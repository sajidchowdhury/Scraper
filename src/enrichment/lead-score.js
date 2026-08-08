'use strict';

/**
 * src/enrichment/lead-score.js — Phase 3.9 — Lead Scoring (combines all signals)
 *
 * This is the capstone stage of the enrichment pipeline. Every prior phase
 * produces an independent signal about a listing; this stage fuses them into a
 * single 0-100 composite "lead score" that ranks how attractive each listing
 * is as a prospect — for sales outreach, partner acquisition, lead enrichment,
 * or fraud triage.
 *
 * The model is deliberately transparent and additive: seven signal dimensions,
 * each normalized to a 0-100 subscore, combined by fixed weights that sum to
 * 1.0. Every subscore carries a human-readable note and the weighted
 * contribution is exposed, so the score is fully explainable (no black box).
 *
 *   Signal             Sources
 *   ─────────────────  ──────────────────────────────────────────────────────
 *   legitimacy         Phase 3.4 spam (inverse) + chain flag
 *   reputation         Phase 3.7 sentiment + star rating + consistency
 *   data_quality       Phase 3.1 phone + 3.2 address + website + reviews
 *   digital_maturity   Phase 3.6 tech-stack sophistication + liveness
 *   establishment      review volume (maturity / longevity proxy)
 *   uniqueness         Phase 3.3 dedup (primary vs duplicate) + phone reuse
 *   geo                Phase 3.8 isolation / competition / area type
 *
 * HARD SPAM CAP (critical rule)
 *   A listing flagged `isSpam` by the Phase 3.4 engine with spamScore >= 65 is
 *   hard-capped at 34 (grade F, tier 'disqualify') regardless of how strong
 *   its other signals are — the spam engine's strong-signal overrides are
 *   designed to be near-certain. spamCapped=true is set on the result so the
 *   batch wrapper and downstream consumers can audit the cap.
 *
 * DESIGN RULES (per PHASE3_EXECUTION_PLAN.md §3.9)
 *   - Pure functions wherever possible (testable without a DB / network). No
 *     external dependencies — every input is read off the business object.
 *   - The 7 per-signal compute*() helpers read prior-phase descriptors and are
 *     each individually unit-testable.
 *   - Defensive reads: prior phases may not have run (tech-stack is opt-in,
 *     sentiment needs reviews, geo needs coords, …). When a descriptor is
 *     missing the affected signal degrades to neutral (score 50) with a note
 *     explaining the gap, so the composite still produces a sensible number.
 *   - The batch wrapper mutates each business IN PLACE: it writes the two
 *     persisted columns (lead_score INT, lead_score_profile TEXT) AND attaches
 *     a `lead_result` debug descriptor (full LeadScoreResult — NOT persisted;
 *     powers the CLI banner + downstream grid/confidence phases).
 *   - The score reflects SIGNAL STRENGTH, not lead value. E.g. low
 *     digital_maturity yields a low maturity subscore (which modestly lowers
 *     the composite); the recommendation surface is what flags "low maturity =
 *     outreach angle for web agencies". See SCORING_PROFILES notes below.
 *
 * SCORING PROFILES
 *   Each profile weights the 7 signals differently to reflect what makes a
 *   listing attractive for a given outreach workflow. Weights sum to 1.0 per
 *   profile. The default profile mirrors the dashboard's published weights.
 *     • web-agency        — emphasizes legitimacy, data_quality, establishment;
 *                           keeps digital_maturity low-weight (low maturity is
 *                           the opportunity, not a disqualifier).
 *     • reputation-mgmt   — heavily weights reputation (the signal they sell
 *                           against); underweights digital_maturity.
 *     • seo-agency        — weights digital_maturity + data_quality (need a
 *                           site to optimize) + geo (local SEO matters).
 *     • default           — the dashboard's even-split baseline.
 *
 * BUSINESS OBJECT FIELD NAMES (snake_case) — INPUTS from prior phases
 *   Core:           name, category, rating, reviews_count, website, scraped_at
 *   3.1 phone:      phone_e164, phone_type, phone_country_code,
 *                   phone_normalized.isValid
 *   3.2 address:    address_street, address_city, address_state,
 *                   address_country, lat, lng, geocode_confidence (0-1)
 *   3.3 dedup:      dedup_result { clusterId, isPrimary, duplicates[],
 *                   maxSimilarity } (debug descriptor)
 *   3.4 chain/spam: chain_result { isChain, chainId, confidence },
 *                   spam_result { isSpam, spamScore, riskLevel, flags[] }
 *   3.6 tech:       tech_stack_result { technologies[], sophisticationScore,
 *                   reachable } OR website_tech_stack (array), website_liveness
 *   3.7 sentiment:  sentiment_result { score, label, volumeConfidence,
 *                   anomalies[] } OR sentiment_score, sentiment_themes
 *   3.8 geo:        geo_result { nearestNeighborM, within1km,
 *                   sameCategoryWithin1km, isolation, areaType, flags[] } OR
 *                   competitor_density_1km / competitor_density_5km
 *   ── THIS MODULE WRITES ──
 *   lead_score              INT 0-100   (persisted)
 *   lead_score_profile      TEXT        (persisted)
 *   lead_result             object      (debug — NOT persisted)
 *
 * PUBLIC API
 *   computeLegitimacy(business)         → { score, note }
 *   computeReputation(business)         → { score, note }
 *   computeDataQuality(business)        → { score, note }
 *   computeDigitalMaturity(business)    → { score, note }
 *   computeEstablishment(business)      → { score, note }
 *   computeUniqueness(business)         → { score, note }
 *   computeGeo(business)                → { score, note }
 *   scoreLead(business, profile?)       → LeadScoreResult
 *   scoreLeadsBatch(businesses, opts?)  → batch stats
 *   gradeForScore(score)                → 'A'|'B'|'C'|'D'|'F'
 *   tierForScore(score, isSpamCapped)   → LeadTier
 *   SCORING_PROFILES                    → { 'web-agency': {...}, ... }
 *   ENRICHMENT_COLUMNS                  → ['lead_score', 'lead_score_profile']
 */

const __version = 1;

const ENRICHMENT_COLUMNS = ['lead_score', 'lead_score_profile'];

// ─────────────────────────────────────────────────────────────────────────────
// Scoring profiles — each weights the 7 signals. Weights MUST sum to 1.0.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ScoringProfile
 * @property {number} legitimacy        weight 0-1
 * @property {number} reputation        weight 0-1
 * @property {number} data_quality      weight 0-1
 * @property {number} digital_maturity  weight 0-1
 * @property {number} establishment     weight 0-1
 * @property {number} uniqueness        weight 0-1
 * @property {number} geo               weight 0-1
 * @property {string} label             human-readable profile name
 * @property {string} angle             default outreach angle string
 */

/** @type {Record<string, ScoringProfile>} */
const SCORING_PROFILES = {
  // Default — mirrors the dashboard's published WEIGHTS (lead.ts).
  // Even baseline; no signal dominates.
  default: {
    legitimacy: 0.25,
    reputation: 0.25,
    data_quality: 0.20,
    digital_maturity: 0.10,
    establishment: 0.10,
    uniqueness: 0.05,
    geo: 0.05,
    label: 'Default',
    angle: 'general outreach',
  },
  // Web agency — wants legitimate, reachable, established businesses; keeps
  // digital_maturity low-weight so low maturity (the opportunity) doesn't
  // tank the composite.
  'web-agency': {
    legitimacy: 0.20,
    reputation: 0.15,
    data_quality: 0.20,
    digital_maturity: 0.10,
    establishment: 0.15,
    uniqueness: 0.10,
    geo: 0.10,
    label: 'Web agency',
    angle: 'website redesign / web presence',
  },
  // Reputation management — heavily weights reputation (the signal they sell
  // against); underweights digital_maturity (orthogonal to their offer).
  'reputation-mgmt': {
    legitimacy: 0.20,
    reputation: 0.35,
    data_quality: 0.15,
    digital_maturity: 0.05,
    establishment: 0.15,
    uniqueness: 0.05,
    geo: 0.05,
    label: 'Reputation management',
    angle: 'reputation management services',
  },
  // SEO agency — weights digital_maturity + data_quality (need a site to
  // optimize) + geo (local SEO matters).
  'seo-agency': {
    legitimacy: 0.15,
    reputation: 0.15,
    data_quality: 0.20,
    digital_maturity: 0.20,
    establishment: 0.10,
    uniqueness: 0.10,
    geo: 0.10,
    label: 'SEO agency',
    angle: 'SEO optimization',
  },
};

const SIGNAL_LABELS = {
  legitimacy: 'Legitimacy',
  reputation: 'Reputation',
  data_quality: 'Data quality',
  digital_maturity: 'Digital maturity',
  establishment: 'Establishment',
  uniqueness: 'Uniqueness',
  geo: 'Geo context',
};

const DEFAULT_PROFILE = 'web-agency';

// Hard cap applied when spam_result.isSpam && spamScore >= SPAM_CAP_THRESHOLD.
const SPAM_CAP_SCORE = 34;
const SPAM_CAP_THRESHOLD = 65;

// Neutral subscore used when a descriptor is missing (defensive default).
const NEUTRAL_SCORE = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

function clamp(n, lo, hi) {
  if (lo === undefined) lo = 0;
  if (hi === undefined) hi = 100;
  return Math.max(lo, Math.min(hi, n));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function numOr(n, fallback) {
  return isNum(n) ? n : fallback;
}

/**
 * Resolve a scoring profile by name. Falls back to the default profile when
 * the requested name is unknown (defensive — callers may pass arbitrary
 * strings from CLI flags).
 *
 * @param {string} [name]
 * @returns {ScoringProfile}
 */
function resolveProfile(name) {
  if (name && Object.prototype.hasOwnProperty.call(SCORING_PROFILES, name)) {
    return SCORING_PROFILES[name];
  }
  return SCORING_PROFILES[DEFAULT_PROFILE];
}

/**
 * Read a nested descriptor off the business object, returning null when
 * absent. Used to defensively access prior-phase outputs (spam_result,
 * chain_result, dedup_result, geo_result, …) without throwing.
 *
 * @param {object} business
 * @param {string} key
 * @returns {object|null}
 */
function readDescriptor(business, key) {
  if (!business || typeof business !== 'object') return null;
  const d = business[key];
  return d && typeof d === 'object' ? d : null;
}

/**
 * Does the spam_result.flags array contain a flag with the given code?
 * Flag codes in the scraper are uppercase (e.g. 'PHONE_REUSE', 'PO_BOX_ADDRESS').
 *
 * @param {object|null} spam
 * @param {string} code
 * @returns {boolean}
 */
function hasSpamFlag(spam, code) {
  if (!spam || !Array.isArray(spam.flags)) return false;
  return spam.flags.some((f) => f && f.code === code);
}

/**
 * Does the geo_result.flags array contain a flag with the given code?
 * Geo flag codes are lowercase (e.g. 'no_geocode', 'isolated_location').
 *
 * @param {object|null} geo
 * @param {string} code
 * @returns {boolean}
 */
function hasGeoFlag(geo, code) {
  if (!geo || !Array.isArray(geo.flags)) return false;
  // Tolerate both {code:'no_geocode'} (object form) and 'no_geocode' (string form).
  return geo.flags.some((f) => {
    if (!f) return false;
    if (typeof f === 'string') return f === code;
    return f.code === code;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-signal subscore computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legitimacy — inverse of the Phase 3.4 spam score, with hard caps for
 * critical/high risk levels and a chain penalty (chain listings are
 * low-value leads — they already have national infrastructure).
 *
 *   Starts at 100.
 *     −1 × spam_result.spamScore      (linear with spam score)
 *     −20 if riskLevel === 'critical'
 *     −10 if riskLevel === 'high'
 *     −15 if chain_result.isChain
 *   Floor 0.
 *
 * If spam_result is missing (Phase 3.4 didn't run), returns neutral 50 with
 * a note explaining the gap — we can't claim a listing is legitimate without
 * a spam scan, but we don't penalize it either.
 *
 * @param {object} business
 * @returns {{ score: number, note: string }}
 */
function computeLegitimacy(business) {
  const spam = readDescriptor(business, 'spam_result');
  if (!spam) {
    return {
      score: NEUTRAL_SCORE,
      note: 'spam_result not available — neutral 50 (Phase 3.4 did not run).',
    };
  }

  let score = 100;
  const parts = [];

  const spamScore = numOr(spam.spamScore, 0);
  if (spamScore > 0) {
    score -= spamScore;
    parts.push(`spamScore −${spamScore}`);
  }

  const level = spam.riskLevel;
  if (level === 'critical') {
    score -= 20;
    parts.push('critical risk −20');
  } else if (level === 'high') {
    score -= 10;
    parts.push('high risk −10');
  }

  const chain = readDescriptor(business, 'chain_result');
  if (chain && chain.isChain) {
    score -= 15;
    parts.push(`chain (${chain.chainName || chain.chainId || 'unknown'}) −15`);
  }

  score = clamp(score);
  const tail = parts.length ? ` · ${parts.join(' · ')}` : ' · clean profile';
  const note = `${score}/100${tail}`;
  return { score, note };
}

/**
 * Reputation — star rating mapped to a 0-100 band, plus a review-volume
 * bonus, minus a penalty when the Phase 3.7 sentiment engine flagged a
 * rating/review mismatch (a 5.0★ rating paired with scathing reviews is a
 * fake-listing tell).
 *
 *   rating:  >=4.5 → 100, >=4.0 → 80, >=3.5 → 60, >=3.0 → 40, else 20
 *   reviews_count bonus:  >=100 → +10, >=50 → +5
 *   sentiment anomaly 'rating_review_mismatch' (or '_high') → −15
 *
 * If rating is missing entirely, returns neutral 50 (reputation unknown).
 *
 * @param {object} business
 * @returns {{ score: number, note: string }}
 */
function computeReputation(business) {
  const rating = numOr(business && business.rating, null);
  if (rating === null) {
    return {
      score: NEUTRAL_SCORE,
      note: 'No rating available — reputation unknown, neutral 50.',
    };
  }

  let base;
  if (rating >= 4.5) base = 100;
  else if (rating >= 4.0) base = 80;
  else if (rating >= 3.5) base = 60;
  else if (rating >= 3.0) base = 40;
  else base = 20;

  const reviewsCount = numOr(business && business.reviews_count, 0);
  let bonus = 0;
  if (reviewsCount >= 100) bonus = 10;
  else if (reviewsCount >= 50) bonus = 5;

  let score = base + bonus;

  // Sentiment anomaly penalty — rating/review mismatch is a fake-listing tell.
  const sentiment = readDescriptor(business, 'sentiment_result');
  let mismatchPenalty = 0;
  if (sentiment && Array.isArray(sentiment.anomalies)) {
    const hasMismatch = sentiment.anomalies.some(
      (a) =>
        a &&
        (a.code === 'rating_review_mismatch' ||
          a.code === 'rating_review_mismatch_high')
    );
    if (hasMismatch) {
      mismatchPenalty = 15;
      score -= mismatchPenalty;
    }
  }

  score = clamp(score);
  const bits = [
    `${rating.toFixed(1)}★ → ${base}`,
    `${reviewsCount} reviews ${bonus ? `(+${bonus})` : '(+0)'}`,
  ];
  if (mismatchPenalty) bits.push(`sentiment mismatch −${mismatchPenalty}`);
  return { score, note: `${score}/100 · ${bits.join(' · ')}` };
}

/**
 * Data quality — additive completeness score across the core fields the
 * pipeline needs to act on a lead. Each present/valid field adds a fixed
 * increment; an invalid phone subtracts heavily (an unreachable lead is
 * near-worthless for outbound).
 *
 *   phone present         +15
 *   phone valid           +10
 *   address complete      +15
 *   geocoded              +10
 *   website               +10
 *   reviews (count > 0)   +10
 *   category              +5
 *   sentiment result      +5
 *   invalid phone         −20
 *
 * Max raw = 80; with invalid phone penalty the floor is 0. Prior phases that
 * didn't run simply contribute 0 to their increment (the score degrades
 * gracefully — a listing with only core scrape fields still scores ~55-60).
 *
 * @param {object} business
 * @returns {{ score: number, note: string }}
 */
function computeDataQuality(business) {
  if (!business) return { score: 0, note: 'No business object.' };

  const parts = [];
  let score = 0;

  // Phone (Phase 3.1)
  const phoneNormalized = readDescriptor(business, 'phone_normalized');
  const phonePresent = Boolean(business.phone_e164 || business.phone);
  const phoneValid = Boolean(
    (phoneNormalized && phoneNormalized.isValid) ||
      (business.phone_e164 && business.phone_type && business.phone_type !== 'invalid')
  );
  if (phonePresent) {
    score += 15;
    parts.push('phone +15');
  }
  if (phoneValid) {
    score += 10;
    parts.push('valid +10');
  } else if (phonePresent && business.phone_type === 'invalid') {
    score -= 20;
    parts.push('invalid phone −20');
  }

  // Address (Phase 3.2)
  const addrComplete =
    Boolean(business.address_street) &&
    Boolean(business.address_city || business.address_state || business.address_country);
  if (addrComplete) {
    score += 15;
    parts.push('address +15');
  }
  const geocoded = isNum(business.lat) && isNum(business.lng);
  if (geocoded) {
    score += 10;
    parts.push('geocoded +10');
  }

  // Website
  if (business.website) {
    score += 10;
    parts.push('website +10');
  }

  // Reviews
  const reviewsCount = numOr(business.reviews_count, 0);
  if (reviewsCount > 0) {
    score += 10;
    parts.push('reviews +10');
  }

  // Category
  if (business.category) {
    score += 5;
    parts.push('category +5');
  }

  // Sentiment (Phase 3.7 — opt-in, needs review text)
  const sentiment = readDescriptor(business, 'sentiment_result');
  if (sentiment) {
    score += 5;
    parts.push('sentiment +5');
  }

  score = clamp(score);
  return { score, note: `${score}/100 · ${parts.join(' · ') || 'no fields present'}` };
}

/**
 * Digital maturity — Phase 3.6 tech-stack sophistication score, modulated by
 * website liveness. The score reflects MATURITY (how sophisticated the web
 * presence is), NOT lead value: a low maturity score is the opportunity a
 * web agency sells against, so SCORING_PROFILES keeps this signal's weight
 * modest in every profile.
 *
 *   If tech_stack_result.sophisticationScore available:
 *     base = sophisticationScore
 *   Else if website present:
 *     base = 30 (website present, sophistication unknown)
 *   Else:
 *     base = 20 (no website — low maturity)
 *   website_liveness 'live'  → +20
 *   website_liveness 'dead'  → −10
 *   website_liveness 'redirected' → +10
 *
 * @param {object} business
 * @returns {{ score: number, note: string }}
 */
function computeDigitalMaturity(business) {
  if (!business) return { score: NEUTRAL_SCORE, note: 'No business object.' };

  const tech = readDescriptor(business, 'tech_stack_result');
  const hasWebsite = Boolean(business.website);
  const liveness = business.website_liveness || null;

  let base;
  let note;

  if (tech && isNum(tech.sophisticationScore)) {
    base = tech.sophisticationScore;
    const techCount = Array.isArray(tech.technologies) ? tech.technologies.length : 0;
    const reachNote = tech.reachable === false ? ' · unreachable' : '';
    note = `sophistication ${base}/100 · ${techCount} tech${reachNote}`;
  } else if (hasWebsite) {
    base = 30;
    note = 'website present · sophistication unknown (Phase 3.6 did not run)';
  } else {
    base = 20;
    note = 'no website · low maturity';
  }

  let adj = 0;
  if (liveness === 'live') {
    adj += 20;
    note += ' · live +20';
  } else if (liveness === 'dead') {
    adj -= 10;
    note += ' · dead −10';
  } else if (liveness === 'redirected') {
    adj += 10;
    note += ' · redirected +10';
  }

  const score = clamp(base + adj);
  return { score, note: `${score}/100 · ${note}` };
}

/**
 * Establishment — review volume as a maturity / longevity proxy. More
 * reviews ≈ longer-operating, better-trafficked business. The bands are
 * coarse on purpose: review count is a noisy signal and exact thresholds
 * would be brittle.
 *
 *   reviews_count >= 200 → 100
 *   reviews_count >= 100 → 80
 *   reviews_count >= 50  → 60
 *   reviews_count >= 20  → 40
 *   reviews_count >= 5   → 20
 *   else                 → 10
 *
 * @param {object} business
 * @returns {{ score: number, note: string }}
 */
function computeEstablishment(business) {
  const rc = numOr(business && business.reviews_count, 0);
  let score;
  let band;
  if (rc >= 200) {
    score = 100;
    band = '>=200 reviews';
  } else if (rc >= 100) {
    score = 80;
    band = '>=100 reviews';
  } else if (rc >= 50) {
    score = 60;
    band = '>=50 reviews';
  } else if (rc >= 20) {
    score = 40;
    band = '>=20 reviews';
  } else if (rc >= 5) {
    score = 20;
    band = '>=5 reviews';
  } else {
    score = 10;
    band = `${rc} review(s)`;
  }
  return { score, note: `${score}/100 · ${band}` };
}

/**
 * Uniqueness — Phase 3.3 dedup similarity (high similarity → low
 * uniqueness), penalized further when the Phase 3.4 spam engine flagged
 * phone reuse across multiple listings (a strong duplicate/fake signal).
 *
 *   base = (1 − dedup_result.maxSimilarity) × 100
 *   PHONE_REUSE spam flag → −20
 *
 * If dedup_result is missing (Phase 3.3 didn't run), returns neutral 50 —
 * we can't assess uniqueness without the dedup pass.
 *
 * @param {object} business
 * @returns {{ score: number, note: string }}
 */
function computeUniqueness(business) {
  const dedup = readDescriptor(business, 'dedup_result');
  if (!dedup) {
    return {
      score: NEUTRAL_SCORE,
      note: 'dedup_result not available — neutral 50 (Phase 3.3 did not run).',
    };
  }

  const maxSim = clamp(numOr(dedup.maxSimilarity, 0), 0, 1);
  let score = (1 - maxSim) * 100;
  const parts = [`maxSimilarity ${maxSim.toFixed(2)} → ${round1(score)}`];

  // A duplicate (non-primary) is superseded by its cluster primary — drop
  // its independent lead value. The dashboard uses 35 for this case; we
  // apply a flat penalty so the cluster primary keeps the higher score.
  if (dedup.isPrimary === false) {
    score -= 20;
    parts.push('duplicate −20');
  }

  // Phone reuse across multiple listings is a strong fake/duplicate signal.
  const spam = readDescriptor(business, 'spam_result');
  if (hasSpamFlag(spam, 'PHONE_REUSE')) {
    score -= 20;
    parts.push('phone reuse −20');
  }

  score = clamp(score);
  return { score, note: `${round1(score)}/100 · ${parts.join(' · ')}` };
}

/**
 * Geo context — Phase 3.8 isolation + area type, penalized when the listing
 * couldn't be geocoded (no competitive context can be computed).
 *
 *   isolation:  isolated → 100, sparse → 80, moderate → 60, dense → 40
 *   areaType:    rural → +10, suburban → 0, urban → −5
 *   no_geocode flag → −15
 *
 * If geo_result is missing (Phase 3.8 didn't run, or the listing couldn't be
 * geocoded and no fallback coord was available), returns neutral 50.
 *
 * @param {object} business
 * @returns {{ score: number, note: string }}
 */
function computeGeo(business) {
  const geo = readDescriptor(business, 'geo_result');
  if (!geo) {
    return {
      score: NEUTRAL_SCORE,
      note: 'geo_result not available — neutral 50 (Phase 3.8 did not run).',
    };
  }

  const isoBase = {
    isolated: 100,
    sparse: 80,
    moderate: 60,
    dense: 40,
  };
  const iso = geo.isolation;
  let score = Object.prototype.hasOwnProperty.call(isoBase, iso)
    ? isoBase[iso]
    : 60;
  const parts = [`isolation ${iso || 'unknown'} → ${score}`];

  const areaAdj = { rural: 10, suburban: 0, urban: -5 };
  const area = geo.areaType;
  if (area && Object.prototype.hasOwnProperty.call(areaAdj, area)) {
    score += areaAdj[area];
    parts.push(`${area} ${areaAdj[area] >= 0 ? '+' : ''}${areaAdj[area]}`);
  }

  if (hasGeoFlag(geo, 'no_geocode')) {
    score -= 15;
    parts.push('no_geocode −15');
  }

  score = clamp(score);
  return { score, note: `${score}/100 · ${parts.join(' · ')}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Grade + tier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a 0-100 composite score to a letter grade.
 *
 *   >= 85 → A
 *   >= 70 → B
 *   >= 55 → C
 *   >= 40 → D
 *   else  → F
 *
 * @param {number} score
 * @returns {'A'|'B'|'C'|'D'|'F'}
 */
function gradeForScore(score) {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Map a 0-100 composite score to a sales/outreach tier. Spam-capped listings
 * are always 'disqualify' regardless of the raw score (the cap forces <= 34,
 * but the flag is checked explicitly to be safe).
 *
 *   >= 85                  → priority
 *   >= 70                  → qualified
 *   >= 55                  → nurture
 *   >= 40                  → monitor
 *   < 40 OR spam-capped    → disqualify
 *
 * @param {number} score
 * @param {boolean} [spamCapped]
 * @returns {'priority'|'qualified'|'nurture'|'monitor'|'disqualify'}
 */
function tierForScore(score, spamCapped) {
  if (spamCapped) return 'disqualify';
  if (score >= 85) return 'priority';
  if (score >= 70) return 'qualified';
  if (score >= 55) return 'nurture';
  if (score >= 40) return 'monitor';
  return 'disqualify';
}

/**
 * Build a one-line recommendation derived from the profile + the weakest
 * signal. The recommendation is what surfaces the outreach angle (e.g. a
 * web-agency profile with low digital_maturity → "website redesign").
 *
 * @param {object} ctx — { tier, profile, profileName, weakest, spamCapped, name }
 * @returns {string}
 */
function recommendationFor(ctx) {
  const {
    tier,
    profile,
    profileName,
    weakest,
    spamCapped,
    name,
  } = ctx;
  const who = name ? ` ${name}` : '';
  const angle = (profile && profile.angle) || 'general outreach';

  if (spamCapped) {
    return `Disqualify${who} — spam-capped (Phase 3.4 spamScore >= ${SPAM_CAP_THRESHOLD}).`;
  }
  if (tier === 'disqualify') {
    return `Disqualify${who} — composite below threshold. Weakest signal: ${weakest.label}.`;
  }
  if (tier === 'priority') {
    return `Priority lead${who} — strong across signals. ${angle} (${profileName}).`;
  }
  if (tier === 'qualified') {
    return `Qualified lead${who} — nurture and address ${weakest.label}. ${angle} (${profileName}).`;
  }
  if (tier === 'nurture') {
    return `Nurture${who} — needs trust-building. Weakest signal: ${weakest.label}. ${angle} (${profileName}).`;
  }
  // monitor
  return `Monitor${who} — mixed signals. Weakest signal: ${weakest.label}. ${angle} (${profileName}).`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factor assembly (strengths / risks)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build top-strengths and top-risks factor lists from the per-signal
 * contributions. A signal is a STRENGTH when its subscore >= 70; a RISK when
 * its subscore < 45. Each factor's `delta` is the absolute weighted
 * deviation from neutral (50). Lists are capped at 3 entries (per spec) and
 * sorted by |delta| descending.
 *
 * @param {Array<{key:string,label:string,score:number,weight:number,note:string}>} signals
 * @returns {{ strengths: object[], risks: object[] }}
 */
function buildTopFactors(signals) {
  const strengths = [];
  const risks = [];
  for (const sig of signals) {
    const deviation = (sig.score - 50) * sig.weight;
    if (sig.score >= 70) {
      strengths.push({
        code: `sig_${sig.key}`,
        label: sig.label,
        detail: sig.note,
        impact: 'positive',
        delta: Math.abs(deviation),
      });
    } else if (sig.score < 45) {
      risks.push({
        code: `sig_${sig.key}`,
        label: `${sig.label} weak`,
        detail: sig.note,
        impact: 'negative',
        delta: Math.abs(deviation),
      });
    }
  }
  strengths.sort((a, b) => b.delta - a.delta);
  risks.sort((a, b) => b.delta - a.delta);
  return {
    strengths: strengths.slice(0, 3),
    risks: risks.slice(0, 3),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API — single-lead scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the full LeadScoreResult for a single business.
 *
 * Pipeline:
 *   1. Resolve the scoring profile (falls back to default).
 *   2. Compute all 7 signal subscores via the compute*() helpers.
 *   3. Weighted sum = Σ(signal.score × profile.weight) → composite 0-100.
 *   4. SPAM CAP: if spam_result.isSpam && spamScore >= 65, hard-cap at 34.
 *   5. grade + tier from the (possibly capped) composite.
 *   6. topStrengths/topRisks from per-signal deviations.
 *   7. recommendation from tier + profile + weakest signal.
 *
 * @param {object} business — enriched business object (see field names above).
 * @param {string} [profileName] — scoring profile name (default 'web-agency').
 * @returns {{
 *   score: number,
 *   grade: string,
 *   tier: string,
 *   profile: string,
 *   signals: Array<{key:string,label:string,score:number,weight:number,contribution:number,note:string}>,
 *   topStrengths: object[],
 *   topRisks: object[],
 *   recommendation: string,
 *   spamCapped: boolean,
 * }}
 */
function scoreLead(business, profileName) {
  const profile = resolveProfile(profileName);
  const resolvedProfileName =
    profileName && Object.prototype.hasOwnProperty.call(SCORING_PROFILES, profileName)
      ? profileName
      : DEFAULT_PROFILE;

  // 1. Compute all 7 signals.
  const outcomes = {
    legitimacy: computeLegitimacy(business),
    reputation: computeReputation(business),
    data_quality: computeDataQuality(business),
    digital_maturity: computeDigitalMaturity(business),
    establishment: computeEstablishment(business),
    uniqueness: computeUniqueness(business),
    geo: computeGeo(business),
  };

  // 2. Build the per-signal contribution list (port of LeadSignalContribution[]).
  const signalKeys = [
    'legitimacy',
    'reputation',
    'data_quality',
    'digital_maturity',
    'establishment',
    'uniqueness',
    'geo',
  ];
  const signals = signalKeys.map((key) => {
    const o = outcomes[key];
    const weight = profile[key];
    return {
      key,
      label: SIGNAL_LABELS[key],
      score: round1(o.score),
      weight,
      contribution: round1(o.score * weight),
      note: o.note,
    };
  });

  // 3. Weighted sum.
  let score = signals.reduce((acc, s) => acc + s.contribution, 0);

  // 4. Spam cap (hard disqualification).
  const spam = readDescriptor(business, 'spam_result');
  let spamCapped = false;
  if (spam && spam.isSpam && numOr(spam.spamScore, 0) >= SPAM_CAP_THRESHOLD) {
    if (score > SPAM_CAP_SCORE) {
      score = SPAM_CAP_SCORE;
      spamCapped = true;
    }
  }

  score = clamp(Math.round(score));

  // 5. Grade + tier.
  const grade = gradeForScore(score);
  const tier = tierForScore(score, spamCapped);

  // 6. Strengths + risks (top 3 each).
  const { strengths, risks } = buildTopFactors(signals);

  // 7. Recommendation — uses the weakest signal (lowest subscore).
  let weakest = signals[0];
  for (const s of signals) {
    if (s.score < weakest.score) weakest = s;
  }
  const recommendation = recommendationFor({
    tier,
    profile,
    profileName: resolvedProfileName,
    weakest: { label: weakest.label, key: weakest.key },
    spamCapped,
    name: business && business.name ? business.name : '',
  });

  return {
    score,
    grade,
    tier,
    profile: resolvedProfileName,
    signals,
    topStrengths: strengths,
    topRisks: risks,
    recommendation,
    spamCapped,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Score a batch of businesses IN PLACE. Each business is mutated with:
 *   - lead_score          INT 0-100  (persisted)
 *   - lead_score_profile  TEXT       (persisted)
 *   - lead_result         object     (debug descriptor — NOT persisted; powers
 *                                     the CLI banner + downstream grid/confidence)
 *
 * Returns batch-level aggregates the CLI banner / pipeline stats consume:
 *   total, avgScore, gradeDist {A,B,C,D,F}, tierDist {priority, qualified,
 *   nurture, monitor, disqualify}, priorityLeads, disqualifiedLeads, spamCapped.
 *
 * @param {object[]} businesses — mutated in place.
 * @param {object} [opts] — { profile, logger }
 * @returns {{
 *   total: number,
 *   avgScore: number,
 *   gradeDist: { A:number, B:number, C:number, D:number, F:number },
 *   tierDist: { priority:number, qualified:number, nurture:number, monitor:number, disqualify:number },
 *   priorityLeads: number,
 *   disqualifiedLeads: number,
 *   spamCapped: number,
 *   skipped: number,
 * }}
 */
function scoreLeadsBatch(businesses, opts) {
  const o = opts || {};
  const list = Array.isArray(businesses) ? businesses : [];
  const profileName = o.profile || DEFAULT_PROFILE;

  const stats = {
    total: list.length,
    avgScore: 0,
    gradeDist: { A: 0, B: 0, C: 0, D: 0, F: 0 },
    tierDist: {
      priority: 0,
      qualified: 0,
      nurture: 0,
      monitor: 0,
      disqualify: 0,
    },
    priorityLeads: 0,
    disqualifiedLeads: 0,
    spamCapped: 0,
    skipped: 0,
  };

  let scoreSum = 0;
  let scored = 0;

  for (const business of list) {
    if (!business || typeof business !== 'object') {
      stats.skipped++;
      continue;
    }

    const result = scoreLead(business, profileName);

    // Persisted columns (the two ENRICHMENT_COLUMNS this module owns).
    business.lead_score = result.score;
    business.lead_score_profile = result.profile;

    // Debug descriptor — NOT persisted (the DB schema only stores the two
    // columns above). Powers the CLI banner, the grid (Phase 3.11), and the
    // confidence phase (Phase 3.10).
    business.lead_result = result;

    scoreSum += result.score;
    scored++;

    if (Object.prototype.hasOwnProperty.call(stats.gradeDist, result.grade)) {
      stats.gradeDist[result.grade]++;
    }
    if (Object.prototype.hasOwnProperty.call(stats.tierDist, result.tier)) {
      stats.tierDist[result.tier]++;
    }
    if (result.tier === 'priority') stats.priorityLeads++;
    if (result.tier === 'disqualify') stats.disqualifiedLeads++;
    if (result.spamCapped) stats.spamCapped++;
  }

  stats.avgScore = scored ? Math.round((scoreSum / scored) * 100) / 100 : 0;
  return stats;
}

module.exports = {
  __version,
  ENRICHMENT_COLUMNS,
  // Scoring config
  SCORING_PROFILES,
  SIGNAL_LABELS,
  DEFAULT_PROFILE,
  SPAM_CAP_SCORE,
  SPAM_CAP_THRESHOLD,
  // Per-signal subscore helpers (exported for unit tests)
  computeLegitimacy,
  computeReputation,
  computeDataQuality,
  computeDigitalMaturity,
  computeEstablishment,
  computeUniqueness,
  computeGeo,
  // Grade + tier
  gradeForScore,
  tierForScore,
  // Core API
  scoreLead,
  scoreLeadsBatch,
  // Helpers (exported for unit tests)
  resolveProfile,
  clamp,
  round1,
};
