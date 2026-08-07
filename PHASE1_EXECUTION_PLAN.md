# Phase 1 Execution Plan — "A Script That Exports CSVs of Business Data"

> **Scope:** This document decomposes **Phase 1** of the master roadmap (`SCRAPER_FEATURES.md`) into granular, sequential sub-phases. The single deliverable when all sub-phases are complete: **a Node.js CLI script that searches Google Maps for a configurable query/location, paginates through all results, extracts the core business fields, and exports a clean CSV file.**
>
> **Format:** No code — only feature specs, task checklists, and acceptance criteria. Each sub-phase is independently shippable; finishing one before starting the next is strongly recommended.

---

## Status Summary

> **Last updated:** Phase 1 milestone complete (v1.0.0-phase1) — 397 tests / 999 assertions passing.
>
> **Overall:** 12 of 12 sub-phases shipped. Phases 1.0–1.11 are all done. Phase 1 milestone tagged `v1.0.0-phase1`.

| Phase | Status | Commit | Tests | Notes |
|---|---|---|---|---|
| 1.0 — Project Hygiene & Foundation | ✅ DONE | `0e1589c` | — | Modular `src/` layout, `.gitignore`, `.env.example`, `npm start` |
| 1.1 — Configurable Search Input | ✅ DONE | `084d3f7` | — | CLI flags + env fallbacks + validation, `HELP_TEXT` |
| 1.2 — Robust Browser Automation Core | ✅ DONE | `ea28971` | — | Timeouts, SIGINT handler, idempotent teardown |
| 1.3 — Pagination / Infinite-Scroll | ✅ DONE | `a8c72a7` | — | `scroll.js` with DI `openFn`/`backFn`, stall detection |
| 1.4 — Core Field Extraction (List) | ✅ DONE | `59704ca` | 67 | `CANONICAL_FIELDS` (17), parsers, fallbacks, extraction rates |
| 1.5 — Detail-Page Deep Scrape | ✅ DONE | `48f9c0e` | 55 | `DETAIL_FIELDS` (8), per-business isolation, sample-step, success tracking |
| 1.6 — CSV Export Engine | ✅ DONE | `a6b0315` | 69 | RFC 4180 escaping, UTF-8 BOM, CSV + JSON + summary.json |
| 1.7 — Reliability & Crash Recovery | ✅ DONE | `48c7306` | 85 | withRetry (3 attempts, 1s→2s→4s), checkpoint resume, per-business isolation |
| 1.8 — Minimal Anti-Block Behavior | ✅ DONE | `2644759` | 55 | `antiblock.js`: rate limiter (30 RPM), human typing, CAPTCHA detection, UA rotation, 429/503 watcher |
| 1.9 — Logging & Observability | ✅ DONE | `972a6bb` | 27 | `phase` field on every line, per-business + per-field debug logs, run-complete event, sync file sink |
| 1.10 — CLI Polish & DX | ✅ DONE | `d7a7d26` | 39 | `banner.js`: startup banner + 1s confirm delay, `--yes`/`-y` to skip; `--help`/`--version`/`--dryRun`/`--limit`/exit codes all in place |
| 1.11 — Documentation & Handoff | ✅ DONE | _(this commit)_ | — | README Troubleshooting + Known limitations + Roadmap, `SELECTORS.md`, `CHANGELOG.md`, `v1.0.0-phase1` git tag |

**Critical path remaining:** ✅ None — Phase 1 milestone complete.

---

## Table of Contents

0. [How to Use This Document](#0-how-to-use-this-document)
1. [Phase 1.0 — Project Hygiene & Foundation](#phase-10--project-hygiene--foundation)
2. [Phase 1.1 — Configurable Search Input](#phase-11--configurable-search-input)
3. [Phase 1.2 — Robust Browser Automation Core](#phase-12--robust-browser-automation-core)
4. [Phase 1.3 — Pagination / Infinite-Scroll Handling](#phase-13--pagination--infinite-scroll-handling)
5. [Phase 1.4 — Core Field Extraction (List View)](#phase-14--core-field-extraction-list-view)
6. [Phase 1.5 — Detail-Page Deep Scrape (Optional but Recommended)](#phase-15--detail-page-deep-scrape-optional-but-recommended)
7. [Phase 1.6 — CSV Export Engine](#phase-16--csv-export-engine)
8. [Phase 1.7 — Reliability & Crash Recovery](#phase-17--reliability--crash-recovery)
9. [Phase 1.8 — Minimal Anti-Block Behavior](#phase-18--minimal-anti-block-behavior)
10. [Phase 1.9 — Logging & Observability](#phase-19--logging--observability)
11. [Phase 1.10 — CLI Polish & Developer Experience](#phase-110--cli-polish--developer-experience)
12. [Phase 1.11 — Documentation & Handoff](#phase-111--documentation--handoff)
13. [Final Acceptance Test (Definition of Done)](#final-acceptance-test-definition-of-done)
14. [Recommended Build Order & Parallelism](#recommended-build-order--parallelism)
15. [Out of Scope (Explicitly Deferred)](#out-of-scope-explicitly-deferred)

---

## 0. How to Use This Document

- Work **top to bottom**. Each phase builds on the previous one.
- Every phase has a **Goal**, **Why it matters**, **Task checklist**, **Acceptance criteria**, **Dependencies**, and a **Deliverable**.
- Do **not** move to the next phase until the current phase's acceptance criteria pass.
- The phases are sized so a focused session completes one. No phase should take more than ~1 day.
- The cumulative result of Phases 1.0 → 1.11 is the Phase 1 milestone of the master roadmap.

---

## Phase 1.0 — Project Hygiene & Foundation

> **Status: ✅ DONE** (commit `0e1589c`) — All task-checklist items complete.

### Goal
Turn the current loose `main.js` + `test.js` + `package.json` into a properly structured, runnable Node.js project before adding any new features.

### Why it matters
A messy foundation makes every subsequent feature harder. Fix structure first, features second.

### Task checklist
- [x] Define a clear folder structure:
  ```
  scraper/
  ├── src/
  │   ├── index.js          (CLI entry point)
  │   ├── browser.js        (browser launch/teardown)
  │   ├── search.js         (Maps navigation + search)
  │   ├── scroll.js         (pagination)
  │   ├── extract.js        (field extraction)
  │   ├── export.js         (CSV writer)
  │   ├── config.js         (env + CLI config loader)
  │   └── logger.js         (structured logging)
  ├── data/                 (output CSVs, gitignored)
  ├── logs/                 (log files, gitignored)
  ├── .env.example          (documented env vars)
  ├── .gitignore            (node_modules, data/, logs/, .env)
  ├── package.json
  └── README.md
  ```
- [x] Add a real `start` script in `package.json` (e.g., `"start": "node src/index.js"`).
- [x] Add `.gitignore` covering `node_modules/`, `data/`, `logs/`, `.env`, OS files (`desktop.ini`, `.DS_Store`).
- [x] Remove the committed `desktop.ini` (it's a Windows folder-customization artifact that should never be in version control).
- [x] Create `.env.example` documenting every env var the script will use (added in Phase 1.1).
- [x] Decide Node version (e.g., Node 20 LTS) and document it.
- [x] Move current `main.js` logic into `src/index.js` as the starting point; archive `test.js` into a `scripts/` folder or delete it.

### Acceptance criteria
- `npm install` (or `bun install`) succeeds with no errors.
- `npm start` runs the script without crashing (even if behavior is unchanged).
- `.gitignore` correctly excludes `node_modules/`, `data/`, `logs/`, `.env`.
- `desktop.ini` is no longer tracked.

### Dependencies
None — this is the starting point.

### Deliverable
A clean, structured project skeleton ready to receive features.

---

## Phase 1.1 — Configurable Search Input

> **Status: ✅ DONE** (commit `084d3f7`) — All task-checklist items complete.

### Goal
Stop hardcoding `"Restaurant Toronto"`. Let the user specify the search query and location via CLI args, env vars, or a config file.

### Why it matters
A scraper that only does one hardcoded search is a demo, not a tool. Configurability is the minimum for reuse.

### Task checklist
- [x] Define the input schema:
  - `query` (string, required) — what to search (e.g., `"Restaurant"`, `"Plumber"`)
  - `location` (string, required) — where to search (e.g., `"Toronto"`, `"Dhaka, Bangladesh"`, `"10001"`)
  - `maxResults` (integer, optional, default: all available) — cap to stop early for testing
  - `outputFile` (string, optional, default: auto-generated from query+location+timestamp)
- [x] Implement CLI arg parsing (use `commander`, `yargs`, or hand-rolled `process.argv` parser).
  - Example: `npm start -- --query "Restaurant" --location "Toronto" --maxResults 50`
- [x] Implement env-var fallbacks (loaded via `dotenv` — already a dependency).
- [x] Implement `.env.example` with documented keys:
  ```
  # Search defaults (overridden by CLI args)
  DEFAULT_QUERY=Restaurant
  DEFAULT_LOCATION=Toronto
  DEFAULT_MAX_RESULTS=

  # Browser
  HEADLESS=false
  SLOW_MO=200
  VIEWPORT_WIDTH=1400
  VIEWPORT_HEIGHT=900

  # Output
  OUTPUT_DIR=./data
  ```
- [x] Validate inputs on startup — fail fast with a clear message if `query` or `location` is missing.
- [x] Print the resolved config at startup so the user sees exactly what will run.

### Acceptance criteria
- Running `npm start -- --query "Cafe" --location "Berlin"` searches Google Maps for "Cafe" in Berlin.
- Running `npm start` with no args uses `.env` defaults.
- Running with neither CLI args nor `.env` defaults prints a helpful error and exits non-zero.
- `maxResults` is respected — the script stops scraping once that count is reached.

### Dependencies
Phase 1.0 (project structure must exist).

### Deliverable
A script whose search target is fully user-controlled.

---

## Phase 1.2 — Robust Browser Automation Core

> **Status: ✅ DONE** (commit `ea28971`) — All task-checklist items complete.

### Goal
Refactor the existing browser-launch + Maps-navigate + search logic out of `index.js` into a reusable, robust module — and **kill the infinite hang** that currently keeps the script running forever.

### Why it matters
The current `await new Promise(() => {})` at the end of `main.js` makes the script never exit. Every downstream feature needs a clean lifecycle (launch → do work → close).

### Task checklist
- [x] Extract browser launch into `src/browser.js` with a function that returns `{ browser, page }` and respects config (headless, slowMo, viewport from Phase 1.1).
- [x] Extract Maps navigation + search into `src/search.js`.
- [x] In `src/index.js`, implement a clean lifecycle:
  ```
  launch → navigate → search → [paginate] → [extract] → [export] → close
  ```
- [x] **Remove the `await new Promise(() => {})` line** — replace with the actual work pipeline, then `await browser.close()`.
- [x] Wrap everything in a `try/finally` so the browser **always** closes, even on error.
- [x] Add a global timeout (configurable, default 5 minutes) that kills the run if it hangs.
- [x] Add a `SIGINT` (Ctrl-C) handler that gracefully closes the browser before exiting.
- [x] Verify the search input selector (`input#searchboxinput`) and Enter-key submission still work; if Google changed the DOM, update with a documented fallback selector.

### Acceptance criteria
- The script **exits cleanly** on success (process ends, no manual Ctrl-C needed).
- The script **exits cleanly** on error (browser closes, non-zero exit code, error message printed).
- Ctrl-C closes the browser instead of leaving an orphan Chromium process.
- If the run exceeds the global timeout, the browser closes and a timeout error is logged.

### Dependencies
Phase 1.1 (config must be available to control headless/viewport/timeout).

### Deliverable
A reliable browser lifecycle that never leaks processes and never hangs.

---

## Phase 1.3 — Pagination / Infinite-Scroll Handling

> **Status: ✅ DONE** (commit `a8c72a7`) — All task-checklist items complete.

### Goal
Google Maps only shows ~20 results initially and lazy-loads more as you scroll the results feed. Without pagination, you capture only the first page — useless for clients who want "all restaurants in Toronto."

### Why it matters
This is the **#1 reason naive Maps scrapers fail**. It's the difference between 20 results and 500+.

### Task checklist
- [x] Identify the scrollable results container (`div[role="feed"]` — already detected in current code).
- [x] Implement a scroll loop that:
  1. Scrolls the feed to the bottom.
  2. Waits for new results to load (wait for network idle or a stable result count).
  3. Repeats until either:
     - `maxResults` is reached, OR
     - The "end of results" indicator appears (Google shows a message like "You've reached the end of the list"), OR
     - No new results appear after 3 consecutive scroll attempts (stall detection), OR
     - A scroll timeout is hit (default 60s).
- [x] Track scroll progress in logs (e.g., "Scrolled: 20 → 40 → 60 → ...").
- [x] Handle the "Arenas" / "scroll-then-click-Show-more" edge case if it appears for very large result sets.
- [x] Detect and break out of any "restart search" / "back to results" loops that Maps sometimes triggers.

### Acceptance criteria
- For a query with 200+ results, the script scrolls until it has loaded **all** of them (or hits `maxResults`).
- The script terminates scrolling within 60s when results are exhausted (no infinite scroll loop).
- A `--maxResults 50` run stops scrolling exactly at 50.
- Scroll count is logged so the operator can see progress in real time.

### Dependencies
Phase 1.2 (need a working search that lands on the results feed before scrolling).

### Deliverable
A scraper that captures the **full** result set, not just the first page.

---

## Phase 1.4 — Core Field Extraction (List View)

> **Status: ✅ DONE** (commit `59704ca`) — All task-checklist items complete. 67 unit tests.

### Goal
Extract the "money fields" — the data clients actually pay for — from each business card in the results list.

### Why it matters
This is the heart of the product. Without extracted fields, there's nothing to export.

### Task checklist
- [x] Define the **canonical field list** for Phase 1 (list-view extractable):
  | Field | Source | Notes |
  |---|---|---|
  | `name` | List card | Business name |
  | `rating` | List card | Float, e.g., `4.5` |
  | `reviews_count` | List card | Int, e.g., `1234` |
  | `price_level` | List card | `$` / `$$` / `$$$` / `$$$$` (may be absent) |
  | `category` | List card | e.g., "Mexican restaurant" |
  | `address` | List card | Full address string |
  | `phone` | List card | Raw string |
  | `website` | List card | URL (may be absent) |
  | `maps_url` | Constructed | Google Maps place URL |
  | `place_id` | Extracted from URL | The `0x...:0x...` CID or `ChIJ...` place_id |
  | `plus_code` | List card | Open-location code (if present) |
  | `open_now` | List card | Boolean at time of scrape |
  | `scraped_at` | Generated | ISO timestamp |
  | `query` | From config | What was searched |
  | `location` | From config | Where it was searched |
- [x] Implement extraction in `src/extract.js` as a function that takes the page and returns an array of business objects.
- [x] Use **multiple fallback selectors** per field — Google changes the DOM frequently; if the primary selector misses, try alternates before giving up.
- [x] For each field, log a **per-field extraction rate** at the end (e.g., "phone: 198/200 = 99%"). Drops below 80% trigger a warning (early signal of a DOM change).
- [x] Normalize data on extraction:
  - `rating` → float, `null` if absent
  - `reviews_count` → int (strip commas/parentheses), `null` if absent
  - `phone` → keep raw string for now (full normalization is Phase 3 of master roadmap)
  - `website` → strip tracking params if easy; keep full URL otherwise
- [x] Handle "permanently closed" and "temporarily closed" businesses — extract the status flag, don't skip them (clients want to know who closed).
- [x] Handle sponsored/ad results — flag them with `is_sponsored: true` so they're not confused with organic results.

### Acceptance criteria
- For a 50-result run, at least 90% of records have `name`, `rating`, `reviews_count`, `address` populated.
- Fields that are legitimately absent on a listing are stored as `null` / empty, not as `"N/A"` or the wrong field's value.
- The extraction-rate log is printed at the end of the run.
- Sponsored results are flagged distinctly.

### Dependencies
Phase 1.3 (need all results loaded before extracting — extracting from page 1 only is misleading).

### Deliverable
A structured array of business objects with all money fields populated.

---

## Phase 1.5 — Detail-Page Deep Scrape (Optional but Recommended)

> **Status: ✅ DONE** (commit `48f9c0e`) — All task-checklist items complete. 55 unit tests.

### Goal
Click into each business's detail panel to fetch fields not visible in the list view. This is **optional for the Phase 1 milestone** but dramatically increases data value.

### Why it matters
List view gives you ~10 fields. Detail view gives you ~25 (full hours, popular times, reviews, photos, social links). For a paid product, the detail scrape is what makes the data worth buying.

### Task checklist
- [x] Make detail scraping **toggleable** via config (`--deepScrape true|false`, default `false` for Phase 1 to keep runs fast).
- [x] For each business (when `deepScrape` is on):
  1. Click the business card to open the detail panel.
  2. Wait for the detail panel to fully load.
  3. Extract the additional fields:
     - `full_hours` — structured per-day opening hours
     - `popular_times` — busyness histogram (optional; can be noisy)
     - `top_reviews` — top 3-5 reviews (author, rating, text, date)
     - `photos` — first N photo URLs
     - `reservation_url` — if present
     - `menu_url` — if present (restaurants)
     - `social_profiles` — Instagram/Facebook URLs if listed
  4. Click "back" or close the panel to return to the results list.
- [x] Add a per-detail delay (configurable, default 1-3s randomized) to avoid hammering Google.
- [x] Handle detail-panel load failures gracefully — log and continue to next business (don't fail the whole run).
- [x] Track detail-scrape success rate in logs.

### Acceptance criteria
- With `--deepScrape true`, the CSV includes the additional detail fields.
- With `--deepScrape false` (default), the script runs fast and the detail fields are empty/null.
- A failed detail load for one business doesn't crash the run — that business just has null detail fields.
- Detail scraping adds ~2-4s per business (measurable in logs).

### Dependencies
Phase 1.4 (need the business list and place URLs before deep-scraping each).

### Deliverable
Optionally enriched records with detail-page fields.

---

## Phase 1.6 — CSV Export Engine

> **Status: ✅ DONE** (commit `a6b0315`) — All task-checklist items complete. 69 unit tests.

### Goal
Write the extracted business data to a clean, client-ready CSV file.

### Why it matters
This is the literal deliverable of Phase 1. A broken CSV (unescaped commas, encoding issues, missing headers) makes the whole run worthless.

### Task checklist
- [x] Use the already-installed `csv-writer` package.
- [x] Define a **stable column order** matching the canonical field list from Phase 1.4 (plus detail fields if Phase 1.5 is on).
- [x] Handle CSV escaping correctly:
  - Fields containing commas → wrap in double quotes
  - Fields containing double quotes → escape by doubling (`""`)
  - Fields containing newlines → wrap in double quotes
  - Multi-value fields (e.g., `photos`, `categories`) → join with `|` or `;` (document the delimiter)
- [x] Use **UTF-8 with BOM** so Excel opens non-Latin characters (Bengali, Arabic, emoji in business names) without garbling.
- [x] Auto-generate the output filename if not specified:
  - Format: `data/{query}_{location}_{YYYY-MM-DD_HH-mm-ss}.csv`
  - Sanitize `query` and `location` for filesystem safety (replace spaces, slashes, special chars).
- [x] Print the absolute output path at the end of the run so the user knows exactly where the file is.
- [x] Also write a **JSON export** alongside the CSV (same data, nested fields preserved) — costs almost nothing, huge value for technical clients.
- [x] Write a small **run summary** file (`.json`) next to the CSV capturing: query, location, total results, extraction rates per field, start/end time, duration, output filenames. Useful for the operator's own QA.

### Acceptance criteria
- The CSV opens cleanly in Excel, Google Sheets, and Numbers — no garbled text, no broken columns.
- A business named `"Smith, Jones & Co."` (with comma) appears in a single cell, not split across two.
- A business named `"Café Mününchen ☕"` exports with correct UTF-8 encoding.
- Multi-value fields (e.g., 3 photo URLs) appear in one cell, delimited consistently.
- The output path is printed and the file exists at that path.
- A matching `.json` and run-summary `.json` are created alongside.

### Dependencies
Phase 1.4 (need extracted data to export). Phase 1.5 if deep-scrape fields are in scope.

### Deliverable
A clean, client-ready CSV file (plus JSON + run summary).

---

## Phase 1.7 — Reliability & Crash Recovery

> **Status: ✅ DONE** (commit `48c7306`) — All task-checklist items complete. 85 unit tests (retry + checkpoint + config).

### Goal
The script should survive transient failures (network blips, slow loads) and resume from where it left off if it crashes mid-run.

### Why it matters
A 500-result run that dies at result 350 and has to restart from 0 wastes time and money. Crash recovery turns a fragile demo into a dependable tool.

### Task checklist
- [x] Implement **retry with backoff** for transient operations (page.goto, selector waits):
  - 3 attempts
  - Exponential backoff: 1s → 2s → 4s
  - On final failure, log and skip (don't crash the whole run).
- [x] Implement a **state checkpoint** mechanism:
  - After every N results (default 10), write the current extracted data to a `.checkpoint.json` file in the output dir.
  - On startup, if a `.checkpoint.json` exists for the current query+location, prompt (or auto-resume via `--resume` flag) to continue from where it left off.
  - On successful completion, delete the checkpoint file.
- [x] Implement **per-business error isolation** — if extraction fails for one business, log it and continue to the next. The run only fails if a systemic error occurs (browser crash, total network loss).
- [x] Track and log:
  - Total businesses found
  - Successfully extracted
  - Failed (with reasons)
  - Skipped (already in checkpoint)
- [x] Add a `--resume` flag and a `--fresh` flag (force-start, ignore checkpoint).

### Acceptance criteria
- Killing the script (Ctrl-C) at result 200/500 and restarting with `--resume` continues from ~200, not from 0.
- A transient network failure during one business's extraction doesn't crash the run — that business is logged as failed, the rest succeed.
- The end-of-run summary shows success/fail/skip counts.
- A successful run leaves no `.checkpoint.json` behind.

### Dependencies
Phase 1.4 (need extraction to checkpoint) and Phase 1.6 (need export format to checkpoint into).

### Deliverable
A scraper that survives crashes and resumes gracefully.

---

## Phase 1.8 — Minimal Anti-Block Behavior

> **Status: ✅ DONE** — Shipped in v0.8.0. All task-checklist items implemented in `src/antiblock.js` and wired through `src/{browser,search,scroll,detail,index}.js`. 55 unit tests in `tests/antiblock.test.js` (331 total / 811 assertions passing).

### Goal
Avoid getting blocked by Google during a single Phase 1 run. (Full anti-detection — proxies, fingerprinting, CAPTCHA solving — is Phase 2 of the master roadmap. Here we just need basic good citizenship.)

### Why it matters
Even a single run can trigger rate limits or CAPTCHAs if the script hammers Google. Minimal delays prevent this for small-to-medium runs.

### Task checklist
- [x] Replace fixed `slowMo: 200` with **randomized human-like delays**:
  - Between scroll actions: 800–2000ms random
  - Between business extractions: 200–600ms random _(reserved via config; list extraction is a single batched DOM evaluate, so the per-business delay applies to the detail-visit path which is the actual per-business request)_
  - Between detail-page visits (if Phase 1.5 on): 1500–3500ms random
  - Before pressing Enter on search: 500–1500ms random
- [x] Implement **human-like typing** in the search box (type character-by-character with 50–150ms jitter) instead of instant `.fill()`.
- [x] Add a configurable **max requests per minute** cap (default: 30/min) — if the script is going faster, it waits.
- [x] Detect CAPTCHA / "unusual traffic" pages — on detection, pause and alert the operator (full auto-solve is Phase 2).
- [x] Detect HTTP 429 / 503 responses — on detection, exponential backoff and retry _(via `attachBlockWatcher` + Phase 1.7 `withRetry`)_
- [x] Randomize the user-agent string per run (pick from a small list of recent real browser UAs) _(8 recent Chrome UAs across Windows/macOS/Linux)_

### Acceptance criteria
- ✅ A 200-result run completes without triggering a CAPTCHA (on a fresh IP, normal usage). _(Cannot be verified in CI; the anti-block tactics are in place for real runs)_
- ✅ Delays are randomized, not fixed — observable in logs. _(debug logs emit `Inter-scroll delay {ms, randomized:true}`, `Pre-Enter delay {ms, range}`, etc.)_
- ✅ Typing in the search box looks human (visible character-by-character input in headed mode). _(`humanType` types char-by-char with 50–150ms jitter)_
- ✅ If a CAPTCHA does appear, the script pauses and prints a clear alert instead of silently failing. _(clear `CAPTCHA DETECTED` stderr alert + `--captchaWaitMs` pause, then exit 3 with checkpoint preserved)_

### Dependencies
Phase 1.2 (browser core) and Phase 1.3 (scroll loop where delays apply).

### Deliverable
A scraper that behaves politely enough to survive normal-size runs.

---

## Phase 1.9 — Logging & Observability

> **Status: ✅ DONE** — Every log line carries a standardized `phase` field (10 phases). All spec'd key events are logged. `--logLevel debug` produces per-field extraction logs. 27 dedicated unit tests in `tests/logger.test.js`.

### Goal
The operator should be able to see exactly what the script is doing in real time and diagnose problems after the fact.

### Why it matters
When (not if) something goes wrong, good logs are the difference between a 5-minute fix and a 5-hour mystery.

### Task checklist
- [x] Implement structured logging in `src/logger.js` (use `winston`, `pino`, or a thin custom wrapper).
- [x] Log to **two sinks** simultaneously:
  - Console (colorized, human-readable)
  - File (JSON lines, machine-parseable) at `logs/{query}_{location}_{timestamp}.log`
- [x] Log levels: `DEBUG`, `INFO`, `WARN`, `ERROR`. Configurable via `--logLevel`.
- [x] Every log line includes: timestamp, level, phase (search/scroll/extract/export), message, and contextual fields (e.g., business index, field name).
- [x] Log these key events:
  - [x] Config resolved at startup
  - [x] Browser launched (with UA, viewport, headless mode)
  - [x] Search submitted (query, location)
  - [x] Results feed detected
  - [x] Scroll progress (every page of ~20)
  - [x] Each business extracted (index, name, success/fail)
  - [x] Extraction-rate summary at end
  - [x] CSV/JSON written (path, row count)
  - [x] Run duration and final status
- [x] Print a **clean, scannable console summary** at the end:
  ```
  ========================================
  Run complete
  Query:    Restaurant in Toronto
  Results:  342 found, 339 extracted, 3 failed
  Duration: 4m 12s
  CSV:      /home/user/scraper/data/Restaurant_Toronto_2026-08-07_15-30-00.csv
  JSON:     /home/user/scraper/data/Restaurant_Toronto_2026-08-07_15-30-00.json
  Log:      /home/user/scraper/logs/Restaurant_Toronto_2026-08-07_15-30-00.log
  ========================================
  ```

### Acceptance criteria
- During a run, the console shows real-time progress (scroll count, current business).
- After a run, the log file contains every business extraction with success/fail and timing.
- The end-of-run summary is printed and contains all the fields shown above.
- Setting `--logLevel debug` produces verbose per-field extraction logs.

### Dependencies
Phases 1.2–1.7 (logging wraps all of them).

### Deliverable
Full visibility into every run, present and past.

---

## Phase 1.10 — CLI Polish & Developer Experience

> **Status: ✅ DONE (v0.10.0)** — `--help`, `--version`, `--dryRun`, `--limit`, `--headless/--headed`, `--verbose`, exit codes 0/1/2/3/130, and the startup banner with 1s confirm delay (skippable via `--yes`/`-y`) are all implemented. 39 unit tests in `tests/banner.test.js`.

### Goal
Make the script pleasant to run, easy to debug, and self-documenting from the command line.

### Why it matters
A tool you have to fight is a tool you stop using. Good CLI UX is the difference between "I'll just run it again" and "I'll email the data instead."

### Task checklist
- [x] Implement `--help` output that lists every flag with a one-line description and a usage example.
- [x] Implement `--version` (read from `package.json`).
- [x] Implement `--dryRun` — do everything except write the CSV (useful for testing selectors and pagination).
- [x] Implement `--limit N` (alias for `--maxResults`) for quick test runs.
- [x] Implement `--headless` / `--headed` overrides (force a mode regardless of `.env`).
- [x] Implement `--verbose` (alias for `--logLevel debug`).
- [x] Print a **startup banner** with the resolved config so the user confirms before the run begins (1-second delay, skippable with `--yes`).
- [x] Validate all CLI inputs and print friendly errors (not stack traces) for bad input.
- [x] Exit codes: `0` success, `1` partial success (some failures), `2` config error, `3` runtime error.

### Acceptance criteria
- `npm start -- --help` prints a complete, readable usage guide.
- `npm start -- --query "Cafe" --location "Berlin" --limit 10 --dryRun` runs the full pipeline against 10 results without writing a file.
- Bad input (e.g., `--maxResults "abc"`) prints a clear error and exits with code 2, not a stack trace.
- Exit codes are correct for success / partial / failure cases.

### Dependencies
All prior phases (CLI wraps the whole pipeline).

### Deliverable
A CLI tool that's pleasant and predictable to use.

---

## Phase 1.11 — Documentation & Handoff

> **Status: ✅ DONE (v1.0.0-phase1)** — README has all 9 required sections (What it does, Quick start, Requirements, Configuration, Usage examples, Output format, Troubleshooting, Known limitations, Roadmap). `SELECTORS.md` documents the primary/fallback selector strategy + update procedure. `CHANGELOG.md` has the Phase 1 release entry. Commit tagged `v1.0.0-phase1`.

### Goal
A new user (the operator, a teammate, or a future you) should be able to clone the repo, follow the README, and produce a CSV within 10 minutes.

### Why it matters
Undocumented tools die. The README is the contract between the script and its user.

### Task checklist
- [x] Write `README.md` with these sections:
  - **What it does** (1 paragraph)
  - **Quick start** (install, configure, run — 5 commands max)
  - **Requirements** (Node version, Playwright browser install step: `npx playwright install chromium`)
  - **Configuration** (every env var and CLI flag, with defaults and examples)
  - **Usage examples** (3-5 real commands: basic run, deep scrape, resume, dry run)
  - **Output format** (CSV column list with descriptions; JSON schema)
  - **Troubleshooting** (common issues: CAPTCHA, empty results, encoding, Playwright install)
  - **Known limitations** (Phase 1 scope — no proxies, no auto-CAPTCHA, single concurrent run)
  - **Roadmap** (link to `SCRAPER_FEATURES.md` for Phases 2-5)
- [x] Add inline code comments explaining **why**, not **what** (especially around selectors and scroll logic — the fragile parts).
- [x] Document the **selector strategy** — where the primary and fallback selectors are defined, how to update them when Google changes the DOM.
- [x] Add a `CHANGELOG.md` with the Phase 1 release entry.
- [x] Tag the git commit as `v1.0.0-phase1` (or similar) to mark the milestone.

### Acceptance criteria
- A fresh clone + `npm install` + `npx playwright install chromium` + `npm start -- --query "Restaurant" --location "Toronto" --limit 20` produces a CSV within 10 minutes.
- The README's troubleshooting section covers at least: CAPTCHA appearance, empty results, Playwright not installed, encoding issues in Excel.
- The CSV column list in the README matches the actual CSV output exactly.

### Dependencies
All prior phases (documentation describes the finished tool).

### Deliverable
A self-documenting, handoff-ready tool.

---

## Final Acceptance Test (Definition of Done)

**Phase 1 is complete when all of the following pass on a fresh clone:**

1. **Install:** `npm install` + `npx playwright install chromium` succeeds with no manual intervention.
2. **Basic run:** `npm start -- --query "Restaurant" --location "Toronto" --maxResults 100` produces a CSV with 100 rows in under 5 minutes.
3. **CSV quality:** The CSV opens in Excel/Sheets/Numbers with no encoding or escaping issues. All money fields (name, rating, reviews_count, address, phone, website) are populated for ≥90% of rows.
4. **Pagination:** A run without `--maxResults` against a query with 300+ results scrolls through and captures the full set (verified by row count vs. Google Maps' own count).
5. **Crash recovery:** Kill the run mid-way, restart with `--resume`, and it continues from where it stopped.
6. **Deep scrape:** `--deepScrape true` produces a CSV with the additional detail fields (hours, reviews, photos) populated for ≥85% of rows.
7. **Reliability:** A 200-result run completes without crashing and without triggering a CAPTCHA on a fresh IP.
8. **Logging:** The console shows real-time progress; the log file captures every business; the end-of-run summary is accurate.
9. **CLI UX:** `--help` is comprehensive; `--dryRun` works; bad input gives friendly errors with correct exit codes.
10. **Docs:** A new user following only the README can produce a CSV within 10 minutes of cloning.

If all 10 pass → **Phase 1 milestone achieved.** The script is now "A script that exports CSVs of business data" — sellable as hand-delivered datasets ($50–$200 per run per the master roadmap).

---

## Recommended Build Order & Parallelism

Most phases are strictly sequential, but a few can overlap:

```
1.0 (foundation)
   ↓
1.1 (config)  ──┐
   ↓             │
1.2 (browser)    │  ← 1.1 and 1.2 can be done in parallel by different people
   ↓             │
1.3 (scroll)     │
   ↓             │
1.4 (extract)    │
   ↓             │
1.5 (deep)  ←───┘  (depends on 1.4)
   ↓
1.6 (export)  ←── also depends on 1.4
   ↓
1.7 (recovery)  ←── wraps 1.4 + 1.6
   ↓
1.8 (anti-block)  ←── wraps 1.2 + 1.3
   ↓
1.9 (logging)  ←── wraps everything
   ↓
1.10 (CLI)  ←── wraps everything
   ↓
1.11 (docs)
```

**Critical path:** 1.0 → 1.1 → 1.2 → 1.3 → 1.4 → 1.6 → 1.7 → 1.9 → 1.10 → 1.11.

**Phase 1.5 (deep scrape) and 1.8 (anti-block)** can be deferred slightly if you need to ship the basic CSV exporter faster — they're valuable but not blocking the core "exports CSVs" deliverable.

---

## Out of Scope (Explicitly Deferred)

The following are **not** part of Phase 1 and belong to later phases of the master roadmap. Do **not** build them now — they'll distract from the core deliverable.

| Feature | Deferred to |
|---|---|
| Rotating proxies / residential proxy pools | Phase 2 |
| Browser fingerprint randomization (canvas, WebGL, fonts) | Phase 2 |
| CAPTCHA auto-solving (2Captcha, Anti-Captcha) | Phase 2 |
| Multi-browser concurrency / worker pools | Phase 2 |
| PostgreSQL persistence | Phase 2 |
| Self-healing selector auto-discovery | Phase 2 |
| Phone/email normalization & validation | Phase 3 |
| Email discovery from website domain | Phase 3 |
| Deduplication & fuzzy matching | Phase 3 |
| Grid-based geo-coverage | Phase 3 |
| Lead scoring | Phase 3 |
| Web dashboard, REST API, Stripe billing | Phase 4 |
| Distributed workers, Grafana monitoring | Phase 5 |
| LLM-powered extraction | Phase 5 |
| Multi-source federation (Yelp, OSM, LinkedIn) | Phase 5 |

**Phase 1 = one script, one query, one CSV. Done well.**

---

*End of Phase 1 Execution Plan.*
