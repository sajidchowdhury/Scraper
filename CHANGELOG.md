# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Phase 1 is tagged `v1.0.0-phase1` — the `-phase1` suffix marks the milestone
(Phase 1 of the master roadmap in `SCRAPER_FEATURES.md`).

---

## [Unreleased] — Phase 2 robustness & scale

### Phase 2.1 — PostgreSQL Persistence Layer

#### Added
- **`src/db.js`** — a thin, DI-friendly PostgreSQL persistence layer over `pg`:
  - `createPool(connectionString)` — returns a `pg.Pool` from a `postgresql://`
    URL (or null if no/invalid URL). Conservative defaults: 10s connect timeout,
    max 10 clients.
  - `getClient(pool)` / `withClient(pool, fn)` — acquire + auto-release clients.
  - `closePool(pool)` — graceful shutdown (null-safe).
  - `runMigration(poolOrClient)` — executes `src/db/schema.sql` idempotently.
  - `computeRowHash(business)` (pure) — SHA-256 of comparable field values, with
    sorted-key normalization so key-order differences in nested objects don't
    produce false "changed" signals. Empty strings normalize to null (matches
    the `toText` coercion used for DB writes).
  - `decideAction(existingHash, business)` (pure) — classifies an upsert as
    `inserted` / `updated` / `unchanged` without touching the database.
  - `upsertBusiness(client, business, {runId})` +
    `upsertBusinessesBatch(client, businesses, {runId, batchSize})` — idempotent
    upserts keyed by `place_id`. Per-batch: one `SELECT … WHERE place_id = ANY($1)`
    hash check, a multi-row `INSERT … ON CONFLICT (place_id) DO NOTHING` for new
    rows, and per-row `UPDATE` for changed rows. Default batch size 50.
  - `insertRunSummary(client, summary)` — writes a `scrape_runs` row, returns
    `runId`.
  - `persistRunResults(pool, {businesses, summary, logger})` — full pipeline
    hook: `BEGIN` → insert run summary → batch upsert businesses → stamp DB
    counts onto the run row → `COMMIT` (or `ROLLBACK` on any error).
  - All queries are parameterized (no SQL-injection surface). Every method
    accepts an explicit `client`/`pool` arg so unit tests can pass a mock client.
- **`src/db/schema.sql`** — idempotent schema (`CREATE TABLE IF NOT EXISTS`):
  - `businesses` table — all 25 scraped fields (17 canonical + 8 detail) plus
    `latitude`/`longitude` (forward-compatible, NULL until a future phase
    extracts them), `data_hash` (SHA-256 for no-op detection), `run_id` (FK →
    `scrape_runs`), `updated_at`. Indexes on `place_id`, `(query, location)`,
    `scraped_at`, `business_status`, `updated_at`.
  - `scrape_runs` table — per-run metadata: `query`, `location`, `started_at`,
    `finished_at`, `extracted`, `failed`, `exit_code`, `log_path`,
    `db_inserted`, `db_updated`, `db_unchanged`.
  - Foreign key added via a `DO $$ … $$` guard block so re-running the migration
    is always safe.
- **`src/db/migrate.js`** + `npm run db:migrate` — standalone CLI that reads
  `schema.sql` and executes it. Exit codes: 0 ok, 2 config error (no
  `DATABASE_URL`), 3 runtime error.
- **`--output csv|json|db|all` flag** in `src/config.js`:
  - `resolveOutputTargets(raw)` pure helper — parses comma-separated values,
    expands `all` → `['csv','json','db']`, de-dupes, case-insensitive.
  - Default `['csv','json']` preserves Phase 1 behavior.
  - `DATABASE_URL` env var support + `OUTPUT` env var.
  - Validation: `--output db` requires a `postgresql://` (or `postgres://`)
    `DATABASE_URL`; a missing or non-postgres URL is a config error (exit 2).
- **Pipeline integration** in `src/index.js`:
  - After extraction + dedup, if `cfg.output.includes('db')` && `!cfg.dryRun`,
    `persistRunResults` upserts every business in a single transaction.
  - End-of-run banner gains a `DB: N inserted, N updated, N unchanged (run #N)`
    line.
  - A DB persistence failure logs an error + sets exit code 1 (partial success),
    but does NOT discard already-written CSV/JSON files.
  - `--dryRun` now skips DB writes too (consistent with skipping file writes).
- **`exportResults` gains `writeCsv` option** (`src/export.js`) so `--output
  json` skips the CSV file and `--output csv` skips the JSON sidecar. Defaults
  to true (preserves existing behavior).

#### Tests
- **`tests/db.test.js`** — 65 tests / 141 assertions covering:
  - Pure functions: `computeRowHash` (determinism, key-order independence,
    change detection, null/empty-string normalization), `decideAction`
    (inserted/updated/unchanged), `columnValue` coercion.
  - SQL builders: `buildBatchInsert` (multi-row, `ON CONFLICT DO NOTHING`,
    sequential placeholders), `buildUpdate` (place_id in WHERE).
  - DI mock-client upsert cycle: insert → unchanged → updated; batched upserts
    respect `batchSize`; missing `place_id` skipped.
  - SQL-injection safety: `'; DROP TABLE businesses; --` stored literally as a
    `place_id`, never interpolated into SQL text.
  - Transaction rollback: `persistRunResults` issues `ROLLBACK` on injected
    failure; in-memory store unchanged; `COMMIT` on success.
  - `insertRunSummary`, `resolveOutputTargets`, config `--output` validation.
  - Pool + migration lifecycle.
  - Integration tests (guarded on a live postgres `DATABASE_URL`): migrate
    creates tables, full upsert cycle, re-migrate idempotency. Skipped
    automatically when no Postgres is available.
- **Total: 475 tests / 1169 assertions** (410 existing + 65 new), all passing.

#### Documentation
- `.env.example` Phase 2.1 section expanded: documents the `postgresql://`
  scheme requirement, `npm run db:migrate`, and `--output` usage.
- `PHASE2_EXECUTION_PLAN.md` — Phase 2.1 marked ✅ DONE; task checklist and
  acceptance criteria updated with verification notes.

### Phase 2.2 — Change Tracking & History

#### Added
- **`src/db/deltas.js`** — pure, side-effect-free change-tracking helpers:
  - `TRACKED_FIELDS` — the five high-value columns clients pay for trend data
    on: `rating`, `reviews_count`, `business_status`, `phone`, `website`.
  - `normalizeValue(v)` — null/undefined/`''` collapse to null; finite numbers
    kept; NaN/Infinity rejected.
  - `coerceNumber(v)` — parses numeric strings (`'4.5'` → `4.5`), rejects
    non-numeric strings / NaN / Infinity. Used by `numericDelta` so stringified
    DB values still produce a meaningful delta.
  - `valuesEqual(a, b)` — comparison after normalization; numeric string vs
    number compare equal (`4.5 === '4.5'`).
  - `numericDelta(old, new)` — `new - old` for numbers (rounded to 1 dp to
    match `NUMERIC(2,1)` precision); the new value itself when old is null
    (a business gaining its first rating); null for non-numeric / NaN / Infinity.
  - `computeChanges(oldRow, newRow, fields?)` — returns an array of
    `{ field, old, new, delta }` for each tracked field that actually changed
    (after normalization). Empty array when nothing changed or when `oldRow` is
    null (brand-new insert — no prior data to diff).
  - `summarizeChanges(changes)` — `{ total, byField }` rollup for the run banner;
    `byField` always contains every tracked field (0 when none changed).
- **`src/db/history.js`** + `npm run db:history` — CLI that prints the change
  timeline for a single business (keyed by `place_id`):
  ```
  Business:  Test Cafe (ChIJxxx)
  Current:   rating 4.3 | reviews 1289 | status open | phone +1-555-0100 | website https://example.com

  Timeline (5 change events, 2 snapshots):
    2026-08-07 14:03  rating 4.5 → 4.3  (Δ -0.2)
    2026-08-07 14:03  reviews 1234 → 1289 (Δ +55)
    2026-07-01 09:12  rating 4.6 → 4.5  (Δ -0.1)
  ```
  - Flags: `--placeId <id>` (required), `--place-id`/`-p` aliases, `--limit N`
    (default 100, most-recent-first), `--help`/`-h`. A positional connection
    string overrides `DATABASE_URL`.
  - Pure formatters (`formatValue`, `formatDelta`, `fieldLabel`,
    `formatTimestamp`, `formatChangeLine`, `formatCurrentLine`, `parseArgs`)
    are exported for unit testing.
- **Schema extension** in `src/db/schema.sql`:
  - `business_snapshots` table — pre-update snapshot of tracked fields (`id`,
    `business_id` FK, `place_id` denormalized, `rating`, `reviews_count`,
    `business_status`, `phone`, `website`, `snapshot_at`, `run_id` FK). Indexes
    on `(business_id, snapshot_at DESC)`, `place_id`, `run_id`.
  - `field_changes` table — computed, queryable per-field delta log (`id`,
    `business_id` FK, `place_id` denormalized, `field`, `old_value`, `new_value`,
    `delta`, `detected_at`, `run_id` FK). Indexes on
    `(business_id, field, detected_at DESC)`, `(place_id, detected_at DESC)`,
    `run_id`.
  - `scrape_runs.changes_detected` INTEGER column, added via an idempotent
    `DO $$ … $$` ALTER guard (safe to re-run on Phase 2.1 databases).
- **Snapshot + field_changes logic** in `src/db.js` `upsertBusinessesBatch`:
  when a business is classified `updated`, the batch path now:
  1. SELECTs the existing rows' `id` + tracked fields (1 round-trip, batched).
  2. INSERTs the OLD values into `business_snapshots` (multi-row, 1 round-trip).
  3. Computes per-field deltas (`computeChanges`) and INSERTs them into
     `field_changes` (multi-row, 1 round-trip).
  4. UPDATEs the `businesses` row (existing path).
  All four steps run inside the `persistRunResults` BEGIN/COMMIT transaction, so
  a crash mid-upsert rolls back the snapshot + changes + update atomically.
- **`buildSnapshotInsert(rows)`** + **`buildFieldChangesInsert(rows)`** — pure,
  parameterized multi-row INSERT builders (exported for unit testing). SQL-
  injection-safe: malicious values appear in `params`, never interpolated.
- **Run-summary extension** — `persistRunResults` now stamps `changes_detected`
  onto the `scrape_runs` row alongside `db_inserted/updated/unchanged`, and
  returns `{ changesDetected, changesByField, snapshotsWritten }` in its result.
- **Banner change breakdown** in `src/index.js` — the end-of-run `DB:` line now
  includes the per-field change counts when any tracked field changed:
  `DB: 50 inserted, 30 updated (12 rating changes, 8 review-count changes, 2 status changes), 20 unchanged (run #5)`.

#### Tests
- **`tests/db-deltas.test.js`** (57 tests) — pure-function coverage for
  `normalizeValue`, `coerceNumber`, `valuesEqual`, `numericDelta` (incl. null→gain,
  value→loss, string coercion, NaN, Infinity), `computeChanges` (all five tracked
  fields, null↔value, empty-string normalization, custom field list),
  `summarizeChanges`, and every `history.js` pure formatter + `parseArgs`.
- **`tests/db.test.js`** extended (65 → 84 tests):
  - Mock client now mirrors `business_snapshots` + `field_changes` in-memory
    (with transaction snapshot/restore so ROLLBACK clears them).
  - New sections: change-tracking on update (insert→no snapshots, unchanged→no
    snapshots, changed reviews_count→1 snapshot + 1 field_change, rating delta
    -0.2, status flip null delta, multi-field update, `changesByField` rollup,
    `persistRunResults` stamps `changes_detected`).
  - SQL-builder tests for `buildSnapshotInsert` / `buildFieldChangesInsert`
    (parameterization, null handling, SQL-injection safety).
  - Integration tests (guarded on `DATABASE_URL`) now drop + recreate all four
    tables and verify a real Postgres re-scrape writes snapshot + field_changes
    rows; an identical re-scrape writes neither.

#### Documentation
- `PHASE2_EXECUTION_PLAN.md` — Phase 2.2 marked ✅ DONE (3 of 13); task checklist
  and acceptance criteria updated with verification notes.
- `README.md` — Phase 2.2 section added (change tracking overview, tracked
  fields, `npm run db:history` usage, banner output example).
- `package.json` — `db:history` script added; `syntax` script now checks
  `src/db/deltas.js` + `src/db/history.js`.

**Test count:** 551 tests / 1407 assertions (was 475 / 1028).

---

### Phase 2.3 — Proxy Management & Rotation

#### Added
- **`src/proxy.js`** — a configurable proxy pool that sits between the scraper
  and Google. Every browser launch (or every N requests, via `--sessionLength`)
  pulls a different proxy from the pool. Burned proxies (3 consecutive 403/429,
  <50% success rate over last 20 requests, 3 consecutive timeouts) are benched
  for a cooldown window; permanently bad proxies (HTTP 407, provider-reported
  retired) are removed entirely.
  - `createProxyPool({ sources, strategy, sessionLength, cooldownMs, logger, now, rng, burnDetector, burnLogWriter })`
    — factory. Sources: `file` (`PROXY_LIST_FILE`), inline `list` (for tests),
    or async `provider()` (Bright Data / Smartproxy / Oxylabs — caller supplies
    the impl). All clocks and randomness are injectable for deterministic tests.
  - `pool.acquire()` — returns the next proxy `{ id, server, url, username,
    password, host, port, protocol, provider }` per the rotation strategy.
    Skips proxies in cooldown or permanently burned. Returns null when the pool
    is exhausted (caller falls back to direct or aborts).
  - `pool.release(proxyId, { success, statusCode })` — reports the outcome of
    an acquire→use cycle. The burn detector decides whether to burn based on
    the outcome history.
  - `pool.markBurned(proxyId, reason, { permanent })` — manual burn override.
  - `pool.stats()` — `{ total, healthy, cooldown, burned, avgSuccessRate,
    totalRequests, totalSuccess, strategy, sessionLength, perProxy[] }`.
  - `pool.healthCheck({ fetchFn, url, timeoutMs })` — optional pre-run probe
    that pings every proxy with a HEAD to Google; benches failures for one
    cooldown cycle. `fetchFn` is injectable so unit tests make zero real
    network calls.
  - `pool.close()` — best-effort teardown (burn log uses sync writes).
- **`src/proxy/burn-detector.js`** — pure per-proxy health tracking + burn
  decision logic. Kept separate from the pool so unit tests can exercise burn
  thresholds without spinning up a pool, and future strategies (ML-based
  anomaly detection) can be dropped in without touching the pool's
  acquire/release flow.
  - `createBurnDetector({ cooldownMs, statusWindow, rateWindow, rateThreshold,
    minRateSamples, consecutiveBlock, consecutiveTimeout, now })`
  - `detector.record(proxyId, { success, statusCode })` — mutates state, may
    transition to cooldown/burned. Returns `{ burned, kind, reason }`.
  - `detector.markPermanent/markCooldown/clear(proxyId, reason)` — manual overrides.
  - `detector.isReusable(proxyId)` — false for permanent burns and for cooldown
    burns whose window hasn't elapsed.
  - `detector.state/stats/cooldownRemainingMs/all/resetCounters(proxyId)` —
    introspection.
  - Auto-burn rules:
    - 3 consecutive 403/429 → cooldown.
    - Success rate < 50% over last 20 requests (min 5 samples) → cooldown.
    - 3 consecutive timeouts (`statusCode === 'TIMEOUT'`) → cooldown.
    - HTTP 407 (Proxy Authentication Required) → permanent (removed entirely).
  - Cooldown proxies auto-recover after `cooldownMs` (default 10 min). Permanent
    proxies never recover.
- **`src/browser.js`** — `launchBrowser(cfg, opts)` now accepts
  `opts.proxy = { server, username, password, id, provider, host, port }`.
  When present, it's passed to Playwright's `chromium.launch({ proxy })` so all
  browser traffic flows through it. When no proxy is configured, the launch is
  direct (Phase 1 behavior preserved). The "Browser launched" log line now
  records the proxy id + provider so the JSON-lines log can be cross-referenced
  with `data/proxy_burn_log.jsonl`.
- **`src/config.js`** — new CLI flags + env vars:
  - `--proxyStrategy round-robin|random|sticky` (default: random)
  - `--sessionLength N` (default: 1 = rotate every request; sticky only)
  - `--proxyCooldownMs` (default: 600000 = 10 min)
  - `--proxyListFile <path>` (or `PROXY_LIST_FILE` env)
  - `--proxyHealthCheck` (probe every proxy with a HEAD before scraping)
  - `--noProxy` (force direct connection; overrides everything)
  - Env: `PROXY_STRATEGY`, `SESSION_LENGTH`, `PROXY_COOLDOWN_MS`, `NO_PROXY`,
    `PROXY_LIST_FILE`, `PROXY_PROVIDER`, `PROXY_PROVIDER_URL`,
    `PROXY_PROVIDER_TOKEN`, `PROXY_BURN_LOG`.
  - Validation: strategy must be one of the three; sessionLength 1–10000;
    cooldownMs 0–86400000; listFile must exist if specified.
- **`src/index.js`** — pipeline wiring:
  - Constructs the proxy pool after config validation (only when
    `cfg.proxy.enabled`).
  - Optional pre-run health check (`--proxyHealthCheck`) probes every proxy
    before scraping; aborts if all fail.
  - Acquires a proxy before each `withBrowser` call; passes it through to
    `launchBrowser` via `opts.proxy`.
  - Releases the proxy in a `finally` block with the pipeline outcome:
    - Success → `{ success: true }`.
    - CAPTCHA → `{ success: false, statusCode: 429 }` (treat as block signal).
    - Other crash → `{ success: false, statusCode: 'TIMEOUT' }`.
  - The end-of-run banner now includes a `Proxy:` line with healthy/cooling/
    burned counts + strategy + avg success rate.
  - The run summary (`summary.json`) now includes `proxy: pool.stats()`.
- **`src/banner.js`** — startup banner now shows a `Proxy` row: strategy +
  session length + cooldown when enabled, or "disabled (direct)" otherwise.
- **`data/proxy_burn_log.jsonl`** — append-only JSONL log of every burn event.
  Each line: `{ ts, kind, proxyId, reason, recentStatusCodes, provider, stats }`.
  Used for ops debugging + provider charge disputes.
- **`tests/proxy.test.js`** — 52 tests / 143 assertions across 9 describe
  blocks:
  - `parseProxyLine` (6 tests) — all 3 URL formats + edge cases.
  - Burn detector (13 tests) — every burn rule + recovery + manual overrides.
  - Pool strategies (5 tests) — round-robin, random (seeded), sticky,
    sessionLength rotation.
  - Pool burn integration (5 tests) — release triggers burn, markBurned,
    exhaustion, cooldown recovery, stats accuracy.
  - Burn log writer (2 tests) — JSONL format + event fields.
  - Health check (2 tests) — DI'd fetchFn, failed proxies benched.
  - DI / no-network guarantees (3 tests) — inline list, injected provider,
    empty pool.
  - Config integration (8 tests) — every flag + env var + validation errors.
  - Acceptance criteria (7 tests) — AC1–AC7 from the execution plan, each
    verified by a dedicated test.

#### Changed
- `package.json` — version bumped to `1.0.0-phase2.3`.
- `src/browser.js` — `withBrowser` now returns `{ browser, page, proxy }` so
  the caller can release the proxy to the pool with the appropriate outcome.
- `.env.example` — new Phase 2.3 section documenting all proxy env vars.
- `PHASE2_EXECUTION_PLAN.md` — Phase 2.3 marked ✅ DONE with test counts and
  deliverable summary.

#### Design notes
- **Eager sync load.** The pool loads sync sources (file + list) eagerly at
  construction so `stats()` and `markBurned()` work without an `acquire()`
  first. Async sources (provider API) load lazily on first `acquire()`/
  `healthCheck()` via a shared `loadPromise`.
- **Default-port restoration.** Node's `URL` strips default ports (80 for http,
  443 for https, 1080 for socks5). `parseProxyLine` restores them so the
  descriptor always has an explicit port — otherwise `http://1.1.1.1:80` would
  parse as null.
- **Burn log is sync.** Proxy burns are rare (a 1000-proxy pool might see a
  few burns per hour), so we use `fs.appendFileSync` for durability rather
  than buffering. This guarantees the burn event hits disk before the pool
  moves on, which matters for provider charge disputes.
- **CAPTCHA → 429 mapping.** When the pipeline aborts with `CAPTCHA_DETECTED`,
  we release the proxy with `statusCode: 429` rather than `'TIMEOUT'`. This
  feeds the consecutive-block burn rule (3 CAPTCHAs → cooldown), which is the
  correct signal: a CAPTCHA means Google is rate-limiting that IP.

**Test count:** 603 tests / 1550 assertions (was 551 / 1407).

---

## [Unreleased] — post-v1.0.0-phase1 hotfixes

### Fixed
- **`playwright` missing from `package.json` dependencies** (`04acb38`):
  fresh-clone installs produced `Cannot find module 'playwright'` because the
  package was only available globally in the dev sandbox. Now declared as a
  runtime dependency.
- **`--dryRun` example was ambiguous and led to "no CSV" confusion**
  (`d85ef34`): the help text's last (most-memorable) example used `--dryRun`
  with only a `# no delay, scripted` comment, never warning that no files are
  written. Reordered the examples (real runs first, smoke-test last) and
  rewrote the flag description to `"Smoke test: run pipeline but write NO
  output files"`. Added a Troubleshooting entry with the exact log
  signatures.
- **Detail-panel deep scrape opened 0% of panels** (this release):
  `openDetailPanelOnPage` waited only for DOM selectors including the stale
  `h1[data-attrid="title"]` (a 2020-era Google Maps selector), and logged
  every failure at `debug` level (suppressed at default `info`). Every
  detail open timed out after 3 retries × 12s = ~40s of silent failure per
  business. Rewrote the function with three hardening stages:
  1. **Anchor finding**: match by `place_id` first (stable, no CSS-special
     chars), then `maps_url`, then generic `/maps/place/`, then card-by-
     `aria-label` fallback.
  2. **Click**: `scrollIntoViewIfNeeded` before click (target card may be
     off-screen after scroll-to-load on Google's virtualized feed).
  3. **Wait**: primary signal is URL change to `/maps/place/` via
     `page.waitForFunction` (pushState navigation — most robust). Secondary
     signal is updated DOM selectors (dropped `data-attrid`, added plain
     `h1`, `div[role="region"]`).
  Every failure path now logs at `warn` level with `beforeUrl`, `afterUrl`,
  `urlChanged`, `matchedBy`, and `triedSelectors` so the operator can see
  exactly which stage failed. Added `safePageUrl` helper (exported) for
  robust `page.url()` reads on synthetic test pages.

### Added
- `tests/detail.test.js`: 11 new tests for the hardened `openDetailPanelOnPage`
  (7 tests: no-anchor, selector ordering, URL-change success, timeout-with-
  urlChanged, click-threw, card-by-aria-label fallback, no-place_id grace) and
  `safePageUrl` (4 tests). Total suite: **410 tests / 1028 assertions**.
- `SELECTORS.md`: new "Detail-panel open strategy" section documenting the
  three-stage approach with selector tables and the historical note on why
  `data-attrid` was dropped.

---

## [v1.0.0-phase1] — 2026-08-07

The Phase 1 milestone: a single-query, single-machine Google Maps business
scraper that searches, paginates, extracts 17 list-view fields (+ 8 optional
detail-panel fields), and exports a 25-column Excel-safe CSV — with crash
recovery, anti-block, structured logging, and CLI polish. **12 of 12
sub-phases complete. 397 tests / 999 assertions passing.**

### Sub-phase rollup

| Sub-phase | Commit | Summary |
|---|---|---|
| 1.0 — Project Hygiene & Foundation | `0e1589c` | Modular `src/` layout, `.gitignore`, `.env.example`, `npm start` |
| 1.1 — Configurable Search Input | `084d3f7` | CLI flags + env fallbacks + validation, `HELP_TEXT` |
| 1.2 — Robust Browser Automation Core | `ea28971` | Timeouts, SIGINT handler, idempotent teardown |
| 1.3 — Pagination / Infinite-Scroll | `a8c72a7` | `scroll.js` with DI `openFn`/`backFn`, stall detection |
| 1.4 — Core Field Extraction (List) | `59704ca` | `CANONICAL_FIELDS` (17), parsers, fallbacks, extraction rates |
| 1.5 — Detail-Page Deep Scrape | `48f9c0e` | `DETAIL_FIELDS` (8), per-business isolation, sample-step |
| 1.6 — CSV Export Engine | `a6b0315` | RFC 4180 escaping, UTF-8 BOM, CSV + JSON + summary.json |
| 1.7 — Reliability & Crash Recovery | `48c7306` | `withRetry` (3 attempts, 1s→2s→4s), checkpoint resume, per-business isolation |
| 1.8 — Minimal Anti-Block Behavior | `2644759` | Rate limiter (30 RPM), human typing, CAPTCHA detection, UA rotation, 429/503 watcher |
| 1.9 — Logging & Observability | `972a6bb` | `phase` field on every log line, per-business + per-field debug, run-complete event, sync file sink |
| 1.10 — CLI Polish & DX | `d7a7d26` | Startup banner + 1s confirm delay, `--yes`/`-y` to skip, exit codes 0/1/2/3/130 |
| 1.11 — Documentation & Handoff | _(this release)_ | Troubleshooting, Known limitations, Roadmap, `SELECTORS.md`, `CHANGELOG.md`, `v1.0.0-phase1` tag |

### Added

- **25-field stable output schema** — 17 canonical list-view fields (name,
  rating, reviews_count, price_level, category, address, phone, website,
  maps_url, place_id, plus_code, open_now, business_status, is_sponsored,
  scraped_at, query, location) + 8 detail fields (full_hours, popular_times,
  top_reviews, photos, reservation_url, menu_url, social_profiles,
  detail_scraped). Column order is fixed in `src/export.js` `COLUMN_SCHEMA`
  so downstream pipelines don't break when fields are added.
- **CSV + JSON + summary.json export** (Phase 1.6). CSV is RFC 4180-compliant
  with UTF-8 BOM and CRLF line endings for Excel safety. JSON sidecar
  preserves nested structure (arrays of review/photo objects). Summary
  records query, location, totals, extraction rates, scroll result, deep-
  scrape stats, duration, and output paths.
- **Crash recovery** (Phase 1.7). `withRetry` wraps every transient browser
  op (3 attempts, 1s→2s→4s backoff). A `.checkpoint_{query}_{location}.json`
  file is written every N results; `--resume` reloads it and skips already-
  extracted businesses by `place_id` (or name+address+phone hash). `--fresh`
  clears it. Checkpoint is auto-cleared on successful completion, preserved
  on crash / SIGINT / CAPTCHA abort.
- **Anti-block behavior** (Phase 1.8). Token-bucket rate limiter (default
  30 req/min, `--maxRPM`), char-by-char human typing (`--noHumanTyping` to
  disable), randomized delays (scroll 800–2000ms, detail 1500–3500ms,
  pre-Enter 500–1500ms, per-key 50–150ms), 8-UA rotation, 429/503 response
  watcher, CAPTCHA detection (`--noCaptchaPause` / `--captchaWaitMs`).
- **Structured logging** (Phase 1.9). Dual-sink logger: colorized console +
  JSON-lines file (`logs/{query}_{location}_{timestamp}.log`). Every line
  carries a `phase` tag (search/scroll/extract/detail/export/recovery/
  antiblock/retry/browser/system). `--logLevel debug` emits per-business,
  per-field breakdown. A structured `Run complete` line records duration,
  counts, and exit code for machine-parseable post-run analysis.
- **CLI polish** (Phase 1.10). Startup banner prints the resolved config
  with a 1-second confirm delay (`--yes`/`-y` to skip). `--help` lists every
  flag with a one-line description and usage example. `--version` reads
  `package.json`. `--dryRun` runs the full pipeline without writing files.
  `--limit N` aliases `--maxResults`. `--headless`/`--headed` override `.env`.
  `--verbose` aliases `--logLevel debug`. Friendly config errors (no stack
  traces). Exit codes 0/1/2/3/130.
- **Documentation & handoff** (Phase 1.11). `README.md` with Quick start,
  Requirements, CLI, Configuration, Usage examples, Output format,
  Troubleshooting, Known limitations, Roadmap. `SELECTORS.md` documenting
  where primary/fallback selectors live and how to update them when Google
  changes the DOM. This `CHANGELOG.md`. `v1.0.0-phase1` git tag.

### Changed

- Bumped version `0.1.0` → `1.0.0-phase1` (`package.json`).
- README Quick start now works on a fresh clone (`npm install` +
  `npx playwright install chromium`), no sandbox-only assumptions.
- Pipeline entry point (`src/index.js`) wires checkpoint resume, retry,
  anti-block, structured logging, and the startup banner in dependency order.

### Fixed

- (Phase 1.4) `parseOpenNow`: "Opens 11:00 AM" now returns `false` (currently
  closed, opens later) instead of `null`.
- (Phase 1.4) Sponsored detection now catches CJK badges (贊助商廣告 /
  赞助商广告 / 広告) via `aria-label` patterns + `adssettings.google.com` link.
- (Phase 1.4) `hl=en` forced on the Maps URL — Maps was rendering in the
  browser locale despite `locale: 'en-US'`.
- (Phase 1.4) Category/address selectors rewrote with nested-`.W4Efsd` parser
  so they no longer grab hours text.

### Known limitations (Phase 1 scope)

These are **deliberately deferred** to later phases (see `SCRAPER_FEATURES.md`):

- No proxy / IP rotation (Phase 2).
- No auto-CAPTCHA solving — pauses for manual solve, then aborts with
  checkpoint preserved (Phase 2).
- Single concurrent run — one browser, one query, sequential (Phase 3).
- List-view `phone`/`website`/`plus_code`/`price_level` are absent on modern
  cards; use `--deepScrape true` to populate them (Phase 1.5).
- Selectors are DOM-coupled — see `SELECTORS.md` for the update procedure.
- No incremental / scheduled runs (Phase 4).
- `commonjs`, not ESM; CLI only, no GUI (Phase 5).

### Acceptance test (Definition of Done)

A fresh clone + `npm install` + `npx playwright install chromium` +
`npm start -- --query "Restaurant" --location "Toronto" --limit 20` produces
a CSV within 10 minutes. ✅ Verified.

---

## Pre-release history

These commits built up Phase 1 incrementally before the `v1.0.0-phase1` tag.
Each is a shippable sub-phase; see `PHASE1_EXECUTION_PLAN.md` for the
granular spec and acceptance criteria per sub-phase.

- `a83eb37` — Initial Playwright scraper setup
- `04ed8db` — Add world-class scraper feature roadmap (`SCRAPER_FEATURES.md`)
- `4b62287` — Add Phase 1 execution plan (granular sub-phases)
- `0e1589c` — Phase 1.0: project hygiene & foundation
- `084d3f7` — Phase 1.1: configurable search input
- `ea28971` — Phase 1.2: robust browser automation core
- `a8c72a7` — Phase 1.3: pagination / infinite-scroll handling
- `59704ca` — Phase 1.4: Core Field Extraction (List View)
- `48f9c0e` — Phase 1.5: detail-page deep scrape (optional)
- `a6b0315` — Phase 1.6: CSV/JSON export engine
- `48c7306` — Phase 1.7: reliability & crash recovery
- `fcbc221` — docs: mark Phase 1.7 done
- `2644759` — Phase 1.8: minimal anti-block behavior
- `972a6bb` — Phase 1.9: structured logging & observability
- `d7a7d26` — Phase 1.10: CLI polish & developer experience
- _(this release)_ — Phase 1.11: documentation & handoff (`v1.0.0-phase1`)
