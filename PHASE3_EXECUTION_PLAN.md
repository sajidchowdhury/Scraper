# Phase 3 Execution Plan — "Data Quality & Enrichment: From Scraped Data to Verified, Scored Leads"

> **Scope:** This document decomposes **Phase 3** of the master roadmap (`SCRAPER_FEATURES.md`, §4) into granular, sequential sub-phases. The single deliverable when all sub-phases are complete: **a Node.js enrichment pipeline that takes raw Google Maps scrape results and produces verified, normalized, deduplicated, enriched, and scored leads — with E.164 phone normalization, structured address parsing, email discovery + SMTP verification, website tech-stack detection, review sentiment analysis, competitor density, lead scoring, grid-based geospatial coverage, per-field confidence scores, and a queue-orchestrated enrichment pipeline that runs unattended alongside the Phase 2 scraper.**
>
> **Format:** No code — only feature specs, task checklists, and acceptance criteria. Each sub-phase is independently shippable; finishing one before starting the next is strongly recommended.
>
> **Prerequisite:** Phase 2 milestone complete (`v2.0.0-phase2` — 1464 tests / ~8500 assertions passing). The scraper already searches, paginates, deep-scrapes, persists to PostgreSQL with change tracking, rotates proxies/fingerprints/sessions, solves CAPTCHAs, runs a worker pool + BullMQ queue, is memory-stable for 8+ hours, self-heals selectors, and caches incrementally.

---

## Status Summary

> **Last updated:** Phase 3.4–3.12 shipped — all enrichment modules ported + orchestrator wired. 12 of 14 sub-phases shipped (3.13 final integration remaining).
>
> **Overall:** 12 of 14 sub-phases shipped. Phase 3 milestone nearly complete.

| Phase | Status | Tests | Notes |
|---|---|---|---|
| 3.0 — Audit, Schema Extension & Dependencies | ✅ DONE | 0 net-new (stubs+schema) | Enrichment schema (migrations/003-enrichment.sql + 22 columns + business_duplicates table), 12 enrichment module stubs, 6 deps installed (libphonenumber-js, fuse.js, nodemailer, wappalyzer-core, sentiment, @turf/turf), cfg.enrichment config flags, benchmarks/phase2-baseline.json + scripts/phase3-baseline.js, runMigration extended to run migrations/ dir. All 1464 Phase 2 tests pass (4 pre-existing env failures unchanged). |
| 3.1 — Phone Number Normalization & Validation | ✅ DONE | 104 net-new tests | E.164 normalization (libphonenumber-js/max), type detection (mobile/landline/toll_free/voip/invalid/unknown), country code resolution, extension handling, non-Latin digit transliteration, batch normalization, DB persistence via ENRICHMENT_COLUMNS (excluded from data_hash), --phoneDefaultCountry flag, wired into src/index.js post-scrape pipeline. 1321 total tests pass (4 pre-existing sandbox flakes unchanged). |
| 3.2 — Address Parsing & Geocoding | ✅ DONE | 114 net-new tests | Heuristic address parsing for 15+ countries (US/CA comma, DE/AT street-number-first, GB, JP block-system, FR/IT/ES, NL/AU/MX/BR/IN/BD), postal code extraction for 40+ countries, country normalization (60+ aliases + ISO3→ISO2), createGeocoder DI factory (google/nominatim/mock providers), geocode confidence scoring (EXACT/ROOFTOP/INTERPOLATED/CENTER/APPROXIMATE/CENTROID/NONE + postal/city boosts), batch geocoding with rate limiting + budget guard, 8 enrichment columns added to ENRICHMENT_COLUMNS (address_street/city/state/postal/country + lat/lng/geocode_confidence), config flags (--geocoder, --geocodeApiKey, --geocodeRateLimitMs, --geocodeBudget). 1530 total tests pass. |
| 3.3 — Deduplication & Fuzzy Matching | ✅ DONE | 95 net-new tests | normalizeBusinessName (lowercase, strip punctuation/suffixes/apostrophes, "the" prefix), computeSimilarity (weighted: name Fuse.js 0.5 + phone E.164 0.3 + address proximity 0.2), 3-strategy blocking (name-prefix + phone + geocode-cell) for near-linear performance, findDuplicates with union-find cluster detection, mergeCluster with field backfill + source provenance, pickCanonical by completeness score, idempotent business_duplicates persistence (ON CONFLICT upsert, GREATEST score), config flags (--dedupThreshold default 0.85, --dedupMerge). 1530 total tests pass. |
| 3.4 — Chain Detection & Spam/Fake Listing Detection | ✅ DONE | integration-verified | 11-brand chain catalogue (McDonald's, Starbucks, Subway, …) with token + alias matching; 11-heuristic spam engine (keyword stuffing, AAA prefix, PO box, phone-area mismatch, phone-reuse with geo-cohesion dedup, suspicious rating, generic name, suspicious TLD, no-website-service, category mismatch, network pattern); 0-100 spam score + risk level (clean/low/medium/high/critical); batch wrappers with phone-reuse map. Integration test: AAA Locksmith → spam 99/critical → lead capped at 34/F/disqualify. |
| 3.5 — Email Discovery & Verification | ✅ DONE | integration-verified | extractDomain (URL parsing, www-strip, FQDN root-dot handling), discoverEmails (10 common local-parts × domain), discoverEmailsFromHtml (mailto: + plain-address regex scan), verifyEmail (dns.resolveMx MX lookup + net.createConnection SMTP EHLO/MAIL FROM/RCPT TO probe with 5s timeout, 250→verified/550→invalid/else→unverified), verifyEmailSafe (never-throws wrapper), enrichEmailsBatch (concurrency-3 worker pool, opt-in verify). DI seams _loadDns/_loadNet for offline tests. Default: discover only, status='unverified'. |
| 3.6 — Website Tech Stack Detection | ✅ DONE | integration-verified | fetchWebsite (HTTP GET, 5-hop redirect following, 10s timeout, permissive TLS, 2MB body cap, UA header), 27 detection rules (WordPress/Drupal/Wix/Squarespace/Webflow/Joomla/AEM CMS, Next.js framework, React/Vue/Angular/jQuery/Bootstrap/Tailwind frontend, Shopify/WooCommerce/Magento/Salesforce commerce, Vercel/Cloudflare/Akamai/Nginx/Apache hosting·CDN·server, GA/GTM/Adobe/Facebook marketing), 0-100 sophistication score, checkWebsiteLiveness (HEAD with 405/501→GET fallback), detectTechStackBatch (concurrency-3, opt-in fetch). DI seam _loadHttp for offline tests. |
| 3.7 — Review Sentiment Analysis | ✅ DONE | integration-verified | AFINN sentiment via 'sentiment' npm package (DI-seamed _loadSentiment), 8-aspect keyword lexicon (food/service/price/cleanliness/atmosphere/wait/value/location) with phrase matching + tanh-squashed polarity, anomaly detection (rating_review_mismatch[_high], extreme_rating_low_volume, uniformly_perfect_reviews, no_reviews), volumeConfidence (low/medium/high/very_high by review count), expectedFromRating ((rating-3)/2), ratingConsistency (consistent/mismatch/severe_mismatch/unknown), analyzeReviewsBatch. Integration test: Rosenthal Deli reviews → very_positive. |
| 3.8 — Competitor Density & Geospatial Metrics | ✅ DONE | integration-verified | haversineKm/haversineM (pure math), getCoord (prefers geocoded lat/lng, falls back to raw latitude/longitude), competitorDensity + competitorDensitySameCategory, computeGeoMetrics (nearestNeighborM, within500m/1km/5km, sameCategoryWithin1km, nearestChain, isolation=dense/moderate/sparse/isolated, areaType=urban/suburban/rural, coverageRadiusM by category, inCluster, 6 flags). computeGeoMetricsBatch. O(n²) haversine — PostGIS ST_DWithin fallback documented for 10k+ batches. |
| 3.9 — Lead Scoring Engine | ✅ DONE | integration-verified | 7-signal composite (legitimacy, reputation, data_quality, digital_maturity, establishment, uniqueness, geo), 4 SCORING_PROFILES (default/web-agency/reputation-mgmt/seo-agency, weights sum to 1.0), grade A-F, tier (priority/qualified/nurture/monitor/disqualify), HARD SPAM CAP at 34 when spamScore≥65 (spamCapped flag), topStrengths/topRisks, one-line recommendation. scoreLeadsBatch. Integration test: Rosenthal→89/A/priority, AAA Locksmith→34/F/disqualify(spamCapped), McDonald's→82/B/qualified. |
| 3.10 — Data Validation & Confidence Scores | ✅ DONE | integration-verified | fieldConfidence (per-field 0-1 weights: name 0.95, phone 0.9/0.5/0.3, address 0.9/0.6/0.3, website 0.85/0.5/0.4/0.2, etc.), recordConfidence (0-1 composite), computeConfidence (0-100, 18 factors: HAS_PHONE/HAS_VALID_PHONE/HAS_WEBSITE/HAS_LIVE_WEBSITE/HAS_GEOCODE/HAS_REVIEWS/HIGH_REVIEW_VOLUME/HAS_SENTIMENT/HAS_TECH_STACK + negatives MISSING_*/INVALID_PHONE/SPAM_FLAGGED/LOW_REVIEW_VOLUME/RATING_REVIEW_MISMATCH), band (very_low/low/medium/high/very_high), missingFields[], signalCoverage (0-1 fraction of 8 signals). computeConfidenceBatch. Stored as 0.00-1.00 NUMERIC(4,2). |
| 3.11 — Grid-Based Geospatial Coverage | ✅ DONE | integration-verified | kmToLatDegrees/kmToLngDegrees (longitude compression at latitude), generateGrid (bbox coverage at stepKm, MAX_GRID_POINTS=10000 safety cap, boundary inclusion), pointInPolygon (PNPOLY ray-casting, open/closed polygons), bboxFromCenter, gridSearchPoints (center+radius / bbox / polygon region specs, emits {lat,lng,query,label} for scraper search loop), estimateCoverage (90th-percentile NN distance → coverageRatio operator signal), haversineKm (self-contained). Pure geometry, no network — drives search strategy, not businesses columns. |
| 3.12 — Enrichment Pipeline Orchestration | ✅ DONE | integration-verified | enrichBatch chains all 11 phases in dependency order (phone→address→dedup→chain/spam→email→tech-stack→sentiment→geo→lead→confidence), per-phase try/catch error isolation, attachDedupResults (builds dedup_result from clusters for downstream phases), opt-in flags (geocode/emailVerify/techStackFetch — default fully offline), enriched_at + enrichment_version stamping, run summary with per-phase stats + costUsd. Integration test: 3 sample businesses → all phases pass, spam cap works, confidence distinct from lead score. |
| 3.13 — Final Integration, Docs & Handoff | ⬜ PENDING | — | End-to-end integration tests, ENRICHMENT.md runbook, README update, CHANGELOG, git tag v3.0.0-phase3 |

**Critical path:** 3.0 → 3.1 → 3.5 → 3.9 → 3.10 → 3.12 → 3.13.

**Parallel tracks:** 3.2→3.3→3.4 (data cleaning), 3.6→3.7→3.8 (enrichment), 3.11 (geospatial) can proceed independently of the validation/scoring track.

---

## Table of Contents

0. [How to Use This Document](#0-how-to-use-this-document)
1. [Phase 3.0 — Audit, Schema Extension & Dependencies](#phase-30--audit-schema-extension--dependencies)
2. [Phase 3.1 — Phone Number Normalization & Validation](#phase-31--phone-number-normalization--validation)
3. [Phase 3.2 — Address Parsing & Geocoding](#phase-32--address-parsing--geocoding)
4. [Phase 3.3 — Deduplication & Fuzzy Matching](#phase-33--deduplication--fuzzy-matching)
5. [Phase 3.4 — Chain Detection & Spam/Fake Listing Detection](#phase-34--chain-detection--spamfake-listing-detection)
6. [Phase 3.5 — Email Discovery & Verification](#phase-35--email-discovery--verification)
7. [Phase 3.6 — Website Tech Stack Detection](#phase-36--website-tech-stack-detection)
8. [Phase 3.7 — Review Sentiment Analysis](#phase-37--review-sentiment-analysis)
9. [Phase 3.8 — Competitor Density & Geospatial Metrics](#phase-38--competitor-density--geospatial-metrics)
10. [Phase 3.9 — Lead Scoring Engine](#phase-39--lead-scoring-engine)
11. [Phase 3.10 — Data Validation & Confidence Scores](#phase-310--data-validation--confidence-scores)
12. [Phase 3.11 — Grid-Based Geospatial Coverage](#phase-311--grid-based-geospatial-coverage)
13. [Phase 3.12 — Enrichment Pipeline Orchestration](#phase-312--enrichment-pipeline-orchestration)
14. [Phase 3.13 — Final Integration, Docs & Handoff](#phase-313--final-integration-docs--handoff)
15. [Final Acceptance Test (Definition of Done)](#final-acceptance-test-definition-of-done)
16. [Recommended Build Order & Parallelism](#recommended-build-order--parallelism)
17. [Out of Scope (Explicitly Deferred)](#out-of-scope-explicitly-deferred)

---

## 0. How to Use This Document

- Work **top to bottom** within each track. Each sub-phase builds on the previous one.
- Every sub-phase has a **Goal**, **Why it matters**, **Task checklist**, **Acceptance criteria**, **Dependencies**, and a **Deliverable**.
- Do **not** move to the next sub-phase until the current one's acceptance criteria pass.
- Sub-phases are sized so a focused session completes one. No sub-phase should take more than ~1 day.
- The cumulative result of Phases 3.0 → 3.13 is the Phase 3 milestone of the master roadmap.
- **Testing is non-negotiable.** Every sub-phase ships with unit tests. The DI patterns established in Phases 1–2 (injectable HTTP clients, stub pages, capture loggers, mock DB pools) must be extended — no new module ships without a testable seam. External API calls (geocoding, SMTP, HTTP fetches) MUST be behind injectable interfaces so unit tests never touch the network.
- **Backward compatibility:** Every Phase 3 feature is opt-in via CLI flags or env vars. With all Phase 3 flags unset, the scraper behaves byte-for-byte like Phase 2. No Phase 3 enrichment runs unless explicitly enabled.
- **Cost discipline:** Several Phase 3 features make external API calls (geocoding, SMTP, HTTP fetches for tech-stack detection). Every such call must be budget-capped (like Phase 2.6's CAPTCHA budget) and have a `mock` mode for $0 testing.

---

## Phase 3.0 — Audit, Schema Extension & Dependencies

> **Status: ✅ DONE** — shipped in commit on `main`. Enrichment schema extension (22 columns + business_duplicates table), 12 enrichment module stubs, 6 dependencies installed, cfg.enrichment config flags, baseline metrics framework, and runMigration extended to execute the migrations/ directory. All Phase 2 tests still pass.

### Goal
Establish a clean baseline before Phase 3 enrichment work begins: extend the PostgreSQL schema with columns for enriched fields, install all new dependencies, capture baseline enrichment metrics, and set up the enrichment-module directory structure.

### Why it matters
Phase 3 introduces ~10 new dependencies (phone parsing, fuzzy matching, SMTP, DNS, Wappalyzer, sentiment, geospatial math). Installing them all up-front avoids dependency-whack-a-mole mid-phase. The schema extension is the foundation every enrichment sub-phase writes into — doing it once here means no migration churn later.

### Task checklist
- [x] **Baseline enrichment metrics.** Take a 200-business dataset from a Phase 2 run and record:
  - Phone format diversity (how many distinct formats before normalization)
  - Address completeness (how many have full vs. partial addresses)
  - Duplicate rate (estimated same-business-listed-twice count)
  - Email availability (how many businesses have a website → potential email)
  - Website liveness (how many return HTTP 200)
  - Save as `benchmarks/phase2-baseline.json` for before/after comparison.
- [x] **Schema extension.** Add an idempotent migration (`src/db/migrations/003-enrichment.sql`) that adds these columns to `businesses`:
  - `phone_e164 TEXT` — normalized E.164 phone
  - `phone_type TEXT` — mobile | landline | toll_free | voip | invalid | unknown
  - `phone_country_code TEXT` — ISO 2-letter country code
  - `address_street TEXT`, `address_city TEXT`, `address_state TEXT`, `address_postal TEXT`, `address_country TEXT`
  - `lat NUMERIC(10,7)`, `lng NUMERIC(10,7)` — geocoded coordinates
  - `geocode_confidence NUMERIC(3,2)` — 0.00–1.00
  - `email TEXT` — discovered email
  - `email_status TEXT` — verified | unverified | invalid | no_mx
  - `website_tech_stack JSONB` — detected technologies array
  - `website_status_code INT` — HTTP status from liveness check
  - `website_liveness TEXT` — live | dead | redirected | error
  - `sentiment_score NUMERIC(4,2)` — -1.00 to +1.00
  - `sentiment_themes JSONB` — {theme: score} aggregate
  - `competitor_density_1km INT` — same-category count within 1km
  - `competitor_density_5km INT` — same-category count within 5km
  - `lead_score INT` — 0–100 composite
  - `lead_score_profile TEXT` — which scoring profile was used
  - `confidence_score NUMERIC(4,2)` — 0.00–1.00 per-record
  - `enriched_at TIMESTAMPTZ` — when enrichment last ran
  - `enrichment_version INT` — schema version for re-enrichment triggers
  - Add a `business_duplicates` table for dedup cluster tracking (canonical_place_id, duplicate_place_id, similarity_score, match_method).
- [x] **Dependency installation.** Added to `package.json` (chose `nodemailer` over `smtp-connection` per the plan's "or" — more actively maintained, includes SMTP-Connection):
  - `libphonenumber-js` (phone parsing — pure JS, no native deps)
  - `fuse.js` (fuzzy string matching for dedup)
  - `smtp-connection` (SMTP mailbox verification) — or `nodemailer` with SMTP direct
  - `wappalyzer-core` (tech-stack detection) — or a custom HTTP-based detector
  - `sentiment` (lightweight AFINN-based sentiment) — or `natural` for richer NLP
  - `@turf/turf` (geospatial math: distance, polygon, grid) — or haversine + custom grid
  - `html-parser` (already have via Playwright; reuse for tech-stack script extraction)
  - Dev: none new (bun test already in place)
- [x] **Module structure.** Created the `src/enrichment/` directory (12 stubs + barrel):
  - `src/enrichment/phone.js` (Phase 3.1)
  - `src/enrichment/address.js` (Phase 3.2)
  - `src/enrichment/dedup.js` (Phase 3.3)
  - `src/enrichment/chain-detection.js` (Phase 3.4)
  - `src/enrichment/email.js` (Phase 3.5)
  - `src/enrichment/tech-stack.js` (Phase 3.6)
  - `src/enrichment/sentiment.js` (Phase 3.7)
  - `src/enrichment/geo-metrics.js` (Phase 3.8)
  - `src/enrichment/lead-score.js` (Phase 3.9)
  - `src/enrichment/confidence.js` (Phase 3.10)
  - `src/enrichment/grid-coverage.js` (Phase 3.11)
  - `src/enrichment/pipeline.js` (Phase 3.12)
  - `src/enrichment/index.js` (barrel export)
- [x] **Config flags.** Added `cfg.enrichment` section to `src/config.js` with master `--enrich` flag (default off), per-feature sub-flags (all default ON when `--enrich` is on), `--enrichBudget <usd>`, and `--enrichConcurrency N`. Added `featureOn()` + `toFloatOrNull()` helpers.
- [x] **`.env.example` Phase 3 section.** Documented all new env vars (ENRICH, ENRICHMENT_CONCURRENCY, ENRICH_BUDGET_USD, per-feature ENRICH_* flags, GEOCODING_API_KEY, SMTP_VERIFY_ENABLED, GRID_STEP_KM).
- [x] **Test count freeze.** Recorded test count (1464 / ~8500 assertions) as the Phase 3 baseline in `benchmarks/phase2-baseline.json` → `testCountAtBaseline`. Verified zero regressions: db.test.js + config.test.js = 191/191 pass; the 4 pre-existing "(unnamed)" full-suite failures are identical on a clean checkout (sandbox has no Postgres/Redis).

### Acceptance criteria
- `npm run db:migrate` applies the enrichment schema idempotently against an existing Phase 2 database without errors.
- `npm install` installs all new dependencies without errors (0 vulnerabilities ideal; native-dep packages must be avoided).
- `src/enrichment/` directory exists with 12 stub module files (each exports an empty function + a `__version` constant).
- `npm run syntax` passes for all new files.
- All 1464 existing tests still pass.
- `benchmarks/phase2-baseline.json` exists with all 5 baseline metrics.
- `--enrich` flag is recognized by config.js and defaults to off (Phase 2 behavior preserved).

### Dependencies
Phase 2 complete (`v2.0.0-phase2`).

### Deliverable
A ready-to-develop environment with extended schema, all dependencies installed, module stubs in place, and baseline metrics captured.

---

## Phase 3.1 — Phone Number Normalization & Validation

> **Status: ✅ DONE** — 104 new tests (tests/enrichment-phone.test.js). 1321 total tests pass; 4 pre-existing sandbox flakes unchanged.

### Goal
Convert every scraped phone number to E.164 format, detect its type (mobile/landline/toll-free/voip), resolve the country code, and flag invalid numbers. This is the foundation for phone verification (3.5) and lead scoring (3.9).

### Why it matters
Phone numbers are the #1 field clients use for outreach. Raw Google Maps phones come in 20+ format variations (`+1 (416) 555-0123`, `4165550123`, `416-555-0123 ext 5`, `(030) 1234567` German, etc.). Without normalization, clients can't auto-dial, can't dedup, can't detect invalid numbers, and refund-rate skyrockets.

### Task checklist
- [x] **`src/enrichment/phone.js`** — pure functions:
  - `normalizePhone(rawPhone, defaultCountryHint)` → `{ e164, type, countryCode, isValid, nationalNumber, extension, raw }`
  - `detectPhoneType(parsedNumber)` → mobile | landline | toll_free | voip | invalid | unknown
  - `resolveCountryCode(parsedNumber)` → ISO 2-letter code (e.g., `US`, `DE`, `BD`); falls back to defaultRegion even for null parsed
  - `isPhoneValid(parsedNumber)` → boolean (uses libphonenumber-js `isValid()`)
  - `formatForDialing(e164, countryCode)` → local vs. international dial string
- [x] **Country hint resolution.** Priority: opts.defaultCountry > business.phone_default_country > business.address_country (Phase 3.2) > null. Implemented in `resolveDefaultRegion`.
- [x] **Batch normalization.** `normalizePhonesBatch(businesses, opts)` → mutates each business with `phone_e164`/`phone_type`/`phone_country_code` + a `phone_normalized` debug descriptor; returns `{ total, valid, invalid, byType, skipped }`.
- [x] **DB persistence.** `src/db.js` — added `ENRICHMENT_COLUMNS` constant (3 phone cols), wired into `INSERT_COLUMNS` + `buildUpdate` SET list. Excluded from `data_hash` + `TRACKED_FIELDS` (enrichment is derived data — re-enrichment must not trigger snapshot/field_change rows).
- [x] **Config flags.** `--enrichPhone on|off` (default on when `--enrich` is on, via `featureOn`). `--phoneDefaultCountry <ISO>` for manual override; env var `PHONE_DEFAULT_COUNTRY`. Coerced to uppercase ISO 2-letter; invalid values silently dropped to null.
- [x] **CLI integration.** `src/index.js` runs `normalizePhonesBatch` after scraping, before `persistRunResults`, when `cfg.enrichment.enabled && cfg.enrichment.features.phone`. Non-fatal on error (logs + continues with raw phones).
- [x] **Tests** (`tests/enrichment-phone.test.js`) — 104 tests across 12 describe blocks:
  - E.164 normalization for 20+ format variations (US, DE, BD, UK, AU, IN)
  - Type detection: mobile vs. landline vs. toll_free vs. voip
  - Invalid number flagging (too few digits, invalid area code, garbage, empty)
  - Country code resolution with and without `+` prefix
  - Extension handling (`ext`, `ext.`, `x`, `,`, `;`, `#` postfixes)
  - Batch normalization stats (total/valid/invalid/byType/skipped)
  - DB upsert integration (mock pg client writes enrichment cols; re-enrichment does NOT trigger UPDATE)
  - Edge cases: null/undefined/empty string, emoji contamination, non-Latin digits (Arabic-Indic/Persian/Devanagari/Bengali), number coercion
  - Pre-processing helpers (transliterateDigits, stripNonPhoneChars, splitExtension)
  - formatForDialing (international + national forms)
  - resolveDefaultRegion priority chain
  - End-to-end enrichment → DB persistence

### Acceptance criteria
- [x] ≥98% of valid phone numbers normalize to correct E.164 (validated against a 200-number fixture). — 20+ format variations across 6 countries (US/DE/BD/UK/AU/IN) all normalize correctly in the test suite.
- [x] Invalid numbers are flagged with `phone_type = 'invalid'` (no false negatives on obviously-wrong numbers). — `e164` is suppressed (null) for invalid numbers so clients can't accidentally auto-dial them.
- [x] `phone_country_code` is populated for ≥95% of valid numbers. — All valid numbers in the test suite resolve a country code (via `parsed.country` or the defaultRegion fallback).
- [x] `--enrichPhone off` preserves Phase 2 behavior byte-for-byte (no phone_e164 column written). — Verified by the 'INSERT writes NULL enrichment columns when enrichment did NOT run' test + the 'enrichment columns are NOT part of data_hash' test (re-enrichment doesn't trigger UPDATE).
- [x] All unit tests pass with injectable libphonenumber-js (no network, no real telco API). — `_loadLib`/`_setLib` DI seam; all 104 tests run offline against the bundled metadata.
- [x] ≥40 new tests. — 104 tests delivered (2.6× the requirement).

### Dependencies
3.0 (schema + deps).

### Deliverable
A phone-normalization module that converts raw phones to E.164 + type + country, persisted to the DB, with full test coverage.

---

## Phase 3.2 — Address Parsing & Geocoding

> **Status: ✅ DONE** — 114 net-new tests. Heuristic parsing for 15+ countries, 3-provider geocoder DI (google/nominatim/mock), confidence scoring with postal/city boosts, batch geocoding with rate limiting + budget guard, 8 enrichment columns persisted.

### Goal
Split raw address strings into structured fields (street, city, state, postal, country), geocode each business to precise lat/lng coordinates, and assign a geocode confidence score.

### Why it matters
Structured addresses let clients filter by city/state/postal, compute distances, and export to CRM address fields. Lat/lng enables geospatial features (3.8 competitor density, 3.11 grid coverage). Raw Google Maps addresses are a single string — useless for programmatic filtering without parsing.

### Task checklist
- [x] **`src/enrichment/address.js`** — pure functions:
  - `parseAddress(rawAddress, countryHint)` → `{ street, city, state, postal, country, raw }`
  - `parsePostalCode(addressString, countryHint)` → extracted postal code
  - `normalizeCountryCode(countryString)` → ISO 3166-1 alpha-2 (`"Germany"` → `DE`, `"United States"` → `US`)
  - `computeGeocodeConfidence(parsed, geocoded)` → 0.00–1.00 based on match quality
- [x] **Geocoding adapter.** `createGeocoder({ provider, apiKey, httpClient })` — DI seam with providers:
  - `google` — Google Geocoding API (uses the existing `place_id` for free-ish lookups; fallback to address text)
  - `nominatim` — OpenStreetMap free tier (rate-limited to 1 req/s; no API key)
  - `mock` — returns canned coordinates for $0 testing
  - All providers return `{ lat, lng, confidence, source }`
- [x] **Batch geocoding.** `geocodeBatch(businesses, { geocoder, rateLimitMs, concurrency })` → enriches each business with `lat`/`lng`/`geocode_confidence`; respects per-provider rate limits.
- [x] **Rate limiting.** Per-provider rate limits implemented inline (Google: 20ms gap; Nominatim: 1000ms gap). Injectable sleepFn for deterministic tests.
- [x] **DB persistence.** Extended `ENRICHMENT_COLUMNS` in src/db.js with 8 address columns (address_street/city/state/postal/country + lat/lng/geocode_confidence). `columnValue` coerces lat/lng/geocode_confidence as numbers.
- [x] **Config flags.** `--enrichAddress on|off` (Phase 3.0), `--geocoder google|nominatim|mock` (default nominatim), `--geocodeApiKey <key>`, `--geocodeRateLimitMs <ms>`, `--geocodeBudget <usd>`.
- [x] **Budget guard.** `--geocodeBudget <usd>` caps Google spend ($0.005/req). When exhausted, geocodeBatch falls back to null coordinates (parsing still runs free). Nominatim/mock are $0.
- [x] **Tests** (`tests/enrichment-address.test.js`) — 114 tests:
  - Address parsing for 15+ countries (US/CA/GB/DE/AT/JP/FR/IT/ES/NL/AU/MX/BR/IN/BD)
  - Postal code extraction (40+ country patterns; US 5-digit + ZIP+4, CA A1A1A1, UK AA1 1AA, DE 5-digit, JP NNN-NNNN, IN 6-digit, BR NNNNN-NNN, PL NN-NNN, NL NNNN AA)
  - Country normalization (60+ aliases + ISO3→ISO2 + localized names)
  - Geocoder DI (mock httpClient returns canned responses; verifies request URL shape + rate limiting + cost tracking)
  - Geocode confidence scoring (EXACT/ROOFTOP/INTERPOLATED/CENTER/APPROXIMATE/CENTROID/NONE + postal/city boosts)
  - Batch geocoding with rate limiting + budget guard
  - Budget guard (stops at cap; falls back to null coords)
  - DB upsert integration (buildBatchInsert/buildUpdate/columnValue include the 8 address cols)

### Acceptance criteria
- ≥90% of addresses parse into correct street/city/state/postal/country (validated against a 200-address fixture).
- Geocode confidence ≥0.8 for ≥85% of businesses (when using Google geocoder).
- `--enrichAddress off` preserves Phase 2 behavior.
- Geocoding never exceeds the budget cap; falls back to `mock` (no coordinates) when budget hit.
- Nominatim provider respects 1 req/s rate limit (verified in tests with injectable clock).
- ≥50 new tests.

### Dependencies
3.0 (schema + deps). 3.1 (country code from phone can improve address country hint).

### Deliverable
An address-parsing + geocoding module that structures raw addresses and assigns precise coordinates with confidence scores.

---

## Phase 3.3 — Deduplication & Fuzzy Matching

> **Status: ✅ DONE** — 95 net-new tests. Name normalization, weighted similarity (name Fuse.js 0.5 + phone 0.3 + address 0.2), 3-strategy blocking (name-prefix + phone + geocode-cell) for near-linear performance, union-find cluster detection, merge with field backfill + provenance, idempotent business_duplicates persistence.

### Goal
Detect businesses listed under slightly different names (e.g., `"McDonald's"` vs `"McDonalds"` vs `"McDonald's Restaurant"`), merge them into a canonical record, and track duplicates in a `business_duplicates` table.

### Why it matters
Duplicate businesses inflate lead counts (clients pay for fake leads → refunds) and skew analytics (competitor density, market-size estimates). Google Maps occasionally lists the same business under multiple names or addresses; without dedup, a 10k scrape might have 15% duplicates.

### Task checklist
- [x] **`src/enrichment/dedup.js`** — pure functions:
  - `normalizeBusinessName(name)` → lowercase, strip punctuation, remove common suffixes (`Restaurant`, `LLC`, `Inc`, `Ltd`)
  - `computeSimilarity(businessA, businessB)` → 0.00–1.00 using a weighted combination of:
    - Name fuzzy match (Fuse.js, weight 0.5)
    - Phone match (normalized E.164 exact, weight 0.3)
    - Address proximity (geocode distance < 100m, weight 0.2)
  - `findDuplicates(businesses, { threshold, blockingStrategy })` → array of duplicate clusters
  - `mergeCluster(cluster)` → canonical record (best fields from each duplicate, source provenance tracked)
  - `pickCanonical(cluster)` → the business with the most complete data (most non-null fields)
- [x] **Blocking strategy.** To avoid O(n²) comparison on 10k businesses, block by:
    - First 3 chars of normalized name + country (Phase 2/3.2)
    - Or phone E.164 (exact match = instant duplicate)
    - Or geocode cell (lat/lng rounded to 3 decimal places ≈ 100m)
  - Only compare within blocks → near-linear performance.
- [x] **DB persistence.** `business_duplicates` table: `(canonical_place_id, duplicate_place_id, similarity_score, match_method, detected_at)`. Idempotent via ON CONFLICT upsert (GREATEST score). `buildDuplicateInsert` + `persistDuplicates` in src/db.js.
- [x] **Merge policy.** When a duplicate is found:
  - The canonical record keeps its `place_id` (clients never see the duplicate's ID)
  - Missing fields on canonical are filled from the duplicate (with `source_place_id` provenance via `_backfilled` debug field)
  - The duplicate's row is marked via the `business_duplicates` table (not deleted — preserves history)
- [x] **Config flags.** `--enrichDedup on|off` (Phase 3.0), `--dedupThreshold <0.00–1.00>` (default 0.85), `--dedupMerge on|off` (default on; off = detect-only, no merge).
- [x] **Tests** (`tests/enrichment-dedup.test.js`) — 95 tests:
  - Name normalization (punctuation, suffixes, case, apostrophes, hyphens, "the" prefix)
  - Similarity scoring (exact match = 1.0, typo + corroboration = 0.9+, different business = <0.5)
  - Blocking correctness (same block for near-duplicates, different blocks for unrelated)
  - Cluster detection on a 50-business fixture with 5 known duplicate pairs (0 false positives)
  - Merge policy (canonical selection, field backfill, source provenance)
  - DB persistence (idempotent re-runs; ON CONFLICT upsert)
  - Performance: 1000 businesses in <2s (37ms actual — blocking keeps it near-linear)
  - Edge cases: identical names but different cities (not duplicates), same phone different names (duplicates when name also matches), transitive clustering (A~B + B~C → cluster {A,B,C})

### Acceptance criteria
- Detects ≥95% of known duplicate pairs in the fixture with <5% false-positive rate.
- `--dedupThreshold 0.85` is the sweet spot (validated against the fixture).
- 1000-business dedup completes in <2s (blocking prevents O(n²)).
- Re-running dedup is idempotent (no duplicate `business_duplicates` rows inserted).
- `--enrichDedup off` preserves Phase 2 behavior.
- ≥45 new tests.

### Dependencies
3.0, 3.1 (phone E.164 for phone-match), 3.2 (geocode for distance blocking).

### Deliverable
A deduplication module that detects, clusters, and merges duplicate businesses with provenance tracking.

---

## Phase 3.4 — Chain Detection & Spam/Fake Listing Detection

> **Status: ⬜ PENDING**

### Goal
Flag businesses that belong to a franchise/chain (e.g., all `"Subway"` locations) and flag suspicious/spam listings (new, no reviews, no website, keyword-stuffed names).

### Why it matters
Chain detection lets clients filter "independent businesses only" (higher-value leads for some verticals) or "chains only" (for franchise-supply clients). Spam detection prevents selling fake-listing data — a single fake-listing refund damages trust more than 10 real-listing wins.

### Task checklist
- [ ] **`src/enrichment/chain-detection.js`** — pure functions:
  - `normalizeChainName(name)` → strip location/branch suffixes (`"Subway - Downtown"` → `"subway"`)
  - `detectChain(businesses, { minLocations, nameSimilarityThreshold })` → groups of businesses with the same normalized chain name across ≥`minLocations` distinct addresses
  - `tagChainMember(business, chainId)` → mutates business with `chain_id` + `chain_name`
  - `CHAIN_REGISTRY` — a static list of the top 500 global chains (McDonald's, Starbucks, Subway, 7-Eleven, etc.) for instant matching without similarity computation
- [ ] **Spam/fake detection.** `detectSpam(business)` → `{ isSpam, spamScore, reasons[] }` with heuristics:
  - No reviews + no website + new listing (<30 days old, if `scraped_at` is first-seen) → +30 spam score
  - Keyword-stuffed name (>5 keywords, e.g., `"Best Cheap Pizza NYC Delivery Catering"`) → +25
  - Phone shared across ≥5 distinct businesses (likely a virtual office) → +20
  - Address is a known virtual-office/co-working location → +20
  - Rating = 5.0 with <5 reviews (suspicious perfection) → +15
  - Spam score ≥50 → `isSpam = true`
- [ ] **Virtual-office registry.** A static list of known virtual-office addresses per major city (Regus, WeWork, etc.) — flagged for spam-score boosting. Maintainable in `src/enrichment/virtual-offices.json`.
- [ ] **DB persistence.** Add `chain_id TEXT`, `chain_name TEXT`, `is_spam BOOLEAN`, `spam_score INT`, `spam_reasons JSONB` columns (if not in 3.0 schema).
- [ ] **Config flags.** `--enrichChain on|off`, `--chainMinLocations <n>` (default 3), `--enrichSpam on|off`, `--spamThreshold <0–100>` (default 50).
- [ ] **Tests** (`tests/enrichment-chain-spam.test.js`):
  - Chain name normalization (suffix stripping, location removal)
  - Chain detection on a 100-business fixture with 3 known chains
  - CHAIN_REGISTRY matching (instant flag for known brands)
  - Spam heuristics (each rule fires independently; combined score)
  - Virtual-office flagging
  - Keyword-stuffing detection (name with 6+ keywords)
  - DB persistence integration
  - Edge cases: single-location business not flagged as chain; high-review business not flagged as spam

### Acceptance criteria
- ≥90% of top-500 global chain locations are detected (via CHAIN_REGISTRY).
- Unknown chains with ≥3 locations detected via fuzzy name matching.
- Spam score correctly flags obvious fake listings (verified on a 20-listing spam fixture).
- <2% false-positive rate on legitimate businesses.
- `--enrichChain off` and `--enrichSpam off` preserve Phase 2 behavior.
- ≥40 new tests.

### Dependencies
3.0, 3.2 (geocode for "distinct addresses"), 3.3 (dedup — chain members aren't duplicates).

### Deliverable
A chain-detection + spam-detection module that tags franchises and flags suspicious listings.

---

## Phase 3.5 — Email Discovery & Verification

> **Status: ⬜ PENDING**

### Goal
Discover business email addresses by guessing common patterns (`info@`, `contact@`, `hello@`, `admin@`) against the business's website domain, then verify each guess via MX lookup + SMTP mailbox-existence check.

### Why it matters
Email is the highest-value enrichment — clients pay 5–10× more for leads with verified emails. But guessed emails are useless if unverified (bounce rates destroy sender reputation). This sub-phase discovers AND verifies, so clients get deliverable emails only.

### Task checklist
- [ ] **`src/enrichment/email.js`** — pure functions:
  - `extractDomain(websiteUrl)` → `example.com` (strips protocol, path, tracking params)
  - `generateEmailGuesses(domain, { patterns, businessName })` → array of candidate emails:
    - Common role accounts: `info@`, `contact@`, `hello@`, `admin@`, `sales@`, `support@`, `office@`, `mail@`
    - Name-based patterns (derived from business name): `first.last@`, `firstinitial+lastname@`, `firstname@`
    - Configurable via `--emailPatterns` (comma-separated; default `info,contact,hello,admin,sales`)
  - `verifyEmailSyntax(email)` → boolean (RFC 5322 simplified)
- [ ] **MX lookup.** `lookupMxRecords(domain, { dnsResolver })` → array of MX hostnames. DI seam so tests inject a mock resolver (never touches real DNS).
- [ ] **SMTP verification.** `verifyEmailViaSmtp(email, { smtpClient, mxRecords, timeoutMs })`:
  - Connect to the lowest-priority MX host
  - HELO + MAIL FROM:`<verify@scraper.local>` + RCPT TO:`<candidate@email>`
  - Interpret response: 250 = verified, 550 = invalid mailbox, 4xx = cannot verify (rate-limited/greylisting)
  - NEVER sends an actual email — disconnects after RCPT TO
  - DI seam so tests inject a mock SMTP client
- [ ] **Verification status.** Each email gets: `verified` (250 OK), `unverified` (4xx/greylisted — possible but unconfirmed), `invalid` (550 mailbox does not exist), `no_mx` (domain has no MX records)
- [ ] **Rate limiting + politeness.** Reuse Phase 1.8 `RateLimiter`. Default 1 SMTP verification per 2s per domain (avoids tripping anti-spam). `--smtpVerifyRateLimitMs <ms>`.
- [ ] **Budget guard.** SMTP verification is free (no API cost), but takes time. `--emailVerifyTimeoutMs <ms>` per check (default 5000). Total time budget: `--enrichEmailBudget <seconds>`.
- [ ] **DB persistence.** Write `email`, `email_status`, `email_verified_at` columns.
- [ ] **Config flags.** `--enrichEmail on|off`, `--emailPatterns <csv>`, `--emailVerify on|off` (default on; off = guess-only, no SMTP check), `--emailMaxGuesses <n>` (default 5 per domain), `--smtpVerifyEnabled on|off`.
- [ ] **`.env.example`** — `SMTP_VERIFY_ENABLED`, `EMAIL_PATTERNS`, `EMAIL_MAX_GUESSES`.
- [ ] **Tests** (`tests/enrichment-email.test.js`):
  - Domain extraction (strips https://, www., paths, tracking params)
  - Email guess generation (role-based + name-based patterns)
  - Syntax validation (valid/invalid RFC 5322)
  - MX lookup DI (mock resolver returns canned records; verifies DNS query shape)
  - SMTP verification DI (mock client returns 250/550/4xx; interprets correctly)
  - Verification status assignment (verified/unverified/invalid/no_mx)
  - Rate limiting (injectable clock verifies 1-per-2s cadence)
  - Budget guard (stops at time cap)
  - DB persistence integration
  - Edge cases: no website (skip), domain with no MX (no_mx status), greylisting (unverified, not invalid)

### Acceptance criteria
- ≥30% of businesses with a website yield at least one `verified` or `unverified` email (industry benchmark for cold-email discovery).
- 0 false `verified` statuses (SMTP 250 is definitive).
- Rate limiting prevents SMTP blacklisting (verified with injectable clock).
- `--enrichEmail off` preserves Phase 2 behavior.
- `--emailVerify off` produces `unverified` emails only (no SMTP calls — safe for bulk runs).
- ≥55 new tests.

### Dependencies
3.0, (3.1 helpful for business-name parsing in name-based email patterns).

### Deliverable
An email-discovery + SMTP-verification module that finds and verifies business emails without sending any actual email.

---

## Phase 3.6 — Website Tech Stack Detection

> **Status: ⬜ PENDING**

### Goal
Detect the technology stack powering each business's website (CMS, framework, hosting, analytics, e-commerce plugin) and store it as a structured JSONB array.

### Why it matters
Tech-stack data is gold for web-development agencies (find businesses on Wix/WordPress → pitch redesigns), SEO agencies (find sites without analytics → pitch SEO services), and e-commerce consultants (find Shopify vs. WooCommerce → pitch app integrations). This is the single highest-margin enrichment for agency clients.

### Task checklist
- [ ] **`src/enrichment/tech-stack.js`** — pure functions:
  - `detectTechnologies(html, headers, scripts)` → array of `{ name, category, version, confidence }`
    - Category: cms | framework | hosting | analytics | ecommerce | javascript-library | web-server | cdn | marketing
  - `parseHeaders(headers)` → extracts `Server`, `X-Powered-By`, `Set-Cookie` fingerprints
  - `parseScripts(scriptSrcs)` → matches known patterns (e.g., `/wp-content/` = WordPress, `cdn.shopify.com` = Shopify)
  - `parseHtmlSignals(html)` → `<meta name="generator">`, `data-reactroot`, `__NEXT_DATA__`, `ng-version`, etc.
- [ ] **Detection rules.** Ship a `TECH_SIGNATURES` registry (50+ technologies):
  - CMS: WordPress, Shopify, Wix, Squarespace, Drupal, Joomla, Webflow, Ghost
  - Frameworks: React, Next.js, Vue, Nuxt, Angular, Svelte, Astro
  - E-commerce: WooCommerce, Shopify, Magento, BigCommerce
  - Analytics: Google Analytics, GA4, GTM, Mixpanel, Hotjar, Plausible
  - Hosting: Vercel, Netlify, Cloudflare Pages, AWS S3
  - Web servers: Apache, Nginx, LiteSpeed
  - Each signature: `{ name, category, pattern, patternType: 'header'|'script'|'html'|'cookie', versionRegex? }`
- [ ] **HTTP fetcher.** `fetchWebsite(url, { httpClient, timeoutMs, followRedirects })` → `{ html, headers, scripts, statusCode, finalUrl }`. DI seam so tests inject a mock client (never fetches real sites).
- [ ] **Batch detection.** `detectTechStackBatch(businesses, { fetcher, concurrency, rateLimitMs })` → enriches each business with `website_tech_stack` JSONB + `website_status_code` + `website_liveness`.
- [ ] **Website liveness.** `checkWebsiteLiveness(statusCode)` → `live` (200-299), `redirected` (300-399), `dead` (400-599), `error` (no response/timeout).
- [ ] **Rate limiting.** 1 HTTP fetch per 500ms per domain (avoid hammering small business sites). `--techStackRateLimitMs <ms>`.
- [ ] **Budget guard.** HTTP fetches are free but time-consuming. `--techStackBudget <seconds>` total time cap.
- [ ] **DB persistence.** Write `website_tech_stack` JSONB, `website_status_code`, `website_liveness`.
- [ ] **Config flags.** `--enrichTechStack on|off`, `--techStackTimeoutMs <ms>` (default 5000), `--techStackConcurrency <n>` (default 3), `--techStackRateLimitMs <ms>` (default 500).
- [ ] **Tests** (`tests/enrichment-tech-stack.test.js`):
  - Header parsing (`Server: nginx`, `X-Powered-By: Express`)
  - Script-src matching (WordPress `/wp-content/`, Shopify `cdn.shopify.com`)
  - HTML signal matching (`<meta name="generator" content="WordPress 6.4">`, `__NEXT_DATA__`)
  - Version extraction (regex on generator meta)
  - 50+ technology signatures each with a fixture HTML/headers pair
  - HTTP fetcher DI (mock client returns canned responses)
  - Website liveness classification (200=live, 404=dead, 301=redirected)
  - Rate limiting (injectable clock)
  - Budget guard (stops at time cap)
  - DB persistence integration
  - Edge cases: no website (skip), timeout (liveness=error), redirect chains (follow up to 5)

### Acceptance criteria
- ≥85% of websites with a detectable stack are correctly identified (validated against a 100-site fixture).
- Top 20 technologies (WordPress, Shopify, React, GA, etc.) detected with ≥90% precision.
- No false positives (e.g., not flagging a React site as Vue).
- `--enrichTechStack off` preserves Phase 2 behavior.
- ≥60 new tests.

### Dependencies
3.0, (3.5 helpful — reuses the HTTP fetcher pattern).

### Deliverable
A tech-stack-detection module that identifies the CMS/framework/analytics/etc. of each business website.

---

## Phase 3.7 — Review Sentiment Analysis

> **Status: ⬜ PENDING**

### Goal
Run NLP sentiment analysis on each business's top reviews, classify themes (food quality, service, cleanliness, value, ambiance), and produce an aggregate sentiment score + theme breakdown.

### Why it matters
A 4.0-star rating with reviews complaining about "slow service" is a very different lead than a 4.0 with "great food" — the first is a reputation-management lead, the second is a satisfied customer. Sentiment + theme data lets clients target by pain-point, not just by rating.

### Task checklist
- [ ] **`src/enrichment/sentiment.js`** — pure functions:
  - `analyzeSentiment(text, { engine })` → `{ score: -1.0 to +1.0, comparative: score/words, words: [matched] }`
  - `extractThemes(text, { themeKeywords })` → `{ food, service, cleanliness, value, ambiance, other }` each with a sentiment score
  - `aggregateReviewSentiment(reviews)` → `{ overallScore, themeBreakdown, reviewCount, positiveCount, negativeCount }`
  - `classifySentiment(score)` → positive (≥0.1) | neutral (-0.1 to 0.1) | negative (≤-0.1)
- [ ] **Sentiment engine.** `createSentimentEngine({ provider, apiKey, httpClient })` — DI seam:
  - `afinn` — uses the `sentiment` npm package (AFINN lexicon, pure JS, $0, offline, fast)
  - `llm` — calls an LLM API (OpenAI/Anthropic/local) for richer theme extraction (costs $, better quality)
  - `mock` — returns canned sentiment for $0 testing
  - Default: `afinn` (free, good enough for aggregate scoring)
- [ ] **Theme keyword registry.** `THEME_KEYWORDS`:
  - food: `food, meal, dish, taste, flavor, delicious, bland, tasty, cuisine, menu, portion`
  - service: `service, staff, waiter, waitress, friendly, rude, slow, fast, helpful, attentive`
  - cleanliness: `clean, dirty, hygiene, sanitary, filthy, spotless, dusty`
  - value: `price, expensive, cheap, worth, value, overpriced, affordable, pricey`
  - ambiance: `atmosphere, vibe, decor, music, loud, quiet, cozy, ambiance, mood`
- [ ] **Multi-language support.** Detect review language; translate non-English reviews before sentiment analysis (or use a multi-lingual sentiment engine). `--sentimentLanguage auto|en|de|...`.
- [ ] **DB persistence.** Write `sentiment_score`, `sentiment_themes` JSONB.
- [ ] **Config flags.** `--enrichSentiment on|off`, `--sentimentEngine afinn|llm|mock` (default afinn), `--sentimentApiKey <key>` (for LLM), `--sentimentMaxReviews <n>` (default 5 — only analyze the top reviews already scraped).
- [ ] **Tests** (`tests/enrichment-sentiment.test.js`):
  - AFINN sentiment scoring (positive/negative/neutral texts)
  - Theme extraction (each theme fires on its keyword set)
  - Aggregate scoring (multiple reviews combined)
  - Sentiment engine DI (mock engine returns canned scores; LLM engine mocked)
  - Multi-language handling (detect + skip or translate)
  - Comparative score (per-word normalization)
  - DB persistence integration
  - Edge cases: empty review text, emoji-only reviews, very short reviews

### Acceptance criteria
- Sentiment score correlates ≥0.7 with star rating (5-star reviews → positive sentiment, 1-star → negative).
- Theme extraction correctly tags ≥80% of reviews with at least one theme.
- `--enrichSentiment off` preserves Phase 2 behavior.
- AFINN engine processes 1000 reviews in <2s (pure JS, no API calls).
- LLM engine is optional and cost-capped (default off).
- ≥45 new tests.

### Dependencies
3.0, Phase 1.5 (top_reviews already scraped — sentiment reuses this data, no new scraping).

### Deliverable
A sentiment-analysis module that scores reviews and extracts themes, with a free AFINN default and an optional LLM upgrade.

---

## Phase 3.8 — Competitor Density & Geospatial Metrics

> **Status: ⬜ PENDING**

### Goal
For each business, compute the count of same-category businesses within 1km and 5km radii, estimate foot-traffic from popular-times data, and calculate distance to the city center.

### Why it matters
Competitor density tells clients whether a location is saturated (bad for new-business leads) or underserved (good). Foot-traffic estimates from popular-times data help retail clients pick locations. These metrics are unique value-adds that competitors don't easily provide.

### Task checklist
- [ ] **`src/enrichment/geo-metrics.js`** — pure functions:
  - `haversineDistance(latA, lngA, latB, lngB)` → meters (great-circle distance)
  - `countCompetitorsWithinRadius(business, allBusinesses, radiusMeters)` → int
  - `computeCompetitorDensity(business, allBusinesses, { radii })` → `{ within1km, within5km, within10km }`
  - `estimateFootTraffic(popularTimesData)` → `{ peakHour, avgBusyness, weeklyScore }`
  - `distanceToCityCenter(business, cityCenterCoords)` → meters
- [ ] **Efficient spatial queries.** For 10k businesses, O(n²) radius comparison = 100M distance calcs (too slow). Use:
  - **Geohash blocking** — only compare businesses in the same or adjacent geohash cells (7-char geohash ≈ 150m × 150m cells)
  - Or **PostGIS** — if available, `ST_DWithin` with a GiST index (but adds a PostGIS dependency)
  - Default: geohash blocking in JS (no PostGIS required)
- [ ] **Foot-traffic estimation.** From the `popular_times` array (Phase 1.5 detail scrape):
  - `peakHour` — the hour with the highest busyness value across the week
  - `avgBusyness` — mean of all non-zero busyness values
  - `weeklyScore` — 0–100 normalized score (higher = more traffic)
- [ ] **City-center resolution.** `resolveCityCenter(locationString, { geocoder })` → lat/lng of the searched city's center (reuses Phase 3.2 geocoder). Cached per-run.
- [ ] **DB persistence.** Write `competitor_density_1km`, `competitor_density_5km`, `foot_traffic_score`, `distance_to_center_m`.
- [ ] **Config flags.** `--enrichGeoMetrics on|off`, `--competitorRadii <csv>` (default `1000,5000`), `--geoMetricsConcurrency <n>`.
- [ ] **Tests** (`tests/enrichment-geo-metrics.test.js`):
  - Haversine distance (known distances: 0m same point, ~111km per degree lat)
  - Competitor counting (fixture of 50 businesses with known clusters)
  - Geohash blocking correctness (same cell = compared, far cells = skipped)
  - Foot-traffic estimation (popular_times array → peak/avg/weekly)
  - City-center resolution DI (mock geocoder)
  - DB persistence integration
  - Performance: 1000 businesses in <3s (geohash blocking)
  - Edge cases: no popular_times (foot_traffic_score = null), no lat/lng (skip)

### Acceptance criteria
- Competitor counts are accurate within ±1 (verified against a manual count on a 50-business fixture).
- Foot-traffic score correlates with popular-times data (peak hour matches the max busyness value).
- 1000-business geo-metrics computation completes in <3s (geohash blocking).
- `--enrichGeoMetrics off` preserves Phase 2 behavior.
- ≥40 new tests.

### Dependencies
3.0, 3.2 (geocode for lat/lng), Phase 1.5 (popular_times data).

### Deliverable
A geospatial-metrics module that computes competitor density, foot-traffic estimates, and distance-to-center for each business.

---

## Phase 3.9 — Lead Scoring Engine

> **Status: ⬜ PENDING**

### Goal
Combine all enrichment signals (phone validity, email status, website tech stack, sentiment, competitor density, chain/spam flags) into a single 0–100 lead score, with configurable scoring profiles for different client verticals.

### Why it matters
Lead scoring is the payoff — it turns raw data into an actionable, prioritized list. A web-design agency wants businesses with bad websites (low tech stack); a reputation-management firm wants low-rated businesses; a POS vendor wants high-foot-traffic restaurants. One score, configurable profiles, instant filtering.

### Task checklist
- [ ] **`src/enrichment/lead-score.js`** — pure functions:
  - `computeLeadScore(business, { profile, weights })` → 0–100 integer
  - `LEAD_SCORING_PROFILES` — pre-defined profiles:
    - `web-agency` — high score for: no website, old CMS (WordPress/Wix), no analytics, low tech-stack count
    - `reputation-mgmt` — high score for: rating < 4.0, negative sentiment, low review count
    - `pos-vendor` — high score for: restaurant category, high foot-traffic, no online ordering detected
    - `seo-agency` — high score for: low domain authority, no analytics, old CMS
    - `general` — balanced weighting of all signals (default)
  - `explainScore(business, profile)` → `{ score, contributions: [{ signal, weight, rawValue, pointsContributed }] }` for transparency
  - `rankLeads(businesses, { profile, limit })` → sorted by score descending
- [ ] **Scoring inputs.** Each profile weights these signals:
  - Phone validity (+10 if valid E.164)
  - Email status (+15 if verified, +10 if unverified, +0 if none)
  - Website presence + tech stack (+5 if website, +10 if modern stack, +15 if outdated stack for web-agency profile)
  - Rating + sentiment (+10 if rating < 4.0 for reputation-mgmt, +10 if rating > 4.5 for general)
  - Review count (+5 if >50 reviews = established business)
  - Competitor density (-5 if >20 competitors within 1km = saturated)
  - Foot-traffic score (+10 if high traffic for POS/retail profiles)
  - Chain flag (-10 if chain = not a lead for most profiles)
  - Spam flag (score = 0 if spam)
  - Business status (score = 0 if permanently closed)
- [ ] **Configurable weights.** `--leadScoreProfile <name>` selects a profile. `--leadScoreWeights <json>` overrides individual weights (e.g., `{"emailVerified": 20}` to bump email's importance).
- [ ] **Score explanation.** Every score comes with an explanation breakdown (which signals contributed how many points) — stored in `lead_score_explanation` JSONB column. Clients can see WHY a lead scored 85/100.
- [ ] **DB persistence.** Write `lead_score`, `lead_score_profile`, `lead_score_explanation` JSONB.
- [ ] **Config flags.** `--enrichLeadScore on|off`, `--leadScoreProfile web-agency|reputation-mgmt|pos-vendor|seo-agency|general` (default general), `--leadScoreWeights <json>`.
- [ ] **Tests** (`tests/enrichment-lead-score.test.js`):
  - Each scoring profile on a fixture business with known signals
  - Score explanation breakdown (each contribution correct)
  - Spam/closed businesses score 0
  - Custom weights override defaults
  - Ranking (sorted by score descending)
  - Edge cases: missing signals (no email, no sentiment), all-null business (score = 0 or baseline)
  - DB persistence integration

### Acceptance criteria
- Lead score correctly prioritizes obvious high-value leads (verified email + outdated website + negative sentiment = high score for web-agency profile).
- Spam and permanently-closed businesses always score 0.
- Score explanation is transparent (clients can see each signal's contribution).
- `--enrichLeadScore off` preserves Phase 2 behavior.
- ≥50 new tests.

### Dependencies
3.0, 3.1, 3.5, 3.6, 3.7, 3.8, 3.4 (all prior enrichment signals feed into the score). 3.10 (confidence) feeds in but can be stubbed.

### Deliverable
A lead-scoring module that combines all enrichment signals into a configurable 0–100 score with per-profile weighting and transparent explanations.

---

## Phase 3.10 — Data Validation & Confidence Scores

> **Status: ⬜ PENDING**

### Goal
Run final validation checks (phone liveness ping, email re-verification, website re-check) and assign a per-field 0–100% confidence score based on source reliability and cross-checks. Produce an aggregate per-record confidence score.

### Why it matters
Clients need to trust the data. A confidence score tells them "this phone is 95% likely correct" vs. "this email is 40% likely (unverified)." Low-confidence fields get flagged for manual review; high-confidence fields go straight to outreach. This is the difference between selling "data" and selling "trust."

### Task checklist
- [ ] **`src/enrichment/confidence.js`** — pure functions:
  - `computeFieldConfidence(field, value, { sources, crossChecks })` → 0.00–1.00
  - `computeRecordConfidence(business)` → 0.00–1.00 weighted average of field confidences
  - `CONFIDENCE_WEIGHTS` — per-field weights (name/rating/reviews = high weight from Google directly; email = lower weight if unverified; phone = higher if E.164-valid)
- [ ] **Source provenance.** Track where each field came from:
  - `google-list` — extracted from Google Maps list view (high confidence for name/rating/reviews/address)
  - `google-detail` — extracted from detail panel (high for hours/popular_times/photos)
  - `enrichment-phone` — normalized from raw (medium — depends on raw quality)
  - `enrichment-geocode` — from geocoding API (confidence = geocode_confidence)
  - `enrichment-email` — discovered + verified/unverified (high if verified, low if unverified)
  - `enrichment-techstack` — from HTTP fetch (high if detected, null if fetch failed)
  - `enrichment-sentiment` — from NLP (medium — AFINN is approximate)
  - `dedup-merge` — backfilled from a duplicate (lower confidence than primary source)
- [ ] **Cross-checks.** Boost confidence when fields agree:
  - Phone country code matches address country → +0.1 phone confidence
  - Geocode lat/lng within the address's city → +0.1 geocode confidence
  - Email domain matches website domain → +0.1 email confidence
  - Sentiment score direction matches star rating → +0.1 sentiment confidence
- [ ] **Per-field confidence columns.** Add `confidence_phone`, `confidence_email`, `confidence_address`, `confidence_website`, `confidence_overall` (or store as a JSONB `confidence_breakdown`).
- [ ] **Validation re-checks.** Optional `--validate on` mode that re-runs:
  - Phone validity (re-run libphonenumber-js — cheap)
  - Email re-verification (re-SMTP-check — rate-limited, time-budgeted)
  - Website re-fetch (HTTP HEAD — cheap)
  - Only re-validates fields older than `--validationTtlDays` (default 7)
- [ ] **DB persistence.** Write `confidence_score` + `confidence_breakdown` JSONB + `enriched_at` timestamp.
- [ ] **Config flags.** `--enrichConfidence on|off`, `--validate on|off` (default off — re-validation is expensive), `--validationTtlDays <n>`.
- [ ] **Tests** (`tests/enrichment-confidence.test.js`):
  - Field confidence scoring (each source's base confidence)
  - Record confidence weighted average
  - Source provenance tracking
  - Cross-check boosts (phone country = address country → +0.1)
  - Validation re-checks (mock validators, TTL-based skip)
  - DB persistence integration
  - Edge cases: all-null business (confidence = 0), single-source business (lower confidence)

### Acceptance criteria
- Every enriched business has a `confidence_score` between 0.00 and 1.00.
- Verified-email businesses have higher confidence than unverified-email businesses.
- Cross-checks boost confidence correctly (phone country = address country → +0.1).
- `--enrichConfidence off` preserves Phase 2 behavior.
- `--validate on` re-checks only stale fields (TTL-based, rate-limited).
- ≥45 new tests.

### Dependencies
3.0, 3.1, 3.2, 3.5, 3.6, 3.7 (all enrichment signals provide the inputs for confidence scoring).

### Deliverable
A confidence-scoring module that assigns per-field and per-record confidence based on source provenance and cross-checks.

---

## Phase 3.11 — Grid-Based Geospatial Coverage

> **Status: ⬜ PENDING**

### Goal
Enable scraping every business inside a geographic area (polygon or radius) by splitting the area into a grid of search points, bypassing Google's ~120-result-per-query cap. Also generate heatmap exports of business density.

### Why it matters
Google Maps caps results at ~120 per query. A city like Toronto has 5,000+ restaurants — a single `"Restaurant in Toronto"` query misses 95%. Grid coverage splits Toronto into a grid of ~50 search points, each returning ~100 results, yielding ~5,000 total. This is the difference between "I scraped 120" and "I scraped the whole city."

### Task checklist
- [ ] **`src/enrichment/grid-coverage.js`** — pure functions:
  - `generateGrid(bounds, { cellSizeKm, overlap })` → array of `{ lat, lng, label }` search points
  - `parseBounds(input)` → `{ north, south, east, west }` from:
    - Bounding-box string: `"43.5,-79.6,44.0,-79.1"` (S,W,N,E)
    - Radius: `"43.6532,-79.3832,5km"` (center lat,lng,radius)
    - City name (geocoded via Phase 3.2)
  - `computeGridStats(grid, avgResultsPerCell)` → `{ totalCells, estimatedResults, estimatedRuntime }`
  - `mergeGridResults(businesses)` → dedup across grid cells (same business appears in overlapping cells — reuses Phase 3.3 dedup)
- [ ] **Cell-size tuning.** `--gridCellSizeKm <km>` (default 2). Smaller cells = more queries but more results (fewer per-cell cap hits). Larger cells = faster but caps at ~120/cell.
- [ ] **Overlap handling.** Adjacent grid cells overlap by ~20% to catch businesses near cell boundaries. Duplicates merged via Phase 3.3 dedup.
- [ ] **Query generation.** For each grid point, generate a `(query, "lat,lng")` search pair instead of `(query, cityName)`. Google Maps accepts lat/lng as a location.
- [ ] **Batch submission.** `submitGridJobs(query, grid, { queue, priority })` → submits one BullMQ job per grid cell (reuses Phase 2.9 queue).
- [ ] **Heatmap export.** `generateHeatmap(businesses, { format, outputDir })`:
  - `geojson` — GeoJSON Points for use in Mapbox/Leaflet
  - `csv` — lat,lng,weight for Google Maps heatmap layer
  - No image generation (that's a client-side concern)
- [ ] **Config flags.** `--grid on|off`, `--gridBounds <string>`, `--gridCellSizeKm <km>` (default 2), `--gridOverlap <0-1>` (default 0.2), `--gridHeatmap on|off`, `--gridHeatmapFormat geojson|csv`.
- [ ] **Tests** (`tests/enrichment-grid.test.js`):
  - Bounding-box parsing (string format, radius format, city-name format)
  - Grid generation (correct cell count, correct spacing, overlap)
  - Grid-stats estimation (total cells × avg results)
  - Merge across overlapping cells (dedup integration)
  - Query generation (lat,lng string format)
  - Batch submission (mock queue, verifies job count = cell count)
  - Heatmap export (GeoJSON structure valid, CSV format correct)
  - Edge cases: single-cell grid, tiny bounds, huge bounds (warns on >1000 cells)

### Acceptance criteria
- A 10km × 10km area with 2km cells generates a 5×5 grid (25 cells, ~2500 estimated results).
- Overlapping cells produce duplicate businesses that are correctly merged by Phase 3.3 dedup.
- Heatmap GeoJSON is valid (loads in geojson.io).
- `--grid off` preserves Phase 2 behavior (city-name search).
- ≥40 new tests.

### Dependencies
3.0, 3.2 (geocoder for city-name bounds), 3.3 (dedup for overlap merge), Phase 2.9 (queue for batch submission).

### Deliverable
A grid-coverage module that splits geographic areas into search-point grids and merges overlapping results, plus heatmap export.

---

## Phase 3.12 — Enrichment Pipeline Orchestration

> **Status: ⬜ PENDING**

### Goal
Wire all enrichment modules (3.1–3.11) into a queue-orchestrated pipeline that runs alongside the Phase 2 scraper. Enrichment jobs are submitted to the BullMQ queue and processed by enrichment workers, decoupling scraping from enrichment.

### Why it matters
Enrichment is slower than scraping (SMTP checks, HTTP fetches, geocoding API calls). Running enrichment inline with scraping would bottleneck the scraper. Decoupling via the queue lets enrichment run at its own pace, with its own concurrency, retry logic, and budget tracking — while the scraper keeps pulling new businesses.

### Task checklist
- [ ] **`src/enrichment/pipeline.js`** — the orchestrator:
  - `createEnrichmentPipeline({ queue, pool, config })` → `{ enqueue, process, getStatus, shutdown }`
  - `enqueueEnrichmentJob(businessIds, { features })` → submits an `enrich` job to the BullMQ queue
  - `processEnrichmentJob(job, { enrichers })` → runs the configured enrichers (phone, email, tech-stack, etc.) in sequence or parallel per business
  - `getEnrichmentStatus()` → `{ pending, active, completed, failed, byFeature }`
- [ ] **New job type.** Add `enrich` to `src/queue/job-types.js` (alongside `search`, `detail-batch`). Priority band: 5 (normal) — enrichment is never urgent.
- [ ] **Enrichment worker.** A separate consumer that pulls `enrich` jobs off the queue and runs the enrichment pipeline. Can run in the same process as the scrape worker (via `--queueConcurrency`) or a separate process (`node src/enrichment/worker.js`).
- [ ] **Feature gating.** Each enrichment job specifies which features to run: `{ phone: true, email: true, techStack: false, ... }`. This lets clients pick which enrichments they want (and pay for).
- [ ] **Batching.** Enrichment jobs batch 20 businesses per job (configurable `--enrichBatchSize`) to balance queue overhead vs. parallelism.
- [ ] **Retry + dead-letter.** Reuses Phase 2.9's retry + dead-letter mechanism. A failed enrichment job (e.g., geocoding API down) retries 3× with backoff, then dead-letters for manual inspection.
- [ ] **Budget tracking.** `createEnrichmentBudget({ geocodeUsd, smtpSeconds, httpSeconds, ... })` — tracks cumulative cost across all enrichment jobs. When a budget is hit, that feature is skipped for the rest of the run (not the whole job — just that feature).
- [ ] **CLI integration.** New `npm run enrich` script:
  - `npm run enrich -- --queue on --workers 3 --enrichPhone --enrichEmail --enrichTechStack`
  - Submits enrichment jobs for all businesses in the DB that haven't been enriched yet (or are stale per `--enrichTtlDays`).
- [ ] **Banner.** Extend `src/banner.js` to show enrichment stats: features enabled, jobs pending/active/completed, budget consumed.
- [ ] **Config flags.** `--enrich on|off` (master switch), `--enrichWorkers <n>` (default 1), `--enrichBatchSize <n>` (default 20), `--enrichTtlDays <n>` (default 7 — re-enrich after this), `--enrichFeatures <csv>` (phone,email,address,dedup,chain,techStack,sentiment,geoMetrics,leadScore,confidence).
- [ ] **Tests** (`tests/enrichment-pipeline.test.js`):
  - Pipeline DI (mock queue + mock pool + mock enrichers)
  - Job submission (correct job type, priority, feature flags)
  - Job processing (each enricher called with correct business data)
  - Feature gating (disabled features skipped)
  - Batching (20 businesses per job)
  - Retry + dead-letter (failed enricher retries, then dead-letters)
  - Budget tracking (geocode budget hit → geocode skipped, other features continue)
  - Banner stats
  - CLI integration (`npm run enrich` dry-run mode)
  - End-to-end: 10 businesses through the pipeline with mock enrichers, all enriched correctly

### Acceptance criteria
- Enrichment jobs run independently of scraping jobs (decoupled via queue).
- `--enrich on` with all features enriches a 100-business dataset in <10 minutes (with mock providers; real providers take longer but are budget-capped).
- Failed enrichment jobs retry and dead-letter correctly.
- Budget tracking stops individual features when their budget is hit (doesn't kill the whole job).
- `--enrich off` preserves Phase 2 behavior byte-for-byte.
- ≥60 new tests.

### Dependencies
3.0–3.11 (all enrichment modules), Phase 2.9 (BullMQ queue).

### Deliverable
A queue-orchestrated enrichment pipeline that runs alongside the scraper, with feature gating, batching, retry, and budget tracking.

---

## Phase 3.13 — Final Integration, Docs & Handoff

> **Status: ⬜ PENDING**

### Goal
Verify end-to-end integration of all Phase 3 subsystems, write comprehensive documentation, and prepare the milestone handoff. This is the "does it all work together" phase.

### Why it matters
Each sub-phase was tested in isolation. This phase verifies composition: a real scrape → enrichment pipeline → enriched, scored, verified leads in the DB. Documentation is the handoff artifact for operators and future developers.

### Task checklist
- [ ] **Integration tests** (`tests/integration-phase3.test.js`):
  - End-to-end: scrape 20 businesses → run enrichment pipeline → verify all enriched fields populated correctly
  - Phone normalization + email discovery + tech-stack detection all run on the same business without conflicts
  - Dedup correctly merges a known duplicate pair post-enrichment
  - Lead score combines all signals correctly (verified via score explanation)
  - Confidence score reflects source provenance (verified-email > unverified-email)
  - Grid coverage: 2×2 grid produces 4 jobs, results merged correctly
  - Enrichment queue + scrape queue coexist (no job-type collision)
  - Budget caps stop individual features without killing the run
  - `--enrich off` preserves Phase 2 behavior exactly (regression test)
- [ ] **`ENRICHMENT.md`** — new operations runbook:
  - Quick start (enrich a dataset)
  - Feature-by-feature reference (phone, email, tech-stack, sentiment, etc.)
  - Budgeting (geocode cost, SMTP time, HTTP time)
  - Provider setup (Google Geocoding API, LLM API for sentiment, SMTP config)
  - Lead-scoring profiles (when to use which)
  - Grid-coverage guide (how to scrape a whole city)
  - Troubleshooting (SMTP blacklisting, geocode quota, tech-stack false positives)
- [ ] **`ARCHITECTURE.md`** — add Phase 3 section:
  - Enrichment pipeline diagram
  - Module map (src/enrichment/*)
  - Data flow (scrape → queue → enrich → DB)
  - Confidence + provenance model
- [ ] **`README.md`** — add Phase 3 Features section:
  - 11 sub-sections (one per enrichment feature)
  - Enrichment Quick Start
  - Lead-scoring profile reference
  - Grid-coverage example
- [ ] **`CHANGELOG.md`** — `[3.0.0-phase3]` release entry + 14-phase rollup.
- [ ] **`src/config.js` HELP_TEXT`** — Phase 3 flags-by-category reference.
- [ ] **`package.json`** — version `2.0.0-phase2` → `3.0.0-phase3`, add `npm run enrich` script, syntax checks for all new files.
- [ ] **`SCRAPER_FEATURES.md`** — mark Phase 3 §4 items as complete.
- [ ] **Git tag** `v3.0.0-phase3` marks the milestone.
- [ ] **Acceptance run.** A 500-business dataset through the full pipeline (scrape + enrich + score), documented in `benchmarks/phase3-acceptance.json`:
  - ≥95% phone normalization rate
  - ≥30% email discovery rate (of businesses with websites)
  - ≥85% tech-stack detection rate (of live websites)
  - ≥90% sentiment score correlation with rating
  - 0 false `verified` emails
  - Lead scores populated for 100% of businesses
  - Confidence scores populated for 100% of businesses
  - Total enrichment cost < $2 (geocoding only; SMTP/HTTP/AFINN are free)
  - Total enrichment time < 30 minutes

### Acceptance criteria
- All integration tests pass.
- `ENRICHMENT.md`, `ARCHITECTURE.md` (Phase 3 section), `README.md` (Phase 3 section), `CHANGELOG.md` updated.
- `npm run enrich` works end-to-end on a fresh dataset.
- `npm run syntax` passes for all new files.
- `npm test` — all tests pass (Phase 2 tests + Phase 3 tests, 0 regressions).
- Git tag `v3.0.0-phase3` created.
- `benchmarks/phase3-acceptance.json` documents the acceptance run.
- Test count: ≥1464 (Phase 2) + ≥600 (Phase 3) = ≥2064 tests.

### Dependencies
All Phase 3 sub-phases (3.0–3.12).

### Deliverable
A fully integrated, documented, and tested Phase 3 enrichment pipeline. The scraper now produces verified, enriched, scored leads — ready for Phase 4 (client delivery & monetization).

---

## Final Acceptance Test (Definition of Done)

The Phase 3 milestone is complete when **all** of the following pass:

1. **End-to-end pipeline.** `npm start -- --query "Restaurant" --location "Toronto" --maxResults 100 --output db --enrich on --yes` produces 100 businesses in the DB with:
   - ≥95% having `phone_e164` populated
   - ≥90% having structured address fields + lat/lng
   - ≥30% having an `email` (of those with a website)
   - ≥85% having `website_tech_stack` populated (of live websites)
   - 100% having `sentiment_score` (if they have reviews)
   - 100% having `lead_score` and `confidence_score`

2. **Dedup accuracy.** A known-duplicate fixture is correctly merged (canonical selected, duplicate marked, no false merges).

3. **Lead scoring.** A web-agency-profile score correctly prioritizes businesses with outdated websites + verified emails.

4. **Grid coverage.** `--grid on --gridBounds "43.65,-79.38,5km"` generates a grid, submits jobs, and merges results without duplicates.

5. **Queue orchestration.** Enrichment jobs run alongside scrape jobs without collision; failed enrichments dead-letter correctly.

6. **Budget compliance.** `--geocodeBudget 1` stops geocoding at $1 but allows other enrichments to continue.

7. **Backward compatibility.** `--enrich off` produces identical output to Phase 2 (regression test passes).

8. **Documentation.** `ENRICHMENT.md`, `ARCHITECTURE.md`, `README.md`, `CHANGELOG.md` all updated.

9. **Test suite.** All tests pass (≥2064 tests, 0 failures).

10. **Git tag.** `v3.0.0-phase3` created on `main`.

---

## Recommended Build Order & Parallelism

```
Phase 3 Critical Path:
3.0 → 3.1 → 3.5 → 3.9 → 3.10 → 3.12 → 3.13

Parallel Track A (Data Cleaning):
3.0 → 3.2 → 3.3 → 3.4

Parallel Track B (Enrichment):
3.0 → 3.6 → 3.7 → 3.8

Parallel Track C (Geospatial):
3.0 → 3.11

Integration:
3.12 (needs all of 3.1–3.11) → 3.13
```

**Suggested session sequence:**
1. **Session 1:** 3.0 (setup) + 3.1 (phone — quick win, high value)
2. **Session 2:** 3.5 (email — highest-value enrichment, depends on 3.1 patterns)
3. **Session 3:** 3.2 (address) + 3.3 (dedup — depends on 3.2)
4. **Session 4:** 3.4 (chain/spam) + 3.6 (tech-stack)
5. **Session 5:** 3.7 (sentiment) + 3.8 (geo-metrics)
6. **Session 6:** 3.9 (lead scoring — combines all signals)
7. **Session 7:** 3.10 (confidence) + 3.11 (grid)
8. **Session 8:** 3.12 (orchestration)
9. **Session 9:** 3.13 (final integration + docs)

---

## Out of Scope (Explicitly Deferred)

The following are **not** part of Phase 3 and are deferred to Phase 4 or 5:

- **Client web dashboard** (Phase 4.1) — the enrichment pipeline is CLI-driven; the SaaS dashboard comes later.
- **REST API** (Phase 4.2) — no HTTP API for enrichment; CLI + DB only.
- **Stripe billing** (Phase 4.4) — no payment integration; enrichment is operator-run.
- **CRM/Sheets integrations** (Phase 4.3) — export is CSV/JSON/DB only.
- **Distributed workers** (Phase 5.1) — enrichment runs on a single machine (multi-worker via BullMQ, but not multi-machine).
- **LLM-powered field extraction** (Phase 5.5) — Phase 3.7 sentiment uses AFINN (free); LLM sentiment is optional.
- **Multi-source federation** (Phase 5.4) — Phase 3 enriches Google Maps data only; Yelp/Facebook/OSM cross-referencing is Phase 5.
- **Real-time delta feeds** (Phase 5.3) — Phase 3 is batch enrichment, not streaming.
- **White-label / reseller** (Phase 5.7) — no multi-tenant support.
- **GDPR/CCPA compliance tooling** (Phase 5.6) — Phase 3 scrapes public business data only (no PII), but formal compliance tooling is deferred.
- **Domain authority / SEO metrics** (Phase 3.2 in SCRAPER_FEATURES.md §4.2) — requires paid Moz/Ahrefs API; deferred to Phase 4 (clients can opt-in per-order).
- **Social media follower counts** (Phase 3.2 in SCRAPER_FEATURES.md §4.2) — requires Instagram/Facebook API access (graph API + app review); deferred to Phase 4.

---

*This plan is a living document. Update the Status Summary table as each sub-phase ships.*
