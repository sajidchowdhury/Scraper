'use strict';

/**
 * src/enrichment/confidence.js — Phase 3.10 — Confidence (Evidence Depth)
 *
 * Confidence is DISTINCT from the lead score (Phase 3.9). The lead score says
 * how *attractive* a listing is; confidence says how much *evidence* underpins
 * that score. A 5.0★ listing with zero reviews, no website and a shaky geocode
 * could be a fantastic lead or could be spam — the lead score can't tell those
 * two apart, but confidence can. It surfaces the uncertainty so an operator
 * knows which lead scores to trust and which need enrichment before outreach.
 *
 *   Lead score (3.9)  →  "how attractive?"      (0-100, graded A–F)
 *   Confidence (3.10) →  "how well-evidenced?"   (0-100, banded 5 ways)
 *
 * MODEL (ported from the dashboard's confidence.ts, re-shaped to the scraper's
 * snake_case descriptor layout)
 *   - Neutral base of 50, then signed deltas from eight evidence dimensions.
 *   - Each dimension emits a {code, label, detail, impact, delta} factor so the
 *     reasoning is transparent and explainable to a human reviewer.
 *   - Raw field gaps (name/phone/address/website/rating/reviews/lat-lng) each
 *     nibble 2 points off the base; the high-impact gaps (phone, website,
 *     address, geocode) additionally fire explicit MISSING_* factors.
 *   - Pipeline descriptors that didn't run (defensive: prior phases may be
 *     absent) contribute NOTHING — neither positive nor negative. Only their
 *     absence from signalCoverage is noted.
 *
 *   Dimension             Source descriptor (snake_case)
 *   ────────────────────  ───────────────────────────────────────────────────
 *   phone reliability     phone_e164 / phone_normalized.isValid  (Phase 3.1)
 *   address reliability   lat, lng, geocode_confidence           (Phase 3.2)
 *   dedup state           dedup_result                           (Phase 3.3)
 *   spam uncertainty      spam_result {spamScore, riskLevel}     (Phase 3.4)
 *   chain membership      chain_result                           (Phase 3.4)
 *   tech coverage         tech_stack_result, website_liveness    (Phase 3.6)
 *   review volume         reviews_count, sentiment_result        (Phase 3.7)
 *   geo context           geo_result {coordSource, flags[]}      (Phase 3.8)
 *   lead present          lead_score / lead_result               (Phase 3.9)
 *
 * DESIGN RULES (per PHASE3_EXECUTION_PLAN.md §3.10)
 *   - Pure functions (no DB / network / external deps). Reads the business
 *     descriptors only; never mutates them outside the batch wrapper.
 *   - 'use strict'; CommonJS. No TypeScript.
 *   - Confidence is stored as 0.00–1.00 (the DB column is NUMERIC(4,2)). We
 *     compute 0-100 internally and divide by 100 for storage. The debug
 *     descriptor (confidence_result) keeps the 0-100 score + full factors.
 *   - Be defensive: every descriptor access tolerates null/undefined. A missing
 *     descriptor → that signal contributes nothing.
 *   - Bands (per spec, NOT the dashboard's bands): very_low <20, low 20-39,
 *     medium 40-59, high 60-79, very_high >=80.
 *
 * PUBLIC API
 *   fieldConfidence(business, field)        → number (0-1) per-field confidence
 *   recordConfidence(business)              → number (0-1) composite (0-100 / 100)
 *   computeConfidence(business)             → {score, band, factors, missingFields, signalCoverage, note}
 *   computeConfidenceBatch(businesses, opts)→ {total, avgConfidence, bandDist, lowConfidenceListings, avgSignalCoverage}
 *   bandForConfidence(score)                → 'very_low'|'low'|'medium'|'high'|'very_high'
 *   BAND_LABELS                             → {very_low:'Very low', ...}
 *   ENRICHMENT_COLUMNS                      → ['confidence_score']
 */

const __version = 1;

const ENRICHMENT_COLUMNS = ['confidence_score'];

/** Total pipeline signals tracked for coverage (phone/address/dedup/spam/tech/sentiment/geo/lead). */
const TOTAL_SIGNALS = 8;

/** Human-readable band labels, keyed by band code. */
const BAND_LABELS = {
  very_low: 'Very low',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  very_high: 'Very high',
};

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamp a number into [lo, hi]. Defaults to the 0-100 confidence range.
 *
 * @param {number} n
 * @param {number} [lo=0]
 * @param {number} [hi=100]
 * @returns {number}
 */
function clamp(n, lo, hi) {
  const low = lo === undefined ? 0 : lo;
  const high = hi === undefined ? 100 : hi;
  return Math.max(low, Math.min(high, n));
}

/**
 * Build a positive-impact factor.
 * @param {string} code
 * @param {string} label
 * @param {string} detail
 * @param {number} delta
 * @returns {{code:string,label:string,detail:string,impact:string,delta:number}}
 */
function pos(code, label, detail, delta) {
  return { code, label, detail, impact: 'positive', delta };
}

/**
 * Build a negative-impact factor.
 * @param {string} code
 * @param {string} label
 * @param {string} detail
 * @param {number} delta
 * @returns {{code:string,label:string,detail:string,impact:string,delta:number}}
 */
function neg(code, label, detail, delta) {
  return { code, label, detail, impact: 'negative', delta };
}

/**
 * Build a neutral-impact factor (delta 0).
 * @param {string} code
 * @param {string} label
 * @param {string} detail
 * @returns {{code:string,label:string,detail:string,impact:string,delta:number}}
 */
function neu(code, label, detail) {
  return { code, label, detail, impact: 'neutral', delta: 0 };
}

/**
 * Map a 0-100 confidence score to its band.
 *   very_low: <20, low: 20-39, medium: 40-59, high: 60-79, very_high: >=80
 *
 * @param {number} score — 0-100
 * @returns {'very_low'|'low'|'medium'|'high'|'very_high'}
 */
function bandForConfidence(score) {
  if (score >= 80) return 'very_high';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  if (score >= 20) return 'low';
  return 'very_low';
}

// ─────────────────────────────────────────────────────────────────────────────
// Defensive descriptor accessors
// ─────────────────────────────────────────────────────────────────────────────

/** Truthy non-empty string check (also rejects whitespace-only strings). */
function hasStr(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** True when a numeric value is a finite number. */
function hasNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Coerce a maybe-null rating to a number, else null. */
function numOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-field confidence (0-1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute per-field confidence (0-1) for a single field on a business record.
 *
 * Field weights (per Phase 3.10 spec):
 *   name          0.95 (always present in Maps; 0.3 if somehow missing)
 *   phone         0.9 if phone_e164 valid / phone_normalized.isValid,
 *                 0.5 if invalid type, 0.3 if missing
 *   address       0.9 if geocoded (geocode_confidence>=0.7),
 *                 0.6 if parsed but not geocoded, 0.3 if raw only
 *   website       0.85 if live (website_liveness='live'),
 *                 0.5 if dead, 0.4 if unverified, 0.2 if missing
 *   category      0.9
 *   rating        0.8 if reviews_count>=20, 0.5 if >=5, 0.2 if <5
 *   reviews_count 0.9
 *   lat / lng     0.9 if geocoded, 0.7 if raw scrape, 0 if none
 *   (default)     0.5 for unknown fields
 *
 * @param {object} business — enriched business record.
 * @param {string} field — one of the field names above.
 * @returns {number} confidence in [0, 1]
 */
function fieldConfidence(business, field) {
  if (!business || typeof business !== 'object' || !field) return 0.5;
  const b = business;

  switch (field) {
    case 'name':
      // Always present in Google Maps scrapes. Defensively drop to 0.3 if absent.
      return hasStr(b.name) ? 0.95 : 0.3;

    case 'phone': {
      if (!hasStr(b.phone)) return 0.3;
      // Validity: prefer the Phase 3.1 descriptor, fall back to phone_e164 presence.
      const pn = b.phone_normalized;
      const isValid = (pn && pn.isValid === true) || hasStr(b.phone_e164);
      if (isValid) return 0.9;
      // Invalid type or unparseable → 0.5 (we have something, but it's shaky).
      return 0.5;
    }

    case 'address': {
      const gc = numOrNull(b.geocode_confidence);
      const hasCoords = hasNum(b.lat) && hasNum(b.lng);
      const parsed = hasStr(b.address_street) || hasStr(b.address_city) || hasStr(b.address_state);
      if (hasCoords && gc !== null && gc >= 0.7) return 0.9;
      if (parsed) return 0.6;
      if (hasStr(b.address)) return 0.3;
      return 0.3;
    }

    case 'website': {
      if (!hasStr(b.website)) return 0.2;
      if (b.website_liveness === 'live') return 0.85;
      if (b.website_liveness === 'dead' || b.website_liveness === 'error') return 0.5;
      // 'redirected' or unset → unverified.
      return 0.4;
    }

    case 'category':
      return hasStr(b.category) ? 0.9 : 0.3;

    case 'rating': {
      if (!hasNum(b.rating)) return 0.2;
      const rc = numOrNull(b.reviews_count);
      if (rc !== null && rc >= 20) return 0.8;
      if (rc !== null && rc >= 5) return 0.5;
      return 0.2; // low-volume ratings are noisy
    }

    case 'reviews_count':
      return hasNum(b.reviews_count) ? 0.9 : 0.3;

    case 'lat':
    case 'lng': {
      const hasCoords = hasNum(b.lat) && hasNum(b.lng);
      if (!hasCoords) return 0;
      const gc = numOrNull(b.geocode_confidence);
      const geoSrc = b.geo_result && b.geo_result.coordSource;
      // Geocoded (Phase 3.2 or 3.8) → 0.9; raw scrape coords only → 0.7.
      if ((gc !== null && gc >= 0.7) || geoSrc === 'geocoded') return 0.9;
      if (geoSrc === 'raw' || geoSrc === 'geocoded') return 0.9;
      // Coords present but origin unknown → assume raw scrape.
      return 0.7;
    }

    default:
      return 0.5;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite confidence (full ConfidenceResult)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the full confidence descriptor for a business record.
 *
 * Returns the dashboard-shaped ConfidenceResult:
 *   { score (0-100), band, factors[], missingFields[], signalCoverage (0-1), note }
 *
 * @param {object} business — enriched business record (reads descriptors from
 *   Phases 3.1–3.9; all are optional — missing ones simply don't contribute).
 * @returns {{score:number, band:string, factors:object[], missingFields:string[], signalCoverage:number, note:string}}
 */
function computeConfidence(business) {
  const b = business && typeof business === 'object' ? business : {};
  const factors = [];
  const missingFields = [];
  let score = 50; // neutral base
  let signalsCovered = 0;

  // ── Raw field completeness ──────────────────────────────────────────────
  // Each missing raw field nibbles 2 points off the base. High-impact gaps
  // (phone/website/address/geocode) additionally fire explicit MISSING_*
  // factors below.
  if (!hasStr(b.name)) missingFields.push('name');
  if (!hasStr(b.phone)) missingFields.push('phone');
  if (!hasStr(b.address)) missingFields.push('address');
  if (!hasStr(b.website)) missingFields.push('website');
  if (!hasNum(b.rating) && numOrNull(b.rating) === null) missingFields.push('rating');
  if (!hasNum(b.reviews_count)) missingFields.push('reviews');
  if (!hasNum(b.lat) || !hasNum(b.lng)) missingFields.push('lat/lng');
  score -= missingFields.length * 2;

  // ── 1. Phone reliability (Phase 3.1) ────────────────────────────────────
  const hasRawPhone = hasStr(b.phone);
  const pn = b.phone_normalized;
  const phoneValid = (pn && pn.isValid === true) || hasStr(b.phone_e164);
  const phoneInvalid = hasRawPhone && !phoneValid &&
    ((pn && pn.isValid === false) || b.phone_type === 'invalid');

  if (!hasRawPhone) {
    score -= 10;
    factors.push(neg('MISSING_PHONE', 'Missing phone', 'No phone number captured from Maps.', -10));
  } else {
    score += 8;
    factors.push(pos('HAS_PHONE', 'Phone present', 'Phone number captured from Maps.', 8));
    if (phoneValid) {
      score += 5;
      factors.push(pos('HAS_VALID_PHONE', 'Valid phone', 'Phone passed E.164 normalization & validation.', 5));
    } else if (phoneInvalid) {
      score -= 12;
      factors.push(neg('INVALID_PHONE', 'Invalid phone', 'Phone present but failed E.164 validation.', -12));
    }
  }

  // ── 2. Address / geocode (Phase 3.2) ────────────────────────────────────
  if (!hasStr(b.address)) {
    score -= 8;
    factors.push(neg('MISSING_ADDRESS', 'Missing address', 'No address captured from Maps.', -8));
  }

  const hasCoords = hasNum(b.lat) && hasNum(b.lng);
  const gc = numOrNull(b.geocode_confidence);
  if (!hasCoords) {
    score -= 10;
    factors.push(neg('MISSING_GEOCODE', 'No geocode', 'Address could not be geocoded to coordinates.', -10));
  } else {
    score += 6;
    factors.push(pos('HAS_GEOCODE', 'Geocoded', 'Coordinates resolved for this listing.', 6));
    if (gc !== null && gc >= 0.9) {
      score += 4;
      factors.push(pos(
        'HIGH_GEOCODE_CONFIDENCE',
        'High geocode confidence',
        'Geocode confidence ' + (gc * 100).toFixed(0) + '%.',
        4,
      ));
    }
  }

  // ── 3. Website liveness (Phase 3.6) ─────────────────────────────────────
  if (!hasStr(b.website)) {
    score -= 8;
    factors.push(neg('MISSING_WEBSITE', 'Missing website', 'No website URL captured from Maps.', -8));
  } else {
    score += 6;
    factors.push(pos('HAS_WEBSITE', 'Website present', 'Website URL captured from Maps.', 6));
    if (b.website_liveness === 'live') {
      score += 4;
      factors.push(pos('HAS_LIVE_WEBSITE', 'Live website', 'Website is reachable and serving content.', 4));
    }
  }

  // ── 4. Review volume (Phase 3.7) ────────────────────────────────────────
  const rc = numOrNull(b.reviews_count);
  if (rc !== null && rc > 0) {
    score += 5;
    factors.push(pos('HAS_REVIEWS', 'Reviews present', rc + ' review(s) captured.', 5));
    if (rc >= 20) {
      score += 6;
      factors.push(pos(
        'HIGH_REVIEW_VOLUME',
        'High review volume',
        rc + ' reviews → statistically robust reputation signal.',
        6,
      ));
    } else if (rc < 5) {
      score -= 6;
      factors.push(neg(
        'LOW_REVIEW_VOLUME',
        'Low review volume',
        'Only ' + rc + ' review(s) — reputation signal is fragile.',
        -6,
      ));
    }
  }

  // ── 5. Sentiment (Phase 3.7) ────────────────────────────────────────────
  const sent = b.sentiment_result;
  if (sent && hasNum(sent.reviewCount) && sent.reviewCount > 0) {
    score += 4;
    factors.push(pos(
      'HAS_SENTIMENT',
      'Sentiment analyzed',
      sent.reviewCount + ' review(s) analyzed for sentiment.',
      4,
    ));

    // Rating / review mismatch — a fake-listing tell.
    const consistency = sent.ratingConsistency;
    if (consistency === 'severe_mismatch' || consistency === 'mismatch') {
      score -= 8;
      factors.push(neg(
        'RATING_REVIEW_MISMATCH',
        'Rating / review mismatch',
        'Star rating and review-derived sentiment diverge — reputation unreliable.',
        -8,
      ));
    }
  }

  // ── 6. Tech stack (Phase 3.6) ───────────────────────────────────────────
  const tech = b.tech_stack_result;
  if (tech) {
    const soph = hasNum(tech.sophisticationScore) ? tech.sophisticationScore : 0;
    score += 3;
    factors.push(pos(
      'HAS_TECH_STACK',
      'Tech stack analyzed',
      'Website analyzed — sophistication ' + soph + '/100.',
      3,
    ));
  }

  // ── 7. Spam uncertainty (Phase 3.4) — score delta only ──────────────────
  const spam = b.spam_result;
  if (spam) {
    const flagged = spam.isSpam === true ||
      spam.riskLevel === 'high' || spam.riskLevel === 'critical';
    if (flagged) {
      score -= 20;
      factors.push(neg(
        'SPAM_FLAGGED',
        'Flagged as spam',
        'Spam score ' + (hasNum(spam.spamScore) ? spam.spamScore : '?') + '/100, risk ' + spam.riskLevel + ' — listing identity in doubt.',
        -20,
      ));
    }
  }

  // ── Signal coverage (the 8 pipeline signals per spec) ───────────────────
  // A signal counts as covered when its Phase produced a usable descriptor.
  // Defensive: missing descriptors contribute nothing (no coverage credit,
  // no score delta). reviews_count is a raw field, NOT a pipeline signal —
  // the sentiment signal (Phase 3.7) carries review-volume coverage.
  // 1. phone        — Phase 3.1 ran (phone_normalized / phone_e164 / phone_type)
  // 2. address      — Phase 3.2 geocoded (lat + lng present)
  // 3. dedup        — dedup_result present (Phase 3.3)
  // 4. chain/spam   — spam_result OR chain_result present (Phase 3.4)
  // 5. tech         — tech_stack_result present (Phase 3.6)
  // 6. sentiment    — sentiment_result present (Phase 3.7)
  // 7. geo          — geo_result present (Phase 3.8)
  // 8. lead         — lead_result OR lead_score present (Phase 3.9)
  if (pn || hasStr(b.phone_e164) || hasStr(b.phone_type)) signalsCovered++;
  if (hasCoords) signalsCovered++;
  if (b.dedup_result) signalsCovered++;
  if (spam || b.chain_result) signalsCovered++;
  if (b.tech_stack_result) signalsCovered++;
  if (b.sentiment_result) signalsCovered++;
  if (b.geo_result) signalsCovered++;
  if (b.lead_result || hasNum(b.lead_score)) signalsCovered++;

  // ── Finalize ────────────────────────────────────────────────────────────
  score = clamp(Math.round(score));
  const band = bandForConfidence(score);
  const signalCoverage = signalsCovered / TOTAL_SIGNALS;

  // Order factors by absolute delta (biggest drivers first).
  factors.sort(function (a, b2) {
    return Math.abs(b2.delta) - Math.abs(a.delta);
  });

  const note = BAND_LABELS[band] + ' confidence · ' +
    signalsCovered + '/' + TOTAL_SIGNALS + ' signals covered · ' +
    missingFields.length + ' missing field(s)';

  return {
    score: score,
    band: band,
    factors: factors.slice(0, 8),
    missingFields: missingFields,
    signalCoverage: signalCoverage,
    note: note,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Composite record confidence (0-1) — short-form API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the composite record-level confidence score (0-1).
 *
 * This is the short-form API promised by the Phase 3.0 stub. It delegates to
 * computeConfidence and returns the 0-100 score normalized to 0-1 (rounded to
 * 2 decimals), matching the storage shape of the `confidence_score` column.
 *
 * @param {object} business — enriched business record.
 * @returns {number} confidence in [0, 1]
 */
function recordConfidence(business) {
  const result = computeConfidence(business);
  return Math.round(result.score) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch wrapper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute confidence across a batch of businesses IN PLACE. Each business is
 * mutated with:
 *   - confidence_score  — NUMERIC(4,2) value 0.00-1.00 (the persisted column).
 *   - confidence_result — full debug descriptor (0-100 score + factors + note).
 *     NOT persisted; useful for the CLI banner and downstream debugging.
 *
 * @param {object[]} businesses — mutated in place.
 * @param {object} [opts] — { logger } (reserved for future use / parity with
 *   other batch wrappers).
 * @returns {{total:number, avgConfidence:number, bandDist:object, lowConfidenceListings:number, avgSignalCoverage:number}}
 */
function computeConfidenceBatch(businesses, opts) {
  const o = opts || {};
  const list = Array.isArray(businesses) ? businesses : [];
  const stats = {
    total: list.length,
    avgConfidence: 0,
    bandDist: { very_low: 0, low: 0, medium: 0, high: 0, very_high: 0 },
    lowConfidenceListings: 0,
    avgSignalCoverage: 0,
  };

  let confSum = 0;
  let coverageSum = 0;

  for (const business of list) {
    if (!business || typeof business !== 'object') {
      // Skip non-records but still count them in the total (callers can detect
      // the gap between total and the bandDist sum).
      continue;
    }

    const result = computeConfidence(business);
    const stored = Math.round(result.score) / 100; // 0.00-1.00, 2 decimals

    business.confidence_score = stored;
    business.confidence_result = result; // debug descriptor (NOT persisted)

    confSum += stored;
    coverageSum += result.signalCoverage;

    if (Object.prototype.hasOwnProperty.call(stats.bandDist, result.band)) {
      stats.bandDist[result.band]++;
    }
    if (result.band === 'very_low' || result.band === 'low') {
      stats.lowConfidenceListings++;
    }

    if (o.logger && typeof o.logger.debug === 'function') {
      try {
        o.logger.debug('confidence', {
          name: business.name,
          score: result.score,
          band: result.band,
          coverage: result.signalCoverage,
        });
      } catch (_e) {
        // Logging is best-effort; never let it break the batch.
      }
    }
  }

  const n = list.length;
  stats.avgConfidence = n ? Math.round((confSum / n) * 100) / 100 : 0;
  stats.avgSignalCoverage = n ? Math.round((coverageSum / n) * 100) / 100 : 0;
  return stats;
}

module.exports = {
  __version,
  ENRICHMENT_COLUMNS,
  // Core API
  fieldConfidence,
  recordConfidence,
  computeConfidence,
  computeConfidenceBatch,
  // Band helpers (exported for unit tests + downstream grid/CLI use)
  bandForConfidence,
  BAND_LABELS,
  // Constants
  TOTAL_SIGNALS,
};
