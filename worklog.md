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
