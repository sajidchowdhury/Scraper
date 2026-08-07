# Phase 2 Execution Plan — "A Reliable Scraper That Survives 10k+ Listings Overnight"

> **Scope:** This document decomposes **Phase 2** of the master roadmap (`SCRAPER_FEATURES.md`, §3) into granular, sequential sub-phases. The single deliverable when all sub-phases are complete: **a Node.js scraper that runs overnight against 10,000+ Google Maps listings without dying — with rotating proxies, fingerprint randomization, CAPTCHA auto-solving, multi-worker concurrency, PostgreSQL persistence, change tracking, and self-healing selectors.**
>
> **Format:** No code — only feature specs, task checklists, and acceptance criteria. Each sub-phase is independently shippable; finishing one before starting the next is strongly recommended.
>
> **Prerequisite:** Phase 1 milestone complete (`v1.0.0-phase1` — 410 tests / 1028 assertions passing). The scraper already searches, paginates, extracts 25 fields, exports CSV/JSON, resumes from checkpoints, and has minimal anti-block.

---

## Status Summary

> **Last updated:** Phase 2.0 complete. 1 of 13 sub-phases shipped.
>
> **Overall:** 1 of 13 sub-phases shipped. Phase 2 work started on `phase2` branch.

| Phase | Status | Commit | Tests | Notes |
|---|---|---|---|---|
| 2.0 — Audit, Fixtures & Dependency Setup | ✅ DONE | _(this commit)_ | 410 | Baseline metrics captured, 6 DOM fixtures, 8 deps installed, docker-compose.yml, .env.example Phase 2 vars |
| 2.1 — PostgreSQL Persistence Layer | ⬜ NOT STARTED | — | — | `pg` client, schema, idempotent upserts, `--output db` flag |
| 2.2 — Change Tracking & History | ⬜ NOT STARTED | — | — | `business_snapshots` table, delta detection, trend data |
| 2.3 — Proxy Management & Rotation | ⬜ NOT STARTED | — | — | `proxy.js`, pool, rotation strategies, burn detection |
| 2.4 — Browser Fingerprint Randomization | ⬜ NOT STARTED | — | — | UA, viewport, timezone, locale, WebGL, canvas, fonts |
| 2.5 — Stealth Hardening | ⬜ NOT STARTED | — | — | `playwright-extra` + stealth, `navigator.webdriver`, headless evasion |
| 2.6 — CAPTCHA Auto-Solving | ⬜ NOT STARTED | — | — | 2Captcha/Anti-Captcha/CapSolver integration, fallback chain |
| 2.7 — Session & Cookie Rotation | ⬜ NOT STARTED | — | — | Fresh context every N requests, warmup hooks |
| 2.8 — Worker Pool & Concurrency | ⬜ NOT STARTED | — | — | N parallel browsers, per-worker proxy+fingerprint, graceful degradation |
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

> **Status: ⬜ NOT STARTED**

### Goal
Add a PostgreSQL persistence layer alongside the existing CSV/JSON export. Every scraped business is upserted into the database, keyed by `place_id`, so re-scraping the same business updates the row instead of duplicating.

### Why it matters
CSVs are great for delivery; databases are great for operations. With Postgres, we get: idempotent re-scrapes, queryable data (filter by city, rating, category), change tracking (Phase 2.2), and the foundation for an API (Phase 4).

### Task checklist
- [ ] **Schema design.** Create `src/db/schema.sql` (version-controlled, idempotent):
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
    - Indexes on `place_id`, `(query, location)`, `scraped_at`, `business_status`.
  - `scrape_runs` table (metadata per run): `id`, `query`, `location`, `started_at`, `finished_at`, `extracted`, `failed`, `exit_code`, `log_path`.
- [ ] **Database client module.** `src/db.js`:
  - `getClient()` — returns a pooled `pg.Pool` client.
  - `closePool()` — for graceful shutdown.
  - `upsertBusiness(business)` — INSERT … ON CONFLICT (place_id) DO UPDATE, returning `action: 'inserted' | 'updated' | 'unchanged'` (compare a hash of field values to detect no-op updates).
  - `insertRunSummary(summary)` — writes to `scrape_runs`.
  - All methods use parameterized queries (no SQL injection surface).
  - All methods are DI-friendly: accept an optional `client` arg for transaction support.
- [ ] **Config flag.** Add `--output csv|json|db|all` (default: `csv,json` — preserves Phase 1 behavior). `db` writes to Postgres; `all` writes to all three.
  - Add `DATABASE_URL` env var support.
  - If `--output db` is set and `DATABASE_URL` is missing → clear error, exit code 2.
- [ ] **Integration into pipeline.** In `src/index.js`, after extraction + dedup, if `cfg.output.includes('db')`:
  - Open a transaction.
  - Upsert each business in batches of 50 (avoid per-row round-trips).
  - Insert run summary.
  - Commit.
  - Log: `DB: 50 inserted, 30 updated, 20 unchanged`.
- [ ] **Migration runner.** `src/db/migrate.js` — reads `schema.sql`, runs it idempotently (`CREATE TABLE IF NOT EXISTS`). Add `npm run db:migrate` script.
- [ ] **Unit tests.** `tests/db.test.js`:
  - Use a test database (e.g., `gmaps_scraper_test`) or testcontainers.
  - Test upsert insert → update → unchanged cycle.
  - Test that re-scraping with identical data returns `unchanged` (no row mutation).
  - Test that re-scraping with changed `reviews_count` returns `updated` and bumps `updated_at`.
  - Test transaction rollback on error.
  - Test SQL-injection safety (place_id containing `'; DROP TABLE—` is stored literally, not executed).
  - DI: `upsertBusiness` accepts a mock client for tests that don't hit Postgres.

### Acceptance criteria
- `npm run db:migrate` creates the schema on a fresh database without errors.
- `npm start -- --query "Cafe" --location "Berlin" --maxResults 10 --output db` populates the `businesses` table with 10+ rows.
- Re-running the same command updates rows (no duplicates) and logs `unchanged` counts.
- Changing a field (e.g., re-scrape after a review count changes) logs `updated` and bumps `updated_at`.
- `--output all` writes CSV + JSON + DB.
- `--output db` without `DATABASE_URL` fails with a clear error and exit code 2.
- All existing CSV/JSON tests still pass; new DB tests pass.

### Dependencies
Phase 2.0 (dependencies installed, PostgreSQL running).

### Deliverable
A database layer that makes scraped data queryable, idempotent, and ready for change tracking.

---

## Phase 2.2 — Change Tracking & History

> **Status: ⬜ NOT STARTED**

### Goal
Every time a business is re-scraped, snapshot the old values into a history table. Detect and log deltas (rating changed, reviews_count increased, business_status flipped to closed). This turns the scraper from a "snapshot tool" into a "trend data tool."

### Why it matters
Clients pay a premium for trend data: "This restaurant's rating dropped from 4.5 to 4.2 in the last 30 days" is far more valuable than "This restaurant has a 4.2 rating." Change tracking is the foundation for delta alerts (Phase 5) and freshness scoring.

### Task checklist
- [ ] **Schema extension.** Add to `src/db/schema.sql`:
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
    - `field` TEXT (e.g., 'rating', 'reviews_count', 'business_status')
    - `old_value` TEXT
    - `new_value` TEXT
    - `delta` TEXT (numeric delta for numeric fields, null for text)
    - `detected_at` TIMESTAMPTZ DEFAULT NOW()
    - `run_id` INT REFERENCES scrape_runs(id)
    - Index on `(business_id, field, detected_at DESC)`.
- [ ] **Snapshot logic in `upsertBusiness`.** When a business is re-scraped and the existing row differs from the new data:
  1. Insert the OLD row's values into `business_snapshots` (before updating).
  2. Compare fields, insert rows into `field_changes` for each changed field.
  3. Update the `businesses` row with new values.
  4. Return `{ action: 'updated', changes: ['rating', 'reviews_count'] }`.
- [ ] **Delta computation helpers.** `src/db/deltas.js`:
  - `computeChanges(oldRow, newRow)` — pure function, returns array of `{ field, old, new, delta }`.
  - `numericDelta(old, new)` — returns `new - old` for numbers, null for non-numeric.
  - Unit-tested with edge cases: null → value, value → null, type coercion, NaN.
- [ ] **Run summary extension.** The `scrape_runs` table gains `inserted`, `updated`, `unchanged`, `changes_detected` columns. The end-of-run banner shows:
  ```
  DB: 50 inserted, 30 updated (12 rating changes, 8 review-count changes, 2 status changes), 20 unchanged
  ```
- [ ] **CLI query helper.** `npm run db:history -- --placeId ChIJxxx` prints the snapshot timeline for a business:
  ```
  2026-08-07 14:03  rating 4.5 → 4.3  (Δ -0.2)
  2026-08-07 14:03  reviews 1234 → 1289 (Δ +55)
  2026-07-01 09:12  rating 4.6 → 4.5  (Δ -0.1)
  ```
- [ ] **Unit tests.** `tests/db-deltas.test.js`:
  - `computeChanges` detects rating, review-count, status, phone, website changes.
  - `computeChanges` returns empty array when nothing changed.
  - `numericDelta` handles nulls, strings, NaN.
  - Integration test: scrape → scrape again with changed data → verify snapshot + field_changes rows exist.

### Acceptance criteria
- Re-scraping the same business after a week produces a `business_snapshots` row with the old values and `field_changes` rows for each changed field.
- The end-of-run banner correctly reports change counts.
- `npm run db:history -- --placeId <id>` prints a readable timeline.
- Snapshotting is transactional — a crash mid-upsert leaves the DB consistent (old snapshot written, or nothing written).
- Re-scraping with identical data produces zero snapshots and zero changes (no noise).

### Dependencies
Phase 2.1 (PostgreSQL persistence).

### Deliverable
A change-tracking system that turns re-scrapes into trend data, with queryable delta history.

---

## Phase 2.3 — Proxy Management & Rotation

> **Status: ⬜ NOT STARTED**

### Goal
Introduce a proxy layer between the scraper and Google. Every browser launch (or every N requests) uses a different proxy from a configurable pool. Burned proxies (returned 403/429) are automatically retired and flagged.

### Why it matters
A single IP scraping Google Maps for 10,000 listings will get blocked within hours. Rotating proxies (especially residential) are the #1 defense. Without this, Phase 2's "survive overnight" goal is impossible.

### Task checklist
- [ ] **Proxy pool module.** `src/proxy.js`:
  - `createProxyPool({ sources, strategy, logger })` — returns a pool object.
  - Sources: file (`PROXY_LIST_FILE`), provider API (Bright Data / Smartproxy / Oxylabs), or manual list.
  - `pool.acquire()` — returns the next proxy `{ url, auth, id, provider }` per the rotation strategy.
  - `pool.release(proxyId, { success, statusCode })` — reports outcome; the pool uses this to track burn rate.
  - `pool.markBurned(proxyId, reason)` — removes a proxy from rotation, logs to `proxy_burn_log`.
  - `pool.stats()` — returns `{ total, healthy, burned, avgSuccessRate }`.
  - `pool.healthCheck()` — optional async method that pings each proxy with a HEAD to Google; prunes dead ones.
- [ ] **Rotation strategies.** Implement three, configurable via `--proxyStrategy`:
  - `round-robin` — cycle through the pool sequentially.
  - `random` — pick randomly (default; better for distributing load).
  - `sticky` — same proxy per session/worker (used when `--sessionLength N` keeps a proxy for N requests, then rotates).
- [ ] **Burn detection.** `src/proxy/burn-detector.js`:
  - Tracks per-proxy: request count, success count, last 10 status codes.
  - Auto-burn conditions:
    - 3 consecutive 403/429 responses.
    - Success rate drops below 50% over last 20 requests.
    - Connection timeout 3 times in a row.
  - Burned proxies go to a cooldown list (configurable: 10 min default) before being retried.
  - Permanent burn (proxy returns 407 auth failed) → removed from pool entirely.
- [ ] **Browser integration.** Modify `src/browser.js`:
  - `launchBrowser({ proxy, ...opts })` — passes `proxy.server`, `proxy.username`, `proxy.password` to Playwright's `chromium.launch({ proxy })`.
  - If no proxy configured → falls back to direct connection (Phase 1 behavior preserved).
  - Log: `Browser launched via proxy <id> (provider: brightdata, location: de-frankfurt)`.
- [ ] **Config flags.**
  - `--proxyStrategy round-robin|random|sticky` (default: random)
  - `--sessionLength N` (requests per proxy before rotation; default: 1 = rotate every request)
  - `--proxyCooldownMs` (default: 600000 = 10 min)
  - `--noProxy` (force direct connection; overrides everything)
- [ ] **Burn log.** `data/proxy_burn_log.jsonl` — append-only log of every burn event with timestamp, proxy id, reason, status codes, provider. Used for ops debugging and provider cost tracking.
- [ ] **Unit tests.** `tests/proxy.test.js`:
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
A proxy rotation layer that distributes requests across a pool and self-heals by retiring burned proxies.

---

## Phase 2.4 — Browser Fingerprint Randomization

> **Status: ⬜ NOT STARTED**

### Goal
Every browser session gets a randomized but coherent fingerprint: user-agent, viewport, timezone, locale, screen resolution, WebGL vendor, canvas noise, and platform. The fingerprint is internally consistent (a Chrome-on-Windows UA doesn't pair with a Mac platform) to avoid easy detection.

### Why it matters
Google's bot detection looks for fingerprint inconsistencies (e.g., Chrome UA + Mac platform + Linux timezone = bot). Coherent randomization makes each session look like a distinct real user, dramatically reducing block rate.

### Task checklist
- [ ] **Fingerprint generator.** `src/fingerprint.js`:
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
- [ ] **Browser application.** Modify `src/browser.js`:
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
- [ ] **Fingerprint persistence per worker.** Each worker (Phase 2.8) gets one fingerprint for its lifetime. Rotating fingerprints within a session is suspicious (real users don't change UAs mid-session).
- [ ] **Fingerprint logging.** Each run logs the fingerprint used (UA, timezone, viewport) so ops can correlate block events with fingerprints.
- [ ] **Config flags.**
  - `--fingerprintProfile random|fixed` (default: random)
  - `--fixedFingerprint <json>` (for debugging — pins a specific fingerprint)
  - `--noFingerprint` (disables randomization; Phase 1 behavior)
- [ ] **Unit tests.** `tests/fingerprint.test.js`:
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
A fingerprint randomization layer that makes each browser session look like a distinct, coherent real user.

---

## Phase 2.5 — Stealth Hardening

> **Status: ⬜ NOT STARTED**

### Goal
Patch the remaining "bot tells" that fingerprint randomization doesn't cover: `navigator.webdriver`, headless-mode indicators, missing browser APIs, permissions quirks, and `chrome.runtime` absence. Use `playwright-extra` + `puppeteer-extra-plugin-stealth` as the foundation, with custom patches for Maps-specific detection.

### Why it matters
Even with a randomized fingerprint, vanilla Playwright/Chromium has ~30 known bot signals (`navigator.webdriver === true`, missing `chrome.runtime`, `Notification.permission` inconsistencies, etc.). Google's detection checks these. Stealth patches eliminate the signals.

### Task checklist
- [ ] **Stealth plugin integration.** Replace `playwright` with `playwright-extra` in `src/browser.js`:
  - `const { chromium } = require('playwright-extra');`
  - `const stealth = require('puppeteer-extra-plugin-stealth')();`
  - `chromium.use(stealth);`
  - Verify all existing tests still pass (stealth should be transparent to the DI stubs).
- [ ] **Custom stealth patches.** `src/stealth-patches.js` — Maps-specific overrides applied via `context.addInitScript`:
  - `navigator.webdriver = undefined` (belt-and-suspenders; stealth handles this but verify).
  - `window.chrome = { runtime: {} }` (Chrome indicator that headless Chromium lacks).
  - `navigator.permissions.query` — return `prompt` for `notifications` instead of `denied` (headless gives `denied`, which is a tell).
  - `navigator.plugins` — populate with fake Chrome PDF plugin entries (headless has empty plugins).
  - `navigator.languages` — return the fingerprint's language array (not just `['en-US']`).
  - `WebGLRenderingContext.getParameter` for `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` — return fingerprint values.
  - `window.outerWidth / outerHeight` — set to > 0 (headless reports 0).
- [ ] **Headless detection evasion.**
  - Add `--disable-blink-features=AutomationControlled` to launch args.
  - Add `--excludeSwitches=enable-automation` (removes the "Chrome is being controlled by automated software" banner).
  - Consider `headless: 'new'` (Playwright's new headless mode, less detectable) vs `headless: true` (old). Test both against a detection page (e.g., `bot.sannysoft.com`).
- [ ] **Verification script.** `scripts/verify-stealth.js` (dev-only):
  - Launches a browser with stealth patches.
  - Navigates to `https://bot.sannysoft.com` (or similar detection page).
  - Screenshots the results + extracts the "detection score."
  - Saves to `benchmarks/stealth-score.json`.
  - Run before and after Phase 2.5 to verify improvement.
- [ ] **Config flags.**
  - `--stealth on|off` (default: on)
  - `--stealthDebug` (logs every patch applied + the resulting navigator properties)
- [ ] **Unit tests.** `tests/stealth.test.js`:
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
A stealth layer that eliminates known bot-detection signals, reducing block rate on long runs.

---

## Phase 2.6 — CAPTCHA Auto-Solving

> **Status: ⬜ NOT STARTED**

### Goal
When Google shows a CAPTCHA (reCAPTCHA or the "unusual traffic" interstitial), automatically solve it via a third-party service (2Captcha / Anti-Captcha / CapSolver). If solving fails or is disabled, fall back to the existing Phase 1.8 behavior (pause + alert the operator).

### Why it matters
Phase 1.8 detects CAPTCHAs and pauses, but a human must solve them. On a 10,000-listing overnight run, that's untenable. Auto-solving keeps the run unattended. Budget: ~$2-3 per 1000 solves — a line-item cost, not a blocker.

### Task checklist
- [ ] **CAPTCHA type detection.** Extend `src/antiblock.js`:
  - Detect reCAPTCHA v2 (the checkbox "I'm not a robot" puzzle).
  - Detect reCAPTCHA v3 (invisible, score-based — usually just means "slow down").
  - Detect the "unusual traffic" interstitial (text-based, may have an image challenge).
  - Extract the `data-sitekey` from reCAPTCHA elements for the solver.
  - Log: `CAPTCHA detected (type=reCAPTCHA v2, sitekey=6Lc..., url=https://...)`.
- [ ] **Solver abstraction.** `src/captcha/solver.js`:
  - `createSolver({ provider, apiKey, logger })` — returns a solver object.
  - `solver.solve({ type, sitekey, url })` — returns `{ token, cost, solveTimeMs }`.
  - Providers:
    - `2captcha` — official SDK, `solver.solveRecaptcha(sitekey, url)`.
    - `anticaptcha` — official SDK.
    - `capsolver` — official SDK.
    - `mock` — for tests; returns a fake token after a configurable delay.
  - `solver.balance()` — returns remaining credit (log on startup + every 100 solves).
  - Budget guard: `--captchaBudget 5.00` — stops solving when cumulative cost exceeds $5; falls back to pause-and-alert.
- [ ] **Token injection.** After solving:
  - For reCAPTCHA v2: inject the token into `#g-recaptcha-response` textarea, then submit the form (or trigger the callback).
  - For the "unusual traffic" interstitial: Google often accepts the token via a specific callback; inspect the page for `___grecaptcha_cfg.clients` and call the callback.
  - Wait for navigation (the page should reload to the results).
  - Log: `CAPTCHA solved (cost=$0.003, time=4.2s) — resuming scrape`.
- [ ] **Retry + fallback chain.**
  - If solver fails (API error, timeout) → retry once with a different provider if configured.
  - If all solvers fail → fall back to Phase 1.8 behavior (pause `--captchaWaitMs`, alert operator).
  - If `--noCaptchaSolve` is set → never call a solver; always pause-and-alert.
- [ ] **Config flags.**
  - `--captchaProvider 2captcha|anticaptcha|capsolver|mock|none` (default: none = Phase 1.8 behavior)
  - `--captchaApiKey <key>` (or `CAPTCHA_API_KEY` env var)
  - `--captchaBudget 5.00` (USD; stops solving above this)
  - `--noCaptchaSolve` (force pause-and-alert, overrides provider)
- [ ] **Cost tracking.** Append to `data/captcha_cost_log.jsonl`:
  - `{ ts, provider, type, cost, solveTimeMs, success, url }`.
  - End-of-run summary includes: `CAPTCHA: 3 solved ($0.009 total, avg 4.1s)`.
- [ ] **Unit tests.** `tests/captcha.test.js`:
  - `createSolver({ provider: 'mock' })` returns a token after a delay.
  - Budget guard stops solving when exceeded.
  - Solver failure triggers fallback to pause.
  - DI: solver accepts a mock HTTP client; no real API calls in tests.
  - Token injection logic tested against a reCAPTCHA HTML fixture.

### Acceptance criteria
- With `--captchaProvider mock`, a simulated CAPTCHA is "solved" (mock token injected) and the scrape resumes without human intervention.
- The cost log accumulates per-solve costs; the end-of-run summary reports total.
- Exceeding `--captchaBudget` stops solving and falls back to pause-and-alert.
- `--captchaProvider none` preserves Phase 1.8 behavior exactly.
- No unit test makes a real API call or spends real money.

### Dependencies
Phase 2.0 (solver SDKs installed), Phase 1.8 (existing CAPTCHA detection).

### Deliverable
An unattended CAPTCHA-solving layer with budget controls and graceful fallback.

---

## Phase 2.7 — Session & Cookie Rotation

> **Status: ⬜ NOT STARTED**

### Goal
Start a fresh browser context (new cookies, new localStorage, new session) every N requests or every M minutes. Optionally support "warmup" — a new context first visits a benign Google property (Search, News) for 10-20 seconds before hitting Maps, to look like a real user warming up a session.

### Why it matters
Google tracks session cookies across requests. A session that scrapes 500 Maps pages in 10 minutes is suspicious. Rotating sessions every ~50 requests makes the traffic pattern look like many distinct users. Warmup defeats "zero-history session hitting Maps" heuristics.

### Task checklist
- [ ] **Session manager.** `src/session.js`:
  - `createSessionManager({ maxRequests, maxAgeMs, warmup, logger })` — returns a manager.
  - `manager.getContext({ proxy, fingerprint })` — returns a browser context, creating a new one if the current one is exhausted (by request count or age).
  - `manager.release()` — closes the current context, clears cookies/storage.
  - `manager.stats()` — returns `{ sessionsCreated, avgRequestsPerSession, avgAgeMs }`.
- [ ] **Rotation triggers.**
  - Request count: `--sessionLength 50` (new context every 50 Maps requests).
  - Age: `--sessionMaxAgeMs 600000` (new context every 10 minutes, regardless of request count).
  - Whichever comes first.
  - On rotation: close context, log `Session rotated (requests=50, age=8.3min)`, create new context with the same proxy+fingerprint OR a new proxy+fingerprint (configurable).
- [ ] **Warmup routine.** `src/session/warmup.js`:
  - `warmupContext(page, { logger })` — visits 1-2 of:
    - `https://www.google.com` (search homepage).
    - `https://news.google.com` (Google News).
    - A random top-100 website (from a bundled list).
  - Waits 5-15 seconds (randomized).
  - Optionally performs a benign search ("weather", "news today").
  - Log: `Session warmup complete (visited google.com, waited 8.2s)`.
  - Configurable: `--warmup on|off` (default: on), `--warmupDurationMs` (default: 10000).
- [ ] **Cookie isolation.** Each new context starts with zero cookies. The session manager never shares cookies between contexts. (Playwright contexts are isolated by default — verify, don't break this.)
- [ ] **Google account warmup (optional, advanced).** `src/session/account-warmup.js`:
  - Accepts a list of Google account credentials (email + app-password).
  - Logs in to Google in a new context, establishing an authenticated session.
  - Logged-in sessions get more data (review text, some private fields) and fewer CAPTCHAs.
  - **Security:** credentials stored only in `.env` (gitignored); never logged.
  - `--accountWarmup on|off` (default: off — this is opt-in due to account-burn risk).
  - Each account used for max 1 session per day (configurable) to avoid all accounts getting flagged together.
- [ ] **Config flags.**
  - `--sessionLength N` (requests per session; default: 50)
  - `--sessionMaxAgeMs` (default: 600000)
  - `--warmup on|off` (default: on)
  - `--warmupDurationMs` (default: 10000)
  - `--accountWarmup on|off` (default: off)
  - `--accountsFile <path>` (JSON array of `{email, password}`; gitignored)
- [ ] **Unit tests.** `tests/session.test.js`:
  - Session manager creates a new context when request count exceeds `maxRequests`.
  - Session manager creates a new context when age exceeds `maxAgeMs`.
  - Warmup visits the expected URLs (with a stub page that records navigations).
  - Account warmup is opt-in and off by default.
  - DI: manager accepts a mock `createContext` function.

### Acceptance criteria
- With `--sessionLength 10`, every 10th request triggers a new context (visible in logs).
- Session age is tracked and triggers rotation independently of request count.
- Warmup visits a benign page before Maps when enabled.
- `--warmup off` skips warmup (Phase 1 behavior).
- Account warmup is off by default; enabling it requires an accounts file.
- Cookie isolation is verified: context A's cookies are not visible in context B.

### Dependencies
Phase 2.3 (proxies), Phase 2.4 (fingerprints) — sessions combine proxy + fingerprint + cookies.

### Deliverable
A session-rotation layer that distributes traffic across many distinct sessions, each warmed up to look human.

---

## Phase 2.8 — Worker Pool & Concurrency

> **Status: ⬜ NOT STARTED**

### Goal
Run N browser workers in parallel, each with its own proxy, fingerprint, and session. A job dispatcher distributes search tasks (one per query/location pair, or one per batch of businesses to deep-scrape) across the pool. If a worker gets blocked, it's marked burned and its tasks are re-queued.

### Why it matters
A single browser maxes out at ~200 businesses/hour (rate-limited). 10 workers = ~2000/hour. The 10,000-listing overnight run requires concurrency. Per-worker proxy isolation means one block doesn't kill the whole run.

### Task checklist
- [ ] **Worker abstraction.** `src/worker.js`:
  - `createWorker({ id, proxy, fingerprint, cfg, logger })` — returns a worker object.
  - `worker.run(task)` — executes a scrape task (search + scroll + extract, or detail-scrape batch).
  - `worker.isHealthy()` — returns true if the worker hasn't been blocked / hasn't exceeded error threshold.
  - `worker.shutdown()` — closes browser, releases proxy, logs final stats.
  - Each worker has its own: browser instance, proxy, fingerprint, session manager, rate limiter, retry config.
  - Workers are isolated: a crash in one worker doesn't affect others.
- [ ] **Worker pool.** `src/pool.js`:
  - `createPool({ size, cfg, proxyPool, fingerprintGen, logger })` — returns a pool.
  - `pool.dispatch(task)` — assigns a task to the next available worker; returns a promise that resolves when the task completes.
  - `pool.dispatchBatch(tasks)` — distributes a batch of tasks across workers; returns when all complete.
  - `pool.stats()` — returns per-worker stats: `{ workerId, tasksCompleted, businessesScraped, errors, blocked, proxyId }`.
  - `pool.shutdown()` — gracefully stops all workers (finish current task, then close).
  - Load balancing: round-robin by default; least-busy optional.
- [ ] **Graceful degradation.**
  - If a worker returns a block signal (CAPTCHA unsolvable, proxy burned, 3 consecutive 403s):
    1. Mark the worker as unhealthy.
    2. Re-queue its current task to another worker.
    3. Rotate the worker's proxy + fingerprint + session.
    4. After cooldown, mark the worker healthy again and return it to the pool.
  - If a worker crashes (uncaught exception):
    1. Log the error with full stack.
    2. Re-queue its current task.
    3. Restart the worker (new browser, new proxy, new fingerprint).
    4. Track crash count; after 3 crashes in 10 minutes, retire the worker permanently (reduce pool size).
- [ ] **Task types.**
  - `search-task` — a full search + scroll + extract for one query/location.
  - `detail-task` — deep-scrape a batch of businesses (e.g., 20 at a time).
  - `resume-task` — resume a crashed search-task from checkpoint.
  - Tasks are serializable (JSON) so they can be persisted to the job queue (Phase 2.9).
- [ ] **Config flags.**
  - `--workers N` (default: 1 = Phase 1 behavior)
  - `--workerProxyStrategy shared|isolated` (default: isolated = each worker has its own proxy; shared = all workers share the pool)
  - `--workerCrashLimit 3` (retire worker after this many crashes in 10 min)
  - `--workerCooldownMs` (default: 300000 = 5 min; how long a blocked worker stays out)
- [ ] **Logging.** Every log line includes `workerId` so the operator can trace which worker did what. The end-of-run summary includes per-worker stats.
- [ ] **Unit tests.** `tests/worker.test.js`, `tests/pool.test.js`:
  - `createWorker` with a mock browser returns expected interface.
  - `pool.dispatch` assigns tasks round-robin.
  - Blocked worker triggers re-queue of its task.
  - Crashed worker is restarted; after crash limit, retired.
  - `pool.stats` aggregates correctly.
  - DI: workers accept a mock `runTask` function; pool accepts a mock `createWorker`.

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
