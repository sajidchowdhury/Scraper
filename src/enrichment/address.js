'use strict';

/**
 * src/enrichment/address.js — Phase 3.2 — Address Parsing & Geocoding
 *
 * STUB (Phase 3.0). Implemented in Phase 3.2.
 *
 * Will split raw single-line addresses into structured fields (street, city,
 * state, postal, country) and geocode them to verified lat/lng with a
 * confidence score. Optional Google Geocoding API integration (gated on
 * GEOCODING_API_KEY).
 *
 * Public API (planned):
 *   parseAddress(raw)                  → { street, city, state, postal, country }
 *   geocodeAddress(parsed, apiKey?)    → { lat, lng, confidence }
 *   ENRICHMENT_COLUMNS                 → address_* + lat/lng/geocode_confidence
 */

const __version = 1;

/**
 * Parse a raw single-line address into structured components.
 *
 * @param {string} _raw
 * @returns {{ street: string|null, city: string|null, state: string|null, postal: string|null, country: string|null }}
 * @implements Phase 3.2
 */
function parseAddress(_raw) {
  // TODO Phase 3.2 — implement heuristic + optional geocoder parsing.
  return { street: null, city: null, state: null, postal: null, country: null };
}

/**
 * Geocode a parsed address to verified coordinates + confidence.
 *
 * @param {object} _parsed
 * @param {string} [_apiKey]
 * @returns {{ lat: number|null, lng: number|null, confidence: number }}
 * @implements Phase 3.2
 */
function geocodeAddress(_parsed, _apiKey) {
  // TODO Phase 3.2 — implement Google Geocoding API call (or fallback).
  return { lat: null, lng: null, confidence: 0 };
}

module.exports = {
  __version,
  parseAddress,
  geocodeAddress,
  ENRICHMENT_COLUMNS: [
    'address_street',
    'address_city',
    'address_state',
    'address_postal',
    'address_country',
    'lat',
    'lng',
    'geocode_confidence',
  ],
};
