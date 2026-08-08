'use strict';

/**
 * src/enrichment/pipeline.js — Phase 3.12 — Enrichment Pipeline Orchestration
 *
 * Chains every Phase 3 enrichment sub-phase into a single batch run:
 *
 *   3.1  phone          → normalizePhonesBatch      (always on)
 *   3.2  address        → parseAddress + geocodeBatch (geocode opt-in)
 *   3.3  dedup          → findDuplicates             (always on)
 *   3.4  chain/spam     → detectChainBatch + detectSpamBatch (always on)
 *   3.5  email          → enrichEmailsBatch          (discover always; verify opt-in)
 *   3.6  tech-stack     → detectTechStackBatch       (opt-in — makes HTTP requests)
 *   3.7  sentiment      → analyzeReviewsBatch        (always on)
 *   3.8  geo-metrics    → computeGeoMetricsBatch     (always on)
 *   3.9  lead-score     → scoreLeadsBatch            (always on)
 *   3.10 confidence     → computeConfidenceBatch     (always on)
 *
 * Phase 3.11 (grid-coverage) is NOT part of the per-business enrichment
 * pipeline — it's a search-strategy utility (generates the grid of search
 * points the scraper queries to achieve full geographic coverage). It's
 * invoked separately by the main scrape loop, not here.
 *
 * DESIGN RULES
 *   - Each phase is wrapped in try/catch so one failure doesn't abort the
 *     whole run. A failed phase logs + contributes empty results; downstream
 *     phases degrade gracefully (they're written to treat missing descriptors
 *     as neutral).
 *   - Network phases (geocode, email verify, tech-stack fetch) are OPT-IN via
 *     opts flags. Default run is fully offline (discovery only, no HTTP/DNS/SMTP).
 *   - The batch is mutated IN PLACE: each business gets enrichment columns +
 *     debug descriptors attached. The caller persists the ENRICHMENT_COLUMNS
 *     to PostgreSQL; debug descriptors (phone_normalized, chain_result,
 *     spam_result, etc.) are NOT persisted (they feed downstream phases only).
 *   - Returns a run summary with per-phase stats + the full ENRICHMENT_COLUMNS
 *     list for the caller's UPDATE statements.
 *
 * PUBLIC API
 *   enrichBusiness(business, opts)   → enriched business (single-record convenience)
 *   enrichBatch(businesses, opts)    → { enriched, skipped, failed, costUsd, phases }
 *   ENRICHMENT_COLUMNS               → []  (aggregated by index.js barrel)
 */

const __version = 1;

const ENRICHMENT_COLUMNS = [];

const phone = require('./phone');
const address = require('./address');
const dedup = require('./dedup');
const chainDetection = require('./chain-detection');
const email = require('./email');
const techStack = require('./tech-stack');
const sentiment = require('./sentiment');
const geoMetrics = require('./geo-metrics');
const leadScore = require('./lead-score');
const confidence = require('./confidence');

/**
 * Build a dedup_result descriptor for each business from the dedup clusters.
 * Downstream phases (lead-score 3.9, confidence 3.10) read dedup_result to
 * penalize non-unique listings.
 *
 * @param {object[]} businesses
 * @param {{ clusters: object[], pairs: object[] }} dedupOut
 */
function attachDedupResults(businesses, dedupOut) {
  if (!dedupOut || !dedupOut.clusters) return;
  const byPlaceId = new Map();
  for (const b of businesses) {
    const id = b && (b.place_id || String(b.id || ''));
    if (id) byPlaceId.set(id, b);
  }
  for (const cluster of dedupOut.clusters) {
    const members = cluster.members || [];
    const canonicalId = cluster.canonical ? cluster.canonical.place_id : (members[0] && members[0].place_id);
    const memberIds = members.map((m) => m.place_id || String(m.id || ''));
    for (const m of members) {
      const id = m.place_id || String(m.id || '');
      const b = byPlaceId.get(id);
      if (!b) continue;
      b.dedup_result = {
        clusterId: cluster.id || `cluster-${memberIds[0] || 'x'}`,
        isPrimary: id === canonicalId,
        duplicateOf: id === canonicalId ? undefined : canonicalId,
        duplicates: memberIds.filter((x) => x !== id).map((x) => ({ id: x, similarity: cluster.maxScore || 0 })),
        maxSimilarity: cluster.maxScore || 0,
      };
    }
  }
  // Businesses not in any cluster get a clean dedup_result.
  for (const b of businesses) {
    if (!b.dedup_result) {
      b.dedup_result = { clusterId: null, isPrimary: true, duplicates: [], maxSimilarity: 0 };
    }
  }
}

/**
 * Run a single enrichment phase with error isolation.
 *
 * @param {string} name — phase name for logging.
 * @param {Function} fn — phase runner (() => stats).
 * @param {object} [logger]
 * @returns {*} whatever fn returns, or { error } on failure.
 */
function runPhase(name, fn, logger) {
  try {
    const t0 = Date.now();
    const result = fn();
    const dt = Date.now() - t0;
    if (logger && typeof logger.info === 'function') {
      logger.info(`[enrichment] ${name} done in ${dt}ms`);
    }
    return result;
  } catch (err) {
    if (logger && typeof logger.error === 'function') {
      logger.error(`[enrichment] ${name} FAILED: ${err.message}`);
    }
    return { error: err.message, phase: name };
  }
}

/**
 * Enrich a batch of businesses through all enabled sub-phases.
 *
 * @param {object[]} businesses — mutated in place.
 * @param {object} [opts]
 *   - {object} logger — bunyan/console-style logger.
 *   - {string} defaultCountry — ISO 2-letter phone-region hint (e.g. 'US').
 *   - {string} leadProfile — scoring profile ('web-agency'|'reputation-mgmt'|'seo-agency'|'default').
 *   - {boolean} geocode — enable address geocoding (network — default false).
 *   - {string} geocoder — geocoder provider ('google'|'nominatim'|'mock').
 *   - {string} geocodeApiKey — API key for the geocoder.
 *   - {boolean} emailVerify — enable SMTP mailbox verification (network — default false).
 *   - {boolean} techStackFetch — enable website HTTP fetching (network — default false).
 *   - {number} techStackConcurrency — website fetch concurrency (default 3).
 *   - {number} emailConcurrency — email verify concurrency (default 3).
 *   - {number} techStackTimeout — website fetch timeout ms (default 10000).
 * @returns {Promise<{ enriched: number, skipped: number, failed: number, costUsd: number, phases: object }>}
 */
async function enrichBatch(businesses, opts) {
  const o = opts || {};
  const list = Array.isArray(businesses) ? businesses : [];
  const logger = o.logger || null;
  const phases = {};
  let costUsd = 0;

  if (list.length === 0) {
    return { enriched: 0, skipped: 0, failed: 0, costUsd: 0, phases };
  }

  // ── 3.1 — Phone normalization (always on) ───────────────────────────────
  phases.phone = runPhase('3.1-phone', () =>
    phone.normalizePhonesBatch(list, { defaultCountry: o.defaultCountry, logger }),
    logger,
  );

  // ── 3.2 — Address parsing + optional geocoding ──────────────────────────
  phases.address = runPhase('3.2-address', () => {
    for (const b of list) {
      if (!b || !b.address) continue;
      try {
        const parsed = address.parseAddress(b.address, { defaultCountry: o.defaultCountry });
        b.address_street = parsed.street || null;
        b.address_unit = parsed.unit || null;
        b.address_city = parsed.city || null;
        b.address_state = parsed.state || null;
        b.address_postal = parsed.postalCode || null;
        b.address_country = parsed.country || null;
        b.address_parsed = parsed; // debug descriptor (NOT persisted)
      } catch (_e) {
        // Parsing failure — leave address_* null, keep raw b.address.
      }
    }
    if (o.geocode) {
      const geoStats = address.geocodeBatch(list, {
        geocoder: o.geocoder || 'mock',
        apiKey: o.geocodeApiKey,
        rateLimitMs: o.geocodeRateLimitMs,
        logger,
      });
      costUsd += geoStats.costUsd || 0;
      return { parsed: list.length, geocoded: geoStats.geocoded, costUsd: geoStats.costUsd };
    }
    return { parsed: list.length, geocoded: 0, costUsd: 0 };
  }, logger);

  // ── 3.3 — Deduplication (always on, batch-wide) ─────────────────────────
  phases.dedup = runPhase('3.3-dedup', () => {
    const out = dedup.findDuplicates(list, { threshold: o.dedupThreshold || 0.85, logger });
    attachDedupResults(list, out);
    return out.stats;
  }, logger);

  // ── 3.4 — Chain detection + spam/fake detection (always on, batch-wide) ─
  phases.chain = runPhase('3.4-chain', () => chainDetection.detectChainBatch(list, { logger }), logger);
  phases.spam = runPhase('3.4-spam', () => chainDetection.detectSpamBatch(list, { logger }), logger);

  // ── 3.5 — Email discovery (+ optional SMTP verification) ────────────────
  phases.email = runPhase('3.5-email', async () => {
    const e = await email.enrichEmailsBatch(list, {
      verify: !!o.emailVerify,
      concurrency: o.emailConcurrency || 3,
      timeout: o.emailTimeout || 5000,
      logger,
    });
    return e;
  }, logger);
  if (phases.email && typeof phases.email.then === 'function') {
    phases.email = await phases.email;
  }

  // ── 3.6 — Tech-stack detection (opt-in — HTTP fetches) ──────────────────
  if (o.techStackFetch) {
    phases.techStack = runPhase('3.6-tech-stack', async () => {
      const t = await techStack.detectTechStackBatch(list, {
        fetch: true,
        timeout: o.techStackTimeout || 10000,
        concurrency: o.techStackConcurrency || 3,
        logger,
      });
      return t;
    }, logger);
    if (phases.techStack && typeof phases.techStack.then === 'function') {
      phases.techStack = await phases.techStack;
    }
  } else {
    phases.techStack = { skipped: true, reason: 'techStackFetch not enabled' };
  }

  // ── 3.7 — Sentiment analysis (always on) ────────────────────────────────
  phases.sentiment = runPhase('3.7-sentiment', () =>
    sentiment.analyzeReviewsBatch(list, { logger }), logger);

  // ── 3.8 — Geo-metrics (always on, batch-wide — needs all businesses) ────
  phases.geo = runPhase('3.8-geo', () =>
    geoMetrics.computeGeoMetricsBatch(list, { logger }), logger);

  // ── 3.9 — Lead scoring (always on — combines all signals) ───────────────
  phases.lead = runPhase('3.9-lead', () =>
    leadScore.scoreLeadsBatch(list, { profile: o.leadProfile || 'web-agency', logger }), logger);

  // ── 3.10 — Confidence scoring (always on — evidence depth) ──────────────
  phases.confidence = runPhase('3.10-confidence', () =>
    confidence.computeConfidenceBatch(list, { logger }), logger);

  // ── Mark enriched + version stamp ───────────────────────────────────────
  const now = new Date();
  let enriched = 0;
  let skipped = 0;
  let failed = 0;
  for (const b of list) {
    if (!b) { skipped++; continue; }
    if (b._enrichmentError) { failed++; continue; }
    b.enriched_at = now;
    b.enrichment_version = 1;
    enriched++;
  }

  return { enriched, skipped, failed, costUsd, phases };
}

/**
 * Enrich a single business. Convenience wrapper — runs the per-business
 * phases but skips batch-wide phases (dedup, spam phone-reuse, geo neighbor
 * counts) since they need the full batch. For full enrichment, use enrichBatch.
 *
 * @param {object} business
 * @param {object} [opts]
 * @returns {Promise<object>} the enriched business
 */
async function enrichBusiness(business, opts) {
  if (!business) return business;
  // Wrap in a single-element batch to reuse the full pipeline.
  await enrichBatch([business], opts);
  return business;
}

module.exports = {
  __version,
  enrichBusiness,
  enrichBatch,
  attachDedupResults,
  ENRICHMENT_COLUMNS,
};
