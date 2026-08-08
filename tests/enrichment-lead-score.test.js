'use strict';

/**
 * tests/enrichment-lead-score.test.js — Phase 3.9 — Lead Scoring unit tests
 *
 * Coverage (per PHASE3_EXECUTION_PLAN.md §3.9 task checklist + acceptance):
 *   - Pure helpers (clamp, round1)
 *   - Profile resolution (web-agency / reputation-mgmt / seo-agency / default,
 *     unknown → DEFAULT_PROFILE, weight sums to 1.0)
 *   - gradeForScore boundaries (A ≥85, B ≥70, C ≥55, D ≥40, F <40)
 *   - tierForScore boundaries + spamCapped-forced disqualify
 *   - 7 per-signal compute*() helpers (legitimacy, reputation, data_quality,
 *     digital_maturity, establishment, uniqueness, geo) — happy path + edge
 *     cases + missing-descriptor neutral fallback
 *   - scoreLead core: STRONG business → high score / grade A-B / tier
 *     priority|qualified; SPAM business → hard cap at SPAM_CAP_SCORE / grade F
 *     / tier disqualify / spamCapped true; WEAK business → low score / D|F
 *   - SPAM cap invariants (spamScore ≥65 + isSpam=true → cap; spamScore 64 →
 *     not capped; isSpam=false with high spamScore → not capped)
 *   - Scoring profile divergence (same business, different profiles →
 *     different scores) + DEFAULT_PROFILE fallback
 *   - scoreLeadsBatch: in-place mutation (lead_score / lead_score_profile /
 *     lead_result), stats shape, empty batch, null-skip accounting, opts.profile
 *   - Module exports (ENRICHMENT_COLUMNS, __version, DEFAULT_PROFILE,
 *     SPAM_CAP_SCORE, SPAM_CAP_THRESHOLD) + SIGNAL_LABELS 7-key shape
 *
 * All tests are deterministic + offline (no network, no DB). The lead-score
 * module is pure — every input is read off the business object.
 *
 * Run: cd /home/z/Scraper && bun test tests/enrichment-lead-score.test.js
 */

const {
  __version,
  ENRICHMENT_COLUMNS,
  SCORING_PROFILES,
  SIGNAL_LABELS,
  DEFAULT_PROFILE,
  SPAM_CAP_SCORE,
  SPAM_CAP_THRESHOLD,
  computeLegitimacy,
  computeReputation,
  computeDataQuality,
  computeDigitalMaturity,
  computeEstablishment,
  computeUniqueness,
  computeGeo,
  gradeForScore,
  tierForScore,
  scoreLead,
  scoreLeadsBatch,
  resolveProfile,
  clamp,
  round1,
} = require('../src/enrichment/lead-score');

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** A strongly-attractive listing: valid phone, full address, live website with
 *  rich tech stack, 200 reviews @ 4.7★, positive sentiment, not spam, not
 *  chain, moderate-density suburban geo. Should score ≥80 (grade A, tier
 *  priority) under the default 'web-agency' profile. */
function buildStrongBusiness() {
  return {
    name: 'Acme Coffee Roasters',
    category: 'Coffee shop',
    rating: 4.7,
    reviews_count: 200,
    website: 'https://acme.example.com',
    website_liveness: 'live',
    phone_e164: '+12125550100',
    phone_type: 'landline',
    phone_normalized: { isValid: true },
    address_street: '123 Main St',
    address_city: 'Springfield',
    address_state: 'IL',
    address_country: 'US',
    lat: 39.78,
    lng: -89.65,
    spam_result: { isSpam: false, spamScore: 0, riskLevel: 'low', flags: [] },
    chain_result: { isChain: false, chainId: null, confidence: 0.0 },
    dedup_result: { clusterId: 'c1', isPrimary: true, duplicates: [], maxSimilarity: 0.1 },
    tech_stack_result: { technologies: ['React', 'Next.js'], sophisticationScore: 80, reachable: true },
    sentiment_result: { score: 0.6, label: 'positive', volumeConfidence: 0.8, anomalies: [] },
    geo_result: {
      nearestNeighborM: 500,
      within1km: 3,
      sameCategoryWithin1km: 1,
      isolation: 'moderate',
      areaType: 'suburban',
      flags: [],
    },
  };
}

/** A spam-flagged listing: spamScore 80 (≥ SPAM_CAP_THRESHOLD 65), high risk,
 *  PHONE_REUSE flag, duplicate (isPrimary=false), dead low-sophistication
 *  website, dense urban geo, sentiment mismatch anomaly. Should hit the hard
 *  cap (score=34, spamCapped=true, grade F, tier disqualify). */
function buildSpamBusiness() {
  return {
    name: 'Shady Lead Gen Co',
    category: 'Marketing',
    rating: 4.5,
    reviews_count: 5,
    website: 'http://spam.example.com',
    website_liveness: 'dead',
    phone_e164: '+12125550199',
    phone_type: 'mobile',
    phone_normalized: { isValid: true },
    address_street: '456 Side St',
    address_city: 'Detroit',
    address_state: 'MI',
    address_country: 'US',
    lat: 42.33,
    lng: -83.05,
    spam_result: {
      isSpam: true,
      spamScore: 80,
      riskLevel: 'high',
      flags: [{ code: 'PHONE_REUSE' }],
    },
    chain_result: { isChain: false, chainId: null },
    dedup_result: { clusterId: 'c2', isPrimary: false, duplicates: [], maxSimilarity: 0.9 },
    tech_stack_result: { technologies: [], sophisticationScore: 10, reachable: false },
    sentiment_result: {
      score: -0.4,
      label: 'negative',
      volumeConfidence: 0.5,
      anomalies: [{ code: 'rating_review_mismatch_high' }],
    },
    geo_result: { isolation: 'dense', areaType: 'urban', flags: [] },
  };
}

/** A minimal listing with no enriched descriptors: every prior-phase signal
 *  degrades to neutral (50) or floor (data_quality 0, digital_maturity 20,
 *  establishment 10). Should score below 40 (grade F, tier disqualify). */
function buildWeakBusiness() {
  return { name: 'Unknown Vendor' };
}

/** A mixed listing: high reputation + establishment but low digital_maturity.
 *  Used to verify the three outreach profiles produce divergent scores (web-
 *  agency / reputation-mgmt / seo-agency weight digital_maturity very
 *  differently). */
function buildMixedBusiness() {
  return {
    name: 'Old Diner',
    category: 'Restaurant',
    rating: 4.8,
    reviews_count: 250,
    website: 'http://olddiner.example.com',
    website_liveness: 'live',
    phone_e164: '+12125550100',
    phone_type: 'landline',
    phone_normalized: { isValid: true },
    address_street: '789 Oak Ave',
    address_city: 'Austin',
    address_state: 'TX',
    address_country: 'US',
    lat: 30.27,
    lng: -97.74,
    spam_result: { isSpam: false, spamScore: 0, riskLevel: 'low', flags: [] },
    chain_result: { isChain: false, chainId: null },
    dedup_result: { clusterId: 'c1', isPrimary: true, duplicates: [], maxSimilarity: 0.05 },
    tech_stack_result: { technologies: ['jQuery'], sophisticationScore: 20, reachable: true },
    sentiment_result: { score: 0.7, label: 'positive', volumeConfidence: 0.9, anomalies: [] },
    geo_result: { isolation: 'sparse', areaType: 'suburban', flags: [] },
  };
}

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

describe('Phase 3.9 — clamp / round1', () => {
  test('clamp clamps to [0,100] by default', () => {
    expect(clamp(150)).toBe(100);
    expect(clamp(-5)).toBe(0);
    expect(clamp(50)).toBe(50);
  });

  test('clamp accepts custom lo/hi bounds', () => {
    expect(clamp(150, 0, 50)).toBe(50);
    expect(clamp(-5, 10, 80)).toBe(10);
    expect(clamp(25, 10, 80)).toBe(25);
  });

  test('round1 rounds to one decimal place', () => {
    expect(round1(3.14159)).toBe(3.1);
    expect(round1(2.5)).toBe(2.5);
    expect(round1(0.46)).toBe(0.5);
    expect(round1(-3.14)).toBe(-3.1);
  });
});

// ---------------------------------------------------------------------------
// 2. resolveProfile
// ---------------------------------------------------------------------------

describe('Phase 3.9 — resolveProfile', () => {
  test('returns the named profile object for each known profile', () => {
    expect(resolveProfile('web-agency')).toBe(SCORING_PROFILES['web-agency']);
    expect(resolveProfile('reputation-mgmt')).toBe(SCORING_PROFILES['reputation-mgmt']);
    expect(resolveProfile('seo-agency')).toBe(SCORING_PROFILES['seo-agency']);
    expect(resolveProfile('default')).toBe(SCORING_PROFILES.default);
  });

  test('falls back to DEFAULT_PROFILE for unknown or missing name', () => {
    expect(resolveProfile('does-not-exist')).toBe(SCORING_PROFILES[DEFAULT_PROFILE]);
    expect(resolveProfile(undefined)).toBe(SCORING_PROFILES[DEFAULT_PROFILE]);
    expect(resolveProfile()).toBe(SCORING_PROFILES[DEFAULT_PROFILE]);
  });

  test('every profile has the 7 signal weights summing to 1.0', () => {
    const keys = [
      'legitimacy',
      'reputation',
      'data_quality',
      'digital_maturity',
      'establishment',
      'uniqueness',
      'geo',
    ];
    for (const name of Object.keys(SCORING_PROFILES)) {
      const p = SCORING_PROFILES[name];
      const sum = keys.reduce((acc, k) => acc + (typeof p[k] === 'number' ? p[k] : 0), 0);
      expect(sum).toBeCloseTo(1.0, 10);
      for (const k of keys) {
        expect(typeof p[k]).toBe('number');
        expect(p[k]).toBeGreaterThanOrEqual(0);
        expect(p[k]).toBeLessThanOrEqual(1);
      }
      expect(typeof p.label).toBe('string');
      expect(typeof p.angle).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. gradeForScore
// ---------------------------------------------------------------------------

describe('Phase 3.9 — gradeForScore boundaries', () => {
  test('A ≥85, B ≥70, C ≥55, D ≥40, F <40', () => {
    expect(gradeForScore(100)).toBe('A');
    expect(gradeForScore(85)).toBe('A');
    expect(gradeForScore(84.99)).toBe('B');
    expect(gradeForScore(70)).toBe('B');
    expect(gradeForScore(69.99)).toBe('C');
    expect(gradeForScore(55)).toBe('C');
    expect(gradeForScore(54.99)).toBe('D');
    expect(gradeForScore(40)).toBe('D');
    expect(gradeForScore(39.99)).toBe('F');
    expect(gradeForScore(0)).toBe('F');
  });
});

// ---------------------------------------------------------------------------
// 4. tierForScore
// ---------------------------------------------------------------------------

describe('Phase 3.9 — tierForScore boundaries', () => {
  test('priority ≥85, qualified ≥70, nurture ≥55, monitor ≥40, disqualify <40', () => {
    expect(tierForScore(100)).toBe('priority');
    expect(tierForScore(85)).toBe('priority');
    expect(tierForScore(84.99)).toBe('qualified');
    expect(tierForScore(70)).toBe('qualified');
    expect(tierForScore(69.99)).toBe('nurture');
    expect(tierForScore(55)).toBe('nurture');
    expect(tierForScore(54.99)).toBe('monitor');
    expect(tierForScore(40)).toBe('monitor');
    expect(tierForScore(39.99)).toBe('disqualify');
    expect(tierForScore(0)).toBe('disqualify');
  });

  test('spamCapped=true forces disqualify regardless of score', () => {
    expect(tierForScore(95, true)).toBe('disqualify');
    expect(tierForScore(100, true)).toBe('disqualify');
  });
});

// ---------------------------------------------------------------------------
// 5. computeLegitimacy
// ---------------------------------------------------------------------------

describe('Phase 3.9 — computeLegitimacy', () => {
  test('clean spam_result + no chain → 100', () => {
    const b = {
      spam_result: { isSpam: false, spamScore: 0, riskLevel: 'low', flags: [] },
      chain_result: { isChain: false },
    };
    const r = computeLegitimacy(b);
    expect(r.score).toBe(100);
    expect(r.note).toContain('clean profile');
  });

  test('high spamScore + high risk level → low score', () => {
    const b = { spam_result: { isSpam: true, spamScore: 80, riskLevel: 'high', flags: [] } };
    const r = computeLegitimacy(b);
    expect(r.score).toBe(10); // 100 - 80 - 10
  });

  test('critical risk level → additional −20', () => {
    const b = { spam_result: { isSpam: true, spamScore: 30, riskLevel: 'critical', flags: [] } };
    const r = computeLegitimacy(b);
    expect(r.score).toBe(50); // 100 - 30 - 20
  });

  test('chain_result.isChain → additional −15', () => {
    const b = {
      spam_result: { isSpam: false, spamScore: 0, riskLevel: 'low' },
      chain_result: { isChain: true, chainId: 'starbucks' },
    };
    const r = computeLegitimacy(b);
    expect(r.score).toBe(85); // 100 - 15
  });

  test('missing spam_result → neutral 50', () => {
    const r = computeLegitimacy({});
    expect(r.score).toBe(50);
    expect(r.note).toContain('neutral 50');
  });
});

// ---------------------------------------------------------------------------
// 6. computeReputation
// ---------------------------------------------------------------------------

describe('Phase 3.9 — computeReputation', () => {
  test('high rating + many reviews → 100 (clamped)', () => {
    const r = computeReputation({ rating: 4.7, reviews_count: 200 });
    expect(r.score).toBe(100); // 4.7★ → 100, +10 reviews, clamp
  });

  test('low rating → low base (20)', () => {
    const r = computeReputation({ rating: 2.5, reviews_count: 0 });
    expect(r.score).toBe(20);
  });

  test('few reviews → no volume bonus', () => {
    const r = computeReputation({ rating: 4.0, reviews_count: 10 });
    expect(r.score).toBe(80); // 4.0★ → 80, +0
  });

  test('sentiment rating_review_mismatch anomaly → −15', () => {
    const b = {
      rating: 4.5,
      reviews_count: 100,
      sentiment_result: { anomalies: [{ code: 'rating_review_mismatch' }] },
    };
    const r = computeReputation(b);
    expect(r.score).toBe(95); // 100 + 10 − 15
  });

  test('missing rating → neutral 50', () => {
    const r = computeReputation({ reviews_count: 50 });
    expect(r.score).toBe(50);
    expect(r.note).toContain('neutral 50');
  });
});

// ---------------------------------------------------------------------------
// 7. computeDataQuality
// ---------------------------------------------------------------------------

describe('Phase 3.9 — computeDataQuality', () => {
  test('all fields present → 80 (raw max)', () => {
    const b = {
      phone_e164: '+12125550100',
      phone_type: 'landline',
      phone_normalized: { isValid: true },
      address_street: '123 Main',
      address_city: 'X',
      address_state: 'Y',
      address_country: 'US',
      lat: 39.7,
      lng: -89.6,
      website: 'http://x.example.com',
      reviews_count: 50,
      category: 'Cafe',
      sentiment_result: { score: 0.5 },
    };
    const r = computeDataQuality(b);
    expect(r.score).toBe(80); // 15+10+15+10+10+10+5+5
  });

  test('minimal fields → 0', () => {
    const r = computeDataQuality({ name: 'X' });
    expect(r.score).toBe(0);
  });

  test('invalid phone → −20 penalty (clamped to 0)', () => {
    const b = { phone: 'garbage', phone_type: 'invalid' };
    const r = computeDataQuality(b);
    expect(r.score).toBe(0); // 15 (present) − 20 (invalid) → −5 → clamp 0
    expect(r.note).toContain('invalid phone');
  });
});

// ---------------------------------------------------------------------------
// 8. computeDigitalMaturity
// ---------------------------------------------------------------------------

describe('Phase 3.9 — computeDigitalMaturity', () => {
  test('tech sophistication + live website → high', () => {
    const b = {
      tech_stack_result: { technologies: ['React', 'Next.js'], sophisticationScore: 80, reachable: true },
      website_liveness: 'live',
    };
    const r = computeDigitalMaturity(b);
    expect(r.score).toBe(100); // 80 + 20
  });

  test('no website → low (20)', () => {
    const r = computeDigitalMaturity({});
    expect(r.score).toBe(20);
  });

  test('website present, no tech result, dead → 20 (30 − 10)', () => {
    const b = { website: 'http://x.example.com', website_liveness: 'dead' };
    const r = computeDigitalMaturity(b);
    expect(r.score).toBe(20);
  });

  test('website present, no tech result, redirected → 40 (30 + 10)', () => {
    const b = { website: 'http://x.example.com', website_liveness: 'redirected' };
    const r = computeDigitalMaturity(b);
    expect(r.score).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// 9. computeEstablishment
// ---------------------------------------------------------------------------

describe('Phase 3.9 — computeEstablishment', () => {
  test('review-volume bands map to 100/80/60/40/20/10', () => {
    expect(computeEstablishment({ reviews_count: 200 }).score).toBe(100);
    expect(computeEstablishment({ reviews_count: 100 }).score).toBe(80);
    expect(computeEstablishment({ reviews_count: 50 }).score).toBe(60);
    expect(computeEstablishment({ reviews_count: 20 }).score).toBe(40);
    expect(computeEstablishment({ reviews_count: 5 }).score).toBe(20);
    expect(computeEstablishment({ reviews_count: 0 }).score).toBe(10);
    expect(computeEstablishment({}).score).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 10. computeUniqueness
// ---------------------------------------------------------------------------

describe('Phase 3.9 — computeUniqueness', () => {
  test('low similarity + primary + no phone reuse → high', () => {
    const b = {
      dedup_result: { isPrimary: true, maxSimilarity: 0.1, duplicates: [] },
      spam_result: { flags: [] },
    };
    const r = computeUniqueness(b);
    expect(r.score).toBe(90); // (1 − 0.1) × 100
  });

  test('duplicate (isPrimary=false) → −20', () => {
    const b = {
      dedup_result: { isPrimary: false, maxSimilarity: 0.1 },
      spam_result: { flags: [] },
    };
    const r = computeUniqueness(b);
    expect(r.score).toBe(70); // 90 − 20
  });

  test('PHONE_REUSE spam flag → −20', () => {
    const b = {
      dedup_result: { isPrimary: true, maxSimilarity: 0.1 },
      spam_result: { flags: [{ code: 'PHONE_REUSE' }] },
    };
    const r = computeUniqueness(b);
    expect(r.score).toBe(70); // 90 − 20
  });

  test('missing dedup_result → neutral 50', () => {
    const r = computeUniqueness({});
    expect(r.score).toBe(50);
    expect(r.note).toContain('neutral 50');
  });
});

// ---------------------------------------------------------------------------
// 11. computeGeo
// ---------------------------------------------------------------------------

describe('Phase 3.9 — computeGeo', () => {
  test('moderate isolation + suburban areaType → 60', () => {
    const b = { geo_result: { isolation: 'moderate', areaType: 'suburban', flags: [] } };
    const r = computeGeo(b);
    expect(r.score).toBe(60);
  });

  test('isolated + rural → clamped to 100 (100 + 10)', () => {
    const b = { geo_result: { isolation: 'isolated', areaType: 'rural', flags: [] } };
    const r = computeGeo(b);
    expect(r.score).toBe(100);
  });

  test('dense + urban → 35 (40 − 5)', () => {
    const b = { geo_result: { isolation: 'dense', areaType: 'urban', flags: [] } };
    const r = computeGeo(b);
    expect(r.score).toBe(35);
  });

  test('no_geocode flag (object form) → −15', () => {
    const b = { geo_result: { isolation: 'moderate', flags: [{ code: 'no_geocode' }] } };
    const r = computeGeo(b);
    expect(r.score).toBe(45); // 60 − 15
  });

  test('no_geocode flag (string form) is also recognized', () => {
    const b = { geo_result: { isolation: 'moderate', flags: ['no_geocode'] } };
    const r = computeGeo(b);
    expect(r.score).toBe(45);
  });

  test('missing geo_result → neutral 50', () => {
    const r = computeGeo({});
    expect(r.score).toBe(50);
    expect(r.note).toContain('neutral 50');
  });
});

// ---------------------------------------------------------------------------
// 12. scoreLead (core)
// ---------------------------------------------------------------------------

describe('Phase 3.9 — scoreLead (core)', () => {
  test('strong business → high score, grade A/B, tier priority|qualified, spamCapped false', () => {
    const r = scoreLead(buildStrongBusiness());
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(['A', 'B']).toContain(r.grade);
    expect(['priority', 'qualified']).toContain(r.tier);
    expect(r.spamCapped).toBe(false);
    expect(r.profile).toBe('web-agency');
    expect(r.topStrengths.length).toBeGreaterThan(0);
    expect(typeof r.recommendation).toBe('string');
    expect(r.recommendation.length).toBeGreaterThan(0);
  });

  test('spam business → score capped at SPAM_CAP_SCORE, grade F, tier disqualify', () => {
    const r = scoreLead(buildSpamBusiness());
    expect(r.score).toBe(SPAM_CAP_SCORE);
    expect(r.spamCapped).toBe(true);
    expect(r.grade).toBe('F');
    expect(r.tier).toBe('disqualify');
    expect(r.recommendation).toContain('spam-capped');
  });

  test('weak business → low score, grade D|F, tier disqualify', () => {
    const r = scoreLead(buildWeakBusiness());
    expect(r.score).toBeLessThan(40);
    expect(['D', 'F']).toContain(r.grade);
    expect(r.tier).toBe('disqualify');
  });

  test('signals array carries all 7 keys with score/weight/contribution/note', () => {
    const r = scoreLead(buildStrongBusiness());
    expect(r.signals).toHaveLength(7);
    const keys = r.signals.map((s) => s.key);
    expect(keys).toEqual([
      'legitimacy',
      'reputation',
      'data_quality',
      'digital_maturity',
      'establishment',
      'uniqueness',
      'geo',
    ]);
    for (const s of r.signals) {
      expect(typeof s.score).toBe('number');
      expect(typeof s.weight).toBe('number');
      expect(typeof s.contribution).toBe('number');
      expect(typeof s.note).toBe('string');
      expect(s.label).toBe(SIGNAL_LABELS[s.key]);
      expect(s.contribution).toBeCloseTo(s.score * s.weight, 1);
    }
  });
});

// ---------------------------------------------------------------------------
// 13. SPAM cap invariants
// ---------------------------------------------------------------------------

describe('Phase 3.9 — spam cap invariants', () => {
  test('isSpam=true with spamScore ≥65 → score ≤ SPAM_CAP_SCORE + spamCapped=true', () => {
    const b = buildStrongBusiness();
    b.spam_result = { isSpam: true, spamScore: 70, riskLevel: 'high', flags: [] };
    const r = scoreLead(b);
    expect(r.score).toBeLessThanOrEqual(SPAM_CAP_SCORE);
    expect(r.spamCapped).toBe(true);
  });

  test('isSpam=true with spamScore 64 (below threshold) → NOT capped', () => {
    const b = buildStrongBusiness();
    b.spam_result = { isSpam: true, spamScore: 64, riskLevel: 'medium', flags: [] };
    const r = scoreLead(b);
    expect(r.spamCapped).toBe(false);
    expect(r.score).toBeGreaterThan(SPAM_CAP_SCORE);
  });

  test('isSpam=true with spamScore exactly 65 (threshold) → capped', () => {
    const b = buildStrongBusiness();
    b.spam_result = { isSpam: true, spamScore: 65, riskLevel: 'high', flags: [] };
    const r = scoreLead(b);
    expect(r.spamCapped).toBe(true);
    expect(r.score).toBe(SPAM_CAP_SCORE);
  });

  test('isSpam=false with high spamScore → NOT capped (cap requires isSpam flag)', () => {
    const b = buildStrongBusiness();
    b.spam_result = { isSpam: false, spamScore: 80, riskLevel: 'medium', flags: [] };
    const r = scoreLead(b);
    expect(r.spamCapped).toBe(false);
    expect(r.score).toBeGreaterThan(SPAM_CAP_SCORE);
  });
});

// ---------------------------------------------------------------------------
// 14. Scoring profiles
// ---------------------------------------------------------------------------

describe('Phase 3.9 — scoring profiles', () => {
  test('same business with web-agency / reputation-mgmt / seo-agency → different scores', () => {
    const mixed = buildMixedBusiness();
    const wa = scoreLead(mixed, 'web-agency');
    const rm = scoreLead(mixed, 'reputation-mgmt');
    const seo = scoreLead(mixed, 'seo-agency');
    expect(wa.score).not.toBe(rm.score);
    expect(wa.score).not.toBe(seo.score);
    expect(rm.score).not.toBe(seo.score);
    expect(wa.profile).toBe('web-agency');
    expect(rm.profile).toBe('reputation-mgmt');
    expect(seo.profile).toBe('seo-agency');
  });

  test('omitted profileName → DEFAULT_PROFILE used', () => {
    const b = buildStrongBusiness();
    const omitted = scoreLead(b);
    const explicit = scoreLead(b, DEFAULT_PROFILE);
    expect(omitted.profile).toBe(DEFAULT_PROFILE);
    expect(omitted.score).toBe(explicit.score);
  });

  test('unknown profileName → falls back to DEFAULT_PROFILE', () => {
    const b = buildStrongBusiness();
    const r = scoreLead(b, 'totally-fake-profile');
    expect(r.profile).toBe(DEFAULT_PROFILE);
    // And matches the explicit DEFAULT_PROFILE score
    expect(r.score).toBe(scoreLead(b, DEFAULT_PROFILE).score);
  });
});

// ---------------------------------------------------------------------------
// 15. scoreLeadsBatch
// ---------------------------------------------------------------------------

describe('Phase 3.9 — scoreLeadsBatch', () => {
  test('attaches lead_score / lead_score_profile / lead_result to each business', () => {
    const list = [buildStrongBusiness(), buildSpamBusiness(), buildWeakBusiness()];
    const stats = scoreLeadsBatch(list);
    for (const b of list) {
      expect(typeof b.lead_score).toBe('number');
      expect(typeof b.lead_score_profile).toBe('string');
      expect(b.lead_result).toBeInstanceOf(Object);
      expect(b.lead_result.score).toBe(b.lead_score);
      expect(b.lead_result.profile).toBe(b.lead_score_profile);
    }
    expect(stats.total).toBe(3);
    expect(stats.priorityLeads).toBeGreaterThan(0); // STRONG business
    expect(stats.disqualifiedLeads).toBeGreaterThanOrEqual(2); // SPAM + WEAK
    expect(stats.spamCapped).toBe(1);
  });

  test('stats has the full documented shape', () => {
    const stats = scoreLeadsBatch([buildStrongBusiness()]);
    expect(stats).toHaveProperty('total', 1);
    expect(stats).toHaveProperty('avgScore');
    expect(stats).toHaveProperty('gradeDist');
    expect(stats).toHaveProperty('tierDist');
    expect(stats.gradeDist).toHaveProperty('A');
    expect(stats.gradeDist).toHaveProperty('F');
    expect(stats.tierDist).toHaveProperty('priority');
    expect(stats.tierDist).toHaveProperty('disqualify');
    expect(stats).toHaveProperty('priorityLeads');
    expect(stats).toHaveProperty('disqualifiedLeads');
    expect(stats).toHaveProperty('spamCapped');
    expect(stats).toHaveProperty('skipped');
  });

  test('empty batch returns zeroed stats', () => {
    const stats = scoreLeadsBatch([]);
    expect(stats.total).toBe(0);
    expect(stats.avgScore).toBe(0);
    expect(stats.priorityLeads).toBe(0);
    expect(stats.disqualifiedLeads).toBe(0);
    expect(stats.spamCapped).toBe(0);
    expect(stats.skipped).toBe(0);
  });

  test('null/undefined entries are skipped and counted in stats.skipped', () => {
    const stats = scoreLeadsBatch([null, undefined, { name: 'X' }]);
    expect(stats.total).toBe(3);
    expect(stats.skipped).toBe(2);
  });

  test('respects opts.profile (resolved profile name propagated to each business)', () => {
    const b1 = buildMixedBusiness();
    const stats = scoreLeadsBatch([b1], { profile: 'reputation-mgmt' });
    expect(b1.lead_score_profile).toBe('reputation-mgmt');
    expect(stats.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 16. Module exports (constants)
// ---------------------------------------------------------------------------

describe('Phase 3.9 — module exports', () => {
  test('ENRICHMENT_COLUMNS equals [lead_score, lead_score_profile]', () => {
    expect(ENRICHMENT_COLUMNS).toEqual(['lead_score', 'lead_score_profile']);
    expect(ENRICHMENT_COLUMNS).toHaveLength(2);
  });

  test('constants: __version, DEFAULT_PROFILE, SPAM_CAP_SCORE, SPAM_CAP_THRESHOLD', () => {
    expect(typeof __version).toBe('number');
    expect(__version).toBeGreaterThan(0);
    expect(DEFAULT_PROFILE).toBe('web-agency');
    expect(SPAM_CAP_SCORE).toBe(34);
    expect(SPAM_CAP_THRESHOLD).toBe(65);
  });
});

// ---------------------------------------------------------------------------
// 17. SIGNAL_LABELS
// ---------------------------------------------------------------------------

describe('Phase 3.9 — SIGNAL_LABELS', () => {
  test('has all 7 signal keys mapped to non-empty label strings', () => {
    const keys = Object.keys(SIGNAL_LABELS);
    expect(keys).toHaveLength(7);
    expect(keys).toEqual(
      expect.arrayContaining([
        'legitimacy',
        'reputation',
        'data_quality',
        'digital_maturity',
        'establishment',
        'uniqueness',
        'geo',
      ]),
    );
    for (const v of Object.values(SIGNAL_LABELS)) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
  });
});
