'use strict';

/**
 * src/enrichment/phone.js — Phase 3.1 — Phone Number Normalization & Validation
 *
 * Converts every scraped phone number to E.164 format, detects its type
 * (mobile | landline | toll_free | voip | invalid | unknown), resolves the ISO
 * 3166-1 alpha-2 country code, and flags invalid numbers. Built on
 * `libphonenumber-js` (pure JS, no native deps, offline — no telco API calls).
 *
 * WHY THIS MODULE EXISTS
 *   Raw Google Maps phones arrive in 20+ format variations:
 *     '+1 (416) 555-0123', '4165550123', '416-555-0123 ext 5',
 *     '(030) 1234567' (German), '০১৭১২-৩৪৫৬৭৮' (Bengali digits), etc.
 *   Without normalization clients can't auto-dial, can't dedup (Phase 3.3),
 *   can't detect invalid numbers, and refund-rates skyrocket. This module is
 *   the foundation for phone verification (3.5) and lead scoring (3.9).
 *
 * DESIGN RULES (per PHASE3_EXECUTION_PLAN.md §3.1)
 *   - Pure functions wherever possible (testable without a DB / network).
 *   - libphonenumber-js is loaded via a DI seam (`_loadLib`) so tests can
 *     inject a stub. Production uses `libphonenumber-js/max` for accurate
 *     type detection (the min build returns `undefined` for getType() in
 *     most regions — max metadata is ~45 KB larger but is the only way to
 *     distinguish mobile from landline).
 *   - Non-Latin digits (Arabic-Indic ٠١٢٣, Devanagari ०१२३, Persian ۰۱۲۳,
 *     Bengali ০১২৩) are transliterated to ASCII before parsing — Google's
 *     UI sometimes surfaces localized digits.
 *   - Extensions (`ext`, `x`, `,`, `;` postfixes) are stripped before
 *     parsing and captured in the `extension` field of the result.
 *   - A returned `e164: null` + `type: 'invalid'` (or 'unknown') means the
 *     number could not be normalized — callers should keep the raw phone
 *     and flag the row for review.
 *
 * PUBLIC API
 *   normalizePhone(raw, defaultRegion?)        → { e164, type, countryCode, isValid, nationalNumber, extension, raw }
 *   detectPhoneType(parsed)                    → 'mobile'|'landline'|'toll_free'|'voip'|'invalid'|'unknown'
 *   resolveCountryCode(parsed, defaultRegion?) → 'US' | 'DE' | 'BD' | ... | null
 *   isPhoneValid(parsed)                       → boolean
 *   formatForDialing(e164, countryCode)        → { international, national }
 *   normalizePhonesBatch(businesses, opts?)    → { total, valid, invalid, byType, skipped }
 *   ENRICHMENT_COLUMNS                         → ['phone_e164','phone_type','phone_country_code']
 */

// ---------------------------------------------------------------------------
// DI seam for libphonenumber-js. We prefer the `max` build (includes full
// metadata for getType() — mobile vs. landline distinction). If the max build
// is unavailable for any reason, fall back to the default build (type
// detection degrades to 'unknown' for most regions, but E.164 + country +
// validity still work). Tests inject a stub via _loadLib to avoid the ~140 KB
// metadata import in unit-test runs.
// ---------------------------------------------------------------------------
let _lib = null;
function _loadLib() {
  if (_lib) return _lib;
  try {
    // libphonenumber-js/max re-exports the same API with full metadata.
    _lib = require('libphonenumber-js/max');
  } catch (_e) {
    // Fallback: min build (type detection degrades, but parsing still works).
    _lib = require('libphonenumber-js');
  }
  return _lib;
}
// Test hook: inject a stub lib. Pass null to reset to the real lib.
function _setLib(stub) {
  _lib = stub;
}

const __version = 1;

const ENRICHMENT_COLUMNS = ['phone_e164', 'phone_type', 'phone_country_code'];

// ---------------------------------------------------------------------------
// Pre-processing helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Transliterate non-Latin digit characters to ASCII 0-9. Google Maps UIs in
 * some locales (ar, fa, bn, hi) surface phone numbers in localized digits;
 * libphonenumber-js only parses ASCII digits. We handle the 4 most common
 * non-Latin digit ranges:
 *   - Arabic-Indic:     U+0660..U+0669 (٠١٢٣٤٥٦٧٨٩)
 *   - Extended Arabic:  U+06F0..U+06F9 (۰۱۲۳۴۵۶۷۸۹ — Persian/Urdu)
 *   - Devanagari:       U+0966..U+096F (०१२३४५६७८९ — Hindi/etc.)
 *   - Bengali:          U+09E6..U+09EF (০১২৩৪৫৬৭৮৯ — Bangla)
 *
 * @param {string} s
 * @returns {string}
 */
function transliterateDigits(s) {
  if (typeof s !== 'string') return s;
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else if (code >= 0x0966 && code <= 0x096f) out += String(code - 0x0966);
    else if (code >= 0x09e6 && code <= 0x09ef) out += String(code - 0x09e6);
    else out += ch;
  }
  return out;
}

/**
 * Strip emoji and other non-phone symbols (keep digits, +, (, ), -, space, .,
 * x, and the extension separators). Emoji contamination happens when a phone
 * is scraped alongside a "📞" glyph or similar. We conservatively keep only
 * the characters libphonenumber-js cares about rather than trying to strip
 * every possible emoji range.
 *
 * @param {string} s
 * @returns {string}
 */
function stripNonPhoneChars(s) {
  if (typeof s !== 'string') return s;
  // Keep: digits, +, (, ), -, space, dot, x, #, comma, semicolon, and letters
  // (for "ext"/"x" words). Strip everything else (emoji, CJK, etc.).
  return s.replace(/[^\d+().\-\sxX#;,a-zA-Z]/g, '');
}

/**
 * Extract and strip an extension from a raw phone string. Recognizes the
 * common postfixes: `ext`, `ext.`, `x`, `ex`, `#`, `,`, `;` (case-insensitive).
 * Returns `{ phone, extension }` where `phone` is the raw minus the extension,
 * and `extension` is the digits of the extension (or null).
 *
 * libphonenumber-js CAN parse extensions itself (it recognizes `;ext=` in
 * RFC3966 and ` ext. ` in common formats), but in practice its extension
 * detection is fragile for the `x` and `,` shorthand we see in scraped data.
 * We extract it ourselves first, then re-attach via the RFC3966 `;ext=` form
 * so the parser sees a clean number + a properly-formatted extension.
 *
 * @param {string} raw
 * @returns {{ phone: string, extension: string|null }}
 */
function splitExtension(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { phone: raw || '', extension: null };
  }
  // Match: separator (ext|ex|x|extension|#|;|,) + optional spaces/dots + digits
  // The separator must NOT be preceded by a digit-comma-decimal (e.g. don't
  // treat a comma in "1,000" as an extension — but phones don't have commas
  // in the main number, so this is safe).
  const m = raw.match(/^(.*?)(?:\s*(?:ext\.?|extension|ex\.?|x|#|;|,)\s*)(\d{1,7})\s*$/i);
  if (m) {
    return { phone: m[1].trim(), extension: m[2] };
  }
  return { phone: raw.trim(), extension: null };
}

// ---------------------------------------------------------------------------
// Type detection (pure, operates on a libphonenumber-js PhoneNumber object)
// ---------------------------------------------------------------------------

/**
 * Map a libphonenumber-js `PhoneNumberType` string to our 6-value taxonomy:
 *   mobile | landline | toll_free | voip | invalid | unknown
 *
 * Mapping (per libphonenumber-js PhoneNumberType enum):
 *   MOBILE                  → 'mobile'
 *   FIXED_LINE              → 'landline'
 *   FIXED_LINE_OR_MOBILE    → 'landline'  (conservative — we can't tell; most
 *                          developed-country fixed_or_mobile numbers are landlines
 *                          being called, and 'mobile' is the higher-value signal
 *                          so we prefer NOT to falsely claim mobile. Callers who
 *                          need the ambiguity can check isValid + the raw type.)
 *   TOLL_FREE               → 'toll_free'
 *   VOIP                    → 'voip'
 *   PREMIUM_RATE            → 'unknown'   (not actionable for outreach)
 *   SHARED_COST             → 'unknown'
 *   PERSONAL_NUMBER         → 'unknown'
 *   PAGER                   → 'unknown'
 *   UAN                     → 'unknown'
 *   VOICEMAIL               → 'unknown'
 *   undefined / null        → 'unknown'   (type couldn't be determined)
 *
 * @param {object} parsed — libphonenumber-js PhoneNumber (must have .getType())
 * @returns {string}
 */
function detectPhoneType(parsed) {
  if (!parsed) return 'invalid';
  // An invalid number is 'invalid' regardless of what getType() says.
  try {
    if (!parsed.isValid()) return 'invalid';
  } catch (_e) {
    return 'unknown';
  }
  let t;
  try {
    t = parsed.getType();
  } catch (_e) {
    return 'unknown';
  }
  switch (t) {
    case 'MOBILE':
      return 'mobile';
    case 'FIXED_LINE':
      return 'landline';
    case 'FIXED_LINE_OR_MOBILE':
      return 'landline'; // conservative default
    case 'TOLL_FREE':
      return 'toll_free';
    case 'VOIP':
      return 'voip';
    case 'PREMIUM_RATE':
    case 'SHARED_COST':
    case 'PERSONAL_NUMBER':
    case 'PAGER':
    case 'UAN':
    case 'VOICEMAIL':
      return 'unknown';
    default:
      return 'unknown'; // undefined / null / unrecognized
  }
}

/**
 * Resolve the ISO 3166-1 alpha-2 country code for a parsed number.
 *
 * Priority:
 *   1. `parsed.country` — set by libphonenumber-js when the number is valid
 *      and unambiguously maps to a single country (e.g. +49 → DE).
 *   2. `defaultRegion` — caller's hint (e.g. the scrape query's location).
 *      Used as a fallback when the number is invalid or the country is
 *      ambiguous (e.g. +1 covers US/CA/Caribbean — parsed.country may be
 *      undefined for invalid NANP numbers).
 *
 * @param {object} parsed
 * @param {string} [defaultRegion]
 * @returns {string|null} ISO 2-letter code or null
 */
function resolveCountryCode(parsed, defaultRegion) {
  // Even for a null/undefined parsed object, honor the defaultRegion fallback
  // (callers use resolveCountryCode to "best-effort" a country even when the
  // number didn't parse — e.g. an invalid local-format number still came from
  // somewhere, and the defaultRegion hint is the best signal we have).
  if (parsed) {
    try {
      if (parsed.country) return parsed.country;
    } catch (_e) {
      /* fall through to defaultRegion */
    }
  }
  if (defaultRegion && /^[A-Z]{2}$/i.test(defaultRegion)) {
    return defaultRegion.toUpperCase();
  }
  return null;
}

/**
 * Check whether a parsed number is valid (libphonenumber-js isValid()).
 * Returns false for null/undefined parsed objects.
 *
 * @param {object} parsed
 * @returns {boolean}
 */
function isPhoneValid(parsed) {
  if (!parsed) return false;
  try {
    return !!parsed.isValid();
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a raw phone string to E.164 + metadata.
 *
 * Pipeline:
 *   1. Coerce to string; reject null/undefined/empty → invalid result.
 *   2. Transliterate non-Latin digits → ASCII.
 *   3. Strip emoji + non-phone characters.
 *   4. Split off the extension (`ext`/`x`/`,`/...).
 *   5. Parse with libphonenumber-js (defaultRegion as the country hint when
 *      the number lacks a `+` prefix).
 *   6. If parsing fails → invalid result (e164: null, type: 'invalid').
 *   7. Detect type, resolve country, check validity.
 *   8. Return the full descriptor.
 *
 * @param {string} rawPhone — the raw phone string from the scrape.
 * @param {string} [defaultRegion] — ISO 2-letter region hint (e.g. 'US').
 *   Used when the number has no `+` prefix. Ignored when the number has `+`.
 * @returns {{ e164: string|null, type: string, countryCode: string|null, isValid: boolean, nationalNumber: string|null, extension: string|null, raw: string }}
 */
function normalizePhone(rawPhone, defaultRegion) {
  const raw = rawPhone === undefined || rawPhone === null ? '' : String(rawPhone);
  const base = {
    e164: null,
    type: 'invalid',
    countryCode: null,
    isValid: false,
    nationalNumber: null,
    extension: null,
    raw,
  };

  if (!raw || !raw.trim()) return base;

  // 1. Transliterate non-Latin digits.
  let s = transliterateDigits(raw);

  // 2. Strip emoji + non-phone chars.
  s = stripNonPhoneChars(s);

  // 3. Split extension.
  const { phone, extension } = splitExtension(s);
  if (!phone || !phone.trim()) {
    base.extension = extension;
    return base;
  }

  // 4. Parse. Re-attach the extension in RFC3966 form so libphonenumber-js
  //    records it on the parsed object (parsed.ext). This is the most reliable
  //    way to round-trip an extension through the parser.
  const parseInput = extension ? `${phone};ext=${extension}` : phone;
  const lib = _loadLib();
  let parsed;
  try {
    parsed = lib.parsePhoneNumberFromString(parseInput, defaultRegion || undefined);
  } catch (_e) {
    // ParseError — malformed number (e.g. letters in the wrong place).
    base.extension = extension;
    return base;
  }

  if (!parsed) {
    base.extension = extension;
    return base;
  }

  // 5. Extract E.164 + metadata.
  let e164 = null;
  try {
    // `.number` is the E.164 form (e.g. '+14165550123'). For INVALID numbers
    // libphonenumber-js still returns a .number (the best-effort parse), but
    // we suppress it — clients filter on phone_e164 for auto-dialing, and an
    // invalid number's e164 would be misleading. e164 is only populated for
    // VALID numbers (callers can still inspect .raw for the original string).
    e164 = parsed.isValid() ? (parsed.number || null) : null;
  } catch (_e) {
    e164 = null;
  }

  const isValid = isPhoneValid(parsed);
  const type = isValid ? detectPhoneType(parsed) : 'invalid';
  const countryCode = resolveCountryCode(parsed, defaultRegion);
  let nationalNumber = null;
  try {
    nationalNumber = parsed.nationalNumber || null;
  } catch (_e) {
    nationalNumber = null;
  }
  // Prefer the extension we extracted ourselves (more reliable for the `x`/
  // `,` shorthand than parsed.ext), falling back to parsed.ext.
  let ext = extension;
  if (!ext && parsed.ext) ext = String(parsed.ext);

  return {
    e164,
    type,
    countryCode,
    isValid,
    nationalNumber,
    extension: ext,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Dial-string formatting (pure)
// ---------------------------------------------------------------------------

/**
 * Format an E.164 number for dialing. Returns both the international form
 * (e.g. `+1 416 555 0123`) and the national form (e.g. `(416) 555-0123`).
 *
 * The international form is what a CRM auto-dialer uses; the national form is
 * what a local sales rep reads. When the number can't be re-parsed (e.g.
 * e164 is null), both fields are null.
 *
 * @param {string} e164 — the E.164 number (with leading `+`).
 * @param {string} [countryCode] — ISO 2-letter code (for national formatting).
 * @returns {{ international: string|null, national: string|null }}
 */
function formatForDialing(e164, countryCode) {
  if (!e164 || typeof e164 !== 'string') {
    return { international: null, national: null };
  }
  const lib = _loadLib();
  let parsed;
  try {
    parsed = lib.parsePhoneNumberFromString(e164, countryCode || undefined);
  } catch (_e) {
    parsed = null;
  }
  if (!parsed) {
    // Can't re-parse — return the raw E.164 as the international form.
    return { international: e164, national: null };
  }
  let international = null;
  let national = null;
  try {
    international = parsed.format('INTERNATIONAL'); // '+1 416 555 0123'
  } catch (_e) {
    international = e164;
  }
  try {
    national = parsed.format('NATIONAL'); // '(416) 555-0123'
  } catch (_e) {
    national = null;
  }
  return { international, national };
}

// ---------------------------------------------------------------------------
// Batch normalization
// ---------------------------------------------------------------------------

/**
 * Resolve the default region hint for a business. Priority:
 *   1. opts.defaultCountry (explicit CLI flag — highest priority).
 *   2. business.phone_default_country (per-business override, set by the
 *      operator via a future enrichment CLI; not used in 3.1 but supported).
 *   3. business.address_country (Phase 3.2 structured address country — not
 *      populated yet in 3.1, but the field is reserved).
 *   4. null (let libphonenumber-js infer from `+` prefix only).
 *
 * @param {object} business
 * @param {object} opts
 * @returns {string|null}
 */
function resolveDefaultRegion(business, opts) {
  if (!business) return null;
  if (opts && opts.defaultCountry) return String(opts.defaultCountry).toUpperCase();
  if (business.phone_default_country) return String(business.phone_default_country).toUpperCase();
  if (business.address_country) return String(business.address_country).toUpperCase();
  return null;
}

/**
 * Normalize the phone numbers of a batch of businesses IN PLACE. Each business
 * is mutated with three new fields (the Phase 3.0 schema columns):
 *   - phone_e164        — E.164 string or null
 *   - phone_type        — 'mobile'|'landline'|'toll_free'|'voip'|'invalid'|'unknown'
 *   - phone_country_code — ISO 2-letter or null
 * Plus a debug-only `phone_normalized` object holding the full descriptor
 * (extension, nationalNumber, raw, isValid) — useful for the CLI banner and
 * debugging; NOT persisted to the DB (the 3 persisted columns are the
 * queryable fields clients filter on).
 *
 * @param {object[]} businesses — mutated in place.
 * @param {object} [opts] — { defaultCountry, logger }
 * @returns {{ total: number, valid: number, invalid: number, byType: object, skipped: number }}
 */
function normalizePhonesBatch(businesses, opts) {
  const o = opts || {};
  const list = Array.isArray(businesses) ? businesses : [];
  const stats = {
    total: list.length,
    valid: 0,
    invalid: 0,
    byType: {
      mobile: 0,
      landline: 0,
      toll_free: 0,
      voip: 0,
      invalid: 0,
      unknown: 0,
    },
    skipped: 0,
  };

  for (const business of list) {
    if (!business || typeof business !== 'object') {
      stats.skipped++;
      continue;
    }
    const rawPhone = business.phone;
    if (!rawPhone || (typeof rawPhone === 'string' && !rawPhone.trim())) {
      // No phone to normalize — record nulls and count as skipped (not invalid;
      // a business without a phone isn't a phone-quality issue).
      business.phone_e164 = null;
      business.phone_type = null; // null = "no phone", distinct from 'invalid'
      business.phone_country_code = null;
      business.phone_normalized = null;
      stats.skipped++;
      continue;
    }

    const region = resolveDefaultRegion(business, o);
    const result = normalizePhone(rawPhone, region);
    business.phone_e164 = result.e164;
    business.phone_type = result.type;
    business.phone_country_code = result.countryCode;
    business.phone_normalized = result; // debug descriptor (NOT persisted)

    if (result.isValid) {
      stats.valid++;
    } else {
      stats.invalid++;
    }
    // byType: count every business (valid + invalid). The 'invalid' bucket
    // gets incremented for both `type === 'invalid'` and for parse failures.
    const t = result.type || 'unknown';
    if (Object.prototype.hasOwnProperty.call(stats.byType, t)) {
      stats.byType[t]++;
    } else {
      stats.byType.unknown++;
    }
  }

  return stats;
}

module.exports = {
  __version,
  ENRICHMENT_COLUMNS,
  // Core API
  normalizePhone,
  detectPhoneType,
  resolveCountryCode,
  isPhoneValid,
  formatForDialing,
  normalizePhonesBatch,
  // Pre-processing helpers (exported for unit tests)
  transliterateDigits,
  stripNonPhoneChars,
  splitExtension,
  resolveDefaultRegion,
  // Test seam
  _loadLib,
  _setLib,
};
