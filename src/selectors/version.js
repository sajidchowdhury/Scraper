'use strict';

/**
 * src/selectors/version.js — Phase 2.11
 *
 * Selector versioning. Every selector set (list-view in src/extract.js,
 * detail-panel in src/detail.js) has a `version` and `lastVerifiedDate`.
 * On startup the scraper logs the active version; if a set is older than
 * --maxSelectorAge (default 30 days) it warns the operator that the
 * fixture-based regression test should be re-run.
 *
 * The version number is bumped every time a selector is added or rewritten
 * in response to a Google Maps DOM change. The lastVerifiedDate is the date
 * the selectors were last confirmed to work against a captured fixture
 * (Phase 2.0 fixtures live in tests/fixtures/).
 *
 * Pure functions (getSelectorAgeDays, isSelectorSetStale) are exported for
 * unit testing. logSelectorVersion is the only side-effectful entry point.
 */

// ---------------------------------------------------------------------------
// Selector version registry
// ---------------------------------------------------------------------------
//
// When you add/rewrite a selector in src/extract.js or src/detail.js, bump
// the matching version here AND update lastVerifiedDate to today's date
// (ISO 8601, UTC). This is the single source of truth that the startup log
// and the staleness warning read from.
//
// Why this matters: Google reshuffles the Maps DOM every few weeks. Without
// a version register, there's no way to know whether the selectors in the
// codebase were verified yesterday or 18 months ago. The staleness warning
// is the first line of defense against silent selector rot.

const SELECTOR_VERSIONS = {
  // List-view feed selectors — business cards on the search results page.
  // Source: src/extract.js → SELECTORS object.
  list: {
    version: 3,
    lastVerifiedDate: '2026-08-07',
    source: 'src/extract.js',
    description: 'List-view feed: name, rating, reviews_count, phone, website, etc.',
    fields: [
      'card',
      'name',
      'rating',
      'reviews_count',
      'price_level',
      'category',
      'address',
      'phone',
      'website',
      'plus_code',
      'open_hours',
    ],
  },
  // Detail-panel selectors — fields only available on the business detail
  // page (hours, popular times, top reviews, photos, reservation/menu links).
  // Source: src/detail.js → DETAIL_SELECTORS object.
  detail: {
    version: 2,
    lastVerifiedDate: '2026-08-07',
    source: 'src/detail.js',
    description: 'Detail-panel: hours, popular_times, top reviews, photos, links',
    fields: [
      'detail_name',
      'detail_rating',
      'detail_reviews_count',
      'detail_address',
      'detail_phone',
      'detail_website',
      'detail_hours',
      'detail_popular_times',
      'detail_reviews',
      'detail_photos',
    ],
  },
  // Search-feed detection selector — "did the search load?" Used by
  // src/search.js to wait for the results feed after submitting the query.
  search: {
    version: 1,
    lastVerifiedDate: '2026-08-07',
    source: 'src/search.js',
    description: 'Feed detection: div[role="feed"] + a[href*="/maps/place/"] fallback',
    fields: ['feed'],
  },
  // End-of-list markers — inner-text phrases Google shows when you've
  // scrolled to the bottom. Source: src/scroll.js → markers array.
  scroll: {
    version: 1,
    lastVerifiedDate: '2026-08-07',
    source: 'src/scroll.js',
    description: 'End-of-list markers ("You\'ve reached the end of the list", etc.)',
    fields: ['markers'],
  },
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parse an ISO date string (YYYY-MM-DD) into a Date at UTC midnight.
 * Returns null for invalid input.
 */
function parseDate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
  // Reject rollover dates (e.g. 2026-02-31 → March 3).
  if (
    d.getUTCFullYear() !== parseInt(m[1], 10) ||
    d.getUTCMonth() !== parseInt(m[2], 10) - 1 ||
    d.getUTCDate() !== parseInt(m[3], 10)
  ) {
    return null;
  }
  return d;
}

/**
 * Return the age of a selector set in whole days, relative to `now`.
 * Returns null if the set or its lastVerifiedDate is unknown.
 *
 * @param {string} setName — key in SELECTOR_VERSIONS ('list', 'detail', ...)
 * @param {Date} [now=new Date()]
 * @returns {number|null}
 */
function getSelectorAgeDays(setName, now = new Date()) {
  const set = SELECTOR_VERSIONS[setName];
  if (!set) return null;
  const verified = parseDate(set.lastVerifiedDate);
  if (!verified) return null;
  const ms = now.getTime() - verified.getTime();
  if (ms < 0) return 0; // future-dated verification: treat as fresh
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Is a selector set stale (older than maxAge days)?
 *
 * @param {string} setName
 * @param {object} [opts]
 * @param {number} [opts.maxAgeDays=30]
 * @param {Date} [opts.now]
 * @returns {boolean}
 */
function isSelectorSetStale(setName, opts = {}) {
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const age = getSelectorAgeDays(setName, opts.now || new Date());
  if (age === null) return false;
  return age > maxAgeDays;
}

/**
 * Return a summary of all selector sets with their version + age.
 * Used by the startup log and the /health endpoint.
 */
function getSelectorStatus(opts = {}) {
  const now = opts.now || new Date();
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const out = [];
  for (const [name, set] of Object.entries(SELECTOR_VERSIONS)) {
    const age = getSelectorAgeDays(name, now);
    out.push({
      name,
      version: set.version,
      lastVerifiedDate: set.lastVerifiedDate,
      source: set.source,
      ageDays: age,
      stale: age !== null && age > maxAgeDays,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Side-effectful entry point
// ---------------------------------------------------------------------------

/**
 * Log the active selector versions + emit a staleness warning if any set
 * is older than --maxSelectorAge (default 30 days).
 *
 * @param {object} logger — the structured logger (info/warn)
 * @param {object} [opts]
 * @param {number} [opts.maxAgeDays=30]
 * @param {Date} [opts.now]
 * @returns {object} — { status: array, staleSets: array }
 */
function logSelectorVersion(logger, opts = {}) {
  const log = logger && logger.phase ? logger.phase('selectors') : logger;
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const status = getSelectorStatus({ maxAgeDays, now: opts.now });
  const staleSets = status.filter((s) => s.stale);

  // One INFO line per set, e.g.:
  //   "Selectors list v3 (last verified 2026-08-07, 12 days ago)"
  for (const s of status) {
    const ageStr =
      s.ageDays === 0
        ? 'today'
        : s.ageDays === 1
          ? '1 day ago'
          : `${s.ageDays} days ago`;
    if (log && log.info) {
      log.info(`Selectors ${s.name} v${s.version} (last verified ${s.lastVerifiedDate}, ${ageStr})`, {
        set: s.name,
        version: s.version,
        lastVerifiedDate: s.lastVerifiedDate,
        ageDays: s.ageDays,
        source: s.source,
      });
    }
  }

  // Staleness warning — one line per stale set, with the actionable hint.
  for (const s of staleSets) {
    const msg =
      `Selectors last verified ${s.ageDays} days ago (${s.name} v${s.version}) — ` +
      `consider re-running the fixture test (bun test tests/selectors-fixture.test.js) ` +
      `and bumping the version in src/selectors/version.js if the DOM changed.`;
    if (log && log.warn) {
      log.warn(msg, {
        set: s.name,
        version: s.version,
        lastVerifiedDate: s.lastVerifiedDate,
        ageDays: s.ageDays,
        maxAgeDays,
        hint: 'Run scripts/capture-fixtures.js to refresh the HTML fixtures, then bun test tests/selectors-fixture.test.js',
      });
    }
  }

  return { status, staleSets };
}

module.exports = {
  SELECTOR_VERSIONS,
  parseDate,
  getSelectorAgeDays,
  isSelectorSetStale,
  getSelectorStatus,
  logSelectorVersion,
};
