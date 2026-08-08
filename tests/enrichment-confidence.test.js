'use strict';

/**
 * tests/enrichment-confidence.test.js — Phase 3.10 — Confidence (Evidence Depth)
 *
 * Confidence is DISTINCT from the Phase 3.9 lead score: the lead score says
 * "how attractive is this listing?"; confidence says "how much evidence
 * underpins that score?". A 5.0★ listing with zero reviews and no website
 * could be a fantastic lead or could be spam — the lead score can't tell the
 * two apart, but confidence surfaces the uncertainty.
 *
 * Coverage (per PHASE3_EXECUTION_PLAN.md §3.10 + Task 3.13 spec):
 *   - bandForConfidence: 5 bands + boundary scores (0, 19, 20, 39, 40, 59, 60, 79, 80, 100)
 *   - BAND_LABELS, TOTAL_SIGNALS, ENRICHMENT_COLUMNS, __version constants
 *   - fieldConfidence: per-field weights for name/phone/address/website/rating/
 *     reviews_count/lat/lng/category + default, with present/missing/invalid variants
 *   - computeConfidence: strong / sparse / spam-flagged / invalid-phone /
 *     rating-review-mismatch / live-vs-dead-website / clamping / factors
 *     structure / signal coverage / missingFields
 *   - recordConfidence: 0–1 normalization (score/100), distinct from 0–100 score
 *   - computeConfidenceBatch: in-place mutation + stats shape + empty batch +
 *     non-array + null entries + logger
 *   - Verified-vs-unverified-email: the module does NOT read email/email_status
 *     — assert identical scores (documented limitation for the integration test)
 *
 * All tests are pure (no network, no DB, no filesystem). Deterministic.
 *
 * Run: bun test tests/enrichment-confidence.test.js
 */

const {
  __version,
  ENRICHMENT_COLUMNS,
  TOTAL_SIGNALS,
  BAND_LABELS,
  fieldConfidence,
  recordConfidence,
  computeConfidence,
  computeConfidenceBatch,
  bandForConfidence,
} = require('../src/enrichment/confidence');

// ---------------------------------------------------------------------------
// Helpers — fixture builders (return fresh copies so tests can't leak state)
// ---------------------------------------------------------------------------

function strongBusiness() {
  return {
    name: 'Cafe Berlin',
    phone: '+49 30 12345678',
    phone_e164: '+493012345678',
    phone_normalized: { isValid: true },
    address: 'Friedrichstraße 100, 10117 Berlin, Germany',
    address_street: 'Friedrichstraße 100',
    address_city: 'Berlin',
    address_state: 'BE',
    lat: 52.5076,
    lng: 13.3904,
    geocode_confidence: 0.95,
    website: 'https://cafe-berlin.de',
    website_liveness: 'live',
    rating: 4.6,
    reviews_count: 250,
    sentiment_result: { reviewCount: 250, ratingConsistency: 'consistent' },
    tech_stack_result: { sophisticationScore: 75 },
    spam_result: { isSpam: false, riskLevel: 'low', spamScore: 5 },
    lead_score: 88,
  };
}

function sparseBusiness() {
  return { name: 'Mystery Spot' };
}

// ---------------------------------------------------------------------------
// 1. bandForConfidence — boundaries
// ---------------------------------------------------------------------------

describe('Phase 3.10 — bandForConfidence boundaries', () => {
  test('score 0 → very_low', () => {
    expect(bandForConfidence(0)).toBe('very_low');
  });
  test('score 19 → very_low (just below low threshold)', () => {
    expect(bandForConfidence(19)).toBe('very_low');
  });
  test('score 20 → low (low band lower bound, inclusive)', () => {
    expect(bandForConfidence(20)).toBe('low');
  });
  test('score 39 → low (just below medium threshold)', () => {
    expect(bandForConfidence(39)).toBe('low');
  });
  test('score 40 → medium', () => {
    expect(bandForConfidence(40)).toBe('medium');
  });
  test('score 59 → medium (just below high threshold)', () => {
    expect(bandForConfidence(59)).toBe('medium');
  });
  test('score 60 → high', () => {
    expect(bandForConfidence(60)).toBe('high');
  });
  test('score 79 → high (just below very_high threshold)', () => {
    expect(bandForConfidence(79)).toBe('high');
  });
  test('score 80 → very_high (very_high lower bound, inclusive)', () => {
    expect(bandForConfidence(80)).toBe('very_high');
  });
  test('score 100 → very_high (upper bound)', () => {
    expect(bandForConfidence(100)).toBe('very_high');
  });
});

// ---------------------------------------------------------------------------
// 2. Module constants
// ---------------------------------------------------------------------------

describe('Phase 3.10 — module constants', () => {
  test('BAND_LABELS has all 5 bands with string labels', () => {
    expect(Object.keys(BAND_LABELS).sort()).toEqual(
      ['high', 'low', 'medium', 'very_high', 'very_low'],
    );
    for (const k of Object.keys(BAND_LABELS)) {
      expect(typeof BAND_LABELS[k]).toBe('string');
      expect(BAND_LABELS[k].length).toBeGreaterThan(0);
    }
  });
  test('TOTAL_SIGNALS === 8 (phone/address/dedup/spam/tech/sentiment/geo/lead)', () => {
    expect(TOTAL_SIGNALS).toBe(8);
  });
  test("ENRICHMENT_COLUMNS === ['confidence_score']", () => {
    expect(ENRICHMENT_COLUMNS).toEqual(['confidence_score']);
  });
  test('__version is a positive number', () => {
    expect(typeof __version).toBe('number');
    expect(__version).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. fieldConfidence — per-field weights (name / phone / address / website + extras)
// ---------------------------------------------------------------------------

describe('Phase 3.10 — fieldConfidence: name', () => {
  test('present name → 0.95', () => {
    expect(fieldConfidence({ name: 'Cafe Berlin' }, 'name')).toBe(0.95);
  });
  test('missing name → 0.3', () => {
    expect(fieldConfidence({}, 'name')).toBe(0.3);
  });
  test('whitespace-only name is treated as missing → 0.3', () => {
    expect(fieldConfidence({ name: '   ' }, 'name')).toBe(0.3);
  });
});

describe('Phase 3.10 — fieldConfidence: phone', () => {
  test('valid phone (phone_normalized.isValid=true) → 0.9', () => {
    expect(
      fieldConfidence({ phone: '+493012345678', phone_normalized: { isValid: true } }, 'phone'),
    ).toBe(0.9);
  });
  test('valid phone (phone_e164 present, no descriptor) → 0.9', () => {
    expect(fieldConfidence({ phone: '+493012345678', phone_e164: '+493012345678' }, 'phone')).toBe(0.9);
  });
  test('missing phone → 0.3', () => {
    expect(fieldConfidence({}, 'phone')).toBe(0.3);
  });
  test('invalid phone (phone_normalized.isValid=false) → 0.5', () => {
    expect(
      fieldConfidence({ phone: '12345', phone_normalized: { isValid: false } }, 'phone'),
    ).toBe(0.5);
  });
});

describe('Phase 3.10 — fieldConfidence: address', () => {
  test('geocoded (lat+lng+gc>=0.7) → 0.9', () => {
    expect(
      fieldConfidence({ lat: 52.5, lng: 13.4, geocode_confidence: 0.85 }, 'address'),
    ).toBe(0.9);
  });
  test('parsed address (street) without coords → 0.6', () => {
    expect(fieldConfidence({ address_street: 'Friedrichstraße 100' }, 'address')).toBe(0.6);
  });
  test('raw address string only → 0.3', () => {
    expect(fieldConfidence({ address: 'Some address' }, 'address')).toBe(0.3);
  });
  test('nothing → 0.3', () => {
    expect(fieldConfidence({}, 'address')).toBe(0.3);
  });
});

describe('Phase 3.10 — fieldConfidence: website', () => {
  test('live website → 0.85', () => {
    expect(fieldConfidence({ website: 'https://x.de', website_liveness: 'live' }, 'website')).toBe(0.85);
  });
  test('dead website → 0.5', () => {
    expect(fieldConfidence({ website: 'https://x.de', website_liveness: 'dead' }, 'website')).toBe(0.5);
  });
  test('error website → 0.5', () => {
    expect(fieldConfidence({ website: 'https://x.de', website_liveness: 'error' }, 'website')).toBe(0.5);
  });
  test('unverified website (liveness unset) → 0.4', () => {
    expect(fieldConfidence({ website: 'https://x.de' }, 'website')).toBe(0.4);
  });
  test('missing website → 0.2', () => {
    expect(fieldConfidence({}, 'website')).toBe(0.2);
  });
});

describe('Phase 3.10 — fieldConfidence: rating / reviews_count / lat-lng / category / default', () => {
  test('rating with reviews_count >= 20 → 0.8', () => {
    expect(fieldConfidence({ rating: 4.5, reviews_count: 25 }, 'rating')).toBe(0.8);
  });
  test('rating with reviews_count in [5,20) → 0.5', () => {
    expect(fieldConfidence({ rating: 4.5, reviews_count: 7 }, 'rating')).toBe(0.5);
  });
  test('rating with reviews_count < 5 → 0.2 (low-volume ratings are noisy)', () => {
    expect(fieldConfidence({ rating: 4.5, reviews_count: 2 }, 'rating')).toBe(0.2);
  });
  test('missing rating → 0.2', () => {
    expect(fieldConfidence({}, 'rating')).toBe(0.2);
  });
  test('reviews_count present → 0.9 / missing → 0.3', () => {
    expect(fieldConfidence({ reviews_count: 100 }, 'reviews_count')).toBe(0.9);
    expect(fieldConfidence({}, 'reviews_count')).toBe(0.3);
  });
  test('lat with geocode_confidence >= 0.7 → 0.9', () => {
    expect(fieldConfidence({ lat: 52.5, lng: 13.4, geocode_confidence: 0.8 }, 'lat')).toBe(0.9);
  });
  test('lng mirrors lat (same case block) → 0.9', () => {
    expect(fieldConfidence({ lat: 52.5, lng: 13.4, geocode_confidence: 0.8 }, 'lng')).toBe(0.9);
  });
  test('coords with no geocode_confidence and no geo_result → 0.7 (raw-scrape assumption)', () => {
    expect(fieldConfidence({ lat: 52.5, lng: 13.4 }, 'lat')).toBe(0.7);
  });
  test('no coords → 0 (both lat and lng)', () => {
    expect(fieldConfidence({}, 'lat')).toBe(0);
    expect(fieldConfidence({}, 'lng')).toBe(0);
  });
  test('category present → 0.9 / missing → 0.3', () => {
    expect(fieldConfidence({ category: 'Cafe' }, 'category')).toBe(0.9);
    expect(fieldConfidence({}, 'category')).toBe(0.3);
  });
  test('unknown field name → 0.5 default', () => {
    expect(fieldConfidence({ foo: 'bar' }, 'foo')).toBe(0.5);
  });
  test('null business / missing field arg → 0.5', () => {
    expect(fieldConfidence(null, 'name')).toBe(0.5);
    expect(fieldConfidence({}, '')).toBe(0.5);
    expect(fieldConfidence({}, null)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// 4. computeConfidence — strong business (everything good)
// ---------------------------------------------------------------------------

describe('Phase 3.10 — computeConfidence: strong business', () => {
  const result = computeConfidence(strongBusiness());

  test('score is >= 80 (very_high band threshold)', () => {
    expect(result.score).toBeGreaterThanOrEqual(80);
  });
  test('band is very_high', () => {
    expect(result.band).toBe('very_high');
  });
  test('score is clamped to <= 100', () => {
    expect(result.score).toBeLessThanOrEqual(100);
  });
  test('missingFields is empty (all raw fields present)', () => {
    expect(result.missingFields).toEqual([]);
  });
  test('signalCoverage is high (>= 0.6) and <= 1', () => {
    expect(result.signalCoverage).toBeGreaterThanOrEqual(0.6);
    expect(result.signalCoverage).toBeLessThanOrEqual(1);
  });
  test('factors include positive HAS_* deltas (phone/geocode/live-website/reviews)', () => {
    const codes = result.factors.map((f) => f.code);
    expect(codes).toContain('HAS_PHONE');
    expect(codes).toContain('HAS_VALID_PHONE');
    expect(codes).toContain('HAS_GEOCODE');
    expect(codes).toContain('HAS_LIVE_WEBSITE');
    expect(codes).toContain('HAS_REVIEWS');
  });
  test('no MISSING_* / SPAM_FLAGGED / INVALID_PHONE factors for the strong business', () => {
    const codes = result.factors.map((f) => f.code);
    expect(codes).not.toContain('MISSING_PHONE');
    expect(codes).not.toContain('MISSING_ADDRESS');
    expect(codes).not.toContain('MISSING_GEOCODE');
    expect(codes).not.toContain('MISSING_WEBSITE');
    expect(codes).not.toContain('SPAM_FLAGGED');
    expect(codes).not.toContain('INVALID_PHONE');
  });
  test('note is a non-empty string mentioning the band label', () => {
    expect(typeof result.note).toBe('string');
    expect(result.note.length).toBeGreaterThan(0);
    expect(result.note).toContain(BAND_LABELS[result.band]);
  });
});

// ---------------------------------------------------------------------------
// 5. computeConfidence — sparse business (only name)
// ---------------------------------------------------------------------------

describe('Phase 3.10 — computeConfidence: sparse business', () => {
  const result = computeConfidence(sparseBusiness());

  test('score is low (< 20 → very_low band)', () => {
    expect(result.score).toBeLessThan(20);
  });
  test('band is very_low or low', () => {
    expect(['very_low', 'low']).toContain(result.band);
  });
  test('missingFields includes phone/website/address/reviews/lat-lng', () => {
    expect(result.missingFields).toContain('phone');
    expect(result.missingFields).toContain('website');
    expect(result.missingFields).toContain('address');
    expect(result.missingFields).toContain('reviews');
    expect(result.missingFields).toContain('lat/lng');
  });
  test('missingFields does NOT include name (name is present)', () => {
    expect(result.missingFields).not.toContain('name');
  });
  test('signalCoverage is 0 (no pipeline descriptors present)', () => {
    expect(result.signalCoverage).toBe(0);
  });
  test('factors include all four MISSING_* negative deltas', () => {
    const codes = result.factors.map((f) => f.code);
    expect(codes).toContain('MISSING_PHONE');
    expect(codes).toContain('MISSING_ADDRESS');
    expect(codes).toContain('MISSING_GEOCODE');
    expect(codes).toContain('MISSING_WEBSITE');
  });
});

// ---------------------------------------------------------------------------
// 6. computeConfidence — spam-flagged business
// ---------------------------------------------------------------------------

describe('Phase 3.10 — computeConfidence: spam-flagged business', () => {
  test('SPAM_FLAGGED factor fires for isSpam=true with negative delta', () => {
    const result = computeConfidence({
      name: 'Spammy',
      spam_result: { isSpam: true, riskLevel: 'high', spamScore: 92 },
    });
    const spam = result.factors.find((f) => f.code === 'SPAM_FLAGGED');
    expect(spam).toBeDefined();
    expect(spam.delta).toBeLessThan(0);
    expect(spam.impact).toBe('negative');
  });
  test('spam-flagged business scores lower than an identical non-spam business', () => {
    const base = { name: 'X' };
    const clean = computeConfidence(base);
    const flagged = computeConfidence({
      ...base,
      spam_result: { isSpam: true, riskLevel: 'high', spamScore: 92 },
    });
    expect(flagged.score).toBeLessThan(clean.score);
  });
  test('riskLevel "critical" also triggers SPAM_FLAGGED; "low" does NOT', () => {
    const critical = computeConfidence({
      name: 'X',
      spam_result: { riskLevel: 'critical', spamScore: 99 },
    });
    const low = computeConfidence({
      name: 'X',
      spam_result: { riskLevel: 'low', spamScore: 5 },
    });
    expect(critical.factors.map((f) => f.code)).toContain('SPAM_FLAGGED');
    expect(low.factors.map((f) => f.code)).not.toContain('SPAM_FLAGGED');
  });
});

// ---------------------------------------------------------------------------
// 7. computeConfidence — invalid phone
// ---------------------------------------------------------------------------

describe('Phase 3.10 — computeConfidence: invalid phone', () => {
  test('INVALID_PHONE factor fires (delta -12) when phone_type=invalid', () => {
    const result = computeConfidence({
      name: 'Bad Phone',
      phone: '12345',
      phone_type: 'invalid',
      phone_normalized: { isValid: false },
    });
    const inv = result.factors.find((f) => f.code === 'INVALID_PHONE');
    expect(inv).toBeDefined();
    expect(inv.delta).toBe(-12);
    expect(inv.impact).toBe('negative');
  });
  test('HAS_PHONE still fires for an invalid phone; HAS_VALID_PHONE does NOT', () => {
    const result = computeConfidence({
      name: 'Bad Phone',
      phone: '12345',
      phone_type: 'invalid',
    });
    const codes = result.factors.map((f) => f.code);
    expect(codes).toContain('HAS_PHONE');
    expect(codes).not.toContain('HAS_VALID_PHONE');
  });
  test('invalid phone scores lower than valid phone with identical other fields', () => {
    const invalid = computeConfidence({
      name: 'X',
      phone: '123',
      phone_type: 'invalid',
      phone_normalized: { isValid: false },
    });
    const valid = computeConfidence({
      name: 'X',
      phone: '+493012345678',
      phone_e164: '+493012345678',
      phone_normalized: { isValid: true },
    });
    expect(invalid.score).toBeLessThan(valid.score);
  });
});

// ---------------------------------------------------------------------------
// 8. computeConfidence — rating / review mismatch
// ---------------------------------------------------------------------------

describe('Phase 3.10 — computeConfidence: rating-review mismatch', () => {
  test('RATING_REVIEW_MISMATCH factor fires (delta -8) for consistency="mismatch"', () => {
    const result = computeConfidence({
      name: 'Mismatched',
      rating: 4.5,
      reviews_count: 10,
      sentiment_result: { reviewCount: 10, ratingConsistency: 'mismatch' },
    });
    const mm = result.factors.find((f) => f.code === 'RATING_REVIEW_MISMATCH');
    expect(mm).toBeDefined();
    expect(mm.delta).toBe(-8);
    expect(mm.impact).toBe('negative');
  });
  test('"severe_mismatch" also triggers RATING_REVIEW_MISMATCH; "consistent" does NOT', () => {
    const severe = computeConfidence({
      name: 'Severe',
      rating: 1.0,
      reviews_count: 50,
      sentiment_result: { reviewCount: 50, ratingConsistency: 'severe_mismatch' },
    });
    const consistent = computeConfidence({
      name: 'Consistent',
      rating: 4.5,
      reviews_count: 50,
      sentiment_result: { reviewCount: 50, ratingConsistency: 'consistent' },
    });
    expect(severe.factors.map((f) => f.code)).toContain('RATING_REVIEW_MISMATCH');
    expect(consistent.factors.map((f) => f.code)).not.toContain('RATING_REVIEW_MISMATCH');
  });
  test('mismatch scores lower than consistent (identical other fields)', () => {
    const base = { name: 'X', rating: 4.5, reviews_count: 10 };
    const consistent = computeConfidence({
      ...base,
      sentiment_result: { reviewCount: 10, ratingConsistency: 'consistent' },
    });
    const mismatch = computeConfidence({
      ...base,
      sentiment_result: { reviewCount: 10, ratingConsistency: 'mismatch' },
    });
    expect(mismatch.score).toBeLessThan(consistent.score);
  });
});

// ---------------------------------------------------------------------------
// 9. Verified vs unverified email — module does NOT distinguish (documented)
// ---------------------------------------------------------------------------

describe('Phase 3.10 — email is NOT a confidence signal (module limitation)', () => {
  test('verified email produces the SAME score & factors as unverified email', () => {
    const verified = computeConfidence({ name: 'X', email: 'a@b.com', email_status: 'verified' });
    const unverified = computeConfidence({ name: 'X', email: 'a@b.com', email_status: 'unverified' });
    expect(verified.score).toBe(unverified.score);
    expect(verified.factors).toEqual(unverified.factors);
  });
  test('business with email and business without email produce the SAME score', () => {
    const withEmail = computeConfidence({ name: 'X', email: 'a@b.com', email_status: 'verified' });
    const withoutEmail = computeConfidence({ name: 'X' });
    expect(withEmail.score).toBe(withoutEmail.score);
  });
  test('no factor code or label mentions email', () => {
    const result = computeConfidence({ name: 'X', email: 'a@b.com', email_status: 'verified' });
    const hasEmailFactor = result.factors.some(
      (f) => /email/i.test(f.code) || /email/i.test(f.label),
    );
    expect(hasEmailFactor).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. Live website vs dead website
// ---------------------------------------------------------------------------

describe('Phase 3.10 — live website vs dead website', () => {
  test('live website emits HAS_LIVE_WEBSITE positive factor (delta +4)', () => {
    const result = computeConfidence({ name: 'X', website: 'https://x.de', website_liveness: 'live' });
    const live = result.factors.find((f) => f.code === 'HAS_LIVE_WEBSITE');
    expect(live).toBeDefined();
    expect(live.delta).toBeGreaterThan(0);
    expect(live.impact).toBe('positive');
  });
  test('dead/error websites do NOT emit HAS_LIVE_WEBSITE', () => {
    const dead = computeConfidence({ name: 'X', website: 'https://x.de', website_liveness: 'dead' });
    const err = computeConfidence({ name: 'X', website: 'https://x.de', website_liveness: 'error' });
    expect(dead.factors.map((f) => f.code)).not.toContain('HAS_LIVE_WEBSITE');
    expect(err.factors.map((f) => f.code)).not.toContain('HAS_LIVE_WEBSITE');
  });
  test('live website scores higher than dead website (identical other fields)', () => {
    const base = { name: 'X', website: 'https://x.de' };
    const live = computeConfidence({ ...base, website_liveness: 'live' });
    const dead = computeConfidence({ ...base, website_liveness: 'dead' });
    expect(live.score).toBeGreaterThan(dead.score);
  });
  test('both live and dead websites still get the HAS_WEBSITE factor', () => {
    const live = computeConfidence({ name: 'X', website: 'https://x.de', website_liveness: 'live' });
    const dead = computeConfidence({ name: 'X', website: 'https://x.de', website_liveness: 'dead' });
    expect(live.factors.map((f) => f.code)).toContain('HAS_WEBSITE');
    expect(dead.factors.map((f) => f.code)).toContain('HAS_WEBSITE');
  });
});

// ---------------------------------------------------------------------------
// 11. Factor array structure
// ---------------------------------------------------------------------------

describe('Phase 3.10 — factor array structure', () => {
  test('each factor has {code,label,detail,impact,delta} with correct value types', () => {
    const result = computeConfidence(strongBusiness());
    expect(result.factors.length).toBeGreaterThan(0);
    for (const f of result.factors) {
      expect(typeof f.code).toBe('string');
      expect(typeof f.label).toBe('string');
      expect(typeof f.detail).toBe('string');
      expect(['positive', 'negative', 'neutral']).toContain(f.impact);
      expect(typeof f.delta).toBe('number');
      expect(Number.isFinite(f.delta)).toBe(true);
    }
  });
  test('positive factors have positive delta; negative factors have negative delta', () => {
    const mixed = computeConfidence({
      name: 'X',
      phone: '123',
      phone_type: 'invalid',
      spam_result: { isSpam: true, riskLevel: 'high', spamScore: 90 },
      website: 'https://x.de',
      website_liveness: 'live',
    });
    for (const f of mixed.factors) {
      if (f.impact === 'positive') expect(f.delta).toBeGreaterThan(0);
      if (f.impact === 'negative') expect(f.delta).toBeLessThan(0);
      if (f.impact === 'neutral') expect(f.delta).toBe(0);
    }
  });
  test('factors are sorted by absolute delta descending (biggest drivers first)', () => {
    const result = computeConfidence(strongBusiness());
    for (let i = 1; i < result.factors.length; i++) {
      expect(Math.abs(result.factors[i - 1].delta)).toBeGreaterThanOrEqual(
        Math.abs(result.factors[i].delta),
      );
    }
  });
  test('factors array is capped at 8 entries (top drivers only)', () => {
    const result = computeConfidence(strongBusiness());
    expect(result.factors.length).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// 12. recordConfidence — 0–1 normalization
// ---------------------------------------------------------------------------

describe('Phase 3.10 — recordConfidence (0–1)', () => {
  test('strong business → 1.0 (100/100)', () => {
    expect(recordConfidence(strongBusiness())).toBe(1);
  });
  test('sparse business → small decimal in [0, 1] equal to score/100', () => {
    const sparse = recordConfidence(sparseBusiness());
    expect(sparse).toBeGreaterThanOrEqual(0);
    expect(sparse).toBeLessThanOrEqual(1);
    expect(sparse).toBe(computeConfidence(sparseBusiness()).score / 100);
  });
  test('recordConfidence(b) === computeConfidence(b).score / 100 for varied businesses', () => {
    const businesses = [
      strongBusiness(),
      sparseBusiness(),
      { name: 'X', phone: '123', phone_type: 'invalid' },
      { name: 'X', website: 'https://x.de', website_liveness: 'live' },
    ];
    for (const b of businesses) {
      expect(recordConfidence(b)).toBe(computeConfidence(b).score / 100);
    }
  });
  test('recordConfidence never exceeds 1 or goes below 0 (clamping holds)', () => {
    expect(recordConfidence(strongBusiness())).toBeLessThanOrEqual(1);
    expect(
      recordConfidence({ name: 'X', spam_result: { isSpam: true, riskLevel: 'high' } }),
    ).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 13. computeConfidenceBatch — in-place mutation + stats
// ---------------------------------------------------------------------------

describe('Phase 3.10 — computeConfidenceBatch', () => {
  test('attaches confidence_score (0–1) and confidence_result to each business', () => {
    const businesses = [strongBusiness(), sparseBusiness()];
    computeConfidenceBatch(businesses);
    for (const b of businesses) {
      expect(typeof b.confidence_score).toBe('number');
      expect(b.confidence_score).toBeGreaterThanOrEqual(0);
      expect(b.confidence_score).toBeLessThanOrEqual(1);
      expect(b.confidence_result).toEqual(expect.any(Object));
      expect(b.confidence_result.score).toBeGreaterThanOrEqual(0);
      expect(b.confidence_result.score).toBeLessThanOrEqual(100);
      // confidence_score is the 2-decimal storage shape: score/100
      expect(b.confidence_score).toBe(Math.round(b.confidence_result.score) / 100);
    }
  });
  test('returns stats with the documented shape', () => {
    const stats = computeConfidenceBatch([strongBusiness(), sparseBusiness()]);
    expect(stats).toHaveProperty('total', 2);
    expect(stats).toHaveProperty('avgConfidence');
    expect(stats).toHaveProperty('bandDist');
    expect(stats).toHaveProperty('lowConfidenceListings');
    expect(stats).toHaveProperty('avgSignalCoverage');
    expect(typeof stats.avgConfidence).toBe('number');
    expect(typeof stats.avgSignalCoverage).toBe('number');
  });
  test('bandDist has all 5 band keys summing to the number of real records', () => {
    const stats = computeConfidenceBatch([strongBusiness(), sparseBusiness()]);
    expect(stats.bandDist).toHaveProperty('very_low');
    expect(stats.bandDist).toHaveProperty('low');
    expect(stats.bandDist).toHaveProperty('medium');
    expect(stats.bandDist).toHaveProperty('high');
    expect(stats.bandDist).toHaveProperty('very_high');
    const sum =
      stats.bandDist.very_low +
      stats.bandDist.low +
      stats.bandDist.medium +
      stats.bandDist.high +
      stats.bandDist.very_high;
    expect(sum).toBe(2);
  });
  test('strong business → very_high band; sparse business → very_low band', () => {
    const stats = computeConfidenceBatch([strongBusiness(), sparseBusiness()]);
    expect(stats.bandDist.very_high).toBeGreaterThanOrEqual(1);
    expect(stats.bandDist.very_low).toBeGreaterThanOrEqual(1);
  });
  test('lowConfidenceListings counts very_low + low band records only', () => {
    const stats = computeConfidenceBatch([strongBusiness(), sparseBusiness()]);
    expect(stats.lowConfidenceListings).toBe(1); // only the sparse one
  });
  test('avgConfidence is the mean of stored 0–1 scores', () => {
    const businesses = [strongBusiness(), sparseBusiness()];
    const stats = computeConfidenceBatch(businesses);
    const expected =
      Math.round(
        ((businesses[0].confidence_score + businesses[1].confidence_score) / 2) * 100,
      ) / 100;
    expect(stats.avgConfidence).toBe(expected);
  });
  test('empty batch → all-zero stats with empty bandDist', () => {
    const stats = computeConfidenceBatch([]);
    expect(stats.total).toBe(0);
    expect(stats.avgConfidence).toBe(0);
    expect(stats.avgSignalCoverage).toBe(0);
    expect(stats.lowConfidenceListings).toBe(0);
    expect(stats.bandDist).toEqual({ very_low: 0, low: 0, medium: 0, high: 0, very_high: 0 });
  });
  test('non-array input → empty-batch stats (defensive)', () => {
    const stats = computeConfidenceBatch(null);
    expect(stats.total).toBe(0);
    expect(stats.avgConfidence).toBe(0);
  });
  test('null entries inside the array are skipped but still counted in total', () => {
    const stats = computeConfidenceBatch([strongBusiness(), null, sparseBusiness()]);
    expect(stats.total).toBe(3);
    const sum = Object.values(stats.bandDist).reduce((a, b) => a + b, 0);
    expect(sum).toBe(2); // only 2 real records mutated
  });
  test('logger.debug is invoked per business with score+band payload', () => {
    const calls = [];
    const logger = { debug: (kind, payload) => calls.push({ kind, payload }) };
    computeConfidenceBatch([strongBusiness()], { logger });
    expect(calls.length).toBe(1);
    expect(calls[0].kind).toBe('confidence');
    expect(calls[0].payload).toHaveProperty('score');
    expect(calls[0].payload).toHaveProperty('band');
  });
  test('a throwing logger.debug does NOT break the batch (best-effort logging)', () => {
    const logger = { debug: () => { throw new Error('boom'); } };
    const businesses = [strongBusiness(), sparseBusiness()];
    expect(() => computeConfidenceBatch(businesses, { logger })).not.toThrow();
    expect(businesses[0].confidence_result).toEqual(expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// 14. Score clamping (0–100)
// ---------------------------------------------------------------------------

describe('Phase 3.10 — score clamping (0–100)', () => {
  test('a fully-loaded strong business never exceeds 100 (raw computed = 101)', () => {
    const result = computeConfidence(strongBusiness());
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
  test('a maximally-bad business never goes below 0 (raw computed is negative)', () => {
    const bad = {
      name: 'Worst',
      phone: '123',
      phone_type: 'invalid',
      spam_result: { isSpam: true, riskLevel: 'critical', spamScore: 100 },
      sentiment_result: { reviewCount: 5, ratingConsistency: 'severe_mismatch' },
    };
    const result = computeConfidence(bad);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBe(0); // clamped to the floor
  });
  test('bandForConfidence returns a valid band at both clamp edges', () => {
    expect(bandForConfidence(0)).toBe('very_low');
    expect(bandForConfidence(100)).toBe('very_high');
  });
});

// ---------------------------------------------------------------------------
// 15. Defensive / edge cases
// ---------------------------------------------------------------------------

describe('Phase 3.10 — defensive edge cases', () => {
  test('computeConfidence(null) → valid result object with a valid band', () => {
    const result = computeConfidence(null);
    expect(result).toEqual(expect.any(Object));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(['very_low', 'low', 'medium', 'high', 'very_high']).toContain(result.band);
  });
  test('computeConfidence(undefined) → missingFields includes phone/website/address', () => {
    const result = computeConfidence(undefined);
    expect(result.missingFields).toContain('phone');
    expect(result.missingFields).toContain('website');
    expect(result.missingFields).toContain('address');
  });
  test('computeConfidence({}) — empty object → very_low band with all four MISSING_* factors', () => {
    const result = computeConfidence({});
    const codes = result.factors.map((f) => f.code);
    expect(codes).toContain('MISSING_PHONE');
    expect(codes).toContain('MISSING_ADDRESS');
    expect(codes).toContain('MISSING_GEOCODE');
    expect(codes).toContain('MISSING_WEBSITE');
    expect(result.band).toBe('very_low');
  });
  test('neutral base is 50 — a name-only business with no descriptors computes to 2 (verifies the base-of-50 model)', () => {
    // 50 (base) - 6*2 (six missing raw fields) - 10 - 8 - 10 - 8 = 2
    const result = computeConfidence({ name: 'Just A Name' });
    expect(result.score).toBe(2);
  });
  test('note contains band label + "N/8 signals covered" + missing-field count', () => {
    const result = computeConfidence(strongBusiness());
    expect(result.note).toContain(BAND_LABELS[result.band]);
    expect(result.note).toMatch(/\d+\/8 signals covered/);
    expect(result.note).toMatch(/\d+ missing field\(s\)/);
  });
});
