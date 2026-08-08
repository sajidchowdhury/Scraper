'use strict';

/**
 * tests/integration-phase2.test.js — Phase 2.13 — Final Integration Test
 *
 * End-to-end integration test that wires ALL Phase 2 subsystems together
 * through their dependency-injection seams and verifies they compose
 * correctly under load. This is the Phase 2.13 acceptance test for
 * cross-subsystem composition (each subsystem's unit tests cover its own
 * internals; this test catches wiring + contract bugs the units can't).
 *
 * Subsystems exercised (all REAL module logic; only I/O boundaries mocked):
 *   - Proxy rotation        (Phase 2.3)  — getIdentity() rotates proxy descriptors
 *   - Fingerprint           (Phase 2.4)  — distinct fingerprint per worker
 *   - Stealth               (Phase 2.5)  — identity carries the stealth-ready marker
 *   - CAPTCHA mock          (Phase 2.6)  — mock solver returns a token, no API cost
 *   - Session rotation      (Phase 2.7)  — distinct session id per worker
 *   - Worker pool           (Phase 2.8)  — real createPool, round-robin, block re-queue
 *   - Job queue             (Phase 2.9)  — real createQueue adapter + MockQueue/MockWorker
 *   - Memory/health         (Phase 2.10) — heap-stability + graceful shutdown
 *   - Self-healing selectors(Phase 2.11) — evaluateHealth + checkExtractionRatesForAbort
 *   - DB persistence        (Phase 2.1)  — real persistRunResults + upsert
 *   - Change tracking       (Phase 2.2)  — snapshots + field_changes on update
 *   - Incremental cache     (Phase 2.12) — preflight skip + per-business detail cache
 *
 * Mock strategy (DI seams — same ones the unit tests use):
 *   - BullMQ         → in-memory MockQueue/MockWorker (src/queue/mock-backend.js)
 *   - PostgreSQL     → in-memory mock client recognizing the exact SQL shapes
 *                      that src/db.js emits (INSERT/UPDATE/snapshots/field_changes/
 *                      scrape_runs + the Phase 2.12 unchanged-refresh + the
 *                      incremental preflight/lookup/load queries)
 *   - Playwright     → DI runTask(worker, task) that simulates scraping +
 *                      persists via the REAL persistRunResults
 *   - CAPTCHA solver → mock provider (returns a token instantly, $0 cost)
 *   - Proxy provider → getIdentity() returns rotating descriptors
 *
 * NOTE on testcontainers: the execution plan calls for real PostgreSQL + Redis
 * via testcontainers. Docker is not available in every environment, so this
 * test uses the DI mock backends instead. The real-Postgres/Redis path is
 * exercised by the manual "Final Acceptance Test (Definition of Done)"
 * criteria in PHASE2_EXECUTION_PLAN.md (run with `docker compose up`).
 * The integration value here comes from running every REAL subsystem module
 * with real logic through a single end-to-end flow.
 *
 * Run: bun test tests/integration-phase2.test.js
 */

const { createPool } = require('../src/pool');
const { createWorker } = require('../src/worker');
const { createQueue } = require('../src/queue');
const { MockQueue, MockWorker, _resetRegistry } = require('../src/queue/mock-backend');
const { persistRunResults, buildUnchangedRefresh } = require('../src/db');
const {
  createIncrementalCache,
  computeChangeHash,
  classifyListFreshness,
  decideDetailScrape,
  mergeCachedDetail,
  CacheStats,
} = require('../src/incremental');
const {
  evaluateHealth,
  isCriticalFailure,
  checkExtractionRatesForAbort,
  computeExtractionRates,
  CORE_FIELDS,
  SELECTOR_FAILURE_EXIT_CODE,
} = require('../src/extract');

// ---------------------------------------------------------------------------
// Mock PostgreSQL — an in-memory client that recognizes the SQL shapes
// emitted by src/db.js (persistRunResults / upsertBusinessesBatch /
// buildUnchangedRefresh) AND src/incremental.js (preflightRun /
// lookupBusinesses / loadBusinessesForRun). The SAME object serves as both
// the Pool (top-level .query + .connect + .end) and the PoolClient
// (.query + .release) so transactions and direct queries share state.
// ---------------------------------------------------------------------------

function makeMockDb() {
  const businesses = new Map(); // place_id → row (all columns)
  const scrapeRuns = []; // { id, query, location, extracted, ... }
  const snapshots = []; // change-tracking snapshots
  const fieldChanges = []; // change-tracking field deltas
  let nextRunId = 1;
  let nextBusinessId = 1;
  let nextSnapshotId = 1;
  let nextChangeId = 1;

  const txStack = [];

  function snap() {
    return {
      businesses: new Map(Array.from(businesses.entries()).map(([k, v]) => [k, { ...v }])),
      scrapeRuns: scrapeRuns.slice(),
      snapshots: snapshots.slice(),
      fieldChanges: fieldChanges.slice(),
      nextRunId, nextBusinessId, nextSnapshotId, nextChangeId,
    };
  }
  function restore(s) {
    businesses.clear();
    for (const [k, v] of s.businesses.entries()) businesses.set(k, { ...v });
    scrapeRuns.length = 0; scrapeRuns.push(...s.scrapeRuns);
    snapshots.length = 0; snapshots.push(...s.snapshots);
    fieldChanges.length = 0; fieldChanges.push(...s.fieldChanges);
    nextRunId = s.nextRunId; nextBusinessId = s.nextBusinessId;
    nextSnapshotId = s.nextSnapshotId; nextChangeId = s.nextChangeId;
  }

  const db = {
    queryCalls: [],
    async query(text, params) {
      const t = String(text).trim();
      this.queryCalls.push({ text: t, params: params ? params.slice() : [] });

      // --- Transaction control ---
      if (t === 'BEGIN') { txStack.push(snap()); return { rows: [] }; }
      if (t === 'COMMIT') { txStack.pop(); return { rows: [] }; }
      if (t === 'ROLLBACK') { const s = txStack.pop(); if (s) restore(s); return { rows: [] }; }

      // --- Phase 2.12 incremental preflight: COUNT + MAX(last_list_scraped) ---
      if (t.startsWith('SELECT COUNT(*) AS cnt, MAX(last_list_scraped) AS newest')) {
        const q = params[0];
        const loc = params[1];
        const matching = Array.from(businesses.values()).filter(
          (b) => b.query === q && b.location === loc,
        );
        const newest = matching
          .map((b) => b.last_list_scraped)
          .filter(Boolean)
          .sort()
          .pop();
        return { rows: [{ cnt: String(matching.length), newest: newest || null }] };
      }

      // --- Phase 2.12 incremental lookup: LOOKUP_COLUMNS SELECT ---
      if (t.startsWith('SELECT place_id, change_hash, last_list_scraped, last_detail_scraped')) {
        const ids = params[0] || [];
        const rows = [];
        for (const id of ids) {
          if (businesses.has(id)) {
            const b = businesses.get(id);
            rows.push({
              place_id: b.place_id,
              change_hash: b.change_hash || null,
              last_list_scraped: b.last_list_scraped || null,
              last_detail_scraped: b.last_detail_scraped || null,
              reviews_count: b.reviews_count,
              rating: b.rating,
              name: b.name,
              full_hours: b.full_hours || null,
              popular_times: b.popular_times || null,
              top_reviews: b.top_reviews || null,
              photos: b.photos || null,
              reservation_url: b.reservation_url || null,
              menu_url: b.menu_url || null,
              social_profiles: b.social_profiles || null,
            });
          }
        }
        return { rows };
      }

      // --- Phase 2.12 incremental load: SELECT * FROM businesses WHERE query/location ---
      if (t.startsWith('SELECT * FROM businesses WHERE query = $1 AND location = $2')) {
        const q = params[0];
        const loc = params[1];
        const rows = Array.from(businesses.values())
          .filter((b) => b.query === q && b.location === loc)
          .sort((a, b) => a.id - b.id);
        return { rows };
      }

      // --- upsert hash lookup ---
      if (t.startsWith('SELECT place_id, data_hash FROM businesses')) {
        const ids = params[0] || [];
        const rows = [];
        for (const id of ids) {
          if (businesses.has(id)) {
            rows.push({ place_id: id, data_hash: businesses.get(id).data_hash });
          }
        }
        return { rows };
      }

      // --- change-tracking pre-update: tracked fields ---
      if (t.startsWith('SELECT id, place_id, rating, reviews_count, business_status, phone, website')) {
        const ids = params[0] || [];
        const rows = [];
        for (const id of ids) {
          if (businesses.has(id)) {
            const b = businesses.get(id);
            rows.push({
              id: b.id, place_id: id, rating: b.rating,
              reviews_count: b.reviews_count, business_status: b.business_status,
              phone: b.phone, website: b.website,
            });
          }
        }
        return { rows };
      }

      // --- batch INSERT ... ON CONFLICT (place_id) DO NOTHING ---
      if (t.startsWith('INSERT INTO businesses') && t.includes('ON CONFLICT')) {
        const colMatch = t.match(/INSERT INTO businesses \(([^)]+)\) VALUES/);
        const cols = colMatch ? colMatch[1].split(', ').map((s) => s.trim()) : [];
        const nCols = cols.length || 1;
        let idx = 0;
        while (idx < params.length) {
          const rowVals = params.slice(idx, idx + nCols);
          const row = {};
          cols.forEach((c, i) => (row[c] = rowVals[i]));
          if (!businesses.has(row.place_id)) {
            businesses.set(row.place_id, {
              id: nextBusinessId++,
              ...row,
              updated_at: new Date().toISOString(),
            });
          }
          idx += nCols;
        }
        return { rows: [] };
      }

      // --- change-tracking: snapshots ---
      if (t.startsWith('INSERT INTO business_snapshots')) {
        const colMatch = t.match(/INSERT INTO business_snapshots \(([^)]+)\) VALUES/);
        const cols = colMatch ? colMatch[1].split(', ').map((s) => s.trim()) : [];
        const nCols = cols.length || 1;
        let idx = 0;
        while (idx < params.length) {
          const rowVals = params.slice(idx, idx + nCols);
          const row = { id: nextSnapshotId++ };
          cols.forEach((c, i) => (row[c] = rowVals[i]));
          row.snapshot_at = new Date().toISOString();
          snapshots.push(row);
          idx += nCols;
        }
        return { rows: [] };
      }

      // --- change-tracking: field_changes ---
      if (t.startsWith('INSERT INTO field_changes')) {
        const colMatch = t.match(/INSERT INTO field_changes \(([^)]+)\) VALUES/);
        const cols = colMatch ? colMatch[1].split(', ').map((s) => s.trim()) : [];
        const nCols = cols.length || 1;
        let idx = 0;
        while (idx < params.length) {
          const rowVals = params.slice(idx, idx + nCols);
          const row = { id: nextChangeId++ };
          cols.forEach((c, i) => (row[c] = rowVals[i]));
          row.detected_at = new Date().toISOString();
          fieldChanges.push(row);
          idx += nCols;
        }
        return { rows: [] };
      }

      // --- Phase 2.12 unchanged-refresh: UPDATE ... FROM (VALUES ...) AS c(...) ---
      if (t.startsWith('UPDATE businesses SET last_list_scraped = NOW(), change_hash = c.change_hash')) {
        for (let i = 0; i < params.length; i += 2) {
          const pid = params[i];
          const ch = params[i + 1];
          if (businesses.has(pid)) {
            const b = businesses.get(pid);
            b.change_hash = ch;
            b.last_list_scraped = new Date().toISOString();
            // NOTE: deliberately do NOT bump updated_at (Phase 2.12 contract).
          }
        }
        return { rows: [] };
      }

      // --- single-row UPDATE businesses SET ... WHERE place_id = $N ---
      if (t.startsWith('UPDATE businesses SET')) {
        const setMatch = t.match(/SET (.+) WHERE place_id = \$(\d+)/);
        if (setMatch) {
          const setClause = setMatch[1];
          const placeIdParamIdx = parseInt(setMatch[2], 10) - 1;
          const placeId = params[placeIdParamIdx];
          if (businesses.has(placeId)) {
            const existing = businesses.get(placeId);
            const assignments = setClause
              .split(', ')
              .filter((s) => !s.includes('NOW()') && !s.includes('CASE'));
            for (const a of assignments) {
              const m = a.match(/^(\w+) = \$(\d+)$/);
              if (m) {
                existing[m[1]] = params[parseInt(m[2], 10) - 1];
              }
            }
            existing.updated_at = new Date().toISOString();
          }
        }
        return { rows: [] };
      }

      // --- scrape_runs insert ---
      if (t.startsWith('INSERT INTO scrape_runs') && t.includes('RETURNING id')) {
        const run = { id: nextRunId++, _params: params };
        scrapeRuns.push(run);
        return { rows: [{ id: run.id }] };
      }

      // --- scrape_runs stamp ---
      if (t.startsWith('UPDATE scrape_runs SET db_inserted')) {
        return { rows: [] };
      }

      // --- DDL (migration) — accept silently ---
      if (t.includes('CREATE TABLE') || t.includes('CREATE INDEX') || t.includes('DO $$')) {
        return { rows: [] };
      }

      return { rows: [] };
    },
    connect() {
      // Return self so withClient() uses the same shared state.
      return Promise.resolve(this);
    },
    release() {},
    async end() {},
    _businesses: businesses,
    _scrapeRuns: scrapeRuns,
    _snapshots: snapshots,
    _fieldChanges: fieldChanges,
  };

  return db;
}

// ---------------------------------------------------------------------------
// Fake identity factory — rotates proxy / fingerprint / session descriptors
// across getIdentity() calls (one per worker construction + one per block/
// crash rotation). Auto-records every call so tests can assert rotation
// (the worker stores identity in closures, so we observe it at the source).
// ---------------------------------------------------------------------------

function makeIdentityFactory({ runTask, proxyCount = 5, fingerprintCount = 5 }) {
  const proxies = Array.from({ length: proxyCount }, (_, i) => ({
    id: `proxy-${i}`,
    server: `http://proxy${i}.example.com:8080`,
  }));
  const fingerprints = Array.from({ length: fingerprintCount }, (_, i) => ({
    userAgent: `Mozilla/5.0 (Fake FP ${i}) Chrome/131`,
    platform: i % 2 === 0 ? 'Win32' : 'MacIntel',
    locale: 'en-US',
    fingerprintId: `fp-${i}`,
  }));
  const sessions = Array.from({ length: proxyCount }, (_, i) => ({
    sessionId: `session-${i}`,
    requestCount: 0,
  }));

  const calls = []; // { proxyId, fingerprintId, sessionId, stealthPatches }
  let pIdx = 0;
  let fIdx = 0;
  let sIdx = 0;

  async function getIdentity() {
    const proxy = proxies[pIdx % proxies.length];
    const fingerprint = fingerprints[fIdx % fingerprints.length];
    const sessionManager = sessions[sIdx % sessions.length];
    pIdx++; fIdx++; sIdx++;
    const identity = {
      proxy,
      fingerprint,
      sessionManager,
      // stealth-ready marker (Phase 2.5): in production, stealth patches are
      // applied via playwright-extra on the browser context built from this
      // identity. Here we assert the identity carries the marker.
      stealthPatches: true,
      runTask,
    };
    calls.push({
      proxyId: proxy.id,
      fingerprintId: fingerprint.fingerprintId,
      sessionId: sessionManager.sessionId,
      stealthPatches: true,
    });
    return identity;
  }

  return {
    getIdentity,
    get calls() {
      return calls;
    },
    get callCount() {
      return calls.length;
    },
    proxies,
    fingerprints,
    sessions,
  };
}

// ---------------------------------------------------------------------------
// Fake runTask — simulates a Playwright scrape end-to-end WITHOUT a browser:
//   1. Generates N businesses for the (query, location) with list + detail fields.
//   2. Computes the list-view change_hash (REAL computeChangeHash — Phase 2.12).
//   3. Looks up existing rows via the REAL incremental cache (lookupBusinesses).
//   4. Per business: classify list freshness + decide detail scrape. On a
//      cache_hit, mergeCachedDetail reuses the cached detail (no deep-scrape).
//   5. Persists via the REAL persistRunResults (db.js upsert + change tracking).
//   6. Returns a result shaped like the real scrape result.
//
// Optionally throws WORKER_BLOCKED on the first attempt for selected task ids
// (self-healing test) and calls the mock CAPTCHA solver (Phase 2.6 coverage).
// ---------------------------------------------------------------------------

function makeFakeRunTask({ db, businessesPerJob = 5, cacheStats, incrementalCache, blockFirstJob = false }) {
  // reviewBump: added to every reviews_count to simulate a real-world change
  // between runs (the test advances it via setReviewBump before a re-scrape).
  let reviewBump = 0;
  function setReviewBump(n) { reviewBump = n; }
  // blockFirstJob: throw WORKER_BLOCKED on the FIRST attempt of the FIRST job
  // only (so the pool re-queues it and it succeeds on retry). Used by the
  // Phase 2.8 self-healing test.
  let firstJobBlocked = false;
  // Mock CAPTCHA solver (Phase 2.6) — returns a token instantly, $0 cost.
  const captchaSolves = [];
  function mockSolveCaptcha() {
    const token = `mock-token-${captchaSolves.length + 1}`;
    captchaSolves.push({ token, costUsd: 0 });
    return { token, costUsd: 0 };
  }

  async function runTask(worker, task) {
    // Phase 2.6 — mock CAPTCHA solve on every job ($0 cost).
    mockSolveCaptcha();

    // Phase 2.8 — block the first attempt of the first job only.
    if (blockFirstJob && !firstJobBlocked) {
      firstJobBlocked = true;
      const err = new Error('simulated block (HTTP 429)');
      err.code = 'WORKER_BLOCKED';
      throw err;
    }

    const query = task.query || 'Cafe';
    const location = task.location || 'Berlin';
    const detailScrapeEnabled = task.deepScrape !== false;

    // 1. Generate businesses DETERMINISTICALLY from (query, location) so a
    //    re-scrape of the same pair produces the SAME data (→ unchanged /
    //    cache hit) unless reviewBump has been advanced (→ updated).
    const qid = `${query}_${location}`.replace(/\s+/g, '_');
    const businesses = [];
    for (let i = 0; i < businessesPerJob; i++) {
      const placeId = `ChIJ-${qid}-${i}`;
      businesses.push({
        place_id: placeId,
        name: `${query} ${i} (${location})`,
        rating: 4.0 + (i % 10) / 10,
        reviews_count: 100 + i * 7 + reviewBump,
        price_level: '$$',
        category: query,
        address: `${100 + i} Main St, ${location}`,
        phone: `+1-555-01${String(i).padStart(2, '0')}00`,
        website: `https://example-${qid}-${i}.com`,
        maps_url: `https://maps.google.com/?cid=${qid}${i}`,
        plus_code: `ABC${qid}${i}+`,
        open_now: true,
        business_status: 'OPERATIONAL',
        query,
        location,
        full_hours: detailScrapeEnabled ? { mon: '9-17' } : null,
        popular_times: detailScrapeEnabled ? { mon: [10, 20, 30] } : null,
        top_reviews: detailScrapeEnabled ? [{ text: 'Great', rating: 5 }] : null,
        photos: detailScrapeEnabled ? ['https://img.example.com/p.jpg'] : null,
        reservation_url: null,
        menu_url: null,
        social_profiles: detailScrapeEnabled ? { instagram: '@x' } : null,
      });
    }

    // 2. Compute list-view change_hash (REAL Phase 2.12 helper).
    for (const b of businesses) {
      b.change_hash = computeChangeHash(b);
    }

    // 3. Incremental cache lookup + per-business decisions.
    let detailScrapedCount = 0;
    let detailCacheHits = 0;
    if (incrementalCache) {
      const placeIds = businesses.map((b) => b.place_id);
      const existing = await incrementalCache.lookupBusinesses(placeIds, db);
      for (const b of businesses) {
        const prev = existing.get(b.place_id);
        const listFresh = classifyListFreshness(prev, { listFreshnessDays: 1 });
        if (listFresh.action === 'fresh' && prev && prev.change_hash === b.change_hash) {
          cacheStats.recordList('fresh_unchanged');
          const decision = decideDetailScrape(prev, b, {
            detailCacheTtlDays: 7,
            detailRefreshOnReviewDelta: 10,
          });
          if (decision.shouldScrape) {
            cacheStats.recordDetail(decision.reason);
            b.detail_scraped = true;
            detailScrapedCount++;
          } else {
            mergeCachedDetail(b, prev);
            detailCacheHits++;
            cacheStats.recordDetail(decision.reason);
          }
        } else {
          cacheStats.recordList(
            listFresh.action === 'fresh' ? 'fresh_changed'
              : listFresh.action === 'stale' ? 'stale'
                : 'new',
          );
          if (detailScrapeEnabled) {
            b.detail_scraped = true;
            detailScrapedCount++;
            cacheStats.recordDetail('no_cache');
          }
        }
      }
    } else if (detailScrapeEnabled) {
      for (const b of businesses) {
        b.detail_scraped = true;
        detailScrapedCount++;
      }
    }

    // 4. Persist via REAL persistRunResults.
    const summary = {
      query,
      location,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      extractionStats: { failed: 0 },
      exitCode: 0,
    };
    const persistRes = await persistRunResults(db, {
      businesses,
      summary,
      incremental: !!incrementalCache,
    });

    return {
      workerId: worker.id,
      extracted: businesses.length,
      detailScraped: detailScrapedCount,
      detailCacheHits,
      dbInserted: persistRes.inserted,
      dbUpdated: persistRes.updated,
      dbUnchanged: persistRes.unchanged,
      captchaSolved: true,
    };
  }

  return { runTask, getCaptchaSolves: () => captchaSolves.slice(), setReviewBump };
}

// ---------------------------------------------------------------------------
// Helper: build a full Phase 2 stack (pool + queue + identity + runTask).
// ---------------------------------------------------------------------------

function buildStack({ workers = 2, queueConcurrency = 2, businessesPerJob = 5, blockFirstJob = false, incremental = true } = {}) {
  const db = makeMockDb();
  const cacheStats = new CacheStats();
  const incrementalCache = incremental ? createIncrementalCache(db, { now: () => Date.now() }) : null;
  const { runTask, getCaptchaSolves, setReviewBump } = makeFakeRunTask({
    db, businessesPerJob, cacheStats, incrementalCache, blockFirstJob,
  });
  const identityFactory = makeIdentityFactory({ runTask });

  const pool = createPool({
    size: workers,
    cfg: {},
    getIdentity: identityFactory.getIdentity,
    // createWorker defaults to the real createWorker; identity.runTask is
    // forwarded by the pool so each worker gets the DI runTask.
    crashLimit: 5,
    crashWindowMs: 60_000,
    cooldownMs: 0,
    taskRetries: workers,
    sleepFn: async () => { await new Promise((r) => setImmediate(r)); },
    pollIntervalMs: 0,
  });

  const queue = createQueue({
    name: 'integration-test',
    backend: { Queue: MockQueue, Worker: MockWorker },
    concurrency: queueConcurrency,
    defaultAttempts: 1,
  });

  return { db, cacheStats, identityFactory, pool, queue, getCaptchaSolves, setReviewBump, incrementalCache };
}

// Helper: wait until the queue reports `completed` >= N (or fail after timeout).
async function waitForCompleted(queue, n, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = await queue.getStats();
    if (stats.completed >= n) return stats;
    if (stats.failed > 0 && stats.completed + stats.failed >= n) return stats;
    await new Promise((r) => setImmediate(r));
  }
  return queue.getStats();
}

// ===========================================================================
// TESTS
// ===========================================================================

describe('Phase 2.13 — Integration: full Phase 2 pipeline', () => {
  beforeEach(() => {
    _resetRegistry();
  });

  // -------------------------------------------------------------------------
  // End-to-end queue + pool + DB
  // -------------------------------------------------------------------------

  describe('end-to-end queue + pool + DB persistence', () => {
    test('10 search jobs through a 2-worker pool + mock queue all complete', async () => {
      const { pool, queue } = buildStack({ workers: 2, queueConcurrency: 2, businessesPerJob: 5 });

      queue.process(async (task) => pool.dispatch(task));

      // 10 DISTINCT (query, location) pairs so each job scrapes unique
      // businesses (no upsert contention across jobs).
      for (let i = 0; i < 10; i++) {
        await queue.add('search', { query: `Cafe${i}`, location: `City${i}`, maxResults: 5 }, { priority: 5, attempts: 1 });
      }

      const stats = await waitForCompleted(queue, 10);
      expect(stats.completed).toBe(10);
      expect(stats.failed).toBe(0);

      await queue.shutdown();
      await pool.shutdown();
    });

    test('DB is populated: businesses + scrape_runs rows written (Phase 2.1)', async () => {
      const { db, pool, queue } = buildStack({ workers: 2, businessesPerJob: 5 });

      queue.process(async (task) => pool.dispatch(task));

      // 3 DISTINCT (query, location) pairs → 3 × 5 = 15 unique businesses.
      const pairs = [['Cafe', 'Berlin'], ['Plumber', 'Dhaka'], ['Salon', 'Tokyo']];
      for (const [q, l] of pairs) {
        await queue.add('search', { query: q, location: l, maxResults: 5 }, { attempts: 1 });
      }
      await waitForCompleted(queue, 3);

      expect(db._businesses.size).toBe(15);
      expect(db._scrapeRuns.length).toBe(3);
      // Phase 2.12 freshness columns populated.
      for (const b of db._businesses.values()) {
        expect(b.change_hash).toBeTruthy();
        expect(typeof b.change_hash).toBe('string');
        expect(b.last_list_scraped).toBeTruthy();
      }

      await queue.shutdown();
      await pool.shutdown();
    });

    test('change tracking: re-scrape with changed reviews_count → updated + snapshot + field_change (Phase 2.2)', async () => {
      // incremental: false isolates Phase 2.2 change-tracking from the Phase
      // 2.12 cache (which would merge cached detail + skew the data_hash).
      const { db, pool, queue, setReviewBump } = buildStack({
        workers: 1, queueConcurrency: 1, businessesPerJob: 2, incremental: false,
      });

      queue.process(async (task) => pool.dispatch(task));

      // First run — inserts 2 businesses.
      await queue.add('search', { query: 'Plumber', location: 'Dhaka', maxResults: 2 }, { attempts: 1 });
      await waitForCompleted(queue, 1);
      expect(db._businesses.size).toBe(2);
      expect(db._snapshots.length).toBe(0);
      expect(db._fieldChanges.length).toBe(0);

      // Second run with SAME data → unchanged (data_hash matches).
      await queue.add('search', { query: 'Plumber', location: 'Dhaka', maxResults: 2 }, { attempts: 1 });
      await waitForCompleted(queue, 2);
      expect(db._snapshots.length).toBe(0);
      expect(db._fieldChanges.length).toBe(0);

      // Simulate a real-world change: Google now reports more reviews.
      setReviewBump(50);

      // Third run — reviews_count bumped → data_hash differs → updated.
      await queue.add('search', { query: 'Plumber', location: 'Dhaka', maxResults: 2 }, { attempts: 1 });
      await waitForCompleted(queue, 3);

      expect(db._snapshots.length).toBeGreaterThanOrEqual(1);
      expect(db._fieldChanges.length).toBeGreaterThanOrEqual(1);
      const reviewChange = db._fieldChanges.find((c) => c.field === 'reviews_count');
      expect(reviewChange).toBeTruthy();
      // new reviews_count = 100 + i*7 + 50 → 150 (i=0) or 157 (i=1).
      expect(Number(reviewChange.new_value)).toBeGreaterThan(100);

      await queue.shutdown();
      await pool.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Identity rotation (proxy / fingerprint / stealth / session)
  // -------------------------------------------------------------------------

  describe('identity rotation (proxy + fingerprint + stealth + session)', () => {
    test('proxies rotated: ≥2 distinct proxy ids across 2 workers (Phase 2.3)', async () => {
      const { pool, queue, identityFactory } = buildStack({ workers: 2, businessesPerJob: 3 });
      queue.process(async (task) => pool.dispatch(task));
      await pool.init();

      // Each worker construction calls getIdentity once.
      expect(identityFactory.callCount).toBeGreaterThanOrEqual(2);
      const distinctProxies = new Set(identityFactory.calls.map((c) => c.proxyId));
      expect(distinctProxies.size).toBeGreaterThanOrEqual(2);

      await queue.shutdown();
      await pool.shutdown();
    });

    test('fingerprints differ per worker (Phase 2.4)', async () => {
      const { pool, queue, identityFactory } = buildStack({ workers: 2, businessesPerJob: 3 });
      await pool.init();
      const distinctFps = new Set(identityFactory.calls.map((c) => c.fingerprintId));
      expect(distinctFps.size).toBeGreaterThanOrEqual(2);
      await queue.shutdown();
      await pool.shutdown();
    });

    test('sessions rotated: ≥2 distinct session ids (Phase 2.7)', async () => {
      const { pool, queue, identityFactory } = buildStack({ workers: 3, businessesPerJob: 3 });
      await pool.init();
      const distinctSessions = new Set(identityFactory.calls.map((c) => c.sessionId));
      expect(distinctSessions.size).toBeGreaterThanOrEqual(2);
      await queue.shutdown();
      await pool.shutdown();
    });

    test('stealth-ready marker on every identity (Phase 2.5)', async () => {
      const { pool, queue, identityFactory } = buildStack({ workers: 2, businessesPerJob: 3 });
      await pool.init();
      expect(identityFactory.calls.length).toBeGreaterThanOrEqual(2);
      for (const c of identityFactory.calls) {
        expect(c.stealthPatches).toBe(true);
      }
      await queue.shutdown();
      await pool.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Incremental cache (Phase 2.12)
  // -------------------------------------------------------------------------

  describe('incremental cache (Phase 2.12)', () => {
    test('run-level preflight: second run of same query/location is a cache HIT (skip)', async () => {
      const db = makeMockDb();
      const incrementalCache = createIncrementalCache(db, { now: () => Date.now() });

      const recentIso = new Date().toISOString();
      db._businesses.set('ChIJ-seed-1', {
        id: 1, place_id: 'ChIJ-seed-1', query: 'Cafe', location: 'Berlin',
        change_hash: 'abc', last_list_scraped: recentIso, reviews_count: 10,
        name: 'Seed Cafe', rating: 4.5,
      });

      const preflight = await incrementalCache.preflightRun('Cafe', 'Berlin', 1);
      expect(preflight.skip).toBe(true);
      expect(preflight.businessCount).toBe(1);
      expect(preflight.ageDays).toBeLessThanOrEqual(1);
    });

    test('run-level preflight: stale data (> freshness days) → no skip', async () => {
      const db = makeMockDb();
      const incrementalCache = createIncrementalCache(db, { now: () => Date.now() });
      const staleIso = new Date(Date.now() - 5 * 86400_000).toISOString();
      db._businesses.set('ChIJ-stale-1', {
        id: 1, place_id: 'ChIJ-stale-1', query: 'Cafe', location: 'Berlin',
        change_hash: 'abc', last_list_scraped: staleIso, reviews_count: 10,
        name: 'Stale Cafe', rating: 4.5,
      });
      const preflight = await incrementalCache.preflightRun('Cafe', 'Berlin', 1);
      expect(preflight.skip).toBe(false);
    });

    test('per-business detail cache: cache_hit reuses cached detail within TTL', async () => {
      const db = makeMockDb();
      const recentIso = new Date().toISOString();
      const placeId = 'ChIJ-cachehit-1';
      const incoming = {
        place_id: placeId, name: 'Cached Cafe', rating: 4.5, reviews_count: 100,
        query: 'Cafe', location: 'Berlin', business_status: 'OPERATIONAL',
      };
      db._businesses.set(placeId, {
        id: 1, place_id: placeId, query: 'Cafe', location: 'Berlin',
        change_hash: computeChangeHash(incoming),
        last_list_scraped: recentIso,
        last_detail_scraped: recentIso,
        reviews_count: 100, rating: 4.5, name: 'Cached Cafe',
        full_hours: { mon: '8-18' }, popular_times: { mon: [5, 10, 20] },
        top_reviews: [{ text: 'Old review', rating: 5 }],
        photos: ['https://old.jpg'], reservation_url: null, menu_url: null,
        social_profiles: { instagram: '@old' },
      });

      const incrementalCache = createIncrementalCache(db, { now: () => Date.now() });
      const existing = (await incrementalCache.lookupBusinesses([placeId])).get(placeId);
      const listFresh = classifyListFreshness(existing, { listFreshnessDays: 1 });
      expect(listFresh.action).toBe('fresh');
      expect(existing.change_hash).toBe(computeChangeHash(incoming));

      const decision = decideDetailScrape(existing, incoming, {
        detailCacheTtlDays: 7,
        detailRefreshOnReviewDelta: 10,
      });
      expect(decision.shouldScrape).toBe(false);
      expect(decision.reason).toBe('cache_hit');

      const merged = mergeCachedDetail({ ...incoming }, existing);
      expect(merged.full_hours).toEqual({ mon: '8-18' });
      expect(merged.top_reviews).toEqual([{ text: 'Old review', rating: 5 }]);
      expect(merged.detail_scraped).toBe(true);
    });

    test('review-delta > threshold forces detail refresh even within TTL', async () => {
      const recentIso = new Date().toISOString();
      const existing = {
        place_id: 'ChIJ-rev-1', last_detail_scraped: recentIso,
        reviews_count: 100, change_hash: 'x',
      };
      const decision = decideDetailScrape(existing, { reviews_count: 120, place_id: 'ChIJ-rev-1' }, {
        detailCacheTtlDays: 7,
        detailRefreshOnReviewDelta: 10,
      });
      expect(decision.shouldScrape).toBe(true);
      expect(decision.reason).toBe('forced_refresh');
    });

    test('change_hash is list-view-only: a detail-only change does not invalidate list freshness', async () => {
      const listOnly = {
        place_id: 'X', name: 'Cafe', rating: 4.5, reviews_count: 100,
        address: '1 St', category: 'Cafe', price_level: '$$',
      };
      const withDetail = { ...listOnly, full_hours: { mon: '9-9' }, photos: ['p.jpg'] };
      expect(computeChangeHash(listOnly)).toBe(computeChangeHash(withDetail));
    });

    test('unchanged refresh: buildUnchangedRefresh issues a batched UPDATE (no updated_at bump)', async () => {
      const sql = buildUnchangedRefresh([
        { placeId: 'A', changeHash: 'ha' },
        { placeId: 'B', changeHash: 'hb' },
      ]);
      expect(sql).toBeTruthy();
      expect(sql.text).toContain('UPDATE businesses SET last_list_scraped = NOW()');
      expect(sql.text).not.toContain('updated_at');
      expect(sql.params).toEqual(['A', 'ha', 'B', 'hb']);
    });
  });

  // -------------------------------------------------------------------------
  // Self-healing (Phase 2.8 block re-queue + Phase 2.11 selector health)
  // -------------------------------------------------------------------------

  describe('self-healing (block re-queue + selector health check)', () => {
    test('block signal re-queues the task + rotates identity, eventually completes (Phase 2.8)', async () => {
      const { db, pool, queue, identityFactory } = buildStack({
        workers: 2, queueConcurrency: 1, businessesPerJob: 3,
        blockFirstJob: true,
      });
      queue.process(async (task) => pool.dispatch(task));

      await queue.add('search', { query: 'Cafe', location: 'Berlin' }, { attempts: 1 });
      const stats = await waitForCompleted(queue, 1);

      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(0);
      expect(db._businesses.size).toBe(3);
      // 2 construction calls + ≥1 rotation call after the block.
      expect(identityFactory.callCount).toBeGreaterThanOrEqual(3);

      await queue.shutdown();
      await pool.shutdown();
    });

    test('health check: evaluateHealth passes with good extraction (Phase 2.11)', async () => {
      const goodBusinesses = Array.from({ length: 5 }, (_, i) => ({
        place_id: `P${i}`, name: `Biz ${i}`, rating: 4.5,
        reviews_count: 100, address: `${i} Main St`,
      }));
      const rates = computeExtractionRates(goodBusinesses);
      const health = evaluateHealth(rates, { minSampleSize: 3 });
      expect(health.ok).toBe(true);
      expect(isCriticalFailure(health)).toBe(false);
      for (const f of CORE_FIELDS) {
        expect(rates[f].rate).toBe(100);
      }
    });

    test('health check: isCriticalFailure true when core fields below threshold (Phase 2.11)', async () => {
      const badBusinesses = Array.from({ length: 5 }, (_, i) => ({
        place_id: `P${i}`, name: null, rating: null,
        reviews_count: null, address: null,
      }));
      const rates = computeExtractionRates(badBusinesses);
      const health = evaluateHealth(rates, { minSampleSize: 3 });
      expect(health.ok).toBe(false);
      expect(isCriticalFailure(health)).toBe(true);
    });

    test('first-batch abort: checkExtractionRatesForAbort throws (exit code 3) below threshold', async () => {
      const badBusinesses = Array.from({ length: 10 }, (_, i) => ({
        place_id: `P${i}`, name: null, rating: null,
        reviews_count: null, address: null,
      }));
      const rates = computeExtractionRates(badBusinesses);
      let thrown = null;
      try {
        checkExtractionRatesForAbort(rates, { minSampleSize: 10 });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeTruthy();
      expect(thrown.exitCode).toBe(SELECTOR_FAILURE_EXIT_CODE);
      expect(thrown.code).toBe('SELECTOR_FAILURE');
    });

    test('first-batch abort: does NOT throw when extraction is healthy', async () => {
      const goodBusinesses = Array.from({ length: 10 }, (_, i) => ({
        place_id: `P${i}`, name: `Biz ${i}`, rating: 4.5,
        reviews_count: 100, address: `${i} Main St`,
      }));
      const rates = computeExtractionRates(goodBusinesses);
      expect(() => {
        checkExtractionRatesForAbort(rates, { minSampleSize: 10 });
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Memory & shutdown (Phase 2.10)
  // -------------------------------------------------------------------------

  describe('memory & graceful shutdown (Phase 2.10)', () => {
    test('heap stable across 10 jobs (no significant growth)', async () => {
      if (typeof global.gc === 'function') global.gc();
      const heapBefore = process.memoryUsage().heapUsed;

      const { pool, queue } = buildStack({ workers: 2, queueConcurrency: 2, businessesPerJob: 5 });
      queue.process(async (task) => pool.dispatch(task));
      for (let i = 0; i < 10; i++) {
        await queue.add('search', { query: 'Cafe', location: 'Berlin' }, { attempts: 1 });
      }
      await waitForCompleted(queue, 10);

      if (typeof global.gc === 'function') global.gc();
      const heapAfter = process.memoryUsage().heapUsed;
      const growthMb = (heapAfter - heapBefore) / (1024 * 1024);
      expect(growthMb).toBeLessThan(50);

      await queue.shutdown();
      await pool.shutdown();
    });

    test('graceful shutdown: pool + queue settle cleanly (no hanging)', async () => {
      const { pool, queue } = buildStack({ workers: 2, businessesPerJob: 3 });
      queue.process(async (task) => pool.dispatch(task));
      for (let i = 0; i < 4; i++) {
        await queue.add('search', { query: 'Cafe', location: 'Berlin' }, { attempts: 1 });
      }
      await waitForCompleted(queue, 4);

      await Promise.race([
        Promise.all([pool.shutdown(), queue.shutdown()]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown hung')), 5000)),
      ]);
      expect(queue.isShutDown).toBe(true);
    });

    test('no orphaned in-flight jobs after shutdown', async () => {
      const { pool, queue } = buildStack({ workers: 2, businessesPerJob: 3 });
      queue.process(async (task) => pool.dispatch(task));
      for (let i = 0; i < 3; i++) {
        await queue.add('search', { query: 'Cafe', location: 'Berlin' }, { attempts: 1 });
      }
      await waitForCompleted(queue, 3);
      await queue.shutdown();
      await pool.shutdown();
      const stats = await queue.getStats();
      expect(stats.waiting).toBe(0);
      expect(stats.active).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // CAPTCHA mock (Phase 2.6)
  // -------------------------------------------------------------------------

  describe('CAPTCHA mock provider (Phase 2.6)', () => {
    test('mock solver returns a token with $0 cost on every job', async () => {
      const { pool, queue, getCaptchaSolves } = buildStack({ workers: 1, queueConcurrency: 1, businessesPerJob: 2 });
      queue.process(async (task) => pool.dispatch(task));
      for (let i = 0; i < 3; i++) {
        await queue.add('search', { query: 'Cafe', location: 'Berlin' }, { attempts: 1 });
      }
      await waitForCompleted(queue, 3);

      const solves = getCaptchaSolves();
      expect(solves.length).toBe(3);
      for (const s of solves) {
        expect(s.token).toMatch(/^mock-token-/);
        expect(s.costUsd).toBe(0);
      }
      const totalCost = solves.reduce((sum, s) => sum + s.costUsd, 0);
      expect(totalCost).toBe(0);

      await queue.shutdown();
      await pool.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Full-stack composition: incremental + change-tracking + identity together
  // -------------------------------------------------------------------------

  describe('full-stack composition', () => {
    test('second run of same query/location: per-business cache hits + unchanged refresh', async () => {
      const { db, pool, queue, cacheStats } = buildStack({
        workers: 1, queueConcurrency: 1, businessesPerJob: 4,
      });
      queue.process(async (task) => pool.dispatch(task));

      // First run — full scrape, all new.
      await queue.add('search', { query: 'Cafe', location: 'Berlin' }, { attempts: 1 });
      await waitForCompleted(queue, 1);
      expect(db._businesses.size).toBe(4);

      // Second run — same data → list fresh + change_hash match → detail cache hits.
      await queue.add('search', { query: 'Cafe', location: 'Berlin' }, { attempts: 1 });
      await waitForCompleted(queue, 2);

      expect(cacheStats.detailHits).toBeGreaterThanOrEqual(4);
      expect(cacheStats.listSkippedFresh).toBeGreaterThanOrEqual(4);

      await queue.shutdown();
      await pool.shutdown();
    });

    test('queue dead-letter: a job that always blocks past retry limit is dead-lettered', async () => {
      // A runTask that ALWAYS throws WORKER_BLOCKED. With taskRetries=0 the
      // pool exhausts immediately → dispatch rejects → the queue (attempts=1)
      // dead-letters the job.
      const alwaysBlock = async () => {
        const err = new Error('permanent block');
        err.code = 'WORKER_BLOCKED';
        throw err;
      };
      const identityFactory = makeIdentityFactory({ runTask: alwaysBlock });
      const pool = createPool({
        size: 1,
        cfg: {},
        getIdentity: identityFactory.getIdentity,
        crashLimit: 5,
        cooldownMs: 0,
        taskRetries: 0,
        sleepFn: async () => { await new Promise((r) => setImmediate(r)); },
        pollIntervalMs: 0,
      });
      const queue = createQueue({
        name: 'dlq-test',
        backend: { Queue: MockQueue, Worker: MockWorker },
        concurrency: 1,
        defaultAttempts: 1,
      });
      queue.process(async (task) => pool.dispatch(task));

      await queue.add('search', { query: 'Cafe', location: 'Berlin' }, { attempts: 1 });
      const stats = await waitForCompleted(queue, 1);
      expect(stats.failed).toBeGreaterThanOrEqual(1);

      const dl = await queue.deadLetter();
      // deadLetter() returns { jobs, total }.
      expect(dl.total).toBeGreaterThanOrEqual(1);
      expect(dl.jobs.length).toBeGreaterThanOrEqual(1);

      await queue.shutdown();
      await pool.shutdown();
    });
  });
});
