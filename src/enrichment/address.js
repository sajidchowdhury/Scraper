'use strict';

/**
 * src/enrichment/address.js — Phase 3.2 — Address Parsing & Geocoding
 *
 * Splits raw single-line addresses scraped from Google Maps into structured
 * fields (street, city, state, postal, country) and geocodes each business to
 * verified lat/lng coordinates with a confidence score.
 *
 * WHY THIS MODULE EXISTS
 *   Google Maps exposes each business's address as a single string
 *   ("123 Main St, Springfield, IL 62701, United States"). That string is
 *   useless for programmatic filtering — clients can't `WHERE city = '...'`
 *   or `ORDER BY distance`. This module:
 *     1. Parses the string into 5 structured columns (Phase 3.2 schema).
 *     2. Geocodes to precise lat/lng with a 0.00–1.00 confidence score.
 *     3. Persists everything to the businesses table (lat/lng/geocode_confidence
 *        are the foundation for Phase 3.8 competitor density + Phase 3.11 grid
 *        coverage).
 *
 * DESIGN RULES (per PHASE3_EXECUTION_PLAN.md §3.2)
 *   - Pure functions for parsing (no network, no DB) — fully unit-testable.
 *   - Geocoding is wrapped in a DI seam (`createGeocoder`) with three providers:
 *       * `google`    — Google Geocoding API ($5 / 1k requests; uses the
 *                       existing `place_id` from the scrape for free-ish lookups
 *                       via place_id, falling back to address text).
 *       * `nominatim` — OpenStreetMap free tier (1 req/s rate limit, no key).
 *                       Default when no API key is configured.
 *       * `mock`      — returns canned coordinates for $0 testing.
 *     All providers return `{ lat, lng, confidence, source }`.
 *   - HTTP is injected (`_httpClient`) so tests can mock fetch without network.
 *   - Rate limiting uses the same pattern as Phase 1.8's RateLimiter but is
 *     implemented inline as a simple delay between requests (per-provider
 *     default: Google 50 req/s → 20ms; Nominatim 1 req/s → 1000ms). Tests
 *     inject a stub sleepFn for deterministic timing.
 *   - Budget guard: every geocode call debits a running budget; when the
 *     budget is exhausted, the geocoder falls back to `mock` (no coordinates)
 *     so the run completes without overspending. Nominatim + mock are $0
 *     (never debited).
 *
 * ADDRESS PARSING HEURISTICS
 *   Google Maps addresses follow country-specific formats. We don't try to be
 *   a full address parser (libaddressinput, Google's Address Validation API do
 *   that better) — instead we use a small set of high-coverage heuristics that
 *   work for the >90% acceptance criterion:
 *
 *     US/CA  — comma-separated: "street, city, ST postal, country"
 *     DE/AT  — "street number, postal city, country" (number AFTER street)
 *     GB     — "street, city, postal, country" (postal AFTER city)
 *     FR/IT  — "street number, postal city, country"
 *     JP     — block-system, no commas: " prefecture city block-building"
 *     BD/IN  — "street, city, postal, country" (postal is 4-6 digits)
 *     *      — fallback: split by commas; try to extract postal + country;
 *              whatever's left is street + city.
 *
 *   The country hint (`countryHint` arg, ISO 2-letter) selects the parser. If
 *   no hint is given, we sniff the country from the last comma-separated token
 *   (matched against COUNTRY_ALIASES), and if that fails we fall back to the
 *   generic comma-splitter.
 *
 * PUBLIC API
 *   parseAddress(raw, countryHint?)         → { street, city, state, postal, country, raw }
 *   parsePostalCode(address, countryHint?)  → string|null
 *   normalizeCountryCode(countryString)     → 'US' | 'DE' | 'BD' | ... | null
 *   computeGeocodeConfidence(parsed, geocoded) → 0.00–1.00
 *   createGeocoder({ provider, apiKey, httpClient, rateLimitMs, sleepFn, nowFn })
 *                                           → { geocode, stats, provider }
 *   geocodeBatch(businesses, opts)          → { total, geocoded, failed, skipped, byConfidence, budgetUsed }
 *   GEOCODE_CONFIDENCE                      → { EXACT, ROOFTOP, INTERPOLATED, CENTER, APPROXIMATE, CENTROID, NONE }
 *   ENRICHMENT_COLUMNS                      → 8 columns written to the businesses table
 */

const __version = 1;

const ENRICHMENT_COLUMNS = [
  'address_street',
  'address_city',
  'address_state',
  'address_postal',
  'address_country',
  'lat',
  'lng',
  'geocode_confidence',
];

// ---------------------------------------------------------------------------
// Confidence score bands. The geocoder returns a numeric confidence 0.00–1.00
// based on the match quality. Higher = better. Callers can filter
// `geocode_confidence >= 0.8` for high-precision leads.
// ---------------------------------------------------------------------------
const GEOCODE_CONFIDENCE = {
  EXACT: 1.0, // place_id match (Google) — the business's own pinned location
  ROOFTOP: 0.9, // address-level precision (Google ROOFTOP / Nominatim ' rooftop')
  INTERPOLATED: 0.75, // RANGE_INTERPOLATED — between two known points
  CENTER: 0.6, // GEOMETRIC_CENTER — centroid of a building/intersection
  APPROXIMATE: 0.4, // approximate (city-level or coarse)
  CENTROID: 0.3, // only the postal/city centroid was returned
  NONE: 0.0, // no result — coordinates are null
};

// ---------------------------------------------------------------------------
// Country normalization — full name / common alias → ISO 3166-1 alpha-2.
// Covers ~60 countries + aliases. Anything not in this map falls back to
// the uppercased 2-letter check (so "DE" stays "DE"). For a full ISO 3166
// table we'd ship a 250-entry JSON — the alias map covers the long-tail of
// Google Maps address strings ("United States", "USA", "U.S.A.", "America").
// ---------------------------------------------------------------------------
const COUNTRY_ALIASES = {
  // North America
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  us: 'US',
  america: 'US',
  'u.s.a.': 'US',
  'u.s.a': 'US',
  canada: 'CA',
  ca: 'CA',
  mexico: 'MX',
  // South America
  brazil: 'BR',
  brasil: 'BR',
  argentina: 'AR',
  chile: 'CL',
  colombia: 'CO',
  peru: 'PE',
  venezuela: 'VE',
  // Europe
  'united kingdom': 'GB',
  britain: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  uk: 'GB',
  'u.k.': 'GB',
  'u.k': 'GB',
  germany: 'DE',
  deutschland: 'DE',
  france: 'FR',
  spain: 'ES',
  españa: 'ES',
  espana: 'ES',
  italy: 'IT',
  italia: 'IT',
  netherlands: 'NL',
  nederland: 'NL',
  holland: 'NL',
  belgium: 'BE',
  belgië: 'BE',
  belgique: 'BE',
  switzerland: 'CH',
  schweiz: 'CH',
  suisse: 'CH',
  austria: 'AT',
  österreich: 'AT',
  sweden: 'SE',
  sverige: 'SE',
  norway: 'NO',
  norge: 'NO',
  denmark: 'DK',
  danmark: 'DK',
  finland: 'FI',
  suomi: 'FI',
  ireland: 'IE',
  portugal: 'PT',
  greece: 'GR',
  poland: 'PL',
  Polska: 'PL',
  czechia: 'CZ',
  'czech republic': 'CZ',
  slovakia: 'SK',
  hungary: 'HU',
  romania: 'RO',
  bulgaria: 'BG',
  croatia: 'HR',
  serbia: 'RS',
  russia: 'RU',
  ukraine: 'UA',
  turkey: 'TR',
  türkiye: 'TR',
  // Asia
  japan: 'JP',
  'south korea': 'KR',
  korea: 'KR',
  china: 'CN',
  india: 'IN',
  pakistan: 'PK',
  bangladesh: 'BD',
  'sri lanka': 'LK',
  nepal: 'NP',
  thailand: 'TH',
  vietnam: 'VN',
  'viet nam': 'VN',
  philippines: 'PH',
  indonesia: 'ID',
  malaysia: 'MY',
  singapore: 'SG',
  'hong kong': 'HK',
  taiwan: 'TW',
  'saudi arabia': 'SA',
  'uae': 'AE',
  'united arab emirates': 'AE',
  qatar: 'QA',
  kuwait: 'KW',
  bahrain: 'BH',
  oman: 'OM',
  israel: 'IL',
  iran: 'IR',
  iraq: 'IQ',
  // Oceania
  australia: 'AU',
  'new zealand': 'NZ',
  // Africa
  'south africa': 'ZA',
  egypt: 'EG',
  nigeria: 'NG',
  kenya: 'KE',
  morocco: 'MA',
  ghana: 'GH',
  ethiopia: 'ET',
  tanzania: 'TZ',
  uganda: 'UG',
};

// ---------------------------------------------------------------------------
// Postal code patterns (per country, ISO 2-letter). Patterns are anchored
// (no ^/$) so they can be searched within an address string. The capture
// group (when present) is the postal code itself; otherwise the whole match.
//
// Sources:
//   US  — 5-digit (or ZIP+4); the 5-digit form is captured.
//   CA  — A1A 1A1 (letter-digit-letter space digit-letter-digit).
//   GB  — AA1 1AA / A1 1AA / A1A 1AA / AA1A 1AA — flexible outer/inner.
//   DE  — 5-digit (post-reunification format).
//   FR  — 5-digit.
//   JP  — NNN-NNNN (7-digit hyphenated) or 3-digit (older).
//   IN  — 6-digit.
//   AU  — 4-digit.
//   BR  — NNNNN-NNN (8-digit, hyphenated; 5-digit captured as fallback).
//   NL  — NNNN AA (4 digits + 2 letters).
//   PL  — NN-NNN (hyphenated 5-digit).
// ---------------------------------------------------------------------------
const POSTAL_PATTERNS = {
  US: /\b(\d{5})(?:-\d{4})?\b/,
  CA: /\b([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/i,
  GB: /\b((?:[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})|(?:[A-Z]{1,2}\d\s?\d[A-Z]{2}))\b/i,
  DE: /\b(\d{5})\b/,
  FR: /\b(\d{5})\b/,
  IT: /\b(\d{5})\b/,
  ES: /\b(\d{5})\b/,
  PT: /\b(\d{4}-\d{3})\b/,
  NL: /\b(\d{4}\s?[A-Z]{2})\b/i,
  BE: /\b(\d{4})\b/,
  CH: /\b(\d{4})\b/,
  AT: /\b(\d{4})\b/,
  SE: /\b(\d{3}\s?\d{2})\b/,
  NO: /\b(\d{4})\b/,
  DK: /\b(\d{4})\b/,
  FI: /\b(\d{5})\b/,
  IE: /\b([A-Z]\d{2}\s?[A-Z\d]{4})\b/, // Eircode: letter + 2 digits + 4 alphanumeric (e.g. D02 XY28)
  PL: /\b(\d{2}-\d{3})\b/,
  CZ: /\b(\d{3}\s?\d{2})\b/,
  JP: /\b(\d{3}-\d{4})\b/,
  KR: /\b(\d{5})\b/,
  CN: /\b(\d{6})\b/,
  IN: /\b(\d{6})\b/,
  PK: /\b(\d{5})\b/,
  BD: /\b(\d{4})\b/,
  TH: /\b(\d{5})\b/,
  VN: /\b(\d{6})\b/,
  PH: /\b(\d{4})\b/,
  ID: /\b(\d{5})\b/,
  MY: /\b(\d{5})\b/,
  SG: /\b(\d{6})\b/,
  // HK: Hong Kong doesn't use postal codes — no pattern defined (previously a
  // 6-char alphanumeric pattern that false-matched words like "Berlin").
  AU: /\b(\d{4})\b/,
  NZ: /\b(\d{4})\b/,
  ZA: /\b(\d{4})\b/,
  EG: /\b(\d{5})\b/,
  NG: /\b(\d{6})\b/,
  KE: /\b(\d{5})\b/,
  MA: /\b(\d{5})\b/,
  BR: /\b(\d{5}-\d{3})\b/,
  AR: /\b([A-Z]\d{4}[A-Z]{3}|\d{4})\b/i,
  CL: /\b(\d{7})\b/,
  CO: /\b(\d{6})\b/,
  PE: /\b(\d{5})\b/,
  VE: /\b(\d{4})\b/,
  RU: /\b(\d{6})\b/,
  UA: /\b(\d{5})\b/,
  TR: /\b(\d{5})\b/,
  SA: /\b(\d{5})\b/,
  AE: /\b(\d{5})\b/,
  IL: /\b(\d{7})\b/,
};

// US state abbreviations — used to detect the state token in US/CA addresses.
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','PR','GU','VI','AS','MP',
]);
const CA_PROVINCES = new Set([
  'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT',
]);

// ---------------------------------------------------------------------------
// DI seam for HTTP. Production uses global fetch; tests inject a stub via
// _setHttpClient to mock the geocoder HTTP responses without network.
// ---------------------------------------------------------------------------
let _httpClient = null;
function _getHttpClient() {
  if (_httpClient) return _httpClient;
  if (typeof fetch === 'function') return fetch;
  // Node 18+ has global fetch; older runtimes would need node-fetch. The
  // package.json requires node >= 20, so fetch is always present in prod.
  throw new Error('address.js: global fetch is not available — inject an httpClient via _setHttpClient for tests, or upgrade to Node 20+');
}
function _setHttpClient(stub) {
  _httpClient = stub;
}

// ---------------------------------------------------------------------------
// Country normalization (pure)
// ---------------------------------------------------------------------------

/**
 * Normalize a country string to ISO 3166-1 alpha-2. Handles:
 *   - Full names ("United States" → "US")
 *   - Common aliases ("USA", "America", "U.S.A." → "US")
 *   - Localized names ("Deutschland" → "DE", "España" → "ES")
 *   - Already-ISO codes ("US" → "US", "us" → "US")
 *   - Whitespace + punctuation
 *
 * Returns null for unrecognized input (callers should keep the original
 * string in the raw address — losing the country is worse than a stale hint).
 *
 * @param {string} countryString
 * @returns {string|null} ISO 2-letter uppercase, or null
 */
function normalizeCountryCode(countryString) {
  if (!countryString || typeof countryString !== 'string') return null;
  // Normalize: trim, collapse internal whitespace, strip trailing periods.
  const s = countryString.trim().replace(/\s+/g, ' ').replace(/\.+$/, '');
  if (!s) return null;
  // Alias lookup FIRST — so "UK" → "GB" (alias) rather than "UK" (bare 2-letter,
  // which is not a valid ISO 3166-1 alpha-2 code; the correct code is "GB").
  const key = s.toLowerCase();
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
  // ISO 3-letter → 2-letter for the most common countries.
  const ISO3_TO_ISO2 = {
    USA: 'US', CAN: 'CA', GBR: 'GB', DEU: 'DE', FRA: 'FR', ESP: 'ES',
    ITA: 'IT', NLD: 'NL', BEL: 'BE', CHE: 'CH', AUT: 'AT', SWE: 'SE',
    NOR: 'NO', DNK: 'DK', FIN: 'FI', IRL: 'IE', PRT: 'PT', GRC: 'GR',
    POL: 'PL', CZE: 'CZ', SVK: 'SK', HUN: 'HU', ROU: 'RO', BGR: 'BG',
    HRV: 'HR', SRB: 'RS', RUS: 'RU', UKR: 'UA', TUR: 'TR', JPN: 'JP',
    KOR: 'KR', CHN: 'CN', IND: 'IN', PAK: 'PK', BGD: 'BD', LKA: 'LK',
    NPL: 'NP', THA: 'TH', VNM: 'VN', PHL: 'PH', IDN: 'ID', MYS: 'MY',
    SGP: 'SG', HKG: 'HK', TWN: 'TW', SAU: 'SA', ARE: 'AE', QAT: 'QA',
    KWT: 'KW', BHR: 'BH', OMN: 'OM', ISR: 'IL', IRN: 'IR', IRQ: 'IQ',
    AUS: 'AU', NZL: 'NZ', ZAF: 'ZA', EGY: 'EG', NGA: 'NG', KEN: 'KE',
    MAR: 'MA', GHA: 'GH', ETH: 'ET', TZA: 'TZ', UGA: 'UG', BRA: 'BR',
    ARG: 'AR', CHL: 'CL', COL: 'CO', PER: 'PE', VEN: 'VE', MEX: 'MX',
  };
  if (/^[A-Z]{3}$/i.test(s)) {
    const up = s.toUpperCase();
    if (ISO3_TO_ISO2[up]) return ISO3_TO_ISO2[up];
  }
  // Direct ISO 2-letter — but only if it's a recognized country code (in our
  // alias set as a value). This avoids treating arbitrary 2-letter strings
  // (e.g. "XY", "AB" for Alberta) as country codes.
  if (/^[A-Z]{2}$/i.test(s)) {
    const up = s.toUpperCase();
    const values = new Set(Object.values(COUNTRY_ALIASES));
    if (values.has(up)) return up;
  }
  // Last-resort: maybe it's "US." or "u.s" with odd punctuation — strip all
  // non-alphanumerics and re-test for a 2-letter code.
  const stripped = s.replace(/[^A-Za-z]/g, '').toUpperCase();
  if (stripped.length === 2) {
    const values = new Set(Object.values(COUNTRY_ALIASES));
    if (values.has(stripped)) return stripped;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Postal code extraction (pure)
// ---------------------------------------------------------------------------

/**
 * Extract a postal code from an address string using country-specific regex.
 *
 * When `countryHint` is provided, only that country's pattern is tried. When
 * no hint is given, we try every pattern (longest-match-wins) and return the
 * first non-null match. This is a reasonable heuristic — postal codes are
 * distinctive enough that cross-country collisions are rare (the only common
 * one is the 5-digit pattern matching US/DE/FR/IT/ES/... which is acceptable
 * since we prefer the country hint).
 *
 * @param {string} addressString
 * @param {string} [countryHint] — ISO 2-letter
 * @returns {string|null} the captured postal code (whitespace-normalized)
 */
function parsePostalCode(addressString, countryHint) {
  if (!addressString || typeof addressString !== 'string') return null;
  const tryOne = (pattern) => {
    const m = addressString.match(pattern);
    if (!m) return null;
    // Capture group 1 if present, else the whole match.
    const captured = m[1] !== undefined ? m[1] : m[0];
    return captured ? captured.replace(/\s+/g, ' ').trim() : null;
  };
  if (countryHint) {
    const up = countryHint.toUpperCase();
    const pattern = POSTAL_PATTERNS[up];
    if (pattern) return tryOne(pattern);
  }
  // No hint — try every pattern. We sort patterns by length-of-first-match
  // descending so longer, more-specific patterns win (e.g. GB "AA1A 1AA"
  // beats the bare 5-digit US pattern that would also match the digits).
  const entries = Object.entries(POSTAL_PATTERNS);
  const matches = [];
  for (const [, pattern] of entries) {
    const m = addressString.match(pattern);
    if (m) {
      const captured = m[1] !== undefined ? m[1] : m[0];
      if (captured) matches.push(captured.replace(/\s+/g, ' ').trim());
    }
  }
  if (matches.length === 0) return null;
  // Longest match wins (more specific = better). Ties broken by alphabetical
  // order for determinism.
  matches.sort((a, b) => b.length - a.length || a.localeCompare(b));
  return matches[0];
}

// ---------------------------------------------------------------------------
// Address parsing (pure, heuristic)
// ---------------------------------------------------------------------------

/**
 * Strip leading/trailing whitespace, collapse internal whitespace runs to a
 * single space, and normalize unicode spaces (NBSP, thin space, etc.).
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeWhitespace(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ') // unicode spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a raw address on commas, normalizing each segment. Empty segments are
 * dropped. Returns the segments in order.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function splitByComma(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => normalizeWhitespace(s))
    .filter((s) => s.length > 0);
}

/**
 * Try to detect the country from the last comma-separated token. Returns the
 * ISO 2-letter code if the token matches a known country name/alias/ISO code,
 * else null.
 *
 * @param {string[]} segments
 * @returns {string|null}
 */
function detectCountryFromSegments(segments) {
  if (!segments || segments.length === 0) return null;
  const last = segments[segments.length - 1];
  return normalizeCountryCode(last);
}

/**
 * Parse a US/CA-format address: "street, city, ST postal, country".
 *
 * The state token (if present) is a 2-letter code surrounded by spaces or
 * commas; the postal code follows it. We use the country hint to pick the
 * postal pattern.
 *
 * @param {string[]} segments — comma-split, normalized.
 * @param {string} country — 'US' or 'CA'.
 * @returns {{ street: string|null, city: string|null, state: string|null, postal: string|null, country: string }}
 */
function parseUsCaAddress(segments, country) {
  const result = { street: null, city: null, state: null, postal: null, country };
  if (segments.length === 0) return result;
  // The last segment is the country (already confirmed); drop it.
  const parts = segments.slice(0, segments.length - 1);
  // Re-join into a single string and re-parse, because the state+postal
  // often live in the same comma-segment ("Springfield, IL 62701").
  const joined = parts.join(', ');
  const postal = parsePostalCode(joined, country);
  result.postal = postal;
  // Strip the postal from the joined string so it doesn't pollute city/state.
  const withoutPostal = postal ? joined.replace(postal, ' ').replace(/\s+/g, ' ').trim() : joined;
  // Re-split by comma.
  const inner = withoutPostal.split(',').map((s) => normalizeWhitespace(s)).filter(Boolean);
  // Find the state token in the last segment(s).
  let stateIdx = -1;
  for (let i = inner.length - 1; i >= 0; i--) {
    const tokens = inner[i].split(/\s+/);
    for (const t of tokens) {
      const up = t.toUpperCase().replace(/[^A-Z]/g, '');
      if (country === 'US' && US_STATES.has(up)) {
        result.state = up;
        stateIdx = i;
        break;
      }
      if (country === 'CA' && CA_PROVINCES.has(up)) {
        result.state = up;
        stateIdx = i;
        break;
      }
    }
    if (stateIdx >= 0) break;
  }
  // Assignment:
  //   - If the state token shares a segment with the city (e.g. "Springfield IL"),
  //     city = (segment minus state token). Street = everything before.
  //   - If the state is alone in its segment (e.g. "Springfield, IL"), city =
  //     the segment immediately before stateIdx. Street = everything before city.
  //   - If no state found: street = inner[0], city = inner[1] (if any), extras
  //     appended to street.
  if (stateIdx >= 0) {
    const stateSegmentMinusState = inner[stateIdx]
      .replace(result.state || '', ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (stateSegmentMinusState) {
      // City + state combined in one segment ("Springfield IL").
      result.city = stateSegmentMinusState;
      // Street = everything before stateIdx (inner[0..stateIdx-1]).
      if (stateIdx > 0) {
        result.street = inner.slice(0, stateIdx).join(', ') || null;
      } else {
        result.street = null;
      }
    } else {
      // State is alone in its segment. City = the previous segment (if any).
      if (stateIdx >= 2) {
        result.city = inner[stateIdx - 1] || null;
        result.street = inner.slice(0, stateIdx - 1).join(', ') || null;
      } else if (stateIdx === 1) {
        // Only street + state (no city): "123 Main St, IL"
        result.city = null;
        result.street = inner[0] || null;
      } else {
        // stateIdx === 0 — only the state segment exists. No street/city.
        result.city = null;
        result.street = null;
      }
    }
  } else {
    // No state found — assign by position: inner[0]=street, inner[1]=city, rest→street.
    if (inner.length > 0) result.street = inner[0] || null;
    if (inner.length >= 2) result.city = inner[1] || null;
    if (inner.length > 2) {
      const middle = inner.slice(2).join(', ');
      if (middle) result.street = result.street ? `${result.street}, ${middle}` : middle;
    }
  }
  return result;
}

/**
 * Parse a DE/AT-format address: "street number, postal city, country".
 * Street number comes AFTER the street name (German convention). The postal
 * is 5 digits and immediately precedes the city in the same segment.
 *
 * @param {string[]} segments — comma-split, normalized, country already dropped.
 * @param {string} country — 'DE' or 'AT'.
 */
function parseDeAtAddress(segments, country) {
  const result = { street: null, city: null, state: null, postal: null, country };
  const parts = segments.slice(0, segments.length - 1);
  if (parts.length === 0) return result;
  // Street is the first segment ("Hauptstraße 5"). German states (Bundesländer)
  // are rarely in the address, so we leave state null unless we explicitly
  // detect one (Bavaria, Berlin, etc.).
  result.street = parts[0] || null;
  // The postal + city segment is parts[1] (e.g. "10115 Berlin").
  if (parts.length >= 2) {
    const pc = parsePostalCode(parts[1], country);
    result.postal = pc;
    if (pc) {
      const city = parts[1].replace(pc, ' ').replace(/\s+/g, ' ').trim();
      result.city = city || null;
    } else {
      result.city = parts[1] || null;
    }
    // Extra segments → treat as state/region (rare for DE).
    if (parts.length > 2) {
      const extra = parts.slice(2).join(', ');
      // Only set state if it's a single token; otherwise treat as street ext.
      const tokens = extra.split(/\s+/);
      if (tokens.length === 1) result.state = extra;
    }
  }
  return result;
}

/**
 * Parse a GB-format address: "street, city, postal, country". The postal code
 * (AA1 1AA format) is typically its own segment or appended to the city.
 *
 * @param {string[]} segments
 */
function parseGbAddress(segments) {
  const result = { street: null, city: null, state: null, postal: null, country: 'GB' };
  const parts = segments.slice(0, segments.length - 1);
  if (parts.length === 0) return result;
  // Re-join and extract postal from the whole thing (GB postals can be in
  // any segment).
  const joined = parts.join(', ');
  const pc = parsePostalCode(joined, 'GB');
  result.postal = pc;
  const withoutPostal = pc ? joined.replace(pc, ' ').replace(/\s+/g, ' ').trim() : joined;
  const inner = withoutPostal.split(',').map((s) => normalizeWhitespace(s)).filter(Boolean);
  if (inner.length > 0) result.street = inner[0] || null;
  if (inner.length >= 2) result.city = inner[1] || null;
  // GB doesn't use "state" — leave null.
  return result;
}

/**
 * Parse a JP-format address: "東京都港区六本木1-2-3" (block-system, no commas).
 * The block ("1-2-3") is the last token; the city is the second-to-last; the
 * prefecture is the first token. We can't reliably tokenize the street from
 * the rest without a JP-specific dictionary, so we leave street as the
 * block+building portion and city as everything before.
 *
 * This is a best-effort parser — Google Maps JP addresses sometimes include
 * commas for the Latin transliteration. When in doubt, fall back to the
 * generic parser.
 *
 * @param {string} raw — already normalized.
 */
function parseJpAddress(raw) {
  const result = { street: null, city: null, state: null, postal: null, country: 'JP' };
  const pc = parsePostalCode(raw, 'JP');
  result.postal = pc;
  const withoutPostal = pc ? raw.replace(pc, ' ').replace(/\s+/g, ' ').trim() : raw;
  // Japanese prefectures end with 都/道/府/県. Find the first occurrence.
  const prefMatch = withoutPostal.match(/^[^都道府県]*[都道府県]/);
  if (prefMatch) {
    result.state = prefMatch[0];
    const rest = withoutPostal.slice(prefMatch[0].length).trim();
    // Find the city (ends with 市/区/町/村).
    const cityMatch = rest.match(/^[^市区町村]*[市区町村]/);
    if (cityMatch) {
      result.city = cityMatch[0];
      result.street = rest.slice(cityMatch[0].length).trim() || null;
    } else {
      result.street = rest || null;
    }
  } else {
    // No prefecture prefix — best-effort: street is the whole thing.
    result.street = withoutPostal || null;
  }
  return result;
}

/**
 * Generic fallback parser — split by commas, assign street/city/state by
 * position, and extract postal + country globally. Used when the country hint
 * is null/unknown or the country-specific parser doesn't apply.
 *
 * @param {string[]} segments
 * @param {string|null} country
 */
function parseGenericAddress(segments, country) {
  const result = { street: null, city: null, state: null, postal: null, country };
  if (segments.length === 0) return result;
  // Re-join to extract postal globally.
  const joined = segments.join(', ');
  const pc = parsePostalCode(joined, country || undefined);
  result.postal = pc;
  const withoutPostal = pc ? joined.replace(pc, ' ').replace(/\s+/g, ' ').trim() : joined;
  // Re-split.
  const inner = withoutPostal.split(',').map((s) => normalizeWhitespace(s)).filter(Boolean);
  // Drop a trailing country segment if present (so it doesn't become the city).
  let trimmed = inner;
  if (country && inner.length > 1 && normalizeCountryCode(inner[inner.length - 1]) === country) {
    trimmed = inner.slice(0, inner.length - 1);
  }
  if (trimmed.length === 0) {
    // Nothing left after dropping country — put it all in street.
    result.street = withoutPostal || null;
    return result;
  }
  // Assignment by position:
  //   1 segment  → street
  //   2 segments → street, city
  //   3 segments → street, city, state
  //   4+         → street, city, state, [extras appended to street]
  if (trimmed.length === 1) {
    result.street = trimmed[0] || null;
  } else if (trimmed.length === 2) {
    result.street = trimmed[0] || null;
    result.city = trimmed[1] || null;
  } else if (trimmed.length === 3) {
    result.street = trimmed[0] || null;
    result.city = trimmed[1] || null;
    result.state = trimmed[2] || null;
  } else {
    result.street = trimmed[0] || null;
    result.city = trimmed[1] || null;
    result.state = trimmed[2] || null;
    const extra = trimmed.slice(3).join(', ');
    if (extra) result.street = result.street ? `${result.street}, ${extra}` : extra;
  }
  return result;
}

/**
 * Parse a raw single-line address into structured components.
 *
 * Heuristic flow:
 *   1. Normalize whitespace.
 *   2. Split by commas.
 *   3. If countryHint is provided, dispatch to the country-specific parser.
 *   4. Otherwise, sniff the country from the last comma segment.
 *   5. If sniffing fails, use the generic parser.
 *
 * Always returns the full 6-key object. The `raw` field preserves the
 * original input for round-trip / debugging.
 *
 * @param {string} rawAddress
 * @param {string} [countryHint] — ISO 2-letter
 * @returns {{ street: string|null, city: string|null, state: string|null, postal: string|null, country: string|null, raw: string }}
 */
function parseAddress(rawAddress, countryHint) {
  const raw = typeof rawAddress === 'string' ? rawAddress : '';
  // For null/undefined/empty/whitespace-only input, return all-null with raw=''
  // (preserving the exact original isn't useful when there's nothing to parse).
  if (!raw || !raw.trim()) {
    return { street: null, city: null, state: null, postal: null, country: null, raw: '' };
  }
  const base = { street: null, city: null, state: null, postal: null, country: null, raw };
  const normalized = normalizeWhitespace(raw);
  const segments = splitByComma(normalized);
  if (segments.length === 0) return base;

  // Determine effective country hint: explicit > sniffed.
  let country = countryHint ? normalizeCountryCode(countryHint) : null;
  if (!country) {
    country = detectCountryFromSegments(segments);
  }
  base.country = country;

  // Dispatch by country. Each parser sets .country explicitly (so a sniffed
  // country sticks even when the parser didn't need it).
  if (country === 'US' || country === 'CA') {
    // If the address doesn't include the country in a comma segment, append
    // a placeholder so the US/CA parser can drop it cleanly.
    const segs = normalizeCountryCode(segments[segments.length - 1]) === country
      ? segments
      : [...segments, country];
    return { ...parseUsCaAddress(segs, country), raw };
  }
  if (country === 'DE' || country === 'AT') {
    const segs = normalizeCountryCode(segments[segments.length - 1]) === country
      ? segments
      : [...segments, country];
    return { ...parseDeAtAddress(segs, country), raw };
  }
  if (country === 'GB') {
    return { ...parseGbAddress(segments), raw };
  }
  if (country === 'JP') {
    return { ...parseJpAddress(normalized), raw };
  }
  // Generic fallback.
  return { ...parseGenericAddress(segments, country), raw };
}

// ---------------------------------------------------------------------------
// Geocode confidence scoring (pure)
// ---------------------------------------------------------------------------

/**
 * Compute a 0.00–1.00 confidence score for a geocode result, given the parsed
 * address and the geocoder's raw response.
 *
 * The score reflects how precisely the geocoder resolved the address:
 *   - EXACT (1.0)   — place_id match (Google returned the exact business).
 *   - ROOFTOP (0.9) — address-level precision (all components matched).
 *   - INTERPOLATED (0.75) — range-interpolated (street number estimated).
 *   - CENTER (0.6)  — geometric center (intersection / building centroid).
 *   - APPROXIMATE (0.4) — approximate (postal or city-level match).
 *   - CENTROID (0.3) — only the city/postal centroid was returned.
 *   - NONE (0.0)    — no result; lat/lng are null.
 *
 * The parsed address is used to boost the score when components are missing:
 *   - If `parsed.postal` is set AND the geocoder's postal matches → +0.05
 *   - If `parsed.city` is set AND the geocoder's city matches → +0.05
 *   (capped at the next band up — never above 1.0).
 *
 * @param {object} parsed — the parseAddress() result.
 * @param {object} geocoded — the geocoder's response: { lat, lng, accuracy, place_id, matchedPostal, matchedCity }
 * @returns {number} 0.00–1.00 (2 decimal places)
 */
function computeGeocodeConfidence(parsed, geocoded) {
  if (!geocoded) return GEOCODE_CONFIDENCE.NONE;
  // When lat/lng are EXPLICITLY null (the geocoder tried and failed), return
  // NONE. We use === null (not == null) so undefined lat/lng (metadata-only
  // objects from geocodeGoogle/Nominatim that don't include coordinates) are
  // OK — the caller already checks lat/lng separately before calling.
  if (geocoded.lat === null || geocoded.lng === null) return GEOCODE_CONFIDENCE.NONE;
  // place_id exact match — Google resolved the business itself (the geocoder's
  // place_id matches the business's own scraped place_id).
  if (geocoded.place_id && parsed && parsed.raw_place_id &&
      geocoded.place_id === parsed.raw_place_id) {
    return GEOCODE_CONFIDENCE.EXACT;
  }
  // Provider-declared accuracy. A geocoded place_id (without a match to the
  // business's own place_id) doesn't auto-promote to EXACT — it just means
  // Google resolved the address text to SOME place, which is ROOFTOP-grade.
  let base = GEOCODE_CONFIDENCE.NONE;
  const acc = (geocoded.accuracy || '').toString().toUpperCase();
  if (acc === 'EXACT') base = GEOCODE_CONFIDENCE.EXACT;
  else if (acc === 'ROOFTOP') base = GEOCODE_CONFIDENCE.ROOFTOP;
  else if (acc.includes('INTERPOLAT') || acc === 'RANGE_INTERPOLATED') base = GEOCODE_CONFIDENCE.INTERPOLATED;
  else if (acc.includes('CENTER') || acc === 'GEOMETRIC_CENTER') base = GEOCODE_CONFIDENCE.CENTER;
  else if (acc === 'APPROXIMATE') base = GEOCODE_CONFIDENCE.APPROXIMATE;
  else if (acc === 'CENTROID') base = GEOCODE_CONFIDENCE.CENTROID;
  // Nominatim uses a 0-1 importance + class; map high-importance to ROOFTOP.
  else if (geocoded.importance != null && geocoded.importance >= 0.5) base = GEOCODE_CONFIDENCE.ROOFTOP;
  else if (geocoded.importance != null && geocoded.importance >= 0.2) base = GEOCODE_CONFIDENCE.CENTER;
  else if (geocoded.lat != null) base = GEOCODE_CONFIDENCE.APPROXIMATE;

  // Boosts (capped at EXACT).
  let boosted = base;
  if (parsed && parsed.postal && geocoded.matchedPostal &&
      parsed.postal.replace(/\s/g, '') === String(geocoded.matchedPostal).replace(/\s/g, '')) {
    boosted = Math.min(boosted + 0.05, GEOCODE_CONFIDENCE.EXACT);
  }
  if (parsed && parsed.city && geocoded.matchedCity &&
      parsed.city.toLowerCase() === String(geocoded.matchedCity).toLowerCase()) {
    boosted = Math.min(boosted + 0.05, GEOCODE_CONFIDENCE.EXACT);
  }
  return Math.round(boosted * 100) / 100;
}

// ---------------------------------------------------------------------------
// Geocoder factory (DI seam)
// ---------------------------------------------------------------------------

/**
 * Default sleep function. Tests inject a no-op to skip real waits.
 */
function _defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default provider rate limits (ms between requests).
 *   google    — 50 req/s → 20ms gap.
 *   nominatim — 1 req/s  → 1000ms gap (their usage policy requires ≤1 req/s).
 *   mock      — 0 (no HTTP).
 */
const DEFAULT_RATE_LIMIT_MS = {
  google: 20,
  nominatim: 1000,
  mock: 0,
};

/**
 * Per-provider USD cost per request. Used by the budget guard. Nominatim and
 * mock are free; Google is $5 per 1k requests ($0.005 each).
 */
const COST_PER_REQUEST_USD = {
  google: 0.005,
  nominatim: 0,
  mock: 0,
};

/**
 * Create a geocoder for a given provider. The returned object has:
 *   - geocode(parsed, business) → Promise<{ lat, lng, confidence, source, place_id?, accuracy? }>
 *   - stats                    → { requests, successes, failures, costUsd }
 *   - provider                 → the provider name ('google' | 'nominatim' | 'mock')
 *
 * The `httpClient` is injected (defaults to global fetch). Tests pass a stub
 * that returns canned JSON without touching the network.
 *
 * @param {object} opts
 *   - provider: 'google' | 'nominatim' | 'mock' (default 'nominatim')
 *   - apiKey: Google API key (required for 'google' unless place_id is used)
 *   - httpClient: function(url, init) → Promise<Response-like>
 *   - rateLimitMs: override the per-provider default
 *   - sleepFn: function(ms) → Promise<void> (test seam)
 *   - nowFn: function() → number (test seam)
 *   - logger: optional logger
 */
function createGeocoder(opts) {
  const o = opts || {};
  const provider = o.provider || 'nominatim';
  if (!['google', 'nominatim', 'mock'].includes(provider)) {
    throw new Error(`createGeocoder: unknown provider '${provider}'`);
  }
  const httpClient = o.httpClient || _getHttpClient;
  const sleepFn = o.sleepFn || _defaultSleep;
  const nowFn = o.nowFn || (() => Date.now());
  const rateLimitMs = o.rateLimitMs != null ? o.rateLimitMs : DEFAULT_RATE_LIMIT_MS[provider];
  const logger = o.logger || null;
  const apiKey = o.apiKey || null;

  const stats = {
    requests: 0,
    successes: 0,
    failures: 0,
    costUsd: 0,
    lastRequestAt: 0,
  };

  async function enforceRateLimit() {
    if (rateLimitMs <= 0) return;
    const now = nowFn();
    const elapsed = now - stats.lastRequestAt;
    if (elapsed < rateLimitMs) {
      await sleepFn(rateLimitMs - elapsed);
    }
    stats.lastRequestAt = nowFn();
  }

  // --- Mock provider -------------------------------------------------------
  async function geocodeMock(parsed, business) {
    stats.requests++;
    stats.costUsd += COST_PER_REQUEST_USD.mock;
    // Return canned coordinates based on the business's place_id hash, so the
    // same business always gets the same mock location (deterministic).
    const placeId = (business && business.place_id) || (parsed && parsed.raw) || 'unknown';
    let hash = 0;
    for (let i = 0; i < placeId.length; i++) {
      hash = ((hash << 5) - hash + placeId.charCodeAt(i)) | 0;
    }
    const lat = ((hash & 0xffff) / 0xffff) * 180 - 90;
    const lng = (((hash >>> 16) & 0xffff) / 0xffff) * 360 - 180;
    stats.successes++;
    return {
      lat: Math.round(lat * 1e7) / 1e7,
      lng: Math.round(lng * 1e7) / 1e7,
      confidence: GEOCODE_CONFIDENCE.APPROXIMATE,
      source: 'mock',
      accuracy: 'APPROXIMATE',
    };
  }

  // --- Google Geocoding API ------------------------------------------------
  async function geocodeGoogle(parsed, business) {
    stats.requests++;
    stats.costUsd += COST_PER_REQUEST_USD.google;
    await enforceRateLimit();
    // Prefer place_id (free-ish — billed as Place Details, but cheap when
    // using the basic field mask). Fallback to address text.
    const placeId = (business && business.place_id) || (parsed && parsed.raw_place_id);
    const params = new URLSearchParams();
    if (placeId) {
      params.set('place_id', placeId);
    } else {
      params.set('address', [parsed.street, parsed.city, parsed.state, parsed.postal, parsed.country]
        .filter(Boolean).join(', '));
    }
    if (apiKey) params.set('key', apiKey);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;
    let resp;
    try {
      resp = await httpClient(url, { method: 'GET' });
    } catch (err) {
      stats.failures++;
      return { lat: null, lng: null, confidence: GEOCODE_CONFIDENCE.NONE, source: 'google', accuracy: 'NONE', error: String(err && err.message || err) };
    }
    let body;
    try {
      body = typeof resp.json === 'function' ? await resp.json() : resp;
    } catch (_e) {
      body = resp;
    }
    if (!body || body.status !== 'OK' || !Array.isArray(body.results) || body.results.length === 0) {
      stats.failures++;
      return { lat: null, lng: null, confidence: GEOCODE_CONFIDENCE.NONE, source: 'google', accuracy: 'NONE' };
    }
    const r = body.results[0];
    const loc = r.geometry && r.geometry.location;
    if (!loc || loc.lat == null || loc.lng == null) {
      stats.failures++;
      return { lat: null, lng: null, confidence: GEOCODE_CONFIDENCE.NONE, source: 'google', accuracy: 'NONE' };
    }
    stats.successes++;
    const accuracy = (r.geometry && r.geometry.location_type) || 'APPROXIMATE';
    const matchedPostal = (r.address_components || []).find((c) => (c.types || []).includes('postal_code'));
    const matchedCity = (r.address_components || []).find((c) =>
      (c.types || []).includes('locality') || (c.types || []).includes('postal_town'));
    return {
      lat: loc.lat,
      lng: loc.lng,
      confidence: computeGeocodeConfidence(parsed, {
        accuracy,
        place_id: r.place_id,
        matchedPostal: matchedPostal ? matchedPostal.long_name : null,
        matchedCity: matchedCity ? matchedCity.long_name : null,
      }),
      source: 'google',
      accuracy,
      place_id: r.place_id || null,
      matchedPostal: matchedPostal ? matchedPostal.long_name : null,
      matchedCity: matchedCity ? matchedCity.long_name : null,
    };
  }

  // --- Nominatim (OpenStreetMap) -------------------------------------------
  async function geocodeNominatim(parsed, business) {
    stats.requests++;
    stats.costUsd += COST_PER_REQUEST_USD.nominatim;
    await enforceRateLimit();
    const q = [parsed.street, parsed.city, parsed.state, parsed.postal, parsed.country]
      .filter(Boolean).join(', ');
    const params = new URLSearchParams({
      q: q || (business && business.name) || parsed.raw,
      format: 'json',
      addressdetails: '1',
      limit: '1',
    });
    const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
    let resp;
    try {
      resp = await httpClient(url, {
        method: 'GET',
        headers: {
          // Nominatim usage policy requires a valid User-Agent / Referer.
          'User-Agent': 'gmaps-scraper/3.0 (https://github.com/sajidchowdhury/Scraper)',
        },
      });
    } catch (err) {
      stats.failures++;
      return { lat: null, lng: null, confidence: GEOCODE_CONFIDENCE.NONE, source: 'nominatim', accuracy: 'NONE', error: String(err && err.message || err) };
    }
    let body;
    try {
      body = typeof resp.json === 'function' ? await resp.json() : resp;
    } catch (_e) {
      body = resp;
    }
    if (!Array.isArray(body) || body.length === 0) {
      stats.failures++;
      return { lat: null, lng: null, confidence: GEOCODE_CONFIDENCE.NONE, source: 'nominatim', accuracy: 'NONE' };
    }
    const r = body[0];
    if (r.lat == null || r.lon == null) {
      stats.failures++;
      return { lat: null, lng: null, confidence: GEOCODE_CONFIDENCE.NONE, source: 'nominatim', accuracy: 'NONE' };
    }
    stats.successes++;
    const acc = r.class === 'building' || r.type === 'yes' ? 'ROOFTOP' : 'APPROXIMATE';
    const addr = r.address || {};
    const matchedPostal = addr.postcode || null;
    const matchedCity = addr.city || addr.town || addr.village || addr.municipality || null;
    return {
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      confidence: computeGeocodeConfidence(parsed, {
        accuracy: acc,
        importance: r.importance != null ? parseFloat(r.importance) : null,
        matchedPostal,
        matchedCity,
      }),
      source: 'nominatim',
      accuracy: acc,
      importance: r.importance != null ? parseFloat(r.importance) : null,
      matchedPostal,
      matchedCity,
    };
  }

  const geocode = provider === 'google' ? geocodeGoogle
    : provider === 'nominatim' ? geocodeNominatim
    : geocodeMock;

  return { geocode, stats, provider };
}

// ---------------------------------------------------------------------------
// Batch geocoding
// ---------------------------------------------------------------------------

/**
 * Geocode a batch of businesses IN PLACE. Each business is mutated with:
 *   - lat                   — float or null
 *   - lng                   — float or null
 *   - geocode_confidence    — 0.00–1.00 (or null when skipped)
 *   - address_street / address_city / address_state / address_postal / address_country
 *     (always populated — parsing is free, no API cost)
 *   - _geocode              — debug descriptor (NOT persisted): the full geocoder
 *                             response so callers can inspect accuracy/source.
 *
 * Budget guard: every paid geocode call debits `budgetUsd`. When the budget
 * is exhausted, the geocoder switches to `mock` for the remaining businesses
 * (lat/lng = approximate canned coords, confidence ~0.4). This guarantees the
 * run completes without overspending, while still parsing every address.
 *
 * @param {object[]} businesses — mutated in place.
 * @param {object} opts
 *   - geocoder: the createGeocoder() return value (required).
 *   - parseAddressFn: override for tests (defaults to parseAddress).
 *   - defaultCountry: ISO 2-letter hint for the parser (when address has no country).
 *   - budgetUsd: USD cap (0 = unlimited). Defaults to geocoder.stats.costUsd baseline.
 *   - logger: optional logger.
 * @returns {Promise<{ total, geocoded, failed, skipped, byConfidence, budgetUsedUsd }>}
 */
async function geocodeBatch(businesses, opts) {
  const o = opts || {};
  const list = Array.isArray(businesses) ? businesses : [];
  const geocoder = o.geocoder;
  if (!geocoder || typeof geocoder.geocode !== 'function') {
    throw new Error('geocodeBatch: geocoder is required (use createGeocoder())');
  }
  const parseFn = o.parseAddressFn || parseAddress;
  const logger = o.logger || null;
  const budgetUsd = o.budgetUsd != null ? o.budgetUsd : Infinity;

  const totals = {
    total: list.length,
    geocoded: 0,
    failed: 0,
    skipped: 0,
    byConfidence: {
      exact: 0,      // >= 1.0
      rooftop: 0,    // >= 0.85
      interpolated: 0, // >= 0.7
      center: 0,     // >= 0.55
      approximate: 0, // >= 0.3
      none: 0,       // < 0.3 or null
    },
    budgetUsedUsd: 0,
  };

  function bucket(confidence) {
    if (confidence == null) { totals.byConfidence.none++; return; }
    if (confidence >= 1.0) totals.byConfidence.exact++;
    else if (confidence >= 0.85) totals.byConfidence.rooftop++;
    else if (confidence >= 0.7) totals.byConfidence.interpolated++;
    else if (confidence >= 0.55) totals.byConfidence.center++;
    else if (confidence >= 0.3) totals.byConfidence.approximate++;
    else totals.byConfidence.none++;
  }

  let budgetExhausted = false;

  for (const business of list) {
    if (!business || typeof business !== 'object') {
      totals.skipped++;
      continue;
    }
    const rawAddress = business.address;
    if (!rawAddress || (typeof rawAddress === 'string' && !rawAddress.trim())) {
      // No address — write nulls + skip geocoding.
      business.address_street = null;
      business.address_city = null;
      business.address_state = null;
      business.address_postal = null;
      business.address_country = null;
      business.lat = null;
      business.lng = null;
      business.geocode_confidence = null;
      business._geocode = null;
      totals.skipped++;
      bucket(null);
      continue;
    }

    // Always parse (free).
    const countryHint = o.defaultCountry || business.address_country || null;
    const parsed = parseFn(rawAddress, countryHint);
    business.address_street = parsed.street;
    business.address_city = parsed.city;
    business.address_state = parsed.state;
    business.address_postal = parsed.postal;
    business.address_country = parsed.country;

    // Budget check — if exhausted, fall back to mock coordinates (no charge).
    if (budgetExhausted || geocoder.stats.costUsd >= budgetUsd) {
      budgetExhausted = true;
      business.lat = null;
      business.lng = null;
      business.geocode_confidence = GEOCODE_CONFIDENCE.NONE;
      business._geocode = { source: 'budget-exhausted', confidence: 0 };
      totals.failed++;
      bucket(null);
      if (logger && logger.debug) {
        logger.debug('geocodeBatch: budget exhausted — skipping', { place_id: business.place_id });
      }
      continue;
    }

    // Geocode.
    let result;
    try {
      result = await geocoder.geocode(parsed, business);
    } catch (err) {
      result = { lat: null, lng: null, confidence: GEOCODE_CONFIDENCE.NONE, source: geocoder.provider, error: String(err && err.message || err) };
    }
    business.lat = result.lat;
    business.lng = result.lng;
    business.geocode_confidence = result.confidence;
    business._geocode = result;

    if (result.lat != null && result.lng != null && result.confidence > 0) {
      totals.geocoded++;
    } else {
      totals.failed++;
    }
    totals.budgetUsedUsd = geocoder.stats.costUsd;
    bucket(result.confidence);
  }

  return totals;
}

module.exports = {
  __version,
  ENRICHMENT_COLUMNS,
  GEOCODE_CONFIDENCE,
  COUNTRY_ALIASES,
  POSTAL_PATTERNS,
  US_STATES,
  CA_PROVINCES,
  COST_PER_REQUEST_USD,
  DEFAULT_RATE_LIMIT_MS,
  // Core API
  parseAddress,
  parsePostalCode,
  normalizeCountryCode,
  computeGeocodeConfidence,
  createGeocoder,
  geocodeBatch,
  // Helpers (exported for tests)
  normalizeWhitespace,
  splitByComma,
  detectCountryFromSegments,
  parseUsCaAddress,
  parseDeAtAddress,
  parseGbAddress,
  parseJpAddress,
  parseGenericAddress,
  // Test seams
  _setHttpClient,
  _getHttpClient,
  _defaultSleep,
};
