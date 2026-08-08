'use strict';

/**
 * tests/enrichment-chain-detection.test.js — Phase 3.4 — Chain Detection & Spam/Fake Listing tests
 *
 * Coverage (per PHASE3_EXECUTION_PLAN.md §3.4 task checklist + acceptance):
 *   - normalizeName: lowercase, apostrophe/punctuation stripping, whitespace collapse
 *   - detectChain: known chains (McDonald's, Starbucks, Subway), non-chain local,
 *     alias matching (Golden Arches), case-insensitivity, suffix-tolerant match
 *   - haversineMeters: same-point=0, symmetric, known 0.5°-lat distance
 *   - isGeographicallyCohesive: tight cluster, far-flung set, single/empty
 *   - detectSpam: each of the 11 heuristics (trigger + clean case)
 *   - detectSpam score boundaries: clean(0)/low/medium/high/critical via scoreToLevel
 *   - buildPhoneReuseMap: grouping, singleton stripping, missing phones, empty
 *   - detectChainBatch: attaches chain_result, stats shape, empty/non-array
 *   - detectSpamBatch: attaches spam_result, builds phone-reuse ctx, stats shape
 *   - groupChainListings: groups by chainId, skips non-chains
 *   - ENRICHMENT_COLUMNS is [] (debug descriptors only — not persisted)
 *
 * The module is pure (no network, no DB). All tests are deterministic and offline.
 *
 * Run: bun test tests/enrichment-chain-detection.test.js
 */

const {
  __version,
  ENRICHMENT_COLUMNS,
  detectChain,
  detectSpam,
  buildPhoneReuseMap,
  groupChainListings,
  detectChainBatch,
  detectSpamBatch,
  normalizeName,
  isGeographicallyCohesive,
  haversineMeters,
  normalizeStreetCity,
  CHAIN_CATALOGUE,
  SPAM_NAME_KEYWORDS,
  SPAM_TLDS,
  AREA_CODE_TO_STATE,
} = require('../src/enrichment/chain-detection');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasFlag(result, code) {
  return result && Array.isArray(result.flags) && result.flags.some((f) => f.code === code);
}

function flagOf(result, code) {
  return result && Array.isArray(result.flags) ? result.flags.find((f) => f.code === code) : null;
}

// Phone-reuse context helper: builds a Map around a single shared number with
// the supplied listing coordinates. Used by the PHONE_REUSE / NETWORK_PATTERN
// heuristics which consult ctx.phoneReuseMap.
function reuseCtx(listings) {
  const map = new Map();
  map.set('+12125551234', listings);
  return { phoneReuseMap: map };
}

// ---------------------------------------------------------------------------
// 1. normalizeName
// ---------------------------------------------------------------------------

describe('Phase 3.4 — normalizeName', () => {
  test('lowercases input', () => {
    expect(normalizeName('MCDONALDS')).toBe('mcdonalds');
    expect(normalizeName('STARBUCKS Coffee')).toBe('starbucks coffee');
  });

  test("strips straight apostrophe and backtick — McDonald's → mcdonalds", () => {
    // The strip set is U+0027 (straight ') and U+0060 (backtick). A curly
    // apostrophe U+2019 is NOT in the set, so it falls through to the
    // non-alphanumeric → space rule ("McDonald\u2019s" → "mcdonald s").
    expect(normalizeName("McDonald's")).toBe('mcdonalds');
    expect(normalizeName('Wendy`S')).toBe('wendys'); // backtick
    expect(normalizeName('McDonald\u2019s')).toBe('mcdonald s'); // curly ' → space
  });

  test('replaces non-alphanumeric punctuation with space (7-Eleven → 7 eleven)', () => {
    expect(normalizeName('7-Eleven')).toBe('7 eleven');
    expect(normalizeName('A.B. Corp')).toBe('a b corp');
    expect(normalizeName('Cafe #1')).toBe('cafe 1');
    expect(normalizeName('Wal-Mart')).toBe('wal mart');
  });

  test('collapses whitespace and trims', () => {
    expect(normalizeName('  McDonald   s  ')).toBe('mcdonald s');
    expect(normalizeName('\tHello\nWorld\t')).toBe('hello world');
  });

  test('null / undefined / empty → empty string', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 2. detectChain
// ---------------------------------------------------------------------------

describe('Phase 3.4 — detectChain', () => {
  test("McDonald's → mcdonalds chain, confidence 1.0", () => {
    const r = detectChain({ name: "McDonald's" });
    expect(r.isChain).toBe(true);
    expect(r.chainId).toBe('mcdonalds');
    expect(r.chainName).toBe("McDonald's");
    expect(r.confidence).toBe(1.0);
    expect(r.matchedToken).toBe('mcdonalds');
  });

  test('Starbucks (case-insensitive) → starbucks, confidence 1.0', () => {
    const r = detectChain({ name: 'STARBUCKS' });
    expect(r.isChain).toBe(true);
    expect(r.chainId).toBe('starbucks');
    expect(r.chainName).toBe('Starbucks');
    expect(r.confidence).toBe(1.0);
  });

  test('Subway → subway', () => {
    const r = detectChain({ name: 'Subway' });
    expect(r.isChain).toBe(true);
    expect(r.chainId).toBe('subway');
  });

  test('non-chain local business → isChain false', () => {
    const r = detectChain({ name: "Joe's Diner" });
    expect(r.isChain).toBe(false);
    expect(r.chainName).toBe(null);
    expect(r.chainId).toBe(null);
    expect(r.confidence).toBe(0);
    expect(r.matchedToken).toBe(null);
  });

  test('alias "Golden Arches" → mcdonalds, confidence 0.9', () => {
    const r = detectChain({ name: 'Golden Arches' });
    expect(r.isChain).toBe(true);
    expect(r.chainId).toBe('mcdonalds');
    expect(r.confidence).toBe(0.9);
    expect(r.matchedToken).toBe('golden arches');
  });

  test('suffix-tolerant: "McDonald\'s LLC" still resolves to mcdonalds', () => {
    // normalizeName does not strip "LLC", but the "mcdonalds" token still
    // word-boundary-matches inside "mcdonalds llc" → confidence 1.0.
    const r = detectChain({ name: "McDonald's LLC" });
    expect(r.isChain).toBe(true);
    expect(r.chainId).toBe('mcdonalds');
    expect(r.confidence).toBe(1.0);
  });

  test('"McDonald\'s of Times Square" → mcdonalds (token inside a sentence)', () => {
    const r = detectChain({ name: "McDonald's of Times Square" });
    expect(r.isChain).toBe(true);
    expect(r.chainId).toBe('mcdonalds');
  });
});

// ---------------------------------------------------------------------------
// 3. haversineMeters
// ---------------------------------------------------------------------------

describe('Phase 3.4 — haversineMeters', () => {
  test('same point = 0', () => {
    expect(haversineMeters(40.7, -74.0, 40.7, -74.0)).toBe(0);
  });

  test('symmetric: haversine(a,b) === haversine(b,a)', () => {
    const d1 = haversineMeters(40.7128, -74.006, 34.0522, -118.2437);
    const d2 = haversineMeters(34.0522, -118.2437, 40.7128, -74.006);
    expect(d1).toBeCloseTo(d2, 6);
  });

  test('0.5° latitude ≈ 55.6 km (within tolerance)', () => {
    const d = haversineMeters(0, 0, 0.5, 0);
    // 0.5° × π/180 × 6371000m ≈ 55597.5m
    expect(d).toBeGreaterThan(55500);
    expect(d).toBeLessThan(55700);
  });
});

// ---------------------------------------------------------------------------
// 4. isGeographicallyCohesive
// ---------------------------------------------------------------------------

describe('Phase 3.4 — isGeographicallyCohesive', () => {
  test('tight cluster (all within 150m) → true', () => {
    const listings = [
      { lat: 40.7128, lng: -74.006, street: '123 Main St', city: 'New York' },
      { lat: 40.7129, lng: -74.0061, street: '123 Main St', city: 'New York' },
    ];
    expect(isGeographicallyCohesive(listings)).toBe(true);
  });

  test('far-flung set → false', () => {
    const listings = [
      { lat: 40.7128, lng: -74.006, street: '123 Main St', city: 'New York' },
      { lat: 34.0522, lng: -118.2437, street: '456 Oak Ave', city: 'Los Angeles' },
    ];
    expect(isGeographicallyCohesive(listings)).toBe(false);
  });

  test('single / empty / null → true (trivially cohesive)', () => {
    expect(isGeographicallyCohesive([])).toBe(true);
    expect(isGeographicallyCohesive(null)).toBe(true);
    expect(isGeographicallyCohesive([{ lat: 40.7, lng: -74, street: 'x', city: 'y' }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. detectSpam — individual heuristics (trigger + clean case each)
// ---------------------------------------------------------------------------

describe('Phase 3.4 — detectSpam heuristics', () => {
  test('keyword stuffing: spam-bait name triggers, clean name does not', () => {
    const spammy = detectSpam({ name: 'BEST CHEAP 24/7 PLUMBER' });
    expect(hasFlag(spammy, 'KEYWORD_STUFFING')).toBe(true);
    const clean = detectSpam({ name: "Bob's Plumbing" });
    expect(hasFlag(clean, 'KEYWORD_STUFFING')).toBe(false);
  });

  test('AAA prefix: "AAA Plumbing" triggers, "Bob\'s Plumbing" does not', () => {
    const spammy = detectSpam({ name: 'AAA Plumbing' });
    expect(hasFlag(spammy, 'AAA_PREFIX')).toBe(true);
    const clean = detectSpam({ name: "Bob's Plumbing" });
    expect(hasFlag(clean, 'AAA_PREFIX')).toBe(false);
  });

  test('PO box address triggers, physical address does not', () => {
    const spammy = detectSpam({ name: 'Clean Co', address: 'PO Box 123, NYC' });
    expect(hasFlag(spammy, 'PO_BOX_ADDRESS')).toBe(true);
    const clean = detectSpam({ name: 'Clean Co', address: '123 Main St, NYC' });
    expect(hasFlag(clean, 'PO_BOX_ADDRESS')).toBe(false);
  });

  test('phone-area mismatch: NYC number on CA address triggers, on NY address does not', () => {
    const base = {
      name: 'Clean Co',
      phone_country_code: 'US',
      phone_type: 'mobile',
      phone_normalized: { nationalNumber: '2125551234' },
    };
    const spammy = detectSpam({ ...base, address_state: 'CA' });
    expect(hasFlag(spammy, 'PHONE_AREA_MISMATCH')).toBe(true);
    const clean = detectSpam({ ...base, address_state: 'NY' });
    expect(hasFlag(clean, 'PHONE_AREA_MISMATCH')).toBe(false);
  });

  test('phone reuse: non-cohesive network → high; cohesive cluster → info', () => {
    // Two listings on the same phone at DIFFERENT locations → spam network.
    const net = reuseCtx([
      { id: 'p1', lat: 40.7128, lng: -74.006, street: '123 Main St', city: 'New York' },
      { id: 'p2', lat: 34.0522, lng: -118.2437, street: '456 Oak Ave', city: 'Los Angeles' },
    ]);
    const spammy = detectSpam({ place_id: 'p1', name: 'Clean Co', phone_e164: '+12125551234' }, net);
    expect(hasFlag(spammy, 'PHONE_REUSE')).toBe(true);
    expect(flagOf(spammy, 'PHONE_REUSE').severity).toBe('high');

    // Two listings on the same phone at the SAME location → duplicates, not spam.
    const coh = reuseCtx([
      { id: 'p1', lat: 40.7128, lng: -74.006, street: '123 Main St', city: 'New York' },
      { id: 'p2', lat: 40.7129, lng: -74.0061, street: '123 Main St', city: 'New York' },
    ]);
    const clean = detectSpam({ place_id: 'p1', name: 'Clean Co', phone_e164: '+12125551234' }, coh);
    expect(hasFlag(clean, 'PHONE_REUSE')).toBe(true);
    expect(flagOf(clean, 'PHONE_REUSE').severity).toBe('info');
  });

  test('suspicious rating: 5.0 with 2 reviews triggers, 4.5 with 100 does not', () => {
    const spammy = detectSpam({ name: 'Clean Co', rating: 5.0, reviews_count: 2 });
    expect(hasFlag(spammy, 'SUSPICIOUS_RATING')).toBe(true);
    const clean = detectSpam({ name: 'Clean Co', rating: 4.5, reviews_count: 100 });
    expect(hasFlag(clean, 'SUSPICIOUS_RATING')).toBe(false);
  });

  test('generic name "Professional Services" triggers, real name does not', () => {
    const spammy = detectSpam({ name: 'Professional Services LLC' });
    expect(hasFlag(spammy, 'GENERIC_NAME')).toBe(true);
    const clean = detectSpam({ name: "Bob's Plumbing" });
    expect(hasFlag(clean, 'GENERIC_NAME')).toBe(false);
  });

  test('suspicious TLD (.xyz) triggers, .com does not', () => {
    const spammy = detectSpam({ name: 'Clean Co', website: 'http://spam.xyz' });
    expect(hasFlag(spammy, 'SUSPICIOUS_TLD')).toBe(true);
    const clean = detectSpam({ name: 'Clean Co', website: 'http://example.com' });
    expect(hasFlag(clean, 'SUSPICIOUS_TLD')).toBe(false);
  });

  test('no-website for a service category (Plumber) triggers, restaurant does not', () => {
    const spammy = detectSpam({ name: 'Clean Co', category: 'Plumber' });
    expect(hasFlag(spammy, 'NO_WEBSITE_SERVICE')).toBe(true);
    const clean = detectSpam({ name: 'Clean Co', category: 'Restaurant' });
    expect(hasFlag(clean, 'NO_WEBSITE_SERVICE')).toBe(false);
  });

  test('category mismatch: Plumber + toll_free + no website triggers, mobile + website does not', () => {
    const spammy = detectSpam({ name: 'Clean Co', category: 'Plumber', phone_type: 'toll_free' });
    expect(hasFlag(spammy, 'CATEGORY_MISMATCH')).toBe(true);
    const clean = detectSpam({
      name: 'Clean Co',
      category: 'Plumber',
      phone_type: 'mobile',
      website: 'http://x.com',
    });
    expect(hasFlag(clean, 'CATEGORY_MISMATCH')).toBe(false);
  });

  test('network pattern: AAA + shared phone across 2 listings triggers, non-AAA does not', () => {
    const ctx = reuseCtx([
      { id: 'p1', lat: 40.7128, lng: -74.006, street: '123 Main St', city: 'New York' },
      { id: 'p2', lat: 34.0522, lng: -118.2437, street: '456 Oak Ave', city: 'Los Angeles' },
    ]);
    const spammy = detectSpam(
      { place_id: 'p1', name: 'AAA Plumbing NYC', phone_e164: '+12125551234' },
      ctx
    );
    expect(hasFlag(spammy, 'NETWORK_PATTERN')).toBe(true);
    expect(flagOf(spammy, 'NETWORK_PATTERN').severity).toBe('critical');
    const clean = detectSpam(
      { place_id: 'p1', name: 'Bob Plumbing NYC', phone_e164: '+12125551234' },
      ctx
    );
    expect(hasFlag(clean, 'NETWORK_PATTERN')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. detectSpam score boundaries + level mapping (scoreToLevel)
// ---------------------------------------------------------------------------

describe('Phase 3.4 — detectSpam score bands & riskLevel mapping', () => {
  test('clean: no signals → score 0, level "clean", isSpam false', () => {
    const r = detectSpam({
      name: "Bob's Diner",
      category: 'Restaurant',
      website: 'http://bob.com',
      rating: 4.5,
      reviews_count: 100,
    });
    expect(r.spamScore).toBe(0);
    expect(r.riskLevel).toBe('clean');
    expect(r.isSpam).toBe(false);
    expect(r.flags).toEqual([]);
  });

  test('low: single AAA-prefix signal → score in [10,24], level "low"', () => {
    // "AAAA Corp" triggers AAA_PREFIX (12) but not keyword stuffing
    // (no word boundary around "aaa" inside "aaaa").
    const r = detectSpam({ name: 'AAAA Corp', category: 'Restaurant', website: 'http://x.com' });
    expect(r.spamScore).toBeGreaterThanOrEqual(10);
    expect(r.spamScore).toBeLessThan(25);
    expect(r.riskLevel).toBe('low');
    expect(r.isSpam).toBe(false);
  });

  test('medium: AAA + PO box → score in [25,44], level "medium"', () => {
    const r = detectSpam({
      name: 'AAAA Corp',
      address: 'PO Box 123',
      category: 'Restaurant',
      website: 'http://x.com',
    });
    expect(r.spamScore).toBeGreaterThanOrEqual(25);
    expect(r.spamScore).toBeLessThan(45);
    expect(r.riskLevel).toBe('medium');
    expect(r.isSpam).toBe(true);
  });

  test('high: AAA + PO box + no-website + category mismatch → score in [45,64]', () => {
    const r = detectSpam({
      name: 'AAAA Plumbing',
      address: 'PO Box 123',
      category: 'Plumber',
      phone_type: 'toll_free',
    });
    expect(r.spamScore).toBeGreaterThanOrEqual(45);
    expect(r.spamScore).toBeLessThan(65);
    expect(r.riskLevel).toBe('high');
    expect(r.isSpam).toBe(true);
  });

  test('critical: multi-keyword stuffing + AAA + PO box → score ≥ 65', () => {
    const r = detectSpam({
      name: 'AAA BEST CHEAP AFFORDABLE 24/7 EMERGENCY PLUMBER',
      address: 'PO Box 123',
      category: 'Plumber',
    });
    expect(r.spamScore).toBeGreaterThanOrEqual(65);
    expect(r.riskLevel).toBe('critical');
    expect(r.isSpam).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. buildPhoneReuseMap
// ---------------------------------------------------------------------------

describe('Phase 3.4 — buildPhoneReuseMap', () => {
  test('groups by phone_e164 and strips singletons', () => {
    const businesses = [
      { place_id: 'p1', phone_e164: '+12125551234', lat: 40.7, lng: -74.0 },
      { place_id: 'p2', phone_e164: '+12125551234', lat: 34.0, lng: -118.2 },
      { place_id: 'p3', phone_e164: '+18005551234', lat: 41.0, lng: -87.0 }, // singleton
    ];
    const map = buildPhoneReuseMap(businesses);
    expect(map.size).toBe(1);
    expect(map.has('+12125551234')).toBe(true);
    expect(map.get('+12125551234')).toHaveLength(2);
    expect(map.has('+18005551234')).toBe(false); // singleton stripped
    // ReuseListing shape
    const entry = map.get('+12125551234')[0];
    expect(entry).toHaveProperty('id');
    expect(entry).toHaveProperty('lat');
    expect(entry).toHaveProperty('lng');
    expect(entry).toHaveProperty('street');
    expect(entry).toHaveProperty('city');
  });

  test('empty list / null → empty map', () => {
    expect(buildPhoneReuseMap([]).size).toBe(0);
    expect(buildPhoneReuseMap(null).size).toBe(0);
    expect(buildPhoneReuseMap(undefined).size).toBe(0);
  });

  test('missing / falsy phones are skipped', () => {
    const businesses = [
      { place_id: 'p1', phone_e164: null },
      { place_id: 'p2' }, // no phone_e164 field
      { place_id: 'p3', phone_e164: '' },
    ];
    expect(buildPhoneReuseMap(businesses).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. detectChainBatch + groupChainListings
// ---------------------------------------------------------------------------

describe('Phase 3.4 — detectChainBatch & groupChainListings', () => {
  test('detectChainBatch attaches chain_result to every business + returns stats', () => {
    const businesses = [
      { place_id: 'p1', name: "McDonald's" },
      { place_id: 'p2', name: 'Starbucks' },
      { place_id: 'p3', name: "Joe's Diner" },
    ];
    const stats = detectChainBatch(businesses);
    expect(businesses[0].chain_result.isChain).toBe(true);
    expect(businesses[0].chain_result.chainId).toBe('mcdonalds');
    expect(businesses[1].chain_result.isChain).toBe(true);
    expect(businesses[2].chain_result.isChain).toBe(false);
    expect(stats.total).toBe(3);
    expect(stats.chainListings).toBe(2);
    expect(stats.byChain.mcdonalds).toBe(1);
    expect(stats.byChain.starbucks).toBe(1);
  });

  test('detectChainBatch: empty / non-array → zero stats', () => {
    expect(detectChainBatch([])).toEqual({ total: 0, chainListings: 0, byChain: {} });
    const nullStats = detectChainBatch(null);
    expect(nullStats.total).toBe(0);
    expect(nullStats.chainListings).toBe(0);
  });

  test('groupChainListings groups chain matches by chainId, skips non-chains', () => {
    const businesses = [
      { place_id: 'p1', chain_result: { isChain: true, chainId: 'mcdonalds', chainName: "McDonald's" } },
      { place_id: 'p2', chain_result: { isChain: true, chainId: 'mcdonalds', chainName: "McDonald's" } },
      { place_id: 'p3', chain_result: { isChain: true, chainId: 'starbucks', chainName: 'Starbucks' } },
      { place_id: 'p4', chain_result: { isChain: false, chainId: null, chainName: null } },
    ];
    const groups = groupChainListings(businesses);
    expect(groups).toHaveLength(2);
    const mcd = groups.find((g) => g.chainId === 'mcdonalds');
    expect(mcd.chainName).toBe("McDonald's");
    expect(mcd.listingIds).toEqual(['p1', 'p2']);
    const sbux = groups.find((g) => g.chainId === 'starbucks');
    expect(sbux.listingIds).toEqual(['p3']);
  });
});

// ---------------------------------------------------------------------------
// 9. detectSpamBatch
// ---------------------------------------------------------------------------

describe('Phase 3.4 — detectSpamBatch', () => {
  test('attaches spam_result to every business + builds phone-reuse ctx internally', () => {
    const businesses = [
      {
        place_id: 'p1',
        name: 'AAA Plumbing NYC',
        phone_e164: '+12125551234',
        lat: 40.7,
        lng: -74.0,
        category: 'Restaurant',
        website: 'http://x.com',
      },
      {
        place_id: 'p2',
        name: 'AAA Plumbing LA',
        phone_e164: '+12125551234',
        lat: 34.0,
        lng: -118.2,
        category: 'Restaurant',
        website: 'http://x.com',
      },
    ];
    const stats = detectSpamBatch(businesses);
    expect(businesses[0].spam_result).toBeDefined();
    expect(businesses[0].spam_result.flags).toBeInstanceOf(Array);
    // Shared phone at different locations → PHONE_REUSE surfaced via the
    // internally-built reuse map.
    expect(hasFlag(businesses[0].spam_result, 'PHONE_REUSE')).toBe(true);
    expect(stats.total).toBe(2);
    expect(stats.spamListings).toBeGreaterThan(0);
    expect(typeof stats.avgScore).toBe('number');
  });

  test('empty batch → zero stats, zero avgScore', () => {
    const stats = detectSpamBatch([]);
    expect(stats.total).toBe(0);
    expect(stats.spamListings).toBe(0);
    expect(stats.avgScore).toBe(0);
    expect(stats.byLevel.clean).toBe(0);
  });

  test('stats.byLevel has all 5 risk levels and avgScore is numeric', () => {
    const businesses = [
      {
        place_id: 'p1',
        name: "Bob's Diner",
        category: 'Restaurant',
        website: 'http://bob.com',
        rating: 4.5,
        reviews_count: 100,
      },
      { place_id: 'p2', name: 'AAAA Spam', address: 'PO Box 1', category: 'Plumber' },
    ];
    const stats = detectSpamBatch(businesses);
    expect(stats.byLevel).toHaveProperty('clean');
    expect(stats.byLevel).toHaveProperty('low');
    expect(stats.byLevel).toHaveProperty('medium');
    expect(stats.byLevel).toHaveProperty('high');
    expect(stats.byLevel).toHaveProperty('critical');
    const totalClassified =
      stats.byLevel.clean + stats.byLevel.low + stats.byLevel.medium + stats.byLevel.high + stats.byLevel.critical;
    expect(totalClassified).toBe(2);
    expect(stats.avgScore).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Module constants
// ---------------------------------------------------------------------------

describe('Phase 3.4 — module constants', () => {
  test('ENRICHMENT_COLUMNS is [] (debug descriptors only — NOT persisted)', () => {
    expect(Array.isArray(ENRICHMENT_COLUMNS)).toBe(true);
    expect(ENRICHMENT_COLUMNS).toEqual([]);
  });

  test('__version, catalogues and constant tables are populated', () => {
    expect(__version).toBe(1);
    expect(CHAIN_CATALOGUE.length).toBeGreaterThan(5);
    expect(CHAIN_CATALOGUE.some((c) => c.chainId === 'mcdonalds')).toBe(true);
    expect(SPAM_NAME_KEYWORDS).toContain('best');
    expect(SPAM_NAME_KEYWORDS).toContain('24/7');
    expect(SPAM_TLDS).toContain('.xyz');
    expect(SPAM_TLDS).toContain('.tk');
    expect(AREA_CODE_TO_STATE['212']).toBe('NY');
    expect(AREA_CODE_TO_STATE['310']).toBe('CA');
  });

  test('normalizeStreetCity expands abbreviations and normalizes for comparison', () => {
    // "St" → "street", "Ave" → "avenue"; output is "street|city".
    expect(normalizeStreetCity('123 Main St', 'New York')).toBe('123 main street|new york');
    expect(normalizeStreetCity('456 Oak Ave', 'LA')).toBe('456 oak avenue|la');
    // Same street+city after normalization compare equal regardless of abbreviation.
    expect(normalizeStreetCity('123 Main St', 'New York')).toBe(
      normalizeStreetCity('123 Main Street', 'New York')
    );
  });
});
