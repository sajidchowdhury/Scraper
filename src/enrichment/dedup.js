'use strict';

/**
 * src/enrichment/dedup.js — Phase 3.3 — Deduplication & Fuzzy Matching
 *
 * STUB (Phase 3.0). Implemented in Phase 3.3.
 *
 * Will detect the same business listed under slightly different names using
 * fuzzy matching on name + address + phone (via fuse.js). Records decisions
 * in the `business_duplicates` table so re-runs don't recompute.
 *
 * Public API (planned):
 *   findDuplicates(businesses, threshold?) → Array<{ canonical, duplicate, score, method }>
 *   similarityScore(a, b)                  → number (0–1)
 *   pickCanonical(cluster)                 → business (the surviving record)
 */

const __version = 1;

/**
 * Find duplicate clusters within a set of businesses.
 *
 * @param {object[]} _businesses
 * @param {number} [_threshold]
 * @returns {Array<{ canonical: string, duplicate: string, score: number, method: string }>}
 * @implements Phase 3.3
 */
function findDuplicates(_businesses, _threshold) {
  // TODO Phase 3.3 — implement fuzzy match with fuse.js on name+address+phone.
  return [];
}

module.exports = {
  __version,
  findDuplicates,
  ENRICHMENT_COLUMNS: [], // dedup writes to business_duplicates table, not businesses
};
