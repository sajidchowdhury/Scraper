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
const { RateLimiter, detectCaptcha } = require('./antiblock');

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
  });

  // Phase 1.8 — construct the rate limiter once and attach to cfg so every
  // module that makes Google-bound requests (search, detail) can acquire.
  cfg.rateLimiter = new RateLimiter(cfg.antiblock.maxRequestsPerMin, { logger });

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
          // Phase 1.8 — CAPTCHA hook: check after each business. If detected,
          // deepScrapeAll pauses + aborts with err.code === 'CAPTCHA_DETECTED'.
          captchaCheck: cfg.antiblock.captchaPause ? () => detectCaptcha(page) : null,
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
      };
    },
    {
      // Phase 1.8 — wire the 429/503 watcher. On a blocked response we just
      // log (the rate limiter + CAPTCHA check handle the actual backoff).
      logger,
      onBlocked: ({ status, url, count }) => {
        logger.warn('Google returned a block-status response', { status, url, count });
      },
    },
  );
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
  };

  let outPaths = null;
  if (!cfg.dryRun) {
    outPaths = await exportResults({
      businesses: result.businesses,
      summary,
      outputFile: cfg.outputFile,
      outputDir: cfg.outputDir,
      logger,
    });
  } else {
    logger.info('Dry run — skipping file output', {
      wouldWrite: cfg.outputFile || path.join(cfg.outputDir, 'dryrun'),
    });
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
  const outputLines = outPaths
    ? [`CSV:      ${outPaths.csvPath}`, `JSON:     ${outPaths.jsonPath}`, `Summary:  ${outPaths.summaryPath}`]
    : ['Output:   (dry run, no file written)'];
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
    ...(logLine ? [logLine] : []),
    '========================================',
  ].join('\n');
  // eslint-disable-next-line no-console
  console.log(banner);

  // Phase 1.10 prep — exit code 1 for partial success (some failures but
  // run completed). Exit 0 only if everything succeeded.
  const hasExtractFailures = result.extractStats && result.extractStats.failed > 0;
  const hasDetailFailures = result.detailStats && result.detailStats.failed > 0;
  const exitCode = hasExtractFailures || hasDetailFailures ? 1 : 0;

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
    csv: outPaths ? outPaths.csvPath : null,
    json: outPaths ? outPaths.jsonPath : null,
    log: logFile,
  });

  clearTimeout(globalTimer);
  process.removeListener('SIGINT', onSigInt);
  logger.close();
  process.exit(exitCode);
}

main();
