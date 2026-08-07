# Google Maps Scraper

A Node.js scraper that extracts business data from Google Maps and exports it to CSV.

## Current status: Phase 1.1 — Configurable Search Input

The project is structured into clean modules and the search target (query,
location, max results, output file) is fully configurable via CLI flags or
environment variables. Pagination, field extraction, and CSV export are
implemented in subsequent phases.

- Full roadmap (Phases 1–5): see [`SCRAPER_FEATURES.md`](./SCRAPER_FEATURES.md)
- Phase 1 step-by-step plan: see [`PHASE1_EXECUTION_PLAN.md`](./PHASE1_EXECUTION_PLAN.md)

## Requirements

- **Node.js** >= 20 LTS
- **Chromium** (installed via Playwright)

## Quick start

```bash
npm install
npx playwright install chromium
cp .env.example .env      # then edit .env to taste
npm start                 # uses .env defaults
```

## Usage

The scraper accepts CLI flags that override `.env` values. Precedence is
**CLI > env > defaults**.

```bash
# Use .env defaults (DEFAULT_QUERY / DEFAULT_LOCATION)
npm start

# Override search target via CLI
npm start -- --query "Cafe" --location "Berlin"

# Limit the number of results (enforced starting in Phase 1.3)
npm start -- --query "Restaurant" --location "Toronto" --max-results 50

# Specify a custom output file path (used starting in Phase 1.6)
npm start -- --query "Restaurant" --location "Toronto" --output-file ./data/my-run.csv

# Combine multiple flags
npm start -- -q "Plumber" -l "Dhaka, Bangladesh" -m 100 -o ./data/plumbers.csv

# Show help
npm start -- --help

# Show version
npm start -- --version
```

### CLI flags

| Flag                          | Env var                | Required | Description                                              |
|-------------------------------|------------------------|----------|----------------------------------------------------------|
| `-q, --query <query>`         | `DEFAULT_QUERY`        | yes      | What to search for (e.g. `"Restaurant"`)                 |
| `-l, --location <location>`   | `DEFAULT_LOCATION`     | yes      | Where to search (e.g. `"Toronto"`)                       |
| `-m, --max-results <number>`  | `DEFAULT_MAX_RESULTS`  | no       | Max businesses to scrape (default: all available)        |
| `-o, --output-file <path>`    | `OUTPUT_FILE`          | no       | Output CSV path (default: auto-generated in `OUTPUT_DIR`)|

If neither the CLI flag nor the env var supplies a required field, the script
prints a friendly error and exits with code `2`.

## Configuration

Environment variables (see [`.env.example`](./.env.example)) provide defaults
that CLI flags override.

| Variable                | Default      | Description                                              |
|-------------------------|--------------|----------------------------------------------------------|
| `DEFAULT_QUERY`         | `Restaurant` | What to search for (overridden by `--query`)             |
| `DEFAULT_LOCATION`      | `Toronto`    | Where to search (overridden by `--location`)             |
| `DEFAULT_MAX_RESULTS`   | *(empty)*    | Max businesses; empty = all (overridden by `--max-results`) |
| `HEADLESS`              | `false`      | `true` to run without a visible browser                  |
| `SLOW_MO`               | `200`        | Ms delay between Playwright actions (debug aid)          |
| `VIEWPORT_WIDTH`        | `1400`       | Browser viewport width                                   |
| `VIEWPORT_HEIGHT`       | `900`        | Browser viewport height                                  |
| `OUTPUT_DIR`            | `./data`     | Directory where CSV/JSON outputs are written             |
| `OUTPUT_FILE`           | *(empty)*    | Output CSV path; empty = auto-generated (overridden by `--output-file`) |
| `LOG_LEVEL`             | `info`       | `debug` \| `info` \| `warn` \| `error`                    |

## Project structure

```
scraper/
├── src/
│   ├── index.js      # CLI entry point — orchestrates the run
│   ├── browser.js    # Browser launch / teardown
│   ├── search.js     # Maps navigation + search
│   ├── scroll.js     # Pagination / infinite-scroll (Phase 1.3)
│   ├── extract.js    # Core field extraction (Phase 1.4)
│   ├── export.js     # CSV / JSON export (Phase 1.6)
│   ├── config.js     # Environment + (future) CLI config loader
│   └── logger.js     # Structured logging
├── data/             # Output CSVs (gitignored, kept via .gitkeep)
├── logs/             # Log files (gitignored, kept via .gitkeep)
├── scripts/          # Utility / archived scripts
│   └── manual-browser-test.js
├── .env.example      # Documented environment variables
├── .gitignore
├── package.json
└── README.md
```

## Roadmap

Phase 1 is broken into 12 sub-phases (1.0 through 1.11). The current
milestone, **1.1**, makes the search input fully configurable. See
[`PHASE1_EXECUTION_PLAN.md`](./PHASE1_EXECUTION_PLAN.md) for the full breakdown.

## License

ISC
