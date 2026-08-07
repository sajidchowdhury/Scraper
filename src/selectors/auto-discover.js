'use strict';

/**
 * src/selectors/auto-discover.js — Phase 2.11
 *
 * Heuristic auto-discovery for fields whose selectors all fail. When every
 * candidate selector for a field misses on a card, we fall back to pattern-
 * based discovery: scan the card DOM for an element whose text/attributes
 * match the field's "shape" (a phone number regex, an aria-label containing
 * "stars", a non-Google <a href>, etc.).
 *
 * Discovery is a FALLBACK, not a primary strategy — it's slow (one pass per
 * missing field per card) and produces a less reliable value than a known
 * selector. The intent is to keep extraction alive (non-null fields) when
 * Google changes the DOM, until a human can craft a new selector. Every
 * successful discovery is logged so the operator can copy the suggested
 * selector into src/extract.js.
 *
 * Supported fields (see DISCOVERY_PATTERNS below):
 *   phone          — element whose text matches a phone-number regex, or
 *                    a[href^="tel:"], or anything with aria-label*="phone".
 *   website        — <a href^="http"> whose host is NOT google.com / maps.
 *   rating         — element with aria-label containing "rated" or "stars".
 *   reviews_count  — element whose text matches "(1,234)" or "1,234 reviews".
 *
 * Each discovery returns { selector, value, snippet } where `selector` is a
 * best-effort CSS selector that would re-find the element (for the operator
 * to copy into src/extract.js), `value` is the raw text/href to be parsed
 * by the existing normalizers, and `snippet` is the first 500 chars of the
 * card's innerHTML (for the debug-dump).
 *
 * Pure helpers (buildDiscoveryRequests, applyDiscoveryResults) are exported
 * for unit testing. discoverField + discoverMissingFields are the
 * side-effectful (page.evaluate) entry points.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The set of fields auto-discovery knows how to find. Other canonical fields
 * (name, address, category, plus_code, open_hours, business_status) are NOT
 * discoverable — they have no reliable text/attribute shape, and discovery
 * would produce too many false positives.
 */
const DISCOVERABLE_FIELDS = ['phone', 'website', 'rating', 'reviews_count'];

/**
 * Build the list of (cardIndex, field) pairs to discover for a batch of
 * normalized records. A field is "missing" on a card when the normalized
 * value is null/empty. Only fields in DISCOVERABLE_FIELDS are requested.
 *
 * Pure function — exported for unit testing.
 *
 * @param {Array<object>} businesses — normalized records from extractBusinesses
 * @param {object} [opts]
 * @param {string[]} [opts.fields=DISCOVERABLE_FIELDS] — restrict discovery to these fields
 * @returns {Array<{ cardIndex: number, fields: string[] }>}
 */
function buildDiscoveryRequests(businesses, opts = {}) {
  const fields = opts.fields || DISCOVERABLE_FIELDS;
  const requests = [];
  for (let i = 0; i < businesses.length; i++) {
    const b = businesses[i];
    if (!b) continue;
    const missing = fields.filter((f) => {
      const v = b[f];
      return v === null || v === undefined || v === '';
    });
    if (missing.length > 0) {
      requests.push({ cardIndex: i, fields: missing });
    }
  }
  return requests;
}

/**
 * Apply discovered values back onto the normalized records.
 * Returns a new array of businesses with discovered fields filled in.
 *
 * Pure function — exported for unit testing.
 *
 * NOTE: discovered values are written into the canonical field slot (e.g.
 * `phone`), NOT into a side-channel tag. This keeps the record shape at
 * exactly CANONICAL_FIELDS keys (existing tests assert this). The count of
 * discovered fields is tracked separately in extract.js's discoveryStats.
 *
 * Discovery returns RAW values (strings — aria-label text, href, innerText).
 * The caller should pass `normalizers` to convert raw → canonical type
 * (e.g. parseRating: '4.2 stars' → 4.2, parseReviewsCount: '(1,234)' → 1234).
 * When no normalizer is provided for a field, the raw value is written as-is.
 *
 * @param {Array<object>} businesses
 * @param {Array<{ cardIndex: number, discovered: object }>} results
 * @param {object} [opts]
 * @param {boolean} [opts.tagDiscovered=false] — when true, add a `_discovered_<field>: true`
 *   tag for each filled-in field (for tests that need to verify discovery ran).
 *   Default false — keeps the record shape canonical.
 * @param {object} [opts.normalizers] — { field: (rawValue) => normalizedValue }
 * @returns {Array<object>} — new array (does not mutate input)
 */
function applyDiscoveryResults(businesses, results, opts = {}) {
  if (!results || results.length === 0) return businesses;
  const tagDiscovered = opts.tagDiscovered === true;
  const normalizers = opts.normalizers || {};
  const out = businesses.slice();
  for (const { cardIndex, discovered } of results) {
    if (cardIndex == null || !discovered) continue;
    const b = out[cardIndex];
    if (!b) continue;
    const merged = { ...b };
    for (const [field, info] of Object.entries(discovered)) {
      if (!info || info.value == null) continue;
      // Only fill in if the field is currently null — discovery is a
      // fallback, never an override.
      if (merged[field] === null || merged[field] === undefined || merged[field] === '') {
        const raw = info.value;
        const normalized = normalizers[field] ? normalizers[field](raw) : raw;
        merged[field] = normalized;
        if (tagDiscovered) merged[`_discovered_${field}`] = true;
      }
    }
    out[cardIndex] = merged;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Browser-side discovery logic (inlined into page.evaluate)
// ---------------------------------------------------------------------------
//
// The function below is serialized into the page.evaluate call. It MUST be
// self-contained (no closure over Node-side variables) and use only browser
// globals (document, window, CSS, Array, etc.). We keep it as a string so it
// can be unit-tested by evaluating it in a jsdom-like context if needed.
//
// IMPORTANT: when editing this string, keep the function body pure — no
// references to outer-scope Node variables. All inputs come via the `req`
// argument that page.evaluate passes in.

const DISCOVERY_SCRIPT = `
function describeSelector(el) {
  if (!el) return null;
  var tag = (el.tagName || '').toLowerCase();
  if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
  var dataItemId = el.getAttribute('data-item-id');
  if (dataItemId) return tag + '[data-item-id="' + dataItemId + '"]';
  var aria = el.getAttribute('aria-label');
  if (aria) {
    var short = aria.slice(0, 25).replace(/"/g, "'");
    return tag + '[aria-label*="' + short + '"]';
  }
  var href = el.getAttribute('href');
  if (href) {
    var shortHref = href.slice(0, 30).replace(/"/g, "'");
    return tag + '[href^="' + shortHref + '"]';
  }
  if (el.className && typeof el.className === 'string') {
    var firstCls = el.className.trim().split(/\\s+/)[0];
    if (firstCls) {
      return tag + '.' + (window.CSS && CSS.escape ? CSS.escape(firstCls) : firstCls);
    }
  }
  return tag;
}

function discoverInCard(card, fieldName) {
  if (!card) return null;
  var PHONE_RE = /^[+]?[\\d\\s\\-()]{7,}$/;
  var REVIEW_PAREN_RE = /^\\(\\d[\\d,]*\\)$/;
  var REVIEW_TEXT_RE = /^\\d[\\d,]*\\s+reviews?$/i;
  var GOOGLE_HOST_RE = /(?:^|\\.)(google\\.[a-z.]+|googlemaps\\.com|maps\\.google\\.[a-z.]+)$/i;

  function snippet() {
    try { return (card.innerHTML || '').slice(0, 500); } catch (e) { return ''; }
  }

  if (fieldName === 'phone') {
    // 1. aria-label containing "phone"
    var all = Array.prototype.slice.call(card.querySelectorAll('[aria-label]'));
    for (var i = 0; i < all.length; i++) {
      var aria = all[i].getAttribute('aria-label') || '';
      if (/phone/i.test(aria)) {
        var t = (all[i].innerText || all[i].textContent || '').trim();
        if (t && PHONE_RE.test(t)) {
          return { selector: describeSelector(all[i]), value: t, snippet: snippet() };
        }
      }
    }
    // 2. tel: link
    var telLink = card.querySelector('a[href^="tel:"]');
    if (telLink) {
      var href = telLink.getAttribute('href') || '';
      return { selector: 'a[href^="tel:"]', value: href.slice(4), snippet: snippet() };
    }
    // 3. data-item-id containing "phone"
    var phoneEl = card.querySelector('[data-item-id*="phone"]');
    if (phoneEl) {
      var raw = phoneEl.getAttribute('data-item-id') || (phoneEl.innerText || '').trim();
      return { selector: '[data-item-id*="phone"]', value: raw, snippet: snippet() };
    }
    // 4. Any element whose text matches the phone regex (last resort — false-positive-prone)
    var candidates = Array.prototype.slice.call(card.querySelectorAll('span, a, button, div'));
    for (var j = 0; j < candidates.length; j++) {
      var ct = (candidates[j].innerText || '').trim();
      if (ct && ct.length >= 7 && ct.length < 25 && PHONE_RE.test(ct)) {
        // Avoid matching review counts, ratings, zip codes — require a + or parens or 10+ digits
        var digitCount = (ct.match(/\\d/g) || []).length;
        if (ct.charAt(0) === '+' || ct.indexOf('(') !== -1 || digitCount >= 10) {
          return { selector: describeSelector(candidates[j]), value: ct, snippet: snippet() };
        }
      }
    }
    return null;
  }

  if (fieldName === 'website') {
    // Find an <a href^="http"> whose host is NOT google / maps.
    var anchors = Array.prototype.slice.call(card.querySelectorAll('a[href^="http"]'));
    for (var k = 0; k < anchors.length; k++) {
      var href = anchors[k].getAttribute('href') || '';
      var host;
      try { host = new URL(href).hostname; } catch (e) { host = ''; }
      if (!host) continue;
      if (GOOGLE_HOST_RE.test(host)) continue;
      // Skip common non-website links (tel:, mailto:, schema.org)
      if (/^mailto:|tel:|javascript:/i.test(href)) continue;
      return { selector: describeSelector(anchors[k]), value: href, snippet: snippet() };
    }
    return null;
  }

  if (fieldName === 'rating') {
    // 1. element with aria-label containing "rated" or "stars"
    var rated = Array.prototype.slice.call(card.querySelectorAll('[aria-label]'));
    for (var m = 0; m < rated.length; m++) {
      var aria = rated[m].getAttribute('aria-label') || '';
      if (/rated|stars/i.test(aria)) {
        return { selector: describeSelector(rated[m]), value: aria, snippet: snippet() };
      }
    }
    // 2. element with role="img" and aria-label containing a number
    var imgRoles = Array.prototype.slice.call(card.querySelectorAll('[role="img"]'));
    for (var n = 0; n < imgRoles.length; n++) {
      var ia = imgRoles[n].getAttribute('aria-label') || '';
      if (/^\\d+(\\.\\d+)?(\\s+(stars?|out\\s+of\\s+\\d+))?$/i.test(ia)) {
        return { selector: describeSelector(imgRoles[n]), value: ia, snippet: snippet() };
      }
    }
    return null;
  }

  if (fieldName === 'reviews_count') {
    // Find an element whose text matches "(1,234)" or "1,234 reviews"
    var spans = Array.prototype.slice.call(card.querySelectorAll('span, div, button, a'));
    for (var p = 0; p < spans.length; p++) {
      var t = (spans[p].innerText || '').trim();
      if (!t || t.length > 30) continue;
      if (REVIEW_PAREN_RE.test(t) || REVIEW_TEXT_RE.test(t)) {
        return { selector: describeSelector(spans[p]), value: t, snippet: snippet() };
      }
    }
    return null;
  }

  return null;
}

function discoverBatch(requests) {
  // Find card elements the same way extractRawFromPage does: by place-anchor
  // href, then closest [role="article"]. This keeps the cardIndex stable
  // between extraction and discovery (the same index in the rawRecords array
  // points to the same card in the DOM).
  var anchors = [];
  var seenHrefs = {};
  var allAnchors = document.querySelectorAll('a[href*="/maps/place/"]');
  for (var i = 0; i < allAnchors.length; i++) {
    var href = allAnchors[i].getAttribute('href') || '';
    if (!href || seenHrefs[href]) continue;
    seenHrefs[href] = true;
    anchors.push(allAnchors[i]);
  }

  return requests.map(function (req) {
    var anchor = anchors[req.cardIndex];
    if (!anchor) return { cardIndex: req.cardIndex, discovered: {} };
    var card = anchor.closest('[role="article"]') || anchor;
    var discovered = {};
    for (var f = 0; f < req.fields.length; f++) {
      var r = discoverInCard(card, req.fields[f]);
      if (r) discovered[req.fields[f]] = r;
    }
    return { cardIndex: req.cardIndex, discovered: discovered };
  });
}

return discoverBatch;
`;

// ---------------------------------------------------------------------------
// Side-effectful entry points (page.evaluate wrappers)
// ---------------------------------------------------------------------------

/**
 * Discover multiple missing fields across multiple cards in a single
 * page.evaluate round-trip. `requests` is the output of buildDiscoveryRequests.
 *
 * @param {import('playwright').Page} page
 * @param {Array<{ cardIndex: number, fields: string[] }>} requests
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @returns {Promise<Array<{ cardIndex: number, discovered: object }>>}
 */
async function discoverMissingFields(page, requests, opts = {}) {
  const logger = opts.logger || { info() {}, warn() {}, debug() {}, error() {} };
  if (!requests || requests.length === 0) return [];

  // Build the discovery function in-browser, then call it with the requests.
  // Playwright's page.evaluate accepts a single argument — wrap the script
  // source + requests in one object.
  const results = await page.evaluate(
    async (payload) => {
      // eslint-disable-next-line no-new-func
      const factory = new Function(payload.scriptSrc + '\n');
      const discoverBatch = factory();
      return discoverBatch(payload.requests);
    },
    { scriptSrc: DISCOVERY_SCRIPT, requests },
  );

  // Log each successful discovery so the operator can copy the selector.
  for (const { cardIndex, discovered } of results) {
    for (const [field, info] of Object.entries(discovered || {})) {
      if (!info) continue;
      logger.info(
        `Auto-discovered ${field} field (selector: ${info.selector}) — add to SELECTORS.js`,
        {
          cardIndex,
          field,
          selector: info.selector,
          value: String(info.value).slice(0, 60),
        },
      );
    }
  }

  return results;
}

/**
 * Discover a single field on a single card. Convenience wrapper around
 * discoverMissingFields for one-off use (testing, debugging).
 *
 * @param {import('playwright').Page} page
 * @param {number} cardIndex
 * @param {string} fieldName
 * @param {object} [opts]
 * @returns {Promise<{ selector: string, value: string, snippet: string } | null>}
 */
async function discoverField(page, cardIndex, fieldName, opts = {}) {
  const results = await discoverMissingFields(
    page,
    [{ cardIndex, fields: [fieldName] }],
    opts,
  );
  if (!results || !results[0]) return null;
  return results[0].discovered?.[fieldName] || null;
}

module.exports = {
  DISCOVERABLE_FIELDS,
  DISCOVERY_SCRIPT,
  buildDiscoveryRequests,
  applyDiscoveryResults,
  discoverField,
  discoverMissingFields,
};
