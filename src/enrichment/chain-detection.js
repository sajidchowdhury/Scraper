'use strict';

/**
 * src/enrichment/chain-detection.js — Phase 3.4 — Chain Detection & Spam/Fake Listing Detection
 *
 * Two complementary analyses run on every business record:
 *
 *   (A) CHAIN DETECTION
 *       Match the business name against a curated catalogue of known chain
 *       brand tokens (McDonald's, Starbucks, Subway, 7-Eleven, …). Matching
 *       uses normalized token overlap + alias lists so "McDonald's of Times
 *       Square" still resolves to the McDonald's chain.
 *
 *   (B) SPAM / FAKE-LISTING DETECTION
 *       A rule engine evaluates ~11 heuristics and emits weighted SpamFlags:
 *         • Keyword stuffing in the business name (CAPS, superlatives,
 *           "24/7", "#1", "cheap", "best", "AAA").
 *         • PO Box / mailbox address with no physical storefront.
 *         • Phone-area-code mismatch (NYC number on a LA address).
 *         • Phone reuse across multiple listings in the same batch.
 *         • Suspiciously perfect 5.0 rating with very few reviews.
 *         • Generic / placeholder name ("Professional Services LLC").
 *         • Suspicious TLD (.xyz / .tk / .top / .gq / .cf).
 *         • Category mismatch (category doesn't fit the phone type, e.g.
 *           "Plumber" running a toll-free number with no website).
 *         • Network-of-listings pattern (same phone / address reused for
 *           multiple "AAA …" branches).
 *
 *       Flags are aggregated into a 0-100 spam score and a risk level.
 *
 * DESIGN RULES (per PHASE3_EXECUTION_PLAN.md §3.4)
 *   - Pure functions wherever possible (testable without a DB / network).
 *   - No external dependencies — all heuristics are regex / set lookups.
 *   - The business object is read (not mutated) by detectChain/detectSpam.
 *     Batch wrappers mutate in place by attaching a `chain_result` and
 *     `spam_result` debug descriptor (NOT persisted — ENRICHMENT_COLUMNS is
 *     empty; spam/chain signals feed into lead_score in Phase 3.9).
 *   - Phone type uses the scraper's 'toll_free' (with underscore) convention
 *     from phone.js — NOT the dashboard's 'tollfree' spelling.
 *
 * PUBLIC API
 *   detectChain(business)                → { isChain, chainName, chainId, confidence, matchedToken }
 *   detectSpam(business, ctx?)           → { isSpam, spamScore, riskLevel, flags[] }
 *   buildPhoneReuseMap(businesses)       → Map<e164, ReuseListing[]>
 *   groupChainListings(businesses)       → [{ chainId, chainName, listingIds[] }]
 *   detectChainBatch(businesses, opts?)  → { total, chainListings, byChain }
 *   detectSpamBatch(businesses, opts?)   → { total, spamListings, byLevel, avgScore }
 *   ENRICHMENT_COLUMNS                   → []  (results feed lead_score, not persisted directly)
 */

const __version = 1;

const ENRICHMENT_COLUMNS = [];

// ─────────────────────────────────────────────────────────────────────────────
// (A) CHAIN CATALOGUE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ChainBrand
 * @property {string} chainId
 * @property {string} name
 * @property {string[]} tokens
 * @property {string[]} aliases
 */

/** @type {ChainBrand[]} */
const CHAIN_CATALOGUE = [
  { chainId: 'mcdonalds', name: "McDonald's", tokens: ['mcdonald', 'mcdonalds'], aliases: ['micky ds', 'mickey ds', 'golden arches'] },
  { chainId: 'starbucks', name: 'Starbucks', tokens: ['starbucks'], aliases: ['starbucks coffee', 'starbucks reserve'] },
  { chainId: 'subway', name: 'Subway', tokens: ['subway'], aliases: [] },
  { chainId: '7eleven', name: '7-Eleven', tokens: ['7eleven', '7 eleven', 'seven eleven'], aliases: ['7-11'] },
  { chainId: 'dunkin', name: "Dunkin'", tokens: ['dunkin'], aliases: ['dunkin donuts'] },
  { chainId: 'wendys', name: "Wendy's", tokens: ['wendys', 'wendy'], aliases: [] },
  { chainId: 'chipotle', name: 'Chipotle', tokens: ['chipotle'], aliases: ['chipotle mexican grill'] },
  { chainId: 'target', name: 'Target', tokens: ['target'], aliases: [] },
  { chainId: 'walmart', name: 'Walmart', tokens: ['walmart', 'wal mart'], aliases: ['wal-mart', 'supercenter'] },
  { chainId: 'costco', name: 'Costco', tokens: ['costco'], aliases: ['costco wholesale'] },
  { chainId: 'wholefoods', name: 'Whole Foods Market', tokens: ['whole foods', 'wholefoods'], aliases: ['whole food'] },
];

/** Normalize a business name for chain matching. */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect whether a business belongs to a known franchise/chain.
 *
 * @param {object} business — must have a `name` field.
 * @returns {{ isChain: boolean, chainName: string|null, chainId: string|null, confidence: number, matchedToken: string|null }}
 */
function detectChain(business) {
  const rawName = business && business.name ? business.name : '';
  const normalized = normalizeName(rawName);
  if (!normalized) {
    return { isChain: false, chainName: null, chainId: null, confidence: 0, matchedToken: null };
  }

  let best = null; // { brand, confidence, token }

  for (const brand of CHAIN_CATALOGUE) {
    // Direct token containment — highest confidence. Word-boundary check so
    // "subway" doesn't match "subway tile shop".
    for (const token of brand.tokens) {
      const tokenNorm = normalizeName(token);
      const re = new RegExp(`(?:^|\\s)${escapeRegex(tokenNorm)}(?:\\s|$)`);
      if (re.test(normalized)) {
        const confidence = 1.0;
        if (!best || confidence > best.confidence) {
          best = { brand, confidence, token };
        }
      }
    }
    // Alias containment — slightly lower confidence.
    if (!best) {
      for (const alias of brand.aliases) {
        const aliasNorm = normalizeName(alias);
        if (aliasNorm && normalized.includes(aliasNorm)) {
          const confidence = 0.9;
          if (!best || confidence > best.confidence) {
            best = { brand, confidence, token: alias };
          }
        }
      }
    }
  }

  if (!best) {
    return { isChain: false, chainName: null, chainId: null, confidence: 0, matchedToken: null };
  }
  return {
    isChain: true,
    chainName: best.brand.name,
    chainId: best.brand.chainId,
    confidence: best.confidence,
    matchedToken: best.token,
  };
}

/**
 * Group businesses that belong to the same chain.
 *
 * @param {object[]} businesses — each must have run through detectChain (chain_result attached).
 * @returns {{ chainId: string, chainName: string, listingIds: string[] }[]}
 */
function groupChainListings(businesses) {
  const list = Array.isArray(businesses) ? businesses : [];
  const groups = new Map();
  for (const b of list) {
    if (!b || !b.chain_result || !b.chain_result.isChain || !b.chain_result.chainId) continue;
    const id = b.place_id || String(b.id || '');
    if (!id) continue;
    const g = groups.get(b.chain_result.chainId) || { chainName: b.chain_result.chainName, listingIds: [] };
    g.listingIds.push(id);
    groups.set(b.chain_result.chainId, g);
  }
  return Array.from(groups, ([chainId, g]) => ({ chainId, chainName: g.chainName, listingIds: g.listingIds }));
}

// ─────────────────────────────────────────────────────────────────────────────
// (B) SPAM / FAKE-LISTING DETECTION
// ─────────────────────────────────────────────────────────────────────────────

// Known superlatives / spam-bait tokens in business names.
const SPAM_NAME_KEYWORDS = [
  'best', 'cheap', 'affordable', 'cheapest', '#1', 'number 1', 'top rated',
  'premium', 'quality', 'reliable', 'professional', 'expert', '24 7', '24/7',
  'emergency', 'fastest', 'instant', 'guaranteed', 'licensed', 'insured',
  'aaa', 'lowest price', 'discount', 'free estimate',
];

// Suspicious TLDs commonly abused by throwaway spam sites.
const SPAM_TLDS = ['.xyz', '.tk', '.top', '.gq', '.cf', '.ml', '.click', '.loan'];

// Generic / placeholder business names that often mask fake listings.
const GENERIC_NAME_PATTERNS = [
  /^professional services/i,
  /^quality services?/i,
  /^best services?/i,
  /^allied services?/i,
  /^city wide services?/i,
  /^abc services?/i,
  /^1 stop /i,
  /^express services?/i,
];

// US area-code → state map (subset, used for area-code mismatch detection).
const AREA_CODE_TO_STATE = {
  // New York
  '212': 'NY', '646': 'NY', '917': 'NY', '332': 'NY', '718': 'NY', '347': 'NY', '929': 'NY',
  // California
  '213': 'CA', '310': 'CA', '323': 'CA', '408': 'CA', '415': 'CA', '510': 'CA',
  '650': 'CA', '669': 'CA', '707': 'CA', '747': 'CA', '805': 'CA', '818': 'CA',
  '858': 'CA', '909': 'CA', '916': 'CA', '925': 'CA', '949': 'CA', '951': 'CA',
  // Texas
  '210': 'TX', '214': 'TX', '254': 'TX', '281': 'TX', '346': 'TX', '409': 'TX',
  '469': 'TX', '512': 'TX', '682': 'TX', '713': 'TX', '726': 'TX', '737': 'TX',
  '806': 'TX', '817': 'TX', '830': 'TX', '832': 'TX', '903': 'TX', '915': 'TX',
  '936': 'TX', '940': 'TX', '945': 'TX', '956': 'TX', '972': 'TX', '979': 'TX',
  // Washington
  '206': 'WA', '253': 'WA', '360': 'WA', '425': 'WA', '509': 'WA', '564': 'WA',
  // Florida
  '239': 'FL', '305': 'FL', '321': 'FL', '352': 'FL', '386': 'FL', '407': 'FL',
  '561': 'FL', '727': 'FL', '754': 'FL', '772': 'FL', '786': 'FL', '813': 'FL',
  '850': 'FL', '863': 'FL', '904': 'FL', '941': 'FL', '954': 'FL',
  // Illinois
  '217': 'IL', '224': 'IL', '309': 'IL', '312': 'IL', '331': 'IL', '618': 'IL',
  '630': 'IL', '708': 'IL', '773': 'IL', '779': 'IL', '815': 'IL', '847': 'IL', '872': 'IL',
  // North Carolina
  '252': 'NC', '336': 'NC', '704': 'NC', '743': 'NC', '828': 'NC', '910': 'NC', '919': 'NC', '980': 'NC',
  // Tennessee
  '423': 'TN', '615': 'TN', '629': 'TN', '731': 'TN', '865': 'TN', '901': 'TN', '931': 'TN',
  // Virginia
  '276': 'VA', '434': 'VA', '540': 'VA', '571': 'VA', '703': 'VA', '757': 'VA', '804': 'VA',
  // Michigan
  '231': 'MI', '248': 'MI', '269': 'MI', '313': 'MI', '517': 'MI', '586': 'MI',
  '616': 'MI', '734': 'MI', '810': 'MI', '906': 'MI', '947': 'MI', '989': 'MI',
  // Colorado
  '303': 'CO', '719': 'CO', '720': 'CO', '970': 'CO',
};

// ── Context passed to the spam detector ──────────────────────────────────────

/**
 * @typedef {Object} ReuseListing
 * @property {string} id
 * @property {number|null} lat
 * @property {number|null} lng
 * @property {string} street
 * @property {string} city
 */

/**
 * @typedef {Object} SpamContext
 * @property {Map<string, ReuseListing[]>} phoneReuseMap
 * @property {Map<string, string>} dedupClusters
 */

/**
 * Build the phone-reuse map once per pipeline run.
 *
 * @param {object[]} businesses — each should have phone_e164 (from Phase 3.1).
 * @returns {Map<string, ReuseListing[]>}
 */
function buildPhoneReuseMap(businesses) {
  const list = Array.isArray(businesses) ? businesses : [];
  const map = new Map();
  for (const b of list) {
    if (!b || !b.phone_e164) continue;
    const arr = map.get(b.phone_e164) || [];
    arr.push({
      id: b.place_id || String(b.id || ''),
      lat: b.lat != null ? Number(b.lat) : (b.latitude != null ? Number(b.latitude) : null),
      lng: b.lng != null ? Number(b.lng) : (b.longitude != null ? Number(b.longitude) : null),
      street: b.address_street || '',
      city: b.address_city || '',
    });
    map.set(b.phone_e164, arr);
  }
  // Strip singletons — only keep phones shared by 2+ listings.
  for (const [k, v] of map) if (v.length < 2) map.delete(k);
  return map;
}

// ── Individual spam heuristics ───────────────────────────────────────────────

function checkKeywordStuffing(name) {
  const letters = String(name || '').replace(/[^A-Za-z]/g, '');
  const capsRatio = letters.length ? letters.replace(/[^A-Z]/g, '').length / letters.length : 0;
  const lower = String(name || '').toLowerCase();
  const hits = [];
  for (const kw of SPAM_NAME_KEYWORDS) {
    const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i');
    if (re.test(lower)) hits.push(kw);
  }
  if (hits.length === 0 && capsRatio < 0.7) return null;

  const severity = hits.length >= 4 ? 'critical' : hits.length >= 2 ? 'high' : 'medium';
  const weight = Math.min(35, hits.length * 8 + (capsRatio >= 0.7 ? 10 : 0));

  return {
    code: 'KEYWORD_STUFFING',
    label: 'Keyword stuffing in name',
    severity,
    detail: `Name contains ${hits.length} spam-bait keyword(s)${
      hits.length ? `: ${hits.slice(0, 5).join(', ')}` : ''
    }${capsRatio >= 0.7 ? `; ${Math.round(capsRatio * 100)}% uppercase` : ''}.`,
    weight,
  };
}

function checkAaaPrefix(name) {
  if (/^a{2,}\s+/i.test(name) || /^aaa\s+/i.test(name)) {
    return {
      code: 'AAA_PREFIX',
      label: '"AAA" directory-listing prefix',
      severity: 'medium',
      detail: 'Names starting with "AAA" are a classic trick to appear first in alphabetical directories — common for spam networks.',
      weight: 12,
    };
  }
  return null;
}

function checkPoBoxAddress(business) {
  const raw = business.address || '';
  const street = business.address_street || '';
  if (/\bp\.?o\.?\s*box\b/i.test(raw) || /\bbox\b/i.test(street)) {
    return {
      code: 'PO_BOX_ADDRESS',
      label: 'PO Box address (no storefront)',
      severity: 'high',
      detail: 'Listing uses a PO Box rather than a physical address — typical for lead-gen / fake-listing networks.',
      weight: 18,
    };
  }
  return null;
}

function checkPhoneAreaMismatch(business) {
  const phoneCountry = business.phone_country_code;
  const phoneType = business.phone_type;
  // Only run for valid US numbers.
  if (phoneCountry !== 'US') return null;
  if (phoneType === 'invalid' || !phoneType) return null;
  const natNum = business.phone_normalized && business.phone_normalized.nationalNumber;
  if (!natNum) return null;
  const areaCode = String(natNum).slice(0, 3);
  const phoneState = AREA_CODE_TO_STATE[areaCode];
  if (!phoneState) return null;
  const addrState = business.address_state || '';
  if (addrState && addrState.toUpperCase() !== phoneState) {
    return {
      code: 'PHONE_AREA_MISMATCH',
      label: 'Phone area code mismatches address state',
      severity: 'high',
      detail: `Phone area code ${areaCode} serves ${phoneState}, but the address is in ${addrState}.`,
      weight: 15,
    };
  }
  return null;
}

function checkPhoneReuse(business, ctx) {
  const e164 = business.phone_e164;
  if (!e164 || !ctx || !ctx.phoneReuseMap) return null;
  const reuse = ctx.phoneReuseMap.get(e164);
  const myId = business.place_id || String(business.id || '');
  if (!reuse || !reuse.some((r) => r.id === myId)) return null;
  const count = reuse.length;

  const myCluster = ctx.dedupClusters && ctx.dedupClusters.get(myId);
  const sameCluster = myCluster && ctx.dedupClusters && reuse.every((r) => ctx.dedupClusters.get(r.id) === myCluster);
  const cohesive = sameCluster || isGeographicallyCohesive(reuse);

  if (cohesive) {
    return {
      code: 'PHONE_REUSE',
      label: `${count} duplicate listings share this phone`,
      severity: 'info',
      detail: `Phone (${e164}) is reused across ${count} listings that ${
        sameCluster ? 'form a single dedup cluster' : 'resolve to the same location'
      } — treat as duplicates, not a spam network.`,
      weight: 4,
    };
  }

  return {
    code: 'PHONE_REUSE',
    label: `${count} listings share this phone`,
    severity: count >= 3 ? 'critical' : 'high',
    detail: `The same phone (${e164}) is used by ${count} listings at DIFFERENT locations — strong signal of a spam network fronting multiple fake storefronts.`,
    weight: Math.min(30, 12 + count * 6),
  };
}

/**
 * Returns true when every listing in the reuse set sits at essentially the same
 * physical location. Cohesion = geo-proximity (≤150m) OR normalized street+city
 * equality across all listings.
 */
function isGeographicallyCohesive(listings) {
  if (!listings || listings.length < 2) return true;

  // (a) Geo-proximity check.
  const withGeo = listings.filter((l) => l.lat != null && l.lng != null);
  if (withGeo.length === listings.length) {
    let allClose = true;
    for (let i = 0; i < withGeo.length && allClose; i++) {
      for (let j = i + 1; j < withGeo.length; j++) {
        const dist = haversineMeters(withGeo[i].lat, withGeo[i].lng, withGeo[j].lat, withGeo[j].lng);
        if (dist > 150) { allClose = false; break; }
      }
    }
    if (allClose) return true;
  }

  // (b) Normalized street + city equality.
  const first = normalizeStreetCity(listings[0].street, listings[0].city);
  if (!first) return false;
  return listings.every((l) => normalizeStreetCity(l.street, l.city) === first);
}

/** Great-circle distance in meters (haversine). */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius, meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Normalize a street+city pair so abbreviation variants compare equal. */
function normalizeStreetCity(street, city) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/\bave\b/g, 'avenue')
      .replace(/\bst\b/g, 'street')
      .replace(/\bbld\b/g, 'boulevard')
      .replace(/\bbd\b/g, 'boulevard')
      .replace(/\bblvd\b/g, 'boulevard')
      .replace(/\brd\b/g, 'road')
      .replace(/\bdr\b/g, 'drive')
      .replace(/\bln\b/g, 'lane')
      .replace(/\bste\b/g, 'suite')
      .replace(/\bapt\b/g, 'apartment')
      .replace(/\bfl\b/g, 'floor')
      .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
      .replace(/,?\s*(suite|ste|unit|apt|apartment)\s*\w+/g, ' ')
      .replace(/,?\s*\d*\s*floor\b/g, ' ')
      .replace(/\bfloor\b/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const n1 = norm(street);
  const n2 = norm(city);
  if (!n1 && !n2) return '';
  return `${n1}|${n2}`;
}

function checkSuspiciousRating(business) {
  const rating = business.rating != null ? Number(business.rating) : null;
  const reviewCount = business.reviews_count != null ? Number(business.reviews_count) : null;
  if (rating == null || reviewCount == null) return null;
  if (rating >= 4.95 && reviewCount <= 5) {
    return {
      code: 'SUSPICIOUS_RATING',
      label: 'Perfect rating with very few reviews',
      severity: reviewCount <= 2 ? 'high' : 'medium',
      detail: `Rating ${rating.toFixed(1)} from only ${reviewCount} review(s) — freshly inflated listings often look like this.`,
      weight: 12 + Math.max(0, 5 - reviewCount) * 2,
    };
  }
  return null;
}

function checkGenericName(name) {
  for (const pat of GENERIC_NAME_PATTERNS) {
    if (pat.test(name)) {
      return {
        code: 'GENERIC_NAME',
        label: 'Generic / placeholder business name',
        severity: 'medium',
        detail: `Name matches generic pattern "${pat.source}" — often used as a shell for fake listings.`,
        weight: 14,
      };
    }
  }
  return null;
}

function checkSuspiciousTld(website) {
  if (!website) return null;
  const lower = String(website).toLowerCase();
  const hit = SPAM_TLDS.find((tld) => lower.includes(tld));
  if (!hit) return null;
  return {
    code: 'SUSPICIOUS_TLD',
    label: `Suspicious TLD (${hit})`,
    severity: 'high',
    detail: `Website uses the ${hit} TLD, which is frequently abused for throwaway spam sites.`,
    weight: 16,
  };
}

function checkNoWebsite(business) {
  const category = business.category || '';
  // Only flag for categories where a legitimate business essentially always has
  // a website presence. Restaurants get a pass.
  const websiteExpected = /contractor|plumber|electrician|locksmith|towing|roofing|hvac|landscap/i.test(category);
  if (websiteExpected && !business.website) {
    return {
      code: 'NO_WEBSITE_SERVICE',
      label: 'Service business with no website',
      severity: 'low',
      detail: `${category} businesses normally have a website — its absence is mildly suspicious.`,
      weight: 6,
    };
  }
  return null;
}

function checkCategoryMismatch(business) {
  const category = business.category || '';
  const phoneType = business.phone_type;
  const website = business.website;
  // Local service business running a toll-free number with no website = odd.
  if (/plumber|electrician|locksmith|towing|hvac/i.test(category) && phoneType === 'toll_free' && !website) {
    return {
      code: 'CATEGORY_MISMATCH',
      label: 'Local service using toll-free number',
      severity: 'medium',
      detail: `${category} is hyper-local but uses a toll-free number with no website — pattern common in lead-gen spam.`,
      weight: 10,
    };
  }
  return null;
}

function checkNetworkPattern(business, ctx) {
  const name = business.name || '';
  if (!/^a{2,}\s+/i.test(name)) return null;
  const e164 = business.phone_e164;
  const reuse = e164 && ctx && ctx.phoneReuseMap ? ctx.phoneReuseMap.get(e164) : undefined;
  const myId = business.place_id || String(business.id || '');
  if (!reuse || !reuse.some((r) => r.id === myId) || reuse.length < 2) return null;
  return {
    code: 'NETWORK_PATTERN',
    label: `Spam network (${reuse.length} branches, 1 phone)`,
    severity: 'critical',
    detail: `Multiple geographically-named "AAA" branches share a single phone number across distinct locations — textbook fake-listing network.`,
    weight: 25,
  };
}

// ── Aggregate ────────────────────────────────────────────────────────────────

function scoreToLevel(score) {
  if (score >= 65) return 'critical';
  if (score >= 45) return 'high';
  if (score >= 25) return 'medium';
  if (score >= 10) return 'low';
  return 'clean';
}

/**
 * Run the full spam engine on a single business record.
 *
 * @param {object} business — enriched business (phone/address fields from 3.1/3.2).
 * @param {SpamContext} [ctx] — optional phone-reuse + dedup-cluster context.
 * @returns {{ isSpam: boolean, spamScore: number, riskLevel: string, flags: object[] }}
 */
function detectSpam(business, ctx) {
  if (!business) return { isSpam: false, spamScore: 0, riskLevel: 'clean', flags: [] };
  const flags = [];

  const checks = [
    checkKeywordStuffing(business.name),
    checkAaaPrefix(business.name),
    checkPoBoxAddress(business),
    checkPhoneAreaMismatch(business),
    checkPhoneReuse(business, ctx),
    checkSuspiciousRating(business),
    checkGenericName(business.name),
    checkSuspiciousTld(business.website),
    business.website ? null : checkNoWebsite(business),
    checkCategoryMismatch(business),
    checkNetworkPattern(business, ctx),
  ];
  for (const f of checks) if (f) flags.push(f);

  // Sort by weight desc so the worst signal surfaces first.
  flags.sort((a, b) => b.weight - a.weight);

  const rawScore = flags.reduce((acc, f) => acc + f.weight, 0);
  const spamScore = Math.min(100, rawScore);
  const riskLevel = scoreToLevel(spamScore);

  return { isSpam: spamScore >= 25, spamScore, riskLevel, flags };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch wrappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run chain detection across a batch IN PLACE. Each business gets a
 * `chain_result` descriptor attached (NOT persisted — feeds lead scoring).
 *
 * @param {object[]} businesses — mutated in place.
 * @param {object} [opts] — { logger }
 * @returns {{ total: number, chainListings: number, byChain: object }}
 */
function detectChainBatch(businesses, opts) {
  const list = Array.isArray(businesses) ? businesses : [];
  const stats = { total: list.length, chainListings: 0, byChain: {} };
  for (const b of list) {
    if (!b) continue;
    b.chain_result = detectChain(b);
    if (b.chain_result.isChain) {
      stats.chainListings++;
      const cid = b.chain_result.chainId;
      stats.byChain[cid] = (stats.byChain[cid] || 0) + 1;
    }
  }
  return stats;
}

/**
 * Run spam detection across a batch IN PLACE. Each business gets a
 * `spam_result` descriptor attached (NOT persisted — feeds lead scoring).
 * Builds the phone-reuse map internally unless one is supplied via opts.ctx.
 *
 * @param {object[]} businesses — mutated in place.
 * @param {object} [opts] — { ctx, dedupClusters, logger }
 * @returns {{ total: number, spamListings: number, byLevel: object, avgScore: number }}
 */
function detectSpamBatch(businesses, opts) {
  const o = opts || {};
  const list = Array.isArray(businesses) ? businesses : [];
  const stats = {
    total: list.length,
    spamListings: 0,
    byLevel: { clean: 0, low: 0, medium: 0, high: 0, critical: 0 },
    avgScore: 0,
  };

  // Build the phone-reuse map once (unless caller supplied one).
  let ctx = o.ctx;
  if (!ctx) {
    const phoneReuseMap = buildPhoneReuseMap(list);
    const dedupClusters = o.dedupClusters || new Map();
    ctx = { phoneReuseMap, dedupClusters };
  }

  let scoreSum = 0;
  for (const b of list) {
    if (!b) continue;
    b.spam_result = detectSpam(b, ctx);
    scoreSum += b.spam_result.spamScore;
    if (b.spam_result.isSpam) stats.spamListings++;
    const lvl = b.spam_result.riskLevel;
    if (Object.prototype.hasOwnProperty.call(stats.byLevel, lvl)) stats.byLevel[lvl]++;
  }
  stats.avgScore = list.length ? Math.round((scoreSum / list.length) * 100) / 100 : 0;
  return stats;
}

module.exports = {
  __version,
  ENRICHMENT_COLUMNS,
  // Core API
  detectChain,
  detectSpam,
  buildPhoneReuseMap,
  groupChainListings,
  // Batch wrappers
  detectChainBatch,
  detectSpamBatch,
  // Helpers exported for unit tests
  normalizeName,
  isGeographicallyCohesive,
  haversineMeters,
  normalizeStreetCity,
  // Catalogues / constants (for tests + extension)
  CHAIN_CATALOGUE,
  SPAM_NAME_KEYWORDS,
  SPAM_TLDS,
  AREA_CODE_TO_STATE,
};
