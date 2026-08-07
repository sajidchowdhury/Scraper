# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Phase 1 is tagged `v1.0.0-phase1` — the `-phase1` suffix marks the milestone
(Phase 1 of the master roadmap in `SCRAPER_FEATURES.md`).

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
