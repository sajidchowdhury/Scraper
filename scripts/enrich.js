'use strict';

/**
 * scripts/enrich.js — Phase 3.13 — Standalone enrichment runner (`npm run enrich`)
 *
 * Runs the Phase 3 enrichment pipeline (src/enrichment/pipeline.js → enrichBatch)
 * on a set of businesses WITHOUT a live Google Maps scrape. This is the
 * `npm run enrich` entry point promised by PHASE3_EXECUTION_PLAN.md §3.13.
 *
 * Two modes:
 *
 *   1. ENRICH MODE (default) — read businesses from --input <file.json>, run the
 *      full 11-phase enrichment pipeline, write enriched businesses to --output.
 *
 *        npm run enrich -- --input data/raw.json --output data/enriched.json \
 *          --profile web-agency --defaultCountry CA
 *
 *      Network phases are OPT-IN (off by default = fully offline, $0):
 *        --geocode on --geocoder google --geocodeApiKey $KEY
 *        --emailVerify on
 *        --techStackFetch on
 *
 *   2. GRID MODE (--grid on) — generate a grid of search points for whole-area
 *      coverage and write them to --output (no per-business enrichment). This is
 *      the Phase 3.11 search-strategy utility; the scraper's main loop consumes
 *      these points as individual search queries.
 *
 *        npm run enrich -- --grid on --gridBounds "43.65,-79.38,5km" \
 *          --gridStepKm 3 --query Restaurant --output data/grid-points.json
 *
 * Input format: a JSON file containing either an array of business objects or
 * an object `{ businesses: [...] }`. Each business uses the scraper's standard
 * SNAKE_CASE field names (place_id, name, address, phone, website, category,
 * rating, reviews_count, top_reviews, latitude, longitude, ...).
 *
 * Output format: a JSON file with the enriched business array plus a `_summary`
 * object reporting per-phase stats + costUsd.
 *
 * Exit codes: 0 success, 1 usage/runtime error, 2 partial failure (some
 * businesses failed enrichment but the run completed).
 */

const fs = require('fs');
const path = require('path');
const { enrichBatch } = require('../src/enrichment/pipeline');
const gridCoverage = require('../src/enrichment/grid-coverage');

// ---------------------------------------------------------------------------
// Minimal arg parser (the main scraper's config.js requires --query/--location,
// which an enrich-only run doesn't need, so we parse locally here).
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--input': out.input = argv[++i]; break;
      case '--output': out.output = argv[++i]; break;
      case '--profile': out.profile = argv[++i]; break;
      case '--defaultCountry': out.defaultCountry = argv[++i]; break;
      case '--geocode': out.geocode = argv[++i]; break;
      case '--geocoder': out.geocoder = argv[++i]; break;
      case '--geocodeApiKey': out.geocodeApiKey = argv[++i]; break;
      case '--geocodeBudget': out.geocodeBudget = parseFloat(argv[++i]); break;
      case '--emailVerify': out.emailVerify = argv[++i]; break;
      case '--techStackFetch': out.techStackFetch = argv[++i]; break;
      case '--budget': out.budget = parseFloat(argv[++i]); break;
      case '--grid': out.grid = argv[++i]; break;
      case '--gridBounds': out.gridBounds = argv[++i]; break;
      case '--gridStepKm': out.gridStepKm = parseFloat(argv[++i]); break;
      case '--query': case '-q': out.query = argv[++i]; break;
      case '--help': case '-h': out.help = true; break;
      default:
        if (a.startsWith('--')) {
          // Unknown flag — ignore but don't crash (forward-compat).
        }
    }
  }
  return out;
}

const HELP = `gmaps-scraper enrich — Phase 3 enrichment runner

Usage:
  npm run enrich -- --input <file.json> --output <file.json> [options]
  npm run enrich -- --grid on --gridBounds "<lat,lng,radiusKm>" --output <file.json>

Enrich mode (default):
  --input <file.json>          Businesses to enrich (JSON array or {businesses:[]}).
  --output <file.json>         Enriched output path.
  --profile <name>             Lead-scoring profile: web-agency (default) |
                               reputation-mgmt | seo-agency | default.
  --defaultCountry <CC>        ISO 2-letter phone-region hint (e.g. CA, US, GB).
  --geocode on                 Enable address geocoding (default off = $0).
  --geocoder <provider>        google | nominatim | mock (default nominatim).
  --geocodeApiKey <key>        Google Geocoding API key (env: GEOCODING_API_KEY).
  --geocodeBudget <usd>        USD cap on geocoding (0 = unlimited).
  --emailVerify on             Enable SMTP mailbox verification (default off).
  --techStackFetch on          Enable website HTTP fetching (default off).
  --budget <usd>               Overall enrichment USD cap.

Grid mode (--grid on):
  --gridBounds "<lat,lng,radiusKm>"   Center + radius, e.g. "43.65,-79.38,5km".
  --gridStepKm <km>                   Grid spacing (default: derived from area).
  --query <term>                      Search term to label each grid point.
  --output <file.json>                Grid points output path.

All network phases are OPT-IN. With none enabled, the run is fully offline
(phone/address-parse/dedup/chain/spam/email-discovery/sentiment/geo/lead/
confidence) and costs $0.
`;

function onOff(v) {
  return /^(on|true|1|yes)$/i.test(String(v));
}

// ---------------------------------------------------------------------------
// Grid mode
// ---------------------------------------------------------------------------

function parseGridBounds(raw) {
  // "lat,lng,radiusKm" or "lat,lng,radius" (km assumed)
  const m = String(raw).match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\s*km?$/i);
  if (!m) return null;
  return {
    center: { lat: parseFloat(m[1]), lng: parseFloat(m[2]) },
    radiusKm: parseFloat(m[3]),
  };
}

function runGridMode(args) {
  if (!args.gridBounds) {
    console.error('Error: --grid on requires --gridBounds "<lat,lng,radiusKm>"');
    process.exit(1);
  }
  const parsed = parseGridBounds(args.gridBounds);
  if (!parsed) {
    console.error(`Error: could not parse --gridBounds "${args.gridBounds}" (expected "lat,lng,radiusKm")`);
    process.exit(1);
  }
  const region = { type: 'center', center: parsed.center, radiusKm: parsed.radiusKm };
  const opts = { query: args.query || '' };
  if (Number.isFinite(args.gridStepKm) && args.gridStepKm > 0) opts.stepKm = args.gridStepKm;

  const points = gridCoverage.gridSearchPoints(region, opts);
  const coverage = gridCoverage.estimateCoverage(points);
  const out = {
    mode: 'grid',
    region: { type: 'center', center: parsed.center, radiusKm: parsed.radiusKm, stepKm: opts.stepKm || 'derived' },
    query: opts.query,
    pointCount: points.length,
    coverageRatio: coverage.coverageRatio,
    estimatedListings: coverage.estimatedListings,
    points,
  };

  const outPath = args.output || 'grid-points.json';
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`[grid] Generated ${points.length} search points (coverage ratio ${coverage.coverageRatio?.toFixed(3) ?? 'n/a'}).`);
  console.log(`[grid] Wrote ${outPath}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Enrich mode
// ---------------------------------------------------------------------------

function loadBusinesses(inputPath) {
  if (!inputPath) {
    console.error('Error: --input <file.json> is required in enrich mode');
    process.exit(1);
  }
  const abs = path.resolve(inputPath);
  if (!fs.existsSync(abs)) {
    console.error(`Error: input file not found: ${abs}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    console.error(`Error: could not parse input JSON: ${e.message}`);
    process.exit(1);
  }
  const businesses = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.businesses) ? parsed.businesses : null);
  if (!businesses) {
    console.error('Error: input JSON must be an array of businesses or { businesses: [...] }');
    process.exit(1);
  }
  return businesses;
}

async function runEnrichMode(args) {
  const businesses = loadBusinesses(args.input);
  console.log(`[enrich] Loaded ${businesses.length} businesses from ${path.resolve(args.input)}`);

  const opts = {
    defaultCountry: args.defaultCountry || null,
    leadProfile: args.profile || 'web-agency',
    geocode: onOff(args.geocode),
    geocoder: args.geocoder || (args.geocodeApiKey ? 'google' : 'nominatim'),
    geocodeApiKey: args.geocodeApiKey || process.env.GEOCODING_API_KEY || null,
    emailVerify: onOff(args.emailVerify),
    techStackFetch: onOff(args.techStackFetch),
  };
  if (Number.isFinite(args.geocodeBudget)) opts.geocodeBudget = args.geocodeBudget;

  const t0 = Date.now();
  const summary = await enrichBatch(businesses, opts);
  const dt = ((Date.now() - t0) / 1000).toFixed(2);

  const outPath = args.output || 'enriched.json';
  const out = {
    _summary: {
      ...summary,
      durationSec: parseFloat(dt),
      leadProfile: opts.leadProfile,
      defaultCountry: opts.defaultCountry,
      geocode: opts.geocode,
      emailVerify: opts.emailVerify,
      techStackFetch: opts.techStackFetch,
      inputCount: businesses.length,
    },
    businesses,
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  // Console summary.
  console.log(`[enrich] Done in ${dt}s — enriched ${summary.enriched}, skipped ${summary.skipped}, failed ${summary.failed}, cost $${summary.costUsd.toFixed(4)}`);
  const lead = summary.phases.lead || {};
  if (lead && typeof lead.avgScore === 'number') {
    console.log(`[enrich] Lead scores: avg ${lead.avgScore}, priority ${lead.priorityLeads}, disqualified ${lead.disqualifiedLeads}, spam-capped ${lead.spamCapped}`);
  }
  const conf = summary.phases.confidence || {};
  if (conf && typeof conf.avgConfidence === 'number') {
    console.log(`[enrich] Confidence: avg ${conf.avgConfidence}, low-confidence ${conf.lowConfidenceListings}, avg signal coverage ${conf.avgSignalCoverage}`);
  }
  console.log(`[enrich] Wrote ${outPath}`);

  if (summary.failed > 0) process.exit(2);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || process.argv.length <= 2) {
    console.log(HELP);
    process.exit(0);
  }
  if (onOff(args.grid)) {
    runGridMode(args);
    return;
  }
  await runEnrichMode(args);
}

main().catch((err) => {
  console.error(`[enrich] Fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
