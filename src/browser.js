/**
 * Browser lifecycle management.
 *
 * Phase 1.0: launches Chromium with config-driven options and tears it down.
 * Phase 1.2 (TODO): add global timeout, SIGINT graceful-shutdown handler,
 *                   and a clean try/finally contract in the orchestrator.
 */
const { chromium } = require('playwright');
const logger = require('./logger');

/**
 * Launch a Chromium browser and a single page with the configured viewport.
 * @param {object} config - application config (config.browser used here)
 * @returns {Promise<{ browser: import('playwright').Browser, page: import('playwright').Page }>}
 */
async function launchBrowser(config) {
  const { headless, slowMo, viewport } = config.browser;
  logger.info('Launching browser', { headless, slowMo, viewport });

  const browser = await chromium.launch({ headless, slowMo });
  const page = await browser.newPage({ viewport });

  logger.info('Browser launched');
  return { browser, page };
}

/**
 * Gracefully close the browser. Safe to call with null/undefined.
 * @param {import('playwright').Browser|null} browser
 */
async function closeBrowser(browser) {
  if (!browser) return;
  logger.info('Closing browser');
  try {
    await browser.close();
  } catch (err) {
    logger.warn('Error while closing browser', { message: err.message });
  }
}

module.exports = { launchBrowser, closeBrowser };
