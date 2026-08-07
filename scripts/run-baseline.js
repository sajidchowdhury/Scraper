#!/usr/bin/env node
'use strict';

/**
 * scripts/run-baseline.js — Phase 2.0
 *
 * Runs the documented Phase 1 baseline: a 100-result --deepScrape true run
 * against "Restaurant in Toronto". Captures:
 *   - wall-clock time
 *   - extraction rates per field (from summary.json)
 *   - deep-scrape success rate
 *   - memory usage at start vs. end
 *   - whether any CAPTCHA appeared (from log scan)
 *
 * Writes benchmarks/phase1-baseline.json.
 *
 * Usage:
 *   node scripts/run-baseline.js
 *
 * This is a dev-only script — not imported by src/. Run from the repo root.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const QUERY = 'Restaurant';
const LOCATION = 'Toronto';
const MAX_RESULTS = 100;
const DEEP_SCRAPE = false; // Phase 1 regression: backToListOnPage lands on about:blank after ~40 businesses. Documented in baseline JSON. List-view baseline is the primary Phase 2 comparison metric.
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'benchmarks');
const OUT_FILE = path.join(OUT_DIR, 'phase1-baseline.json');

function fmtBytes(n) {
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const memBefore = process.memoryUsage();
  const t0 = Date.now();

  console.log('=== Phase 1 Baseline Run ===');
  console.log(`Query: ${QUERY} in ${LOCATION}, maxResults=${MAX_RESULTS}, deepScrape=${DEEP_SCRAPE}`);
  console.log(`Memory before: heap=${fmtBytes(memBefore.heapUsed)} rss=${fmtBytes(memBefore.rss)}`);
  console.log('');

  // Run the scraper as a child process so its memory is isolated from ours.
  const args = [
    'src/index.js',
    '--query', QUERY,
    '--location', LOCATION,
    '--maxResults', String(MAX_RESULTS),
    '--yes', // skip the 1s banner delay (scripted)
  ];
  if (DEEP_SCRAPE) args.push('--deepScrape', 'true');

  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  const t1 = Date.now();
  try {
    exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (d) => {
        stdout += d.toString();
        process.stdout.write(d);
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        process.stderr.write(d);
      });
      child.on('close', resolve);
    });
  } catch (err) {
    console.error('Scraper run threw:', err);
    exitCode = 1;
  }
  const wallClockMs = Date.now() - t1;
  const memAfter = process.memoryUsage();

  console.log('');
  console.log(`Wall-clock: ${(wallClockMs / 1000).toFixed(1)}s, exit code: ${exitCode}`);
  console.log(`Memory after: heap=${fmtBytes(memAfter.heapUsed)} rss=${fmtBytes(memAfter.rss)}`);

  // Find the latest summary.json + log file for this query/location.
  const dataDir = path.join(REPO_ROOT, 'data');
  const files = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).filter((f) => f.startsWith(`${QUERY}_${LOCATION}`))
    : [];
  const summaryFile = files
    .filter((f) => f.endsWith('.summary.json'))
    .sort()
    .pop();
  const csvFile = files.filter((f) => f.endsWith('.csv')).sort().pop();
  const jsonFile = files.filter((f) => f.endsWith('.json') && !f.endsWith('.summary.json')).sort().pop();

  let summary = null;
  if (summaryFile) {
    try {
      summary = JSON.parse(fs.readFileSync(path.join(dataDir, summaryFile), 'utf8'));
    } catch (err) {
      console.error('Failed to parse summary:', err.message);
    }
  }

  // Find the log file (in logs/ not data/)
  const logsDir = path.join(REPO_ROOT, 'logs');
  const logFiles = fs.existsSync(logsDir)
    ? fs.readdirSync(logsDir).filter((f) => f.startsWith(`${QUERY}_${LOCATION}`))
    : [];
  const logFile = logFiles.sort().pop();
  let logContent = '';
  if (logFile) {
    try {
      logContent = fs.readFileSync(path.join(logsDir, logFile), 'utf8');
    } catch (err) {
      console.error('Failed to read log:', err.message);
    }
  }

  // Detect CAPTCHA from the log — match actual detection events, not config
  // mentions (the config line contains "captchaPause":true which would false-
  // positive on a naive /captcha/i regex).
  const captchaAppeared =
    /"msg":"Run aborted — CAPTCHA detected"/.test(logContent) ||
    /"msg":"Blocked HTTP response detected from Google"/.test(logContent) ||
    /"code":"CAPTCHA_DETECTED"/.test(logContent);

  // Compute deep-scrape success rate from the log
  let detailSuccessRate = null;
  let detailAttempted = null;
  let detailSucceeded = null;
  const detailMatch = logContent.match(/"detailAttempted":(\d+)/);
  const detailSuccMatch = logContent.match(/"detailSucceeded":(\d+)/);
  if (detailMatch) detailAttempted = parseInt(detailMatch[1], 10);
  if (detailSuccMatch) detailSucceeded = parseInt(detailSuccMatch[1], 10);
  if (detailAttempted && detailAttempted > 0) {
    detailSuccessRate = Math.round((detailSucceeded / detailAttempted) * 1000) / 10;
  }

  // Field extraction rates from summary — transform {field: {filled,total,rate,warn}}
  // into {field: rate} for compact comparison.
  let fieldRates = null;
  if (summary && summary.extractionRates) {
    fieldRates = {};
    for (const [field, info] of Object.entries(summary.extractionRates)) {
      fieldRates[field] = info.rate;
    }
  }

  // Row counts — summary uses `total`, scrollReason + loaded come from the log's
  // Run complete event.
  let scrollReason = null;
  let loadedCount = null;
  const runCompleteMatch = logContent.match(/"msg":"Run complete"[^}]*"extracted":(\d+)[^}]*"loaded":(\d+)[^}]*"scrollReason":"([^"]*)"/);
  if (runCompleteMatch) {
    loadedCount = parseInt(runCompleteMatch[2], 10);
    scrollReason = runCompleteMatch[3];
  }

  const baseline = {
    metadata: {
      recordedAt: new Date(t0).toISOString(),
      phase: 'phase1-baseline',
      purpose: 'Phase 2.0 baseline metrics for before/after comparison',
      command: `npm start -- --query "${QUERY}" --location "${LOCATION}" --maxResults ${MAX_RESULTS}${DEEP_SCRAPE ? ' --deepScrape true' : ''} --yes`,
      scraperVersion: require('../package.json').version,
      nodeVersion: process.version,
      platform: process.platform,
      deepScrapeEnabled: DEEP_SCRAPE,
    },
    wallClockMs,
    wallClockSeconds: Math.round(wallClockMs / 100) / 10,
    exitCode,
    memory: {
      before: {
        heapUsed: memBefore.heapUsed,
        heapUsedMb: Math.round(memBefore.heapUsed / 1024 / 102.4) / 10,
        rss: memBefore.rss,
        rssMb: Math.round(memBefore.rss / 1024 / 102.4) / 10,
      },
      after: {
        heapUsed: memAfter.heapUsed,
        heapUsedMb: Math.round(memAfter.heapUsed / 1024 / 102.4) / 10,
        rss: memAfter.rss,
        rssMb: Math.round(memAfter.rss / 1024 / 102.4) / 10,
      },
      note: 'before/after are the parent process (this script), not the scraper child. The child\'s peak memory is not directly observable; rss delta is a rough proxy. For precise child memory, run /usr/bin/time -v on the scraper directly.',
    },
    captchaAppeared,
    deepScrape: {
      attempted: detailAttempted,
      succeeded: detailSucceeded,
      successRatePct: detailSuccessRate,
    },
    extractionRates: fieldRates,
    rowCounts: {
      extracted: summary ? summary.total : null,
      loaded: loadedCount,
      sponsored: summary ? summary.sponsored : null,
      permanentlyClosed: summary ? summary.permanentlyClosed : null,
      temporarilyClosed: summary ? summary.temporarilyClosed : null,
      scrollReason,
    },
    timing: {
      startedAt: summary ? summary.startedAt : null,
      durationMs: summary ? summary.durationMs : null,
      durationSeconds: summary ? Math.round(summary.durationMs / 100) / 10 : null,
    },
    outputFiles: {
      csv: csvFile || null,
      json: jsonFile || null,
      summary: summaryFile || null,
      log: logFile || null,
    },
    testCountAtBaseline: {
      tests: 410,
      assertions: 1028,
      note: 'Frozen at Phase 1 milestone (v1.0.0-phase1) + post-tag hotfixes. Track net-new tests across Phase 2 against this number.',
    },
    knownIssues: {
      deepScrapeNavigationRegression: {
        description: 'backToListOnPage lands on about:blank after ~40 detail scrapes, causing all subsequent detail-panel opens to fail with "no anchor/card found in DOM". First observed during this baseline run (attempted with --deepScrape true, hit timeout at business 42).',
        rootCause: 'page.goBack() on Google Maps pushState SPA can over-navigate past the search page to the initial blank page. The in-Maps Back button click + 400ms sleep is insufficient — the feed has not restored when the next openDetailPanelOnPage runs.',
        workaround: 'Baseline run uses deepScrape=false. List-view metrics are the primary Phase 2 comparison target.',
        fixPlannedIn: 'Phase 2.7 (session rotation — fresh context per N requests resets navigation state) and/or a targeted fix to backToListOnPage (wait for feed container after back-nav, re-navigate to search URL if about:blank detected).',
        diagnosticValue: 'The warn-level diagnostics added in commit c7f7dc1 (Phase 1.11 hardening) revealed this issue clearly — beforeUrl:about:blank + triedSelectors logged on every failure. This validates the diagnostic investment.',
      },
    },
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(baseline, null, 2));
  console.log('');
  console.log(`=== Baseline written to ${path.relative(REPO_ROOT, OUT_FILE)} ===`);
  console.log(JSON.stringify({
    wallClockSeconds: baseline.wallClockSeconds,
    exitCode: baseline.exitCode,
    captchaAppeared: baseline.captchaAppeared,
    deepScrapeSuccessRate: baseline.deepScrape.successRatePct,
    extracted: baseline.rowCounts.extracted,
    testsAtBaseline: baseline.testCountAtBaseline.tests,
  }, null, 2));

  // Exit 0 even if the scraper failed non-fatally — we want the baseline JSON
  // written either way so we can compare. The exitCode is recorded in the JSON.
  process.exit(0);
}

main().catch((err) => {
  console.error('Baseline run failed:', err);
  process.exit(1);
});
