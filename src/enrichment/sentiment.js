'use strict';

/**
 * src/enrichment/sentiment.js — Phase 3.7 — Review Sentiment Analysis
 *
 * STUB (Phase 3.0). Implemented in Phase 3.7.
 *
 * Will run NLP over a business's top reviews to produce a composite sentiment
 * score (-1.00 to +1.00) and a per-theme breakdown (food, service, cleanliness,
 * ...). Uses the `sentiment` package (AFINN-based) or `natural` for richer NLP.
 *
 * Public API (planned):
 *   analyzeReviews(reviews)          → { score, themes }
 *   analyzeSentiment(text)           → number (-1 to +1)
 *   ENRICHMENT_COLUMNS               → ['sentiment_score', 'sentiment_themes']
 */

const __version = 1;

/**
 * Analyze a set of reviews for composite sentiment + themes.
 *
 * @param {Array<{ text?: string, rating?: number }>} _reviews
 * @returns {{ score: number, themes: object }}
 * @implements Phase 3.7
 */
function analyzeReviews(_reviews) {
  // TODO Phase 3.7 — implement AFINN sentiment + theme keyword aggregation.
  return { score: 0, themes: {} };
}

module.exports = {
  __version,
  analyzeReviews,
  analyzeSentiment: analyzeReviews, // alias for single-text convenience
  ENRICHMENT_COLUMNS: ['sentiment_score', 'sentiment_themes'],
};
