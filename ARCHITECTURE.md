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
