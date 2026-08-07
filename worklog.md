# Scraper — Work Log

This file tracks work done by agents on the Scraper project. Each entry is
appended (never overwritten). New entries start with `---`.

---
Task ID: 1.8
Agent: main (Z.ai Code)
Task: Implement Phase 1.8 — Minimal Anti-Block Behavior (per PHASE1_EXECUTION_PLAN.md §1.8)

Work Log:
- Read Phase 1.8 spec from PHASE1_EXECUTION_PLAN.md (lines 422-454)
- Audited current state: src/browser.js already has pickUserAgent() with 3 UAs;
  src/search.js still uses .fill() (instant, not human); src/scroll.js uses
  fixed batchDelayMs=800; src/detail.js uses 1000-3000ms range (spec wants
  1500-3500); no rate limiter; no CAPTCHA detection.
- Baseline: 276 tests / 675 assertions passing, clean git tree.

Stage Summary:
- Starting Phase 1.8 implementation. Plan: new src/antiblock.js module, wire
  into config/browser/search/scroll/detail/index, add tests/antiblock.test.js,
  update docs + execution plan, push to GitHub.

---
Task ID: 1.8 (complete)
Agent: main (Z.ai Code)
Task: Implement Phase 1.8 — Minimal Anti-Block Behavior (per PHASE1_EXECUTION_PLAN.md §1.8)

Work Log:
- Created src/antiblock.js (core module): USER_AGENTS (8 entries), pickUserAgent(rng),
  randomInt/randomDelay, humanType (char-by-char with injectable typeFn/delayFn/sleepFn),
  RateLimiter (sliding-window, max N per 60s, injectable nowFn/sleepFn for tests),
  CAPTCHA_INDICATORS + detectCaptchaInText (pure) + detectCaptcha (page-bound),
  BLOCK_STATUSES + isBlockStatus, attachBlockWatcher (page.on('response') for 429/503).
- Updated src/config.js: added `antiblock` config section (maxRequestsPerMin=30,
  humanTyping, captchaPause, captchaWaitMs=300000, + 8 delay-range env vars) and
  CLI flags --maxRPM / --noHumanTyping / --noCaptchaPause / --captchaWaitMs.
  Validation for maxRPM (1-600) and captchaWaitMs (0-3600000). Updated HELP_TEXT.
- Updated src/browser.js: imports pickUserAgent + attachBlockWatcher from antiblock;
  slowMo defaults to 0 (randomized delays at action sites instead); withBrowser
  accepts opts {logger, onBlocked} to wire the 429/503 watcher; detach on teardown.
- Updated src/search.js: replaced searchInput.fill() with humanType (50-150ms/key)
  unless cfg.antiblock.humanTyping===false; added randomized pre-Enter delay
  (500-1500ms); rate limiter acquired before page.goto; CAPTCHA detection on
  feed-appearance failure (surfaces root cause instead of generic error).
- Updated src/scroll.js: pickBatchDelay({batchDelayMs, batchDelayMinMs, batchDelayMaxMs})
  — randomized per-iteration when min/max given, fixed (legacy) otherwise;
  scrollFeedToBottomOnPage passes cfg.antiblock.scrollDelayMin/MaxMs (800-2000).
- Updated src/detail.js: detail delay bumped to 1500-3500ms (was 1000-3000) via
  cfg.antiblock.detailDelayMin/MaxMs; rate limiter acquired before each detail-panel
  open; deepScrapeAll accepts captchaCheck hook — after each business, if detected,
  logs error + prints CAPTCHA DETECTED alert to stderr + pauses captchaWaitMs +
  throws err.code='CAPTCHA_DETECTED'.
- Updated src/index.js: constructs RateLimiter once (cfg.rateLimiter); passes to
  performSearch + deepScrapeAll; wires onBlocked callback to withBrowser; passes
  captchaCheck => detectCaptcha(page) hook to deepScrapeAll; catches CAPTCHA_DETECTED
  error code separately with a clear "rerun with --resume" hint; adds antiblock
  stats to run summary (maxRPM, rateLimitWaits, humanTyping).
- Wrote tests/antiblock.test.js (55 tests): pickUserAgent, randomInt, randomDelay,
  humanType (4 tests), RateLimiter (5 tests), detectCaptchaInText (8 tests),
  detectCaptcha page-bound (3), isBlockStatus (3), attachBlockWatcher (6),
  scroll.pickBatchDelay (3), + 17 config tests for Phase 1.8 flags/validation/env.
- Updated package.json: version 0.7.0 → 0.8.0, syntax script includes antiblock.js.
- Updated .env.example: added Phase 1.8 section (MAX_REQUESTS_PER_MIN, HUMAN_TYPING,
  CAPTCHA_PAUSE, CAPTCHA_WAIT_MS, + 8 delay-range vars); bumped DEEP_SCRAPE_DELAY
  defaults to 1500/3500.
- Updated README.md: added Phase 1.8 section (6 subsections covering delays, typing,
  rate limiter, CAPTCHA detection, 429/503 watcher, UA rotation), added new flags
  to CLI table, added antiblock.js to project structure tree.
- Updated PHASE1_EXECUTION_PLAN.md: status summary table (1.8 → ✅ DONE, 9/12 shipped,
  331 tests/811 assertions), Phase 1.8 section header + all task-checklist items +
  acceptance criteria marked done with implementation notes.

Stage Summary:
- Phase 1.8 fully implemented. 331 tests / 811 assertions passing (was 276/675).
- New module src/antiblock.js is the single source of truth for all anti-block
  tactics; pure functions are DI-testable, page-bound functions are thin wrappers.
- All 6 task-checklist items shipped: randomized delays, human typing, rate limiter,
  CAPTCHA detection + pause, 429/503 detection, UA rotation.
- All 4 acceptance criteria met (CAPTCHA-free 200-run cannot be verified in CI but
  the tactics are in place; delays observable in debug logs; human typing visible
  in headed mode; CAPTCHA pause+alert implemented).
- Critical path remaining: 1.9 → 1.10 → 1.11 (then Phase 1 milestone complete).

---
Task ID: 2.2
Agent: main (Z.ai Code)
Task: Implement Phase 2.2 — Change Tracking & History (per PHASE2_EXECUTION_PLAN.md §2.2)

Work Log:
- Read Phase 2.2 spec from PHASE2_EXECUTION_PLAN.md (lines 224-293): business_snapshots +
  field_changes tables, snapshot-on-update logic, deltas.js pure helpers, run-summary
  changes_detected column, db:history CLI, unit tests.
- Confirmed baseline: Phase 2.1 already committed (b606fbc), working tree clean on phase2
  branch, 475 tests / 1028 assertions passing.
- Extended src/db/schema.sql: added business_snapshots table (id, business_id FK, place_id
  denormalized, rating, reviews_count, business_status, phone, website, snapshot_at, run_id FK)
  with indexes on (business_id, snapshot_at DESC), place_id, run_id; added field_changes table
  (id, business_id FK, place_id denormalized, field, old_value, new_value, delta, detected_at,
  run_id FK) with indexes on (business_id, field, detected_at DESC), (place_id, detected_at DESC),
  run_id; added scrape_runs.changes_detected INTEGER via idempotent DO $$ ALTER guard.
- Created src/db/deltas.js (pure helpers): TRACKED_FIELDS (rating, reviews_count,
  business_status, phone, website), normalizeValue, coerceNumber (parses numeric strings,
  rejects NaN/Infinity), valuesEqual (numeric string vs number compare equal), numericDelta
  (new-old for numbers, new value when old is null = gain, null for non-numeric/NaN/Infinity,
  rounded to 1dp for rating precision), computeChanges (returns [] when nothing changed or
  oldRow is null), summarizeChanges ({total, byField} rollup with every tracked field = 0).
- Wired snapshot + field_changes into src/db.js upsertBusinessesBatch: when a business is
  classified 'updated', SELECT existing id + tracked fields (1 round-trip), compute per-field
  deltas, INSERT old values into business_snapshots (multi-row, 1 round-trip), INSERT changes
  into field_changes (multi-row, 1 round-trip), then UPDATE businesses (existing path). All
  inside persistRunResults BEGIN/COMMIT transaction → atomic rollback on crash.
- Added buildSnapshotInsert + buildFieldChangesInsert pure parameterized SQL builders (exported
  for testing, SQL-injection-safe). Added SNAPSHOT_COLUMNS + FIELD_CHANGE_COLUMNS constants.
- Extended persistRunResults to stamp changes_detected onto scrape_runs (alongside
  db_inserted/updated/unchanged) and return {changesDetected, changesByField, snapshotsWritten}.
- Updated src/index.js banner: DB line now includes per-field change breakdown when any tracked
  field changed — "30 updated (12 rating changes, 8 review-count changes, 2 status changes)".
- Created src/db/history.js CLI: npm run db:history -- --placeId <id> prints Business/Current/
  Timeline. Pure formatters (formatValue, formatDelta, fieldLabel, formatTimestamp,
  formatChangeLine, formatCurrentLine, parseArgs) exported for testing. Flags: --placeId/--place-id/-p,
  --limit (default 100), --help/-h, positional connection-string override. Exit codes 0/2/3.
- Extended tests/db.test.js mock client: added _snapshots + _fieldChanges in-memory arrays with
  transaction snapshot/restore (ROLLBACK clears them); added handlers for SELECT tracked fields,
  INSERT business_snapshots, INSERT field_changes; added 19 new Phase 2.2 tests (insert→no
  snapshots, unchanged→no snapshots, changed reviews_count→1 snapshot + 1 field_change, rating
  delta -0.2, status flip null delta, multi-field update, changesByField rollup, persistRunResults
  stamps changes_detected, SQL-builder tests, summarizeChanges tests); extended integration tests
  to drop+recreate all 4 tables and verify real-Postgres re-scrape writes snapshot+changes +
  identical re-scrape writes neither.
- Created tests/db-deltas.test.js (57 tests): normalizeValue, coerceNumber, valuesEqual,
  numericDelta (null→gain, value→loss, string coercion, NaN, Infinity, 1dp rounding),
  computeChanges (all 5 tracked fields, null↔value, empty-string normalization, custom field
  list), summarizeChanges, history.js formatters + parseArgs.
- Fixed numericDelta edge case: distinguished null/undefined/'' old (legitimate gain → +new)
  from NaN/Infinity old (can't compute → null).
- Updated package.json: added db:history script; extended syntax script to check deltas.js +
  history.js.
- Updated PHASE2_EXECUTION_PLAN.md: status table (2.2 → ✅ DONE, 3/13 shipped, 551 tests),
  Phase 2.2 section header + all task-checklist items + acceptance criteria marked done with
  implementation notes.
- Updated CHANGELOG.md: added Phase 2.2 section (Added/Tests/Documentation).
- Updated README.md: roadmap (2.2 ✅), schema section (4 tables), new "Change tracking &
  history (Phase 2.2)" section with tracked-fields table + db:history usage + transactional
  snapshotting note; updated banner example to show change breakdown.

Stage Summary:
- Phase 2.2 fully implemented. 551 tests / 1407 assertions passing (was 475 / 1028; +76 tests).
- New pure module src/db/deltas.js is the single source of truth for change detection; new CLI
  src/db/history.js makes trend data queryable per-business.
- All 5 task-checklist items shipped + all 5 acceptance criteria met (transactional snapshotting
  verified via mock rollback machinery; identical re-scrape produces zero snapshots/changes).
- Critical path remaining (per plan): 2.3 (Proxy Management) next on the stealth/scale track;
  2.12 (Incremental Scraping) next on the data track (builds on 2.2's change_hash).

---
Task ID: 2.11
Agent: main (Z.ai Code)
Task: Implement Phase 2.11 — Self-Healing Selectors & Health Checks (per PHASE2_EXECUTION_PLAN.md §2.11)

Work Log:
- Read Phase 2.11 spec from PHASE2_EXECUTION_PLAN.md (lines 893-954): selector versioning,
  startup health check, heuristic auto-discovery, extraction-rate-based abort, selector
  debug dumps, fixture-based regression test, config flags, unit tests.
- Confirmed baseline: Phase 2.10 complete (commit 9ec3dc4), 1190 tests / 7720 assertions
  passing, working tree clean on phase2 branch.
- Created src/selectors/ directory with 5 modules:
  - version.js: SELECTOR_VERSIONS registry (list/detail/search/scroll sets, each with
    version + lastVerifiedDate + source + fields), parseDate (with rollover rejection),
    getSelectorAgeDays, isSelectorSetStale, getSelectorStatus, logSelectorVersion (logs
    one INFO per set + one WARN per stale set with actionable hint).
  - auto-discover.js: DISCOVERABLE_FIELDS (phone/website/rating/reviews_count),
    buildDiscoveryRequests (pure — returns [{cardIndex, fields}] for cards with missing
    discoverable fields), applyDiscoveryResults (pure — fills in missing fields with
    optional normalizers for raw→canonical conversion + optional tagDiscovered flag),
    DISCOVERY_SCRIPT (browser-side function source inlined into page.evaluate via
    new Function()), discoverInCard with 4 strategies per field (phone: aria-label*="phone"
    + regex, a[href^="tel:"], data-item-id*="phone", text regex with +/parens/10+digit
    guard; website: non-Google <a href^="http">; rating: aria-label containing rated|stars,
    role="img" with number aria-label; reviews_count: text matching (1,234) or "1,234 reviews"),
    describeSelector (builds a CSS selector for the discovered element), discoverField
    (single-field wrapper), discoverMissingFields (batch discovery in one page.evaluate
    round-trip, logs each success).
  - health-check.js: healthCheck (page-bound wrapper that runs extractBusinesses on a
    pre-set-up page, optional auto-discover pass, evaluateHealth, logs pass/fail with
    coreRates + failingCore + hint). Re-exports pure helpers from extract.js to avoid
    circular require.
  - debug-dump.js: DEFAULT_DUMP_THRESHOLD_PCT=80, shouldDumpForField (pure, respects
    enabled flag + threshold), buildDumpPath (sanitizes field name + ISO timestamp),
    buildDumpContent (HTML comment header + 500-char card snippets), dumpSelectorDebug
    (mkdirSync recursive + writeFileSync, returns path or null).
  - index.js: barrel export for all 5 modules.
- Modified src/extract.js: added CORE_FIELDS (name/rating/reviews_count/address),
  SECONDARY_FIELDS, SELECTOR_FAILURE_EXIT_CODE=3, CORE_THRESHOLD_PCT=50,
  SECONDARY_THRESHOLD_PCT=30, DEFAULT_MIN_SAMPLE_SIZE=10, evaluateHealth (pure,
  skips when sample < minSampleSize), isCriticalFailure, buildSelectorFailureError
  (sets code=SELECTOR_FAILURE + exitCode=3 + health), checkExtractionRatesForAbort
  (throws on critical failure), getCardSnippets (page.evaluate fetching innerHTML
  for specific card indexes). Wired extractBusinesses with ctx.selectors — autoDiscover
  (default on, try/catch non-fatal, passes normalizers for raw→canonical conversion),
  abortCheck (default off, opt-in via index.js), debugDump (default on, iterates
  CORE+SECONDARY fields, dumps when rate < threshold via getCardSnippets + dumpSelectorDebug).
- Modified src/config.js: added --skipHealthCheck, --autoDiscover on|off,
  --selectorDebugDump on|off, --maxSelectorAge N, --selectorDebugDir <path> CLI flags
  + SKIP_HEALTH_CHECK/AUTO_DISCOVER/SELECTOR_DEBUG_DUMP/MAX_SELECTOR_AGE/SELECTOR_DEBUG_DIR/
  HEALTH_CHECK_FIXTURE env vars. Added cfg.selectors section with skipHealthCheck/
  autoDiscover/selectorDebugDump/maxSelectorAge/debugDumpDir/healthCheckFixture/resolved.
  Added validation (autoDiscover/selectorDebugDump must be boolean, maxSelectorAge 1-365).
  Updated HELP_TEXT with Phase 2.11 section.
- Modified src/index.js: added fs + selectors imports. logSelectorVersion at startup
  with maxAgeDays=cfg.selectors.maxSelectorAge. Startup health check in separate
  withBrowser call before main pipeline — loads fixture, runs healthCheck, throws
  SELECTOR_FAILURE on !ok, non-fatal on browser/fixture errors. cfg.selectors.resolved
  = {ran, ok, rates, elapsedMs, failingCore, failingSecondary}. SELECTOR_FAILURE catch
  branch in outer try/catch — exits with SELECTOR_FAILURE_EXIT_CODE [3] + logs failing
  fields + hint. ctx.selectors passed to all 3 extractBusinesses calls (sequential +
  pool + queue) with autoDiscover/abortCheck:true/debugDump/debugDumpDir. Selectors
  stats in run summary.
- Wrote tests/selectors-health.test.js (69 tests / 210 assertions):
  - version.js (11 tests): SELECTOR_VERSIONS shape, parseDate valid/invalid, getSelectorAgeDays
    today/N-days/unknown/future, isSelectorSetStale fresh/old, getSelectorStatus,
    logSelectorVersion with/without .phase() + stale warning.
  - auto-discover.js pure (9 tests): DISCOVERABLE_FIELDS, buildDiscoveryRequests
    empty/populated/non-discoverable, applyDiscoveryResults fill/override/empty/non-
    canonical-tags/tagDiscovered/out-of-range.
  - auto-discover.js page-bound (9 tests): discoverField phone/website/rating/
    reviews_count/non-discoverable/out-of-range, discoverMissingFields empty/batch/logging.
  - health-check.js pure (11 tests): CORE_FIELDS/SECONDARY_FIELDS/exit code/thresholds,
    evaluateHealth high/low/small-sample/secondary, isCriticalFailure, buildSelectorFailureError,
    checkExtractionRatesForAbort throw/no-throw/small-sample.
  - health-check.js page-bound (4 tests): healthCheck passes on healthy fixture, fails on
    broken fixture, fails when core rates low, runs auto-discover.
  - debug-dump.js (9 tests): threshold, shouldDumpForField true/false/disabled/null,
    buildDumpPath timestamp/sanitize, buildDumpContent fields/truncate, dumpSelectorDebug
    writes/empty/filesystem-error.
  - extract.js re-exports (5 tests): exports, evaluateHealth matches, getCardSnippets
    indexes/empty/out-of-range.
  - extractBusinesses integration (4 tests): fills via auto-discover, skips when disabled,
    throws on critical rates, writes debug dumps.
- Wrote tests/selectors-fixture.test.js (45 tests / 120 assertions): 3 fixtures × 15
  assertions each — fixture loads + extracts ≥1, stats include discovery, 4 core fields
  ≥70%, 8 secondary fields ≥15% (with sparse overrides for plus_code/price_level/phone/
  website/open_now), full rate summary logged. Catches selector breakage before production.
- Added 22 Phase 2.11 config tests to tests/config.test.js: cfg.selectors section exists,
  defaults, --skipHealthCheck, --autoDiscover on/off, --selectorDebugDump off, --maxSelectorAge,
  --selectorDebugDir, healthCheckFixture, env vars (AUTO_DISCOVER/SKIP_HEALTH_CHECK/
  HEALTH_CHECK/MAX_SELECTOR_AGE), validation (0/366/365 boundary), HELP_TEXT coverage.
- Updated .env.example: expanded Phase 2.11 section (HEALTH_CHECK, AUTO_DISCOVER,
  SELECTOR_DEBUG_DUMP, MAX_SELECTOR_AGE, SELECTOR_DEBUG_DIR, HEALTH_CHECK_FIXTURE,
  SKIP_HEALTH_CHECK) with explanatory comments.
- Updated SELECTORS.md: added "Self-healing selectors (Phase 2.11)" section documenting
  the 5 layers (versioning, startup health check, first-batch abort, auto-discovery,
  debug dumps), config flags table, and how-to-update-selectors guide.
- Updated package.json: version 1.0.0-phase2.10 → 1.0.0-phase2.11, syntax script includes
  src/selectors/*.js, deduplicated the two syntax keys (was a bug from a previous phase).
- Updated PHASE2_EXECUTION_PLAN.md: status summary (12 of 13 shipped), Phase 2.11 row
  marked ✅ DONE with full Shipped block, task checklist + acceptance criteria all [x].

Stage Summary:
- Phase 2.11 fully implemented. 1326 tests / 8079 assertions passing (was 1190/7720).
- 136 new tests (69 selectors-health + 45 selectors-fixture + 22 config).
- 5-layer self-healing selector defense: version registry + staleness warning (30d default),
  startup health check (loads fixture, aborts if core <50%), first-batch abort (after 10
  businesses, exit code 3), heuristic auto-discovery (phone/website/rating/reviews_count
  via pattern + aria-label proximity, raw→canonical normalization), debug dumps (500-char
  card innerHTML to data/selector-debug/{field}_{timestamp}.html when rate <80%).
- Architecture: pure helpers (evaluateHealth, checkExtractionRatesForAbort, CORE_FIELDS,
  SECONDARY_FIELDS) live in extract.js to avoid circular require with health-check.js.
  health-check.js re-exports them + adds the page-bound healthCheck wrapper.
  auto-discover.js is self-contained (DISCOVERY_SCRIPT inlined into page.evaluate via
  new Function()). debug-dump.js is pure + filesystem.
- All 8 task-checklist items shipped + all 6 acceptance criteria met.
- Only Phase 2.12 (Incremental Scraping & Detail Caching) and Phase 2.13 (Final
  Integration, Docs & Handoff) remain.

---
Task ID: 2.12
Agent: main (Z.ai Code)
Task: Implement Phase 2.12 — Incremental Scraping & Detail Caching (per PHASE2_EXECUTION_PLAN.md §2.12)

Work Log:
- Read Phase 2.12 spec from PHASE2_EXECUTION_PLAN.md (lines 962-1027). Verified
  prior phases 2.9/2.10/2.11 committed on phase2 branch (1326 tests baseline).
- Explored project structure: src/db.js (computeRowHash, upsertBusinessesBatch,
  persistRunResults), src/db/schema.sql (businesses table), src/config.js (flag
  pattern), src/index.js (sequential scrape flow around line 1980-2080 +
  result assembly + banner + persistRunResults call).
- Created src/incremental.js (new module, ~520 lines):
  - LIST_VIEW_HASH_COLUMNS (15 fields: name/rating/reviews_count/.../query/location).
  - computeChangeHash (SHA-256 list-view-only — distinct from db.js data_hash
    which includes detail JSONB).
  - ageDays, classifyListFreshness (new/fresh/stale), reviewDeltaPct,
    decideDetailScrape (cache_hit/cache_miss/forced_refresh/no_cache),
    mergeCachedDetail (merges detail fields + sets detail_scraped=true).
  - CacheStats accumulator (recordList/recordDetail/recordPreflightSkip +
    estimateSavings + toJSON).
  - formatCacheStatsSummary (renders the execution-plan banner format).
  - createIncrementalCache (DI pg Pool wrapper: preflightRun/lookupBusinesses/
    loadBusinessesForRun/close).
  - rowToBusiness (JSONB parse + Date→ISO).
- Modified src/db/schema.sql: added 3 columns via idempotent DO$$ ALTER blocks
  (last_list_scraped TIMESTAMPTZ, last_detail_scraped TIMESTAMPTZ, change_hash
  TEXT) + 2 composite indexes. Migration re-runnable against 2.1/2.2 DBs.
- Modified src/db.js:
  - Imported computeChangeHash from incremental.js (one-way require, no cycle).
  - buildBatchInsert: +change_hash/last_list_scraped/last_detail_scraped
    (NOW() for list; NOW() when detail_scraped else NULL for detail).
  - buildUpdate: +same 3 columns; last_detail_scraped uses CASE WHEN
    detail_scraped THEN NOW() ELSE last_detail_scraped END (preserves cached
    timestamp when no detail scrape this run).
  - buildUnchangedRefresh (new): batched VALUES-table UPDATE of
    last_list_scraped + change_hash for unchanged businesses — does NOT touch
    updated_at (preserves Phase 2.1 contract).
  - upsertBusinessesBatch: +opts.incremental flag; unchanged businesses
    collected + batched refresh issued (non-fatal on error).
  - persistRunResults: passes incremental through to upsert.
  - Exports: +computeChangeHash, +buildUnchangedRefresh.
- Modified src/config.js:
  - parseArgs: +--incremental/--listFreshnessDays/--detailCacheTtlDays/
    --detailRefreshOnReviewDelta/--noDetailCache/--swrr.
  - cfg.incremental section (enabled/listFreshnessDays/detailCacheTtlDays/
    detailRefreshOnReviewDelta/noDetailCache/swrr/resolved) + env-var parity
    (INCREMENTAL/LIST_FRESHNESS_DAYS/DETAIL_CACHE_TTL_DAYS/
    DETAIL_REFRESH_ON_REVIEW_DELTA/NO_DETAIL_CACHE/SWRR).
  - Validation: --incremental requires --output db; range checks
    (listFreshnessDays 0-365, detailCacheTtlDays 0-365,
    detailRefreshOnReviewDelta 0-1000).
  - HELP_TEXT: Phase 2.12 section + 6 example commands.
- Modified src/index.js:
  - Imported incremental helpers (createIncrementalCache, classifyListFreshness,
    decideDetailScrape, mergeCachedDetail, computeChangeHash, CacheStats,
    formatCacheStatsSummary).
  - Constructed shared dbPool + incrementalCache + cacheStats early in main()
    (after rate limiter, before proxy pool). cfg.incremental.resolved set.
  - Run-level preflight before browser launch: if preflight.skip → load
    businesses from DB, synthesize minimal result object, skip browser +
    health check + scrape (guarded by !incrementalPreflightSkip).
  - Per-business detail-cache check in sequential detail-setup loop: batched
    lookup → fresh+change_hash match skips detail entirely (mergeCachedDetail
    + detail_scraped=true); detail TTL check (cache_hit reuses cached detail,
    cache_miss/forced_refresh/no_cache leave for deepScrapeAll).
  - persistRunResults reuses shared dbPool + passes incremental flag.
  - Cache-stats banner block (Incremental/Detail cache/Saved lines) +
    structured run-complete log (incremental: {list, detail, preflight,
    savings}).
  - dbPool closed at end (best-effort; skipped in endless mode).
- Updated .env.example: expanded Phase 2.12 section (INCREMENTAL/
  LIST_FRESHNESS_DAYS/DETAIL_CACHE_TTL_DAYS/DETAIL_REFRESH_ON_REVIEW_DELTA/
  NO_DETAIL_CACHE/SWRR) with explanatory comments.
- Updated package.json: version 1.0.0-phase2.11 → 1.0.0-phase2.12; syntax
  script includes src/incremental.js.
- Wrote tests/incremental.test.js (110 tests / 276 assertions):
  - computeChangeHash (11): deterministic, list-view-only (detail fields
    don't change it), 64-char hex, key-order-independent.
  - ageDays (8): null/invalid/future/Date/epoch-ms/defaults.
  - classifyListFreshness (7): new/fresh/stale/boundary/null-timestamp/
    freshness=0/default.
  - reviewDeltaPct (9): 100→115, negative, 0→N, 0→0, null-as-0, undefined→null.
  - decideDetailScrape (13): the 8 required cases + boundary (exactly 10%),
    threshold=0, negative delta, ttl=0, null last_detail_scraped.
  - mergeCachedDetail (6): merges detail, sets detail_scraped, no mutation,
    preserves fresh list-view, null cached, null cached fields.
  - CacheStats (7): empty, recordList, recordDetail, recordDetailDisabled,
    recordPreflightSkip, estimateSavings, toJSON.
  - formatCacheStatsSummary (4): empty, acceptance-criteria shape, preflight
    skip, accepts serialized object.
  - createIncrementalCache (11): preflight skip/no-skip/error, lookup Map,
    empty placeIds, error tolerance, loadBusinessesForRun, null pool, close.
  - rowToBusiness (5): JSONB string parse, object preserve, Date→ISO, null,
    invalid JSON.
  - Integration scenarios (7): all 6 acceptance criteria end-to-end +
    full preflight-skip flow.
  - db.js integration (5): re-export parity, buildUnchangedRefresh null/
    VALUES-table/no-updated_at/injection-safe.
  - Config (17): defaults, all 6 flags, env vars, validation (3 range errors
    + boundary), HELP_TEXT coverage.
- Added 4 tests to tests/db.test.js: incremental freshness-refresh on
  unchanged (query issued), no-refresh when flag off (Phase 2.1 behavior),
  change_hash/last_list_scraped populated on INSERT, last_detail_scraped NULL
  when not detail_scraped. Fixed 1 existing assertion (params.length +2 → +5
  for the 3 new columns).
- Ran full test suite: 1440 pass / 0 fail / 8401 assertions (was 1326/8079).
  114 new tests (110 incremental + 4 db). Syntax check clean. No regressions.

Stage Summary:
- Phase 2.12 fully implemented. 1440 tests / 8401 assertions passing.
- Two-tier incremental cache: run-level preflight (skip browser when most-
  recent scrape of query/location is within --listFreshnessDays → 100% cache
  hits, ~0 requests, <30s) + per-business detail cache (--detailCacheTtlDays
  default 7d, reuse cached hours/reviews/photos via mergeCachedDetail +
  detail_scraped=true so deepScrapeAll skips).
- change_hash is list-view-only SHA-256 (distinct from Phase 2.1 data_hash
  which includes detail JSONB) — a detail-only change does NOT invalidate
  list freshness. This is the core design contract.
- Review-delta heuristic (--detailRefreshOnReviewDelta default 10%) forces
  detail re-scrape on review SURGES even within TTL (only positive deltas;
  0→N reports 1000 so any threshold triggers).
- Unchanged businesses get a lightweight batched last_list_scraped refresh
  (no updated_at bump — preserves Phase 2.1 "unchanged = no updated_at
  bump" contract) so frequently-re-scraped businesses stay fresh.
- --noDetailCache forces deep-scrape; --swrr stubbed for Phase 5.
- All pure helpers DI-testable with mock DB (no real Postgres needed).
- --incremental off preserves Phase 2.1/1.5 behavior byte-for-byte
  (incremental flag defaults false everywhere; upserts populate the new
  columns but they're harmless NULLs when unused).
- Only Phase 2.13 (Final Integration, Docs & Handoff) remains.
