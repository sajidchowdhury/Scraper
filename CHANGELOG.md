# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Phase 1 is tagged `v1.0.0-phase1` — the `-phase1` suffix marks the milestone
(Phase 1 of the master roadmap in `SCRAPER_FEATURES.md`).

---

## [Unreleased]

Phase 3 work (phone/email normalization & validation, email discovery, deduplication
& fuzzy matching, lead scoring, grid-based geo-coverage) — not yet started. See
`SCRAPER_FEATURES.md` for the master roadmap and `PHASE2_EXECUTION_PLAN.md`
"Out of Scope" for the full deferred-features list.

---

## [3.0.0-phase3] — 2026-08-08

The Phase 3 milestone: a Node.js enrichment pipeline that turns raw Google Maps
scrape results into verified, normalized, deduplicated, enriched, scored leads.
Fourteen sub-phases (3.0–3.13) shipped, spanning data cleaning (phone/address
normalization, fuzzy dedup, chain & spam detection), enrichment (email discovery
+ SMTP verify, website tech-stack + liveness, review sentiment, competitor
density), scoring (composite lead score 0–100 with a hard spam cap, 18-factor
record confidence), and orchestration (a queue-friendly batch pipeline that
chains all 11 per-business phases + grid-based geospatial coverage for search
strategy). Opt-in via `--enrich on`; fully offline by default (no HTTP/DNS/SMTP
issued unless explicitly enabled). Tagged `v3.0.0-phase3`.

### Added

- **3.0 — Audit, schema extension & dependencies.** Enrichment schema
  (`src/db/migrations/003-enrichment.sql`: 22 new `businesses` columns + a
  `business_duplicates` table + 7 indexes + an optional PostGIS GiST point
  index that is gracefully skipped when PostGIS is absent), 12 enrichment
  module stubs + `src/enrichment/index.js` barrel (single source of truth for
  the aggregated `ENRICHMENT_COLUMNS` + `ENRICHMENT_VERSION`), 6 dependencies
  (`libphonenumber-js`, `fuse.js`, `nodemailer`, `wappalyzer-core`,
  `sentiment`, `@turf/turf`), `cfg.enrichment` config flags +
  `featureOn()`/`toFloatOrNull()` helpers, `scripts/phase3-baseline.js` +
  `benchmarks/phase2-baseline.json` baseline-metrics framework, `runMigration`
  extended to apply `migrations/*.sql` after `schema.sql`.
- **3.1 — Phone number normalization & validation.** E.164 normalization
  (`libphonenumber-js/max`), 6-value type taxonomy
  (mobile/landline/toll_free/voip/invalid/unknown), country-code resolution,
  extension handling, non-Latin digit transliteration
  (Arabic-Indic/Persian/Devanagari/Bengali), `normalizePhonesBatch` wired
  into the post-scrape pipeline. 104 net-new tests. Persists `phone_e164`,
  `phone_type`, `phone_country_code`.
- **3.2 — Address parsing & geocoding.** Heuristic address parsing for 15+
  countries (US/CA comma, DE/AT street-number-first, GB, JP block-system,
  FR/IT/ES, NL/AU/MX/BR/IN/BD), postal-code extraction for 40+ countries,
  country normalization (60+ aliases + ISO3→ISO2), `createGeocoder` DI
  factory (google/nominatim/mock providers), 7-band geocode confidence
  (EXACT/ROOFTOP/INTERPOLATED/CENTER/APPROXIMATE/CENTROID/NONE + postal/city
  boosts), batch geocoding with rate limiting + budget guard. 114 net-new
  tests. Persists `address_street`, `address_city`, `address_state`,
  `address_postal`, `address_country`, `lat`, `lng`, `geocode_confidence`.
- **3.3 — Deduplication & fuzzy matching.** `normalizeBusinessName`,
  `computeSimilarity` (weighted: name Fuse.js 0.5 + phone E.164 0.3 + address
  proximity 0.2), 3-strategy blocking (name-prefix + phone + geocode-cell)
  for near-linear performance, `findDuplicates` with union-find cluster
  detection, `mergeCluster` with field backfill + source provenance,
  `pickCanonical` by completeness score, idempotent `business_duplicates`
  persistence (`ON CONFLICT` upsert, `GREATEST` score). 95 net-new tests.
- **3.4 — Chain detection & spam/fake-listing detection.** 11-brand chain
  catalogue (McDonald's, Starbucks, Subway, …) with token + alias matching;
  11-heuristic spam engine (keyword stuffing, AAA prefix, PO box, phone-area
  mismatch, phone-reuse with geo-cohesion dedup, suspicious rating, generic
  name, suspicious TLD, no-website-service, category mismatch, network
  pattern); 0–100 spam score + risk level (clean/low/medium/high/critical);
  batch wrappers with phone-reuse map. Integration test: AAA Locksmith →
  spam 99/critical → lead capped at 34/F/disqualify.
- **3.5 — Email discovery & verification.** `extractDomain` (URL parsing,
  www-strip, FQDN root-dot handling), `discoverEmails` (10 common local-parts
  × domain), `discoverEmailsFromHtml` (mailto: + plain-address regex scan),
  `verifyEmail` (`dns.resolveMx` MX lookup + `net.createConnection` SMTP
  EHLO/MAIL FROM/RCPT TO probe with 5s timeout, 250→verified/550→invalid/
  else→unverified), `verifyEmailSafe` (never-throws wrapper),
  `enrichEmailsBatch` (concurrency-3 worker pool, opt-in verify). DI seams
  `_loadDns`/`_loadNet` for offline tests. Default: discover only,
  `email_status='unverified'`. Persists `email`, `email_status`.
- **3.6 — Website tech-stack detection.** `fetchWebsite` (HTTP GET, 5-hop
  redirect following, 10s timeout, permissive TLS, 2MB body cap, UA header),
  27 detection rules (WordPress/Drupal/Wix/Squarespace/Webflow/Joomla/AEM
  CMS, Next.js framework, React/Vue/Angular/jQuery/Bootstrap/Tailwind
  frontend, Shopify/WooCommerce/Magento/Salesforce commerce,
  Vercel/Cloudflare/Akamai/Nginx/Apache hosting·CDN·server,
  GA/GTM/Adobe/Facebook marketing), 0–100 sophistication score,
  `checkWebsiteLiveness` (HEAD with 405/501→GET fallback),
  `detectTechStackBatch` (concurrency-3, opt-in fetch). DI seam `_loadHttp`
  for offline tests. Persists `website_tech_stack` (JSONB),
  `website_status_code`, `website_liveness`.
- **3.7 — Review sentiment analysis.** AFINN sentiment via the `sentiment` npm
  package (DI-seamed `_loadSentiment`), 8-aspect keyword lexicon
  (food/service/price/cleanliness/atmosphere/wait/value/location) with phrase
  matching + tanh-squashed polarity, anomaly detection
  (`rating_review_mismatch`[_high], `extreme_rating_low_volume`,
  `uniformly_perfect_reviews`, `no_reviews`), `volumeConfidence`
  (low/medium/high/very_high by review count), `expectedFromRating`
  ((rating-3)/2), `ratingConsistency`
  (consistent/mismatch/severe_mismatch/unknown), `analyzeReviewsBatch`.
  Integration test: Rosenthal Deli reviews → very_positive. Persists
  `sentiment_score` (-5..+5 NUMERIC(4,2)), `sentiment_themes` (JSONB).
- **3.8 — Competitor density & geospatial metrics.** `haversineKm`/
  `haversineM` (pure math), `getCoord` (prefers geocoded lat/lng, falls back
  to raw `latitude`/`longitude`), `competitorDensity` +
  `competitorDensitySameCategory`, `computeGeoMetrics` (`nearestNeighborM`,
  `within500m`/`1km`/`5km`, `sameCategoryWithin1km`, `nearestChain`,
  `isolation`=dense/moderate/sparse/isolated,
  `areaType`=urban/suburban/rural, `coverageRadiusM` by category,
  `inCluster`, 6 flags), `computeGeoMetricsBatch`. O(n²) haversine —
  PostGIS `ST_DWithin` fallback documented for 10k+ batches. Persists
  `competitor_density_1km`, `competitor_density_5km`.
- **3.9 — Lead scoring engine.** 7-signal composite (legitimacy, reputation,
  data_quality, digital_maturity, establishment, uniqueness, geo), 4
  `SCORING_PROFILES` (default/web-agency/reputation-mgmt/seo-agency, weights
  sum to 1.0), grade A–F, tier (priority/qualified/nurture/monitor/
  disqualify), **hard spam cap at 34** when `spamScore ≥ 65` (`spamCapped`
  flag), `topStrengths`/`topRisks`, one-line recommendation,
  `scoreLeadsBatch`. Integration test: Rosenthal→89/A/priority, AAA
  Locksmith→34/F/disqualify (`spamCapped`), McDonald's→82/B/qualified.
  Persists `lead_score` (INTEGER 0–100), `lead_score_profile`.
- **3.10 — Data validation & confidence scores.** `fieldConfidence`
  (per-field 0–1 weights: name 0.95, phone 0.9/0.5/0.3, address
  0.9/0.6/0.3, website 0.85/0.5/0.4/0.2, …), `recordConfidence` (0–1
  composite), `computeConfidence` (0–100, 18 factors: `HAS_PHONE`/
  `HAS_VALID_PHONE`/`HAS_WEBSITE`/`HAS_LIVE_WEBSITE`/`HAS_GEOCODE`/
  `HAS_REVIEWS`/`HIGH_REVIEW_VOLUME`/`HAS_SENTIMENT`/`HAS_TECH_STACK` +
  negatives `MISSING_*`/`INVALID_PHONE`/`SPAM_FLAGGED`/
  `LOW_REVIEW_VOLUME`/`RATING_REVIEW_MISMATCH`), band
  (very_low/low/medium/high/very_high), `missingFields[]`,
  `signalCoverage` (0–1 fraction of 8 signals), `computeConfidenceBatch`.
  Stored as 0.00–1.00 NUMERIC(4,2). Persists `confidence_score`.
- **3.11 — Grid-based geospatial coverage.** `kmToLatDegrees`/
  `kmToLngDegrees` (longitude compression at latitude), `generateGrid` (bbox
  coverage at `stepKm`, `MAX_GRID_POINTS=10000` safety cap, boundary
  inclusion), `pointInPolygon` (PNPOLY ray-casting, open/closed polygons),
  `bboxFromCenter`, `gridSearchPoints` (center+radius / bbox / polygon
  region specs, emits `{lat,lng,query,label}` for the scraper search loop),
  `estimateCoverage` (90th-percentile NN distance → `coverageRatio`
  operator signal), `haversineKm` (self-contained). Pure geometry, no
  network — drives search strategy, not `businesses` columns.
- **3.12 — Enrichment pipeline orchestration.** `enrichBatch` chains all 11
  per-business phases in dependency order (phone→address→dedup→chain/spam→
  email→tech-stack→sentiment→geo→lead→confidence), per-phase `try/catch`
  error isolation, `attachDedupResults` (builds `dedup_result` from clusters
  for downstream phases), opt-in network flags (`geocode`/`emailVerify`/
  `techStackFetch` — default fully offline), `enriched_at` +
  `enrichment_version` stamping, run summary with per-phase stats +
  `costUsd`, `enrichBusiness` single-record convenience wrapper.
  Integration test: 3 sample businesses → all phases pass, spam cap works,
  confidence distinct from lead score.
- **3.13 — Final integration, docs & handoff.** `tests/integration-phase3.test.js`
  acceptance suite (end-to-end composition wiring every real enrichment
  module through DI seams — mock DNS/SMTP/HTTP/geocoders, mock `pg` client
  recognizing the exact SQL shapes `db.js` emits, in-memory dedup clusters,
  spam-cap enforcement, confidence-vs-lead-score independence, opt-in
  network-phase gating). `ENRICHMENT.md` operator runbook (prerequisites,
  CLI flag reference, opt-in network phases, cost-budget guidance,
  troubleshooting). `ARCHITECTURE.md` + `README.md` Phase 3 sections.
  `npm run enrich` script. Git tag `v3.0.0-phase3`.
- **Persisted columns — the `ENRICHMENT_COLUMNS` aggregate exported by
  `src/enrichment/index.js` (mirrored by `migrations/003-enrichment.sql` and
  excluded from `data_hash`/change-tracking so re-enrichment is a no-op for
  snapshots + `field_changes`):** `phone_e164`, `phone_type`,
  `phone_country_code`, `address_street`, `address_city`, `address_state`,
  `address_postal`, `address_country`, `lat`, `lng`, `geocode_confidence`,
  `email`, `email_status`, `website_tech_stack`, `website_status_code`,
  `website_liveness`, `sentiment_score`, `sentiment_themes`,
  `competitor_density_1km`, `competitor_density_5km`, `lead_score`,
  `lead_score_profile`, `confidence_score`, `enriched_at`,
  `enrichment_version` — plus the `business_duplicates` table (cluster id,
  canonical `place_id`, member `place_id`s, similarity score, `detected_at`,
  `run_id`).
- **New CLI flags** in `src/config.js`:
  - `--enrich on|off` — master switch (default `off`).
  - `--enrichPhone` / `--enrichAddress` / `--enrichDedup` / `--enrichEmail` /
    `--enrichTechStack` / `--enrichSentiment` / `--enrichGeo` /
    `--enrichLeadScore` / `--enrichConfidence` `on|off` — per-phase toggles
    (all default `on` when `--enrich on`).
  - `--enrichBudget <usd>` — USD cap on API-cost features (0 = unlimited).
  - `--enrichConcurrency N` — parallel enrichment workers (default 4).
  - `--geocoder google|nominatim|mock` — geocoding provider.
  - `--geocodeApiKey <key>` — Google Geocoding API key.
  - `--geocodeRateLimitMs <ms>` — per-request geocoding throttle.
  - `--geocodeBudget <usd>` — USD cap on geocoding spend.
  - `--dedupThreshold 0..1` — fuzzy-match cutoff (default 0.85).
  - `--phoneDefaultCountry <ISO>` — default region for local-format phones.
  - `--leadProfile default|web-agency|reputation-mgmt|seo-agency` — scoring
    weights.
  - `--grid` / `--gridBounds` — grid-based search-strategy controls
    (Phase 3.11).

### Changed

- `package.json` — version `2.0.0-phase2` → `3.0.0-phase3`; added
  `npm run enrich` script (runs the standalone enrichment CLI over a prior
  scrape's JSON/DB output); `npm run syntax` expanded to cover all 13
  enrichment files (`src/enrichment/*.js`) + `scripts/phase3-baseline.js`.
- `src/config.js` `HELP_TEXT` — new "Phase 3 flags by category" quick
  reference (Enrichment master + per-phase toggles, Geocoding, Dedup,
  Scoring, Grid) + a "Phase 3 Quick Start" example block.
- Git tag `v3.0.0-phase3` marks the Phase 3 milestone.

### Fixed

- **Pre-existing `src/enrichment/dedup.js` `ENRICHMENT_COLUMNS` export bug**
  (surfaced and fixed in 3.12): `dedup.js` was not exporting its
  `ENRICHMENT_COLUMNS` constant, which blocked the `src/enrichment/index.js`
  barrel from loading (`...dedup.ENRICHMENT_COLUMNS` → `TypeError: Cannot
  read properties of undefined` / "not iterable"). The fix exports
  `ENRICHMENT_COLUMNS = []` — dedup contributes no `businesses` columns (its
  output is the separate `business_duplicates` table) — so the barrel loads
  cleanly and the rest of the pipeline can aggregate the column list.

### Tests

- Phase 3 adds unit tests for all 8 ported modules beyond 3.1–3.3:
  `tests/enrichment-chain-detection.test.js`,
  `tests/enrichment-email.test.js`,
  `tests/enrichment-tech-stack.test.js`,
  `tests/enrichment-sentiment.test.js`,
  `tests/enrichment-geo-metrics.test.js`,
  `tests/enrichment-lead-score.test.js`,
  `tests/enrichment-confidence.test.js`,
  `tests/enrichment-grid-coverage.test.js`.
- `tests/integration-phase3.test.js` — the Phase 3.13 end-to-end acceptance
  suite, wiring every real enrichment module together through DI seams (mock
  DNS/SMTP/HTTP/geocoders, mock `pg` client recognizing the exact SQL shapes
  `db.js` emits) and verifying cross-phase composition: phone + address +
  dedup → chain/spam → email → tech-stack → sentiment → geo → lead →
  confidence; spam-cap enforcement at score 34; confidence independent of
  lead score; opt-in network-phase gating (default fully offline).
- **Total test count:** Phase 3 adds 313+ net-new tests across the 11
  enrichment modules (phone 104 + address 114 + dedup 95 + chain/email/
  tech-stack/sentiment/geo/lead/confidence/grid integration-verified) on top
  of the Phase 2 baseline of 1464 tests / ~8500 assertions. The automated
  `tests/integration-phase3.test.js` suite is the verified composition proxy;
  the operator-run acceptance gate is documented in
  `benchmarks/phase3-acceptance.json` (schema + thresholds + how-to-populate,
  marked `status: PENDING` — the actual enrichment acceptance run requires
  real geocoder/SMTP/HTTP access and must be executed by an operator,
  mirroring the Phase 2.13 `benchmarks/phase2-10k-run.json` pattern).

### Backward Compatibility

- `--enrich off` (the default) is byte-for-byte Phase 2 behavior: no
  enrichment columns are written, no network probes are issued, no
  `business_duplicates` rows are inserted, and the post-scrape pipeline
  skips `enrichBatch` entirely. The 22 enrichment columns stay NULL on
  existing rows; `migrations/003-enrichment.sql` is purely additive
  (`IF NOT EXISTS` / `DO $$ … $$` guards) and safe to apply to a Phase 2
  database.
- When `--enrich on` is set but an individual phase is disabled (e.g.
  `--enrichEmail off`), that phase's columns stay NULL — the rest of the
  pipeline degrades gracefully (each phase treats missing upstream
  descriptors as neutral).
- Enrichment columns are excluded from `data_hash` and `TRACKED_FIELDS`, so
  re-running enrichment on an unchanged scrape does not trigger
  snapshot/`field_changes` rows or bump `updated_at` — only a real scrape
  change (rating/reviews/phone/website) counts as "the business's data
  changed."

---

## [2.0.0-phase2] — 2026-08-07

The Phase 2 milestone: a robust, scalable Google Maps scraper that survives
10,000+ listings overnight unattended. Thirteen sub-phases (2.0–2.13) shipped,
spanning four parallel tracks — data (PostgreSQL + change tracking + incremental
cache), stealth (proxy + fingerprint + stealth + CAPTCHA + sessions), scale
(worker pool + job queue + memory management), and resilience (self-healing
selectors). Tagged `v2.0.0-phase2`. 1464 tests / ~8500 assertions passing.

The definitive acceptance test — a 10,000-listing overnight run with
`--workers 5 --queue on --incremental --deepScrape true --captchaProvider
2captcha --proxyStrategy random --sessionLength 50` — is codified in
`scripts/run-10k.sh` + `queries-10k.csv` + `benchmarks/phase2-10k-run.json`.
Cross-subsystem composition is verified by `tests/integration-phase2.test.js`
(24 end-to-end tests wiring every real Phase 2 module through DI seams).

### Sub-phase rollup
- **2.0 — Audit, fixtures & dependency setup.** Phase 2 baseline + Playwright/`pg`/`bullmq`/`ioredis`/`2captcha`/`proxy-chain`/`puppeteer-extra-plugin-stealth` dependencies + captured HTML fixtures.
- **2.1 — PostgreSQL persistence layer.** Idempotent upsert keyed by `place_id`, `data_hash` for no-op detection, `scrape_runs` table, `--output db|csv,json,db|all`, `npm run db:migrate`.
- **2.2 — Change tracking & history.** `business_snapshots` (old values) + `field_changes` (per-field deltas) per run, `npm run db:history` CLI, `changes_detected` count surfaced in the run banner.
- **2.3 — Proxy management & rotation.** `--proxyStrategy round-robin|random|sticky`, `--proxyListFile`, burn detection (repeated 429/403/timeout → cooldown), `--proxyHealthCheck`, `--noProxy`.
- **2.4 — Browser fingerprint randomization.** Coherent per-run fingerprint (UA, viewport, timezone, locale, WebGL vendor/renderer, canvas noise, hw concurrency), `--fingerprintProfile random|fixed|off`, `--fixedFingerprint`.
- **2.5 — Stealth hardening.** `--stealth on|off` (default on) via `playwright-extra` + stealth plugin + custom init-script patches (`navigator.webdriver`, `chrome.runtime`, `plugins.length`, `permissions.query`), `--stealthDebug`.
- **2.6 — CAPTCHA auto-solving.** `--captchaProvider 2captcha|anticaptcha|capsolver|mock|none`, `--captchaApiKey`, `--captchaBudget` (default $5 hard stop), `--captchaFallbackProvider`, `--noCaptchaSolve`; cost-log JSONL tracking.
- **2.7 — Session & cookie rotation.** `--sessionMaxRequests` (default 50) + `--sessionMaxAgeMs` (default 10min) context rotation, `--warmup` (benign-page visits), `--accountWarmup` (opt-in Google login), `--accountsFile`.
- **2.8 — Worker pool & concurrency.** `--workers N` parallel browsers, round-robin/least-busy load balancing, block cooldown + identity rotation, crash-limit retirement, task re-queue, `--workerCrashLimit`, `--workerCooldownMs`, `--workerTaskRetries`.
- **2.9 — Job queue & orchestration.** `--queue on` BullMQ adapter (Redis-backed) with DI mock backend, `--redisUrl`, `--queuePriority`, `--queueAttempts`, `--queueConcurrency`, dead-letter helper, `npm run batch` + `npm run queue:status`.
- **2.10 — Memory management & long-run stability.** `--maxHeapMb` (per-worker) + `--maxRssMb` (process) thresholds, memory monitor + worker probe + zombie reaper + graceful degradation, `--endless` mode, `--healthPort` HTTP `/health` endpoint, `--contextRestartEvery`.
- **2.11 — Self-healing selectors & health checks.** Startup health check (exit code 3 on <50% core-field extraction), first-batch abort (`checkExtractionRatesForAbort`), `--autoDiscover` heuristic field discovery, `--selectorDebugDump`, `--maxSelectorAge`, selector versioning in `src/selectors/version.js`.
- **2.12 — Incremental scraping & detail caching.** `--incremental` (requires `--output db`), run-level preflight skip (skip browser when fresh within `--listFreshnessDays`), per-business detail cache (`--detailCacheTtlDays` default 7d), list-view-only `change_hash` (distinct from `data_hash`), review-delta refresh (`--detailRefreshOnReviewDelta`), `--noDetailCache`, `--swrr` (stub).
- **2.13 — Final integration, docs & handoff.** `tests/integration-phase2.test.js` (24 end-to-end tests), `scripts/run-10k.sh` + `queries-10k.csv` + `benchmarks/phase2-10k-run.json`, `ARCHITECTURE.md` (new), `OPERATIONS.md` (new), `SELECTORS.md` self-healing section, README Phase 2 Features + 10k Quick Start + Troubleshooting, CLI help category reference + 10k quick-start, version `2.0.0-phase2`, git tag `v2.0.0-phase2`.

Detailed changelog entries for 2.1, 2.2, 2.3, 2.8, 2.9 appear below (unchanged from
their original sub-phase releases). 2.4–2.7, 2.10–2.13 are summarized above and
documented in full in `worklog.md` + `PHASE2_EXECUTION_PLAN.md`.

### Phase 2.13 — Final Integration, Docs & Handoff

#### Added
- **`tests/integration-phase2.test.js`** (24 tests / 117 assertions) — the Phase 2.13
  end-to-end integration test. Wires every REAL Phase 2 subsystem module together
  through DI seams (mock BullMQ backend, in-memory mock `pg` client recognizing the
  exact SQL shapes `db.js` emits, DI `runTask`/`getIdentity`) and verifies
  cross-subsystem composition: 10 jobs through a 2-worker pool + mock queue all
  complete; DB persistence (businesses + scrape_runs); change tracking
  (snapshots + field_changes on update); proxy/fingerprint/session rotation
  (≥2 distinct identities across workers); incremental cache (run-level preflight
  skip, per-business detail cache_hit, review-delta forced_refresh, list-view-only
  change_hash); self-healing (block re-queue + identity rotation, selector health
  check passes/aborts, first-batch abort throws exit 3); memory (heap stable
  across 10 jobs, graceful shutdown leaves no orphaned jobs); CAPTCHA mock ($0
  cost); queue dead-letter on permanent block. External services mocked via the
  same DI seams the unit tests use (Docker/testcontainers unavailable in this
  environment; the live 10k run is the operator-run acceptance gate).
- **`scripts/run-10k.sh`** — the definitive 10,000-listing overnight run helper.
  Prerequisite checks (docker, db:migrate, proxies, CAPTCHA key), batch-submits
  `queries-10k.csv` to the queue, runs the canonical 5-worker command with
  `--endless`, and captures the run summary to `benchmarks/phase2-10k-run.json`
  via a DB-query post-step.
- **`queries-10k.csv`** — 52 (query, location) pairs × ~200 results each ≈ 10,400
  businesses, spanning US cities for geographic diversity.
- **`benchmarks/phase2-10k-run.json`** — run-plan + results schema (config, success
  thresholds, how-to-populate). Marked `status: PENDING` — the actual overnight
  run requires real proxies + CAPTCHA budget + 8h and must be executed by an
  operator; `tests/integration-phase2.test.js` is the automated composition proxy.
- **`ARCHITECTURE.md`** (new, 591 lines) — system architecture: high-level
  pipeline diagram, module map, request lifecycle, identity stack, concurrency
  model, persistence & change tracking, incremental cache, health & self-healing,
  data-flow diagram, configuration surface, failure modes & recovery.
- **`OPERATIONS.md`** (new, 367 lines) — production operations runbook:
  prerequisites, first-time setup, running a production scrape, proxy management,
  CAPTCHA budgeting, concurrency tuning, database operations, incremental & cache
  operations, monitoring & health, common alerts & remediation, troubleshooting,
  graceful shutdown & recovery, cost management, post-run.
- **`SELECTORS.md`** — new "Self-Healing Selectors (Phase 2.11)" section with 9
  sub-sections (overview, startup health check, first-batch abort, heuristic
  auto-discovery, selector debug dump, selector versioning, recovery workflow,
  configuration reference, thresholds).
- **`README.md`** — new "Phase 2 Features" section (12 sub-sections, one per
  sub-system), "Phase 2 — 10,000-listing overnight run" Quick Start, 8 new
  Troubleshooting Q&A entries (exit code 3, proxy burn, CAPTCHA budget, worker
  retirement, heap growth, queue stall, incremental not caching, 0% detail
  success). 990 → 1310 lines.
- **`src/config.js` `HELP_TEXT`** — "Phase 2 flags by category" quick reference
  (Proxy, Stealth, Concurrency, Queue, DB, Cache, CAPTCHA, Health, Session) +
  "Phase 2 Quick Start" 10k-run example block.
- **`package.json`** — version `1.0.0-phase2.12` → `2.0.0-phase2`; added
  `npm run run-10k` script.

#### Changed
- Git tag `v2.0.0-phase2` marks the Phase 2 milestone.

**Test count:** 1464 tests / ~8500 assertions (was 1440 / 8459 at end of Phase 2.12).
24 new tests in `tests/integration-phase2.test.js`. No regressions.

---

### Phase 2.1 — PostgreSQL Persistence Layer

#### Added
- **`src/db.js`** — a thin, DI-friendly PostgreSQL persistence layer over `pg`:
  - `createPool(connectionString)` — returns a `pg.Pool` from a `postgresql://`
    URL (or null if no/invalid URL). Conservative defaults: 10s connect timeout,
    max 10 clients.
  - `getClient(pool)` / `withClient(pool, fn)` — acquire + auto-release clients.
  - `closePool(pool)` — graceful shutdown (null-safe).
  - `runMigration(poolOrClient)` — executes `src/db/schema.sql` idempotently.
  - `computeRowHash(business)` (pure) — SHA-256 of comparable field values, with
    sorted-key normalization so key-order differences in nested objects don't
    produce false "changed" signals. Empty strings normalize to null (matches
    the `toText` coercion used for DB writes).
  - `decideAction(existingHash, business)` (pure) — classifies an upsert as
    `inserted` / `updated` / `unchanged` without touching the database.
  - `upsertBusiness(client, business, {runId})` +
    `upsertBusinessesBatch(client, businesses, {runId, batchSize})` — idempotent
    upserts keyed by `place_id`. Per-batch: one `SELECT … WHERE place_id = ANY($1)`
    hash check, a multi-row `INSERT … ON CONFLICT (place_id) DO NOTHING` for new
    rows, and per-row `UPDATE` for changed rows. Default batch size 50.
  - `insertRunSummary(client, summary)` — writes a `scrape_runs` row, returns
    `runId`.
  - `persistRunResults(pool, {businesses, summary, logger})` — full pipeline
    hook: `BEGIN` → insert run summary → batch upsert businesses → stamp DB
    counts onto the run row → `COMMIT` (or `ROLLBACK` on any error).
  - All queries are parameterized (no SQL-injection surface). Every method
    accepts an explicit `client`/`pool` arg so unit tests can pass a mock client.
- **`src/db/schema.sql`** — idempotent schema (`CREATE TABLE IF NOT EXISTS`):
  - `businesses` table — all 25 scraped fields (17 canonical + 8 detail) plus
    `latitude`/`longitude` (forward-compatible, NULL until a future phase
    extracts them), `data_hash` (SHA-256 for no-op detection), `run_id` (FK →
    `scrape_runs`), `updated_at`. Indexes on `place_id`, `(query, location)`,
    `scraped_at`, `business_status`, `updated_at`.
  - `scrape_runs` table — per-run metadata: `query`, `location`, `started_at`,
    `finished_at`, `extracted`, `failed`, `exit_code`, `log_path`,
    `db_inserted`, `db_updated`, `db_unchanged`.
  - Foreign key added via a `DO $$ … $$` guard block so re-running the migration
    is always safe.
- **`src/db/migrate.js`** + `npm run db:migrate` — standalone CLI that reads
  `schema.sql` and executes it. Exit codes: 0 ok, 2 config error (no
  `DATABASE_URL`), 3 runtime error.
- **`--output csv|json|db|all` flag** in `src/config.js`:
  - `resolveOutputTargets(raw)` pure helper — parses comma-separated values,
    expands `all` → `['csv','json','db']`, de-dupes, case-insensitive.
  - Default `['csv','json']` preserves Phase 1 behavior.
  - `DATABASE_URL` env var support + `OUTPUT` env var.
  - Validation: `--output db` requires a `postgresql://` (or `postgres://`)
    `DATABASE_URL`; a missing or non-postgres URL is a config error (exit 2).
- **Pipeline integration** in `src/index.js`:
  - After extraction + dedup, if `cfg.output.includes('db')` && `!cfg.dryRun`,
    `persistRunResults` upserts every business in a single transaction.
  - End-of-run banner gains a `DB: N inserted, N updated, N unchanged (run #N)`
    line.
  - A DB persistence failure logs an error + sets exit code 1 (partial success),
    but does NOT discard already-written CSV/JSON files.
  - `--dryRun` now skips DB writes too (consistent with skipping file writes).
- **`exportResults` gains `writeCsv` option** (`src/export.js`) so `--output
  json` skips the CSV file and `--output csv` skips the JSON sidecar. Defaults
  to true (preserves existing behavior).

#### Tests
- **`tests/db.test.js`** — 65 tests / 141 assertions covering:
  - Pure functions: `computeRowHash` (determinism, key-order independence,
    change detection, null/empty-string normalization), `decideAction`
    (inserted/updated/unchanged), `columnValue` coercion.
  - SQL builders: `buildBatchInsert` (multi-row, `ON CONFLICT DO NOTHING`,
    sequential placeholders), `buildUpdate` (place_id in WHERE).
  - DI mock-client upsert cycle: insert → unchanged → updated; batched upserts
    respect `batchSize`; missing `place_id` skipped.
  - SQL-injection safety: `'; DROP TABLE businesses; --` stored literally as a
    `place_id`, never interpolated into SQL text.
  - Transaction rollback: `persistRunResults` issues `ROLLBACK` on injected
    failure; in-memory store unchanged; `COMMIT` on success.
  - `insertRunSummary`, `resolveOutputTargets`, config `--output` validation.
  - Pool + migration lifecycle.
  - Integration tests (guarded on a live postgres `DATABASE_URL`): migrate
    creates tables, full upsert cycle, re-migrate idempotency. Skipped
    automatically when no Postgres is available.
- **Total: 475 tests / 1169 assertions** (410 existing + 65 new), all passing.

#### Documentation
- `.env.example` Phase 2.1 section expanded: documents the `postgresql://`
  scheme requirement, `npm run db:migrate`, and `--output` usage.
- `PHASE2_EXECUTION_PLAN.md` — Phase 2.1 marked ✅ DONE; task checklist and
  acceptance criteria updated with verification notes.

### Phase 2.2 — Change Tracking & History

#### Added
- **`src/db/deltas.js`** — pure, side-effect-free change-tracking helpers:
  - `TRACKED_FIELDS` — the five high-value columns clients pay for trend data
    on: `rating`, `reviews_count`, `business_status`, `phone`, `website`.
  - `normalizeValue(v)` — null/undefined/`''` collapse to null; finite numbers
    kept; NaN/Infinity rejected.
  - `coerceNumber(v)` — parses numeric strings (`'4.5'` → `4.5`), rejects
    non-numeric strings / NaN / Infinity. Used by `numericDelta` so stringified
    DB values still produce a meaningful delta.
  - `valuesEqual(a, b)` — comparison after normalization; numeric string vs
    number compare equal (`4.5 === '4.5'`).
  - `numericDelta(old, new)` — `new - old` for numbers (rounded to 1 dp to
    match `NUMERIC(2,1)` precision); the new value itself when old is null
    (a business gaining its first rating); null for non-numeric / NaN / Infinity.
  - `computeChanges(oldRow, newRow, fields?)` — returns an array of
    `{ field, old, new, delta }` for each tracked field that actually changed
    (after normalization). Empty array when nothing changed or when `oldRow` is
    null (brand-new insert — no prior data to diff).
  - `summarizeChanges(changes)` — `{ total, byField }` rollup for the run banner;
    `byField` always contains every tracked field (0 when none changed).
- **`src/db/history.js`** + `npm run db:history` — CLI that prints the change
  timeline for a single business (keyed by `place_id`):
  ```
  Business:  Test Cafe (ChIJxxx)
  Current:   rating 4.3 | reviews 1289 | status open | phone +1-555-0100 | website https://example.com

  Timeline (5 change events, 2 snapshots):
    2026-08-07 14:03  rating 4.5 → 4.3  (Δ -0.2)
    2026-08-07 14:03  reviews 1234 → 1289 (Δ +55)
    2026-07-01 09:12  rating 4.6 → 4.5  (Δ -0.1)
  ```
  - Flags: `--placeId <id>` (required), `--place-id`/`-p` aliases, `--limit N`
    (default 100, most-recent-first), `--help`/`-h`. A positional connection
    string overrides `DATABASE_URL`.
  - Pure formatters (`formatValue`, `formatDelta`, `fieldLabel`,
    `formatTimestamp`, `formatChangeLine`, `formatCurrentLine`, `parseArgs`)
    are exported for unit testing.
- **Schema extension** in `src/db/schema.sql`:
  - `business_snapshots` table — pre-update snapshot of tracked fields (`id`,
    `business_id` FK, `place_id` denormalized, `rating`, `reviews_count`,
    `business_status`, `phone`, `website`, `snapshot_at`, `run_id` FK). Indexes
    on `(business_id, snapshot_at DESC)`, `place_id`, `run_id`.
  - `field_changes` table — computed, queryable per-field delta log (`id`,
    `business_id` FK, `place_id` denormalized, `field`, `old_value`, `new_value`,
    `delta`, `detected_at`, `run_id` FK). Indexes on
    `(business_id, field, detected_at DESC)`, `(place_id, detected_at DESC)`,
    `run_id`.
  - `scrape_runs.changes_detected` INTEGER column, added via an idempotent
    `DO $$ … $$` ALTER guard (safe to re-run on Phase 2.1 databases).
- **Snapshot + field_changes logic** in `src/db.js` `upsertBusinessesBatch`:
  when a business is classified `updated`, the batch path now:
  1. SELECTs the existing rows' `id` + tracked fields (1 round-trip, batched).
  2. INSERTs the OLD values into `business_snapshots` (multi-row, 1 round-trip).
  3. Computes per-field deltas (`computeChanges`) and INSERTs them into
     `field_changes` (multi-row, 1 round-trip).
  4. UPDATEs the `businesses` row (existing path).
  All four steps run inside the `persistRunResults` BEGIN/COMMIT transaction, so
  a crash mid-upsert rolls back the snapshot + changes + update atomically.
- **`buildSnapshotInsert(rows)`** + **`buildFieldChangesInsert(rows)`** — pure,
  parameterized multi-row INSERT builders (exported for unit testing). SQL-
  injection-safe: malicious values appear in `params`, never interpolated.
- **Run-summary extension** — `persistRunResults` now stamps `changes_detected`
  onto the `scrape_runs` row alongside `db_inserted/updated/unchanged`, and
  returns `{ changesDetected, changesByField, snapshotsWritten }` in its result.
- **Banner change breakdown** in `src/index.js` — the end-of-run `DB:` line now
  includes the per-field change counts when any tracked field changed:
  `DB: 50 inserted, 30 updated (12 rating changes, 8 review-count changes, 2 status changes), 20 unchanged (run #5)`.

#### Tests
- **`tests/db-deltas.test.js`** (57 tests) — pure-function coverage for
  `normalizeValue`, `coerceNumber`, `valuesEqual`, `numericDelta` (incl. null→gain,
  value→loss, string coercion, NaN, Infinity), `computeChanges` (all five tracked
  fields, null↔value, empty-string normalization, custom field list),
  `summarizeChanges`, and every `history.js` pure formatter + `parseArgs`.
- **`tests/db.test.js`** extended (65 → 84 tests):
  - Mock client now mirrors `business_snapshots` + `field_changes` in-memory
    (with transaction snapshot/restore so ROLLBACK clears them).
  - New sections: change-tracking on update (insert→no snapshots, unchanged→no
    snapshots, changed reviews_count→1 snapshot + 1 field_change, rating delta
    -0.2, status flip null delta, multi-field update, `changesByField` rollup,
    `persistRunResults` stamps `changes_detected`).
  - SQL-builder tests for `buildSnapshotInsert` / `buildFieldChangesInsert`
    (parameterization, null handling, SQL-injection safety).
  - Integration tests (guarded on `DATABASE_URL`) now drop + recreate all four
    tables and verify a real Postgres re-scrape writes snapshot + field_changes
    rows; an identical re-scrape writes neither.

#### Documentation
- `PHASE2_EXECUTION_PLAN.md` — Phase 2.2 marked ✅ DONE (3 of 13); task checklist
  and acceptance criteria updated with verification notes.
- `README.md` — Phase 2.2 section added (change tracking overview, tracked
  fields, `npm run db:history` usage, banner output example).
- `package.json` — `db:history` script added; `syntax` script now checks
  `src/db/deltas.js` + `src/db/history.js`.

**Test count:** 551 tests / 1407 assertions (was 475 / 1028).

---

### Phase 2.3 — Proxy Management & Rotation

#### Added
- **`src/proxy.js`** — a configurable proxy pool that sits between the scraper
  and Google. Every browser launch (or every N requests, via `--sessionLength`)
  pulls a different proxy from the pool. Burned proxies (3 consecutive 403/429,
  <50% success rate over last 20 requests, 3 consecutive timeouts) are benched
  for a cooldown window; permanently bad proxies (HTTP 407, provider-reported
  retired) are removed entirely.
  - `createProxyPool({ sources, strategy, sessionLength, cooldownMs, logger, now, rng, burnDetector, burnLogWriter })`
    — factory. Sources: `file` (`PROXY_LIST_FILE`), inline `list` (for tests),
    or async `provider()` (Bright Data / Smartproxy / Oxylabs — caller supplies
    the impl). All clocks and randomness are injectable for deterministic tests.
  - `pool.acquire()` — returns the next proxy `{ id, server, url, username,
    password, host, port, protocol, provider }` per the rotation strategy.
    Skips proxies in cooldown or permanently burned. Returns null when the pool
    is exhausted (caller falls back to direct or aborts).
  - `pool.release(proxyId, { success, statusCode })` — reports the outcome of
    an acquire→use cycle. The burn detector decides whether to burn based on
    the outcome history.
  - `pool.markBurned(proxyId, reason, { permanent })` — manual burn override.
  - `pool.stats()` — `{ total, healthy, cooldown, burned, avgSuccessRate,
    totalRequests, totalSuccess, strategy, sessionLength, perProxy[] }`.
  - `pool.healthCheck({ fetchFn, url, timeoutMs })` — optional pre-run probe
    that pings every proxy with a HEAD to Google; benches failures for one
    cooldown cycle. `fetchFn` is injectable so unit tests make zero real
    network calls.
  - `pool.close()` — best-effort teardown (burn log uses sync writes).
- **`src/proxy/burn-detector.js`** — pure per-proxy health tracking + burn
  decision logic. Kept separate from the pool so unit tests can exercise burn
  thresholds without spinning up a pool, and future strategies (ML-based
  anomaly detection) can be dropped in without touching the pool's
  acquire/release flow.
  - `createBurnDetector({ cooldownMs, statusWindow, rateWindow, rateThreshold,
    minRateSamples, consecutiveBlock, consecutiveTimeout, now })`
  - `detector.record(proxyId, { success, statusCode })` — mutates state, may
    transition to cooldown/burned. Returns `{ burned, kind, reason }`.
  - `detector.markPermanent/markCooldown/clear(proxyId, reason)` — manual overrides.
  - `detector.isReusable(proxyId)` — false for permanent burns and for cooldown
    burns whose window hasn't elapsed.
  - `detector.state/stats/cooldownRemainingMs/all/resetCounters(proxyId)` —
    introspection.
  - Auto-burn rules:
    - 3 consecutive 403/429 → cooldown.
    - Success rate < 50% over last 20 requests (min 5 samples) → cooldown.
    - 3 consecutive timeouts (`statusCode === 'TIMEOUT'`) → cooldown.
    - HTTP 407 (Proxy Authentication Required) → permanent (removed entirely).
  - Cooldown proxies auto-recover after `cooldownMs` (default 10 min). Permanent
    proxies never recover.
- **`src/browser.js`** — `launchBrowser(cfg, opts)` now accepts
  `opts.proxy = { server, username, password, id, provider, host, port }`.
  When present, it's passed to Playwright's `chromium.launch({ proxy })` so all
  browser traffic flows through it. When no proxy is configured, the launch is
  direct (Phase 1 behavior preserved). The "Browser launched" log line now
  records the proxy id + provider so the JSON-lines log can be cross-referenced
  with `data/proxy_burn_log.jsonl`.
- **`src/config.js`** — new CLI flags + env vars:
  - `--proxyStrategy round-robin|random|sticky` (default: random)
  - `--sessionLength N` (default: 1 = rotate every request; sticky only)
  - `--proxyCooldownMs` (default: 600000 = 10 min)
  - `--proxyListFile <path>` (or `PROXY_LIST_FILE` env)
  - `--proxyHealthCheck` (probe every proxy with a HEAD before scraping)
  - `--noProxy` (force direct connection; overrides everything)
  - Env: `PROXY_STRATEGY`, `SESSION_LENGTH`, `PROXY_COOLDOWN_MS`, `NO_PROXY`,
    `PROXY_LIST_FILE`, `PROXY_PROVIDER`, `PROXY_PROVIDER_URL`,
    `PROXY_PROVIDER_TOKEN`, `PROXY_BURN_LOG`.
  - Validation: strategy must be one of the three; sessionLength 1–10000;
    cooldownMs 0–86400000; listFile must exist if specified.
- **`src/index.js`** — pipeline wiring:
  - Constructs the proxy pool after config validation (only when
    `cfg.proxy.enabled`).
  - Optional pre-run health check (`--proxyHealthCheck`) probes every proxy
    before scraping; aborts if all fail.
  - Acquires a proxy before each `withBrowser` call; passes it through to
    `launchBrowser` via `opts.proxy`.
  - Releases the proxy in a `finally` block with the pipeline outcome:
    - Success → `{ success: true }`.
    - CAPTCHA → `{ success: false, statusCode: 429 }` (treat as block signal).
    - Other crash → `{ success: false, statusCode: 'TIMEOUT' }`.
  - The end-of-run banner now includes a `Proxy:` line with healthy/cooling/
    burned counts + strategy + avg success rate.
  - The run summary (`summary.json`) now includes `proxy: pool.stats()`.
- **`src/banner.js`** — startup banner now shows a `Proxy` row: strategy +
  session length + cooldown when enabled, or "disabled (direct)" otherwise.
- **`data/proxy_burn_log.jsonl`** — append-only JSONL log of every burn event.
  Each line: `{ ts, kind, proxyId, reason, recentStatusCodes, provider, stats }`.
  Used for ops debugging + provider charge disputes.
- **`tests/proxy.test.js`** — 52 tests / 143 assertions across 9 describe
  blocks:
  - `parseProxyLine` (6 tests) — all 3 URL formats + edge cases.
  - Burn detector (13 tests) — every burn rule + recovery + manual overrides.
  - Pool strategies (5 tests) — round-robin, random (seeded), sticky,
    sessionLength rotation.
  - Pool burn integration (5 tests) — release triggers burn, markBurned,
    exhaustion, cooldown recovery, stats accuracy.
  - Burn log writer (2 tests) — JSONL format + event fields.
  - Health check (2 tests) — DI'd fetchFn, failed proxies benched.
  - DI / no-network guarantees (3 tests) — inline list, injected provider,
    empty pool.
  - Config integration (8 tests) — every flag + env var + validation errors.
  - Acceptance criteria (7 tests) — AC1–AC7 from the execution plan, each
    verified by a dedicated test.

#### Changed
- `package.json` — version bumped to `1.0.0-phase2.3`.
- `src/browser.js` — `withBrowser` now returns `{ browser, page, proxy }` so
  the caller can release the proxy to the pool with the appropriate outcome.
- `.env.example` — new Phase 2.3 section documenting all proxy env vars.
- `PHASE2_EXECUTION_PLAN.md` — Phase 2.3 marked ✅ DONE with test counts and
  deliverable summary.

#### Design notes
- **Eager sync load.** The pool loads sync sources (file + list) eagerly at
  construction so `stats()` and `markBurned()` work without an `acquire()`
  first. Async sources (provider API) load lazily on first `acquire()`/
  `healthCheck()` via a shared `loadPromise`.
- **Default-port restoration.** Node's `URL` strips default ports (80 for http,
  443 for https, 1080 for socks5). `parseProxyLine` restores them so the
  descriptor always has an explicit port — otherwise `http://1.1.1.1:80` would
  parse as null.
- **Burn log is sync.** Proxy burns are rare (a 1000-proxy pool might see a
  few burns per hour), so we use `fs.appendFileSync` for durability rather
  than buffering. This guarantees the burn event hits disk before the pool
  moves on, which matters for provider charge disputes.
- **CAPTCHA → 429 mapping.** When the pipeline aborts with `CAPTCHA_DETECTED`,
  we release the proxy with `statusCode: 429` rather than `'TIMEOUT'`. This
  feeds the consecutive-block burn rule (3 CAPTCHAs → cooldown), which is the
  correct signal: a CAPTCHA means Google is rate-limiting that IP.

**Test count:** 603 tests / 1550 assertions (was 551 / 1407).

---

### Phase 2.8 — Worker Pool & Concurrency

#### Added
- **`src/worker.js`** — an isolated scrape worker abstraction with full DI:
  - `createWorker({ id, cfg, proxy, fingerprint, sessionManager, rateLimiter, runTask, crashLimit, crashWindowMs, cooldownMs, clock, sleepFn, logger })` — returns a worker object. `runTask` is injected (DI) so the worker is fully unit-testable with mocks and decoupled from the Playwright pipeline.
  - `worker.run(task)` — executes a task via `runTask(worker, task)`; tracks `tasksAttempted`/`tasksCompleted`/`businessesScraped` (accumulated from `{businesses}`/`{count}`/array result shapes); handles block + crash signals.
  - State machine: `idle` → `busy` → (`idle` | `cooldown` | `retired`).
  - **Block signal** — `runTask` throws `{ code: 'WORKER_BLOCKED' }` → `markBlocked()` (state=`cooldown`, `cooldownUntil = now + cooldownMs`), `blocked++`, re-throw tagged so the pool re-queues.
  - **Crash** — any other thrown error → `markCrashed(err)` (records a sliding-window crash timestamp; `errors++`/`crashes++`); after `crashLimit` (default 3) crashes in 10 min → `state='retired'` (worker removed from the active pool permanently).
  - `worker.isHealthy()` / `worker.isAvailable()` — `isAvailable` lazy-revives a cooldown worker once the clock passes `cooldownUntil`.
  - `worker.rotateIdentity({ proxy, fingerprint, sessionManager })` — swaps the worker's identity after a block/crash so the NEXT task launches a fresh browser with a new proxy + fingerprint + session (the "restart").
  - `worker.stats()` — `{ workerId, state, retired, proxyId, fingerprint, tasksAttempted, tasksCompleted, businessesScraped, errors, blocked, crashes, consecutiveErrors, crashCountInWindow, crashLimit, cooldownRemainingMs, lastError, ... }`.
  - `worker.shutdown()` — releases the session manager, logs final stats, sets `state='retired'`.
  - `WorkerError` with `code` (`WORKER_CONFIG`/`WORKER_RETIRED`/`WORKER_BUSY`/`WORKER_COOLDOWN`/`WORKER_BLOCKED`/`WORKER_CRASHED`).
- **Task descriptors** (serializable for the Phase 2.9 job queue):
  - `createSearchTask({ query, location, maxResults, opts })` — search + scroll + extract for one query/location.
  - `createDetailTask({ businesses, opts })` — deep-scrape a batch of businesses (default 20).
  - `createResumeTask({ checkpoint, opts })` — resume a crashed search-task from checkpoint.
  - `validateTask(task)` — validates type/id/fields + JSON-serializability; returns error array.
- **`src/pool.js`** — a worker pool scheduler + self-healer with full DI:
  - `createPool({ size, cfg, createWorker, getIdentity, loadBalancer, crashLimit, crashWindowMs, cooldownMs, taskRetries, clock, sleepFn, pollIntervalMs, logger })`.
  - `pool.dispatch(task)` — acquires an available worker (race-free under single-threaded JS via a sync `busy` Set claim), runs the task, and **re-queues on failure**: a block → `rotateIdentity` + cooldown + re-queue to another worker; a crash → `markCrashed` (retire if over limit) + `rotateIdentity` + re-queue. Resolves when the task eventually completes (or rejects after `taskRetries` / pool exhaustion).
  - `pool.dispatchBatch(tasks)` — `Promise.all`-style; preserves order; pool gates concurrency to `size`.
  - `pool.dispatchBatchSettled(tasks)` — never rejects; returns `{ results, fulfilled, rejected, total }` for partial-failure detail-batch runs.
  - `pool.stats()` — aggregate `{ size, activeSize, retiredCount, loadBalancer, dispatchCount, requeueCount, totals, perWorker }`.
  - `pool.shutdown()` — graceful: drains in-flight tasks (60s deadline), then shuts down every worker.
  - **Load balancers:** `round-robin` (default; cycles the available set) and `least-busy` (fewest `tasksCompleted`, ties by lowest id).
  - `acquireWorker()` polls on an injectable `sleepFn` (default 25ms — negligible for scrape-length tasks, instant under test's no-op sleep); throws `PoolError('POOL_EXHAUSTED')` when every worker is retired.
  - `getIdentity` is DI: in production it acquires a proxy from the proxy pool + generates a fingerprint + builds a per-worker session manager + rate limiter; in tests it's a mock.
- **`src/config.js`** — 7 new CLI flags + env vars + validation + help:
  - `--workers N` (default 1 = Phase 1 sequential behavior preserved byte-for-byte).
  - `--workerProxyStrategy shared|isolated` (default `isolated`).
  - `--workerCrashLimit N` (default 3).
  - `--workerCooldownMs <ms>` (default 300000 = 5 min).
  - `--workerLoadBalancer round-robin|least-busy` (default `round-robin`).
  - `--workerDetailBatchSize N` (default 20).
  - `--workerTaskRetries N` (default = workers size).
  - Matching `WORKERS` / `WORKER_PROXY_STRATEGY` / `WORKER_CRASH_LIMIT` / `WORKER_COOLDOWN_MS` / `WORKER_LOAD_BALANCER` / `WORKER_DETAIL_BATCH_SIZE` / `WORKER_TASK_RETRIES` env vars.
- **`src/index.js`** — `runWithPool()` multi-worker pipeline:
  - `getIdentity()` acquires a proxy (fallback to direct on pool exhaustion), generates a per-worker fingerprint, and builds a per-worker session manager + `RateLimiter`.
  - `runTask(worker, task)` handles `search-task` (warmup → search → scroll → extract) and `detail-task` (warmup → search → scroll → `deepScrapeAll` on the batch) via `withBrowser` with the worker's identity.
  - Dispatches one `search-task` → dedups against checkpoint → splits businesses into `detail-task` batches (size `--workerDetailBatchSize`) → `dispatchBatchSettled` across the pool → merges detail fields back into the master array by index → aggregates `detailStats`.
  - Aggregates per-worker session stats; includes `pool.stats()` in the run summary + a `Pool:` line in the end-of-run banner.
  - `--workers 1` skips the pool entirely — the existing single-browser pipeline runs unchanged (Phase 1 behavior preserved exactly).
- **`.env.example`** — Phase 2.8 section expanded with all 7 env vars + comments.

#### Tests
- **`tests/worker.test.js`** (29 tests / 108 assertions) — createWorker DI + validation; run success path (result-shape accumulation, consecutiveErrors reset, state transitions); block signal (cooldown, lazy revival via injectable clock); crash + retirement (crashLimit window pruning, WORKER_RETIRED); rotateIdentity; stats; shutdown; task helpers (search/detail/resume, JSON-serializability, unique ids).
- **`tests/pool.test.js`** (17 tests / 39 assertions) — construction; dispatch; round-robin distribution (3 workers → 3 distinct); least-busy; **parallelism** (3 tasks on 3 workers ≈ 1× duration with overlapping execution windows); **no race conditions** (5 tasks on 2 workers: max concurrency ≤ 2, all 5 run); block re-queue + identity rotation; crash re-queue + retirement (active size drops); pool exhaustion (`POOL_EXHAUSTED`); `dispatchBatchSettled` partial failure; shutdown.
- **`tests/config.test.js`** Phase 2.8 section (21 tests) — CLI flag parsing, env var fallbacks, CLI-overrides-env, validation (range + enum), HELP_TEXT, `--workers 1` produces no worker-pool errors.

**Test count:** 1016 tests / 7280 assertions (was 949 / 7125).

---

### Phase 2.9 — Job Queue & Orchestration

#### Added
- **`src/queue/index.js`** — a BullMQ-backed job queue adapter with full DI:
  - `createQueue({ redisUrl, name, logger, backend?, defaultPriority?, defaultAttempts?, concurrency? })` — returns a queue adapter. Production uses real BullMQ + Redis (lazy `require('bullmq')` so the dep only loads when a queue is actually constructed); tests inject `{ Queue: MockQueue, Worker: MockWorker }` (DI seam — NO real Redis required for unit tests, an explicit acceptance criterion).
  - `queue.add(type, payload, { priority, delay, attempts })` — submits a job. Validates via `JOB_TYPES[type].validate` FIRST (fail-fast on bad payloads — never persist garbage to Redis); then delegates to the backend. Returns `{ id }`.
  - `queue.addBatch(jobs)` — submits multiple jobs; returns per-job `{ id } | { error }` so a bad row in a CSV doesn't tank the whole batch.
  - `queue.process(processor)` — registers the worker function. The adapter converts the job payload → task via `JOB_TYPES[type].toTask`, stamps it with `_queue = { jobId, type, attemptsMade }`, then calls `processor(task, job)`. In production the processor calls `pool.dispatch(task)`. Only one processor per queue (BullMQ limitation).
  - `queue.getStatus(jobId)` — returns `{ id, type, data, state, progress, result, error, attemptsMade, timestamp, processedOn, finishedOn }`; null for missing jobs.
  - `queue.getStats()` — returns `{ waiting, active, completed, failed, delayed, total }`.
  - `queue.getActive({ limit })`, `queue.pause()`, `queue.resume()` — introspection + flow control.
  - `queue.deadLetter` — callable (returns the list, spec parity) AND an object with `.list({ limit, offset })` / `.get(id)` / `.retry(id)` / `.retryAll({ limit })` / `.remove(id)` / `.clear()` / `.count()` (rich API).
  - `queue.retryDeadLetter(jobId)` — spec-parity top-level method.
  - `queue.shutdown()` — graceful: stops accepting new adds, finishes in-flight jobs, closes the worker + queue. Best-effort — never throws. Idempotent.
  - `QueueError` with `code` (`QUEUE_NO_REDIS`/`QUEUE_NO_BACKEND`/`QUEUE_INVALID`/`QUEUE_UNKNOWN_TYPE`/`QUEUE_SHUTDOWN`/`QUEUE_PROCESSOR_EXISTS`/`QUEUE_CONFIG`).
- **`src/queue/job-types.js`** — job-type registry + schema validators (pure, no deps):
  - `JOB_TYPES` registry — `search`, `detail-batch`, `enrich`. Each has `name` / `validate(payload)` / `toTask(payload)` / `priority`.
  - `search` — `{ query, location, maxResults?, deepScrape? }` → `search-task`.
  - `detail-batch` — `{ businessIds?: string[], businesses?: object[], deepScrape? }` → `detail-task`. Two payload shapes: `businessIds` (Phase 3 re-scrape-by-id, needs DB lookup) OR `businesses` (Phase 2.9 main flow, no lookup needed).
  - `enrich` — (Phase 3 placeholder) `{ businessId, source? }` → `enrich-task`.
  - `validateJobRequest({ type, payload, priority?, attempts?, delay? })` — fail-fast validation; returns error array (empty = valid).
  - `resolvePriority(p)` — clamps to BullMQ's range (1 to 2^31-1); negative/non-finite → normal.
  - `PRIORITY_HIGH=1` / `PRIORITY_NORMAL=5` / `PRIORITY_LOW=10` bands.
- **`src/queue/mock-backend.js`** — a pure in-memory implementation of the BullMQ API subset the adapter depends on (the test seam):
  - `MockQueue` — `add` / `getJob` / `getJobCounts` / `getFailed` / `getJobs(state)` / `pause` / `resume` / `close` / `disconnect`. Priority queue with stable sort (priority asc, timestamp asc). Delayed jobs promoted lazily on `getJobCounts` / `_pull` (matches BullMQ).
  - `MockWorker(name, processor, { concurrency, clock, sleepFn, logger })` — polls the MockQueue; processes up to `concurrency` jobs in parallel. Retry with exponential backoff CALCULATION (logged for parity; the mock doesn't actually sleep — tests don't want to wait). Dead-letters after `attempts` failures. `close()` awaits `_pollDonePromise` so in-flight jobs finish before the worker exits.
  - `MockJob` — `id` / `name` / `data` / `opts` / `progress` / `returnvalue` / `failedReason` / `attemptsMade` / `timestamp` / `processedOn` / `finishedOn` / `getState()` / `updateProgress(value)` / `waitUntilFinished()` / `retry()` / `remove()`. `retry()` resets `attemptsMade` to 0 (fresh set of attempts, matches BullMQ) AND removes the job from the `_failed` / `_completed` sets so `getFailed()` no longer returns it.
  - `setImmediate`-based poll loop (NOT `Promise.resolve()`) so the event loop isn't starved — a microtask-only yield would deadlock any test using real timers.
  - `_resetRegistry()` test helper — clears the shared MockQueue↔MockWorker registry between tests.
- **`src/queue/dead-letter.js`** — dead-letter helper (DI on the backend queue):
  - `createDeadLetter({ queue, logger })` — returns `{ list, get, retry, retryAll, remove, clear, count }`.
  - `list({ limit=100, offset=0 })` — paginated failed-jobs listing + total count.
  - `retry(jobId)` — returns `{ ok: true } | { ok: false, error }` (never throws).
  - `retryAll({ limit=1000 })` — retries every dead-lettered job; returns `{ retried, failed, total, errors }`.
  - `remove(jobId)` / `clear()` / `count()` — manual dead-letter management.
  - `serializeJob(job)` — JSON-safe plain-object snapshot for CLI / API output.
- **`src/config.js`** — 5 new CLI flags + env vars + validation + help:
  - `--queue on|off` (default `off` = Phase 2.8 in-process dispatch — no Redis required).
  - `--redisUrl <url>` (default `redis://localhost:6379`; required when `--queue on`).
  - `--queuePriority N` (default 5; range 1-100).
  - `--queueAttempts N` (default 3; range 1-50).
  - `--queueConcurrency N` (default 1; range 1-64; should be ≤ `--workers`).
  - Validation: `--queue on` requires `REDIS_URL` (fail-fast before any browser launches).
  - HELP_TEXT expanded with Phase 2.9 flags + examples (batch + queue:status).
- **`src/index.js`** — `runWithQueue` pipeline path (gated on `cfg.queue.enabled`):
  - Builds the same worker pool as `runWithPool` (getIdentity + runTask + createWorkerPool) — a Phase 2.13 refactor will extract this into a shared `buildPool()` helper.
  - Builds the queue adapter + registers a processor that calls `pool.dispatch(task)`.
  - Submits the search job → awaits `job.waitUntilFinished()` → dedup against checkpoint → stamp `EMPTY_DETAIL`.
  - If `--deepScrape true`, splits businesses into detail-batch jobs (each carrying the FULL business objects — no DB lookup needed in the main flow), submits them via `addBatch`, awaits each, and merges results back by index. Failed batches are reported + counted as dead-lettered.
  - Aggregates per-worker session stats + queue stats into the same `result` shape as `runWithPool` so the downstream export / summary / banner logic is shared.
  - Graceful shutdown: queue first (stop accepting jobs, finish in-flight), then pool (workers finish, release proxies).
  - `--queue off` (default) falls through to Phase 2.8 / sequential unchanged.
- **`src/banner.js`** — two new startup-banner rows:
  - `Workers` — pool size + load balancer + crash limit when `--workers N > 1`, or "1 (Phase 1 sequential)".
  - `Queue` — "on (BullMQ + Redis, priority N, M attempts, C concurrency)" or "off (Phase 2.8 in-process)".
- **`src/index.js`** end-of-run banner — `Queue:` line showing completed/active/waiting/failed/delayed counts (omitted when `--queue off`).
- **`scripts/batch.js`** — batch submission CLI (`npm run batch -- --file queries.csv`):
  - Hand-rolled CSV parser (no external dep) — handles double-quoted fields with escaped quotes (`""`), commas inside quotes, `#` comments, blank lines.
  - Columns: `query, location, maxResults, deepScrape, priority` (only `query` + `location` required; others optional).
  - Per-row validation; invalid rows are reported but don't tank the batch.
  - `--dryRun` parses + prints without submitting.
  - Submits via `queue.addBatch`; prints per-job `{ id }` or `{ error }`; prints a monitoring hint.
- **`scripts/queue-status.js`** — live status CLI (`npm run queue:status`):
  - Live top-style view — refreshes every 2s, Ctrl-C to exit.
  - Prints: waiting / active / completed / failed / delayed / total counts.
  - Prints: active jobs (id, type, progress, attemptsMade, elapsed, data summary).
  - Prints: recently-failed (dead-letter) jobs (id, type, reason, attemptsMade).
  - Modes: `--once` (single snapshot), `--job <id>` (inspect one job), `--deadLetter` (full list), `--retry <id>` (retry one), `--retryAll` (retry all).
  - ANSI screen clear in TTY mode; plain output when piped (CI-friendly).
- **`queries.example.csv`** — sample batch input (5 rows demonstrating query/location/maxResults/deepScrape/priority, including a quoted "Dhaka, Bangladesh" with a comma).
- **`.env.example`** — Phase 2.9 section expanded with `REDIS_URL` + `QUEUE_CONCURRENCY` + detailed comments.
- **`package.json`** — version bumped to `1.0.0-phase2.9`; new scripts `batch` + `queue:status`; `syntax` script extended to cover the new `src/queue/` files + the two new scripts.

#### Tests
- **`tests/queue.test.js`** (96 tests / 231 assertions) — comprehensive coverage:
  - `job-types.js` validators: search/detail-batch/enrich (valid + invalid payloads), validateJobRequest (unknown type, invalid payload, negative priority, attempts < 1 / > 50, negative delay, non-object request), resolvePriority (undefined/null → normal, valid pass-through with floor, negative → normal, non-finite → normal, huge clamp), PRIORITY band ordering.
  - `mock-backend.js` lifecycle: MockQueue construction (requires name), add returns job with id + data, getJob by id, getJobCounts reflects state, add throws when closed, delayed jobs go into delayed state (with injectable clock), MockWorker processes end-to-end, FIFO within same priority, processor can report progress, MockWorker requires processor + registered queue, priority ordering (high runs before low submitted after), equal-priority FIFO, retry (fail N times then succeed), dead-letter (fail N times → failed state + attemptsMade = N), getFailed returns dead-lettered jobs, job.retry() resets attemptsMade + removes from _failed set, retry on completed job, pause stops processing, resume restarts, close stops new adds, worker.close() waits for in-flight jobs.
  - `dead-letter.js`: list with limit/offset (paginated, no overlap), get (single, null for missing/null), retry (ok:true on success, ok:false for nonexistent), retryAll (retries all, returns summary), count, remove, clear, serializeJob (JSON-safe).
  - `queue/index.js` adapter: add (valid returns {id}, unknown type throws, invalid payload throws, post-shutdown throws), addBatch (per-job results, invalid row → {error}), process (registers + converts payload → task via toTask, stamps _queue metadata, throws if already registered, throws if not a function), getStatus (null for missing/null, full for completed), getStats (queue-wide counts), priority ordering (high runs before low), retry (fail 3× → dead-lettered, fail 2× then succeed → completed), deadLetter() callable returns list, deadLetter.list() method, deadLetter.count(), retryDeadLetter(id), deadLetter.retryAll(), pause/resume, shutdown (stops adds + idempotent), default priority/attempts from opts, enrich job type end-to-end, detail-batch with businesses payload, detail-batch with businessIds payload, getActive, concurrency 3 parallelism (maxActive 2-3), real BullMQ backend throws when redisUrl missing.
  - DI: every test injects `{ Queue: MockQueue, Worker: MockWorker }` — NO real Redis required (an explicit acceptance criterion).

**Test count:** 1112 tests / 7534 assertions (was 1016 / 7280).

---

## [Unreleased] — post-v1.0.0-phase1 hotfixes

### Fixed
- **`playwright` missing from `package.json` dependencies** (`04acb38`):
  fresh-clone installs produced `Cannot find module 'playwright'` because the
  package was only available globally in the dev sandbox. Now declared as a
  runtime dependency.
- **`--dryRun` example was ambiguous and led to "no CSV" confusion**
  (`d85ef34`): the help text's last (most-memorable) example used `--dryRun`
  with only a `# no delay, scripted` comment, never warning that no files are
  written. Reordered the examples (real runs first, smoke-test last) and
  rewrote the flag description to `"Smoke test: run pipeline but write NO
  output files"`. Added a Troubleshooting entry with the exact log
  signatures.
- **Detail-panel deep scrape opened 0% of panels** (this release):
  `openDetailPanelOnPage` waited only for DOM selectors including the stale
  `h1[data-attrid="title"]` (a 2020-era Google Maps selector), and logged
  every failure at `debug` level (suppressed at default `info`). Every
  detail open timed out after 3 retries × 12s = ~40s of silent failure per
  business. Rewrote the function with three hardening stages:
  1. **Anchor finding**: match by `place_id` first (stable, no CSS-special
     chars), then `maps_url`, then generic `/maps/place/`, then card-by-
     `aria-label` fallback.
  2. **Click**: `scrollIntoViewIfNeeded` before click (target card may be
     off-screen after scroll-to-load on Google's virtualized feed).
  3. **Wait**: primary signal is URL change to `/maps/place/` via
     `page.waitForFunction` (pushState navigation — most robust). Secondary
     signal is updated DOM selectors (dropped `data-attrid`, added plain
     `h1`, `div[role="region"]`).
  Every failure path now logs at `warn` level with `beforeUrl`, `afterUrl`,
  `urlChanged`, `matchedBy`, and `triedSelectors` so the operator can see
  exactly which stage failed. Added `safePageUrl` helper (exported) for
  robust `page.url()` reads on synthetic test pages.

### Added
- `tests/detail.test.js`: 11 new tests for the hardened `openDetailPanelOnPage`
  (7 tests: no-anchor, selector ordering, URL-change success, timeout-with-
  urlChanged, click-threw, card-by-aria-label fallback, no-place_id grace) and
  `safePageUrl` (4 tests). Total suite: **410 tests / 1028 assertions**.
- `SELECTORS.md`: new "Detail-panel open strategy" section documenting the
  three-stage approach with selector tables and the historical note on why
  `data-attrid` was dropped.

---

## [v1.0.0-phase1] — 2026-08-07

The Phase 1 milestone: a single-query, single-machine Google Maps business
scraper that searches, paginates, extracts 17 list-view fields (+ 8 optional
detail-panel fields), and exports a 25-column Excel-safe CSV — with crash
recovery, anti-block, structured logging, and CLI polish. **12 of 12
sub-phases complete. 397 tests / 999 assertions passing.**

### Sub-phase rollup

| Sub-phase | Commit | Summary |
|---|---|---|
| 1.0 — Project Hygiene & Foundation | `0e1589c` | Modular `src/` layout, `.gitignore`, `.env.example`, `npm start` |
| 1.1 — Configurable Search Input | `084d3f7` | CLI flags + env fallbacks + validation, `HELP_TEXT` |
| 1.2 — Robust Browser Automation Core | `ea28971` | Timeouts, SIGINT handler, idempotent teardown |
| 1.3 — Pagination / Infinite-Scroll | `a8c72a7` | `scroll.js` with DI `openFn`/`backFn`, stall detection |
| 1.4 — Core Field Extraction (List) | `59704ca` | `CANONICAL_FIELDS` (17), parsers, fallbacks, extraction rates |
| 1.5 — Detail-Page Deep Scrape | `48f9c0e` | `DETAIL_FIELDS` (8), per-business isolation, sample-step |
| 1.6 — CSV Export Engine | `a6b0315` | RFC 4180 escaping, UTF-8 BOM, CSV + JSON + summary.json |
| 1.7 — Reliability & Crash Recovery | `48c7306` | `withRetry` (3 attempts, 1s→2s→4s), checkpoint resume, per-business isolation |
| 1.8 — Minimal Anti-Block Behavior | `2644759` | Rate limiter (30 RPM), human typing, CAPTCHA detection, UA rotation, 429/503 watcher |
| 1.9 — Logging & Observability | `972a6bb` | `phase` field on every log line, per-business + per-field debug, run-complete event, sync file sink |
| 1.10 — CLI Polish & DX | `d7a7d26` | Startup banner + 1s confirm delay, `--yes`/`-y` to skip, exit codes 0/1/2/3/130 |
| 1.11 — Documentation & Handoff | _(this release)_ | Troubleshooting, Known limitations, Roadmap, `SELECTORS.md`, `CHANGELOG.md`, `v1.0.0-phase1` tag |

### Added

- **25-field stable output schema** — 17 canonical list-view fields (name,
  rating, reviews_count, price_level, category, address, phone, website,
  maps_url, place_id, plus_code, open_now, business_status, is_sponsored,
  scraped_at, query, location) + 8 detail fields (full_hours, popular_times,
  top_reviews, photos, reservation_url, menu_url, social_profiles,
  detail_scraped). Column order is fixed in `src/export.js` `COLUMN_SCHEMA`
  so downstream pipelines don't break when fields are added.
- **CSV + JSON + summary.json export** (Phase 1.6). CSV is RFC 4180-compliant
  with UTF-8 BOM and CRLF line endings for Excel safety. JSON sidecar
  preserves nested structure (arrays of review/photo objects). Summary
  records query, location, totals, extraction rates, scroll result, deep-
  scrape stats, duration, and output paths.
- **Crash recovery** (Phase 1.7). `withRetry` wraps every transient browser
  op (3 attempts, 1s→2s→4s backoff). A `.checkpoint_{query}_{location}.json`
  file is written every N results; `--resume` reloads it and skips already-
  extracted businesses by `place_id` (or name+address+phone hash). `--fresh`
  clears it. Checkpoint is auto-cleared on successful completion, preserved
  on crash / SIGINT / CAPTCHA abort.
- **Anti-block behavior** (Phase 1.8). Token-bucket rate limiter (default
  30 req/min, `--maxRPM`), char-by-char human typing (`--noHumanTyping` to
  disable), randomized delays (scroll 800–2000ms, detail 1500–3500ms,
  pre-Enter 500–1500ms, per-key 50–150ms), 8-UA rotation, 429/503 response
  watcher, CAPTCHA detection (`--noCaptchaPause` / `--captchaWaitMs`).
- **Structured logging** (Phase 1.9). Dual-sink logger: colorized console +
  JSON-lines file (`logs/{query}_{location}_{timestamp}.log`). Every line
  carries a `phase` tag (search/scroll/extract/detail/export/recovery/
  antiblock/retry/browser/system). `--logLevel debug` emits per-business,
  per-field breakdown. A structured `Run complete` line records duration,
  counts, and exit code for machine-parseable post-run analysis.
- **CLI polish** (Phase 1.10). Startup banner prints the resolved config
  with a 1-second confirm delay (`--yes`/`-y` to skip). `--help` lists every
  flag with a one-line description and usage example. `--version` reads
  `package.json`. `--dryRun` runs the full pipeline without writing files.
  `--limit N` aliases `--maxResults`. `--headless`/`--headed` override `.env`.
  `--verbose` aliases `--logLevel debug`. Friendly config errors (no stack
  traces). Exit codes 0/1/2/3/130.
- **Documentation & handoff** (Phase 1.11). `README.md` with Quick start,
  Requirements, CLI, Configuration, Usage examples, Output format,
  Troubleshooting, Known limitations, Roadmap. `SELECTORS.md` documenting
  where primary/fallback selectors live and how to update them when Google
  changes the DOM. This `CHANGELOG.md`. `v1.0.0-phase1` git tag.

### Changed

- Bumped version `0.1.0` → `1.0.0-phase1` (`package.json`).
- README Quick start now works on a fresh clone (`npm install` +
  `npx playwright install chromium`), no sandbox-only assumptions.
- Pipeline entry point (`src/index.js`) wires checkpoint resume, retry,
  anti-block, structured logging, and the startup banner in dependency order.

### Fixed

- (Phase 1.4) `parseOpenNow`: "Opens 11:00 AM" now returns `false` (currently
  closed, opens later) instead of `null`.
- (Phase 1.4) Sponsored detection now catches CJK badges (贊助商廣告 /
  赞助商广告 / 広告) via `aria-label` patterns + `adssettings.google.com` link.
- (Phase 1.4) `hl=en` forced on the Maps URL — Maps was rendering in the
  browser locale despite `locale: 'en-US'`.
- (Phase 1.4) Category/address selectors rewrote with nested-`.W4Efsd` parser
  so they no longer grab hours text.

### Known limitations (Phase 1 scope)

These are **deliberately deferred** to later phases (see `SCRAPER_FEATURES.md`):

- No proxy / IP rotation (Phase 2).
- No auto-CAPTCHA solving — pauses for manual solve, then aborts with
  checkpoint preserved (Phase 2).
- Single concurrent run — one browser, one query, sequential (Phase 3).
- List-view `phone`/`website`/`plus_code`/`price_level` are absent on modern
  cards; use `--deepScrape true` to populate them (Phase 1.5).
- Selectors are DOM-coupled — see `SELECTORS.md` for the update procedure.
- No incremental / scheduled runs (Phase 4).
- `commonjs`, not ESM; CLI only, no GUI (Phase 5).

### Acceptance test (Definition of Done)

A fresh clone + `npm install` + `npx playwright install chromium` +
`npm start -- --query "Restaurant" --location "Toronto" --limit 20` produces
a CSV within 10 minutes. ✅ Verified.

---

## Pre-release history

These commits built up Phase 1 incrementally before the `v1.0.0-phase1` tag.
Each is a shippable sub-phase; see `PHASE1_EXECUTION_PLAN.md` for the
granular spec and acceptance criteria per sub-phase.

- `a83eb37` — Initial Playwright scraper setup
- `04ed8db` — Add world-class scraper feature roadmap (`SCRAPER_FEATURES.md`)
- `4b62287` — Add Phase 1 execution plan (granular sub-phases)
- `0e1589c` — Phase 1.0: project hygiene & foundation
- `084d3f7` — Phase 1.1: configurable search input
- `ea28971` — Phase 1.2: robust browser automation core
- `a8c72a7` — Phase 1.3: pagination / infinite-scroll handling
- `59704ca` — Phase 1.4: Core Field Extraction (List View)
- `48f9c0e` — Phase 1.5: detail-page deep scrape (optional)
- `a6b0315` — Phase 1.6: CSV/JSON export engine
- `48c7306` — Phase 1.7: reliability & crash recovery
- `fcbc221` — docs: mark Phase 1.7 done
- `2644759` — Phase 1.8: minimal anti-block behavior
- `972a6bb` — Phase 1.9: structured logging & observability
- `d7a7d26` — Phase 1.10: CLI polish & developer experience
- _(this release)_ — Phase 1.11: documentation & handoff (`v1.0.0-phase1`)
