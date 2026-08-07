# gmaps-scraper

Google Maps business scraper — **Phase 1**: search → paginate → extract → (deep scrape) → CSV export, with crash recovery.

> Implements sub-phases 1.0 through 1.7 of `PHASE1_EXECUTION_PLAN.md`. The script survives
> transient failures (retry with backoff), resumes from checkpoints after a crash, and
> isolates per-business errors so one bad record never crashes the run.

## Quick start

```bash
# 1. Install (Playwright is symlinked from the global install — no npm install needed
#    in this sandbox; in a fresh checkout run `npm install playwright`.)
cp .env.example .env

# 2. Run (list-view fields only — fast)
npm start -- --query "Restaurant" --location "Toronto" --maxResults 50

# 3. Run with detail-page deep scrape (slower, ~2-4s/business, richer data)
npm start -- --query "Cafe" --location "Berlin" --deepScrape true --maxResults 20

# 4. QA mode — deep-scrape every 5th business for a fast smoke test
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
  --dryRun                   Run pipeline but skip writing output files
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
│   ├── config.js    (env + CLI config loader, validation)
│   └── logger.js    (dual-sink logger: console + JSON-lines file)
├── tests/
│   ├── extract.test.js    (Phase 1.4 unit tests — parsers, normalization, rates)
│   ├── detail.test.js     (Phase 1.5 unit tests — parsers, DI failure isolation, e2e)
│   ├── export.test.js     (Phase 1.6 unit tests — RFC 4180, BOM, multi-value, e2e)
│   ├── retry.test.js      (Phase 1.7 unit tests — backoff, retryIf, edge cases)
│   ├── checkpoint.test.js (Phase 1.7 unit tests — dedup, resume, corrupt handling)
│   ├── config.test.js     (Phase 1.7 config tests — new flags + validation)
│   └── antiblock.test.js  (Phase 1.8 unit tests — rate limiter, human typing, CAPTCHA)
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
npm test          # bun test tests/ (276 tests, 675 assertions)
npm run syntax    # node --check on every src file
```

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
