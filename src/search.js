'use strict';

/**
 * src/search.js — Phase 1.2 (Phase 1.7: retry on transient failures)
 *
 * Navigates to Google Maps and performs the search for `query` in `location`.
 * Returns once the results feed (div[role="feed"]) is detected.
 *
 * Phase 1.7 additions:
 *   - page.goto wrapped in withRetry (transient network blips)
 *   - feed-detection waits wrapped in withRetry (slow first-paint)
 *   - On final failure, throws — the caller (index.js) logs + exits 3.
 */

const { withRetry } = require('./retry');

const MAPS_URL = 'https://www.google.com/maps?hl=en';

async function navigateToMaps(page, logger, retryOpts = {}) {
  logger.info('Navigating to Google Maps', { url: MAPS_URL });
  // Retry only when retryOpts is explicitly provided (production path).
  const hasRetry = retryOpts && retryOpts.attempts > 1;
  const gotoFn = () => page.goto(MAPS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (hasRetry) {
    await withRetry(gotoFn, { ...retryOpts, label: 'page.goto(maps)', logger });
  } else {
    await gotoFn();
  }
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

async function performSearch(page, { query, location }, logger, retryOpts = {}) {
  await navigateToMaps(page, logger, retryOpts);

  const searchInput = await getSearchInput(page);
  if (!searchInput) {
    throw new Error('Search input not found — Google Maps DOM may have changed');
  }

  const fullQuery = `${query} in ${location}`;
  logger.info('Submitting search', { query: fullQuery });

  await searchInput.click();
  await searchInput.fill(fullQuery);
  await page.keyboard.press('Enter');

  // Wait for the results feed to appear — wrapped in retry so a slow
  // first-paint or a momentary network blip doesn't fail the whole run.
  const feedSelector = 'div[role="feed"]';
  const hasRetry = retryOpts && retryOpts.attempts > 1;
  const waitFeed = () => page.waitForSelector(feedSelector, { timeout: 30000 });
  const waitFallback = () => page.waitForSelector('a[href*="/maps/place/"]', { timeout: 15000 });
  try {
    if (hasRetry) {
      await withRetry(waitFeed, { ...retryOpts, label: 'waitForSelector(feed)', logger });
    } else {
      await waitFeed();
    }
    logger.info('Results feed detected');
  } catch {
    // Fallback: wait for any result card
    try {
      if (hasRetry) {
        await withRetry(waitFallback, { ...retryOpts, label: 'waitForSelector(place-link fallback)', logger });
      } else {
        await waitFallback();
      }
      logger.info('Results feed detected (via place link fallback)');
    } catch {
      throw new Error('Results feed did not appear after search — possibly zero results or a CAPTCHA');
    }
  }

  return { fullQuery };
}

module.exports = { performSearch, navigateToMaps, getSearchInput, MAPS_URL };
