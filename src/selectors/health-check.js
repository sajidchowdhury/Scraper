'use strict';

/**
 * src/selectors/health-check.js — Phase 2.11
 *
 * Page-bound startup health check. The pure helpers (evaluateHealth,
 * checkExtractionRatesForAbort, CORE_FIELDS, etc.) live in src/extract.js
 * to avoid a circular require (extract.js needs the abort check, and the
 * health check needs extractBusinesses). This module re-exports them for
 * convenience and adds the page-bound `healthCheck` function.
 *
 * Two layers of protection:
 *   1. Startup health check (healthCheck) — runs BEFORE the main scrape.
 *      Loads a known-good HTML fixture into a browser, runs extractBusinesses,
 *      and checks that core fields (name, rating, reviews_count, address)
 *      extract at ≥ 50%. If they don't, the run is aborted with a clear
 *      error and exit code 3 (selector failure) — unless --skipHealthCheck
 *      is set.
 *   2. First-batch abort (checkExtractionRatesForAbort, in extract.js) —
 *      runs AFTER the first batch of N businesses (default 10) is extracted
 *      during the real scrape. If core fields are below 50%, throws a
 *      SelectorFailureError with exitCode=3.
 */

// One-way dependency: extract.js owns the pure helpers + extractBusinesses.
// This module adds the page-bound healthCheck wrapper.
const {
  extractBusinesses,
  computeExtractionRates,
  CORE_FIELDS,
  SECONDARY_FIELDS,
  SELECTOR_FAILURE_EXIT_CODE,
  CORE_THRESHOLD_PCT,
  SECONDARY_THRESHOLD_PCT,
  DEFAULT_MIN_SAMPLE_SIZE,
  evaluateHealth,
  isCriticalFailure,
  buildSelectorFailureError,
  checkExtractionRatesForAbort,
} = require('../extract');

const { discoverMissingFields, applyDiscoveryResults, buildDiscoveryRequests } = require('./auto-discover');

/**
 * Run a health-check extraction on a pre-set-up page and evaluate the rates.
 *
 * The page MUST already contain a Google Maps feed DOM (either a captured
 * fixture loaded via page.setContent, or a live URL navigated to by the
 * caller). This function does NOT navigate — it just extracts + evaluates.
 *
 * @param {import('playwright').Page} page — already set up with feed HTML
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @param {string} [opts.query='health-check'] — label for the extraction
 * @param {string} [opts.location='fixture']
 * @param {boolean} [opts.autoDiscover=true] — run auto-discover before evaluating
 * @param {number} [opts.minSampleSize=3] — startup check uses a smaller bar
 * @param {number} [opts.coreThreshold=50]
 * @param {number} [opts.secondaryThreshold=30]
 * @returns {Promise<{ ok: boolean, rates: object, health: object, businesses: Array }>}
 */
async function healthCheck(page, opts = {}) {
  const logger = opts.logger || { info() {}, warn() {}, debug() {}, error() {} };
  const log = logger.phase ? logger.phase('selectors') : logger;
  const query = opts.query || 'health-check';
  const location = opts.location || 'fixture';
  const autoDiscover = opts.autoDiscover !== false;
  const minSampleSize = opts.minSampleSize ?? 3;
  const coreThreshold = opts.coreThreshold ?? CORE_THRESHOLD_PCT;
  const secondaryThreshold = opts.secondaryThreshold ?? SECONDARY_THRESHOLD_PCT;

  log.info('Running extraction-rate health check', {
    query,
    location,
    autoDiscover,
    coreThreshold,
    secondaryThreshold,
  });

  const { businesses, extractionRates } = await extractBusinesses(page, {
    query,
    location,
    logger: log,
    // Disable the in-extract abort check + debug dumps for the health check
    // itself — we evaluate rates ourselves below.
    selectors: { abortCheck: false, debugDump: false, autoDiscover: false },
  });

  // Optional: run auto-discovery to fill in missing fields before evaluating.
  // This reflects what would happen in a real run (auto-discover is part of
  // the extraction pipeline) and avoids false alarms from fields that
  // discovery would have filled in.
  let finalBusinesses = businesses;
  let finalRates = extractionRates;
  if (autoDiscover && businesses.length > 0) {
    const requests = buildDiscoveryRequests(businesses);
    if (requests.length > 0) {
      log.info('Health check — running auto-discover for missing fields', {
        cardsWithMissing: requests.length,
      });
      try {
        const results = await discoverMissingFields(page, requests, { logger: log });
        finalBusinesses = applyDiscoveryResults(businesses, results);
        finalRates = computeExtractionRates(finalBusinesses);
      } catch (err) {
        log.warn('Health check — auto-discover failed (non-fatal)', { error: err.message });
      }
    }
  }

  const health = evaluateHealth(finalRates, {
    minSampleSize,
    coreThreshold,
    secondaryThreshold,
  });

  if (health.ok) {
    log.info('Health check passed', {
      total: health.total,
      coreRates: health.coreRates,
      secondaryRates: health.secondaryRates,
      failingSecondary: health.failingSecondary,
    });
  } else {
    log.error('Health check FAILED — aborting run', {
      total: health.total,
      failingCore: health.failingCore,
      failingSecondary: health.failingSecondary,
      coreRates: health.coreRates,
      reason: health.reason,
      hint: 'Run scripts/capture-fixtures.js to refresh fixtures, then bun test tests/selectors-fixture.test.js. Use --skipHealthCheck to bypass this check for an emergency run.',
    });
  }

  if (health.failingSecondary.length > 0 && health.ok) {
    log.warn('Health check — secondary fields below threshold (continuing)', {
      failingSecondary: health.failingSecondary,
      secondaryRates: health.secondaryRates,
    });
  }

  return { ok: health.ok, rates: finalRates, health, businesses: finalBusinesses };
}

module.exports = {
  // Re-exported pure helpers (defined in extract.js)
  SELECTOR_FAILURE_EXIT_CODE,
  CORE_FIELDS,
  SECONDARY_FIELDS,
  CORE_THRESHOLD_PCT,
  SECONDARY_THRESHOLD_PCT,
  DEFAULT_MIN_SAMPLE_SIZE,
  evaluateHealth,
  isCriticalFailure,
  buildSelectorFailureError,
  checkExtractionRatesForAbort,
  // Page-bound health check (defined here)
  healthCheck,
};
