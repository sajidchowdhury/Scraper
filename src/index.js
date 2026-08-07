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
// Phase 2.1 — PostgreSQL persistence (lazy-loaded; only used when
// cfg.output includes 'db').
const { createPool, persistRunResults, closePool } = require('./db');
// Phase 2.3 — proxy management & rotation. Only initialized when cfg.proxy
// is enabled (i.e. --noProxy is not set AND a proxy source is configured).
const { createProxyPool } = require('./proxy');

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
  });

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
  let browserClosed = false;
  const onSigInt = async () => {
    logger.warn('SIGINT received — shutting down (checkpoint preserved for --resume)');
    process.exit(130);
  };
  process.on('SIGINT', onSigInt);

  const startedAt = Date.now();
  let result;

  try {
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
        async ({ page }) => {
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
    }
  } catch (err) {
    if (err && err.code === 'CAPTCHA_DETECTED') {
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
  // Phase 1.9 — include the log file path in the banner so the operator knows
  // where the full JSON-lines record of this run lives.
  const logFile = logger.getLogFile ? logger.getLogFile() : null;
  const logLine = logFile ? `Log:      ${logFile}` : null;
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
  process.removeListener('SIGINT', onSigInt);
  logger.close();
  process.exit(exitCode);
}

main();
