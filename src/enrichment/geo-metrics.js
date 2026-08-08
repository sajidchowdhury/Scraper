'use strict';

/**
 * src/enrichment/geo-metrics.js — Phase 3.8 — Competitor Density (Geospatial)
 *
 * STUB (Phase 3.0). Implemented in Phase 3.8.
 *
 * Will compute same-category competitor counts within 1 km and 5 km radii of
 * each business, plus foot-traffic estimates from popular-times data. Uses
 * haversine math (or PostGIS ST_DWithin when available — see the GiST index
 * in migrations/003-enrichment.sql).
 *
 * Public API (planned):
 *   haversineKm(a, b)                  → number (km)
 *   competitorDensity(business, all, radiusKm) → number
 *   computeGeoMetrics(business, all)   → { density1km, density5km }
 *   ENRICHMENT_COLUMNS                 → ['competitor_density_1km', 'competitor_density_5km']
 */

const __version = 1;

// Mean Earth radius (km) — matches the haversine formula constant.
const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance between two {lat, lng} points, in km (haversine).
 *
 * Pure function — unit-testable without a database. Phase 3.8 will use this as
 * the PostGIS-free fallback for competitor-density radius queries.
 *
 * @param {{ lat: number, lng: number }} _a
 * @param {{ lat: number, lng: number }} _b
 * @returns {number} distance in km (0 when either point is missing coords)
 * @implements Phase 3.8
 */
function haversineKm(_a, _b) {
  // TODO Phase 3.8 — implement haversine (kept as a stub signature for 3.0).
  return 0;
}

/**
 * Count same-category businesses within a radius (km) of the target.
 *
 * @param {object} _business
 * @param {object[]} _all
 * @param {number} _radiusKm
 * @returns {number}
 * @implements Phase 3.8
 */
function competitorDensity(_business, _all, _radiusKm) {
  // TODO Phase 3.8 — iterate `all`, filter by category + haversine <= radius.
  return 0;
}

module.exports = {
  __version,
  EARTH_RADIUS_KM,
  haversineKm,
  competitorDensity,
  ENRICHMENT_COLUMNS: ['competitor_density_1km', 'competitor_density_5km'],
};
