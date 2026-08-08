'use strict';

/**
 * src/enrichment/confidence.js — Phase 3.10 — Per-Field Confidence Scoring
 *
 * STUB (Phase 3.0). Implemented in Phase 3.10.
 *
 * Will compute a 0.00–1.00 per-record confidence score based on source
 * reliability and cross-checks (e.g. phone verified via SMTP-style ping =
 * high confidence; phone only in list view = lower). Aggregates per-field
 * confidence into a single record-level composite.
 *
 * Public API (planned):
 *   fieldConfidence(business, field) → number (0–1)
 *   recordConfidence(business)       → number (0–1) composite
 *   ENRICHMENT_COLUMNS               → ['confidence_score']
 */

const __version = 1;

/**
 * Compute per-field confidence (0–1) for a business record.
 *
 * @param {object} _business
 * @param {string} _field
 * @returns {number}
 * @implements Phase 3.10
 */
function fieldConfidence(_business, _field) {
  // TODO Phase 3.10 — implement source-reliability + cross-check weighting.
  return 0;
}

/**
 * Compute the composite record-level confidence score (0–1).
 *
 * @param {object} _business
 * @returns {number}
 * @implements Phase 3.10
 */
function recordConfidence(_business) {
  // TODO Phase 3.10 — aggregate per-field confidence into a record composite.
  return 0;
}

module.exports = {
  __version,
  fieldConfidence,
  recordConfidence,
  ENRICHMENT_COLUMNS: ['confidence_score'],
};
