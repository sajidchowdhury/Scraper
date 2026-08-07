# gmaps-scraper

Google Maps business scraper — **Phase 1**: search → paginate → extract → (deep scrape) → CSV export, with crash recovery, anti-block, structured logging, and CLI polish.

> Implements sub-phases 1.0 through 1.11 of `PHASE1_EXECUTION_PLAN.md` — the full Phase 1 milestone.
> The script survives transient failures (retry with backoff), resumes from checkpoints after a crash,
> isolates per-business errors so one bad record never crashes the run, throttles itself to avoid
> blocks, and emits a JSON-lines log per run for post-hoc analysis.

- **[CHANGELOG.md](CHANGELOG.md)** — release history for the Phase 1 milestone (`v1.0.0-phase1`).
- **[SELECTORS.md](SELECTORS.md)** — where the primary/fallback CSS selectors live, and how to update them when Google changes the DOM.
- **[PHASE1_EXECUTION_PLAN.md](PHASE1_EXECUTION_PLAN.md)** — granular per-sub-phase spec, acceptance criteria, and status.
- **[SCRAPER_FEATURES.md](SCRAPER_FEATURES.md)** — master roadmap (Phases 2–5: proxies, auto-CAPTCHA, concurrency, …).

## Quick start

```bash
# 1. Clone + install dependencies
npm install
npx playwright install chromium

# 2. Configure (optional — CLI flags override everything)
cp .env.example .env   # then edit DEFAULT_QUERY / DEFAULT_LOCATION

# 3. Run (list-view fields only — fast)
npm start -- --query "Restaurant" --location "Toronto" --maxResults 50

# 4. Run with detail-page deep scrape (slower, ~2-4s/business, richer data)
npm start -- --query "Cafe" --location "Berlin" --deepScrape true --maxResults 20

# 5. QA mode — deep-scrape every 5th business for a fast smoke test
npm start -- --query "Cafe" --location "Berlin" --deepScrape true --deepScrapeSampleStep 5
```

Output is written to `data/{query}_{location}_{timestamp}.*`:
- `.csv` — UTF-8-with-BOM, Excel-safe, 25-column stable schema
- `.json` — full nested data (arrays/objects preserved)
- `.summary.json` — run metadata (query, location, totals, extraction rates, timing, output paths)

## CLI

```
Required:
  --query, -q <string>      What to search (e.g. "Restaurant")
  --location, -l <string>   Where to search (e.g. "Toronto")

Optional:
  --maxResults, --limit <n>  Cap result count (default: all available)
  --outputFile, -o <path>    Output path (default: auto-generated)
  --outputDir <path>         Output directory (default: ./data)
  --headless / --headed      Force browser mode (default: headless)
  --logLevel <level>         debug | info | warn | error (default: info)
  --verbose                  Alias for --logLevel debug
  --dryRun                   Smoke test: run pipeline but write NO output files
  --yes, -y                  Phase 1.10 — skip the 1s startup-banner delay (CI)
  --deepScrape true|false    Phase 1.5 — open each detail panel to fetch
                             hours, popular times, reviews, photos, links
  --deepScrapeSampleStep <n> Scrape every Nth business (1 = all, 5 = QA mode)
  --noDeepScrape             Force --deepScrape false (overrides .env)
  --resume / --fresh         Phase 1.7 — resume from / ignore .checkpoint.json
  --checkpointInterval <n>   Phase 1.7 — write checkpoint every N records (10)
  --maxRetries <n>           Phase 1.7 — retry attempts for transient ops (3)
  --retryBaseMs <ms>         Phase 1.7 — base backoff, doubles each retry (1000)
  --maxRPM <n>               Phase 1.8 — max Google requests per minute (30)
  --noHumanTyping            Phase 1.8 — disable char-by-char search typing
  --noCaptchaPause           Phase 1.8 — don't pause on CAPTCHA (just exit)
  --captchaWaitMs <ms>       Phase 1.8 — CAPTCHA pause duration (300000)
  --version                  Print version and exit
  --help, -h                 Show this help
```

## Project structure

```
scraper/
├── src/
│   ├── index.js     (CLI entry; pipeline orchestration + checkpoint)
│   ├── browser.js   (Playwright launch/teardown, withBrowser helper)
│   ├── search.js    (Maps navigation + search submit, retry-wrapped)
│   ├── scroll.js    (Phase 1.3 — infinite-scroll pagination w/ stall detection)
│   ├── extract.js   (Phase 1.4 — core field extraction, 17-field schema, per-record isolation)
│   ├── detail.js    (Phase 1.5 — detail-page deep scrape, 8 detail fields, retry-wrapped)
│   ├── export.js    (Phase 1.6 — CSV + JSON + summary export, RFC 4180 + BOM)
│   ├── retry.js     (Phase 1.7 — withRetry: exponential backoff for transient ops)
│   ├── checkpoint.js (Phase 1.7 — crash-recovery checkpoint: read/write/clear/resume)
│   ├── antiblock.js  (Phase 1.8 — rate limiter, human typing, CAPTCHA detection, UA rotation)
│   ├── banner.js    (Phase 1.10 — startup banner + 1s confirm delay, --yes to skip)
│   ├── config.js    (env + CLI config loader, validation)
│   └── logger.js    (dual-sink logger: console + JSON-lines file)
├── tests/
│   ├── extract.test.js    (Phase 1.4 unit tests — parsers, normalization, rates)
│   ├── detail.test.js     (Phase 1.5 unit tests — parsers, DI failure isolation, e2e)
│   ├── export.test.js     (Phase 1.6 unit tests — RFC 4180, BOM, multi-value, e2e)
│   ├── retry.test.js      (Phase 1.7 unit tests — backoff, retryIf, edge cases)
│   ├── checkpoint.test.js (Phase 1.7 unit tests — dedup, resume, corrupt handling)
│   ├── config.test.js     (Phase 1.7 config tests — new flags + validation)
│   ├── antiblock.test.js  (Phase 1.8 unit tests — rate limiter, human typing, CAPTCHA)
│   ├── logger.test.js     (Phase 1.9 unit tests — phase binding, sinks, memory buffer)
│   └── banner.test.js     (Phase 1.10 unit tests — startup banner, --yes, delay skip)
├── data/            (output CSV/JSON + .checkpoint.json, gitignored)
├── logs/            (run logs, gitignored)
├── .env.example
└── package.json
```

## Phase 1.4 — Core Field Extraction

Each extracted business record has these **15 canonical fields**:

| Field | Type | Source | Notes |
|---|---|---|---|
| `name` | string | List card | Business name |
| `rating` | float | List card | 0–5, `null` if absent |
| `reviews_count` | int | List card | Commas/parens stripped, `null` if absent |
| `price_level` | string | List card | `$` / `$$` / `$$$` / `$$$$`, `null` if absent |
| `category` | string | List card | e.g. "Mexican restaurant" |
| `address` | string | List card | Full address string |
| `phone` | string | List card | Raw tel: string (full normalization is Phase 3) |
| `website` | string | List card | Tracking params (utm_*, gclid, fbclid) stripped |
| `maps_url` | string | Constructed | Absolute Google Maps place URL |
| `place_id` | string | Parsed from URL | `0x…:0x…` CID or `ChIJ…` place_id |
| `plus_code` | string | List card | Open-location code, `null` if absent |
| `open_now` | bool | List card | `true`/`false`/`null` at time of scrape |
| `business_status` | enum | List card | `open` / `temporarily_closed` / `permanently_closed` |
| `is_sponsored` | bool | List card | `true` for ad/sponsored results |
| `scraped_at` | ISO string | Generated | Scrape timestamp |
| `query` | string | From config | What was searched |
| `location` | string | From config | Where it was searched |

### Extraction resilience

- **Multiple fallback selectors per field** — Google reshuffles the DOM often;
  each field has 2–4 candidate selectors tried in order.
- **Per-field extraction-rate log** — printed at end of every run, e.g.
  `phone: 198/200 = 99%`. Fields below 80% trigger a `WARN`.
- **Normalization** — `rating` → float, `reviews_count` → int, `website` →
  tracking-stripped, `phone` → raw, `place_id`/`plus_code` → parsed.
- **Closed businesses are not skipped** — flagged via `business_status`.
- **Sponsored results are flagged** — `is_sponsored: true`.

## Phase 1.5 — Detail-Page Deep Scrape (Optional)

When `--deepScrape true` is passed, the script clicks into each business's
detail panel after the list-view extraction to fetch additional fields not
visible in the list. This is **off by default** to keep runs fast.

Each detail-scraped business gets these **8 additional fields**:

| Field | Type | Source | Notes |
|---|---|---|---|
| `full_hours` | array\[{day,hours}\] | Detail panel | Per-day opening hours; `null` if absent |
| `popular_times` | array\[{day,busy}\] | Detail panel | Busyness histogram per day; `null` if absent (noisy) |
| `top_reviews` | array\[{author,rating,text,date}\] | Detail panel | Top N reviews (configurable, default 5) |
| `photos` | array\[url\] | Detail panel | First N photo URLs (configurable, default 5) |
| `reservation_url` | string | Detail panel | OpenTable/Resy/etc. link; `null` if absent |
| `menu_url` | string | Detail panel | Menu link; `null` if absent |
| `social_profiles` | array\[{platform,url}\] | Detail panel | Instagram/Facebook/X/LinkedIn/YouTube + website |
| `detail_scraped` | bool | Generated | `true` if detail load succeeded, `false` otherwise |

### Deep-scrape resilience

- **Per-business failure isolation** — a failed detail load (timeout, missing
  panel, selector crash) logs a warning and continues; that business keeps its
  list-view fields with `null`/empty detail fields. One bad business never
  crashes the run.
- **Always returns to list** — the `backFn` runs in a `finally` block, so a
  stranded detail panel on business N doesn't strand business N+1.
- **Randomized per-detail delay** (1–3s default) — avoids a metronomic request
  pattern that triggers anti-bot defenses.
- **Hard per-business timeout** (15s default) — a hanging detail page can't
  stall the whole run.
- **Success-rate tracking** — `attempted`, `succeeded`, `failed`, `successRate`,
  `avgMs`/`minMs`/`maxMs` per business, and an error tally. Logged at the end
  of every deep-scrape phase; warns when success rate < 80%.
- **Sample step** — `--deepScrapeSampleStep 5` scrapes every 5th business for
  fast QA smoke-tests against large result sets.
- **Stable output schema** — when `--deepScrape false` (default), every record
  is stamped with empty detail fields so the JSON/CSV shape is identical
  whether or not detail scraping ran (Phase 1.6 CSV column order won't shift).

## Phase 1.6 — CSV / JSON Export Engine

Every run writes **three files** sharing a common base name
(`data/{query}_{location}_{timestamp}.*`):

| File | Purpose |
|---|---|
| `.csv` | UTF-8-with-BOM, RFC 4180 escaping, 25-column stable schema. Opens cleanly in Excel/Sheets/Numbers. |
| `.json` | Full nested data (businesses + summary). Arrays/objects preserved (unlike CSV, which flattens). |
| `.summary.json` | Run metadata only: query, location, totals, per-field extraction rates, deep-scrape stats, timing, output file paths, column order. |

### CSV column order (25 columns)

The 17 canonical list-view fields (Phase 1.4) followed by the 8 detail fields
(Phase 1.5), in a fixed order so downstream pipelines don't break when fields
are added:

```
Name, Rating, Reviews Count, Price Level, Category, Address, Phone, Website,
Maps URL, Place ID, Plus Code, Open Now, Business Status, Sponsored,
Scraped At, Query, Location, Full Hours, Popular Times, Top Reviews, Photos,
Reservation URL, Menu URL, Social Profiles, Detail Scraped
```

### RFC 4180 escaping

- Field with **comma** → wrapped in double quotes: `"Smith, Jones & Co."`
- Field with **double-quote** → doubled and wrapped: `"say ""hi"""`
- Field with **newline** → wrapped in double quotes
- **UTF-8 with BOM** (`\uFEFF`) so Excel opens non-Latin text (Bengali, Arabic,
  emoji) without garbling — e.g. `Café Mününchen ☕`, `ঢাকা Restaurant`
- **CRLF line endings** (RFC 4180 standard)

### Multi-value field serialization

Nested detail fields are flattened to single CSV cells with documented delimiters:

| Field | Format | Example |
|---|---|---|
| `photos` | URLs joined with `\|` | `https://a.jpg\|https://b.jpg\|https://c.jpg` |
| `social_profiles` | `platform:url` joined with `\|` | `instagram:https://ig.com/x\|facebook:https://fb.com/y` |
| `full_hours` | `day: hours` joined with `; ` | `Monday: 9-5; Tuesday: 9-5; Wednesday: Closed` |
| `top_reviews` | JSON string (too structured for delimited) | `[{"author":"Jane","rating":5,...}]` |
| `popular_times` | JSON string (too structured for delimited) | `[{"day":"Monday","busy":[...]}]` |

The JSON sidecar preserves the full nested structure (arrays of objects) for
clients that need it; the CSV is for spreadsheet consumers.

### Hand-rolled (no csv-writer dependency)

The CSV writer is hand-rolled (~120 lines) to match the project's no-deps
philosophy (see `src/config.js`, `src/logger.js`) and to give full control over
BOM, nested-field serialization, and encoding. It's fully unit-tested against
the spec's exact acceptance criteria.

## Testing

```bash
npm test          # bun test tests/ (358 tests, 911 assertions)
npm run syntax    # node --check on every src file
```

Test coverage by phase: extract (67), detail (55), export (69), checkpoint
(37), retry (12), antiblock (91), config (Phase 1.8 flags), **logger (27 —
Phase 1.9)**.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (all businesses extracted/scraped cleanly) |
| 1 | Partial success (run completed but some businesses failed extraction or detail scrape) |
| 2 | Config error (missing/invalid args) |
| 3 | Runtime error (browser crash, selector failure, timeout) |
| 130 | SIGINT (Ctrl-C) — checkpoint preserved for `--resume` |

## Phase 1.7 — Reliability & Crash Recovery

The scraper survives transient failures and resumes from where it left off after
a crash. Three mechanisms work together:

### 1. Retry with exponential backoff

All transient operations (`page.goto`, `waitForSelector`, `page.evaluate`,
detail-panel open/back) are wrapped in `withRetry()`:

- **3 attempts** (configurable via `--maxRetries`)
- **Exponential backoff**: 1s → 2s → 4s (base via `--retryBaseMs`)
- On final failure, the error is re-thrown — the caller logs and skips the
  business (or exits 3 for systemic failures)
- Optional `retryIf` predicate: callers can exclude non-transient errors from
  wasting retry budget

```bash
npm start -- --query "Cafe" --location "Berlin" --maxRetries 5 --retryBaseMs 500
```

### 2. Checkpoint-based crash recovery

During the slow deep-scrape phase, a `.checkpoint.json` file is written to the
output directory every N businesses (default 10, via `--checkpointInterval`).
On the next run, if the checkpoint exists for the same query+location:

- With `--resume`: automatically loads the checkpoint and skips already-
  extracted businesses (deduped by `place_id` or name+address+phone hash)
- Without `--resume` (interactive TTY): prompts `Resume from checkpoint? [y/N]`
- With `--fresh`: ignores and deletes the checkpoint, starts from scratch

On successful completion, the checkpoint is **cleared automatically** — a
leftover checkpoint would cause a stale prompt on the next run. On crash
(Ctrl-C or runtime error), the checkpoint stays on disk for `--resume`.

```bash
# A 500-result run dies at result 200:
npm start -- --query "Restaurant" --location "Toronto" --deepScrape true
# Ctrl-C at result 200

# Resume — continues from ~200, doesn't restart:
npm start -- --query "Restaurant" --location "Toronto" --deepScrape true --resume
```

Already-deep-scraped businesses (with `detail_scraped: true`) are skipped on
resume — only the unfinished ones get re-scraped.

### 3. Per-business error isolation

A failed extraction or detail-scrape is **logged and counted**, never crashes
the run. The run summary tracks:

- **Total found** (from scroll)
- **Successfully extracted** (list-view fields)
- **Failed extraction** (with per-record error reasons)
- **Skipped** (already in checkpoint on resume)
- **Deep-scrape succeeded/failed** (with error breakdown)

The exit code reflects the outcome: `0` = all clean, `1` = partial success
(some failures but run completed), `3` = systemic crash.

## Phase 1.8 — Minimal Anti-Block Behavior

The scraper behaves politely enough to survive normal-size runs without
triggering CAPTCHAs or rate limits. Full anti-detection (proxies,
fingerprinting, CAPTCHA solving) is Phase 2 — here we just practice basic good
citizenship. All tactics live in `src/antiblock.js`.

### 1. Randomized human-like delays

Fixed/metronomic delays are replaced with randomized ranges (visible in debug
logs as `Inter-scroll delay`, `Pre-Enter delay`, etc.):

| Action                     | Range (ms)   | Config env vars                  |
|----------------------------|--------------|----------------------------------|
| Between scroll actions     | 800–2000    | `SCROLL_DELAY_MIN/MAX_MS`        |
| Before pressing Enter      | 500–1500    | `PRE_ENTER_DELAY_MIN/MAX_MS`     |
| Between detail-page visits | 1500–3500   | `DETAIL_DELAY_MIN/MAX_MS`        |
| Per keypress (typing)      | 50–150      | `TYPE_KEY_MIN/MAX_MS`            |

### 2. Human-like typing

The search query is typed character-by-character with 50–150ms jitter per key
instead of Playwright's instant `.fill()`. Visible in `--headed` mode as real
typing. Disable with `--noHumanTyping`.

### 3. Max requests per minute cap

A sliding-window `RateLimiter` (default **30 req/min**) gates every
Google-bound HTTP request (`page.goto` in search + each detail-panel open in
deep-scrape). If the script is going faster than the cap, it waits. Override
with `--maxRPM <n>`.

### 4. CAPTCHA / "unusual traffic" detection

After the search feed appears and after every detail scrape, the page body is
scanned for known block indicators (`unusual traffic`, `captcha`, `recaptcha`,
`not a robot`, etc.). On detection the script:

1. Prints a clear `CAPTCHA DETECTED` alert to stderr
2. Pauses for `--captchaWaitMs` (default 5 min) so the operator can solve it
   in `--headed` mode
3. Aborts with exit code 3 — the checkpoint is preserved for `--resume`

Disable the pause with `--noCaptchaPause` (still exits 3). Auto-solve is
Phase 2.

### 5. HTTP 429 / 503 detection

A `page.on('response')` watcher fires on Google 429 / 503 responses, logging
a warning with the status + URL. These combine with the rate limiter and
Phase 1.7 retry/backoff to handle transient throttling.

### 6. User-agent rotation

A user-agent is picked at random per run from a list of 8 recent real desktop
Chrome UAs (Windows / macOS / Linux) so each run looks like a different
machine.

```bash
# Polite default run (30 RPM, human typing, CAPTCHA pause on):
npm start -- --query "Cafe" --location "Berlin" --maxResults 200

# Aggressive QA mode (faster, still anti-block basics):
npm start -- --query "Cafe" --location "Berlin" --maxRPM 60 --noHumanTyping

# Headed run so you can solve a CAPTCHA manually if one appears:
npm start -- --query "Cafe" --location "Berlin" --headed --captchaWaitMs 600000
```

## Phase 1.9 — Logging & Observability

Every log line — console and file — carries a structured `phase` tag so an
operator can filter the JSON-lines log file by pipeline stage after the fact.

### Phases

| Phase | Where it's emitted |
|---|---|
| `system` | Config resolved, run complete, global timeout, SIGINT |
| `browser` | Browser launched (UA, viewport, headless mode) |
| `search` | Navigating to Maps, search submitted, results feed detected |
| `scroll` | Scroll loop start/progress/stop (with page number) |
| `extract` | Each business extracted (index, name, success/fail), per-field debug, rate summary |
| `detail` | Deep-scrape start/progress/complete, each detail outcome with timing |
| `export` | CSV/JSON/summary written (path, rows, bytes) |
| `recovery` | Checkpoint resume decisions |
| `antiblock` | Rate-limit pauses, 429/503 detection |
| `retry` | Transient-operation retry warnings |

### Console output

The console shows a dim `[phase]` tag on every line for scannability:

```
[2026-08-07T15:30:00.000Z] INFO  [system] Config resolved
[2026-08-07T15:30:01.234Z] INFO  [browser] Browser launched
[2026-08-07T15:30:02.456Z] INFO  [search] Search submitted
[2026-08-07T15:30:03.789Z] INFO  [scroll] Scroll progress
[2026-08-07T15:30:04.012Z] INFO  [extract] Business extracted
```

### Log file (JSON lines)

Every run writes `logs/{query}_{location}_{timestamp}.log`. Each line is a JSON
object with `ts`, `level`, `phase`, `msg`, and any context fields:

```json
{"ts":"2026-08-07T15:30:04.012Z","level":"info","phase":"extract","msg":"Business extracted","index":5,"name":"Joe's Diner","success":true,"sponsored":false,"status":"open"}
```

Filter by phase after a run:

```bash
jq 'select(.phase=="extract")' logs/Restaurant_Toronto_*.log | head
jq 'select(.level=="warn" or .level=="error")' logs/Restaurant_Toronto_*.log
```

### `--logLevel debug`

At debug level, every business emits a per-field breakdown so a missing
selector is obvious:

```
[extract] Normalized fields  index=5 name="Joe's Diner" fields={name:"Joe's Diner",rating:4.5,reviews_count:128,...,phone:null,...}
```

### End-of-run summary

The console banner now includes the log file path:

```
========================================
Run complete
Query:    Restaurant in Toronto
Results:  342 extracted (342 loaded, reason=endOfList)
Duration: 252.4s
Detail:   disabled (--deepScrape false)
CSV:      /home/z/Scraper/data/Restaurant_Toronto_2026-08-07_15-30-00.csv
JSON:     /home/z/Scraper/data/Restaurant_Toronto_2026-08-07_15-30-00.json
Summary:  /home/z/Scraper/data/Restaurant_Toronto_2026-08-07_15-30-00.summary.json
Log:      /home/z/Scraper/logs/Restaurant_Toronto_2026-08-07_15-30-00.log
========================================
```

A structured `Run complete` log line (phase: system) is also written to the
log file with duration, counts, and exit code for machine-parseable post-run
analysis.

## Phase 1.10 — CLI Polish & Developer Experience

A tool you have to fight is a tool you stop using. Phase 1.10 makes the
script pleasant to run, easy to debug, and self-documenting from the command
line.

### Startup banner

Before any browser is launched, the script prints a compact snapshot of the
**resolved** configuration so the operator gets one last chance to eyeball
"what am I about to run?" and `Ctrl-C` if something looks wrong (wrong city,
`--dryRun` off by accident, `--deepScrape` unexpectedly on, etc.):

```
========================================
gmaps-scraper v0.10.0
----------------------------------------
  Query             Cafe
  Location          Berlin
  Max results       50
  Output dir        ./data
  Output file       (auto)
  Dry run           no
  Headless          yes
  Log level         info
  Deep scrape       no
  Resume            no
  Fresh             no
  Checkpoint every  10 records
  Retry             3× (base 1000ms)
  Max RPM           30
  Human typing      yes
  CAPTCHA pause     yes (300000ms)
----------------------------------------
Starting in 1.0s — Ctrl-C to abort, --yes to skip.
========================================
```

The banner is followed by a **1-second delay** (so a human can react). The
delay is skippable with `--yes` (alias `-y`) for scripted / CI runs — the
banner still prints, but the run starts immediately:

```
  ...
  Starting immediately (--yes).
  ...
```

### CLI surface (Phase 1.10 checklist)

| Feature | Status |
|---|---|
| `--help` with every flag + usage example | ✅ |
| `--version` (reads `package.json`) | ✅ |
| `--dryRun` (full pipeline, no file writes) | ✅ |
| `--limit N` (alias for `--maxResults`) | ✅ |
| `--headless` / `--headed` overrides | ✅ |
| `--verbose` (alias for `--logLevel debug`) | ✅ |
| Startup banner + 1s confirm delay | ✅ |
| `--yes` / `-y` to skip the banner delay | ✅ |
| Friendly config errors (no stack traces) | ✅ |
| Exit codes 0 / 1 / 2 / 3 / 130 | ✅ |

## Troubleshooting

### Google shows a CAPTCHA / "Our systems have detected unusual traffic"

Google flags automated traffic. The scraper detects this (Phase 1.8) and
**pauses** for `CAPTCHA_WAIT_MS` (default 5 min) so you can solve it in a
`--headed` window, then aborts with exit code `3` — **leaving the checkpoint
on disk** so you can continue.

```bash
# 1. Rerun headed so you can see / solve the CAPTCHA
npm start -- --query "Restaurant" --location "Toronto" --headed --resume

# 2. If it keeps happening, lower the request rate
npm start -- --maxRPM 15 --query "Restaurant" --location "Toronto" --resume

# 3. Wait it out — blocks usually clear in a few hours. Then:
npm start -- --query "Restaurant" --location "Toronto" --resume
```

Prevention: keep `--maxRPM` at or below 30 (the default), leave human typing
on (the default), and avoid re-running the same query/location back-to-back.
Auto-solving CAPTCHAs is explicitly **Phase 2** scope (see `SCRAPER_FEATURES.md`).

### No results / "Results feed detected" never logs

- **Wrong query spelling or location granularity.** Try a broader location
  (e.g. `Toronto` instead of `Downtown Toronto ON`).
- **Google rendered the page in a non-English locale.** The scraper forces
  `hl=en` on the Maps URL, but if you're behind a regional redirect, add the
  country to the location: `"Dhaka, Bangladesh"`.
- **The results feed selector changed.** Check `SELECTORS.md` for how to
  inspect the live DOM and update the feed-detection selector.
- Run with `--verbose` (alias `--logLevel debug`) to see every scroll step
  and the raw result count.

### `Error: Executable doesn't exist at .../chromium-*/chrome` (Playwright not installed)

Playwright's npm package is JS-only; the browser binaries are a separate
download. Install them once after `npm install`:

```bash
npx playwright install chromium
```

If you're on a fresh OS image you may also need system deps:

```bash
npx playwright install-deps chromium   # Linux (apt)
```

### CSV opens in Excel with garbled non-Latin text (Bengali, Arabic, emoji)

The CSV is written **UTF-8 with BOM** (`\uFEFF`) and **CRLF** line endings
(RFC 4180) specifically so Excel auto-detects the encoding. If you still see
garbling:

- **You opened it as plain text first.** Open the `.csv` directly from
  Excel's *File → Open* (don't paste it in).
- **Excel's default import codec is wrong.** Use *Data → From Text/CSV* and
  pick `65001: Unicode (UTF-8)`.
- **You re-saved it from a text editor** that stripped the BOM. Re-export
  from the `.json` sidecar, or rerun the scraper.

### Encoding issues in the JSON sidecar

The `.json` file is UTF-8 (no BOM — JSON spec forbids it). Any modern parser
(Node, Python `json`, `jq`) handles it natively. If your tool shows `\uXXXX`
escapes, that's normal JSON Unicode escaping — the data is correct.

### The run finished but there's no CSV in `data/`

You almost certainly ran with `--dryRun`. That flag runs the **entire** pipeline
(launch browser → search → scroll → extract) but **writes no files** — it only
logs where it *would* have written them. Check the end of your log; you'll see:

```json
{"msg":"Dry run — skipping file output","wouldWrite":"data\\dryrun"}
{"msg":"Run complete", ... "csv":null, "json":null}
```

Re-run **without** `--dryRun` to actually produce the CSV:

```bash
npm start -- --query "Cafe" --location "Berlin" --maxResults 10
```

### Extraction rates show `phone`, `website`, `plus_code`, `price_level` at 0%

This is **expected** on modern Google Maps list-view cards — Google removed
those fields from the compact list layout. They live on the **detail panel**
now, so enable deep scrape to populate them:

```bash
npm start -- --query "Cafe" --location "Berlin" --deepScrape true
```

The extraction-rate reporter surfaces this as a `WARN (<80%)` line by
design — it's an early-warning signal, not a bug.

### The run crashed partway — how do I continue?

A `.checkpoint_{query}_{location}.json` file is left in `data/`. Just rerun
with `--resume`:

```bash
npm start -- --query "Restaurant" --location "Toronto" --resume
```

The scraper reloads the already-extracted businesses, re-searches +
re-scrolls (a live browser session can't be restored, only the data), and
**skips businesses already in the checkpoint** by `place_id` (or a
name+address+phone hash as fallback). To start completely fresh instead:

```bash
npm start -- --query "Restaurant" --location "Toronto" --fresh
```

### Exit code reference

| Code | Meaning |
|---|---|
| `0` | Success — all businesses extracted cleanly |
| `1` | Partial success — run completed but some businesses failed (see logs) |
| `2` | Config error — bad CLI input (e.g. `--maxResults abc`) |
| `3` | Runtime error — crash or CAPTCHA abort (checkpoint preserved for `--resume`) |
| `130` | `Ctrl-C` / `SIGINT` (checkpoint preserved) |

## Known limitations (Phase 1 scope)

These are **deliberately deferred** to later phases (see `SCRAPER_FEATURES.md`):

- **No proxy / IP rotation.** All requests come from one IP. Sustained runs
  against the same query/location will eventually trip a CAPTCHA. Phase 2
  adds a proxy pool.
- **No auto-CAPTCHA solving.** On detection the scraper pauses (so you can
  solve it in a `--headed` window) then aborts with the checkpoint
  preserved. Auto-solve is Phase 2.
- **Single concurrent run.** One browser, one query, sequential extraction.
  Parallelism (multiple workers / queries) is Phase 3.
- **List-view field gaps.** `phone`, `website`, `plus_code`, and
  `price_level` are absent from modern list-view cards — populate them with
  `--deepScrape true` (Phase 1.5), which opens each detail panel
  (~2–4 s/business).
- **Selectors are DOM-coupled.** Google reshuffles the Maps DOM frequently.
  When a field's extraction rate drops, see `SELECTORS.md` for how to
  inspect the live DOM and add/update a fallback selector. There is no
  machine-learning fallback in Phase 1.
- **No incremental / scheduled runs.** Each run is a fresh search + scroll.
  Delta detection ("what changed since last week?") is Phase 4.
- **`commonjs`, not ESM.** The codebase uses `require()`/`module.exports`
  for Node 20 compatibility with zero build step. ESM migration is Phase 5
  housekeeping.
- **No GUI.** CLI only. A web dashboard is Phase 5.

## Roadmap

Phase 1 (this release — `v1.0.0-phase1`) delivers a **single-query,
single-machine, CSV-exporting** scraper that's robust against transient
failures and polite to Google. The master roadmap in
**[`SCRAPER_FEATURES.md`](SCRAPER_FEATURES.md)** covers Phases 2–5:

- **Phase 2 — Anti-Block Hardening:** proxy pool, auto-CAPTCHA solver,
  residential-IP rotation, fingerprint randomization.
- **Phase 3 — Scale:** multi-worker concurrency, queue-based scheduling,
  distributed checkpoints (SQLite/Postgres instead of `.checkpoint.json`).
- **Phase 4 — Data Quality & Analytics:** delta detection, schema
  validation, deduplication across runs, a small analytics dashboard.
- **Phase 5 — Polish:** ESM migration, web UI, plugin system, packaging as
  a CLI (`npx gmaps-scraper`), Docker image.

See `PHASE1_EXECUTION_PLAN.md` for the granular Phase 1 sub-phase spec and
acceptance criteria, and `CHANGELOG.md` for what shipped in this release.

