# Google Maps Scraper

A Node.js scraper that extracts business data from Google Maps and exports it to CSV.

## Current status: Phase 1.0 — Project Hygiene & Foundation

The project has been restructured into a clean, modular layout. The scraper can
launch a browser, navigate to Google Maps, and perform a search. Data
extraction, pagination, and CSV export are implemented in subsequent phases.

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
npm start
```

## Configuration

All configuration currently flows through environment variables (see
[`.env.example`](./.env.example)). CLI argument overrides land in Phase 1.1.

| Variable           | Default      | Description                                  |
|--------------------|--------------|----------------------------------------------|
| `DEFAULT_QUERY`    | `Restaurant` | What to search for                           |
| `DEFAULT_LOCATION` | `Toronto`    | Where to search                              |
| `HEADLESS`         | `false`      | `true` to run without a visible browser      |
| `SLOW_MO`          | `200`        | Ms delay between Playwright actions          |
| `VIEWPORT_WIDTH`   | `1400`       | Browser viewport width                       |
| `VIEWPORT_HEIGHT`  | `900`        | Browser viewport height                      |
| `OUTPUT_DIR`       | `./data`     | Where CSV/JSON outputs are written           |
| `LOG_LEVEL`        | `info`       | `debug` \| `info` \| `warn` \| `error`       |

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
milestone, **1.0**, establishes the foundation. See
[`PHASE1_EXECUTION_PLAN.md`](./PHASE1_EXECUTION_PLAN.md) for the full breakdown.

## License

ISC
