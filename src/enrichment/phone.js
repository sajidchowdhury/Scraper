'use strict';

/**
 * src/enrichment/phone.js — Phase 3.1 — Phone Number Normalization & Validation
 *
 * STUB (Phase 3.0). Implemented in Phase 3.1.
 *
 * Will convert every scraped phone number to E.164 format, detect its type
 * (mobile | landline | toll_free | voip | invalid | unknown), resolve the
 * ISO country code, and flag invalid numbers. Uses `libphonenumber-js`
 * (pure JS, no native deps).
 *
 * Public API (planned):
 *   normalizePhone(raw, defaultRegion?) → { e164, type, countryCode, isValid }
 *   detectPhoneType(parsed)             → 'mobile' | 'landline' | 'toll_free' | 'voip' | 'invalid' | 'unknown'
 *   ENRICHMENT_COLUMNS                  → ['phone_e164', 'phone_type', 'phone_country_code']
 */

const __version = 1;

/**
 * Normalize a raw phone string to E.164 + metadata.
 *
 * @param {string} _raw — the raw phone string from the scrape.
 * @param {string} [_defaultRegion] — ISO 2-letter region hint (e.g. 'US').
 * @returns {{ e164: string|null, type: string, countryCode: string|null, isValid: boolean }}
 * @implements Phase 3.1
 */
function normalizePhone(_raw, _defaultRegion) {
  // TODO Phase 3.1 — implement with libphonenumber-js.parsePhoneNumberFromString().
  return { e164: null, type: 'unknown', countryCode: null, isValid: false };
}

module.exports = {
  __version,
  normalizePhone,
  ENRICHMENT_COLUMNS: ['phone_e164', 'phone_type', 'phone_country_code'],
};
