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
    // Phase 2.1 — output targets (csv, json, db, all). Accepts comma-separated
    // values too: --output csv,json,db. The keyword `all` expands to csv,json,db.
    else if (a === '--output') out.output = argv[++i];
    // Phase 2.3 — proxy management & rotation
    else if (a === '--proxyStrategy') out.proxyStrategy = argv[++i];
    else if (a === '--sessionLength') out.sessionLength = argv[++i];
    else if (a === '--proxyCooldownMs') out.proxyCooldownMs = argv[++i];
    else if (a === '--noProxy') out.noProxy = true;
    else if (a === '--proxyListFile') out.proxyListFile = argv[++i];
    else if (a === '--proxyHealthCheck') out.proxyHealthCheck = true;
    // Phase 2.4 — browser fingerprint randomization
    else if (a === '--fingerprintProfile') out.fingerprintProfile = argv[++i];
    else if (a === '--fixedFingerprint') out.fixedFingerprint = argv[++i];
    else if (a === '--noFingerprint') out.noFingerprint = true;
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

// ---------------------------------------------------------------------------
// Phase 2.1 — resolve --output / OUTPUT into a normalized target array.
// Accepts: 'csv', 'json', 'db', 'all', or comma-separated combinations.
// Returns: string[] of targets in canonical order (csv, json, db) — de-duped.
// 'all' expands to ['csv','json','db']. Empty/undefined → ['csv','json']
// (preserves Phase 1 default behavior).
// ---------------------------------------------------------------------------

function resolveOutputTargets(raw) {
  if (!raw) return ['csv', 'json'];
  const parts = String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return ['csv', 'json'];
  if (parts.includes('all')) return ['csv', 'json', 'db'];
  // De-dup while preserving first-seen order.
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
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
  // Phase 2.1 — validate --output targets.
  for (const t of cfg.output) {
    if (!['csv', 'json', 'db'].includes(t)) {
      errors.push(
        `--output target must be csv, json, db, or all (got "${t}"). ` +
          'Use comma-separated values for multiple: --output csv,json,db',
      );
    }
  }
  // --output db requires DATABASE_URL at runtime (the pool is created lazily
  // in src/index.js, but we fail fast here so the operator sees the error
  // before any browser launches). The URL must be a PostgreSQL connection
  // string (postgres:// or postgresql://) — a SQLite file:// URL won't work.
  if (cfg.output.includes('db')) {
    if (!cfg.databaseUrl) {
      errors.push(
        '--output db requires DATABASE_URL (set in .env or environment). ' +
          'See .env.example → Phase 2.1 section.',
      );
    } else if (!/^postgres(ql)?:\/\//.test(cfg.databaseUrl)) {
      errors.push(
        '--output db requires a PostgreSQL DATABASE_URL (must start with ' +
          'postgresql:// or postgres://). Got: ' +
          cfg.databaseUrl.slice(0, 40) +
          (cfg.databaseUrl.length > 40 ? '…' : ''),
      );
    }
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
  // Phase 2.3 — proxy validation
  if (!['round-robin', 'random', 'sticky'].includes(cfg.proxy.strategy)) {
    errors.push(
      `proxyStrategy must be one of round-robin, random, sticky (got "${cfg.proxy.strategy}")`,
    );
  }
  if (cfg.proxy.sessionLength < 1 || cfg.proxy.sessionLength > 10000) {
    errors.push(
      `sessionLength must be between 1 and 10000 (got ${cfg.proxy.sessionLength})`,
    );
  }
  if (cfg.proxy.cooldownMs < 0 || cfg.proxy.cooldownMs > 24 * 60 * 60 * 1000) {
    errors.push(
      `proxyCooldownMs must be between 0 and 86400000 (got ${cfg.proxy.cooldownMs})`,
    );
  }
  // --proxyListFile must point to a readable file IF specified. We don't
  // require it (the pool can also be populated via a provider() function),
  // but a non-existent file is a config error, not a runtime one.
  if (cfg.proxy.listFile && !fs.existsSync(cfg.proxy.listFile)) {
    errors.push(
      `--proxyListFile not found: ${cfg.proxy.listFile} (set PROXY_LIST_FILE in .env or pass --proxyListFile <path>)`,
    );
  }
  // Phase 2.4 — fingerprint validation
  if (!['random', 'fixed', 'off'].includes(cfg.fingerprint.profile)) {
    errors.push(
      `fingerprintProfile must be one of random, fixed, off (got "${cfg.fingerprint.profile}")`,
    );
  }
  // --fixedFingerprint must be valid JSON when fingerprintProfile is 'fixed'.
  // We parse it here so a malformed string fails fast at config time, not at
  // the first browser launch. The coherence check itself happens in index.js
  // (it needs the fingerprint module loaded).
  if (cfg.fingerprint.profile === 'fixed') {
    if (!cfg.fingerprint.fixedJson) {
      errors.push(
        'fingerprintProfile=fixed requires --fixedFingerprint <json> (a JSON object with userAgent, platform, locale, timezone, ...)',
      );
    } else {
      try {
        const parsed = JSON.parse(cfg.fingerprint.fixedJson);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
          errors.push('--fixedFingerprint must be a JSON object, not ' + typeof parsed);
        }
      } catch (e) {
        errors.push(`--fixedFingerprint is not valid JSON: ${e.message}`);
      }
    }
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

    // Phase 2.1 — output targets. Resolved from --output (comma-separated) or
    // the OUTPUT env var. Default ['csv','json'] preserves Phase 1 behavior.
    // The keyword 'all' expands to ['csv','json','db'].
    output: resolveOutputTargets(cli.output ?? process.env.OUTPUT),
    databaseUrl: process.env.DATABASE_URL || null,

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

    // Phase 2.3 — Proxy management & rotation
    proxy: {
      // --noProxy forces a direct connection (Phase 1 behavior). Overrides
      // every other proxy flag. Also implied when no proxy source is configured.
      enabled: !cli.noProxy && process.env.NO_PROXY !== 'true' &&
        !!(cli.proxyListFile || process.env.PROXY_LIST_FILE || process.env.PROXY_PROVIDER),
      strategy: cli.proxyStrategy || process.env.PROXY_STRATEGY || 'random',
      sessionLength: toIntOrNull(cli.sessionLength ?? process.env.SESSION_LENGTH) ?? 1,
      cooldownMs: toIntOrNull(cli.proxyCooldownMs ?? process.env.PROXY_COOLDOWN_MS) ?? 10 * 60 * 1000,
      listFile: cli.proxyListFile || process.env.PROXY_LIST_FILE || null,
      // Provider name (informational — the actual fetch impl is wired in index.js
      // based on this string, e.g. 'brightdata' → Bright Data API).
      provider: process.env.PROXY_PROVIDER || null,
      providerUrl: process.env.PROXY_PROVIDER_URL || null,
      providerToken: process.env.PROXY_PROVIDER_TOKEN || null,
      // Optional pre-run health check (--proxyHealthCheck probes every proxy
      // with a HEAD to google.com before the scrape starts).
      healthCheck: !!cli.proxyHealthCheck,
      // Burn log path (defaults to data/proxy_burn_log.jsonl). Override via env
      // for ops teams that want to centralize the log.
      burnLogPath: process.env.PROXY_BURN_LOG || null,
    },

    // Phase 2.4 — Browser fingerprint randomization.
    //   --noFingerprint              → profile 'off' (Phase 1 behavior preserved)
    //   --fingerprintProfile random  → randomized coherent profile per run (DEFAULT)
    //   --fingerprintProfile fixed   → use the profile supplied via --fixedFingerprint <json>
    // The resolved profile is generated in src/index.js (it needs the fingerprint
    // module + logger) and passed to launchBrowser({ fingerprint }).
    fingerprint: {
      profile: cli.noFingerprint || process.env.NO_FINGERPRINT === 'true'
        ? 'off'
        : (cli.fingerprintProfile || process.env.FINGERPRINT_PROFILE || 'random'),
      fixedJson: cli.fixedFingerprint || process.env.FIXED_FINGERPRINT || null,
      // Resolved at runtime in index.js (the actual profile object, not the JSON string).
      // Stored on cfg so the pipeline can pass it to launchBrowser().
      resolved: null,
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

const HELP_TEXT = `gmaps-scraper — Google Maps business scraper (Phase 2)

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
  --dryRun                   Smoke test: run pipeline but write NO output files
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

  --output <targets>         Phase 2.1 — output targets, comma-separated:
                             csv, json, db, or all (default: csv,json).
                             db writes to PostgreSQL (requires DATABASE_URL).
                             all = csv,json,db. Examples:
                               --output csv          (CSV only)
                               --output db           (Postgres only)
                               --output csv,json,db  (all three, explicit)
                               --output all          (all three, shorthand)

  --proxyStrategy <s>        Phase 2.3 — round-robin | random | sticky (default: random)
  --sessionLength <n>        Phase 2.3 — requests per proxy before rotation (sticky only; default: 1)
  --proxyCooldownMs <ms>     Phase 2.3 — burn cooldown window (default: 600000 = 10 min)
  --proxyListFile <path>     Phase 2.3 — proxy list file (one proxy per line)
  --proxyHealthCheck         Phase 2.3 — probe every proxy with a HEAD before scraping
  --noProxy                  Phase 2.3 — force direct connection (Phase 1 behavior)

  --fingerprintProfile <s>   Phase 2.4 — random | fixed | off (default: random)
                             Each run gets a coherent fingerprint: UA, viewport,
                             timezone, locale, WebGL, canvas noise, hw concurrency.
  --fixedFingerprint <json>  Phase 2.4 — pin a specific fingerprint (requires
                             --fingerprintProfile fixed). JSON object with
                             userAgent, platform, locale, timezone, viewport, etc.
  --noFingerprint            Phase 2.4 — disable randomization (Phase 1 behavior)

  --version                  Print version and exit
  --help, -h                 Show this help

Examples:
  # Real runs — write CSV + JSON + summary to ./data/
  npm start -- --query "Cafe" --location "Berlin" --maxResults 50
  npm start -- --query "Plumber" --location "Dhaka, Bangladesh" --headed --verbose
  npm start -- --query "Restaurant" --location "Toronto" --deepScrape true --deepScrapeSampleStep 5
  npm start -- --query "Restaurant" --location "Toronto" --resume   # continue after a crash

  # Phase 2.1 — write to PostgreSQL (set DATABASE_URL in .env first)
  npm run db:migrate                                        # create schema (once)
  npm start -- --query "Cafe" --location "Berlin" --output db --yes
  npm start -- --query "Cafe" --location "Berlin" --output all   # CSV + JSON + DB

  # Phase 2.3 — proxy rotation (set PROXY_LIST_FILE in .env or pass --proxyListFile)
  #   Format: one proxy per line — protocol://[user:pass@]host:port or host:port:user:pass
  npm start -- --query "Cafe" --location "Berlin" --proxyListFile ./proxies.txt
  npm start -- --query "Cafe" --location "Berlin" --proxyStrategy round-robin --sessionLength 5
  npm start -- --query "Cafe" --location "Berlin" --proxyListFile ./proxies.txt --proxyHealthCheck
  npm start -- --query "Cafe" --location "Berlin" --noProxy   # force direct connection

  # Phase 2.4 — fingerprint randomization (on by default)
  npm start -- --query "Cafe" --location "Berlin"               # random fingerprint per run
  npm start -- --query "Cafe" --location "Berlin" --noFingerprint   # Phase 1 behavior
  npm start -- --query "Cafe" --location "Berlin" --fingerprintProfile fixed \
    --fixedFingerprint '{"userAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131","platform":"Win32","locale":"en-US","timezone":"America/New_York","languages":["en-US","en"],"viewport":{"width":1920,"height":1080},"screen":{"width":1920,"height":1080},"webglVendor":"Intel Inc.","webglRenderer":"Intel(R) UHD Graphics 630","canvasNoiseSeed":42,"hardwareConcurrency":8,"deviceMemory":8,"geolocation":{"latitude":40.7128,"longitude":-74.006}}'

  # Smoke test — runs the pipeline but writes NO files (no CSV, no JSON)
  npm start -- --query "Cafe" --location "Berlin" --maxResults 10 --yes --dryRun
`;

module.exports = { loadConfig, parseArgs, validate, HELP_TEXT, resolveOutputTargets };
