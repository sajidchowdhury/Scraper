/**
 * Scraper entry point.
 *
 * Phase 1.1: resolves config (CLI > env > defaults) with validation, prints the
 *            resolved config so the operator sees exactly what will run, then
 *            orchestrates launch → navigate → search → (later) scroll/extract/export.
 *
 * Exit codes:
 *   0  success
 *   1  partial success (some businesses failed — used once extraction exists)
 *   2  configuration error (missing/invalid CLI args or env)
 *   3  runtime error (browser crash, network failure, etc.)
 *
 * Phase 1.2 (TODO): add global timeout, SIGINT graceful-shutdown handler, and
 *                   the full pipeline (scroll → extract → export → close).
 *                   Remove the demo pause below.
 */
const { resolveConfig, ConfigError } = require('./config');
const logger = require('./logger');
const { launchBrowser, closeBrowser } = require('./browser');
const { navigateToMaps, performSearch } = require('./search');

async function main() {
  // ---- Resolve + validate config (CLI > env > defaults) ----
  let config;
  try {
    config = resolveConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('\n  Configuration error:');
      console.error('  ' + err.message.split('\n').join('\n  '));
      console.error('\n  Run with --help for usage.\n');
      process.exit(2);
    }
    // --help / --version: commander already printed output; just exit.
    if (err && err.code === 'commander.helpDisplayed') process.exit(0);
    if (err && err.code === 'commander.versionDisplayed') process.exit(0);
    // Any other commander error (unknown flag, missing arg) — it has already
    // printed its own message; exit with code 2 to signal usage error.
    if (err && typeof err.code === 'string' && err.code.startsWith('commander.')) {
      process.exit(2);
    }
    logger.error('Unexpected error during config resolution', { message: err.message, stack: err.stack });
    process.exit(3);
  }

  // ---- Print resolved config so the operator sees exactly what will run ----
  logResolvedConfig(config);

  // ---- Apply log level override (env LOG_LEVEL is picked up by logger at
  //      require time; config.log.level mirrors it for display). ----

  let browser;
  try {
    const { browser: b, page } = await launchBrowser(config);
    browser = b;

    await navigateToMaps(page);
    await performSearch(page, config.search.query, config.search.location);

    // ---------------------------------------------------------------------
    // Phase 1.1 scaffold pause.
    // maxResults is now accepted + validated + plumbed through config, but its
    // enforcement (stopping once N businesses are scraped) lands in Phase 1.3
    // once pagination + extraction exist. For now we just log that it's set.
    // The full pipeline (scroll -> extract -> export) lands in Phases 1.3-1.6.
    // TODO Phase 1.2: replace this pause with the real pipeline + lifecycle
    //                 guards (global timeout, SIGINT handler).
    // ---------------------------------------------------------------------
    if (config.search.maxResults != null) {
      logger.info('maxResults configured', {
        maxResults: config.search.maxResults,
        note: 'enforced starting in Phase 1.3 (pagination)',
      });
    }
    logger.info('Phase 1.1 scaffold reached — pausing for demo, then closing.');
    await page.waitForTimeout(5000);
  } catch (err) {
    logger.error('Run failed', { message: err.message, stack: err.stack });
    process.exitCode = 3;
  } finally {
    await closeBrowser(browser);
    logger.info('Scraper finished');
  }
}

/**
 * Print the resolved configuration in a scannable block so the operator can
 * confirm what's about to run before any browser activity begins.
 */
function logResolvedConfig(config) {
  const summary = {
    query: config.search.query,
    location: config.search.location,
    maxResults: config.search.maxResults == null ? 'all available' : config.search.maxResults,
    outputFile: config.output.file == null ? 'auto-generated' : config.output.file,
    outputDir: config.output.dir,
    headless: config.browser.headless,
    slowMo: config.browser.slowMo,
    viewport: `${config.browser.viewport.width}x${config.browser.viewport.height}`,
    logLevel: config.log.level,
  };
  logger.info('Scraper starting');
  logger.info('Resolved configuration', summary);
}

main();
