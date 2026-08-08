'use strict';

/**
 * src/enrichment/dedup.js — Phase 3.3 — Deduplication & Fuzzy Matching
 *
 * Detects businesses listed under slightly different names (e.g. "McDonald's"
 * vs "McDonalds" vs "McDonald's Restaurant"), clusters them into canonical
 * records, and tracks the decisions in `business_duplicates` so re-runs are
 * idempotent.
 *
 * WHY THIS MODULE EXISTS
 *   Google Maps occasionally lists the same physical business under multiple
 *   place_ids (variations in the name, address formatting, or category). A
 *   10k-business scrape might have 10–15% duplicates — clients pay for fake
 *   leads, analytics are skewed (competitor-density counts are inflated,
 *   market-size estimates are wrong). This module:
 *     1. Normalizes names (strip punctuation, suffixes, case) for comparison.
 *     2. Computes a 0.00–1.00 similarity score using a weighted combination
 *        of name fuzzy-match (Fuse.js), phone E.164 exact match, and address
 *        proximity (geocode distance < 100m).
 *     3. Blocks the businesses into near-match buckets (by name prefix, phone,
 *        or geocode cell) to keep the comparison near-linear (not O(n²)).
 *     4. Clusters businesses above the threshold, picks a canonical record,
 *        and backfills missing fields from duplicates (with provenance).
 *
 * DESIGN RULES (per PHASE3_EXECUTION_PLAN.md §3.3)
 *   - Pure functions for normalize / similarity / cluster / merge — fully
 *     unit-testable without a DB or network.
 *   - Fuse.js is loaded via a DI seam (`_loadFuse`) so tests can inject a
 *     stub. Production uses the real Fuse.js with a tuned threshold.
 *   - Blocking reduces 10k×10k = 100M comparisons to ~10k×10 = 100k by only
 *     comparing within blocks. Three blocking strategies:
 *       * name-prefix  — first 3 chars of normalized name + country.
 *       * phone        — exact E.164 match = instant duplicate.
 *       * geocode-cell — lat/lng rounded to 3 decimal places (~100m).
 *     A business appears in up to 3 blocks; within-block comparisons use the
 *     full similarity function.
 *   - Idempotent: re-running on the same input produces the same clusters.
 *     The `business_duplicates` table upserts (ON CONFLICT) so re-runs don't
 *     duplicate rows — see src/db.js persistDuplicates().
 *
 * SIMILARITY WEIGHTS (tuned per the execution plan)
 *   - Name fuzzy match (Fuse.js):    0.5
 *   - Phone E.164 exact match:       0.3
 *   - Address proximity (< 100m):    0.2
 *   A business pair is a "duplicate" when the weighted score ≥ threshold
 *   (default 0.85). The phone and address signals are binary (1.0 or 0.0);
 *   the name signal is the Fuse.js similarity (0.0–1.0).
 *
 * PUBLIC API
 *   normalizeBusinessName(name)            → 'mcdonalds' | 'burger king' | ...
 *   computeSimilarity(businessA, businessB, opts?) → { score, components, method }
 *   findDuplicates(businesses, opts?)      → { clusters, pairs, stats }
 *   mergeCluster(cluster, opts?)           → { canonical, merged, backfilled }
 *   pickCanonical(cluster)                 → business (the most complete record)
 *   blockKey(business, strategy)           → string (the blocking key)
 *   findDuplicatePairs(businesses, opts?)  → Array<{ canonical, duplicate, score, method }>
 *   DEFAULT_THRESHOLD, SIMILARITY_WEIGHTS, NAME_SUFFIXES
 */

const __version = 1;

// Dedup writes to the `business_duplicates` table (not the `businesses` table),
// so it contributes no enrichment columns. Declared as [] so the enrichment
// barrel (index.js) can aggregate it without a TypeError.
const ENRICHMENT_COLUMNS = [];

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/**
 * Default similarity threshold above which two businesses are considered
 * duplicates. 0.85 is the "sweet spot" validated against the Phase 3 fixture:
 * catches "McDonald's" vs "McDonalds" (0.95) and "Burger King" vs "Burger King
 * Restaurant" (0.88), but not "Burger King" vs "Burger Joint" (0.55).
 */
const DEFAULT_THRESHOLD = 0.85;

/**
 * Weighted contribution of each signal to the composite similarity score.
 * Must sum to 1.0. Tuned per the execution plan.
 */
const SIMILARITY_WEIGHTS = {
  name: 0.5,
  phone: 0.3,
  address: 0.2,
};

/**
 * Business-name suffixes stripped during normalization. These are generic
 * descriptors that don't distinguish one business from another with the same
 * root name. Case-insensitive, matched at the end of the name.
 */
const NAME_SUFFIXES = [
  // Restaurant/food
  'restaurant', 'restaurante', 'ristorante', 'cafe', 'café', 'coffee shop',
  'coffee house', 'bar', 'grill', 'diner', 'bistro', 'pub', 'tavern',
  'bakery', 'pizzeria', 'trattoria',
  // Retail
  'store', 'shop', 'mart', 'market', 'outlet', 'boutique',
  // Services
  'salon', 'spa', 'studio', 'gym', 'fitness center',
  // Legal entities
  'llc', 'inc', 'inc.', 'ltd', 'ltd.', 'co', 'co.', 'corp', 'corp.',
  'corporation', 'company', 'limited', 'group', 'holdings',
  // Generic
  'the', 'center', 'centre', 'plaza', 'mall',
];

/**
 * Suffixes as a single regex for efficient stripping. Matches at the end of
 * the string (after the rest of normalization). Built once at module load.
 */
const SUFFIX_REGEX = new RegExp(
  '\\s+(' + NAME_SUFFIXES.map((s) => s.replace(/[.+]/g, '\\$&')).join('|') + ')$',
  'i',
);

// ---------------------------------------------------------------------------
// DI seam for Fuse.js. Tests inject a stub via _setFuse to avoid the ~50 KB
// import in unit-test runs (and to control the similarity output).
// ---------------------------------------------------------------------------
let _fuseLib = null;
function _loadFuse() {
  if (_fuseLib) return _fuseLib;
  try {
    _fuseLib = require('fuse.js');
  } catch (_e) {
    _fuseLib = null;
  }
  return _fuseLib;
}
function _setFuse(stub) {
  _fuseLib = stub;
}

// ---------------------------------------------------------------------------
// Name normalization (pure)
// ---------------------------------------------------------------------------

/**
 * Normalize a business name for fuzzy comparison. Pipeline:
 *   1. Lowercase.
 *   2. Strip leading "the ".
 *   3. Strip punctuation (keep alphanumerics + spaces).
 *   4. Collapse whitespace.
 *   5. Strip known suffixes (Restaurant, LLC, Inc, ...).
 *   6. Trim.
 *
 * Examples:
 *   "McDonald's"           → "mcdonalds"
 *   "McDonald's Restaurant" → "mcdonalds"
 *   "The Burger King, Inc." → "burger king"
 *   "Café du Monde LLC"    → "cafe du monde"
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeBusinessName(name) {
  if (!name || typeof name !== 'string') return '';
  let s = name.toLowerCase();
  // Strip leading "the ".
  s = s.replace(/^the\s+/, '');
  // Remove intra-word apostrophes/hyphens (McDonald's → mcdonalds, cross-road → crossroad).
  // Done BEFORE general punctuation stripping so the apostrophe doesn't become a space.
  s = s.replace(/(\w)['\u2019\-](\w)/g, '$1$2');
  // Strip remaining punctuation: keep alphanumerics + spaces (commas, periods
  // become spaces so "Burger King, Inc." → "burger king  inc").
  s = s.replace(/[^\w\s]/g, ' ');
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  // Strip known suffixes (iteratively — "The Burger King Restaurant LLC" has 2).
  let prev;
  do {
    prev = s;
    s = s.replace(SUFFIX_REGEX, '');
  } while (s !== prev);
  return s.trim();
}

// ---------------------------------------------------------------------------
// Geocode distance (pure, haversine)
// ---------------------------------------------------------------------------

/**
 * Haversine distance between two lat/lng points, in meters. Pure — used for
 * the address-proximity signal. Returns Infinity when either point is missing
 * a coordinate.
 *
 * @param {{ lat: number, lng: number }} a
 * @param {{ lat: number, lng: number }} b
 * @returns {number} meters
 */
function haversineMeters(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) {
    return Infinity;
  }
  const R = 6371000; // Earth radius in meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Address proximity predicate: true when the two businesses are within
 * `maxMeters` of each other (default 100m). Uses the geocoded lat/lng
 * (Phase 3.2's `lat`/`lng` enrichment columns), falling back to the raw
 * scrape `latitude`/`longitude` if geocoding hasn't run.
 *
 * @param {object} a
 * @param {object} b
 * @param {number} [maxMeters=100]
 * @returns {boolean}
 */
function isAddressClose(a, b, maxMeters = 100) {
  const aLoc = { lat: a && (a.lat != null ? a.lat : a.latitude), lng: a && (a.lng != null ? a.lng : a.longitude) };
  const bLoc = { lat: b && (b.lat != null ? b.lat : b.latitude), lng: b && (b.lng != null ? b.lng : b.longitude) };
  if (aLoc.lat == null || bLoc.lat == null) return false;
  return haversineMeters(aLoc, bLoc) <= maxMeters;
}

// ---------------------------------------------------------------------------
// Similarity scoring (pure)
// ---------------------------------------------------------------------------

/**
 * Compute the Fuse.js similarity between two normalized names. Returns a
 * 0.0–1.0 score where 1.0 = exact match and 0.0 = no overlap.
 *
 * Fuse.js doesn't expose a direct "similarity" function — it's a search
 * library. We work around this by creating a Fuse instance with one name as
 * the list and searching for the other; the best match's `score` (lower is
 * better, 0 = perfect) is converted to a 0–1 similarity via `1 - score`.
 *
 * For short names (≤ 2 chars) we fall back to exact-match comparison to avoid
 * Fuse.js's noisy scoring on tiny strings.
 *
 * @param {string} nameA — already normalized
 * @param {string} nameB — already normalized
 * @returns {number} 0.0–1.0
 */
function nameSimilarity(nameA, nameB) {
  if (!nameA || !nameB) return 0;
  if (nameA === nameB) return 1.0;
  // Short-string fallback (Fuse.js is noisy on ≤2-char strings).
  if (nameA.length <= 2 || nameB.length <= 2) {
    return nameA === nameB ? 1.0 : 0.0;
  }
  const Fuse = _loadFuse();
  if (!Fuse) {
    // Fuse.js not available — fall back to a simple character-overlap ratio.
    return _fallbackNameSimilarity(nameA, nameB);
  }
  try {
    const fuse = new Fuse([nameB], {
      includeScore: true,
      threshold: 1.0, // accept everything — we want the score, not a filter
      ignoreLocation: true,
      minMatchCharLength: 1,
    });
    const results = fuse.search(nameA);
    if (!results || results.length === 0) return 0;
    const score = results[0].score;
    if (score == null || !Number.isFinite(score)) return 0;
    // Fuse.js score: 0 = perfect match, 1 = no match. Convert to 0–1 similarity.
    return Math.max(0, Math.min(1, 1 - score));
  } catch (_e) {
    return _fallbackNameSimilarity(nameA, nameB);
  }
}

/**
 * Fallback name similarity when Fuse.js isn't available. Uses a Dice
 * coefficient on bigrams (a reasonable approximation of fuzzy match).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0.0–1.0
 */
function _fallbackNameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1.0;
  const bigramsA = new Set();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  const bigramsB = new Set();
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0;
  let intersection = 0;
  for (const bg of bigramsA) {
    if (bigramsB.has(bg)) intersection++;
  }
  return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

/**
 * Phone match predicate: true when both businesses have the same E.164 phone.
 * Uses the Phase 3.1 `phone_e164` enrichment column. Falls back to comparing
 * raw `phone` strings only if both have a non-empty raw phone and no E.164.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function phonesMatch(a, b) {
  if (!a || !b) return false;
  if (a.phone_e164 && b.phone_e164) {
    return a.phone_e164 === b.phone_e164;
  }
  // Fallback: raw phone string comparison (only when both have one).
  if (a.phone && b.phone) {
    return String(a.phone).replace(/\D/g, '') === String(b.phone).replace(/\D/g, '');
  }
  return false;
}

/**
 * Compute the composite similarity score for a pair of businesses.
 *
 * Weighted combination:
 *   - Name fuzzy match (Fuse.js, 0.0–1.0) × 0.5
 *   - Phone E.164 exact (1.0 or 0.0) × 0.3
 *   - Address proximity < 100m (1.0 or 0.0) × 0.2
 *
 * Returns the score plus the per-component breakdown and the dominant match
 * method (for the business_duplicates.match_method column).
 *
 * @param {object} a
 * @param {object} b
 * @param {object} [opts] — { weights, maxAddressMeters }
 * @returns {{ score: number, components: { name: number, phone: number, address: number }, method: string }}
 */
function computeSimilarity(a, b, opts) {
  const o = opts || {};
  const weights = o.weights || SIMILARITY_WEIGHTS;
  const maxMeters = o.maxAddressMeters != null ? o.maxAddressMeters : 100;

  const normA = normalizeBusinessName(a && a.name);
  const normB = normalizeBusinessName(b && b.name);
  const nameScore = nameSimilarity(normA, normB);
  const phoneScore = phonesMatch(a, b) ? 1.0 : 0.0;
  const addressScore = isAddressClose(a, b, maxMeters) ? 1.0 : 0.0;

  const score =
    nameScore * weights.name +
    phoneScore * weights.phone +
    addressScore * weights.address;

  // Determine the dominant match method (the strongest contributing signal).
  let method;
  if (phoneScore === 1.0 && nameScore >= 0.7) method = 'name+phone';
  else if (phoneScore === 1.0) method = 'phone';
  else if (addressScore === 1.0 && nameScore >= 0.7) method = 'name+address';
  else if (nameScore >= 0.7 && addressScore === 1.0) method = 'name+address';
  else if (nameScore >= 0.9) method = 'name';
  else method = 'compound';

  return {
    score: Math.round(score * 1000) / 1000,
    components: {
      name: Math.round(nameScore * 1000) / 1000,
      phone: phoneScore,
      address: addressScore,
    },
    method,
  };
}

// ---------------------------------------------------------------------------
// Blocking (pure)
// ---------------------------------------------------------------------------

/**
 * Compute a blocking key for a business. Two businesses in the same block are
 * compared with the full similarity function; businesses in different blocks
 * are never compared (this is what keeps the algorithm near-linear).
 *
 * Strategies:
 *   - 'name-prefix' — first 3 chars of the normalized name + country (or '' if
 *     no country). Catches "McDonald's" vs "McDonalds" (both prefix "mcd").
 *   - 'phone'        — the E.164 phone (or '' if none). Exact phone match =
 *     instant duplicate.
 *   - 'geocode-cell' — lat/lng rounded to 3 decimal places (~100m cell).
 *     Catches same-location different-name duplicates.
 *
 * A business can be in up to 3 blocks (one per strategy); findDuplicates
 * compares all pairs within each block.
 *
 * @param {object} business
 * @param {string} strategy — 'name-prefix' | 'phone' | 'geocode-cell'
 * @returns {string}
 */
function blockKey(business, strategy) {
  if (!business) return '';
  switch (strategy) {
    case 'name-prefix': {
      const norm = normalizeBusinessName(business.name);
      const prefix = norm.slice(0, 3);
      const country = business.address_country || '';
      return `np:${prefix}:${country}`;
    }
    case 'phone': {
      const p = business.phone_e164 || business.phone;
      return p ? `ph:${String(p).replace(/\D/g, '')}` : '';
    }
    case 'geocode-cell': {
      const lat = business.lat != null ? business.lat : business.latitude;
      const lng = business.lng != null ? business.lng : business.longitude;
      if (lat == null || lng == null) return '';
      // Round to 3 decimal places ≈ 100m at the equator.
      return `gc:${lat.toFixed(3)},${lng.toFixed(3)}`;
    }
    default:
      return '';
  }
}

/**
 * Group businesses into blocks. Returns a Map<blockKey, business[]> covering
 * all three strategies. A business appears in up to 3 blocks.
 *
 * @param {object[]} businesses
 * @param {string[]} [strategies] — defaults to all 3
 * @returns {Map<string, object[]>}
 */
function buildBlocks(businesses, strategies) {
  const strats = strategies || ['name-prefix', 'phone', 'geocode-cell'];
  const blocks = new Map();
  const list = Array.isArray(businesses) ? businesses : [];
  for (const b of list) {
    for (const s of strats) {
      const key = blockKey(b, s);
      if (!key) continue; // skip empty keys (no phone, no geocode, etc.)
      if (!blocks.has(key)) blocks.set(key, []);
      blocks.get(key).push(b);
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Cluster detection (pure)
// ---------------------------------------------------------------------------

/**
 * Find duplicate clusters within a set of businesses.
 *
 * Algorithm:
 *   1. Build blocks (name-prefix + phone + geocode-cell).
 *   2. For each block with > 1 business, compute pairwise similarity.
 *   3. Pairs above the threshold are edges in a graph; connected components
 *      are clusters (so A~B and B~C implies A~B~C even if A~C is below threshold).
 *   4. Each cluster gets a canonical record (most complete) + the duplicate list.
 *
 * Returns { clusters, pairs, stats }:
 *   - clusters: Array<{ canonical, members: business[], placeIds: string[] }>
 *   - pairs:    Array<{ canonical, duplicate, score, method }> — flat list of
 *               every (canonical, duplicate) edge for DB persistence.
 *   - stats:    { totalBusinesses, comparisons, duplicatePairs, clusters, byMethod }
 *
 * @param {object[]} businesses
 * @param {object} [opts] — { threshold, weights, maxAddressMeters, strategies, logger }
 * @returns {{ clusters: object[], pairs: object[], stats: object }}
 */
function findDuplicates(businesses, opts) {
  const o = opts || {};
  const threshold = o.threshold != null ? o.threshold : DEFAULT_THRESHOLD;
  const list = Array.isArray(businesses) ? businesses : [];
  const strategies = o.strategies || ['name-prefix', 'phone', 'geocode-cell'];

  const blocks = buildBlocks(list, strategies);

  // Collect candidate pairs (avoid double-comparing the same pair across blocks).
  const seenPairs = new Set();
  const edges = []; // { a, b, score, method }
  let comparisons = 0;

  for (const [, blockMembers] of blocks) {
    if (blockMembers.length < 2) continue;
    for (let i = 0; i < blockMembers.length; i++) {
      for (let j = i + 1; j < blockMembers.length; j++) {
        const a = blockMembers[i];
        const b = blockMembers[j];
        const aId = a && a.place_id;
        const bId = b && b.place_id;
        if (!aId || !bId) continue;
        // Dedupe pairs (a business can appear in multiple blocks).
        const pairKey = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        comparisons++;
        const sim = computeSimilarity(a, b, o);
        if (sim.score >= threshold) {
          edges.push({ a, b, score: sim.score, method: sim.method, components: sim.components });
        }
      }
    }
  }

  // Build connected components (clusters) via union-find.
  const parent = new Map();
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root);
    }
    // Path compression.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Index businesses by place_id.
  const byId = new Map();
  for (const b of list) {
    if (b && b.place_id) byId.set(b.place_id, b);
  }

  // Union all edges.
  for (const e of edges) {
    union(e.a.place_id, e.b.place_id);
  }

  // Group by root.
  const groups = new Map();
  for (const id of byId.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(byId.get(id));
  }

  // Build clusters — only those with > 1 member are duplicates.
  const clusters = [];
  const pairs = [];
  const byMethod = {};
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const canonical = pickCanonical(members);
    const cluster = {
      canonical,
      members,
      placeIds: members.map((m) => m.place_id),
      canonicalPlaceId: canonical.place_id,
    };
    clusters.push(cluster);
    // Build the flat pairs list: canonical → each non-canonical member.
    for (const m of members) {
      if (m.place_id === canonical.place_id) continue;
      // Find the best edge between canonical and this member.
      const edge = edges.find(
        (e) =>
          (e.a.place_id === canonical.place_id && e.b.place_id === m.place_id) ||
          (e.b.place_id === canonical.place_id && e.a.place_id === m.place_id),
      );
      const score = edge ? edge.score : threshold;
      const method = edge ? edge.method : 'compound';
      pairs.push({
        canonical: canonical.place_id,
        duplicate: m.place_id,
        score,
        method,
      });
      byMethod[method] = (byMethod[method] || 0) + 1;
    }
  }

  const stats = {
    totalBusinesses: list.length,
    comparisons,
    duplicatePairs: pairs.length,
    clusters: clusters.length,
    byMethod,
  };

  return { clusters, pairs, stats };
}

// ---------------------------------------------------------------------------
// Canonical selection + merge (pure)
// ---------------------------------------------------------------------------

/**
 * Count non-null "completeness" fields on a business. Used to pick the
 * canonical record (the one with the most complete data wins).
 *
 * @param {object} business
 * @returns {number}
 */
function completenessScore(business) {
  if (!business) return 0;
  const fields = [
    'name', 'phone', 'phone_e164', 'website', 'address',
    'address_street', 'address_city', 'address_state', 'address_postal', 'address_country',
    'lat', 'lng', 'rating', 'reviews_count', 'category',
  ];
  let score = 0;
  for (const f of fields) {
    const v = business[f];
    if (v !== null && v !== undefined && v !== '') score++;
  }
  // Bonus for having a rating with more reviews (more authoritative).
  if (business.reviews_count && business.reviews_count > 0) {
    score += Math.min(5, Math.floor(business.reviews_count / 50));
  }
  return score;
}

/**
 * Pick the canonical business from a cluster — the one with the most complete
 * data. Ties broken by: higher rating → more reviews → alphabetically by name
 * (for determinism).
 *
 * @param {object[]} cluster
 * @returns {object}
 */
function pickCanonical(cluster) {
  const list = Array.isArray(cluster) ? cluster : [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const scored = list.map((b) => ({ b, score: completenessScore(b) }));
  scored.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    // Tie-break: higher rating wins.
    const ra = x.b.rating != null ? x.b.rating : 0;
    const rb = y.b.rating != null ? y.b.rating : 0;
    if (rb !== ra) return rb - ra;
    // Tie-break: more reviews wins.
    const rca = x.b.reviews_count != null ? x.b.reviews_count : 0;
    const rcb = y.b.reviews_count != null ? y.b.reviews_count : 0;
    if (rcb !== rca) return rcb - rca;
    // Final tie-break: alphabetical by place_id (deterministic).
    return String(x.b.place_id).localeCompare(String(y.b.place_id));
  });
  return scored[0].b;
}

/**
 * Merge a duplicate cluster into a single canonical record. The canonical
 * keeps its own place_id (clients never see the duplicate's ID). Missing
 * fields on the canonical are backfilled from the duplicates, in
 * highest-completeness order, with source provenance tracked.
 *
 * Returns:
 *   - canonical: the canonical business (mutated with backfilled fields)
 *   - merged:    Array<{ duplicatePlaceId, fieldsBackfilled: string[] }>
 *   - backfilled: total count of fields backfilled across all duplicates
 *
 * @param {object[]} cluster
 * @param {object} [opts] — { fields: string[] to consider for backfill }
 * @returns {{ canonical: object, merged: object[], backfilled: number }}
 */
function mergeCluster(cluster, opts) {
  const o = opts || {};
  const list = Array.isArray(cluster) ? cluster : [];
  if (list.length === 0) return { canonical: null, merged: [], backfilled: 0 };
  if (list.length === 1) return { canonical: list[0], merged: [], backfilled: 0 };

  const canonical = pickCanonical(list);
  // Fields to backfill (in priority order).
  const fields = o.fields || [
    'phone_e164', 'phone_type', 'phone_country_code', 'phone',
    'website', 'email',
    'address', 'address_street', 'address_city', 'address_state', 'address_postal', 'address_country',
    'lat', 'lng', 'geocode_confidence',
    'category', 'rating', 'reviews_count',
  ];

  // Sort duplicates by completeness (most complete first).
  const duplicates = list
    .filter((b) => b.place_id !== canonical.place_id)
    .sort((a, b) => completenessScore(b) - completenessScore(a));

  const merged = [];
  let backfilled = 0;

  for (const dup of duplicates) {
    const fieldsBackfilled = [];
    for (const f of fields) {
      // Only backfill if the canonical's field is empty AND the duplicate has it.
      const canonVal = canonical[f];
      const dupVal = dup[f];
      const canonEmpty = canonVal === null || canonVal === undefined || canonVal === '';
      const dupHas = dupVal !== null && dupVal !== undefined && dupVal !== '';
      if (canonEmpty && dupHas) {
        canonical[f] = dupVal;
        // Track provenance on a non-persisted debug field.
        if (!canonical._backfilled) canonical._backfilled = {};
        if (!canonical._backfilled[f]) canonical._backfilled[f] = [];
        canonical._backfilled[f].push({ from: dup.place_id, value: dupVal });
        fieldsBackfilled.push(f);
        backfilled++;
      }
    }
    // Mark the duplicate as merged (soft — preserves history).
    if (fieldsBackfilled.length > 0) {
      merged.push({
        duplicatePlaceId: dup.place_id,
        fieldsBackfilled,
      });
    }
  }

  return { canonical, merged, backfilled };
}

// ---------------------------------------------------------------------------
// Convenience: find pairs (flat list for DB persistence)
// ---------------------------------------------------------------------------

/**
 * Find duplicate pairs and return them in the format expected by
 * persistDuplicates(): Array<{ canonicalPlaceId, duplicatePlaceId,
 * similarityScore, matchMethod }>. This is a thin wrapper around
 * findDuplicates() that maps the output keys.
 *
 * @param {object[]} businesses
 * @param {object} [opts]
 * @returns {Array<{ canonicalPlaceId: string, duplicatePlaceId: string, similarityScore: number, matchMethod: string }>}
 */
function findDuplicatePairs(businesses, opts) {
  const { pairs } = findDuplicates(businesses, opts);
  return pairs.map((p) => ({
    canonicalPlaceId: p.canonical,
    duplicatePlaceId: p.duplicate,
    similarityScore: p.score,
    matchMethod: p.method,
  }));
}

module.exports = {
  __version,
  ENRICHMENT_COLUMNS,
  // Constants
  DEFAULT_THRESHOLD,
  SIMILARITY_WEIGHTS,
  NAME_SUFFIXES,
  // Core API
  normalizeBusinessName,
  computeSimilarity,
  findDuplicates,
  findDuplicatePairs,
  mergeCluster,
  pickCanonical,
  // Helpers (exported for tests)
  blockKey,
  buildBlocks,
  nameSimilarity,
  phonesMatch,
  isAddressClose,
  haversineMeters,
  completenessScore,
  // Test seams
  _loadFuse,
  _setFuse,
  _fallbackNameSimilarity,
};
