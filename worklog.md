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
