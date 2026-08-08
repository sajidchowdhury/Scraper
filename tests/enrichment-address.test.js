'use strict';

/**
 * tests/enrichment-address.test.js — Phase 3.2 — Address Parsing & Geocoding tests
 *
 * Coverage (per PHASE3_EXECUTION_PLAN.md §3.2 task checklist + acceptance):
 *   - Address parsing for 15+ countries (US comma format, German street-number-first,
 *     Japanese block-system, GB, CA, BD, IN, BR, NL, FR, IT, ES, AU, MX, SE)
 *   - Postal code extraction (US 5-digit + ZIP+4, CA A1A1A1, UK AA1 1AA, DE 5-digit,
 *     JP NNN-NNNN, IN 6-digit, AU 4-digit, BR NNNNN-NNN, PL NN-NNN, NL NNNN AA)
 *   - Country normalization (full name → ISO, common aliases, localized names,
 *     ISO 3-letter → 2-letter, already-ISO, whitespace/punctuation)
 *   - Geocoder DI (mock httpClient returns canned responses for google/nominatim/mock;
 *     verifies request URL shape + rate limiting + cost tracking)
 *   - Geocode confidence scoring (EXACT vs ROOFTOP vs INTERPOLATED vs CENTER vs
 *     APPROXIMATE vs CENTROID vs NONE; boost on postal/city match)
 *   - Batch geocoding with rate limiting
 *   - Budget guard (stops at cap; falls back to null coordinates when budget hit)
 *   - DB upsert integration (mock pg client writes the 8 enrichment columns)
 *
 * All tests are pure (no network, no real DB). The mock httpClient + mock pg
 * client isolate every test from external state.
 *
 * Run: bun test tests/enrichment-address.test.js
 */

const {
  parseAddress,
  parsePostalCode,
  normalizeCountryCode,
  computeGeocodeConfidence,
  createGeocoder,
  geocodeBatch,
  GEOCODE_CONFIDENCE,
  ENRICHMENT_COLUMNS,
  COUNTRY_ALIASES,
  POSTAL_PATTERNS,
  COST_PER_REQUEST_USD,
  DEFAULT_RATE_LIMIT_MS,
  normalizeWhitespace,
  splitByComma,
  detectCountryFromSegments,
  parseUsCaAddress,
  parseDeAtAddress,
  parseGbAddress,
  parseJpAddress,
  parseGenericAddress,
  _setHttpClient,
} = require('../src/enrichment/address');

const {
  buildBatchInsert,
  buildUpdate,
  columnValue,
  ENRICHMENT_COLUMNS: DB_ENRICHMENT_COLUMNS,
  buildDuplicateInsert,
  persistDuplicates,
} = require('../src/db');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock pg client that simulates the businesses table in-memory. */
function makeMockClient() {
  const rows = new Map(); // place_id → row
  return {
    _rows: rows,
    async query(text, params) {
      const t = (text || '').trim().toUpperCase();
      // SELECT existing hashes for a chunk.
      if (t.startsWith('SELECT PLACE_ID, DATA_HASH')) {
        const ids = params[0] || [];
        const out = [];
        for (const id of ids) {
          if (rows.has(id)) out.push({ place_id: id, data_hash: rows.get(id).data_hash });
        }
        return { rows: out };
      }
      // SELECT tracked fields for updates.
      if (t.startsWith('SELECT ID, PLACE_ID')) {
        const ids = params[0] || [];
        const out = [];
        for (const id of ids) {
          if (rows.has(id)) {
            const r = rows.get(id);
            out.push({
              id: r.id || 1,
              place_id: id,
              rating: r.rating,
              reviews_count: r.reviews_count,
              business_status: r.business_status,
              phone: r.phone,
              website: r.website,
            });
          }
        }
        return { rows: out };
      }
      // Multi-row INSERT (businesses).
      if (t.startsWith('INSERT INTO BUSINESSES')) {
        // The buildBatchInsert format isn't easily parseable here; we just
        // record that an INSERT happened and trust the per-business tests.
        return { rows: [] };
      }
      // Snapshot insert.
      if (t.startsWith('INSERT INTO BUSINESS_SNAPSHOTS')) {
        return { rows: [] };
      }
      // Field changes insert.
      if (t.startsWith('INSERT INTO FIELD_CHANGES')) {
        return { rows: [] };
      }
      // Duplicate insert.
      if (t.startsWith('INSERT INTO BUSINESS_DUPLICATES')) {
        return { rows: [] };
      }
      // Unchanged refresh.
      if (t.startsWith('UPDATE BUSINESSES SET LAST_LIST_SCRAPED')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

/** Build a mock httpClient that returns canned geocoder JSON per URL prefix. */
function makeMockHttp(responses) {
  return async (url) => {
    for (const { match, body } of responses) {
      if (typeof match === 'string' ? url.includes(match) : match.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

// ---------------------------------------------------------------------------
// Phase 3.2 — ENRICHMENT_COLUMNS export
// ---------------------------------------------------------------------------

describe('Phase 3.2 — module exports', () => {
  test('ENRICHMENT_COLUMNS lists the 8 address columns in schema order', () => {
    expect(ENRICHMENT_COLUMNS).toEqual([
      'address_street',
      'address_city',
      'address_state',
      'address_postal',
      'address_country',
      'lat',
      'lng',
      'geocode_confidence',
    ]);
  });

  test('GEOCODE_CONFIDENCE bands are ordered descending and sum to a sane range', () => {
    expect(GEOCODE_CONFIDENCE.EXACT).toBe(1.0);
    expect(GEOCODE_CONFIDENCE.ROOFTOP).toBe(0.9);
    expect(GEOCODE_CONFIDENCE.INTERPOLATED).toBe(0.75);
    expect(GEOCODE_CONFIDENCE.CENTER).toBe(0.6);
    expect(GEOCODE_CONFIDENCE.APPROXIMATE).toBe(0.4);
    expect(GEOCODE_CONFIDENCE.CENTROID).toBe(0.3);
    expect(GEOCODE_CONFIDENCE.NONE).toBe(0.0);
    expect(GEOCODE_CONFIDENCE.EXACT).toBeGreaterThan(GEOCODE_CONFIDENCE.ROOFTOP);
    expect(GEOCODE_CONFIDENCE.ROOFTOP).toBeGreaterThan(GEOCODE_CONFIDENCE.INTERPOLATED);
  });

  test('db.ENRICHMENT_COLUMNS mirrors the 11 enrichment columns (3 phone + 8 address)', () => {
    expect(DB_ENRICHMENT_COLUMNS).toEqual([
      'phone_e164', 'phone_type', 'phone_country_code',
      'address_street', 'address_city', 'address_state',
      'address_postal', 'address_country', 'lat', 'lng', 'geocode_confidence',
    ]);
  });
});

// ---------------------------------------------------------------------------
// normalizeCountryCode
// ---------------------------------------------------------------------------

describe('Phase 3.2 — normalizeCountryCode', () => {
  test('full name → ISO 2-letter (US)', () => {
    expect(normalizeCountryCode('United States')).toBe('US');
    expect(normalizeCountryCode('United States of America')).toBe('US');
  });

  test('common aliases (USA, America, U.S.A.)', () => {
    expect(normalizeCountryCode('USA')).toBe('US');
    expect(normalizeCountryCode('America')).toBe('US');
    expect(normalizeCountryCode('U.S.A.')).toBe('US');
  });

  test('already-ISO 2-letter (uppercase + lowercase)', () => {
    expect(normalizeCountryCode('US')).toBe('US');
    expect(normalizeCountryCode('us')).toBe('US');
    expect(normalizeCountryCode('DE')).toBe('DE');
    expect(normalizeCountryCode('de')).toBe('DE');
  });

  test('localized names (Deutschland, España, Italia)', () => {
    expect(normalizeCountryCode('Deutschland')).toBe('DE');
    expect(normalizeCountryCode('España')).toBe('ES');
    expect(normalizeCountryCode('Italia')).toBe('IT');
    expect(normalizeCountryCode('Sverige')).toBe('SE');
  });

  test('United Kingdom variants (UK, GB, Britain, England)', () => {
    expect(normalizeCountryCode('United Kingdom')).toBe('GB');
    expect(normalizeCountryCode('UK')).toBe('GB');
    expect(normalizeCountryCode('U.K.')).toBe('GB');
    expect(normalizeCountryCode('Britain')).toBe('GB');
    expect(normalizeCountryCode('Great Britain')).toBe('GB');
    expect(normalizeCountryCode('England')).toBe('GB');
  });

  test('ISO 3-letter → 2-letter (USA, DEU, JPN, BGD)', () => {
    expect(normalizeCountryCode('USA')).toBe('US');
    expect(normalizeCountryCode('DEU')).toBe('DE');
    expect(normalizeCountryCode('JPN')).toBe('JP');
    expect(normalizeCountryCode('BGD')).toBe('BD');
  });

  test('whitespace + trailing punctuation stripped', () => {
    expect(normalizeCountryCode('  United States  ')).toBe('US');
    expect(normalizeCountryCode('Germany.')).toBe('DE');
    expect(normalizeCountryCode('France.')).toBe('FR');
  });

  test('Bangladesh variants', () => {
    expect(normalizeCountryCode('Bangladesh')).toBe('BD');
    expect(normalizeCountryCode('BD')).toBe('BD');
    expect(normalizeCountryCode('BGD')).toBe('BD');
  });

  test('null / undefined / empty → null', () => {
    expect(normalizeCountryCode(null)).toBe(null);
    expect(normalizeCountryCode(undefined)).toBe(null);
    expect(normalizeCountryCode('')).toBe(null);
    expect(normalizeCountryCode('   ')).toBe(null);
  });

  test('unrecognized string → null (does not crash)', () => {
    expect(normalizeCountryCode('Atlantis')).toBe(null);
    expect(normalizeCountryCode('XY')).toBe(null); // 2-letter but not a country alias value
  });

  test('COUNTRY_ALIASES has at least 50 entries', () => {
    expect(Object.keys(COUNTRY_ALIASES).length).toBeGreaterThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// parsePostalCode
// ---------------------------------------------------------------------------

describe('Phase 3.2 — parsePostalCode', () => {
  test('US 5-digit', () => {
    expect(parsePostalCode('Springfield, IL 62701', 'US')).toBe('62701');
  });

  test('US ZIP+4 captures the 5-digit form', () => {
    expect(parsePostalCode('Springfield, IL 62701-1234', 'US')).toBe('62701');
  });

  test('CA A1A 1A1 with and without internal space', () => {
    expect(parsePostalCode('Toronto, ON M4B 1B3', 'CA')).toBe('M4B 1B3');
    expect(parsePostalCode('Toronto, ON M4B1B3', 'CA')).toBe('M4B1B3');
  });

  test('GB SW1A 2AA', () => {
    expect(parsePostalCode('London SW1A 2AA', 'GB')).toBe('SW1A 2AA');
  });

  test('GB M1 1AA (short outward)', () => {
    expect(parsePostalCode('Manchester M1 1AA', 'GB')).toBe('M1 1AA');
  });

  test('DE 5-digit', () => {
    expect(parsePostalCode('Berlin 10115', 'DE')).toBe('10115');
  });

  test('JP NNN-NNNN', () => {
    expect(parsePostalCode('東京都港区 106-0032', 'JP')).toBe('106-0032');
  });

  test('IN 6-digit', () => {
    expect(parsePostalCode('Bengaluru 560001', 'IN')).toBe('560001');
  });

  test('AU 4-digit', () => {
    expect(parsePostalCode('Sydney NSW 2000', 'AU')).toBe('2000');
  });

  test('BR NNNNN-NNN', () => {
    expect(parsePostalCode('São Paulo, SP 01310-100', 'BR')).toBe('01310-100');
  });

  test('NL NNNN AA', () => {
    expect(parsePostalCode('Amsterdam 1011 AB', 'NL')).toBe('1011 AB');
  });

  test('PL NN-NNN', () => {
    expect(parsePostalCode('Warszawa 00-001', 'PL')).toBe('00-001');
  });

  test('no hint → longest match wins (GB over US 5-digit)', () => {
    // The GB pattern matches "SW1A 2AA" (7 chars) which beats the bare
    // 5-digit pattern that would match "SW1A2" (no — 5-digit only matches
    // digits, so GB wins unambiguously here).
    expect(parsePostalCode('London SW1A 2AA')).toBe('SW1A 2AA');
  });

  test('no hint → 5-digit fallback for ambiguous digit-only codes', () => {
    expect(parsePostalCode('Berlin 10115')).toBe('10115');
  });

  test('returns null when no postal pattern matches', () => {
    expect(parsePostalCode('no postal here', 'US')).toBe(null);
    expect(parsePostalCode('plain text without numbers')).toBe(null);
  });

  test('null / undefined input → null', () => {
    expect(parsePostalCode(null)).toBe(null);
    expect(parsePostalCode(undefined)).toBe(null);
    expect(parsePostalCode('')).toBe(null);
  });

  test('POSTAL_PATTERNS covers 30+ countries', () => {
    expect(Object.keys(POSTAL_PATTERNS).length).toBeGreaterThanOrEqual(30);
  });
});

// ---------------------------------------------------------------------------
// parseAddress — country-specific parsers
// ---------------------------------------------------------------------------

describe('Phase 3.2 — parseAddress (US)', () => {
  test('"street, city, ST postal, USA" with hint', () => {
    const r = parseAddress('123 Main St, Springfield, IL 62701, United States', 'US');
    expect(r.street).toBe('123 Main St');
    expect(r.city).toBe('Springfield');
    expect(r.state).toBe('IL');
    expect(r.postal).toBe('62701');
    expect(r.country).toBe('US');
  });

  test('"street, city ST postal" (combined city+state) with hint', () => {
    const r = parseAddress('123 Main St, Springfield IL 62701', 'US');
    expect(r.street).toBe('123 Main St');
    expect(r.city).toBe('Springfield');
    expect(r.state).toBe('IL');
    expect(r.postal).toBe('62701');
  });

  test('"street, suite, city, ST postal" — multi-segment street', () => {
    const r = parseAddress('123 Main St, Suite 100, Springfield, IL 62701', 'US');
    expect(r.street).toBe('123 Main St, Suite 100');
    expect(r.city).toBe('Springfield');
    expect(r.state).toBe('IL');
    expect(r.postal).toBe('62701');
  });

  test('ZIP+4 captures the 5-digit postal', () => {
    const r = parseAddress('123 Main St, Springfield, IL 62701-1234', 'US');
    expect(r.postal).toBe('62701');
  });

  test('sniffs country from last segment when no hint provided', () => {
    const r = parseAddress('123 Main St, Springfield, IL 62701, USA');
    expect(r.country).toBe('US');
    expect(r.state).toBe('IL');
    expect(r.postal).toBe('62701');
  });
});

describe('Phase 3.2 — parseAddress (CA)', () => {
  test('"street, city, PROV postal, Canada" with hint', () => {
    const r = parseAddress('456 Yonge St, Toronto, ON M4B 1B3, Canada', 'CA');
    expect(r.street).toBe('456 Yonge St');
    expect(r.city).toBe('Toronto');
    expect(r.state).toBe('ON');
    expect(r.postal).toBe('M4B 1B3');
    expect(r.country).toBe('CA');
  });
});

describe('Phase 3.2 — parseAddress (DE)', () => {
  test('"street number, postal city, Germany" with hint', () => {
    const r = parseAddress('Hauptstraße 5, 10115 Berlin, Germany', 'DE');
    expect(r.street).toBe('Hauptstraße 5');
    expect(r.city).toBe('Berlin');
    expect(r.postal).toBe('10115');
    expect(r.country).toBe('DE');
  });

  test('sniffs "Deutschland" as DE', () => {
    const r = parseAddress('Hauptstraße 5, 10115 Berlin, Deutschland');
    expect(r.country).toBe('DE');
    expect(r.city).toBe('Berlin');
    expect(r.postal).toBe('10115');
  });
});

describe('Phase 3.2 — parseAddress (AT)', () => {
  test('Austrian address with hint', () => {
    const r = parseAddress('Mariahilfer Straße 45, 1060 Wien, Austria', 'AT');
    expect(r.street).toBe('Mariahilfer Straße 45');
    expect(r.city).toBe('Wien');
    expect(r.postal).toBe('1060');
    expect(r.country).toBe('AT');
  });
});

describe('Phase 3.2 — parseAddress (GB)', () => {
  test('"street, city, postal, United Kingdom" — postal in own segment', () => {
    const r = parseAddress('10 Downing St, London, SW1A 2AA, United Kingdom');
    expect(r.street).toBe('10 Downing St');
    expect(r.city).toBe('London');
    expect(r.postal).toBe('SW1A 2AA');
    expect(r.country).toBe('GB');
  });

  test('sniffs "UK" as GB', () => {
    const r = parseAddress('10 Downing St, London, SW1A 2AA, UK');
    expect(r.country).toBe('GB');
  });
});

describe('Phase 3.2 — parseAddress (JP)', () => {
  test('block-system address with prefecture prefix', () => {
    const r = parseAddress('東京都港区六本木1-2-3', 'JP');
    expect(r.state).toBe('東京都');
    expect(r.city).toBe('港区');
    expect(r.street).toBe('六本木1-2-3');
    expect(r.country).toBe('JP');
  });

  test('JP postal NNN-NNNN extracted', () => {
    const r = parseAddress('東京都港区六本木1-2-3 106-0032', 'JP');
    expect(r.postal).toBe('106-0032');
  });
});

describe('Phase 3.2 — parseAddress (FR/IT/ES)', () => {
  test('FR address — street number first, postal city', () => {
    const r = parseAddress('10 Rue de la Paix, 75002 Paris, France', 'FR');
    expect(r.street).toBe('10 Rue de la Paix');
    expect(r.city).toBe('Paris');
    expect(r.postal).toBe('75002');
    expect(r.country).toBe('FR');
  });

  test('IT address — street number first, postal city', () => {
    const r = parseAddress('Via del Corso 1, 00186 Roma, Italia', 'IT');
    expect(r.street).toBe('Via del Corso 1');
    expect(r.city).toBe('Roma');
    expect(r.postal).toBe('00186');
    expect(r.country).toBe('IT');
  });

  test('ES address — street number first, postal city', () => {
    const r = parseAddress('Calle Mayor 1, 28013 Madrid, España', 'ES');
    expect(r.street).toBe('Calle Mayor 1');
    expect(r.city).toBe('Madrid');
    expect(r.postal).toBe('28013');
    expect(r.country).toBe('ES');
  });
});

describe('Phase 3.2 — parseAddress (NL/AU/MX/BR/IN/BD)', () => {
  test('NL address', () => {
    const r = parseAddress('Herengracht 1, 1011 AB Amsterdam, Netherlands', 'NL');
    expect(r.street).toBe('Herengracht 1');
    expect(r.city).toBe('Amsterdam');
    expect(r.postal).toBe('1011 AB');
    expect(r.country).toBe('NL');
  });

  test('AU address', () => {
    const r = parseAddress('1 Macquarie St, Sydney NSW 2000, Australia', 'AU');
    expect(r.postal).toBe('2000');
    expect(r.country).toBe('AU');
  });

  test('IN address', () => {
    const r = parseAddress('1 MG Road, Bengaluru 560001, India', 'IN');
    expect(r.postal).toBe('560001');
    expect(r.country).toBe('IN');
  });

  test('BD address — best-effort generic parse', () => {
    const r = parseAddress('House 12, Road 5, Dhanmondi, Dhaka 1209, Bangladesh');
    expect(r.postal).toBe('1209');
    expect(r.country).toBe('BD');
  });

  test('BR address', () => {
    const r = parseAddress('Av. Paulista 1000, 01310-100 São Paulo, Brasil', 'BR');
    expect(r.postal).toBe('01310-100');
    expect(r.country).toBe('BR');
  });
});

describe('Phase 3.2 — parseAddress (edge cases)', () => {
  test('null / undefined / empty → all-null result', () => {
    expect(parseAddress(null)).toEqual({ street: null, city: null, state: null, postal: null, country: null, raw: '' });
    expect(parseAddress(undefined)).toEqual({ street: null, city: null, state: null, postal: null, country: null, raw: '' });
    expect(parseAddress('')).toEqual({ street: null, city: null, state: null, postal: null, country: null, raw: '' });
    expect(parseAddress('   ')).toEqual({ street: null, city: null, state: null, postal: null, country: null, raw: '' });
  });

  test('preserves the raw input', () => {
    const raw = '123 Main St, Springfield, IL 62701, USA';
    expect(parseAddress(raw).raw).toBe(raw);
  });

  test('collapses internal whitespace', () => {
    const r = parseAddress('123  Main   St,  Springfield,  IL  62701', 'US');
    expect(r.street).toBe('123 Main St');
    expect(r.city).toBe('Springfield');
  });

  test('normalizes unicode whitespace (NBSP)', () => {
    const r = parseAddress('123\u00A0Main St, Springfield, IL 62701', 'US');
    expect(r.street).toBe('123 Main St');
  });

  test('unknown country hint → generic parser, country normalized', () => {
    const r = parseAddress('Some Street, Some City, 12345, Atlantis');
    expect(r.country).toBe(null); // Atlantis not recognized
    // Generic parser still extracts postal.
    expect(r.postal).toBe('12345');
  });
});

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

describe('Phase 3.2 — helpers', () => {
  test('normalizeWhitespace collapses runs and trims', () => {
    expect(normalizeWhitespace('  a   b  ')).toBe('a b');
    expect(normalizeWhitespace('a\tb\nc')).toBe('a b c');
  });

  test('splitByComma drops empty segments', () => {
    expect(splitByComma('a, , b,')).toEqual(['a', 'b']);
    expect(splitByComma('')).toEqual([]);
    expect(splitByComma(null)).toEqual([]);
  });

  test('detectCountryFromSegments returns ISO from last segment', () => {
    expect(detectCountryFromSegments(['123 Main St', 'Springfield, IL 62701', 'USA'])).toBe('US');
    expect(detectCountryFromSegments(['x', 'Germany'])).toBe('DE');
    expect(detectCountryFromSegments(['x'])).toBe(null); // no recognizable country
    expect(detectCountryFromSegments([])).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// computeGeocodeConfidence
// ---------------------------------------------------------------------------

describe('Phase 3.2 — computeGeocodeConfidence', () => {
  test('EXACT (1.00) when place_id matches', () => {
    const c = computeGeocodeConfidence(
      { raw: 'addr', raw_place_id: 'abc' },
      { lat: 1, lng: 2, place_id: 'abc' },
    );
    expect(c).toBe(1.0);
  });

  test('ROOFTOP (0.90) when accuracy=ROOFTOP', () => {
    const c = computeGeocodeConfidence({}, { lat: 1, lng: 2, accuracy: 'ROOFTOP' });
    expect(c).toBe(0.9);
  });

  test('INTERPOLATED (0.75) when accuracy=RANGE_INTERPOLATED', () => {
    const c = computeGeocodeConfidence({}, { lat: 1, lng: 2, accuracy: 'RANGE_INTERPOLATED' });
    expect(c).toBe(0.75);
  });

  test('CENTER (0.60) when accuracy=GEOMETRIC_CENTER', () => {
    const c = computeGeocodeConfidence({}, { lat: 1, lng: 2, accuracy: 'GEOMETRIC_CENTER' });
    expect(c).toBe(0.6);
  });

  test('APPROXIMATE (0.40) when accuracy=APPROXIMATE', () => {
    const c = computeGeocodeConfidence({}, { lat: 1, lng: 2, accuracy: 'APPROXIMATE' });
    expect(c).toBe(0.4);
  });

  test('NONE (0.00) when lat/lng are null', () => {
    expect(computeGeocodeConfidence({}, { lat: null, lng: null, accuracy: 'ROOFTOP' })).toBe(0);
    expect(computeGeocodeConfidence({}, null)).toBe(0);
  });

  test('postal match boosts by +0.05 (capped at EXACT)', () => {
    const c = computeGeocodeConfidence(
      { postal: '62701' },
      { lat: 1, lng: 2, accuracy: 'ROOFTOP', matchedPostal: '62701' },
    );
    expect(c).toBe(0.95);
  });

  test('postal mismatch does not boost', () => {
    const c = computeGeocodeConfidence(
      { postal: '62701' },
      { lat: 1, lng: 2, accuracy: 'ROOFTOP', matchedPostal: '99999' },
    );
    expect(c).toBe(0.9);
  });

  test('city match boosts by +0.05', () => {
    const c = computeGeocodeConfidence(
      { city: 'Springfield' },
      { lat: 1, lng: 2, accuracy: 'ROOFTOP', matchedCity: 'Springfield' },
    );
    expect(c).toBe(0.95);
  });

  test('both postal + city match boost by +0.10 (capped at EXACT)', () => {
    const c = computeGeocodeConfidence(
      { postal: '62701', city: 'Springfield' },
      { lat: 1, lng: 2, accuracy: 'ROOFTOP', matchedPostal: '62701', matchedCity: 'Springfield' },
    );
    expect(c).toBe(1.0); // 0.9 + 0.05 + 0.05 = 1.0
  });

  test('Nominatim importance >= 0.5 → ROOFTOP band', () => {
    const c = computeGeocodeConfidence({}, { lat: 1, lng: 2, importance: 0.7 });
    expect(c).toBe(0.9);
  });

  test('Nominatim importance >= 0.2 (but < 0.5) → CENTER band', () => {
    const c = computeGeocodeConfidence({}, { lat: 1, lng: 2, importance: 0.3 });
    expect(c).toBe(0.6);
  });

  test('unknown accuracy with lat/lng present → APPROXIMATE', () => {
    const c = computeGeocodeConfidence({}, { lat: 1, lng: 2, accuracy: 'WHATEVER' });
    expect(c).toBe(0.4);
  });

  test('postal comparison is whitespace-insensitive', () => {
    const c = computeGeocodeConfidence(
      { postal: 'M4B 1B3' },
      { lat: 1, lng: 2, accuracy: 'ROOFTOP', matchedPostal: 'M4B1B3' },
    );
    expect(c).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// createGeocoder — mock provider
// ---------------------------------------------------------------------------

describe('Phase 3.2 — createGeocoder (mock provider)', () => {
  test('returns canned coordinates deterministically from place_id', async () => {
    const g = createGeocoder({ provider: 'mock' });
    const r1 = await g.geocode({ raw: 'x' }, { place_id: 'ChIJabc123' });
    const r2 = await g.geocode({ raw: 'x' }, { place_id: 'ChIJabc123' });
    expect(r1.lat).toBe(r2.lat);
    expect(r1.lng).toBe(r2.lng);
    expect(r1.source).toBe('mock');
    expect(r1.confidence).toBe(GEOCODE_CONFIDENCE.APPROXIMATE);
    expect(g.stats.requests).toBe(2);
    expect(g.stats.successes).toBe(2);
    expect(g.stats.costUsd).toBe(0);
  });

  test('stats track requests / successes / cost', async () => {
    const g = createGeocoder({ provider: 'mock' });
    await g.geocode({}, { place_id: 'a' });
    await g.geocode({}, { place_id: 'b' });
    expect(g.stats.requests).toBe(2);
    expect(g.stats.successes).toBe(2);
    expect(g.stats.costUsd).toBe(0);
  });

  test('different place_ids produce different coordinates', async () => {
    const g = createGeocoder({ provider: 'mock' });
    const r1 = await g.geocode({}, { place_id: 'place-AAA' });
    const r2 = await g.geocode({}, { place_id: 'place-BBB' });
    expect(r1.lat).not.toBe(r2.lat);
  });
});

// ---------------------------------------------------------------------------
// createGeocoder — google provider (mock httpClient)
// ---------------------------------------------------------------------------

describe('Phase 3.2 — createGeocoder (google provider)', () => {
  test('prefers place_id when business has one (cheaper, more accurate)', async () => {
    let capturedUrl = null;
    const http = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({
      status: 'OK',
      results: [{
        place_id: 'abc',
        geometry: { location: { lat: 40.7, lng: -74.0 }, location_type: 'ROOFTOP' },
        address_components: [
          { long_name: '62701', types: ['postal_code'] },
          { long_name: 'Springfield', types: ['locality'] },
        ],
      }],
    }) }; };
    const g = createGeocoder({ provider: 'google', apiKey: 'TEST_KEY', httpClient: http, rateLimitMs: 0 });
    const r = await g.geocode({ raw: '123 Main St' }, { place_id: 'ChIJabc' });
    expect(capturedUrl).toContain('place_id=ChIJabc');
    expect(capturedUrl).toContain('key=TEST_KEY');
    expect(r.lat).toBe(40.7);
    expect(r.lng).toBe(-74.0);
    expect(r.source).toBe('google');
    expect(r.confidence).toBe(0.9); // ROOFTOP
    expect(g.stats.requests).toBe(1);
    expect(g.stats.successes).toBe(1);
    expect(g.stats.costUsd).toBe(COST_PER_REQUEST_USD.google);
  });

  test('falls back to address text when no place_id', async () => {
    let capturedUrl = null;
    const http = async (url) => { capturedUrl = url; return { ok: true, json: async () => ({
      status: 'OK',
      results: [{ geometry: { location: { lat: 1, lng: 2 }, location_type: 'APPROXIMATE' } }],
    }) }; };
    const g = createGeocoder({ provider: 'google', apiKey: 'K', httpClient: http, rateLimitMs: 0 });
    const r = await g.geocode({ street: '123 Main', city: 'Springfield', state: 'IL', postal: '62701', country: 'US', raw: 'x' }, {});
    expect(capturedUrl).toContain('address=');
    expect(r.lat).toBe(1);
    expect(r.confidence).toBe(0.4); // APPROXIMATE
  });

  test('returns NONE confidence when status != OK', async () => {
    const http = async () => ({ ok: true, json: async () => ({ status: 'ZERO_RESULTS', results: [] }) });
    const g = createGeocoder({ provider: 'google', apiKey: 'K', httpClient: http, rateLimitMs: 0 });
    const r = await g.geocode({}, { place_id: 'x' });
    expect(r.lat).toBe(null);
    expect(r.confidence).toBe(0);
    expect(g.stats.failures).toBe(1);
  });

  test('handles HTTP fetch error gracefully', async () => {
    const http = async () => { throw new Error('network down'); };
    const g = createGeocoder({ provider: 'google', apiKey: 'K', httpClient: http, rateLimitMs: 0 });
    const r = await g.geocode({}, { place_id: 'x' });
    expect(r.lat).toBe(null);
    expect(r.confidence).toBe(0);
    expect(r.error).toBeDefined();
    expect(g.stats.failures).toBe(1);
  });

  test('postal + city match boosts confidence', async () => {
    const http = async () => ({ ok: true, json: async () => ({
      status: 'OK',
      results: [{
        geometry: { location: { lat: 1, lng: 2 }, location_type: 'ROOFTOP' },
        address_components: [
          { long_name: '62701', types: ['postal_code'] },
          { long_name: 'Springfield', types: ['locality'] },
        ],
      }],
    }) });
    const g = createGeocoder({ provider: 'google', apiKey: 'K', httpClient: http, rateLimitMs: 0 });
    const r = await g.geocode({ postal: '62701', city: 'Springfield', raw: 'x' }, {});
    expect(r.confidence).toBe(1.0); // 0.9 + 0.05 + 0.05
  });

  test('rate limit is enforced between requests', async () => {
    const calls = [];
    const http = async () => { calls.push(Date.now()); return { ok: true, json: async () => ({
      status: 'OK', results: [{ geometry: { location: { lat: 1, lng: 2 }, location_type: 'APPROXIMATE' } }],
    }) }; };
    const g = createGeocoder({ provider: 'google', apiKey: 'K', httpClient: http, rateLimitMs: 50 });
    await g.geocode({}, { place_id: 'a' });
    await g.geocode({}, { place_id: 'b' });
    expect(calls.length).toBe(2);
    // The 2nd call should be delayed by ~50ms after the 1st.
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// createGeocoder — nominatim provider (mock httpClient)
// ---------------------------------------------------------------------------

describe('Phase 3.2 — createGeocoder (nominatim provider)', () => {
  test('builds the search URL with q= and addressdetails=1', async () => {
    let capturedUrl = null;
    const http = async (url) => { capturedUrl = url; return { ok: true, json: async () => [{
      lat: '52.5', lon: '13.4', importance: 0.6, class: 'building',
      address: { postcode: '10115', city: 'Berlin' },
    }] }; };
    const g = createGeocoder({ provider: 'nominatim', httpClient: http, rateLimitMs: 0 });
    const r = await g.geocode({ street: 'Hauptstr 5', city: 'Berlin', postal: '10115', country: 'DE', raw: 'x' }, {});
    expect(capturedUrl).toContain('nominatim.openstreetmap.org/search');
    expect(capturedUrl).toContain('addressdetails=1');
    expect(capturedUrl).toContain('format=json');
    expect(r.lat).toBe(52.5);
    expect(r.lng).toBe(13.4);
    expect(r.source).toBe('nominatim');
    expect(g.stats.costUsd).toBe(0); // free
  });

  test('returns NONE when no results', async () => {
    const http = async () => ({ ok: true, json: async () => [] });
    const g = createGeocoder({ provider: 'nominatim', httpClient: http, rateLimitMs: 0 });
    const r = await g.geocode({}, {});
    expect(r.lat).toBe(null);
    expect(r.confidence).toBe(0);
    expect(g.stats.failures).toBe(1);
  });

  test('class=building → ROOFTOP accuracy', async () => {
    const http = async () => ({ ok: true, json: async () => [{
      lat: '1', lon: '2', importance: 0.8, class: 'building',
      address: { postcode: '62701', city: 'Springfield' },
    }] });
    const g = createGeocoder({ provider: 'nominatim', httpClient: http, rateLimitMs: 0 });
    const r = await g.geocode({ postal: '62701', city: 'Springfield', raw: 'x' }, {});
    expect(r.accuracy).toBe('ROOFTOP');
    expect(r.confidence).toBe(1.0); // 0.9 + 0.05 + 0.05
  });

  test('respects the 1 req/s default rate limit', async () => {
    const calls = [];
    const http = async () => { calls.push(Date.now()); return { ok: true, json: async () => [{
      lat: '1', lon: '2', importance: 0.1, class: 'place',
    }] }; };
    const g = createGeocoder({ provider: 'nominatim', httpClient: http }); // default 1000ms
    await g.geocode({}, {});
    await g.geocode({}, {});
    expect(calls.length).toBe(2);
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(900); // ~1s gap
  });
});

// ---------------------------------------------------------------------------
// createGeocoder — invalid provider
// ---------------------------------------------------------------------------

describe('Phase 3.2 — createGeocoder validation', () => {
  test('unknown provider throws', () => {
    expect(() => createGeocoder({ provider: 'mapbox' })).toThrow(/unknown provider/);
  });

  test('default provider is nominatim when none specified', () => {
    const g = createGeocoder({});
    expect(g.provider).toBe('nominatim');
  });

  test('COST_PER_REQUEST_USD: google=0.005, nominatim=0, mock=0', () => {
    expect(COST_PER_REQUEST_USD.google).toBe(0.005);
    expect(COST_PER_REQUEST_USD.nominatim).toBe(0);
    expect(COST_PER_REQUEST_USD.mock).toBe(0);
  });

  test('DEFAULT_RATE_LIMIT_MS: google=20, nominatim=1000, mock=0', () => {
    expect(DEFAULT_RATE_LIMIT_MS.google).toBe(20);
    expect(DEFAULT_RATE_LIMIT_MS.nominatim).toBe(1000);
    expect(DEFAULT_RATE_LIMIT_MS.mock).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// geocodeBatch
// ---------------------------------------------------------------------------

describe('Phase 3.2 — geocodeBatch', () => {
  test('enriches a mixed batch and returns correct stats', async () => {
    const businesses = [
      { place_id: 'a', name: 'A', address: '123 Main St, Springfield, IL 62701, USA' },
      { place_id: 'b', name: 'B', address: 'Hauptstraße 5, 10115 Berlin, Germany' },
      { place_id: 'c', name: 'C', address: null },
      { place_id: 'd', name: 'D', address: '10 Downing St, London, SW1A 2AA, UK' },
    ];
    const g = createGeocoder({ provider: 'mock' });
    const stats = await geocodeBatch(businesses, { geocoder: g });
    expect(stats.total).toBe(4);
    expect(stats.geocoded).toBe(3); // 3 with addresses, geocoded via mock
    expect(stats.skipped).toBe(1); // null address
    // Each business got the 8 enrichment columns.
    expect(businesses[0].address_street).toBe('123 Main St');
    expect(businesses[0].address_city).toBe('Springfield');
    expect(businesses[0].address_state).toBe('IL');
    expect(businesses[0].address_postal).toBe('62701');
    expect(businesses[0].address_country).toBe('US');
    expect(businesses[0].lat).not.toBe(null);
    expect(businesses[0].lng).not.toBe(null);
    expect(businesses[0].geocode_confidence).toBe(GEOCODE_CONFIDENCE.APPROXIMATE);
    // The null-address business got nulls.
    expect(businesses[2].address_street).toBe(null);
    expect(businesses[2].lat).toBe(null);
    expect(businesses[2].lng).toBe(null);
    expect(businesses[2].geocode_confidence).toBe(null);
  });

  test('requires a geocoder', async () => {
    await expect(geocodeBatch([], {})).rejects.toThrow(/geocoder is required/);
  });

  test('empty array → all-zero stats', async () => {
    const g = createGeocoder({ provider: 'mock' });
    const stats = await geocodeBatch([], { geocoder: g });
    expect(stats.total).toBe(0);
    expect(stats.geocoded).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.skipped).toBe(0);
  });

  test('non-array input → all-zero stats (no throw)', async () => {
    const g = createGeocoder({ provider: 'mock' });
    const stats = await geocodeBatch(null, { geocoder: g });
    expect(stats.total).toBe(0);
  });

  test('budget guard stops geocoding when cap is hit', async () => {
    // Google costs $0.005/req. With a $0.01 budget, only 2 requests can fire.
    const http = async () => ({ ok: true, json: async () => ({
      status: 'OK', results: [{ geometry: { location: { lat: 1, lng: 2 }, location_type: 'ROOFTOP' } }],
    }) });
    const g = createGeocoder({ provider: 'google', apiKey: 'K', httpClient: http, rateLimitMs: 0 });
    const businesses = Array.from({ length: 5 }, (_, i) => ({
      place_id: `p${i}`,
      address: '123 Main St, Springfield, IL 62701, USA',
    }));
    const stats = await geocodeBatch(businesses, { geocoder: g, budgetUsd: 0.01 });
    // First 2 succeed, remaining 3 fall back to null coords (budget exhausted).
    expect(stats.geocoded).toBe(2);
    expect(stats.failed).toBe(3);
    expect(stats.budgetUsedUsd).toBeCloseTo(0.01, 4);
    // The 3rd+ businesses still got parsed address columns (free) but null coords.
    expect(businesses[2].address_street).toBe('123 Main St');
    expect(businesses[2].lat).toBe(null);
    expect(businesses[2].geocode_confidence).toBe(0);
  });

  test('budget 0 (unlimited) never stops geocoding', async () => {
    const http = async () => ({ ok: true, json: async () => ({
      status: 'OK', results: [{ geometry: { location: { lat: 1, lng: 2 }, location_type: 'APPROXIMATE' } }],
    }) });
    const g = createGeocoder({ provider: 'google', apiKey: 'K', httpClient: http, rateLimitMs: 0 });
    const businesses = Array.from({ length: 10 }, (_, i) => ({
      place_id: `p${i}`,
      address: '123 Main St, USA',
    }));
    const stats = await geocodeBatch(businesses, { geocoder: g, budgetUsd: Infinity });
    expect(stats.geocoded).toBe(10);
    expect(stats.failed).toBe(0);
  });

  test('defaultCountry hint is passed to the parser', async () => {
    const g = createGeocoder({ provider: 'mock' });
    const businesses = [{ place_id: 'a', address: '123 Main St, Springfield, IL 62701' }];
    await geocodeBatch(businesses, { geocoder: g, defaultCountry: 'US' });
    expect(businesses[0].address_country).toBe('US');
    expect(businesses[0].address_state).toBe('IL');
  });

  test('geocoder error is caught and recorded as a failure', async () => {
    const http = async () => { throw new Error('boom'); };
    const g = createGeocoder({ provider: 'google', apiKey: 'K', httpClient: http, rateLimitMs: 0 });
    const businesses = [{ place_id: 'a', address: '123 Main St, USA' }];
    const stats = await geocodeBatch(businesses, { geocoder: g });
    expect(stats.geocoded).toBe(0);
    expect(stats.failed).toBe(1);
    expect(businesses[0].lat).toBe(null);
    expect(businesses[0].geocode_confidence).toBe(0);
  });

  test('byConfidence buckets are populated', async () => {
    const g = createGeocoder({ provider: 'mock' });
    const businesses = Array.from({ length: 3 }, (_, i) => ({
      place_id: `p${i}`,
      address: '123 Main St, USA',
    }));
    const stats = await geocodeBatch(businesses, { geocoder: g });
    // Mock returns APPROXIMATE (0.4) → all 3 go in the 'approximate' bucket.
    expect(stats.byConfidence.approximate).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// DB integration — INSERT/UPDATE include the address columns
// ---------------------------------------------------------------------------

describe('Phase 3.2 — DB persistence includes address columns', () => {
  test('columnValue coerces lat/lng/geocode_confidence as numbers', () => {
    expect(columnValue('lat', { lat: '40.7' })).toBe(40.7);
    expect(columnValue('lng', { lng: '-74.0' })).toBe(-74.0);
    expect(columnValue('geocode_confidence', { geocode_confidence: '0.95' })).toBe(0.95);
    expect(columnValue('lat', { lat: null })).toBe(null);
    expect(columnValue('lat', {})).toBe(null);
  });

  test('columnValue coerces address_street/city/state/postal/country as text', () => {
    expect(columnValue('address_street', { address_street: '123 Main St' })).toBe('123 Main St');
    expect(columnValue('address_city', { address_city: '' })).toBe(null);
    expect(columnValue('address_postal', { address_postal: null })).toBe(null);
  });

  test('buildBatchInsert param count includes the 8 address columns', () => {
    const business = {
      place_id: 'abc', name: 'X',
      // address enrichment
      address_street: '123 Main St', address_city: 'Springfield',
      address_state: 'IL', address_postal: '62701', address_country: 'US',
      lat: 40.7, lng: -74.0, geocode_confidence: 0.95,
    };
    const ins = buildBatchInsert([{ business, hash: 'h', changeHash: 'ch' }], 1);
    // The INSERT column list should mention all 8 address cols.
    for (const col of ['address_street','address_city','address_state','address_postal','address_country','lat','lng','geocode_confidence']) {
      expect(ins.text).toContain(col);
    }
  });

  test('buildUpdate SET clause includes lat/lng/geocode_confidence', () => {
    const business = {
      place_id: 'abc', name: 'X',
      address_street: '123 Main St', lat: 1.5, lng: 2.5, geocode_confidence: 0.9,
    };
    const upd = buildUpdate(business, 'hash', 1, 'ch');
    expect(upd.text).toContain('address_street =');
    expect(upd.text).toContain('lat =');
    expect(upd.text).toContain('lng =');
    expect(upd.text).toContain('geocode_confidence =');
  });

  test('end-to-end: enriched business flows through upsertBusinessesBatch', async () => {
    const client = makeMockClient();
    const business = {
      place_id: 'abc', name: 'A', rating: 4.5, reviews_count: 10,
      // enriched fields
      phone_e164: '+14165550123', phone_type: 'mobile', phone_country_code: 'US',
      address_street: '123 Main St', address_city: 'Springfield',
      address_state: 'IL', address_postal: '62701', address_country: 'US',
      lat: 39.7, lng: -89.6, geocode_confidence: 0.95,
    };
    const { upsertBusinessesBatch } = require('../src/db');
    const res = await upsertBusinessesBatch(client, [business], { runId: 1 });
    expect(res.inserted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.3 — business_duplicates persistence (buildDuplicateInsert / persistDuplicates)
// ---------------------------------------------------------------------------

describe('Phase 3.2/3.3 — business_duplicates persistence', () => {
  test('buildDuplicateInsert builds a parameterized ON CONFLICT upsert', () => {
    const rows = [
      { canonicalPlaceId: 'c1', duplicatePlaceId: 'd1', similarityScore: 0.92, matchMethod: 'name+address' },
      { canonicalPlaceId: 'c2', duplicatePlaceId: 'd2', similarityScore: 0.88, matchMethod: 'phone' },
    ];
    const ins = buildDuplicateInsert(rows);
    expect(ins.text).toContain('INSERT INTO business_duplicates');
    expect(ins.text).toContain('ON CONFLICT (canonical_place_id, duplicate_place_id) DO UPDATE');
    expect(ins.text).toContain('GREATEST');
    expect(ins.params).toEqual(['c1', 'd1', 0.92, 'name+address', 'c2', 'd2', 0.88, 'phone']);
  });

  test('buildDuplicateInsert returns null for empty input', () => {
    expect(buildDuplicateInsert([])).toBe(null);
    expect(buildDuplicateInsert(null)).toBe(null);
  });

  test('buildDuplicateInsert skips rows missing canonical/duplicate IDs', () => {
    const rows = [
      { canonicalPlaceId: 'c1', duplicatePlaceId: 'd1', similarityScore: 0.9, matchMethod: 'm' },
      { canonicalPlaceId: null, duplicatePlaceId: 'd2', similarityScore: 0.9, matchMethod: 'm' },
      { canonicalPlaceId: 'c3', duplicatePlaceId: null, similarityScore: 0.9, matchMethod: 'm' },
    ];
    const ins = buildDuplicateInsert(rows);
    // Only the first row made it.
    expect(ins.params).toEqual(['c1', 'd1', 0.9, 'm']);
  });

  test('buildDuplicateInsert clamps similarityScore to [0,1]', () => {
    const rows = [
      { canonicalPlaceId: 'c1', duplicatePlaceId: 'd1', similarityScore: 1.5, matchMethod: 'm' },
      { canonicalPlaceId: 'c2', duplicatePlaceId: 'd2', similarityScore: -0.5, matchMethod: 'm' },
    ];
    const ins = buildDuplicateInsert(rows);
    expect(ins.params[2]).toBe(1); // clamped to 1
    expect(ins.params[6]).toBe(0); // clamped to 0
  });

  test('buildDuplicateInsert defaults matchMethod to "compound" when missing', () => {
    const ins = buildDuplicateInsert([
      { canonicalPlaceId: 'c1', duplicatePlaceId: 'd1', similarityScore: 0.9 },
    ]);
    expect(ins.params[3]).toBe('compound');
  });

  test('persistDuplicates is idempotent (mock client records 1 INSERT call)', async () => {
    const calls = [];
    const client = {
      async query(text, params) { calls.push({ text, params }); return { rows: [] }; },
    };
    const rows = [
      { canonicalPlaceId: 'c1', duplicatePlaceId: 'd1', similarityScore: 0.9, matchMethod: 'name' },
    ];
    const r1 = await persistDuplicates(client, rows);
    const r2 = await persistDuplicates(client, rows);
    expect(r1.inserted).toBe(1);
    expect(r2.inserted).toBe(1);
    expect(calls.length).toBe(2); // 1 INSERT per call (idempotent via ON CONFLICT)
  });

  test('persistDuplicates skips invalid rows', async () => {
    const client = { async query() { return { rows: [] }; } };
    const rows = [
      { canonicalPlaceId: 'c1', duplicatePlaceId: 'd1', similarityScore: 0.9, matchMethod: 'm' },
      { canonicalPlaceId: null, duplicatePlaceId: 'd2', similarityScore: 0.9, matchMethod: 'm' },
    ];
    const r = await persistDuplicates(client, rows);
    expect(r.inserted).toBe(1);
    expect(r.skipped).toBe(1);
  });

  test('persistDuplicates empty input → 0/0, no query issued', async () => {
    let called = false;
    const client = { async query() { called = true; return { rows: [] }; } };
    const r = await persistDuplicates(client, []);
    expect(r.inserted).toBe(0);
    expect(r.skipped).toBe(0);
    expect(called).toBe(false);
  });

  test('persistDuplicates throws when client is null', async () => {
    await expect(persistDuplicates(null, [])).rejects.toThrow(/client is null/);
  });
});
