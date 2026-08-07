# gmaps-scraper

Google Maps business scraper — **Phase 1**: search → paginate → extract → export.

> Implements sub-phases 1.0 through 1.4 of `PHASE1_EXECUTION_PLAN.md`.

## Quick start

```bash
# 1. Install (Playwright is symlinked from the global install — no npm install needed
#    in this sandbox; in a fresh checkout run `npm install playwright`.)
cp .env.example .env

# 2. Run
npm start -- --query "Restaurant" --location "Toronto" --maxResults 50
# or headed for debugging:
npm start -- --query "Cafe" --location "Berlin" --headed --verbose
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
│   ├── config.js    (env + CLI config loader, validation)
│   └── logger.js    (dual-sink logger: console + JSON-lines file)
├── tests/
│   └── extract.test.js   (Phase 1.4 unit tests — parsers, normalization, rates)
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
