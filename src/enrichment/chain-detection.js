'use strict';

/**
 * src/enrichment/chain-detection.js — Phase 3.4 — Chain Detection & Spam/Fake Listing Detection
 *
 * STUB (Phase 3.0). Implemented in Phase 3.4.
 *
 * Will flag businesses that belong to a franchise/chain (e.g. all "Subway"
 * locations) and detect suspicious/fake listings (new, no reviews, no website,
 * keyword-stuffed name).
 *
 * Public API (planned):
 *   detectChain(business, knownChains?) → { isChain, chainName, confidence }
 *   detectSpam(business)                → { isSpam, reasons[], spamScore }
 */

const __version = 1;

/**
 * Detect whether a business belongs to a known franchise/chain.
 *
 * @param {object} _business
 * @param {object} [_knownChains]
 * @returns {{ isChain: boolean, chainName: string|null, confidence: number }}
 * @implements Phase 3.4
 */
function detectChain(_business, _knownChains) {
  // TODO Phase 3.4 — implement name normalization + known-chain lookup.
  return { isChain: false, chainName: null, confidence: 0 };
}

/**
 * Detect suspicious / fake-listing patterns.
 *
 * @param {object} _business
 * @returns {{ isSpam: boolean, reasons: string[], spamScore: number }}
 * @implements Phase 3.4
 */
function detectSpam(_business) {
  // TODO Phase 3.4 — implement heuristics (no reviews + no website + new + keyword-stuffed).
  return { isSpam: false, reasons: [], spamScore: 0 };
}

module.exports = {
  __version,
  detectChain,
  detectSpam,
  ENRICHMENT_COLUMNS: [],
};
