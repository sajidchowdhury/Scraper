'use strict';

/**
 * src/search.js — Phase 1.2 (Phase 1.7: retry; Phase 1.8: anti-block)
 *
 * Navigates to Google Maps and performs the search for `query` in `location`.
 * Returns once the results feed (div[role="feed"]) is detected.
 *
 * Phase 1.7 additions:
 *   - page.goto wrapped in withRetry (transient network blips)
 *   - feed-detection waits wrapped in withRetry (slow first-paint)
 *   - On final failure, throws — the caller (index.js) logs + exits 3.
 *
 * Phase 1.8 additions:
 *   - Rate limiter: acquire a slot before page.goto (the only HTTP request
 *     this module makes). Pass cfg.rateLimiter from index.js.
 *   - Human typing: replace searchInput.fill() with humanType() (char-by-char
 *     with 50-150ms jitter) unless cfg.antiblock.humanTyping is false.
 *   - Pre-Enter randomized delay (500-1500ms) — looks like a human reading
 *     the autocomplete before submitting.
 *   - CAPTCHA detection after the feed appears: if Google throttled us, the
 *     feed won't render and detectCaptcha() will surface the reason instead
 *     of a cryptic "feed did not appear" error.
 *
 * Phase 1.9 additions:
 *   - All log lines bound to the 'search' phase so the JSON-lines log file
 *     can be filtered by pipeline stage.
 */

const { withRetry } = require('./retry');
const { humanType, randomDelay, detectCaptcha } = require('./antiblock');

const MAPS_URL = 'https://www.google.com/maps?hl=en';

async function navigateToMaps(page, logger, retryOpts = {}, rateLimiter = null) {
  // Phase 1.9 — bind to the 'search' phase (no-op if logger is a plain stub).
  const log = logger && logger.phase ? logger.phase('search') : logger;
  log.info('Navigating to Google Maps', { url: MAPS_URL });
  // Phase 1.8 — rate-limit the only outbound HTTP request this module makes.
  if (rateLimiter && typeof rateLimiter.acquire === 'function') {
    await rateLimiter.acquire('page.goto(maps)');
  }
  // Retry only when retryOpts is explicitly provided (production path).
  const hasRetry = retryOpts && retryOpts.attempts > 1;
  const gotoFn = () => page.goto(MAPS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (hasRetry) {
    await withRetry(gotoFn, { ...retryOpts, label: 'page.goto(maps)', logger: log });
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
    log.debug('Dismissed consent dialog');
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

/**
 * Phase 1.8 — type the query char-by-char with randomized jitter, unless
 * antiblock.humanTyping is false (then fall back to instant .fill()).
 */
async function typeSearchQuery(page, searchInput, fullQuery, cfg, logger) {
  const log = logger && logger.phase ? logger.phase('search') : logger;
  const ab = (cfg && cfg.antiblock) || {};
  if (ab.humanTyping === false) {
    log.debug('Human typing disabled — using instant fill', { chars: fullQuery.length });
    await searchInput.fill(fullQuery);
    return { typed: 'fill', chars: fullQuery.length, delays: [] };
  }
  const minMs = ab.typeKeyMinMs ?? 50;
  const maxMs = ab.typeKeyMaxMs ?? 150;
  const result = await humanType(page, fullQuery, { minMs, maxMs });
  log.debug('Human-typed search query', {
    chars: result.chars,
    keyDelayRange: [minMs, maxMs],
    totalTypedMs: result.delays.reduce((a, b) => a + b, 0),
  });
  return { typed: 'human', ...result };
}

async function performSearch(page, cfg, logger, retryOpts = {}, rateLimiter = null) {
  // Phase 1.9 — bind every line in this module to the 'search' phase.
  const log = logger && logger.phase ? logger.phase('search') : logger;
  const ab = (cfg && cfg.antiblock) || {};
  await navigateToMaps(page, log, retryOpts, rateLimiter);

  const searchInput = await getSearchInput(page);
  if (!searchInput) {
    throw new Error('Search input not found — Google Maps DOM may have changed');
  }

  const fullQuery = `${cfg.query} in ${cfg.location}`;
  log.info('Search submitted', { query: fullQuery, humanTyping: ab.humanTyping !== false });

  await searchInput.click();
  await typeSearchQuery(page, searchInput, fullQuery, cfg, log);

  // Phase 1.8 — randomized pre-Enter delay (500-1500ms). Looks like a human
  // glancing at the autocomplete suggestions before submitting.
  const preEnterMin = ab.preEnterDelayMinMs ?? 500;
  const preEnterMax = ab.preEnterDelayMaxMs ?? 1500;
  const preWait = await randomDelay(preEnterMin, preEnterMax);
  log.debug('Pre-Enter delay', { ms: preWait, range: [preEnterMin, preEnterMax] });
  await page.keyboard.press('Enter');

  // Wait for the results feed to appear — wrapped in retry so a slow
  // first-paint or a momentary network blip doesn't fail the whole run.
  const feedSelector = 'div[role="feed"]';
  const hasRetry = retryOpts && retryOpts.attempts > 1;
  const waitFeed = () => page.waitForSelector(feedSelector, { timeout: 30000 });
  const waitFallback = () => page.waitForSelector('a[href*="/maps/place/"]', { timeout: 15000 });
  try {
    if (hasRetry) {
      await withRetry(waitFeed, { ...retryOpts, label: 'waitForSelector(feed)', logger: log });
    } else {
      await waitFeed();
    }
    log.info('Results feed detected');
  } catch {
    // Phase 1.8 — before declaring failure, check whether Google is actually
    // showing a CAPTCHA / "unusual traffic" page. If so, surface that as the
    // root cause instead of the generic "feed did not appear" message.
    const captcha = await detectCaptcha(page);
    if (captcha.detected) {
      throw new Error(
        `Google CAPTCHA / block detected during search (indicator: "${captcha.indicator}"). ` +
          'Rerun later, lower --maxRPM, or solve the CAPTCHA manually in a --headed run.',
      );
    }
    // Fallback: wait for any result card
    try {
      if (hasRetry) {
        await withRetry(waitFallback, { ...retryOpts, label: 'waitForSelector(place-link fallback)', logger: log });
      } else {
        await waitFallback();
      }
      log.info('Results feed detected (via place link fallback)');
    } catch {
      throw new Error('Results feed did not appear after search — possibly zero results or a CAPTCHA');
    }
  }

  return { fullQuery };
}

module.exports = { performSearch, navigateToMaps, getSearchInput, typeSearchQuery, MAPS_URL };
