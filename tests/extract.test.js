'use strict';

/**
 * tests/extract.test.js — Phase 1.4 unit tests
 *
 * Coverage:
 *   1. Field parsers (parseRating, parseReviewsCount, parsePriceLevel,
 *      parsePlaceId, parsePlusCode, parseOpenNow, detectBusinessStatus,
 *      detectSponsored, cleanWebsite, cleanPhone)
 *   2. normalizeRecord — happy path + missing-field null handling
 *   3. computeExtractionRates — threshold WARN logic
 *   4. extractBusinesses end-to-end against a static HTML fixture loaded
 *      via Playwright (verifies DOM selectors + full pipeline)
 *
 * Run: bun test tests/
 */

const { chromium } = require('playwright');
// bun test exposes describe/test/expect/beforeAll/afterAll as globals
const fs = require('fs');
const path = require('path');

const {
  CANONICAL_FIELDS,
  extractBusinesses,
  normalizeRecord,
  computeExtractionRates,
  logExtractionRates,
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
} = require('../src/extract');

// ---------------------------------------------------------------------------
// 1. Field parser unit tests
// ---------------------------------------------------------------------------

describe('parseRating', () => {
  test('parses "4.5 stars"', () => {
    expect(parseRating('4.5 stars')).toBe(4.5);
  });
  test('parses bare "4.5"', () => {
    expect(parseRating('4.5')).toBe(4.5);
  });
  test('parses "Rated 4.0 out of 5"', () => {
    expect(parseRating('Rated 4.0 out of 5')).toBe(4.0);
  });
  test('returns null for empty', () => {
    expect(parseRating(null)).toBeNull();
    expect(parseRating('')).toBeNull();
  });
  test('rejects out-of-range (>5)', () => {
    expect(parseRating('7.2')).toBeNull();
  });
  test('rejects non-numeric', () => {
    expect(parseRating('No rating')).toBeNull();
  });
});

describe('parseReviewsCount', () => {
  test('strips parens "(1,234)"', () => {
    expect(parseReviewsCount('(1,234)')).toBe(1234);
  });
  test('strips "1,234 reviews"', () => {
    expect(parseReviewsCount('1,234 reviews')).toBe(1234);
  });
  test('parses bare number', () => {
    expect(parseReviewsCount('567')).toBe(567);
  });
  test('returns null for empty', () => {
    expect(parseReviewsCount(null)).toBeNull();
    expect(parseReviewsCount('')).toBeNull();
  });
  test('returns null when no digits', () => {
    expect(parseReviewsCount('No reviews')).toBeNull();
  });
});

describe('parsePriceLevel', () => {
  test('matches single $', () => {
    expect(parsePriceLevel('$')).toBe('$');
  });
  test('matches $$ in surrounding text', () => {
    expect(parsePriceLevel('$$ · Mexican')).toBe('$$');
  });
  test('matches $$$', () => {
    expect(parsePriceLevel('$$$')).toBe('$$$');
  });
  test('returns null when no $', () => {
    expect(parsePriceLevel('Mexican restaurant')).toBeNull();
    expect(parsePriceLevel(null)).toBeNull();
  });
});

describe('parsePlaceId', () => {
  test('parses CID format 0x...:0x...', () => {
    const url = 'https://www.google.com/maps/place/Some+Place/@43.6,-79.3,17z/data=!3m1!4b1!4m6!3m5!1s0x89d4cb90d1f1f1f1:0x2a2a2a2a2a2a2a2a!8m2!3d43.6!4d-79.3';
    expect(parsePlaceId(url)).toBe('0x89d4cb90d1f1f1f1:0x2a2a2a2a2a2a2a2a');
  });
  test('parses ChIJ format', () => {
    const url = 'https://www.google.com/maps/place/?q=place_id:ChIJj61dQgK6j4AR4GeTYWZUkwk';
    expect(parsePlaceId(url)).toBe('ChIJj61dQgK6j4AR4GeTYWZUkwk');
  });
  test('parses explicit place_id query param', () => {
    const url = 'https://www.google.com/maps?place_id=ChIJAbCdEfGhIjKlMnOpQrStUvW';
    expect(parsePlaceId(url)).toBe('ChIJAbCdEfGhIjKlMnOpQrStUvW');
  });
  test('returns null when no place_id', () => {
    expect(parsePlaceId('https://example.com')).toBeNull();
    expect(parsePlaceId(null)).toBeNull();
  });
});

describe('parsePlusCode', () => {
  test('parses bare code', () => {
    expect(parsePlusCode('8FVC9GQF+5W')).toBe('8FVC9GQF+5W');
  });
  test('parses code with location suffix', () => {
    expect(parsePlusCode('8FVC9GQF+5W, Dhaka')).toBe('8FVC9GQF+5W');
  });
  test('returns null when not a plus code', () => {
    expect(parsePlusCode('Toronto, ON')).toBeNull();
    expect(parsePlusCode(null)).toBeNull();
  });
});

describe('parseOpenNow', () => {
  test('"Open now" → true', () => {
    expect(parseOpenNow('Open now')).toBe(true);
  });
  test('"Closed" → false', () => {
    expect(parseOpenNow('Closed')).toBe(false);
  });
  test('"Opens 11:00 AM" → false (currently closed, opens later)', () => {
    expect(parseOpenNow('Opens 11:00 AM')).toBe(false);
  });
  test('"Closed · Opens 3:00 PM" → false (currently closed)', () => {
    expect(parseOpenNow('Closed · Opens 3:00 PM')).toBe(false);
  });
  test('"Open · Closes 10:00 PM" → true', () => {
    expect(parseOpenNow('Open · Closes 10:00 PM')).toBe(true);
  });
  test('returns null for empty', () => {
    expect(parseOpenNow(null)).toBeNull();
  });
});

describe('detectBusinessStatus', () => {
  test('"Permanently closed"', () => {
    expect(detectBusinessStatus('Permanently closed')).toBe('permanently_closed');
  });
  test('"Temporarily closed"', () => {
    expect(detectBusinessStatus('Temporarily closed')).toBe('temporarily_closed');
  });
  test('"Temp. closed" variant', () => {
    expect(detectBusinessStatus('Temp. closed')).toBe('temporarily_closed');
  });
  test('open business (no closed text)', () => {
    expect(detectBusinessStatus('Open now · Closes 10 PM')).toBe('open');
  });
  test('null → open', () => {
    expect(detectBusinessStatus(null)).toBe('open');
  });
});

describe('detectSponsored', () => {
  test('text "Sponsored"', () => {
    expect(detectSponsored('Sponsored', {})).toBe(true);
  });
  test('text "Ad"', () => {
    expect(detectSponsored('Ad', {})).toBe(true);
  });
  test('organic result', () => {
    expect(detectSponsored('Open now · 4.5 stars', {})).toBe(false);
  });
  test('aria-label "Sponsored"', () => {
    expect(detectSponsored('Some text', { getAttribute: () => 'Sponsored result' })).toBe(true);
  });
});

describe('cleanWebsite', () => {
  test('strips utm_* params (and drops trailing slash on bare host)', () => {
    expect(
      cleanWebsite('https://example.com/?utm_source=google&utm_medium=maps&utm_campaign=biz'),
    ).toBe('https://example.com');
  });
  test('strips gclid + fbclid', () => {
    expect(cleanWebsite('https://example.com/menu?gclid=abc&fbclid=xyz')).toBe(
      'https://example.com/menu',
    );
  });
  test('keeps legit query params', () => {
    expect(cleanWebsite('https://example.com/menu?page=2')).toBe('https://example.com/menu?page=2');
  });
  test('drops trailing slash on bare host', () => {
    expect(cleanWebsite('https://example.com/')).toBe('https://example.com');
  });
  test('returns null for empty', () => {
    expect(cleanWebsite(null)).toBeNull();
  });
  test('keeps invalid URL as-is', () => {
    expect(cleanWebsite('not-a-url')).toBe('not-a-url');
  });
});

describe('cleanPhone', () => {
  test('extracts from data-item-id "phone:tel:+8801712345678"', () => {
    expect(cleanPhone('phone:tel:+8801712345678')).toBe('+8801712345678');
  });
  test('strips tel: prefix', () => {
    expect(cleanPhone('tel:+14165551234')).toBe('+14165551234');
  });
  test('keeps plain text number', () => {
    expect(cleanPhone('+1 (416) 555-1234')).toBe('+1 (416) 555-1234');
  });
  test('returns null for empty', () => {
    expect(cleanPhone(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. normalizeRecord
// ---------------------------------------------------------------------------

describe('normalizeRecord', () => {
  const ctx = { scrapedAt: '2026-08-07T10:00:00.000Z', query: 'Cafe', location: 'Berlin' };

  test('happy path — all fields populated', () => {
    const raw = {
      href: 'https://www.google.com/maps/place/Cafe+x/data=!3m1!4b1!4m6!3m5!1s0x89d4cb90d1f1f1f1:0x2a2a2a2a2a2a2a2a',
      name: 'Cafe Berlin',
      ratingRaw: '4.5 stars',
      reviewsRaw: '(1,234)',
      priceRaw: '$$',
      categoryRaw: 'Cafe',
      addressRaw: '123 Main St, Berlin',
      phoneRaw: 'phone:tel:+491234567890',
      websiteRaw: 'https://cafe-berlin.de/?utm_source=google',
      plusRaw: '8FVC9GQF+5W, Berlin',
      hoursRaw: 'Open now',
      business_status: 'open',
      is_sponsored: false,
    };
    const b = normalizeRecord(raw, ctx);
    expect(b.name).toBe('Cafe Berlin');
    expect(b.rating).toBe(4.5);
    expect(b.reviews_count).toBe(1234);
    expect(b.price_level).toBe('$$');
    expect(b.category).toBe('Cafe');
    expect(b.address).toBe('123 Main St, Berlin');
    expect(b.phone).toBe('+491234567890');
    expect(b.website).toBe('https://cafe-berlin.de');
    expect(b.place_id).toBe('0x89d4cb90d1f1f1f1:0x2a2a2a2a2a2a2a2a');
    expect(b.plus_code).toBe('8FVC9GQF+5W');
    expect(b.open_now).toBe(true);
    expect(b.business_status).toBe('open');
    expect(b.is_sponsored).toBe(false);
    expect(b.scraped_at).toBe(ctx.scrapedAt);
    expect(b.query).toBe('Cafe');
    expect(b.location).toBe('Berlin');
    expect(b.maps_url).toContain('/maps/place/');
  });

  test('missing fields → null, never "N/A"', () => {
    const raw = {
      href: 'https://www.google.com/maps/place/X',
      name: 'Mystery Place',
      ratingRaw: null,
      reviewsRaw: null,
      priceRaw: null,
      categoryRaw: null,
      addressRaw: null,
      phoneRaw: null,
      websiteRaw: null,
      plusRaw: null,
      hoursRaw: null,
      business_status: 'open',
      is_sponsored: false,
    };
    const b = normalizeRecord(raw, ctx);
    expect(b.rating).toBeNull();
    expect(b.reviews_count).toBeNull();
    expect(b.price_level).toBeNull();
    expect(b.category).toBeNull();
    expect(b.address).toBeNull();
    expect(b.phone).toBeNull();
    expect(b.website).toBeNull();
    expect(b.plus_code).toBeNull();
    expect(b.open_now).toBeNull();
    // name still populated
    expect(b.name).toBe('Mystery Place');
  });

  test('permanently closed business — flagged, not skipped', () => {
    const raw = {
      href: 'https://www.google.com/maps/place/Closed+Cafe',
      name: 'Closed Cafe',
      ratingRaw: '3.8 stars',
      reviewsRaw: '42 reviews',
      priceRaw: '$',
      categoryRaw: 'Cafe',
      addressRaw: '456 Side St',
      phoneRaw: null,
      websiteRaw: null,
      plusRaw: null,
      hoursRaw: 'Closed',
      business_status: 'permanently_closed',
      is_sponsored: false,
    };
    const b = normalizeRecord(raw, ctx);
    expect(b.business_status).toBe('permanently_closed');
    expect(b.name).toBe('Closed Cafe'); // not skipped
    expect(b.rating).toBe(3.8);
  });

  test('sponsored business — flagged', () => {
    const raw = {
      href: 'https://www.google.com/maps/place/Ad+Cafe',
      name: 'Ad Cafe',
      ratingRaw: '4.0 stars',
      reviewsRaw: '(10)',
      priceRaw: null,
      categoryRaw: 'Cafe',
      addressRaw: '789 Ad St',
      phoneRaw: null,
      websiteRaw: 'https://ad-cafe.com',
      plusRaw: null,
      hoursRaw: 'Open now',
      business_status: 'open',
      is_sponsored: true,
    };
    const b = normalizeRecord(raw, ctx);
    expect(b.is_sponsored).toBe(true);
  });

  test('canonical field order is preserved', () => {
    const raw = { href: '', name: 'X', business_status: 'open', is_sponsored: false };
    const b = normalizeRecord(raw, ctx);
    expect(Object.keys(b)).toEqual(CANONICAL_FIELDS);
  });
});

// ---------------------------------------------------------------------------
// 3. computeExtractionRates
// ---------------------------------------------------------------------------

describe('computeExtractionRates', () => {
  const makeBiz = (overrides = {}) => ({
    name: 'Biz',
    rating: 4.0,
    reviews_count: 100,
    price_level: '$$',
    category: 'Cafe',
    address: '123 St',
    phone: '+1',
    website: 'https://x.com',
    maps_url: 'https://g.com',
    place_id: '0x1:0x2',
    plus_code: 'ABCD+EF',
    open_now: true,
    business_status: 'open',
    is_sponsored: false,
    scraped_at: 't',
    query: 'q',
    location: 'l',
    ...overrides,
  });

  test('100% hit rate when all filled', () => {
    const biz = [makeBiz(), makeBiz(), makeBiz()];
    const r = computeExtractionRates(biz, { fieldWarnThreshold: 80 });
    expect(r.name.filled).toBe(3);
    expect(r.name.total).toBe(3);
    expect(r.name.rate).toBe(100);
    expect(r.name.warn).toBe(false);
  });

  test('detects <80% threshold and flags warn', () => {
    const biz = [
      makeBiz({ phone: '+1' }),
      makeBiz({ phone: null }),
      makeBiz({ phone: null }),
      makeBiz({ phone: null }),
    ];
    const r = computeExtractionRates(biz, { fieldWarnThreshold: 80 });
    expect(r.phone.filled).toBe(1);
    expect(r.phone.total).toBe(4);
    expect(r.phone.rate).toBe(25);
    expect(r.phone.warn).toBe(true);
  });

  test('open_now=false counts as filled (legit false value)', () => {
    const biz = [makeBiz({ open_now: false }), makeBiz({ open_now: true })];
    const r = computeExtractionRates(biz);
    expect(r.open_now.filled).toBe(2);
    expect(r.open_now.rate).toBe(100);
  });

  test('is_sponsored=false counts as filled', () => {
    const biz = [makeBiz({ is_sponsored: false }), makeBiz({ is_sponsored: true })];
    const r = computeExtractionRates(biz);
    expect(r.is_sponsored.filled).toBe(2);
    expect(r.is_sponsored.rate).toBe(100);
  });

  test('empty list → 0 rate, no crash', () => {
    const r = computeExtractionRates([]);
    expect(r.name.total).toBe(0);
    expect(r.name.rate).toBe(0);
  });

  test('logExtractionRates returns same rates object', () => {
    const biz = [makeBiz()];
    const r = computeExtractionRates(biz);
    const captured = [];
    const logger = {
      info: (m) => captured.push(m),
      warn: (m) => captured.push(m),
      debug: () => {},
      error: () => {},
    };
    const out = logExtractionRates(r, logger);
    expect(out).toBe(r);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.some((l) => l.includes('extraction rates'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end extraction against a static HTML fixture (Playwright)
//    Verifies the in-browser selectors + full extractBusinesses pipeline.
// ---------------------------------------------------------------------------

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Maps fixture</title></head>
<body>
  <div role="feed">
    <!-- Card 1: full happy path. Modern Maps: card is div[role="article"],
         place link is a nested <a>, other fields are siblings inside the div. -->
    <div role="article" tabindex="-1">
      <a href="https://www.google.com/maps/place/Cafe+Berlin/data=!4m6!3m5!1s0x89d4cb90d1f1f1f1:0x2a2a2a2a2a2a2a2a!8m2!3d43.6!4d-79.3" aria-label="Cafe Berlin">
        <div class="fontHeadlineSmall">Cafe Berlin</div>
      </a>
      <div class="fontBodyMedium">
        <span aria-label="4.5 stars">4.5</span>
        <span aria-label="1,234 reviews">(1,234)</span>
        <span>$$</span>
        <button>Mexican restaurant</button>
      </div>
      <div class="W4Efsd">123 Main St, Berlin</div>
      <span data-item-id="phone:tel:+491234567890">+49 123 4567890</span>
      <a data-item-id="authority" href="https://cafe-berlin.de/?utm_source=google">Website</a>
      <span data-item-id="plus_code">8FVC9GQF+5W, Berlin</span>
      <span data-item-id="oh">Open now</span>
    </div>

    <!-- Card 2: missing several fields (no phone, no website, no plus code) -->
    <div role="article" tabindex="-1">
      <a href="https://www.google.com/maps/place/Simple+Spot/data=!3m1!4b1!4m6!3m5!1s0xabc:0xdef!8m2" aria-label="Simple Spot">
        <div class="fontHeadlineSmall">Simple Spot</div>
      </a>
      <div class="fontBodyMedium">
        <span aria-label="4.0 stars">4.0</span>
        <span aria-label="56 reviews">56 reviews</span>
        <button>Cafe</button>
      </div>
      <div class="W4Efsd">456 Side St</div>
      <span data-item-id="oh">Closed</span>
    </div>

    <!-- Card 3: permanently closed -->
    <div role="article" tabindex="-1">
      <a href="https://www.google.com/maps/place/Old+Place/data=!4m6!3m5!1s0x111:0x222!8m2" aria-label="Old Place">
        <div class="fontHeadlineSmall">Old Place</div>
      </a>
      <div class="fontBodyMedium">
        <span aria-label="3.5 stars">3.5</span>
        <span aria-label="12 reviews">(12)</span>
        <button>Bar</button>
      </div>
      <div class="W4Efsd">789 Old Rd</div>
      <div>Permanently closed</div>
    </div>

    <!-- Card 4: sponsored (aria-label is business name; sponsored shown via separate badge) -->
    <div role="article" tabindex="-1">
      <a href="https://www.google.com/maps/place/Ad+Cafe/data=!4m6!3m5!1s0x333:0x444!8m2" aria-label="Ad Cafe">
        <div class="fontHeadlineSmall">Ad Cafe</div>
      </a>
      <div class="fontBodyMedium">
        <span aria-label="4.2 stars">4.2</span>
        <span aria-label="3 reviews">(3)</span>
        <button>Cafe</button>
      </div>
      <div class="W4Efsd">1 Ad Ave</div>
      <div aria-label="Sponsored">Sponsored</div>
      <span data-item-id="phone:tel:+15551234">+1 555 1234</span>
      <a data-item-id="authority" href="https://ad-cafe.com">Website</a>
      <span data-item-id="oh">Open now</span>
    </div>

    <!-- Card 5: real modern-Maps nested .W4Efsd structure (category+address
         in B1, hours in B2). Verifies the parseInfoBlock() logic against
         the actual live DOM layout. -->
    <div role="article" tabindex="-1">
      <a href="https://www.google.com/maps/place/Real+Maps+Card/data=!4m6!3m5!1s0x555:0x666!8m2" aria-label="Real Maps Card">
        <span class="xxVWCe">Real Maps Card</span>
      </a>
      <div class="UaQhfb fontBodyMedium">
        <div class="W4Efsd"><div class="AJB7ye"><span class="e4rVHe fontBodyMedium"><span role="img" aria-label="4.8 stars"><span class="MW4etd">4.8</span></span></span></div></div>
        <div class="W4Efsd">
          <div class="W4Efsd">
            <span><span>Restaurant</span></span>
            <span> <span aria-hidden="true">·</span> <span>123 Real St</span></span>
          </div>
          <div class="W4Efsd">
            <span><span><span>Closed</span><span> · Opens 3:00 PM</span></span></span>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`;

let browser;
let page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.setContent(FIXTURE_HTML, { waitUntil: 'domcontentloaded' });
});

afterAll(async () => {
  if (browser) await browser.close();
});

describe('extractBusinesses end-to-end (fixture HTML)', () => {
  let result;

  beforeAll(async () => {
    result = await extractBusinesses(page, {
      query: 'Cafe',
      location: 'Berlin',
      logger: { info() {}, warn() {}, debug() {} },
    });
  });

  test('extracts all 5 cards', () => {
    expect(result.businesses).toHaveLength(5);
  });

  test('card 1 — happy path fields', () => {
    const b = result.businesses[0];
    expect(b.name).toBe('Cafe Berlin');
    expect(b.rating).toBe(4.5);
    expect(b.reviews_count).toBe(1234);
    expect(b.price_level).toBe('$$');
    expect(b.category).toBe('Mexican restaurant');
    expect(b.address).toContain('Main St');
    expect(b.phone).toBe('+491234567890');
    expect(b.website).toBe('https://cafe-berlin.de'); // utm stripped, trailing slash dropped
    expect(b.place_id).toBe('0x89d4cb90d1f1f1f1:0x2a2a2a2a2a2a2a2a');
    expect(b.plus_code).toBe('8FVC9GQF+5W');
    expect(b.open_now).toBe(true);
    expect(b.business_status).toBe('open');
    expect(b.is_sponsored).toBe(false);
    expect(b.maps_url).toContain('/maps/place/');
  });

  test('card 2 — missing fields are null (not N/A, not wrong field)', () => {
    const b = result.businesses[1];
    expect(b.name).toBe('Simple Spot');
    expect(b.rating).toBe(4.0);
    expect(b.reviews_count).toBe(56);
    expect(b.price_level).toBeNull();
    expect(b.phone).toBeNull();
    expect(b.website).toBeNull();
    expect(b.plus_code).toBeNull();
    expect(b.open_now).toBe(false); // "Closed"
  });

  test('card 3 — permanently closed flagged, not skipped', () => {
    const b = result.businesses[2];
    expect(b.name).toBe('Old Place');
    expect(b.business_status).toBe('permanently_closed');
    expect(b.rating).toBe(3.5);
  });

  test('card 4 — sponsored flagged', () => {
    const b = result.businesses[3];
    expect(b.name).toBe('Ad Cafe');
    expect(b.is_sponsored).toBe(true);
  });

  test('card 5 — real nested .W4Efsd structure (category/address/hours split correctly)', () => {
    const b = result.businesses[4];
    expect(b.name).toBe('Real Maps Card');
    expect(b.rating).toBe(4.8);
    expect(b.category).toBe('Restaurant');
    expect(b.address).toBe('123 Real St');
    // Hours text is "Closed · Opens 3:00 PM" → open_now=false (Closed keyword)
    expect(b.open_now).toBe(false);
  });

  test('every record has all 17 canonical keys', () => {
    for (const b of result.businesses) {
      expect(Object.keys(b).sort()).toEqual([...CANONICAL_FIELDS].sort());
    }
  });

  test('extraction rates include all canonical fields', () => {
    for (const field of CANONICAL_FIELDS) {
      expect(result.extractionRates[field]).toBeDefined();
      expect(result.extractionRates[field].total).toBe(5);
    }
  });

  test('name extraction rate is 100% on fixture', () => {
    expect(result.extractionRates.name.rate).toBe(100);
  });
});
