#!/usr/bin/env node
'use strict';

/**
 * scripts/verify-stealth.js — Phase 2.5 (dev-only stealth verification)
 *
 * Launches a real Chromium browser with the Phase 2.5 stealth patches applied,
 * navigates to a bot-detection page (https://bot.sannysoft.com by default),
 * screenshots the results, extracts the detection score, and saves everything
 * to benchmarks/stealth-score.json.
 *
 * Usage:
 *   node scripts/verify-stealth.js                       # default: bot.sannysoft.com
 *   node scripts/verify-stealth.js --url <detection-url> # custom detection page
 *   node scripts/verify-stealth.js --noStealth           # A/B: disable stealth for comparison
 *   node scripts/verify-stealth.js --headed              # show the browser
 *
 * Output:
 *   - benchmarks/stealth-score.json  (detection predicates + pass/fail count)
 *   - benchmarks/stealth-screenshot.png  (full-page screenshot of the results)
 *
 * This script is dev-only — it's not part of the test suite and requires a
 * real browser + network access. Run it manually before/after Phase 2.5
 * changes to verify the stealth patches are still effective.
 *
 * Acceptance criteria (from PHASE2_EXECUTION_PLAN.md §2.5):
 *   - navigator.webdriver === undefined
 *   - window.chrome?.runtime is an object (not undefined)
 *   - navigator.plugins.length > 0
 *   - All detection predicates pass (no red indicators on bot.sannysoft.com)
 */

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { url: 'https://bot.sannysoft.com', headed: false, stealth: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--headed') out.headed = true;
    else if (a === '--noStealth') out.stealth = false;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/verify-stealth.js [--url <url>] [--headed] [--noStealth]');
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve the chromium launcher (playwright-extra + stealth when enabled).
  const { buildStealthLaunchArgs, applyStealthPatches, STEALTH_PATCHES } = require('../src/stealth-patches');
  let chromium;
  if (args.stealth) {
    const { chromium: extraChromium } = require('playwright-extra');
    const stealth = require('puppeteer-extra-plugin-stealth');
    extraChromium.use(stealth());
    chromium = extraChromium;
  } else {
    chromium = require('playwright').chromium;
  }

  console.log(`Launching browser (stealth: ${args.stealth ? 'ON' : 'OFF'})...`);
  const launchOpts = {
    headless: !args.headed,
    args: args.stealth ? buildStealthLaunchArgs({}) : [],
  };
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  // Apply the custom stealth patches (10 bot-detection surfaces).
  if (args.stealth) {
    await applyStealthPatches(context, { debug: true });
    console.log(`Applied ${STEALTH_PATCHES.length} custom stealth patches`);
  }

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  console.log(`Navigating to ${args.url}...`);
  await page.goto(args.url, { waitUntil: 'networkidle' });

  // Give the detection page a moment to run its JS.
  await page.waitForTimeout(3000);

  // Extract the detection predicates. These are the standard bot-detection
  // checks that bot.sannysoft.com and similar pages run.
  const predicates = await page.evaluate(() => {
    const results = {};
    // The 4 acceptance criteria from PHASE2_EXECUTION_PLAN.md §2.5:
    results.webdriver = navigator.webdriver;
    results.chromeRuntime = typeof (window.chrome && window.chrome.runtime);
    results.pluginsLength = navigator.plugins ? navigator.plugins.length : 0;
    results.permissions = typeof navigator.permissions;
    results.languages = navigator.languages;
    results.vendor = navigator.vendor;
    results.outerWidth = window.outerWidth;
    results.outerHeight = window.outerHeight;
    results.maxTouchPoints = navigator.maxTouchPoints;
    results.notificationPermission = typeof Notification !== 'undefined' ? Notification.permission : 'undefined';
    // Additional tells:
    results.userAgent = navigator.userAgent.slice(0, 80);
    results.platform = navigator.platform;
    results.hardwareConcurrency = navigator.hardwareConcurrency;
    results.deviceMemory = navigator.deviceMemory;
    results.webglVendor = (function () {
      try {
        var c = document.createElement('canvas');
        var gl = c.getContext('webgl') || c.getContext('webgl2');
        if (!gl) return 'no-webgl';
        var dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
        return dbgInfo ? gl.getParameter(dbgInfo.UNMASKED_VENDOR_WEBGL) : 'no-debug-info';
      } catch (e) { return 'error: ' + e.message; }
    })();
    results.webglRenderer = (function () {
      try {
        var c = document.createElement('canvas');
        var gl = c.getContext('webgl') || c.getContext('webgl2');
        if (!gl) return 'no-webgl';
        var dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
        return dbgInfo ? gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) : 'no-debug-info';
      } catch (e) { return 'error: ' + e.message; }
    })();
    return results;
  });

  // Score the predicates against the acceptance criteria.
  const score = {
    passed: 0,
    failed: 0,
    checks: [],
  };
  function check(name, condition, actual, expected) {
    if (condition) score.passed++;
    else score.failed++;
    score.checks.push({ name, passed: !!condition, actual, expected });
  }
  check('navigator.webdriver is undefined', predicates.webdriver === undefined, predicates.webdriver, 'undefined');
  check('window.chrome.runtime is an object', predicates.chromeRuntime === 'object', predicates.chromeRuntime, 'object');
  check('navigator.plugins.length > 0', predicates.pluginsLength > 0, predicates.pluginsLength, '> 0');
  check('navigator.vendor is "Google Inc."', predicates.vendor === 'Google Inc.', predicates.vendor, 'Google Inc.');
  check('window.outerWidth > 0', predicates.outerWidth > 0, predicates.outerWidth, '> 0');
  check('window.outerHeight > 0', predicates.outerHeight > 0, predicates.outerHeight, '> 0');
  check('navigator.maxTouchPoints === 0', predicates.maxTouchPoints === 0, predicates.maxTouchPoints, 0);
  check('Notification.permission is "default"', predicates.notificationPermission === 'default', predicates.notificationPermission, 'default');
  check('navigator.languages has 2+ entries', predicates.languages && predicates.languages.length >= 2, predicates.languages, '>= 2 entries');
  check('WebGL vendor is set', predicates.webglVendor && predicates.webglVendor !== 'no-webgl' && predicates.webglVendor !== 'no-debug-info', predicates.webglVendor, 'a real vendor string');

  // Screenshot.
  const screenshotPath = path.join(process.cwd(), 'benchmarks', 'stealth-screenshot.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`Screenshot saved: ${screenshotPath}`);

  // Build the output.
  const output = {
    timestamp: new Date().toISOString(),
    url: args.url,
    stealthEnabled: args.stealth,
    patchCount: args.stealth ? STEALTH_PATCHES.length : 0,
    score: { passed: score.passed, failed: score.failed, total: score.passed + score.failed },
    checks: score.checks,
    predicates,
    userAgent: predicates.userAgent,
  };

  // Save to benchmarks/stealth-score.json.
  const benchmarksDir = path.join(process.cwd(), 'benchmarks');
  if (!fs.existsSync(benchmarksDir)) fs.mkdirSync(benchmarksDir, { recursive: true });
  const scorePath = path.join(benchmarksDir, 'stealth-score.json');
  fs.writeFileSync(scorePath, JSON.stringify(output, null, 2));
  console.log(`Score saved: ${scorePath}`);

  // Print a summary.
  console.log('\n=== Stealth Verification Results ===');
  console.log(`Stealth: ${args.stealth ? 'ON' : 'OFF'} (${args.stealth ? STEALTH_PATCHES.length + ' patches' : 'no patches'})`);
  console.log(`Score: ${score.passed}/${score.passed + score.failed} checks passed`);
  console.log('');
  for (const c of score.checks) {
    const icon = c.passed ? '✓' : '✗';
    console.log(`  ${icon} ${c.name}`);
    if (!c.passed) {
      console.log(`      expected: ${c.expected}`);
      console.log(`      actual:   ${c.actual}`);
    }
  }
  console.log('');

  await browser.close();

  // Exit code: 0 if all passed, 1 if any failed.
  process.exit(score.failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-stealth.js failed:', err.message);
  console.error(err.stack);
  process.exit(2);
});
