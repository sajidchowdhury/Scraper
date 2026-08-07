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
    // Phase 2.5 — stealth hardening (playwright-extra + stealth plugin +
    // custom init-script patches for navigator.webdriver, chrome.runtime,
    // plugins.length, permissions.query, outerWidth/Height, etc.)
    else if (a === '--stealth') out.stealth = argv[++i];
    else if (a === '--noStealth') out.noStealth = true;
    else if (a === '--stealthDebug') out.stealthDebug = true;
    // Phase 2.6 — CAPTCHA auto-solving (2captcha / anticaptcha / capsolver / mock / none).
    // --noCaptchaSolve forces pause-and-alert (overrides --captchaProvider).
    else if (a === '--captchaProvider') out.captchaProvider = argv[++i];
    else if (a === '--captchaApiKey') out.captchaApiKey = argv[++i];
    else if (a === '--captchaBudget') out.captchaBudget = argv[++i];
    else if (a === '--captchaFallbackProvider') out.captchaFallbackProvider = argv[++i];
    else if (a === '--noCaptchaSolve') out.noCaptchaSolve = true;
    // Phase 2.7 — session & cookie rotation. NOTE: --sessionLength is already
    // taken by Phase 2.3 (proxy sticky rotation), so we use --sessionMaxRequests
    // for the browser-context rotation trigger to avoid a flag collision.
    else if (a === '--sessionMaxRequests') out.sessionMaxRequests = argv[++i];
    else if (a === '--sessionMaxAgeMs') out.sessionMaxAgeMs = argv[++i];
    else if (a === '--warmup') out.warmup = argv[++i];
    else if (a === '--warmupDurationMs') out.warmupDurationMs = argv[++i];
    else if (a === '--noWarmup') out.noWarmup = true;
    else if (a === '--accountWarmup') out.accountWarmup = argv[++i];
    else if (a === '--accountsFile') out.accountsFile = argv[++i];
    // Phase 2.8 — worker pool & concurrency. --workers N spawns N parallel
    // browser workers (default: 1 = Phase 1 sequential behavior preserved
    // exactly). Each worker gets its own proxy + fingerprint + session + rate
    // limiter. --workers 1 skips the pool entirely (no overhead).
    else if (a === '--workers') out.workers = argv[++i];
    else if (a === '--workerProxyStrategy') out.workerProxyStrategy = argv[++i];
    else if (a === '--workerCrashLimit') out.workerCrashLimit = argv[++i];
    else if (a === '--workerCooldownMs') out.workerCooldownMs = argv[++i];
    else if (a === '--workerLoadBalancer') out.workerLoadBalancer = argv[++i];
    else if (a === '--workerDetailBatchSize') out.workerDetailBatchSize = argv[++i];
    else if (a === '--workerTaskRetries') out.workerTaskRetries = argv[++i];
    // Phase 2.9 — job queue & orchestration. --queue on switches from the
    // Phase 2.8 in-process pool.dispatch to a BullMQ-backed queue: jobs are
    // submitted to Redis, a worker pulls them off, and the pool dispatches
    // each one. This decouples submission from execution (batch CLI, crash
    // recovery, priorities). --queue off (default) preserves Phase 2.8
    // behavior exactly (no Redis required).
    else if (a === '--queue') out.queue = argv[++i];
    else if (a === '--redisUrl') out.redisUrl = argv[++i];
    else if (a === '--queuePriority') out.queuePriority = argv[++i];
    else if (a === '--queueAttempts') out.queueAttempts = argv[++i];
    else if (a === '--queueConcurrency') out.queueConcurrency = argv[++i];
    // Phase 2.10 — memory management & long-run stability. These flags keep
    // the scraper running 8+ hours without OOM or zombie Chromium processes:
    //   --contextRestartEvery N — force-restart the browser context every N
    //                             tasks (clears Chrome memory leaks; 0 = off).
    //   --maxHeapMb N           — per-worker heap threshold (MB). Crossing it
    //                             fires the memory monitor's onThreshold
    //                             callback (which restarts the context).
    //   --maxRssMb N            — total process RSS threshold (MB). Crossing it
    //                             triggers graceful degradation (pause queue,
    //                             restart contexts, reduce pool size).
    //   --endless               — keep pulling jobs from the queue indefinitely
    //                             (Phase 5 continuous scraping). Implies an
    //                             aggressive memory monitor + hourly zombie
    //                             reaper + HTTP /health endpoint.
    //   --healthCheckIntervalMs — memory monitor + worker probe cadence (ms).
    //                             Default 30000 (memory) / 60000 (worker probe).
    //   --healthPort N          — bind a GET /health HTTP endpoint on this port
    //                             (default: off; auto-on when --endless).
    else if (a === '--contextRestartEvery') out.contextRestartEvery = argv[++i];
    else if (a === '--maxHeapMb') out.maxHeapMb = argv[++i];
    else if (a === '--maxRssMb') out.maxRssMb = argv[++i];
    else if (a === '--endless') out.endless = true;
    else if (a === '--healthCheckIntervalMs') out.healthCheckIntervalMs = argv[++i];
    else if (a === '--healthPort') out.healthPort = argv[++i];
    else if (a === '--healthHost') out.healthHost = argv[++i];
    else if (a === '--noHealthServer') out.noHealthServer = true;
    // Phase 2.11 — self-healing selectors & health checks. These flags
    // control the startup selector health check, heuristic field auto-
    // discovery, DOM-snippet debug dumps, and selector-set age warnings.
    //   --skipHealthCheck       — don't run the pre-scrape extraction-rate
    //                             health check (emergency runs only).
    //   --autoDiscover on|off   — heuristic field discovery when selectors
    //                             fail (default: on).
    //   --selectorDebugDump on|off — write DOM snippets for low-rate fields
    //                             to data/selector-debug/ (default: on).
    //   --maxSelectorAge N      — warn when selector sets are older than N
    //                             days (default: 30).
    //   --selectorDebugDir <p>  — override the dump directory.
    else if (a === '--skipHealthCheck') out.skipHealthCheck = true;
    else if (a === '--autoDiscover') out.autoDiscover = argv[++i];
    else if (a === '--selectorDebugDump') out.selectorDebugDump = argv[++i];
    else if (a === '--maxSelectorAge') out.maxSelectorAge = argv[++i];
    else if (a === '--selectorDebugDir') out.selectorDebugDir = argv[++i];
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
  // Phase 2.5 — stealth validation. --stealth must be 'on' or 'off' (case-insensitive).
  // --noStealth is an alias for --stealth off. --stealthDebug implies --stealth on.
  if (cfg.stealth.profile !== 'on' && cfg.stealth.profile !== 'off') {
    errors.push(
      `stealth must be one of on, off (got "${cfg.stealth.profile}"). Use --stealth on|off or --noStealth.`,
    );
  }
  // Phase 2.6 — CAPTCHA provider validation. Must be one of the registered
  // providers (case-insensitive; normalized to lowercase). --noCaptchaSolve
  // overrides to 'none' (Phase 1.8 pause-and-alert behavior).
  const validCaptchaProviders = ['2captcha', 'anticaptcha', 'capsolver', 'mock', 'none'];
  if (!validCaptchaProviders.includes(cfg.captcha.provider)) {
    errors.push(
      `captchaProvider must be one of ${validCaptchaProviders.join(', ')} (got "${cfg.captcha.provider}"). ` +
        'Use --captchaProvider <p> or CAPTCHA_PROVIDER in .env.',
    );
  }
  // Real providers (2captcha / anticaptcha / capsolver) require an API key.
  // mock + none do not. We fail fast here so the operator doesn't discover a
  // missing key at the first CAPTCHA mid-run.
  if (
    ['2captcha', 'anticaptcha', 'capsolver'].includes(cfg.captcha.provider) &&
    !cfg.captcha.apiKey
  ) {
    errors.push(
      `captchaProvider=${cfg.captcha.provider} requires --captchaApiKey <key> (or CAPTCHA_API_KEY in .env).`,
    );
  }
  // Budget must be a non-negative finite number (0 = allow no solves; Infinity
  // is rejected — use a large number instead). Default 5.00.
  if (
    !Number.isFinite(cfg.captcha.budget) ||
    cfg.captcha.budget < 0 ||
    cfg.captcha.budget > 1_000_000
  ) {
    errors.push(
      `captchaBudget must be a finite number between 0 and 1000000 (got ${cfg.captcha.budget}).`,
    );
  }
  // Fallback provider (optional) must be valid if set.
  if (
    cfg.captcha.fallbackProvider &&
    !validCaptchaProviders.includes(cfg.captcha.fallbackProvider)
  ) {
    errors.push(
      `captchaFallbackProvider must be one of ${validCaptchaProviders.join(', ')} (got "${cfg.captcha.fallbackProvider}").`,
    );
  }
  // Fallback cannot be the same as the primary (pointless) and cannot be 'none'
  // (use --noCaptchaSolve instead for the global disable).
  if (
    cfg.captcha.fallbackProvider &&
    cfg.captcha.fallbackProvider === cfg.captcha.provider
  ) {
    errors.push(
      'captchaFallbackProvider must differ from captchaProvider (it is the secondary solver tried when the primary fails).',
    );
  }
  if (cfg.captcha.fallbackProvider === 'none') {
    errors.push(
      'captchaFallbackProvider cannot be "none" (use --noCaptchaSolve to disable all auto-solving).',
    );
  }
  // Fallback real provider also requires the API key (a single key per service
  // is the common case; mixed-provider fallback is a future enhancement).
  if (
    cfg.captcha.fallbackProvider &&
    ['2captcha', 'anticaptcha', 'capsolver'].includes(cfg.captcha.fallbackProvider) &&
    !cfg.captcha.apiKey
  ) {
    errors.push(
      `captchaFallbackProvider=${cfg.captcha.fallbackProvider} also requires --captchaApiKey <key>.`,
    );
  }
  // Phase 2.7 — session rotation validation.
  if (cfg.session.maxRequests < 1 || cfg.session.maxRequests > 100000) {
    errors.push(
      `sessionMaxRequests must be between 1 and 100000 (got ${cfg.session.maxRequests}). Use --sessionMaxRequests <n>.`,
    );
  }
  if (cfg.session.maxAgeMs < 1000 || cfg.session.maxAgeMs > 24 * 60 * 60 * 1000) {
    errors.push(
      `sessionMaxAgeMs must be between 1000 and 86400000 (got ${cfg.session.maxAgeMs}). Use --sessionMaxAgeMs <ms>.`,
    );
  }
  if (cfg.session.warmupDurationMs < 0 || cfg.session.warmupDurationMs > 300000) {
    errors.push(
      `warmupDurationMs must be between 0 and 300000 (got ${cfg.session.warmupDurationMs}). Use --warmupDurationMs <ms>.`,
    );
  }
  // accountWarmup requires an accounts file. We check existence here (fail-fast)
  // so the operator knows before any browser launches. A missing file is a
  // config error, not a runtime one.
  if (cfg.session.accountWarmup) {
    if (!cfg.session.accountsFile) {
      errors.push(
        'accountWarmup=on requires --accountsFile <path> (a JSON array of {email, password}). ' +
          'Set ACCOUNTS_FILE in .env or pass --accountsFile. The file MUST be gitignored + chmod 600.',
      );
    } else if (!fs.existsSync(cfg.session.accountsFile)) {
      errors.push(
        `--accountsFile not found: ${cfg.session.accountsFile} (set ACCOUNTS_FILE in .env or pass --accountsFile <path>)`,
      );
    }
  }
  // Phase 2.8 — worker pool validation.
  if (cfg.workers.size < 1 || cfg.workers.size > 64) {
    errors.push(
      `workers must be between 1 and 64 (got ${cfg.workers.size}). --workers 1 = Phase 1 sequential behavior.`,
    );
  }
  if (!['shared', 'isolated'].includes(cfg.workers.proxyStrategy)) {
    errors.push(
      `workerProxyStrategy must be one of shared, isolated (got "${cfg.workers.proxyStrategy}"). ` +
        'isolated = each worker gets its own proxy (default); shared = all workers draw from the pool.',
    );
  }
  if (cfg.workers.crashLimit < 1 || cfg.workers.crashLimit > 50) {
    errors.push(
      `workerCrashLimit must be between 1 and 50 (got ${cfg.workers.crashLimit}). ` +
        'Worker is retired after this many crashes in the 10-min window.',
    );
  }
  if (cfg.workers.cooldownMs < 0 || cfg.workers.cooldownMs > 24 * 60 * 60 * 1000) {
    errors.push(
      `workerCooldownMs must be between 0 and 86400000 (got ${cfg.workers.cooldownMs}). ` +
        'How long a blocked worker stays out before revival (default 300000 = 5 min).',
    );
  }
  if (!['round-robin', 'least-busy'].includes(cfg.workers.loadBalancer)) {
    errors.push(
      `workerLoadBalancer must be one of round-robin, least-busy (got "${cfg.workers.loadBalancer}").`,
    );
  }
  if (cfg.workers.detailBatchSize < 1 || cfg.workers.detailBatchSize > 500) {
    errors.push(
      `workerDetailBatchSize must be between 1 and 500 (got ${cfg.workers.detailBatchSize}). ` +
        'Number of businesses per detail-task (default 20).',
    );
  }
  if (cfg.workers.taskRetries < 0 || cfg.workers.taskRetries > 64) {
    errors.push(
      `workerTaskRetries must be between 0 and 64 (got ${cfg.workers.taskRetries}). ` +
        'Max re-queues per task across workers (default = workers size).',
    );
  }
  // Phase 2.9 — job queue validation. --queue on|off is normalized to a
  // boolean in loadConfig; here we validate the dependent fields.
  if (typeof cfg.queue.enabled !== 'boolean') {
    errors.push(
      `queue must be one of on, off (got "${cfg.queue.enabled}"). Use --queue on|off.`,
    );
  }
  if (cfg.queue.priority < 1 || cfg.queue.priority > 100) {
    errors.push(
      `queuePriority must be between 1 and 100 (got ${cfg.queue.priority}). ` +
        '1 = highest priority (paid jobs), 10 = low (background re-scrape), 5 = normal.',
    );
  }
  if (cfg.queue.attempts < 1 || cfg.queue.attempts > 50) {
    errors.push(
      `queueAttempts must be between 1 and 50 (got ${cfg.queue.attempts}). ` +
        'BullMQ retries failed jobs up to this many times with exponential backoff.',
    );
  }
  if (cfg.queue.concurrency < 1 || cfg.queue.concurrency > 64) {
    errors.push(
      `queueConcurrency must be between 1 and 64 (got ${cfg.queue.concurrency}). ` +
        'How many jobs the worker pulls off the queue in parallel.',
    );
  }
  // --queue on requires REDIS_URL (BullMQ needs a Redis connection). We fail
  // fast here so the operator sees the error before any browser launches.
  if (cfg.queue.enabled === 'on' && !cfg.queue.redisUrl) {
    errors.push(
      '--queue on requires REDIS_URL (set in .env or pass --redisUrl <url>). ' +
        'See .env.example → Phase 2.9 section.',
    );
  }
  // --queue on implicitly requires --workers > 1 (the queue feeds the pool;
  // a single-worker pool can still process queue jobs but with no concurrency
  // benefit). We WARN (not error) — a single worker + queue is a valid config
  // for low-throughput crash-resilient runs.
  // Phase 2.10 — memory management validation.
  if (cfg.health.contextRestartEvery !== 0 && cfg.health.contextRestartEvery < 1) {
    errors.push(
      `contextRestartEvery must be 0 (off) or >= 1 (got ${cfg.health.contextRestartEvery}). ` +
        'Force-restart the browser context every N tasks to clear Chrome memory.',
    );
  }
  if (cfg.health.contextRestartEvery > 10000) {
    errors.push(
      `contextRestartEvery is suspiciously large (got ${cfg.health.contextRestartEvery}). ` +
        'For 8+ hour runs use 50–200; 10000+ defeats the memory-reclamation purpose.',
    );
  }
  if (cfg.health.maxHeapMb < 64 || cfg.health.maxHeapMb > 8192) {
    errors.push(
      `maxHeapMb must be between 64 and 8192 (got ${cfg.health.maxHeapMb}). ` +
        'Per-worker heap threshold for the memory monitor (default 1024).',
    );
  }
  if (cfg.health.maxRssMb < 256 || cfg.health.maxRssMb > 32768) {
    errors.push(
      `maxRssMb must be between 256 and 32768 (got ${cfg.health.maxRssMb}). ` +
        'Total process RSS threshold for graceful degradation (default 4096).',
    );
  }
  if (cfg.health.maxRssMb <= cfg.health.maxHeapMb) {
    errors.push(
      `maxRssMb (${cfg.health.maxRssMb}) must be > maxHeapMb (${cfg.health.maxHeapMb}). ` +
        'The total-process threshold must exceed the per-worker threshold.',
    );
  }
  if (cfg.health.memoryIntervalMs < 1000 || cfg.health.memoryIntervalMs > 60 * 60 * 1000) {
    errors.push(
      `healthCheckIntervalMs must be between 1000 and 3600000 (got ${cfg.health.memoryIntervalMs}). ` +
        'Memory monitor + worker probe cadence (default 30000).',
    );
  }
  if (cfg.health.port !== null && (cfg.health.port < 1 || cfg.health.port > 65535)) {
    errors.push(
      `healthPort must be between 1 and 65535 (got ${cfg.health.port}). ` +
        'Set to 0 or omit to disable the HTTP /health endpoint.',
    );
  }
  // --endless requires --queue on (the endless loop pulls jobs from the queue;
  // without a queue there's nothing to pull).
  if (cfg.health.endless && !cfg.queue.enabled) {
    errors.push(
      '--endless requires --queue on (the endless loop pulls jobs from the ' +
        'BullMQ queue; without a queue there is nothing to pull). See .env.example → Phase 2.10.',
    );
  }
  // Phase 2.11 — self-healing selector validation.
  if (cfg.selectors.autoDiscover !== true && cfg.selectors.autoDiscover !== false) {
    errors.push(
      `autoDiscover must be one of on, off (got "${cfg.selectors.autoDiscover}"). Use --autoDiscover on|off.`,
    );
  }
  if (cfg.selectors.selectorDebugDump !== true && cfg.selectors.selectorDebugDump !== false) {
    errors.push(
      `selectorDebugDump must be one of on, off (got "${cfg.selectors.selectorDebugDump}"). Use --selectorDebugDump on|off.`,
    );
  }
  if (cfg.selectors.maxSelectorAge < 1 || cfg.selectors.maxSelectorAge > 365) {
    errors.push(
      `maxSelectorAge must be between 1 and 365 days (got ${cfg.selectors.maxSelectorAge}). ` +
        'Warn when selector sets are older than this (default 30).',
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

    // Phase 2.5 — Stealth hardening (playwright-extra + stealth plugin + custom
    // init-script patches for navigator.webdriver, chrome.runtime, plugins.length,
    // permissions.query, outerWidth/Height, Notification.permission, etc.).
    //   --noStealth / STEALTH=off       → profile 'off' (Phase 1/2.4 behavior preserved)
    //   --stealth on / STEALTH=on       → playwright-extra + stealth plugin + custom patches (DEFAULT)
    //   --stealthDebug                  → init script emits console.warn per patch applied
    // Stealth is ON by default in Phase 2.5 — it complements (not replaces) the fingerprint.
    stealth: {
      profile: cli.noStealth || process.env.STEALTH === 'off'
        ? 'off'
        : (cli.stealth || process.env.STEALTH || 'on'),
      debug: !!cli.stealthDebug || process.env.STEALTH_DEBUG === 'true',
      // Resolved at runtime in index.js into { enabled, debug } for launchBrowser().
      resolved: null,
    },

    // Phase 2.6 — CAPTCHA auto-solving.
    //   --captchaProvider 2captcha|anticaptcha|capsolver|mock|none (default: none)
    //   --noCaptchaSolve   → force provider 'none' (Phase 1.8 pause-and-alert),
    //                        overrides --captchaProvider / CAPTCHA_PROVIDER
    //   --captchaApiKey    → solver API key (or CAPTCHA_API_KEY env)
    //   --captchaBudget    → USD spend cap; stops solving above this (default 5.00)
    //   --captchaFallbackProvider → optional secondary solver tried when the
    //                                primary fails its retry
    // provider 'none' preserves Phase 1.8 behavior EXACTLY: detectCaptcha() +
    // pause(captchaWaitMs) + alert. The orchestrator is only constructed when a
    // real/mock provider is set.
    captcha: {
      provider: cli.noCaptchaSolve
        ? 'none'
        : (cli.captchaProvider || process.env.CAPTCHA_PROVIDER || 'none').toLowerCase(),
      apiKey: cli.captchaApiKey || process.env.CAPTCHA_API_KEY || null,
      // Default budget: $5.00 (a line-item cost, per the execution plan). 0 is
      // valid (allow no solves) but must be set explicitly.
      budget: Number.parseFloat(cli.captchaBudget ?? process.env.CAPTCHA_BUDGET ?? '5.00'),
      fallbackProvider: (cli.captchaFallbackProvider || process.env.CAPTCHA_FALLBACK_PROVIDER || '').toLowerCase() || null,
      // Resolved at runtime in index.js into { solver, budgetGuard, costLogger }.
      resolved: null,
    },

    // Phase 2.7 — session & cookie rotation.
    //   --sessionMaxRequests N   — rotate the browser context every N Maps
    //                              requests (default 50). NOTE: this is distinct
    //                              from Phase 2.3's --sessionLength (proxy sticky
    //                              rotation). The two coexist: proxies rotate per
    //                              request, contexts rotate per N requests.
    //   --sessionMaxAgeMs <ms>   — rotate the context after this many ms,
    //                              regardless of request count (default 600000 = 10min).
    //                              Whichever trigger fires first wins.
    //   --warmup on|off          — visit benign pages (google.com, etc.) before
    //                              the first Maps request in each new context
    //                              (default: on). Defeats "zero-history session
    //                              hitting Maps" heuristics.
    //   --noWarmup               — alias for --warmup off (Phase 1 behavior).
    //   --warmupDurationMs <ms>  — total warmup time budget (default 10000).
    //   --accountWarmup on|off   — opt-in Google account login per session
    //                              (default: off — account-burn risk). Requires
    //                              --accountsFile.
    //   --accountsFile <path>    — JSON array of {email, password}. MUST be
    //                              gitignored + chmod 600. Credentials are never
    //                              logged (email redacted to prefix***@domain).
    session: {
      maxRequests: toIntOrNull(cli.sessionMaxRequests ?? process.env.SESSION_MAX_REQUESTS) ?? 50,
      maxAgeMs: toIntOrNull(cli.sessionMaxAgeMs ?? process.env.SESSION_MAX_AGE_MS) ?? 600_000,
      warmup: cli.noWarmup || process.env.WARMUP === 'off'
        ? false
        : (cli.warmup || process.env.WARMUP || 'on') === 'on',
      warmupDurationMs: toIntOrNull(cli.warmupDurationMs ?? process.env.WARMUP_DURATION_MS) ?? 10_000,
      accountWarmup: (cli.accountWarmup || process.env.ACCOUNT_WARMUP || 'off') === 'on',
      accountsFile: cli.accountsFile || process.env.ACCOUNTS_FILE || null,
      // Resolved at runtime in index.js into { manager }.
      resolved: null,
    },

    // Phase 2.8 — worker pool & concurrency.
    //   --workers N                  — parallel browser workers (default: 1 =
    //                                  Phase 1 sequential behavior preserved).
    //                                  Each worker gets its own proxy +
    //                                  fingerprint + session + rate limiter.
    //   --workerProxyStrategy shared|isolated — isolated = each worker gets its
    //                                  own proxy (default); shared = all workers
    //                                  draw from the proxy pool (more IPs used).
    //   --workerCrashLimit N         — retire a worker after N crashes in 10 min
    //                                  (default 3). Retired workers drop the
    //                                  effective pool size.
    //   --workerCooldownMs <ms>      — block cooldown (default 300000 = 5 min).
    //                                  A blocked worker sits out this long
    //                                  before revival with a fresh identity.
    //   --workerLoadBalancer <s>     — round-robin (default) | least-busy.
    //   --workerDetailBatchSize N    — businesses per detail-task (default 20).
    //                                  With --workers N --deepScrape true, the
    //                                  detail work is split into batches of N
    //                                  and run in parallel across the pool.
    //   --workerTaskRetries N        — max re-queues per task (default = workers
    //                                  size). A task is re-tried on another
    //                                  worker after a block/crash.
    workers: {
      size: toIntOrNull(cli.workers ?? process.env.WORKERS) ?? 1,
      proxyStrategy:
        cli.workerProxyStrategy || process.env.WORKER_PROXY_STRATEGY || 'isolated',
      crashLimit: toIntOrNull(cli.workerCrashLimit ?? process.env.WORKER_CRASH_LIMIT) ?? 3,
      cooldownMs:
        toIntOrNull(cli.workerCooldownMs ?? process.env.WORKER_COOLDOWN_MS) ?? 5 * 60 * 1000,
      loadBalancer:
        cli.workerLoadBalancer || process.env.WORKER_LOAD_BALANCER || 'round-robin',
      detailBatchSize:
        toIntOrNull(cli.workerDetailBatchSize ?? process.env.WORKER_DETAIL_BATCH_SIZE) ?? 20,
      taskRetries:
        toIntOrNull(cli.workerTaskRetries ?? process.env.WORKER_TASK_RETRIES) ?? null,
      // Resolved at runtime in index.js into { pool } (null when size === 1).
      resolved: null,
    },

    // Phase 2.9 — job queue & orchestration (BullMQ + Redis).
    //   --queue on|off              — on = submit jobs to a BullMQ queue (Redis-
    //                                 backed); a worker pulls them off and feeds
    //                                 the pool. off (default) = Phase 2.8
    //                                 in-process dispatch (no Redis required).
    //   --redisUrl <url>            — Redis connection URL (required when
    //                                 --queue on). Default redis://localhost:6379.
    //   --queuePriority N           — default priority for submitted jobs
    //                                 (1=high, 5=normal, 10=low; default 5).
    //   --queueAttempts N           — BullMQ retry attempts per job (default 3).
    //                                 After this many failures the job is dead-
    //                                 lettered for manual inspection.
    //   --queueConcurrency N        — worker concurrency (how many jobs the
    //                                 worker pulls off the queue in parallel;
    //                                 default 1). Should be <= --workers.
    queue: {
      enabled: (cli.queue || process.env.QUEUE || 'off') === 'on',
      redisUrl: cli.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379',
      priority: toIntOrNull(cli.queuePriority ?? process.env.QUEUE_PRIORITY) ?? 5,
      attempts: toIntOrNull(cli.queueAttempts ?? process.env.QUEUE_ATTEMPTS) ?? 3,
      concurrency: toIntOrNull(cli.queueConcurrency ?? process.env.QUEUE_CONCURRENCY) ?? 1,
      // Resolved at runtime in index.js into { adapter } (null when disabled).
      resolved: null,
    },

    // Phase 2.10 — memory management & long-run stability.
    //   --contextRestartEvery N    — force-restart the browser context every N
    //                                tasks (clears Chrome memory leaks; 0 = off,
    //                                preserves Phase 2.7 behavior). Default 50
    //                                (matches the execution plan).
    //   --maxHeapMb N              — per-worker heap threshold (MB). Crossing
    //                                it fires the memory monitor's onThreshold
    //                                callback (which restarts the context).
    //                                Default 1024.
    //   --maxRssMb N               — total process RSS threshold (MB). Crossing
    //                                it triggers graceful degradation (pause
    //                                queue, restart contexts, reduce pool size).
    //                                Default 4096.
    //   --endless                  — keep pulling jobs from the queue indefinitely
    //                                (Phase 5 continuous scraping). Implies an
    //                                aggressive memory monitor + hourly zombie
    //                                reaper + HTTP /health endpoint. Requires
    //                                --queue on.
    //   --healthCheckIntervalMs N  — memory monitor + worker probe cadence.
    //                                Default 30000 (memory) / 60000 (worker probe).
    //   --healthPort N             — bind a GET /health HTTP endpoint on this
    //                                port (default: off; auto-on when --endless).
    //   --healthHost <host>        — bind host (default 127.0.0.1; set 0.0.0.0
    //                                to expose externally — make sure the port
    //                                is firewalled).
    //   --noHealthServer           — force-disable the HTTP /health endpoint
    //                                even when --endless is set.
    health: {
      contextRestartEvery:
        toIntOrNull(cli.contextRestartEvery ?? process.env.CONTEXT_RESTART_EVERY) ?? 50,
      maxHeapMb: toIntOrNull(cli.maxHeapMb ?? process.env.MAX_HEAP_MB) ?? 1024,
      maxRssMb: toIntOrNull(cli.maxRssMb ?? process.env.MAX_RSS_MB) ?? 4096,
      endless: !!cli.endless || process.env.ENDLESS === 'on' || process.env.ENDLESS === 'true',
      memoryIntervalMs:
        toIntOrNull(cli.healthCheckIntervalMs ?? process.env.HEALTH_CHECK_INTERVAL_MS) ?? 30_000,
      workerProbeIntervalMs:
        toIntOrNull(process.env.WORKER_PROBE_INTERVAL_MS) ?? 60_000,
      workerMaxHeapMb: toIntOrNull(process.env.WORKER_MAX_HEAP_MB) ?? 500,
      stuckAfterMs: toIntOrNull(process.env.WORKER_STUCK_AFTER_MS) ?? 10 * 60 * 1000,
      probeTimeoutMs: toIntOrNull(process.env.WORKER_PROBE_TIMEOUT_MS) ?? 5_000,
      probeThreshold: toIntOrNull(process.env.WORKER_PROBE_THRESHOLD) ?? 3,
      logEveryMs: toIntOrNull(process.env.MEMORY_LOG_EVERY_MS) ?? 5 * 60 * 1000,
      port: toIntOrNull(cli.healthPort ?? process.env.HEALTH_PORT) ?? null,
      host: cli.healthHost || process.env.HEALTH_HOST || '127.0.0.1',
      serverEnabled:
        (!!cli.endless || process.env.ENDLESS === 'on' || process.env.ENDLESS === 'true') &&
        !cli.noHealthServer,
      // Resolved at runtime in index.js into { stack } (null when not started).
      resolved: null,
    },

    // Phase 2.11 — self-healing selectors & health checks.
    //   --skipHealthCheck          — don't run the pre-scrape extraction-rate
    //                                health check (emergency runs only).
    //   --autoDiscover on|off      — heuristic field discovery when selectors
    //                                fail (default: on). When a discoverable
    //                                field (phone, website, rating,
    //                                reviews_count) is null on a card, scan
    //                                the card DOM for a pattern match.
    //   --selectorDebugDump on|off — write DOM snippets for low-rate fields
    //                                to data/selector-debug/ (default: on).
    //   --maxSelectorAge N         — warn when selector sets are older than N
    //                                days (default: 30).
    //   --selectorDebugDir <path>  — override the dump directory (default:
    //                                ./data/selector-debug).
    selectors: {
      skipHealthCheck:
        !!cli.skipHealthCheck || process.env.SKIP_HEALTH_CHECK === 'true' ||
        process.env.HEALTH_CHECK === 'off',
      autoDiscover:
        (cli.autoDiscover || process.env.AUTO_DISCOVER || 'on') === 'on',
      selectorDebugDump:
        (cli.selectorDebugDump || process.env.SELECTOR_DEBUG_DUMP || 'on') === 'on',
      maxSelectorAge:
        toIntOrNull(cli.maxSelectorAge ?? process.env.MAX_SELECTOR_AGE) ?? 30,
      debugDumpDir: cli.selectorDebugDir || process.env.SELECTOR_DEBUG_DIR || './data/selector-debug',
      // Path to the HTML fixture used by the startup health check. When set,
      // the health check loads this fixture instead of doing a live search.
      // Defaults to tests/fixtures/Cafe_Berlin_feed.html (captured in Phase 2.0).
      healthCheckFixture:
        process.env.HEALTH_CHECK_FIXTURE ||
        path.join(process.cwd(), 'tests', 'fixtures', 'Cafe_Berlin_feed.html'),
      // Resolved at runtime in index.js into { ran, ok, rates }.
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

  --stealth on|off           Phase 2.5 — stealth hardening (default: on)
                             Patches navigator.webdriver, chrome.runtime,
                             plugins.length, permissions.query, outerWidth/Height
                             via playwright-extra + stealth plugin + custom
                             init script. Complements (not replaces) fingerprint.
  --noStealth                Phase 2.5 — alias for --stealth off
  --stealthDebug             Phase 2.5 — log every patch applied + resulting
                             navigator properties (for debugging detection)

  --captchaProvider <p>      Phase 2.6 — CAPTCHA solver: 2captcha | anticaptcha |
                             capsolver | mock | none (default: none = Phase 1.8
                             pause-and-alert). When a CAPTCHA is detected, the
                             orchestrator solves it via the service, injects the
                             token, and resumes — unattended. ~$0.003/solve.
  --captchaApiKey <key>      Phase 2.6 — solver API key (or CAPTCHA_API_KEY env).
                             Required for 2captcha/anticaptcha/capsolver.
  --captchaBudget <usd>      Phase 2.6 — USD spend cap (default: 5.00). Stops
                             solving once cumulative cost exceeds this; falls
                             back to pause-and-alert.
  --captchaFallbackProvider <p>  Phase 2.6 — secondary solver tried when the
                             primary fails its retry (optional).
  --noCaptchaSolve           Phase 2.6 — force pause-and-alert (overrides
                             --captchaProvider). Preserves Phase 1.8 behavior.

  --sessionMaxRequests <n>   Phase 2.7 — rotate the browser context every N Maps
                             requests (default: 50). Each new context gets fresh
                             cookies + (optionally) a warmup visit. NOTE: distinct
                             from Phase 2.3's --sessionLength (proxy sticky rotation).
  --sessionMaxAgeMs <ms>     Phase 2.7 — rotate the context after this many ms,
                             regardless of request count (default: 600000 = 10min).
                             Whichever trigger (count OR age) fires first wins.
  --warmup on|off            Phase 2.7 — visit benign pages (google.com, etc.)
                             before the first Maps request in each new context
                             (default: on). Defeats zero-history-session detection.
  --noWarmup                 Phase 2.7 — alias for --warmup off (Phase 1 behavior).
  --warmupDurationMs <ms>    Phase 2.7 — total warmup time budget (default: 10000).
  --accountWarmup on|off     Phase 2.7 — opt-in Google account login per session
                             (default: off — account-burn risk). Requires --accountsFile.
                             Logged-in sessions get more data + fewer CAPTCHAs.
  --accountsFile <path>      Phase 2.7 — JSON array of {email, password}. MUST be
                             gitignored + chmod 600. Credentials are never logged
                             (email redacted to prefix***@domain).

  --workers <n>              Phase 2.8 — parallel browser workers (default: 1 =
                             Phase 1 sequential behavior). Each worker gets its
                             own proxy + fingerprint + session + rate limiter.
                             With --workers N --deepScrape true, detail-scrape
                             batches run in parallel across the pool (~N× faster).
  --workerProxyStrategy <s>  Phase 2.8 — shared | isolated (default: isolated).
                             isolated = each worker pins its own proxy; shared =
                             all workers draw from the proxy pool on each task.
  --workerCrashLimit <n>     Phase 2.8 — retire a worker after N crashes in 10 min
                             (default: 3). Retired workers drop the pool size.
  --workerCooldownMs <ms>    Phase 2.8 — block cooldown (default: 300000 = 5 min).
                             A blocked worker sits out, rotates its identity, then
                             revives. Its task is re-queued to another worker.
  --workerLoadBalancer <s>   Phase 2.8 — round-robin (default) | least-busy.
  --workerDetailBatchSize <n> Phase 2.8 — businesses per detail-task (default: 20).
  --workerTaskRetries <n>    Phase 2.8 — max re-queues per task (default = workers).

  --queue on|off             Phase 2.9 — on = submit jobs to a BullMQ-backed
                             Redis queue (decouples submission from execution).
                             A worker pulls jobs off the queue and feeds the
                             pool. off (default) = Phase 2.8 in-process dispatch
                             (no Redis required).
  --redisUrl <url>           Phase 2.9 — Redis connection URL (required when
                             --queue on). Default redis://localhost:6379.
  --queuePriority <n>        Phase 2.9 — default job priority (1=high, 5=normal,
                             10=low; default 5). BullMQ: lower = higher priority.
  --queueAttempts <n>        Phase 2.9 — BullMQ retry attempts per job (default 3).
                             After this many failures the job is dead-lettered.
  --queueConcurrency <n>     Phase 2.9 — worker concurrency (how many jobs the
                             worker pulls off the queue in parallel; default 1).
                             Should be <= --workers.

  --contextRestartEvery <n>  Phase 2.10 — force-restart the browser context every
                             N tasks to clear Chrome memory leaks (default 50;
                             0 = off, preserves Phase 2.7 behavior).
  --maxHeapMb <n>            Phase 2.10 — per-worker heap threshold (MB) for the
                             memory monitor (default 1024). Crossing it fires the
                             onThreshold callback (which restarts the context).
  --maxRssMb <n>             Phase 2.10 — total process RSS threshold (MB) for
                             graceful degradation (default 4096). Crossing it
                             pauses the queue, restarts contexts, reduces pool.
  --endless                  Phase 2.10 — keep pulling jobs from the queue
                             indefinitely (Phase 5 continuous scraping). Requires
                             --queue on. Implies an aggressive memory monitor +
                             hourly zombie reaper + HTTP /health endpoint.
  --healthCheckIntervalMs <ms> Phase 2.10 — memory monitor + worker probe cadence
                             (default 30000 for memory; 60000 for worker probe).
  --healthPort <n>           Phase 2.10 — bind a GET /health HTTP endpoint on
                             this port (default: off; auto-on when --endless).
  --healthHost <host>        Phase 2.10 — /health bind host (default 127.0.0.1).
  --noHealthServer           Phase 2.10 — force-disable the HTTP /health endpoint.

  --skipHealthCheck          Phase 2.11 — skip the pre-scrape extraction-rate
                             health check (emergency runs only). The check
                             loads a fixture, runs extraction, and aborts if
                             core fields (name, rating, reviews_count,
                             address) are below 50% — likely a DOM change.
  --autoDiscover on|off      Phase 2.11 — heuristic field auto-discovery when
                             selectors fail (default: on). When a discoverable
                             field (phone, website, rating, reviews_count) is
                             null on a card, scan the card DOM for a pattern
                             match (phone regex, non-Google <a href>, aria-
                             label containing "stars", etc.). Logs the
                             suggested selector for the operator to add to
                             src/extract.js.
  --selectorDebugDump on|off Phase 2.11 — write DOM snippets for low-rate
                             fields to data/selector-debug/ (default: on).
                             When a field's extraction rate drops below 80%,
                             the first 500 chars of each card's innerHTML is
                             written to {field}_{timestamp}.html — gives the
                             developer a sample to craft a new selector.
  --maxSelectorAge <days>    Phase 2.11 — warn when selector sets are older
                             than this many days (default: 30). Bump the
                             version + lastVerifiedDate in src/selectors/
                             version.js when you re-verify against a fixture.
  --selectorDebugDir <path>  Phase 2.11 — override the debug-dump directory
                             (default: ./data/selector-debug).

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

  # Phase 2.5 — stealth hardening (on by default)
  npm start -- --query "Cafe" --location "Berlin"               # stealth on (default)
  npm start -- --query "Cafe" --location "Berlin" --noStealth   # disable stealth (Phase 1/2.4 behavior)
  npm start -- --query "Cafe" --location "Berlin" --stealthDebug   # log every patch applied

  # Phase 2.6 — CAPTCHA auto-solving (provider 'none' = Phase 1.8 pause-and-alert)
  npm start -- --query "Cafe" --location "Berlin"               # no solver (default — pause + alert)
  npm start -- --query "Cafe" --location "Berlin" --captchaProvider mock   # dry-run solver (no API cost)
  npm start -- --query "Cafe" --location "Berlin" \
    --captchaProvider 2captcha --captchaApiKey $KEY --captchaBudget 5.00
  npm start -- --query "Cafe" --location "Berlin" --noCaptchaSolve   # force pause-and-alert

  # Phase 2.7 — session & cookie rotation (default: rotate every 50 req / 10 min + warmup)
  npm start -- --query "Cafe" --location "Berlin"               # default session rotation + warmup
  npm start -- --query "Cafe" --location "Berlin" --sessionMaxRequests 10   # rotate every 10 requests
  npm start -- --query "Cafe" --location "Berlin" --noWarmup    # skip warmup (Phase 1 behavior)
  npm start -- --query "Cafe" --location "Berlin" --accountWarmup on --accountsFile ./accounts.json

  # Phase 2.8 — worker pool & concurrency (default: 1 = Phase 1 sequential)
  npm start -- --query "Cafe" --location "Berlin"               # 1 worker (Phase 1 behavior, unchanged)
  npm start -- --query "Cafe" --location "Berlin" --workers 3   # 3 parallel workers
  npm start -- --query "Restaurant" --location "Toronto" --workers 5 --deepScrape true   # 5× parallel detail-scrape
  npm start -- --query "Cafe" --location "Berlin" --workers 4 --workerLoadBalancer least-busy
  npm start -- --query "Cafe" --location "Berlin" --workers 3 --workerCrashLimit 5 --workerCooldownMs 120000

  # Phase 2.9 — job queue & orchestration (default: off = Phase 2.8 in-process)
  #   Requires Redis running (docker-compose up redis). --queue on submits the
  #   search-task to a BullMQ queue; a worker pulls it off and feeds the pool.
  #   For batch submission use: npm run batch -- --file queries.csv (one job
  #   per row) and monitor with: npm run queue:status (live, refreshes 2s).
  npm start -- --query "Cafe" --location "Berlin" --workers 3 --queue on   # queue + 3 workers
  npm start -- --query "Cafe" --location "Berlin" --queue on --queuePriority 1   # high-priority job
  npm start -- --query "Cafe" --location "Berlin" --queue on --queueAttempts 5   # more retries
  npm run batch -- --file queries.csv --workers 5 --queue on   # batch submit + process
  npm run queue:status                                         # live status (top-style, 2s refresh)

  # Smoke test — runs the pipeline but writes NO files (no CSV, no JSON)
  npm start -- --query "Cafe" --location "Berlin" --maxResults 10 --yes --dryRun
`;

module.exports = { loadConfig, parseArgs, validate, HELP_TEXT, resolveOutputTargets };
