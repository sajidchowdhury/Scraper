#!/usr/bin/env node
'use strict';

/**
 * scripts/phase3-baseline.js — Phase 3.0 — Enrichment-Readiness Baseline
 *
 * Computes the 5 Phase 2 baseline metrics that Phase 3 enrichment will improve
 * against, so before/after comparison is possible:
 *
 *   1. Phone format diversity  — distinct raw phone formats before E.164
 *                                normalization (Phase 3.1 collapses these).
 *   2. Address completeness    — % with full vs. partial addresses (Phase 3.2
 *                                parses + verifies).
 *   3. Duplicate rate          — estimated same-business-listed-twice count
 *                                (Phase 3.3 dedup removes these).
 *   4. Email availability      — % with a website (potential email surface;
 *                                Phase 3.5 discovers + verifies emails).
 *   5. Website liveness        — % of websites returning HTTP 200 (Phase 3.6
 *                                checks + flags dead/redirected).
 *
 * Input: a scraper JSON export (array of business objects with name/phone/
 *        address/website fields — the standard output the Phase 1/2 pipeline
 *        writes to data/*.json).
 *
 * Usage:
 *   node scripts/phase3-baseline.js data/Restaurant_Toronto_2026-*.json
 *   node scripts/phase3-baseline.js                     # scans data/*.json
 *   node scripts/phase3-baseline.js --out benchmarks/phase2-baseline.json
 *
 * This is a dev-only script — not imported by src/. Run from the repo root.
 * The website-liveness metric (metric 5) issues real HTTP HEAD requests; pass
 * --skipLiveness to skip network probes (the metric reports null instead).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT = path.join(REPO_ROOT, 'benchmarks', 'phase2-baseline.json');
const DEFAULT_DATA_DIR = path.join(REPO_ROOT, 'data');

// ---------------------------------------------------------------------------
// CLI parsing (tiny — matches src/config.js hand-rolled style)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { files: [], out: DEFAULT_OUT, skipLiveness: false, timeoutMs: 5000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--skipLiveness') out.skipLiveness = true;
    else if (a === '--timeoutMs') out.timeoutMs = Number(argv[++i]) || 5000;
    else if (!a.startsWith('--')) out.files.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metric 1 — Phone format diversity
// ---------------------------------------------------------------------------
// Classify a raw phone string into a coarse "format signature" so we can count
// how many DISTINCT formats exist before E.164 normalization collapses them.
// This is a heuristic shape classifier, NOT a parser (Phase 3.1 does the real
// parsing with libphonenumber-js).
function phoneFormatSignature(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  // Signature: replace digits with '9', keep separators/letters as-is.
  // "+1 (416) 555-0100" → "+9 (999) 999-9999"
  // "4165550100"        → "9999999999"
  // This reveals how many distinct display formats coexist.
  return s.replace(/\d/g, '9');
}

function computePhoneDiversity(businesses) {
  const phones = businesses
    .map((b) => b && b.phone)
    .filter((p) => p && String(p).trim());
  const signatures = new Set(phones.map(phoneFormatSignature));
  const total = businesses.length;
  return {
    metric: 'phoneFormatDiversity',
    definition: 'Distinct raw phone display formats before E.164 normalization',
    businessesWithPhone: phones.length,
    businessesWithPhonePct: total ? round((phones.length / total) * 100, 1) : 0,
    distinctFormats: signatures.size,
    sampleFormats: Array.from(signatures).slice(0, 10),
    target: 'Phase 3.1 collapses all formats to a single E.164 representation',
  };
}

// ---------------------------------------------------------------------------
// Metric 2 — Address completeness
// ---------------------------------------------------------------------------
// A "full" address has at least a street + city + region/postal (heuristic).
// "Partial" has only some components. Phase 3.2 parses + verifies both.
function addressCompleteness(raw) {
  if (!raw || typeof raw !== 'string') return { has: false, full: false, parts: 0 };
  const s = raw.trim();
  if (!s) return { has: false, full: false, parts: 0 };
  // Count comma-separated components + a postal-code regex as a proxy for
  // completeness. A full address typically has 3+ components.
  const commaParts = s.split(',').map((p) => p.trim()).filter(Boolean);
  const hasPostal = /\b[A-Z0-9]{3,10}\s*[A-Z0-9]{0,6}\b/i.test(s);
  const hasStreetNumber = /\b\d+\s+[A-Z]/i.test(s);
  const parts = commaParts.length + (hasPostal ? 1 : 0) + (hasStreetNumber ? 1 : 0);
  return { has: true, full: parts >= 3, parts };
}

function computeAddressCompleteness(businesses) {
  const total = businesses.length;
  const assessed = businesses.map((b) => addressCompleteness(b && b.address));
  const withAddress = assessed.filter((a) => a.has).length;
  const full = assessed.filter((a) => a.has && a.full).length;
  const partial = withAddress - full;
  return {
    metric: 'addressCompleteness',
    definition: '% of businesses with a full (3+ component) vs. partial address',
    businessesWithAddress: withAddress,
    businessesWithAddressPct: total ? round((withAddress / total) * 100, 1) : 0,
    fullAddresses: full,
    fullAddressesPct: total ? round((full / total) * 100, 1) : 0,
    partialAddresses: partial,
    partialAddressesPct: total ? round((partial / total) * 100, 1) : 0,
    target: 'Phase 3.2 parses every address into structured street/city/state/postal/country',
  };
}

// ---------------------------------------------------------------------------
// Metric 3 — Duplicate rate (estimated)
// ---------------------------------------------------------------------------
// Estimate same-business-listed-twice via a normalized-name + phone match.
// This is a conservative estimate (Phase 3.3 will use fuzzy matching). A
// duplicate is flagged when two businesses share the same normalized name AND
// the same phone (or same normalized name + same address prefix).
function normalizeName(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(inc|llc|ltd|co|the)$/g, '');
}

function estimateDuplicateRate(businesses) {
  const total = businesses.length;
  const seen = new Map();
  let duplicates = 0;
  const dupPairs = [];
  for (const b of businesses) {
    const key = `${normalizeName(b && b.name)}|${(b && b.phone) || ''}`.trim();
    if (!key || key === '|') continue;
    if (seen.has(key)) {
      duplicates++;
      if (dupPairs.length < 10) dupPairs.push({ name: b && b.name, phone: b && b.phone });
    } else {
      seen.set(key, true);
    }
  }
  return {
    metric: 'duplicateRate',
    definition: 'Estimated same-business-listed-twice count (exact name+phone match)',
    duplicateCount: duplicates,
    duplicateRatePct: total ? round((duplicates / total) * 100, 1) : 0,
    sampleDuplicates: dupPairs,
    target: 'Phase 3.3 uses fuzzy matching (fuse.js) to catch near-duplicates',
  };
}

// ---------------------------------------------------------------------------
// Metric 4 — Email availability (website → potential email surface)
// ---------------------------------------------------------------------------
function computeEmailAvailability(businesses) {
  const total = businesses.length;
  const withWebsite = businesses.filter((b) => b && b.website && /^https?:\/\//i.test(b.website));
  return {
    metric: 'emailAvailability',
    definition: '% of businesses with a website (potential email discovery surface)',
    businessesWithWebsite: withWebsite.length,
    businessesWithWebsitePct: total ? round((withWebsite.length / total) * 100, 1) : 0,
    target: 'Phase 3.5 discovers + SMTP-verifies emails from these domains',
  };
}

// ---------------------------------------------------------------------------
// Metric 5 — Website liveness (HTTP HEAD)
// ---------------------------------------------------------------------------
function headRequest(url, timeoutMs) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(
      url,
      { method: 'HEAD', timeout: timeoutMs, headers: { 'User-Agent': 'gmaps-scraper/phase3-baseline' } },
      (res) => {
        resolve({ statusCode: res.statusCode || 0, redirected: [301, 302, 303, 307, 308].includes(res.statusCode || 0) });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ statusCode: 0, error: 'timeout' });
    });
    req.on('error', (err) => resolve({ statusCode: 0, error: err.code || err.message }));
    req.end();
  });
}

async function computeWebsiteLiveness(businesses, { skipLiveness, timeoutMs }) {
  const withWebsite = businesses.filter((b) => b && b.website && /^https?:\/\//i.test(b.website));
  const total = withWebsite.length;
  if (skipLiveness) {
    return {
      metric: 'websiteLiveness',
      definition: '% of websites returning HTTP 200 (skipped — no network probe)',
      websitesChecked: 0,
      liveCount: null,
      livePct: null,
      skipped: true,
      target: 'Phase 3.6 checks every website + flags dead/redirected',
    };
  }
  let live = 0;
  let redirected = 0;
  let dead = 0;
  const sample = [];
  // Probe sequentially with a short timeout (baseline, not production).
  for (const b of withWebsite.slice(0, 200)) {
    const r = await headRequest(b.website, timeoutMs);
    if (r.statusCode >= 200 && r.statusCode < 300) live++;
    else if (r.redirected) redirected++;
    else dead++;
    if (sample.length < 10 && r.statusCode !== 200)
      sample.push({ website: b.website, statusCode: r.statusCode, error: r.error });
  }
  const checked = Math.min(total, 200);
  return {
    metric: 'websiteLiveness',
    definition: '% of websites returning HTTP 2xx (live)',
    websitesChecked: checked,
    liveCount: live,
    livePct: checked ? round((live / checked) * 100, 1) : 0,
    redirectedCount: redirected,
    deadCount: dead,
    sampleNon200: sample,
    target: 'Phase 3.6 records website_status_code + website_liveness per business',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function round(n, dp) {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

function loadBusinesses(files) {
  let resolved = files;
  if (resolved.length === 0) {
    // Default: scan data/*.json (skip *.summary.json + *.baseline.json).
    if (fs.existsSync(DEFAULT_DATA_DIR)) {
      resolved = fs
        .readdirSync(DEFAULT_DATA_DIR)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.summary.json') && !f.endsWith('.baseline.json'))
        .map((f) => path.join(DEFAULT_DATA_DIR, f));
    }
  }
  if (resolved.length === 0) {
    process.stderr.write(
      'phase3-baseline: no input. Pass a scraper JSON export:\n' +
        '  node scripts/phase3-baseline.js data/Restaurant_Toronto_*.json\n',
    );
    process.exit(2);
  }
  let businesses = [];
  const sources = [];
  for (const f of resolved) {
    const raw = fs.readFileSync(f, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.businesses) ? parsed.businesses : [];
    businesses = businesses.concat(arr);
    sources.push({ file: path.basename(f), count: arr.length });
  }
  return { businesses, sources };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { businesses, sources } = loadBusinesses(args.files);

  const phone = computePhoneDiversity(businesses);
  const address = computeAddressCompleteness(businesses);
  const duplicates = estimateDuplicateRate(businesses);
  const email = computeEmailAvailability(businesses);
  const liveness = await computeWebsiteLiveness(businesses, {
    skipLiveness: args.skipLiveness,
    timeoutMs: args.timeoutMs,
  });

  const baseline = {
    metadata: {
      recordedAt: new Date().toISOString(),
      phase: 'phase2-baseline',
      purpose: 'Phase 3 enrichment-readiness baseline (before/after comparison)',
      scraperVersion: '2.0.0-phase2',
      nodeVersion: process.version,
      platform: process.platform,
      sampleSize: businesses.length,
      sources,
      reRunCommand:
        'node scripts/phase3-baseline.js data/<scrape-output>.json --out benchmarks/phase2-baseline.json',
      note:
        'Re-run after each Phase 2 scrape to refresh the baseline. ' +
        'Phase 3 sub-phases (3.1–3.10) should improve every metric below.',
    },
    metrics: {
      phoneFormatDiversity: phone,
      addressCompleteness: address,
      duplicateRate: duplicates,
      emailAvailability: email,
      websiteLiveness: liveness,
    },
    testCountAtBaseline: {
      tests: 1464,
      assertions: 8500,
      note: 'Frozen at Phase 2 milestone (v2.0.0-phase2). Track net-new tests across Phase 3 against this number.',
    },
  };

  const outDir = path.dirname(args.out);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(baseline, null, 2) + '\n');
  process.stdout.write(`phase3-baseline — wrote ${path.relative(REPO_ROOT, args.out)}\n`);
  process.stdout.write(
    `  sample: ${businesses.length} businesses from ${sources.length} file(s)\n` +
      `  phone formats: ${phone.distinctFormats} distinct\n` +
      `  address full: ${address.fullAddressesPct}%\n` +
      `  duplicates: ${duplicates.duplicateRatePct}%\n` +
      `  email surface: ${email.businessesWithWebsitePct}% have a website\n` +
      `  website live: ${liveness.livePct === null ? 'skipped' : liveness.livePct + '%'}\n`,
  );
}

main().catch((err) => {
  process.stderr.write('phase3-baseline — error: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(3);
});
