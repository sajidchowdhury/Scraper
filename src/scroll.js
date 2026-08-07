'use strict';

/**
 * src/scroll.js — Phase 1.3
 *
 * Scrolls the Google Maps results feed to the bottom, loading all lazy-
 * loaded results. Stops on:
 *   - maxResults reached
 *   - "end of list" indicator
 *   - stall (no new results for N consecutive scroll attempts)
 *   - total timeout
 *
 * Functions accept an injectable `countFn` / `scrollFn` / `endFn` for unit
 * testing without a real browser (DI pattern).
 */

/**
 * Count current result cards on the page.
 * Result cards are anchors with href containing "/maps/place/" OR
 * div[role="article"] inside the feed.
 */
async function countResults(page) {
  return page.evaluate(() => {
    // Anchors linking to a place page — most reliable signal
    const anchors = document.querySelectorAll('a[href*="/maps/place/"]');
    // Dedupe by href (Google sometimes renders duplicates during scroll)
    const seen = new Set();
    let n = 0;
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (seen.has(href)) continue;
      seen.add(href);
      n++;
    }
    return n;
  });
}

/**
 * Scroll the feed container to its bottom.
 */
async function scrollToLastCard(page) {
  return page.evaluate(() => {
    const feed = document.querySelector('div[role="feed"]');
    if (!feed) return false;
    feed.scrollTo({ top: feed.scrollHeight, behavior: 'auto' });
    return true;
  });
}

/**
 * Detect the "end of list" indicator Google shows when results are exhausted.
 */
async function isEndOfList(page) {
  return page.evaluate(() => {
    const bodyText = document.body.innerText || '';
    // Google shows variations of these when the list ends
    const markers = [
      "You've reached the end of the list",
      'reached the end',
      'No results found',
      'Try different search',
    ];
    return markers.some((m) => bodyText.includes(m));
  });
}

/**
 * Wait until result count is stable (no growth) for `pollIntervalMs` * `stableTicks`.
 */
async function waitForCountStable(countFn, { pollIntervalMs = 500, stableTicks = 2, maxWaitMs = 8000 } = {}) {
  let last = -1;
  let stable = 0;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const cur = await countFn();
    if (cur === last) {
      stable++;
      if (stable >= stableTicks) return { stable: true, count: cur };
    } else {
      stable = 0;
    }
    last = cur;
    await sleep(pollIntervalMs);
  }
  return { stable: false, count: last };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Main scroll loop. Accepts dependency-injected functions for testability.
 *
 * @param {object} opts
 * @param {() => Promise<number>} opts.countFn        - returns current result count
 * @param {() => Promise<boolean>} opts.scrollFn      - scrolls feed to bottom
 * @param {() => Promise<boolean>} opts.endFn         - returns true if end-of-list detected
 * @param {number} opts.maxResults                    - stop early if reached (null = unlimited)
 * @param {number} opts.totalTimeoutMs                - hard cap
 * @param {number} opts.stallThreshold                - consecutive no-growth scrolls to stop
 * @param {number} opts.batchDelayMs                  - delay between scroll attempts
 * @param {object} opts.logger
 */
async function scrollFeedToBottom({
  countFn,
  scrollFn,
  endFn,
  maxResults = null,
  totalTimeoutMs = 90000,
  stallThreshold = 3,
  batchDelayMs = 800,
  pollIntervalMs = 500,
  logger = { info() {}, debug() {}, warn() {} },
}) {
  const start = Date.now();
  let count = await countFn();
  let lastCount = count;
  let stallCount = 0;
  let reason = 'maxResults';

  logger.info('Scroll loop started', { initialCount: count, maxResults });

  while (true) {
    // Stop conditions
    if (maxResults !== null && count >= maxResults) {
      reason = 'maxResults';
      logger.info('Scroll stop: maxResults reached', { count, maxResults });
      break;
    }
    if (Date.now() - start > totalTimeoutMs) {
      reason = 'timeout';
      logger.warn('Scroll stop: total timeout reached', { count, elapsedMs: Date.now() - start });
      break;
    }
    if (await endFn()) {
      reason = 'endOfList';
      logger.info('Scroll stop: end-of-list indicator detected', { count });
      break;
    }
    if (stallCount >= stallThreshold) {
      reason = 'stall';
      logger.info('Scroll stop: stall threshold reached', { count, stallCount });
      break;
    }

    await scrollFn();
    await sleep(batchDelayMs);

    // Wait for count to settle after this scroll
    const { count: newCount } = await waitForCountStable(countFn, {
      pollIntervalMs,
      stableTicks: 2,
      maxWaitMs: 5000,
    });

    if (newCount > lastCount) {
      logger.info('Scroll progress', { from: lastCount, to: newCount });
      stallCount = 0;
    } else {
      stallCount++;
      logger.debug('Scroll stall', { stallCount, count: newCount });
    }
    lastCount = newCount;
    count = newCount;
  }

  return {
    finalCount: count,
    reason,
    elapsedMs: Date.now() - start,
  };
}

/**
 * Production wrapper: wires real page-based count/scroll/end functions.
 */
async function scrollFeedToBottomOnPage(page, cfg, logger) {
  return scrollFeedToBottom({
    countFn: () => countResults(page),
    scrollFn: () => scrollToLastCard(page),
    endFn: () => isEndOfList(page),
    maxResults: cfg.maxResults,
    totalTimeoutMs: cfg.scroll.totalTimeoutMs,
    stallThreshold: cfg.scroll.stallThreshold,
    batchDelayMs: cfg.scroll.batchDelayMs,
    pollIntervalMs: cfg.scroll.pollIntervalMs,
    logger,
  });
}

module.exports = {
  countResults,
  scrollToLastCard,
  isEndOfList,
  waitForCountStable,
  scrollFeedToBottom,
  scrollFeedToBottomOnPage,
  sleep,
};
