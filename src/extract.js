'use strict';

/**
 * src/extract.js — Phase 1.4 — Core Field Extraction (List View)
 *
 * Extracts the canonical "money fields" from each business card in the
 * Google Maps results feed.
 *
 * Canonical field list (15 fields):
 *   name, rating, reviews_count, price_level, category, address, phone,
 *   website, maps_url, place_id, plus_code, open_now, business_status,
 *   is_sponsored, scraped_at, query, location
 *
 * Design rules (per Phase 1.4 spec):
 *   - Multiple fallback selectors per field (Google changes the DOM often)
 *   - Per-field extraction-rate reporting with WARN below threshold
 *   - Normalization: rating → float|null, reviews_count → int|null,
 *     phone → raw string, website → strip tracking params
 *   - "permanently closed" / "temporarily closed" → business_status flag, not skipped
 *   - Sponsored/ad results → is_sponsored: true
 *   - Legitimately absent fields → null, never "N/A" or wrong field's value
 */

// ---------------------------------------------------------------------------
// Canonical schema (exported for CSV column order in Phase 1.6)
// ---------------------------------------------------------------------------

const CANONICAL_FIELDS = [
  'name',
  'rating',
  'reviews_count',
  'price_level',
  'category',
  'address',
  'phone',
  'website',
  'maps_url',
  'place_id',
  'plus_code',
  'open_now',
  'business_status', // open | temporarily_closed | permanently_closed
  'is_sponsored',
  'scraped_at',
  'query',
  'location',
];

// ---------------------------------------------------------------------------
// Field-level selectors (primary + fallbacks). Google frequently reshuffles
// these, so each field has 2-4 candidates.
// ---------------------------------------------------------------------------

const SELECTORS = {
  // A result "card" on modern Google Maps is a div[role="article"] that
  // CONTAINS an <a href*="/maps/place/"> (the title link) plus other fields.
  // Fallback: the place anchor itself (older layout where the whole card is
  // the anchor — note: nested <a> is invalid HTML, so the website/phone links
  // cannot be children in that layout; the div[role="article"] layout is the
  // reliable one).
  card: [
    'div[role="feed"] div[role="article"]',
    'div[role="article"]',
    'div[role="feed"] a[href*="/maps/place/"]',
    'a[href*="/maps/place/"]',
  ],
  // Within a card, candidates for each field:
  name: [
    '.fontHeadlineSmall',
    '[role="article"] [aria-label]',
    'div[role="feed"] a[href*="/maps/place/"] [aria-label]',
    '.qBF1Pd',
  ],
  rating: [
    '.fontBodyMedium > span[aria-label*="stars"]',
    'span[aria-label$="stars"]',
    'span.MW4etd',
    '[role="img"][aria-label*="Rated"]',
  ],
  reviews_count: [
    '.fontBodyMedium > span[aria-label*="reviews"]',
    'span[aria-label*="review"]',
    '.UY7F9',
    // Note: ':has-text()' is a Playwright pseudo-class, not native CSS —
    // it cannot be used inside page.evaluate(). Keep selectors native here.
  ],
  price_level: [
    'span[data-value*="$"]',
    // Note: '.fontBodyMedium span:nth-child(2)' removed — too brittle, often
    // matches the reviews-count span instead of the price span. Rely on the
    // text-based $ scan in extractRawFromPage() instead.
  ],
  category: [
    '.fontBodyMedium > button',
    'button.fontBodyMedium',
    '.W4Efsd > span:last-child',
  ],
  address: [
    '.W4Efsd:last-child > span:last-child',
    '.fontBodyMedium .W4Efsd',
    // Bare fallback — returns the first W4Efsd block's text. On real Maps
    // this may over-capture (category+address), so the specific selectors
    // above are preferred. Detail-scrape (Phase 1.5) is the reliable source.
    '.W4Efsd',
  ],
  phone: [
    'span[data-item-id*="phone"]',
    'button[data-item-id*="phone:tel"]',
    'a[href^="tel:"]',
  ],
  website: [
    'a[data-item-id*="authority"]',
    'a[aria-label*="Website"]',
    // Note: the catch-all 'a[href^="http"]:not([href*="google.com"])' is too
    // broad inside a card anchor (would match nested links); left out by design.
  ],
  plus_code: [
    'span[data-item-id*="plus_code"]',
    // 'button:has-text("Plus code")' removed — :has-text not valid in evaluate
  ],
  open_hours: [
    'span[data-item-id*="oh"]',
    'button[aria-label*="hours"]',
    // ':has-text("Open")' / ':has-text("Closed")' removed — handled in JS below
  ],
};

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

async function textOf(el) {
  if (!el) return null;
  const t = (await el.innerText().catch(() => '')).trim();
  return t || null;
}

async function attr(el, name) {
  if (!el) return null;
  return el.getAttribute(name);
}

async function trySelectors(scope, selectorList) {
  for (const sel of selectorList) {
    const el = await scope.$(sel).catch(() => null);
    if (el) return el;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field normalizers
// ---------------------------------------------------------------------------

function parseRating(raw) {
  if (!raw) return null;
  // "4.5 stars" / "4.5" / "Rated 4.5 out of 5"
  const m = raw.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v) || v < 0 || v > 5) return null;
  return v;
}

function parseReviewsCount(raw) {
  if (!raw) return null;
  // "(1,234)" / "1,234 reviews" / "1234"
  const cleaned = raw.replace(/[(),]/g, '').replace(/reviews?/i, '').trim();
  const m = cleaned.match(/(\d+)/);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return Number.isFinite(v) ? v : null;
}

function parsePriceLevel(raw) {
  if (!raw) return null;
  // Match sequences of $ only
  const m = raw.match(/(\${1,4})/);
  return m ? m[1] : null;
}

function cleanWebsite(url) {
  if (!url) return null;
  // Strip common tracking params (utm_*, gclid, fbclid) — keep the rest
  try {
    const u = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'ref'].forEach(
      (k) => u.searchParams.delete(k),
    );
    // Drop trailing slash on bare host URLs for tidiness
    let s = u.toString();
    if (s.endsWith('/') && u.pathname === '/' && u.search === '') s = s.slice(0, -1);
    return s;
  } catch {
    return url; // not a valid URL — keep raw
  }
}

/**
 * Extract place_id from a Maps URL.
 * Handles two formats:
 *   1. 0x...:0x... CID format (16-hex on each side of colon)
 *   2. ChIJ... place_id format (base64-ish, ~27 chars)
 *   3. ?place_id=ChIJ... query param
 */
function parsePlaceId(url) {
  if (!url) return null;
  // Explicit query param
  const paramMatch = url.match(/[?&]place_id=([^&]+)/);
  if (paramMatch) return decodeURIComponent(paramMatch[1]);
  // CID format: 0x<hex>:0x<hex>
  const cidMatch = url.match(/0x[0-9a-fA-F]+:0x[0-9a-fA-F]+/);
  if (cidMatch) return cidMatch[0];
  // ChIJ place_id format (appears in path or data=)
  const chijMatch = url.match(/(ChIJ[A-Za-z0-9_-]{10,})/);
  if (chijMatch) return chijMatch[1];
  return null;
}

function parsePlusCode(raw) {
  if (!raw) return null;
  // Open Location Code format: e.g. "8FVC9GQF+5W" or with prefix "8FVC9GQF+5W, Dhaka"
  const m = raw.match(/([0-23456789CFGHJMPQRVWX]{4,8}\+[0-23456789CFGHJMPQRVWX]{2,3}(?:,?\s.*)?)/);
  return m ? m[1].split(',')[0].trim() : null;
}

function parseOpenNow(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  // Order matters: check "open now"/"open ·" (currently open) before "closed"/"opens"
  // (currently closed). "Closed · Opens 3:00 PM" → currently closed (false).
  // "Opens 11:00 AM" alone → currently closed, opens later (false).
  if (lower.includes('open now')) return true;
  if (lower.startsWith('open') && !lower.startsWith('opens') && !lower.includes('hours')) {
    return true; // "Open · Closes 10 PM"
  }
  if (lower.includes('closed')) return false; // "Closed" / "Closed · Opens 3 PM"
  if (lower.startsWith('opens')) return false; // "Opens 3 PM" — currently closed
  // CJK variants (Maps may render in the IP-geo locale despite hl=en)
  if (/營業中|营业中/.test(raw)) return true;
  if (/已打烊|歇業|歇业|关门|關門|永久歇業/.test(raw)) return false;
  return null; // ambiguous / hours-only
}

/**
 * Detect business status from card text.
 * Returns one of: 'open' | 'temporarily_closed' | 'permanently_closed'
 */
function detectBusinessStatus(cardText) {
  if (!cardText) return 'open';
  const lower = cardText.toLowerCase();
  if (lower.includes('permanently closed')) return 'permanently_closed';
  if (lower.includes('temporarily closed') || lower.includes('temp. closed')) return 'temporarily_closed';
  return 'open';
}

/**
 * Detect if a card is a sponsored/ad result.
 */
function detectSponsored(cardText, cardEl) {
  // Google marks sponsored with "Sponsored" / "Ad" labels or specific data attrs
  if (cardText && /sponsored|^ad$/i.test(cardText)) return true;
  // Some layouts use aria-label="Sponsored"
  const aria = cardEl && cardEl.getAttribute ? cardEl.getAttribute('aria-label') : null;
  if (aria && /sponsored/i.test(aria)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Per-card extraction (runs inside browser via page.evaluate)
// ---------------------------------------------------------------------------

/**
 * The big in-browser extractor. Runs as page.evaluate to avoid round-trips.
 * Returns a raw object per card; normalization happens in Node afterwards.
 */
async function extractRawFromPage(page) {
  // The selector list for cards
  return page.evaluate((selectorsJson) => {
    const SEL = JSON.parse(selectorsJson);

    function pick(scope, list) {
      for (const s of list) {
        const el = scope.querySelector(s);
        if (el) return el;
      }
      return null;
    }

    // Find all place anchors (the title link inside each card). We anchor on
    // these because the href is the canonical place URL. The "card scope" for
    // field extraction is the closest div[role="article"] ancestor if present,
    // otherwise the anchor itself.
    const placeAnchors = [];
    const seenHrefs = new Set();
    const anchorCandidates = document.querySelectorAll('a[href*="/maps/place/"]');
    for (const a of anchorCandidates) {
      const href = a.getAttribute('href') || '';
      if (!href || seenHrefs.has(href)) continue;
      seenHrefs.add(href);
      placeAnchors.push(a);
    }

    // Build (scope, href) pairs. Scope = closest article, or the anchor itself.
    const cardEls = placeAnchors.map((a) => ({
      scope: a.closest('[role="article"]') || a,
      anchor: a,
    }));

    return cardEls.map(({ scope: card, anchor }, idx) => {
      const cardText = (card.innerText || '').trim();
      const href = anchor.getAttribute('href') || '';
      // aria-label: prefer the anchor's (business name on modern Maps), fall
      // back to the card's.
      const ariaLabel = anchor.getAttribute('aria-label') || card.getAttribute('aria-label') || '';

      // Name — prefer aria-label on the place anchor, fall back to inner selectors
      let name = ariaLabel || null;
      if (!name) {
        const nameEl = pick(card, SEL.name);
        name = nameEl ? (nameEl.innerText || nameEl.textContent || '').trim() : null;
      }

      // Rating
      const ratingEl = pick(card, SEL.rating);
      const ratingRaw = ratingEl
        ? (ratingEl.getAttribute('aria-label') || ratingEl.innerText || '').trim()
        : null;

      // Reviews count
      const reviewsEl = pick(card, SEL.reviews_count);
      const reviewsRaw = reviewsEl ? (reviewsEl.innerText || '').trim() : null;

      // Price level — try native selectors first (validated to contain $),
      // then scan spans for a $-only token as fallback.
      let priceRaw = null;
      const priceEl = pick(card, SEL.price_level);
      if (priceEl) {
        const t = (priceEl.innerText || '').trim();
        if (/\$/.test(t)) priceRaw = t;
      }
      if (!priceRaw) {
        const spans = Array.from(card.querySelectorAll('span'));
        for (const s of spans) {
          const t = (s.innerText || '').trim();
          if (/^\${1,4}$/.test(t) || /(\${1,4})/.test(t)) {
            priceRaw = t;
            break;
          }
        }
      }

      // Category + Address + Hours — modern Maps nests these in a structure like:
      //   <div class="W4Efsd">                       <!-- info wrapper (B) -->
      //     <div class="W4Efsd">                     <!-- B1: category + address -->
      //       <span><span>Restaurant</span></span>
      //       <span> · <span>123 Main St</span></span>
      //     </div>
      //     <div class="W4Efsd">                     <!-- B2: hours -->
      //       <span>Closed · Opens 3:00 PM</span>
      //     </div>
      //   </div>
      // We parse this structure directly. Falls back to single-element selectors
      // if the nested structure isn't present (older layouts).
      let categoryRaw = null;
      let addressRaw = null;
      let hoursRaw = null;

      (function parseInfoBlock() {
        // Find candidate info wrappers: a .W4Efsd that contains nested .W4Efsd divs.
        const wrappers = Array.from(card.querySelectorAll('.W4Efsd')).filter((w) =>
          w.querySelector(':scope > .W4Efsd'),
        );
        let infoWrapper = wrappers[0] || null;

        if (infoWrapper) {
          const nested = Array.from(infoWrapper.querySelectorAll(':scope > .W4Efsd'));
          // B1 (first nested) → category + address spans
          if (nested[0]) {
            const spans = Array.from(nested[0].querySelectorAll(':scope > span'));
            const texts = spans.map((s) => (s.innerText || '').trim()).filter(Boolean);
            // First non-"·" text is category; the rest (joined) is address.
            if (texts.length >= 1) categoryRaw = texts[0].replace(/^·\s*/, '').trim();
            if (texts.length >= 2) {
              addressRaw = texts
                .slice(1)
                .join(' ')
                .replace(/^·\s*/, '')
                .replace(/\s*·\s*/g, ' ')
                .trim();
            }
          }
          // B2 (second nested) → hours
          if (nested[1]) {
            hoursRaw = (nested[1].innerText || '').trim();
          }
        }

        // Fallbacks if the nested structure wasn't found
        if (!categoryRaw) {
          const catEl = pick(card, SEL.category);
          if (catEl) categoryRaw = (catEl.innerText || '').trim();
        }
        if (!addressRaw) {
          const addressEl = pick(card, SEL.address);
          if (addressEl) addressRaw = (addressEl.innerText || '').trim();
        }
        if (!hoursRaw) {
          const hoursEl = pick(card, SEL.open_hours);
          if (hoursEl) {
            hoursRaw = (hoursEl.innerText || '').trim();
          } else {
            // Last-resort: scan for a short span whose text matches open/closed
            // keywords (English + common non-English variants).
            const spans = Array.from(card.querySelectorAll('span, button'));
            const re = /\b(open now|closed|opens?|已打烊|營業中|歇業|開門|关门|营业中)\b/i;
            for (const s of spans) {
              const t = (s.innerText || '').trim();
              if (t && t.length < 40 && re.test(t)) {
                hoursRaw = t;
                break;
              }
            }
          }
        }
      })();

      // Phone
      const phoneEl = pick(card, SEL.phone);
      let phoneRaw = null;
      if (phoneEl) {
        phoneRaw =
          phoneEl.getAttribute('data-item-id') ||
          phoneEl.getAttribute('href') ||
          (phoneEl.innerText || '').trim();
      }

      // Website
      const webEl = pick(card, SEL.website);
      const websiteRaw = webEl ? webEl.getAttribute('href') : null;

      // Plus code
      const plusEl = pick(card, SEL.plus_code);
      const plusRaw = plusEl ? (plusEl.innerText || '').trim() : null;

      // Status / sponsored detection — multi-locale aware.
      // Maps renders "Permanently closed" / "Temporarily closed" in the active
      // locale; we check English + common CJK variants.
      const business_status = (function (t) {
        const l = (t || '').toLowerCase();
        if (
          l.includes('permanently closed') ||
          l.includes('永久歇業') ||
          l.includes('永久停业') ||
          l.includes('永久關閉')
        )
          return 'permanently_closed';
        if (
          l.includes('temporarily closed') ||
          l.includes('temp. closed') ||
          l.includes('暫時歇業') ||
          l.includes('暂时停业')
        )
          return 'temporarily_closed';
        return 'open';
      })(cardText);

      const is_sponsored = (function (t, aria) {
        // Text badge: "Sponsored" / "Ad" (English) + 贊助商廣告/赞助商广告 (CJK)
        if (t && /sponsored|^ad$|贊助商廣告|赞助商广告|広告/i.test(t)) return true;
        if (aria && /sponsored|贊助商廣告|赞助商广告|広告/i.test(aria)) return true;
        // A link to adssettings.google.com is a sure sponsored signal
        if (card.querySelector('a[href*="adssettings.google.com"], button[data-url*="adssettings.google.com"]')) {
          return true;
        }
        // Some layouts render a small "Ad" badge separately
        const adBadge = card.querySelector(
          '[aria-label="Advertisement"], [aria-label="Sponsored"], [aria-label="贊助商廣告"], [aria-label="赞助商广告"]',
        );
        return !!adBadge;
      })(cardText, ariaLabel);

      return {
        index: idx,
        href,
        name,
        ratingRaw,
        reviewsRaw,
        priceRaw,
        categoryRaw,
        addressRaw,
        phoneRaw,
        websiteRaw,
        plusRaw,
        hoursRaw,
        business_status,
        is_sponsored,
      };
    });
  }, JSON.stringify(SELECTORS));
}

// ---------------------------------------------------------------------------
// Normalize a single raw record into canonical shape
// ---------------------------------------------------------------------------

function normalizeRecord(raw, ctx) {
  const mapsUrl = raw.href ? absolutizeMapsUrl(raw.href) : null;
  const placeId = parsePlaceId(raw.href) || parsePlaceId(mapsUrl);
  return {
    name: raw.name || null,
    rating: parseRating(raw.ratingRaw),
    reviews_count: parseReviewsCount(raw.reviewsRaw),
    price_level: parsePriceLevel(raw.priceRaw),
    category: raw.categoryRaw || null,
    address: raw.addressRaw || null,
    phone: raw.phoneRaw ? cleanPhone(raw.phoneRaw) : null,
    website: cleanWebsite(raw.websiteRaw),
    maps_url: mapsUrl,
    place_id: placeId,
    plus_code: parsePlusCode(raw.plusRaw),
    open_now: parseOpenNow(raw.hoursRaw),
    business_status: raw.business_status || 'open',
    is_sponsored: !!raw.is_sponsored,
    scraped_at: ctx.scrapedAt,
    query: ctx.query,
    location: ctx.location,
  };
}

function absolutizeMapsUrl(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href;
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/')) return 'https://www.google.com' + href;
  return href;
}

function cleanPhone(raw) {
  if (!raw) return null;
  // data-item-id often looks like "phone:tel:+8801712345678" — extract the tel: portion
  const telMatch = raw.match(/tel:([+0-9 ()-]+)/);
  if (telMatch) return telMatch[1].trim();
  // href tel: link
  if (raw.startsWith('tel:')) return raw.slice(4).trim();
  // Plain text number — keep raw (full normalization is Phase 3 of master roadmap)
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Main entry point: extractBusinesses(page, ctx)
// ---------------------------------------------------------------------------

/**
 * Extract all business records from the current page state.
 *
 * @param {import('playwright').Page} page
 * @param {object} ctx — { query, location, logger }
 * @returns {Promise<{ businesses: Array, extractionRates: object }>}
 */
async function extractBusinesses(page, ctx) {
  const logger = ctx.logger || { info() {}, warn() {}, debug() {} };
  const scrapedAt = new Date().toISOString();

  logger.info('Extracting business records from feed');
  const rawRecords = await extractRawFromPage(page);
  logger.info('Raw records pulled from DOM', { count: rawRecords.length });

  const businesses = rawRecords.map((r) =>
    normalizeRecord(r, {
      scrapedAt,
      query: ctx.query,
      location: ctx.location,
    }),
  );

  const extractionRates = computeExtractionRates(businesses);
  return { businesses, extractionRates };
}

// ---------------------------------------------------------------------------
// Extraction-rate reporter
// ---------------------------------------------------------------------------

/**
 * Compute per-field hit rate.
 * Returns: { field: { filled, total, rate } }
 */
function computeExtractionRates(businesses, opts = {}) {
  const warnThreshold = opts.fieldWarnThreshold ?? 80;
  const total = businesses.length;
  const rates = {};

  for (const field of CANONICAL_FIELDS) {
    let filled = 0;
    for (const b of businesses) {
      const v = b[field];
      if (v !== null && v !== undefined && v !== '' && v !== false) filled++;
      // Note: false is a legit value for open_now / is_sponsored, but those
      // are "filled" semantically — count via presence check below.
    }
    // Re-count fields where false is a legitimate filled value (open_now, is_sponsored)
    if (field === 'open_now' || field === 'is_sponsored') {
      filled = businesses.filter((b) => b[field] !== null && b[field] !== undefined).length;
    }
    const rate = total === 0 ? 0 : Math.round((filled / total) * 1000) / 10; // one decimal
    rates[field] = { filled, total, rate, warn: rate < warnThreshold };
  }
  return rates;
}

/**
 * Log the per-field extraction rate table.
 * Returns the same rates object (for inclusion in run summary).
 */
function logExtractionRates(rates, logger) {
  const lines = [];
  lines.push('Field extraction rates:');
  lines.push('  field              filled / total   rate');
  lines.push('  -----------------------------------------');
  for (const field of CANONICAL_FIELDS) {
    const r = rates[field];
    if (!r) continue;
    const pct = `${r.rate}%`.padStart(6);
    const flag = r.warn ? '  ⚠ WARN (<80%)' : '';
    lines.push(
      `  ${field.padEnd(18)} ${String(r.filled).padStart(5)} / ${String(r.total).padStart(5)}   ${pct}${flag}`,
    );
  }
  for (const l of lines) {
    if (l.includes('WARN')) logger.warn(l.trim());
    else logger.info(l);
  }
  return rates;
}

module.exports = {
  CANONICAL_FIELDS,
  SELECTORS,
  extractBusinesses,
  extractRawFromPage,
  normalizeRecord,
  computeExtractionRates,
  logExtractionRates,
  // Field parsers (exported for unit testing)
  parseRating,
  parseReviewsCount,
  parsePriceLevel,
  parsePlaceId,
  parsePlusCode,
  parseOpenNow,
  detectBusinessStatus,
  detectSponsored,
  cleanWebsite,
  cleanPhone,
  absolutizeMapsUrl,
};
