Scraper — System Architecture (Phase 2)

# Architecture

The Scraper is a Playwright-based Google Maps business extractor written in
Node/Bun. It searches a (query, location) pair on Google Maps, scrolls the
results feed, extracts the canonical list-view fields, optionally deep-scrapes
each detail panel for hours/reviews/photos, and persists everything to
PostgreSQL with per-run snapshots and field-level change tracking. The Phase 2
goal — stated in `PHASE2_EXECUTION_PLAN.md` — is a single machine that survives
a 10,000+ listing overnight run unattended: rotating proxies, randomized
fingerprints, stealth patches, session rotation, CAPTCHA auto-solving, a worker
pool, a BullMQ-backed job queue, memory management with zombie reaping,
self-healing selectors, and a two-tier incremental cache. Twelve of thirteen
Phase 2 sub-phases (2.0 through 2.12) are shipped; Phase 2.13 is the
integration, docs, and handoff phase this document belongs to.

## High-Level Pipeline

```
 ┌─────────────────┐   ┌──────────────────┐   ┌──────────────────────────┐
 │ CLI / .env      │──▶│ main()           │──▶│ run-level preflight      │
 │ src/config.js   │   │ src/index.js     │   │ (Phase 2.12 incremental) │
 └─────────────────┘   └──────────────────┘   └─────────────┬────────────┘
                                                            │ cache miss
                                                            ▼
                          ┌──────────────────────────────────────────────┐
                          │ Startup health check (Phase 2.11)            │
                          │ src/selectors/health-check.js → abort ex 3   │
                          └──────────────────────┬───────────────────────┘
                                                 │
              ┌──────────────────────────────────┴──────────────────────────┐
              │  --queue off (default)              --queue on              │
              │  runWithPool()                      runWithQueue()          │
              │  src/index.js                       src/index.js            │
              └────────────┬──────────────────────────────────┬─────────────┘
                           │                                  │
                           ▼                                  ▼
                  ┌────────────────┐                 ┌────────────────────┐
                  │ Worker Pool    │  pool.dispatch  │ BullMQ Queue       │
                  │ src/pool.js    │◀────────────────│ src/queue/index.js │
                  │ (N workers)    │  queue.process  │ job-types.js       │
                  └───────┬────────┘                 └────────────────────┘
                          │ one task at a time per worker
                          ▼
                  ┌────────────────┐    getIdentity / rotateIdentity
                  │ Worker         │◀─────────────────────────────────────┐
                  │ src/worker.js  │                                       │
                  └───────┬────────┘                                       │
                          │                                                │
                          ▼                                                │
  ┌─────────────────────────────────────────────────────────────────┐      │
  │ Browser identity stack (one COHERENT identity per worker)       │      │
  │  proxy.js  →  fingerprint.js  →  stealth-patches.js  →  session │──────┘
  │  (Phase 2.3)    (Phase 2.4)        (Phase 2.5)         (2.7)   │
  └──────────────────────────┬──────────────────────────────────────┘
                             │ Playwright Chromium
                             ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ Scrape pipeline (per worker, per task)                          │
  │  search.js  →  scroll.js  →  extract.js  →  detail.js           │
  │  (Phase 1.2)    (1.3)         (1.4)         (1.5 + 2.7 hook)    │
  │  CAPTCHA hook: src/captcha/orchestrator.js (Phase 2.6)          │
  │  Self-healing selectors: src/selectors/* (Phase 2.11)           │
  └──────────────────────────┬──────────────────────────────────────┘
                             │ businesses[]
                             ▼
  ┌─────────────────────────────────────────────────────────────────┐
  │ Persistence + change tracking + incremental cache               │
  │  src/db.js  →  PostgreSQL (businesses, scrape_runs,             │
  │  src/db/deltas.js     business_snapshots, field_changes)        │
  │  src/db/history.js    + Phase 2.12 columns:                     │
  │  src/incremental.js     last_list_scraped /                     │
  │                         last_detail_scraped / change_hash       │
  └──────────────────────────┬──────────────────────────────────────┘
                             │
                             ▼
                  ┌────────────────────┐
                  │ Export + summary   │
                  │ src/export.js      │  CSV / JSON / summary.json
                  └─────────┬──────────┘
                            │
                            ▼
                  ┌────────────────────┐
                  │ Health monitoring  │  memory monitor + worker probe
                  │ src/health/*       │  + zombie reaper + degradation
                  │ HTTP GET /health   │  + node:http server
                  └────────────────────┘
```

The orchestrator (`src/index.js`) supports two execution modes that share the
same worker pool, identity stack, and persistence layer. **In-process mode**
(`--queue off`, the default) calls `runWithPool()`: a `Pool` of N `Worker`s
(`src/pool.js` + `src/worker.js`, Phase 2.8) runs the search task and any
detail tasks inline within the lifetime of one `main()` invocation; with
`--workers 1` it reduces byte-for-byte to the Phase 1 sequential pipeline.
**Queue-backed mode** (`--queue on`, Phase 2.9) calls `runWithQueue()` which
constructs the same pool and then layers a BullMQ adapter (`src/queue/`) on
top: the search job is submitted to Redis, `queue.process` is wired to
`pool.dispatch(task)`, and BullMQ owns retries, backoff, priority, and the
dead-letter queue. Queue mode is what `--endless` (Phase 2.10) and
`npm run batch` (Phase 2.9) use for long unattended runs; in-process mode is
the zero-infra path that needs neither Redis nor Docker.

## Module Map

| Subsystem | Module | Purpose |
|---|---|---|
| Core orchestration | `src/index.js` | CLI entry point; wires config → preflight → health check → pool/queue → export → summary. |
| Core orchestration | `src/config.js` | Resolves config from CLI args → env vars → `.env` → defaults; validates and fails fast. |
| Core orchestration | `src/banner.js` | Builds + prints the resolved-config startup banner before any browser launch. |
| Core orchestration | `src/logger.js` | Dual-sink structured logger (console + JSON-lines file) with `phase` tags. |
| Core orchestration | `src/checkpoint.js` | Phase 1.7 crash-recovery checkpoint (`.checkpoint.json`) for resume. |
| Core orchestration | `src/retry.js` | `withRetry` exponential backoff wrapper used across search/scroll/detail. |
| Browser & stealth | `src/browser.js` | Launches Playwright Chromium with proxy + fingerprint + stealth options. |
| Browser & stealth | `src/antiblock.js` | UA list, `humanType`, `RateLimiter`, CAPTCHA text detection, block watcher. |
| Browser & stealth | `src/fingerprint.js` | Phase 2.4 coherent fingerprint generation (UA + platform + viewport + tz + WebGL + canvas noise). |
| Browser & stealth | `src/stealth-patches.js` | Phase 2.5 Maps-specific stealth (webdriver, chrome.runtime, plugins, permissions). |
| Concurrency | `src/pool.js` | Phase 2.8 worker pool: round-robin/least-busy dispatch, block cooldown, crash-limit retirement, task re-queue. |
| Concurrency | `src/worker.js` | Phase 2.8 worker: idle/busy/cooldown/retired state machine, `rotateIdentity`, per-worker stats. |
| Concurrency | `src/queue/index.js` | Phase 2.9 BullMQ adapter (DI backend): add/addBatch/process/getStatus/pause/resume/dead-letter. |
| Concurrency | `src/queue/job-types.js` | Job registry: `search`, `detail-batch`, `enrich`; validators + priority bands. |
| Concurrency | `src/queue/mock-backend.js` | In-memory MockQueue/MockWorker/MockJob mirroring BullMQ for unit tests (no Redis). |
| Concurrency | `src/queue/dead-letter.js` | List/get/retry/retryAll/remove/clear/count over failed jobs. |
| Persistence & data | `src/db.js` | Phase 2.1 `pg` layer: `createPool`, batched idempotent upserts, `data_hash`, run persistence. |
| Persistence & data | `src/db/schema.sql` | DDL for `businesses`, `scrape_runs`, `business_snapshots`, `field_changes` + Phase 2.12 columns. |
| Persistence & data | `src/db/migrate.js` | `npm run db:migrate` runner (idempotent `IF NOT EXISTS` everywhere). |
| Persistence & data | `src/db/deltas.js` | Phase 2.2 pure helpers: `computeChanges`, `numericDelta` (rating/reviews/status/phone/website). |
| Persistence & data | `src/db/history.js` | Phase 2.2 `npm run db:history` CLI for a single business's snapshot + change timeline. |
| Incremental & caching | `src/incremental.js` | Phase 2.12 two-tier cache: `computeChangeHash`, `classifyListFreshness`, `decideDetailScrape`, `mergeCachedDetail`, `createIncrementalCache`, `CacheStats`. |
| Health & resilience | `src/health/index.js` | Phase 2.10 barrel + `createHealthStack` orchestrator. |
| Health & resilience | `src/health/memory-monitor.js` | Polls `process.memoryUsage`; fires threshold callback; high-water mark tracking. |
| Health & resilience | `src/health/worker-probe.js` | Detects per-worker heap bloat / stuck / unresponsive; corrective callback. |
| Health & resilience | `src/health/zombie-reaper.js` | Kills orphaned Chromium on startup/shutdown (DI `listPids`/`killPid`). |
| Health & resilience | `src/health/degradation.js` | RSS-pressure recovery: pause queue → restart contexts → gc → reduce pool. |
| Health & resilience | `src/health/server.js` | `node:http` GET `/health` JSON snapshot (200 ok/degraded, 503 unhealthy). |
| Selectors | `src/selectors/index.js` | Phase 2.11 barrel export. |
| Selectors | `src/selectors/version.js` | Selector version registry + 30-day staleness warning. |
| Selectors | `src/selectors/health-check.js` | Startup fixture health check (abort exit 3 if core < 50%). |
| Selectors | `src/selectors/auto-discover.js` | Heuristic DOM discovery for phone/website/rating/reviews_count. |
| Selectors | `src/selectors/debug-dump.js` | Writes 500-char card HTML snippets for low-rate fields. |
| Selectors | `src/extract.js` | Phase 1.4 list-view extractor; owns `CORE_FIELDS`, `checkExtractionRatesForAbort`, first-batch abort. |
| Captcha | `src/captcha/index.js` | Phase 2.6 barrel. |
| Captcha | `src/captcha/solver.js` | Provider abstraction (2captcha/anticaptcha/capsolver/mock/none) + `BudgetGuard`. |
| Captcha | `src/captcha/orchestrator.js` | `handleCaptcha` pipeline entry: detect → solve → inject → retry → pause-and-alert. |
| Captcha | `src/captcha/injector.js` | Pure DOM token injection + callback trigger (reCAPTCHA v2). |
| Captcha | `src/captcha/cost-log.js` | JSONL cost log + end-of-run summary. |
| Session | `src/session/index.js` | Phase 2.7 barrel. |
| Session | `src/session/manager.js` | Rotation engine: maxRequests OR maxAgeMs, `shouldRotate`, `rotate`, `tickRequest`. |
| Session | `src/session/warmup.js` | Benign pre-Maps visits (google.com, news, random top-100 site). |
| Session | `src/session/account-warmup.js` | Opt-in Google account login (credentials never logged, email redacted). |
| Session | `src/session/context-factory.js` | Production `createContext` bridge: `browser.newContext` + fingerprint + stealth. |
| Proxy | `src/proxy.js` | Phase 2.3 proxy pool: round-robin/random/sticky, burn, health check, stats. |
| Proxy | `src/proxy/burn-detector.js` | Pure per-proxy health tracking + burn thresholds (3×403/429, <50% success, 3× timeout). |
| Scrape primitives | `src/search.js` | Phase 1.2 Maps navigation + search input + feed detection. |
| Scrape primitives | `src/scroll.js` | Phase 1.3 feed pagination via lazy-load scrolling. |
| Scrape primitives | `src/detail.js` | Phase 1.5 detail-panel deep-scrape + Phase 2.7 session-check hook. |
| Utilities | `src/export.js` | Phase 1.6 CSV (RFC 4180) + JSON + summary.json writer. |

## Request Lifecycle

A single search job flows through the system in the following order:

1. **Config load** — `src/config.js` parses CLI args, layers env vars + `.env`
   on top, validates (e.g. `--incremental` requires `--output db`,
   `--queue on` requires `REDIS_URL`, `--endless` requires `--queue on`), and
   fails fast with a clear message on any conflict.
2. **Logger + banner** — `src/logger.js` opens the JSON-lines log file;
   `src/banner.js` prints the resolved config and waits 1s (skip with `--yes`).
3. **Shared infrastructure** — proxy pool (`src/proxy.js`), shared `pg.Pool`
   (when `--output db`), CAPTCHA solver + budget guard + cost logger
   (`src/captcha/*`), session manager factory, and the `CacheStats`
   accumulator are constructed once and reused by every worker.
4. **Run-level incremental preflight (Phase 2.12)** — when `--incremental` is
   on, `incrementalCache.preflightRun(query, location, listFreshnessDays)`
   checks the most recent successful scrape of this (query, location). If it
   is within `--listFreshnessDays`, the browser is skipped entirely: cached
   businesses are loaded from PostgreSQL, a minimal `result` object is
   synthesized, and the run jumps straight to export. Acceptance criterion:
   ~0 requests, runtime < 30s.
5. **Startup health check (Phase 2.11)** — unless skipped via
   `--skipHealthCheck` or a preflight cache hit, `selectors.healthCheck` loads
   a known-good fixture HTML into a separate browser context, runs
   `extractBusinesses`, and confirms core fields (name, rating,
   reviews_count, address) extract at ≥ 50%. Failure aborts the run with
   `SELECTOR_FAILURE_EXIT_CODE` (3).
6. **Browser launch with identity** — `runWithPool()` (or `runWithQueue()`)
   calls `pool.getIdentity()` per worker, which pulls a proxy
   (`proxyPool.acquire`), generates a fingerprint (`fingerprint.js`), and
   constructs a session manager. `src/session/context-factory.js` calls
   `browser.newContext` with the proxy + fingerprint + stealth init scripts.
7. **Warmup + search** — `src/session/warmup.js` optionally visits benign
   pages; `src/search.js` navigates to Google Maps, types the query with
   `humanType`, and waits for the results feed.
8. **Scroll / paginate** — `src/scroll.js` scrolls the feed to the bottom
   (capped by `--maxResults`, end-of-list marker, stall detection, or total
   timeout), loading lazy results.
9. **Extract list-view** — `src/extract.js` runs each card through multiple
   fallback selectors per field, normalizes values, and tags sponsored /
   closed entries.
10. **First-batch abort check (Phase 2.11)** — after the first 10 businesses,
    `checkExtractionRatesForAbort` re-checks core field rates; if below 50%,
    it throws `SelectorFailureError` (exit 3) so the operator knows the DOM
    changed mid-run rather than burning a 10k request budget on garbage.
11. **Detail deep-scrape with per-business detail cache (Phase 2.12)** — for
    each business, `incrementalCache.lookupBusinesses(placeIds)` returns the
    cached `last_list_scraped` / `last_detail_scraped` / `change_hash`.
    `decideDetailScrape` returns one of:
    - `cache_hit` — list fresh AND `change_hash` matches AND detail within
      `--detailCacheTtlDays` → `mergeCachedDetail` reuses cached hours /
      reviews / photos, `detail_scraped=true`, deep-scrape skipped.
    - `forced_refresh` — review-delta `--detailRefreshOnReviewDelta` (default
      10%) exceeded even within TTL → deep-scrape runs.
    - `cache_miss` — TTL expired or no prior detail → deep-scrape runs.
    - `no_cache` — `--noDetailCache` or `--incremental` off → deep-scrape
      runs unconditionally.
    `src/detail.js` opens the detail panel, extracts hours/reviews/photos,
    runs the `sessionCheck` hook (Phase 2.7 mid-scrape rotation if the session
    exceeded `--sessionMaxRequests` / `--sessionMaxAgeMs`), and returns to
    the list.
12. **Upsert + change tracking (Phase 2.1 / 2.2)** —
    `db.upsertBusinessesBatch` writes the batch (default 50 rows/round-trip)
    inside one transaction. Per-row outcome is `inserted` / `updated` /
    `unchanged` (the last detected via `data_hash` equality, no `updated_at`
    bump). On `updated`, a `business_snapshots` row captures the pre-update
    high-value fields and `field_changes` rows record per-field deltas
    (rating/reviews_count/business_status/phone/website).
13. **Incremental freshness refresh (Phase 2.12)** — for `unchanged` rows,
    `db.buildUnchangedRefresh` issues a single batched `VALUES`-table UPDATE
    of `last_list_scraped` + `change_hash` WITHOUT touching `updated_at`
    (preserving the Phase 2.1 idempotency contract). For rows that
    deep-scraped, `last_detail_scraped` is bumped to `NOW()`.
14. **Run summary** — `scrape_runs` row is finalized (extracted, failed,
   db_inserted, db_updated, db_unchanged, changes_detected, finished_at).
   `src/export.js` writes CSV + JSON + summary.json. The end-of-run banner
   prints selector stats, session stats, CAPTCHA cost, incremental cache
   stats, and exit code 0.

## Identity Stack

Each worker owns one **coherent** browser identity, composed of four layers
that address different detection surfaces. They never contradict each other:

- **Proxy rotation (Phase 2.3, `src/proxy.js` + `src/proxy/burn-detector.js`)**
  — `proxyPool.acquire()` returns a proxy chosen by `--proxyStrategy`
  (`random` default, `round-robin`, or `sticky` for N requests per proxy via
  `--sessionLength`). The burn detector benches a proxy on three consecutive
  403/429s, < 50% success over 20 requests, or three consecutive timeouts;
  HTTP 407 / provider-reported retirement is permanent. Benched proxies sit
  out for `--proxyCooldownMs` (default 10 min) before lazy revival.
- **Fingerprint (Phase 2.4, `src/fingerprint.js`)** — generates a randomized
  but coherent fingerprint: UA + platform (Win32 / MacIntel / Linux x86_64) +
  viewport + screen + timezone + locale + language chain + WebGL
  vendor/renderer pair + canvas noise + hardwareConcurrency + deviceMemory +
  geolocation. Coherence is enforced (e.g. a Windows UA always pairs with
  Win32 and an American locale with an American timezone). Injected via
  `context.addInitScript` in `src/session/context-factory.js`.
- **Stealth patches (Phase 2.5, `src/stealth-patches.js`)** — ten
  automation-surface overrides applied as a second init script:
  `navigator.webdriver`, `chrome.runtime`, `plugins`, `permissions`,
  `outerWidth/Height`, `Notification.permission`, `vendor`,
  `maxTouchPoints`, plus launch arg `--disable-blink-features=AutomationControlled`.
  Stealth touches properties the fingerprint script never touches; the only
  overlap (`navigator.languages`, WebGL `getParameter`) yields to the
  fingerprint values when both are present.
- **Session / cookie rotation (Phase 2.7, `src/session/*`)** — each context
  starts with zero cookies. The manager rotates when EITHER
  `--sessionMaxRequests` OR `--sessionMaxAgeMs` is exceeded (whichever
  first). Optional `--warmup` visits google.com + a random second site + a
  benign search before Maps so the session has browsing history.
  `--accountWarmup` (off by default) logs into a burner Google account;
  credentials are never logged and email is redacted.

**Composition and rotation:** `pool.getIdentity()` (in `src/index.js`) pulls
a fresh proxy + fingerprint + session manager tuple when a worker is created.
On a block, `worker.markBlocked()` puts the worker into `cooldown` and the
pool calls `worker.rotateIdentity({ proxy, fingerprint, sessionManager })` so
the next task launches with a brand-new identity; the blocked task is
re-queued to a *different* worker (the original is cooling down). On a crash,
`worker.markCrashed()` records a timestamp; if crash count in the 10-minute
window reaches `--workerCrashLimit` the worker is `retired` permanently,
otherwise `rotateIdentity` is called and the task re-queued. `--workerProxyStrategy`
`shared` lets all workers pull from the same proxy pool; `isolated` (default)
gives each worker a sticky proxy for its lifetime.

## Concurrency Model

**Worker pool (Phase 2.8, `src/pool.js` + `src/worker.js`)** — a `Pool`
manages N `Worker`s (default `--workers 1`, which preserves the Phase 1
sequential pipeline byte-for-byte). Each worker is one isolated scrape unit
with its own identity + rate limiter, and runs one serializable task
(`search-task` / `detail-task` / `resume-task`) at a time. Worker states:
`idle` → `busy` → (`cooldown` | `retired`). Load balancing is `round-robin`
(default) or `least-busy` (`--workerLoadBalancer`); both only consider
available workers (idle + cooldown elapsed + not retired). Acquisition is
race-free. Self-healing:

- **Block** (`runTask` throws `{ code: 'WORKER_BLOCKED' }`) — worker enters
  cooldown for `--workerCooldownMs` (default 5 min), `rotateIdentity()` swaps
  in a fresh proxy + fingerprint + session, the task is re-queued to another
  worker, the original `dispatch()` promise resolves when the task eventually
  completes, and the worker is lazy-revived to `idle` after cooldown.
- **Crash** (any other thrown error) — worker increments `crashes`, records a
  timestamp; if `crashCountInWindow >= --workerCrashLimit` (default 3) it is
  `retired`, otherwise `rotateIdentity()` + re-queue.
- **Task retries** — `--workerTaskRetries` (default = `--workers`) caps how
  many times a task can bounce between workers before it is failed.

`pool.dispatchBatchSettled(tasks)` runs up to `size` tasks in parallel and
waits for all to settle; `pool.stats()` returns per-worker + aggregate
counters; `pool.shutdown()` gracefully finishes in-flight tasks.

**Queue (Phase 2.9, `src/queue/*`)** — `createQueue` is an adapter over
BullMQ (production, real Redis) or the in-memory `MockQueue`/`MockWorker`
(tests, no Redis — an explicit acceptance criterion). Three job types:
`search` (one per CSV row, top-level), `detail-batch` (deep-scrape a batch of
already-extracted businesses by id or in-memory record), and `enrich` (Phase
3 placeholder — accepted but no-op). Each type has a schema validator that
fails fast on bad payloads so garbage never reaches Redis. Priority bands:
1=high, 5=normal, 10=low (`--queuePriority`). Retries with exponential
backoff (`--queueAttempts` default 3); after exhaustion, jobs land in the
dead-letter surface (`src/queue/dead-letter.js`) which exposes
list/get/retry/retryAll/remove/clear/count.

**How the queue feeds the pool** — in `runWithQueue()`, `queue.process` is
wired to an async `(task) => pool.dispatch(task)` function. BullMQ converts
each incoming job's payload to a task via `JOB_TYPES[type].toTask`, hands it
to the processor, the processor dispatches it to the pool, and the pool's
return value (`{ businesses, scrollResult, extractionRates, extractStats }`)
becomes the job's result, which BullMQ persists. The `search` job's
completion can fan out `detail-batch` jobs. Because jobs persist in Redis,
crashing the Node process does not lose work — restarting re-attaches to the
queue and resumes.

## Persistence & Change Tracking

PostgreSQL schema (`src/db/schema.sql`, migrated via `npm run db:migrate`):

- **`businesses`** — one row per scraped business, keyed by `place_id`
  (Google's stable identifier). Holds the 17 Phase 1.4 list-view fields, 8
  Phase 1.5 detail JSONB fields (`full_hours`, `popular_times`, `top_reviews`,
  `photos`, `reservation_url`, `menu_url`, `social_profiles`,
  `detail_scraped`), `data_hash` (Phase 2.1), `run_id` FK, `updated_at`, and
  the three Phase 2.12 columns `last_list_scraped`, `last_detail_scraped`,
  `change_hash`.
- **`scrape_runs`** — one row per pipeline invocation: query, location,
  started_at, finished_at, extracted, failed, exit_code, log_path,
  `db_inserted`/`db_updated`/`db_unchanged` (Phase 2.1), and
  `changes_detected` (Phase 2.2).
- **`business_snapshots`** (Phase 2.2) — pre-update snapshot of high-value
  fields captured the moment before an UPDATE overwrites them, inside the
  same transaction. Indexed by `(business_id, snapshot_at DESC)` and
  `place_id` for the `db:history` CLI.
- **`field_changes`** (Phase 2.2) — computed, queryable per-field delta log:
  one row per field that actually changed in a given update, with a numeric
  `delta` column for `rating` / `reviews_count`. Powers
  `npm run db:history -- --placeId ChIJxxx`.

**Upsert idempotency (Phase 2.1):** `db.upsertBusinessesBatch` writes a
batch (default 50 rows/round-trip) inside one transaction. For each row, the
comparable field values are SHA-256-hashed into `data_hash`; on conflict
(`place_id`), the existing `data_hash` is compared: equal → `unchanged` (no
`updated_at` bump), different → snapshot the old row + `UPDATE` + record
`field_changes` (→ `updated`). New `place_id` → `INSERT` (→ `inserted`).
Parameterized queries everywhere — no SQL injection surface.

**Two hashes — why:** the schema carries two distinct SHA-256 columns on
`businesses`:

- **`data_hash`** (Phase 2.1) — hash of the full comparable row INCLUDING
  detail JSONB. Used to detect "did anything at all change?" for the upsert
  idempotency decision (inserted / updated / unchanged) and to avoid bumping
  `updated_at` on identical re-scrapes.
- **`change_hash`** (Phase 2.12) — hash of the LIST-VIEW fields ONLY (name,
  rating, reviews_count, price_level, category, address, phone, website,
  maps_url, plus_code, business_status, is_sponsored, scraped_at, query,
  location). Used by the incremental cache: if `change_hash` matches on
  re-scrape AND `last_list_scraped` is within `--listFreshnessDays`, the
  business is treated as "fresh + unchanged" and the detail deep-scrape is
  skipped entirely.

The split is deliberate: a detail-only change (new reviews, updated hours)
does NOT invalidate list freshness, so the expensive detail-panel deep-scrape
is only triggered when the list-view itself actually changed or when the
review-delta heuristic fires.

## Incremental Cache

Phase 2.12 (`src/incremental.js`) implements a two-tier cache that converts
repeated runs of the same (query, location) into near-zero-cost operations.

**Tier 1 — run-level preflight.** Before any browser launches,
`incrementalCache.preflightRun(query, location, listFreshnessDays)` queries
the most recent successful scrape of this exact (query, location) pair. If
its `last_list_scraped` is within `--listFreshnessDays` (default 1 day), the
browser is skipped entirely: `loadBusinessesForRun` reads the cached
businesses from PostgreSQL, a minimal `result` object is synthesized, and
the run proceeds straight to export. Acceptance criterion: 100% cache hits,
~0 requests, runtime < 30s for 1000 cached businesses.

**Tier 2 — per-business detail cache.** After the list-view scrape,
`incrementalCache.lookupBusinesses(placeIds)` returns the cached
`last_list_scraped` / `last_detail_scraped` / `change_hash` for every
business found. For each business, `classifyListFreshness` returns
`new` / `fresh` / `stale`, and `decideDetailScrape` returns one of four
decisions:

- `cache_hit` — list fresh AND `change_hash` matches AND
  `last_detail_scraped` within `--detailCacheTtlDays` (default 7) →
  `mergeCachedDetail` copies the cached `full_hours` / `popular_times` /
  `top_reviews` / `photos` / `reservation_url` / `menu_url` /
  `social_profiles` into the live record, sets `detail_scraped=true`, and
  `deepScrapeAll` skips this business entirely.
- `forced_refresh` — `reviewDeltaPct(old, new)` exceeds
  `--detailRefreshOnReviewDelta` (default 10%) even within TTL → deep-scrape
  runs. Only positive deltas trigger (a review surge is a signal that other
  detail fields likely changed too).
- `cache_miss` — TTL expired or no prior detail scrape → deep-scrape runs.
- `no_cache` — `--noDetailCache` set OR `--incremental` off → deep-scrape
  runs unconditionally (Phase 1.5 behavior preserved).

`CacheStats` accumulates per-tier counts + an estimated-savings figure
(skipped requests × average detail-scrape cost) that the end-of-run banner
prints as an `Incremental` block. Unchanged businesses get a lightweight
batched `last_list_scraped` + `change_hash` refresh via
`db.buildUnchangedRefresh` WITHOUT touching `updated_at`. `--swrr` is
stubbed for Phase 5.

## Health & Self-Healing

Phase 2.10 (`src/health/*`) adds the long-run stability layer; Phase 2.11
(`src/selectors/*`) adds selector self-healing. They are bundled by
`createHealthStack` in `src/health/index.js`.

- **Memory monitor** (`memory-monitor.js`) — polls `process.memoryUsage()`
  every `--healthCheckIntervalMs`, tracks the all-time heap + RSS
  high-water mark, and fires an `onThreshold` callback when `heapUsed`
  crosses `--maxHeapMb` (default 1024). Fully DI (no real `setInterval` in
  tests).
- **Worker probe** (`worker-probe.js`) — inspects every worker every 60s for
  three failure modes: heap bloat (per-worker heap > `--maxHeapMb`),
  stuck (busy for > 10 min), and unresponsive (3 consecutive `page.evaluate`
  timeouts). Each triggers a corrective callback (restart context / kill +
  re-queue / kill + restart).
- **Zombie reaper** (`zombie-reaper.js`) — `reapOnStartup` scans for
  orphaned Chromium processes left by a previous crashed run and kills them
  (SIGTERM → SIGKILL escalation); `reapOnShutdown` runs from the SIGINT
  handler + the main `finally` block so no orphaned Chromium survives.
  Process discovery is DI (`pgrep -f chromium` default); tests inject
  `listPids`/`killPid` and never touch the OS.
- **Degradation** (`degradation.js`) — when total RSS crosses `--maxRssMb`
  (default 4096), orchestrates: pause queue → wait for in-flight tasks →
  restart every worker's browser context → optional `global.gc()` (if
  `--expose-gc`) → resume queue → if still over threshold, retire one worker
  (shed load). DI pause/resume/restart/reducePool functions.
- **HTTP `/health`** (`server.js`) — `node:http` server (no Express) bound
  on `--healthHost`:`--healthPort`. Returns JSON snapshot: status
  (`ok`/`degraded`/`unhealthy`), uptime, heap, workers, queueDepth, endless.
  200 for ok/degraded, 503 for unhealthy. Disabled with `--noHealthServer`.
- **Self-healing selectors (Phase 2.11)** — five layers:
  1. **Version registry** (`version.js`) — every selector set has a version
     + `lastVerifiedDate`; startup logs the active version and warns when a
     set is older than `--maxSelectorAge` (default 30 days).
  2. **Startup health check** (`health-check.js`) — loads a known-good
     fixture HTML, runs `extractBusinesses`, aborts with exit code 3 if core
     fields extract below 50% (bypass with `--skipHealthCheck`).
  3. **First-batch abort** (`extract.js → checkExtractionRatesForAbort`) —
     after the first 10 businesses of a real scrape, re-checks core rates;
     throws `SelectorFailureError` (exit 3) so the operator learns the DOM
     changed mid-run before burning a 10k request budget.
  4. **Auto-discovery** (`auto-discover.js`) — when every fallback selector
     for a field misses on a card, falls back to pattern-based discovery
     (phone regex, non-Google `<a href>`, aria-label "stars"/"rated", "N
     reviews" text). DISCOVERY_SCRIPT is inlined into `page.evaluate`. A
     successful discovery is logged so the operator can promote it to a
     real selector in `src/extract.js`.
  5. **Debug dumps** (`debug-dump.js`) — when a field's extraction rate
     drops below 80%, writes the first 500 chars of each card's innerHTML
     to `data/selector-debug/{field}_{timestamp}.html` so the developer can
     craft a new selector without re-running the scrape.

## Data Flow Diagram

```
 ┌──────────┐   search + scroll     ┌──────────────┐
 │ search.js│──────────────────────▶│  extract.js  │  list-view fields (17)
 └──────────┘                       └──────┬───────┘
                                           │ businesses[]
                                           ▼
                            ┌───────────────────────────┐
                            │  detail.js (deep-scrape)  │  detail fields (8 JSONB)
                            │  + incremental.js lookup  │  (skipped on cache_hit)
                            └─────────────┬─────────────┘
                                          │ enriched businesses[]
                                          ▼
                            ┌───────────────────────────┐
                            │  db.upsertBusinessesBatch │  Phase 2.1 idempotent
                            │  (src/db.js)              │  INSERT ... ON CONFLICT
                            └─────┬───────────────┬─────┘
                  inserted/      │               │  updated
                  unchanged      ▼               ▼
                            ┌─────────┐   ┌──────────────────────┐
                            │businesses│   │ business_snapshots   │  pre-update
                            │  (row)  │   │  (Phase 2.2)         │  snapshot
                            └────┬────┘   └──────────┬───────────┘
                                 │                   │
                                 │                   ▼
                                 │          ┌──────────────────────┐
                                 │          │ field_changes        │  per-field
                                 │          │  (Phase 2.2)         │  delta log
                                 │          └──────────┬───────────┘
                                 │                     │
                                 ▼                     ▼
                       ┌─────────────────────────────────────┐
                       │ db.buildUnchangedRefresh            │  Phase 2.12
                       │ (lightweight last_list_scraped +    │  no updated_at
                       │  change_hash bump for unchanged)    │  bump
                       └────────────────┬────────────────────┘
                                        │
                                        ▼
                       ┌─────────────────────────────────────┐
                       │ export.js → CSV / JSON / summary    │  Phase 1.6
                       └────────────────┬────────────────────┘
                                        │
                                        ▼
                       ┌─────────────────────────────────────┐
                       │ scrape_runs row finalized           │  db_inserted /
                       │ + run-complete structured log       │  db_updated /
                       │ + end-of-run banner (cache stats)   │  db_unchanged /
                       └─────────────────────────────────────┘  changes_detected
```

## Configuration Surface

`src/config.js` is the single source of truth for runtime configuration. It
resolves values in priority order — CLI args > process env vars > `.env`
file (loaded by a tiny hand-rolled parser) > hardcoded defaults — and
validates on startup, failing fast with a clear message on any conflict
(e.g. `--incremental` requires `--output db`, `--queue on` requires
`REDIS_URL`, `--endless` requires `--queue on`). Every CLI flag has a
matching env var (e.g. `--workers` ↔ `WORKERS`, `--listFreshnessDays` ↔
`LIST_FRESHNESS_DAYS`); `.env.example` documents every Phase 2 variable
across all 13 sub-phases. The full flag catalog (grouped by category:
Proxy, Stealth, Concurrency, Queue, DB, Cache, CAPTCHA, Health, Selectors)
is printed by `npm start -- --help`. The banner (`src/banner.js`) prints the
resolved config before any browser launches so the operator can eyeball it
and Ctrl-C if something looks wrong.

## Failure Modes & Recovery

- **Proxy burn** — three consecutive 403/429, < 50% success over 20
  requests, or three consecutive timeouts triggers a cooldown burn (benched
  for `--proxyCooldownMs`); HTTP 407 or provider-reported retirement is
  permanent. The pool skips benched proxies on `acquire`; if every proxy is
  benched, the worker logs a warning and runs direct (Phase 1 behavior).
- **Block (HTTP 429/503 or `WORKER_BLOCKED`)** — `worker.markBlocked()` puts
  the worker into `cooldown` for `--workerCooldownMs`; `pool` calls
  `worker.rotateIdentity()` to swap in a fresh proxy + fingerprint + session;
  the task is re-queued to a different worker; the original `dispatch()`
  promise resolves when the task eventually completes; the worker is
  lazy-revived after cooldown.
- **Crash (any non-block thrown error)** — `worker.markCrashed()` records a
  timestamp; if `crashCountInWindow >= --workerCrashLimit` the worker is
  `retired` permanently, otherwise `rotateIdentity()` + re-queue. Tasks cap
  re-queues at `--workerTaskRetries` (default = `--workers`).
- **CAPTCHA** — `src/captcha/orchestrator.js` runs `detectCaptchaType`; if a
  CAPTCHA is detected AND a solver is configured (`--captchaProvider` ≠
  `none`) AND `BudgetGuard` allows spend, `solveAndInject` runs (solver →
  inject token → wait for nav). On solver failure, no solver, or budget
  exceeded → fall back to Phase 1.8 pause-and-alert (`--captchaWaitMs`,
  default 5 min) and return `{ resolved: false }` so the caller can abort.
- **Selector failure** — startup health check failure OR first-batch abort
  throws `SelectorFailureError` with `exitCode = SELECTOR_FAILURE_EXIT_CODE`
  (3); the run exits cleanly with code 3 and a clear log line. Auto-discover
  + debug dumps keep extraction alive for non-critical fields.
- **Memory pressure (RSS)** — `degradation.handlePressure` pauses the queue,
  waits for in-flight tasks, restarts every worker's browser context,
  optionally runs `global.gc()` (if `--expose-gc`), resumes the queue, and —
  if RSS is still above `--maxRssMb` — retires one worker to shed load.
- **OOM / orphaned Chromium** — `zombie-reaper.reapOnStartup` sweeps
  orphaned Chromium on boot; `reapOnShutdown` runs from the SIGINT handler
  + main `finally` block. Acceptance criterion: zero orphaned Chromium
  processes after exit.
- **Job failure (queue mode)** — BullMQ retries with exponential backoff up
  to `--queueAttempts` (default 3); after exhaustion the job lands in the
  dead-letter surface, retriable via `npm run queue:status -- --retry <id>`
  or `--retryAll`.
- **Process crash (queue mode)** — jobs persist in Redis; restarting the
  process re-attaches to the queue and resumes pending work. In-process
  mode relies on the Phase 1.7 `.checkpoint.json` + `--resume` for crash
  recovery.

## Phase 3 — Data Quality & Enrichment

Phase 3 layers a *derived-data* pipeline on top of the Phase 2 scrape. After
the worker pool persists the raw `businesses` rows, the orchestrator
(`src/enrichment/pipeline.js`, Phase 3.12) runs `enrichBatch(businesses, opts)`
across the whole batch: ten sub-phases (3.1 phone → 3.10 confidence) normalize
phone numbers, parse + geocode addresses, deduplicate fuzzy-matched listings,
flag chain/spam patterns, discover + verify emails, detect website tech stacks,
score review sentiment, compute competitor-density geo-metrics, fuse everything
into a 0-100 lead score, and finally stamp an evidence-depth confidence score.
Phase 3.11 (grid-coverage) is a *separate* search-strategy utility that feeds
the scraper's main query loop with a grid of `(lat, lng)` search points so a
whole city can be covered despite Google Maps' ~120-results-per-query cap; it
is not part of the per-business enrichment pipeline. Enrichment is OFF by
default (`--enrich off`) — a run without the flag is byte-for-byte Phase 2.

### Enrichment Pipeline Diagram

```
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ Phase 2 scrape pipeline                                                 │
 │ search.js → scroll.js → extract.js → detail.js → db.upsertBusinessesBatch │
 └───────────────────────────────────┬─────────────────────────────────────┘
                                     │ result.businesses[]  (raw Maps fields)
                                     ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ enrichBatch(businesses, opts)              src/enrichment/pipeline.js   │
 │                                                (Phase 3.12)             │
 │                                                                         │
 │  runPhase(name, fn, logger) wraps EACH phase in try/catch:              │
 │  one failure → { error, phase } stub + log; downstream phases see       │
 │  missing descriptors and degrade to neutral. The batch keeps running.   │
 │                                                                         │
 │  3.1  phone          normalizePhonesBatch         (always on, offline)  │
 │  3.2  address        parseAddress + geocodeBatch  (geocode opt-in → net)│
 │  3.3  dedup          findDuplicates              (batch-wide, offline)  │
 │  3.4  chain + spam   detectChainBatch + detectSpamBatch (batch-wide)    │
 │  3.5  email          enrichEmailsBatch           (SMTP verify opt-in)   │
 │  3.6  tech-stack     detectTechStackBatch        (HTTP fetch opt-in)    │
 │  3.7  sentiment      analyzeReviewsBatch         (always on, offline)   │
 │  3.8  geo-metrics    computeGeoMetricsBatch      (batch-wide, offline)  │
 │  3.9  lead-score     scoreLeadsBatch             (always on; fuses all) │
 │  3.10 confidence     computeConfidenceBatch      (always on; evidence)  │
 │                                                                         │
 │  Every phase mutates business rows IN PLACE: writes its ENRICHMENT_     │
 │  COLUMNS + attaches a debug descriptor (phone_normalized, dedup_result, │
 │  chain_result, spam_result, tech_stack_result, sentiment_result,        │
 │  geo_result, lead_result, confidence_result). Descriptors are NOT       │
 │  persisted — they feed downstream phases + the CLI banner only.         │
 │                                                                         │
 │  Returns { enriched, skipped, failed, costUsd, phases }                 │
 └───────────────────────────────────┬─────────────────────────────────────┘
                                     │ mutated businesses[] + per-phase stats
                                     ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ Persist ENRICHMENT_COLUMNS → UPDATE businesses SET ...                  │
 │ + stamp enriched_at = NOW(), enrichment_version = 1                     │
 │ src/db.js — ENRICHMENT_COLUMNS are EXCLUDED from data_hash + change     │
 │ tracking (derived data; re-enrichment never bumps updated_at)           │
 └─────────────────────────────────────────────────────────────────────────┘

 SEPARATE TRACK — NOT in the per-business pipeline:
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ 3.11 grid-coverage    gridSearchPoints(region, { query, stepKm })       │
 │                       src/enrichment/grid-coverage.js                   │
 │ Drives the scraper's main search loop (one Maps query per grid point).  │
 │ Overlapping result sets between adjacent cells are merged by Phase 3.3  │
 │ dedup. Pure geometry — no network, no DB, no Google API.                │
 └─────────────────────────────────────────────────────────────────────────┘
```

### Phase 3 Module Map

| Phase | Module | Responsibility | Persisted columns |
|---|---|---|---|
| 3.0 | `src/enrichment/index.js` | Barrel export + `ENRICHMENT_COLUMNS` aggregation (single source of truth, mirrored by `migrations/003-enrichment.sql`) + `ENRICHMENT_VERSION` re-enrichment trigger. | (aggregator) |
| 3.1 | `src/enrichment/phone.js` | Phone normalization & validation. E.164 conversion, type detection (mobile/landline/toll_free/voip/invalid/unknown), ISO country resolution, non-Latin-digit transliteration, extension extraction. Backed by `libphonenumber-js/max` (offline). `e164` suppressed for invalid numbers (safety: clients filter on it for auto-dialing). | `phone_e164`, `phone_type`, `phone_country_code` |
| 3.2 | `src/enrichment/address.js` | Split raw one-line address into street/unit/city/state/postal/country + optional geocoding to `lat`/`lng` with `geocode_confidence`. DI geocoder seam (`google`/`nominatim`/`mock`); mock returns a deterministic offset so the pipeline is testable offline. | `address_street`, `address_city`, `address_state`, `address_postal`, `address_country`, `lat`, `lng`, `geocode_confidence` |
| 3.3 | `src/enrichment/dedup.js` | Fuzzy deduplication. Weighted similarity (name 0.5 / phone 0.3 / address 0.2) above `threshold` (default 0.85) clusters near-duplicate listings; canonical picked by completeness score. Block-key pre-filter keeps it O(n·k) not O(n²). | (none — clusters written to `business_duplicates` by the caller; `dedup_result` descriptor feeds 3.9/3.10) |
| 3.4 | `src/enrichment/chain-detection.js` | Two analyses: (A) chain-brand detection against a token+alias catalogue (McDonald's, Starbucks, …); (B) spam/fake-listing scoring from phone-reuse across listings, spam-name keywords, throwaway TLDs, and area-code/state mismatch. | (none — `chain_result` + `spam_result` descriptors feed 3.9/3.10) |
| 3.5 | `src/enrichment/email.js` | Email discovery (scrape website contact/about pages + pattern-based guess: `info@`, `contact@`, `first.last@`) followed by optional SMTP mailbox verification (RCPT TO → 250/251 verified, 550/551/553 invalid, transient → unverified). | `email`, `email_status` |
| 3.6 | `src/enrichment/tech-stack.js` | HTTP-fetch the website (redirect-following, 2 MB cap, 10 s timeout), then run signature detection for CMS / framework / CDN / analytics / ecommerce / JS libs + liveness (`live`/`dead`/`redirected`/`error`) + HTTP status code. | `website_tech_stack`, `website_status_code`, `website_liveness` |
| 3.7 | `src/enrichment/sentiment.js` | AFINN-based review sentiment + 8-aspect theme extraction (food/service/price/cleanliness/atmosphere/wait/value/location) + rating/review consistency check (a 5.0★ rating paired with scathing reviews is a fake-listing tell). | `sentiment_score`, `sentiment_themes` |
| 3.8 | `src/enrichment/geo-metrics.js` | Competitor density within 1 km + 5 km (overall and same-category), nearest-neighbor distance, isolation classification, area-type classification (urban/suburban/rural), category-specific coverage radius. Batch-wide — needs all businesses to count neighbors. | `competitor_density_1km`, `competitor_density_5km` |
| 3.9 | `src/enrichment/lead-score.js` | Capstone: fuses 3.1–3.8 into a 0-100 composite lead score. 7 signals × 4 profiles, grade A-F, sales tier, hard SPAM_CAP at 34. | `lead_score`, `lead_score_profile` |
| 3.10 | `src/enrichment/confidence.js` | Evidence-depth confidence (DISTINCT from lead score). Neutral base 50, 18 signed-delta factors, banded 0-100 → stored 0.00-1.00. Surfaces *how well-evidenced* a listing is so operators know which lead scores to trust. | `confidence_score` |
| 3.11 | `src/enrichment/grid-coverage.js` | Grid-based geospatial search coverage. `gridSearchPoints(region, { query, stepKm })` generates a regular-in-km grid of `(lat, lng)` points (longitude step shrinks with `cos(lat)`); `estimateCoverage()` quantifies the gap-vs-waste trade-off. Search-strategy utility — feeds the scraper's query loop, NOT the per-business pipeline. | (none — drives search input, not DB columns) |
| 3.12 | `src/enrichment/pipeline.js` | Orchestrator. `enrichBatch(businesses, opts)` chains 3.1→3.10 in fixed order, isolates each phase in `runPhase()` try/catch, stamps `enriched_at` + `enrichment_version`, returns `{ enriched, skipped, failed, costUsd, phases }`. `enrichBusiness(business, opts)` is the single-record convenience wrapper. | `enriched_at`, `enrichment_version` (provenance, written by the pipeline) |

### Data Flow

The Phase 2 scrape produces `result.businesses[]` — an array of raw Maps
fields (name, phone, address, website, rating, reviews_count, top_reviews,
category, place_id, …). When `--enrich on`, `src/index.js` hands that array
to `enrichBatch(businesses, opts)` *before* `persistRunResults`, deliberately
outside the DB transaction so a DB failure can't lose the enrichment work.

The pipeline is **mutate-in-place**: each phase reads prior-phase descriptors
off the business object and writes its own ENRICHMENT_COLUMNS + debug
descriptor back onto the same object. No intermediate copies. Three phases are
**batch-wide** — they need the full array to do their job:

- **3.3 dedup** compares every business against every other (via block-key
  pre-filter) to cluster duplicates and pick a canonical.
- **3.4 spam** builds a phone-reuse map across the whole batch (one phone
  number shared by 5+ "businesses" is a strong fake-listing signal).
- **3.8 geo-metrics** counts neighbors within 1 km / 5 km — per-business
  density is meaningless without the rest of the batch.

The other seven phases are per-business: each business is processed
independently and the phase would produce identical output on a single-element
batch. `enrichBusiness()` exploits this by wrapping a one-element array and
delegating to `enrichBatch()`, at the cost of trivial batch-wide stats (no
duplicates possible, no neighbors).

After the pipeline returns, the caller persists the ENRICHMENT_COLUMNS to
PostgreSQL via `db.upsertBusinessesBatch`. The columns are aggregated by
`src/enrichment/index.js` from each module's `ENRICHMENT_COLUMNS` export
(de-duplicated; dedup + chain-detection + grid-coverage contribute none) plus
the two provenance columns (`enriched_at`, `enrichment_version`).

### Error-Isolation Model

`runPhase(name, fn, logger)` is the safety seam. Every phase is invoked
through it:

```
function runPhase(name, fn, logger) {
  try {
    const t0 = Date.now();
    const result = fn();
    logger?.info(`[enrichment] ${name} done in ${Date.now() - t0}ms`);
    return result;
  } catch (err) {
    logger?.error(`[enrichment] ${name} FAILED: ${err.message}`);
    return { error: err.message, phase: name };
  }
}
```

A thrown phase produces a `{ error, phase }` stub in the `phases` object of
the return summary, but does **not** abort the run. Downstream phases are
written defensively: every descriptor access tolerates `null`/`undefined`, and
a missing descriptor contributes *nothing* — neither positive nor negative.
The lead scorer (3.9) degrades the affected signal to a neutral 50 with a note
explaining the gap ("spam_result not available — neutral 50 (Phase 3.4 did not
run)"); the confidence scorer (3.10) simply notes the signal as uncovered in
`signalCoverage`. The batch therefore always produces a sensible lead score +
confidence for every business, even if half the phases failed. The per-phase
`phases` object in the return value lets the operator audit exactly which
phases succeeded, which failed, and what the error was.

### Opt-In Network Phases

The default enrichment run is **fully offline and $0**: no HTTP, no DNS, no
SMTP, no paid geocoding API. Three phases make network calls and are gated
behind `opts` flags:

| Phase | Flag | Default | Behavior when off |
|---|---|---|---|
| 3.2 geocode | `opts.geocode` | `false` | Address is still *parsed* into structured fields (street/city/state/postal/country) — only the lat/lng resolution is skipped. `lat`/`lng`/`geocode_confidence` stay null. |
| 3.5 email verify | `opts.emailVerify` | `false` | Discovery still runs — the website is not fetched, but the `email` column is populated from pattern-based guesses on the website domain. `email_status` is set to `unverified` (the default — discovery ran but no hard SMTP verdict). |
| 3.6 tech-stack fetch | `opts.techStackFetch` | `false` | Phase is **skipped entirely** (`phases.techStack = { skipped: true, reason: 'techStackFetch not enabled' }`). `website_tech_stack`/`website_status_code`/`website_liveness` stay null; the `HAS_TECH_STACK` confidence factor won't fire. |

When `opts.geocode` is on but no `geocoder` is specified, it falls back to
`'mock'` — a deterministic offset from the parsed postal code — so the pipeline
remains testable without a real API key. The Google and Nominatim providers are
real; only Google costs money (Nominatim is free under its usage policy). The
`costUsd` field in the return summary accumulates geocoding spend so budget
caps (`--enrichBudget`) can be enforced by the caller.

### Confidence & Provenance Model

`confidence_score` is **evidence depth**, deliberately distinct from
`lead_score` (which is *attractiveness*). A 5.0★ listing with zero reviews and
no website could be a fantastic lead or could be spam — the lead score can't
tell those two apart, but confidence can. Operators use it to decide which
lead scores to trust and which need more enrichment before outreach.

The model (ported from the dashboard's `confidence.ts`): a neutral base of 50,
then signed deltas from eight evidence dimensions. Each delta emits a
`{ code, label, detail, impact, delta }` factor so the reasoning is fully
explainable. 18 factors total:

- **Positive (10):** `HAS_PHONE` (+8), `HAS_VALID_PHONE` (+5), `HAS_GEOCODE`
  (+6), `HIGH_GEOCODE_CONFIDENCE` (+4), `HAS_WEBSITE` (+6), `HAS_LIVE_WEBSITE`
  (+4), `HAS_REVIEWS` (+5), `HIGH_REVIEW_VOLUME` (+6, ≥20 reviews),
  `HAS_SENTIMENT` (+4), `HAS_TECH_STACK` (+3).
- **Negative (8):** `MISSING_PHONE` (−10), `INVALID_PHONE` (−12),
  `MISSING_ADDRESS` (−8), `MISSING_GEOCODE` (−10), `MISSING_WEBSITE` (−8),
  `LOW_REVIEW_VOLUME` (−6, <5 reviews), `RATING_REVIEW_MISMATCH` (−8),
  `SPAM_FLAGGED` (−20).

Each missing raw field (name/phone/address/website/rating/reviews/lat-lng)
also nibbles 2 points off the base; the high-impact gaps additionally fire the
explicit `MISSING_*` factors above. The final 0-100 score is clamped, banded,
and divided by 100 for storage:

- **Bands:** `very_low` (<20), `low` (20-39), `medium` (40-59), `high`
  (60-79), `very_high` (≥80).
- **Storage:** `NUMERIC(4,2)` → stored as 0.00-1.00 (computed internally as
  0-100, divided by 100, rounded to 2 decimals).
- **`signalCoverage`:** fraction of 8 pipeline signals present (phone /
  address-geocode / dedup / chain-spam / tech / sentiment / geo / lead).
  Missing descriptors contribute no coverage credit but no penalty either.
- **`missingFields`:** list of raw fields absent from the scrape.
- **`confidence_result`:** the full `{ score, band, factors, missingFields,
  signalCoverage, note }` debug descriptor — NOT persisted, powers the CLI
  banner + downstream debugging.

**Provenance:** every enriched row is stamped with `enriched_at = NOW()` and
`enrichment_version = 1` (the `__version` constant in `pipeline.js` /
`ENRICHMENT_VERSION` in `index.js`). Bumping the version is the re-enrichment
trigger — rows with a lower `enrichment_version` get re-enriched on the next
pipeline run. Enrichment columns are excluded from `data_hash` and
change-tracking (`HASH_EXCLUDED` in `src/db.js`), so a re-enrichment with a
new algorithm or a different phone-country hint does NOT create
`business_snapshots` / `field_changes` rows or bump `updated_at` — only a real
scrape change (rating/reviews/phone/website) counts as "the business's data
changed."

### Lead-Scoring Model

The capstone phase (3.9) fuses every prior signal into one 0-100 composite
**lead score**. The model is transparent and additive: seven signal
dimensions, each normalized to a 0-100 subscore, combined by fixed weights
that sum to 1.0 per profile. Every subscore carries a human-readable note and
the weighted contribution is exposed, so the score is fully explainable.

| Signal | Sources |
|---|---|
| `legitimacy` | 3.4 spam score (inverse) + chain flag |
| `reputation` | 3.7 sentiment + star rating + consistency |
| `data_quality` | 3.1 phone + 3.2 address + website + reviews |
| `digital_maturity` | 3.6 tech-stack sophistication + liveness |
| `establishment` | review volume (maturity / longevity proxy) |
| `uniqueness` | 3.3 dedup (primary vs duplicate) + phone reuse |
| `geo` | 3.8 isolation / competition / area type |

**Four scoring profiles** weight the signals differently for different
outreach workflows (weights sum to 1.0 each):

- `web-agency` (default) — emphasizes legitimacy, data_quality,
  establishment; keeps `digital_maturity` low-weight (low maturity is the
  *opportunity*, not a disqualifier).
- `reputation-mgmt` — heavily weights reputation (the signal they sell
  against); underweights digital_maturity.
- `seo-agency` — weights digital_maturity + data_quality (need a site to
  optimize) + geo (local SEO matters).
- `default` — the dashboard's even-split baseline.

**Grade** (composite → letter): A ≥85, B ≥70, C ≥55, D ≥40, F <40.

**Tier** (composite + spam flag → sales action): `priority` ≥85,
`qualified` ≥70, `nurture` ≥55, `monitor` ≥40, `disqualify` <40.

**SPAM_CAP** (critical rule): a listing flagged `isSpam` by Phase 3.4 with
`spamScore ≥ 65` (`SPAM_CAP_THRESHOLD`) is hard-capped at 34
(`SPAM_CAP_SCORE`) — grade F, tier `disqualify` — regardless of how strong its
other signals are. The spam engine's strong-signal overrides are designed to
be near-certain. `spamCapped = true` is set on the `lead_result` descriptor so
the batch wrapper and downstream consumers can audit the cap.

Two columns are persisted: `lead_score` (INT 0-100) and `lead_score_profile`
(TEXT). The full `lead_result` descriptor (subscores, weights, strengths,
risks, recommendation) is attached to the business object but NOT persisted —
it powers the CLI banner and downstream grid/confidence phases.

### Backward Compatibility

Enrichment is gated behind `--enrich on` (default `off`). An `--enrich off`
run — the default — never loads the enrichment pipeline: `enrichBatch` is not
called, no ENRICHMENT_COLUMNS are written, and the `businesses` table looks
exactly as it did under Phase 2. The schema migration (`003-enrichment.sql`)
is purely additive (22 nullable columns + one side table + indexes, all
`IF NOT EXISTS`), so a Phase 2 database migrates forward without touching
existing rows. Within an `--enrich on` run, each feature is independently
toggleable (`--enrichPhone off`, `--enrichEmail off`, …) — turning a feature
off leaves its columns NULL and the downstream phases treat the absence as
neutral, exactly as if the descriptor had never been produced. The Phase 2
acceptance suite (1464 tests) continues to pass unchanged; Phase 3 adds its
own suite on top.
