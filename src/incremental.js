'use strict';

/**
 * src/incremental.js — Phase 2.12 — Incremental Scraping & Detail Caching
 *
 * Only re-scrape businesses that have changed since the last scrape. Detail-
 * page deep-scrapes are cached for a configurable TTL (default: 7 days). The
 * scraper skips businesses whose `place_id` was seen recently with no detected
 * change, dramatically reducing runtime and request count on repeat runs.
 *
 * Design rules (per PHASE2_EXECUTION_PLAN.md §2.12):
 *   - Freshness tracked via `last_list_scraped` / `last_detail_scraped` /
 *     `change_hash` columns on the `businesses` table (added by the Phase 2.12
 *     schema migration).
 *   - `change_hash` is a SHA-256 of the LIST-VIEW fields only — distinct from
 *     Phase 2.1's `data_hash` (which includes detail JSONB). When the list
 *     hash matches on re-scrape, the business is "unchanged" and we skip the
 *     detail-scrape entirely.
 *   - `--incremental` mode does a run-level pre-flight: if the most recent
 *     successful scrape of this (query, location) is within `--listFreshnessDays`,
 *     skip the browser entirely and re-export from the DB. (Acceptance
 *     criterion: "second run immediately after → 100% cache hits, ~0 requests,
 *     runtime < 30s".)
 *   - Per-business detail cache: `--detailCacheTtlDays` (default 7). Before
 *     deep-scraping a business, check `last_detail_scraped`; if within TTL, skip
 *     the deep-scrape and reuse the cached detail fields. `--noDetailCache`
 *     forces a deep-scrape on every business.
 *   - Change-triggered detail refresh: when a list-view field changes (e.g.
 *     `reviews_count` increased by > `--detailRefreshOnReviewDelta` percent,
 *     default 10%), force a detail re-scrape even if the TTL hasn't expired.
 *   - First-run behavior: on a fresh database (no existing rows), every
 *     business is "new" — no special-casing needed.
 *   - `--swrr` (stale-while-revalidate) is stubbed for Phase 5: the flag is
 *     accepted + logged, but behaves like normal incremental mode.
 *
 * The module is split into PURE helpers (unit-testable without a database)
 * and a thin DB-AWARE wrapper (`createIncrementalCache`) that accepts a pg
 * Pool and issues parameterized queries. Every DB method takes an injectable
 * `client` (or uses the pool) so tests pass a mock client implementing
 * `.query(text, params) → { rows: [...] }`.
 *
 * Public API:
 *   // Pure helpers
 *   LIST_VIEW_HASH_COLUMNS               → string[] (the hashed list-view fields)
 *   computeChangeHash(business)          → 64-char hex (pure)
 *   classifyListFreshness(existing, opts)→ { action, reason, ageDays } (pure)
 *   decideDetailScrape(existing, incoming, opts) → { shouldScrape, reason, ageDays } (pure)
 *   reviewDeltaPct(oldCount, newCount)   → number | null (pure)
 *   ageDays(timestamp, now)              → number | null (pure)
 *   mergeCachedDetail(business, cached)  → business with detail fields + detail_scraped=true (pure)
 *   class CacheStats                     → accumulator + summary()
 *   formatCacheStatsSummary(stats)       → string (pure)
 *
 *   // DB-aware wrapper (uses pg Pool)
 *   createIncrementalCache(pool, { logger, now }) → {
 *     preflightRun(query, location, listFreshnessDays) → { skip, runId, businessCount, ageDays }
 *     lookupBusinesses(placeIds)        → Map<placeId, existingRow>
 *     loadBusinessesForRun(query, location) → business[]
 *     close()
 *   }
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// List-view fields — the columns hashed by `change_hash`.
// ---------------------------------------------------------------------------
// These are the 17 canonical list-view fields from Phase 1.4 (the fields
// extracted from the feed cards BEFORE any detail-panel deep-scrape). They
// map 1:1 to `businesses` table columns. `place_id` is included because a
// place_id change is impossible (it's the key) but including it keeps the
// hash self-describing; `scraped_at` is excluded because it's the moment we
// saw the data, not the data itself; `query`/`location` are included so the
// same business scraped under a different query/location is treated as
// "changed" (the search context differs).
//
// IMPORTANT: this MUST stay in sync with src/db.js SCALAR_COLUMNS (the list-
// view subset). We re-declare it here (rather than importing) so the
// incremental module has no circular dependency on db.js — the pure helpers
// can be unit-tested in isolation.
// ---------------------------------------------------------------------------
const LIST_VIEW_HASH_COLUMNS = [
  'name',
  'rating',
  'reviews_count',
  'price_level',
  'category',
  'address',
  'phone',
  'website',
  'maps_url',
  'plus_code',
  'open_now',
  'business_status',
  'is_sponsored',
  'query',
  'location',
];

// The detail fields that `mergeCachedDetail` copies from a cached DB row when
// a business is skipped (fresh-unchanged or detail-cache hit). Kept in sync
// with src/detail.js DETAIL_FIELDS + the JSONB columns in src/db.js.
const DETAIL_FIELDS = [
  'full_hours',
  'popular_times',
  'top_reviews',
  'photos',
  'reservation_url',
  'menu_url',
  'social_profiles',
];

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without a database)
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys for deterministic JSON serialization. Copied
 * from src/db.js (kept local to avoid a require that would couple this module
 * to the DB layer for a pure helper).
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = sortKeysDeep(value[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * Coerce a value to a normalized form for stable hashing. Mirrors
 * src/db.js normalizeForHash so the change_hash is consistent with data_hash
 * semantics: null/undefined/'' all normalize to null; objects/arrays are
 * JSON-stringified with sorted keys.
 */
function normalizeForHash(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'object') return JSON.stringify(sortKeysDeep(value));
  return value;
}

/**
 * Compute a SHA-256 hex hash of a business's LIST-VIEW field values only.
 * Two businesses with the same name/rating/reviews/etc. (and same
 * query/location context) produce the same hash, so a re-scrape that finds
 * nothing changed is detected without a full column-by-column diff.
 *
 * This is DISTINCT from src/db.js computeRowHash, which hashes the full row
 * (including detail JSONB). `change_hash` is the list-only subset used by the
 * incremental subsystem to decide whether to skip the detail-scrape.
 *
 * Pure function — safe to unit-test without a database.
 *
 * @param {object} business — a scraped business record (list-view fields).
 * @returns {string} 64-char lowercase hex digest.
 */
function computeChangeHash(business) {
  const parts = [];
  for (const col of LIST_VIEW_HASH_COLUMNS) {
    parts.push(col + '=' + normalizeForHash(business ? business[col] : undefined));
  }
  return crypto.createHash('sha256').update(parts.join('\u0001'), 'utf8').digest('hex');
}

/**
 * Compute the age of a timestamp in days, relative to `now`. Returns null for
 * null/undefined/invalid timestamps (treated as "never scraped"). Pure.
 *
 * @param {string|number|Date|null|undefined} timestamp — ISO string, epoch-ms, or Date.
 * @param {number|Date} [now] — epoch-ms or Date (default: Date.now()).
 * @returns {number|null} age in days (floating-point; null when timestamp is absent/invalid).
 */
function ageDays(timestamp, now) {
  if (timestamp === undefined || timestamp === null || timestamp === '') return null;
  const t = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return null;
  const n = now instanceof Date ? now.getTime() : (now !== undefined ? now : Date.now());
  if (!Number.isFinite(n)) return null;
  const ms = n - t;
  if (ms < 0) return 0; // future timestamps are clamped to 0 (clock skew tolerance)
  return ms / (24 * 60 * 60 * 1000);
}

/**
 * Classify a business's list-view freshness given its existing DB row.
 *
 * @param {object|null} existing — { last_list_scraped, change_hash, reviews_count } or null.
 * @param {object} opts — { now, listFreshnessDays }.
 * @returns {{
 *   action: 'new'|'fresh'|'stale',
 *   reason: string,
 *   ageDays: number|null,
 * }}
 *   - 'new'   : no existing row (first scrape of this place_id).
 *   - 'fresh' : last_list_scraped is within listFreshnessDays.
 *   - 'stale' : last_list_scraped is beyond listFreshnessDays (or null).
 */
function classifyListFreshness(existing, opts) {
  const o = opts || {};
  const now = o.now !== undefined ? o.now : Date.now();
  const freshnessDays = o.listFreshnessDays !== undefined ? o.listFreshnessDays : 1;

  if (!existing) {
    return { action: 'new', reason: 'no existing row', ageDays: null };
  }
  const age = ageDays(existing.last_list_scraped, now);
  if (age === null) {
    // Existing row but never list-scraped (shouldn't happen post-2.12, but
    // tolerate rows inserted by older code). Treat as stale → full scrape.
    return { action: 'stale', reason: 'last_list_scraped is null', ageDays: null };
  }
  if (age <= freshnessDays) {
    return { action: 'fresh', reason: `scraped ${age.toFixed(2)} days ago (<= ${freshnessDays}d)`, ageDays: age };
  }
  return { action: 'stale', reason: `scraped ${age.toFixed(2)} days ago (> ${freshnessDays}d)`, ageDays: age };
}

/**
 * Compute the percentage delta between two review counts. Returns null when
 * either count is missing/non-finite, or when the old count is 0 (a 0→N
 * transition is "new reviews" but the percentage is undefined; we treat it
 * as a 100% delta only when new > 0, which callers can compare against the
 * threshold). Pure.
 *
 * @returns {number|null} delta in percent (e.g. 15 for +15%), or null.
 */
function reviewDeltaPct(oldCount, newCount) {
  const oldN = Number(oldCount);
  const newN = Number(newCount);
  if (!Number.isFinite(oldN) || !Number.isFinite(newN)) return null;
  if (oldN === 0) {
    // 0 → N: if N > 0, this is an infinite-percent jump; report a large
    // number (1000) so any threshold < 1000 triggers a refresh. 0 → 0 is 0%.
    return newN > 0 ? 1000 : 0;
  }
  return ((newN - oldN) / Math.abs(oldN)) * 100;
}

/**
 * Decide whether to deep-scrape a business's detail panel, given its existing
 * DB row + the freshly-extracted list-view data.
 *
 * Decision tree:
 *   1. noDetailCache → shouldScrape=true, reason='no_cache' (forced).
 *   2. no existing row → shouldScrape=true, reason='no_cache' (first scrape).
 *   3. existing.last_detail_scraped is null → shouldScrape=true, reason='no_cache'.
 *   4. review-delta > detailRefreshOnReviewDelta → shouldScrape=true, reason='forced_refresh'.
 *   5. age > detailCacheTtlDays → shouldScrape=true, reason='cache_miss'.
 *   6. otherwise → shouldScrape=false, reason='cache_hit' (within TTL, no review delta).
 *
 * @param {object|null} existing — { last_detail_scraped, reviews_count } or null.
 * @param {object} incoming — { reviews_count } (the freshly-extracted value).
 * @param {object} opts — { now, detailCacheTtlDays, detailRefreshOnReviewDelta, noDetailCache }.
 * @returns {{
 *   shouldScrape: boolean,
 *   reason: 'no_cache'|'cache_miss'|'cache_hit'|'forced_refresh',
 *   ageDays: number|null,
 *   reviewDeltaPct: number|null,
 * }}
 */
function decideDetailScrape(existing, incoming, opts) {
  const o = opts || {};
  const now = o.now !== undefined ? o.now : Date.now();
  const ttlDays = o.detailCacheTtlDays !== undefined ? o.detailCacheTtlDays : 7;
  const refreshThreshold = o.detailRefreshOnReviewDelta !== undefined ? o.detailRefreshOnReviewDelta : 10;
  const noCache = !!o.noDetailCache;

  // 1. --noDetailCache forces a deep-scrape regardless of cache state.
  if (noCache) {
    return { shouldScrape: true, reason: 'no_cache', ageDays: null, reviewDeltaPct: null };
  }
  // 2/3. No existing detail cache → must scrape.
  if (!existing || existing.last_detail_scraped === undefined || existing.last_detail_scraped === null || existing.last_detail_scraped === '') {
    return { shouldScrape: true, reason: 'no_cache', ageDays: null, reviewDeltaPct: null };
  }

  const age = ageDays(existing.last_detail_scraped, now);
  const rdp = reviewDeltaPct(existing.reviews_count, incoming ? incoming.reviews_count : undefined);

  // 4. Review-count delta exceeds threshold → forced refresh even within TTL.
  //    (A >10% review-count jump suggests the reviews/popular-times data has
  //    also changed, so the cached detail is likely stale.)
  if (rdp !== null && rdp > refreshThreshold) {
    return { shouldScrape: true, reason: 'forced_refresh', ageDays: age, reviewDeltaPct: rdp };
  }
  // 5. Beyond TTL → cache miss.
  if (age === null || age > ttlDays) {
    return { shouldScrape: true, reason: 'cache_miss', ageDays: age, reviewDeltaPct: rdp };
  }
  // 6. Within TTL + no review delta → cache hit.
  return { shouldScrape: false, reason: 'cache_hit', ageDays: age, reviewDeltaPct: rdp };
}

/**
 * Merge cached detail fields from an existing DB row into a freshly-extracted
 * business. Returns a NEW object (does not mutate). Sets `detail_scraped=true`
 * so downstream deepScrapeAll skips it. Pure.
 *
 * @param {object} business — the freshly-extracted list-view business.
 * @param {object} cached — the existing DB row (with detail fields + place_id).
 * @returns {object} a new business object with detail fields merged in.
 */
function mergeCachedDetail(business, cached) {
  if (!business) return business;
  if (!cached) return business;
  const merged = { ...business };
  for (const f of DETAIL_FIELDS) {
    if (cached[f] !== undefined && cached[f] !== null) {
      merged[f] = cached[f];
    }
  }
  merged.detail_scraped = true;
  return merged;
}

// ---------------------------------------------------------------------------
// CacheStats — accumulates per-business incremental decisions for the
// end-of-run summary. Pure accumulator (no I/O).
// ---------------------------------------------------------------------------

class CacheStats {
  constructor() {
    // List-view incremental decisions.
    this.listNew = 0;            // no existing row → full scrape
    this.listSkippedFresh = 0;   // fresh + change_hash matched → skipped
    this.listReScrapedStale = 0; // stale → re-scraped
    this.listReScrapedChanged = 0; // fresh but change_hash differed → re-scraped

    // Detail-cache decisions.
    this.detailHits = 0;          // within TTL + no review delta → reused cache
    this.detailMisses = 0;        // beyond TTL → deep-scraped
    this.detailForced = 0;        // review-delta triggered refresh
    this.detailNoCache = 0;       // --noDetailCache or first scrape → deep-scraped
    this.detailDisabled = 0;      // --deepScrape false → no detail work at all

    // Run-level preflight (set when the entire browser scrape is skipped).
    this.runPreflightSkip = false;
    this.runPreflightBusinessCount = 0;
    this.runPreflightAgeDays = null;
  }

  /** Record a list-view incremental decision. */
  recordList(action) {
    switch (action) {
      case 'new':
        this.listNew++;
        break;
      case 'fresh_unchanged':
        this.listSkippedFresh++;
        break;
      case 'stale':
        this.listReScrapedStale++;
        break;
      case 'fresh_changed':
        this.listReScrapedChanged++;
        break;
      default:
        // unknown action — ignore (defensive)
        break;
    }
  }

  /** Record a detail-cache decision. */
  recordDetail(reason) {
    switch (reason) {
      case 'cache_hit':
        this.detailHits++;
        break;
      case 'cache_miss':
        this.detailMisses++;
        break;
      case 'forced_refresh':
        this.detailForced++;
        break;
      case 'no_cache':
        this.detailNoCache++;
        break;
      default:
        break;
    }
  }

  /** Mark a business as having detail work disabled (--deepScrape false). */
  recordDetailDisabled(count = 1) {
    this.detailDisabled += count;
  }

  /** Mark the run-level preflight as a skip (browser not launched). */
  recordPreflightSkip(businessCount, ageDays) {
    this.runPreflightSkip = true;
    this.runPreflightBusinessCount = businessCount;
    this.runPreflightAgeDays = ageDays;
    // When the whole run is skipped, every business is a list-level skip.
    this.listSkippedFresh += businessCount;
  }

  /** Total businesses that avoided a list-view re-scrape. */
  get totalSkipped() {
    return this.listSkippedFresh;
  }

  /** Total businesses that WERE re-scraped (new + stale + changed). */
  get totalScraped() {
    return this.listNew + this.listReScrapedStale + this.listReScrapedChanged;
  }

  /** Total detail-cache hits (skipped deep-scrapes). */
  get totalDetailSkipped() {
    return this.detailHits;
  }

  /** Total detail deep-scrapes performed. */
  get totalDetailScraped() {
    return this.detailMisses + this.detailForced + this.detailNoCache;
  }

  /**
   * Rough savings estimate: each skipped list-scrape saves ~1 Google request
   * (the feed already loaded it, but we skip the detail-panel opens); each
   * skipped detail-scrape saves ~3 requests (panel opens for hours, reviews,
   * photos). Each detail deep-scrape takes ~4s on average. These are planning
   * estimates for the banner, not precise measurements.
   */
  estimateSavings() {
    const requestsSaved = this.listSkippedFresh * 1 + this.detailHits * 3;
    const secondsSaved = this.detailHits * 4; // ~4s per skipped detail-scrape
    return {
      requestsSaved,
      secondsSaved,
      hoursSaved: secondsSaved / 3600,
    };
  }

  /** Serialize to a plain object (for logging + run summary). */
  toJSON() {
    const savings = this.estimateSavings();
    return {
      list: {
        new: this.listNew,
        skippedFresh: this.listSkippedFresh,
        reScrapedStale: this.listReScrapedStale,
        reScrapedChanged: this.listReScrapedChanged,
      },
      detail: {
        hits: this.detailHits,
        misses: this.detailMisses,
        forced: this.detailForced,
        noCache: this.detailNoCache,
        disabled: this.detailDisabled,
      },
      preflight: {
        skipped: this.runPreflightSkip,
        businessCount: this.runPreflightBusinessCount,
        ageDays: this.runPreflightAgeDays,
      },
      savings: {
        requestsSaved: savings.requestsSaved,
        hoursScrapingSaved: Number(savings.hoursSaved.toFixed(2)),
      },
    };
  }
}

/**
 * Format the cache stats into the multi-line banner block specified by the
 * execution plan:
 *   Incremental: 8000 skipped (fresh), 1500 re-scraped (stale), 500 new
 *   Detail cache: 7000 hits, 2500 misses, 500 forced-refresh
 *   Saved: ~6.2 hours of scraping, ~14000 requests
 *
 * Returns null when incremental mode was not active (no stats collected).
 */
function formatCacheStatsSummary(stats) {
  if (!stats) return null;
  const j = stats.toJSON ? stats.toJSON() : stats;
  const lines = [];
  if (j.preflight && j.preflight.skipped) {
    const age = j.preflight.ageDays !== null && j.preflight.ageDays !== undefined
      ? `(last run ${j.preflight.ageDays.toFixed(2)}d ago)`
      : '';
    lines.push(
      `Incremental: RUN-LEVEL SKIP ${age} — ${j.preflight.businessCount} businesses served from cache, browser not launched`,
    );
  } else {
    lines.push(
      `Incremental: ${j.list.skippedFresh} skipped (fresh), ` +
        `${j.list.reScrapedStale + j.list.reScrapedChanged} re-scraped (stale/changed), ` +
        `${j.list.new} new`,
    );
  }
  lines.push(
    `Detail cache: ${j.detail.hits} hits, ${j.detail.misses} misses, ${j.detail.forced} forced-refresh` +
      (j.detail.noCache > 0 ? `, ${j.detail.noCache} no-cache` : '') +
      (j.detail.disabled > 0 ? `, ${j.detail.disabled} disabled` : ''),
  );
  if (j.savings && (j.savings.requestsSaved > 0 || j.savings.hoursScrapingSaved > 0)) {
    lines.push(
      `Saved: ~${j.savings.hoursScrapingSaved} hours of scraping, ~${j.savings.requestsSaved} requests`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// DB-aware wrapper — uses a pg Pool. Every method accepts an injectable
// client (for transaction reuse); when omitted, the pool's auto-client is
// used. The mock-client contract: an object with
//   `query(text, params) → { rows: [...] }`.
// ---------------------------------------------------------------------------

/**
 * Build the SELECT column list for incremental lookups. Includes the
 * freshness columns + the cached detail fields (so a cache hit can merge
 * them without a second round-trip). `reviews_count` is included for the
 * review-delta check.
 */
const LOOKUP_COLUMNS = [
  'place_id',
  'change_hash',
  'last_list_scraped',
  'last_detail_scraped',
  'reviews_count',
  'rating',
  'name',
  // detail fields (for cache-hit merging)
  'full_hours',
  'popular_times',
  'top_reviews',
  'photos',
  'reservation_url',
  'menu_url',
  'social_profiles',
];

/**
 * Create an incremental cache backed by a pg Pool. Returns async methods that
 * issue parameterized queries. The Pool may be null (incremental disabled) —
 * in that case every method returns a safe no-skip result.
 *
 * @param {import('pg').Pool|null} pool
 * @param {object} [opts] — { logger, now }
 */
function createIncrementalCache(pool, opts) {
  const o = opts || {};
  const logger = o.logger || null;
  const nowFn = o.now !== undefined ? o.now : Date.now;

  function logWarn(msg, meta) {
    if (logger && logger.warn) logger.warn(msg, meta);
  }
  function logInfo(msg, meta) {
    if (logger && logger.info) logger.info(msg, meta);
  }

  /**
   * Run-level pre-flight: is there a recent successful scrape for this
   * (query, location)? Returns { skip, businessCount, ageDays }.
   * `skip=true` means the caller should load businesses from the DB and NOT
   * launch the browser.
   */
  async function preflightRun(query, location, listFreshnessDays) {
    if (!pool) return { skip: false, businessCount: 0, ageDays: null };
    try {
      // Find the most recent business scraped for this (query, location).
      // We use MAX(last_list_scraped) as the freshness signal — if the newest
      // business is within freshness, the whole run is considered fresh
      // (conservative: even one stale business would force a full re-scrape,
      // but on a repeat run all businesses share the same scrape timestamp).
      const res = await pool.query(
        'SELECT COUNT(*) AS cnt, MAX(last_list_scraped) AS newest ' +
          'FROM businesses WHERE query = $1 AND location = $2',
        [query, location],
      );
      const row = res.rows && res.rows[0] ? res.rows[0] : null;
      const cnt = row ? Number(row.cnt) : 0;
      if (cnt === 0 || !row || !row.newest) {
        return { skip: false, businessCount: 0, ageDays: null };
      }
      const age = ageDays(row.newest, nowFn());
      if (age === null) return { skip: false, businessCount: cnt, ageDays: null };
      if (age <= listFreshnessDays) {
        logInfo('Phase 2.12 — incremental pre-flight: run-level cache HIT', {
          query,
          location,
          businessCount: cnt,
          ageDays: Number(age.toFixed(2)),
          listFreshnessDays,
          hint: 'Skipping browser launch; loading businesses from DB.',
        });
        return { skip: true, businessCount: cnt, ageDays: age };
      }
      return { skip: false, businessCount: cnt, ageDays: age };
    } catch (err) {
      logWarn('Phase 2.12 — incremental pre-flight failed (non-fatal, continuing with full scrape)', {
        error: err.message,
      });
      return { skip: false, businessCount: 0, ageDays: null };
    }
  }

  /**
   * Look up existing rows for a batch of place_ids. Returns a Map<placeId,
   * existingRow>. Only the columns in LOOKUP_COLUMNS are selected. An empty
   * placeIds array returns an empty Map (no query issued).
   */
  async function lookupBusinesses(placeIds, client) {
    const empty = new Map();
    const ids = Array.isArray(placeIds) ? placeIds.filter((p) => p) : [];
    if (ids.length === 0) return empty;
    const q = client || pool;
    if (!q) return empty;
    try {
      const res = await q.query(
        'SELECT ' + LOOKUP_COLUMNS.join(', ') + ' FROM businesses WHERE place_id = ANY($1)',
        [ids],
      );
      const map = new Map();
      for (const row of res.rows || []) {
        map.set(row.place_id, row);
      }
      return map;
    } catch (err) {
      logWarn('Phase 2.12 — incremental lookup failed (non-fatal, treating all as new)', {
        placeIdCount: ids.length,
        error: err.message,
      });
      return empty;
    }
  }

  /**
   * Load all businesses for a (query, location) from the DB — used when the
   * run-level preflight is a HIT (browser skipped). Returns an array of
   * business objects shaped like freshly-extracted ones (list + detail fields
   * populated from the cached row).
   */
  async function loadBusinessesForRun(query, location, client) {
    const q = client || pool;
    if (!q) return [];
    try {
      const res = await q.query(
        'SELECT * FROM businesses WHERE query = $1 AND location = $2 ORDER BY id',
        [query, location],
      );
      return (res.rows || []).map(rowToBusiness);
    } catch (err) {
      logWarn('Phase 2.12 — load cached businesses failed (non-fatal)', {
        query,
        location,
        error: err.message,
      });
      return [];
    }
  }

  function close() {
    // The pool is owned + closed by the caller (src/index.js). Nothing to do.
  }

  return {
    preflightRun,
    lookupBusinesses,
    loadBusinessesForRun,
    close,
  };
}

/**
 * Convert a DB row (from `businesses`) into a business object shaped like a
 * freshly-extracted one. Parses JSONB columns back into objects/arrays. Used
 * by loadBusinessesForRun for the run-level cache-hit path.
 */
function rowToBusiness(row) {
  if (!row) return null;
  const b = { ...row };
  // JSONB columns come back as already-parsed objects from pg, but be
  // defensive: if they're strings, parse them.
  for (const f of ['full_hours', 'popular_times', 'top_reviews', 'photos', 'social_profiles']) {
    if (typeof b[f] === 'string') {
      try {
        b[f] = JSON.parse(b[f]);
      } catch {
        // leave as string (downstream coercion will handle it)
      }
    }
  }
  // Date objects → ISO strings (matches the extract.js output shape).
  if (b.scraped_at instanceof Date) b.scraped_at = b.scraped_at.toISOString();
  if (b.last_list_scraped instanceof Date) b.last_list_scraped = b.last_list_scraped.toISOString();
  if (b.last_detail_scraped instanceof Date) b.last_detail_scraped = b.last_detail_scraped.toISOString();
  return b;
}

module.exports = {
  // constants
  LIST_VIEW_HASH_COLUMNS,
  DETAIL_FIELDS,
  LOOKUP_COLUMNS,
  // pure helpers
  computeChangeHash,
  ageDays,
  classifyListFreshness,
  reviewDeltaPct,
  decideDetailScrape,
  mergeCachedDetail,
  // stats
  CacheStats,
  formatCacheStatsSummary,
  // DB-aware wrapper
  createIncrementalCache,
  // row conversion (exported for tests)
  rowToBusiness,
};
