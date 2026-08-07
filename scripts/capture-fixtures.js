#!/usr/bin/env node
'use strict';

/**
 * scripts/capture-fixtures.js — Phase 2.0
 *
 * Captures DOM fixtures from live Google Maps for 3 fixed queries. The
 * fixtures are used by:
 *   - Phase 2.11 self-healing selector health checks (regression tests
 *     against a known-good DOM)
 *   - Phase 2.5 stealth verification (verify extraction still works after
 *     stealth patches are applied)
 *   - Phase 2.4 fingerprint randomization (verify no field breaks when
 *     the fingerprint changes)
 *
 * Output: tests/fixtures/{query}_{location}_{view}.html
 *   where view = "feed" (results list) or "detail" (one detail panel)
 *
 * Usage:
 *   node scripts/capture-fixtures.js                    # all 3 queries
 *   node scripts/capture-fixtures.js --query "Cafe" --location "Berlin"  # one
 *
 * This is a dev-only script — not imported by src/. Run from the repo root.
 * Fixtures are committed to the repo (they're the regression-test baseline).
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
// Reuse the real scraper's search logic — handles cookie consent, search-input
// fallback selectors, and feed detection. Avoids duplicating fragile selectors.
const { performSearch, getSearchInput } = require('../src/search');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures');

// Three fixed queries spanning different locales + business densities.
const DEFAULT_QUERIES = [
  { query: 'Cafe', location: 'Berlin' },
  { query: 'Plumber', location: 'Dhaka' },
  { query: 'Restaurant', location: 'Toronto' },
];

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

async function captureFeed(page, query, location) {
  console.log(`  Capturing feed HTML for "${query} in ${location}"...`);
  // Wait for the feed container to be present
  await page.waitForSelector('div[role="feed"]', { timeout: 30000 });
  // Give it a moment to populate
  await new Promise((r) => setTimeout(r, 2000));
  // Scroll once to load a few more cards
  await page.evaluate(() => {
    const feed = document.querySelector('div[role="feed"]');
    if (feed) feed.scrollTop = feed.scrollHeight;
  });
  await new Promise((r) => setTimeout(r, 1500));

  const html = await page.content();
  const name = `${sanitize(query)}_${sanitize(location)}_feed.html`;
  const outPath = path.join(FIXTURES_DIR, name);
  fs.writeFileSync(outPath, html);
  console.log(`    → ${path.relative(REPO_ROOT, outPath)} (${(html.length / 1024).toFixed(0)}KB)`);
  return { name, sizeBytes: html.length };
}

async function captureDetail(page, query, location) {
  console.log(`  Capturing detail HTML for "${query} in ${location}"...`);
  // Click the first place anchor to open the detail panel
  const anchor = await page.$('a[href*="/maps/place/"]').catch(() => null);
  if (!anchor) {
    console.log('    ⚠ no place anchor found — skipping detail capture');
    return null;
  }
  try {
    await anchor.click({ timeout: 8000 });
  } catch (err) {
    console.log(`    ⚠ click failed: ${err.message} — skipping detail capture`);
    return null;
  }
  // Wait for URL to change to /maps/place/ (the robust signal from Phase 1.11)
  try {
    await page.waitForFunction(
      () => window.location.pathname.includes('/maps/place/'),
      { timeout: 12000 },
    );
  } catch {
    console.log('    ⚠ URL did not change to /maps/place/ — skipping detail capture');
    return null;
  }
  // Give the detail panel a moment to fully render
  await new Promise((r) => setTimeout(r, 2500));

  const html = await page.content();
  const name = `${sanitize(query)}_${sanitize(location)}_detail.html`;
  const outPath = path.join(FIXTURES_DIR, name);
  fs.writeFileSync(outPath, html);
  console.log(`    → ${path.relative(REPO_ROOT, outPath)} (${(html.length / 1024).toFixed(0)}KB)`);
  return { name, sizeBytes: html.length };
}

async function captureOne(browser, { query, location }) {
  console.log(`\n=== Capturing fixtures: "${query} in ${location}" ===`);
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Minimal cfg + logger for performSearch (reuses the real search pipeline:
  // cookie-consent dismissal, search-input fallback selectors, feed detection).
  const cfg = {
    query,
    location,
    antiblock: {
      humanTyping: false, // instant fill — fixtures don't need human typing
      preEnterDelayMinMs: 300,
      preEnterDelayMaxMs: 600,
    },
  };
  const logger = {
    info: (msg, ctx) => console.log(`    [search] ${msg}`),
    debug: () => {},
    warn: (msg) => console.log(`    [search] WARN: ${msg}`),
    error: (msg) => console.log(`    [search] ERROR: ${msg}`),
    phase: () => ({
      info: (msg, ctx) => console.log(`    [search] ${msg}`),
      debug: () => {},
      warn: (msg) => console.log(`    [search] WARN: ${msg}`),
      error: (msg) => console.log(`    [search] ERROR: ${msg}`),
    }),
  };

  const results = { query, location, feed: null, detail: null, error: null };
  try {
    console.log(`  Running real search pipeline (performSearch)...`);
    await performSearch(page, cfg, logger);
    console.log(`  Feed detected.`);

    // Capture feed
    results.feed = await captureFeed(page, query, location);

    // Capture detail (opens first business)
    results.detail = await captureDetail(page, query, location);
  } catch (err) {
    results.error = err.message;
    console.error(`  ✗ Error: ${err.message}`);
  } finally {
    await context.close();
  }
  return results;
}

async function main() {
  // Parse CLI args for optional single query
  const argv = process.argv.slice(2);
  let queries = DEFAULT_QUERIES;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--query' || argv[i] === '-q') {
      const q = argv[++i];
      const l = argv[++i]; // expect --location next... actually just take next arg
      // Simpler: if --query and --location both given, use one query
      queries = [{ query: q, location: l || 'Toronto' }];
    } else if (argv[i] === '--location' || argv[i] === '-l') {
      // already consumed above
    }
  }

  if (!fs.existsSync(FIXTURES_DIR)) {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  }

  console.log(`Capturing DOM fixtures to ${path.relative(REPO_ROOT, FIXTURES_DIR)}/`);
  console.log(`Queries: ${queries.map((q) => `${q.query}/${q.location}`).join(', ')}`);

  const browser = await chromium.launch({ headless: true });
  const allResults = [];
  try {
    for (const q of queries) {
      const result = await captureOne(browser, q);
      allResults.push(result);
    }
  } finally {
    await browser.close();
  }

  // Write a manifest
  const manifest = {
    capturedAt: new Date().toISOString(),
    scraperVersion: require('../package.json').version,
    fixtures: allResults,
  };
  const manifestPath = path.join(FIXTURES_DIR, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest written to ${path.relative(REPO_ROOT, manifestPath)}`);

  // Summary
  const feedCount = allResults.filter((r) => r.feed).length;
  const detailCount = allResults.filter((r) => r.detail).length;
  const errorCount = allResults.filter((r) => r.error).length;
  console.log(`\n=== Summary ===`);
  console.log(`Feed fixtures:   ${feedCount}/${queries.length}`);
  console.log(`Detail fixtures: ${detailCount}/${queries.length}`);
  console.log(`Errors:          ${errorCount}/${queries.length}`);

  if (errorCount > 0) {
    console.log('\nErrors:');
    for (const r of allResults) {
      if (r.error) console.log(`  ${r.query}/${r.location}: ${r.error}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Fixture capture failed:', err);
  process.exit(1);
});
