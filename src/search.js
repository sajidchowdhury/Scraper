/**
 * Google Maps navigation + search.
 *
 * Phase 1.0: navigates to Maps, fills the search box, submits, and waits for
 *            the results feed. Behavior mirrors the original main.js.
 *
 * Phase 1.3 (TODO): after the feed is found, hand off to scroll.js for
 *                   pagination before extraction.
 */
const logger = require('./logger');

const MAPS_URL = 'https://www.google.com/maps';

// Selectors — kept here so a future DOM change only requires editing one place.
// TODO Phase 1.2/2.x: add fallback selectors for resilience.
const SELECTORS = {
  searchbox: 'input#searchboxinput',
  feed: 'div[role="feed"]',
};

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

  // Mimic original behavior (3s settle before typing).
  // TODO Phase 1.2: replace with a wait-for-selector on the search box.
  await page.waitForTimeout(3000);

  await page.locator(SELECTORS.searchbox).fill(searchTerm);
  await page.keyboard.press('Enter');

  logger.info('Search submitted, waiting for results feed...');
  await page.waitForSelector(SELECTORS.feed, { timeout: 30000 });
  logger.info('Business list found');

  // TODO Phase 1.3: scroll the feed to load all results (scroll.scrollFeedToBottom).
  // TODO Phase 1.4: extract business data (extract.extractBusinesses).
}

module.exports = {
  MAPS_URL,
  SELECTORS,
  navigateToMaps,
  performSearch,
};
