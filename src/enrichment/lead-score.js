'use strict';

/**
 * src/enrichment/lead-score.js — Phase 3.9 — Lead Scoring
 *
 * STUB (Phase 3.0). Implemented in Phase 3.9.
 *
 * Will combine enrichment signals into a 0–100 composite lead score using a
 * configurable scoring profile (web-agency, reputation-mgmt, SEO-agency, ...).
 * Example: no website → high-value lead for web agencies; low rating → lead
 * for reputation-management services.
 *
 * Public API (planned):
 *   scoreLead(business, profile?)   → { score, profile, signals }
 *   SCORING_PROFILES                → { 'web-agency': {...}, 'reputation-mgmt': {...} }
 *   ENRICHMENT_COLUMNS              → ['lead_score', 'lead_score_profile']
 */

const __version = 1;

/**
 * Available scoring profiles (expanded in Phase 3.9).
 * Each profile weights signals differently (e.g. web-agency weights
 * "no website" high; reputation-mgmt weights "low rating" high).
 */
const SCORING_PROFILES = {
  'web-agency': { noWebsite: 40, oldTech: 20, deadSite: 25, density: 15 },
  'reputation-mgmt': { lowRating: 40, fewReviews: 20, negativeSentiment: 25, density: 15 },
  'seo-agency': { lowAuthority: 35, oldTech: 25, noWebsite: 20, density: 20 },
};

/**
 * Compute a composite lead score (0–100) for a business.
 *
 * @param {object} _business
 * @param {string} [_profile] — scoring profile name (default 'web-agency').
 * @returns {{ score: number, profile: string, signals: object }}
 * @implements Phase 3.9
 */
function scoreLead(_business, _profile) {
  // TODO Phase 3.9 — implement weighted signal aggregation per profile.
  return { score: 0, profile: _profile || 'web-agency', signals: {} };
}

module.exports = {
  __version,
  SCORING_PROFILES,
  scoreLead,
  ENRICHMENT_COLUMNS: ['lead_score', 'lead_score_profile'],
};
