'use strict';

/**
 * src/enrichment/sentiment.js — Phase 3.7 — Review Sentiment Analysis
 *
 * Runs AFINN-based sentiment analysis over each business's top_reviews and
 * cross-checks the review-derived polarity against the listing's star rating.
 * A 5.0★ rating paired with scathing review text is a strong fake-listing tell
 * that the Phase 3.4 spam engine cannot see on its own — this module surfaces
 * that signal as a `rating_review_mismatch` anomaly (consumed by Phase 3.9
 * lead scoring and Phase 3.10 confidence).
 *
 * Two engines run side by side:
 *
 *   (A) OVERALL SENTIMENT (AFINN via the `sentiment` npm package)
 *       Each review's text is scored with the AFINN-165 lexicon. The package's
 *       `.comparative` value (score ÷ token count) is the per-review sentiment
 *       in roughly -1..+1 (clamped). The business-level score is the mean of
 *       per-review scores. The package is loaded through a DI seam so tests can
 *       inject a stub and skip the AFINN import entirely.
 *
 *   (B) ASPECT DETECTION (keyword-based, no ML)
 *       A curated lexicon maps review keywords to one of 8 aspects
 *       (food, service, price, cleanliness, atmosphere, wait, value, location)
 *       with a signed polarity (-3..+3; 0 for neutral aspect markers like
 *       "pizza" or "staff" that flag the topic without carrying sentiment).
 *       For each review we scan for aspect keywords + multi-word phrases
 *       ("worth it", "tourist trap", "must try"), aggregate per aspect
 *       (mentions, polarity sum, keywords), and squash the net polarity to
 *       -1..+1 via tanh — a faithful port of the dashboard's pipeline.
 *
 *   (C) RATING-vs-REVIEW CONSISTENCY
 *       The star rating is mapped to an expected -1..+1 sentiment
 *       ((rating-3)/2) and compared to the review-derived score. A gap ≥0.6
 *       is a `severe_mismatch` (high-severity anomaly); ≥0.3 is a `mismatch`.
 *
 *   (D) ANOMALIES
 *       rating_review_mismatch(_high), extreme_rating_low_volume,
 *       uniformly_perfect_reviews, no_reviews.
 *
 * DESIGN RULES (per PHASE3_EXECUTION_PLAN.md §3.7)
 *   - Pure functions wherever possible (testable without a DB / network).
 *   - The `sentiment` package is loaded via a DI seam (`_loadSentiment` /
 *     `_setSentiment`) so tests inject a stub instance and skip the AFINN
 *     import in unit-test runs.
 *   - top_reviews is JSONB — the pg driver delivers it as a JS array already.
 *     Guard against null/undefined/non-array/non-object reviews.
 *   - A business with no reviews returns score=0, label='neutral',
 *     volumeConfidence='low', anomalies=[{code:'no_reviews'}].
 *   - Aspect detection is keyword-based (no ML). The lexicon is ported from
 *     the dashboard's sentiment pipeline; polarities are on a -3..+3 scale.
 *     A word maps to exactly one aspect (e.g. "fast"/"slow" → wait, even
 *     though the dashboard's example service list mentions them — wait is the
 *     more specific dimension; "fresh"/"stale" → cleanliness per the spec).
 *   - The `sentiment` package's default English scorer does NOT negate, so
 *     "not good" still scores positive — a known limitation shared by the
 *     aspect scan (no negation window) so the two engines stay consistent.
 *   - The business object is mutated IN PLACE by the batch wrapper, which
 *     attaches `sentiment_score` (persisted, NUMERIC 4,2), `sentiment_themes`
 *     (persisted, JSONB {aspect:score}), and `sentiment_result` (debug-only
 *     full descriptor — NOT persisted; consumed by lead-score + confidence).
 *
 * BUSINESS OBJECT FIELD NAMES (snake_case)
 *   Reads:  business.top_reviews (JSONB array of {author,rating,text,time}),
 *           business.rating       (NUMERIC 2,1)
 *           business.reviews_count (INT)
 *   Writes: business.sentiment_score  (NUMERIC 4,2, -1..+1)
 *           business.sentiment_themes (JSONB {food:0.6, service:-0.3, ...})
 *           business.sentiment_result (debug descriptor — not persisted)
 *
 * PUBLIC API
 *   analyzeSentiment(text)                 → number (-1..+1)
 *   labelFromScore(score)                  → 'very_positive'|'positive'|'neutral'|'negative'|'very_negative'
 *   expectedFromRating(rating?)            → number (-1..+1)
 *   volumeConfidenceFor(reviewCount?, n)   → 'low'|'medium'|'high'|'very_high'
 *   detectAspects(text)                    → AspectSentiment[]
 *   analyzeReviews(reviews, opts?)         → SentimentResult
 *   analyzeReviewsBatch(businesses, opts?) → { total, analyzed, avgScore, byLabel, anomalies, listingsWithReviews }
 *   ENRICHMENT_COLUMNS                     → ['sentiment_score', 'sentiment_themes']
 */

// ---------------------------------------------------------------------------
// DI seam for the `sentiment` npm package (AFINN-165 based). Production loads
// `new Sentiment()` once and caches the instance. Tests inject a stub via
// `_setSentiment({ analyze(t) → { comparative, ... } })`; pass null to reset to
// the real package on the next `_loadSentiment()` call. If the package is not
// installed, `_loadSentiment()` returns null and `analyzeSentiment` degrades to
// 0 (so the rest of the aspect / anomaly logic still runs on keyword signals).
// ---------------------------------------------------------------------------
let _instance = null; // cached Sentiment instance (production) or injected stub
let _didLoad = false; // whether we've attempted the production require

function _loadSentiment() {
  if (_didLoad) return _instance;
  _didLoad = true;
  try {
    const Sentiment = require('sentiment');
    _instance = new Sentiment();
  } catch (_e) {
    _instance = null;
  }
  return _instance;
}

// Test hook: inject a stub instance (any object with .analyze(text)). Pass null
// to force a re-load from the package on the next _loadSentiment() call.
function _setSentiment(stub) {
  _instance = stub || null;
  _didLoad = stub != null;
}

const __version = 1;

const ENRICHMENT_COLUMNS = ['sentiment_score', 'sentiment_themes'];

// ---------------------------------------------------------------------------
// Aspect lexicon — { word: { aspect, polarity } }
//
// polarity ∈ [-3, +3]; 0 marks a neutral "topic marker" (e.g. pizza, staff)
// which flags the aspect as discussed without contributing sentiment. Words
// are lowercased and stripped of non-alphanumerics before lookup, so only
// [a-z0-9'-] tokens appear here. A word maps to exactly ONE aspect.
//
// Aspect set (8): food, service, price, cleanliness, atmosphere, wait, value,
// location. Ported from the dashboard's sentiment lexicon, adapted so speed
// words (fast/slow/quick) land in `wait` and freshness words (fresh/stale)
// land in `cleanliness` per the Phase 3.7 spec.
// ---------------------------------------------------------------------------
const ASPECTS = [
  'food', 'service', 'price', 'cleanliness',
  'atmosphere', 'wait', 'value', 'location',
];

const WORD_LEXICON = {
  // ── food / taste ────────────────────────────────────────────────────────
  food: { aspect: 'food', polarity: 0 },
  pizza: { aspect: 'food', polarity: 0 },
  burger: { aspect: 'food', polarity: 0 },
  burgers: { aspect: 'food', polarity: 0 },
  taste: { aspect: 'food', polarity: 0 },
  tasty: { aspect: 'food', polarity: 2 },
  flavor: { aspect: 'food', polarity: 0 },
  flavorless: { aspect: 'food', polarity: -2 },
  flavorful: { aspect: 'food', polarity: 2 },
  tasteless: { aspect: 'food', polarity: -2 },
  delicious: { aspect: 'food', polarity: 3 },
  meal: { aspect: 'food', polarity: 0 },
  meals: { aspect: 'food', polarity: 0 },
  dish: { aspect: 'food', polarity: 0 },
  dishes: { aspect: 'food', polarity: 0 },
  cuisine: { aspect: 'food', polarity: 0 },
  comforting: { aspect: 'food', polarity: 2 },
  seasoned: { aspect: 'food', polarity: 1 },
  authentic: { aspect: 'food', polarity: 2 },
  homemade: { aspect: 'food', polarity: 2 },
  mediocre: { aspect: 'food', polarity: -2 },
  pasta: { aspect: 'food', polarity: 0 },
  steak: { aspect: 'food', polarity: 0 },
  soup: { aspect: 'food', polarity: 0 },
  salad: { aspect: 'food', polarity: 0 },
  dessert: { aspect: 'food', polarity: 0 },
  coffee: { aspect: 'food', polarity: 0 },
  menu: { aspect: 'food', polarity: 0 },
  portion: { aspect: 'food', polarity: 0 },
  portions: { aspect: 'food', polarity: 0 },
  spicy: { aspect: 'food', polarity: 1 },
  crispy: { aspect: 'food', polarity: 1 },
  juicy: { aspect: 'food', polarity: 1 },
  tender: { aspect: 'food', polarity: 1 },
  flaky: { aspect: 'food', polarity: 1 },
  rich: { aspect: 'food', polarity: 1 },
  hot: { aspect: 'food', polarity: 1 },
  cold: { aspect: 'food', polarity: -2 },
  bland: { aspect: 'food', polarity: -2 },
  greasy: { aspect: 'food', polarity: -1 },
  dry: { aspect: 'food', polarity: -2 },
  soggy: { aspect: 'food', polarity: -2 },
  burnt: { aspect: 'food', polarity: -2 },
  undercooked: { aspect: 'food', polarity: -2 },
  overcooked: { aspect: 'food', polarity: -2 },
  raw: { aspect: 'food', polarity: -2 },

  // ── service / staff ─────────────────────────────────────────────────────
  service: { aspect: 'service', polarity: 0 },
  staff: { aspect: 'service', polarity: 0 },
  waiter: { aspect: 'service', polarity: 0 },
  waitress: { aspect: 'service', polarity: 0 },
  server: { aspect: 'service', polarity: 0 },
  manager: { aspect: 'service', polarity: 0 },
  chef: { aspect: 'service', polarity: 0 },
  cook: { aspect: 'service', polarity: 0 },
  bartender: { aspect: 'service', polarity: 0 },
  employees: { aspect: 'service', polarity: 0 },
  friendly: { aspect: 'service', polarity: 2 },
  helpful: { aspect: 'service', polarity: 2 },
  professional: { aspect: 'service', polarity: 2 },
  attentive: { aspect: 'service', polarity: 2 },
  responsive: { aspect: 'service', polarity: 2 },
  knowledgeable: { aspect: 'service', polarity: 2 },
  polite: { aspect: 'service', polarity: 2 },
  courteous: { aspect: 'service', polarity: 2 },
  welcoming: { aspect: 'service', polarity: 2 },
  skilled: { aspect: 'service', polarity: 2 },
  thorough: { aspect: 'service', polarity: 2 },
  gentle: { aspect: 'service', polarity: 2 },
  greeted: { aspect: 'service', polarity: 1 },
  rude: { aspect: 'service', polarity: -3 },
  annoyed: { aspect: 'service', polarity: -2 },
  ignored: { aspect: 'service', polarity: -2 },
  unhelpful: { aspect: 'service', polarity: -2 },
  impolite: { aspect: 'service', polarity: -2 },
  disrespectful: { aspect: 'service', polarity: -2 },
  dismissive: { aspect: 'service', polarity: -2 },

  // ── price ───────────────────────────────────────────────────────────────
  price: { aspect: 'price', polarity: 0 },
  prices: { aspect: 'price', polarity: 0 },
  cost: { aspect: 'price', polarity: 0 },
  costly: { aspect: 'price', polarity: -2 },
  bill: { aspect: 'price', polarity: 0 },
  fee: { aspect: 'price', polarity: 0 },
  fees: { aspect: 'price', polarity: 0 },
  pricing: { aspect: 'price', polarity: 0 },
  expensive: { aspect: 'price', polarity: -1 },
  overpriced: { aspect: 'price', polarity: -2 },
  pricey: { aspect: 'price', polarity: -1 },
  pricy: { aspect: 'price', polarity: -1 },
  charged: { aspect: 'price', polarity: -2 },
  quoted: { aspect: 'price', polarity: -1 },
  unreasonable: { aspect: 'price', polarity: -2 },
  cheap: { aspect: 'price', polarity: 1 },
  affordable: { aspect: 'price', polarity: 2 },
  inexpensive: { aspect: 'price', polarity: 2 },
  reasonable: { aspect: 'price', polarity: 2 },
  fair: { aspect: 'price', polarity: 2 },

  // ── cleanliness ─────────────────────────────────────────────────────────
  hygiene: { aspect: 'cleanliness', polarity: 0 },
  hygienic: { aspect: 'cleanliness', polarity: 2 },
  sanitary: { aspect: 'cleanliness', polarity: 2 },
  unsanitary: { aspect: 'cleanliness', polarity: -3 },
  clean: { aspect: 'cleanliness', polarity: 2 },
  spotless: { aspect: 'cleanliness', polarity: 3 },
  tidy: { aspect: 'cleanliness', polarity: 1 },
  neat: { aspect: 'cleanliness', polarity: 1 },
  fresh: { aspect: 'cleanliness', polarity: 2 },
  dirty: { aspect: 'cleanliness', polarity: -3 },
  disgusting: { aspect: 'cleanliness', polarity: -3 },
  messy: { aspect: 'cleanliness', polarity: -2 },
  filthy: { aspect: 'cleanliness', polarity: -3 },
  grimy: { aspect: 'cleanliness', polarity: -2 },
  dusty: { aspect: 'cleanliness', polarity: -1 },
  unclean: { aspect: 'cleanliness', polarity: -2 },
  unkempt: { aspect: 'cleanliness', polarity: -2 },
  stale: { aspect: 'cleanliness', polarity: -2 },

  // ── atmosphere ──────────────────────────────────────────────────────────
  atmosphere: { aspect: 'atmosphere', polarity: 0 },
  ambiance: { aspect: 'atmosphere', polarity: 0 },
  ambience: { aspect: 'atmosphere', polarity: 0 },
  vibe: { aspect: 'atmosphere', polarity: 0 },
  vibes: { aspect: 'atmosphere', polarity: 0 },
  decor: { aspect: 'atmosphere', polarity: 0 },
  modern: { aspect: 'atmosphere', polarity: 0 },
  music: { aspect: 'atmosphere', polarity: 0 },
  lighting: { aspect: 'atmosphere', polarity: 0 },
  cozy: { aspect: 'atmosphere', polarity: 2 },
  charming: { aspect: 'atmosphere', polarity: 2 },
  serene: { aspect: 'atmosphere', polarity: 2 },
  calming: { aspect: 'atmosphere', polarity: 2 },
  gorgeous: { aspect: 'atmosphere', polarity: 3 },
  beautiful: { aspect: 'atmosphere', polarity: 2 },
  lovely: { aspect: 'atmosphere', polarity: 2 },
  historic: { aspect: 'atmosphere', polarity: 1 },
  relaxed: { aspect: 'atmosphere', polarity: 1 },
  romantic: { aspect: 'atmosphere', polarity: 2 },
  trendy: { aspect: 'atmosphere', polarity: 1 },
  quaint: { aspect: 'atmosphere', polarity: 1 },
  chaotic: { aspect: 'atmosphere', polarity: -2 },
  loud: { aspect: 'atmosphere', polarity: -1 },
  crowded: { aspect: 'atmosphere', polarity: -1 },
  disorganized: { aspect: 'atmosphere', polarity: -2 },

  // ── wait / speed ────────────────────────────────────────────────────────
  wait: { aspect: 'wait', polarity: 0 },
  waited: { aspect: 'wait', polarity: 0 },
  waiting: { aspect: 'wait', polarity: 0 },
  line: { aspect: 'wait', polarity: 0 },
  queue: { aspect: 'wait', polarity: 0 },
  reservation: { aspect: 'wait', polarity: 0 },
  appointment: { aspect: 'wait', polarity: 0 },
  fast: { aspect: 'wait', polarity: 2 },
  quick: { aspect: 'wait', polarity: 2 },
  slow: { aspect: 'wait', polarity: -2 },
  efficient: { aspect: 'wait', polarity: 2 },
  reliable: { aspect: 'wait', polarity: 2 },
  timely: { aspect: 'wait', polarity: 2 },
  prompt: { aspect: 'wait', polarity: 2 },
  delayed: { aspect: 'wait', polarity: -2 },
  delay: { aspect: 'wait', polarity: -2 },
  rushed: { aspect: 'wait', polarity: -1 },

  // ── value ───────────────────────────────────────────────────────────────
  value: { aspect: 'value', polarity: 0 },
  worth: { aspect: 'value', polarity: 2 },
  worthwhile: { aspect: 'value', polarity: 2 },
  deal: { aspect: 'value', polarity: 1 },
  bargain: { aspect: 'value', polarity: 2 },
  steal: { aspect: 'value', polarity: 2 },
  disappointing: { aspect: 'value', polarity: -2 },
  underwhelming: { aspect: 'value', polarity: -2 },
  scam: { aspect: 'value', polarity: -3 },
  fraud: { aspect: 'value', polarity: -3 },
  ripoff: { aspect: 'value', polarity: -3 },

  // ── location ────────────────────────────────────────────────────────────
  location: { aspect: 'location', polarity: 0 },
  located: { aspect: 'location', polarity: 0 },
  parking: { aspect: 'location', polarity: 0 },
  neighborhood: { aspect: 'location', polarity: 0 },
  downtown: { aspect: 'location', polarity: 0 },
  convenient: { aspect: 'location', polarity: 2 },
  accessible: { aspect: 'location', polarity: 1 },
  walkable: { aspect: 'location', polarity: 1 },
  nearby: { aspect: 'location', polarity: 1 },
  isolated: { aspect: 'location', polarity: -1 },
};

// Multi-word phrases checked before single-token lookup. Longer phrases win;
// matched spans are marked consumed so their constituent tokens aren't
// double-counted in the single-token pass (e.g. "worth it" won't also score
// "worth" separately).
const PHRASES = {
  'worth it': { aspect: 'value', polarity: 2 },
  'worth every': { aspect: 'value', polarity: 3 },
  'real deal': { aspect: 'value', polarity: 3 },
  'must try': { aspect: 'food', polarity: 3 },
  'must visit': { aspect: 'atmosphere', polarity: 3 },
  'on time': { aspect: 'wait', polarity: 2 },
  'tourist trap': { aspect: 'atmosphere', polarity: -3 },
  'never showed': { aspect: 'service', polarity: -3 },
};

// ---------------------------------------------------------------------------
// Small numeric helpers (pure)
// ---------------------------------------------------------------------------

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function round(n, digits) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

/**
 * Tokenize text into lowercase word tokens, preserving apostrophes and
 * hyphens (e.g. "don't", "kid-friendly"). Returns {word, start} pairs so the
 * caller can skip tokens whose character span was consumed by a phrase match.
 *
 * @param {string} lower — already-lowercased text
 * @returns {{ word: string, start: number }[]}
 */
function tokenizeWithPositions(lower) {
  const tokens = [];
  const re = /[a-z0-9][a-z0-9'-]*/g;
  let m;
  while ((m = re.exec(lower)) !== null) {
    tokens.push({ word: m[0], start: m.index });
  }
  return tokens;
}

function anyConsumed(consumed, from, to) {
  for (let i = from; i < to; i++) if (consumed[i]) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Core sentiment scoring
// ---------------------------------------------------------------------------

/**
 * Score a single text with the AFINN-based `sentiment` package and return its
 * normalized comparative score (-1..+1, clamped). Returns 0 for null/empty
 * input or when the package is unavailable (DI stub returned null).
 *
 * @param {string} text
 * @returns {number} -1..+1
 */
function analyzeSentiment(text) {
  if (text == null || typeof text !== 'string' || !text.trim()) return 0;
  const inst = _loadSentiment();
  if (!inst || typeof inst.analyze !== 'function') return 0;
  let result;
  try {
    result = inst.analyze(text);
  } catch (_e) {
    return 0;
  }
  if (!result || typeof result.comparative !== 'number') return 0;
  // comparative = score / tokenCount; can exceed ±1 for a single strong word
  // (e.g. "great" → 3.0), so clamp into the documented -1..+1 range.
  return clamp(result.comparative, -1, 1);
}

/**
 * Map a -1..+1 score to a 5-bucket label.
 *   >= 0.5  → very_positive
 *   >= 0.1  → positive
 *   <= -0.5 → very_negative
 *   <= -0.1 → negative
 *   else    → neutral
 *
 * @param {number} score
 * @returns {'very_positive'|'positive'|'neutral'|'negative'|'very_negative'}
 */
function labelFromScore(score) {
  if (score >= 0.5) return 'very_positive';
  if (score >= 0.1) return 'positive';
  if (score <= -0.5) return 'very_negative';
  if (score <= -0.1) return 'negative';
  return 'neutral';
}

/**
 * Map a 1-5 star rating to an expected -1..+1 sentiment: (rating-3)/2.
 * Returns 0 when no rating is supplied (rating == null / NaN).
 *
 * @param {number} [rating]
 * @returns {number} -1..+1
 */
function expectedFromRating(rating) {
  if (rating == null || typeof rating !== 'number' || Number.isNaN(rating)) return 0;
  const r = clamp(rating, 1, 5);
  return (r - 3) / 2;
}

/**
 * Volume-confidence band from review count. Falls back to the number of review
 * snippets when the business's declared reviewCount is unknown.
 *   <5        → low
 *   5-19      → medium
 *   20-99     → high
 *   100+      → very_high
 *
 * @param {number} [reviewCount] — business.reviews_count
 * @param {number} [snippets] — number of review texts actually captured
 * @returns {'low'|'medium'|'high'|'very_high'}
 */
function volumeConfidenceFor(reviewCount, snippets) {
  const n = typeof reviewCount === 'number' && !Number.isNaN(reviewCount)
    ? reviewCount
    : snippets;
  if (n == null || n === 0) return 'low';
  if (n < 5) return 'low';
  if (n < 20) return 'medium';
  if (n < 100) return 'high';
  return 'very_high';
}

// ---------------------------------------------------------------------------
// Aspect detection (keyword-based)
// ---------------------------------------------------------------------------

/**
 * Record one keyword hit into an aspect bucket.
 *
 * @param {Map} buckets — aspect → { mentions, polaritySum, polarityHits, keywords: Map<word,count> }
 * @param {string} aspect
 * @param {number} polarity
 * @param {string} keyword
 */
function recordAspect(buckets, aspect, polarity, keyword) {
  let b = buckets.get(aspect);
  if (!b) {
    b = { mentions: 0, polaritySum: 0, polarityHits: 0, keywords: new Map() };
    buckets.set(aspect, b);
  }
  b.mentions += 1;
  b.polaritySum += polarity;
  if (polarity !== 0) b.polarityHits += 1;
  b.keywords.set(keyword, (b.keywords.get(keyword) || 0) + 1);
}

function tallyKw(positiveKw, negativeKw, word, polarity) {
  if (polarity > 0) {
    const e = positiveKw.get(word) || { polarity, count: 0 };
    e.count += 1;
    positiveKw.set(word, e);
  } else if (polarity < 0) {
    const e = negativeKw.get(word) || { polarity, count: 0 };
    e.count += 1;
    negativeKw.set(word, e);
  }
}

/**
 * Scan one piece of text for aspect keywords + phrases. Returns the raw
 * per-aspect buckets plus positive/negative keyword tallies — the building
 * blocks for both `detectAspects` (single text) and `analyzeReviews`
 * (cross-review aggregation).
 *
 * @param {string} text
 * @returns {{ aspectBuckets: Map, positiveKw: Map, negativeKw: Map }}
 */
function scanText(text) {
  const aspectBuckets = new Map();
  const positiveKw = new Map();
  const negativeKw = new Map();
  if (!text || typeof text !== 'string') {
    return { aspectBuckets, positiveKw, negativeKw };
  }
  const lower = text.toLowerCase();
  const consumed = new Array(lower.length).fill(false);

  // Phrase pass — longer phrases first so "worth every" wins over "worth it".
  const phraseKeys = Object.keys(PHRASES).sort((a, b) => b.length - a.length);
  for (const phrase of phraseKeys) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      const before = idx === 0 || /\s/.test(lower[idx - 1]);
      const after = idx + phrase.length === lower.length || /\s/.test(lower[idx + phrase.length]);
      if (before && after && !anyConsumed(consumed, idx, idx + phrase.length)) {
        const entry = PHRASES[phrase];
        recordAspect(aspectBuckets, entry.aspect, entry.polarity, phrase);
        tallyKw(positiveKw, negativeKw, phrase, entry.polarity);
        for (let i = idx; i < idx + phrase.length; i++) consumed[i] = true;
      }
      idx = lower.indexOf(phrase, idx + 1);
    }
  }

  // Single-token pass — skip tokens whose char span was consumed by a phrase.
  const tokens = tokenizeWithPositions(lower);
  for (const { word, start } of tokens) {
    if (consumed[start]) continue;
    const entry = WORD_LEXICON[word];
    if (!entry) continue;
    recordAspect(aspectBuckets, entry.aspect, entry.polarity, word);
    tallyKw(positiveKw, negativeKw, word, entry.polarity);
  }

  return { aspectBuckets, positiveKw, negativeKw };
}

/**
 * Convert raw aspect buckets into the public AspectSentiment[] shape.
 * Only aspects with ≥1 mention are returned, sorted by mentions desc.
 *
 * Aspect score = tanh(polaritySum / (polarityHits * 3)) — a faithful port of
 * the dashboard's `squash(avg * 2)` where avg = sum/hits and max |polarity| = 3.
 * Neutral markers (polarity 0) count toward `mentions` but don't dilute the
 * score (the average runs over polarity hits only). When an aspect has only
 * neutral markers, its score is 0 (neutral).
 *
 * @param {Map} buckets
 * @returns {AspectSentiment[]}
 */
function bucketsToAspects(buckets) {
  const out = [];
  for (const [aspect, b] of buckets) {
    if (b.mentions < 1) continue;
    const score = b.polarityHits > 0
      ? clamp(Math.tanh(b.polaritySum / (b.polarityHits * 3)), -1, 1)
      : 0;
    out.push({
      aspect,
      label: labelFromScore(score),
      score: round(score, 3),
      mentions: b.mentions,
      keywords: topKeywordsByCount(b.keywords, 4),
    });
  }
  out.sort((a, b) => b.mentions - a.mentions);
  return out;
}

function topKeywordsByCount(kwMap, limit) {
  return Array.from(kwMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map((e) => e[0]);
}

/**
 * Detect aspect sentiment in a single text. Returns one AspectSentiment per
 * aspect with ≥1 keyword mention, sorted by mention count desc.
 *
 * @param {string} text
 * @returns {AspectSentiment[]}
 */
function detectAspects(text) {
  const { aspectBuckets } = scanText(text);
  return bucketsToAspects(aspectBuckets);
}

// ---------------------------------------------------------------------------
// Aggregation across reviews
// ---------------------------------------------------------------------------

function mergeBuckets(dest, src) {
  for (const [aspect, b] of src) {
    let d = dest.get(aspect);
    if (!d) {
      d = { mentions: 0, polaritySum: 0, polarityHits: 0, keywords: new Map() };
      dest.set(aspect, d);
    }
    d.mentions += b.mentions;
    d.polaritySum += b.polaritySum;
    d.polarityHits += b.polarityHits;
    for (const [kw, c] of b.keywords) {
      d.keywords.set(kw, (d.keywords.get(kw) || 0) + c);
    }
  }
}

function mergeKw(dest, src) {
  for (const [word, e] of src) {
    const d = dest.get(word) || { polarity: e.polarity, count: 0 };
    d.count += e.count;
    dest.set(word, d);
  }
}

/**
 * Top `limit` keywords by polarity magnitude (|polarity| desc, then count desc
 * as tiebreaker). Each keyword appears at most once.
 *
 * @param {Map} kwMap — word → { polarity, count }
 * @param {number} limit
 * @returns {string[]}
 */
function topKwByPolarity(kwMap, limit) {
  return Array.from(kwMap.entries())
    .sort((a, b) => Math.abs(b[1].polarity) - Math.abs(a[1].polarity) || b[1].count - a[1].count)
    .slice(0, limit)
    .map((e) => e[0]);
}

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

/**
 * Build the anomaly list for a sentiment result. Ports the dashboard's
 * buildAnomalies: rating/review mismatch (medium + high), perfect-rating /
 * low-volume, uniformly-perfect short reviews. `no_reviews` is emitted by the
 * caller in the empty-reviews branch.
 *
 * @param {object} args — { rating, reviewCount, reviews, score, label, ratingConsistency }
 * @returns {SentimentAnomaly[]}
 */
function buildAnomalies(args) {
  const out = [];
  const { rating, reviewCount, reviews, score, label, ratingConsistency } = args;
  const effectiveCount = reviewCount != null ? reviewCount : reviews.length;

  if (ratingConsistency === 'severe_mismatch') {
    out.push({
      code: 'rating_review_mismatch_high',
      label: 'Severe rating / review mismatch',
      detail:
        'The ' + rating.toFixed(1) + '★ rating implies strong positive sentiment, but the review ' +
        'text reads ' + label.replace(/_/g, ' ') + '. This is a classic fake-listing tell.',
      severity: 'high',
    });
  } else if (ratingConsistency === 'mismatch') {
    out.push({
      code: 'rating_review_mismatch',
      label: 'Rating / review mismatch',
      detail:
        'The ' + rating.toFixed(1) + '★ rating and the review-derived sentiment diverge ' +
        'noticeably — worth a manual review.',
      severity: 'medium',
    });
  }

  // Perfect rating with almost no reviews.
  if (rating != null && rating >= 4.8 && effectiveCount <= 5) {
    out.push({
      code: 'extreme_rating_low_volume',
      label: 'Perfect rating, almost no reviews',
      detail:
        'Rating ' + rating.toFixed(1) + ' with only ' + effectiveCount + ' review(s) is ' +
        'statistically fragile and a common fingerprint of seeded fake listings.',
      severity: 'high',
    });
  }

  // Uniformly perfect short reviews — all under 6 words, all glowing, low volume.
  const shortPositive = reviews.filter((r) => r.text.trim().split(/\s+/).length < 6);
  if (
    reviews.length >= 1 &&
    shortPositive.length === reviews.length &&
    score > 0.2 &&
    effectiveCount <= 5
  ) {
    out.push({
      code: 'uniformly_perfect_reviews',
      label: 'Uniformly perfect short reviews',
      detail:
        'Every review is under 6 words and glowing — the kind of generic, interchangeable ' +
        'praise typical of purchased or self-written fake reviews.',
      severity: 'medium',
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Public API — single business
// ---------------------------------------------------------------------------

/**
 * Analyze a set of reviews for composite sentiment, aspect breakdown, and
 * rating consistency.
 *
 * @param {Array<{ text?: string, rating?: number }>} reviews — the scraper's
 *   top_reviews JSONB shape (pg driver delivers it as a JS array already).
 * @param {object} [opts] — { rating: business.rating, reviewCount: business.reviews_count }
 * @returns {SentimentResult}
 */
function analyzeReviews(reviews, opts) {
  const o = opts || {};
  const rating = typeof o.rating === 'number' && !Number.isNaN(o.rating) ? o.rating : undefined;
  const reviewCountHint = typeof o.reviewCount === 'number' && !Number.isNaN(o.reviewCount)
    ? o.reviewCount
    : undefined;

  const list = Array.isArray(reviews) ? reviews : [];
  const valid = list.filter(
    (r) => r && typeof r === 'object' && typeof r.text === 'string' && r.text.trim().length > 0
  );

  const expected = expectedFromRating(rating);

  // No reviews → neutral with a low-confidence anomaly (and a possible
  // extreme_rating_low_volume flag if the rating is suspiciously perfect).
  if (valid.length === 0) {
    const anomalies = [
      {
        code: 'no_reviews',
        label: 'No review text',
        detail:
          'No review snippets were captured for this listing, so review-derived ' +
          'sentiment is unavailable.',
        severity: 'info',
      },
    ];
    if (rating != null && rating >= 4.8 && (reviewCountHint || 0) <= 5) {
      anomalies.push({
        code: 'extreme_rating_low_volume',
        label: 'Perfect rating, almost no reviews',
        detail:
          'Rating ' + rating.toFixed(1) + ' with only ' + (reviewCountHint || 0) + ' review(s) ' +
          'is an unreliable signal — common in freshly seeded fake listings.',
        severity: 'high',
      });
    }
    return {
      reviewCount: 0,
      score: 0,
      label: 'neutral',
      aspects: [],
      topPositive: [],
      topNegative: [],
      volumeConfidence: 'low',
      expectedFromRating: round(expected, 3),
      ratingConsistency: 'unknown',
      anomalies,
    };
  }

  // Per-review AFINN scores + cross-review aspect / keyword aggregation.
  const perReviewScores = [];
  const aspectAgg = new Map();
  const positiveKwAgg = new Map();
  const negativeKwAgg = new Map();

  for (const review of valid) {
    perReviewScores.push(analyzeSentiment(review.text));
    const { aspectBuckets, positiveKw, negativeKw } = scanText(review.text);
    mergeBuckets(aspectAgg, aspectBuckets);
    mergeKw(positiveKwAgg, positiveKw);
    mergeKw(negativeKwAgg, negativeKw);
  }

  const score = clamp(
    perReviewScores.reduce((a, b) => a + b, 0) / perReviewScores.length,
    -1,
    1
  );
  const label = labelFromScore(score);
  const aspects = bucketsToAspects(aspectAgg);
  const topPositive = topKwByPolarity(positiveKwAgg, 5);
  const topNegative = topKwByPolarity(negativeKwAgg, 5);

  // Rating consistency — |expected - actual| thresholds.
  let ratingConsistency;
  if (rating == null) {
    ratingConsistency = 'unknown';
  } else {
    const diff = Math.abs(score - expected);
    if (diff < 0.3) ratingConsistency = 'consistent';
    else if (diff < 0.6) ratingConsistency = 'mismatch';
    else ratingConsistency = 'severe_mismatch';
  }

  const volumeConfidence = volumeConfidenceFor(reviewCountHint, valid.length);

  const anomalies = buildAnomalies({
    rating,
    reviewCount: reviewCountHint,
    reviews: valid,
    score,
    label,
    ratingConsistency,
  });

  return {
    reviewCount: valid.length,
    score: round(score, 3),
    label,
    aspects,
    topPositive,
    topNegative,
    volumeConfidence,
    expectedFromRating: round(expected, 3),
    ratingConsistency,
    anomalies,
  };
}

// ---------------------------------------------------------------------------
// Batch wrapper
// ---------------------------------------------------------------------------

/**
 * Build the persisted sentiment_themes JSONB object: { aspect: score } for
 * each aspect with ≥1 mention.
 *
 * @param {AspectSentiment[]} aspects
 * @returns {Object<string, number>}
 */
function aspectsToThemes(aspects) {
  const themes = {};
  for (const a of aspects) themes[a.aspect] = a.score;
  return themes;
}

/**
 * Run sentiment analysis across a batch of businesses IN PLACE. Each business
 * is mutated with:
 *   - sentiment_score  (NUMERIC 4,2, -1..+1) — persisted
 *   - sentiment_themes (JSONB {aspect:score}) — persisted
 *   - sentiment_result (full SentimentResult) — debug only, NOT persisted;
 *     consumed by Phase 3.9 lead-score and Phase 3.10 confidence
 *
 * Reads business.top_reviews (JSONB array), business.rating, business.reviews_count.
 *
 * @param {object[]} businesses — mutated in place.
 * @param {object} [opts] — { logger } (reserved for future use)
 * @returns {{ total: number, analyzed: number, avgScore: number, byLabel: object, anomalies: number, listingsWithReviews: number }}
 */
function analyzeReviewsBatch(businesses, opts) {
  const list = Array.isArray(businesses) ? businesses : [];
  const stats = {
    total: list.length,
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
  };

  let scoreSum = 0;
  let scoreCount = 0;

  for (const business of list) {
    if (!business || typeof business !== 'object') continue;
    stats.analyzed++;

    const topReviews = Array.isArray(business.top_reviews) ? business.top_reviews : [];
    const rating = typeof business.rating === 'number' && !Number.isNaN(business.rating)
      ? business.rating
      : undefined;
    const reviewCount = typeof business.reviews_count === 'number' && !Number.isNaN(business.reviews_count)
      ? business.reviews_count
      : undefined;

    const result = analyzeReviews(topReviews, { rating, reviewCount });

    // Persisted columns.
    business.sentiment_score = round(result.score, 2); // NUMERIC(4,2)
    business.sentiment_themes = aspectsToThemes(result.aspects); // JSONB {aspect:score}
    // Debug descriptor (NOT persisted — feeds lead-score + confidence).
    business.sentiment_result = result;

    if (result.reviewCount > 0) {
      stats.listingsWithReviews++;
      scoreSum += result.score;
      scoreCount++;
    }
    if (Object.prototype.hasOwnProperty.call(stats.byLabel, result.label)) {
      stats.byLabel[result.label]++;
    }
    stats.anomalies += result.anomalies.length;
  }

  // avgScore is the mean over businesses that actually had reviews — no-review
  // businesses (score 0) would otherwise drag the average toward neutral.
  stats.avgScore = scoreCount > 0 ? round(scoreSum / scoreCount, 3) : 0;
  return stats;
}

module.exports = {
  __version,
  ENRICHMENT_COLUMNS,
  // Core API
  analyzeSentiment,
  labelFromScore,
  expectedFromRating,
  volumeConfidenceFor,
  detectAspects,
  analyzeReviews,
  analyzeReviewsBatch,
  // Test seam
  _loadSentiment,
  _setSentiment,
  // Lexicon / constants (for tests + extension)
  ASPECTS,
  WORD_LEXICON,
  PHRASES,
};
