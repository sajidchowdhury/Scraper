'use strict';

/**
 * tests/enrichment-grid-coverage.test.js — Phase 3.11 — Grid-Based Geospatial Coverage tests
 *
 * Coverage (per PHASE3_EXECUTION_PLAN.md §3.11 task checklist + acceptance):
 *   - Degree ↔ kilometre conversions (kmToLatDegrees, kmToLngDegrees with cos(lat) compression)
 *   - haversineKm great-circle distance (known distance, symmetric, same-point, invalid)
 *   - bboxFromCenter (return shape {north,south,east,west}, edge midpoints ≈ radiusKm)
 *   - generateGrid: 2×2 → 4 points (KEY ACCEPTANCE), 3×3 → 9, boundary inclusion, invalid bbox
 *   - generateGrid MAX_GRID_POINTS safety cap (10000)
 *   - pointInPolygon ray-casting (inside, outside, edge/vertex, concave notch, open/closed)
 *   - gridSearchPoints region specs: center+radius, bbox, polygon (filter to interior)
 *   - gridSearchPoints emitted-point shape ({lat,lng,query,label}, query formatted)
 *   - estimateCoverage: dense → ratio 1.0, sparse → ratio <1, empty/single, estimatedListings
 *   - ENRICHMENT_COLUMNS === [] (search-strategy module, no DB columns)
 *   - Module constants + turf DI seam
 *
 * Pure geometry — no network, no DB, no @turf/turf required. All deterministic.
 *
 * Run: bun test tests/enrichment-grid-coverage.test.js
 */

const {
  __version,
  ENRICHMENT_COLUMNS,
  EARTH_RADIUS_KM,
  KM_PER_LAT_DEGREE,
  GOOGLE_RESULT_RADIUS_KM,
  DEFAULT_URBAN_DENSITY,
  DEFAULT_STEP_KM,
  MAX_GRID_POINTS,
  kmToLatDegrees,
  kmToLngDegrees,
  haversineKm,
  bboxFromCenter,
  generateGrid,
  pointInPolygon,
  gridSearchPoints,
  estimateCoverage,
  _loadTurf,
  _setTurf,
} = require('../src/enrichment/grid-coverage');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function approxEqual(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------------------
// 1. kmToLatDegrees
// ---------------------------------------------------------------------------

describe('Phase 3.11 — kmToLatDegrees', () => {
  test('111 km → ~1.0° (KM_PER_LAT_DEGREE)', () => {
    expect(kmToLatDegrees(111)).toBeCloseTo(1.0, 10);
    expect(kmToLatDegrees(KM_PER_LAT_DEGREE)).toBeCloseTo(1.0, 10);
  });

  test('222 km → ~2.0° (linear scaling)', () => {
    expect(kmToLatDegrees(222)).toBeCloseTo(2.0, 10);
  });

  test('0 / negative / NaN / non-number → 0', () => {
    expect(kmToLatDegrees(0)).toBe(0);
    expect(kmToLatDegrees(-5)).toBe(0);
    expect(kmToLatDegrees(NaN)).toBe(0);
    expect(kmToLatDegrees(Infinity)).toBe(0);
    expect(kmToLatDegrees('5')).toBe(0);
    expect(kmToLatDegrees(null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. kmToLngDegrees (cos(lat) longitude compression)
// ---------------------------------------------------------------------------

describe('Phase 3.11 — kmToLngDegrees', () => {
  test('at equator (lat 0) 111 km → ~1.0°', () => {
    expect(kmToLngDegrees(111, 0)).toBeCloseTo(1.0, 10);
  });

  test('at lat 60, 111 km → ~2.0° (cos(60°)=0.5 halves the span)', () => {
    // 111 / (111 * cos(60°)) = 1 / 0.5 = 2.0
    expect(kmToLngDegrees(111, 60)).toBeCloseTo(2.0, 5);
  });

  test('verify the cos(lat) factor: lat 60 doubles equator value', () => {
    const atEquator = kmToLngDegrees(111, 0);
    const at60 = kmToLngDegrees(111, 60);
    expect(at60 / atEquator).toBeCloseTo(2.0, 5); // 1/cos(60°) = 2
  });

  test('at the poles (|lat| = 90°) → Infinity (east-west undefined)', () => {
    expect(kmToLngDegrees(111, 90)).toBe(Infinity);
    expect(kmToLngDegrees(111, -90)).toBe(Infinity);
  });

  test('invalid input → 0', () => {
    expect(kmToLngDegrees(0, 0)).toBe(0);
    expect(kmToLngDegrees(-5, 0)).toBe(0);
    expect(kmToLngDegrees(NaN, 0)).toBe(0);
    expect(kmToLngDegrees(111, NaN)).toBe(0);
    expect(kmToLngDegrees(111, 'x')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. haversineKm
// ---------------------------------------------------------------------------

describe('Phase 3.11 — haversineKm', () => {
  test('0.5° latitude apart ≈ 55.6 km (within tolerance)', () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 0.5, lng: 0 };
    const d = haversineKm(a, b);
    // 0.5° lat × ~111.19 km/° (haversine with R=6371) ≈ 55.6 km
    expect(d).toBeGreaterThan(55);
    expect(d).toBeLessThan(56);
  });

  test('same point → 0', () => {
    const p = { lat: 43.6532, lng: -79.3832 };
    expect(haversineKm(p, p)).toBe(0);
  });

  test('symmetric: haversineKm(a,b) === haversineKm(b,a)', () => {
    const a = { lat: 40.7128, lng: -74.006 }; // NYC
    const b = { lat: 51.5074, lng: -0.1278 }; // London
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 10);
  });

  test('uses EARTH_RADIUS_KM = 6371 (1° lat ≈ 111.19 km)', () => {
    expect(EARTH_RADIUS_KM).toBe(6371);
    const d = haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    // With R=6371: 1° lat = 6371 × π/180 ≈ 111.195 km
    expect(d).toBeCloseTo(111.195, 2);
  });

  test('null / invalid points → 0 (no throw)', () => {
    expect(haversineKm(null, { lat: 0, lng: 0 })).toBe(0);
    expect(haversineKm({ lat: 0, lng: 0 }, null)).toBe(0);
    expect(haversineKm({ lat: 'x', lng: 0 }, { lat: 0, lng: 0 })).toBe(0);
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: NaN, lng: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. bboxFromCenter
// ---------------------------------------------------------------------------

describe('Phase 3.11 — bboxFromCenter', () => {
  test('returns {north,south,east,west} object (order confirmed from source)', () => {
    const bbox = bboxFromCenter({ lat: 0, lng: 0 }, 111);
    expect(bbox).not.toBeNull();
    expect(bbox).toEqual(expect.objectContaining({
      north: expect.any(Number),
      south: expect.any(Number),
      east: expect.any(Number),
      west: expect.any(Number),
    }));
    // Centered at origin: north = +dLat, south = -dLat, east = +dLng, west = -dLng
    expect(bbox.north).toBeCloseTo(1.0, 5);
    expect(bbox.south).toBeCloseTo(-1.0, 5);
    expect(bbox.east).toBeCloseTo(1.0, 5);
    expect(bbox.west).toBeCloseTo(-1.0, 5);
  });

  test('edge midpoints are ≈ radiusKm from the centre', () => {
    const center = { lat: 43.6532, lng: -79.3832 };
    const radiusKm = 5;
    const bbox = bboxFromCenter(center, radiusKm);
    // North edge midpoint = (north, center.lng); distance ≈ radiusKm along meridian
    const northEdge = { lat: bbox.north, lng: center.lng };
    const southEdge = { lat: bbox.south, lng: center.lng };
    const eastEdge = { lat: center.lat, lng: bbox.east };
    const westEdge = { lat: center.lat, lng: bbox.west };
    expect(haversineKm(center, northEdge)).toBeCloseTo(radiusKm, 0);
    expect(haversineKm(center, southEdge)).toBeCloseTo(radiusKm, 0);
    expect(haversineKm(center, eastEdge)).toBeCloseTo(radiusKm, 0);
    expect(haversineKm(center, westEdge)).toBeCloseTo(radiusKm, 0);
  });

  test('box side ≈ 2 × radiusKm (north-south span)', () => {
    const center = { lat: 0, lng: 0 };
    const bbox = bboxFromCenter(center, 50);
    const spanKm = haversineKm(
      { lat: bbox.south, lng: 0 },
      { lat: bbox.north, lng: 0 }
    );
    expect(spanKm).toBeCloseTo(100, 0); // 2 × 50 km
  });

  test('invalid centre or radius → null', () => {
    expect(bboxFromCenter(null, 10)).toBeNull();
    expect(bboxFromCenter({ lat: 0, lng: 0 }, 0)).toBeNull();
    expect(bboxFromCenter({ lat: 0, lng: 0 }, -5)).toBeNull();
    expect(bboxFromCenter({ lat: 'x', lng: 0 }, 10)).toBeNull();
    expect(bboxFromCenter({ lat: 0, lng: 0 }, NaN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. generateGrid (KEY ACCEPTANCE: 2×2 → 4 points)
// ---------------------------------------------------------------------------

describe('Phase 3.11 — generateGrid', () => {
  test('2×2 grid produces exactly 4 points (Phase 3.13 acceptance test)', () => {
    // stepKm = 111 → latStep = 1.0° exactly; bbox 1°×1° → 2 rows × 2 cols.
    const bbox = { north: 1, south: 0, east: 1, west: 0 };
    const grid = generateGrid(bbox, 111);
    expect(grid).toHaveLength(4);
  });

  test('2×2 grid spans the bbox with boundary inclusion', () => {
    const bbox = { north: 1, south: 0, east: 1, west: 0 };
    const grid = generateGrid(bbox, 111);
    const lats = grid.map((p) => p.lat);
    const lngs = grid.map((p) => p.lng);
    // south boundary represented
    expect(Math.min(...lats)).toBeCloseTo(0, 7);
    // north boundary represented
    expect(Math.max(...lats)).toBeCloseTo(1, 7);
    // west boundary represented
    expect(Math.min(...lngs)).toBeCloseTo(0, 7);
    // east boundary represented
    expect(Math.max(...lngs)).toBeCloseTo(1, 7);
  });

  test('3×3 grid produces exactly 9 points', () => {
    // stepKm = 111 → 1.0° steps; bbox 2°×2° → 3 rows × 3 cols.
    const bbox = { north: 2, south: 0, east: 2, west: 0 };
    const grid = generateGrid(bbox, 111);
    expect(grid).toHaveLength(9);
  });

  test('each point carries row + col indices', () => {
    const bbox = { north: 1, south: 0, east: 1, west: 0 };
    const grid = generateGrid(bbox, 111);
    for (const p of grid) {
      expect(typeof p.row).toBe('number');
      expect(typeof p.col).toBe('number');
      expect(p.row).toBeGreaterThanOrEqual(0);
      expect(p.col).toBeGreaterThanOrEqual(0);
    }
  });

  test('invalid bbox / stepKm ≤ 0 → empty array', () => {
    expect(generateGrid(null, 5)).toEqual([]);
    expect(generateGrid({ north: 0, south: 1, east: 1, west: 0 }, 5)).toEqual([]); // north < south
    expect(generateGrid({ north: 1, south: 0, east: 0, west: 1 }, 5)).toEqual([]); // east < west
    expect(generateGrid({ north: 1, south: 0, east: 1, west: 0 }, 0)).toEqual([]);
    expect(generateGrid({ north: 1, south: 0, east: 1, west: 0 }, -5)).toEqual([]);
    expect(generateGrid({ north: 1, south: 0, east: 1, west: 0 }, NaN)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. generateGrid MAX_GRID_POINTS cap
// ---------------------------------------------------------------------------

describe('Phase 3.11 — generateGrid MAX_GRID_POINTS cap', () => {
  test('huge bbox + tiny step is capped at MAX_GRID_POINTS (10000)', () => {
    // A 2°×358° bbox at 0.01 km step would naïvely produce millions of
    // points; the cap returns the first 10000 and stops.
    const bbox = { north: 1, south: -1, east: 179, west: -179 };
    const grid = generateGrid(bbox, 0.01);
    expect(grid.length).toBeLessThanOrEqual(MAX_GRID_POINTS);
    expect(grid.length).toBe(MAX_GRID_POINTS);
  });
});

// ---------------------------------------------------------------------------
// 7. pointInPolygon (PNPOLY ray-casting)
// ---------------------------------------------------------------------------

describe('Phase 3.11 — pointInPolygon', () => {
  const square = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
    { lat: 1, lng: 1 },
    { lat: 1, lng: 0 },
  ];

  test('point clearly inside a square → true', () => {
    expect(pointInPolygon({ lat: 0.5, lng: 0.5 }, square)).toBe(true);
  });

  test('point clearly outside → false', () => {
    expect(pointInPolygon({ lat: 2, lng: 2 }, square)).toBe(false);
    expect(pointInPolygon({ lat: 0.5, lng: 2 }, square)).toBe(false);
    expect(pointInPolygon({ lat: -1, lng: 0.5 }, square)).toBe(false);
  });

  test('point on an edge returns a boolean (indeterminate per PNPOLY)', () => {
    // The module docs state boundary points are indeterminate (may be true
    // or false). We only assert it does not crash and yields a boolean.
    const onEdge = pointInPolygon({ lat: 0, lng: 0.5 }, square);
    expect(typeof onEdge).toBe('boolean');
    const onVertex = pointInPolygon({ lat: 0, lng: 0 }, square);
    expect(typeof onVertex).toBe('boolean');
  });

  test('concave polygon: point in the notch → false', () => {
    // C-shaped polygon opening to the right; notch = lat∈(1,2), lng∈(1,3).
    const cShape = [
      { lat: 0, lng: 0 },
      { lat: 3, lng: 0 },
      { lat: 3, lng: 3 },
      { lat: 2, lng: 3 },
      { lat: 2, lng: 1 },
      { lat: 1, lng: 1 },
      { lat: 1, lng: 3 },
      { lat: 0, lng: 3 },
    ];
    expect(pointInPolygon({ lat: 1.5, lng: 2 }, cShape)).toBe(false); // inside the notch
  });

  test('concave polygon: point in the solid arm → true', () => {
    const cShape = [
      { lat: 0, lng: 0 },
      { lat: 3, lng: 0 },
      { lat: 3, lng: 3 },
      { lat: 2, lng: 3 },
      { lat: 2, lng: 1 },
      { lat: 1, lng: 1 },
      { lat: 1, lng: 3 },
      { lat: 0, lng: 3 },
    ];
    expect(pointInPolygon({ lat: 1.5, lng: 0.5 }, cShape)).toBe(true); // left arm
  });

  test('open vs closed polygon give identical results', () => {
    const open = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 4 },
      { lat: 4, lng: 0 },
    ];
    const closed = [...open, { lat: 0, lng: 0 }]; // duplicated closing vertex
    const inside = { lat: 1, lng: 1 };
    const outside = { lat: 3, lng: 3 };
    expect(pointInPolygon(inside, open)).toBe(pointInPolygon(inside, closed));
    expect(pointInPolygon(outside, open)).toBe(pointInPolygon(outside, closed));
    expect(pointInPolygon(inside, open)).toBe(true);
    expect(pointInPolygon(outside, open)).toBe(false);
  });

  test('polygon with fewer than 3 vertices → false', () => {
    expect(pointInPolygon({ lat: 0.5, lng: 0.5 }, [])).toBe(false);
    expect(pointInPolygon({ lat: 0.5, lng: 0.5 }, [{ lat: 0, lng: 0 }])).toBe(false);
    expect(pointInPolygon({ lat: 0.5, lng: 0.5 }, [
      { lat: 0, lng: 0 }, { lat: 1, lng: 1 },
    ])).toBe(false);
  });

  test('invalid point / polygon → false', () => {
    expect(pointInPolygon(null, square)).toBe(false);
    expect(pointInPolygon({ lat: 0.5, lng: 0.5 }, null)).toBe(false);
    expect(pointInPolygon({ lat: 'x', lng: 0.5 }, square)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. gridSearchPoints — center + radius spec
// ---------------------------------------------------------------------------

describe('Phase 3.11 — gridSearchPoints (center+radius)', () => {
  test('emits {lat,lng,query,label} points covering the radius', () => {
    const region = {
      type: 'center',
      center: { lat: 43.6532, lng: -79.3832 },
      radiusKm: 10,
    };
    const pts = gridSearchPoints(region, { stepKm: 3, query: 'plumber' });
    expect(pts.length).toBeGreaterThan(0);
    // A 20×20 km box at 3 km step → roughly 7×7 ≈ 49 points (bounded by cap).
    expect(pts.length).toBeLessThan(MAX_GRID_POINTS);
    for (const p of pts) {
      expect(typeof p.lat).toBe('number');
      expect(typeof p.lng).toBe('number');
      // Every point lies within the box (radiusKm of the centre in each axis).
      expect(Math.abs(p.lat - region.center.lat)).toBeLessThan(1);
      expect(Math.abs(p.lng - region.center.lng)).toBeLessThan(1);
    }
  });

  test('query string is formatted as "term@lat,lng" and label is set', () => {
    const region = {
      center: { lat: 40.7128, lng: -74.006 },
      radiusKm: 3,
    };
    const pts = gridSearchPoints(region, { stepKm: 3, query: 'cafe' });
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) {
      expect(typeof p.query).toBe('string');
      expect(p.query.length).toBeGreaterThan(0);
      expect(p.query.startsWith('cafe@')).toBe(true);
      // 6 decimal places for the coordinates
      expect(p.query).toMatch(/^cafe@-?\d+\.\d{6},-?\d+\.\d{6}$/);
      expect(typeof p.label).toBe('string');
      expect(p.label.startsWith('grid-r')).toBe(true);
    }
  });

  test('empty query term yields bare "lat,lng" coordinates', () => {
    const region = { center: { lat: 0, lng: 0 }, radiusKm: 3 };
    const pts = gridSearchPoints(region, { stepKm: 3, query: '' });
    expect(pts.length).toBeGreaterThan(0);
    expect(pts[0].query).toMatch(/^-?\d+\.\d{6},-?\d+\.\d{6}$/);
  });
});

// ---------------------------------------------------------------------------
// 9. gridSearchPoints — bbox spec
// ---------------------------------------------------------------------------

describe('Phase 3.11 — gridSearchPoints (bbox)', () => {
  test('bbox region → grid of points', () => {
    const region = { bbox: { north: 1, south: 0, east: 1, west: 0 } };
    const pts = gridSearchPoints(region, { stepKm: 111, query: 'restaurant' });
    expect(pts).toHaveLength(4); // 2×2 over a 1°×1° box at 1° step
    for (const p of pts) {
      expect(p.query.startsWith('restaurant@')).toBe(true);
    }
  });

  test('bbox region without explicit stepKm derives a sensible default', () => {
    const region = { bbox: { north: 1, south: 0, east: 1, west: 0 } };
    const pts = gridSearchPoints(region, { query: 'restaurant' });
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.length).toBeLessThan(MAX_GRID_POINTS);
  });
});

// ---------------------------------------------------------------------------
// 10. gridSearchPoints — polygon spec
// ---------------------------------------------------------------------------

describe('Phase 3.11 — gridSearchPoints (polygon)', () => {
  test('polygon region → only points inside the polygon', () => {
    // Right triangle with hypotenuse lat+lng=4; bbox is the 4×4 square.
    const triangle = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 4 },
      { lat: 4, lng: 0 },
    ];
    const region = { polygon: triangle };
    const pts = gridSearchPoints(region, { stepKm: 111, query: 'restaurant' });
    // Full bbox grid would be 5×5 = 25; the triangle filters out the
    // upper-right corner (lat+lng > 4) so the result is strictly fewer.
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.length).toBeLessThan(25);
    // Every returned point satisfies pointInPolygon (sanity).
    for (const p of pts) {
      expect(pointInPolygon({ lat: p.lat, lng: p.lng }, triangle)).toBe(true);
    }
    // A clearly-outside point (≈ (3, 3), lat+lng ≈ 6 > 4) must be excluded.
    const hasOutside = pts.some(
      (p) => approxEqual(p.lat, 3, 0.05) && approxEqual(p.lng, 3, 0.05)
    );
    expect(hasOutside).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 11. gridSearchPoints — emitted point shape
// ---------------------------------------------------------------------------

describe('Phase 3.11 — gridSearchPoints (point shape)', () => {
  test('every emitted point has lat, lng, query, label all defined', () => {
    const region = {
      center: { lat: 51.5074, lng: -0.1278 },
      radiusKm: 6,
    };
    const pts = gridSearchPoints(region, { stepKm: 2, query: 'pub' });
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) {
      expect(p).toEqual(expect.objectContaining({
        lat: expect.any(Number),
        lng: expect.any(Number),
        query: expect.any(String),
        label: expect.any(String),
      }));
      expect(p.query.length).toBeGreaterThan(0);
      expect(Number.isFinite(p.lat)).toBe(true);
      expect(Number.isFinite(p.lng)).toBe(true);
    }
  });

  test('invalid region → empty array (no throw)', () => {
    expect(gridSearchPoints(null, { query: 'x' })).toEqual([]);
    expect(gridSearchPoints({}, { query: 'x' })).toEqual([]);
    expect(gridSearchPoints({ type: 'unknown' }, { query: 'x' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 12. estimateCoverage
// ---------------------------------------------------------------------------

describe('Phase 3.11 — estimateCoverage', () => {
  test('dense grid → coverageRatio 1.0 (stepKm well below Google radius)', () => {
    // 1 km step → worst-case cell-corner distance = 1/√2 ≈ 0.71 km, well
    // inside GOOGLE_RESULT_RADIUS_KM (3 km) → full coverage.
    const dense = generateGrid(
      { north: 0.05, south: 0, east: 0.05, west: 0 },
      1
    );
    const cov = estimateCoverage(dense);
    expect(cov.totalPoints).toBe(dense.length);
    expect(cov.coverageRatio).toBe(1.0);
    expect(cov.areaKm2).toBeGreaterThan(0);
    expect(cov.estimatedListings).toBeGreaterThan(0);
  });

  test('sparse grid → coverageRatio < 1 (gaps exceed Google radius)', () => {
    // 111 km step → worst-case ≈ 78 km >> 3 km → ratio ≈ 0.038.
    const sparse = generateGrid(
      { north: 5, south: 0, east: 5, west: 0 },
      111
    );
    const cov = estimateCoverage(sparse);
    expect(cov.totalPoints).toBe(sparse.length);
    expect(cov.coverageRatio).toBeLessThan(1);
    expect(cov.coverageRatio).toBeGreaterThan(0);
    // Recovered stepKm ≈ 111 km → ratio ≈ 3 / (111/√2) ≈ 0.038
    expect(cov.coverageRatio).toBeCloseTo(3 / (111 / Math.SQRT2), 1);
  });

  test('empty input → all-zero result', () => {
    const cov = estimateCoverage([]);
    expect(cov).toEqual({
      totalPoints: 0,
      areaKm2: 0,
      estimatedListings: 0,
      coverageRatio: 0,
    });
  });

  test('single point → totalPoints 1, stepKm 0 → zeros for area/coverage', () => {
    const cov = estimateCoverage([{ lat: 0, lng: 0 }]);
    expect(cov.totalPoints).toBe(1);
    expect(cov.areaKm2).toBe(0);
    expect(cov.estimatedListings).toBe(0);
    expect(cov.coverageRatio).toBe(0);
  });

  test('estimatedListings = round(areaKm2 × density)', () => {
    const dense = generateGrid(
      { north: 0.05, south: 0, east: 0.05, west: 0 },
      1
    );
    const cov = estimateCoverage(dense, 10); // density = 10 / km²
    expect(cov.estimatedListings).toBe(Math.round(cov.areaKm2 * 10));
  });

  test('higher density scales estimatedListings proportionally', () => {
    const grid = generateGrid(
      { north: 0.05, south: 0, east: 0.05, west: 0 },
      1
    );
    const low = estimateCoverage(grid, 5);
    const high = estimateCoverage(grid, 20);
    expect(high.estimatedListings).toBeCloseTo(low.estimatedListings * 4, -1);
  });
});

// ---------------------------------------------------------------------------
// 13. ENRICHMENT_COLUMNS
// ---------------------------------------------------------------------------

describe('Phase 3.11 — ENRICHMENT_COLUMNS', () => {
  test('equals [] (grid coverage drives search input, not DB columns)', () => {
    expect(ENRICHMENT_COLUMNS).toEqual([]);
    expect(Array.isArray(ENRICHMENT_COLUMNS)).toBe(true);
    expect(ENRICHMENT_COLUMNS).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 14. Module constants
// ---------------------------------------------------------------------------

describe('Phase 3.11 — module constants', () => {
  test('exposes the documented Phase 3.11 constants', () => {
    expect(KM_PER_LAT_DEGREE).toBe(111.0);
    expect(GOOGLE_RESULT_RADIUS_KM).toBe(3);
    expect(MAX_GRID_POINTS).toBe(10000);
    expect(DEFAULT_URBAN_DENSITY).toBe(5);
    expect(DEFAULT_STEP_KM).toBe(3);
    expect(EARTH_RADIUS_KM).toBe(6371);
    expect(__version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 15. Turf DI seam (reserved — @turf/turf not used by current impl)
// ---------------------------------------------------------------------------

describe('Phase 3.11 — turf DI seam', () => {
  afterEach(() => {
    _setTurf(null); // reset module state so the lazy require re-runs
  });

  test('_setTurf injects a stub returned by _loadTurf; null resets it', () => {
    const stub = { booleanPointInPolygon: () => true, fake: true };
    _setTurf(stub);
    expect(_loadTurf()).toBe(stub);
    _setTurf(null);
    // After reset, _loadTurf re-runs the lazy require — returns whatever the
    // real @turf/turf exports (an object) or null if not installed. Either is
    // acceptable; the seam must simply not throw and not return the stub.
    const after = _loadTurf();
    expect(after).not.toBe(stub);
  });
});
