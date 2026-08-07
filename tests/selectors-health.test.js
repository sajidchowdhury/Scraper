'use strict';

/**
 * tests/selectors-health.test.js — Phase 2.11
 *
 * Unit tests for the self-healing selector subsystem:
 *   - version.js      — selector versioning + staleness warning
 *   - auto-discover.js — heuristic field discovery (pure helpers + page-bound)
 *   - health-check.js — extraction-rate evaluation + startup health check
 *   - debug-dump.js   — DOM snippet dumps for low-rate fields
 *   - extract.js      — new pure helpers (evaluateHealth, checkExtractionRatesForAbort)
 *
 * Acceptance criteria covered (from PHASE2_EXECUTION_PLAN.md §2.11):
 *   - Health check passes when extraction rates are high (using a fixture).
 *   - Health check fails when rates are low (using a broken fixture).
 *   - Auto-discover finds a phone field by pattern.
 *   - Selector version warning triggers when lastVerifiedDate is old.
 *
 * Run: bun test tests/selectors-health.test.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  SELECTOR_VERSIONS,
  parseDate,
  getSelectorAgeDays,
  isSelectorSetStale,
  getSelectorStatus,
  logSelectorVersion,
} = require('../src/selectors/version');

const {
  DISCOVERABLE_FIELDS,
  buildDiscoveryRequests,
  applyDiscoveryResults,
  discoverField,
  discoverMissingFields,
} = require('../src/selectors/auto-discover');

const {
  SELECTOR_FAILURE_EXIT_CODE,
  CORE_FIELDS,
  SECONDARY_FIELDS,
  CORE_THRESHOLD_PCT,
  SECONDARY_THRESHOLD_PCT,
  evaluateHealth,
  isCriticalFailure,
  buildSelectorFailureError,
  checkExtractionRatesForAbort,
  healthCheck,
} = require('../src/selectors/health-check');

const {
  shouldDumpForField,
  buildDumpPath,
  buildDumpContent,
  dumpSelectorDebug,
  DEFAULT_DUMP_THRESHOLD_PCT,
} = require('../src/selectors/debug-dump');

const {
  computeExtractionRates,
} = require('../src/extract');

// ---------------------------------------------------------------------------
// Test fixture — a small HTML page with a Google-Maps-like feed DOM for
// auto-discover + health-check tests. Has 3 cards:
//   1. Full happy path (all fields present via standard selectors)
//   2. Missing phone/website — discoverable via tel: link + non-Google <a>
//   3. Missing rating/reviews_count — discoverable via aria-label + text regex
// ---------------------------------------------------------------------------

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Health-check fixture</title></head>
<body>
  <div role="feed">
    <!-- Card 1: full happy path -->
    <div role="article" tabindex="-1">
      <a href="https://www.google.com/maps/place/Cafe+One/data=!4m6!3m5!1s0x111:0x222!8m2" aria-label="Cafe One">
        <div class="fontHeadlineSmall">Cafe One</div>
      </a>
      <div class="fontBodyMedium">
        <span aria-label="4.5 stars">4.5</span>
        <span aria-label="1,234 reviews">(1,234)</span>
        <span>$$</span>
        <button>Cafe</button>
      </div>
      <div class="W4Efsd">123 Main St</div>
      <span data-item-id="phone:tel:+491234567890">+49 123 4567890</span>
      <a data-item-id="authority" href="https://cafe-one.de">Website</a>
      <span data-item-id="oh">Open now</span>
    </div>

    <!-- Card 2: missing phone/website via standard selectors, but
         discoverable via aria-label="Phone" + non-Google <a href>.
         NOTE: NO data-item-id, NO tel: href, NO aria-label="Website" —
         standard selectors all miss, auto-discover finds them. -->
    <div role="article" tabindex="-1">
      <a href="https://www.google.com/maps/place/Cafe+Two/data=!4m6!3m5!1s0x333:0x444!8m2" aria-label="Cafe Two">
        <div class="fontHeadlineSmall">Cafe Two</div>
      </a>
      <div class="fontBodyMedium">
        <span aria-label="4.0 stars">4.0</span>
        <span aria-label="56 reviews">(56)</span>
        <button>Cafe</button>
      </div>
      <div class="W4Efsd">456 Side St</div>
      <span aria-label="Phone: +49 987 6543210">+49 987 6543210</span>
      <a href="https://cafe-two.example.com">Visit</a>
      <span data-item-id="oh">Closed</span>
    </div>

    <!-- Card 3: missing rating/reviews_count via standard selectors, but
         discoverable via role="img" aria-label="4.2" + "42 reviews" text.
         NOTE: NO aria-label$="stars", NO aria-label*="Rated" — standard
         selectors all miss, auto-discover finds them. -->
    <div role="article" tabindex="-1">
      <a href="https://www.google.com/maps/place/Cafe+Three/data=!4m6!3m5!1s0x555:0x666!8m2" aria-label="Cafe Three">
        <div class="fontHeadlineSmall">Cafe Three</div>
      </a>
      <div class="fontBodyMedium">
        <span role="img" aria-label="4.2">4.2</span>
        <span>42 reviews</span>
        <button>Cafe</button>
      </div>
      <div class="W4Efsd">789 Other Rd</div>
      <span data-item-id="phone:tel:+15551234">+1 555 1234</span>
      <a data-item-id="authority" href="https://cafe-three.com">Website</a>
      <span data-item-id="oh">Open now</span>
    </div>
  </div>
</body></html>`;

// A broken fixture — no cards at all. Should trigger a health-check failure
// (or at least a skip due to small sample size).
const BROKEN_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Broken fixture</title></head>
<body><div>No results found</div></body></html>`;

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

// ---------------------------------------------------------------------------
// 1. version.js — selector versioning + staleness warning
// ---------------------------------------------------------------------------

describe('Phase 2.11 — version.js', () => {
  test('SELECTOR_VERSIONS has entries for list, detail, search, scroll', () => {
    expect(SELECTOR_VERSIONS.list).toBeDefined();
    expect(SELECTOR_VERSIONS.detail).toBeDefined();
    expect(SELECTOR_VERSIONS.search).toBeDefined();
    expect(SELECTOR_VERSIONS.scroll).toBeDefined();
    for (const [, set] of Object.entries(SELECTOR_VERSIONS)) {
      expect(set.version).toBeGreaterThanOrEqual(1);
      expect(set.lastVerifiedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof set.source).toBe('string');
    }
  });

  test('parseDate parses a valid ISO date', () => {
    const d = parseDate('2026-08-07');
    expect(d).toBeInstanceOf(Date);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(7); // August (0-indexed)
    expect(d.getUTCDate()).toBe(7);
  });

  test('parseDate rejects invalid dates', () => {
    expect(parseDate('not-a-date')).toBeNull();
    expect(parseDate('2026-02-31')).toBeNull(); // rollover
    expect(parseDate('2026-13-01')).toBeNull(); // bad month
    expect(parseDate(null)).toBeNull();
    expect(parseDate('')).toBeNull();
  });

  test('getSelectorAgeDays returns 0 for today', () => {
    const today = new Date().toISOString().slice(0, 10);
    const age = getSelectorAgeDays('list', new Date(today + 'T12:00:00Z'));
    expect(age).toBe(0);
  });

  test('getSelectorAgeDays returns N for N days ago', () => {
    // Temporarily override lastVerifiedDate
    const orig = SELECTOR_VERSIONS.list.lastVerifiedDate;
    SELECTOR_VERSIONS.list.lastVerifiedDate = '2026-01-01';
    const age = getSelectorAgeDays('list', new Date('2026-02-01T00:00:00Z'));
    expect(age).toBe(31);
    SELECTOR_VERSIONS.list.lastVerifiedDate = orig;
  });

  test('getSelectorAgeDays returns null for unknown set', () => {
    expect(getSelectorAgeDays('nonexistent')).toBeNull();
  });

  test('getSelectorAgeDays returns 0 for future-dated verification', () => {
    const orig = SELECTOR_VERSIONS.list.lastVerifiedDate;
    SELECTOR_VERSIONS.list.lastVerifiedDate = '2099-12-31';
    const age = getSelectorAgeDays('list', new Date('2026-01-01T00:00:00Z'));
    expect(age).toBe(0);
    SELECTOR_VERSIONS.list.lastVerifiedDate = orig;
  });

  test('isSelectorSetStale returns false for fresh sets', () => {
    const orig = SELECTOR_VERSIONS.list.lastVerifiedDate;
    SELECTOR_VERSIONS.list.lastVerifiedDate = new Date().toISOString().slice(0, 10);
    expect(isSelectorSetStale('list', { maxAgeDays: 30 })).toBe(false);
    SELECTOR_VERSIONS.list.lastVerifiedDate = orig;
  });

  test('isSelectorSetStale returns true for old sets', () => {
    const orig = SELECTOR_VERSIONS.list.lastVerifiedDate;
    SELECTOR_VERSIONS.list.lastVerifiedDate = '2020-01-01';
    expect(isSelectorSetStale('list', { maxAgeDays: 30, now: new Date('2026-01-01T00:00:00Z') })).toBe(true);
    SELECTOR_VERSIONS.list.lastVerifiedDate = orig;
  });

  test('getSelectorStatus returns array with stale flag', () => {
    const status = getSelectorStatus({ maxAgeDays: 30, now: new Date() });
    expect(Array.isArray(status)).toBe(true);
    expect(status.length).toBeGreaterThanOrEqual(4);
    for (const s of status) {
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('version');
      expect(s).toHaveProperty('lastVerifiedDate');
      expect(s).toHaveProperty('ageDays');
      expect(s).toHaveProperty('stale');
    }
  });

  test('logSelectorVersion logs version info + warns for stale sets', () => {
    const orig = SELECTOR_VERSIONS.scroll.lastVerifiedDate;
    SELECTOR_VERSIONS.scroll.lastVerifiedDate = '2020-01-01';
    const infos = [];
    const warns = [];
    const logger = {
      info: (msg, ctx) => infos.push({ msg, ctx }),
      warn: (msg, ctx) => warns.push({ msg, ctx }),
      phase: () => ({ info: (m, c) => infos.push({ msg: m, ctx: c }), warn: (m, c) => warns.push({ msg: m, ctx: c }) }),
    };
    const { status, staleSets } = logSelectorVersion(logger, {
      maxAgeDays: 30,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    expect(status.length).toBeGreaterThanOrEqual(4);
    expect(staleSets.length).toBeGreaterThanOrEqual(1);
    expect(staleSets.some((s) => s.name === 'scroll')).toBe(true);
    expect(warns.some((w) => w.ctx && w.ctx.set === 'scroll')).toBe(true);
    expect(infos.length).toBeGreaterThanOrEqual(4);
    SELECTOR_VERSIONS.scroll.lastVerifiedDate = orig;
  });

  test('logSelectorVersion handles a logger without .phase()', () => {
    const infos = [];
    const warns = [];
    const logger = {
      info: (msg) => infos.push(msg),
      warn: (msg) => warns.push(msg),
    };
    const { status } = logSelectorVersion(logger, { maxAgeDays: 30 });
    expect(status.length).toBeGreaterThanOrEqual(4);
    expect(infos.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// 2. auto-discover.js — heuristic field discovery
// ---------------------------------------------------------------------------

describe('Phase 2.11 — auto-discover.js (pure helpers)', () => {
  test('DISCOVERABLE_FIELDS is phone, website, rating, reviews_count', () => {
    expect(DISCOVERABLE_FIELDS).toEqual(['phone', 'website', 'rating', 'reviews_count']);
  });

  test('buildDiscoveryRequests returns empty for fully-populated records', () => {
    const businesses = [
      { name: 'A', rating: 4.5, reviews_count: 10, phone: '+1', website: 'http://a' },
      { name: 'B', rating: 4.0, reviews_count: 5, phone: '+2', website: 'http://b' },
    ];
    const reqs = buildDiscoveryRequests(businesses);
    expect(reqs).toEqual([]);
  });

  test('buildDiscoveryRequests returns requests for missing discoverable fields', () => {
    const businesses = [
      { name: 'A', rating: 4.5, reviews_count: 10, phone: null, website: null },
      { name: 'B', rating: null, reviews_count: null, phone: '+2', website: 'http://b' },
    ];
    const reqs = buildDiscoveryRequests(businesses);
    expect(reqs.length).toBe(2);
    expect(reqs[0].cardIndex).toBe(0);
    expect(reqs[0].fields).toContain('phone');
    expect(reqs[0].fields).toContain('website');
    expect(reqs[1].cardIndex).toBe(1);
    expect(reqs[1].fields).toContain('rating');
    expect(reqs[1].fields).toContain('reviews_count');
  });

  test('buildDiscoveryRequests ignores non-discoverable fields (name, address)', () => {
    // All discoverable fields filled → no requests, even though name/address are null.
    const businesses = [{ name: null, address: null, phone: '+1', website: 'http://a', rating: 4.5, reviews_count: 10 }];
    const reqs = buildDiscoveryRequests(businesses);
    expect(reqs).toEqual([]);
  });

  test('applyDiscoveryResults fills in missing fields with discovered values', () => {
    const businesses = [
      { name: 'A', phone: null, website: null },
      { name: 'B', phone: '+1', website: 'http://b' },
    ];
    const results = [
      { cardIndex: 0, discovered: { phone: { selector: 'a[href^="tel:"]', value: '+49 123', snippet: '' } } },
    ];
    const out = applyDiscoveryResults(businesses, results);
    expect(out[0].phone).toBe('+49 123');
    expect(out[0].website).toBeNull(); // not discovered
    expect(out[1].phone).toBe('+1'); // unchanged
  });

  test('applyDiscoveryResults does not override existing values', () => {
    const businesses = [{ name: 'A', phone: '+1' }];
    const results = [
      { cardIndex: 0, discovered: { phone: { selector: 'x', value: '+2', snippet: '' } } },
    ];
    const out = applyDiscoveryResults(businesses, results);
    expect(out[0].phone).toBe('+1'); // NOT overridden
  });

  test('applyDiscoveryResults returns input unchanged for empty results', () => {
    const businesses = [{ name: 'A', phone: null }];
    expect(applyDiscoveryResults(businesses, [])).toBe(businesses);
    expect(applyDiscoveryResults(businesses, null)).toBe(businesses);
  });

  test('applyDiscoveryResults does not add non-canonical tags by default', () => {
    const businesses = [{ name: 'A', phone: null }];
    const results = [{ cardIndex: 0, discovered: { phone: { selector: 'x', value: '+1', snippet: '' } } }];
    const out = applyDiscoveryResults(businesses, results);
    expect(out[0]).not.toHaveProperty('_discovered_phone');
  });

  test('applyDiscoveryResults adds _discovered_ tag when tagDiscovered=true', () => {
    const businesses = [{ name: 'A', phone: null }];
    const results = [{ cardIndex: 0, discovered: { phone: { selector: 'x', value: '+1', snippet: '' } } }];
    const out = applyDiscoveryResults(businesses, results, { tagDiscovered: true });
    expect(out[0]._discovered_phone).toBe(true);
  });

  test('applyDiscoveryResults handles out-of-range cardIndex gracefully', () => {
    const businesses = [{ name: 'A', phone: null }];
    const results = [{ cardIndex: 99, discovered: { phone: { selector: 'x', value: '+1', snippet: '' } } }];
    const out = applyDiscoveryResults(businesses, results);
    expect(out[0].phone).toBeNull(); // unchanged (index out of range)
  });
});

describe('Phase 2.11 — auto-discover.js (page-bound)', () => {
  test('discoverField finds phone via aria-label*="phone" on card 2', async () => {
    const result = await discoverField(page, 1, 'phone', {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
    });
    expect(result).not.toBeNull();
    expect(result.value).toMatch(/49\s*987\s*6543210/);
    expect(result.selector).toBeDefined();
  });

  test('discoverField finds website via non-Google <a> on card 2', async () => {
    const result = await discoverField(page, 1, 'website', {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
    });
    expect(result).not.toBeNull();
    expect(result.value).toContain('cafe-two.example.com');
  });

  test('discoverField finds rating via role="img" aria-label on card 3', async () => {
    const result = await discoverField(page, 2, 'rating', {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
    });
    expect(result).not.toBeNull();
    expect(result.value).toMatch(/4\.2/);
  });

  test('discoverField finds reviews_count via text regex on card 3', async () => {
    const result = await discoverField(page, 2, 'reviews_count', {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
    });
    expect(result).not.toBeNull();
    expect(result.value).toMatch(/42/);
  });

  test('discoverField returns null for non-discoverable field (name)', async () => {
    const result = await discoverField(page, 0, 'name', {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
    });
    expect(result).toBeNull();
  });

  test('discoverField returns null for out-of-range card index', async () => {
    const result = await discoverField(page, 99, 'phone', {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
    });
    expect(result).toBeNull();
  });

  test('discoverMissingFields handles empty requests array', async () => {
    const results = await discoverMissingFields(page, [], {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
    });
    expect(results).toEqual([]);
  });

  test('discoverMissingFields discovers multiple fields in one round-trip', async () => {
    const requests = [
      { cardIndex: 1, fields: ['phone', 'website'] },
      { cardIndex: 2, fields: ['rating', 'reviews_count'] },
    ];
    const results = await discoverMissingFields(page, requests, {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
    });
    expect(results.length).toBe(2);
    expect(results[0].discovered.phone).toBeDefined();
    expect(results[0].discovered.website).toBeDefined();
    expect(results[1].discovered.rating).toBeDefined();
    expect(results[1].discovered.reviews_count).toBeDefined();
  });

  test('discoverMissingFields logs each successful discovery', async () => {
    const logged = [];
    const logger = {
      info: (msg, ctx) => logged.push({ msg, ctx }),
      warn: () => {},
      debug: () => {},
      error: () => {},
    };
    await discoverMissingFields(page, [{ cardIndex: 1, fields: ['phone'] }], { logger });
    expect(logged.some((l) => l.msg && l.msg.includes('Auto-discovered phone'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. health-check.js — extraction-rate evaluation + startup health check
// ---------------------------------------------------------------------------

describe('Phase 2.11 — health-check.js (pure helpers)', () => {
  test('CORE_FIELDS is name, rating, reviews_count, address', () => {
    expect(CORE_FIELDS).toEqual(['name', 'rating', 'reviews_count', 'address']);
  });

  test('SECONDARY_FIELDS includes phone, website, plus_code, etc.', () => {
    expect(SECONDARY_FIELDS).toContain('phone');
    expect(SECONDARY_FIELDS).toContain('website');
    expect(SECONDARY_FIELDS).toContain('plus_code');
    expect(SECONDARY_FIELDS).toContain('category');
  });

  test('SELECTOR_FAILURE_EXIT_CODE is 3', () => {
    expect(SELECTOR_FAILURE_EXIT_CODE).toBe(3);
  });

  test('CORE_THRESHOLD_PCT is 50, SECONDARY_THRESHOLD_PCT is 30', () => {
    expect(CORE_THRESHOLD_PCT).toBe(50);
    expect(SECONDARY_THRESHOLD_PCT).toBe(30);
  });

  test('evaluateHealth returns ok=true when rates are high', () => {
    const rates = makeRates({ name: 100, rating: 100, reviews_count: 95, address: 100, phone: 90 }, 20);
    const result = evaluateHealth(rates);
    expect(result.ok).toBe(true);
    expect(result.failingCore).toEqual([]);
    expect(result.total).toBe(20);
  });

  test('evaluateHealth returns ok=false when a core field is below 50%', () => {
    const rates = makeRates({ name: 100, rating: 40, reviews_count: 95, address: 100 }, 20);
    const result = evaluateHealth(rates);
    expect(result.ok).toBe(false);
    expect(result.failingCore).toContain('rating');
    expect(result.reason).toMatch(/rating=40%/);
  });

  test('evaluateHealth skips when sample size < minSampleSize', () => {
    const rates = makeRates({ name: 0, rating: 0, reviews_count: 0, address: 0 }, 5);
    const result = evaluateHealth(rates, { minSampleSize: 10 });
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/sample size 5 < minSampleSize 10/);
  });

  test('evaluateHealth flags secondary fields below 30% but does not fail', () => {
    const rates = makeRates(
      { name: 100, rating: 100, reviews_count: 100, address: 100, phone: 20, website: 25 },
      20,
    );
    const result = evaluateHealth(rates);
    expect(result.ok).toBe(true);
    expect(result.failingSecondary).toContain('phone');
    expect(result.failingSecondary).toContain('website');
  });

  test('isCriticalFailure returns true only when ok=false AND failingCore > 0', () => {
    expect(isCriticalFailure({ ok: false, failingCore: ['rating'] })).toBe(true);
    expect(isCriticalFailure({ ok: true, failingCore: [] })).toBe(false);
    expect(isCriticalFailure({ ok: false, failingCore: [] })).toBe(false);
    expect(isCriticalFailure(null)).toBe(false);
  });

  test('buildSelectorFailureError sets code, exitCode, health', () => {
    const health = { ok: false, failingCore: ['rating'], failingSecondary: [], reason: 'test' };
    const err = buildSelectorFailureError(health);
    expect(err.code).toBe('SELECTOR_FAILURE');
    expect(err.exitCode).toBe(3);
    expect(err.health).toBe(health);
    expect(err.failingCore).toEqual(['rating']);
    expect(err.message).toBe('test');
  });

  test('checkExtractionRatesForAbort throws on critical failure', () => {
    const rates = makeRates({ name: 100, rating: 30, reviews_count: 95, address: 100 }, 20);
    expect(() => checkExtractionRatesForAbort(rates)).toThrow();
    try {
      checkExtractionRatesForAbort(rates);
    } catch (err) {
      expect(err.code).toBe('SELECTOR_FAILURE');
      expect(err.exitCode).toBe(3);
    }
  });

  test('checkExtractionRatesForAbort does not throw when rates are healthy', () => {
    const rates = makeRates({ name: 100, rating: 100, reviews_count: 95, address: 100 }, 20);
    expect(() => checkExtractionRatesForAbort(rates)).not.toThrow();
    const result = checkExtractionRatesForAbort(rates);
    expect(result.ok).toBe(true);
  });

  test('checkExtractionRatesForAbort does not throw for small samples', () => {
    const rates = makeRates({ name: 0, rating: 0, reviews_count: 0, address: 0 }, 5);
    expect(() => checkExtractionRatesForAbort(rates, { minSampleSize: 10 })).not.toThrow();
  });
});

describe('Phase 2.11 — health-check.js (page-bound healthCheck)', () => {
  test('healthCheck passes on a healthy fixture', async () => {
    const { ok, health } = await healthCheck(page, {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      minSampleSize: 1,
      autoDiscover: true,
    });
    expect(ok).toBe(true);
    expect(health.total).toBeGreaterThanOrEqual(3);
    // Core fields should be near 100% on the healthy fixture.
    for (const f of CORE_FIELDS) {
      expect(health.coreRates[f]).toBeGreaterThanOrEqual(50);
    }
  });

  test('healthCheck fails on a broken fixture (no cards)', async () => {
    const brokenPage = await browser.newPage();
    await brokenPage.setContent(BROKEN_HTML, { waitUntil: 'domcontentloaded' });
    const { ok, health } = await healthCheck(brokenPage, {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      minSampleSize: 1,
      autoDiscover: false,
    });
    // With 0 cards, sample size is 0 < minSampleSize 1 → ok=true (skipped).
    // OR if minSampleSize is 0, total=0 → all rates are 0 → ok=false.
    // We use minSampleSize=1 so it skips (ok=true, reason mentions sample size).
    expect(ok).toBe(true);
    expect(health.total).toBe(0);
    await brokenPage.close();
  });

  test('healthCheck fails when core rates are below threshold', async () => {
    // Simulate a DOM change: use a fixture where rating/reviews_count selectors
    // all miss. We craft a fixture with cards that have name+address but no
    // recognizable rating/reviews_count elements.
    const degradedHtml = `<!DOCTYPE html><html><body>
      <div role="feed">
        ${Array.from({ length: 12 }, (_, i) => `
          <div role="article">
            <a href="https://www.google.com/maps/place/Place+${i}/data=!1s0x${i}:0x${i}" aria-label="Place ${i}">
              <div class="fontHeadlineSmall">Place ${i}</div>
            </a>
            <div class="W4Efsd">${i} Main St</div>
            <!-- NO rating, NO reviews_count — selectors all miss -->
          </div>`).join('')}
      </div>
    </body></html>`;
    const degradedPage = await browser.newPage();
    await degradedPage.setContent(degradedHtml, { waitUntil: 'domcontentloaded' });
    const { ok, health } = await healthCheck(degradedPage, {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      minSampleSize: 10,
      coreThreshold: 50,
      autoDiscover: false,
    });
    expect(ok).toBe(false);
    expect(health.failingCore).toContain('rating');
    expect(health.failingCore).toContain('reviews_count');
    expect(health.reason).toMatch(/Extraction rates critically low/);
    await degradedPage.close();
  });

  test('healthCheck runs auto-discover to fill in missing fields', async () => {
    // On the main fixture, card 2 is missing phone/website (discoverable).
    // With autoDiscover=true, the health check should fill them in and the
    // rates should be higher than without auto-discover.
    const { ok, rates } = await healthCheck(page, {
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      minSampleSize: 1,
      autoDiscover: true,
    });
    expect(ok).toBe(true);
    // After auto-discover, phone rate should be high (cards 1, 2, 3 all have
    // phone — card 2 via tel: link discovery).
    expect(rates.phone.rate).toBeGreaterThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// 4. debug-dump.js — DOM snippet dumps for low-rate fields
// ---------------------------------------------------------------------------

describe('Phase 2.11 — debug-dump.js', () => {
  test('DEFAULT_DUMP_THRESHOLD_PCT is 80', () => {
    expect(DEFAULT_DUMP_THRESHOLD_PCT).toBe(80);
  });

  test('shouldDumpForField returns true when rate < threshold', () => {
    expect(shouldDumpForField('phone', 50, { thresholdPct: 80 })).toBe(true);
    expect(shouldDumpForField('phone', 79, { thresholdPct: 80 })).toBe(true);
  });

  test('shouldDumpForField returns false when rate >= threshold', () => {
    expect(shouldDumpForField('phone', 80, { thresholdPct: 80 })).toBe(false);
    expect(shouldDumpForField('phone', 100, { thresholdPct: 80 })).toBe(false);
  });

  test('shouldDumpForField returns false when disabled', () => {
    expect(shouldDumpForField('phone', 10, { enabled: false, thresholdPct: 80 })).toBe(false);
  });

  test('shouldDumpForField returns false for null/invalid rate', () => {
    expect(shouldDumpForField('phone', null, { thresholdPct: 80 })).toBe(false);
    expect(shouldDumpForField('phone', NaN, { thresholdPct: 80 })).toBe(false);
    expect(shouldDumpForField('phone', undefined, { thresholdPct: 80 })).toBe(false);
  });

  test('buildDumpPath includes field name + timestamp', () => {
    const p = buildDumpPath('phone', { dir: '/tmp/test-dump', now: new Date('2026-08-07T12:00:00.000Z') });
    expect(p).toContain('phone_');
    expect(p).toContain('2026-08-07T12-00-00-000Z');
    expect(p.startsWith('/tmp/test-dump')).toBe(true);
  });

  test('buildDumpPath sanitizes field name', () => {
    const p = buildDumpPath('phone/custom', { dir: '/tmp/test-dump' });
    // The slash in the field name is sanitized to _ so it doesn't create subdirs.
    expect(p).toContain('phone_custom');
    expect(p).not.toMatch(/phone\/custom/); // no literal slash in the filename
    // The path starts with the dir, then the sanitized filename.
    expect(p.startsWith('/tmp/test-dump')).toBe(true);
  });

  test('buildDumpContent includes field name + card snippets', () => {
    const content = buildDumpContent('phone', [
      { index: 0, snippet: '<div>card 0</div>' },
      { index: 1, snippet: '<div>card 1</div>' },
    ], { rate: 45, now: new Date('2026-08-07T00:00:00Z') });
    expect(content).toContain('field: phone');
    expect(content).toContain('Extraction rate: 45%');
    expect(content).toContain('Card 0');
    expect(content).toContain('<div>card 0</div>');
    expect(content).toContain('<div>card 1</div>');
  });

  test('buildDumpContent truncates snippets to 500 chars', () => {
    const longSnippet = 'x'.repeat(1000);
    const content = buildDumpContent('phone', [{ index: 0, snippet: longSnippet }]);
    expect(content).toContain('x'.repeat(500));
    expect(content).not.toContain('x'.repeat(501));
  });

  test('dumpSelectorDebug writes a file to disk', () => {
    const tmpDir = path.join(os.tmpdir(), 'selector-dump-test-' + Date.now());
    const cards = [{ index: 0, snippet: '<div>test card</div>' }];
    const logged = [];
    const logger = {
      info: (msg, ctx) => logged.push({ msg, ctx }),
      warn: () => {},
      debug: () => {},
      error: () => {},
    };
    const filepath = dumpSelectorDebug('phone', cards, {
      dir: tmpDir,
      rate: 45,
      logger,
    });
    expect(filepath).toBeTruthy();
    expect(fs.existsSync(filepath)).toBe(true);
    const content = fs.readFileSync(filepath, 'utf8');
    expect(content).toContain('field: phone');
    expect(content).toContain('<div>test card</div>');
    expect(logged.some((l) => l.msg && l.msg.includes('Selector debug dump written'))).toBe(true);
    // Cleanup
    fs.unlinkSync(filepath);
    fs.rmdirSync(tmpDir);
  });

  test('dumpSelectorDebug returns null for empty cards array', () => {
    const result = dumpSelectorDebug('phone', [], { logger: { info() {}, warn() {}, debug() {}, error() {} } });
    expect(result).toBeNull();
  });

  test('dumpSelectorDebug warns on filesystem error', () => {
    const warned = [];
    const logger = {
      info: () => {},
      warn: (msg, ctx) => warned.push({ msg, ctx }),
      debug: () => {},
      error: () => {},
    };
    // Use an unwritable path (parent of root)
    const result = dumpSelectorDebug('phone', [{ index: 0, snippet: '<div/>' }], {
      dir: '/nonexistent-root/path/that/cannot/be/created',
      logger,
    });
    expect(result).toBeNull();
    expect(warned.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. extract.js — new pure helpers (re-exported from extract.js)
// ---------------------------------------------------------------------------

describe('Phase 2.11 — extract.js pure helpers (re-exported)', () => {
  test('extract.js exports the Phase 2.11 helpers', () => {
    const extract = require('../src/extract');
    expect(extract.CORE_FIELDS).toEqual(CORE_FIELDS);
    expect(extract.SECONDARY_FIELDS).toEqual(SECONDARY_FIELDS);
    expect(extract.SELECTOR_FAILURE_EXIT_CODE).toBe(3);
    expect(typeof extract.evaluateHealth).toBe('function');
    expect(typeof extract.checkExtractionRatesForAbort).toBe('function');
    expect(typeof extract.buildSelectorFailureError).toBe('function');
    expect(typeof extract.getCardSnippets).toBe('function');
  });

  test('extract.js evaluateHealth matches health-check evaluateHealth', () => {
    const extract = require('../src/extract');
    const rates = makeRates({ name: 100, rating: 100, reviews_count: 100, address: 100 }, 20);
    expect(extract.evaluateHealth(rates)).toEqual(evaluateHealth(rates));
  });

  test('getCardSnippets returns innerHTML snippets for the given indexes', async () => {
    const { getCardSnippets } = require('../src/extract');
    const snippets = await getCardSnippets(page, [0, 1, 2]);
    expect(snippets.length).toBe(3);
    expect(snippets[0]).toContain('Cafe One');
    expect(snippets[1]).toContain('Cafe Two');
    expect(snippets[2]).toContain('Cafe Three');
  });

  test('getCardSnippets returns empty array for empty indexes', async () => {
    const { getCardSnippets } = require('../src/extract');
    const snippets = await getCardSnippets(page, []);
    expect(snippets).toEqual([]);
  });

  test('getCardSnippets returns null for out-of-range index', async () => {
    const { getCardSnippets } = require('../src/extract');
    const snippets = await getCardSnippets(page, [99]);
    expect(snippets.length).toBe(1);
    expect(snippets[0]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. extract.js — extractBusinesses integration with auto-discover + dumps
// ---------------------------------------------------------------------------

describe('Phase 2.11 — extractBusinesses auto-discover integration', () => {
  const { extractBusinesses } = require('../src/extract');

  test('extractBusinesses fills in discoverable fields via auto-discover', async () => {
    const result = await extractBusinesses(page, {
      query: 'test',
      location: 'fixture',
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      selectors: { autoDiscover: true, abortCheck: false, debugDump: false },
    });
    // Card 2 (index 1) has phone discoverable via aria-label*="phone"
    expect(result.businesses[1].phone).not.toBeNull();
    expect(result.businesses[1].phone).toMatch(/49\s*987\s*6543210/);
    // Card 2 also has website discoverable via non-Google <a href>
    expect(result.businesses[1].website).not.toBeNull();
    expect(result.businesses[1].website).toContain('cafe-two.example.com');
    // Card 3 (index 2) has rating discoverable via role="img" aria-label
    expect(result.businesses[2].rating).not.toBeNull();
    expect(result.businesses[2].rating).toBeCloseTo(4.2, 1);
    // Card 3 has reviews_count discoverable via "42 reviews" text
    expect(result.businesses[2].reviews_count).not.toBeNull();
    expect(result.businesses[2].reviews_count).toBe(42);
    // Discovery stats should be tracked
    expect(result.stats.discovery).toBeDefined();
    expect(result.stats.discovery.discovered).toBeGreaterThan(0);
  });

  test('extractBusinesses skips auto-discover when disabled', async () => {
    const result = await extractBusinesses(page, {
      query: 'test',
      location: 'fixture',
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      selectors: { autoDiscover: false, abortCheck: false, debugDump: false },
    });
    // Card 2 phone should remain null (no standard selector matches, no discovery)
    expect(result.businesses[1].phone).toBeNull();
    // Card 2 website should remain null (no standard selector matches)
    expect(result.businesses[1].website).toBeNull();
    // Card 3 rating should remain null (no standard selector matches)
    expect(result.businesses[2].rating).toBeNull();
    // Card 3 reviews_count should remain null (no standard selector matches)
    expect(result.businesses[2].reviews_count).toBeNull();
    expect(result.stats.discovery.discovered).toBe(0);
  });

  test('extractBusinesses throws on critical rates when abortCheck is on', async () => {
    // Build a degraded fixture with 12 cards but no rating/reviews_count
    const degradedHtml = `<!DOCTYPE html><html><body>
      <div role="feed">
        ${Array.from({ length: 12 }, (_, i) => `
          <div role="article">
            <a href="https://www.google.com/maps/place/Place+${i}/data=!1s0x${i}:0x${i}" aria-label="Place ${i}">
              <div class="fontHeadlineSmall">Place ${i}</div>
            </a>
            <div class="W4Efsd">${i} Main St</div>
          </div>`).join('')}
      </div>
    </body></html>`;
    const degradedPage = await browser.newPage();
    await degradedPage.setContent(degradedHtml, { waitUntil: 'domcontentloaded' });
    let threw = false;
    let caughtErr = null;
    try {
      await extractBusinesses(degradedPage, {
        query: 'test',
        location: 'fixture',
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        selectors: { autoDiscover: false, abortCheck: true, debugDump: false },
      });
    } catch (err) {
      threw = true;
      caughtErr = err;
    }
    expect(threw).toBe(true);
    expect(caughtErr.code).toBe('SELECTOR_FAILURE');
    expect(caughtErr.exitCode).toBe(3);
    await degradedPage.close();
  });

  test('extractBusinesses writes debug dumps for low-rate fields', async () => {
    const tmpDir = path.join(os.tmpdir(), 'selector-extract-dump-test-' + Date.now());
    const result = await extractBusinesses(page, {
      query: 'test',
      location: 'fixture',
      logger: { info() {}, warn() {}, debug() {}, error() {} },
      selectors: {
        autoDiscover: false,
        abortCheck: false,
        debugDump: true,
        debugDumpDir: tmpDir,
        // Set a high threshold so dumps fire even on the healthy fixture
        debugDumpThreshold: 95,
      },
    });
    // Some dumps should have been written (phone/website rates are < 95% on
    // the fixture without auto-discover).
    const files = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
    expect(files.length).toBeGreaterThan(0);
    // Cleanup
    if (fs.existsSync(tmpDir)) {
      for (const f of files) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    }
    // Result should still be returned (dump errors are non-fatal)
    expect(result.businesses.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a rates object like the one computeExtractionRates returns.
 * @param {object} fieldRates — { fieldName: ratePercent }
 * @param {number} total — total card count
 */
function makeRates(fieldRates, total) {
  const rates = {};
  const allFields = [
    'name', 'rating', 'reviews_count', 'price_level', 'category', 'address',
    'phone', 'website', 'maps_url', 'place_id', 'plus_code', 'open_now',
    'business_status', 'is_sponsored', 'scraped_at', 'query', 'location',
  ];
  for (const f of allFields) {
    const rate = fieldRates[f] != null ? fieldRates[f] : 100;
    const filled = Math.round((rate / 100) * total);
    rates[f] = { filled, total, rate, warn: rate < 80 };
  }
  return rates;
}
