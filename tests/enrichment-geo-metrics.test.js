'use strict';

/**
 * tests/enrichment-geo-metrics.test.js — Phase 3.8 — Competitor Density (Geospatial) tests
 *
 * Coverage (per PHASE3_EXECUTION_PLAN.md §3.8 task checklist + acceptance):
 *   - haversineKm / haversineM: known distance, same-point, symmetric, missing
 *     coords, EARTH_RADIUS_KM constant
 *   - getCoord: geocoded (lat/lng) preference, raw (latitude/longitude)
 *     fallback, none, partial-coord fallback
 *   - toFiniteNumber: number, numeric string, null/NaN/Infinity/empty/garbage
 *   - normalizeCategory: lowercase + trim, null, no aliasing (Cafe → cafe)
 *   - identityKey: place_id preference, id fallback, empty, stability
 *   - isSameListing: same/different place_id, missing-key, id fallback
 *   - competitorDensity: count within radius, excludes self, respects radius,
 *     no-coords guard
 *   - competitorDensitySameCategory: only same-category counted, no-category guard
 *   - classifyIsolation: isolated/sparse/moderate/dense thresholds + null NN
 *   - classifyArea: urban/suburban/rural thresholds
 *   - coverageRadiusForCategory: known categories, unknown → default, constant
 *   - chainOf: chain_result.isChain, flat-field fallback, non-chain → null
 *   - computeGeoMetrics: synthetic 6-business Toronto cluster → nearest,
 *     within-bucket counts, sameCategoryWithin1km, nearestChain, isolation,
 *     areaType, coverageRadiusM, inCluster, flags; isolated business; no-geocode
 *   - computeGeoMetricsBatch: in-place mutation, stats shape, empty batch,
 *     single business
 *   - ENRICHMENT_COLUMNS + __version
 *
 * All tests are pure (no network, no DB). Deterministic + offline.
 *
 * Run: bun test tests/enrichment-geo-metrics.test.js
 */

const {
  __version,
  EARTH_RADIUS_KM,
  ENRICHMENT_COLUMNS,
  DEFAULT_COVERAGE_RADIUS_M,
  CATEGORY_COVERAGE,
  haversineKm,
  haversineM,
  getCoord,
  competitorDensity,
  competitorDensitySameCategory,
  computeGeoMetrics,
  computeGeoMetricsBatch,
  classifyIsolation,
  classifyArea,
  coverageRadiusForCategory,
  isSameListing,
  identityKey,
  normalizeCategory,
  chainOf,
  toFiniteNumber,
} = require('../src/enrichment/geo-metrics');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal business with sane defaults + overrides. */
function makeBusiness(overrides) {
  return {
    place_id: 'place-default',
    id: 'id-default',
    name: 'Default Business',
    category: null,
    lat: null,
    lng: null,
    latitude: null,
    longitude: null,
    chain_result: null,
    ...overrides,
  };
}

// Toronto reference point used across the cluster tests.
const TORONTO = { lat: 43.65, lng: -79.38 };

/**
 * Build the canonical 6-business Toronto cluster used by the computeGeoMetrics
 * tests. Layout (target T at 43.650,-79.380):
 *
 *   N1 (43.6510, -79.3800) "Coffee shop"      ~111 m N   (same cat, within 500m)
 *   N2 (43.6505, -79.3805) "Bakery",  chain    ~69  m NE  (diff cat, chain, within 500m)
 *   N3 (43.6520, -79.3810) "Coffee shop"      ~236 m NE  (same cat, within 500m)
 *   N4 (43.6490, -79.3780) "Restaurant"       ~196 m SW  (diff cat, within 500m)
 *   N5 (43.6400, -79.3700) "Coffee shop"      ~1372 m SW (same cat, within 5km only)
 *
 * Expected for T: within500m=4, within1km=4, within5km=5,
 * sameCategoryWithin1km=2 (N1+N3), nearest=N2 (~69m), nearestChain=N2,
 * isolation=moderate (within1km=4), areaType=rural (within5km=5 < 10),
 * coverageRadiusM=1500 (coffee), inCluster=true (within500m>=3).
 */
function makeTorontoCluster() {
  const target = makeBusiness({
    place_id: 'T',
    name: 'Target Cafe',
    category: 'Coffee shop',
    lat: TORONTO.lat,
    lng: TORONTO.lng,
  });
  const n1 = makeBusiness({
    place_id: 'N1',
    name: 'North Coffee',
    category: 'Coffee shop',
    lat: 43.651,
    lng: -79.38,
  });
  const n2 = makeBusiness({
    place_id: 'N2',
    name: 'Tim Hortons',
    category: 'Bakery',
    lat: 43.6505,
    lng: -79.3805,
    chain_result: { isChain: true, chainId: 'th', chainName: 'Tim Hortons' },
  });
  const n3 = makeBusiness({
    place_id: 'N3',
    name: 'Corner Coffee',
    category: 'Coffee shop',
    lat: 43.652,
    lng: -79.381,
  });
  const n4 = makeBusiness({
    place_id: 'N4',
    name: 'Downtown Diner',
    category: 'Restaurant',
    lat: 43.649,
    lng: -79.378,
  });
  const n5 = makeBusiness({
    place_id: 'N5',
    name: 'Far Coffee',
    category: 'Coffee shop',
    lat: 43.64,
    lng: -79.37,
  });
  return { target, neighbors: [n1, n2, n3, n4, n5], all: [target, n1, n2, n3, n4, n5] };
}

// ---------------------------------------------------------------------------
// Constants & module exports
// ---------------------------------------------------------------------------

describe('Phase 3.8 — constants & module exports', () => {
  test('EARTH_RADIUS_KM is 6371 (mean earth radius)', () => {
    expect(EARTH_RADIUS_KM).toBe(6371);
  });

  test('ENRICHMENT_COLUMNS is exactly the two persisted density columns', () => {
    expect(ENRICHMENT_COLUMNS).toEqual([
      'competitor_density_1km',
      'competitor_density_5km',
    ]);
  });

  test('DEFAULT_COVERAGE_RADIUS_M is 5000', () => {
    expect(DEFAULT_COVERAGE_RADIUS_M).toBe(5000);
  });

  test('__version is 1', () => {
    expect(__version).toBe(1);
  });

  test('CATEGORY_COVERAGE is a non-empty array of {re, radiusM}', () => {
    expect(Array.isArray(CATEGORY_COVERAGE)).toBe(true);
    expect(CATEGORY_COVERAGE.length).toBeGreaterThan(0);
    for (const entry of CATEGORY_COVERAGE) {
      expect(entry.re).toBeInstanceOf(RegExp);
      expect(typeof entry.radiusM).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// haversineKm / haversineM
// ---------------------------------------------------------------------------

describe('Phase 3.8 — haversineKm / haversineM', () => {
  test('same point → 0 km', () => {
    expect(haversineKm(TORONTO, TORONTO)).toBe(0);
  });

  test('0.5° latitude apart ≈ 55.6 km (within 0.5 km tolerance)', () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 0.5, lng: 0 };
    // 0.5° × ~111.19 km/° ≈ 55.6 km
    expect(haversineKm(a, b)).toBeGreaterThan(55);
    expect(haversineKm(a, b)).toBeLessThan(56);
  });

  test('symmetric: haversineKm(a,b) === haversineKm(b,a)', () => {
    const a = { lat: 43.65, lng: -79.38 };
    const b = { lat: 40.7128, lng: -74.006 };
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 6);
  });

  test('haversineM === haversineKm * 1000', () => {
    const a = { lat: 43.65, lng: -79.38 };
    const b = { lat: 43.66, lng: -79.39 };
    expect(haversineM(a, b)).toBeCloseTo(haversineKm(a, b) * 1000, 6);
  });

  test('missing coords on either side → 0', () => {
    expect(haversineKm(null, TORONTO)).toBe(0);
    expect(haversineKm(TORONTO, null)).toBe(0);
    expect(haversineKm({ lat: null, lng: null }, TORONTO)).toBe(0);
    expect(haversineM({ lat: 'abc', lng: 1 }, TORONTO)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getCoord
// ---------------------------------------------------------------------------

describe('Phase 3.8 — getCoord', () => {
  test('prefers geocoded lat/lng (source="geocoded")', () => {
    const b = makeBusiness({
      lat: 43.65,
      lng: -79.38,
      latitude: 40.0,
      longitude: -74.0,
    });
    const c = getCoord(b);
    expect(c.lat).toBe(43.65);
    expect(c.lng).toBe(-79.38);
    expect(c.source).toBe('geocoded');
  });

  test('falls back to raw latitude/longitude when lat/lng absent (source="raw")', () => {
    const b = makeBusiness({ latitude: 40.7128, longitude: -74.006 });
    const c = getCoord(b);
    expect(c.lat).toBeCloseTo(40.7128, 6);
    expect(c.lng).toBeCloseTo(-74.006, 6);
    expect(c.source).toBe('raw');
  });

  test('no coords at all → source="none" with null lat/lng', () => {
    const c = getCoord(makeBusiness());
    expect(c.lat).toBeNull();
    expect(c.lng).toBeNull();
    expect(c.source).toBe('none');
  });

  test('partial geocoded (lat but no lng) falls back to raw', () => {
    const b = makeBusiness({ lat: 43.65, lng: null, latitude: 40.0, longitude: -74.0 });
    const c = getCoord(b);
    expect(c.source).toBe('raw');
    expect(c.lat).toBe(40.0);
    expect(c.lng).toBe(-74.0);
  });

  test('null business → source="none"', () => {
    const c = getCoord(null);
    expect(c.source).toBe('none');
    expect(c.lat).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toFiniteNumber
// ---------------------------------------------------------------------------

describe('Phase 3.8 — toFiniteNumber', () => {
  test('number passthrough', () => {
    expect(toFiniteNumber(42)).toBe(42);
    expect(toFiniteNumber(-3.5)).toBe(-3.5);
    expect(toFiniteNumber(0)).toBe(0);
  });

  test('numeric string coerced', () => {
    expect(toFiniteNumber('40.7128000')).toBeCloseTo(40.7128, 6);
    expect(toFiniteNumber('100')).toBe(100);
  });

  test('null / undefined → null', () => {
    expect(toFiniteNumber(null)).toBeNull();
    expect(toFiniteNumber(undefined)).toBeNull();
  });

  test('NaN / Infinity → null', () => {
    expect(toFiniteNumber(NaN)).toBeNull();
    expect(toFiniteNumber(Infinity)).toBeNull();
    expect(toFiniteNumber(-Infinity)).toBeNull();
  });

  test('non-numeric string → null; empty string coerces to 0 (Number("") quirk)', () => {
    // NOTE: Number('') === 0, so toFiniteNumber('') returns 0, NOT null. This
    // mirrors the module's documented behaviour (pg NUMERIC strings + numbers;
    // empty string is an edge case that falls through to the Number() coercion).
    expect(toFiniteNumber('')).toBe(0);
    expect(toFiniteNumber('abc')).toBeNull();
    expect(toFiniteNumber('not a number')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeCategory
// ---------------------------------------------------------------------------

describe('Phase 3.8 — normalizeCategory', () => {
  test('lowercases + trims', () => {
    expect(normalizeCategory('  Coffee Shop  ')).toBe('coffee shop');
    expect(normalizeCategory('PLUMBING')).toBe('plumbing');
  });

  test('"Cafe" → "cafe" (lowercase only, NO accent aliasing)', () => {
    // The module does not alias "cafe" to "café" — it only lowercases + trims.
    expect(normalizeCategory('Cafe')).toBe('cafe');
    expect(normalizeCategory('Café')).toBe('café');
  });

  test('null / undefined → empty string', () => {
    expect(normalizeCategory(null)).toBe('');
    expect(normalizeCategory(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// identityKey / isSameListing
// ---------------------------------------------------------------------------

describe('Phase 3.8 — identityKey', () => {
  test('prefers place_id', () => {
    expect(identityKey(makeBusiness({ place_id: 'p1', id: 'i1' }))).toBe('p1');
  });

  test('falls back to id when place_id missing', () => {
    expect(identityKey(makeBusiness({ place_id: null, id: 'i1' }))).toBe('i1');
  });

  test('neither place_id nor id → empty string', () => {
    expect(identityKey(makeBusiness({ place_id: null, id: null }))).toBe('');
    expect(identityKey(null)).toBe('');
  });

  test('stable: same business record → same key', () => {
    const b = makeBusiness({ place_id: 'abc' });
    expect(identityKey(b)).toBe(identityKey(b));
  });
});

describe('Phase 3.8 — isSameListing', () => {
  test('same place_id → true', () => {
    const a = makeBusiness({ place_id: 'p1' });
    const b = makeBusiness({ place_id: 'p1' });
    expect(isSameListing(a, b)).toBe(true);
  });

  test('different place_id → false', () => {
    expect(isSameListing(makeBusiness({ place_id: 'p1' }), makeBusiness({ place_id: 'p2' }))).toBe(
      false
    );
  });

  test('one side missing key → false (treated as distinct)', () => {
    expect(
      isSameListing(makeBusiness({ place_id: 'p1' }), makeBusiness({ place_id: null, id: null }))
    ).toBe(false);
  });

  test('id fallback: same id, no place_id → true', () => {
    expect(
      isSameListing(
        makeBusiness({ place_id: null, id: 'i9' }),
        makeBusiness({ place_id: null, id: 'i9' })
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// competitorDensity / competitorDensitySameCategory
// ---------------------------------------------------------------------------

describe('Phase 3.8 — competitorDensity', () => {
  test('counts OTHER businesses within radius (3 within 1km → 3)', () => {
    const { target, all } = makeTorontoCluster();
    // N1, N2, N3, N4 are within 1km of target (4 actually). Use radius=1.
    expect(competitorDensity(target, all, 1)).toBe(4);
  });

  test('none nearby → 0', () => {
    const target = makeBusiness({ place_id: 'solo', lat: 0, lng: 0 });
    const far = makeBusiness({ place_id: 'far', lat: 10, lng: 10 });
    expect(competitorDensity(target, [target, far], 1)).toBe(0);
  });

  test('excludes self (same place_id)', () => {
    const target = makeBusiness({ place_id: 't', lat: 0, lng: 0 });
    // A second record with the SAME place_id must NOT be counted.
    const dup = makeBusiness({ place_id: 't', lat: 0, lng: 0 });
    expect(competitorDensity(target, [target, dup], 1)).toBe(0);
  });

  test('respects radius (0.5km excludes the 1km+ neighbour)', () => {
    const { target, all } = makeTorontoCluster();
    // All 4 close neighbours are within 500m, so radius 0.5 → 4.
    expect(competitorDensity(target, all, 0.5)).toBe(4);
    // radius 0.1 km (100m) — only N2 (~69m) qualifies.
    expect(competitorDensity(target, all, 0.1)).toBe(1);
  });

  test('no usable coords → 0', () => {
    const target = makeBusiness({ place_id: 't', lat: null, lng: null });
    const near = makeBusiness({ place_id: 'n', lat: 0, lng: 0 });
    expect(competitorDensity(target, [target, near], 1)).toBe(0);
  });
});

describe('Phase 3.8 — competitorDensitySameCategory', () => {
  test('only counts same-category competitors within radius', () => {
    const { target, all } = makeTorontoCluster();
    // Target is "Coffee shop"; N1 + N3 are same-category within 1km → 2.
    expect(competitorDensitySameCategory(target, all, 1)).toBe(2);
  });

  test('no category on target → 0', () => {
    const target = makeBusiness({ place_id: 't', lat: 0, lng: 0, category: null });
    const same = makeBusiness({ place_id: 'n', lat: 0, lng: 0, category: 'Coffee shop' });
    expect(competitorDensitySameCategory(target, [target, same], 1)).toBe(0);
  });

  test('different category → 0', () => {
    const target = makeBusiness({ place_id: 't', lat: 0, lng: 0, category: 'Plumber' });
    const other = makeBusiness({ place_id: 'n', lat: 0, lng: 0, category: 'Bakery' });
    expect(competitorDensitySameCategory(target, [target, other], 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyIsolation / classifyArea
// ---------------------------------------------------------------------------

describe('Phase 3.8 — classifyIsolation', () => {
  test('nearestNeighborM == null → isolated (single-listing batch)', () => {
    expect(classifyIsolation(null, 0)).toBe('isolated');
  });

  test('within1km == 0 → isolated', () => {
    expect(classifyIsolation(5000, 0)).toBe('isolated');
  });

  test('within1km 1..3 → sparse', () => {
    expect(classifyIsolation(200, 1)).toBe('sparse');
    expect(classifyIsolation(200, 3)).toBe('sparse');
  });

  test('within1km 4..9 → moderate', () => {
    expect(classifyIsolation(120, 4)).toBe('moderate');
    expect(classifyIsolation(120, 9)).toBe('moderate');
  });

  test('within1km >= 10 → dense', () => {
    expect(classifyIsolation(50, 10)).toBe('dense');
    expect(classifyIsolation(30, 999)).toBe('dense');
  });
});

describe('Phase 3.8 — classifyArea', () => {
  test('within5km >= 50 → urban', () => {
    expect(classifyArea(50)).toBe('urban');
    expect(classifyArea(500)).toBe('urban');
  });

  test('within5km 10..49 → suburban', () => {
    expect(classifyArea(10)).toBe('suburban');
    expect(classifyArea(49)).toBe('suburban');
  });

  test('within5km < 10 → rural', () => {
    expect(classifyArea(0)).toBe('rural');
    expect(classifyArea(9)).toBe('rural');
  });
});

// ---------------------------------------------------------------------------
// coverageRadiusForCategory
// ---------------------------------------------------------------------------

describe('Phase 3.8 — coverageRadiusForCategory', () => {
  test('service businesses (towing/locksmith/plumb/solar/...) → 25000', () => {
    expect(coverageRadiusForCategory('Towing service')).toBe(25000);
    expect(coverageRadiusForCategory('Locksmith')).toBe(25000);
    expect(coverageRadiusForCategory('Solar panel installer')).toBe(25000);
  });

  test('foot-traffic (coffee/cafe/restaurant/...) → 1500', () => {
    expect(coverageRadiusForCategory('Coffee shop')).toBe(1500);
    expect(coverageRadiusForCategory('cafe')).toBe(1500);
    expect(coverageRadiusForCategory('Pizza restaurant')).toBe(1500);
  });

  test('medical (dentist/vet/clinic) → 6000; professional (lawyer) → 12000', () => {
    expect(coverageRadiusForCategory('Dentist office')).toBe(6000);
    expect(coverageRadiusForCategory('Lawyer')).toBe(12000);
  });

  test('unknown / null category → DEFAULT_COVERAGE_RADIUS_M (5000)', () => {
    expect(coverageRadiusForCategory('Something exotic')).toBe(DEFAULT_COVERAGE_RADIUS_M);
    expect(coverageRadiusForCategory(null)).toBe(DEFAULT_COVERAGE_RADIUS_M);
    expect(coverageRadiusForCategory('')).toBe(DEFAULT_COVERAGE_RADIUS_M);
  });
});

// ---------------------------------------------------------------------------
// chainOf
// ---------------------------------------------------------------------------

describe('Phase 3.8 — chainOf', () => {
  test('chain_result.isChain true → returns {chainId, chainName}', () => {
    const b = makeBusiness({
      chain_result: { isChain: true, chainId: 'th', chainName: 'Tim Hortons' },
    });
    const c = chainOf(b);
    expect(c).not.toBeNull();
    expect(c.chainId).toBe('th');
    expect(c.chainName).toBe('Tim Hortons');
  });

  test('chain_result.isChain false → null', () => {
    const b = makeBusiness({
      chain_result: { isChain: false, chainId: 'th', chainName: 'Tim Hortons' },
    });
    expect(chainOf(b)).toBeNull();
  });

  test('no chain_result → null', () => {
    expect(chainOf(makeBusiness())).toBeNull();
    expect(chainOf(null)).toBeNull();
  });

  test('flat-field fallback (chainId + chainName, no chain_result)', () => {
    const b = makeBusiness({ chainId: 'sb', chainName: 'Starbucks' });
    const c = chainOf(b);
    expect(c).not.toBeNull();
    expect(c.chainId).toBe('sb');
    expect(c.chainName).toBe('Starbucks');
  });

  test('flat-field with only chainId (no chainName) → null', () => {
    const b = makeBusiness({ chainId: 'sb', chainName: null });
    expect(chainOf(b)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeGeoMetrics (core)
// ---------------------------------------------------------------------------

describe('Phase 3.8 — computeGeoMetrics on Toronto cluster', () => {
  const { target, all } = makeTorontoCluster();
  const result = computeGeoMetrics(target, all);

  test('returns a full descriptor with the expected keys', () => {
    expect(result).toEqual(
      expect.objectContaining({
        lat: expect.any(Number),
        lng: expect.any(Number),
        coordSource: 'geocoded',
        nearestNeighborM: expect.any(Number),
        nearestNeighbor: expect.objectContaining({
          id: expect.any(String),
          name: expect.any(String),
          category: expect.any(String),
          distanceM: expect.any(Number),
        }),
        within500m: expect.any(Number),
        within1km: expect.any(Number),
        within5km: expect.any(Number),
        sameCategoryWithin1km: expect.any(Number),
        nearestChainM: expect.any(Number),
        nearestChain: expect.any(Object),
        isolation: expect.any(String),
        areaType: expect.any(String),
        coverageRadiusM: expect.any(Number),
        inCluster: expect.any(Boolean),
        flags: expect.any(Array),
      })
    );
  });

  test('within500m / within1km = 4, within5km = 5', () => {
    expect(result.within500m).toBe(4);
    expect(result.within1km).toBe(4);
    expect(result.within5km).toBe(5);
  });

  test('nearest neighbour is N2 (Tim Hortons) at ~69 m', () => {
    expect(result.nearestNeighbor.id).toBe('N2');
    expect(result.nearestNeighborM).toBeGreaterThan(60);
    expect(result.nearestNeighborM).toBeLessThan(80);
  });

  test('sameCategoryWithin1km = 2 (N1 + N3, both "Coffee shop" within 1km)', () => {
    expect(result.sameCategoryWithin1km).toBe(2);
  });

  test('nearestChain is Tim Hortons (chain) at ~69 m', () => {
    expect(result.nearestChain).not.toBeNull();
    expect(result.nearestChain.chainId).toBe('th');
    expect(result.nearestChain.chainName).toBe('Tim Hortons');
    expect(result.nearestChainM).toBeGreaterThan(60);
    expect(result.nearestChainM).toBeLessThan(80);
  });

  test('isolation = moderate (within1km=4 falls in 4..9 band)', () => {
    expect(result.isolation).toBe('moderate');
  });

  test('areaType = rural (within5km=5 < 10)', () => {
    expect(result.areaType).toBe('rural');
  });

  test('coverageRadiusM = 1500 (Coffee shop → coffee/cafe band)', () => {
    expect(result.coverageRadiusM).toBe(1500);
  });

  test('inCluster = true (within500m >= 3)', () => {
    expect(result.inCluster).toBe(true);
  });

  test('flags include high_competition_zone, chain_proximity, cluster_member', () => {
    const codes = result.flags.map((f) => f.code);
    expect(codes).toContain('high_competition_zone');
    expect(codes).toContain('chain_proximity');
    expect(codes).toContain('cluster_member');
  });

  test('flags do NOT include isolated_location / sparse_area / no_geocode', () => {
    const codes = result.flags.map((f) => f.code);
    expect(codes).not.toContain('isolated_location');
    expect(codes).not.toContain('sparse_area');
    expect(codes).not.toContain('no_geocode');
  });

  test('each flag has {code,label,detail,severity}', () => {
    for (const f of result.flags) {
      expect(typeof f.code).toBe('string');
      expect(typeof f.label).toBe('string');
      expect(typeof f.detail).toBe('string');
      expect(typeof f.severity).toBe('string');
    }
  });
});

describe('Phase 3.8 — computeGeoMetrics isolated business', () => {
  test('no neighbours within 5km → isolation "isolated", within5km 0', () => {
    const target = makeBusiness({ place_id: 'solo', name: 'Solo', lat: 0, lng: 0 });
    const far = makeBusiness({
      place_id: 'far',
      name: 'Far',
      lat: 10,
      lng: 10,
      category: 'Coffee shop',
    });
    const result = computeGeoMetrics(target, [target, far]);
    expect(result.nearestNeighborM).not.toBeNull();
    expect(result.nearestNeighborM).toBeGreaterThan(1000000); // > 1000 km
    expect(result.within500m).toBe(0);
    expect(result.within1km).toBe(0);
    expect(result.within5km).toBe(0);
    expect(result.isolation).toBe('isolated');
    expect(result.areaType).toBe('rural');
    expect(result.inCluster).toBe(false);
    const codes = result.flags.map((f) => f.code);
    expect(codes).toContain('isolated_location');
    expect(codes).not.toContain('cluster_member');
  });

  test('truly single-listing batch → nearestNeighborM null, isolated', () => {
    const target = makeBusiness({ place_id: 'solo', lat: 0, lng: 0 });
    const result = computeGeoMetrics(target, [target]);
    expect(result.nearestNeighborM).toBeNull();
    expect(result.nearestNeighbor).toBeNull();
    expect(result.isolation).toBe('isolated');
    expect(result.within5km).toBe(0);
  });
});

describe('Phase 3.8 — computeGeoMetrics no-geocode guard', () => {
  test('business with no coords → no_geocode flag, zeroed counts, isolated/rural', () => {
    const target = makeBusiness({ place_id: 'nogeo', lat: null, lng: null, category: 'Cafe' });
    const near = makeBusiness({ place_id: 'near', lat: 0, lng: 0 });
    const result = computeGeoMetrics(target, [target, near]);
    expect(result.coordSource).toBe('none');
    expect(result.lat).toBeNull();
    expect(result.lng).toBeNull();
    expect(result.within1km).toBe(0);
    expect(result.within5km).toBe(0);
    expect(result.isolation).toBe('isolated');
    expect(result.areaType).toBe('rural');
    expect(result.inCluster).toBe(false);
    // coverageRadiusM is still derived from category even without coords.
    expect(result.coverageRadiusM).toBe(1500);
    const codes = result.flags.map((f) => f.code);
    expect(codes).toContain('no_geocode');
  });
});

// ---------------------------------------------------------------------------
// computeGeoMetricsBatch
// ---------------------------------------------------------------------------

describe('Phase 3.8 — computeGeoMetricsBatch', () => {
  test('mutates every business with geo_result + density columns', () => {
    const { all } = makeTorontoCluster();
    const stats = computeGeoMetricsBatch(all);
    expect(stats.total).toBe(6);
    for (const b of all) {
      expect(b).toHaveProperty('geo_result');
      expect(b).toHaveProperty('competitor_density_1km');
      expect(b).toHaveProperty('competitor_density_5km');
      expect(typeof b.competitor_density_1km).toBe('number');
      expect(typeof b.competitor_density_5km).toBe('number');
      // The persisted density columns must mirror the descriptor's within-bucket
      // counts — this is the batch wrapper's core contract.
      expect(b.competitor_density_1km).toBe(b.geo_result.within1km);
      expect(b.competitor_density_5km).toBe(b.geo_result.within5km);
      // And the descriptor matches a fresh single-business computation.
      expect(b.geo_result).toEqual(computeGeoMetrics(b, all));
    }
    // Target specifically: 4 within 1km, 5 within 5km.
    const target = all[0];
    expect(target.competitor_density_1km).toBe(4);
    expect(target.competitor_density_5km).toBe(5);
  });

  test('returns the documented stats shape', () => {
    const { all } = makeTorontoCluster();
    const stats = computeGeoMetricsBatch(all);
    expect(stats).toEqual(
      expect.objectContaining({
        total: 6,
        withCoords: expect.any(Number),
        avgNearestNeighborM: expect.any(Number),
        isolatedListings: expect.any(Number),
        highCompetitionListings: expect.any(Number),
        urban: expect.any(Number),
        suburban: expect.any(Number),
        rural: expect.any(Number),
        avgDensity1km: expect.any(Number),
      })
    );
    // All 6 sit in a tight cluster — each sees <10 within 5km → all rural.
    expect(stats.urban).toBe(0);
    expect(stats.suburban).toBe(0);
    expect(stats.rural).toBe(6);
    expect(stats.withCoords).toBe(6);
    // N5 sits ~1.2–1.4 km from every other listing → 0 within 1km → isolated.
    // The other 5 each have neighbours within 1km, so only N5 is isolated.
    expect(stats.isolatedListings).toBe(1);
  });

  test('empty batch → zeroed stats, avgNearestNeighborM null', () => {
    const stats = computeGeoMetricsBatch([]);
    expect(stats.total).toBe(0);
    expect(stats.withCoords).toBe(0);
    expect(stats.avgNearestNeighborM).toBeNull();
    expect(stats.avgDensity1km).toBe(0);
    expect(stats.urban).toBe(0);
    expect(stats.suburban).toBe(0);
    expect(stats.rural).toBe(0);
  });

  test('non-array input → zeroed stats (defensive)', () => {
    const stats = computeGeoMetricsBatch(null);
    expect(stats.total).toBe(0);
    expect(stats.rural).toBe(0);
  });

  test('single business (no neighbours) → isolated, rural, density 0', () => {
    const list = [makeBusiness({ place_id: 'solo', lat: 0, lng: 0, category: 'Cafe' })];
    const stats = computeGeoMetricsBatch(list);
    expect(stats.total).toBe(1);
    expect(stats.withCoords).toBe(1);
    expect(stats.isolatedListings).toBe(1);
    expect(stats.rural).toBe(1);
    expect(stats.avgDensity1km).toBe(0);
    expect(list[0].competitor_density_1km).toBe(0);
    expect(list[0].competitor_density_5km).toBe(0);
    expect(list[0].geo_result.isolation).toBe('isolated');
  });

  test('logger.debug is invoked when a logger is supplied', () => {
    const lines = [];
    const logger = { debug: (msg) => lines.push(msg) };
    const { all } = makeTorontoCluster();
    computeGeoMetricsBatch(all, { logger });
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('[3.8] geo-metrics');
  });
});

