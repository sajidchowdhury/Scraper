/**
 * Browser lifecycle management.
 *
 * Phase 1.0: launches Chromium with config-driven options and tears it down.
 * Phase 1.2: makes closeBrowser() idempotent (safe to call from both a SIGINT
 *            handler and the main finally block), and adds isBrowserOpen() so
 *            callers can check whether teardown is still pending.
 *
 * Phase 1.3+ (TODO): accept an external proxy config, randomize fingerprint,
 *                    support multi-context concurrency.
 */
const { chromium } = require('playwright');
const logger = require('./logger');

/**
 * Track which browser instances we've already initiated a close on, so that
 * closeBrowser() is idempotent. A WeakSet lets garbage collection reclaim
 * browser entries once nothing else references them.
 */
const closingBrowsers = new WeakSet();

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
 * Gracefully close the browser. Idempotent — safe to call multiple times
 * (e.g. from a SIGINT handler AND the main finally block). Resolves silently
 * if the browser is null/undefined or already being closed.
 *
 * @param {import('playwright').Browser|null|undefined} browser
 * @returns {Promise<void>}
 */
async function closeBrowser(browser) {
  if (!browser) return;
  if (closingBrowsers.has(browser)) {
    // Already closing/closed — don't issue a second browser.close() call.
    return;
  }
  closingBrowsers.add(browser);
  logger.info('Closing browser');
  try {
    await browser.close();
  } catch (err) {
    logger.warn('Error while closing browser', { message: err.message });
  }
}

/**
 * Returns true if closeBrowser() has NOT yet been called on this browser.
 * Useful for the SIGINT handler to decide whether to initiate teardown.
 * @param {import('playwright').Browser|null|undefined} browser
 * @returns {boolean}
 */
function isBrowserOpen(browser) {
  return !!browser && !closingBrowsers.has(browser);
}

module.exports = { launchBrowser, closeBrowser, isBrowserOpen };
