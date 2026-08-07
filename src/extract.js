/**
 * Core field extraction.
 *
 * Phase 1.4 (TODO): extract the canonical money fields from each business card
 * in the results list:
 *   name, rating, reviews_count, price_level, category, address, phone,
 *   website, maps_url, place_id, plus_code, open_now, scraped_at, query, location.
 *
 * Phase 1.5 (TODO): optional detail-page deep scrape (hours, reviews, photos...).
 *
 * Until then, this module is a placeholder so the project structure is
 * complete and importable.
 */

/**
 * Extract business records from the loaded results feed.
 *
 * @param {import('playwright').Page} page
 * @param {object} [context]  { query, location } used to tag each record
 * @returns {Promise<Array<object>>} array of business records
 */
async function extractBusinesses(page, context = {}) {
  throw new Error('extractBusinesses() not implemented yet — see Phase 1.4');
}

module.exports = { extractBusinesses };
