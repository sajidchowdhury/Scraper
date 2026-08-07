'use strict';

/**
 * src/search.js — Phase 1.2
 *
 * Navigates to Google Maps and performs the search for `query` in `location`.
 * Returns once the results feed (div[role="feed"]) is detected.
 */

const MAPS_URL = 'https://www.google.com/maps?hl=en';

async function navigateToMaps(page, logger) {
  logger.info('Navigating to Google Maps', { url: MAPS_URL });
  await page.goto(MAPS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Force English UI regardless of IP-geolocation (Maps sometimes overrides
  // the Accept-Language header with a hl= URL param based on geo).
  try {
    await page.evaluate(() => {
      // Best-effort: click the language switcher if present
    });
  } catch {
    /* ignore */
  }
  // Accept cookies consent if it appears (EU IPs)
  try {
    const acceptBtn = page
      .locator('button:has-text("Accept all"), button:has-text("I agree"), form[action*="consent"] button')
      .first();
    await acceptBtn.click({ timeout: 2500 });
    logger.debug('Dismissed consent dialog');
  } catch {
    /* no consent dialog — fine */
  }
}

async function getSearchInput(page) {
  // Primary + fallback selectors for the search box
  const selectors = [
    'input#searchboxinput',
    'input[name="q"]',
    'input[aria-label*="earch"]',
    'input.searchboxinput',
  ];
  for (const s of selectors) {
    const el = await page.$(s);
    if (el) return el;
  }
  return null;
}

async function performSearch(page, { query, location }, logger) {
  await navigateToMaps(page, logger);

  const searchInput = await getSearchInput(page);
  if (!searchInput) {
    throw new Error('Search input not found — Google Maps DOM may have changed');
  }

  const fullQuery = `${query} in ${location}`;
  logger.info('Submitting search', { query: fullQuery });

  await searchInput.click();
  await searchInput.fill(fullQuery);
  await page.keyboard.press('Enter');

  // Wait for the results feed to appear
  const feedSelector = 'div[role="feed"]';
  try {
    await page.waitForSelector(feedSelector, { timeout: 30000 });
    logger.info('Results feed detected');
  } catch {
    // Fallback: wait for any result card
    try {
      await page.waitForSelector('a[href*="/maps/place/"]', { timeout: 15000 });
      logger.info('Results feed detected (via place link fallback)');
    } catch {
      throw new Error('Results feed did not appear after search — possibly zero results or a CAPTCHA');
    }
  }

  return { fullQuery };
}

module.exports = { performSearch, navigateToMaps, getSearchInput, MAPS_URL };
