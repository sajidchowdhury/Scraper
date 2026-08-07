/**
 * Scraper entry point.
 *
 * Phase 1.0: orchestrates launch → navigate → search, then closes cleanly.
 *            This establishes the modular structure that later phases will fill.
 *
 * Phase 1.2 (TODO): add the full pipeline (scroll → extract → export → close)
 *                   with a global timeout and SIGINT handler; remove the demo
 *                   wait below.
 */
const config = require('./config');
const logger = require('./logger');
const { launchBrowser, closeBrowser } = require('./browser');
const { navigateToMaps, performSearch } = require('./search');

async function main() {
  logger.info('Scraper starting', {
    query: config.search.query,
    location: config.search.location,
    headless: config.browser.headless,
  });

  let browser;
  try {
    const { browser: b, page } = await launchBrowser(config);
    browser = b;

    await navigateToMaps(page);
    await performSearch(page, config.search.query, config.search.location);

    // ---------------------------------------------------------------------
    // Phase 1.0 demo pause.
    // The full pipeline (scroll -> extract -> export) lands in Phases 1.3-1.6.
    // For now we pause briefly so the run is observable, then close cleanly.
    // TODO Phase 1.2: replace this with the real pipeline + lifecycle guards.
    // ---------------------------------------------------------------------
    logger.info('Phase 1.0 scaffold reached — pausing for demo, then closing.');
    await page.waitForTimeout(5000);
  } catch (err) {
    logger.error('Run failed', { message: err.message, stack: err.stack });
    process.exitCode = 3;
  } finally {
    await closeBrowser(browser);
    logger.info('Scraper finished');
  }
}

main();
