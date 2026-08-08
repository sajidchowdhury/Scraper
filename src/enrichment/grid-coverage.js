'use strict';

/**
 * src/enrichment/grid-coverage.js — Phase 3.11 — Grid-Based Geospatial Coverage
 *
 * WHY THIS MODULE EXISTS
 *   Google Maps caps search results at ~120 per query. A city like Toronto has
 *   5,000+ restaurants — a single "Restaurant in Toronto" query misses 95%.
 *   Grid coverage splits a region into a grid of (lat,lng) search points, each
 *   receiving its own Maps query, so the scraper harvests the WHOLE area
 *   instead of the first 120 hits. This is a SEARCH-STRATEGY module: it
 *   produces the list of points to query, not per-business enrichment columns
 *   (ENRICHMENT_COLUMNS = []).
 *
 *   The scraper's main loop (src/index.js) calls `gridSearchPoints(region,
 *   {query, stepKm})` to get the list of search points, then runs one Maps
 *   query per point (e.g. "plumber@43.6532,-79.3832"). Overlapping result sets
 *   between adjacent cells are merged by Phase 3.3 dedup.
 *
 * DESIGN RULES (per PHASE3_EXECUTION_PLAN.md §3.11)
 *   - Pure geometry — no network, no DB, no Google API calls. Safe to run
 *     offline. All functions are unit-testable without external state.
 *   - Self-contained implementations preferred over @turf/turf to avoid the
 *     dependency coupling. A DI seam (_loadTurf/_setTurf) is reserved for a
 *     future phase that needs complex polygon ops (union/difference/buffer);
 *     the current ray-caster + haversine + manual grid cover all 3.11 needs.
 *   - Step size matters: too coarse → gaps between grid points exceed Google's
 *     result radius (~3km for a category search) and businesses are missed;
 *     too fine → wasted queries (overlapping result sets). Default 2-5km is
 *     typical for urban plumber/restaurant searches. `estimateCoverage()`
 *     quantifies this trade-off for the operator.
 *   - haversineKm is implemented locally (NOT imported from geo-metrics.js)
 *     to keep this module decoupled from the 3.8 track — the two modules may
 *     evolve independently and 3.8's haversineKm is itself a stub today.
 *   - Lat/lng stepping accounts for longitude compression at higher latitudes
 *     (1° lng shrinks as cos(lat) → 0). The east-west step is recomputed per
 *     row so the grid stays regular in KILOMETRES, not in degrees.
 *
 * PUBLIC API
 *   kmToLatDegrees(km)                  → number   (km → degrees latitude)
 *   kmToLngDegrees(km, lat)             → number   (km → degrees longitude at lat)
 *   generateGrid(bbox, stepKm)          → Array<{lat,lng,row,col}>
 *   pointInPolygon(point, polygon)      → boolean  (ray-casting, even-odd)
 *   bboxFromCenter(center, radiusKm)    → {north,south,east,west}
 *   gridSearchPoints(region, opts)      → Array<{lat,lng,query,label}>
 *   estimateCoverage(points, density?)  → {totalPoints,areaKm2,estimatedListings,coverageRatio}
 *   haversineKm(a, b)                   → number   (great-circle km)
 *   ENRICHMENT_COLUMNS                  → []  (grid drives search input, not DB columns)
 */

// ---------------------------------------------------------------------------
// DI seam for @turf/turf. RESERVED — currently unused. The self-contained
// implementations below (ray-casting point-in-polygon, haversine, manual grid
// generation) cover all Phase 3.11 needs without the @turf/turf dependency. If
// a future phase needs complex polygon ops (union, difference, buffer), load
// turf lazily here and inject a stub in tests via _setTurf. Keeping the seam
// now means callers can opt into turf later without touching call sites.
// ---------------------------------------------------------------------------
let _turf = null;
function _loadTurf() {
  if (_turf) return _turf;
  try {
    _turf = require('@turf/turf');
  } catch (_e) {
    _turf = null; // @turf/turf not installed — fine, we don't require it.
  }
  return _turf;
}
// Test hook: inject a stub turf (or pass null to reset).
function _setTurf(stub) {
  _turf = stub;
}

const __version = 1;

/** Mean Earth radius in kilometres (haversine formula constant). */
const EARTH_RADIUS_KM = 6371;

/**
 * Approximate kilometres per degree of latitude. 1° lat ≈ 111km everywhere on
 * Earth (the meridional circumference is ~40,008km → 40008/360 ≈ 111.1km). We
 * use the conventional 111.0 constant for consistency with the rest of the
 * enrichment pipeline.
 */
const KM_PER_LAT_DEGREE = 111.0;

/**
 * Approximate Google Maps result radius for a category search (e.g.
 * "plumber near me"). Google typically returns businesses within ~3km of the
 * search anchor for non-dense categories; denser categories (restaurants) may
 * tighten to ~1-2km. Used by `estimateCoverage()` to decide whether a grid's
 * spacing is fine enough to avoid coverage gaps.
 */
const GOOGLE_RESULT_RADIUS_KM = 3;

/**
 * Default urban business density (listings/km²) used by estimateCoverage when
 * the caller doesn't supply one. 5/km² is a reasonable mid-range estimate for
 * a typical service category (plumbers, electricians) in a metro area; dense
 * categories like restaurants run 20-50/km² in city cores.
 */
const DEFAULT_URBAN_DENSITY = 5;

/**
 * Default step size (km) when the region is too small to derive one or when
 * the caller omits opts.stepKm. Falls within the documented 2-5km urban range.
 */
const DEFAULT_STEP_KM = 3;

/**
 * Safety valve: refuse to emit more than this many grid points. A 10000-point
 * grid at 3km spacing covers ~90,000km² (roughly all of Portugal) — anything
 * larger is almost certainly a caller mistake (wrong bbox units, swapped
 * north/south, decimal-degree confusion with km). The cap prevents the scraper
 * from accidentally queueing millions of search jobs.
 */
const MAX_GRID_POINTS = 10000;

/**
 * Float-comparison epsilon in decimal degrees. 1e-7° ≈ 1.1cm at the equator —
 * well below any meaningful grid resolution. Used for loop termination and for
 * boundary-point deduplication (so a stepped point that lands within ~1cm of a
 * boundary is treated as the boundary, not as a separate point).
 */
const EPS_DEG = 1e-7;

const ENRICHMENT_COLUMNS = []; // grid coverage drives search input, not DB columns

// ---------------------------------------------------------------------------
// Degree ↔ kilometre conversions
// ---------------------------------------------------------------------------

/**
 * Convert kilometres to degrees of latitude. 1° latitude ≈ 111km everywhere.
 *
 * @param {number} km
 * @returns {number} degrees of latitude (0 for invalid input)
 */
function kmToLatDegrees(km) {
  if (typeof km !== 'number' || !isFinite(km) || km <= 0) return 0;
  return km / KM_PER_LAT_DEGREE;
}

/**
 * Convert kilometres to degrees of longitude at a given latitude. Longitude
 * degrees compress as cos(lat) → 0 toward the poles: 1° lng ≈ 111km at the
 * equator but ≈ 0km at the poles. Returns Infinity at the poles (|lat| = 90°),
 * where east-west distance is undefined; callers should skip such rows.
 *
 * @param {number} km
 * @param {number} lat — latitude in degrees
 * @returns {number} degrees of longitude (0 for invalid input, Infinity at poles)
 */
function kmToLngDegrees(km, lat) {
  if (typeof km !== 'number' || !isFinite(km) || km <= 0) return 0;
  if (typeof lat !== 'number' || !isFinite(lat)) return 0;
  const cosLat = Math.cos(lat * Math.PI / 180);
  if (Math.abs(cosLat) < 1e-12) return Infinity; // at/near a pole
  return km / (KM_PER_LAT_DEGREE * cosLat);
}

// ---------------------------------------------------------------------------
// Distance (haversine) — self-contained, deliberately not imported from 3.8
// ---------------------------------------------------------------------------

/**
 * Great-circle distance between two {lat,lng} points in kilometres (haversine
 * formula). Pure function — unit-testable without a database or network.
 *
 * Implemented locally rather than imported from geo-metrics.js so this module
 * stays decoupled from the Phase 3.8 track (which may evolve its own
 * haversine variant, e.g. a PostGIS-backed implementation).
 *
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @returns {number} kilometres (0 if either point is invalid)
 */
function haversineKm(a, b) {
  if (!a || !b) return 0;
  const lat1 = a.lat;
  const lng1 = a.lng;
  const lat2 = b.lat;
  const lng2 = b.lng;
  if (typeof lat1 !== 'number' || typeof lng1 !== 'number' ||
      typeof lat2 !== 'number' || typeof lng2 !== 'number' ||
      !isFinite(lat1) || !isFinite(lng1) || !isFinite(lat2) || !isFinite(lng2)) {
    return 0;
  }
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * sinDLng * sinDLng;
  // Clamp h to [0,1] to guard against floating-point drift past the unit circle.
  const hClamped = h < 0 ? 0 : (h > 1 ? 1 : h);
  const c = 2 * Math.atan2(Math.sqrt(hClamped), Math.sqrt(1 - hClamped));
  return EARTH_RADIUS_KM * c;
}

// ---------------------------------------------------------------------------
// Bounding-box helpers
// ---------------------------------------------------------------------------

/**
 * Validate a bounding box. A valid bbox has all four numeric, finite edges with
 * north > south and east > west. Antimeridian-crossing boxes (east < west) are
 * rejected — Google Maps scraping regions are assumed not to cross ±180°.
 *
 * @param {object} bbox
 * @returns {boolean}
 */
function _isValidBbox(bbox) {
  return !!bbox &&
    typeof bbox.north === 'number' && isFinite(bbox.north) &&
    typeof bbox.south === 'number' && isFinite(bbox.south) &&
    typeof bbox.east === 'number' && isFinite(bbox.east) &&
    typeof bbox.west === 'number' && isFinite(bbox.west) &&
    bbox.north > bbox.south &&
    bbox.east > bbox.west;
}

/**
 * Compute the bounding box of a polygon (min/max of vertex lat/lng).
 *
 * @param {Array<{lat:number,lng:number}>} polygon
 * @returns {{north,south,east,west}|null} null if the polygon has no valid vertices
 */
function _bboxFromPolygon(polygon) {
  let north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
  for (const v of polygon) {
    if (!v || typeof v.lat !== 'number' || typeof v.lng !== 'number' ||
        !isFinite(v.lat) || !isFinite(v.lng)) continue;
    if (v.lat > north) north = v.lat;
    if (v.lat < south) south = v.lat;
    if (v.lng > east) east = v.lng;
    if (v.lng < west) west = v.lng;
  }
  if (!isFinite(north) || !isFinite(south) || !isFinite(east) || !isFinite(west)) {
    return null;
  }
  return { north, south, east, west };
}

/**
 * Great-circle diagonal of a bounding box (SW corner → NE corner), in km.
 * Used to derive a sensible default grid step from the region's overall size.
 *
 * @param {{north,south,east,west}} bbox
 * @returns {number}
 */
function _bboxDiagonalKm(bbox) {
  return haversineKm({ lat: bbox.south, lng: bbox.west }, { lat: bbox.north, lng: bbox.east });
}

/**
 * Derive a default grid step (km) from the region's diagonal. Smaller regions
 * get finer grids so a tiny downtown area isn't covered by a single coarse
 * cell; larger regions get coarser grids to keep the point count manageable.
 * The tiers land in the documented 2-5km range for typical urban searches.
 *
 *   diagonal ≤ 10km  → 1.5km  (neighbourhood-scale, dense category)
 *   diagonal ≤ 30km  → 2km    (borough/city-core scale)
 *   diagonal ≤ 80km  → 3km    (typical metro — the DEFAULT_STEP_KM)
 *   diagonal ≤ 200km → 5km    (small country / large metro area)
 *   diagonal > 200km → 8km    (region/state — operator should tune manually)
 *
 * @param {number} diagonalKm
 * @returns {number}
 */
function _deriveDefaultStepKm(diagonalKm) {
  if (typeof diagonalKm !== 'number' || !(diagonalKm > 0)) return DEFAULT_STEP_KM;
  if (diagonalKm <= 10) return 1.5;
  if (diagonalKm <= 30) return 2;
  if (diagonalKm <= 80) return 3;
  if (diagonalKm <= 200) return 5;
  return 8;
}

// ---------------------------------------------------------------------------
// Grid generation
// ---------------------------------------------------------------------------

/**
 * Generate a grid of search points covering a bounding box, spaced stepKm
 * apart in both dimensions. Starts at the SW corner and steps north then east.
 * Both the north and east boundaries are guaranteed to be represented (a final
 * boundary row/column is appended if the last step overshoots or undershoots).
 *
 * The east-west step is recomputed for each row's latitude so the grid stays
 * regular in KILOMETRES — without this, a grid at 60°N would have ~2× the
 * east-west density of one at the equator for the same stepKm.
 *
 * Each point carries `row` and `col` indices (0-based from the SW corner) for
 * debugging and for stable labelling in `gridSearchPoints`.
 *
 * @param {{north:number,south:number,east:number,west:number}} bbox
 * @param {number} stepKm — grid spacing in kilometres
 * @returns {Array<{lat:number,lng:number,row:number,col:number}>} empty if the
 *   bbox is invalid or stepKm ≤ 0; capped at MAX_GRID_POINTS points.
 */
function generateGrid(bbox, stepKm) {
  if (!_isValidBbox(bbox)) return [];
  if (typeof stepKm !== 'number' || !isFinite(stepKm) || stepKm <= 0) return [];

  const { north, south, east, west } = bbox;
  const latStep = kmToLatDegrees(stepKm);
  if (!(latStep > 0)) return [];

  // Row latitudes: south → north, both boundaries included.
  const rowLats = [];
  for (let lat = south; lat <= north + EPS_DEG; lat += latStep) {
    if (rowLats.length >= MAX_GRID_POINTS) break;
    rowLats.push(Math.min(lat, north)); // clamp overshoot to the north boundary
  }
  // Guarantee the north boundary is the last row (loop may have undershot).
  if (rowLats.length === 0 || Math.abs(rowLats[rowLats.length - 1] - north) > EPS_DEG) {
    if (rowLats.length < MAX_GRID_POINTS) rowLats.push(north);
  }

  const points = [];
  for (let r = 0; r < rowLats.length; r++) {
    const lat = rowLats[r];
    const lngStep = kmToLngDegrees(stepKm, lat);
    // Skip rows at/near a pole where east-west distance is undefined.
    if (!isFinite(lngStep) || !(lngStep > 0)) continue;

    let c = 0;
    let lastLng = null;
    for (let lng = west; lng <= east + EPS_DEG; lng += lngStep) {
      if (points.length >= MAX_GRID_POINTS) return points;
      const clampedLng = Math.min(lng, east);
      // Dedup against the previous point on this row (handles the case where
      // a stepped point clamps to within EPS_DEG of the last one).
      if (lastLng === null || Math.abs(clampedLng - lastLng) > EPS_DEG) {
        points.push({ lat, lng: clampedLng, row: r, col: c });
        lastLng = clampedLng;
        c++;
      }
    }
    // Guarantee the east boundary for this row (loop may have undershot).
    if ((lastLng === null || Math.abs(lastLng - east) > EPS_DEG) &&
        points.length < MAX_GRID_POINTS) {
      points.push({ lat, lng: east, row: r, col: c });
    }
  }
  return points;
}

/**
 * Compute a bounding box of side ~2×radiusKm centred on a point. The box
 * extends radiusKm north/south/east/west of the centre. East-west extent uses
 * kmToLngDegrees at the centre latitude (so the box is square in km, not in
 * degrees).
 *
 * @param {{lat:number,lng:number}} center
 * @param {number} radiusKm — half the box's side length
 * @returns {{north,south,east,west}|null} null for invalid input
 */
function bboxFromCenter(center, radiusKm) {
  if (!center ||
      typeof center.lat !== 'number' || typeof center.lng !== 'number' ||
      !isFinite(center.lat) || !isFinite(center.lng)) return null;
  if (typeof radiusKm !== 'number' || !isFinite(radiusKm) || radiusKm <= 0) return null;

  const dLat = kmToLatDegrees(radiusKm);
  const dLng = kmToLngDegrees(radiusKm, center.lat);
  if (!(dLat > 0) || !isFinite(dLng) || !(dLng > 0)) return null;

  return {
    north: center.lat + dLat,
    south: center.lat - dLat,
    east: center.lng + dLng,
    west: center.lng - dLng,
  };
}

// ---------------------------------------------------------------------------
// Point-in-polygon (ray-casting, even-odd rule)
// ---------------------------------------------------------------------------

/**
 * Test whether a point falls inside a polygon using the ray-casting algorithm
 * (W. Randolph Franklin's PNPOLY) with the standard even-odd rule. The polygon
 * may be open (last vertex ≠ first) or closed (last vertex == first) — a
 * duplicated closing vertex is detected and dropped before iteration.
 *
 * Vertices use {lat,lng}; lng is treated as the x-axis, lat as the y-axis.
 * This is the conventional mapping for geographic point-in-polygon tests and
 * matches the output format of generateGrid / gridSearchPoints.
 *
 * Edge cases:
 *   - polygon with fewer than 3 distinct vertices → false (no area).
 *   - point exactly on an edge → indeterminate (may return true or false);
 *     this is acceptable for search-grid filtering, where a boundary point is
 *     covered by the adjacent cell anyway.
 *
 * @param {{lat:number,lng:number}} point
 * @param {Array<{lat:number,lng:number}>} polygon
 * @returns {boolean}
 */
function pointInPolygon(point, polygon) {
  if (!point || !Array.isArray(polygon)) return false;
  const n = polygon.length;
  if (n < 3) return false;
  if (typeof point.lat !== 'number' || typeof point.lng !== 'number') return false;

  // Drop a duplicated closing vertex so we can iterate edges as (i, i-1).
  const verts = polygon.slice();
  const first = verts[0];
  const last = verts[n - 1];
  if (first && last &&
      first.lat === last.lat && first.lng === last.lng) {
    verts.pop();
  }
  const m = verts.length;
  if (m < 3) return false;

  const x = point.lng;
  const y = point.lat;
  let inside = false;
  for (let i = 0, j = m - 1; i < m; j = i++) {
    const xi = verts[i].lng, yi = verts[i].lat;
    const xj = verts[j].lng, yj = verts[j].lat;
    // Is the ray crossing this edge? Test whether the edge straddles the
    // horizontal line y=point.lat, and if so, whether the crossing is to
    // the left of (smaller lng than) the point.
    const intersects = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// High-level search-point generation
// ---------------------------------------------------------------------------

/**
 * Build the search-query string for a grid point. Format: `query@lat,lng`
 * (e.g. "plumber@43.6532,-79.3832"). When the query term is empty, just the
 * coordinates are returned (the scraper can still use them as a bare anchor).
 * Coordinates are formatted to 6 decimal places (~11cm) — far below any grid
 * spacing, and well within Google Maps' location-resolution floor.
 *
 * @param {string} query — the search term (e.g. 'plumber')
 * @param {{lat:number,lng:number}} point
 * @returns {string}
 */
function _formatQuery(query, point) {
  const lat = Number(point.lat).toFixed(6);
  const lng = Number(point.lng).toFixed(6);
  const q = (typeof query === 'string' ? query : String(query || '')).trim();
  return q ? `${q}@${lat},${lng}` : `${lat},${lng}`;
}

/**
 * Generate the full list of search points for a region, each carrying the
 * search query string the scraper should submit for that cell. This is the
 * main entry point the scraper's query loop calls.
 *
 * Region spec (one of):
 *   - { center: {lat,lng}, radiusKm: number }  → bbox of side 2×radiusKm
 *   - { bbox: {north,south,east,west} }        → use the bbox directly
 *   - { polygon: [{lat,lng}, ...] }            → bbox of the polygon, then
 *                                                  filter points to inside it
 *
 * Options:
 *   - stepKm  — grid spacing. Default derived from the region's diagonal via
 *               _deriveDefaultStepKm (smaller region → finer grid).
 *   - query   — the search term (e.g. 'plumber'). Default '' (coordinates only).
 *
 * For polygon regions, grid points falling outside the polygon are dropped, so
 * the returned list covers only the polygon's interior (no wasted queries on
 * the polygon's bounding-box corners).
 *
 * @param {object} region — {center,radiusKm} | {bbox} | {polygon}
 * @param {object} [opts] — {stepKm, query}
 * @returns {Array<{lat:number,lng:number,query:string,label:string}>}
 */
function gridSearchPoints(region, opts) {
  const o = opts || {};
  if (!region || typeof region !== 'object') return [];

  // Resolve the working bounding box (and optional polygon filter).
  let bbox = null;
  let polygon = null;
  if (Array.isArray(region.polygon) && region.polygon.length >= 3) {
    polygon = region.polygon;
    bbox = _bboxFromPolygon(polygon);
  } else if (_isValidBbox(region.bbox)) {
    bbox = region.bbox;
  } else if (region.center && typeof region.center.lat === 'number' &&
             typeof region.center.lng === 'number' &&
             typeof region.radiusKm === 'number' && region.radiusKm > 0) {
    bbox = bboxFromCenter(region.center, region.radiusKm);
  }
  if (!_isValidBbox(bbox)) return [];

  // Step size: explicit > derived from bbox diagonal > module default.
  const stepKm = (typeof o.stepKm === 'number' && o.stepKm > 0)
    ? o.stepKm
    : _deriveDefaultStepKm(_bboxDiagonalKm(bbox));

  let grid = generateGrid(bbox, stepKm);
  if (polygon) {
    grid = grid.filter((p) => pointInPolygon(p, polygon));
  }

  const query = o.query != null ? o.query : '';
  return grid.map((p) => ({
    lat: p.lat,
    lng: p.lng,
    query: _formatQuery(query, p),
    label: `grid-r${p.row}c${p.col}`,
  }));
}

// ---------------------------------------------------------------------------
// Coverage estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the grid spacing (stepKm) from a set of grid points by computing
 * each point's nearest-neighbour distance and taking the 90th percentile.
 *
 * The 90th percentile (rather than the median) is deliberate: generateGrid
 * appends explicit north/east boundary points that sit CLOSER than stepKm to
 * their last stepped neighbour (so the boundary is fully covered). These short
 * boundary gaps drag the median below the true stepKm. Interior points'
 * nearest neighbour is exactly one cell away (= stepKm), and they dominate the
 * upper percentiles — so the 90th percentile recovers stepKm robustly even
 * when boundary points are the majority (small grids). The 90th (rather than
 * the max) also tolerates a few polygon-edge points whose nearest neighbour
 * was filtered out, whose NN distance may briefly exceed stepKm.
 *
 * To bound runtime, only the first 500 points are used as query points (each
 * still compares against ALL n points). For a regular grid this is more than
 * enough to recover the spacing.
 *
 * @param {Array<{lat:number,lng:number}>} points
 * @returns {number} estimated stepKm (0 if <2 points)
 */
function _estimateStepKm(points) {
  const n = points.length;
  if (n < 2) return 0;
  const sampleSize = Math.min(n, 500);
  const dists = [];
  for (let i = 0; i < sampleSize; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const d = haversineKm(points[i], points[j]);
      if (d < best) best = d;
    }
    if (best !== Infinity) dists.push(best);
  }
  if (dists.length === 0) return 0;
  dists.sort((a, b) => a - b);
  // 90th percentile, nearest-rank method: index = ceil(0.9 × n) − 1.
  const idx = Math.min(dists.length - 1, Math.max(0, Math.ceil(0.9 * dists.length) - 1));
  return dists[idx];
}

/**
 * Estimate coverage quality of a grid from its points. Returns:
 *   - totalPoints       — number of points supplied.
 *   - areaKm2           — approx region area = points × stepKm² (each cell is a
 *                          stepKm × stepKm square; total area ≈ count × cell).
 *   - estimatedListings — area × density (default 5/km² urban). Rough order-of-
 *                          magnitude figure; real density varies by category.
 *   - coverageRatio     — 0..1 indicator of how gap-free the grid is. Computed
 *                          as GOOGLE_RESULT_RADIUS_KM / (stepKm/√2), capped at
 *                          1.0. When stepKm ≤ ~4.2km the worst-case distance
 *                          from any location to its nearest grid point stays
 *                          within Google's result radius → ratio 1.0 (full
 *                          coverage). Coarser grids drop below 1.0, signalling
 *                          gaps where businesses may be missed. Operators
 *                          should aim for coverageRatio = 1.0 (the target).
 *
 * The effective stepKm is recovered from the points themselves (90th
 * percentile of nearest-neighbour distances — see `_estimateStepKm`), so
 * callers can pass the raw gridSearchPoints output without tracking the step
 * separately.
 *
 * @param {Array<{lat:number,lng:number}>} points
 * @param {number} [expectedDensity] — listings/km² (default 5, urban)
 * @returns {{totalPoints:number,areaKm2:number,estimatedListings:number,coverageRatio:number}}
 */
function estimateCoverage(points, expectedDensity) {
  const list = Array.isArray(points) ? points : [];
  const totalPoints = list.length;
  const density = (typeof expectedDensity === 'number' && expectedDensity > 0)
    ? expectedDensity
    : DEFAULT_URBAN_DENSITY;

  if (totalPoints === 0) {
    return { totalPoints: 0, areaKm2: 0, estimatedListings: 0, coverageRatio: 0 };
  }

  const stepKm = _estimateStepKm(list);
  const areaKm2 = stepKm > 0 ? totalPoints * stepKm * stepKm : 0;
  const estimatedListings = Math.round(areaKm2 * density);

  let coverageRatio = 0;
  if (stepKm > 0) {
    // Worst-case distance from any location in a cell to the cell's grid point
    // is half the cell diagonal = stepKm / √2. Full coverage when that ≤ the
    // Google result radius; below that, the ratio drops linearly.
    const worstCase = stepKm / Math.SQRT2;
    coverageRatio = Math.min(1, GOOGLE_RESULT_RADIUS_KM / worstCase);
  }

  return { totalPoints, areaKm2, estimatedListings, coverageRatio };
}

module.exports = {
  __version,
  ENRICHMENT_COLUMNS,
  EARTH_RADIUS_KM,
  // Core API
  kmToLatDegrees,
  kmToLngDegrees,
  generateGrid,
  pointInPolygon,
  bboxFromCenter,
  gridSearchPoints,
  estimateCoverage,
  haversineKm,
  // Constants exposed for tests / operator reference
  KM_PER_LAT_DEGREE,
  GOOGLE_RESULT_RADIUS_KM,
  DEFAULT_URBAN_DENSITY,
  DEFAULT_STEP_KM,
  MAX_GRID_POINTS,
  // Test seam (reserved — @turf/turf not currently used)
  _loadTurf,
  _setTurf,
};
