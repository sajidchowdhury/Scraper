'use strict';

/**
 * src/enrichment/tech-stack.js — Phase 3.6 — Website Tech Stack Detection
 *
 * STUB (Phase 3.0). Implemented in Phase 3.6.
 *
 * Will detect the CMS/framework/hosting a business's website uses (WordPress,
 * Shopify, Wix, custom, ...) and check website liveness (HTTP HEAD →
 * website_status_code + website_liveness: live | dead | redirected | error).
 * Uses wappalyzer-core (or a custom HTTP-based detector).
 *
 * Public API (planned):
 *   detectTechStack(website)          → string[] (technologies)
 *   checkWebsiteLiveness(website)     → { statusCode, liveness }
 *   ENRICHMENT_COLUMNS                → ['website_tech_stack', 'website_status_code', 'website_liveness']
 */

const __version = 1;

/**
 * Detect the technologies powering a website.
 *
 * @param {string} _website
 * @returns {string[]}
 * @implements Phase 3.6
 */
function detectTechStack(_website) {
  // TODO Phase 3.6 — implement wappalyzer-core detection (headers + HTML).
  return [];
}

/**
 * Check whether a website is live (HTTP HEAD).
 *
 * @param {string} _website
 * @returns {{ statusCode: number|null, liveness: string }}
 * @implements Phase 3.6
 */
function checkWebsiteLiveness(_website) {
  // TODO Phase 3.6 — implement HTTP HEAD with redirect + timeout handling.
  return { statusCode: null, liveness: 'error' };
}

module.exports = {
  __version,
  detectTechStack,
  checkWebsiteLiveness,
  ENRICHMENT_COLUMNS: [
    'website_tech_stack',
    'website_status_code',
    'website_liveness',
  ],
};
