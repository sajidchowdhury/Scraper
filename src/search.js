/**
 * Google Maps navigation + search.
 *
 * Phase 1.0: navigates to Maps, fills the search box, submits, and waits for
 *            the results feed. Behavior mirrors the original main.js.
 *
 * Phase 1.2: adds fallback selectors for both the search box and the results
 *            feed, so a single Google DOM change doesn't break the whole
 *            pipeline. Selectors are tried sequentially within a shared
 *            timeout budget; the first one to match wins.
 *
 * Phase 1.3 (TODO): after the feed is found, hand off to scroll.js for
 *                   pagination before extraction.
 */
const logger = require('./logger');

const MAPS_URL = 'https://www.google.com/maps';

/**
 * Selectors — kept here so a future DOM change only requires editing one place.
 * Tried in order; the first match wins. Add new fallbacks at the bottom as
 * Google rolls out DOM changes.
 */
const SEARCHBOX_SELECTORS = [
  'input#searchboxinput',                 // primary (current Google Maps)
  'input#searchboxinputtextfield',        // legacy variant
  'input[aria-label*="Search" i]',        // aria-label fallback
  'input[name="q"]',                      // generic name fallback
];

const FEED_SELECTORS = [
  'div[role="feed"]',                     // primary (results list container)
  'div[aria-label*="Results" i]',         // aria-label fallback
  'div.section-result-content',           // legacy class-based fallback
];

/**
 * Fill the search box using the first matching selector.
 *
 * @param {import('playwright').Page} page
 * @param {string} value
 * @param {object} [options]
 * @param {number} [options.timeoutMs=5000]  per-selector wait timeout
 * @returns {Promise<string>} the selector that worked
 */
async function fillSearchbox(page, value, options = {}) {
  const perSelectorTimeout = options.timeoutMs || 5000;
  for (const sel of SEARCHBOX_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: perSelectorTimeout });
      await loc.fill(value);
      logger.debug('Search box filled', { selector: sel });
      return sel;
    } catch (err) {
      logger.debug('Search box selector failed, trying next', {
        selector: sel,
        message: err.message,
      });
    }
  }
  throw new Error(
    `Could not find the Google Maps search box. Tried ${SEARCHBOX_SELECTORS.length} selectors: ${SEARCHBOX_SELECTORS.join(', ')}`
  );
}

/**
 * Wait for the results feed to appear, trying fallback selectors in sequence
 * within a shared timeout budget.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {number} [options.timeoutMs=30000]  total budget across all selectors
 * @returns {Promise<string>} the selector that matched
 */
async function waitForFeed(page, options = {}) {
  const totalTimeout = options.timeoutMs || 30000;
  const start = Date.now();
  for (const sel of FEED_SELECTORS) {
    const remaining = totalTimeout - (Date.now() - start);
    if (remaining <= 0) break;
    try {
      await page.waitForSelector(sel, { timeout: remaining });
      logger.info('Results feed found', { selector: sel });
      return sel;
    } catch (err) {
      logger.debug('Feed selector not found, trying next', {
        selector: sel,
        remainingMs: remaining,
      });
    }
  }
  throw new Error(
    `Results feed did not appear within ${totalTimeout}ms. Tried ${FEED_SELECTORS.length} selectors: ${FEED_SELECTORS.join(', ')}`
  );
}

/**
 * Navigate to Google Maps and wait for the page to settle.
 * @param {import('playwright').Page} page
 */
async function navigateToMaps(page) {
  logger.info('Navigating to Google Maps', { url: MAPS_URL });
  await page.goto(MAPS_URL, { waitUntil: 'networkidle' });
  logger.info('Google Maps loaded');
}

/**
 * Fill the search box with "{query} {location}" and submit, then wait for the
 * results feed to appear.
 *
 * @param {import('playwright').Page} page
 * @param {string} query   e.g. "Restaurant"
 * @param {string} location e.g. "Toronto"
 */
async function performSearch(page, query, location) {
  const searchTerm = `${query} ${location}`.trim();
  logger.info('Performing search', { query, location, searchTerm });

  // Give the Maps UI a moment to settle before typing. Replaced with a proper
  // wait-for-searchbox below, but a short settle helps in headed mode.
  // TODO Phase 1.3: replace with a smarter wait (e.g. wait for the search box
  //                  to be interactable, no fixed delay).
  await page.waitForTimeout(1500);

  const usedSelector = await fillSearchbox(page, searchTerm);
  await page.keyboard.press('Enter');
  logger.info('Search submitted', { searchboxSelector: usedSelector });

  await waitForFeed(page, { timeoutMs: 30000 });

  // TODO Phase 1.3: scroll the feed to load all results (scroll.scrollFeedToBottom).
  // TODO Phase 1.4: extract business data (extract.extractBusinesses).
}

module.exports = {
  MAPS_URL,
  SEARCHBOX_SELECTORS,
  FEED_SELECTORS,
  fillSearchbox,
  waitForFeed,
  navigateToMaps,
  performSearch,
};
