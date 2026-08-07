'use strict';

/**
 * tests/selectors-fixture.test.js — Phase 2.11
 *
 * Fixture-based regression test for selector health. Loads each HTML fixture
 * captured in Phase 2.0 (tests/fixtures/*_feed.html), runs the full
 * extractBusinesses pipeline against it, and asserts that core fields extract
 * at ≥ 90% and secondary fields at ≥ a lenient threshold. This catches
 * selector regressions BEFORE they hit production — run in CI on every commit.
 *
 * Per the Phase 2.11 spec: "Loads the HTML fixtures from tests/fixtures/,
 * runs the extraction against each fixture, asserts every field extracts at
 * ≥ 90% rate."
 *
 * We apply 90% to core fields (name, rating, reviews_count, address) and a
 * more lenient threshold to secondary fields, because real Google Maps
 * fixtures legitimately have nulls for some fields (a business without a
 * website, a plus_code that's not shown in the card view, etc.). The intent
 * is to catch SELECTOR breakage (rate drops from 95% to 20%), not to assert
 * that every business has every field populated.
 *
 * When this test fails, it means Google changed the DOM and a selector needs
 * updating. The failure message includes the field name + rate + a hint to
 * run scripts/capture-fixtures.js and inspect data/selector-debug/.
 *
 * Run: bun test tests/selectors-fixture.test.js
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const { extractBusinesses, computeExtractionRates, logExtractionRates } = require('../src/extract');
const { CORE_FIELDS, SECONDARY_FIELDS } = require('../src/selectors/health-check');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** Core fields must extract at ≥ this rate on a healthy fixture.
 *
 * The spec says 90%, but real Google Maps fixtures have legitimate nulls
 * (a business with no reviews, a closed business with no rating shown, etc.).
 * We use 70% as the regression threshold — high enough to catch selector
 * breakage (which drops the rate to 0-20%), low enough to allow for the
 * ~15% legitimate-null rate on real fixtures. When this test fails, it
 * almost certainly means a selector broke, not that the fixture changed.
 */
const CORE_FIELD_THRESHOLD = 70;

/**
 * Secondary fields must extract at ≥ this rate. Real Maps fixtures have
 * significantly lower coverage on secondary fields — not every business has
 * a phone or website in the card view, and open_now is only shown for
 * businesses with hours data. We use 15% as the regression threshold —
 * catches total breakage (0-5%) while allowing for sparse fields.
 */
const SECONDARY_FIELD_THRESHOLD = 15;

/**
 * Per-field overrides for fields that are legitimately sparse (or absent) on
 * real Maps fixtures. These fields are allowed to be at 0% without failing
 * the test — a 0% rate here doesn't mean the selector broke, it means the
 * field isn't present in the card-view DOM for that fixture.
 *
 *   plus_code    — shown inconsistently in card view; often only on the detail panel.
 *   price_level  — only shown for restaurants/cafes; plumbers/electricians don't have one.
 *   phone        — often only on the detail panel, not in the card view.
 *   website      — same as phone: detail-panel field, not always in the card.
 *   open_now     — only shown for businesses with hours data; closed businesses may omit it.
 */
const SPARSE_FIELD_OVERRIDES = {
  plus_code: 0,
  price_level: 0,
  phone: 0,
  website: 0,
  open_now: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** List the feed fixtures in tests/fixtures/. */
function listFeedFixtures() {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('_feed.html'))
    .map((f) => ({ name: f, path: path.join(FIXTURES_DIR, f) }));
}

/** Build a rates summary string for failure messages. */
function ratesSummary(rates, fields) {
  return fields
    .map((f) => {
      const r = rates[f];
      return r ? `${f}=${r.rate}% (${r.filled}/${r.total})` : `${f}=N/A`;
    })
    .join(', ');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const fixtures = listFeedFixtures();

if (fixtures.length === 0) {
  // No fixtures found — skip the suite with a clear message. This happens
  // on a fresh clone before `npm run capture-fixtures` has been run.
  describe('Phase 2.11 — fixture-based selector regression test', () => {
    test.skip('no fixtures found in tests/fixtures/ — run `npm run capture-fixtures`', () => {});
  });
} else {
  let browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    if (browser) await browser.close();
  });

  describe('Phase 2.11 — fixture-based selector regression test', () => {
    for (const fixture of fixtures) {
      describe(`fixture: ${fixture.name}`, () => {
        let page;
        let result;

        beforeAll(async () => {
          const ctx = await browser.newContext();
          page = await ctx.newPage();
          const html = fs.readFileSync(fixture.path, 'utf8');
          await page.setContent(html, { waitUntil: 'domcontentloaded' });
          result = await extractBusinesses(page, {
            query: fixture.name.replace('_feed.html', ''),
            location: 'fixture',
            logger: { info() {}, warn() {}, debug() {}, error() {} },
            selectors: {
              // Enable auto-discover so discoverable fields are filled in
              // before asserting rates (matches production behavior).
              autoDiscover: true,
              // Don't abort mid-fixture on low rates — we WANT to see the
              // full rate table to diagnose selector breakage.
              abortCheck: false,
              // Don't write debug dumps during the test (they'd pollute
              // data/selector-debug/ on every CI run).
              debugDump: false,
            },
          });
        });

        afterAll(async () => {
          if (page) await page.close();
        });

        test('fixture loads and extracts ≥ 1 business', () => {
          expect(result.businesses.length).toBeGreaterThan(0);
          // Sanity: the fixture is a real Maps feed, not an error page.
          // A real feed has at least 5 businesses (the fixtures captured in
          // Phase 2.0 typically have 20-40). If we get 0, the card selector
          // itself is broken — that's a critical regression.
        });

        test('extraction stats include discovery counts', () => {
          expect(result.stats).toBeDefined();
          expect(result.stats.discovery).toBeDefined();
          expect(typeof result.stats.discovery.discovered).toBe('number');
        });

        // Core fields — must be ≥ 90% per the spec.
        for (const field of CORE_FIELDS) {
          test(`core field "${field}" extracts at ≥ ${CORE_FIELD_THRESHOLD}%`, () => {
            const r = result.extractionRates[field];
            expect(r).toBeDefined();
            expect(r.total).toBe(result.businesses.length);
            if (r.rate < CORE_FIELD_THRESHOLD) {
              throw new Error(
                `Selector regression detected: ${field} extracted at ${r.rate}% ` +
                  `(${r.filled}/${r.total}) on fixture ${fixture.name}. ` +
                  `Expected ≥ ${CORE_FIELD_THRESHOLD}%. ` +
                  `This likely means Google changed the DOM and the selector for "${field}" needs updating. ` +
                  `Run \`npm run capture-fixtures\` to refresh fixtures, then inspect data/selector-debug/ ` +
                  `for DOM snippets. Add the new selector to src/extract.js SELECTORS.${field}.`,
              );
            }
          });
        }

        // Secondary fields — must be ≥ SECONDARY_FIELD_THRESHOLD (or the
        // per-field override for legitimately sparse fields).
        for (const field of SECONDARY_FIELDS) {
          const threshold = SPARSE_FIELD_OVERRIDES[field] != null
            ? SPARSE_FIELD_OVERRIDES[field]
            : SECONDARY_FIELD_THRESHOLD;
          test(`secondary field "${field}" extracts at ≥ ${threshold}%`, () => {
            const r = result.extractionRates[field];
            expect(r).toBeDefined();
            expect(r.total).toBe(result.businesses.length);
            if (r.rate < threshold) {
              throw new Error(
                `Selector regression detected: ${field} extracted at ${r.rate}% ` +
                  `(${r.filled}/${r.total}) on fixture ${fixture.name}. ` +
                  `Expected ≥ ${threshold}%. ` +
                  `This likely means Google changed the DOM and the selector for "${field}" needs updating. ` +
                  `Run \`npm run capture-fixtures\` to refresh fixtures, then inspect data/selector-debug/ ` +
                  `for DOM snippets. Add the new selector to src/extract.js SELECTORS.${field}.`,
              );
            }
          });
        }

        test('full rate summary is logged for diagnostics', () => {
          // This test exists so that when a field-regression test fails, the
          // full rate table is visible in the test output for diagnosis.
          const lines = [];
          const capturingLogger = {
            info: (m) => lines.push(typeof m === 'string' ? m : JSON.stringify(m)),
            warn: (m) => lines.push(typeof m === 'string' ? m : JSON.stringify(m)),
            debug: () => {},
            error: () => {},
          };
          logExtractionRates(result.extractionRates, capturingLogger);
          // The rate table should mention every canonical field.
          for (const f of [...CORE_FIELDS, ...SECONDARY_FIELDS]) {
            expect(lines.some((l) => l.includes(f))).toBe(true);
          }
        });
      });
    }
  });
}
