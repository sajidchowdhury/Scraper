'use strict';

/**
 * src/enrichment/pipeline.js — Phase 3.12 — Enrichment Pipeline Orchestration
 *
 * STUB (Phase 3.0). Implemented in Phase 3.12.
 *
 * Will orchestrate the full enrichment pipeline: reads un-enriched businesses
 * from PostgreSQL, runs each enabled enrichment sub-phase (phone → address →
 * dedup → chain → email → tech-stack → sentiment → geo → lead-score →
 * confidence), writes results back, and respects --enrichBudget (USD cap on
 * API-cost features) + ENRICHMENT_CONCURRENCY. Designed to run unattended
 * alongside the Phase 2 scraper (queue-orchestrated in Phase 3.13).
 *
 * Public API (planned):
 *   enrichBusiness(business, opts)   → enriched business
 *   enrichBatch(businesses, opts)    → { enriched, skipped, failed, costUsd }
 *   runEnrichmentPipeline(opts)      → full run summary (DB-driven)
 */

const __version = 1;

/**
 * Enrich a single business through all enabled sub-phases.
 *
 * @param {object} _business
 * @param {object} [_opts] — { features, budgetUsd, concurrency, logger }
 * @returns {Promise<object>} the enriched business
 * @implements Phase 3.12
 */
async function enrichBusiness(_business, _opts) {
  // TODO Phase 3.12 — chain phone → address → dedup → ... → confidence.
  return _business;
}

/**
 * Enrich a batch of businesses with concurrency + budget control.
 *
 * @param {object[]} _businesses
 * @param {object} [_opts]
 * @returns {Promise<{ enriched: number, skipped: number, failed: number, costUsd: number }>}
 * @implements Phase 3.12
 */
async function enrichBatch(_businesses, _opts) {
  // TODO Phase 3.12 — implement bounded-concurrency batch + budget guard.
  return { enriched: 0, skipped: 0, failed: 0, costUsd: 0 };
}

module.exports = {
  __version,
  enrichBusiness,
  enrichBatch,
  ENRICHMENT_COLUMNS: [],
};
