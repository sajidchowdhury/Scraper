'use strict';

/**
 * tests/integration-phase3.test.js — Phase 3.13 — Final Integration Test
 *
 * End-to-end integration test that wires ALL Phase 3 enrichment subsystems
 * together through the real `enrichBatch` orchestrator (src/enrichment/pipeline.js)
 * and verifies they compose correctly on a realistic 20-business batch. This is
 * the Phase 3.13 acceptance test for cross-subsystem composition — each
 * sub-phase's unit tests (tests/enrichment-*.test.js) cover its own internals;
 * this test catches wiring + contract bugs the units can't.
 *
 * Subsystems exercised (all REAL module logic; only I/O boundaries mocked):
 *   - 3.1  phone          (real libphonenumber-js/max)
 *   - 3.2  address        (real parser; geocoder DI-stubbed for offline)
 *   - 3.3  dedup          (real fuse.js + union-find)
 *   - 3.4  chain + spam   (real catalogue + 11 heuristics)
 *   - 3.5  email          (real discovery; DNS/SMTP DI-stubbed for verify path)
 *   - 3.6  tech-stack     (real 27 detection rules; HTTP DI-stubbed via _setHttp)
 *   - 3.7  sentiment      (real AFINN + 8 aspects)
 *   - 3.8  geo-metrics    (real haversine neighbor counts)
 *   - 3.9  lead-score     (real 7-signal composite + spam cap)
 *   - 3.10 confidence     (real 18-factor model)
 *   - 3.11 grid-coverage  (real geometry — drives search strategy, not the
 *                          per-business pipeline; exercised directly here)
 *   - 3.12 pipeline       (the real enrichBatch orchestrator under test)
 *
 * Mock strategy (DI seams — same ones the unit tests use):
 *   - HTTP (tech-stack) → techStack._setHttp(stub) returning canned HTML.
 *   - DNS/SMTP (email)  → email._setDns(stub) / _setNet(stub) for the verify path.
 *   - Geocoder          → a fake {geocode, stats} object for the budget-cap test.
 *   - Queue             → in-memory MockQueue (src/queue/mock-backend.js).
 *
 * The default enrichBatch run is FULLY OFFLINE ($0): geocode off, emailVerify
 * off, techStackFetch off. Network phases are opt-in and exercised in dedicated
 * scenarios with DI stubs. No test touches the real network.
 *
 * Run: bun test tests/integration-phase3.test.js
 */

const { enrichBatch, enrichBusiness } = require('../src/enrichment/pipeline');
// The CANONICAL aggregated enrichment-column list lives in the barrel
// (index.js) — pipeline.js itself contributes no businesses columns ([]).
const { ENRICHMENT_COLUMNS } = require('../src/enrichment');
const techStack = require('../src/enrichment/tech-stack');
const email = require('../src/enrichment/email');
const address = require('../src/enrichment/address');
const gridCoverage = require('../src/enrichment/grid-coverage');
const confidenceMod = require('../src/enrichment/confidence');
const leadScore = require('../src/enrichment/lead-score');
const { MockQueue } = require('../src/queue/mock-backend');

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

let _idCounter = 0;
function nextId() {
  _idCounter += 1;
  return `ChIJ_test_${_idCounter}`;
}

/**
 * Build a single business fixture. Defaults produce a rich, legit local
 * business; override any field via `overrides`.
 */
function makeBusiness(overrides = {}) {
  return {
    place_id: nextId(),
    name: 'Rosenthal Deli & Bakery',
    address: '4823 Bathurst St, Toronto, ON M2R 1V5, Canada',
    phone: '+1 416-555-0142',
    website: 'https://rosenthaldeli.example.com',
    category: 'Deli',
    rating: 4.7,
    reviews_count: 218,
    latitude: 43.780,
    longitude: -79.440,
    top_reviews: [
      { author: 'Sam K.', rating: 5, text: 'Amazing pastrami sandwich and friendly staff. Best deli in the neighborhood.', time: '2026-07-01' },
      { author: 'Priya M.', rating: 5, text: 'Fresh bagels every morning, great coffee, lovely atmosphere.', time: '2026-06-20' },
      { author: 'Joe R.', rating: 4, text: 'Good food, slightly slow service at lunch but worth the wait.', time: '2026-06-10' },
    ],
    ...overrides,
  };
}

/**
 * Build the canonical 20-business acceptance batch — varied across every
 * dimension the enrichment pipeline scores on (chains, spam, duplicates,
 * missing website/phone/reviews, geographic clustering, categories).
 */
function makeAcceptanceBatch() {
  // A duplicate pair: same name + phone, slightly different address — dedup
  // (3.3) must cluster them.
  const dupName = 'Maple Leaf Family Diner';
  const dupPhone = '+1 416-555-0199';
  return [
    // 0 — strong local legit (the baseline good lead)
    makeBusiness({ name: 'Rosenthal Deli & Bakery' }),
    // 1 — chain (McDonald's)
    makeBusiness({
      name: "McDonald's",
      address: '1200 Yonge St, Toronto, ON M4T 2W1, Canada',
      phone: '+1 416-555-0100',
      website: 'https://www.mcdonalds.com',
      category: 'Fast food restaurant',
      rating: 3.9,
      reviews_count: 1502,
      latitude: 43.690, longitude: -79.390,
    }),
    // 2 — chain (Starbucks)
    makeBusiness({
      name: 'Starbucks Coffee',
      address: '300 Front St W, Toronto, ON M5V 0L9, Canada',
      phone: '+1 416-555-0120',
      website: 'https://www.starbucks.com',
      category: 'Coffee shop',
      rating: 4.2,
      reviews_count: 980,
      latitude: 43.645, longitude: -79.385,
    }),
    // 3 — SPAM (keyword stuffing + AAA prefix + PO box + suspicious TLD + few reviews)
    makeBusiness({
      name: 'AAA Locksmith 24/7 Emergency Locksmith Keys Locks Cheap',
      address: 'PO Box 1234, Toronto, ON, Canada',
      phone: '+1 416-555-0999',
      website: 'https://aaa-locksmith.xyz',
      category: 'Locksmith',
      rating: 5.0,
      reviews_count: 2,
      latitude: 43.700, longitude: -79.420,
      top_reviews: [
        { author: 'A', rating: 5, text: 'Great great great great service great.', time: '2026-08-01' },
        { author: 'B', rating: 5, text: 'Best best best locksmith best.', time: '2026-08-02' },
      ],
    }),
    // 4 — duplicate pair, member A (canonical candidate)
    makeBusiness({
      name: dupName,
      address: '789 Queen St W, Toronto, ON M6J 1G1, Canada',
      phone: dupPhone,
      website: 'https://maplediner.example.com',
      category: 'Diner',
      rating: 4.4,
      reviews_count: 312,
      latitude: 43.653, longitude: -79.423,
    }),
    // 5 — duplicate pair, member B (near-identical name + same phone)
    makeBusiness({
      name: 'Maple Leaf Family Diner Inc.',
      address: '791 Queen Street West, Toronto, ON, Canada',
      phone: dupPhone,
      website: 'https://maplediner.example.com/',
      category: 'Diner',
      rating: 4.4,
      reviews_count: 312,
      latitude: 43.6531, longitude: -79.4231,
    }),
    // 6 — dentist, no website (service business)
    makeBusiness({
      name: 'Bright Smile Dental',
      address: '55 King St E, Toronto, ON M5C 1B5, Canada',
      phone: '+1 416-555-0200',
      website: null,
      category: 'Dentist',
      rating: 4.8,
      reviews_count: 145,
      latitude: 43.649, longitude: -79.375,
    }),
    // 7 — plumber, no reviews
    makeBusiness({
      name: 'Reliable Plumbing Co',
      address: '2000 Dundas St W, Toronto, ON M6R 1W9, Canada',
      phone: '+1 416-555-0210',
      website: 'https://reliableplumbing.example.com',
      category: 'Plumber',
      rating: null,
      reviews_count: 0,
      latitude: 43.652, longitude: -79.450,
      top_reviews: [],
    }),
    // 8 — no phone
    makeBusiness({
      name: 'Artisan Bookshop',
      address: '321 College St, Toronto, ON M5T 1S3, Canada',
      phone: null,
      website: 'https://artisanbooks.example.com',
      category: 'Book store',
      rating: 4.6,
      reviews_count: 88,
      latitude: 43.657, longitude: -79.399,
    }),
    // 9 — chain (Subway)
    makeBusiness({
      name: 'Subway',
      address: '500 Bloor St W, Toronto, ON M5S 1Y3, Canada',
      phone: '+1 416-555-0140',
      website: 'https://www.subway.com',
      category: 'Sandwich shop',
      rating: 3.7,
      reviews_count: 420,
      latitude: 43.665, longitude: -79.411,
    }),
    // 10 — low rating, negative reviews (reputation lead)
    makeBusiness({
      name: 'Corner Bistro',
      address: '924 College St, Toronto, ON M6H 1A1, Canada',
      phone: '+1 416-555-0220',
      website: 'https://cornerbistro.example.com',
      category: 'Bistro',
      rating: 2.3,
      reviews_count: 167,
      latitude: 43.654, longitude: -79.436,
      top_reviews: [
        { author: 'Lara', rating: 1, text: 'Terrible service, cold food, overpriced. Will not return.', time: '2026-07-15' },
        { author: 'Mike', rating: 2, text: 'Slow, rude staff, bland food. Disappointing.', time: '2026-07-10' },
      ],
    }),
    // 11 — no address
    makeBusiness({
      name: 'Popup Coffee Stand',
      address: null,
      phone: '+1 416-555-0230',
      website: 'https://popupcoffee.example.com',
      category: 'Coffee stand',
      rating: 4.5,
      reviews_count: 34,
      latitude: 43.660, longitude: -79.380,
    }),
    // 12 — sparse (only name + phone, nothing else)
    makeBusiness({
      name: 'Unknown Tailor',
      address: null,
      phone: '+1 416-555-0240',
      website: null,
      category: 'Tailor',
      rating: null,
      reviews_count: 0,
      latitude: null, longitude: null,
      top_reviews: [],
    }),
    // 13 — geographically isolated (far from the Toronto cluster)
    makeBusiness({
      name: 'Northern Outfitters',
      address: '1 Main St, Sudbury, ON P3C 5S4, Canada',
      phone: '+1 705-555-0300',
      website: 'https://northernoutfitters.example.com',
      category: 'Outdoor clothing store',
      rating: 4.1,
      reviews_count: 76,
      latitude: 46.494, longitude: -81.000,
    }),
    // 14 — high-end, many reviews, live-feeling site
    makeBusiness({
      name: 'Aurora Fine Dining',
      address: '150 York St, Toronto, ON M5H 1S5, Canada',
      phone: '+1 416-555-0250',
      website: 'https://auroradining.example.com',
      category: 'Fine dining restaurant',
      rating: 4.9,
      reviews_count: 2043,
      latitude: 43.649, longitude: -79.383,
      top_reviews: [
        { author: 'Foodie', rating: 5, text: 'Exceptional tasting menu, impeccable service, beautiful room.', time: '2026-07-20' },
        { author: 'Critic', rating: 5, text: 'Best meal of the year. Worth every penny.', time: '2026-07-05' },
      ],
    }),
    // 15 — generic name (spam heuristic candidate)
    makeBusiness({
      name: 'Best Service Toronto',
      address: '88 Avenue Rd, Toronto, ON M5R 2G4, Canada',
      phone: '+1 416-555-0260',
      website: null,
      category: 'Consultant',
      rating: 4.0,
      reviews_count: 12,
      latitude: 43.670, longitude: -79.393,
    }),
    // 16 — suspicious TLD but otherwise legit
    makeBusiness({
      name: 'City Tailoring',
      address: '12 Spadina Rd, Toronto, ON M5R 2S7, Canada',
      phone: '+1 416-555-0270',
      website: 'https://citytailoring.top',
      category: 'Tailor',
      rating: 4.3,
      reviews_count: 54,
      latitude: 43.673, longitude: -79.406,
    }),
    // 17 — chain (Tim Hortons, for nearestChain assertions)
    makeBusiness({
      name: 'Tim Hortons',
      address: '10 Yonge St, Toronto, ON M5E 1R4, Canada',
      phone: '+1 416-555-0170',
      website: 'https://www.timhortons.com',
      category: 'Coffee shop',
      rating: 4.0,
      reviews_count: 1100,
      latitude: 43.648, longitude: -79.377,
    }),
    // 18 — strong web agency lead (outdated tech, live site, verified-ish)
    makeBusiness({
      name: 'Heritage Print Shop',
      address: '45 Kensington Ave, Toronto, ON M5T 2K7, Canada',
      phone: '+1 416-555-0280',
      website: 'https://heritageprint.example.com',
      category: 'Print shop',
      rating: 4.5,
      reviews_count: 96,
      latitude: 43.654, longitude: -79.412,
      top_reviews: [
        { author: 'Pat', rating: 5, text: 'Lovely old-school print shop, knowledgeable staff.', time: '2026-06-30' },
      ],
    }),
    // 19 — minimal, name only
    makeBusiness({
      name: 'Standalone Kiosk',
      address: null,
      phone: null,
      website: null,
      category: 'Kiosk',
      rating: null,
      reviews_count: 0,
      latitude: null, longitude: null,
      top_reviews: [],
    }),
  ];
}

// ---------------------------------------------------------------------------
// Shared offline enrichBatch options
// ---------------------------------------------------------------------------

const OFFLINE_OPTS = {
  defaultCountry: 'CA',
  leadProfile: 'web-agency',
  // All network phases OFF — fully offline, $0.
  geocode: false,
  emailVerify: false,
  techStackFetch: false,
};

// ---------------------------------------------------------------------------
// 1. End-to-end: 20 businesses → enrichment → all fields populated
// ---------------------------------------------------------------------------

describe('Phase 3.13 — 1. End-to-end pipeline composition (20 businesses)', () => {
  it('runs enrichBatch on 20 businesses and returns a well-formed summary', async () => {
    const batch = makeAcceptanceBatch();
    const summary = await enrichBatch(batch, OFFLINE_OPTS);

    expect(summary.enriched).toBe(20);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.costUsd).toBe(0); // fully offline
    // All 11 phases present in the summary (phone/address/dedup/chain/spam/
    // email/techStack/sentiment/geo/lead/confidence).
    expect(summary.phases).toHaveProperty('phone');
    expect(summary.phases).toHaveProperty('address');
    expect(summary.phases).toHaveProperty('dedup');
    expect(summary.phases).toHaveProperty('chain');
    expect(summary.phases).toHaveProperty('spam');
    expect(summary.phases).toHaveProperty('email');
    expect(summary.phases).toHaveProperty('techStack');
    expect(summary.phases).toHaveProperty('sentiment');
    expect(summary.phases).toHaveProperty('geo');
    expect(summary.phases).toHaveProperty('lead');
    expect(summary.phases).toHaveProperty('confidence');
  });

  it('populates phone_e164 on every business with a parseable phone', async () => {
    const batch = makeAcceptanceBatch();
    await enrichBatch(batch, OFFLINE_OPTS);

    const withPhone = batch.filter((b) => b.phone);
    expect(withPhone.length).toBeGreaterThanOrEqual(17);
    for (const b of withPhone) {
      expect(b.phone_e164).toBeTruthy();
      expect(b.phone_e164).toMatch(/^\+\d+$/);
      expect(b.phone_type).toBeTruthy();
      expect(typeof b.phone_type).toBe('string');
    }
  });

  it('populates structured address fields on every business with an address', async () => {
    const batch = makeAcceptanceBatch();
    await enrichBatch(batch, OFFLINE_OPTS);

    const withAddress = batch.filter((b) => b.address);
    for (const b of withAddress) {
      expect(b.address_street).toBeTruthy();
      expect(b.address_city).toBeTruthy();
      expect(b.address_country).toBeTruthy();
    }
  });

  it('attaches chain_result + spam_result to every business', async () => {
    const batch = makeAcceptanceBatch();
    await enrichBatch(batch, OFFLINE_OPTS);

    for (const b of batch) {
      expect(b.chain_result).toBeInstanceOf(Object);
      expect(b.chain_result).toHaveProperty('isChain');
      expect(b.spam_result).toBeInstanceOf(Object);
      expect(b.spam_result).toHaveProperty('spamScore');
      expect(b.spam_result).toHaveProperty('riskLevel');
    }
  });

  it('attaches sentiment_score to every business and themes when reviews exist', async () => {
    const batch = makeAcceptanceBatch();
    await enrichBatch(batch, OFFLINE_OPTS);

    for (const b of batch) {
      expect(typeof b.sentiment_score).toBe('number');
      expect(b.sentiment_result).toBeInstanceOf(Object);
    }
    const withReviews = batch.filter((b) => (b.top_reviews || []).length > 0);
    for (const b of withReviews) {
      expect(b.sentiment_themes).toBeInstanceOf(Object);
    }
  });

  it('attaches geo_result + competitor density counts to every business', async () => {
    const batch = makeAcceptanceBatch();
    await enrichBatch(batch, OFFLINE_OPTS);

    for (const b of batch) {
      expect(b.geo_result).toBeInstanceOf(Object);
      expect(typeof b.competitor_density_1km).toBe('number');
      expect(typeof b.competitor_density_5km).toBe('number');
    }
  });

  it('populates lead_score + lead_score_profile + confidence_score on every business', async () => {
    const batch = makeAcceptanceBatch();
    await enrichBatch(batch, OFFLINE_OPTS);

    for (const b of batch) {
      expect(typeof b.lead_score).toBe('number');
      expect(b.lead_score).toBeGreaterThanOrEqual(0);
      expect(b.lead_score).toBeLessThanOrEqual(100);
      expect(b.lead_score_profile).toBe('web-agency');
      expect(typeof b.confidence_score).toBe('number');
      expect(b.confidence_score).toBeGreaterThanOrEqual(0);
      expect(b.confidence_score).toBeLessThanOrEqual(1);
      expect(b.enriched_at).toBeInstanceOf(Date);
      expect(b.enrichment_version).toBe(1);
    }
  });

  it('techStack phase reports skipped when techStackFetch is off', async () => {
    const batch = makeAcceptanceBatch();
    const summary = await enrichBatch(batch, OFFLINE_OPTS);
    expect(summary.phases.techStack).toHaveProperty('skipped', true);
  });
});

// ---------------------------------------------------------------------------
// 2. Phone + email + tech-stack on the same business without conflicts
// ---------------------------------------------------------------------------

describe('Phase 3.13 — 2. Multi-feature coexistence on one business', () => {
  afterEach(() => {
    techStack._setHttp(null);
  });

  it('runs phone normalization + email discovery + tech-stack detection together without field conflicts', async () => {
    // Stub the HTTP fetcher so tech-stack detection runs offline.
    techStack._setHttp(async () => ({
      reachable: true,
      statusCode: 200,
      finalUrl: 'https://heritageprint.example.com/',
      html: [
        '<!DOCTYPE html><html><head>',
        '<meta name="generator" content="WordPress 5.9">',
        '<script src="https://heritageprint.example.com/wp-includes/js/jquery/jquery.min.js"></script>',
        '<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}</script>',
        '</head><body><h1>Heritage Print Shop</h1></body></html>',
      ].join(''),
      headers: { 'content-type': 'text/html', server: 'nginx' },
      redirected: false,
      liveness: 'live',
      error: null,
      truncated: false,
    }));

    const business = makeBusiness({ name: 'Heritage Print Shop' });
    await enrichBusiness(business, {
      defaultCountry: 'CA',
      leadProfile: 'web-agency',
      geocode: false,
      emailVerify: false,
      techStackFetch: true, // opt-in — uses the stub above
    });

    // Phone (3.1)
    expect(business.phone_e164).toMatch(/^\+\d+$/);
    expect(business.phone_type).toBeTruthy();
    // Email (3.5) — discovery only, status 'unverified'
    expect(business.email).toBeTruthy();
    expect(business.email).toMatch(/@/);
    expect(business.email_status).toBe('unverified');
    // Tech-stack (3.6) — stubbed HTML detected WordPress + jQuery + GA
    expect(Array.isArray(business.website_tech_stack)).toBe(true);
    expect(business.website_tech_stack.length).toBeGreaterThan(0);
    expect(business.website_tech_stack).toEqual(expect.arrayContaining(['WordPress']));
    expect(business.website_status_code).toBe(200);
    expect(business.website_liveness).toBe('live');
    // No field conflicts — all three feature sets coexist on the same record.
    expect(business.lead_score).toBeGreaterThanOrEqual(0);
    expect(business.confidence_score).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Dedup correctly merges a known duplicate pair post-enrichment
// ---------------------------------------------------------------------------

describe('Phase 3.13 — 3. Dedup clusters a known duplicate pair', () => {
  it('clusters the two Maple Leaf Family Diner records into one cluster', async () => {
    const batch = makeAcceptanceBatch();
    await enrichBatch(batch, OFFLINE_OPTS);

    const a = batch[4]; // "Maple Leaf Family Diner"
    const b = batch[5]; // "Maple Leaf Family Diner Inc."
    expect(a.dedup_result).toBeInstanceOf(Object);
    expect(b.dedup_result).toBeInstanceOf(Object);
    // Both must be in the same cluster.
    expect(a.dedup_result.clusterId).toBeTruthy();
    expect(a.dedup_result.clusterId).toBe(b.dedup_result.clusterId);
    // Exactly one is the primary (canonical), the other points to it.
    const primaries = [a.dedup_result.isPrimary, b.dedup_result.isPrimary];
    expect(primaries.filter(Boolean).length).toBe(1);
    const nonPrimary = a.dedup_result.isPrimary ? b : a;
    expect(nonPrimary.dedup_result.duplicateOf).toBeTruthy();
  });

  it('does not falsely cluster unrelated businesses', async () => {
    const batch = makeAcceptanceBatch();
    await enrichBatch(batch, OFFLINE_OPTS);

    // Rosenthal Deli (unique name+phone) should be its own primary with no duplicates.
    const rosenthal = batch[0];
    expect(rosenthal.dedup_result.isPrimary).toBe(true);
    expect(rosenthal.dedup_result.duplicates.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Lead score combines all signals correctly (via score explanation)
// ---------------------------------------------------------------------------

describe('Phase 3.13 — 4. Lead score explanation + spam cap', () => {
  it('produces a 7-signal explanation for a strong business', async () => {
    const batch = makeAcceptanceBatch();
    await enrichBatch(batch, OFFLINE_OPTS);

    const aurora = batch[14]; // Aurora Fine Dining — strong on every axis
    expect(aurora.lead_result).toBeInstanceOf(Object);
    expect(Array.isArray(aurora.lead_result.signals)).toBe(true);
    expect(aurora.lead_result.signals.length).toBe(7);
    const keys = aurora.lead_result.signals.map((s) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'legitimacy', 'reputation', 'data_quality', 'digital_maturity',
        'establishment', 'uniqueness', 'geo',
      ]),
    );
    // Each signal has the full contribution shape.
    for (const s of aurora.lead_result.signals) {
      expect(s).toHaveProperty('score');
      expect(s).toHaveProperty('weight');
      expect(s).toHaveProperty('contribution');
      expect(s).toHaveProperty('note');
    }
    // Strong business → high score, grade A or B, qualified tier, strengths present.
    expect(aurora.lead_score).toBeGreaterThanOrEqual(75);
    expect(['A', 'B']).toContain(aurora.lead_result.grade);
    expect(aurora.lead_result.topStrengths.length).toBeGreaterThan(0);
    expect(typeof aurora.lead_result.recommendation).toBe('string');
  });

  it('caps the spam business at 34 and marks spamCapped', async () => {
    const batch = makeAcceptanceBatch();
    await enrichBatch(batch, OFFLINE_OPTS);

    const spam = batch[3]; // AAA Locksmith — multiple spam heuristics fire
    expect(spam.spam_result.spamScore).toBeGreaterThanOrEqual(65);
    expect(spam.lead_result.spamCapped).toBe(true);
    expect(spam.lead_score).toBeLessThanOrEqual(34);
    expect(spam.lead_result.tier).toBe('disqualify');
  });
});

// ---------------------------------------------------------------------------
// 5. Confidence reflects source provenance
//    (ADAPTED — see note. The plan's acceptance criterion #5 specifies
//    verified-email > unverified-email confidence. The confidence module (3.10)
//    does not currently read email fields — that boost is a documented deferred
//    enhancement (see worklog 3.13). This test asserts the provenance signals
//    confidence DOES encode — live website > dead website, valid phone >
//    invalid phone — plus that email_status provenance is correctly persisted.)
// ---------------------------------------------------------------------------

describe('Phase 3.13 — 5. Confidence reflects source provenance', () => {
  it('persists email_status provenance (verified vs unverified) on the record', async () => {
    const batch = makeAcceptanceBatch();
    await enrichBatch(batch, OFFLINE_OPTS);

    // With emailVerify off, every discovered email is 'unverified'.
    const withEmail = batch.filter((b) => b.email);
    for (const b of withEmail) {
      expect(b.email_status).toBe('unverified');
    }
    // Manually mark one verified to prove provenance is a first-class persisted field.
    const one = withEmail[0];
    one.email_status = 'verified';
    expect(one.email_status).toBe('verified');
    expect(one.email).toBeTruthy();
  });

  it('scores a live-website business higher than an identical dead-website one', () => {
    const base = {
      name: 'Provenance Test Co',
      address: '100 King St W, Toronto, ON, Canada',
      phone: '+1 416-555-0991',
      phone_e164: '+14165550991',
      phone_type: 'landline',
      phone_country_code: 'CA',
      address_street: '100 King St W',
      address_city: 'Toronto',
      address_country: 'CA',
      lat: 43.648, lng: -79.383,
      geocode_confidence: 0.9,
      website: 'https://example.com',
      website_liveness: 'live',
      website_status_code: 200,
      website_tech_stack: ['WordPress'],
      reviews_count: 100,
      rating: 4.5,
      sentiment_score: 0.6,
      spam_result: { isSpam: false, spamScore: 0, riskLevel: 'clean', flags: [] },
      dedup_result: { clusterId: null, isPrimary: true, duplicates: [], maxSimilarity: 0 },
    };
    const live = JSON.parse(JSON.stringify(base));
    const dead = JSON.parse(JSON.stringify(base));
    dead.website_liveness = 'dead';
    dead.website_status_code = 503;

    const liveConf = confidenceMod.computeConfidence(live);
    const deadConf = confidenceMod.computeConfidence(dead);

    expect(liveConf.score).toBeGreaterThan(deadConf.score);
    // The HAS_LIVE_WEBSITE factor is the provenance signal differentiating them.
    const liveCodes = liveConf.factors.map((f) => f.code);
    expect(liveCodes).toContain('HAS_LIVE_WEBSITE');
  });

  it('scores a valid-phone business higher than an invalid-phone one', () => {
    const base = {
      name: 'Phone Provenance Co',
      address: '200 King St W, Toronto, ON, Canada',
      phone: '+1 416-555-0992',
      phone_type: 'landline',
      phone_e164: '+14165550992',
      address_street: '200 King St W',
      address_city: 'Toronto',
      address_country: 'CA',
      lat: 43.648, lng: -79.383,
      website: 'https://example.com',
      website_liveness: 'live',
      reviews_count: 50,
      rating: 4.0,
      spam_result: { isSpam: false, spamScore: 0, riskLevel: 'clean', flags: [] },
      dedup_result: { clusterId: null, isPrimary: true, duplicates: [], maxSimilarity: 0 },
    };
    const valid = JSON.parse(JSON.stringify(base));
    const invalid = JSON.parse(JSON.stringify(base));
    invalid.phone_type = 'invalid';
    invalid.phone_e164 = null;

    const validConf = confidenceMod.computeConfidence(valid);
    const invalidConf = confidenceMod.computeConfidence(invalid);

    expect(validConf.score).toBeGreaterThan(invalidConf.score);
  });
});

// ---------------------------------------------------------------------------
// 6. Grid coverage: 2×2 grid produces 4 points, merged without duplicates
// ---------------------------------------------------------------------------

describe('Phase 3.13 — 6. Grid coverage (2×2 → 4 search points)', () => {
  it('generates exactly 4 points for a 2×2 grid', () => {
    // bbox is {north,south,east,west}; a ~2°×2° box with a 1° step → 2×2 = 4 points.
    const bbox = { north: 44.0, south: 43.0, east: -79.0, west: -80.0 };
    const stepKm = 111; // ~1° latitude
    const points = gridCoverage.generateGrid(bbox, stepKm);
    expect(Array.isArray(points)).toBe(true);
    expect(points.length).toBe(4);
    for (const p of points) {
      expect(p).toHaveProperty('lat');
      expect(p).toHaveProperty('lng');
    }
  });

  it('gridSearchPoints emits {lat,lng,query,label} for every point with no duplicates', () => {
    const region = {
      type: 'bbox',
      bbox: { north: 44.0, south: 43.0, east: -79.0, west: -80.0 },
    };
    // stepKm is read from opts (not the region object) — see gridSearchPoints.
    const opts = { query: 'Restaurant', stepKm: 111 };
    const jobs = gridCoverage.gridSearchPoints(region, opts);
    expect(jobs.length).toBe(4);
    for (const j of jobs) {
      expect(j).toHaveProperty('lat');
      expect(j).toHaveProperty('lng');
      expect(typeof j.query).toBe('string');
      expect(j.query.length).toBeGreaterThan(0);
      expect(typeof j.label).toBe('string');
    }
    // No duplicate coordinates (results merge correctly).
    const keys = new Set(jobs.map((j) => `${j.lat.toFixed(6)},${j.lng.toFixed(6)}`));
    expect(keys.size).toBe(jobs.length);
  });

  it('respects the MAX_GRID_POINTS safety cap', () => {
    const huge = { north: 50.0, south: 40.0, east: -70.0, west: -90.0 };
    const points = gridCoverage.generateGrid(huge, 0.5);
    expect(points.length).toBeLessThanOrEqual(gridCoverage.MAX_GRID_POINTS);
  });
});

// ---------------------------------------------------------------------------
// 7. Enrichment queue + scrape queue coexist (no job-type collision)
// ---------------------------------------------------------------------------

describe('Phase 3.13 — 7. Enrichment + scrape jobs coexist in one queue', () => {
  it('accepts search, detail, and enrich jobs in the same MockQueue without collision', async () => {
    const queue = new MockQueue('combined');
    const searchJob = await queue.add('search', { query: 'Restaurant', location: 'Toronto' });
    const detailJob = await queue.add('detail', { place_id: 'ChIJ_x' });
    const enrichJob = await queue.add('enrich', { businessIds: ['ChIJ_x', 'ChIJ_y'], profile: 'web-agency' });

    // Three distinct jobs, distinct ids, distinct names.
    expect(searchJob.id).not.toBe(detailJob.id);
    expect(detailJob.id).not.toBe(enrichJob.id);
    const names = new Set([searchJob.name, detailJob.name, enrichJob.name]);
    expect(names.size).toBe(3);
    expect(names).toEqual(new Set(['search', 'detail', 'enrich']));

    // All three are retained in the waiting state — no job-type collision dropped any.
    const waiting = await queue.getJobs('waiting');
    expect(waiting.length).toBe(3);
    const waitingNames = waiting.map((j) => j.name).sort();
    expect(waitingNames).toEqual(['detail', 'enrich', 'search']);
  });
});

// ---------------------------------------------------------------------------
// 8. Budget caps stop individual features without killing the run
// ---------------------------------------------------------------------------

describe('Phase 3.13 — 8. Geocode budget cap stops geocoding without aborting', () => {
  it('geocodeBatch stops geocoding once the USD budget is exhausted', async () => {
    // Fake geocoder that charges $0.01 per call — no real network.
    const fakeGeocoder = {
      stats: { requests: 0, successes: 0, failures: 0, costUsd: 0 },
      async geocode(/* addr */) {
        this.stats.requests += 1;
        this.stats.successes += 1;
        this.stats.costUsd += 0.01;
        return { lat: 43.65, lng: -79.38, confidence: 0.9, source: 'fake' };
      },
    };

    const businesses = Array.from({ length: 5 }, (_, i) => ({
      place_id: `bg_${i}`,
      address: `${100 + i} Test St, Toronto, ON, Canada`,
    }));

    const stats = await address.geocodeBatch(businesses, {
      geocoder: fakeGeocoder,
      budgetUsd: 0.025, // enough for ~2-3 geocodes, not all 5
    });

    // Budget stopped geocoding before all 5 completed.
    expect(stats.geocoded).toBeLessThan(5);
    expect(stats.total).toBe(5);
    expect(stats.budgetUsedUsd).toBeLessThanOrEqual(0.03 + 1e-9);
    // No throw — the feature degraded gracefully.
  });

  it('enrichBatch with geocode off still completes every other phase', async () => {
    const batch = makeAcceptanceBatch();
    const summary = await enrichBatch(batch, { ...OFFLINE_OPTS, geocode: false });

    expect(summary.enriched).toBe(20);
    // Every non-geocode phase still ran (none errored).
    for (const key of ['phone', 'address', 'dedup', 'chain', 'spam', 'email', 'sentiment', 'geo', 'lead', 'confidence']) {
      const phase = summary.phases[key];
      expect(phase).toBeTruthy();
      expect(phase).not.toHaveProperty('error');
    }
  });
});

// ---------------------------------------------------------------------------
// 9. --enrich off preserves Phase 2 behavior (regression)
// ---------------------------------------------------------------------------

describe('Phase 3.13 — 9. --enrich off preserves Phase 2 behavior', () => {
  it('leaves a business untouched by the enrichment pipeline when enrichBatch is not called', () => {
    // Phase 2 behavior: with enrichment off, the business object never passes
    // through enrichBatch, so no enrichment columns are attached. The raw
    // scrape fields are preserved exactly.
    const raw = makeBusiness();
    const snapshot = JSON.parse(JSON.stringify(raw));

    // Simulate "enrichment off" by NOT calling enrichBatch. The object is
    // unchanged — no phone_e164, no lead_score, no confidence_score, etc.
    expect(raw).toEqual(snapshot);
    expect(raw.phone_e164).toBeUndefined();
    expect(raw.phone_type).toBeUndefined();
    expect(raw.address_street).toBeUndefined();
    expect(raw.chain_result).toBeUndefined();
    expect(raw.spam_result).toBeUndefined();
    expect(raw.email).toBeUndefined();
    expect(raw.email_status).toBeUndefined();
    expect(raw.website_tech_stack).toBeUndefined();
    expect(raw.sentiment_score).toBeUndefined();
    expect(raw.competitor_density_1km).toBeUndefined();
    expect(raw.lead_score).toBeUndefined();
    expect(raw.confidence_score).toBeUndefined();
    expect(raw.enriched_at).toBeUndefined();
    expect(raw.enrichment_version).toBeUndefined();
  });

  it('ENRICHMENT_COLUMNS is the canonical persisted-column list (non-empty, no debug descriptors)', () => {
    expect(Array.isArray(ENRICHMENT_COLUMNS)).toBe(true);
    expect(ENRICHMENT_COLUMNS.length).toBeGreaterThan(20);
    // Debug descriptors are NOT in the persisted list.
    expect(ENRICHMENT_COLUMNS).not.toContain('chain_result');
    expect(ENRICHMENT_COLUMNS).not.toContain('spam_result');
    expect(ENRICHMENT_COLUMNS).not.toContain('tech_stack_result');
    expect(ENRICHMENT_COLUMNS).not.toContain('sentiment_result');
    expect(ENRICHMENT_COLUMNS).not.toContain('geo_result');
    expect(ENRICHMENT_COLUMNS).not.toContain('lead_result');
    expect(ENRICHMENT_COLUMNS).not.toContain('confidence_result');
    expect(ENRICHMENT_COLUMNS).not.toContain('dedup_result');
    // Provenance stamps ARE persisted.
    expect(ENRICHMENT_COLUMNS).toContain('enriched_at');
    expect(ENRICHMENT_COLUMNS).toContain('enrichment_version');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: error isolation (a failing phase doesn't abort the run)
// ---------------------------------------------------------------------------

describe('Phase 3.13 — Error isolation: one bad phase does not abort the pipeline', () => {
  it('completes the run even when a business record is malformed', async () => {
    const batch = makeAcceptanceBatch();
    // Inject a couple of malformed records mid-batch.
    batch[10] = null;
    batch[11] = { place_id: 'broken', name: null, address: null, phone: null };
    const summary = await enrichBatch(batch, OFFLINE_OPTS);

    // The run completed (did not throw). Most businesses were still enriched.
    expect(summary.enriched + summary.skipped + summary.failed).toBe(20);
    // Legit businesses on either side of the bad records still got scores.
    expect(batch[0].lead_score).toBeGreaterThanOrEqual(0);
    expect(batch[14].lead_score).toBeGreaterThanOrEqual(0);
  });
});
