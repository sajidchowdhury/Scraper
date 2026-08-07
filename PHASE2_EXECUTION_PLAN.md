# Phase 2 Execution Plan — "A Reliable Scraper That Survives 10k+ Listings Overnight"

> **Scope:** This document decomposes **Phase 2** of the master roadmap (`SCRAPER_FEATURES.md`, §3) into granular, sequential sub-phases. The single deliverable when all sub-phases are complete: **a Node.js scraper that runs overnight against 10,000+ Google Maps listings without dying — with rotating proxies, fingerprint randomization, CAPTCHA auto-solving, multi-worker concurrency, PostgreSQL persistence, change tracking, and self-healing selectors.**
>
> **Format:** No code — only feature specs, task checklists, and acceptance criteria. Each sub-phase is independently shippable; finishing one before starting the next is strongly recommended.
>
> **Prerequisite:** Phase 1 milestone complete (`v1.0.0-phase1` — 410 tests / 1028 assertions passing). The scraper already searches, paginates, extracts 25 fields, exports CSV/JSON, resumes from checkpoints, and has minimal anti-block.

---

## Status Summary

> **Last updated:** Phase 2.8 complete. 9 of 13 sub-phases shipped.
>
> **Overall:** 9 of 13 sub-phases shipped. Phase 2 work on `phase2` branch.

| Phase | Status | Commit | Tests | Notes |
|---|---|---|---|---|
| 2.0 — Audit, Fixtures & Dependency Setup | ✅ DONE | _(this commit)_ | 410 | Baseline metrics captured, 6 DOM fixtures, 8 deps installed, docker-compose.yml, .env.example Phase 2 vars |
| 2.1 — PostgreSQL Persistence Layer | ✅ DONE | _(this commit)_ | 475 (+65) | `src/db.js` (pool, upserts, change-hash), `schema.sql`, `migrate.js`, `--output csv\|json\|db\|all` flag, batched upserts, transaction rollback, SQL-injection-safe |
| 2.2 — Change Tracking & History | ✅ DONE | _(this commit)_ | 551 (+76) | `business_snapshots` + `field_changes` tables, `src/db/deltas.js` (computeChanges, numericDelta), snapshot-on-update, `changes_detected` on scrape_runs, `npm run db:history` CLI, change-breakdown banner |
| 2.3 — Proxy Management & Rotation | ✅ DONE | 52 tests | `src/proxy.js`, `src/proxy/burn-detector.js` | pool, 3 rotation strategies, burn detection, health check |
| 2.4 — Browser Fingerprint Randomization | ✅ DONE | 96 tests | `src/fingerprint.js`, `src/browser.js` (fingerprint-aware launch), `src/config.js` (--fingerprintProfile/--fixedFingerprint/--noFingerprint), `src/banner.js` (fingerprint row), `src/index.js` (per-run generation + logging) | coherent UA+platform+viewport+timezone+locale+WebGL+canvas noise+hw concurrency+device memory+geolocation; init-script injection; 1000× coherence stress test |
| 2.5 — Stealth Hardening | ✅ DONE | 83 tests | `src/stealth-patches.js`, `src/browser.js` (playwright-extra + stealth plugin + custom patches), `src/config.js` (--stealth/--noStealth/--stealthDebug), `src/banner.js` (stealth row), `src/index.js` (resolve + apply), `scripts/verify-stealth.js` (dev-only) | 10 bot-detection patches (webdriver, chrome.runtime, plugins, permissions, outerWidth/Height, Notification.permission, vendor, maxTouchPoints); coexists with fingerprint (yields to WebGL+languages overrides); launch args (--disable-blink-features=AutomationControlled); stub-page eval tests |
| 2.6 — CAPTCHA Auto-Solving | ✅ DONE | 90 tests | `src/captcha/solver.js`, `src/captcha/cost-log.js`, `src/captcha/injector.js`, `src/captcha/orchestrator.js`, `src/captcha/index.js`, `src/antiblock.js` (detectCaptchaType + extractSitekey + CAPTCHA_TYPES), `src/config.js` (--captchaProvider/--captchaApiKey/--captchaBudget/--noCaptchaSolve), `src/banner.js` (CAPTCHA row), `src/index.js` (resolve solver + budget guard + cost logger; wire handleCaptcha into deep-scrape hook; end-of-run CAPTCHA cost line), `tests/fixtures/recaptcha-v2.html`, `tests/helpers/mock-dom.js` | 4 providers (2captcha REST, anticaptcha JSON-RPC, capsolver JSON-RPC, mock) via injectable httpClient (no real API calls in tests); BudgetGuard spend cap; cost-log JSONL + summary; pure DOM token-injection tested against reCAPTCHA v2 fixture; orchestrator fallback chain (solve→retry→fallback provider→pause-and-alert); provider 'none' preserves Phase 1.8 behavior exactly |
| 2.7 — Session & Cookie Rotation | ✅ DONE | 59 tests | `src/session/manager.js`, `src/session/warmup.js`, `src/session/account-warmup.js`, `src/session/context-factory.js`, `src/session/index.js`, `src/detail.js` (sessionCheck hook + page swap), `src/config.js` (--sessionMaxRequests/--sessionMaxAgeMs/--warmup/--warmupDurationMs/--accountWarmup/--accountsFile), `src/banner.js` (Session row), `src/index.js` (construct manager, warmup before search, tickRequest in deep-scrape, rotate + re-navigate, end-of-run stats) | createSessionManager with injectable createContext/clock/sleep; rotation by request count OR age (whichever first); warmupContext visits google.com + random second site + benign search; accountWarmup opt-in (off by default, credentials never logged, email redacted); cookie isolation (each context fresh jar); createRealContextFactory bridges to browser.newContext + fingerprint + stealth; mid-deep-scrape rotation via sessionCheck hook + re-navigate to Maps search |
| 2.8 — Worker Pool & Concurrency | ✅ DONE | 67 tests | `src/worker.js`, `src/pool.js`, `src/config.js` (--workers/--workerProxyStrategy/--workerCrashLimit/--workerCooldownMs/--workerLoadBalancer/--workerDetailBatchSize/--workerTaskRetries), `src/index.js` (runWithPool: getIdentity + runTask [search-task/detail-task] + dispatchBatchSettled + per-worker session aggregation + Pool: banner line), `.env.example` (Phase 2.8 section) | createWorker with DI runTask + state machine (idle/busy/cooldown/retired) + block/crash tracking + rotateIdentity; createPool with round-robin/least-busy + race-free acquireWorker + re-queue on block/crash + retire after crashLimit; serializable task types (search/detail/resume); --workers 1 preserves Phase 1 sequential pipeline byte-for-byte |
| 2.9 — Job Queue & Orchestration | ⬜ NOT STARTED | — | — | BullMQ/Redis or in-memory queue, async jobs, priorities |
| 2.10 — Memory Management & Long-Run Stability | ⬜ NOT STARTED | — | — | Context restart, leak mitigation, health probes |
| 2.11 — Self-Healing Selectors & Health Checks | ⬜ NOT STARTED | — | — | Auto-discovery, extraction-rate alerting, selector versioning |
| 2.12 — Incremental Scraping & Detail Caching | ⬜ NOT STARTED | — | — | `last_seen` freshness, detail-page cache, only-re-scrape-modified |
| 2.13 — Final Integration, Docs & Handoff | ⬜ NOT STARTED | — | — | End-to-end 10k run, docs update, `v2.0.0-phase2` tag |

**Critical path:** 2.0 → 2.3 → 2.4 → 2.5 → 2.6 → 2.7 → 2.8 → 2.9 → 2.10 → 2.13.

**Parallel tracks:** 2.1→2.2→2.12 (data), 2.11 (resilience) can proceed independently of the stealth/scale track.

---

## Table of Contents

0. [How to Use This Document](#0-how-to-use-this-document)
1. [Phase 2.0 — Audit, Fixtures & Dependency Setup](#phase-20--audit-fixtures--dependency-setup)
2. [Phase 2.1 — PostgreSQL Persistence Layer](#phase-21--postgresql-persistence-layer)
3. [Phase 2.2 — Change Tracking & History](#phase-22--change-tracking--history)
4. [Phase 2.3 — Proxy Management & Rotation](#phase-23--proxy-management--rotation)
5. [Phase 2.4 — Browser Fingerprint Randomization](#phase-24--browser-fingerprint-randomization)
6. [Phase 2.5 — Stealth Hardening](#phase-25--stealth-hardening)
7. [Phase 2.6 — CAPTCHA Auto-Solving](#phase-26--captcha-auto-solving)
8. [Phase 2.7 — Session & Cookie Rotation](#phase-27--session--cookie-rotation)
9. [Phase 2.8 — Worker Pool & Concurrency](#phase-28--worker-pool--concurrency)
10. [Phase 2.9 — Job Queue & Orchestration](#phase-29--job-queue--orchestration)
11. [Phase 2.10 — Memory Management & Long-Run Stability](#phase-210--memory-management--long-run-stability)
12. [Phase 2.11 — Self-Healing Selectors & Health Checks](#phase-211--self-healing-selectors--health-checks)
13. [Phase 2.12 — Incremental Scraping & Detail Caching](#phase-212--incremental-scraping--detail-caching)
14. [Phase 2.13 — Final Integration, Docs & Handoff](#phase-213--final-integration-docs--handoff)
15. [Final Acceptance Test (Definition of Done)](#final-acceptance-test-definition-of-done)
16. [Recommended Build Order & Parallelism](#recommended-build-order--parallelism)
17. [Out of Scope (Explicitly Deferred)](#out-of-scope-explicitly-deferred)

---

## 0. How to Use This Document

- Work **top to bottom** within each track. Each sub-phase builds on the previous one.
- Every sub-phase has a **Goal**, **Why it matters**, **Task checklist**, **Acceptance criteria**, **Dependencies**, and a **Deliverable**.
- Do **not** move to the next sub-phase until the current one's acceptance criteria pass.
- Sub-phases are sized so a focused session completes one. No sub-phase should take more than ~1 day.
- The cumulative result of Phases 2.0 → 2.13 is the Phase 2 milestone of the master roadmap.
- **Testing is non-negotiable.** Every sub-phase ships with unit tests. The DI patterns established in Phase 1 (`openFn`/`backFn`/`extractFn` injection, stub pages, capture loggers) must be extended — no new module ships without a testable seam.

---

## Phase 2.0 — Audit, Fixtures & Dependency Setup

> **Status: ✅ DONE** — All task-checklist items complete. 410 tests / 1028 assertions still passing on `phase2` branch.

### Goal
Establish a clean baseline before Phase 2 work begins: measure current performance, capture reference DOM fixtures for stealth/selector testing, install all new dependencies, and set up the supporting infrastructure (local PostgreSQL, local Redis, proxy credential vault).

### Why it matters
Phase 2 introduces ~8 new dependencies (pg, bullmq, ioredis, playwright-extra, stealth plugin, captcha SDKs, proxy libs). Installing them all up-front avoids dependency-whack-a-mole mid-phase. Baseline metrics give us a "before" to compare the "after" against.

### Task checklist
- [x] **Baseline metrics run.** Execute a documented 100-result `--deepScrape true` run against a fixed query ("Restaurant in Toronto") and record:
  - Wall-clock time
  - Extraction rates per field (from the summary.json)
  - Deep-scrape success rate
  - Memory usage at start vs. end (`process.memoryUsage().heapUsed`)
  - Whether any CAPTCHA appeared
  - Save the output as `benchmarks/phase1-baseline.json` for future comparison.
- [x] **DOM fixture capture.** Add a `scripts/capture-fixtures.js` script (dev-only, not in `src/`) that:
  - Opens Google Maps for 3 fixed queries ("Cafe in Berlin", "Plumber in Dhaka", "Restaurant in Toronto").
  - Saves the full HTML of the results feed + one detail panel to `tests/fixtures/`.
  - These fixtures become the baseline for selector-health checks (Phase 2.11) and stealth verification.
- [x] **Dependency installation.** Add to `package.json`:
  - `pg` (PostgreSQL client — lightweight, no ORM needed for Phase 2)
  - `bullmq` + `ioredis` (job queue)
  - `playwright-extra` + `puppeteer-extra-plugin-stealth` (stealth patches)
  - `2captcha` (official SDK — or `anticaptcha`/`capsolver` per preference)
  - `proxy-chain` (proxy rotation helper — or custom)
  - `user-agents` (UA generation)
  - ~~`canvas` (optional — for fingerprint canvas-noise; may require native deps)~~ — **deferred**: requires native compilation; Phase 2.4 will use a pure-JS canvas-noise approach instead.
  - Dev: `testcontainers` or a local Docker Compose for PostgreSQL + Redis in tests. — **shipped as `docker-compose.yml`** (testcontainers deferred to Phase 2.1 when DB tests need it).
- [x] **Infrastructure setup.**
  - Local PostgreSQL 15+ running (Docker: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:15`). — **`docker-compose.yml` provided**; Docker not available in the dev sandbox so the containers were not started here, but `docker compose up -d` works on any Docker-equipped machine.
  - Local Redis 7+ running (Docker: `docker run -d -p 6379:6379 redis:7`). — **same as above**.
  - Document connection strings in `.env.example` (`DATABASE_URL`, `REDIS_URL`).
  - Add a `docker-compose.yml` at repo root for one-command infra (`docker compose up -d`).
- [x] **Proxy credential vault.** Create a `.env.example` section for proxy config:
  - `PROXY_LIST_FILE` (path to a file of `host:port:user:pass` lines)
  - `PROXY_PROVIDER` (manual | brightdata | smartproxy | oxylabs)
  - `PROXY_API_KEY` (for provider APIs)
  - Document that `.env` is gitignored and must never contain real credentials.
- [x] **Test count freeze.** Record current test count (410) in `benchmarks/phase1-baseline.json` so we can track net-new tests across Phase 2.
- [x] **Branch strategy.** Create `phase2` branch off `main`. All Phase 2 work merges there. `main` stays on Phase 1 until 2.13 ships.

### Acceptance criteria
- ✅ `benchmarks/phase1-baseline.json` exists with all 6 baseline metrics recorded.
- ✅ `tests/fixtures/` contains at least 6 HTML files (3 feed + 3 detail). — 6 files + manifest.json shipped (5.2MB total).
- ✅ `npm install` installs all new dependencies without errors. — 86 packages added, 0 vulnerabilities.
- ⚠️ `docker compose up -d` starts PostgreSQL + Redis; both accept connections. — `docker-compose.yml` provided and valid; Docker not available in the dev sandbox so the containers were not started here. Verified `docker compose config` parses cleanly. The user can run `docker compose up -d` on any Docker-equipped machine.
- ✅ `.env.example` documents all new env vars. — Phase 2 section appended (110 new lines covering 2.1–2.12).
- ✅ `phase2` branch exists and is checked out.
- ✅ All 410 existing tests still pass on the new branch. — 410 tests / 1028 assertions, 0 failures.

### Findings during baseline run
The baseline run with `--deepScrape true` revealed a Phase 1 regression: `backToListOnPage` lands on `about:blank` after ~40 detail scrapes, causing all subsequent detail-panel opens to fail. The Phase 1.11 diagnostics (commit `c7f7dc1`) surfaced this clearly — `beforeUrl:about:blank` + `triedSelectors` logged on every failure. The baseline JSON documents this as a known issue; the list-view baseline (without deepScrape) is the primary Phase 2 comparison metric. The fix is planned for Phase 2.7 (session rotation resets navigation state) or a targeted `backToListOnPage` patch.

**Baseline numbers (list-view, 100 results, Restaurant in Toronto):**
- Wall-clock: **47.5s** (0.48s per business)
- Memory: 4.5MB → 4.9MB heap (parent process; child not directly observable)
- Extraction rates: name/rating/reviews/category/address/maps_url/place_id/business_status/is_sponsored/scraped_at/query/location all **100%**; price_level **80%**; open_now **37%**; phone/website/plus_code **0%** (expected — these need deepScrape)
- CAPTCHA: not triggered
- Exit code: 0

### Dependencies
Phase 1 complete (`v1.0.0-phase1`).

### Deliverable
A ready-to-develop environment with baseline metrics, test fixtures, infrastructure, and all dependencies installed.

---

## Phase 2.1 — PostgreSQL Persistence Layer

> **Status: ✅ DONE** — `src/db.js` + `src/db/schema.sql` + `src/db/migrate.js` + `--output` flag + 65 new tests (475 total). Integration tests guarded on a live Postgres `DATABASE_URL`.

### Goal
Add a PostgreSQL persistence layer alongside the existing CSV/JSON export. Every scraped business is upserted into the database, keyed by `place_id`, so re-scraping the same business updates the row instead of duplicating.

### Why it matters
CSVs are great for delivery; databases are great for operations. With Postgres, we get: idempotent re-scrapes, queryable data (filter by city, rating, category), change tracking (Phase 2.2), and the foundation for an API (Phase 4).

### Task checklist
- [x] **Schema design.** Create `src/db/schema.sql` (version-controlled, idempotent):
  - `businesses` table:
    - `id` SERIAL PRIMARY KEY
    - `place_id` TEXT UNIQUE NOT NULL (the canonical key)
    - `name`, `rating` (NUMERIC(2,1)), `reviews_count` (INT)
    - `price_level`, `category`, `address`, `phone`, `website`
    - `maps_url`, `plus_code`, `latitude` (NUMERIC(10,7)), `longitude` (NUMERIC(10,7))
    - `open_now` (BOOLEAN), `business_status`, `is_sponsored` (BOOLEAN)
    - `query`, `location` (the search that found it)
    - `full_hours` (JSONB), `popular_times` (JSONB), `top_reviews` (JSONB), `photos` (JSONB)
    - `reservation_url`, `menu_url`, `social_profiles` (JSONB)
    - `detail_scraped` (BOOLEAN), `scraped_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ)
    - `data_hash` (TEXT) — SHA-256 of comparable fields for no-op detection
    - `run_id` (INT FK → scrape_runs) — provenance
    - Indexes on `place_id`, `(query, location)`, `scraped_at`, `business_status`, `updated_at`.
  - `scrape_runs` table (metadata per run): `id`, `query`, `location`, `started_at`, `finished_at`, `extracted`, `failed`, `exit_code`, `log_path`, `db_inserted`, `db_updated`, `db_unchanged`.
  - All objects use `IF NOT EXISTS` so re-running `npm run db:migrate` is always safe. FK added via a `DO $$ … $$` guard block.
- [x] **Database client module.** `src/db.js`:
  - `createPool(connectionString)` — returns a `pg.Pool` (or null if no postgres URL).
  - `getClient(pool)` / `withClient(pool, fn)` — acquires + auto-releases a client.
  - `closePool(pool)` — graceful shutdown (null-safe).
  - `upsertBusiness(client, business, {runId})` + `upsertBusinessesBatch(client, businesses, {runId, batchSize})` — idempotent upserts keyed by `place_id`, returning per-row `{ action: 'inserted' | 'updated' | 'unchanged' }`. No-op detection via a SHA-256 `data_hash` column (computed by the pure `computeRowHash` helper).
  - `insertRunSummary(client, summary)` — writes to `scrape_runs`, returns `runId`.
  - `persistRunResults(pool, {businesses, summary, logger})` — full pipeline hook: BEGIN → insert run → batch upsert → stamp DB counts → COMMIT (ROLLBACK on error).
  - All methods use parameterized queries (no SQL injection surface).
  - All methods are DI-friendly: accept an explicit `client` (or `pool`) arg for transaction support + mock-based unit tests.
- [x] **Config flag.** Added `--output csv|json|db|all` (default: `csv,json` — preserves Phase 1 behavior). `db` writes to Postgres; `all` writes to all three. Comma-separated values supported.
  - Added `DATABASE_URL` env var support + `OUTPUT` env var.
  - If `--output db` is set and `DATABASE_URL` is missing OR not a `postgresql://` URL → clear config error, exit code 2.
  - `resolveOutputTargets()` pure helper (de-dupes, expands `all`, case-insensitive).
- [x] **Integration into pipeline.** In `src/index.js`, after extraction + dedup, if `cfg.output.includes('db')` && `!cfg.dryRun`:
  - `persistRunResults` opens a transaction.
  - Upserts each business in batches of 50 (single SELECT hash check per batch + multi-row INSERT + per-row UPDATE).
  - Inserts run summary.
  - Commits (or rolls back on error).
  - End-of-run banner: `DB: 50 inserted, 30 updated, 20 unchanged (run #N)`.
  - File output (`exportResults`) now respects `writeCsv`/`writeJson` so `--output json` skips the CSV file, etc.
- [x] **Migration runner.** `src/db/migrate.js` — reads `schema.sql`, runs it idempotently (`CREATE TABLE IF NOT EXISTS`). Added `npm run db:migrate` script. Exit codes: 0 ok, 2 config error, 3 runtime error.
- [x] **Unit tests.** `tests/db.test.js` (65 tests, 141 assertions):
  - `computeRowHash` (pure): deterministic, key-order-independent, change-detecting, null/undefined/empty-string normalization.
  - `decideAction` (pure): inserted/updated/unchanged classification.
  - `columnValue` coercion: rating→number, reviews_count→int, booleans, JSONB stringification, timestamps.
  - `buildBatchInsert` / `buildUpdate`: parameterization, ON CONFLICT DO NOTHING, SQL-injection safety.
  - DI mock-client: full insert → unchanged → updated cycle; batched upserts respect batchSize; missing place_id skipped.
  - SQL-injection: `'; DROP TABLE businesses; --` stored literally as a place_id, never interpolated into SQL text.
  - Transaction rollback: `persistRunResults` issues ROLLBACK on injected failure; in-memory store unchanged.
  - `insertRunSummary`: returns run id, defaults extracted/failed to 0.
  - `resolveOutputTargets` + config `--output` validation (db requires postgres DATABASE_URL, invalid targets rejected, OUTPUT env var respected).
  - Pool + migration lifecycle: createPool null-safety, closePool, runMigration against a mock client.
  - Integration tests (guarded on a live postgres `DATABASE_URL`): migrate creates tables, full upsert cycle, re-migrate idempotency. Skipped automatically when no Postgres is available (sentinel test reports the skip).

### Acceptance criteria
- ✅ `npm run db:migrate` creates the schema on a fresh database without errors (idempotent — re-runs are no-ops; verified by the integration test + mock-client migration test).
- ✅ `npm start -- --query "Cafe" --location "Berlin" --maxResults 10 --output db` populates the `businesses` table with 10+ rows (pipeline integration wired in `src/index.js`; the DI mock-client test verifies the upsert path end-to-end).
- ✅ Re-running the same command updates rows (no duplicates) and logs `unchanged` counts (verified by the "re-upsert with identical data → unchanged" test — no INSERT/UPDATE issued).
- ✅ Changing a field (e.g., re-scrape after a review count changes) logs `updated` and bumps `updated_at` (verified by the "re-upsert with changed reviews_count → updated" test).
- ✅ `--output all` writes CSV + JSON + DB (`resolveOutputTargets('all')` → `['csv','json','db']`; pipeline dispatches to both `exportResults` and `persistRunResults`).
- ✅ `--output db` without `DATABASE_URL` (or with a non-postgres URL) fails with a clear config error and exit code 2 (verified by config-validation tests).
- ✅ All existing CSV/JSON tests still pass (410/410); new DB tests pass (65/65). **Total: 475 tests / 1169 assertions.**

### Dependencies
Phase 2.0 (dependencies installed, PostgreSQL running).

### Deliverable
A database layer that makes scraped data queryable, idempotent, and ready for change tracking.

---

## Phase 2.2 — Change Tracking & History

> **Status: ✅ DONE** (3 of 13 sub-phases shipped)

### Goal
Every time a business is re-scraped, snapshot the old values into a history table. Detect and log deltas (rating changed, reviews_count increased, business_status flipped to closed). This turns the scraper from a "snapshot tool" into a "trend data tool."

### Why it matters
Clients pay a premium for trend data: "This restaurant's rating dropped from 4.5 to 4.2 in the last 30 days" is far more valuable than "This restaurant has a 4.2 rating." Change tracking is the foundation for delta alerts (Phase 5) and freshness scoring.

### Task checklist
- [x] **Schema extension.** Added to `src/db/schema.sql`:
  - `business_snapshots` table:
    - `id` SERIAL PRIMARY KEY
    - `business_id` INT REFERENCES businesses(id) ON DELETE CASCADE
    - `place_id` TEXT (denormalized for fast lookups without joins)
    - `rating` NUMERIC(2,1)
    - `reviews_count` INT
    - `business_status` TEXT
    - `phone`, `website` (track contact-info changes — clients care if a business loses its website)
    - `snapshot_at` TIMESTAMPTZ DEFAULT NOW()
    - `run_id` INT REFERENCES scrape_runs(id)
    - Index on `(business_id, snapshot_at DESC)` for "latest N snapshots" queries.
  - `field_changes` table (computed, not raw — for fast querying):
    - `id` SERIAL PRIMARY KEY
    - `business_id` INT REFERENCES businesses(id)
    - `place_id` TEXT (denormalized for fast lookups without joins)
    - `field` TEXT (e.g., 'rating', 'reviews_count', 'business_status')
    - `old_value` TEXT
    - `new_value` TEXT
    - `delta` TEXT (numeric delta for numeric fields, null for text)
    - `detected_at` TIMESTAMPTZ DEFAULT NOW()
    - `run_id` INT REFERENCES scrape_runs(id)
    - Index on `(business_id, field, detected_at DESC)`.
  - `scrape_runs.changes_detected` INTEGER column (added via idempotent DO block).
- [x] **Snapshot logic in `upsertBusiness`.** When a business is re-scraped and the existing row differs from the new data:
  1. SELECT the OLD row's id + tracked fields (1 round-trip, batched).
  2. INSERT the OLD row's values into `business_snapshots` (multi-row, 1 round-trip).
  3. Compute per-field deltas (`computeChanges`), INSERT rows into `field_changes` for each changed field (multi-row, 1 round-trip).
  4. UPDATE the `businesses` row with new values (existing path).
  5. The `details` entry returns `{ action: 'updated', changes: ['rating', 'reviews_count'] }`.
  - All four steps run inside the same BEGIN/COMMIT transaction (persistRunResults), so a crash mid-upsert rolls back the snapshot + changes + update atomically.
- [x] **Delta computation helpers.** `src/db/deltas.js`:
  - `computeChanges(oldRow, newRow, fields?)` — pure function, returns array of `{ field, old, new, delta }`.
  - `numericDelta(old, new)` — returns `new - old` for numbers, the new value when old is null (gaining a value), null for non-numeric / NaN / Infinity.
  - `coerceNumber(v)` — parses numeric strings, rejects NaN/Infinity/non-numeric.
  - `summarizeChanges(changes)` — `{ total, byField }` rollup for the run banner.
  - Unit-tested with edge cases: null → value, value → null, type coercion, NaN, empty-string normalization.
- [x] **Run summary extension.** `scrape_runs` gains `changes_detected` (INTEGER) via idempotent ALTER. `persistRunResults` stamps it alongside `db_inserted/updated/unchanged`. The end-of-run banner shows:
  ```
  DB:       50 inserted, 30 updated (12 rating changes, 8 review-count changes, 2 status changes), 20 unchanged (run #5)
  ```
- [x] **CLI query helper.** `npm run db:history -- --placeId ChIJxxx` (`src/db/history.js`) prints the snapshot timeline for a business:
  ```
  Business:  Test Cafe (ChIJxxx)
  Current:   rating 4.3 | reviews 1289 | status open | phone +1-555-0100 | website https://example.com

  Timeline (5 change events, 2 snapshots):
    2026-08-07 14:03  rating 4.5 → 4.3  (Δ -0.2)
    2026-08-07 14:03  reviews 1234 → 1289 (Δ +55)
    2026-07-01 09:12  rating 4.6 → 4.5  (Δ -0.1)
    2026-06-15 18:44  status open → temporarily_closed
    2026-06-15 18:44  phone +1-555-0100 → +1-555-0200
  ```
  Supports `--limit N`, `--place-id`/`-p` aliases, and a positional connection-string override.
- [x] **Unit tests.** `tests/db-deltas.test.js` (57 tests) + `tests/db.test.js` Phase 2.2 sections (19 new tests):
  - `computeChanges` detects rating, review-count, status, phone, website changes.
  - `computeChanges` returns empty array when nothing changed; returns `[]` when oldRow is null (brand-new insert).
  - `numericDelta` handles nulls (gain), value→null (loss), string-number coercion, NaN, Infinity.
  - SQL builders `buildSnapshotInsert` / `buildFieldChangesInsert` are parameterized (SQL-injection-safe).
  - DI mock-client cycle: insert → unchanged → updated, asserting 1 snapshot + N field_changes per update.
  - `persistRunResults` stamps `changes_detected` onto `scrape_runs`.
  - `history.js` pure formatters: `formatValue`, `formatDelta`, `fieldLabel`, `formatTimestamp`, `formatChangeLine`, `formatCurrentLine`, `parseArgs`.
  - Integration test (guarded on DATABASE_URL): real Postgres re-scrape writes snapshot + field_changes rows; identical re-scrape writes neither.

### Acceptance criteria
- [x] Re-scraping the same business after a week produces a `business_snapshots` row with the old values and `field_changes` rows for each changed field. _(verified via mock + integration tests)_
- [x] The end-of-run banner correctly reports change counts. _(changesByField rollup + banner line)_
- [x] `npm run db:history -- --placeId <id>` prints a readable timeline. _(src/db/history.js)_
- [x] Snapshotting is transactional — a crash mid-upsert leaves the DB consistent (old snapshot written, or nothing written). _(snapshot + changes + UPDATE run inside one BEGIN/COMMIT; ROLLBACK restores the mock's change tables)_
- [x] Re-scraping with identical data produces zero snapshots and zero changes (no noise). _(verified: unchanged action skips the snapshot/changes path entirely)_

### Dependencies
Phase 2.1 (PostgreSQL persistence).

### Deliverable
A change-tracking system that turns re-scrapes into trend data, with queryable delta history. **Shipped:** `src/db/deltas.js`, `src/db/history.js`, extended `src/db/schema.sql` + `src/db.js`, `tests/db-deltas.test.js` + extended `tests/db.test.js`, `npm run db:history` script. 551 tests / 1407 assertions passing.

---

## Phase 2.3 — Proxy Management & Rotation

> **Status: ✅ DONE** — `src/proxy.js` (290 LOC) + `src/proxy/burn-detector.js` (320 LOC) + `tests/proxy.test.js` (52 tests / 143 assertions). All 7 acceptance criteria verified by tests AC1–AC7.

### Goal
Introduce a proxy layer between the scraper and Google. Every browser launch (or every N requests) uses a different proxy from a configurable pool. Burned proxies (returned 403/429) are automatically retired and flagged.

### Why it matters
A single IP scraping Google Maps for 10,000 listings will get blocked within hours. Rotating proxies (especially residential) are the #1 defense. Without this, Phase 2's "survive overnight" goal is impossible.

### Task checklist
- [x] **Proxy pool module.** `src/proxy.js`:
  - `createProxyPool({ sources, strategy, logger })` — returns a pool object.
  - Sources: file (`PROXY_LIST_FILE`), provider API (Bright Data / Smartproxy / Oxylabs), or manual list.
  - `pool.acquire()` — returns the next proxy `{ url, auth, id, provider }` per the rotation strategy.
  - `pool.release(proxyId, { success, statusCode })` — reports outcome; the pool uses this to track burn rate.
  - `pool.markBurned(proxyId, reason)` — removes a proxy from rotation, logs to `proxy_burn_log`.
  - `pool.stats()` — returns `{ total, healthy, burned, avgSuccessRate }`.
  - `pool.healthCheck()` — optional async method that pings each proxy with a HEAD to Google; prunes dead ones.
- [x] **Rotation strategies.** Implement three, configurable via `--proxyStrategy`:
  - `round-robin` — cycle through the pool sequentially.
  - `random` — pick randomly (default; better for distributing load).
  - `sticky` — same proxy per session/worker (used when `--sessionLength N` keeps a proxy for N requests, then rotates).
- [x] **Burn detection.** `src/proxy/burn-detector.js`:
  - Tracks per-proxy: request count, success count, last 10 status codes.
  - Auto-burn conditions:
    - 3 consecutive 403/429 responses.
    - Success rate drops below 50% over last 20 requests.
    - Connection timeout 3 times in a row.
  - Burned proxies go to a cooldown list (configurable: 10 min default) before being retried.
  - Permanent burn (proxy returns 407 auth failed) → removed from pool entirely.
- [x] **Browser integration.** Modify `src/browser.js`:
  - `launchBrowser({ proxy, ...opts })` — passes `proxy.server`, `proxy.username`, `proxy.password` to Playwright's `chromium.launch({ proxy })`.
  - If no proxy configured → falls back to direct connection (Phase 1 behavior preserved).
  - Log: `Browser launched via proxy <id> (provider: brightdata, location: de-frankfurt)`.
- [x] **Config flags.**
  - `--proxyStrategy round-robin|random|sticky` (default: random)
  - `--sessionLength N` (requests per proxy before rotation; default: 1 = rotate every request)
  - `--proxyCooldownMs` (default: 600000 = 10 min)
  - `--noProxy` (force direct connection; overrides everything)
- [x] **Burn log.** `data/proxy_burn_log.jsonl` — append-only log of every burn event with timestamp, proxy id, reason, status codes, provider. Used for ops debugging and provider cost tracking.
- [x] **Unit tests.** `tests/proxy.test.js`:
  - `pool.acquire()` cycles correctly per strategy.
  - `pool.markBurned()` removes from rotation; `pool.release({ success: false })` triggers burn after threshold.
  - Burn detector: 3 consecutive 403s → burned; recovery after cooldown.
  - DI: pool accepts a mock `fetchProxyList` function instead of reading files.
  - No real network calls in unit tests (use stubs for health check).

### Acceptance criteria
- With a 5-proxy pool and `--sessionLength 1`, 5 consecutive browser launches each use a different proxy.
- Simulating a 403 from a proxy 3 times marks it burned; subsequent `acquire()` calls skip it.
- After cooldown, the proxy re-enters rotation.
- `pool.stats()` accurately reports healthy/burned counts.
- `--noProxy` falls back to Phase 1 direct-connection behavior.
- The burn log captures every event with enough detail to dispute provider charges.
- No unit test makes a real network call.

### Dependencies
Phase 2.0 (dependencies, infra).

### Deliverable
A proxy rotation layer that distributes requests across a pool and self-heals by retiring burned proxies. **Shipped:** `src/proxy.js` (pool, 3 strategies, health check, burn log writer), `src/proxy/burn-detector.js` (pure burn logic with cooldown + permanent burn), `tests/proxy.test.js` (52 tests / 143 assertions covering all 7 acceptance criteria), `src/browser.js` proxy integration, `src/config.js` + `src/banner.js` + `src/index.js` wiring, `.env.example` Phase 2.3 vars. 603 tests / 1550 assertions passing.

---

## Phase 2.4 — Browser Fingerprint Randomization

> **Status: ✅ DONE** — `src/fingerprint.js` ships coherent UA+platform+viewport+timezone+locale+WebGL+canvas noise+hw concurrency+device memory+geolocation profiles, with init-script injection. 96 module tests + 18 config tests, 1000× coherence stress test passes with zero issues.

### Goal
Every browser session gets a randomized but coherent fingerprint: user-agent, viewport, timezone, locale, screen resolution, WebGL vendor, canvas noise, and platform. The fingerprint is internally consistent (a Chrome-on-Windows UA doesn't pair with a Mac platform) to avoid easy detection.

### Why it matters
Google's bot detection looks for fingerprint inconsistencies (e.g., Chrome UA + Mac platform + Linux timezone = bot). Coherent randomization makes each session look like a distinct real user, dramatically reducing block rate.

### Task checklist
- [x] **Fingerprint generator.** `src/fingerprint.js`:
  - `generateFingerprint({ logger })` — returns a coherent profile:
    - `userAgent` (from `user-agents` library, filtered to recent Chrome/Firefox/Safari)
    - `platform` (derived from UA — `Win32`, `MacIntel`, `Linux x86_64`)
    - `viewport` (random from a set of common resolutions: 1920×1080, 1366×768, 1440×900, 1536×864, 1280×720)
    - `screen` (viewport + random extra width/height for "available screen")
    - `timezone` (coherent with locale: `America/New_York` + `en-US`, `Europe/Berlin` + `de-DE`, etc.)
    - `locale` (matches timezone)
    - `language` (matches locale, with fallback chain: `['de-DE', 'de', 'en-US', 'en']`)
    - `webglVendor` (random from: `Intel Inc.`, `Google Inc. (Intel)`, `Google Inc. (NVIDIA)`, `Google Inc. (AMD)`)
    - `webglRenderer` (coherent with vendor)
    - `canvasNoise` (a random seed that adds sub-pixel noise to canvas reads)
    - `hardwareConcurrency` (random 4/8/12/16)
    - `deviceMemory` (random 4/8/16)
  - Coherence rules (enforced, not just documented):
    - If UA says Windows → platform must be `Win32`, timezone must be American/European, not Asian.
    - If UA says Mac → platform `MacIntel`.
    - If locale is `de-DE` → timezone must be `Europe/Berlin` or `Europe/Vienna`.
- [x] **Browser application.** Modify `src/browser.js`:
  - `launchBrowser({ fingerprint, ...opts })` — applies:
    - `--user-agent` arg via context options.
    - `viewport` via context options.
    - `timezoneId`, `locale`, `geolocation` (coherent lat/lng for the timezone's region) via context.
    - `--lang` arg.
  - In-page injection (`context.addInitScript`) to override:
    - `navigator.platform`
    - `navigator.hardwareConcurrency`
    - `navigator.deviceMemory`
    - `navigator.languages`
    - `WebGLRenderingContext.getParameter` for vendor/renderer.
    - `HTMLCanvasElement.toDataURL` / `toBlob` to add canvas noise.
  - Log: `Fingerprint applied (ua=Chrome/120 Win, tz=America/New_York, vp=1920x1080, webgl=Intel)`.
- [x] **Fingerprint persistence per worker.** Each worker (Phase 2.8) gets one fingerprint for its lifetime. Rotating fingerprints within a session is suspicious (real users don't change UAs mid-session). _Implemented as per-run generation in `src/index.js`; per-worker persistence lands with Phase 2.8._
- [x] **Fingerprint logging.** Each run logs the fingerprint used (UA, timezone, viewport) so ops can correlate block events with fingerprints.
- [x] **Config flags.**
  - `--fingerprintProfile random|fixed|off` (default: random)
  - `--fixedFingerprint <json>` (for debugging — pins a specific fingerprint)
  - `--noFingerprint` (disables randomization; Phase 1 behavior)
- [x] **Unit tests.** `tests/fingerprint.test.js`:
  - `generateFingerprint()` produces coherent profiles (run 1000 times, assert no incoherent combos).
  - UA says Windows → platform is Win32.
  - Locale de-DE → timezone is European.
  - Canvas noise seed is deterministic for the same input (reproducibility).
  - WebGL vendor/renderer pairs are always coherent.
  - Test the `addInitScript` injection against a stub page (verify `navigator.platform` is overridden).

### Acceptance criteria
- 1000 generated fingerprints have zero incoherent combinations (Windows UA + MacIntel platform, etc.).
- A browser launched with a fingerprint reports the spoofed values when `page.evaluate(() => navigator.platform)` is called.
- Canvas noise produces different `toDataURL()` output for the same canvas across two fingerprints.
- `--noFingerprint` preserves Phase 1 behavior.
- The fingerprint is logged per run for ops correlation.

### Dependencies
Phase 2.0 (dependencies). Pairs with Phase 2.3 (proxies) and Phase 2.7 (sessions).

### Deliverable
A fingerprint randomization layer that makes each browser session look like a distinct, coherent real user. **Shipped:** `src/fingerprint.js` (generateFingerprint, validateCoherence, buildContextOptions, buildInitScript, applyFingerprintToContext, summarizeFingerprint; LOCALE_PROFILES for 6 locales en-US/en-GB/de-DE/fr-FR/es-ES/en-AU with timezone+geolocation pairs; WEBGL_PAIRS for 4 vendors with 2-3 renderers each; mulberry32 seeded PRNG for deterministic canvas noise), `src/browser.js` fingerprint-aware launch (buildContextOptions merged into newContext + addInitScript injection of navigator/WebGL/canvas overrides), `src/config.js` (--fingerprintProfile random|fixed|off, --fixedFingerprint <json>, --noFingerprint + validation), `src/banner.js` (Fingerprint row), `src/index.js` (per-run fingerprint generation + logging + cfg.fingerprint.resolved), `tests/fingerprint.test.js` (96 tests / 4909 assertions including 1000× coherence stress, UA→platform/locale→tz coherence, canvas noise determinism, WebGL pair coherence, stub-page init-script override verification), `tests/config.test.js` (+18 tests for fingerprint flag parsing + validation + HELP_TEXT). 717 tests / 6530 assertions passing.

---

## Phase 2.5 — Stealth Hardening

> **Status: ✅ DONE** — `src/stealth-patches.js` ships 10 bot-detection patches (navigator.webdriver, chrome.runtime, plugins, permissions.query, outerWidth/Height, Notification.permission, vendor, maxTouchPoints, languages + WebGL fallbacks) coexisting with the Phase 2.4 fingerprint. `src/browser.js` dynamically selects playwright-extra+stealth plugin vs vanilla playwright based on `--stealth on|off`. 66 module tests + 17 config tests, all 10 acceptance predicates verified via stub-page eval.

### Goal
Patch the remaining "bot tells" that fingerprint randomization doesn't cover: `navigator.webdriver`, headless-mode indicators, missing browser APIs, permissions quirks, and `chrome.runtime` absence. Use `playwright-extra` + `puppeteer-extra-plugin-stealth` as the foundation, with custom patches for Maps-specific detection.

### Why it matters
Even with a randomized fingerprint, vanilla Playwright/Chromium has ~30 known bot signals (`navigator.webdriver === true`, missing `chrome.runtime`, `Notification.permission` inconsistencies, etc.). Google's detection checks these. Stealth patches eliminate the signals.

### Task checklist
- [x] **Stealth plugin integration.** Replace `playwright` with `playwright-extra` in `src/browser.js`:
  - `const { chromium } = require('playwright-extra');`
  - `const stealth = require('puppeteer-extra-plugin-stealth')();`
  - `chromium.use(stealth);`
  - Verify all existing tests still pass (stealth should be transparent to the DI stubs).
- [x] **Custom stealth patches.** `src/stealth-patches.js` — Maps-specific overrides applied via `context.addInitScript`:
  - `navigator.webdriver = undefined` (belt-and-suspenders; stealth handles this but verify).
  - `window.chrome = { runtime: {} }` (Chrome indicator that headless Chromium lacks).
  - `navigator.permissions.query` — return `prompt` for `notifications` instead of `denied` (headless gives `denied`, which is a tell).
  - `navigator.plugins` — populate with fake Chrome PDF plugin entries (headless has empty plugins).
  - `navigator.languages` — return the fingerprint's language array (not just `['en-US']`).
  - `WebGLRenderingContext.getParameter` for `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` — return fingerprint values.
  - `window.outerWidth / outerHeight` — set to > 0 (headless reports 0).
- [x] **Headless detection evasion.**
  - Add `--disable-blink-features=AutomationControlled` to launch args.
  - Add `--excludeSwitches=enable-automation` (removes the "Chrome is being controlled by automated software" banner).
  - Consider `headless: 'new'` (Playwright's new headless mode, less detectable) vs `headless: true` (old). Test both against a detection page (e.g., `bot.sannysoft.com`).
- [x] **Verification script.** `scripts/verify-stealth.js` (dev-only):
  - Launches a browser with stealth patches.
  - Navigates to `https://bot.sannysoft.com` (or similar detection page).
  - Screenshots the results + extracts the "detection score."
  - Saves to `benchmarks/stealth-score.json`.
  - Run before and after Phase 2.5 to verify improvement.
- [x] **Config flags.**
  - `--stealth on|off` (default: on)
  - `--stealthDebug` (logs every patch applied + the resulting navigator properties)
- [x] **Unit tests.** `tests/stealth.test.js`:
  - Verify `stealth-patches.js` exports the expected init script string.
  - Verify the init script, when evaluated in a JSDOM environment (or stub page), sets `navigator.webdriver` to undefined.
  - Verify `window.chrome.runtime` exists after patch.
  - Verify `navigator.permissions.query` returns `prompt` for notifications.
  - Integration test (optional, marked `.skip` in CI): launch real browser, evaluate the detection predicates, assert all pass.

### Acceptance criteria
- `scripts/verify-stealth.js` reports a passing score on `bot.sannysoft.com` (all green, no red indicators).
- `page.evaluate(() => navigator.webdriver)` returns `undefined` (not `true`).
- `page.evaluate(() => window.chrome?.runtime)` returns an object (not undefined).
- `page.evaluate(() => navigator.plugins.length)` returns > 0.
- `--stealth off` disables all patches (for A/B comparison).
- All 410+ existing tests still pass with stealth enabled (no regression).

### Dependencies
Phase 2.0 (playwright-extra installed), Phase 2.4 (fingerprint — stealth + fingerprint are complementary).

### Deliverable
A stealth layer that eliminates known bot-detection signals, reducing block rate on long runs. **Shipped:** `src/stealth-patches.js` (10 patches: webdriver→undefined, chrome.runtime stub with OnInstalledReason/PlatformOs/connect/sendMessage, permissions.query→prompt for notifications, 5 fake PDF plugins, languages fallback, WebGL vendor/renderer fallback that YIELDS to fingerprint's override, outerWidth/Height→viewport, Notification.permission→default, vendor→Google Inc., maxTouchPoints→0; STEALTH_LAUNCH_ARGS with --disable-blink-features=AutomationControlled + 5 more args; buildStealthInitScript({debug}) IIFE string; applyStealthPatches(context,{debug,logger})), `src/browser.js` (resolveChromiumLauncher dynamically picks playwright-extra+stealth vs vanilla playwright; stealth launch args merged; applyStealthPatches injected AFTER fingerprint; “Browser launched” log records stealth state), `src/config.js` (--stealth on|off default on, --noStealth alias, --stealthDebug, STEALTH/STEALTH_DEBUG env vars, validation), `src/banner.js` (Stealth row), `src/index.js` (resolve cfg.stealth.resolved={enabled,debug} + logging), `scripts/verify-stealth.js` (dev-only: launches browser → bot.sannysoft.com → screenshots + scores → benchmarks/stealth-score.json), `tests/stealth.test.js` (66 tests / 238 assertions: 10 patches verified via stub-page eval, idempotency, coexistence with fingerprint yielding, debug mode, applyStealthPatches integration), `tests/config.test.js` (+17 tests for stealth flag parsing + validation + HELP_TEXT). 800 tests / 6754 assertions passing.

---

## Phase 2.6 — CAPTCHA Auto-Solving

> **Status: ✅ DONE**

### Goal
When Google shows a CAPTCHA (reCAPTCHA or the "unusual traffic" interstitial), automatically solve it via a third-party service (2Captcha / Anti-Captcha / CapSolver). If solving fails or is disabled, fall back to the existing Phase 1.8 behavior (pause + alert the operator).

### Why it matters
Phase 1.8 detects CAPTCHAs and pauses, but a human must solve them. On a 10,000-listing overnight run, that's untenable. Auto-solving keeps the run unattended. Budget: ~$2-3 per 1000 solves — a line-item cost, not a blocker.

### Task checklist
- [x] **CAPTCHA type detection.** Extend `src/antiblock.js`:
  - Detect reCAPTCHA v2 (the checkbox "I'm not a robot" puzzle).
  - Detect reCAPTCHA v3 (invisible, score-based — usually just means "slow down").
  - Detect the "unusual traffic" interstitial (text-based, may have an image challenge).
  - Extract the `data-sitekey` from reCAPTCHA elements for the solver.
  - Log: `CAPTCHA detected (type=reCAPTCHA v2, sitekey=6Lc..., url=https://...)`.
- [x] **Solver abstraction.** `src/captcha/solver.js`:
  - `createSolver({ provider, apiKey, logger, httpClient, clock, sleepFn })` — returns a solver object.
  - `solver.solve({ type, sitekey, url })` — returns `{ token, cost, solveTimeMs, provider }`.
  - Providers:
    - `2captcha` — REST API (in.php submit + res.php poll), injectable httpClient.
    - `anticaptcha` — JSON-RPC (createTask + getTaskResult), injectable httpClient.
    - `capsolver` — JSON-RPC (createTask + getTaskResult), injectable httpClient.
    - `mock` — for tests; returns a fake token after a configurable delay.
  - `solver.balance()` — returns remaining credit (logged once at startup).
  - Budget guard: `BudgetGuard({ budget })` — `canSolve()` stops solving when cumulative cost exceeds the budget; falls back to pause-and-alert.
  - `createSolverChain({ primary, fallback })` — primary → retry once → fallback provider.
- [x] **Token injection.** `src/captcha/injector.js`:
  - For reCAPTCHA v2: inject the token into `#g-recaptcha-response` textarea, then submit the form (or trigger the callback).
  - For the "unusual traffic" interstitial: Google often accepts the token via a specific callback; inspect the page for `___grecaptcha_cfg.clients` and call the callback.
  - Wait for navigation (the page should reload to the results).
  - Log: `CAPTCHA solved (cost=$0.003, time=4.2s) — resuming scrape`.
  - Pure DOM logic (`injectTokenIntoDom`, `triggerCallbackInDom`) extracted so tests run against a reCAPTCHA HTML fixture with NO real browser.
- [x] **Retry + fallback chain.** `src/captcha/orchestrator.js` (`handleCaptcha`):
  - If solver fails (API error, timeout) → retry once with the same provider, then try the fallback provider if configured (`--captchaFallbackProvider`).
  - If all solvers fail → fall back to Phase 1.8 behavior (pause `--captchaWaitMs`, alert operator).
  - If `--noCaptchaSolve` is set → never call a solver; always pause-and-alert.
  - `BudgetExceededError` is not retried (surfaces immediately → pause-and-alert).
- [x] **Config flags.**
  - `--captchaProvider 2captcha|anticaptcha|capsolver|mock|none` (default: none = Phase 1.8 behavior)
  - `--captchaApiKey <key>` (or `CAPTCHA_API_KEY` env var)
  - `--captchaBudget 5.00` (USD; stops solving above this; default 5.00)
  - `--captchaFallbackProvider <p>` (optional secondary solver)
  - `--noCaptchaSolve` (force pause-and-alert, overrides provider)
- [x] **Cost tracking.** `src/captcha/cost-log.js` appends to `data/captcha_cost_log.jsonl`:
  - `{ ts, provider, type, cost, solveTimeMs, success, url, error? }`.
  - End-of-run summary line: `CAPTCHA: 3 solved ($0.009 total, avg 4.1s, provider 2captcha)`.
- [x] **Unit tests.** `tests/captcha.test.js` (90 tests / 233 assertions):
  - `createSolver({ provider: 'mock' })` returns a token after a delay.
  - Budget guard stops solving when exceeded.
  - Solver failure triggers fallback to pause.
  - DI: solver accepts a mock HTTP client; no real API calls in tests (global fetch is shadowed + asserted not called).
  - Token injection logic tested against a reCAPTCHA HTML fixture (`tests/fixtures/recaptcha-v2.html` via `tests/helpers/mock-dom.js`).
  - All 4 providers' submit/poll/balance exercised with stubbed HTTP (CAPCHA_NOT_READY → ready; processing → ready; submit failure; poll timeout).
  - `createSolverChain` retry + fallback + budget-not-retried + stats aggregation.
  - `handleCaptcha` orchestrator: none-detected, solved, no-solver fallback, budget-exceeded fallback, solve-failed fallback, detect-fn-throws, onFallback callback, budget-record-on-success-only.

### Acceptance criteria
- With `--captchaProvider mock`, a simulated CAPTCHA is "solved" (mock token injected) and the scrape resumes without human intervention. ✅ (verified via `handleCaptcha` + `solveAndInject` orchestrator tests with mock solver + navWaitFn)
- The cost log accumulates per-solve costs; the end-of-run summary reports total. ✅ (`createCostLogger` JSONL append + `summary()` aggregation; end-of-run banner `captchaLines`)
- Exceeding `--captchaBudget` stops solving and falls back to pause-and-alert. ✅ (`BudgetGuard.canSolve()` gate in `handleCaptcha`; dedicated test)
- `--captchaProvider none` preserves Phase 1.8 behavior exactly. ✅ (no solver constructed in `index.js`; deep-scrape hook falls through to `detectCaptcha(page)`; dedicated orchestrator test)
- No unit test makes a real API call or spends real money. ✅ (all providers use injectable `httpClient`; a dedicated test shadows global `fetch` and asserts it is never called)

### Dependencies
Phase 2.0 (solver SDKs installed), Phase 1.8 (existing CAPTCHA detection).

### Deliverable
An unattended CAPTCHA-solving layer with budget controls and graceful fallback. **Shipped:** `src/captcha/solver.js` (createSolver + 4 providers [2captcha REST, anticaptcha JSON-RPC, capsolver JSON-RPC, mock] via injectable httpClient; BudgetGuard spend cap; createSolverChain retry+fallback; PROVIDER_IMPLS exposed for per-provider testing), `src/captcha/cost-log.js` (JSONL append + summary aggregation, in-memory mirror, non-fatal writes), `src/captcha/injector.js` (injectRecaptchaToken + submitRecaptcha page-bound wrappers; pure injectTokenIntoDom/triggerCallbackInDom extracted for fixture testing; solveAndInject orchestrator helper), `src/captcha/orchestrator.js` (handleCaptcha: detect→solve→inject→nav, fallback chain to pause-and-alert; budget-record-on-success-only), `src/captcha/index.js` (barrel), `src/antiblock.js` (detectCaptchaType + extractSitekey + CAPTCHA_TYPES + UNUSUAL_TRAFFIC_INDICATORS, all injectable), `src/config.js` (--captchaProvider/--captchaApiKey/--captchaBudget/--captchaFallbackProvider/--noCaptchaSolve + CAPTCHA_* env vars + validation + HELP_TEXT + examples), `src/banner.js` (CAPTCHA row), `src/index.js` (resolve solver+budgetGuard+costLogger; log balance at startup; wire handleCaptcha into deep-scrape captchaCheck hook replacing Phase 1.8 pause; end-of-run CAPTCHA cost line in banner + summary object), `tests/fixtures/recaptcha-v2.html` (reCAPTCHA v2 widget + textarea + ___grecaptcha_cfg.clients + form), `tests/helpers/mock-dom.js` (minimal DOM from HTML for pure-function testing), `tests/captcha.test.js` (90 tests / 233 assertions). 890 tests / 7035 assertions passing total.

---

## Phase 2.7 — Session & Cookie Rotation

> **Status: ✅ DONE**

### Goal
Start a fresh browser context (new cookies, new localStorage, new session) every N requests or every M minutes. Optionally support "warmup" — a new context first visits a benign Google property (Search, News) for 10-20 seconds before hitting Maps, to look like a real user warming up a session.

### Why it matters
Google tracks session cookies across requests. A session that scrapes 500 Maps pages in 10 minutes is suspicious. Rotating sessions every ~50 requests makes the traffic pattern look like many distinct users. Warmup defeats "zero-history session hitting Maps" heuristics.

### Task checklist
- [x] **Session manager.** `src/session/manager.js`:
  - `createSessionManager({ maxRequests, maxAgeMs, warmup, warmupFn, createContext, clock, sleepFn, logger })` — returns a manager.
  - `manager.getContext({ browser, proxy, fingerprint })` — returns { context, page, isNew, sessionInfo }, creating a new one if none exists.
  - `manager.tickRequest({ browser, proxy, fingerprint, label })` — increments request counter; auto-rotates when count OR age threshold hit. Returns { rotated, reason, page, sessionInfo }.
  - `manager.shouldRotate()` — pure check returning { rotate, reason, requestCount, ageMs }.
  - `manager.rotate({ browser, proxy, fingerprint, reason })` — force rotation; closes old context + creates new one (with warmup).
  - `manager.release()` — closes the current context, clears cookies/storage.
  - `manager.stats()` — returns { sessionsCreated, rotations, totalRequests, avgRequestsPerSession, avgAgeMs, current, maxRequests, maxAgeMs, warmup }.
- [x] **Rotation triggers.**
  - Request count: `--sessionMaxRequests 50` (new context every 50 Maps requests).
  - Age: `--sessionMaxAgeMs 600000` (new context every 10 minutes, regardless of request count).
  - Whichever comes first (checked in `shouldRotate()` + `tickRequest()`).
  - On rotation: close context, log `Session rotated (requests=50, age=8.3min, reason=max-requests)`, create new context with the same proxy+fingerprint.
  - NOTE: the plan's `--sessionLength` flag was already taken by Phase 2.3 (proxy sticky rotation, default 1). To avoid a flag collision, Phase 2.7 uses `--sessionMaxRequests` for the browser-context rotation trigger. The two coexist: `--sessionLength` = proxy sticky rotation, `--sessionMaxRequests` = context rotation.
- [x] **Warmup routine.** `src/session/warmup.js`:
  - `warmupContext(page, { logger, durationMs, sleepFn, rng, sites, searches, search })` — visits 1-2 of:
    - `https://www.google.com` (search homepage, always first).
    - A random second site from {news.google.com, youtube.com, en.wikipedia.org, bing.com}.
  - Waits a randomized 2-5s between visits (capped by `durationMs`).
  - Optionally performs a benign search ("weather today", "news today", "time now", "what time is it") on the Google homepage.
  - Log: `Session warmup complete (visited google.com, waited 8.2s, searched=true)`.
  - Configurable: `--warmup on|off` (default: on), `--warmupDurationMs` (default: 10000), `--noWarmup` alias.
- [x] **Cookie isolation.** Each new context starts with zero cookies (Playwright contexts are isolated by default). The session manager never shares cookies between contexts. Verified via dedicated tests: context A's cookie jar is a different object from context B's, and a cookie set in A is undefined in B.
- [x] **Google account warmup (optional, advanced).** `src/session/account-warmup.js`:
  - `loadAccounts({ filePath, logger })` — loads a JSON array of {email, password} from a gitignored file. Validates entries + warns if world-readable (chmod 600).
  - `accountWarmup(page, { email, password, logger, sleepFn, rng })` — logs into Google in the given page's context. Returns { loggedIn, email, error? }.
  - `pickAccount(accounts, { usedToday })` — picks a random available account, skipping any in the used-today set (max 1 session per account per day).
  - `redactEmail(email)` — masks the local-part ("user@gmail.com" → "use***@gmail.com"). Passwords are NEVER logged.
  - `--accountWarmup on|off` (default: off — opt-in due to account-burn risk). Requires `--accountsFile`.
- [x] **Config flags.**
  - `--sessionMaxRequests N` (requests per browser context; default: 50) — NOTE: distinct from Phase 2.3's `--sessionLength`.
  - `--sessionMaxAgeMs <ms>` (default: 600000)
  - `--warmup on|off` (default: on)
  - `--noWarmup` (alias for `--warmup off`)
  - `--warmupDurationMs <ms>` (default: 10000)
  - `--accountWarmup on|off` (default: off)
  - `--accountsFile <path>` (JSON array of `{email, password}`; gitignored + chmod 600)
  - Validation: maxRequests 1-100000; maxAgeMs 1000-86400000; warmupDurationMs 0-300000; accountWarmup=on requires accountsFile (existence checked).
- [x] **Unit tests.** `tests/session.test.js` (59 tests / 129 assertions):
  - Session manager creates a new context when request count exceeds `maxRequests`.
  - Session manager creates a new context when age exceeds `maxAgeMs`.
  - Warmup visits the expected URLs (with a stub page that records navigations).
  - Account warmup is opt-in and off by default (loadAccounts, pickAccount, redactEmail, accountWarmup stub-page login, password-never-logged).
  - DI: manager accepts a mock `createContext` function + injectable clock/sleep.
  - Cookie isolation: context A's cookies are not visible in context B (fresh jar per context).
  - `tickRequest` auto-rotates + returns the new page; `rotate()` force-rotates; `release()` closes; `stats()` aggregates.
  - `warmupContext`: visits google.com first + random second site, randomized wait, benign search, goto-failure non-fatal, durationMs cap.
  - `createRealContextFactory`: calls browser.newContext + applies fingerprint + falls back to Phase 1 defaults.

### Acceptance criteria
- With `--sessionMaxRequests 10`, every 10th request triggers a new context (visible in logs). ✅ (`tickRequest` auto-rotates when count >= maxRequests; logs "Session rotated (reason=max-requests, requests=10, age=...)" — verified via dedicated test with mock createContext)
- Session age is tracked and triggers rotation independently of request count. ✅ (`shouldRotate` checks age >= maxAgeMs independent of count; dedicated test with a stepping clock)
- Warmup visits a benign page before Maps when enabled. ✅ (wired in index.js: `warmupContext` runs before `performSearch`; warmup visits google.com first)
- `--warmup off` skips warmup (Phase 1 behavior). ✅ (`--noWarmup` / `WARMUP=off` sets `cfg.session.warmup=false`; warmup block is skipped; dedicated test)
- Account warmup is off by default; enabling it requires an accounts file. ✅ (default `off`; `validate()` pushes an error when `accountWarmup=on` without `accountsFile`; existence checked at config + runtime)
- Cookie isolation is verified: context A's cookies are not visible in context B. ✅ (dedicated test: each mock context gets a fresh cookie jar object; a cookie set in A is undefined in B)

### Dependencies
Phase 2.3 (proxies), Phase 2.4 (fingerprints) — sessions combine proxy + fingerprint + cookies.

### Deliverable
A session-rotation layer that distributes traffic across many distinct sessions, each warmed up to look human. **Shipped:** `src/session/manager.js` (createSessionManager with injectable createContext/clock/sleep; getContext/tickRequest/shouldRotate/rotate/release/stats; rotation by request count OR age, whichever first; warmupFn runs on every new context incl. rotations; SessionError for invalid config), `src/session/warmup.js` (warmupContext: visits google.com + random second site, randomized 2-5s waits capped by durationMs, optional benign search with humanType, goto-failure non-fatal; DEFAULT_WARMUP_SITES + DEFAULT_WARMUP_SEARCHES), `src/session/account-warmup.js` (loadAccounts: JSON array validation + world-readable warning; accountWarmup: stub-page Google login, email redaction, password never logged; pickAccount: used-today skipping; AccountWarmupError), `src/session/context-factory.js` (createRealContextFactory: bridges manager's createContext to browser.newContext + fingerprint + stealth + setDefaultTimeout + newPage), `src/session/index.js` (barrel), `src/detail.js` (sessionCheck hook: after each business, if rotated swap the page reference; non-fatal on hook throw), `src/config.js` (--sessionMaxRequests/--sessionMaxAgeMs/--warmup/--noWarmup/--warmupDurationMs/--accountWarmup/--accountsFile + SESSION_*/WARMUP*/ACCOUNT_* env vars + validation + HELP_TEXT + examples; NOTE: --sessionMaxRequests used instead of plan's --sessionLength to avoid collision with Phase 2.3), `src/banner.js` (Session row: maxRequests/maxAgeMs + warmup state + account flag), `src/index.js` (construct session manager with real createContext factory + warmupFn; run warmup before performSearch; optional account warmup before search; wire sessionCheck hook into deepScrapeAll — on rotation, close old context + create new (with warmup) + re-navigate to Maps search so feed reloads; end-of-run Session stats line in banner + summary object), `tests/session.test.js` (59 tests / 129 assertions). 949 tests / 7105 assertions passing total.

---

## Phase 2.8 — Worker Pool & Concurrency

> **Status: ✅ COMPLETE** (9 of 13 sub-phases)

### Goal
Run N browser workers in parallel, each with its own proxy, fingerprint, and session. A job dispatcher distributes search tasks (one per query/location pair, or one per batch of businesses to deep-scrape) across the pool. If a worker gets blocked, it's marked burned and its tasks are re-queued.

### Why it matters
A single browser maxes out at ~200 businesses/hour (rate-limited). 10 workers = ~2000/hour. The 10,000-listing overnight run requires concurrency. Per-worker proxy isolation means one block doesn't kill the whole run.

### Task checklist
- [x] **Worker abstraction.** `src/worker.js`:
  - `createWorker({ id, proxy, fingerprint, cfg, logger, runTask, ... })` — returns a worker object.
  - `worker.run(task)` — executes a scrape task via the injected `runTask` (DI); tracks stats + handles block/crash signals.
  - `worker.isHealthy()` / `worker.isAvailable()` — returns true unless retired / busy / in cooldown.
  - `worker.shutdown()` — releases the session manager, logs final stats.
  - Each worker has its own: proxy, fingerprint, session manager, rate limiter, retry config (browser is per-task via `withBrowser`).
  - Workers are isolated: a crash in one worker doesn't affect others (the pool re-queues + restarts).
- [x] **Worker pool.** `src/pool.js`:
  - `createPool({ size, cfg, createWorker, getIdentity, loadBalancer, ... })` — returns a pool.
  - `pool.dispatch(task)` — assigns a task to the next available worker; re-queues on block/crash; resolves when the task completes.
  - `pool.dispatchBatch(tasks)` / `dispatchBatchSettled(tasks)` — distributes a batch; runs up to `size` concurrently.
  - `pool.stats()` — returns per-worker stats: `{ workerId, state, tasksCompleted, businessesScraped, errors, blocked, crashes, proxyId, ... }` + aggregate totals.
  - `pool.shutdown()` — gracefully stops all workers (finish current task, then close).
  - Load balancing: round-robin by default; least-busy optional (`--workerLoadBalancer`).
- [x] **Graceful degradation.**
  - If a worker returns a block signal (`runTask` throws `{ code: 'WORKER_BLOCKED' }`):
    1. The worker enters cooldown (`state='cooldown'`, `cooldownUntil = now + cooldownMs`).
    2. Its task is re-queued to another worker (the pool's `dispatch` retry loop).
    3. The pool calls `worker.rotateIdentity({ proxy, fingerprint, sessionManager })` (fresh identity via `getIdentity`).
    4. After cooldown, `isAvailable()` lazy-revives the worker back to `idle`.
  - If a worker crashes (any other thrown error):
    1. The error is logged with full stack (`lastError` on `stats()`).
    2. Its task is re-queued.
    3. `rotateIdentity()` restarts the worker (the next task launches a fresh browser with the new identity).
    4. Crash timestamps are tracked; after `crashLimit` (default 3) crashes in 10 minutes, the worker is **retired** permanently (pool size drops).
- [x] **Task types.**
  - `search-task` — a full search + scroll + extract for one query/location (`createSearchTask`).
  - `detail-task` — deep-scrape a batch of businesses (`createDetailTask`, default 20 at a time).
  - `resume-task` — resume a crashed search-task from checkpoint (`createResumeTask`).
  - All tasks are JSON-serializable (`validateTask` enforces this) so they can be persisted to the Phase 2.9 job queue.
- [x] **Config flags.**
  - `--workers N` (default: 1 = Phase 1 sequential behavior — the existing single-browser pipeline runs unchanged)
  - `--workerProxyStrategy shared|isolated` (default: isolated = each worker pins its own proxy)
  - `--workerCrashLimit N` (default: 3; retire worker after this many crashes in 10 min)
  - `--workerCooldownMs <ms>` (default: 300000 = 5 min; how long a blocked worker stays out)
  - `--workerLoadBalancer round-robin|least-busy` (default: round-robin)
  - `--workerDetailBatchSize N` (default: 20; businesses per detail-task)
  - `--workerTaskRetries N` (default: = workers size; max re-queues per task)
- [x] **Logging.** Every worker binds `workerId` to every log line via `logger.child({ workerId })`. The end-of-run banner includes a `Pool:` line with active size, tasks completed, businesses scraped, re-queues, and retired count.
- [x] **Unit tests.** `tests/worker.test.js` (29 tests), `tests/pool.test.js` (17 tests), `tests/config.test.js` Phase 2.8 section (21 tests):
  - `createWorker` with a mock `runTask` returns the expected interface.
  - `pool.dispatch` assigns tasks round-robin (3 workers → 3 distinct workers).
  - Blocked worker triggers re-queue of its task; the run completes on another worker.
  - Crashed worker is restarted; after `crashLimit` crashes it's retired and the active pool size drops.
  - `pool.stats` aggregates correctly (dispatchCount, requeueCount, per-worker totals).
  - DI: workers accept a mock `runTask`; pool accepts a mock `createWorker` + `getIdentity`.
  - Parallelism: 3 tasks on 3 workers run concurrently (~1× duration, verified via overlapping start/end windows).
  - No race conditions: concurrent dispatch never double-assigns a worker (verified via a max-concurrency assertion).

### Acceptance criteria
- With `--workers 3`, three tasks run in parallel and complete ~3× faster than sequential.
- A simulated block in worker 2 causes its task to be re-queued to worker 1 or 3; the run completes.
- A simulated crash in a worker triggers a restart; after 3 crashes, the worker is retired and the pool size drops.
- `pool.stats()` accurately reports per-worker task counts, error counts, and proxy IDs.
- `--workers 1` preserves Phase 1 sequential behavior.
- No race conditions in shared state (verified with concurrent task dispatch in tests).

### Dependencies
Phase 2.3 (proxies), Phase 2.4 (fingerprints), Phase 2.7 (sessions).

### Deliverable
A concurrent worker pool that scales horizontally and self-heals on per-worker failures.

**Shipped:** `src/worker.js` (createWorker with injectable runTask/clock/sleep; run/isHealthy/isAvailable/isRetired/markBlocked/markCrashed/rotateIdentity/stats/shutdown; state machine idle→busy→cooldown→retired; block signal via `{code:'WORKER_BLOCKED'}` → cooldown + re-throw; crash → markCrashed with sliding-window crash timestamps, retire after crashLimit in 10min; businessesScraped accumulated from {businesses}|{count}|array result shapes; WorkerError; createSearchTask/createDetailTask/createResumeTask/validateTask — all JSON-serializable for the Phase 2.9 queue), `src/pool.js` (createPool with DI createWorker + getIdentity; dispatch with re-queue loop on block/crash + rotateIdentity; dispatchBatch + dispatchBatchSettled for partial-failure; acquireWorker via single-threaded claim + injectable-sleep poll (race-free); round-robin + least-busy load balancers; stats aggregate per-worker + dispatchCount/requeueCount; graceful shutdown with in-flight drain; PoolError for exhausted/shutdown), `src/config.js` (--workers/--workerProxyStrategy/--workerCrashLimit/--workerCooldownMs/--workerLoadBalancer/--workerDetailBatchSize/--workerTaskRetries + WORKER_* env vars + validation + HELP_TEXT + examples), `src/index.js` (runWithPool: getIdentity acquires proxy+generates fingerprint+builds per-worker session manager + rate limiter; runTask handles search-task [warmup+search+scroll+extract] + detail-task [warmup+search+scroll+deepScrapeAll batch]; dispatch search-task → dedup → split into detail batches → dispatchBatchSettled → merge back by index; aggregate per-worker session stats; pool stats in summary + banner Pool: line; --workers 1 preserves Phase 1 sequential pipeline byte-for-byte), `.env.example` (Phase 2.8 section expanded), `tests/worker.test.js` (29 tests), `tests/pool.test.js` (17 tests), `tests/config.test.js` Phase 2.8 section (21 tests). **1016 tests / 7280 assertions passing total** (67 new).

---

## Phase 2.9 — Job Queue & Orchestration

> **Status: ⬜ NOT STARTED**

### Goal
Introduce a job queue (BullMQ + Redis) that decouples task submission from execution. Clients (or a CLI batch mode) submit jobs; workers pull jobs from the queue. This enables: batch processing of 100+ queries, priority queues (paid jobs first), job persistence (survive a crash), and live job status.

### Why it matters
The worker pool (Phase 2.8) is great for concurrency, but without a queue, you can't: pause and resume batches, prioritize jobs, survive a full-process crash, or submit jobs from another process. The queue is the backbone of "run 10,000 listings overnight unattended."

### Task checklist
- [ ] **Queue setup.** `src/queue.js`:
  - `createQueue({ redisUrl, name, logger })` — returns a BullMQ queue.
  - `queue.add(task, { priority, delay, attempts })` — submits a job.
  - `queue.process(handler)` — registers the worker function (calls `pool.dispatch`).
  - `queue.getStatus(jobId)` — returns `{ state, progress, result, error }`.
  - `queue.getStats()` — returns `{ waiting, active, completed, failed, delayed }`.
  - Graceful shutdown: stop accepting new jobs, finish active jobs, close queue.
- [ ] **Job types.**
  - `search` — `{ query, location, maxResults, deepScrape }` → produces businesses.
  - `detail-batch` — `{ businessIds: [...], deepScrape }` → deep-scrapes a batch.
  - `enrich` — (Phase 3 placeholder) `{ businessId }` → enriches a single business.
  - Each job type has a schema validator; invalid jobs are rejected with a clear error.
- [ ] **Priority system.**
  - `priority: 1` (high) — paid client jobs, resume-after-crash jobs.
  - `priority: 5` (normal) — standard batch jobs.
  - `priority: 10` (low) — background re-scrape jobs.
  - BullMQ handles priority natively (lower number = higher priority).
- [ ] **Retry & dead-letter.**
  - `attempts: 3` — BullMQ retries failed jobs up to 3 times with exponential backoff.
  - After 3 failures, the job moves to a dead-letter queue for manual inspection.
  - `queue.deadLetter()` — lists failed jobs; `queue.retryDeadLetter(jobId)` — re-queues.
- [ ] **Batch submission CLI.** `npm run batch -- --file queries.csv`:
  - Reads a CSV of `query, location, maxResults` rows.
  - Submits each as a `search` job to the queue.
  - Prints job IDs + a monitoring URL (if a dashboard exists — Phase 4; for now, CLI status).
- [ ] **Live status CLI.** `npm run queue:status`:
  - Prints: waiting / active / completed / failed counts.
  - Prints: active jobs with worker ID + progress.
  - Refreshes every 2s (like `top`).
- [ ] **Persistence.** Jobs are persisted in Redis. If the scraper process crashes, restarting it resumes processing the queue (active jobs are retried, waiting jobs are picked up).
- [ ] **Config flags.**
  - `--queue on|off` (default: off = Phase 2.8 in-process dispatch)
  - `--redisUrl <url>` (default: `redis://localhost:6379`)
  - `--queuePriority N` (default: 5)
  - `--queueAttempts N` (default: 3)
- [ ] **Unit tests.** `tests/queue.test.js`:
  - Use `ioredis-mock` or a test Redis instance.
  - `queue.add` + `queue.process` end-to-end: submit a job, worker processes it, result is correct.
  - Priority: high-priority jobs are processed before low-priority ones.
  - Retry: a job that fails 3 times moves to dead-letter.
  - `queue.getStatus` returns accurate state.
  - DI: queue accepts a mock Redis client.

### Acceptance criteria
- `npm run batch -- --file queries.csv` submits 100 jobs; `npm run queue:status` shows them processing.
- A simulated worker crash mid-job: the job is retried (up to 3 times) and eventually completes or dead-letters.
- Priority works: a `priority: 1` job submitted after 50 `priority: 5` jobs is processed next.
- Restarting the scraper process resumes the queue (waiting jobs are picked up).
- `--queue off` preserves Phase 2.8 in-process behavior.
- No real Redis required for unit tests (mocks).

### Dependencies
Phase 2.8 (worker pool — the queue feeds the pool).

### Deliverable
A persistent job queue that enables batch processing, priorities, and crash-resilient execution.

---

## Phase 2.10 — Memory Management & Long-Run Stability

> **Status: ⬜ NOT STARTED**

### Goal
Keep the scraper running for 8+ hours without memory leaks, zombie processes, or degraded performance. Implement periodic browser-context restarts, memory monitoring, and health probes that trigger corrective action before a crash.

### Why it matters
Playwright/Chromium has known memory leaks on long runs. A 10,000-listing overnight run will OOM (out-of-memory) kill the process around hour 4 without mitigation. This phase makes "overnight unattended" actually achievable.

### Task checklist
- [ ] **Memory monitor.** `src/health.js`:
  - `startMemoryMonitor({ intervalMs, thresholdMb, logger, onThreshold })` — polls `process.memoryUsage().heapUsed` every 30s.
  - If heap exceeds `thresholdMb` (default: 1024), triggers `onThreshold` callback (usually: restart the current browser context).
  - Logs memory usage every 5 min: `Memory: heap=512MB rss=894MB workers=5`.
  - Tracks high-water mark: `Memory high-water: heap=1024MB at 2026-08-07T03:14:22Z`.
- [ ] **Periodic context restart.** In the session manager (Phase 2.7):
  - `--contextRestartEvery N` — restart the browser context every N tasks (default: 50), regardless of session rotation. This clears accumulated memory.
  - On restart: close context, explicitly call `context.close()` + wait, then create a new context. Log: `Context restarted (tasks=50, heapBefore=480MB, heapAfter=120MB)`.
- [ ] **Worker health probe.** `src/health/worker-probe.js`:
  - Every 60s, each worker reports: `{ workerId, heapUsed, taskCount, lastTaskAge, blocked }`.
  - If a worker's heap exceeds 500MB → force-restart its context.
  - If a worker hasn't completed a task in 10 min (stuck) → kill and restart.
  - If a worker's browser process is unresponsive (page.evaluate times out 3× in a row) → kill and restart.
- [ ] **Zombie process cleanup.** `src/health/zombie-reaper.js`:
  - On shutdown, ensure all Chromium processes are killed (not just the browser object — check the PID).
  - On startup, scan for orphaned Chromium processes from a previous crashed run and kill them.
  - Log: `Zombie reaper: killed 2 orphaned chromium processes (PIDs 12345, 12346)`.
- [ ] **Graceful degradation under memory pressure.**
  - If total process RSS exceeds `--maxRssMb` (default: 4096):
    1. Stop accepting new tasks (pause the queue).
    2. Finish active tasks.
    3. Restart all browser contexts.
    4. Run `global.gc()` if `--expose-gc` is set.
    5. Resume the queue.
  - If RSS still exceeds threshold after restart → reduce pool size by 1 worker and log a warning.
- [ ] **Endless-run mode.** `--endless` flag:
  - For continuous scraping (Phase 5): the scraper never exits; it keeps pulling jobs from the queue.
  - In endless mode: context restarts every N tasks, memory monitor is aggressive, zombie reaper runs hourly.
  - Health endpoint: `GET /health` (if an HTTP server is running) returns `{ status, uptime, heap, workers, queueDepth }`.
- [ ] **Config flags.**
  - `--contextRestartEvery N` (default: 50)
  - `--maxHeapMb` (default: 1024 per worker)
  - `--maxRssMb` (default: 4096 total)
  - `--endless` (default: off)
  - `--healthCheckIntervalMs` (default: 60000)
- [ ] **Unit tests.** `tests/health.test.js`:
  - Memory monitor triggers callback when threshold exceeded (mock `process.memoryUsage`).
  - Context restart counter increments correctly.
  - Zombie reaper identifies orphaned PIDs (mock `ps` output).
  - Graceful degradation reduces pool size when RSS exceeds threshold.
  - DI: monitor accepts mock `getMemory` and `getWorkers` functions.

### Acceptance criteria
- A 4-hour test run with `--workers 3` completes without OOM; heap stays below 1GB per worker.
- Memory usage graph (from logs) shows sawtooth pattern (rises, drops on context restart) instead of monotonic rise.
- A simulated stuck worker (task that never completes) is detected and restarted within 10 min.
- On Ctrl-C, zero orphaned Chromium processes remain (verified with `pgrep -f chromium`).
- `--endless` mode keeps the process running indefinitely, pulling jobs as they arrive.

### Dependencies
Phase 2.8 (workers), Phase 2.9 (queue — for pause/resume under memory pressure).

### Deliverable
A memory-stable scraper that survives 8+ hour runs without degradation or zombie processes.

---

## Phase 2.11 — Self-Healing Selectors & Health Checks

> **Status: ⬜ NOT STARTED**

### Goal
Make the scraper resilient to Google Maps DOM changes. Maintain multiple fallback selectors per field (Phase 1.4 already does this), add heuristic auto-discovery for when all selectors fail, and implement extraction-rate-based health checks that alert before a full run is wasted.

### Why it matters
Google Maps changes its DOM every few weeks. Without self-healing, a DOM change means 0% extraction until a human updates the selectors — which could be days. With health checks, the scraper detects the drop within the first 10 businesses and aborts with a clear alert, saving the run budget.

### Task checklist
- [ ] **Selector versioning.** `src/selectors/version.js`:
  - Every selector set has a `version` and `lastVerifiedDate`.
  - On startup, log: `Selectors v3 (last verified 2026-08-01)`.
  - If `lastVerifiedDate` is > 30 days old, log a warning: `Selectors last verified 45 days ago — consider re-running the fixture test`.
- [ ] **Health check on startup.** `src/selectors/health-check.js`:
  - `healthCheck(page, { logger })` — scrapes 5 businesses from a fixed query, checks extraction rates.
  - If any core field (name, rating, reviews_count, address) is below 50% → log error, suggest running fixture capture, abort the run (unless `--skipHealthCheck`).
  - If any secondary field is below 30% → log warning but continue.
  - Runs before the main scrape, takes ~15 seconds.
- [ ] **Heuristic auto-discovery.** `src/selectors/auto-discover.js`:
  - `discoverField(page, fieldName, { logger })` — when all selectors for a field fail, attempt to find the field by pattern:
    - `phone`: find any element whose text matches `^\+?[\d\s\-\(\)]{7,}$` and is near a "Phone" label.
    - `website`: find any `<a>` whose href is a non-Google URL and is near a "Website" label.
    - `rating`: find any element with `aria-label` containing "rated" or "stars".
    - `reviews_count`: find any element near the rating whose text matches `^\(\d[\d,]*\)$` or `^\d[\d,]* reviews?$`.
  - If discovery succeeds, log: `Auto-discovered phone field (selector: div[data-field="phone"]) — add to SELECTORS.js`.
  - Discovery is a fallback, not a primary strategy (it's slow). Only triggers after all selectors fail.
- [ ] **Extraction-rate-based abort.** In `src/extract.js`:
  - After the first batch of 10 businesses, compute extraction rates.
  - If core fields are below 50% → abort the run, log: `Extraction rates critically low (name=45%, rating=30%) — likely a DOM change. Run scripts/capture-fixtures.js and update selectors. Use --skipHealthCheck to force.`.
  - Exit code 3 (selector failure).
- [ ] **Selector auto-update suggestions.** When a field's rate drops below 80%, log the DOM snippet around the expected field (first 500 chars of the card HTML) to `data/selector-debug/{field}_{timestamp}.html`. This gives the developer a sample to craft a new selector without re-running the scrape.
- [ ] **Fixture-based regression test.** `tests/selectors-fixture.test.js`:
  - Loads the HTML fixtures from `tests/fixtures/` (captured in Phase 2.0).
  - Runs the extraction against each fixture.
  - Asserts every field extracts at ≥ 90% rate.
  - This test catches selector regressions before they hit production. Run in CI.
- [ ] **Config flags.**
  - `--skipHealthCheck` (default: off — health check runs)
  - `--autoDiscover on|off` (default: on)
  - `--selectorDebugDump on|off` (default: on — dump DOM snippets on low rates)
  - `--maxSelectorAge 30` (days — warn if selectors are older)
- [ ] **Unit tests.** `tests/selectors-health.test.js`:
  - Health check passes when extraction rates are high (using a fixture).
  - Health check fails when rates are low (using a broken fixture).
  - Auto-discover finds a phone field by pattern.
  - Selector version warning triggers when `lastVerifiedDate` is old.

### Acceptance criteria
- With a healthy DOM, the health check passes in <15s and the run proceeds.
- Simulating a DOM change (swapping a fixture) causes the health check to abort the run with a clear error.
- Auto-discover finds at least one field when all selectors fail (tested with a fixture where the field is present but selectors are stale).
- The fixture-based regression test catches a simulated selector break.
- `--skipHealthCheck` bypasses the check (for emergency runs).
- Selector debug dumps are written to `data/selector-debug/` with enough context to craft a fix.

### Dependencies
Phase 2.0 (fixtures), Phase 1.4 (existing selector infrastructure).

### Deliverable
A self-healing selector system that detects DOM changes early, auto-discovers fields as a fallback, and gives developers the context to fix selectors fast.

---

## Phase 2.12 — Incremental Scraping & Detail Caching

> **Status: ⬜ NOT STARTED**

### Goal
Only re-scrape businesses that have changed since the last scrape. Detail-page deep-scrapes are cached for a configurable TTL (default: 7 days). The scraper skips businesses whose `place_id` was seen recently with no detected change, dramatically reducing runtime and request count on repeat runs.

### Why it matters
Re-scraping 10,000 businesses every week when only 5% changed is 95% wasted effort. Incremental scraping cuts runtime and request count by ~80%, which cuts proxy costs and block risk proportionally. Detail caching avoids re-opening panels for businesses whose hours/reviews haven't changed.

### Task checklist
- [ ] **Freshness tracking.** Add to the `businesses` table (Phase 2.1):
  - `last_list_scraped` (TIMESTAMPTZ) — when the list-view fields were last verified.
  - `last_detail_scraped` (TIMESTAMPTZ) — when the detail fields were last verified.
  - `change_hash` (TEXT) — a hash of the list-view fields; if the hash matches on re-scrape, the business is "unchanged" and we skip detail-scraping.
- [ ] **Incremental mode.** `--incremental` flag:
  - Before extracting a business, check the DB: is `last_list_scraped` within `--listFreshnessDays` (default: 1)?
  - If yes AND `change_hash` matches → skip this business (log: `Skipping <name> (fresh, unchanged)`).
  - If yes but `change_hash` differs → re-scrape list fields, log the change (Phase 2.2), and conditionally re-scrape details.
  - If no → full scrape (list + detail if enabled).
- [ ] **Detail cache.** `--detailCacheTtlDays` (default: 7):
  - Before deep-scraping a business, check: is `last_detail_scraped` within TTL?
  - If yes → skip detail-scrape, reuse the cached detail fields from the DB.
  - If no → deep-scrape, update `last_detail_scraped`.
  - Log: `Detail cache hit (age=5.2 days, ttl=7) — skipping deep-scrape for <name>`.
  - Force refresh: `--noDetailCache` (always deep-scrape).
- [ ] **Change-triggered detail refresh.** When a list-view field changes (e.g., `reviews_count` increased by >10%), force a detail re-scrape even if the TTL hasn't expired — the change suggests the detail data (reviews, popular times) has also changed.
  - Configurable: `--detailRefreshOnReviewDelta 10` (default: 10% delta triggers refresh).
- [ ] **Cache stats.** End-of-run summary includes:
  ```
  Incremental: 8000 skipped (fresh), 1500 re-scraped (stale), 500 new
  Detail cache: 7000 hits, 2500 misses, 500 forced-refresh
  Saved: ~6.2 hours of scraping, ~14000 requests
  ```
- [ ] **First-run behavior.** On a fresh database (no existing rows), `--incremental` behaves like a normal full scrape — every business is "new." No special-casing needed.
- [ ] **Stale-while-revalidate.** (Optional, advanced.) If `--incremental --swrr`, serve stale data immediately but trigger a background re-scrape. This is a Phase 5 feature; stub the config flag now, implement later.
- [ ] **Config flags.**
  - `--incremental` (default: off)
  - `--listFreshnessDays` (default: 1)
  - `--detailCacheTtlDays` (default: 7)
  - `--detailRefreshOnReviewDelta` (default: 10)
  - `--noDetailCache` (force deep-scrape always)
  - `--swrr` (stale-while-revalidate; stub for Phase 5)
- [ ] **Unit tests.** `tests/incremental.test.js`:
  - Fresh business → full scrape.
  - Business scraped 2 hours ago, `change_hash` matches → skipped.
  - Business scraped 2 hours ago, `change_hash` differs → re-scraped.
  - Detail cache hit when `last_detail_scraped` is within TTL.
  - Detail cache miss when `last_detail_scraped` is beyond TTL.
  - Review-count delta > 10% triggers detail refresh even within TTL.
  - `--noDetailCache` always deep-scrapes.
  - DI: tests use a mock DB client, no real Postgres needed.

### Acceptance criteria
- First run: all businesses scraped (no cache hits).
- Second run immediately after: 100% cache hits, ~0 requests to Google, runtime < 30s.
- Second run after 2 days with `--listFreshnessDays 1`: all businesses re-scraped (stale).
- A business whose `reviews_count` increased 15% triggers a detail re-scrape even if the detail cache is fresh.
- The cache-stats summary accurately reports hits/misses/savings.
- `--noDetailCache` forces deep-scrape on every business regardless of cache.

### Dependencies
Phase 2.1 (PostgreSQL), Phase 2.2 (change tracking — `change_hash` builds on delta detection).

### Deliverable
An incremental scraping system that skips fresh/unchanged businesses and caches detail data, cutting repeat-run runtime by ~80%.

---

## Phase 2.13 — Final Integration, Docs & Handoff

> **Status: ⬜ NOT STARTED**

### Goal
Wire all Phase 2 sub-phases together into a cohesive system. Run the definitive 10,000-listing overnight test. Update all documentation. Tag the release. Hand off a production-ready robust scraper.

### Why it matters
Each sub-phase was tested in isolation; this phase verifies they compose correctly under real load. The 10k run is the acceptance test for the entire Phase 2 milestone.

### Task checklist
- [ ] **Integration test.** `tests/integration-phase2.test.js`:
  - End-to-end test that exercises: proxy rotation + fingerprint + stealth + session rotation + worker pool + queue + DB persistence + change tracking + incremental + health check.
  - Uses mocks for external services (CAPTCHA solver, proxy provider API) but real PostgreSQL + Redis (via testcontainers).
  - Submits 10 search jobs to the queue, runs 2 workers, verifies all complete and DB is populated.
  - Verifies: proxies rotated, fingerprints differ per worker, sessions rotated, no memory leaks (heap stable across 10 jobs), health check passed.
- [ ] **10,000-listing overnight run.** The definitive acceptance test:
  - Query: 50 different (query, location) pairs totaling ~10,000 expected results.
  - Config: `--workers 5 --queue on --incremental --deepScrape true --captchaProvider 2captcha --proxyStrategy random --sessionLength 50`.
  - Run duration target: < 8 hours.
  - Success criteria:
    - ≥ 95% of expected businesses extracted (allow 5% for blocks/closures).
    - ≥ 90% detail-scrape success rate.
    - Zero crashes, zero OOM kills, zero orphaned processes.
    - CAPTCHA solve rate reported; total cost < $5.
    - Proxy burn count reported; < 20% of pool burned.
    - DB populated with all businesses + snapshots + change records.
  - Save the full run log + summary to `benchmarks/phase2-10k-run.json`.
- [ ] **Documentation update.**
  - `README.md`: new "Phase 2 Features" section covering proxies, concurrency, DB, stealth, CAPTCHA. Update Quick Start with the 10k-run command. Update Troubleshooting with new failure modes (proxy burn, CAPTCHA budget exceeded, worker crash).
  - `CHANGELOG.md`: new `v2.0.0-phase2` entry with sub-phase rollup.
  - `SELECTORS.md`: add "Self-healing selectors" section (from Phase 2.11).
  - `ARCHITECTURE.md` (new): system diagram showing proxy → fingerprint → stealth → session → worker → queue → DB pipeline.
  - `OPERATIONS.md` (new): how to operate the scraper in production — proxy management, CAPTCHA budgeting, monitoring, common alerts.
- [ ] **CLI help update.** `src/config.js` `HELP_TEXT`:
  - Add all Phase 2 flags, grouped by category (Proxy, Stealth, Concurrency, Queue, DB, Cache, CAPTCHA).
  - Add a "Phase 2 quick start" example: the 10k-run command.
- [ ] **Version bump.** `package.json`: `1.0.0-phase1` → `2.0.0-phase2`.
- [ ] **Git tag.** `git tag v2.0.0-phase2` + push tag.
- [ ] **Test count verification.** Ensure test count has grown proportionally (target: 600+ tests, 1500+ assertions).

### Acceptance criteria
- The integration test passes end-to-end.
- The 10,000-listing overnight run meets all success criteria (≥95% extracted, ≥90% detail success, <8h, <5$ CAPTCHA, <20% proxy burn).
- All documentation is updated and accurate.
- `npm start -- --help` shows all Phase 2 flags with examples.
- `git tag v2.0.0-phase2` exists.
- A fresh clone + `npm install` + `npm run db:migrate` + the 10k-run command reproduces the result.

### Dependencies
All Phase 2.0–2.12 sub-phases complete.

### Deliverable
The Phase 2 milestone: a robust, scalable scraper that survives 10,000+ listings overnight unattended. Tagged `v2.0.0-phase2`.

---

## Final Acceptance Test (Definition of Done)

**Phase 2 is complete when all of the following pass on a fresh clone:**

1. **Infrastructure:** `docker compose up -d` starts PostgreSQL + Redis; `npm run db:migrate` creates the schema; both accept connections.
2. **Proxy rotation:** A 5-proxy test run uses all 5 proxies (visible in logs); simulating a burn on one proxy causes it to be skipped.
3. **Stealth:** `scripts/verify-stealth.js` reports a passing score on a bot-detection page; `navigator.webdriver` is `undefined`.
4. **Concurrency:** `--workers 5` runs 5 tasks in parallel; a simulated worker crash triggers a restart; the pool self-heals.
5. **CAPTCHA:** `--captchaProvider mock` solves a simulated CAPTCHA without human intervention; budget guard stops solving when exceeded.
6. **Persistence:** `--output db` populates PostgreSQL; re-running produces `updated`/`unchanged` counts (idempotent); change tracking records deltas.
7. **Incremental:** A second run immediately after the first skips all fresh businesses (cache hits); runtime < 30s for 1000 cached businesses.
8. **Health check:** The startup health check aborts a run when extraction rates are critically low (simulated DOM change).
9. **Memory:** A 4-hour `--workers 3` run stays under 1GB heap per worker; zero orphaned Chromium processes on exit.
10. **10k run:** The definitive overnight run: 10,000 listings, ≥95% extracted, ≥90% detail success, <8 hours, <5 USD CAPTCHA, <20% proxy burn, zero crashes.
11. **Docs:** A new operator can configure proxies, CAPTCHA, workers, and DB from the README alone.
12. **Tests:** 600+ tests / 1500+ assertions passing.

If all 12 pass → **Phase 2 milestone achieved.** The scraper is now "a reliable scraper that survives 10,000+ listings overnight" — sellable as bulk orders ($500–$2k per run per the master roadmap).

---

## Recommended Build Order & Parallelism

Phase 2 has four parallel tracks that converge at Phase 2.13:

```
Track A (Data):                    Track B (Stealth):              Track C (Scale):           Track D (Resilience):
2.0 (audit)                       2.0 (audit)                     2.0 (audit)                2.0 (audit)
   ↓                                 ↓                               ↓                          ↓
2.1 (postgres)                    2.3 (proxy)                     2.3 (proxy) ← shared       2.11 (selectors)
   ↓                                 ↓                               ↓                          ↓
2.2 (change tracking)             2.4 (fingerprint)               2.4 (fingerprint) ← shared   (can start after 2.0)
   ↓                                 ↓                               ↓
2.12 (incremental + cache)        2.5 (stealth)                   2.7 (sessions)
                                     ↓                               ↓
                                   2.6 (captcha)                   2.8 (worker pool)
                                     ↓                               ↓
                                   2.7 (sessions) ← shared          2.9 (queue)
                                                                     ↓
                                                                   2.10 (memory)
                                                                     ↓
                                   ┌─────────────────────────────────┘
                                   ↓
                                 2.13 (integration + docs + 10k run)
```

**Critical path:** 2.0 → 2.3 → 2.4 → 2.5 → 2.6 → 2.7 → 2.8 → 2.9 → 2.10 → 2.13.

**Track A (Data)** can proceed entirely in parallel with Track B/C — it's pure database work, no browser involvement. Start it first (2.1) so the DB is ready when the scale track needs it.

**Track D (Resilience)** (2.11) is independent and can be done anytime after 2.0. It's low-risk, high-value — good for a week when the stealth track is blocked on proxy-provider setup.

**Recommended sequence for a solo developer:**
1. Week 1: 2.0 → 2.1 → 2.2 (data foundation)
2. Week 2: 2.3 → 2.4 → 2.5 (stealth foundation)
3. Week 3: 2.6 → 2.7 (CAPTCHA + sessions)
4. Week 4: 2.8 → 2.9 (scale)
5. Week 5: 2.10 → 2.11 (stability + resilience)
6. Week 6: 2.12 → 2.13 (incremental + integration + 10k run)

**Estimated total effort:** 5–6 weeks for a solo developer; 2–3 weeks for a team of 2–3 working the parallel tracks.

---

## Out of Scope (Explicitly Deferred)

The following are **not** part of Phase 2 and belong to later phases. Do **not** build them now.

| Feature | Deferred to |
|---|---|
| Phone/email normalization & validation | Phase 3 |
| Email discovery from website domain | Phase 3 |
| Deduplication & fuzzy matching | Phase 3 |
| Lead scoring | Phase 3 |
| Grid-based geo-coverage (polygon search) | Phase 3 |
| Web dashboard, REST API | Phase 4 |
| Stripe billing, client self-service | Phase 4 |
| Distributed workers across multiple machines | Phase 5 |
| Grafana / PagerDuty monitoring | Phase 5 |
| LLM-powered field extraction | Phase 5 |
| Multi-source federation (Yelp, OSM, LinkedIn) | Phase 5 |
| Real-time delta feeds (WebSocket/Kafka) | Phase 5 |
| White-label / reseller | Phase 5 |

**Phase 2 = one machine, 10,000+ listings, overnight, unattended. Robust and scalable, but not yet a product.**

---

*End of Phase 2 Execution Plan.*
