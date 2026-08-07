# Google Maps Scraper

A Node.js scraper that extracts business data from Google Maps and exports it to CSV.

## Current status: Phase 1.2 — Robust Browser Automation Core

The project is structured into clean modules, the search target is fully
configurable via CLI flags or environment variables, and the browser
lifecycle is bulletproof: a global run timeout prevents hangs, Ctrl-C shuts
down gracefully, and the browser is always torn down via `try/finally`.
Pagination, field extraction, and CSV export land in subsequent phases.

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
| `RUN_TIMEOUT_MS`        | `300000`     | Global run timeout in ms (min `5000`); prevents hangs → exit `3` |
| `LOG_LEVEL`             | `info`       | `debug` \| `info` \| `warn` \| `error`                    |

## Lifecycle & exit codes

The scraper is built to **never hang** and **never leak browser processes**.

- **Global timeout**: if the run exceeds `RUN_TIMEOUT_MS` (default 5 min), the
  browser is force-closed and the process exits with code `3`.
- **Ctrl-C (SIGINT)**: the first Ctrl-C closes the browser gracefully and exits
  with code `130`. A second Ctrl-C forces an immediate exit with code `137`
  (escape hatch if `browser.close()` itself is hung).
- **`try/finally`**: the browser is always torn down, even on error.
- **Idempotent close**: `closeBrowser()` is safe to call from both the signal
  handler and the `finally` block.

| Exit code | Meaning                                                       |
|-----------|---------------------------------------------------------------|
| `0`       | Success                                                       |
| `1`       | Partial success (some businesses failed — used in Phase 1.4+) |
| `2`       | Configuration error (missing/invalid CLI args or env)         |
| `3`       | Runtime error (browser crash, network failure, timeout)       |
| `130`     | Interrupted by user (Ctrl-C, graceful shutdown)               |
| `137`     | Interrupted by user (second Ctrl-C, forced shutdown)          |

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
milestone, **1.2**, makes the browser lifecycle bulletproof (global timeout,
graceful SIGINT, idempotent teardown, fallback selectors). See
[`PHASE1_EXECUTION_PLAN.md`](./PHASE1_EXECUTION_PLAN.md) for the full breakdown.

## License

ISC
