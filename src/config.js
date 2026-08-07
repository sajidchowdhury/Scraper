'use strict';

/**
 * src/config.js — Phase 1.1
 *
 * Resolves runtime configuration from (in priority order):
 *   1. CLI args (--query, --location, --maxResults, --headless/--headed, ...)
 *   2. Process environment variables (DEFAULT_QUERY, HEADLESS, ...)
 *   3. .env file (tiny hand-rolled loader — no external dep)
 *   4. Hardcoded defaults
 *
 * Validates on startup and fails fast with a clear message.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Tiny .env loader (hand-rolled to avoid pulling in dotenv for Phase 1)
// ---------------------------------------------------------------------------

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// CLI arg parser (hand-rolled, no commander/yargs dependency for Phase 1)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--query' || a === '-q') out.query = argv[++i];
    else if (a === '--location' || a === '-l') out.location = argv[++i];
    else if (a === '--maxResults' || a === '--limit') out.maxResults = argv[++i];
    else if (a === '--outputFile' || a === '-o') out.outputFile = argv[++i];
    else if (a === '--outputDir') out.outputDir = argv[++i];
    else if (a === '--headless') out.headless = true;
    else if (a === '--headed') out.headless = false;
    else if (a === '--logLevel') out.logLevel = argv[++i];
    else if (a === '--verbose') out.logLevel = 'debug';
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version') out.version = true;
    else if (a === '--dryRun') out.dryRun = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function toIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

function validate(cfg) {
  const errors = [];
  if (!cfg.query || !cfg.query.trim()) {
    errors.push('Missing required input: --query (or DEFAULT_QUERY in .env)');
  }
  if (!cfg.location || !cfg.location.trim()) {
    errors.push('Missing required input: --location (or DEFAULT_LOCATION in .env)');
  }
  if (cfg.maxResults !== null && (cfg.maxResults < 1 || cfg.maxResults > 100000)) {
    errors.push(`maxResults must be between 1 and 100000 (got ${cfg.maxResults})`);
  }
  const validLevels = ['debug', 'info', 'warn', 'error'];
  if (!validLevels.includes(cfg.logLevel)) {
    errors.push(`logLevel must be one of ${validLevels.join(', ')} (got ${cfg.logLevel})`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

function loadConfig(argv = process.argv.slice(2)) {
  loadDotEnv(path.join(process.cwd(), '.env'));

  const cli = parseArgs(argv);

  const headless =
    cli.headless !== undefined
      ? cli.headless
      : process.env.HEADLESS === undefined
        ? true
        : process.env.HEADLESS === 'true';

  const cfg = {
    // Search inputs
    query: cli.query || process.env.DEFAULT_QUERY || '',
    location: cli.location || process.env.DEFAULT_LOCATION || '',
    maxResults: toIntOrNull(cli.maxResults ?? process.env.DEFAULT_MAX_RESULTS),

    // Output
    outputDir: cli.outputDir || process.env.OUTPUT_DIR || './data',
    outputFile: cli.outputFile || null, // null = auto-generate
    dryRun: !!cli.dryRun,

    // Browser
    headless,
    slowMo: toIntOrNull(process.env.SLOW_MO) ?? 0,
    viewportWidth: toIntOrNull(process.env.VIEWPORT_WIDTH) ?? 1400,
    viewportHeight: toIntOrNull(process.env.VIEWPORT_HEIGHT) ?? 900,

    // Timeouts
    globalTimeoutMs: toIntOrNull(process.env.GLOBAL_TIMEOUT_MS) ?? 5 * 60 * 1000,
    navTimeoutMs: toIntOrNull(process.env.NAV_TIMEOUT_MS) ?? 60 * 1000,

    // Scroll (Phase 1.3)
    scroll: {
      totalTimeoutMs: toIntOrNull(process.env.SCROLL_TIMEOUT_MS) ?? 90 * 1000,
      stallThreshold: toIntOrNull(process.env.SCROLL_STALL_THRESHOLD) ?? 3,
      batchDelayMs: toIntOrNull(process.env.SCROLL_BATCH_DELAY_MS) ?? 800,
      pollIntervalMs: toIntOrNull(process.env.SCROLL_POLL_INTERVAL_MS) ?? 500,
    },

    // Extract (Phase 1.4)
    extract: {
      interBatchMs: toIntOrNull(process.env.EXTRACT_INTER_BATCH_MS) ?? 250,
      fieldWarnThreshold: toIntOrNull(process.env.EXTRACT_FIELD_WARN_THRESHOLD) ?? 80,
    },

    // Logging
    logLevel: cli.logLevel || process.env.LOG_LEVEL || 'info',

    // CLI meta
    help: !!cli.help,
    version: !!cli.version,
  };

  cfg.errors = validate(cfg);
  return cfg;
}

const HELP_TEXT = `gmaps-scraper — Google Maps business scraper (Phase 1)

Usage:
  npm start -- --query <q> --location <loc> [options]
  node src/index.js --query <q> --location <loc> [options]

Required:
  --query, -q <string>      What to search (e.g. "Restaurant")
  --location, -l <string>   Where to search (e.g. "Toronto")

Optional:
  --maxResults, --limit <n>  Cap result count (default: all available)
  --outputFile, -o <path>    Output CSV/JSON path (default: auto-generated)
  --outputDir <path>         Output directory (default: ./data)
  --headless / --headed      Force browser mode (default: headless)
  --logLevel <level>         debug | info | warn | error (default: info)
  --verbose                  Alias for --logLevel debug
  --dryRun                   Run pipeline but skip writing output files
  --version                  Print version and exit
  --help, -h                 Show this help

Examples:
  npm start -- --query "Cafe" --location "Berlin" --maxResults 50
  npm start -- --query "Plumber" --location "Dhaka, Bangladesh" --headed --verbose
`;

module.exports = { loadConfig, parseArgs, validate, HELP_TEXT };
