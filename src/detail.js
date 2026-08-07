'use strict';

/**
 * src/detail.js — Phase 1.5 — Detail-Page Deep Scrape (Optional)
 *
 * Clicks into each business's detail panel to fetch fields not visible in the
 * list view, then returns to the results list. Toggleable via cfg.deepScrape.
 *
 * Detail fields (added to each business record when deepScrape is on):
 *   full_hours       — structured per-day opening hours [{day, hours}, ...]
 *   popular_times    — busyness histogram [{day, busy:[0..23]}, ...]  (noisy)
 *   top_reviews      — top N reviews [{author, rating, text, date}, ...]
 *   photos           — first N photo URLs [url, ...]
 *   reservation_url  — reservation link (OpenTable / Resy / etc.) | null
 *   menu_url         — menu link (restaurants) | null
 *   social_profiles  — [{platform, url}, ...]  (Instagram / Facebook / etc.)
 *   detail_scraped   — boolean (true if detail load succeeded)
 *
 * Design rules (per Phase 1.5 spec):
 *   - Toggleable: --deepScrape true|false, default false (keep runs fast)
 *   - Per-detail randomized delay (1.5-3.5s default, Phase 1.8) to avoid
 *     hammering Google
 *   - Per-business failure isolation: a failed detail load logs + continues;
 *     that business keeps its list-view fields with null detail fields
 *   - Detail-scrape success rate tracked + logged
 *   - Adds ~2-4s per business (measurable in logs)
 *
 * Phase 1.8 additions:
 *   - Rate limiter: acquire a slot before each detail-panel open (the only
 *     new HTTP request per business). Pass cfg.rateLimiter from index.js.
 *   - CAPTCHA detection: deepScrapeAll accepts a captchaCheck hook; after each
 *     business, if the hook reports a CAPTCHA, the run pauses + alerts the
 *     operator, then aborts (auto-solve is Phase 2).
 *
 * Phase 1.9 additions:
 *   - All log lines bound to the 'detail' phase so the JSON-lines log file
 *     can be filtered by pipeline stage. Per-business outcome (success/fail
 *     + timing) is now logged with the phase tag, making it queryable.
 *
 * Functions accept injectable openFn/extractFn/backFn for unit testing
 * without a real browser (DI pattern, matching src/scroll.js).
 */

const { withRetry } = require('./retry');
const { randomInt } = require('./antiblock');

// ---------------------------------------------------------------------------
// Detail field schema (exported for CSV column order in Phase 1.6)
// ---------------------------------------------------------------------------

const DETAIL_FIELDS = [
  'full_hours',
  'popular_times',
  'top_reviews',
  'photos',
  'reservation_url',
  'menu_url',
  'social_profiles',
  'detail_scraped',
];

// Fields a business record has when deepScrape is OFF — all null/false so the
// CSV column order is stable whether or not detail scraping ran.
const EMPTY_DETAIL = {
  full_hours: null,
  popular_times: null,
  top_reviews: [],
  photos: [],
  reservation_url: null,
  menu_url: null,
  social_profiles: [],
  detail_scraped: false,
};

// ---------------------------------------------------------------------------
// In-browser selector list. Google changes the DOM often, so each field has
// 2-4 candidate selectors tried in order.
// ---------------------------------------------------------------------------

const DETAIL_SELECTORS = {
  // The detail panel container. Modern Maps uses an aria-label="Place info"
  // or a div[role="region"] that wraps the place details.
  panel: [
    'div[role="region"][aria-label*="info"]',
    'div[aria-label*="Place"]',
    'div.bAPzgb',
    '[role="main"] [role="region"]',
  ],
  // Hours table — Google renders a <table> with rows per day, OR a set of
  // div rows. We support both.
  hoursTable: [
    'table[aria-label*="Hours"]',
    'table.y0bXy',
    'div[aria-label*="Hours table"]',
  ],
  hoursRow: [
    'table[aria-label*="Hours"] tr',
    'table.y0Xkzf tr',
    'div[role="row"]',
  ],
  // Popular times — the busyness bar chart. Each bar has aria-label like
  // "Currently not busy" / "Usually busy at 3 PM" / a day-name header.
  popularTimesBar: [
    'div[role="img"][aria-label*="busy"]',
    'div[aria-label*="Popular times"] div[role="img"]',
    'div.HFt63e', // legacy class
  ],
  popularTimesDay: [
    'div[aria-label*="Popular times"] button',
  ],
  // Reviews
  reviewBlock: [
    'div[data-review-id]',
    'div.jJc9Ad', // modern review container class
    'div[jsaction*="review"]',
  ],
  // Photos — thumbnails in the photo carousel/grid
  photoImg: [
    'button[jsaction*="photo"] img',
    'div[jsaction*="photo"] img',
    'img[data-src]',
    'img.KmsPWd',
  ],
  // Reservation / menu / order links — Maps renders these as action buttons
  // with data-item-id containing the action type.
  reservationLink: [
    'a[data-item-id*="reservation"]',
    'a[aria-label*="Reserve"]',
    'a[aria-label*="reservation"]',
    'a[href*="opentable.com"], a[href*="resy.com"], a[href*="booking.com"]',
  ],
  menuLink: [
    'a[data-item-id*="menu"]',
    'a[aria-label*="Menu"]',
    'button[aria-label*="Menu"]',
  ],
  // Social profiles — Instagram / Facebook / X / etc. links in the action bar
  socialLinks: [
    'a[data-item-id*="authority"]', // generic website authority
    'a[href*="instagram.com"]',
    'a[href*="facebook.com"]',
    'a[href*="twitter.com"], a[href*="x.com"]',
    'a[href*="linkedin.com"]',
    'a[href*="youtube.com"]',
  ],
};

// ---------------------------------------------------------------------------
// Small DOM helpers (in-browser)
// ---------------------------------------------------------------------------

function pick(scope, list) {
  for (const s of list) {
    try {
      const el = scope.querySelector(s);
      if (el) return el;
    } catch {
      /* invalid selector for this scope — try next */
    }
  }
  return null;
}

function textOrEmpty(el) {
  if (!el) return '';
  return (el.innerText || el.textContent || '').trim();
}

// ---------------------------------------------------------------------------
// Field parsers (pure functions — exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parse a 7-day hours table into structured form.
 * Input: array of { day: string, text: string } rows extracted from DOM.
 * Output: [{ day, hours }, ...] with hours normalized.
 *   - "Closed" stays "Closed"
 *   - "9:00 AM – 5:00 PM" stays as-is
 *   - Empty → null
 *
 * Google's day labels are localized; we normalize the English ones and pass
 * others through verbatim (Phase 3 will add full i18n).
 */
const DAY_ALIASES = {
  monday: 'Monday',
  mon: 'Monday',
  tuesday: 'Tuesday',
  tue: 'Tuesday',
  tues: 'Tuesday',
  wednesday: 'Wednesday',
  wed: 'Wednesday',
  weds: 'Wednesday',
  thursday: 'Thursday',
  thu: 'Thursday',
  thur: 'Thursday',
  thurs: 'Thursday',
  friday: 'Friday',
  fri: 'Friday',
  saturday: 'Saturday',
  sat: 'Saturday',
  sunday: 'Sunday',
  sun: 'Sunday',
};

function normalizeDay(raw) {
  if (!raw) return null;
  const lower = String(raw).trim().toLowerCase().replace(/\.+$/, '');
  return DAY_ALIASES[lower] || String(raw).trim();
}

function parseHoursTable(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const out = [];
  for (const { day, text } of rows) {
    if (!day && !text) continue;
    const hours = text ? String(text).trim() : null;
    if (!hours) continue;
    out.push({ day: normalizeDay(day) || day, hours });
  }
  return out.length > 0 ? out : null;
}

/**
 * Parse popular-times bars into a per-day busyness histogram.
 * Input: array of { day, bars: [{ label, hour }] }
 *   - label: aria-label text like "Usually busy at 3 PM" or "Not busy"
 *   - hour: inferred hour 0-23 (parsed from label, or index)
 * Output: [{ day, busy: [{hour, level}, ...] }, ...]
 *   - level: 0-4 (not busy → very busy), parsed from label keywords
 *
 * This is inherently noisy — Google's popular-times labels are freeform text.
 * We extract a best-effort 0-4 busyness level per hour.
 */
const BUSY_KEYWORDS = [
  { re: /(usually|currently)?\s*(very|extremely)\s*(busy|busy)/i, level: 4 },
  { re: /(usually|currently)\s*busy/i, level: 3 },
  { re: /(usually|currently)\s*(a little|slightly)\s*busy/i, level: 2 },
  { re: /(usually|currently)\s*not\s*(as|too)\s*busy/i, level: 2 },
  { re: /(usually|currently)\s*not\s*busy/i, level: 1 },
  { re: /not\s*busy/i, level: 1 },
];

function parseBusyLevel(label) {
  if (!label) return 0;
  const s = String(label);
  for (const { re, level } of BUSY_KEYWORDS) {
    if (re.test(s)) return level;
  }
  return 0;
}

function parseHourFromLabel(label) {
  if (!label) return null;
  const m = String(label).match(/(\d{1,2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const meridiem = m[2].toUpperCase();
  if (meridiem === 'PM' && h !== 12) h += 12;
  if (meridiem === 'AM' && h === 12) h = 0;
  return h;
}

function parsePopularTimes(dayEntries) {
  if (!Array.isArray(dayEntries) || dayEntries.length === 0) return null;
  const out = [];
  for (const { day, bars } of dayEntries) {
    if (!bars || bars.length === 0) continue;
    const nd = normalizeDay(day) || day;
    // For each bar, prefer an explicit hour; otherwise parse the hour from the
    // bar's aria-label (e.g. "Usually busy at 9 AM" → 9); fall back to the
    // bar's positional index so we always have a sortable 0-23 value.
    const busy = bars.map((b, i) => {
      const parsedHour = parseHourFromLabel(b.label);
      return {
        hour: b.hour != null ? b.hour : parsedHour != null ? parsedHour : i,
        level: parseBusyLevel(b.label),
        label: b.label || null,
      };
    });
    out.push({ day: nd, busy });
  }
  return out.length > 0 ? out : null;
}

/**
 * Parse a raw review DOM extraction into a normalized review object.
 * Input: { author, ratingRaw, text, dateRaw }
 * Output: { author, rating, text, date } with rating as float|null
 */
function parseReview(raw) {
  if (!raw) return null;
  let rating = null;
  if (raw.ratingRaw) {
    const m = String(raw.ratingRaw).match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const v = parseFloat(m[1]);
      if (Number.isFinite(v) && v >= 0 && v <= 5) rating = v;
    }
  }
  const text = raw.text ? String(raw.text).trim() : null;
  const author = raw.author ? String(raw.author).trim() : null;
  const date = raw.dateRaw ? String(raw.dateRaw).trim() : null;
  // Drop reviews with no text AND no author (essentially empty)
  if (!text && !author && rating === null) return null;
  return { author, rating, text, date };
}

/**
 * Classify a social-profile URL into a platform name.
 * Returns 'instagram' | 'facebook' | 'twitter' | 'linkedin' | 'youtube' |
 *         'website' | 'other'.
 */
function classifySocialUrl(url) {
  if (!url) return 'other';
  const u = String(url).toLowerCase();
  if (u.includes('instagram.com')) return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.com')) return 'facebook';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'twitter';
  if (u.includes('linkedin.com')) return 'linkedin';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
  return 'other';
}

function parseSocialProfiles(urls, opts = {}) {
  if (!Array.isArray(urls)) return [];
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    if (!url) continue;
    let clean = url;
    try {
      const u = new URL(url);
      ['utm_source', 'utm_medium', 'utm_campaign', 'gclid', 'fbclid'].forEach((k) =>
        u.searchParams.delete(k),
      );
      clean = u.toString();
    } catch {
      /* keep raw */
    }
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ platform: classifySocialUrl(clean), url: clean });
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-browser raw extractor. Runs as page.evaluate to avoid round-trips.
// Returns the raw detail fields; normalization happens in Node afterwards.
// ---------------------------------------------------------------------------

async function extractDetailFromPage(page, opts = {}) {
  const maxReviews = opts.maxReviews ?? 5;
  const maxPhotos = opts.maxPhotos ?? 5;

  return page.evaluate(
    (args) => {
      const { selectorsJson, maxReviews, maxPhotos } = args;
      const SEL = JSON.parse(selectorsJson);

      function pickScope(scope, list) {
        for (const s of list) {
          try {
            const el = scope.querySelector(s);
            if (el) return el;
          } catch {
            /* try next */
          }
        }
        return null;
      }

      // Detail panel is the main content region. Fall back to document.
      const panel =
        pickScope(document, SEL.panel) || document.querySelector('[role="main"]') || document;

      // --- Hours table ---------------------------------------------------
      let hoursRows = [];
      const hoursTable = pickScope(panel, SEL.hoursTable);
      const rowCandidates = hoursTable
        ? Array.from(hoursTable.querySelectorAll('tr'))
        : Array.from(panel.querySelectorAll(SEL.hoursRow.join(',')));
      for (const tr of rowCandidates) {
        const cells = Array.from(tr.querySelectorAll('td, th, div'));
        if (cells.length < 2) continue;
        const day = (cells[0].innerText || '').trim();
        const text = (cells[1].innerText || '').trim();
        if (day) hoursRows.push({ day, text });
      }
      // Some layouts hide hours behind a "Hours" button — skip those; the
      // visible table is what we want.

      // --- Popular times -------------------------------------------------
      let popularDayEntries = [];
      // Google renders popular times as a row of bars per day. The whole chart
      // is often under one container; bars carry aria-labels like
      // "Usually busy at 3 PM". We bucket by day header if present.
      const ptContainer = panel.querySelector('[aria-label*="Popular times"], div.HFt63e');
      if (ptContainer) {
        // Try per-day buttons (newer layout): each <button> = one day column
        const dayButtons = Array.from(ptContainer.querySelectorAll('button'));
        if (dayButtons.length > 0) {
          for (const btn of dayButtons) {
            const dayLabel = (btn.getAttribute('aria-label') || '').trim();
            const bars = Array.from(btn.querySelectorAll('div[role="img"], div[aria-label]'))
              .map((b) => ({
                label: b.getAttribute('aria-label') || b.getAttribute('title') || '',
              }))
              .filter((b) => b.label);
            if (bars.length) {
              popularDayEntries.push({ day: dayLabel, bars });
            }
          }
        } else {
          // Single-day "currently" chart: bars directly under container
          const bars = Array.from(ptContainer.querySelectorAll('div[role="img"], div[aria-label]'))
            .map((b) => ({
              label: b.getAttribute('aria-label') || b.getAttribute('title') || '',
            }))
            .filter((b) => b.label);
          if (bars.length) {
            popularDayEntries.push({ day: 'Today', bars });
          }
        }
      }

      // --- Reviews -------------------------------------------------------
      const reviewEls = Array.from(panel.querySelectorAll(SEL.reviewBlock.join(',')));
      const topReviews = reviewEls.slice(0, maxReviews).map((el) => {
        // Author: typically a span/button with the reviewer's name
        const authorEl =
          el.querySelector('[class*="d2r"] button, .d4r55') ||
          el.querySelector('button[data-href*="contrib"]') ||
          el.querySelector('a[href*="contrib"]');
        const author = authorEl ? (authorEl.innerText || authorEl.textContent || '').trim() : null;

        // Rating: aria-label like "4 stars" or a star icon
        const ratingEl = el.querySelector('[role="img"][aria-label*="star"], span[aria-label*="star"]');
        const ratingRaw = ratingEl ? ratingEl.getAttribute('aria-label') || '' : '';

        // Text: the review body — Google uses a <span> with class containing "wiI7pd"
        const textEl =
          el.querySelector('span.wiI7pd, [class*="review-text"], div[jsaction*="review"] span') ||
          el.querySelector('span');
        const text = textEl ? (textEl.innerText || '').trim() : null;

        // Date: usually a span with class "rsqaWe" or similar
        const dateEl = el.querySelector('span.rsqaWe, [class*="date"], span:last-of-type');
        const dateRaw = dateEl ? (dateEl.innerText || '').trim() : null;

        return { author, ratingRaw, text, dateRaw };
      });

      // --- Photos --------------------------------------------------------
      const photoEls = Array.from(panel.querySelectorAll(SEL.photoImg.join(',')));
      const photos = photoEls
        .slice(0, maxPhotos)
        .map((img) => img.getAttribute('src') || img.getAttribute('data-src') || '')
        .filter(Boolean);

      // --- Reservation / Menu -------------------------------------------
      const resEl = pickScope(panel, SEL.reservationLink);
      const reservation_url = resEl ? resEl.getAttribute('href') : null;

      const menuEl = pickScope(panel, SEL.menuLink);
      const menu_url = menuEl
        ? menuEl.getAttribute('href') ||
          menuEl.getAttribute('data-url') ||
          (menuEl.tagName === 'BUTTON' ? null : null)
        : null;

      // --- Social profiles ----------------------------------------------
      // Collect all candidate social/website link hrefs, dedupe by URL.
      const socialHrefs = [];
      const seenHref = new Set();
      for (const sel of SEL.socialLinks) {
        try {
          const els = panel.querySelectorAll(sel);
          for (const a of els) {
            const href = a.getAttribute('href');
            if (!href || seenHref.has(href)) continue;
            seenHref.add(href);
            socialHrefs.push(href);
          }
        } catch {
          /* invalid selector */
        }
      }

      return {
        hoursRows,
        popularDayEntries,
        topReviews,
        photos,
        reservation_url,
        menu_url,
        socialHrefs,
      };
    },
    { selectorsJson: JSON.stringify(DETAIL_SELECTORS), maxReviews, maxPhotos },
  );
}

// ---------------------------------------------------------------------------
// Normalize raw detail extraction into canonical detail-field shape
// ---------------------------------------------------------------------------

function normalizeDetail(raw, opts = {}) {
  // normalizeDetail is the SUCCESS-path normalizer — if we're calling it, the
  // detail panel loaded and we extracted *something* (even if all fields are
  // empty). The failure path in deepScrapeDetails returns EMPTY_DETAIL
  // (detail_scraped: false) directly without calling this function.
  if (!raw) return { ...EMPTY_DETAIL, detail_scraped: true };
  return {
    full_hours: parseHoursTable(raw.hoursRows),
    popular_times: parsePopularTimes(raw.popularDayEntries),
    top_reviews: (raw.topReviews || [])
      .map(parseReview)
      .filter((r) => r !== null),
    photos: Array.isArray(raw.photos) ? raw.photos.slice(0, opts.maxPhotos ?? 5) : [],
    reservation_url: raw.reservation_url || null,
    menu_url: raw.menu_url || null,
    social_profiles: parseSocialProfiles(raw.socialHrefs, opts),
    detail_scraped: true,
  };
}

/**
 * Merge detail fields into a list-view business record.
 * Returns a NEW object (does not mutate input).
 */
function mergeDetailFields(business, detail) {
  const safeDetail = detail || EMPTY_DETAIL;
  return {
    ...business,
    full_hours: safeDetail.full_hours ?? null,
    popular_times: safeDetail.popular_times ?? null,
    top_reviews: safeDetail.top_reviews ?? [],
    photos: safeDetail.photos ?? [],
    reservation_url: safeDetail.reservation_url ?? null,
    menu_url: safeDetail.menu_url ?? null,
    social_profiles: safeDetail.social_profiles ?? [],
    detail_scraped: !!safeDetail.detail_scraped,
  };
}

// ---------------------------------------------------------------------------
// Core deep-scrape loop — DI version (testable without a real browser)
// ---------------------------------------------------------------------------

/**
 * Deep-scrape a single business's detail panel.
 *
 * @param {object} opts
 * @param {object} opts.business          - the list-view record (needs maps_url or href)
 * @param {() => Promise<boolean>} opts.openFn  - open the detail panel; resolve false if open failed
 * @param {() => Promise<object>} opts.extractFn - extract raw detail fields from the now-loaded panel
 * @param {() => Promise<void>} opts.backFn    - return to the results list
 * @param {number} opts.delayMinMs        - min randomized delay after open
 * @param {number} opts.delayMaxMs        - max randomized delay after open
 * @param {number} opts.timeoutMs         - hard cap for the whole detail scrape of one business
 * @param {object} opts.logger
 * @returns {Promise<{ detail, ok, elapsedMs, error }>}
 */
async function deepScrapeDetails({
  business,
  openFn,
  extractFn,
  backFn,
  delayMinMs = 1000,
  delayMaxMs = 3000,
  timeoutMs = 15000,
  logger = { info() {}, debug() {}, warn() {}, error() {} },
}) {
  // Phase 1.9 — bind to the 'detail' phase (no-op for plain stub loggers).
  const log = logger && logger.phase ? logger.phase('detail') : logger;
  const startedAt = Date.now();
  const name = business && business.name ? business.name : '(unknown)';

  // Race the whole detail scrape against a hard timeout. If we hit it, we
  // still try to go back so the next business isn't stranded on a bad panel.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, timeoutMs);

  try {
    log.debug('Opening detail panel', { business: name });
    const opened = await openFn();
    if (timedOut) throw new Error(`detail-scrape timeout (${timeoutMs}ms) before open completed`);
    if (!opened) {
      log.warn('Detail panel did not open', { business: name });
      return {
        detail: { ...EMPTY_DETAIL },
        ok: false,
        elapsedMs: Date.now() - startedAt,
        error: 'open_failed',
      };
    }

    // Randomized inter-detail delay — avoids a metronomic request pattern.
    // Phase 1.8: delay range now 1500-3500ms (was 1000-3000) per spec.
    const delay = randomInt(delayMinMs, delayMaxMs);
    await sleep(delay);

    if (timedOut) throw new Error(`detail-scrape timeout (${timeoutMs}ms) during delay`);
    const raw = await extractFn();
    if (timedOut) throw new Error(`detail-scrape timeout (${timeoutMs}ms) during extract`);

    const detail = normalizeDetail(raw);
    log.debug('Detail panel scraped', {
      business: name,
      reviews: (detail.top_reviews || []).length,
      photos: (detail.photos || []).length,
      hours: detail.full_hours ? detail.full_hours.length : 0,
      elapsedMs: Date.now() - startedAt,
    });

    return {
      detail,
      ok: true,
      elapsedMs: Date.now() - startedAt,
      error: null,
    };
  } catch (err) {
    log.warn('Detail scrape failed for business — continuing', {
      business: name,
      error: err.message,
    });
    return {
      detail: { ...EMPTY_DETAIL },
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: err.message || 'unknown',
    };
  } finally {
    clearTimeout(timer);
    // Always attempt to return to the list, even on failure. Swallow errors
    // here — a stranded panel on one business must not crash the run.
    if (backFn) {
      try {
        await backFn();
      } catch (err) {
        log.debug('backFn failed (non-fatal)', { business: name, error: err.message });
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Production wrapper: wires real page-based open/extract/back functions
// ---------------------------------------------------------------------------

/**
 * Open the detail panel for a business by clicking its place link in the
 * results list. The place link is identified by href matching the business's
 * maps_url (or the first place anchor if no match).
 *
 * @returns {Promise<boolean>} true if a panel-open signal was detected
 */
async function openDetailPanelOnPage(page, business, { logger }) {
  const log = logger && logger.phase ? logger.phase('detail') : logger;
  const targetHref = business && business.maps_url ? business.maps_url : null;

  // Find the matching place anchor in the current results list
  const anchorSelector = targetHref
    ? `a[href*="${cssEscapeHref(targetHref)}"]`
    : 'a[href*="/maps/place/"]';

  let anchor;
  try {
    anchor = await page.$(anchorSelector).catch(() => null);
  } catch {
    anchor = null;
  }
  if (!anchor) {
    // Fallback: any place anchor
    anchor = await page.$('a[href*="/maps/place/"]').catch(() => null);
  }
  if (!anchor) {
    return false;
  }

  try {
    await anchor.click({ timeout: 8000 });
  } catch (err) {
    log.debug('click on place anchor failed', { error: err.message });
    return false;
  }

  // Wait for the detail panel to appear. The panel region replaces or
  // supplements the list. We look for either the region element or a
  // secondary place-title heading.
  try {
    await page.waitForSelector(
      [
        'div[role="region"][aria-label*="info"]',
        'div[aria-label*="Place"]',
        'h1[data-attrid="title"]',
        'button[aria-label*="Back"]',
      ].join(', '),
      { timeout: 12000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Return to the results list from an open detail panel.
 * Strategy: click the browser-style Back button if present, else hit the
 * browser back navigation. Swallow all errors — caller also has a try/catch.
 */
async function backToListOnPage(page, { logger }) {
  const log = logger && logger.phase ? logger.phase('detail') : logger;
  // Try the in-Maps Back button first
  try {
    const backBtn = await page
      .$('button[aria-label*="Back"], button[jsaction*="backToList"]')
      .catch(() => null);
    if (backBtn) {
      await backBtn.click({ timeout: 5000 });
      // Give the list a moment to restore
      await sleep(400);
      return;
    }
  } catch (err) {
    log.debug('in-Maps back button failed, falling back to nav.back', {
      error: err.message,
    });
  }
  // Fallback: browser back
  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
  } catch (err) {
    log.debug('page.goBack failed', { error: err.message });
  }
}

/**
 * Production wrapper for deepScrapeDetails using a real Playwright page.
 *
 * Phase 1.7: the openFn (click + waitForSelector for the detail panel) and
 * backFn (click back / page.goBack) are wrapped in withRetry so a transient
 * click miss or navigation interrupt doesn't immediately fail the business.
 * The DI core (deepScrapeDetails) stays retry-free so its unit tests remain
 * deterministic with synthetic openFn/extractFn/backFn.
 *
 * Retry is only applied when cfg.retry is explicitly provided (production
 * path via index.js). When absent (unit tests with stub pages), no retry
 * happens — preserving backward compat with the existing fast-failing tests.
 */
async function deepScrapeDetailsOnPage(page, business, cfg, logger) {
  const log = logger && logger.phase ? logger.phase('detail') : logger;
  const detailCfg = (cfg && cfg.detail) || {};
  const ab = (cfg && cfg.antiblock) || {};
  const hasRetry = !!(cfg && cfg.retry);
  const retryOpts = hasRetry
    ? { attempts: cfg.retry.attempts || 3, baseMs: cfg.retry.baseMs || 1000, logger: log }
    : { attempts: 1, baseMs: 0, logger: log };

  // Phase 1.8 — rate-limit the detail-panel open (it triggers an XHR to
  // Google). Acquire before the openFn so the cap covers the actual request.
  const rateLimiter = cfg && cfg.rateLimiter;
  if (rateLimiter && typeof rateLimiter.acquire === 'function') {
    await rateLimiter.acquire(`detail.open(${business && business.name ? business.name : '?'})`);
  }

  const openFn = hasRetry
    ? () =>
        withRetry(
          async () => {
            const opened = await openDetailPanelOnPage(page, business, { logger: log });
            if (!opened) throw new Error('detail panel did not open');
            return opened;
          },
          { ...retryOpts, label: 'openDetailPanel' },
        )
    : () => openDetailPanelOnPage(page, business, { logger: log });

  const backFn = hasRetry
    ? () =>
        withRetry(() => backToListOnPage(page, { logger: log }), {
          ...retryOpts,
          label: 'backToList',
          attempts: Math.min(retryOpts.attempts, 2),
        })
    : () => backToListOnPage(page, { logger: log });

  // Phase 1.8 — prefer antiblock detail delay range (1500-3500ms) when present;
  // fall back to detailCfg values (1000-3000) for backward compat.
  return deepScrapeDetails({
    business,
    openFn,
    extractFn: () =>
      extractDetailFromPage(page, {
        maxReviews: detailCfg.maxReviews ?? 5,
        maxPhotos: detailCfg.maxPhotos ?? 5,
      }),
    backFn,
    delayMinMs: ab.detailDelayMinMs ?? detailCfg.delayMinMs ?? 1500,
    delayMaxMs: ab.detailDelayMaxMs ?? detailCfg.delayMaxMs ?? 3500,
    timeoutMs: detailCfg.timeoutMs ?? 15000,
    logger: log,
  });
}

// ---------------------------------------------------------------------------
// Batch deep-scrape over all businesses with success-rate tracking
// ---------------------------------------------------------------------------

/**
 * Deep-scrape every business in `businesses`, merging detail fields in place.
 *
 * @param {import('playwright').Page} page
 * @param {Array} businesses    - list-view records (mutated: detail fields merged in)
 * @param {object} cfg          - runtime config (uses cfg.detail + cfg.deepScrapeSampleStep)
 * @param {object} logger
 * @param {object} [hooks]      - Phase 1.7 hooks for crash recovery
 * @param {(progress: {index, attempted, succeeded, failed}) => void} [hooks.onProgress]
 *        Called after each business is deep-scraped; index.js uses this to
 *        write a checkpoint file every N records.
 * @param {() => Promise<{detected: boolean, indicator: string|null}>} [hooks.captchaCheck]
 *        Phase 1.8 — async function checked after each business; if it reports
 *        a CAPTCHA, the run pauses + alerts the operator, then aborts.
 * @param {number} [hooks.captchaWaitMs]
 *        Phase 1.8 — how long to pause when a CAPTCHA is detected (default 300000).
 * @returns {Promise<{ successRate, attempted, succeeded, failed, durations }>}
 */
async function deepScrapeAll(page, businesses, cfg, logger, hooks = {}) {
  // Phase 1.9 — bind every line to the 'detail' phase (no-op for stubs).
  const log = logger && logger.phase ? logger.phase('detail') : logger;
  const detailCfg = (cfg && cfg.detail) || {};
  const ab = (cfg && cfg.antiblock) || {};
  const sampleStep = detailCfg.sampleStep ?? 1; // 1 = every business; 5 = every 5th (QA mode)
  const onProgress = hooks.onProgress || (() => {});
  const captchaCheck = hooks.captchaCheck || null;
  const captchaWaitMs = hooks.captchaWaitMs ?? ab.captchaWaitMs ?? 300_000;

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const durations = [];
  const errors = {};

  log.info('Deep-scrape started', {
    total: businesses.length,
    sampleStep,
    delayRangeMs: [ab.detailDelayMinMs ?? detailCfg.delayMinMs ?? 1500, ab.detailDelayMaxMs ?? detailCfg.delayMaxMs ?? 3500],
    rateLimited: !!(cfg && cfg.rateLimiter),
    captchaCheck: !!captchaCheck,
  });

  for (let i = 0; i < businesses.length; i++) {
    // Phase 1.7 — skip businesses already deep-scraped in a prior run
    // (loaded from checkpoint on --resume). Their detail fields are already
    // merged in; re-scraping would waste time + requests.
    if (businesses[i] && businesses[i].detail_scraped === true) {
      continue;
    }
    if (sampleStep > 1 && i % sampleStep !== 0) {
      // Not in sample — leave EMPTY_DETAIL on this record
      businesses[i] = mergeDetailFields(businesses[i], EMPTY_DETAIL);
      continue;
    }
    attempted++;
    const b = businesses[i];
    const res = await deepScrapeDetailsOnPage(page, b, cfg, log);
    durations.push(res.elapsedMs);
    businesses[i] = mergeDetailFields(b, res.detail);
    if (res.ok) {
      succeeded++;
      // Phase 1.9 — per-business outcome log with timing so the log file
      // records every detail scrape with success/fail + duration.
      log.info('Detail scraped', {
        index: i,
        business: b && b.name ? b.name : '(unknown)',
        success: true,
        elapsedMs: res.elapsedMs,
      });
    } else {
      failed++;
      const errKey = res.error || 'unknown';
      errors[errKey] = (errors[errKey] || 0) + 1;
      log.warn('Detail scrape failed', {
        index: i,
        business: b && b.name ? b.name : '(unknown)',
        success: false,
        elapsedMs: res.elapsedMs,
        error: res.error,
      });
    }

    // Progress log every 10 details
    if (attempted % 10 === 0) {
      log.info('Deep-scrape progress', {
        attempted,
        succeeded,
        failed,
        remaining: businesses.length - i - 1,
      });
    }

    // Phase 1.7 — notify caller after each scrape so it can checkpoint.
    onProgress({ index: i, attempted, succeeded, failed });

    // Phase 1.8 — CAPTCHA check after each business. If Google throttled us,
    // pause + alert the operator, then abort the deep-scrape phase (auto-solve
    // is Phase 2). The checkpoint stays on disk for a --resume rerun.
    if (captchaCheck) {
      let captcha;
      try {
        captcha = await captchaCheck();
      } catch (err) {
        log.debug('captchaCheck hook threw (non-fatal)', { error: err.message });
        captcha = { detected: false, indicator: null };
      }
      if (captcha.detected) {
        log.error('CAPTCHA / block detected during deep-scrape — pausing', {
          indicator: captcha.indicator,
          pauseMs: captchaWaitMs,
          attemptedSoFar: attempted,
          business: b && b.name ? b.name : '(unknown)',
        });
        // eslint-disable-next-line no-console
        console.error(
          '\n========================================\n' +
            'CAPTCHA DETECTED — Google is throttling this run.\n' +
            `Indicator: ${captcha.indicator}\n` +
            `Pausing ${Math.round(captchaWaitMs / 1000)}s for operator action.\n` +
            'In --headed mode: solve the CAPTCHA in the browser window.\n' +
            'The checkpoint is preserved — rerun with --resume after the block clears.\n' +
            '========================================\n',
        );
        await sleep(captchaWaitMs);
        const err = new Error(
          `CAPTCHA detected during deep-scrape (indicator: "${captcha.indicator}"). ` +
            'Run aborted after operator pause. Rerun with --resume once the block clears.',
        );
        err.code = 'CAPTCHA_DETECTED';
        err.captchaIndicator = captcha.indicator;
        throw err;
      }
    }
  }

  const successRate = attempted === 0 ? 0 : Math.round((succeeded / attempted) * 1000) / 10;
  const avgMs = durations.length === 0 ? 0 : Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const maxMs = durations.length === 0 ? 0 : Math.max(...durations);
  const minMs = durations.length === 0 ? 0 : Math.min(...durations);

  log.info('Deep-scrape complete', {
    attempted,
    succeeded,
    failed,
    successRate: `${successRate}%`,
    avgMs,
    minMs,
    maxMs,
    errors,
  });

  if (successRate < 80) {
    log.warn('Deep-scrape success rate below 80% threshold', { successRate: `${successRate}%` });
  }

  return {
    successRate,
    attempted,
    succeeded,
    failed,
    durations,
    avgMs,
    minMs,
    maxMs,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a URL/href so it's safe to embed inside a CSS attribute selector.
 * CSS attribute values are quoted; we escape quotes and backslashes.
 */
function cssEscapeHref(href) {
  return String(href || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  DETAIL_FIELDS,
  EMPTY_DETAIL,
  DETAIL_SELECTORS,
  // Parsers (exported for unit testing)
  normalizeDay,
  parseHoursTable,
  parsePopularTimes,
  parseBusyLevel,
  parseHourFromLabel,
  parseReview,
  parseSocialProfiles,
  classifySocialUrl,
  // Core extractor
  extractDetailFromPage,
  normalizeDetail,
  mergeDetailFields,
  // DI loop + production wrappers
  deepScrapeDetails,
  deepScrapeDetailsOnPage,
  deepScrapeAll,
  openDetailPanelOnPage,
  backToListOnPage,
  sleep,
};
