'use strict';

/**
 * src/enrichment/geo-metrics.js — Phase 3.8 — Competitor Density (Geospatial)
 *
 * WHY THIS MODULE EXISTS
 *   For every business, compute spatial analytics relative to the rest of the
 *   batch: how many other businesses sit within walking distance, whether the
 *   listing is geographically isolated (a spam signal), whether it sits in a
 *   dense commercial cluster, and the proximity of the nearest chain location.
 *   These metrics power two downstream concerns:
 *
 *     (A) Competitive intelligence — how crowded is this business's
 *         neighbourhood? How many direct competitors (same category) sit
 *         within 1 km?
 *     (B) Authenticity signals — an isolated listing or a service business
 *         with suspiciously tight same-category clustering can corroborate
 *         (or soften) Phase 3.4 spam verdicts.
 *
 * DESIGN RULES (per PHASE3_EXECUTION_PLAN.md §3.8)
 *   - Pure math: no network, no DB, no external deps. The haversine formula
 *     is implemented inline so the module works on any Postgres install —
 *     PostGIS is NOT required.
 *   - The DB schema has a PostGIS GiST index on (ST_Point(lng,lat)::geography)
 *     (see migrations/003-enrichment.sql) for ST_DWithin radius queries. That
 *     index is created inside a DO $$ guard that no-ops when PostGIS is absent;
 *     this module is the JS FALLBACK the pipeline uses so enrichment can run
 *     without a round-trip to the DB per business and without requiring
 *     PostGIS. Both paths share the same haversine earth-radius constant.
 *   - O(n²) over the batch. Fine for typical batch sizes (hundreds to low
 *     thousands of listings per scrape). For 10k+ batches a spatial index
 *     (R-tree / k-d tree in JS, or ST_DWithin pushed down to PostGIS) would
 *     be needed — documented here, NOT implemented in this module.
 *   - Coords arrive from pg as strings (NUMERIC 10,7); we Number() them and
 *     guard against null/undefined/NaN/Infinity. Listings with no usable
 *     coordinate get a `no_geocode` flag and are excluded from distance math
 *     (their density columns are 0).
 *   - The business object is READ by computeGeoMetrics; the batch wrapper
 *     MUTATES in place by writing the two persisted INT columns
 *     (competitor_density_1km, competitor_density_5km) and attaching a debug
 *     `geo_result` descriptor (NOT persisted — feeds lead scoring 3.9 and
 *     the CLI banner).
 *
 * COORDINATE PRIORITY (per scraper schema)
 *   business.lat / business.lng       — Phase 3.2 geocoded coords (NUMERIC
 *                                        10,7), preferred when present.
 *   business.latitude / longitude     — raw scrape coords (Google Maps pin),
 *                                        fallback when geocoding didn't run.
 *
 * PUBLIC API
 *   haversineKm(a, b)                          → number (km, 0 if no coords)
 *   haversineM(a, b)                           → number (metres)
 *   getCoord(business)                         → { lat, lng, source: 'geocoded'|'raw'|'none' }
 *   competitorDensity(business, all, radiusKm) → number (OTHER businesses within radius)
 *   competitorDensitySameCategory(...)         → number (same-category within radius)
 *   computeGeoMetrics(business, all)           → full GeoMetricsResult descriptor
 *   computeGeoMetricsBatch(businesses, opts?)  → batch wrapper, mutates in place
 *   ENRICHMENT_COLUMNS                         → ['competitor_density_1km', 'competitor_density_5km']
 */

const __version = 1;

// Mean Earth radius (km) — matches the haversine formula constant. Shared with
// Phase 3.3 dedup so the whole pipeline uses one earth-radius value.
const EARTH_RADIUS_KM = 6371;

const ENRICHMENT_COLUMNS = ['competitor_density_1km', 'competitor_density_5km'];

const DEG_TO_RAD = Math.PI / 180;

// ─────────────────────────────────────────────────────────────────────────────
// Category → estimated service-area coverage radius (metres)
//
// Service businesses (towing, solar, plumbing, locksmith) draw customers from
// a wide radius; foot-traffic businesses (coffee, deli, salon) draw from a
// tight one. Used to estimate a realistic "coverage radius" independent of the
// observed batch density. Ported faithfully from the dashboard's geom.ts
// `coverageRadiusForCategory`.
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_COVERAGE = [
  { re: /(towing|locksmith|plumb|electr|roof|solar|hvac|pest|tree)/,          radiusM: 25000 },
  { re: /(contractor|general|construction|renovation)/,                       radiusM: 20000 },
  { re: /(dentist|doctor|clinic|medical|veterinary|vet)/,                     radiusM: 6000  },
  { re: /(architecture|design|studio|lawyer|attorney|account)/,               radiusM: 12000 },
  { re: /(yoga|pilates|gym|fitness|salon|spa|barber)/,                        radiusM: 3500  },
  { re: /(coffee|cafe|bakery|deli|restaurant|bar|pizza|burger|sandwich)/,     radiusM: 1500  },
  { re: /(store|shop|retail|book|clothing|hardware|bait|fishing|herbalist)/,  radiusM: 4000  },
];

const DEFAULT_COVERAGE_RADIUS_M = 5000;

/**
 * Estimated service-area coverage radius (metres) for a business category.
 *
 * @param {string} category
 * @returns {number}
 */
function coverageRadiusForCategory(category) {
  const c = String(category || '').toLowerCase();
  for (const entry of CATEGORY_COVERAGE) {
    if (entry.re.test(c)) return entry.radiusM;
  }
  return DEFAULT_COVERAGE_RADIUS_M;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate resolution + haversine math (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce a value to a finite number, returning null for null/undefined/NaN/
 * Infinity. Handles pg NUMERIC strings ("40.7128000"), plain numbers, and
 * empty strings.
 *
 * @param {*} v
 * @returns {number|null}
 */
function toFiniteNumber(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Resolve the best available coordinate for a business. Priority:
 *   1. business.lat / business.lng (Phase 3.2 geocoded — preferred).
 *   2. business.latitude / business.longitude (raw scrape — fallback).
 *   3. none — listings with neither are flagged no_geocode.
 *
 * pg returns NUMERIC columns as strings; we Number() them here and guard
 * against null/NaN. source is 'geocoded' | 'raw' | 'none'.
 *
 * @param {object} business
 * @returns {{ lat: number|null, lng: number|null, source: 'geocoded'|'raw'|'none' }}
 */
function getCoord(business) {
  if (!business) return { lat: null, lng: null, source: 'none' };

  const geoLat = toFiniteNumber(business.lat);
  const geoLng = toFiniteNumber(business.lng);
  if (geoLat != null && geoLng != null) {
    return { lat: geoLat, lng: geoLng, source: 'geocoded' };
  }

  const rawLat = toFiniteNumber(business.latitude);
  const rawLng = toFiniteNumber(business.longitude);
  if (rawLat != null && rawLng != null) {
    return { lat: rawLat, lng: rawLng, source: 'raw' };
  }

  return { lat: null, lng: null, source: 'none' };
}

/**
 * Great-circle distance between two {lat, lng} points, in km (haversine).
 * Returns 0 if either point is missing coordinates.
 *
 * Pure function — unit-testable without a DB. This is the PostGIS-free
 * fallback used by every radius query in Phase 3.8.
 *
 * @param {{ lat: number, lng: number }} a
 * @param {{ lat: number, lng: number }} b
 * @returns {number} distance in km
 */
function haversineKm(a, b) {
  const aLat = a ? toFiniteNumber(a.lat) : null;
  const aLng = a ? toFiniteNumber(a.lng) : null;
  const bLat = b ? toFiniteNumber(b.lat) : null;
  const bLng = b ? toFiniteNumber(b.lng) : null;
  if (aLat == null || aLng == null || bLat == null || bLng == null) return 0;

  const dLat = (bLat - aLat) * DEG_TO_RAD;
  const dLng = (bLng - aLng) * DEG_TO_RAD;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(aLat * DEG_TO_RAD) * Math.cos(bLat * DEG_TO_RAD) * sinDLng * sinDLng;
  // Math.min(1, ...) guards against floating-point drift pushing sqrt(h) past 1.
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Great-circle distance in metres — convenience wrapper around haversineKm.
 *
 * @param {{ lat: number, lng: number }} a
 * @param {{ lat: number, lng: number }} b
 * @returns {number} distance in metres (0 if either point lacks coords)
 */
function haversineM(a, b) {
  return haversineKm(a, b) * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity + category helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the identity key for a business. We exclude "self" from competitor
 * counts by place_id (Google's stable identifier), falling back to id when
 * place_id is missing.
 *
 * @param {object} business
 * @returns {string}
 */
function identityKey(business) {
  if (!business) return '';
  return String(business.place_id || business.id || '');
}

/**
 * True when two business records refer to the same listing. Matches on
 * place_id, falling back to id. Either key missing → false (treat as
 * distinct, so a no-place_id listing still counts as a separate competitor).
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function isSameListing(a, b) {
  const ka = identityKey(a);
  const kb = identityKey(b);
  if (!ka || !kb) return false;
  return ka === kb;
}

/**
 * Normalize a category string for same-category comparison.
 * @param {string} c
 * @returns {string}
 */
function normalizeCategory(c) {
  return String(c || '').toLowerCase().trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Density primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Count OTHER businesses in `all` (same place_id excluded) within radiusKm.
 * Pure: iterates the batch once, applies haversine, increments a counter.
 *
 * This is the stub signature preserved from Phase 3.0; the persisted columns
 * competitor_density_1km / competitor_density_5km are populated by calling
 * this with radiusKm = 1 and 5 respectively (see computeGeoMetricsBatch).
 *
 * @param {object} business — target business (must have resolvable coords).
 * @param {object[]} all — the full batch.
 * @param {number} radiusKm — radius in kilometres.
 * @returns {number}
 */
function competitorDensity(business, all, radiusKm) {
  const self = getCoord(business);
  if (self.source === 'none' || !Array.isArray(all)) return 0;
  const radius = Number(radiusKm);
  if (!Number.isFinite(radius) || radius <= 0) return 0;

  let count = 0;
  for (const other of all) {
    if (!other || other === business) continue;
    if (isSameListing(business, other)) continue;
    const oc = getCoord(other);
    if (oc.source === 'none') continue;
    if (haversineKm(self, oc) <= radius) count++;
  }
  return count;
}

/**
 * Same as competitorDensity, but restricted to same-category businesses.
 * Used for direct-competitor counts (e.g. the high_competition_zone flag and
 * the dashboard's sameCategoryWithin1km field).
 *
 * @param {object} business
 * @param {object[]} all
 * @param {number} radiusKm
 * @returns {number}
 */
function competitorDensitySameCategory(business, all, radiusKm) {
  const self = getCoord(business);
  if (self.source === 'none' || !Array.isArray(all)) return 0;
  const radius = Number(radiusKm);
  if (!Number.isFinite(radius) || radius <= 0) return 0;

  const selfCat = normalizeCategory(business.category);
  if (!selfCat) return 0; // no category → can't match same-category

  let count = 0;
  for (const other of all) {
    if (!other || other === business) continue;
    if (isSameListing(business, other)) continue;
    if (normalizeCategory(other.category) !== selfCat) continue;
    const oc = getCoord(other);
    if (oc.source === 'none') continue;
    if (haversineKm(self, oc) <= radius) count++;
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify isolation from the count of other businesses within 1 km:
 *   within1km == 0           → 'isolated'
 *   within1km 1..3           → 'sparse'
 *   within1km 4..9           → 'moderate'
 *   within1km >= 10          → 'dense'
 *
 * nearestNeighborM == null (no other geocodable listing in the batch) is also
 * 'isolated' — a single-listing batch is trivially isolated.
 *
 * @param {number|null} nearestNeighborM
 * @param {number} within1km
 * @returns {'isolated'|'sparse'|'moderate'|'dense'}
 */
function classifyIsolation(nearestNeighborM, within1km) {
  if (nearestNeighborM == null) return 'isolated';
  if (within1km === 0) return 'isolated';
  if (within1km <= 3) return 'sparse';
  if (within1km <= 9) return 'moderate';
  return 'dense';
}

/**
 * Classify area type from the count of other businesses within 5 km:
 *   within5km >= 50   → 'urban'
 *   within5km 10..49  → 'suburban'
 *   within5km < 10    → 'rural'
 *
 * @param {number} within5km
 * @returns {'urban'|'suburban'|'rural'}
 */
function classifyArea(within5km) {
  if (within5km >= 50) return 'urban';
  if (within5km >= 10) return 'suburban';
  return 'rural';
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain-result accessor (Phase 3.4 interop)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull the chain descriptor from a business. Accepts the scraper's
 * `chain_result` object ({ isChain, chainId, chainName }) from Phase 3.4
 * (preferred) or the dashboard's flat fields (defensive). Returns null when
 * the business isn't part of a chain.
 *
 * @param {object} business
 * @returns {{ chainId: string, chainName: string }|null}
 */
function chainOf(business) {
  if (!business) return null;
  const cr = business.chain_result;
  if (cr && cr.isChain && (cr.chainId || cr.chainName)) {
    return {
      chainId: String(cr.chainId || cr.chainName || ''),
      chainName: String(cr.chainName || cr.chainId || ''),
    };
  }
  // Dashboard-style flat fields (defensive — scraper uses chain_result).
  if (business.chainId && business.chainName) {
    return { chainId: String(business.chainId), chainName: String(business.chainName) };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core geo-metrics computation (single business vs the batch)
//
// Ported from the dashboard's geom.ts `computeOne`. The result shape matches
// the dashboard's GeoMetricsResult (snake_case-friendly), with these field
// differences for the scraper:
//   - nearestNeighbor / nearestChain are null (not undefined) when absent,
//     so the descriptor round-trips through JSON without key loss.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the full geo-metrics descriptor for a single business relative to
 * the rest of the batch.
 *
 * @param {object} business — must have resolvable coords (else no_geocode).
 * @param {object[]} all — full batch (business should be a member of `all`).
 * @returns {{
 *   lat: number|null, lng: number|null, coordSource: string,
 *   nearestNeighborM: number|null, nearestNeighbor: object|null,
 *   within500m: number, within1km: number, within5km: number,
 *   sameCategoryWithin1km: number,
 *   nearestChainM: number|null, nearestChain: object|null,
 *   isolation: string, areaType: string, coverageRadiusM: number,
 *   inCluster: boolean,
 *   flags: Array<{ code: string, label: string, detail: string, severity: string }>
 * }}
 */
function computeGeoMetrics(business, all) {
  const flags = [];
  const self = getCoord(business);
  const list = Array.isArray(all) ? all : [];
  const coverageRadiusM = coverageRadiusForCategory(business && business.category);

  // No usable coordinate → no_geocode flag, zeroed counts, isolated/rural defaults.
  if (self.source === 'none' || self.lat == null || self.lng == null) {
    flags.push({
      code: 'no_geocode',
      label: 'No geocode',
      detail:
        'This listing has no geocoded coordinate and no raw scraped coordinate, so geo-metrics are unavailable.',
      severity: 'medium',
    });
    return {
      lat: null,
      lng: null,
      coordSource: 'none',
      nearestNeighborM: null,
      nearestNeighbor: null,
      within500m: 0,
      within1km: 0,
      within5km: 0,
      sameCategoryWithin1km: 0,
      nearestChainM: null,
      nearestChain: null,
      isolation: 'isolated',
      areaType: 'rural',
      coverageRadiusM,
      inCluster: false,
      flags,
    };
  }

  const selfCat = normalizeCategory(business.category);
  const selfChain = chainOf(business);

  let nearest = null;       // { id, name, category, distanceM }
  let within500m = 0;
  let within1km = 0;
  let within5km = 0;
  let sameCategoryWithin1km = 0;
  let nearestChain = null;  // { chainId, chainName, distanceM }

  for (const other of list) {
    if (!other || other === business) continue;
    if (isSameListing(business, other)) continue;

    const oc = getCoord(other);
    if (oc.source === 'none') continue;

    const distM = haversineM(self, oc);

    // Nearest neighbour (any category).
    if (nearest == null || distM < nearest.distanceM) {
      nearest = {
        id: String(other.place_id || other.id || ''),
        name: String(other.name || ''),
        category: String(other.category || ''),
        distanceM: distM,
      };
    }

    if (distM <= 500) within500m += 1;
    if (distM <= 1000) within1km += 1;
    if (distM <= 5000) within5km += 1;

    // Direct competitors within 1 km (same category). Exclude members of the
    // same Phase 3.3 dedup cluster — they're the SAME business, not a
    // competitor. dedup_cluster_id is optional; if either side lacks it we
    // treat them as distinct (conservative — counts them as competitors).
    if (distM <= 1000 && selfCat && normalizeCategory(other.category) === selfCat) {
      const sameCluster =
        business.dedup_cluster_id &&
        other.dedup_cluster_id &&
        business.dedup_cluster_id === other.dedup_cluster_id;
      if (!sameCluster) sameCategoryWithin1km += 1;
    }

    // Nearest chain location (any chain, excluding self if self is the same chain).
    const otherChain = chainOf(other);
    if (otherChain) {
      const sameChain = selfChain && selfChain.chainId === otherChain.chainId;
      if (!sameChain) {
        if (nearestChain == null || distM < nearestChain.distanceM) {
          nearestChain = {
            chainId: otherChain.chainId,
            chainName: otherChain.chainName,
            distanceM: distM,
          };
        }
      }
    }
  }

  const nearestNeighborM = nearest ? nearest.distanceM : null;
  const isolation = classifyIsolation(nearestNeighborM, within1km);
  const areaType = classifyArea(within5km);
  const inCluster = within500m >= 3; // 3+ OTHER businesses within 500m

  // ── Flags (ported from the dashboard's GeoFlag set) ───────────────────────
  if (isolation === 'isolated') {
    flags.push({
      code: 'isolated_location',
      label: 'Isolated location',
      detail:
        nearestNeighborM != null
          ? `Nearest other listing is ${(nearestNeighborM / 1000).toFixed(1)} km away — this business sits alone, which is unusual for a storefront.`
          : 'No other geocodable listing nearby — this business sits alone.',
      severity: 'high',
    });
  } else if (isolation === 'sparse') {
    flags.push({
      code: 'sparse_area',
      label: 'Sparse area',
      detail:
        nearestNeighborM != null
          ? `Nearest neighbour is ${(nearestNeighborM / 1000).toFixed(1)} km away; only ${within1km} listing(s) within 1 km.`
          : 'Few nearby listings.',
      severity: 'low',
    });
  }

  if (sameCategoryWithin1km >= 2) {
    flags.push({
      code: 'high_competition_zone',
      label: 'High competition zone',
      detail: `${sameCategoryWithin1km} same-category competitors within 1 km — a saturated micro-market.`,
      severity: 'medium',
    });
  }

  if (nearestChain && nearestChain.distanceM < 500) {
    flags.push({
      code: 'chain_proximity',
      label: 'Chain in immediate vicinity',
      detail: `${nearestChain.chainName} is ${Math.round(nearestChain.distanceM)} m away — chain co-tenancy or competitive pressure.`,
      severity: 'info',
    });
  }

  if (inCluster) {
    flags.push({
      code: 'cluster_member',
      label: 'Part of a geographic cluster',
      detail: `${within500m + 1} listings (incl. this one) sit within 500 m — a tight commercial node.`,
      severity: 'info',
    });
  }

  return {
    lat: self.lat,
    lng: self.lng,
    coordSource: self.source,
    nearestNeighborM,
    nearestNeighbor: nearest || null,
    within500m,
    within1km,
    within5km,
    sameCategoryWithin1km,
    nearestChainM: nearestChain ? nearestChain.distanceM : null,
    nearestChain: nearestChain || null,
    isolation,
    areaType,
    coverageRadiusM,
    inCluster,
    flags,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run geo-metrics across a batch IN PLACE. Each business is mutated with:
 *   - competitor_density_1km (INT) — count of OTHER businesses within 1 km.
 *   - competitor_density_5km (INT) — count of OTHER businesses within 5 km.
 *   - geo_result (object, debug-only — NOT persisted) — the full descriptor
 *     from computeGeoMetrics, for use by lead scoring (Phase 3.9) and the CLI
 *     banner. Same shape as the dashboard's GeoMetricsResult.
 *
 * The O(n²) inner loop is fine for typical batch sizes (hundreds to low
 * thousands). For 10k+ batches, switch to PostGIS ST_DWithin (the GiST index
 * in migrations/003-enrichment.sql already supports it) or a JS spatial index
 * — documented here, not implemented in this module.
 *
 * @param {object[]} businesses — mutated in place.
 * @param {object} [opts] — { logger }
 * @returns {{
 *   total: number,
 *   withCoords: number,
 *   avgNearestNeighborM: number|null,
 *   isolatedListings: number,
 *   highCompetitionListings: number,
 *   urban: number,
 *   suburban: number,
 *   rural: number,
 *   avgDensity1km: number
 * }}
 */
function computeGeoMetricsBatch(businesses, opts) {
  const o = opts || {};
  const list = Array.isArray(businesses) ? businesses : [];
  const stats = {
    total: list.length,
    withCoords: 0,
    avgNearestNeighborM: null,
    isolatedListings: 0,
    highCompetitionListings: 0,
    urban: 0,
    suburban: 0,
    rural: 0,
    avgDensity1km: 0,
  };

  let nnSum = 0;
  let nnCount = 0;
  let density1kmSum = 0;

  for (const b of list) {
    if (!b) continue;

    const result = computeGeoMetrics(b, list);

    // Persisted columns (INT). competitor_density_1km = within1km (count of
    // OTHER businesses within 1 km — the broadest "competition" notion: every
    // nearby business competes for foot traffic). Same-category density is
    // retained on the debug descriptor (result.sameCategoryWithin1km) for
    // lead scoring.
    b.competitor_density_1km = result.within1km;
    b.competitor_density_5km = result.within5km;

    // Debug descriptor (not persisted — feeds lead scoring + CLI banner).
    b.geo_result = result;

    if (result.coordSource !== 'none') stats.withCoords++;
    if (result.nearestNeighborM != null) {
      nnSum += result.nearestNeighborM;
      nnCount++;
    }
    if (result.isolation === 'isolated') stats.isolatedListings++;
    if (result.flags.some((f) => f.code === 'high_competition_zone')) {
      stats.highCompetitionListings++;
    }
    if (result.areaType === 'urban') stats.urban++;
    else if (result.areaType === 'suburban') stats.suburban++;
    else stats.rural++;

    density1kmSum += result.within1km;
  }

  stats.avgNearestNeighborM = nnCount > 0 ? Math.round(nnSum / nnCount) : null;
  stats.avgDensity1km = list.length ? Math.round((density1kmSum / list.length) * 100) / 100 : 0;

  if (o.logger && typeof o.logger.debug === 'function') {
    o.logger.debug(
      `[3.8] geo-metrics: ${stats.withCoords}/${stats.total} with coords, ` +
        `${stats.isolatedListings} isolated, ${stats.highCompetitionListings} high-competition, ` +
        `urban/suburban/rural ${stats.urban}/${stats.suburban}/${stats.rural}`
    );
  }

  return stats;
}

module.exports = {
  __version,
  EARTH_RADIUS_KM,
  ENRICHMENT_COLUMNS,
  // Core API
  haversineKm,
  haversineM,
  getCoord,
  competitorDensity,
  competitorDensitySameCategory,
  computeGeoMetrics,
  computeGeoMetricsBatch,
  // Classification helpers (exported for unit tests)
  classifyIsolation,
  classifyArea,
  coverageRadiusForCategory,
  // Identity / normalization helpers (exported for unit tests)
  isSameListing,
  identityKey,
  normalizeCategory,
  chainOf,
  toFiniteNumber,
  // Catalogues / constants (for tests + extension)
  CATEGORY_COVERAGE,
  DEFAULT_COVERAGE_RADIUS_M,
};
