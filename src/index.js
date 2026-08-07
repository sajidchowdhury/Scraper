'use strict';

/**
 * src/index.js — CLI entry point (Phases 1.0 → 1.8)
 *
 * Pipeline:
 *   loadConfig → [shouldResume] → launchBrowser → performSearch
 *              → scrollFeedToBottom → extractBusinesses [+ dedup vs checkpoint]
 *              → [deepScrapeAll if cfg.deepScrape, with checkpoint onProgress]
 *              → logExtractionRates → exportResults (CSV + JSON + summary)
 *              → [clearCheckpoint on success] → closeBrowser
 *
 * Phase 1.7 — Reliability & crash recovery:
 *   - On startup, shouldResume() checks for a .checkpoint.json. If present
 *     and (--resume OR interactive yes), the already-extracted businesses
 *     are loaded as the starting set and skipped during re-extraction.
 *   - During deep-scrape, a checkpoint is written every cfg.checkpointInterval
 *     businesses so a crash mid-run can be resumed.
 *   - On successful completion, the checkpoint is cleared (no leftover file).
 *   - On crash, the checkpoint stays on disk for the next --resume.
 *   - All transient operations (page.goto, waitForSelector, page.evaluate,
 *     detail-panel open/back) are wrapped in withRetry (3 attempts, 1s→2s→4s).
 *   - Per-business error isolation: a failed extraction or detail-scrape is
 *     logged + counted, never crashes the run.
 *
 * Phase 1.8 — Minimal anti-block behavior:
 *   - RateLimiter (default 30 req/min) gates every Google-bound HTTP request
 *     (page.goto in search + each detail-panel open in deep-scrape).
 *   - Human typing in the search box (char-by-char, 50-150ms jitter) unless
 *     --noHumanTyping.
 *   - Randomized delays between scroll actions (800-2000ms), before Enter
 *     (500-1500ms), and between detail visits (1500-3500ms).
 *   - User-agent randomized per run from a list of 8 recent real Chrome UAs.
 *   - 429/503 response watcher attached to the page (logs + alerts).
 *   - CAPTCHA detection after search and after each detail scrape; on detect,
 *     pauses (default 5min) + prints a clear alert, then aborts with the
 *     checkpoint preserved for --resume. Auto-solve is Phase 2.
 *
 * Phase 1.9 — Logging & observability:
 *   - Every module binds its log lines to a pipeline phase (search/scroll/
 *     extract/detail/export/recovery/antiblock/retry/browser) via logger.phase().
 *   - Each business extraction emits an INFO line (index, name, success/fail).
 *   - At --logLevel debug, each business also emits a per-field breakdown.
 *   - The end-of-run banner now includes the log file path.
 *   - A structured "Run complete" log line (phase: system) records duration,
 *     counts, and exit code for machine-parseable post-run analysis.
 *
 * Phase 1.10 — CLI Polish & DX:
 *   - A startup banner prints the resolved config (query, location, maxResults,
 *     dryRun, deepScrape, retry, antiblock, ...) before any browser launches,
 *     then waits 1s so the operator can Ctrl-C if it looks wrong.
 *   - `--yes` (alias `-y`) skips the 1s delay for scripted / CI runs.
 *   - Exit codes: 0 success, 1 partial success, 2 config error, 3 runtime
 *     error, 130 SIGINT — all unchanged from prior phases.
 *
 * Exit codes (Phase 1.10 prep):
 *   0 = success (all businesses extracted/scraped cleanly)
 *   1 = partial success (run completed but some businesses failed)
 *   2 = config error
 *   3 = runtime error (crash / CAPTCHA abort)
 */

const path = require('path');

const { loadConfig, HELP_TEXT } = require('./config');
const { createLogger } = require('./logger');
const { withBrowser } = require('./browser');
const { performSearch } = require('./search');
const { scrollFeedToBottomOnPage } = require('./scroll');
const { extractBusinesses, logExtractionRates, CANONICAL_FIELDS } = require('./extract');
const { deepScrapeAll, DETAIL_FIELDS, EMPTY_DETAIL } = require('./detail');
const { exportResults } = require('./export');
const {
  shouldResume,
  writeCheckpoint,
  clearCheckpoint,
  buildDedupSet,
  dedupKey,
} = require('./checkpoint');
const { RateLimiter, detectCaptcha, detectCaptchaType } = require('./antiblock');
const { showStartupBanner } = require('./banner');
// Phase 2.4 — browser fingerprint randomization. Loaded eagerly so the
// fingerprint can be generated + logged before the browser launches (and so
// --fixedFingerprint coherence failures surface at config time, not at launch).
const { generateFingerprint, summarizeFingerprint } = require('./fingerprint');
// Phase 2.6 — CAPTCHA auto-solving. createSolver/BudgetGuard/handleCaptcha are
// only invoked when cfg.captcha.provider != 'none' (otherwise Phase 1.8's
// pause-and-alert behavior is preserved exactly).
const {
  createSolver,
  createSolverChain,
  BudgetGuard,
  createCostLogger,
  handleCaptcha,
} = require('./captcha');
// Phase 2.7 — session & cookie rotation. The session manager wraps context
// creation so contexts are rotated every N requests / M ms (fresh cookies each
// time). warmupContext visits benign pages before the first Maps request in
// each new context. accountWarmup is opt-in (off by default — account-burn risk).
const {
  createSessionManager,
  warmupContext,
  accountWarmup,
  loadAccounts,
  pickAccount,
  redactEmail,
  createRealContextFactory,
} = require('./session');
// Phase 2.1 — PostgreSQL persistence (lazy-loaded; only used when
// cfg.output includes 'db').
const { createPool, persistRunResults, closePool } = require('./db');
// Phase 2.3 — proxy management & rotation. Only initialized when cfg.proxy
// is enabled (i.e. --noProxy is not set AND a proxy source is configured).
const { createProxyPool } = require('./proxy');
// Phase 2.8 — worker pool & concurrency. Only used when --workers > 1; with
// --workers 1 (the default) the existing single-browser pipeline runs unchanged.
// Aliased as createWorkerPool to avoid colliding with the DB pool's createPool.
const { createPool: createWorkerPool } = require('./pool');
const {
  createWorker,
  createSearchTask,
  createDetailTask,
  validateTask,
} = require('./worker');

// Phase 2.9 — job queue & orchestration (BullMQ + Redis). Only used when
// --queue on; with --queue off (the default) the Phase 2.8 in-process pool
// dispatch runs unchanged (no Redis required).
const { createQueue } = require('./queue');

// Phase 2.10 — memory management & long-run stability. The health stack wires
// together a memory monitor, worker probe, zombie reaper, graceful-degradation
// handler, and (optionally) an HTTP /health endpoint. Only the zombie reaper
// runs unconditionally (startup reap); the rest require --workers > 1 OR
// --endless OR a non-default --contextRestartEvery / --maxHeapMb setting.
const {
  createHealthStack,
  createZombieReaper,
  startMemoryMonitor,
  startWorkerProbe,
  createDegradation,
  createHealthServer,
} = require('./health');

// Phase 2.11 — self-healing selectors & health checks. The selectors module
// wires together: selector versioning (with staleness warning), a startup
// extraction-rate health check (loads a fixture, aborts if core fields are
// below 50%), heuristic field auto-discovery (pattern-based fallback when
// selectors fail), and DOM-snippet debug dumps for low-rate fields.
const fs = require('fs');
const {
  logSelectorVersion,
  healthCheck,
  SELECTOR_FAILURE_EXIT_CODE,
} = require('./selectors');

async function main() {
  const cfg = loadConfig(process.argv.slice(2));

  if (cfg.help) {
    process.stdout.write(HELP_TEXT + '\n');
    process.exit(0);
  }
  if (cfg.version) {
    const pkg = require('../package.json');
    process.stdout.write(`gmaps-scraper v${pkg.version}\n`);
    process.exit(0);
  }

  if (cfg.errors.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Configuration errors:\n  - ' + cfg.errors.join('\n  - '));
    process.exit(2);
  }

  const logger = createLogger({
    level: cfg.logLevel,
    query: cfg.query,
    location: cfg.location,
    logDir: './logs',
  });

  logger.info('Config resolved', {
    query: cfg.query,
    location: cfg.location,
    maxResults: cfg.maxResults,
    headless: cfg.headless,
    dryRun: cfg.dryRun,
    output: cfg.output,
    deepScrape: cfg.deepScrape,
    resume: cfg.resume,
    fresh: cfg.fresh,
    checkpointInterval: cfg.checkpointInterval,
    retry: cfg.retry,
    antiblock: {
      maxRPM: cfg.antiblock.maxRequestsPerMin,
      humanTyping: cfg.antiblock.humanTyping,
      captchaPause: cfg.antiblock.captchaPause,
      scrollDelay: [cfg.antiblock.scrollDelayMinMs, cfg.antiblock.scrollDelayMaxMs],
      detailDelay: [cfg.antiblock.detailDelayMinMs, cfg.antiblock.detailDelayMaxMs],
    },
    proxy: {
      enabled: cfg.proxy.enabled,
      strategy: cfg.proxy.strategy,
      sessionLength: cfg.proxy.sessionLength,
      cooldownMs: cfg.proxy.cooldownMs,
      listFile: cfg.proxy.listFile,
      provider: cfg.proxy.provider,
      healthCheck: cfg.proxy.healthCheck,
    },
    selectors: {
      skipHealthCheck: cfg.selectors.skipHealthCheck,
      autoDiscover: cfg.selectors.autoDiscover,
      selectorDebugDump: cfg.selectors.selectorDebugDump,
      maxSelectorAge: cfg.selectors.maxSelectorAge,
    },
  });

  // Phase 2.11 — log the active selector versions + emit a staleness warning
  // for any set older than --maxSelectorAge (default 30 days). This is the
  // first line of defense against silent selector rot: if the selectors
  // were last verified 60 days ago, the operator is warned to re-run the
  // fixture test before trusting the extraction rates.
  logSelectorVersion(logger, { maxAgeDays: cfg.selectors.maxSelectorAge });

  // Phase 1.8 — construct the rate limiter once and attach to cfg so every
  // module that makes Google-bound requests (search, detail) can acquire.
  cfg.rateLimiter = new RateLimiter(cfg.antiblock.maxRequestsPerMin, { logger });

  // Phase 2.3 — construct the proxy pool (if enabled). The pool is then
  // queried before each browser launch to pick a proxy; release() is called
  // in the finally block with the outcome so the burn detector can track it.
  let proxyPool = null;
  if (cfg.proxy.enabled) {
    const proxySources = {};
    if (cfg.proxy.listFile) proxySources.file = cfg.proxy.listFile;
    if (cfg.proxy.provider && cfg.proxy.providerUrl) {
      // The provider() function is wired up here. Currently a stub that reads
      // from a local file or returns an empty list — real provider APIs
      // (Bright Data / Smartproxy / Oxylabs) are integrated in Phase 2.7.
      proxySources.provider = async () => {
        logger.warn('Proxy provider configured but not yet implemented', {
          provider: cfg.proxy.provider,
          hint: 'Use --proxyListFile for now. Provider API integration is Phase 2.7.',
        });
        return [];
      };
    }
    proxyPool = createProxyPool({
      sources: proxySources,
      strategy: cfg.proxy.strategy,
      sessionLength: cfg.proxy.sessionLength,
      cooldownMs: cfg.proxy.cooldownMs,
      burnLogPath: cfg.proxy.burnLogPath || undefined,
      logger,
    });

    // Optional pre-run health check. Probes every proxy with a HEAD to Google;
    // benches failures for one cooldown cycle. Useful before long overnight runs.
    if (cfg.proxy.healthCheck) {
      logger.info('Phase 2.3 — running proxy health check', {
        hint: 'Probes every proxy with a HEAD to google.com before scraping',
      });
      try {
        const hc = await proxyPool.healthCheck();
        logger.info('Proxy health check result', {
          total: hc.total,
          healthy: hc.healthy.length,
          dead: hc.dead.length,
        });
        if (hc.healthy.length === 0) {
          logger.error('All proxies failed health check — aborting', {
            dead: hc.dead,
            hint: 'Check your proxy list or provider credentials, or rerun with --noProxy',
          });
          process.exit(3);
        }
      } catch (err) {
        logger.error('Proxy health check failed (non-fatal — continuing)', {
          message: err.message,
        });
      }
    }
  } else {
    logger.info('Phase 2.3 — proxy rotation disabled (direct connection)', {
      reason: cfg.proxy.enabled === false ? 'no proxy source configured (use --proxyListFile or PROXY_LIST_FILE)' : '--noProxy flag set',
    });
  }

  // Phase 2.4 — generate the per-run fingerprint. Generated ONCE here (before
  // the browser launches) so the same fingerprint is used for the whole
  // session. Per-worker persistence (Phase 2.8) will move this into the worker
  // pool — for now, the single-browser pipeline gets one fingerprint.
  //
  // --noFingerprint / fingerprintProfile 'off' → no fingerprint (Phase 1
  //   behavior: pickUserAgent() + cfg.viewport + 'en-US' + 'America/Toronto').
  // --fingerprintProfile random  → generateFingerprint() picks a coherent
  //   profile (UA + platform + viewport + timezone + locale + WebGL + canvas
  //   noise + hw concurrency + device memory + geolocation).
  // --fingerprintProfile fixed   → use the profile supplied via
  //   --fixedFingerprint <json>. Coherence is validated; an incoherent fixed
  //   profile is rejected (treated as 'off' with a warning) rather than
  //   shipping a detectable mismatch.
  let fingerprint = null;
  if (cfg.fingerprint.profile === 'off') {
    logger.info('Phase 2.4 — fingerprint randomization disabled (Phase 1 behavior)', {
      reason: '--noFingerprint flag or NO_FINGERPRINT=true',
    });
  } else if (cfg.fingerprint.profile === 'fixed') {
    let fixed = null;
    try {
      fixed = JSON.parse(cfg.fingerprint.fixedJson);
    } catch (err) {
      // Should never happen — validate() catches this at config time. But we
      // defend in depth so a runtime .env change can't crash the run.
      logger.error('Phase 2.4 — --fixedFingerprint JSON parse failed', { error: err.message });
    }
    if (fixed) {
      fingerprint = generateFingerprint({ fixed, logger });
      if (!fingerprint) {
        logger.warn('Phase 2.4 — fixed fingerprint failed coherence check; falling back to Phase 1 behavior', {
          hint: 'Fix the --fixedFingerprint JSON or rerun with --fingerprintProfile random',
        });
      }
    }
  } else {
    // 'random' (the default)
    fingerprint = generateFingerprint({ logger });
    if (!fingerprint) {
      logger.warn('Phase 2.4 — fingerprint generation failed; falling back to Phase 1 behavior', {
        hint: 'This is unexpected — check that the user-agents library is installed',
      });
    }
  }
  if (fingerprint) {
    logger.info('Phase 2.4 — fingerprint generated', {
      summary: summarizeFingerprint(fingerprint),
      profile: cfg.fingerprint.profile,
      userAgent: fingerprint.userAgent,
      platform: fingerprint.platform,
      viewport: fingerprint.viewport,
      timezone: fingerprint.timezone,
      locale: fingerprint.locale,
      webglVendor: fingerprint.webglVendor,
      hardwareConcurrency: fingerprint.hardwareConcurrency,
      deviceMemory: fingerprint.deviceMemory,
    });
  }
  // Store on cfg so downstream code (banner, future worker pool) can read it.
  cfg.fingerprint.resolved = fingerprint;

  // Phase 2.5 — resolve the stealth config. Stealth is ON by default in
  // Phase 2.5; --noStealth / STEALTH=off disables it. --stealthDebug turns on
  // per-patch console.warn output from the init script (for debugging which
  // patches applied + the resulting navigator properties).
  //
  // Stealth complements (not replaces) the fingerprint:
  //   fingerprint → WHO the browser claims to be (UA, platform, WebGL vendor, ...)
  //   stealth     → WHETHER the browser looks automated (webdriver, chrome.runtime,
  //                 plugins.length, permissions.query, outerWidth/Height, ...)
  // A real Chrome user has BOTH a coherent identity AND no automation signals.
  const stealthConfig = {
    enabled: cfg.stealth.profile === 'on',
    debug: cfg.stealth.debug,
  };
  cfg.stealth.resolved = stealthConfig;
  if (stealthConfig.enabled) {
    logger.info('Phase 2.5 — stealth hardening enabled', {
      profile: cfg.stealth.profile,
      debug: stealthConfig.debug,
      hint: stealthConfig.debug
        ? 'Init script will emit console.warn per patch — visible in browser console'
        : 'Use --stealthDebug to see which patches applied',
    });
  } else {
    logger.info('Phase 2.5 — stealth hardening disabled (Phase 1/2.4 behavior)', {
      reason: '--noStealth flag or STEALTH=off',
    });
  }

  // Phase 2.6 — resolve the CAPTCHA solver. When provider is 'none' (the
  // default) OR --noCaptchaSolve is set, NO solver is constructed and the
  // pipeline falls back to Phase 1.8's pause-and-alert behavior exactly. When
  // a real/mock provider is set, we build the solver + a budget guard + a
  // cost logger; the deep-scrape CAPTCHA hook then calls handleCaptcha()
  // instead of the simple pause.
  //
  // The budget guard caps cumulative solver spend at cfg.captcha.budget (USD).
  // Once exceeded, handleCaptcha() falls back to pause-and-alert — it does NOT
  // spend more money.
  // The cost logger appends one JSONL record per solve attempt to
  // data/captcha_cost_log.jsonl and feeds the end-of-run summary.
  let captchaSolver = null;
  let captchaBudgetGuard = null;
  let captchaCostLogger = null;
  if (cfg.captcha.provider !== 'none') {
    const primary = createSolver({
      provider: cfg.captcha.provider,
      apiKey: cfg.captcha.apiKey,
      logger: logger.phase('captcha'),
      // For the mock provider, default to 0ms delay so tests/dry runs are instant.
      mockDelayMs: cfg.captcha.provider === 'mock' ? 0 : undefined,
    });
    let solver = primary;
    if (cfg.captcha.fallbackProvider) {
      const fallback = createSolver({
        provider: cfg.captcha.fallbackProvider,
        apiKey: cfg.captcha.apiKey,
        logger: logger.phase('captcha'),
        mockDelayMs: cfg.captcha.fallbackProvider === 'mock' ? 0 : undefined,
      });
      solver = createSolverChain({ primary, fallback, logger: logger.phase('captcha') });
    }
    captchaSolver = solver;
    captchaBudgetGuard = new BudgetGuard({
      budget: cfg.captcha.budget,
      logger: logger.phase('captcha'),
    });
    captchaCostLogger = createCostLogger({
      logger: logger.phase('captcha'),
    });
    // Log the balance ONCE at startup (per the execution plan). Best-effort —
    // a balance fetch failure is non-fatal (the solver still works).
    try {
      const bal = await solver.balance();
      if (bal !== null && bal !== undefined) {
        logger.phase('captcha').info('CAPTCHA solver balance', {
          provider: cfg.captcha.provider,
          balance: `$${Number(bal).toFixed(4)}`,
          budget: `$${cfg.captcha.budget.toFixed(2)}`,
          hint: bal < cfg.captcha.budget ? 'Balance below budget — top up if you expect many CAPTCHAs' : 'OK',
        });
      }
    } catch (err) {
      logger.phase('captcha').warn('CAPTCHA balance check failed (non-fatal)', {
        provider: cfg.captcha.provider,
        error: err.message,
      });
    }
    logger.phase('captcha').info('Phase 2.6 — CAPTCHA auto-solving enabled', {
      provider: cfg.captcha.provider,
      fallback: cfg.captcha.fallbackProvider || null,
      budget: `$${cfg.captcha.budget.toFixed(2)}`,
      costLog: captchaCostLogger.filePath,
    });
  } else {
    logger.phase('captcha').info('Phase 2.6 — CAPTCHA auto-solving disabled (Phase 1.8 pause-and-alert)', {
      reason: 'provider=none (default) or --noCaptchaSolve',
      hint: 'Set --captchaProvider mock for a dry-run solver, or 2captcha/anticaptcha/capsolver for real solves',
    });
  }
  // Store the resolved solver/guard/logger on cfg so the banner + deep-scrape
  // hook + end-of-run summary can read them.
  cfg.captcha.resolved = {
    solver: captchaSolver,
    budgetGuard: captchaBudgetGuard,
    costLogger: captchaCostLogger,
  };

  // Phase 2.7 — resolve the session manager. The manager wraps context creation
  // so contexts (cookies + storage) are rotated every cfg.session.maxRequests
  // requests OR cfg.session.maxAgeMs ms — whichever comes first. Each new
  // context is optionally warmed up (visits google.com etc. before Maps).
  //
  // The manager uses a real createContext factory (createRealContextFactory)
  // that calls browser.newContext(opts) + applies the Phase 2.4 fingerprint +
  // Phase 2.5 stealth patches. The factory is constructed here (needs cfg +
  // logger + stealth config); the manager calls it on each rotation.
  //
  // accountWarmup is opt-in (default off). When on, each new context logs into
  // a Google account (from the gitignored accounts file) before the scrape.
  // Credentials are never logged (email redacted to prefix***@domain).
  const sessionCreateContext = createRealContextFactory({
    cfg,
    logger,
    stealth: cfg.stealth.resolved || { enabled: false, debug: false },
  });
  // The warmup function bound to the run's config. Returns { visited, waitedMs }.
  // Passed to the manager as warmupFn so it runs on EVERY new context (including
  // mid-scrape rotations), not just the initial one.
  const sessionWarmupFn = cfg.session.warmup
    ? async (page, ctx) => warmupContext(page, {
        logger: ctx.logger || logger,
        durationMs: cfg.session.warmupDurationMs,
        sleepFn: ctx.sleepFn,
      })
    : null;
  let sessionAccounts = null;
  let sessionUsedToday = new Set();
  if (cfg.session.accountWarmup) {
    try {
      sessionAccounts = loadAccounts({ filePath: cfg.session.accountsFile, logger });
      logger.phase('session').info('Phase 2.7 — account warmup enabled', {
        accounts: sessionAccounts.length,
        hint: 'Use burner/dedicated scraping accounts only — never primary accounts',
      });
    } catch (err) {
      logger.phase('session').error('Phase 2.7 — account warmup: accounts file load failed', {
        error: err.message,
        hint: 'Disable with --accountWarmup off or fix the accounts file',
      });
      // Fail fast — a missing/malformed accounts file is a config error the
      // operator should fix before running. validate() catches most cases, but
      // a runtime parse failure (file changed after config) surfaces here.
      process.exit(2);
    }
  }
  const sessionManager = createSessionManager({
    maxRequests: cfg.session.maxRequests,
    maxAgeMs: cfg.session.maxAgeMs,
    warmup: cfg.session.warmup,
    warmupFn: sessionWarmupFn,
    createContext: sessionCreateContext,
    logger: logger.phase('session'),
  });
  cfg.session.resolved = { manager: sessionManager, accounts: sessionAccounts, usedToday: sessionUsedToday };
  logger.phase('session').info('Phase 2.7 — session rotation enabled', {
    maxRequests: cfg.session.maxRequests,
    maxAgeMs: cfg.session.maxAgeMs,
    warmup: cfg.session.warmup,
    warmupDurationMs: cfg.session.warmupDurationMs,
    accountWarmup: cfg.session.accountWarmup,
  });

  // Phase 1.10 — startup banner. Prints the resolved config and waits 1s so
  // the operator can eyeball it and Ctrl-C if it looks wrong. Skipped (no
  // delay) when --yes is set, for scripted / CI runs.
  const pkg = require('../package.json');
  await showStartupBanner(cfg, { name: pkg.name, version: pkg.version });

  // Phase 1.7 — checkpoint resume decision (before launching the browser,
  // so we know whether to seed the businesses array).
  const { resume, checkpoint, skipped } = await shouldResume(cfg, {}, logger);
  const existingBusinesses = resume && checkpoint ? checkpoint.businesses || [] : [];
  const dedupSet = buildDedupSet(existingBusinesses);

  if (resume) {
    logger.phase('recovery').info('Resuming from checkpoint', {
      existingBusinesses: existingBusinesses.length,
      deepScrapedAlready: existingBusinesses.filter((b) => b.detail_scraped === true).length,
    });
  }

  const globalTimer = setTimeout(() => {
    logger.error('Global timeout exceeded — aborting', { ms: cfg.globalTimeoutMs });
    process.exit(3);
  }, cfg.globalTimeoutMs);

  // Graceful Ctrl-C — on SIGINT the checkpoint stays on disk for --resume.
  // Phase 2.10 — also runs the zombie reaper shutdown sweep so no Chromium
  // processes survive a Ctrl-C (acceptance criterion: "On Ctrl-C, zero
  // orphaned Chromium processes remain").
  let browserClosed = false;
  const onSigInt = async () => {
    logger.warn('SIGINT received — shutting down (checkpoint preserved for --resume)');
    // Phase 2.10 — best-effort zombie reap before exit. We can't await in a
    // SIGINT handler reliably (the process may exit first), so we fire-and-
    // forget with a 2s deadline. The finally blocks of runWithPool /
    // runWithQueue / sequential pipeline also call stopHealthStack which
    // runs the same reap — this is the backstop for when the run hasn't
    // started yet or is stuck.
    try {
      const reaper = createZombieReaper({ logger });
      const report = await Promise.race([
        reaper.reapOnShutdown({ ownPid: process.pid }),
        new Promise((resolve) => setTimeout(() => resolve({ killed: [] }), 2000)),
      ]);
      if (report && report.killed && report.killed.length > 0) {
        logger.info('SIGINT zombie reaper: cleaned up Chromium processes', {
          killed: report.killed,
        });
      }
    } catch {
      /* best-effort */
    }
    process.exit(130);
  };
  process.on('SIGINT', onSigInt);

  // Phase 2.8 — worker pool & concurrency. --workers 1 (the default) preserves
  // Phase 1 sequential behavior EXACTLY (the existing single-browser pipeline
  // below runs unchanged). --workers N > 1 constructs a pool of N isolated
  // browser workers, each with its own proxy + fingerprint + session + rate
  // limiter, and dispatches tasks across them with self-healing on per-worker
  // failures (block → cooldown + re-queue; crash → restart, retire after limit).
  if (cfg.workers.size > 1) {
    logger.info('Phase 2.8 — worker pool enabled', {
      size: cfg.workers.size,
      proxyStrategy: cfg.workers.proxyStrategy,
      loadBalancer: cfg.workers.loadBalancer,
      crashLimit: cfg.workers.crashLimit,
      cooldownMs: cfg.workers.cooldownMs,
      detailBatchSize: cfg.workers.detailBatchSize,
      taskRetries: cfg.workers.taskRetries === null ? cfg.workers.size : cfg.workers.taskRetries,
    });
  } else {
    logger.info('Phase 2.8 — worker pool disabled (size 1 — Phase 1 sequential behavior)', {
      hint: 'Use --workers N to run N parallel browser workers',
    });
  }

  // Phase 2.9 — job queue & orchestration. --queue on (default: off) submits
  // jobs to a BullMQ-backed Redis queue; a worker pulls them off and feeds the
  // pool. This decouples submission from execution: batch CLI submits 100 jobs
  // and exits; a separate worker process pulls them off over hours. With
  // --queue off the Phase 2.8 in-process dispatch runs unchanged (no Redis).
  if (cfg.queue.enabled) {
    logger.info('Phase 2.9 — job queue enabled', {
      redisUrl: cfg.queue.redisUrl,
      priority: cfg.queue.priority,
      attempts: cfg.queue.attempts,
      concurrency: cfg.queue.concurrency,
      hint: 'Jobs are persisted in Redis — a crash resumes the queue on restart',
    });
  } else {
    logger.info('Phase 2.9 — job queue disabled (Phase 2.8 in-process dispatch)', {
      hint: 'Use --queue on (requires REDIS_URL) for batch processing + crash resilience',
    });
  }

  // Phase 2.10 — memory management & long-run stability.
  // The zombie reaper ALWAYS runs: it scans for orphaned Chromium processes
  // left over from a previous crashed run and kills them before we launch
  // our own browsers (otherwise we'd compete for the display socket + RAM).
  // The rest of the health stack (memory monitor, worker probe, degradation
  // handler, HTTP /health server) is wired up after the pool/queue are built
  // — see "Phase 2.10 — wire the health stack" further down.
  const zombieReaper = createZombieReaper({ logger });
  let startupReapReport = null;
  try {
    startupReapReport = await zombieReaper.reapOnStartup({ ownPid: process.pid });
    zombieReaper.logReport(startupReapReport, { when: 'startup' });
  } catch (err) {
    logger.warn('Phase 2.10 — zombie reaper startup sweep failed (non-fatal)', {
      error: err.message,
    });
  }

  if (cfg.health.endless) {
    logger.info('Phase 2.10 — endless mode enabled', {
      hint: 'The scraper will pull jobs from the queue indefinitely (Phase 5 continuous scraping)',
      memoryIntervalMs: cfg.health.memoryIntervalMs,
      contextRestartEvery: cfg.health.contextRestartEvery,
      maxHeapMb: cfg.health.maxHeapMb,
      maxRssMb: cfg.health.maxRssMb,
      healthPort: cfg.health.port,
    });
  } else if (cfg.health.contextRestartEvery > 0 || cfg.health.port) {
    logger.info('Phase 2.10 — memory management enabled', {
      contextRestartEvery: cfg.health.contextRestartEvery,
      maxHeapMb: cfg.health.maxHeapMb,
      maxRssMb: cfg.health.maxRssMb,
      memoryIntervalMs: cfg.health.memoryIntervalMs,
      healthPort: cfg.health.port,
    });
  } else {
    logger.info('Phase 2.10 — memory management at defaults (contextRestartEvery=50, monitor + zombie reaper active)', {
      hint: 'Use --endless (with --queue on) for continuous scraping, or --maxHeapMb / --maxRssMb to tune thresholds',
    });
  }

  // Phase 2.10 — buildHealthStack: construct + start the memory monitor,
  // worker probe, degradation handler, and HTTP /health server. Called by
  // runWithPool + runWithQueue AFTER the pool (and queue, if any) are built
  // — the health stack needs live references to them. The returned object's
  // .stop() is wired into the finally block of each runner so intervals are
  // cleared + the HTTP server is closed on shutdown.
  //
  // The onThreshold callback fires when the process-wide heap crosses
  // cfg.health.maxHeapMb; it does nothing dramatic on its own (just logs)
  // because the per-worker memory-based restart is handled by each worker's
  // session manager (shouldRestartForMemory → restartForMemory) via the
  // worker probe's onIssue callback below.
  //
  // The onIssue callback fires when a worker is bloated / stuck / unresponsive.
  // For 'heap' issues it calls the worker's session manager restartForMemory
  // (which closes + reopens the context, reclaiming Chrome memory). For
  // 'stuck' / 'unresponsive' issues it logs — the pool's crash/re-queue
  // machinery handles the actual restart (a stuck task eventually times out
  // → throws → markCrashed → rotateIdentity).
  const buildHealthStack = async (pool, queue) => {
    const getWorkers = () => (pool && pool.workers ? pool.workers : []);
    const onMemoryThreshold = (snap) => {
      logger.warn('Phase 2.10 — process-wide heap threshold exceeded', {
        heapMb: snap.heapUsedMb,
        thresholdMb: cfg.health.maxHeapMb,
        hint: 'Per-worker context restarts are handled by the worker probe; this is the process-wide backstop',
      });
    };
    const onWorkerIssue = async (worker, issue) => {
      logger.warn('Phase 2.10 — worker health issue detected', {
        workerId: worker.id,
        issueType: issue.type,
        issue,
      });
      if (issue.type === 'heap' && worker.sessionManager) {
        try {
          await worker.sessionManager.restartForMemory({ reason: 'worker-probe-heap' });
        } catch (err) {
          logger.warn('Phase 2.10 — worker context restart failed (non-fatal)', {
            workerId: worker.id,
            error: err.message,
          });
        }
      }
      // 'stuck' + 'unresponsive' are logged only — the pool's task timeout
      // + crash machinery handles the actual worker restart. A future phase
      // could force-kill the worker's browser process here.
    };
    // Degradation callbacks — only wired when both pool + queue exist (the
    // graceful-degradation sequence pauses the queue, which requires a queue).
    const pauseFn = queue ? async () => { await queue.pause(); } : null;
    const resumeFn = queue ? async () => { await queue.resume(); } : null;
    const restartWorkerFn = async (worker) => {
      if (worker.sessionManager && typeof worker.sessionManager.restartForMemory === 'function') {
        await worker.sessionManager.restartForMemory({ reason: 'degradation' });
      }
    };
    const reducePoolFn = () => {
      // Retire the first non-retired worker to shed load. The pool's
      // dispatch will route around it. Returns the new active size.
      const w = pool.workers.find((x) => !x.isRetired());
      if (w) {
        try {
          w.markCrashed(new Error('memory pressure — pool reduction'));
        } catch {
          /* best-effort */
        }
      }
      return pool.activeSize;
    };
    const gcFn = typeof global.gc === 'function' ? () => global.gc() : null;

    const stack = createHealthStack({
      cfg,
      logger,
      pool,
      queue,
      getWorkers,
      getRss: () => process.memoryUsage().rss,
      gcFn,
      onMemoryThreshold,
      onWorkerIssue,
      pauseFn,
      resumeFn,
      restartWorkerFn,
      reducePoolFn,
      startedAt: Date.now(),
      version: '1.0.0-phase2.10',
      endless: cfg.health.endless,
    });
    try {
      await stack.start();
    } catch (err) {
      logger.warn('Phase 2.10 — health stack start failed (non-fatal — continuing)', {
        error: err.message,
      });
    }
    cfg.health.resolved = { stack };
    return stack;
  };

  // Phase 2.10 — stopHealthStack: best-effort shutdown of the health stack.
  // Called from the finally block of runWithPool + runWithQueue. Also runs
  // the zombie reaper's shutdown sweep to ensure no Chromium processes
  // survive the run.
  const stopHealthStack = async (stack, knownBrowserPids = []) => {
    if (stack && typeof stack.stop === 'function') {
      try {
        await stack.stop();
      } catch (err) {
        logger.warn('Phase 2.10 — health stack stop failed (non-fatal)', { error: err.message });
      }
    }
    // Zombie reaper shutdown sweep — kill any Chromium processes we spawned
    // that browser.close() didn't reap (defensive backstop).
    try {
      const report = await zombieReaper.reapOnShutdown({
        ownPid: process.pid,
        knownPids: knownBrowserPids,
      });
      zombieReaper.logReport(report, { when: 'shutdown' });
    } catch (err) {
      logger.warn('Phase 2.10 — zombie reaper shutdown sweep failed (non-fatal)', {
        error: err.message,
      });
    }
  };

  // Phase 2.8 — runWithPool: the multi-worker pipeline. Builds a pool, dispatches
  // a search-task (search + scroll + extract) to one worker, then — if deepScrape
  // — splits the businesses into detail-task batches and runs them in parallel
  // across the pool. Returns the same `result` shape as the sequential pipeline
  // so the downstream export/summary/banner logic is shared.
  const runWithPool = async () => {
    // getIdentity — called per worker (initial + after every block/crash
    // rotation). Acquires a proxy from the proxy pool, generates a fresh
    // fingerprint, and builds a per-worker session manager + rate limiter.
    // With proxyStrategy 'isolated' each worker pins its proxy; with 'shared'
    // a new proxy is drawn from the pool on every rotation (more IPs, less
    // stickiness). When no proxy pool is configured, proxy is null (direct).
    const getIdentity = async () => {
      let proxy = null;
      if (proxyPool) {
        proxy = await proxyPool.acquire();
        // If the pool is exhausted, fall back to a direct connection for this
        // worker rather than crashing the whole run. The burn detector will
        // recycle proxies as their cooldowns elapse.
        if (!proxy) {
          logger.warn('Worker getIdentity: proxy pool exhausted — worker will run direct', {
            hint: 'Add more proxies or wait for cooldowns to elapse',
          });
        }
      }
      // Each worker gets its own fingerprint (Phase 2.4) so N workers don't
      // share an identity. --noFingerprint → null (Phase 1 behavior per worker).
      let fp = null;
      if (cfg.fingerprint.profile !== 'off') {
        fp = generateFingerprint({ logger: logger.phase('fingerprint') });
      }
      // Per-worker session manager (Phase 2.7) + rate limiter (Phase 1.8).
      // Each worker's rate limiter caps THAT worker's Google-bound request rate
      // at cfg.antiblock.maxRequestsPerMin — with isolated proxies this is a
      // per-IP cap, so N workers = N× the aggregate rate (each from its own IP).
      const workerRateLimiter = new RateLimiter(cfg.antiblock.maxRequestsPerMin, {
        logger: logger.phase('antiblock'),
      });
      const workerSessionCreateContext = createRealContextFactory({
        cfg,
        logger,
        stealth: cfg.stealth.resolved || { enabled: false, debug: false },
      });
      const workerWarmupFn = cfg.session.warmup
        ? async (page, ctx) =>
            warmupContext(page, {
              logger: (ctx && ctx.logger) || logger.phase('session'),
              durationMs: cfg.session.warmupDurationMs,
              sleepFn: ctx && ctx.sleepFn,
            })
        : null;
      const workerSessionManager = createSessionManager({
        maxRequests: cfg.session.maxRequests,
        maxAgeMs: cfg.session.maxAgeMs,
        warmup: cfg.session.warmup,
        warmupFn: workerWarmupFn,
        createContext: workerSessionCreateContext,
        logger: logger.phase('session'),
        // Phase 2.10 — periodic context restart + memory-based forced restart.
        // contextRestartEvery clears Chrome memory leaks every N tasks; the
        // getMemory accessor + memoryThresholdMb let the manager force-restart
        // its own context when heap pressure is detected (called from the
        // worker probe's onIssue callback — see healthStack wiring below).
        contextRestartEvery: cfg.health.contextRestartEvery,
        getMemory: () => process.memoryUsage(),
        memoryThresholdMb: cfg.health.workerMaxHeapMb,
      });
      return { proxy, fingerprint: fp, sessionManager: workerSessionManager, rateLimiter: workerRateLimiter };
    };

    // runTask — the per-worker task executor. Handles search-task (search +
    // scroll + extract) and detail-task (deep-scrape a batch). Each task
    // launches its own browser via withBrowser using the worker's identity,
    // so a block/crash + rotateIdentity gives the next task a fresh browser.
    const runTask = async (worker, task) => {
      // Per-worker cfg: same as the base cfg but with the worker's own rate
      // limiter wired in (so detail.js / search.js rate-limit against THIS
      // worker's limiter, not the shared one).
      const wcfg = { ...cfg, rateLimiter: worker.rateLimiter };
      const wlogger = worker.logger || logger;
      const taskErrs = validateTask(task);
      if (taskErrs.length > 0) {
        throw new Error(`invalid task: ${taskErrs.join('; ')}`);
      }

      if (task.type === 'search-task') {
        // Search + scroll + extract on the worker's browser. Mirrors the
        // sequential pipeline minus deep-scrape (deep-scrape runs as separate
        // detail-tasks so it can be parallelized).
        return withBrowser(
          wcfg,
          async ({ page, browser }) => {
            if (cfg.session.warmup) {
              try {
                await warmupContext(page, {
                  logger: wlogger.phase('session'),
                  durationMs: cfg.session.warmupDurationMs,
                });
              } catch (err) {
                wlogger.phase('session').warn('Worker warmup failed (non-fatal)', {
                  workerId: worker.id,
                  error: err.message,
                });
              }
            }
            await performSearch(page, wcfg, wlogger, wcfg.retry, wcfg.rateLimiter);
            const scrollResult = await scrollFeedToBottomOnPage(page, wcfg, wlogger);
            wlogger.info('Worker scroll complete', {
              workerId: worker.id,
              finalCount: scrollResult.finalCount,
              reason: scrollResult.reason,
              elapsedMs: scrollResult.elapsedMs,
            });
            const { businesses: freshBusinesses, extractionRates, stats: extractStats } =
              await extractBusinesses(page, {
                query: task.query || cfg.query,
                location: task.location || cfg.location,
                logger: wlogger,
                retry: wcfg.retry,
                selectors: {
                  autoDiscover: cfg.selectors.autoDiscover,
                  abortCheck: true,
                  debugDump: cfg.selectors.selectorDebugDump,
                  debugDumpDir: cfg.selectors.debugDumpDir,
                },
              });
            return { businesses: freshBusinesses, scrollResult, extractionRates, extractStats };
          },
          {
            logger: wlogger,
            proxy: worker.proxy,
            fingerprint: worker.fingerprint,
            stealth: cfg.stealth.resolved,
            onBlocked: ({ status, url }) => {
              wlogger.warn('Worker got a block-status response', {
                workerId: worker.id,
                status,
                url,
              });
            },
          },
        );
      }

      if (task.type === 'detail-task') {
        // Deep-scrape a batch of businesses. Each worker navigates to Maps,
        // searches + scrolls (so the feed loads + the batch's businesses are
        // findable by name), then deepScrapeAll on just the batch. Parallelism:
        // N workers each scrape M/N businesses → ~N× faster than sequential.
        const batch = Array.isArray(task.businesses) ? task.businesses : [];
        return withBrowser(
          wcfg,
          async ({ page, browser }) => {
            if (cfg.session.warmup) {
              try {
                await warmupContext(page, {
                  logger: wlogger.phase('session'),
                  durationMs: cfg.session.warmupDurationMs,
                });
              } catch (err) {
                wlogger.phase('session').warn('Worker warmup failed (non-fatal)', {
                  workerId: worker.id,
                  error: err.message,
                });
              }
            }
            await performSearch(page, wcfg, wlogger, wcfg.retry, wcfg.rateLimiter);
            await scrollFeedToBottomOnPage(page, wcfg, wlogger);
            // deepScrapeAll mutates the batch array in place (replaces slots
            // with merged-detail objects). We return the batch so the caller
            // can write the detail fields back to the master array.
            const detailStats = await deepScrapeAll(page, batch, wcfg, wlogger, {
              captchaCheck: cfg.antiblock.captchaPause
                ? async () => {
                    if (cfg.captcha.resolved && cfg.captcha.resolved.solver) {
                      const r = await handleCaptcha(page, {
                        solver: cfg.captcha.resolved.solver,
                        budgetGuard: cfg.captcha.resolved.budgetGuard,
                        costLogger: cfg.captcha.resolved.costLogger,
                        logger: wlogger.phase('captcha'),
                        captchaWaitMs: 0,
                      });
                      if (r.resolved) return { detected: false, indicator: null };
                      return { detected: true, indicator: r.indicator };
                    }
                    return detectCaptcha(page);
                  }
                : null,
              captchaWaitMs: cfg.antiblock.captchaWaitMs,
            });
            return { businesses: batch, detailStats };
          },
          {
            logger: wlogger,
            proxy: worker.proxy,
            fingerprint: worker.fingerprint,
            stealth: cfg.stealth.resolved,
            onBlocked: ({ status, url }) => {
              wlogger.warn('Worker got a block-status response', {
                workerId: worker.id,
                status,
                url,
              });
            },
          },
        );
      }

      throw new Error(`unknown task type: ${task.type}`);
    };

    // Build the pool. createWorker is the real factory (DI: runTask injected).
    const pool = createWorkerPool({
      size: cfg.workers.size,
      cfg,
      createWorker: (wOpts) => createWorker({ ...wOpts, runTask }),
      getIdentity,
      loadBalancer: cfg.workers.loadBalancer,
      crashLimit: cfg.workers.crashLimit,
      cooldownMs: cfg.workers.cooldownMs,
      taskRetries: cfg.workers.taskRetries === null ? cfg.workers.size : cfg.workers.taskRetries,
      logger,
    });

    // Phase 2.10 — start the health stack (memory monitor + worker probe +
    // degradation handler + HTTP /health server) now that the pool exists.
    // No queue is passed here (runWithPool is the in-process path); the
    // degradation handler's pauseFn/resumeFn are null, so under memory
    // pressure it skips the queue-pause step and just restarts contexts.
    const healthStack = await buildHealthStack(pool, null);

    let poolResult;
    try {
      // 1) Dispatch the search-task (runs on one worker; the rest idle until
      //    detail batches are dispatched).
      const searchTask = createSearchTask({
        query: cfg.query,
        location: cfg.location,
        maxResults: cfg.maxResults,
      });
      logger.info('Phase 2.8 — dispatching search-task to worker pool', {
        taskId: searchTask.id,
        size: cfg.workers.size,
      });
      const searchResult = await pool.dispatch(searchTask);

      // Dedup against checkpoint (same logic as the sequential pipeline).
      let newCount = 0;
      let skipCount = 0;
      const allBusinesses = existingBusinesses.slice();
      const seenKeys = new Set(dedupSet);
      for (const b of searchResult.businesses) {
        const k = dedupKey(b);
        if (k && seenKeys.has(k)) {
          skipCount++;
        } else {
          allBusinesses.push(b);
          if (k) seenKeys.add(k);
          newCount++;
        }
      }
      logger.info('Worker pool extraction + checkpoint dedup complete', {
        fresh: searchResult.businesses.length,
        existing: existingBusinesses.length,
        new: newCount,
        skipped: skipCount,
        total: allBusinesses.length,
      });

      // Stamp EMPTY_DETAIL on new records (stable output schema).
      for (let i = 0; i < allBusinesses.length; i++) {
        if (!allBusinesses[i].detail_scraped) {
          allBusinesses[i] = { ...allBusinesses[i], ...EMPTY_DETAIL };
        }
      }

      let detailStats = null;
      if (cfg.deepScrape) {
        // 2) Split into detail-task batches + dispatch in parallel across the
        //    pool. Each batch is a slice of allBusinesses; after a batch
        //    completes we write the detail-enriched records back by index.
        const batchSize = cfg.workers.detailBatchSize;
        const batches = [];
        for (let i = 0; i < allBusinesses.length; i += batchSize) {
          const slice = allBusinesses.slice(i, i + batchSize).map((b) => ({ ...b }));
          batches.push({ startIdx: i, businesses: slice });
        }
        logger.info('Phase 2.8 — dispatching detail-task batches to worker pool', {
          total: allBusinesses.length,
          batches: batches.length,
          batchSize,
          workers: cfg.workers.size,
        });
        const detailTasks = batches.map((b) =>
          createDetailTask({ businesses: b.businesses, opts: { startIdx: b.startIdx } }),
        );
        const settled = await pool.dispatchBatchSettled(detailTasks);

        // Merge batch results back into allBusinesses by startIdx.
        let attempted = 0;
        let succeeded = 0;
        let failed = 0;
        const durations = [];
        const errors = {};
        let batchIdx = 0;
        for (const r of settled.results) {
          const startIdx = batches[batchIdx].startIdx;
          if (r.status === 'fulfilled' && r.value && Array.isArray(r.value.businesses)) {
            for (let j = 0; j < r.value.businesses.length; j++) {
              allBusinesses[startIdx + j] = r.value.businesses[j];
            }
            if (r.value.detailStats) {
              attempted += r.value.detailStats.attempted || 0;
              succeeded += r.value.detailStats.succeeded || 0;
              failed += r.value.detailStats.failed || 0;
              if (Array.isArray(r.value.detailStats.durations)) {
                durations.push(...r.value.detailStats.durations);
              }
              if (r.value.detailStats.errors) {
                for (const [k, v] of Object.entries(r.value.detailStats.errors)) {
                  errors[k] = (errors[k] || 0) + v;
                }
              }
            }
          } else {
            // Batch failed entirely — count its businesses as failed.
            const cnt = batches[batchIdx].businesses.length;
            attempted += cnt;
            failed += cnt;
            const reason = r.reason ? r.reason.message : 'batch failed';
            errors[reason] = (errors[reason] || 0) + cnt;
            logger.error('Detail batch failed', {
              startIdx,
              count: cnt,
              error: reason,
            });
          }
          batchIdx++;
        }
        const avgMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
        const minMs = durations.length > 0 ? Math.min(...durations) : 0;
        const maxMs = durations.length > 0 ? Math.max(...durations) : 0;
        detailStats = {
          attempted,
          succeeded,
          failed,
          successRate: attempted > 0 ? Math.round((succeeded / attempted) * 100) : 0,
          avgMs,
          minMs,
          maxMs,
          errors,
          durations,
        };
        logger.info('Worker pool deep-scrape complete', {
          attempted,
          succeeded,
          failed,
          successRate: detailStats.successRate,
          batches: batches.length,
          batchFailures: settled.rejected,
        });
      }

      // Aggregate per-worker session stats (each worker has its own manager).
      let sessionsCreated = 0;
      let rotations = 0;
      let totalRequests = 0;
      const warmup = cfg.session.warmup;
      let ageSum = 0;
      let sessionCount = 0;
      for (const w of pool.workers) {
        if (w.sessionManager && typeof w.sessionManager.stats === 'function') {
          const s = w.sessionManager.stats();
          sessionsCreated += s.sessionsCreated || 0;
          rotations += s.rotations || 0;
          totalRequests += s.totalRequests || 0;
          if (s.avgAgeMs) {
            ageSum += s.avgAgeMs;
            sessionCount++;
          }
        }
      }

      poolResult = {
        businesses: allBusinesses,
        extractionRates: searchResult.extractionRates,
        scrollResult: searchResult.scrollResult,
        detailStats,
        extractStats: searchResult.extractStats,
        recovery: {
          resumed: resume,
          existingCount: existingBusinesses.length,
          newCount,
          skipped: skipCount,
        },
        antiblock: {
          maxRPM: cfg.antiblock.maxRequestsPerMin,
          rateLimitWaits: 0, // per-worker limiters; aggregate omitted for brevity
          humanTyping: cfg.antiblock.humanTyping,
        },
        captcha: cfg.captcha.resolved && cfg.captcha.resolved.costLogger
          ? {
              provider: cfg.captcha.provider,
              fallback: cfg.captcha.fallbackProvider || null,
              budget: cfg.captcha.budget,
              spent: cfg.captcha.resolved.budgetGuard ? cfg.captcha.resolved.budgetGuard.spent : 0,
              budgetExceeded: cfg.captcha.resolved.budgetGuard ? cfg.captcha.resolved.budgetGuard.exceeded : false,
              costLog: cfg.captcha.resolved.costLogger.summary(),
              costLogPath: cfg.captcha.resolved.costLogger.filePath,
            }
          : { provider: 'none', costLog: { count: 0, totalCost: 0, avgMs: 0 } },
        session: {
          enabled: true,
          sessionsCreated,
          rotations,
          totalRequests,
          avgRequestsPerSession: sessionsCreated > 0 ? Math.round(totalRequests / sessionsCreated) : 0,
          avgAgeMs: sessionCount > 0 ? Math.round(ageSum / sessionCount) : 0,
          warmup,
        },
        pool: pool.stats(),
      };
    } finally {
      // Phase 2.10 — stop the health stack (memory monitor + worker probe +
      // HTTP /health server) and run the zombie reaper shutdown sweep.
      await stopHealthStack(healthStack);
      // Graceful pool shutdown — workers finish current tasks, release proxies.
      try {
        await pool.shutdown();
      } catch (err) {
        logger.warn('Pool shutdown error (non-fatal)', { error: err.message });
      }
      // Release any proxies still held by retired workers (best-effort).
      if (proxyPool) {
        for (const w of pool.workers) {
          if (w.proxy && w.proxy.id) {
            try {
              proxyPool.release(w.proxy.id, { success: !w.isRetired() });
            } catch {
              /* best-effort */
            }
          }
        }
      }
    }
    return poolResult;
  };

  // Phase 2.9 — runWithQueue: the queue-backed pipeline. Builds the same worker
  // pool as runWithPool, then layers a BullMQ queue on top: the search-task is
  // submitted as a job, the worker pulls it off, and pool.dispatch runs it. If
  // deepScrape is on, the businesses are split into detail-batch jobs (each
  // carrying the full business objects — no DB lookup needed in the main flow).
  // Returns the same `result` shape as runWithPool so the downstream export /
  // summary / banner logic is shared.
  //
  // The queue adds: crash-resilience (jobs persist in Redis — a process restart
  // resumes the queue), priority (paid jobs first), and batch submission (the
  // CLI can submit 100 jobs and exit; a worker process drains them over hours).
  // With --queue off (default) runWithPool runs unchanged (no Redis required).
  const runWithQueue = async () => {
    // getIdentity — same as runWithPool (copied here to keep the queue path
    // self-contained; a Phase 2.13 refactor will extract this into a shared
    // buildPool() helper used by both runWithPool and runWithQueue).
    const getIdentity = async () => {
      let proxy = null;
      if (proxyPool) {
        proxy = await proxyPool.acquire();
        if (!proxy) {
          logger.warn('Worker getIdentity: proxy pool exhausted — worker will run direct', {
            hint: 'Add more proxies or wait for cooldowns to elapse',
          });
        }
      }
      let fp = null;
      if (cfg.fingerprint.profile !== 'off') {
        fp = generateFingerprint({ logger: logger.phase('fingerprint') });
      }
      const workerRateLimiter = new RateLimiter(cfg.antiblock.maxRequestsPerMin, {
        logger: logger.phase('antiblock'),
      });
      const workerSessionCreateContext = createRealContextFactory({
        cfg,
        logger,
        stealth: cfg.stealth.resolved || { enabled: false, debug: false },
      });
      const workerWarmupFn = cfg.session.warmup
        ? async (page, ctx) =>
            warmupContext(page, {
              logger: (ctx && ctx.logger) || logger.phase('session'),
              durationMs: cfg.session.warmupDurationMs,
              sleepFn: ctx && ctx.sleepFn,
            })
        : null;
      const workerSessionManager = createSessionManager({
        maxRequests: cfg.session.maxRequests,
        maxAgeMs: cfg.session.maxAgeMs,
        warmup: cfg.session.warmup,
        warmupFn: workerWarmupFn,
        createContext: workerSessionCreateContext,
        logger: logger.phase('session'),
        // Phase 2.10 — periodic context restart + memory-based forced restart.
        // contextRestartEvery clears Chrome memory leaks every N tasks; the
        // getMemory accessor + memoryThresholdMb let the manager force-restart
        // its own context when heap pressure is detected (called from the
        // worker probe's onIssue callback — see healthStack wiring below).
        contextRestartEvery: cfg.health.contextRestartEvery,
        getMemory: () => process.memoryUsage(),
        memoryThresholdMb: cfg.health.workerMaxHeapMb,
      });
      return { proxy, fingerprint: fp, sessionManager: workerSessionManager, rateLimiter: workerRateLimiter };
    };

    // runTask — same as runWithPool. Handles search-task + detail-task. The
    // queue processor calls pool.dispatch(task) which calls worker.run(task)
    // which calls this runTask.
    const runTask = async (worker, task) => {
      const wcfg = { ...cfg, rateLimiter: worker.rateLimiter };
      const wlogger = worker.logger || logger;
      const taskErrs = validateTask(task);
      if (taskErrs.length > 0) {
        throw new Error(`invalid task: ${taskErrs.join('; ')}`);
      }
      if (task.type === 'search-task') {
        return withBrowser(
          wcfg,
          async ({ page, browser }) => {
            if (cfg.session.warmup) {
              try {
                await warmupContext(page, {
                  logger: wlogger.phase('session'),
                  durationMs: cfg.session.warmupDurationMs,
                });
              } catch (err) {
                wlogger.phase('session').warn('Worker warmup failed (non-fatal)', {
                  workerId: worker.id,
                  error: err.message,
                });
              }
            }
            await performSearch(page, wcfg, wlogger, wcfg.retry, wcfg.rateLimiter);
            const scrollResult = await scrollFeedToBottomOnPage(page, wcfg, wlogger);
            const { businesses: freshBusinesses, extractionRates, stats: extractStats } =
              await extractBusinesses(page, {
                query: task.query || cfg.query,
                location: task.location || cfg.location,
                logger: wlogger,
                retry: wcfg.retry,
                selectors: {
                  autoDiscover: cfg.selectors.autoDiscover,
                  abortCheck: true,
                  debugDump: cfg.selectors.selectorDebugDump,
                  debugDumpDir: cfg.selectors.debugDumpDir,
                },
              });
            return { businesses: freshBusinesses, scrollResult, extractionRates, extractStats };
          },
          {
            logger: wlogger,
            proxy: worker.proxy,
            fingerprint: worker.fingerprint,
            stealth: cfg.stealth.resolved,
            onBlocked: ({ status, url }) => {
              wlogger.warn('Worker got a block-status response', {
                workerId: worker.id,
                status,
                url,
              });
            },
          },
        );
      }
      if (task.type === 'detail-task') {
        const batch = Array.isArray(task.businesses) ? task.businesses : [];
        return withBrowser(
          wcfg,
          async ({ page, browser }) => {
            if (cfg.session.warmup) {
              try {
                await warmupContext(page, {
                  logger: wlogger.phase('session'),
                  durationMs: cfg.session.warmupDurationMs,
                });
              } catch (err) {
                wlogger.phase('session').warn('Worker warmup failed (non-fatal)', {
                  workerId: worker.id,
                  error: err.message,
                });
              }
            }
            await performSearch(page, wcfg, wlogger, wcfg.retry, wcfg.rateLimiter);
            await scrollFeedToBottomOnPage(page, wcfg, wlogger);
            const detailStats = await deepScrapeAll(page, batch, wcfg, wlogger, {
              captchaCheck: cfg.antiblock.captchaPause
                ? async () => {
                    if (cfg.captcha.resolved && cfg.captcha.resolved.solver) {
                      const r = await handleCaptcha(page, {
                        solver: cfg.captcha.resolved.solver,
                        budgetGuard: cfg.captcha.resolved.budgetGuard,
                        costLogger: cfg.captcha.resolved.costLogger,
                        logger: wlogger.phase('captcha'),
                        captchaWaitMs: 0,
                      });
                      if (r.resolved) return { detected: false, indicator: null };
                      return { detected: true, indicator: r.indicator };
                    }
                    return detectCaptcha(page);
                  }
                : null,
              captchaWaitMs: cfg.antiblock.captchaWaitMs,
            });
            return { businesses: batch, detailStats };
          },
          {
            logger: wlogger,
            proxy: worker.proxy,
            fingerprint: worker.fingerprint,
            stealth: cfg.stealth.resolved,
            onBlocked: ({ status, url }) => {
              wlogger.warn('Worker got a block-status response', {
                workerId: worker.id,
                status,
                url,
              });
            },
          },
        );
      }
      throw new Error(`unknown task type: ${task.type}`);
    };

    // Build the pool (same as runWithPool).
    const pool = createWorkerPool({
      size: cfg.workers.size,
      cfg,
      createWorker: (wOpts) => createWorker({ ...wOpts, runTask }),
      getIdentity,
      loadBalancer: cfg.workers.loadBalancer,
      crashLimit: cfg.workers.crashLimit,
      cooldownMs: cfg.workers.cooldownMs,
      taskRetries: cfg.workers.taskRetries === null ? cfg.workers.size : cfg.workers.taskRetries,
      logger,
    });

    // Build the queue adapter. Production uses real BullMQ + Redis; tests can
    // inject a mock backend via cfg.queue.resolved.backend (none here — the
    // main flow always uses the real backend).
    const queue = createQueue({
      redisUrl: cfg.queue.redisUrl,
      name: 'scraper',
      logger,
      defaultPriority: cfg.queue.priority,
      defaultAttempts: cfg.queue.attempts,
      concurrency: cfg.queue.concurrency,
    });
    cfg.queue.resolved = { adapter: queue };

    // Register the queue processor. The adapter converts the job payload →
    // task (via JOB_TYPES[type].toTask), then calls this processor. The
    // processor dispatches the task to the pool. For detail-task, the task
    // may carry `businessIds` (Phase 3 — needs DB lookup, not yet wired) OR
    // `businesses` (Phase 2.9 main flow — already in memory).
    queue.process(async (task) => {
      // detail-task with businessIds only (no businesses) — Phase 3 placeholder.
      // We can't resolve ids without a DB lookup; throw so the job retries then
      // dead-letters. The Phase 3 enrich worker will wire the lookup.
      if (task.type === 'detail-task' && (!task.businesses || task.businesses.length === 0)) {
        if (task.businessIds && task.businessIds.length > 0) {
          throw new Error(
            'detail-batch by businessId requires DB lookup (Phase 3 — not yet implemented). ' +
              'Submit with { businesses: [...] } instead for the Phase 2.9 main flow.',
          );
        }
        throw new Error('detail-task requires either businessIds or businesses');
      }
      return pool.dispatch(task);
    });

    // Phase 2.10 — start the health stack now that BOTH the pool + queue
    // exist. With a queue present, the degradation handler can pause/resume
    // it under memory pressure (runWithPool skips this — no queue).
    const healthStack = await buildHealthStack(pool, queue);

    let queueResult;
    let queueErrored = false; // Phase 2.10 — drives endless-mode teardown decision
    try {
      // 1) Submit the search job + await completion. The job's result is the
      //    pool.dispatch return value: { businesses, scrollResult, extractionRates, extractStats }.
      const searchJobOpts = {
        priority: cfg.queue.priority,
        attempts: cfg.queue.attempts,
      };
      logger.info('Phase 2.9 — submitting search job to queue', {
        queue: queue.name,
        query: cfg.query,
        location: cfg.location,
        priority: searchJobOpts.priority,
        attempts: searchJobOpts.attempts,
      });
      const { id: searchJobId } = await queue.add(
        'search',
        {
          query: cfg.query,
          location: cfg.location,
          maxResults: cfg.maxResults,
          deepScrape: cfg.deepScrape,
        },
        searchJobOpts,
      );
      // Wait for the search job to finish. The backend job's waitUntilFinished()
      // resolves with the processor's return value (the pool.dispatch result).
      const searchJob = queue._backendQueue.getJob(searchJobId);
      const searchResult = await searchJob.waitUntilFinished();
      logger.info('Phase 2.9 — search job complete', {
        jobId: searchJobId,
        businesses: searchResult.businesses.length,
      });

      // Dedup against checkpoint (same logic as runWithPool).
      let newCount = 0;
      let skipCount = 0;
      const allBusinesses = existingBusinesses.slice();
      const seenKeys = new Set(dedupSet);
      for (const b of searchResult.businesses) {
        const k = dedupKey(b);
        if (k && seenKeys.has(k)) {
          skipCount++;
        } else {
          allBusinesses.push(b);
          if (k) seenKeys.add(k);
          newCount++;
        }
      }
      logger.info('Queue search + checkpoint dedup complete', {
        fresh: searchResult.businesses.length,
        existing: existingBusinesses.length,
        new: newCount,
        skipped: skipCount,
        total: allBusinesses.length,
      });

      // Stamp EMPTY_DETAIL on new records (stable output schema).
      for (let i = 0; i < allBusinesses.length; i++) {
        if (!allBusinesses[i].detail_scraped) {
          allBusinesses[i] = { ...allBusinesses[i], ...EMPTY_DETAIL };
        }
      }

      let detailStats = null;
      if (cfg.deepScrape) {
        // 2) Split into detail-batch jobs + submit them. Each job carries the
        //    FULL business objects (no DB lookup needed). The queue's retry +
        //    dead-letter semantics apply per batch — a failed batch is retried
        //    up to cfg.queue.attempts times, then dead-lettered for inspection.
        const batchSize = cfg.workers.detailBatchSize;
        const batches = [];
        for (let i = 0; i < allBusinesses.length; i += batchSize) {
          const slice = allBusinesses.slice(i, i + batchSize).map((b) => ({ ...b }));
          batches.push({ startIdx: i, businesses: slice });
        }
        logger.info('Phase 2.9 — submitting detail-batch jobs to queue', {
          total: allBusinesses.length,
          batches: batches.length,
          batchSize,
          attempts: cfg.queue.attempts,
        });
        const detailJobs = batches.map((b) => ({
          type: 'detail-batch',
          payload: { businesses: b.businesses, deepScrape: true },
          priority: cfg.queue.priority,
          attempts: cfg.queue.attempts,
        }));
        const submitted = await queue.addBatch(detailJobs);

        // Wait for all detail jobs to finish (in order). Each job's result is
        // the pool.dispatch return value: { businesses, detailStats }.
        const detailResults = [];
        for (let i = 0; i < submitted.length; i++) {
          const s = submitted[i];
          if (s.error) {
            // Submission failed (e.g. invalid payload) — count the batch as failed.
            const cnt = batches[i].businesses.length;
            detailResults.push({
              startIdx: batches[i].startIdx,
              count: cnt,
              failed: true,
              error: s.error,
              businesses: batches[i].businesses,
            });
            continue;
          }
          const job = queue._backendQueue.getJob(s.id);
          try {
            const res = await job.waitUntilFinished();
            detailResults.push({
              startIdx: batches[i].startIdx,
              count: batches[i].businesses.length,
              failed: false,
              businesses: res.businesses,
              detailStats: res.detailStats,
            });
          } catch (err) {
            // Job exhausted retries + dead-lettered.
            detailResults.push({
              startIdx: batches[i].startIdx,
              count: batches[i].businesses.length,
              failed: true,
              error: err.message,
              businesses: batches[i].businesses,
            });
          }
        }

        // Merge batch results back + aggregate detailStats.
        let attempted = 0;
        let succeeded = 0;
        let failed = 0;
        const durations = [];
        const errors = {};
        for (const r of detailResults) {
          if (r.failed) {
            attempted += r.count;
            failed += r.count;
            errors[r.error || 'batch failed'] = (errors[r.error || 'batch failed'] || 0) + r.count;
            logger.error('Detail-batch job failed (dead-lettered)', {
              startIdx: r.startIdx,
              count: r.count,
              error: r.error,
            });
            continue;
          }
          for (let j = 0; j < r.businesses.length; j++) {
            allBusinesses[r.startIdx + j] = r.businesses[j];
          }
          if (r.detailStats) {
            attempted += r.detailStats.attempted || 0;
            succeeded += r.detailStats.succeeded || 0;
            failed += r.detailStats.failed || 0;
            if (Array.isArray(r.detailStats.durations)) {
              durations.push(...r.detailStats.durations);
            }
            if (r.detailStats.errors) {
              for (const [k, v] of Object.entries(r.detailStats.errors)) {
                errors[k] = (errors[k] || 0) + v;
              }
            }
          }
        }
        const avgMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
        const minMs = durations.length > 0 ? Math.min(...durations) : 0;
        const maxMs = durations.length > 0 ? Math.max(...durations) : 0;
        detailStats = {
          attempted,
          succeeded,
          failed,
          successRate: attempted > 0 ? Math.round((succeeded / attempted) * 100) : 0,
          avgMs,
          minMs,
          maxMs,
          errors,
          durations,
        };
        // Report any dead-lettered batches so the operator can inspect + retry.
        const deadLettered = detailResults.filter((r) => r.failed).length;
        if (deadLettered > 0) {
          logger.warn('Phase 2.9 — some detail-batch jobs dead-lettered', {
            deadLettered,
            total: detailResults.length,
            hint: 'Use `npm run queue:status` or queue.deadLetter().list() to inspect + retry',
          });
        }
        logger.info('Queue deep-scrape complete', {
          attempted,
          succeeded,
          failed,
          successRate: detailStats.successRate,
          batches: batches.length,
          batchFailures: deadLettered,
        });
      }

      // Aggregate per-worker session stats (same as runWithPool).
      let sessionsCreated = 0;
      let rotations = 0;
      let totalRequests = 0;
      const warmup = cfg.session.warmup;
      let ageSum = 0;
      let sessionCount = 0;
      for (const w of pool.workers) {
        if (w.sessionManager && typeof w.sessionManager.stats === 'function') {
          const s = w.sessionManager.stats();
          sessionsCreated += s.sessionsCreated || 0;
          rotations += s.rotations || 0;
          totalRequests += s.totalRequests || 0;
          if (s.avgAgeMs) {
            ageSum += s.avgAgeMs;
            sessionCount++;
          }
        }
      }

      // Queue stats for the end-of-run banner.
      const queueStats = await queue.getStats();

      queueResult = {
        businesses: allBusinesses,
        extractionRates: searchResult.extractionRates,
        scrollResult: searchResult.scrollResult,
        detailStats,
        extractStats: searchResult.extractStats,
        recovery: {
          resumed: resume,
          existingCount: existingBusinesses.length,
          newCount,
          skipped: skipCount,
        },
        antiblock: {
          maxRPM: cfg.antiblock.maxRequestsPerMin,
          rateLimitWaits: 0,
          humanTyping: cfg.antiblock.humanTyping,
        },
        captcha: cfg.captcha.resolved && cfg.captcha.resolved.costLogger
          ? {
              provider: cfg.captcha.provider,
              fallback: cfg.captcha.fallbackProvider || null,
              budget: cfg.captcha.budget,
              spent: cfg.captcha.resolved.budgetGuard ? cfg.captcha.resolved.budgetGuard.spent : 0,
              budgetExceeded: cfg.captcha.resolved.budgetGuard ? cfg.captcha.resolved.budgetGuard.exceeded : false,
              costLog: cfg.captcha.resolved.costLogger.summary(),
              costLogPath: cfg.captcha.resolved.costLogger.filePath,
            }
          : { provider: 'none', costLog: { count: 0, totalCost: 0, avgMs: 0 } },
        session: {
          enabled: true,
          sessionsCreated,
          rotations,
          totalRequests,
          avgRequestsPerSession: sessionsCreated > 0 ? Math.round(totalRequests / sessionsCreated) : 0,
          avgAgeMs: sessionCount > 0 ? Math.round(ageSum / sessionCount) : 0,
          warmup,
        },
        pool: pool.stats(),
        queue: queueStats,
      };
    } catch (err) {
      // Phase 2.10 — mark the run as errored so the finally block tears down
      // even in endless mode (a broken queue/pool shouldn't keep running).
      queueErrored = true;
      throw err;
    } finally {
      // Phase 2.10 — in endless mode (AND the run succeeded), SKIP the
      // teardown. The queue worker + pool + health stack stay alive so the
      // BullMQ worker keeps pulling jobs from Redis as they arrive. The
      // main() endless loop (further down) keeps the process alive; Ctrl-C
      // triggers the SIGINT zombie reap + exit 130.
      //
      // If the run ERRORED, we tear down even in endless mode — a broken
      // queue/pool shouldn't keep running. The operator restarts after
      // investigating.
      const skipTeardown = cfg.health.endless && !queueErrored;
      if (skipTeardown) {
        logger.info('Phase 2.10 — endless mode: keeping queue + pool + health stack alive for continuous scraping', {
          queueName: queue.name,
          activeWorkers: pool.activeSize,
          healthPort: cfg.health.port,
        });
      } else {
        // Phase 2.10 — stop the health stack (memory monitor + worker probe +
        // HTTP /health server) and run the zombie reaper shutdown sweep.
        await stopHealthStack(healthStack);
        // Graceful queue shutdown — stop accepting jobs, finish in-flight, close.
        try {
          await queue.shutdown();
        } catch (err) {
          logger.warn('Queue shutdown error (non-fatal)', { error: err.message });
        }
        // Graceful pool shutdown (same as runWithPool).
        try {
          await pool.shutdown();
        } catch (err) {
          logger.warn('Pool shutdown error (non-fatal)', { error: err.message });
        }
        if (proxyPool) {
          for (const w of pool.workers) {
            if (w.proxy && w.proxy.id) {
              try {
                proxyPool.release(w.proxy.id, { success: !w.isRetired() });
              } catch {
                /* best-effort */
              }
            }
          }
        }
      }
    }
    return queueResult;
  };

  const startedAt = Date.now();
  let result;

  // Phase 2.11 — startup extraction-rate health check. Loads a known-good
  // HTML fixture (captured in Phase 2.0) into a throwaway browser, runs
  // extractBusinesses, and aborts the run if any core field (name, rating,
  // reviews_count, address) extracts below 50%. This catches a DOM change
  // BEFORE the run spends time + proxy budget on a broken scrape.
  //
  // Skipped when:
  //   - --skipHealthCheck is set (emergency runs)
  //   - the fixture file is missing (fresh clone — warn but continue)
  //   - --dryRun is set (smoke test — no point aborting)
  //
  // The health check uses a SEPARATE browser instance (launched + closed
  // here) so it doesn't interfere with the main pipeline's browser state.
  // Overhead: ~15s for browser launch + fixture load + extraction.
  if (!cfg.selectors.skipHealthCheck && !cfg.dryRun) {
    const fixturePath = cfg.selectors.healthCheckFixture;
    if (!fs.existsSync(fixturePath)) {
      logger.warn('Phase 2.11 — startup health check skipped (fixture not found)', {
        fixturePath,
        hint: 'Run `npm run capture-fixtures` to capture fixtures, or set HEALTH_CHECK_FIXTURE to a captured HTML file. Use --skipHealthCheck to silence this warning.',
      });
      cfg.selectors.resolved = { ran: false, ok: true, reason: 'fixture not found' };
    } else {
      logger.info('Phase 2.11 — running startup extraction-rate health check', {
        fixturePath,
        autoDiscover: cfg.selectors.autoDiscover,
        hint: 'Loads a fixture, runs extraction, aborts if core fields < 50%',
      });
      const hcStartedAt = Date.now();
      try {
        // Use a minimal browser config for the health check — no fingerprint,
        // no stealth, no proxy. The fixture is a static HTML file; we just
        // need a DOM to extract from. This keeps the check fast (~15s).
        const hcCfg = {
          ...cfg,
          headless: true,
          fingerprint: { ...cfg.fingerprint, profile: 'off', resolved: null },
          stealth: { ...cfg.stealth, profile: 'off', resolved: { enabled: false, debug: false } },
          proxy: { ...cfg.proxy, enabled: false },
        };
        await withBrowser(hcCfg, async ({ page }) => {
          const fixtureHtml = fs.readFileSync(fixturePath, 'utf8');
          await page.setContent(fixtureHtml, { waitUntil: 'domcontentloaded' });
          const { ok, health } = await healthCheck(page, {
            logger,
            autoDiscover: cfg.selectors.autoDiscover,
            minSampleSize: 3,
            coreThreshold: 50,
            secondaryThreshold: 30,
          });
          const elapsedMs = Date.now() - hcStartedAt;
          cfg.selectors.resolved = {
            ran: true,
            ok,
            rates: health.coreRates,
            elapsedMs,
            failingCore: health.failingCore,
            failingSecondary: health.failingSecondary,
          };
          if (!ok) {
            logger.error('Phase 2.11 — startup health check FAILED — aborting run', {
              elapsedMs,
              failingCore: health.failingCore,
              failingSecondary: health.failingSecondary,
              coreRates: health.coreRates,
              reason: health.reason,
              hint: 'Run `npm run capture-fixtures` to refresh fixtures, then `bun test tests/selectors-fixture.test.js`. Use --skipHealthCheck to bypass for an emergency run.',
            });
            const err = new Error(health.reason || 'Selector health check failed');
            err.code = 'SELECTOR_FAILURE';
            err.exitCode = SELECTOR_FAILURE_EXIT_CODE;
            err.health = health;
            throw err;
          }
          logger.info('Phase 2.11 — startup health check passed', {
            elapsedMs,
            total: health.total,
            coreRates: health.coreRates,
            failingSecondary: health.failingSecondary,
          });
        });
      } catch (err) {
        if (err.code === 'SELECTOR_FAILURE') {
          // Re-throw to the outer catch, which handles exit code 3.
          throw err;
        }
        // Non-selector errors (browser launch failure, fixture parse error,
        // etc.) are non-fatal — warn and continue. The main scrape might
        // still work; the first-batch abort check is the backstop.
        logger.warn('Phase 2.11 — startup health check errored (non-fatal — continuing)', {
          error: err.message,
          hint: 'The main scrape will proceed; the first-batch abort check is the backstop',
        });
        cfg.selectors.resolved = { ran: true, ok: true, error: err.message };
      }
    }
  } else {
    cfg.selectors.resolved = {
      ran: false,
      ok: true,
      reason: cfg.selectors.skipHealthCheck ? '--skipHealthCheck' : '--dryRun',
    };
  }

  try {
    // Phase 2.9 — queue path. --queue on submits the search-task as a BullMQ
    // job (persisted in Redis, crash-resilient, priority-ordered); a worker
    // pulls it off and feeds the pool. --queue off (default) skips this path
    // entirely and falls through to Phase 2.8 / sequential.
    if (cfg.queue.enabled) {
      result = await runWithQueue();
    }
    // Phase 2.8 — multi-worker path. --workers N > 1 runs the pool; --workers 1
    // (default) runs the existing single-browser pipeline unchanged.
    else if (cfg.workers.size > 1) {
      result = await runWithPool();
    } else {
    // Phase 2.3 — acquire a proxy (if the pool is enabled) before launching
    // the browser. The proxy descriptor flows through withBrowser →
    // launchBrowser → chromium.launch({ proxy }). On teardown (success OR
    // failure) we release the proxy back to the pool with the outcome so the
    // burn detector can track success rate + consecutive failures.
    let acquiredProxy = null;
    if (proxyPool) {
      acquiredProxy = await proxyPool.acquire();
      if (!acquiredProxy) {
        logger.error('Proxy pool exhausted — every proxy is burned', {
          hint: 'Wait for the cooldown window to elapse, add more proxies, or rerun with --noProxy',
        });
        process.exit(3);
      }
    }

    let pipelineError = null;
    try {
      result = await withBrowser(
        cfg,
        async ({ page, browser }) => {
          // Phase 2.7 — warm up the initial context before the first Maps
          // request. A zero-history session hitting Maps directly is a strong
          // bot signal; warmup visits google.com (etc.) first so the cookie
          // jar looks like a real user. Skipped when --warmup off.
          if (cfg.session.warmup) {
            try {
              const w = await warmupContext(page, {
                logger: logger.phase('session'),
                durationMs: cfg.session.warmupDurationMs,
              });
              logger.phase('session').info('Initial session warmup complete', {
                visited: w.visited,
                waitedMs: w.waitedMs,
                searched: w.searched,
              });
            } catch (err) {
              logger.phase('session').warn('Initial warmup failed (non-fatal — continuing)', {
                error: err.message,
              });
            }
          }
          // Phase 2.7 — optional account warmup (opt-in). Logs into a Google
          // account in the initial context so the session is authenticated.
          // Logged-in sessions get more data + fewer CAPTCHAs. Each account is
          // used for max 1 session per day (tracked in sessionUsedToday).
          if (cfg.session.accountWarmup && sessionAccounts) {
            const acct = pickAccount(sessionAccounts, { usedToday: sessionUsedToday, logger });
            if (acct) {
              const r = await accountWarmup(page, {
                email: acct.email,
                password: acct.password,
                logger: logger.phase('session'),
              });
              if (r.loggedIn) {
                sessionUsedToday.add(acct.email);
                logger.phase('session').info('Account warmup succeeded', { email: redactEmail(acct.email) });
              } else {
                logger.phase('session').warn('Account warmup failed — continuing unauthenticated', {
                  email: redactEmail(acct.email),
                  error: r.error,
                });
              }
            } else {
              logger.phase('session').warn('Account warmup: all accounts already used today — continuing unauthenticated');
            }
          }

          // We always re-search + re-scroll on resume — a live browser session
          // can't be restored, only the extracted data can.
          await performSearch(page, cfg, logger, cfg.retry, cfg.rateLimiter);

        const scrollResult = await scrollFeedToBottomOnPage(page, cfg, logger);
        logger.info('Scroll complete', {
          finalCount: scrollResult.finalCount,
          reason: scrollResult.reason,
          elapsedMs: scrollResult.elapsedMs,
        });

      const { businesses: freshBusinesses, extractionRates, stats: extractStats } =
        await extractBusinesses(page, {
          query: cfg.query,
          location: cfg.location,
          logger,
          retry: cfg.retry,
          selectors: {
            autoDiscover: cfg.selectors.autoDiscover,
            abortCheck: true,
            debugDump: cfg.selectors.selectorDebugDump,
            debugDumpDir: cfg.selectors.debugDumpDir,
          },
        });

      logExtractionRates(extractionRates, logger);

      // Phase 1.7 — dedup freshly-extracted businesses against the checkpoint.
      // Businesses already in the checkpoint are skipped (counted), new ones
      // are appended to the running set.
      let newCount = 0;
      let skipCount = 0;
      const allBusinesses = existingBusinesses.slice();
      const seenKeys = new Set(dedupSet);
      for (const b of freshBusinesses) {
        const k = dedupKey(b);
        if (k && seenKeys.has(k)) {
          skipCount++;
        } else {
          allBusinesses.push(b);
          if (k) seenKeys.add(k);
          newCount++;
        }
      }

      logger.info('Extraction + checkpoint dedup complete', {
        fresh: freshBusinesses.length,
        existing: existingBusinesses.length,
        new: newCount,
        skipped: skipCount,
        total: allBusinesses.length,
        extractFailed: extractStats.failed,
      });

      logger.info('Extraction complete', {
        total: allBusinesses.length,
        sponsored: allBusinesses.filter((b) => b.is_sponsored).length,
        permanentlyClosed: allBusinesses.filter((b) => b.business_status === 'permanently_closed').length,
        temporarilyClosed: allBusinesses.filter((b) => b.business_status === 'temporarily_closed').length,
      });

      // Phase 1.5 — optional detail-page deep scrape. Adds hours, popular
      // times, top reviews, photos, reservation/menu/social links per business.
      // Per-business failure isolation: a bad detail load never crashes the run.
      let detailStats = null;
      if (cfg.deepScrape) {
        // Ensure every business has a detail-field baseline. Existing
        // businesses from the checkpoint already have their detail fields
        // (detail_scraped: true) and are skipped by deepScrapeAll. New ones
        // get EMPTY_DETAIL as the baseline before scraping.
        for (let i = 0; i < allBusinesses.length; i++) {
          if (!allBusinesses[i].detail_scraped) {
            allBusinesses[i] = { ...allBusinesses[i], ...EMPTY_DETAIL };
          }
        }

        logger.info('Phase 1.5 — detail-page deep scrape enabled', {
          total: allBusinesses.length,
          alreadyScraped: allBusinesses.filter((b) => b.detail_scraped === true).length,
          toScrape: allBusinesses.filter((b) => b.detail_scraped !== true).length,
          sampleStep: cfg.detail.sampleStep,
          checkpointInterval: cfg.checkpointInterval,
        });
        const detailStart = Date.now();

        // Phase 1.7 — checkpoint hook: write every N deep-scrapes so a crash
        // mid-run can be resumed.
        const onProgress = ({ attempted }) => {
          if (attempted > 0 && attempted % cfg.checkpointInterval === 0) {
            try {
              writeCheckpoint(cfg, {
                businesses: allBusinesses,
                extractionRates,
                scroll: scrollResult,
              });
              logger.debug('Checkpoint written', {
                attempted,
                total: allBusinesses.length,
              });
            } catch (err) {
              logger.warn('Checkpoint write failed (non-fatal)', { error: err.message });
            }
          }
        };

        detailStats = await deepScrapeAll(page, allBusinesses, cfg, logger, {
          onProgress,
          // Phase 1.8 + 2.6 — CAPTCHA hook: check after each business. If
          // detected AND no solver is configured → deepScrapeAll pauses +
          // aborts with err.code === 'CAPTCHA_DETECTED' (Phase 1.8 behavior).
          // If a solver IS configured (Phase 2.6) → handleCaptcha() tries to
          // auto-solve; on success it returns {detected:false} (scrape
          // continues unattended); on failure it returns {detected:true} so
          // deepScrapeAll falls back to the Phase 1.8 pause-and-alert.
          captchaCheck: cfg.antiblock.captchaPause
            ? async () => {
                // Phase 2.6 — auto-solve path. Only when a solver is resolved.
                if (cfg.captcha.resolved && cfg.captcha.resolved.solver) {
                  const result = await handleCaptcha(page, {
                    solver: cfg.captcha.resolved.solver,
                    budgetGuard: cfg.captcha.resolved.budgetGuard,
                    costLogger: cfg.captcha.resolved.costLogger,
                    logger: logger.phase('captcha'),
                    // The orchestrator does NOT pause here (captchaWaitMs: 0).
                    // detail.js does the real pause when we return {detected:true}.
                    // We only want the operator alert from the orchestrator.
                    captchaWaitMs: 0,
                    onFallback: ({ detection }) => {
                      // eslint-disable-next-line no-console
                      console.error(
                        '\n========================================\n' +
                          'CAPTCHA DETECTED — auto-solve unavailable or failed.\n' +
                          `Type: ${detection.type}  Indicator: ${detection.indicator}\n` +
                          `Falling back to operator pause (${Math.round(cfg.antiblock.captchaWaitMs / 1000)}s).\n` +
                          'In --headed mode: solve the CAPTCHA in the browser window.\n' +
                          'The checkpoint is preserved — rerun with --resume after the block clears.\n' +
                          '========================================\n',
                      );
                    },
                  });
                  if (result.resolved) {
                    // Solved — scrape continues unattended.
                    return { detected: false, indicator: null };
                  }
                  // Not solved — let detail.js pause + abort (Phase 1.8 behavior).
                  return { detected: true, indicator: result.indicator };
                }
                // Phase 1.8 path — no solver configured, plain text detection.
                return detectCaptcha(page);
              }
            : null,
          captchaWaitMs: cfg.antiblock.captchaWaitMs,
          // Phase 2.7 — session rotation hook. Called after each business; when
          // the session manager triggers a rotation (maxRequests or maxAge), the
          // hook closes the old context, creates + warms up a new one, re-navigates
          // to the Maps search (so the feed reloads), and returns the new page.
          // deepScrapeAll swaps its page reference to the new page.
          sessionCheck: async () => {
            const r = await sessionManager.tickRequest({
              browser,
              proxy: acquiredProxy,
              fingerprint: cfg.fingerprint.resolved,
              label: 'deep-scrape',
            });
            if (!r.rotated) return { rotated: false };
            // A rotation happened — re-navigate the new page to the Maps search
            // so the feed is loaded for the next business's detail-panel click.
            // The businesses are in memory; the feed reloads in a few seconds.
            try {
              logger.phase('session').info('Session rotated — re-navigating new page to Maps search', {
                reason: r.reason,
                sessionInfo: r.sessionInfo,
              });
              await performSearch(r.page, cfg, logger, cfg.retry, cfg.rateLimiter);
            } catch (err) {
              logger.phase('session').warn('Session rotation: re-search failed (non-fatal — deep-scrape will retry)', {
                error: err.message,
              });
            }
            return { rotated: true, page: r.page, reason: r.reason };
          },
        });
        const detailDuration = Date.now() - detailStart;
        logger.info('Deep-scrape phase complete', {
          attempted: detailStats.attempted,
          succeeded: detailStats.succeeded,
          failed: detailStats.failed,
          successRate: `${detailStats.successRate}%`,
          avgMsPerBusiness: detailStats.avgMs,
          totalDurationMs: detailDuration,
        });
      } else {
        // Deep scrape off — stamp every NEW record with EMPTY_DETAIL so the
        // output schema is stable (CSV column order in Phase 1.6 doesn't shift).
        // Existing records from checkpoint keep whatever they already have.
        for (let i = 0; i < allBusinesses.length; i++) {
          if (!allBusinesses[i].detail_scraped) {
            allBusinesses[i] = { ...allBusinesses[i], ...EMPTY_DETAIL };
          }
        }
        logger.info('Deep-scrape disabled — detail fields null/empty', {
          total: allBusinesses.length,
        });
      }

      return {
        businesses: allBusinesses,
        extractionRates,
        scrollResult,
        detailStats,
        extractStats,
        recovery: {
          resumed: resume,
          existingCount: existingBusinesses.length,
          newCount,
          skipped: skipCount,
        },
        antiblock: {
          maxRPM: cfg.antiblock.maxRequestsPerMin,
          rateLimitWaits: cfg.rateLimiter ? cfg.rateLimiter.totalWaits : 0,
          humanTyping: cfg.antiblock.humanTyping,
        },
        // Phase 2.6 — CAPTCHA solver stats for this run. Null when provider is
        // 'none' (Phase 1.8 pause-and-alert, no solver constructed).
        captcha: cfg.captcha.resolved && cfg.captcha.resolved.costLogger
          ? {
              provider: cfg.captcha.provider,
              fallback: cfg.captcha.fallbackProvider || null,
              budget: cfg.captcha.budget,
              spent: cfg.captcha.resolved.budgetGuard
                ? cfg.captcha.resolved.budgetGuard.spent
                : 0,
              budgetExceeded: cfg.captcha.resolved.budgetGuard
                ? cfg.captcha.resolved.budgetGuard.exceeded
                : false,
              costLog: cfg.captcha.resolved.costLogger.summary(),
              costLogPath: cfg.captcha.resolved.costLogger.filePath,
            }
          : { provider: 'none', costLog: { count: 0, totalCost: 0, avgMs: 0 } },
        // Phase 2.7 — session rotation stats for this run.
        session: sessionManager ? sessionManager.stats() : { enabled: false },
      };
    },
    {
      // Phase 1.8 — wire the 429/503 watcher. On a blocked response we just
      // log (the rate limiter + CAPTCHA check handle the actual backoff).
      logger,
      // Phase 2.3 — pass the acquired proxy through to launchBrowser.
      proxy: acquiredProxy,
      // Phase 2.4 — pass the per-run fingerprint through to launchBrowser.
      // null when --noFingerprint / profile 'off' → Phase 1 context defaults.
      fingerprint: cfg.fingerprint.resolved,
      // Phase 2.5 — pass the stealth config through to launchBrowser.
      // { enabled: false } when --noStealth → vanilla playwright, no patches.
      stealth: cfg.stealth.resolved,
      onBlocked: ({ status, url, count }) => {
        logger.warn('Google returned a block-status response', { status, url, count });
        // Phase 2.3 — a 429/503 from Google while using a proxy is a strong
        // signal that the proxy is being rate-limited. We mark it burned via
        // release() below (the onBlocked hook is informational only; the
        // actual burn decision happens in the finally block based on whether
        // the pipeline threw).
      },
    },
  );
    } catch (err) {
      pipelineError = err;
      throw err;
    } finally {
      // Phase 2.3 — release the proxy back to the pool with the outcome so the
      // burn detector can track success rate + consecutive failures. A CAPTCHA
      // or 429 from Google counts as a soft failure (the proxy may be getting
      // rate-limited); a hard crash counts as a timeout-equivalent failure.
      if (proxyPool && acquiredProxy) {
        let outcome;
        if (pipelineError && pipelineError.code === 'CAPTCHA_DETECTED') {
          // CAPTCHA → treat as a 429 (block signal) for burn-detection purposes.
          outcome = { success: false, statusCode: 429 };
        } else if (pipelineError) {
          // Other crash → treat as a timeout (different burn rule, separate
          // streak counter in the detector).
          outcome = { success: false, statusCode: 'TIMEOUT' };
        } else {
          outcome = { success: true };
        }
        try {
          proxyPool.release(acquiredProxy.id, outcome);
        } catch (releaseErr) {
          logger.warn('Proxy release failed (non-fatal)', {
            proxyId: acquiredProxy.id,
            error: releaseErr.message,
          });
        }
      }
      // Phase 2.10 — sequential-path zombie reaper shutdown sweep. The pool/
      // queue paths do this in their own finally blocks via stopHealthStack;
      // the sequential path has no health stack (single browser, no pool) but
      // still needs to guarantee no orphaned Chromium processes survive.
      try {
        const report = await zombieReaper.reapOnShutdown({ ownPid: process.pid });
        zombieReaper.logReport(report, { when: 'shutdown' });
      } catch (err) {
        logger.warn('Phase 2.10 — sequential zombie reaper failed (non-fatal)', {
          error: err.message,
        });
      }
    }
    } // end Phase 2.8 else (sequential single-browser path)
  } catch (err) {
    if (err && err.code === 'SELECTOR_FAILURE') {
      // Phase 2.11 — extraction-rate abort. Core fields dropped below 50%,
      // almost certainly because Google changed the DOM. Don't waste the
      // run budget — exit with code 3 (selector failure) and tell the
      // operator exactly which fields failed + how to fix.
      logger.error('Run aborted — selector failure (extraction rates critically low)', {
        failingCore: err.failingCore,
        failingSecondary: err.failingSecondary,
        coreRates: err.health ? err.health.coreRates : null,
        reason: err.message,
        hint: 'Run `npm run capture-fixtures` to refresh fixtures, then `bun test tests/selectors-fixture.test.js`. Inspect data/selector-debug/ for DOM snippets. Use --skipHealthCheck to bypass for an emergency run.',
      });
      clearTimeout(globalTimer);
      process.removeListener('SIGINT', onSigInt);
      logger.close();
      process.exit(SELECTOR_FAILURE_EXIT_CODE);
    } else if (err && err.code === 'CAPTCHA_DETECTED') {
      logger.error('Run aborted — CAPTCHA detected', {
        indicator: err.captchaIndicator,
        hint: 'Wait for the block to clear, then rerun with --resume',
      });
    } else {
      logger.error('Runtime error during pipeline', { message: err.message, stack: err.stack });
    }
    logger.warn('Checkpoint preserved on disk — rerun with --resume to continue');
    clearTimeout(globalTimer);
    process.removeListener('SIGINT', onSigInt);
    logger.close();
    process.exit(3);
  } finally {
    browserClosed = true;
    // Phase 2.3 — flush + close the proxy pool (best-effort).
    if (proxyPool && typeof proxyPool.close === 'function') {
      try {
        proxyPool.close();
      } catch {
        /* best-effort */
      }
    }
  }

  const durationMs = Date.now() - startedAt;

  // Phase 1.6 — export CSV + JSON sidecar + run summary.
  // Build the summary object (shared across all three files).
  const summary = {
    query: cfg.query,
    location: cfg.location,
    total: result.businesses.length,
    sponsored: result.businesses.filter((b) => b.is_sponsored).length,
    permanentlyClosed: result.businesses.filter((b) => b.business_status === 'permanently_closed').length,
    temporarilyClosed: result.businesses.filter((b) => b.business_status === 'temporarily_closed').length,
    extractionRates: result.extractionRates,
    extractionStats: result.extractStats,
    scroll: result.scrollResult,
    recovery: result.recovery,
    deepScrape: result.detailStats
      ? {
          enabled: true,
          attempted: result.detailStats.attempted,
          succeeded: result.detailStats.succeeded,
          failed: result.detailStats.failed,
          successRate: result.detailStats.successRate,
          avgMsPerBusiness: result.detailStats.avgMs,
          minMs: result.detailStats.minMs,
          maxMs: result.detailStats.maxMs,
          errors: result.detailStats.errors,
        }
      : { enabled: false },
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    fields: [...CANONICAL_FIELDS, ...DETAIL_FIELDS],
    // Phase 2.3 — proxy pool stats for this run (null when proxy disabled).
    proxy: proxyPool ? proxyPool.stats() : { enabled: false },
    // Phase 2.6 — CAPTCHA solver stats for this run (provider/spend/cost log).
    captcha: result.captcha,
    // Phase 2.7 — session rotation stats (sessionsCreated, rotations, avgRequests).
    session: result.session,
    // Phase 2.8 — worker pool stats (per-worker counts + aggregate). Null when
    // --workers 1 (Phase 1 sequential behavior — no pool constructed).
    pool: result.pool || null,
    // Phase 2.11 — self-healing selector stats: startup health check result +
    // extraction-rate abort status + auto-discovery + debug-dump counts.
    selectors: cfg.selectors.resolved || { ran: false, ok: true },
  };

  // Phase 2.1 — output dispatch. cfg.output is a normalized array of targets
  // (csv, json, db). Dry runs skip ALL writes (files + DB) so --dryRun remains
  // a true smoke test.
  const wantsCsv = cfg.output.includes('csv');
  const wantsJson = cfg.output.includes('json');
  const wantsDb = cfg.output.includes('db');
  const wantsFiles = wantsCsv || wantsJson;

  let outPaths = null;
  if (!cfg.dryRun && wantsFiles) {
    outPaths = await exportResults({
      businesses: result.businesses,
      summary,
      outputFile: cfg.outputFile,
      outputDir: cfg.outputDir,
      writeCsv: wantsCsv,
      writeJson: wantsJson,
      writeSummary: wantsFiles,
      logger,
    });
  } else if (cfg.dryRun) {
    logger.info('Dry run — skipping file output', {
      wouldWrite: cfg.outputFile || path.join(cfg.outputDir, 'dryrun'),
      outputTargets: cfg.output,
    });
  }

  // Phase 2.1 — PostgreSQL persistence. Opens a pool, upserts every business
  // (keyed by place_id) in a single transaction, writes the run summary, and
  // closes the pool. A DB failure is logged + reflected in the exit code but
  // does NOT discard the file outputs already written above.
  let dbResult = null;
  if (!cfg.dryRun && wantsDb) {
    const pool = createPool(cfg.databaseUrl);
    if (!pool) {
      logger.error('DB output requested but DATABASE_URL is unset', {
        hint: 'Set DATABASE_URL in .env (see .env.example → Phase 2.1).',
      });
      process.exit(2);
    }
    try {
      dbResult = await persistRunResults(pool, {
        businesses: result.businesses,
        summary: { ...summary, exitCode: null, logPath: logger.getLogFile ? logger.getLogFile() : null },
        logger,
      });
    } catch (err) {
      logger.error('DB persistence failed', {
        phase: 'db',
        message: err.message,
        stack: err.stack,
        hint: 'CSV/JSON outputs (if any) are unaffected. Re-run with --output db to retry.',
      });
      dbResult = { failed: true, message: err.message };
    } finally {
      await closePool(pool);
    }
  }

  // Phase 1.7 — clear the checkpoint on successful completion. A leftover
  // checkpoint would cause a stale "resume?" prompt on the next run.
  if (!cfg.dryRun) {
    const cleared = clearCheckpoint(cfg);
    if (cleared && resume) {
      logger.info('Checkpoint cleared (run completed successfully)', {
        resumedFrom: existingBusinesses.length,
      });
    }
  }

  // Clean summary
  const detailLine = result.detailStats
    ? `Detail:   ${result.detailStats.succeeded}/${result.detailStats.attempted} scraped (${result.detailStats.successRate}% success, avg ${result.detailStats.avgMs}ms/business)`
    : 'Detail:   disabled (--deepScrape false)';
  const recoveryLine = result.recovery.resumed
    ? `Recovery: resumed from ${result.recovery.existingCount} (skipped ${result.recovery.skipped} dupes, +${result.recovery.newCount} new)`
    : null;
  const extractFailLine =
    result.extractStats && result.extractStats.failed > 0
      ? `Extract:  ${result.extractStats.succeeded}/${result.extractStats.total} succeeded, ${result.extractStats.failed} failed`
      : null;
  // Phase 2.1 — build the output lines for the end-of-run banner. Each target
  // (csv, json, db) gets its own line; dry runs show a single placeholder.
  const outputLines = [];
  if (cfg.dryRun) {
    outputLines.push('Output:   (dry run, no files / DB written)');
  } else {
    if (outPaths && outPaths.csvPath) outputLines.push(`CSV:      ${outPaths.csvPath}`);
    if (outPaths && outPaths.jsonPath) outputLines.push(`JSON:     ${outPaths.jsonPath}`);
    if (outPaths && outPaths.summaryPath) outputLines.push(`Summary:  ${outPaths.summaryPath}`);
    if (dbResult) {
      if (dbResult.failed) {
        outputLines.push(`DB:       FAILED — ${dbResult.message}`);
      } else {
        // Phase 2.2 — include the change breakdown when any tracked field
        // changed. Format: "30 updated (12 rating changes, 8 review-count
        // changes, 2 status changes), 20 unchanged". When there are zero
        // changes, fall back to the compact Phase 2.1 line.
        const cbf = dbResult.changesByField || {};
        const changeParts = [];
        if (cbf.rating) changeParts.push(`${cbf.rating} rating changes`);
        if (cbf.reviews_count) changeParts.push(`${cbf.reviews_count} review-count changes`);
        if (cbf.business_status) changeParts.push(`${cbf.business_status} status changes`);
        if (cbf.phone) changeParts.push(`${cbf.phone} phone changes`);
        if (cbf.website) changeParts.push(`${cbf.website} website changes`);
        const changesClause =
          dbResult.updated > 0 && changeParts.length > 0
            ? ` (${changeParts.join(', ')})`
            : '';
        outputLines.push(
          `DB:       ${dbResult.inserted} inserted, ${dbResult.updated} updated${changesClause}, ${dbResult.unchanged} unchanged (run #${dbResult.runId})`,
        );
      }
    }
    if (outputLines.length === 0) outputLines.push('Output:   (no targets selected)');
  }
  // Phase 2.3 — proxy stats line. Shows total/healthy/burned + the strategy.
  // When proxy is disabled, the line is omitted entirely (matches Phase 1).
  const proxyLines = [];
  if (proxyPool) {
    const ps = proxyPool.stats();
    const rate = ps.avgSuccessRate !== null
      ? `${Math.round(ps.avgSuccessRate * 100)}% success`
      : 'no requests yet';
    proxyLines.push(
      `Proxy:    ${ps.healthy}/${ps.total} healthy, ${ps.cooldown} cooling, ${ps.burned} burned (${ps.strategy}, ${rate})`,
    );
  }
  // Phase 2.6 — CAPTCHA solver stats line. Per the execution plan's end-of-run
  // summary format: "CAPTCHA: 3 solved ($0.009 total, avg 4.1s)". When the
  // provider is 'none' (Phase 1.8 behavior), the line is omitted. When solves
  // happened, show count + total cost + avg time + budget-exceeded flag.
  const captchaLines = [];
  if (result.captcha && result.captcha.provider && result.captcha.provider !== 'none') {
    const cl = result.captcha.costLog || {};
    if (cl.count > 0) {
      const avgS = cl.avgMs > 0 ? (cl.avgMs / 1000).toFixed(1) : '0.0';
      const budgetFlag = result.captcha.budgetExceeded ? ' [BUDGET EXCEEDED]' : '';
      captchaLines.push(
        `CAPTCHA:  ${cl.successCount}/${cl.count} solved ($${cl.totalCost.toFixed(4)} total, avg ${avgS}s, provider ${result.captcha.provider})${budgetFlag}`,
      );
    } else {
      captchaLines.push(
        `CAPTCHA:  none encountered (provider ${result.captcha.provider}, budget $${result.captcha.budget.toFixed(2)})`,
      );
    }
  }
  // Phase 2.7 — session rotation stats line. Shows how many sessions were
  // created, how many rotations happened, and the avg requests per session.
  const sessionLines = [];
  if (result.session && result.session.sessionsCreated !== undefined) {
    const ss = result.session;
    const avgReq = ss.avgRequestsPerSession || 0;
    const avgAge = ss.avgAgeMs > 0 ? `${(ss.avgAgeMs / 1000).toFixed(1)}s` : '0s';
    sessionLines.push(
      `Session:  ${ss.sessionsCreated} created, ${ss.rotations} rotations (avg ${avgReq} req/session, avg age ${avgAge}${ss.warmup ? ', +warmup' : ''})`,
    );
  }
  // Phase 1.9 — include the log file path in the banner so the operator knows
  // where the full JSON-lines record of this run lives.
  const logFile = logger.getLogFile ? logger.getLogFile() : null;
  const logLine = logFile ? `Log:      ${logFile}` : null;
  // Phase 2.8 — worker pool stats line. Shows the active pool size, completed
  // tasks, re-queues, and any retired workers. Omitted when --workers 1 (no
  // pool constructed — Phase 1 sequential behavior).
  const poolLines = [];
  if (result.pool) {
    const ps = result.pool;
    const retired = ps.retiredCount > 0 ? `, ${ps.retiredCount} retired` : '';
    poolLines.push(
      `Pool:     ${ps.activeSize}/${ps.size} workers, ${ps.totals.tasksCompleted} tasks, ${ps.totals.businessesScraped} businesses, ${ps.requeueCount} re-queues${retired} (${ps.loadBalancer})`,
    );
  }
  // Phase 2.9 — job queue stats line. Shows waiting/active/completed/failed/
  // delayed counts. Omitted when --queue off (no queue constructed — Phase 2.8
  // in-process behavior).
  const queueLines = [];
  if (result.queue) {
    const qs = result.queue;
    const failedTag = qs.failed > 0 ? `, ${qs.failed} FAILED` : '';
    const delayedTag = qs.delayed > 0 ? `, ${qs.delayed} delayed` : '';
    queueLines.push(
      `Queue:    ${qs.completed} done, ${qs.active} active, ${qs.waiting} waiting${delayedTag}${failedTag} (BullMQ + Redis)`,
    );
  }
  const banner = [
    '========================================',
    'Run complete',
    `Query:    ${cfg.query} in ${cfg.location}`,
    `Results:  ${result.businesses.length} extracted (${result.scrollResult.finalCount} loaded, reason=${result.scrollResult.reason})`,
    `Duration: ${(durationMs / 1000).toFixed(1)}s`,
    detailLine,
    ...(recoveryLine ? [recoveryLine] : []),
    ...(extractFailLine ? [extractFailLine] : []),
    ...outputLines,
    ...proxyLines,
    ...captchaLines,
    ...sessionLines,
    ...poolLines,
    ...queueLines,
    ...(logLine ? [logLine] : []),
    '========================================',
  ].join('\n');
  // eslint-disable-next-line no-console
  console.log(banner);

  // Phase 1.10 prep — exit code 1 for partial success (some failures but
  // run completed). Exit 0 only if everything succeeded. A DB persistence
  // failure also counts as partial success (exit 1), not a crash (exit 3),
  // because the scrape itself completed — only the DB write failed.
  const hasExtractFailures = result.extractStats && result.extractStats.failed > 0;
  const hasDetailFailures = result.detailStats && result.detailStats.failed > 0;
  const hasDbFailure = !!(dbResult && dbResult.failed);
  const exitCode = hasExtractFailures || hasDetailFailures || hasDbFailure ? 1 : 0;

  // Phase 1.9 — structured "Run complete" log line so the JSON-lines file has
  // a single machine-parseable record of the run's final status (duration,
  // counts, exit code). Emitted before logger.close() so it's flushed to disk.
  logger.info('Run complete', {
    phase: 'system',
    query: cfg.query,
    location: cfg.location,
    extracted: result.businesses.length,
    loaded: result.scrollResult.finalCount,
    scrollReason: result.scrollResult.reason,
    durationMs,
    exitCode,
    extractFailed: result.extractStats ? result.extractStats.failed : 0,
    detailAttempted: result.detailStats ? result.detailStats.attempted : 0,
    detailFailed: result.detailStats ? result.detailStats.failed : 0,
    dryRun: cfg.dryRun,
    output: cfg.output,
    csv: outPaths ? outPaths.csvPath : null,
    json: outPaths ? outPaths.jsonPath : null,
    db: dbResult && !dbResult.failed
      ? { runId: dbResult.runId, inserted: dbResult.inserted, updated: dbResult.updated, unchanged: dbResult.unchanged }
      : dbResult && dbResult.failed
        ? { failed: true, message: dbResult.message }
        : null,
    log: logFile,
  });

  clearTimeout(globalTimer);

  // Phase 2.10 — endless mode. When --endless is on (requires --queue on),
  // the scraper does NOT exit after the initial run. Instead it keeps the
  // process alive so the BullMQ worker continues pulling jobs from the queue
  // as they arrive (submitted by the batch CLI or any other producer). The
  // memory monitor + worker probe + zombie reaper + HTTP /health server
  // (all started inside runWithQueue) keep running. The operator stops the
  // scraper with Ctrl-C (which triggers the SIGINT zombie reap + exit 130).
  //
  // Implementation: we DON'T call process.exit here. Instead we log a banner
  // and await a never-resolving promise. The health server's /health endpoint
  // keeps reporting status=ok|degraded|unhealthy. Memory pressure is handled
  // by the degradation handler (pause queue → restart contexts → reduce pool).
  if (cfg.health.endless && cfg.queue.enabled) {
    logger.info('Phase 2.10 — endless mode: initial run complete, keeping process alive for queue jobs', {
      hint: 'Submit more jobs via `npm run batch -- --file queries.csv`. Ctrl-C to stop.',
      healthPort: cfg.health.port,
      memoryIntervalMs: cfg.health.memoryIntervalMs,
      exitCode,
    });
    // The queue adapter + pool + health stack were torn down in runWithQueue's
    // finally block. For endless mode we need to RE-CONSTRUCT them so the
    // BullMQ worker can keep pulling jobs. The cleanest path: re-call
    // runWithQueue in a loop, but with an empty initial query (no search job
    // submitted — just drain the queue). For Phase 2.10 we implement the
    // simple version: keep the process alive with a periodic heartbeat log
    // + the health endpoint. A future phase will add the full drain loop.
    //
    // NOTE: This is the documented Phase 2.10 surface. The full continuous-
    // scrape loop (submitting a heartbeat search every N minutes to keep
    // the queue warm) is Phase 5. Here we just guarantee the process
    // doesn't exit + the health endpoint stays up.
    const heartbeat = setInterval(() => {
      const mem = process.memoryUsage();
      logger.info('Phase 2.10 — endless heartbeat', {
        uptimeMs: Date.now() - startedAt,
        heapMb: Math.round(mem.heapUsed / (1024 * 1024)),
        rssMb: Math.round(mem.rss / (1024 * 1024)),
        exitCode,
      });
    }, 60 * 1000); // 1 min heartbeat
    // Never-resolving promise — the process stays alive until Ctrl-C.
    // The SIGINT handler (registered above) reaps zombies + exits 130.
    await new Promise(() => {});
    clearInterval(heartbeat);
  }

  process.removeListener('SIGINT', onSigInt);
  logger.close();
  process.exit(exitCode);
}

main();
