'use strict';

/**
 * src/index.js — CLI entry point (Phases 1.0 → 1.4)
 *
 * Pipeline:
 *   loadConfig → launchBrowser → performSearch → scrollFeedToBottom
 *              → extractBusinesses → logExtractionRates → write JSON
 *              → closeBrowser
 *
 * Exit codes (Phase 1.10 prep):
 *   0 = success
 *   2 = config error
 *   3 = runtime error
 */

const fs = require('fs');
const path = require('path');

const { loadConfig, HELP_TEXT } = require('./config');
const { createLogger } = require('./logger');
const { withBrowser } = require('./browser');
const { performSearch } = require('./search');
const { scrollFeedToBottomOnPage } = require('./scroll');
const { extractBusinesses, logExtractionRates, CANONICAL_FIELDS } = require('./extract');

function sanitizeName(s) {
  return String(s || 'run').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function autoOutputPath(cfg, ext = 'json') {
  const base = `${sanitizeName(cfg.query)}_${sanitizeName(cfg.location)}_${stamp()}`;
  return path.join(cfg.outputDir, `${base}.${ext}`);
}

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

      return { businesses, extractionRates, scrollResult };
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

  // Write JSON output (Phase 1.6 will add CSV; JSON is enough for Phase 1.4 verification)
  const outFile = cfg.outputFile
    ? cfg.outputFile.replace(/\.\w+$/, '') + '.json'
    : autoOutputPath(cfg, 'json');

  if (!cfg.dryRun) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    const summary = {
      query: cfg.query,
      location: cfg.location,
      total: result.businesses.length,
      sponsored: result.businesses.filter((b) => b.is_sponsored).length,
      permanentlyClosed: result.businesses.filter((b) => b.business_status === 'permanently_closed').length,
      temporarilyClosed: result.businesses.filter((b) => b.business_status === 'temporarily_closed').length,
      extractionRates: result.extractionRates,
      scroll: result.scrollResult,
      startedAt: new Date(startedAt).toISOString(),
      durationMs,
      outputFile: outFile,
      fields: CANONICAL_FIELDS,
    };
    const payload = { summary, businesses: result.businesses };
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
    logger.info('JSON written', { path: path.resolve(outFile), rows: result.businesses.length });
  } else {
    logger.info('Dry run — skipping file output', { wouldWrite: outFile });
  }

  // Clean summary
  const banner = [
    '========================================',
    'Run complete',
    `Query:    ${cfg.query} in ${cfg.location}`,
    `Results:  ${result.businesses.length} extracted (${result.scrollResult.finalCount} loaded, reason=${result.scrollResult.reason})`,
    `Duration: ${(durationMs / 1000).toFixed(1)}s`,
    cfg.dryRun ? 'Output:   (dry run, no file written)' : `JSON:     ${path.resolve(outFile)}`,
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
