/**
 * Pagination / infinite-scroll handling.
 *
 * Phase 1.3: scrolls the div[role="feed"] container until all results are
 *            loaded, maxResults is reached, end-of-list is detected (via stall),
 *            or a total scroll-timeout is hit.
 *
 * Stop conditions (checked in order each iteration):
 *   1. maxResults met        -> stopReason = 'maxResults'
 *   2. stallThreshold reached -> stopReason = 'exhausted'  (results finished loading)
 *   3. totalTimeoutMs exceeded-> stopReason = 'timeout'
 *
 * Design notes:
 *   - The three helpers (countResults, scrollToLastCard, waitForCountStable) are
 *     exported so they can be unit-tested with a mocked page.
 *   - scrollFeedToBottom() accepts optional _countResults / _scrollToLastCard /
 *     _waitForCountStable injections (underscore-prefixed) so the main loop can
 *     be tested end-to-end without a real browser.
 */
const logger = require('./logger');

/**
 * Selectors for the results feed container (re-exported from search.js for
 * local convenience; the feed is already located before scroll starts).
 */
const FEED_SELECTORS = [
  'div[role="feed"]',
  'div[aria-label*="Results" i]',
];

/**
 * Selectors for individual business cards. Tried in order; the first non-zero
 * match count is used. Add new fallbacks as Google rolls out DOM changes.
 */
const CARD_SELECTORS = [
  'div[role="feed"] a[role="article"]',   // primary: article-role links inside feed
  'a[role="article"]',                     // fallback: any article-role link
  'div[role="feed"] div[role="article"]',  // fallback: article-role div inside feed
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Count the number of business cards currently loaded in the feed.
 * Tries multiple selectors; returns the first non-zero count, else 0.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<number>}
 */
async function countResults(page) {
  return page.evaluate((selectors) => {
    for (const sel of selectors) {
      try {
        const cards = document.querySelectorAll(sel);
        if (cards.length > 0) return cards.length;
      } catch (e) {
        /* ignore selector errors, try next */
      }
    }
    return 0;
  }, CARD_SELECTORS);
}

/**
 * Scroll the feed to bring the last loaded card into view, triggering Google
 * Maps to lazy-load the next batch. Falls back to scrolling the feed container
 * itself if no cards are found.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true if a scroll action was performed
 */
async function scrollToLastCard(page) {
  return page.evaluate((selectors) => {
    // Try scrolling the last card into view first.
    for (const sel of selectors) {
      try {
        const cards = document.querySelectorAll(sel);
        if (cards.length > 0) {
          cards[cards.length - 1].scrollIntoView({ behavior: 'instant', block: 'end' });
          return true;
        }
      } catch (e) {
        /* ignore */
      }
    }
    // Fallback: scroll the feed container by ~one viewport.
    const feed = document.querySelector('div[role="feed"]') ||
                 document.querySelector('div[aria-label*="Results" i]');
    if (feed) {
      feed.scrollBy(0, feed.clientHeight * 0.8);
      return true;
    }
    return false;
  }, CARD_SELECTORS);
}

/**
 * Wait for the result count to stabilize (no new cards loading).
 * Polls the count; if it hasn't changed for `stableForMs`, returns.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {number} [options.pollIntervalMs=300]   how often to re-check the count
 * @param {number} [options.maxWaitMs=4000]       hard cap on wait time per scroll
 * @param {number} [options.stableForMs=800]      count must be unchanged this long
 * @returns {Promise<{count: number, stable: boolean}>}
 */
async function waitForCountStable(page, options = {}) {
  const pollIntervalMs = options.pollIntervalMs || 300;
  const maxWaitMs = options.maxWaitMs || 4000;
  const stableForMs = options.stableForMs || 800;

  const start = Date.now();
  let lastCount = await countResults(page);
  let lastChangeTime = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await sleep(pollIntervalMs);
    const currentCount = await countResults(page);
    if (currentCount !== lastCount) {
      lastCount = currentCount;
      lastChangeTime = Date.now();
    } else if (Date.now() - lastChangeTime >= stableForMs) {
      return { count: lastCount, stable: true };
    }
  }
  return { count: lastCount, stable: false };
}

/**
 * Scroll the results feed to load all available businesses.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {number|null} [options.maxResults]       stop once this many results are visible (null = all)
 * @param {number} [options.totalTimeoutMs=60000]  hard cap on total scrolling time
 * @param {number} [options.stallThreshold=3]      consecutive no-progress scrolls before stopping
 * @param {Function} [options._countResults]       (test injection) override countResults
 * @param {Function} [options._scrollToLastCard]   (test injection) override scrollToLastCard
 * @param {Function} [options._waitForCountStable] (test injection) override waitForCountStable
 * @returns {Promise<{totalLoaded: number, scrollCount: number, stopReason: string, durationMs: number}>}
 *          stopReason is one of: 'maxResults' | 'exhausted' | 'timeout' | 'noResults'
 */
async function scrollFeedToBottom(page, options = {}) {
  const maxResults = options.maxResults != null ? options.maxResults : null;
  const totalTimeoutMs = options.totalTimeoutMs || 60000;
  const stallThreshold = options.stallThreshold || 3;

  // Injectable helpers for unit testing (underscore = internal/test-only).
  const countFn = options._countResults || ((p) => countResults(p));
  const scrollFn = options._scrollToLastCard || ((p) => scrollToLastCard(p));
  const waitFn = options._waitForCountStable || ((p, o) => waitForCountStable(p, o));

  const startTime = Date.now();
  const deadline = startTime + totalTimeoutMs;

  logger.info('Starting pagination', { maxResults, totalTimeoutMs, stallThreshold });

  let scrollCount = 0;
  let stallCount = 0;
  let currentCount = await countFn(page);
  let lastProgressCount = currentCount;
  let stopReason = 'unknown';

  logger.info('Initial result count', { count: currentCount });

  // Edge case: zero results found at all.
  if (currentCount === 0) {
    stopReason = 'noResults';
    logger.warn('No results found in feed');
    return { totalLoaded: 0, scrollCount: 0, stopReason, durationMs: Date.now() - startTime };
  }

  // Edge case: maxResults already met/exceeded by the initial load.
  if (maxResults != null && currentCount >= maxResults) {
    stopReason = 'maxResults';
    logger.info('maxResults met by initial load', { count: currentCount, maxResults });
    return { totalLoaded: currentCount, scrollCount: 0, stopReason, durationMs: Date.now() - startTime };
  }

  // Main scroll loop.
  while (true) {
    // Check total timeout FIRST so a misconfigured tiny timeout still exits.
    if (Date.now() >= deadline) {
      stopReason = 'timeout';
      logger.warn('Pagination timed out', { count: currentCount, totalTimeoutMs });
      break;
    }

    // Scroll + wait for the next batch to settle.
    await scrollFn(page);
    scrollCount += 1;

    const { count: settledCount } = await waitFn(page);
    currentCount = settledCount;

    const delta = currentCount - lastProgressCount;
    logger.info('Scroll progress', {
      scroll: scrollCount,
      loaded: currentCount,
      delta: delta >= 0 ? `+${delta}` : `${delta}`,
      stall: stallCount,
    });

    // Stop condition 1: maxResults reached.
    if (maxResults != null && currentCount >= maxResults) {
      stopReason = 'maxResults';
      logger.info('maxResults reached, stopping pagination', { count: currentCount, maxResults });
      break;
    }

    // Stop condition 2: stall (no progress on this scroll).
    if (currentCount === lastProgressCount) {
      stallCount += 1;
      logger.debug('No progress on this scroll', { stallCount, threshold: stallThreshold });
      if (stallCount >= stallThreshold) {
        stopReason = 'exhausted';
        logger.info('Results exhausted (stall threshold reached)', { count: currentCount, stallCount });
        break;
      }
    } else {
      // Progress made — reset stall counter and update baseline.
      stallCount = 0;
      lastProgressCount = currentCount;
    }
  }

  const durationMs = Date.now() - startTime;
  logger.info('Pagination complete', {
    totalLoaded: currentCount,
    scrollCount,
    stopReason,
    durationMs,
  });

  return { totalLoaded: currentCount, scrollCount, stopReason, durationMs };
}

module.exports = {
  FEED_SELECTORS,
  CARD_SELECTORS,
  countResults,
  scrollToLastCard,
  waitForCountStable,
  scrollFeedToBottom,
};
