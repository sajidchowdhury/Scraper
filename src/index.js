'use strict';

/**
 * src/index.js — CLI entry point (Phases 1.0 → 1.6)
 *
 * Pipeline:
 *   loadConfig → launchBrowser → performSearch → scrollFeedToBottom
 *              → extractBusinesses → [deepScrapeAll if cfg.deepScrape]
 *              → logExtractionRates → exportResults (CSV + JSON + summary)
 *              → closeBrowser
 *
 * Exit codes (Phase 1.10 prep):
 *   0 = success
 *   2 = config error
 *   3 = runtime error
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
  });

  const globalTimer = setTimeout(() => {
    logger.error('Global timeout exceeded — aborting', { ms: cfg.globalTimeoutMs });
    process.exit(3);
  }, cfg.globalTimeoutMs);

  // Graceful Ctrl-C
  let browserClosed = false;
  const onSigInt = async () => {
    logger.warn('SIGINT received — shutting down');
    process.exit(130);
  };
  process.on('SIGINT', onSigInt);

  const startedAt = Date.now();
  let result;

  try {
    result = await withBrowser(cfg, async ({ page }) => {
      await performSearch(page, cfg, logger);

      const scrollResult = await scrollFeedToBottomOnPage(page, cfg, logger);
      logger.info('Scroll complete', {
        finalCount: scrollResult.finalCount,
        reason: scrollResult.reason,
        elapsedMs: scrollResult.elapsedMs,
      });

      const { businesses, extractionRates } = await extractBusinesses(page, {
        query: cfg.query,
        location: cfg.location,
        logger,
      });

      logExtractionRates(extractionRates, logger);

      logger.info('Extraction complete', {
        total: businesses.length,
        sponsored: businesses.filter((b) => b.is_sponsored).length,
        permanentlyClosed: businesses.filter((b) => b.business_status === 'permanently_closed').length,
        temporarilyClosed: businesses.filter((b) => b.business_status === 'temporarily_closed').length,
      });

      // Phase 1.5 — optional detail-page deep scrape. Adds hours, popular
      // times, top reviews, photos, reservation/menu/social links per business.
      // Per-business failure isolation: a bad detail load never crashes the run.
      let detailStats = null;
      if (cfg.deepScrape) {
        logger.info('Phase 1.5 — detail-page deep scrape enabled', {
          total: businesses.length,
          sampleStep: cfg.detail.sampleStep,
        });
        const detailStart = Date.now();
        detailStats = await deepScrapeAll(page, businesses, cfg, logger);
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
        // Deep scrape off — stamp every record with EMPTY_DETAIL so the output
        // schema is stable (CSV column order in Phase 1.6 doesn't shift).
        for (let i = 0; i < businesses.length; i++) {
          businesses[i] = { ...businesses[i], ...EMPTY_DETAIL };
        }
        logger.info('Deep-scrape disabled — detail fields null/empty', {
          total: businesses.length,
        });
      }

      return { businesses, extractionRates, scrollResult, detailStats };
    });
  } catch (err) {
    logger.error('Runtime error during pipeline', { message: err.message, stack: err.stack });
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
    scroll: result.scrollResult,
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

  // Clean summary
  const detailLine = result.detailStats
    ? `Detail:   ${result.detailStats.succeeded}/${result.detailStats.attempted} scraped (${result.detailStats.successRate}% success, avg ${result.detailStats.avgMs}ms/business)`
    : 'Detail:   disabled (--deepScrape false)';
  const outputLines = outPaths
    ? [`CSV:      ${outPaths.csvPath}`, `JSON:     ${outPaths.jsonPath}`, `Summary:  ${outPaths.summaryPath}`]
    : ['Output:   (dry run, no file written)'];
  const banner = [
    '========================================',
    'Run complete',
    `Query:    ${cfg.query} in ${cfg.location}`,
    `Results:  ${result.businesses.length} extracted (${result.scrollResult.finalCount} loaded, reason=${result.scrollResult.reason})`,
    `Duration: ${(durationMs / 1000).toFixed(1)}s`,
    detailLine,
    ...outputLines,
    '========================================',
  ].join('\n');
  // eslint-disable-next-line no-console
  console.log(banner);

  clearTimeout(globalTimer);
  process.removeListener('SIGINT', onSigInt);
  logger.close();
  process.exit(0);
}

main();
