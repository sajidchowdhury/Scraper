/**
 * Pagination / infinite-scroll handling.
 *
 * Phase 1.3 (TODO): scroll the div[role="feed"] container until all results
 * are loaded, maxResults is reached, end-of-list is detected, or a stall/
 * timeout guard triggers.
 *
 * Until then, this module is a placeholder so the project structure is
 * complete and importable.
 */

/**
 * Scroll the results feed to load all available businesses.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {number} [options.maxResults]  stop once this many results are visible
 * @param {number} [options.timeoutMs]   hard cap on scrolling time
 * @returns {Promise<number>} total number of results loaded
 */
async function scrollFeedToBottom(page, options = {}) {
  throw new Error('scrollFeedToBottom() not implemented yet — see Phase 1.3');
}

module.exports = { scrollFeedToBottom };
