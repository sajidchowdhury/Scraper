# gmaps-scraper

Google Maps business scraper — **Phase 1**: search → paginate → extract → (deep scrape) → export.

> Implements sub-phases 1.0 through 1.5 of `PHASE1_EXECUTION_PLAN.md`.

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

Output JSON is written to `data/{query}_{location}_{timestamp}.json` and includes
a run summary plus the full extracted business list.

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
  --version                  Print version and exit
  --help, -h                 Show this help
```

## Project structure

```
scraper/
├── src/
│   ├── index.js     (CLI entry; pipeline orchestration)
│   ├── browser.js   (Playwright launch/teardown, withBrowser helper)
│   ├── search.js    (Maps navigation + search submit)
│   ├── scroll.js    (Phase 1.3 — infinite-scroll pagination w/ stall detection)
│   ├── extract.js   (Phase 1.4 — core field extraction, 15-field schema)
│   ├── detail.js    (Phase 1.5 — detail-page deep scrape, 8 detail fields)
│   ├── config.js    (env + CLI config loader, validation)
│   └── logger.js    (dual-sink logger: console + JSON-lines file)
├── tests/
│   ├── extract.test.js   (Phase 1.4 unit tests — parsers, normalization, rates)
│   └── detail.test.js    (Phase 1.5 unit tests — parsers, DI failure isolation, e2e)
├── data/            (output JSON, gitignored)
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

## Testing

```bash
npm test          # bun test tests/
npm run syntax    # node --check on every src file
```

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 2 | Config error (missing/invalid args) |
| 3 | Runtime error (browser crash, selector failure, timeout) |
