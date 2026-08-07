'use strict';

/**
 * src/session/warmup.js — Phase 2.7 — Session warmup
 *
 * A new browser context that immediately hits Google Maps looks like a
 * zero-history bot. Real users warm up their session: they visit the search
 * homepage, maybe glance at News, type a benign query, THEN navigate to Maps.
 * warmupContext() replays that pattern before the scrape's first Maps request.
 *
 * Behavior:
 *   - Visits 1-2 of: google.com (search homepage), news.google.com, or a
 *     random top-100 site (from a bundled list). The number + selection is
 *     randomized so each session's warmup looks different.
 *   - Waits a randomized 5-15 seconds (capped by opts.durationMs) between
 *     visits to look human.
 *   - Optionally performs a benign search ("weather", "news today") on the
 *     Google homepage.
 *   - Returns { visited: string[], waitedMs, searched: boolean }.
 *
 * All operations are injectable (page.goto via a stub, sleepFn, rng) so unit
 * tests run instantly and never touch the network.
 *
 * Public API:
 *   const r = await warmupContext(page, { logger, durationMs, sleepFn, rng, sites, searches, search });
 *   // r = { visited: [...], waitedMs, searched: bool, query: string|null }
 */

const { randomInt } = require('../antiblock');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_DURATION_MS = 10_000;

// Benign URLs for warmup. Google properties first (same-site as Maps, so the
// cookies set here are sent to Maps too — which is what we want: a warm
// google.com cookie jar). Then a few high-traffic third-party sites so the
// referrer / navigation history looks like a real multi-site user.
const DEFAULT_WARMUP_SITES = [
  'https://www.google.com',
  'https://news.google.com',
  'https://www.youtube.com',
  'https://en.wikipedia.org',
  'https://www.bing.com',
];

// Benign search queries. Picking one + typing it into the Google search box
// establishes a realistic interaction history before the Maps scrape.
const DEFAULT_WARMUP_SEARCHES = [
  'weather today',
  'news today',
  'time now',
  'what time is it',
];

function defaultRng() {
  return Math.random();
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// warmupContext
// ---------------------------------------------------------------------------

/**
 * Warm up a fresh browser context by visiting benign pages before the scrape.
 *
 * @param {object} page — Playwright Page (or a stub with goto + url + title)
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @param {number} [opts.durationMs=10000] — total warmup budget (cap on wait time)
 * @param {(ms:number)=>Promise<void>} [opts.sleepFn] — injectable sleep
 * @param {()=>number} [opts.rng] — injectable RNG (default Math.random)
 * @param {string[]} [opts.sites] — warmup site URLs (default DEFAULT_WARMUP_SITES)
 * @param {string[]} [opts.searches] — benign search queries (default DEFAULT_WARMUP_SEARCHES)
 * @param {boolean} [opts.search=true] — whether to perform a benign search
 * @returns {Promise<{ visited: string[], waitedMs: number, searched: boolean, query: string|null }>}
 */
async function warmupContext(page, opts = {}) {
  const logger = opts.logger || null;
  const durationMs = opts.durationMs ?? DEFAULT_DURATION_MS;
  const sleepFn = opts.sleepFn || defaultSleep;
  const rng = opts.rng || defaultRng;
  const sites = opts.sites || DEFAULT_WARMUP_SITES;
  const searches = opts.searches || DEFAULT_WARMUP_SEARCHES;
  const doSearch = opts.search !== false;

  const visited = [];
  let waitedMs = 0;
  let searched = false;
  let query = null;

  // Pick 1-2 sites to visit. Always include google.com first (so the search
  // step has a page to type into), then a random second site.
  const firstSite = sites[0]; // google.com
  const secondPool = sites.slice(1);
  const secondSite = secondPool.length > 0 ? secondPool[Math.floor(rng() * secondPool.length)] : null;
  const toVisit = secondSite ? [firstSite, secondSite] : [firstSite];

  for (const url of toVisit) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      visited.push(url);
      if (logger) logger.debug('Warmup: visited', { url });
    } catch (err) {
      // A warmup navigation failure is non-fatal — the session is still usable.
      if (logger) logger.debug('Warmup: visit failed (non-fatal)', { url, error: err.message });
    }
    // Wait a randomized 2-5s between visits (capped by the remaining budget).
    const remaining = durationMs - waitedMs;
    if (remaining <= 0) break;
    const wait = Math.min(remaining, randomInt(2000, 5000, rng));
    await sleepFn(wait);
    waitedMs += wait;
  }

  // Optionally perform a benign search on the Google homepage.
  if (doSearch && visited.includes(firstSite)) {
    query = searches[Math.floor(rng() * searches.length)];
    try {
      await performBenignSearch(page, query, { sleepFn, rng, logger });
      searched = true;
      if (logger) logger.debug('Warmup: performed benign search', { query });
      // Wait 2-4s after the search to let results render.
      const remaining = durationMs - waitedMs;
      if (remaining > 0) {
        const wait = Math.min(remaining, randomInt(2000, 4000, rng));
        await sleepFn(wait);
        waitedMs += wait;
      }
    } catch (err) {
      if (logger) logger.debug('Warmup: benign search failed (non-fatal)', { query, error: err.message });
    }
  }

  if (logger) {
    logger.info('Session warmup complete', {
      visited,
      waitedMs,
      searched,
      query,
    });
  }
  return { visited, waitedMs, searched, query };
}

// ---------------------------------------------------------------------------
// Benign search — type a query into Google's search box + press Enter
// ---------------------------------------------------------------------------

/**
 * Type a benign query into the Google homepage search box and submit.
 * Best-effort — wrapped in try/catch by the caller. Uses the antiblock
 * humanType() for realistic char-by-char input when available.
 *
 * Accepts injectable typeFn / submitFn for tests.
 */
async function performBenignSearch(page, query, opts = {}) {
  const sleepFn = opts.sleepFn || defaultSleep;
  const rng = opts.rng || defaultRng;
  const logger = opts.logger || null;

  // Try the standard search input selectors. Google's homepage has gone
  // through several layouts; we try the most common ones.
  const searchInputSelectors = [
    'textarea[name="q"]',
    'input[name="q"]',
    'input[type="text"]',
  ];
  let input = null;
  for (const sel of searchInputSelectors) {
    try {
      input = await page.$(sel);
      if (input) break;
    } catch { /* best-effort */ }
  }
  if (!input) {
    if (logger) logger.debug('Warmup search: no search input found (skipping)');
    return;
  }

  // Click + type char-by-char (human-like). Falls back to fill() if type fails.
  try {
    await input.click({ delay: randomInt(50, 150, rng) });
  } catch { /* best-effort */ }
  try {
    await page.keyboard.type(query, { delay: randomInt(50, 150, rng) });
  } catch {
    try { await input.fill(query); } catch { /* best-effort */ }
  }
  // Small human pause before Enter.
  await sleepFn(randomInt(300, 800, rng));
  try {
    await page.keyboard.press('Enter');
  } catch { /* best-effort */ }
}

module.exports = {
  warmupContext,
  performBenignSearch,
  DEFAULT_WARMUP_SITES,
  DEFAULT_WARMUP_SEARCHES,
  DEFAULT_DURATION_MS,
  defaultRng,
  defaultSleep,
};
