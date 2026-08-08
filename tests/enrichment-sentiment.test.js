'use strict';

/**
 * tests/enrichment-sentiment.test.js — Phase 3.7 — Review Sentiment Analysis tests
 *
 * Coverage (per PHASE3_EXECUTION_PLAN.md §3.7 task checklist + acceptance):
 *   - analyzeSentiment: positive/negative/neutral/empty inputs + [-1,+1] clamping
 *   - labelFromScore: very_positive / positive / neutral / negative / very_negative bands
 *   - expectedFromRating: (rating-3)/2 formula, clamping, null/NaN handling
 *   - volumeConfidenceFor: low/medium/high/very_high bands + snippets fallback
 *   - detectAspects: each of the 8 ASPECTS (food, service, price, cleanliness,
 *     atmosphere, wait, value, location) triggered with correct polarity
 *     direction; multi-word PHRASES; empty/no-keyword text returns []
 *   - analyzeReviews: positive/negative batches, returned-object shape,
 *     ratingConsistency bands, opts.rating omitted → 'unknown'
 *   - Anomalies: no_reviews, rating_review_mismatch (medium),
 *     rating_review_mismatch_high (severe), extreme_rating_low_volume,
 *     uniformly_perfect_reviews
 *   - analyzeReviewsBatch: in-place mutation (sentiment_score 2-decimals,
 *     sentiment_themes {aspect:score}, sentiment_result debug descriptor),
 *     no-review businesses excluded from avgScore/listingsWithReviews,
 *     byLabel tally, empty-batch stats
 *   - Module exports: ENRICHMENT_COLUMNS, ASPECTS, WORD_LEXICON, PHRASES, __version
 *
 * Determinism strategy:
 *   - The real `sentiment` AFINN package is installed and used for the
 *     analyzeSentiment / detectAspects / analyzeReviews core tests — AFINN-165
 *     is a fixed lexicon so scores are reproducible.
 *   - For the rating_review_mismatch anomaly bands (which require a precise
 *     score inside a 0.3-wide window) we inject a stub via the _setSentiment
 *     DI seam so the per-review comparative is fully controlled.
 *   - All tests are pure (no network, no DB, no clock).
 *
 * Run: bun test tests/enrichment-sentiment.test.js
 */

const {
  __version,
  ENRICHMENT_COLUMNS,
  analyzeSentiment,
  labelFromScore,
  expectedFromRating,
  volumeConfidenceFor,
  detectAspects,
  analyzeReviews,
  analyzeReviewsBatch,
  _setSentiment,
  ASPECTS,
  WORD_LEXICON,
  PHRASES,
} = require('../src/enrichment/sentiment');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a sentiment-package stub returning a fixed comparative for any text. */
function makeStub(comparative) {
  return {
    analyze() {
      return { score: comparative * 10, comparative, tokens: ['x', 'y', 'z'] };
    },
  };
}

function pickAspect(aspects, name) {
  return aspects.find((a) => a.aspect === name);
}

function anomalyCodes(result) {
  return result.anomalies.map((a) => a.code);
}

// Reset the DI seam between tests so a stub injected in one test never leaks
// into another (bun runs all tests in one process).
afterEach(() => {
  _setSentiment(null);
});

// ---------------------------------------------------------------------------
// 1. analyzeSentiment (AFINN-based, -1..+1 clamped)
// ---------------------------------------------------------------------------

describe('Phase 3.7 — analyzeSentiment', () => {
  test('clearly positive text → score > 0', () => {
    expect(analyzeSentiment('This is wonderful and amazing and delicious')).toBeGreaterThan(0);
  });

  test('clearly negative text → score < 0', () => {
    expect(analyzeSentiment('Terrible awful horrible bad experience')).toBeLessThan(0);
  });

  test('neutral text → score ~0', () => {
    expect(analyzeSentiment('It is a table')).toBe(0);
  });

  test('empty / whitespace / null / non-string → 0', () => {
    expect(analyzeSentiment('')).toBe(0);
    expect(analyzeSentiment('   ')).toBe(0);
    expect(analyzeSentiment(null)).toBe(0);
    expect(analyzeSentiment(undefined)).toBe(0);
    expect(analyzeSentiment(12345)).toBe(0);
  });

  test('comparative is clamped into [-1, +1]', () => {
    // "wonderful amazing delicious" has comparative 1.57 raw — must clamp to 1.
    expect(analyzeSentiment('This is wonderful and amazing and delicious')).toBe(1);
    // "terrible awful horrible bad" has comparative -3 raw — must clamp to -1.
    expect(analyzeSentiment('Terrible awful horrible bad')).toBe(-1);
  });

  test('returns 0 when the DI stub is null (package unavailable)', () => {
    _setSentiment(null);
    // Force the "didLoad + instance=null" path that production hits when the
    // package is missing. analyzeSentiment must degrade to 0 without throwing.
    _setSentiment({ analyze: null });
    expect(analyzeSentiment('wonderful delicious amazing')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. labelFromScore (5-band mapping)
// ---------------------------------------------------------------------------

describe('Phase 3.7 — labelFromScore', () => {
  test('score >= 0.5 → very_positive (boundary at 0.5 inclusive)', () => {
    expect(labelFromScore(0.5)).toBe('very_positive');
    expect(labelFromScore(0.7)).toBe('very_positive');
    expect(labelFromScore(1)).toBe('very_positive');
  });

  test('0.1 <= score < 0.5 → positive (boundary at 0.1 inclusive)', () => {
    expect(labelFromScore(0.1)).toBe('positive');
    expect(labelFromScore(0.3)).toBe('positive');
    expect(labelFromScore(0.499)).toBe('positive');
  });

  test('-0.5 < score < 0.1 → neutral (excludes the negative boundary -0.1)', () => {
    expect(labelFromScore(0)).toBe('neutral');
    expect(labelFromScore(0.05)).toBe('neutral');
    expect(labelFromScore(-0.05)).toBe('neutral');
    expect(labelFromScore(0.099)).toBe('neutral');
  });

  test('score <= -0.5 → very_negative (boundary at -0.5 inclusive)', () => {
    expect(labelFromScore(-0.5)).toBe('very_negative');
    expect(labelFromScore(-0.7)).toBe('very_negative');
    expect(labelFromScore(-1)).toBe('very_negative');
  });

  test('-0.5 < score <= -0.1 → negative (boundary at -0.1 inclusive)', () => {
    expect(labelFromScore(-0.1)).toBe('negative');
    expect(labelFromScore(-0.3)).toBe('negative');
    expect(labelFromScore(-0.499)).toBe('negative');
  });
});

// ---------------------------------------------------------------------------
// 3. expectedFromRating ((rating-3)/2 with clamping)
// ---------------------------------------------------------------------------

describe('Phase 3.7 — expectedFromRating', () => {
  test('rating 5 → +1, rating 1 → -1, rating 3 → 0', () => {
    expect(expectedFromRating(5)).toBe(1);
    expect(expectedFromRating(1)).toBe(-1);
    expect(expectedFromRating(3)).toBe(0);
  });

  test('formula (rating-3)/2 holds for every integer rating 1..5', () => {
    for (let r = 1; r <= 5; r++) {
      expect(expectedFromRating(r)).toBeCloseTo((r - 3) / 2, 10);
    }
  });

  test('rating is clamped into [1,5] before applying the formula', () => {
    expect(expectedFromRating(7)).toBe(1); // clamps to 5 → (5-3)/2 = 1
    expect(expectedFromRating(0)).toBe(-1); // clamps to 1 → (1-3)/2 = -1
    expect(expectedFromRating(-10)).toBe(-1);
    expect(expectedFromRating(100)).toBe(1);
  });

  test('null / undefined / NaN / non-number → 0', () => {
    expect(expectedFromRating(null)).toBe(0);
    expect(expectedFromRating(undefined)).toBe(0);
    expect(expectedFromRating(NaN)).toBe(0);
    expect(expectedFromRating('5')).toBe(0);
    expect(expectedFromRating({})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. volumeConfidenceFor (low / medium / high / very_high bands)
// ---------------------------------------------------------------------------

describe('Phase 3.7 — volumeConfidenceFor', () => {
  test('0 / null / <5 → low', () => {
    expect(volumeConfidenceFor(0)).toBe('low');
    expect(volumeConfidenceFor(null)).toBe('low');
    expect(volumeConfidenceFor(undefined)).toBe('low');
    expect(volumeConfidenceFor(4)).toBe('low');
  });

  test('5..19 → medium, 20..99 → high, 100+ → very_high', () => {
    expect(volumeConfidenceFor(5)).toBe('medium');
    expect(volumeConfidenceFor(19)).toBe('medium');
    expect(volumeConfidenceFor(20)).toBe('high');
    expect(volumeConfidenceFor(99)).toBe('high');
    expect(volumeConfidenceFor(100)).toBe('very_high');
    expect(volumeConfidenceFor(5000)).toBe('very_high');
  });

  test('falls back to snippets when reviewCount is null/undefined', () => {
    expect(volumeConfidenceFor(null, 0)).toBe('low');
    expect(volumeConfidenceFor(null, 4)).toBe('low');
    expect(volumeConfidenceFor(null, 10)).toBe('medium');
    expect(volumeConfidenceFor(null, 50)).toBe('high');
    expect(volumeConfidenceFor(null, 200)).toBe('very_high');
  });
});

// ---------------------------------------------------------------------------
// 5. detectAspects (one test per ASPECT + polarity direction)
// ---------------------------------------------------------------------------

describe('Phase 3.7 — detectAspects (per-aspect polarity)', () => {
  test('food: pizza + delicious → food aspect, positive score', () => {
    const a = detectAspects('The pizza was delicious');
    const food = pickAspect(a, 'food');
    expect(food).toBeDefined();
    expect(food.score).toBeGreaterThan(0);
    expect(food.mentions).toBeGreaterThanOrEqual(2);
    expect(food.keywords).toEqual(expect.arrayContaining(['pizza', 'delicious']));
  });

  test('service: waiter + rude → service aspect, negative score', () => {
    const a = detectAspects('The waiter was rude');
    const svc = pickAspect(a, 'service');
    expect(svc).toBeDefined();
    expect(svc.score).toBeLessThan(0);
    expect(svc.keywords).toEqual(expect.arrayContaining(['waiter', 'rude']));
  });

  test('price: expensive + overpriced → price aspect, negative score', () => {
    const a = detectAspects('Expensive and overpriced');
    const price = pickAspect(a, 'price');
    expect(price).toBeDefined();
    expect(price.score).toBeLessThan(0);
  });

  test('cleanliness: dirty + filthy → cleanliness aspect, negative score', () => {
    const a = detectAspects('Dirty and filthy');
    const cl = pickAspect(a, 'cleanliness');
    expect(cl).toBeDefined();
    expect(cl.score).toBeLessThan(0);
  });

  test('atmosphere: cozy + beautiful → atmosphere aspect, positive score', () => {
    const a = detectAspects('Cozy and beautiful');
    const atmo = pickAspect(a, 'atmosphere');
    expect(atmo).toBeDefined();
    expect(atmo.score).toBeGreaterThan(0);
  });

  test('wait: fast + quick → wait aspect, positive score', () => {
    const a = detectAspects('Fast and quick');
    const wait = pickAspect(a, 'wait');
    expect(wait).toBeDefined();
    expect(wait.score).toBeGreaterThan(0);
  });

  test('value: "worth it" + "real deal" → value aspect, positive score', () => {
    const a = detectAspects('Worth it, real deal');
    const val = pickAspect(a, 'value');
    expect(val).toBeDefined();
    expect(val.score).toBeGreaterThan(0);
    expect(val.keywords).toEqual(expect.arrayContaining(['real deal']));
  });

  test('location: convenient + walkable → location aspect, positive score', () => {
    const a = detectAspects('Convenient location, walkable');
    const loc = pickAspect(a, 'location');
    expect(loc).toBeDefined();
    expect(loc.score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. detectAspects (phrases, edge cases, shape)
// ---------------------------------------------------------------------------

describe('Phase 3.7 — detectAspects (phrases + shape)', () => {
  test('multi-word phrase "tourist trap" → atmosphere, negative', () => {
    const a = detectAspects('Total tourist trap here');
    const atmo = pickAspect(a, 'atmosphere');
    expect(atmo).toBeDefined();
    expect(atmo.score).toBeLessThan(0);
    expect(atmo.keywords).toEqual(expect.arrayContaining(['tourist trap']));
  });

  test('"must try" phrase → food, positive', () => {
    const a = detectAspects('Must try the pizza here');
    const food = pickAspect(a, 'food');
    expect(food).toBeDefined();
    expect(food.score).toBeGreaterThan(0);
    expect(food.keywords).toEqual(expect.arrayContaining(['must try']));
  });

  test('text with no aspect keywords → empty array', () => {
    expect(detectAspects('It is a table')).toEqual([]);
  });

  test('empty / null / non-string → empty array', () => {
    expect(detectAspects('')).toEqual([]);
    expect(detectAspects(null)).toEqual([]);
    expect(detectAspects(undefined)).toEqual([]);
    expect(detectAspects(123)).toEqual([]);
  });

  test('each AspectSentiment has {aspect,label,score,mentions,keywords}', () => {
    const a = detectAspects('The pizza was delicious');
    expect(a.length).toBeGreaterThan(0);
    for (const item of a) {
      expect(item).toEqual(
        expect.objectContaining({
          aspect: expect.any(String),
          label: expect.any(String),
          score: expect.any(Number),
          mentions: expect.any(Number),
          keywords: expect.any(Array),
        })
      );
      expect(item.score).toBeGreaterThanOrEqual(-1);
      expect(item.score).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. analyzeReviews (core)
// ---------------------------------------------------------------------------

describe('Phase 3.7 — analyzeReviews (core)', () => {
  const positiveReviews = [
    { author: 'A', rating: 5, text: 'The pizza was delicious', time: '3 weeks ago' },
    { author: 'B', rating: 5, text: 'Amazing place, loved it!', time: '2 weeks ago' },
    { author: 'C', rating: 5, text: 'Great food and great service', time: '1 week ago' },
  ];

  const negativeReviews = [
    { author: 'A', rating: 1, text: 'Terrible awful horrible bad experience', time: '3w' },
    { author: 'B', rating: 1, text: 'Worst meal ever, never again', time: '2w' },
    { author: 'C', rating: 1, text: 'Bland food and rude waiter, total ripoff', time: '1w' },
  ];

  test('positive batch + rating 5 → positive score, very_positive label, no anomalies', () => {
    const r = analyzeReviews(positiveReviews, { rating: 5, reviewCount: 10 });
    expect(r.score).toBeGreaterThan(0);
    expect(r.label).toBe('very_positive');
    expect(r.anomalies).toEqual([]);
    expect(r.ratingConsistency).toBe('consistent');
    expect(r.volumeConfidence).toBe('medium'); // reviewCount=10 → 5-19 band
  });

  test('negative batch + rating 1 → negative score, very_negative label', () => {
    const r = analyzeReviews(negativeReviews, { rating: 1, reviewCount: 8 });
    expect(r.score).toBeLessThan(0);
    expect(r.label).toBe('very_negative');
    expect(r.reviewCount).toBe(3);
  });

  test('returned object has the documented SentimentResult shape', () => {
    const r = analyzeReviews(positiveReviews, { rating: 5, reviewCount: 10 });
    expect(r).toEqual(
      expect.objectContaining({
        reviewCount: expect.any(Number),
        score: expect.any(Number),
        label: expect.any(String),
        aspects: expect.any(Array),
        topPositive: expect.any(Array),
        topNegative: expect.any(Array),
        volumeConfidence: expect.any(String),
        expectedFromRating: expect.any(Number),
        ratingConsistency: expect.any(String),
        anomalies: expect.any(Array),
      })
    );
    expect(r.score).toBeGreaterThanOrEqual(-1);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  test('opts.rating omitted → ratingConsistency "unknown" + expectedFromRating 0', () => {
    const r = analyzeReviews(positiveReviews, { reviewCount: 10 });
    expect(r.ratingConsistency).toBe('unknown');
    expect(r.expectedFromRating).toBe(0);
  });

  test('opts.reviewCount omitted → volumeConfidence falls back to reviews.length', () => {
    // 3 reviews → falls in the <5 "low" band.
    const r = analyzeReviews(positiveReviews, { rating: 5 });
    expect(r.volumeConfidence).toBe('low');
  });

  test('reviews with empty/whitespace text are filtered out', () => {
    const reviews = [
      { author: 'A', rating: 5, text: 'The pizza was delicious', time: '1w' },
      { author: 'B', rating: 5, text: '', time: '1w' },
      { author: 'C', rating: 5, text: '   ', time: '1w' },
      { author: 'D', rating: 5, text: null, time: '1w' },
    ];
    const r = analyzeReviews(reviews, { rating: 5, reviewCount: 4 });
    expect(r.reviewCount).toBe(1);
    expect(r.score).toBeGreaterThan(0);
  });

  test('non-array reviews argument is treated as empty → no_reviews anomaly', () => {
    const r1 = analyzeReviews(null, { rating: 3 });
    const r2 = analyzeReviews(undefined, { rating: 3 });
    expect(r1.anomalies.map((a) => a.code)).toContain('no_reviews');
    expect(r2.anomalies.map((a) => a.code)).toContain('no_reviews');
    expect(r1.reviewCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Anomalies (each code triggered by crafted input)
// ---------------------------------------------------------------------------

describe('Phase 3.7 — anomalies', () => {
  test('no_reviews: empty reviews array → [{code:"no_reviews", severity:"info"}]', () => {
    const r = analyzeReviews([], { rating: 3, reviewCount: 0 });
    expect(anomalyCodes(r)).toContain('no_reviews');
    const a = r.anomalies.find((x) => x.code === 'no_reviews');
    expect(a.severity).toBe('info');
    expect(r.score).toBe(0);
    expect(r.label).toBe('neutral');
    expect(r.volumeConfidence).toBe('low');
  });

  test('no_reviews: rating >= 4.8 with low reviewCount also flags extreme_rating_low_volume', () => {
    const r = analyzeReviews([], { rating: 5, reviewCount: 2 });
    expect(anomalyCodes(r)).toEqual(
      expect.arrayContaining(['no_reviews', 'extreme_rating_low_volume'])
    );
  });

  test('rating_review_mismatch (medium): rating 5 but reviews score ~0.55 (diff 0.45)', () => {
    _setSentiment(makeStub(0.55));
    const reviews = [
      { author: 'A', rating: 5, text: 'this place exists', time: '1w' },
      { author: 'B', rating: 5, text: 'it was okay', time: '2w' },
    ];
    const r = analyzeReviews(reviews, { rating: 5, reviewCount: 50 });
    expect(r.ratingConsistency).toBe('mismatch');
    expect(anomalyCodes(r)).toContain('rating_review_mismatch');
    const a = r.anomalies.find((x) => x.code === 'rating_review_mismatch');
    expect(a.severity).toBe('medium');
    // High-severity variant must NOT fire in this band.
    expect(anomalyCodes(r)).not.toContain('rating_review_mismatch_high');
  });

  test('rating_review_mismatch_high (severe): rating 5 but reviews score -0.3 (diff 1.3)', () => {
    _setSentiment(makeStub(-0.3));
    const reviews = [
      { author: 'A', rating: 5, text: 'this place exists', time: '1w' },
      { author: 'B', rating: 5, text: 'it was okay', time: '2w' },
    ];
    const r = analyzeReviews(reviews, { rating: 5, reviewCount: 50 });
    expect(r.ratingConsistency).toBe('severe_mismatch');
    expect(anomalyCodes(r)).toContain('rating_review_mismatch_high');
    const a = r.anomalies.find((x) => x.code === 'rating_review_mismatch_high');
    expect(a.severity).toBe('high');
  });

  test('extreme_rating_low_volume: rating 5.0 with 2 reviews (clean, no other anomaly)', () => {
    // Long positive reviews so uniformly_perfect_reviews does NOT also fire.
    const reviews = [
      { author: 'A', rating: 5, text: 'This place was wonderful and the food was delicious', time: '3w' },
      { author: 'B', rating: 5, text: 'We had an amazing time and the service was great', time: '2w' },
    ];
    const r = analyzeReviews(reviews, { rating: 5, reviewCount: 2 });
    expect(r.ratingConsistency).toBe('consistent'); // no mismatch
    expect(anomalyCodes(r)).toEqual(['extreme_rating_low_volume']);
    const a = r.anomalies[0];
    expect(a.severity).toBe('high');
    expect(a.detail).toMatch(/5\.0/);
  });

  test('uniformly_perfect_reviews: all short glowing reviews, no rating (clean)', () => {
    const reviews = [
      { author: 'A', rating: 5, text: 'Amazing place', time: '3w' },
      { author: 'B', rating: 5, text: 'Loved it', time: '2w' },
      { author: 'C', rating: 5, text: 'Great spot', time: '1w' },
    ];
    const r = analyzeReviews(reviews, { rating: null, reviewCount: null });
    expect(r.score).toBeGreaterThan(0.2);
    expect(anomalyCodes(r)).toEqual(['uniformly_perfect_reviews']);
    const a = r.anomalies[0];
    expect(a.severity).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// 9. ratingConsistency bands
// ---------------------------------------------------------------------------

describe('Phase 3.7 — ratingConsistency', () => {
  test('consistent: score within 0.3 of expected', () => {
    // rating 5 → expected 1.0; real reviews score ~0.917 → diff 0.083.
    const reviews = [
      { author: 'A', rating: 5, text: 'The pizza was delicious', time: '1w' },
      { author: 'B', rating: 5, text: 'Amazing place, loved it!', time: '2w' },
    ];
    const r = analyzeReviews(reviews, { rating: 5, reviewCount: 20 });
    expect(r.ratingConsistency).toBe('consistent');
  });

  test('mismatch: diff in [0.3, 0.6) via stub', () => {
    _setSentiment(makeStub(0.6)); // rating 5 → expected 1.0, diff 0.4
    const reviews = [
      { author: 'A', rating: 5, text: 'this place exists', time: '1w' },
    ];
    const r = analyzeReviews(reviews, { rating: 5, reviewCount: 20 });
    expect(r.ratingConsistency).toBe('mismatch');
  });

  test('severe_mismatch: diff >= 0.6 via stub', () => {
    _setSentiment(makeStub(0.0)); // rating 5 → expected 1.0, diff 1.0
    const reviews = [
      { author: 'A', rating: 5, text: 'this place exists', time: '1w' },
    ];
    const r = analyzeReviews(reviews, { rating: 5, reviewCount: 20 });
    expect(r.ratingConsistency).toBe('severe_mismatch');
  });

  test('unknown: no rating supplied, or no reviews', () => {
    const reviews = [
      { author: 'A', rating: 5, text: 'The pizza was delicious', time: '1w' },
    ];
    const r1 = analyzeReviews(reviews, { reviewCount: 5 });
    expect(r1.ratingConsistency).toBe('unknown');
    const r2 = analyzeReviews([], { rating: 5, reviewCount: 0 });
    expect(r2.ratingConsistency).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// 10. analyzeReviewsBatch (in-place mutation + stats)
// ---------------------------------------------------------------------------

describe('Phase 3.7 — analyzeReviewsBatch', () => {
  function sampleBusinesses() {
    return [
      {
        place_id: 'A',
        rating: 5,
        reviews_count: 10,
        top_reviews: [
          { author: 'A', rating: 5, text: 'The pizza was delicious', time: '1w' },
          { author: 'B', rating: 5, text: 'Amazing place, loved it!', time: '2w' },
          { author: 'C', rating: 5, text: 'Great food and great service', time: '3w' },
        ],
      },
      {
        place_id: 'B',
        rating: 1,
        reviews_count: 8,
        top_reviews: [
          { author: 'A', rating: 1, text: 'Terrible awful horrible bad experience', time: '1w' },
          { author: 'B', rating: 1, text: 'Worst meal ever, never again', time: '2w' },
        ],
      },
      {
        place_id: 'C',
        rating: null,
        reviews_count: 0,
        top_reviews: [],
      },
    ];
  }

  test('attaches sentiment_score (number, 2 decimals), sentiment_themes (object), sentiment_result', () => {
    const businesses = sampleBusinesses();
    analyzeReviewsBatch(businesses);
    const a = businesses[0];
    expect(typeof a.sentiment_score).toBe('number');
    // 2-decimal precision: score * 100 is an integer.
    expect(Math.round(a.sentiment_score * 100)).toBe(a.sentiment_score * 100);
    expect(a.sentiment_score).toBeGreaterThan(0);
    expect(a.sentiment_score).toBeLessThanOrEqual(1);
    expect(a.sentiment_themes).toEqual(expect.any(Object));
    expect(a.sentiment_result).toEqual(expect.any(Object));
    expect(a.sentiment_result.label).toBe('very_positive');
  });

  test('sentiment_themes is {aspect: score} for each detected aspect', () => {
    const businesses = sampleBusinesses();
    analyzeReviewsBatch(businesses);
    const themes = businesses[0].sentiment_themes;
    expect(themes.food).toEqual(expect.any(Number));
    expect(themes.food).toBeGreaterThan(0);
  });

  test('business with no reviews → score 0, themes {}, no_reviews anomaly; excluded from avgScore + listingsWithReviews', () => {
    const businesses = sampleBusinesses();
    const stats = analyzeReviewsBatch(businesses);
    const c = businesses[2];
    expect(c.sentiment_score).toBe(0);
    expect(c.sentiment_themes).toEqual({});
    expect(anomalyCodes(c.sentiment_result)).toContain('no_reviews');
    expect(stats.listingsWithReviews).toBe(2);
    expect(stats.total).toBe(3);
    expect(stats.analyzed).toBe(3);
  });

  test('stats shape + avgScore excludes no-review businesses', () => {
    const businesses = sampleBusinesses();
    const stats = analyzeReviewsBatch(businesses);
    expect(stats).toEqual(
      expect.objectContaining({
        total: 3,
        analyzed: 3,
        avgScore: expect.any(Number),
        byLabel: expect.any(Object),
        anomalies: expect.any(Number),
        listingsWithReviews: 2,
      })
    );
    // avgScore = round(mean over the 2 businesses with reviews, 3 decimals) —
    // the module rounds both per-business score and the batch mean to 3dp.
    const a = businesses[0].sentiment_result.score;
    const b = businesses[1].sentiment_result.score;
    expect(stats.avgScore).toBe(Math.round(((a + b) / 2) * 1000) / 1000);
    expect(stats.byLabel.very_positive).toBe(1);
    expect(stats.byLabel.very_negative).toBe(1);
    expect(stats.byLabel.neutral).toBe(1); // business C
    expect(stats.anomalies).toBeGreaterThanOrEqual(1); // B's mismatch + C's no_reviews
  });

  test('empty batch → all-zero stats', () => {
    const stats = analyzeReviewsBatch([]);
    expect(stats).toEqual({
      total: 0,
      analyzed: 0,
      avgScore: 0,
      byLabel: {
        very_positive: 0,
        positive: 0,
        neutral: 0,
        negative: 0,
        very_negative: 0,
      },
      anomalies: 0,
      listingsWithReviews: 0,
    });
  });

  test('business with no top_reviews field is handled (treated as empty)', () => {
    const businesses = [{ place_id: 'X', rating: 4, reviews_count: 0 }];
    const stats = analyzeReviewsBatch(businesses);
    expect(businesses[0].sentiment_score).toBe(0);
    expect(anomalyCodes(businesses[0].sentiment_result)).toContain('no_reviews');
    expect(stats.listingsWithReviews).toBe(0);
  });

  test('non-array argument is treated as an empty batch', () => {
    expect(analyzeReviewsBatch(null)).toEqual(
      expect.objectContaining({ total: 0, analyzed: 0, listingsWithReviews: 0 })
    );
    expect(analyzeReviewsBatch(undefined)).toEqual(
      expect.objectContaining({ total: 0, analyzed: 0, listingsWithReviews: 0 })
    );
  });
});

// ---------------------------------------------------------------------------
// 11. Module exports / constants
// ---------------------------------------------------------------------------

describe('Phase 3.7 — module exports', () => {
  test('ENRICHMENT_COLUMNS = ["sentiment_score", "sentiment_themes"]', () => {
    expect(ENRICHMENT_COLUMNS).toEqual(['sentiment_score', 'sentiment_themes']);
  });

  test('ASPECTS is an array of 8 expected aspect names', () => {
    expect(Array.isArray(ASPECTS)).toBe(true);
    expect(ASPECTS).toHaveLength(8);
    expect(ASPECTS).toEqual(
      expect.arrayContaining([
        'food',
        'service',
        'price',
        'cleanliness',
        'atmosphere',
        'wait',
        'value',
        'location',
      ])
    );
  });

  test('WORD_LEXICON + PHRASES are plain objects with the expected key shape', () => {
    expect(WORD_LEXICON).toEqual(expect.any(Object));
    expect(PHRASES).toEqual(expect.any(Object));
    // Sample a word entry: { aspect, polarity }.
    const delicious = WORD_LEXICON.delicious;
    expect(delicious).toBeDefined();
    expect(delicious.aspect).toBe('food');
    expect(typeof delicious.polarity).toBe('number');
    expect(delicious.polarity).toBeGreaterThan(0);
    // Sample a phrase entry.
    const worthIt = PHRASES['worth it'];
    expect(worthIt).toBeDefined();
    expect(worthIt.aspect).toBe('value');
    expect(worthIt.polarity).toBeGreaterThan(0);
  });

  test('__version is a positive number', () => {
    expect(typeof __version).toBe('number');
    expect(__version).toBeGreaterThan(0);
  });
});
