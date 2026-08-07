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
    // Phase 1.10 — startup banner / DX
    else if (a === '--yes' || a === '-y') out.yes = true;
    // Phase 1.5 — detail-page deep scrape toggle
    else if (a === '--deepScrape') {
      const v = argv[++i];
      out.deepScrape = v === 'true' || v === '1' || v === 'yes';
    } else if (a === '--noDeepScrape') {
      out.deepScrape = false;
    } else if (a === '--deepScrapeSampleStep') {
      out.deepScrapeSampleStep = argv[++i];
    }
    // Phase 1.7 — crash recovery / resume
    else if (a === '--resume') out.resume = true;
    else if (a === '--fresh') out.fresh = true;
    else if (a === '--checkpointInterval') out.checkpointInterval = argv[++i];
    else if (a === '--maxRetries') out.maxRetries = argv[++i];
    else if (a === '--retryBaseMs') out.retryBaseMs = argv[++i];
    // Phase 1.8 — minimal anti-block behavior
    else if (a === '--maxRPM') out.maxRPM = argv[++i];
    else if (a === '--noHumanTyping') out.humanTyping = false;
    else if (a === '--noCaptchaPause') out.captchaPause = false;
    else if (a === '--captchaWaitMs') out.captchaWaitMs = argv[++i];
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
  if (cfg.checkpointInterval !== null && (cfg.checkpointInterval < 1 || cfg.checkpointInterval > 10000)) {
    errors.push(`checkpointInterval must be between 1 and 10000 (got ${cfg.checkpointInterval})`);
  }
  if (cfg.retry.attempts < 1 || cfg.retry.attempts > 10) {
    errors.push(`maxRetries must be between 1 and 10 (got ${cfg.retry.attempts})`);
  }
  if (cfg.retry.baseMs < 0 || cfg.retry.baseMs > 60000) {
    errors.push(`retryBaseMs must be between 0 and 60000 (got ${cfg.retry.baseMs})`);
  }
  if (cfg.resume && cfg.fresh) {
    errors.push('--resume and --fresh are mutually exclusive');
  }
  // Phase 1.8 — antiblock validation
  if (cfg.antiblock.maxRequestsPerMin < 1 || cfg.antiblock.maxRequestsPerMin > 600) {
    errors.push(
      `maxRPM must be between 1 and 600 (got ${cfg.antiblock.maxRequestsPerMin})`,
    );
  }
  if (cfg.antiblock.captchaWaitMs < 0 || cfg.antiblock.captchaWaitMs > 3_600_000) {
    errors.push(
      `captchaWaitMs must be between 0 and 3600000 (got ${cfg.antiblock.captchaWaitMs})`,
    );
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

    // Phase 1.10 — DX: skip the startup-banner delay (scripted / CI runs).
    yes: !!cli.yes,

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

    // Detail-page deep scrape (Phase 1.5) — toggleable, default off for speed
    deepScrape:
      cli.deepScrape !== undefined
        ? cli.deepScrape
        : process.env.DEEP_SCRAPE === 'true',
    detail: {
      delayMinMs: toIntOrNull(process.env.DEEP_SCRAPE_DELAY_MIN_MS) ?? 1000,
      delayMaxMs: toIntOrNull(process.env.DEEP_SCRAPE_DELAY_MAX_MS) ?? 3000,
      timeoutMs: toIntOrNull(process.env.DEEP_SCRAPE_TIMEOUT_MS) ?? 15000,
      maxReviews: toIntOrNull(process.env.DEEP_SCRAPE_MAX_REVIEWS) ?? 5,
      maxPhotos: toIntOrNull(process.env.DEEP_SCRAPE_MAX_PHOTOS) ?? 5,
      // Sample step: scrape every Nth business (1 = all, 5 = QA mode). Useful
      // for fast smoke-tests against large result sets.
      sampleStep: toIntOrNull(cli.deepScrapeSampleStep ?? process.env.DEEP_SCRAPE_SAMPLE_STEP) ?? 1,
    },

    // Phase 1.7 — Reliability & crash recovery
    resume: !!cli.resume,
    fresh: !!cli.fresh,
    checkpointInterval: toIntOrNull(cli.checkpointInterval ?? process.env.CHECKPOINT_INTERVAL) ?? 10,
    retry: {
      attempts: toIntOrNull(cli.maxRetries ?? process.env.MAX_RETRIES) ?? 3,
      baseMs: toIntOrNull(cli.retryBaseMs ?? process.env.RETRY_BASE_MS) ?? 1000,
    },

    // Phase 1.8 — Minimal anti-block behavior
    antiblock: {
      maxRequestsPerMin:
        toIntOrNull(cli.maxRPM ?? process.env.MAX_REQUESTS_PER_MIN) ?? 30,
      humanTyping: cli.humanTyping !== undefined ? cli.humanTyping : process.env.HUMAN_TYPING !== 'false',
      captchaPause:
        cli.captchaPause !== undefined ? cli.captchaPause : process.env.CAPTCHA_PAUSE !== 'false',
      captchaWaitMs: toIntOrNull(cli.captchaWaitMs ?? process.env.CAPTCHA_WAIT_MS) ?? 5 * 60 * 1000,
      // Delay ranges (ms). Spec defaults:
      //   scroll: 800-2000, extraction inter-batch: 200-600,
      //   detail visit: 1500-3500, pre-Enter: 500-1500, typing key: 50-150
      scrollDelayMinMs: toIntOrNull(process.env.SCROLL_DELAY_MIN_MS) ?? 800,
      scrollDelayMaxMs: toIntOrNull(process.env.SCROLL_DELAY_MAX_MS) ?? 2000,
      extractDelayMinMs: toIntOrNull(process.env.EXTRACT_DELAY_MIN_MS) ?? 200,
      extractDelayMaxMs: toIntOrNull(process.env.EXTRACT_DELAY_MAX_MS) ?? 600,
      detailDelayMinMs: toIntOrNull(process.env.DETAIL_DELAY_MIN_MS) ?? 1500,
      detailDelayMaxMs: toIntOrNull(process.env.DETAIL_DELAY_MAX_MS) ?? 3500,
      preEnterDelayMinMs: toIntOrNull(process.env.PRE_ENTER_DELAY_MIN_MS) ?? 500,
      preEnterDelayMaxMs: toIntOrNull(process.env.PRE_ENTER_DELAY_MAX_MS) ?? 1500,
      typeKeyMinMs: toIntOrNull(process.env.TYPE_KEY_MIN_MS) ?? 50,
      typeKeyMaxMs: toIntOrNull(process.env.TYPE_KEY_MAX_MS) ?? 150,
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
  --yes, -y                  Skip the 1s startup-banner delay (scripted / CI runs)

  --deepScrape true|false    Phase 1.5 — open each detail panel to fetch
                             hours, popular times, top reviews, photos,
                             reservation/menu/social links (default: false)
  --deepScrapeSampleStep <n> Scrape every Nth business (1 = all, 5 = QA mode)
  --noDeepScrape             Force --deepScrape false (overrides .env)

  --resume                   Phase 1.7 — resume from .checkpoint.json if it exists
  --fresh                    Phase 1.7 — ignore/delete checkpoint, start from scratch
  --checkpointInterval <n>   Write checkpoint every N new records (default: 10)
  --maxRetries <n>           Retry attempts for transient ops (default: 3)
  --retryBaseMs <ms>         Base backoff for retries, doubles each time (default: 1000)

  --maxRPM <n>               Phase 1.8 — max Google requests per minute (default: 30)
  --noHumanTyping            Phase 1.8 — disable char-by-char search typing
  --noCaptchaPause           Phase 1.8 — don't pause on CAPTCHA (just exit)
  --captchaWaitMs <ms>       Phase 1.8 — how long to pause on CAPTCHA (default: 300000)

  --version                  Print version and exit
  --help, -h                 Show this help

Examples:
  npm start -- --query "Cafe" --location "Berlin" --maxResults 50
  npm start -- --query "Plumber" --location "Dhaka, Bangladesh" --headed --verbose
  npm start -- --query "Restaurant" --location "Toronto" --deepScrape true --deepScrapeSampleStep 5
  npm start -- --query "Restaurant" --location "Toronto" --resume   # continue after a crash
  npm start -- --query "Cafe" --location "Berlin" --yes --dryRun    # no delay, scripted
`;

module.exports = { loadConfig, parseArgs, validate, HELP_TEXT };
