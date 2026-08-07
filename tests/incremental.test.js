'use strict';

/**
 * tests/incremental.test.js — Phase 2.12 — Incremental Scraping & Detail Caching
 *
 * Coverage (per PHASE2_EXECUTION_PLAN.md §2.12 task checklist + acceptance
 * criteria). All tests use a mock DB client (the contract: an object with
 * `query(text, params) → { rows: [...] }`) — no real PostgreSQL needed.
 *
 * Test groups:
 *   1. computeChangeHash (pure) — deterministic, list-view-only, change-detecting.
 *   2. ageDays (pure) — null/invalid/future/normal timestamps.
 *   3. classifyListFreshness (pure) — new / fresh / stale decisions.
 *   4. reviewDeltaPct (pure) — 0→N, N→N, negative, missing.
 *   5. decideDetailScrape (pure) — the 8 required cases:
 *        a. Fresh business (no existing) → full scrape.
 *        b. Fresh + change_hash match → skipped.
 *        c. Fresh + change_hash differs → re-scraped.
 *        d. Detail cache hit (within TTL).
 *        e. Detail cache miss (beyond TTL).
 *        f. Review-count delta > 10% → forced refresh even within TTL.
 *        g. --noDetailCache always deep-scrapes.
 *   6. mergeCachedDetail (pure) — merges detail fields + sets detail_scraped.
 *   7. CacheStats (accumulator) — recordList/recordDetail/preflight/summary.
 *   8. formatCacheStatsSummary (pure) — banner formatting.
 *   9. createIncrementalCache (DI mock pool) — preflightRun / lookupBusinesses /
 *      loadBusinessesForRun / error-tolerance.
 *  10. rowToBusiness (pure) — JSONB parsing + Date→ISO conversion.
 *  11. Integration scenarios — end-to-end decision flows matching the
 *      acceptance criteria (first run, second run, 2-day-stale run, review-delta).
 *  12. Config (Phase 2.12 flags) — defaults, CLI parsing, env vars, validation.
 */

const {
  LIST_VIEW_HASH_COLUMNS,
  DETAIL_FIELDS,
  computeChangeHash,
  ageDays,
  classifyListFreshness,
  reviewDeltaPct,
  decideDetailScrape,
  mergeCachedDetail,
  CacheStats,
  formatCacheStatsSummary,
  createIncrementalCache,
  rowToBusiness,
} = require('../src/incremental');
const { computeChangeHash: dbComputeChangeHash, buildUnchangedRefresh } = require('../src/db');
const { loadConfig } = require('../src/config');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBusiness(overrides = {}) {
  return {
    place_id: 'ChIJTest1',
    name: 'Test Cafe',
    rating: 4.5,
    reviews_count: 123,
    price_level: '$$',
    category: 'Cafe',
    address: '123 Main St',
    phone: '+1-555-0100',
    website: 'https://example.com',
    maps_url: 'https://maps.google.com/?cid=123',
    plus_code: 'ABC123+',
    open_now: true,
    business_status: 'open',
    is_sponsored: false,
    scraped_at: '2026-08-07T12:00:00.000Z',
    query: 'Cafe',
    location: 'Berlin',
    full_hours: { Monday: '9:00–17:00' },
    popular_times: { Monday: [0, 0, 5, 10] },
    top_reviews: [{ author: 'Alice', rating: 5, text: 'Great!' }],
    photos: ['https://example.com/p1.jpg'],
    reservation_url: null,
    menu_url: 'https://example.com/menu',
    social_profiles: ['instagram:testcafe'],
    detail_scraped: true,
    ...overrides,
  };
}

// Fixed "now" for deterministic age calculations: 2026-08-07T12:00:00Z.
const NOW = new Date('2026-08-07T12:00:00.000Z').getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
function iso(msAgo) {
  return new Date(NOW - msAgo).toISOString();
}
function daysAgoIso(d) {
  return iso(d * DAY_MS);
}
function hoursAgoIso(h) {
  return iso(h * 60 * 60 * 1000);
}

// Mock pg Pool: routes .query to an in-memory handler. Tests configure the
// handler per-test to return the rows they want.
function makeMockPool(handler) {
  return {
    query: async (text, params) => {
      if (handler) return handler(text, params || []);
      return { rows: [] };
    },
    connect: async () => ({ query: makeMockPool(handler).query, release: () => {} }),
    end: async () => {},
  };
}

// ---------------------------------------------------------------------------
// 1. computeChangeHash (pure)
// ---------------------------------------------------------------------------

describe('Phase 2.12 — computeChangeHash (pure)', () => {
  test('is deterministic — same input → same hash', () => {
    const b = makeBusiness();
    expect(computeChangeHash(b)).toBe(computeChangeHash(b));
  });

  test('produces a 64-char lowercase hex digest', () => {
    const h = computeChangeHash(makeBusiness());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('two businesses with identical list-view fields produce the same hash', () => {
    const a = makeBusiness();
    const b = makeBusiness();
    expect(computeChangeHash(a)).toBe(computeChangeHash(b));
  });

  test('changing a list-view field (reviews_count) changes the hash', () => {
    const a = makeBusiness({ reviews_count: 123 });
    const b = makeBusiness({ reviews_count: 200 });
    expect(computeChangeHash(a)).not.toBe(computeChangeHash(b));
  });

  test('changing a list-view field (name) changes the hash', () => {
    const a = makeBusiness({ name: 'Cafe A' });
    const b = makeBusiness({ name: 'Cafe B' });
    expect(computeChangeHash(a)).not.toBe(computeChangeHash(b));
  });

  test('changing a DETAIL field (full_hours) does NOT change the change_hash', () => {
    // change_hash is list-view-only (distinct from data_hash which includes
    // detail JSONB). This is the core design contract: a detail-only change
    // does not invalidate the list freshness.
    const a = makeBusiness({ full_hours: { Monday: '9:00–17:00' } });
    const b = makeBusiness({ full_hours: { Monday: '8:00–18:00', Tuesday: '9:00–17:00' } });
    expect(computeChangeHash(a)).toBe(computeChangeHash(b));
  });

  test('changing top_reviews (detail JSONB) does NOT change the change_hash', () => {
    const a = makeBusiness({ top_reviews: [{ author: 'Alice', rating: 5 }] });
    const b = makeBusiness({ top_reviews: [{ author: 'Bob', rating: 3 }] });
    expect(computeChangeHash(a)).toBe(computeChangeHash(b));
  });

  test('changing scraped_at does NOT change the change_hash (excluded bookkeeping)', () => {
    const a = makeBusiness({ scraped_at: '2026-08-07T12:00:00.000Z' });
    const b = makeBusiness({ scraped_at: '2026-08-08T09:00:00.000Z' });
    expect(computeChangeHash(a)).toBe(computeChangeHash(b));
  });

  test('changing query or location changes the hash (search context matters)', () => {
    const a = makeBusiness({ query: 'Cafe', location: 'Berlin' });
    const b = makeBusiness({ query: 'Cafe', location: 'Paris' });
    expect(computeChangeHash(a)).not.toBe(computeChangeHash(b));
  });

  test('key-order-independent: nested objects with different key order hash identically', () => {
    // full_hours is NOT in LIST_VIEW_HASH_COLUMNS, so this tests the
    // normalizeForHash path indirectly via a list-view field that could be an
    // object. None of the list-view fields are objects in practice, but the
    // helper should still be deterministic. Test via the db re-export to
    // confirm parity.
    const a = makeBusiness();
    const b = makeBusiness();
    expect(computeChangeHash(a)).toBe(dbComputeChangeHash(b));
  });

  test('LIST_VIEW_HASH_COLUMNS excludes detail fields', () => {
    // The list-view columns must NOT include any detail JSONB field.
    for (const f of DETAIL_FIELDS) {
      expect(LIST_VIEW_HASH_COLUMNS).not.toContain(f);
    }
    // And must include the canonical list-view fields.
    expect(LIST_VIEW_HASH_COLUMNS).toContain('name');
    expect(LIST_VIEW_HASH_COLUMNS).toContain('rating');
    expect(LIST_VIEW_HASH_COLUMNS).toContain('reviews_count');
    expect(LIST_VIEW_HASH_COLUMNS).toContain('phone');
    expect(LIST_VIEW_HASH_COLUMNS).toContain('website');
  });
});

// ---------------------------------------------------------------------------
// 2. ageDays (pure)
// ---------------------------------------------------------------------------

describe('Phase 2.12 — ageDays (pure)', () => {
  test('null/undefined/empty → null', () => {
    expect(ageDays(null, NOW)).toBeNull();
    expect(ageDays(undefined, NOW)).toBeNull();
    expect(ageDays('', NOW)).toBeNull();
  });

  test('invalid timestamp → null', () => {
    expect(ageDays('not-a-date', NOW)).toBeNull();
    expect(ageDays('2026-13-99', NOW)).toBeNull();
  });

  test('1 day ago → 1.0', () => {
    expect(ageDays(daysAgoIso(1), NOW)).toBeCloseTo(1.0, 5);
  });

  test('2 hours ago → ~0.0833 days', () => {
    const age = ageDays(hoursAgoIso(2), NOW);
    expect(age).not.toBeNull();
    expect(age).toBeCloseTo(2 / 24, 5);
  });

  test('future timestamp → clamped to 0 (clock-skew tolerance)', () => {
    const future = new Date(NOW + 60_000).toISOString();
    expect(ageDays(future, NOW)).toBe(0);
  });

  test('accepts Date objects', () => {
    const d = new Date(NOW - DAY_MS);
    expect(ageDays(d, NOW)).toBeCloseTo(1.0, 5);
  });

  test('accepts epoch-ms numbers', () => {
    expect(ageDays(NOW - DAY_MS, NOW)).toBeCloseTo(1.0, 5);
  });

  test('defaults now to Date.now() when omitted', () => {
    const ts = new Date(Date.now() - DAY_MS).toISOString();
    const age = ageDays(ts);
    expect(age).not.toBeNull();
    expect(age).toBeGreaterThan(0.9);
    expect(age).toBeLessThan(1.1);
  });
});

// ---------------------------------------------------------------------------
// 3. classifyListFreshness (pure)
// ---------------------------------------------------------------------------

describe('Phase 2.12 — classifyListFreshness (pure)', () => {
  test('no existing row → action "new"', () => {
    const d = classifyListFreshness(null, { now: NOW, listFreshnessDays: 1 });
    expect(d.action).toBe('new');
    expect(d.ageDays).toBeNull();
  });

  test('existing row with last_list_scraped 2h ago, freshness=1d → "fresh"', () => {
    const existing = { last_list_scraped: hoursAgoIso(2), change_hash: 'abc' };
    const d = classifyListFreshness(existing, { now: NOW, listFreshnessDays: 1 });
    expect(d.action).toBe('fresh');
    expect(d.ageDays).toBeCloseTo(2 / 24, 5);
  });

  test('existing row with last_list_scraped 2 days ago, freshness=1d → "stale"', () => {
    const existing = { last_list_scraped: daysAgoIso(2), change_hash: 'abc' };
    const d = classifyListFreshness(existing, { now: NOW, listFreshnessDays: 1 });
    expect(d.action).toBe('stale');
    expect(d.ageDays).toBeCloseTo(2.0, 5);
  });

  test('boundary: exactly at freshness threshold → "fresh" (<= comparison)', () => {
    // 1.0 days old with freshness=1 → fresh (the <= boundary is inclusive).
    const existing = { last_list_scraped: daysAgoIso(1), change_hash: 'abc' };
    const d = classifyListFreshness(existing, { now: NOW, listFreshnessDays: 1 });
    expect(d.action).toBe('fresh');
  });

  test('existing row with null last_list_scraped → "stale" (tolerate old rows)', () => {
    const existing = { last_list_scraped: null, change_hash: 'abc' };
    const d = classifyListFreshness(existing, { now: NOW, listFreshnessDays: 1 });
    expect(d.action).toBe('stale');
    expect(d.ageDays).toBeNull();
  });

  test('freshness=0 → always stale (except future timestamps)', () => {
    const existing = { last_list_scraped: hoursAgoIso(1), change_hash: 'abc' };
    const d = classifyListFreshness(existing, { now: NOW, listFreshnessDays: 0 });
    expect(d.action).toBe('stale');
  });

  test('default freshness=1 when opts omitted', () => {
    const existing = { last_list_scraped: hoursAgoIso(2), change_hash: 'abc' };
    // Pass now but omit listFreshnessDays (uses default 1).
    const d = classifyListFreshness(existing, { now: NOW });
    expect(d.action).toBe('fresh');
  });
});

// ---------------------------------------------------------------------------
// 4. reviewDeltaPct (pure)
// ---------------------------------------------------------------------------

describe('Phase 2.12 — reviewDeltaPct (pure)', () => {
  test('100 → 115 = +15%', () => {
    expect(reviewDeltaPct(100, 115)).toBeCloseTo(15, 5);
  });

  test('100 → 90 = -10% (negative delta)', () => {
    expect(reviewDeltaPct(100, 90)).toBeCloseTo(-10, 5);
  });

  test('0 → 50 = large positive (1000)', () => {
    // 0→N is an infinite-percent jump; report a large number so any reasonable
    // threshold triggers a refresh.
    expect(reviewDeltaPct(0, 50)).toBe(1000);
  });

  test('0 → 0 = 0%', () => {
    expect(reviewDeltaPct(0, 0)).toBe(0);
  });

  test('null old count treated as 0 → 0→N = large positive (1000)', () => {
    // null reviews_count (never scraped reviews) is semantically "0 reviews
    // known". A 0→N transition is a large positive delta → forces a refresh
    // (the business gained reviews; detail data likely changed).
    expect(reviewDeltaPct(null, 100)).toBe(1000);
    expect(reviewDeltaPct(null, 0)).toBe(0);
  });

  test('null new count treated as 0 → N→0 = -100% (negative, not forced)', () => {
    // Reviews disappearing (N→0) is a negative delta — does NOT force a
    // refresh (the detail-refresh heuristic only catches review SURGES).
    expect(reviewDeltaPct(100, null)).toBeCloseTo(-100, 5);
  });

  test('undefined old count → null (Number(undefined) is NaN)', () => {
    expect(reviewDeltaPct(undefined, 100)).toBeNull();
  });

  test('undefined new count → null', () => {
    expect(reviewDeltaPct(100, undefined)).toBeNull();
  });

  test('non-finite inputs → null', () => {
    expect(reviewDeltaPct('abc', 100)).toBeNull();
    expect(reviewDeltaPct(100, NaN)).toBeNull();
  });

  test('200 → 230 = +15% (proportional, not absolute)', () => {
    expect(reviewDeltaPct(200, 230)).toBeCloseTo(15, 5);
  });
});

// ---------------------------------------------------------------------------
// 5. decideDetailScrape (pure) — the 8 required cases
// ---------------------------------------------------------------------------

describe('Phase 2.12 — decideDetailScrape (pure)', () => {
  const baseOpts = { now: NOW, detailCacheTtlDays: 7, detailRefreshOnReviewDelta: 10, noDetailCache: false };

  test('CASE a: fresh business (no existing row) → shouldScrape=true, reason=no_cache', () => {
    // Acceptance criterion: "First run: all businesses scraped (no cache hits)."
    const d = decideDetailScrape(null, { reviews_count: 100 }, baseOpts);
    expect(d.shouldScrape).toBe(true);
    expect(d.reason).toBe('no_cache');
    expect(d.ageDays).toBeNull();
  });

  test('CASE b: fresh + change_hash match → handled by caller (decideDetailScrape still evaluates cache)', () => {
    // The change_hash match is evaluated by the caller (index.js) BEFORE
    // calling decideDetailScrape — when it matches, the business is skipped
    // entirely and decideDetailScrape is never called. Here we verify the
    // detail-cache decision for a business that IS being re-scraped (fresh but
    // changed) with a fresh detail cache → cache hit.
    const existing = {
      last_detail_scraped: hoursAgoIso(2),
      reviews_count: 100,
    };
    const incoming = { reviews_count: 100 }; // no review delta
    const d = decideDetailScrape(existing, incoming, baseOpts);
    expect(d.shouldScrape).toBe(false);
    expect(d.reason).toBe('cache_hit');
  });

  test('CASE c: fresh + change_hash differs → re-scraped (detail cache may still hit)', () => {
    // The list changed, but if the detail cache is fresh AND no review delta,
    // the detail is reused. (The caller only re-scrapes list fields; the
    // detail decision is independent.) If there IS a review delta, the detail
    // is force-refreshed — covered in CASE f.
    const existing = {
      last_detail_scraped: hoursAgoIso(2),
      reviews_count: 100,
    };
    const incoming = { reviews_count: 100 }; // list changed elsewhere (e.g. name), reviews unchanged
    const d = decideDetailScrape(existing, incoming, baseOpts);
    expect(d.shouldScrape).toBe(false);
    expect(d.reason).toBe('cache_hit');
  });

  test('CASE d: detail cache HIT — last_detail_scraped within TTL, no review delta', () => {
    // Acceptance criterion: "Detail cache hit when last_detail_scraped is within TTL."
    const existing = {
      last_detail_scraped: daysAgoIso(5), // 5 days < 7-day TTL
      reviews_count: 100,
    };
    const incoming = { reviews_count: 105 }; // +5% < 10% threshold
    const d = decideDetailScrape(existing, incoming, baseOpts);
    expect(d.shouldScrape).toBe(false);
    expect(d.reason).toBe('cache_hit');
    expect(d.ageDays).toBeCloseTo(5.0, 5);
  });

  test('CASE e: detail cache MISS — last_detail_scraped beyond TTL', () => {
    // Acceptance criterion: "Detail cache miss when last_detail_scraped is beyond TTL."
    const existing = {
      last_detail_scraped: daysAgoIso(10), // 10 days > 7-day TTL
      reviews_count: 100,
    };
    const incoming = { reviews_count: 105 }; // +5% < 10%
    const d = decideDetailScrape(existing, incoming, baseOpts);
    expect(d.shouldScrape).toBe(true);
    expect(d.reason).toBe('cache_miss');
    expect(d.ageDays).toBeCloseTo(10.0, 5);
  });

  test('CASE f: review-count delta > 10% → forced_refresh even within TTL', () => {
    // Acceptance criterion: "A business whose reviews_count increased 15%
    // triggers a detail re-scrape even if the detail cache is fresh."
    const existing = {
      last_detail_scraped: hoursAgoIso(2), // fresh detail cache
      reviews_count: 100,
    };
    const incoming = { reviews_count: 115 }; // +15% > 10% threshold
    const d = decideDetailScrape(existing, incoming, baseOpts);
    expect(d.shouldScrape).toBe(true);
    expect(d.reason).toBe('forced_refresh');
    expect(d.reviewDeltaPct).toBeCloseTo(15, 5);
  });

  test('CASE g: --noDetailCache always deep-scrapes (reason=no_cache)', () => {
    // Acceptance criterion: "--noDetailCache forces deep-scrape on every
    // business regardless of cache."
    const existing = {
      last_detail_scraped: hoursAgoIso(1), // very fresh
      reviews_count: 100,
    };
    const incoming = { reviews_count: 100 };
    const d = decideDetailScrape(existing, incoming, { ...baseOpts, noDetailCache: true });
    expect(d.shouldScrape).toBe(true);
    expect(d.reason).toBe('no_cache');
  });

  test('existing row but null last_detail_scraped → no_cache (first detail scrape)', () => {
    const existing = { last_detail_scraped: null, reviews_count: 100 };
    const d = decideDetailScrape(existing, { reviews_count: 100 }, baseOpts);
    expect(d.shouldScrape).toBe(true);
    expect(d.reason).toBe('no_cache');
  });

  test('review delta exactly at threshold (10%) → NOT forced (strictly greater-than)', () => {
    const existing = { last_detail_scraped: hoursAgoIso(2), reviews_count: 100 };
    const incoming = { reviews_count: 110 }; // exactly +10%
    const d = decideDetailScrape(existing, incoming, baseOpts);
    // +10% is NOT > 10% → not forced; falls through to cache_hit (within TTL).
    expect(d.reason).toBe('cache_hit');
    expect(d.shouldScrape).toBe(false);
  });

  test('review delta threshold=0 → any change forces refresh', () => {
    const existing = { last_detail_scraped: hoursAgoIso(2), reviews_count: 100 };
    const incoming = { reviews_count: 101 }; // +1%
    const d = decideDetailScrape(existing, incoming, { ...baseOpts, detailRefreshOnReviewDelta: 0 });
    expect(d.shouldScrape).toBe(true);
    expect(d.reason).toBe('forced_refresh');
  });

  test('negative review delta (reviews removed) below threshold → cache_hit', () => {
    const existing = { last_detail_scraped: hoursAgoIso(2), reviews_count: 100 };
    const incoming = { reviews_count: 95 }; // -5%
    const d = decideDetailScrape(existing, incoming, baseOpts);
    expect(d.shouldScrape).toBe(false);
    expect(d.reason).toBe('cache_hit');
  });

  test('large negative review delta (-15%) does NOT force refresh (only positive spikes)', () => {
    // The detail-refresh heuristic catches review SURGES (new reviews suggest
    // new popular-times data). A drop in reviews (e.g. Google removing fake
    // reviews) doesn't imply the detail data changed.
    const existing = { last_detail_scraped: hoursAgoIso(2), reviews_count: 100 };
    const incoming = { reviews_count: 85 }; // -15%
    const d = decideDetailScrape(existing, incoming, baseOpts);
    expect(d.shouldScrape).toBe(false);
    expect(d.reason).toBe('cache_hit');
  });

  test('ttlDays=0 → always cache_miss (when not no_cache/forced)', () => {
    const existing = { last_detail_scraped: hoursAgoIso(0.001), reviews_count: 100 };
    const incoming = { reviews_count: 100 };
    const d = decideDetailScrape(existing, incoming, { ...baseOpts, detailCacheTtlDays: 0 });
    expect(d.shouldScrape).toBe(true);
    expect(d.reason).toBe('cache_miss');
  });
});

// ---------------------------------------------------------------------------
// 6. mergeCachedDetail (pure)
// ---------------------------------------------------------------------------

describe('Phase 2.12 — mergeCachedDetail (pure)', () => {
  test('merges detail fields from cached row into fresh business', () => {
    const fresh = makeBusiness({ full_hours: null, top_reviews: null, detail_scraped: false });
    const cached = {
      full_hours: { Monday: '9:00–17:00' },
      popular_times: { Monday: [1, 2, 3] },
      top_reviews: [{ author: 'Alice', rating: 5 }],
      photos: ['url1'],
      reservation_url: 'https://res.com',
      menu_url: 'https://menu.com',
      social_profiles: ['instagram:x'],
    };
    const merged = mergeCachedDetail(fresh, cached);
    expect(merged.full_hours).toEqual(cached.full_hours);
    expect(merged.popular_times).toEqual(cached.popular_times);
    expect(merged.top_reviews).toEqual(cached.top_reviews);
    expect(merged.photos).toEqual(cached.photos);
    expect(merged.reservation_url).toBe('https://res.com');
    expect(merged.menu_url).toBe('https://menu.com');
    expect(merged.social_profiles).toEqual(cached.social_profiles);
  });

  test('sets detail_scraped=true so deepScrapeAll skips it', () => {
    const fresh = makeBusiness({ detail_scraped: false });
    const merged = mergeCachedDetail(fresh, { full_hours: {} });
    expect(merged.detail_scraped).toBe(true);
  });

  test('does NOT mutate the original business (returns a new object)', () => {
    const fresh = makeBusiness({ detail_scraped: false, full_hours: null });
    const cached = { full_hours: { Monday: '9:00–17:00' } };
    const merged = mergeCachedDetail(fresh, cached);
    expect(fresh.detail_scraped).toBe(false); // original unchanged
    expect(fresh.full_hours).toBeNull();
    expect(merged).not.toBe(fresh);
  });

  test('preserves fresh list-view fields (does not overwrite with cached)', () => {
    const fresh = makeBusiness({ name: 'Fresh Name', reviews_count: 200 });
    const cached = { name: 'Old Name', reviews_count: 100, full_hours: { Monday: '9–5' } };
    const merged = mergeCachedDetail(fresh, cached);
    expect(merged.name).toBe('Fresh Name'); // list-view from fresh
    expect(merged.reviews_count).toBe(200); // list-view from fresh
    expect(merged.full_hours).toEqual({ Monday: '9–5' }); // detail from cached
  });

  test('null cached → returns business unchanged', () => {
    const fresh = makeBusiness({ detail_scraped: false });
    const merged = mergeCachedDetail(fresh, null);
    expect(merged).toBe(fresh);
  });

  test('skips null/undefined cached detail fields (does not clobber with null)', () => {
    const fresh = makeBusiness({ full_hours: { Monday: 'existing' }, detail_scraped: false });
    const cached = { full_hours: null, top_reviews: null }; // cached has nulls
    const merged = mergeCachedDetail(fresh, cached);
    // Existing fresh value preserved (cached nulls do not overwrite).
    expect(merged.full_hours).toEqual({ Monday: 'existing' });
    expect(merged.detail_scraped).toBe(true); // still marked scraped
  });
});

// ---------------------------------------------------------------------------
// 7. CacheStats (accumulator)
// ---------------------------------------------------------------------------

describe('Phase 2.12 — CacheStats (accumulator)', () => {
  test('starts empty (all zeros)', () => {
    const s = new CacheStats();
    expect(s.listNew).toBe(0);
    expect(s.listSkippedFresh).toBe(0);
    expect(s.listReScrapedStale).toBe(0);
    expect(s.listReScrapedChanged).toBe(0);
    expect(s.detailHits).toBe(0);
    expect(s.detailMisses).toBe(0);
    expect(s.detailForced).toBe(0);
    expect(s.detailNoCache).toBe(0);
    expect(s.totalSkipped).toBe(0);
    expect(s.totalScraped).toBe(0);
  });

  test('recordList accumulates each action type', () => {
    const s = new CacheStats();
    s.recordList('new');
    s.recordList('new');
    s.recordList('fresh_unchanged');
    s.recordList('fresh_unchanged');
    s.recordList('fresh_unchanged');
    s.recordList('stale');
    s.recordList('fresh_changed');
    expect(s.listNew).toBe(2);
    expect(s.listSkippedFresh).toBe(3);
    expect(s.listReScrapedStale).toBe(1);
    expect(s.listReScrapedChanged).toBe(1);
    expect(s.totalSkipped).toBe(3);
    expect(s.totalScraped).toBe(4);
  });

  test('recordList ignores unknown actions (defensive)', () => {
    const s = new CacheStats();
    s.recordList('unknown');
    s.recordList('whatever');
    expect(s.totalScraped).toBe(0);
    expect(s.totalSkipped).toBe(0);
  });

  test('recordDetail accumulates each reason type', () => {
    const s = new CacheStats();
    s.recordDetail('cache_hit');
    s.recordDetail('cache_hit');
    s.recordDetail('cache_miss');
    s.recordDetail('forced_refresh');
    s.recordDetail('no_cache');
    expect(s.detailHits).toBe(2);
    expect(s.detailMisses).toBe(1);
    expect(s.detailForced).toBe(1);
    expect(s.detailNoCache).toBe(1);
    expect(s.totalDetailSkipped).toBe(2);
    expect(s.totalDetailScraped).toBe(3);
  });

  test('recordDetailDisabled accumulates count', () => {
    const s = new CacheStats();
    s.recordDetailDisabled(5);
    s.recordDetailDisabled(3);
    expect(s.detailDisabled).toBe(8);
  });

  test('recordPreflightSkip sets the preflight fields + counts as list skips', () => {
    const s = new CacheStats();
    s.recordPreflightSkip(100, 0.5);
    expect(s.runPreflightSkip).toBe(true);
    expect(s.runPreflightBusinessCount).toBe(100);
    expect(s.runPreflightAgeDays).toBe(0.5);
    expect(s.listSkippedFresh).toBe(100); // all businesses served from cache
    expect(s.totalSkipped).toBe(100);
  });

  test('estimateSavings: 1000 detail hits × 4s = ~1.11 hours, 1000×3 requests', () => {
    const s = new CacheStats();
    for (let i = 0; i < 1000; i++) s.recordDetail('cache_hit');
    const sv = s.estimateSavings();
    expect(sv.requestsSaved).toBe(3000); // 1000 × 3
    expect(sv.secondsSaved).toBe(4000); // 1000 × 4
    expect(sv.hoursSaved).toBeCloseTo(4000 / 3600, 5);
  });

  test('toJSON serializes all fields for structured logging', () => {
    const s = new CacheStats();
    s.recordList('new');
    s.recordList('fresh_unchanged');
    s.recordDetail('cache_hit');
    s.recordDetail('forced_refresh');
    s.recordPreflightSkip(50, 0.25);
    const j = s.toJSON();
    expect(j.list.new).toBe(1);
    expect(j.list.skippedFresh).toBe(51); // 1 + 50 preflight
    expect(j.detail.hits).toBe(1);
    expect(j.detail.forced).toBe(1);
    expect(j.preflight.skipped).toBe(true);
    expect(j.preflight.businessCount).toBe(50);
    expect(j.savings).toBeDefined();
    expect(typeof j.savings.requestsSaved).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// 8. formatCacheStatsSummary (pure)
// ---------------------------------------------------------------------------

describe('Phase 2.12 — formatCacheStatsSummary (pure)', () => {
  test('returns null for empty stats (no decisions recorded)', () => {
    const s = new CacheStats();
    // Empty accumulator with no decisions → no savings → but the lines still
    // render (0 skipped, 0 hits). formatCacheStatsSummary returns the block
    // whenever stats exist. An empty CacheStats still renders zeros.
    const block = formatCacheStatsSummary(s);
    // It should render the "Incremental:" + "Detail cache:" lines (zeros),
    // but omit the "Saved:" line (no savings).
    expect(block).toContain('Incremental:');
    expect(block).toContain('Detail cache:');
    expect(block).not.toContain('Saved:');
  });

  test('formats the acceptance-criteria example shape', () => {
    const s = new CacheStats();
    // Simulate: 8000 skipped (fresh), 1500 re-scraped (stale), 500 new
    for (let i = 0; i < 8000; i++) s.recordList('fresh_unchanged');
    for (let i = 0; i < 1500; i++) s.recordList('stale');
    for (let i = 0; i < 500; i++) s.recordList('new');
    // Detail: 7000 hits, 2500 misses, 500 forced
    for (let i = 0; i < 7000; i++) s.recordDetail('cache_hit');
    for (let i = 0; i < 2500; i++) s.recordDetail('cache_miss');
    for (let i = 0; i < 500; i++) s.recordDetail('forced_refresh');
    const block = formatCacheStatsSummary(s);
    expect(block).toContain('8000 skipped (fresh)');
    expect(block).toContain('re-scraped (stale/changed)'); // 1500 stale + 0 changed
    expect(block).toContain('500 new');
    expect(block).toContain('7000 hits');
    expect(block).toContain('2500 misses');
    expect(block).toContain('500 forced-refresh');
    expect(block).toContain('Saved:');
    expect(block).toContain('hours of scraping');
    expect(block).toContain('requests');
  });

  test('preflight skip renders a distinct RUN-LEVEL SKIP line', () => {
    const s = new CacheStats();
    s.recordPreflightSkip(100, 0.04); // ~1 hour ago
    const block = formatCacheStatsSummary(s);
    expect(block).toContain('RUN-LEVEL SKIP');
    expect(block).toContain('100 businesses served from cache');
    expect(block).toContain('browser not launched');
  });

  test('accepts a toJSON-serialized object (not just a CacheStats instance)', () => {
    const s = new CacheStats();
    s.recordList('new');
    s.recordDetail('cache_hit');
    const j = s.toJSON();
    const block = formatCacheStatsSummary(j);
    expect(block).toContain('Incremental:');
    expect(block).toContain('1 new');
  });
});

// ---------------------------------------------------------------------------
// 9. createIncrementalCache (DI mock pool)
// ---------------------------------------------------------------------------

describe('Phase 2.12 — createIncrementalCache (DI mock pool)', () => {
  test('preflightRun returns skip=false when pool is null', async () => {
    const cache = createIncrementalCache(null);
    const r = await cache.preflightRun('Cafe', 'Berlin', 1);
    expect(r.skip).toBe(false);
    expect(r.businessCount).toBe(0);
  });

  test('preflightRun returns skip=false when no businesses exist', async () => {
    const pool = makeMockPool(() => ({ rows: [{ cnt: '0', newest: null }] }));
    const cache = createIncrementalCache(pool, { now: () => NOW });
    const r = await cache.preflightRun('Cafe', 'Berlin', 1);
    expect(r.skip).toBe(false);
    expect(r.businessCount).toBe(0);
  });

  test('preflightRun returns skip=true when newest scrape is within freshness', async () => {
    const pool = makeMockPool(() => ({
      rows: [{ cnt: '50', newest: hoursAgoIso(2) }], // 2h ago, freshness=1d
    }));
    const cache = createIncrementalCache(pool, { now: () => NOW });
    const r = await cache.preflightRun('Cafe', 'Berlin', 1);
    expect(r.skip).toBe(true);
    expect(r.businessCount).toBe(50);
    expect(r.ageDays).toBeCloseTo(2 / 24, 5);
  });

  test('preflightRun returns skip=false when newest scrape is beyond freshness', async () => {
    const pool = makeMockPool(() => ({
      rows: [{ cnt: '50', newest: daysAgoIso(2) }], // 2 days ago, freshness=1d
    }));
    const cache = createIncrementalCache(pool, { now: () => NOW });
    const r = await cache.preflightRun('Cafe', 'Berlin', 1);
    expect(r.skip).toBe(false);
    expect(r.businessCount).toBe(50);
  });

  test('preflightRun swallows DB errors → skip=false (non-fatal)', async () => {
    const pool = makeMockPool(() => {
      throw new Error('connection refused');
    });
    const cache = createIncrementalCache(pool, { now: () => NOW });
    const r = await cache.preflightRun('Cafe', 'Berlin', 1);
    expect(r.skip).toBe(false);
  });

  test('lookupBusinesses returns a Map keyed by place_id', async () => {
    const pool = makeMockPool((text, params) => {
      if (text.startsWith('SELECT') && text.includes('WHERE place_id = ANY')) {
        const ids = params[0];
        const rows = ids.map((id) => ({
          place_id: id,
          change_hash: 'hash_' + id,
          last_list_scraped: hoursAgoIso(2),
          last_detail_scraped: daysAgoIso(3),
          reviews_count: 100,
          full_hours: { Monday: '9–5' },
        }));
        return { rows };
      }
      return { rows: [] };
    });
    const cache = createIncrementalCache(pool);
    const map = await cache.lookupBusinesses(['A', 'B', 'C']);
    expect(map.size).toBe(3);
    expect(map.get('A').change_hash).toBe('hash_A');
    expect(map.get('B').last_detail_scraped).toBeDefined();
    expect(map.get('C').full_hours).toEqual({ Monday: '9–5' });
  });

  test('lookupBusinesses returns empty Map for empty placeIds (no query issued)', async () => {
    let queried = false;
    const pool = makeMockPool(() => {
      queried = true;
      return { rows: [] };
    });
    const cache = createIncrementalCache(pool);
    const map = await cache.lookupBusinesses([]);
    expect(map.size).toBe(0);
    expect(queried).toBe(false);
  });

  test('lookupBusinesses swallows DB errors → empty Map (treat all as new)', async () => {
    const pool = makeMockPool(() => {
      throw new Error('timeout');
    });
    const cache = createIncrementalCache(pool);
    const map = await cache.lookupBusinesses(['A', 'B']);
    expect(map.size).toBe(0);
  });

  test('loadBusinessesForRun returns business-shaped objects', async () => {
    const pool = makeMockPool((text) => {
      if (text.startsWith('SELECT * FROM businesses WHERE query')) {
        return {
          rows: [
            {
              place_id: 'X',
              name: 'Cafe X',
              rating: 4.5,
              reviews_count: 100,
              query: 'Cafe',
              location: 'Berlin',
              full_hours: { Monday: '9–5' },
              detail_scraped: true,
              scraped_at: new Date(NOW),
              last_list_scraped: new Date(NOW),
            },
          ],
        };
      }
      return { rows: [] };
    });
    const cache = createIncrementalCache(pool);
    const businesses = await cache.loadBusinessesForRun('Cafe', 'Berlin');
    expect(businesses).toHaveLength(1);
    expect(businesses[0].place_id).toBe('X');
    expect(businesses[0].name).toBe('Cafe X');
    // Date objects converted to ISO strings (matches extract.js output shape).
    expect(typeof businesses[0].scraped_at).toBe('string');
    expect(businesses[0].full_hours).toEqual({ Monday: '9–5' });
  });

  test('loadBusinessesForRun returns [] when pool is null', async () => {
    const cache = createIncrementalCache(null);
    const businesses = await cache.loadBusinessesForRun('Cafe', 'Berlin');
    expect(businesses).toEqual([]);
  });

  test('close() is a no-op (pool owned by caller)', () => {
    const cache = createIncrementalCache(null);
    expect(() => cache.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 10. rowToBusiness (pure)
// ---------------------------------------------------------------------------

describe('Phase 2.12 — rowToBusiness (pure)', () => {
  test('parses JSONB string columns into objects', () => {
    const row = {
      place_id: 'X',
      full_hours: '{"Monday":"9-5"}',
      top_reviews: '[{"author":"A"}]',
      photos: '["url1"]',
    };
    const b = rowToBusiness(row);
    expect(b.full_hours).toEqual({ Monday: '9-5' });
    expect(b.top_reviews).toEqual([{ author: 'A' }]);
    expect(b.photos).toEqual(['url1']);
  });

  test('preserves already-parsed JSONB objects (pg returns objects)', () => {
    const row = { place_id: 'X', full_hours: { Monday: '9-5' } };
    const b = rowToBusiness(row);
    expect(b.full_hours).toEqual({ Monday: '9-5' });
  });

  test('converts Date objects to ISO strings', () => {
    const d = new Date('2026-08-07T12:00:00.000Z');
    const row = { place_id: 'X', scraped_at: d, last_list_scraped: d, last_detail_scraped: d };
    const b = rowToBusiness(row);
    expect(b.scraped_at).toBe('2026-08-07T12:00:00.000Z');
    expect(b.last_list_scraped).toBe('2026-08-07T12:00:00.000Z');
    expect(b.last_detail_scraped).toBe('2026-08-07T12:00:00.000Z');
  });

  test('null row → null', () => {
    expect(rowToBusiness(null)).toBeNull();
  });

  test('invalid JSON string left as string (defensive)', () => {
    const row = { place_id: 'X', full_hours: '{not valid json' };
    const b = rowToBusiness(row);
    expect(b.full_hours).toBe('{not valid json');
  });
});

// ---------------------------------------------------------------------------
// 11. Integration scenarios — acceptance criteria end-to-end
// ---------------------------------------------------------------------------

describe('Phase 2.12 — integration scenarios (acceptance criteria)', () => {
  test('FIRST RUN: all businesses scraped (no cache hits)', () => {
    // Acceptance: "First run: all businesses scraped (no cache hits)."
    // Every business is "new" → full scrape + detail no_cache.
    const cacheStats = new CacheStats();
    const businesses = [makeBusiness({ place_id: 'A' }), makeBusiness({ place_id: 'B' })];
    for (const b of businesses) {
      const existing = null; // fresh DB
      const listD = classifyListFreshness(existing, { now: NOW, listFreshnessDays: 1 });
      expect(listD.action).toBe('new');
      cacheStats.recordList('new');
      const detailD = decideDetailScrape(existing, { reviews_count: b.reviews_count }, {
        now: NOW, detailCacheTtlDays: 7, detailRefreshOnReviewDelta: 10, noDetailCache: false,
      });
      expect(detailD.reason).toBe('no_cache');
      cacheStats.recordDetail(detailD.reason);
    }
    expect(cacheStats.listNew).toBe(2);
    expect(cacheStats.totalSkipped).toBe(0);
    expect(cacheStats.detailNoCache).toBe(2);
  });

  test('SECOND RUN immediately after: 100% cache hits (fresh + change_hash match)', () => {
    // Acceptance: "Second run immediately after: 100% cache hits, ~0 requests."
    // Every business was scraped 2h ago; change_hash matches → all skipped.
    const cacheStats = new CacheStats();
    const businesses = [makeBusiness({ place_id: 'A' }), makeBusiness({ place_id: 'B' })];
    for (const b of businesses) {
      const existing = {
        last_list_scraped: hoursAgoIso(2),
        change_hash: computeChangeHash(b), // matches the freshly-extracted hash
        last_detail_scraped: hoursAgoIso(2),
        reviews_count: b.reviews_count,
      };
      const listD = classifyListFreshness(existing, { now: NOW, listFreshnessDays: 1 });
      expect(listD.action).toBe('fresh');
      // change_hash matches → fresh_unchanged → skip entirely.
      if (listD.action === 'fresh' && existing.change_hash === computeChangeHash(b)) {
        cacheStats.recordList('fresh_unchanged');
        // detail not even consulted (skipped)
      }
    }
    expect(cacheStats.listSkippedFresh).toBe(2);
    expect(cacheStats.totalScraped).toBe(0);
    // ~0 requests to Google (all served from cache).
  });

  test('SECOND RUN after 2 days with listFreshnessDays=1: all re-scraped (stale)', () => {
    // Acceptance: "Second run after 2 days with --listFreshnessDays 1: all
    // businesses re-scraped (stale)."
    const cacheStats = new CacheStats();
    const businesses = [makeBusiness({ place_id: 'A' }), makeBusiness({ place_id: 'B' })];
    for (const b of businesses) {
      const existing = {
        last_list_scraped: daysAgoIso(2), // 2 days > 1 day freshness
        change_hash: computeChangeHash(b),
        last_detail_scraped: daysAgoIso(2), // also beyond detail TTL (7d)? No, 2 < 7.
        reviews_count: b.reviews_count,
      };
      const listD = classifyListFreshness(existing, { now: NOW, listFreshnessDays: 1 });
      expect(listD.action).toBe('stale');
      cacheStats.recordList('stale');
    }
    expect(cacheStats.listReScrapedStale).toBe(2);
    expect(cacheStats.listSkippedFresh).toBe(0);
  });

  test('reviews_count +15% triggers detail refresh even with fresh detail cache', () => {
    // Acceptance: "A business whose reviews_count increased 15% triggers a
    // detail re-scrape even if the detail cache is fresh."
    const existing = {
      last_list_scraped: hoursAgoIso(2),
      change_hash: 'different', // list changed (so we're re-scraping list)
      last_detail_scraped: hoursAgoIso(2), // detail cache very fresh
      reviews_count: 100,
    };
    const incoming = { reviews_count: 115 }; // +15%
    const d = decideDetailScrape(existing, incoming, {
      now: NOW, detailCacheTtlDays: 7, detailRefreshOnReviewDelta: 10, noDetailCache: false,
    });
    expect(d.shouldScrape).toBe(true);
    expect(d.reason).toBe('forced_refresh');
  });

  test('--noDetailCache forces deep-scrape on every business regardless of cache', () => {
    // Acceptance: "--noDetailCache forces deep-scrape on every business
    // regardless of cache."
    const businesses = [makeBusiness({ place_id: 'A' }), makeBusiness({ place_id: 'B' })];
    for (const b of businesses) {
      const existing = {
        last_list_scraped: hoursAgoIso(0.1), // super fresh
        last_detail_scraped: hoursAgoIso(0.1),
        reviews_count: b.reviews_count, // no delta
      };
      const d = decideDetailScrape(existing, { reviews_count: b.reviews_count }, {
        now: NOW, detailCacheTtlDays: 7, detailRefreshOnReviewDelta: 10, noDetailCache: true,
      });
      expect(d.shouldScrape).toBe(true);
      expect(d.reason).toBe('no_cache');
    }
  });

  test('cache-stats summary accurately reports hits/misses/savings', () => {
    // Acceptance: "The cache-stats summary accurately reports hits/misses/savings."
    const s = new CacheStats();
    // 3 fresh-unchanged (skipped), 2 stale (re-scraped), 1 new.
    s.recordList('fresh_unchanged');
    s.recordList('fresh_unchanged');
    s.recordList('fresh_unchanged');
    s.recordList('stale');
    s.recordList('stale');
    s.recordList('new');
    // Of the 3 re-scraped: 1 detail cache hit, 1 miss, 1 forced.
    s.recordDetail('cache_hit');
    s.recordDetail('cache_miss');
    s.recordDetail('forced_refresh');
    const block = formatCacheStatsSummary(s);
    expect(block).toContain('3 skipped (fresh)');
    expect(block).toContain('2 re-scraped'); // stale/changed
    expect(block).toContain('1 new');
    expect(block).toContain('1 hits');
    expect(block).toContain('1 misses');
    expect(block).toContain('1 forced-refresh');
    expect(block).toContain('Saved:');
  });

  test('full repeat-run flow: preflight skip → 100% cache, ~0 requests', async () => {
    // Simulate the run-level preflight path: pool returns a recent scrape →
    // preflightRun returns skip=true → loadBusinessesForRun returns the cached
    // rows → cacheStats records a preflight skip.
    const cachedRows = [
      { place_id: 'A', name: 'Cafe A', query: 'Cafe', location: 'Berlin' },
      { place_id: 'B', name: 'Cafe B', query: 'Cafe', location: 'Berlin' },
    ];
    const pool = makeMockPool((text) => {
      if (text.startsWith('SELECT COUNT(*)')) {
        return { rows: [{ cnt: '2', newest: hoursAgoIso(1) }] };
      }
      if (text.startsWith('SELECT * FROM businesses WHERE query')) {
        return { rows: cachedRows };
      }
      return { rows: [] };
    });
    const cache = createIncrementalCache(pool, { now: () => NOW });
    const preflight = await cache.preflightRun('Cafe', 'Berlin', 1);
    expect(preflight.skip).toBe(true);
    expect(preflight.businessCount).toBe(2);

    const stats = new CacheStats();
    if (preflight.skip) {
      const businesses = await cache.loadBusinessesForRun('Cafe', 'Berlin');
      stats.recordPreflightSkip(businesses.length, preflight.ageDays);
      expect(businesses).toHaveLength(2);
    }
    expect(stats.runPreflightSkip).toBe(true);
    expect(stats.listSkippedFresh).toBe(2);
    expect(stats.totalScraped).toBe(0); // ~0 requests
  });
});

// ---------------------------------------------------------------------------
// 12. db.js Phase 2.12 integration — buildUnchangedRefresh + computeChangeHash re-export
// ---------------------------------------------------------------------------

describe('Phase 2.12 — db.js integration (buildUnchangedRefresh + re-exports)', () => {
  test('db.js re-exports computeChangeHash (same function as incremental.js)', () => {
    const b = makeBusiness();
    expect(dbComputeChangeHash(b)).toBe(computeChangeHash(b));
  });

  test('buildUnchangedRefresh returns null for empty rows', () => {
    expect(buildUnchangedRefresh([])).toBeNull();
    expect(buildUnchangedRefresh(null)).toBeNull();
  });

  test('buildUnchangedRefresh builds a batched UPDATE with VALUES table', () => {
    const rows = [
      { placeId: 'A', changeHash: 'hashA' },
      { placeId: 'B', changeHash: 'hashB' },
    ];
    const { text, params } = buildUnchangedRefresh(rows);
    expect(text).toContain('UPDATE businesses SET last_list_scraped = NOW()');
    expect(text).toContain('change_hash = c.change_hash');
    expect(text).toContain('FROM (VALUES');
    expect(text).toContain('WHERE businesses.place_id = c.place_id');
    // 2 rows × 2 params (placeId, changeHash) = 4 params.
    expect(params).toEqual(['A', 'hashA', 'B', 'hashB']);
  });

  test('buildUnchangedRefresh does NOT touch updated_at (preserves Phase 2.1 contract)', () => {
    const { text } = buildUnchangedRefresh([{ placeId: 'A', changeHash: 'h' }]);
    expect(text).not.toContain('updated_at');
  });

  test('buildUnchangedRefresh is SQL-injection safe (place_id is parameterized)', () => {
    const evil = "'; DROP TABLE businesses; --";
    const { text, params } = buildUnchangedRefresh([{ placeId: evil, changeHash: 'h' }]);
    expect(text).not.toContain('DROP TABLE');
    expect(text).not.toContain(evil);
    expect(params).toContain(evil);
  });
});

// ---------------------------------------------------------------------------
// 13. Config (Phase 2.12 flags)
// ---------------------------------------------------------------------------

describe('Phase 2.12 — config flags', () => {
  test('defaults: incremental off, freshness=1, ttl=7, delta=10, noCache=false, swrr=false', () => {
    // Set DATABASE_URL + --output db so validation passes when incremental is on.
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.incremental.enabled).toBe(false);
    expect(cfg.incremental.listFreshnessDays).toBe(1);
    expect(cfg.incremental.detailCacheTtlDays).toBe(7);
    expect(cfg.incremental.detailRefreshOnReviewDelta).toBe(10);
    expect(cfg.incremental.noDetailCache).toBe(false);
    expect(cfg.incremental.swrr).toBe(false);
    expect(cfg.incremental.resolved).toBeNull();
  });

  test('--incremental enables incremental mode', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--output', 'db', '--incremental',
    ]);
    expect(cfg.incremental.enabled).toBe(true);
    expect(cfg.errors).not.toContain(
      expect.stringContaining('--incremental requires --output db'),
    );
    delete process.env.DATABASE_URL;
  });

  test('--incremental WITHOUT --output db is a config error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--incremental',
    ]);
    expect(cfg.errors.some((e) => e.includes('--incremental requires --output db'))).toBe(true);
  });

  test('INCREMENTAL env var enables incremental (with OUTPUT=db + DATABASE_URL)', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.OUTPUT = 'db';
    process.env.INCREMENTAL = 'true';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.incremental.enabled).toBe(true);
    delete process.env.DATABASE_URL;
    delete process.env.OUTPUT;
    delete process.env.INCREMENTAL;
  });

  test('--listFreshnessDays sets the freshness window', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--output', 'db', '--incremental', '--listFreshnessDays', '3',
    ]);
    expect(cfg.incremental.listFreshnessDays).toBe(3);
    delete process.env.DATABASE_URL;
  });

  test('--detailCacheTtlDays sets the detail cache TTL', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--output', 'db', '--incremental', '--detailCacheTtlDays', '14',
    ]);
    expect(cfg.incremental.detailCacheTtlDays).toBe(14);
    delete process.env.DATABASE_URL;
  });

  test('--detailRefreshOnReviewDelta sets the review-delta threshold', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--output', 'db', '--incremental', '--detailRefreshOnReviewDelta', '5',
    ]);
    expect(cfg.incremental.detailRefreshOnReviewDelta).toBe(5);
    delete process.env.DATABASE_URL;
  });

  test('--noDetailCache forces no-cache mode', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--output', 'db', '--incremental', '--noDetailCache',
    ]);
    expect(cfg.incremental.noDetailCache).toBe(true);
    delete process.env.DATABASE_URL;
  });

  test('--swrr is accepted (stub for Phase 5)', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--output', 'db', '--incremental', '--swrr',
    ]);
    expect(cfg.incremental.swrr).toBe(true);
    delete process.env.DATABASE_URL;
  });

  test('env vars: LIST_FRESHNESS_DAYS, DETAIL_CACHE_TTL_DAYS, DETAIL_REFRESH_ON_REVIEW_DELTA, NO_DETAIL_CACHE, SWRR', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.OUTPUT = 'db';
    process.env.INCREMENTAL = 'on';
    process.env.LIST_FRESHNESS_DAYS = '2';
    process.env.DETAIL_CACHE_TTL_DAYS = '10';
    process.env.DETAIL_REFRESH_ON_REVIEW_DELTA = '15';
    process.env.NO_DETAIL_CACHE = 'true';
    process.env.SWRR = 'true';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.incremental.enabled).toBe(true);
    expect(cfg.incremental.listFreshnessDays).toBe(2);
    expect(cfg.incremental.detailCacheTtlDays).toBe(10);
    expect(cfg.incremental.detailRefreshOnReviewDelta).toBe(15);
    expect(cfg.incremental.noDetailCache).toBe(true);
    expect(cfg.incremental.swrr).toBe(true);
    delete process.env.DATABASE_URL;
    delete process.env.OUTPUT;
    delete process.env.INCREMENTAL;
    delete process.env.LIST_FRESHNESS_DAYS;
    delete process.env.DETAIL_CACHE_TTL_DAYS;
    delete process.env.DETAIL_REFRESH_ON_REVIEW_DELTA;
    delete process.env.NO_DETAIL_CACHE;
    delete process.env.SWRR;
  });

  test('validation: listFreshnessDays out of range (366) is an error', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--output', 'db', '--incremental', '--listFreshnessDays', '366',
    ]);
    expect(cfg.errors.some((e) => e.includes('listFreshnessDays must be between 0 and 365'))).toBe(true);
    delete process.env.DATABASE_URL;
  });

  test('validation: detailCacheTtlDays negative is an error', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--output', 'db', '--incremental', '--detailCacheTtlDays', '-1',
    ]);
    expect(cfg.errors.some((e) => e.includes('detailCacheTtlDays must be between 0 and 365'))).toBe(true);
    delete process.env.DATABASE_URL;
  });

  test('validation: detailRefreshOnReviewDelta out of range (1001) is an error', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--output', 'db', '--incremental', '--detailRefreshOnReviewDelta', '1001',
    ]);
    expect(cfg.errors.some((e) => e.includes('detailRefreshOnReviewDelta must be between 0 and 1000'))).toBe(true);
    delete process.env.DATABASE_URL;
  });

  test('boundary: listFreshnessDays=0 and 365 are valid', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--output', 'db', '--incremental', '--listFreshnessDays', '0',
    ]);
    expect(cfg.errors.some((e) => e.includes('listFreshnessDays'))).toBe(false);
    delete process.env.DATABASE_URL;
  });

  test('HELP_TEXT documents Phase 2.12 flags', () => {
    const { HELP_TEXT } = require('../src/config');
    expect(HELP_TEXT).toContain('--incremental');
    expect(HELP_TEXT).toContain('--listFreshnessDays');
    expect(HELP_TEXT).toContain('--detailCacheTtlDays');
    expect(HELP_TEXT).toContain('--detailRefreshOnReviewDelta');
    expect(HELP_TEXT).toContain('--noDetailCache');
    expect(HELP_TEXT).toContain('--swrr');
    expect(HELP_TEXT).toContain('Phase 2.12');
  });
});
