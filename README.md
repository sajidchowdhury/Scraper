# gmaps-scraper

Google Maps business scraper — **Phase 1**: search → paginate → extract → (deep scrape) → CSV export, with crash recovery, anti-block, structured logging, and CLI polish.

> Implements sub-phases 1.0 through 1.11 of `PHASE1_EXECUTION_PLAN.md` — the full Phase 1 milestone.
> The script survives transient failures (retry with backoff), resumes from checkpoints after a crash,
> isolates per-business errors so one bad record never crashes the run, throttles itself to avoid
> blocks, and emits a JSON-lines log per run for post-hoc analysis.

- **[CHANGELOG.md](CHANGELOG.md)** — release history for the Phase 1 milestone (`v1.0.0-phase1`).
- **[SELECTORS.md](SELECTORS.md)** — where the primary/fallback CSS selectors live, and how to update them when Google changes the DOM.
- **[PHASE1_EXECUTION_PLAN.md](PHASE1_EXECUTION_PLAN.md)** — granular per-sub-phase spec, acceptance criteria, and status (Phase 1 complete).
- **[PHASE2_EXECUTION_PLAN.md](PHASE2_EXECUTION_PLAN.md)** — granular per-sub-phase spec for Phase 2 (robustness & scale: proxies, stealth, concurrency, PostgreSQL, CAPTCHA solving). 13 sub-phases.
- **[SCRAPER_FEATURES.md](SCRAPER_FEATURES.md)** — master roadmap (Phases 2–5: proxies, auto-CAPTCHA, concurrency, …).
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — Phase 2 system architecture: high-level pipeline diagram, module map, request lifecycle, identity stack, concurrency model, persistence + change tracking, incremental cache, health & self-healing.
- **[OPERATIONS.md](OPERATIONS.md)** — Phase 2 production operations runbook: 10k-listing overnight run, proxy + CAPTCHA budgeting, concurrency tuning, monitoring + alerting, recovery, post-run verification.

## Phase 2 Features

Phase 2 (sub-phases 2.0–2.12, version `2.0.0-phase2`) turns the Phase 1
single-machine, file-only scraper into a robust, unattended pipeline that
survives a 10,000+-listing overnight run. Every sub-system is opt-in via
CLI flags or env vars — with all Phase 2 flags unset, the scraper behaves
byte-for-byte like Phase 1. See **[`ARCHITECTURE.md`](ARCHITECTURE.md)**
for the full pipeline diagram (CLI → preflight → health check → pool/queue
→ worker identity stack → scrape pipeline → persistence + change tracking
+ incremental cache → export) and **[`OPERATIONS.md`](OPERATIONS.md)** for
the production runbook (10k-run command, budgeting, monitoring, recovery).
Detailed sub-phase specs + acceptance criteria live in
**[`PHASE2_EXECUTION_PLAN.md`](PHASE2_EXECUTION_PLAN.md)**; selector
internals live in **[`SELECTORS.md`](SELECTORS.md)**.

### PostgreSQL Persistence

Phase 2.1 — scraped businesses can be upserted into PostgreSQL alongside
(or instead of) CSV/JSON via `--output db` (or `--output all` for all
three). Each business is keyed by `place_id` and re-scrapes are no-op
detected via a SHA-256 `data_hash` column, so identical re-runs produce
zero writes. Create the schema once with `npm run db:migrate`
(`DATABASE_URL` required). See the
[PostgreSQL persistence (phase 2.1)](#postgresql-persistence-phase-21)
section below for the schema, output targets, and idempotent upsert
details.

### Change Tracking & History

Phase 2.2 — every re-scrape snapshots the old values into
`business_snapshots` and logs one `field_changes` row per tracked field
(`rating`, `reviews_count`, `business_status`, `phone`, `website`),
turning the scraper into a trend-data tool. Identical re-scrapes produce
zero snapshots and zero changes (no noise). Inspect any business's
timeline with `npm run db:history -- --placeId ChIJxxx`. See the
[Change tracking & history (phase 2.2)](#change-tracking--history-phase-22)
section below for the tracked-fields table and CLI flags.

### Proxy Management & Rotation

Phase 2.3 — route browser traffic through a rotating proxy pool declared
via `--proxyListFile` (one proxy per line: `protocol://[user:pass@]host:port`
or `host:port:user:pass`). Three strategies (`--proxyStrategy
round-robin|random|sticky`), automatic burn detection (3× 403/429, <50%
success, 3× timeout → cooldown; HTTP 407 → permanent), and an optional
`--proxyHealthCheck` HEAD probe before scraping. `--noProxy` forces a
direct connection (Phase 1 behavior). See the
[Proxy management & rotation (phase 2.3)](#proxy-management--rotation-phase-23)
section below and `OPERATIONS.md` for the full burn rules + burn log.

### Browser Fingerprint Randomization

Phase 2.4 — each run gets a coherent fingerprint: user-agent + platform +
viewport + timezone + locale + WebGL vendor/renderer + canvas noise +
`hardwareConcurrency` + `deviceMemory` + geolocation, all generated so the
combination never leaks a detectable mismatch (Windows UA → Win32
platform, `de-DE` locale → `Europe/Berlin` timezone, etc.). Controlled
via `--fingerprintProfile random|fixed|off` (default `random`),
`--fixedFingerprint <json>` for pinned profiles, and `--noFingerprint`
for Phase 1 behavior.

### Stealth Hardening

Phase 2.5 — patches the bot-detection surfaces fingerprint randomization
doesn't cover (`navigator.webdriver`, `chrome.runtime`, `plugins.length`,
`permissions.query`, `outerWidth/Height`, `Notification.permission`,
`navigator.vendor`, `maxTouchPoints`) via `playwright-extra` +
`puppeteer-extra-plugin-stealth` plus a custom init script. On by
default (`--stealth on`); `--noStealth` disables it for A/B testing and
`--stealthDebug` logs every patch applied + the resulting navigator
properties. Complements (does not replace) the Phase 2.4 fingerprint.

### CAPTCHA Auto-Solving

Phase 2.6 — when Google shows a CAPTCHA, the orchestrator solves it via a
third-party service and resumes unattended. Provider is selected via
`--captchaProvider 2captcha|anticaptcha|capsolver|mock|none` (default
`none` = Phase 1.8 pause-and-alert). `--captchaBudget <usd>` (default
$5.00) is a hard spend cap — once hit, the orchestrator falls back to
pause-and-alert rather than spending more. `--noCaptchaSolve` forces
Phase 1.8 behavior. Use `--captchaProvider mock` for $0 smoke tests.

### Session & Cookie Rotation

Phase 2.7 — rotate the browser context (cookies + localStorage) every N
Maps requests (`--sessionMaxRequests`, default 50) OR every M ms
(`--sessionMaxAgeMs`, default 10 min), whichever fires first. Each new
context starts with a fresh cookie jar and is optionally warmed up
(`--warmup on`, default on) by visiting `google.com` + a random second
site + a benign search so the session doesn't look like a zero-history
bot. `--accountWarmup on` (off by default, account-burn risk) logs in
with aged Google accounts from `--accountsFile` for richer data + fewer
CAPTCHAs.

### Worker Pool & Concurrency

Phase 2.8 — parallel browser workers via `--workers <n>` (default 1 =
Phase 1 sequential). Each worker gets its own proxy + fingerprint +
session + rate limiter; with `--deepScrape true`, detail batches are
split across the pool for ~N× speedup. Blocked workers cool down
(`--workerCooldownMs`, default 5 min), rotate their identity, then
revive; their task is re-queued to another worker. Workers that crash
`--workerCrashLimit` times in 10 minutes are retired (pool shrinks).
Load balancer: `--workerLoadBalancer round-robin|least-busy` (default
`round-robin`).

### Job Queue & Orchestration

Phase 2.9 — `--queue on` decouples job submission from execution via a
BullMQ-backed Redis queue (`--redisUrl`, default `redis://localhost:6379`).
Submit a CSV of (query, location) pairs with `npm run batch -- --file
queries.csv --queue on`; jobs persist in Redis so a process crash
resumes on restart. Three job types (`search`, `detail-batch`,
`enrich`), priority bands (1=high / 5=normal / 10=low via
`--queuePriority`), exponential-backoff retries (`--queueAttempts`,
default 3) → dead-letter queue. Monitor live with `npm run queue:status`
(2s refresh; `--job`, `--deadLetter`, `--retry`, `--retryAll` modes).

### Memory Management & Long-Run Stability

Phase 2.10 — keeps the scraper running 8+ hours without OOM or orphaned
Chromium processes. `--contextRestartEvery <n>` (default 50)
force-restarts each browser context every N tasks to clear Chrome memory
leaks; `--maxHeapMb` (default 1024) + `--maxRssMb` (default 4096) trigger
graceful degradation (pause queue → restart contexts → run `global.gc()`
if `--expose-gc` → reduce pool). A zombie reaper scans for orphaned
Chromium at startup + shutdown + hourly in endless mode. `--endless`
keeps the process alive pulling jobs from the queue forever (Phase 5
continuous scraping); `--healthPort` binds a GET `/health` JSON endpoint
(auto-on when `--endless`, returns 200 ok/degraded or 503 unhealthy).

### Self-Healing Selectors & Health Checks

Phase 2.11 — a five-layer defense against Google Maps DOM changes:
selector versioning + staleness warning (`--maxSelectorAge`, default 30
days), startup health check (loads a fixture, aborts with **exit code 3**
if core fields <50%), first-batch abort (after 10 businesses, exit 3 if
core <50%), heuristic auto-discovery (`--autoDiscover`, default on —
falls back to phone/website/rating/reviews_count pattern matching when
selectors miss), and debug dumps (`--selectorDebugDump`, default on —
writes 500-char card snippets to `data/selector-debug/{field}_{ts}.html`
when a field's rate drops below 80%). `--skipHealthCheck` bypasses the
startup check for emergency runs. See **[`SELECTORS.md`](SELECTORS.md)**
for the full self-healing workflow + how to add new selectors.

### Incremental Scraping & Detail Caching

Phase 2.12 — a two-tier cache that cuts repeat-run runtime by ~80%.
`--incremental` (requires `--output db`) enables a run-level preflight
that skips the browser entirely when the most-recent scrape of this
(query, location) is within `--listFreshnessDays` (default 1) — ~0
requests, <30s runtime. Per-business, cached detail data (hours,
reviews, photos) is reused within `--detailCacheTtlDays` (default 7)
when the list-view `change_hash` matches; `--detailRefreshOnReviewDelta`
(default 10%) forces a refresh on review surges even within the TTL.
`--noDetailCache` forces a full deep-scrape; `--listFreshnessDays 0`
forces a full re-scrape.

## Phase 3 — Data Quality & Enrichment

Phase 3 (sub-phases 3.0–3.13, version `3.0.0-phase3`) turns raw scrape
results into **verified, normalized, deduplicated, enriched, scored
leads**. A single `--enrich on` flag runs an 11-stage pipeline after
each scrape (phone → address → dedup → chain/spam → email → tech-stack
→ sentiment → geo-metrics → lead score → confidence); grid-based
geospatial coverage (3.11) drives the search loop itself. Enrichment is
**opt-in and off by default** — with `--enrich` unset, the scraper
behaves byte-for-byte like Phase 2. See **[`ENRICHMENT.md`](ENRICHMENT.md)**
for the full operations runbook (provider setup, budgeting,
troubleshooting) and **[`ARCHITECTURE.md`](ARCHITECTURE.md)** for the
enrichment pipeline diagram. Detailed sub-phase specs + acceptance
criteria live in **[`PHASE3_EXECUTION_PLAN.md`](PHASE3_EXECUTION_PLAN.md)**.

### Enrichment Quick Start

```bash
# Canonical enriched run — 100 Toronto restaurants → Postgres + full enrichment
node src/index.js --query "Restaurant" --location "Toronto" \
  --maxResults 100 --output db --enrich on --yes
```

The default enriched run is **fully offline**: phone normalization,
address parsing, dedup, chain/spam detection, email discovery
(heuristic only), sentiment, geo-metrics, lead scoring, and confidence
all run without any outbound network calls. The three
network-dependent stages are opt-in:

- **Geocoding** — `--geocoder google|nominatim|mock` (default
  `nominatim`, free at 1 req/s; `google` is $5/1k and needs
  `--geocodeApiKey`; `mock` is $0 canned coords for testing).
- **Email SMTP verification** — network mailbox probes.
- **Tech-stack detection** — live HTTP fetch of each business's website.

Opt-in example (Google geocoding + email + tech-stack enrichment):

```bash
node src/index.js --query "Restaurant" --location "Toronto" \
  --maxResults 100 --output db --enrich on --yes \
  --geocoder google --geocodeApiKey $GEOCODING_API_KEY \
  --enrichEmail on --enrichTechStack on
```

Per-feature sub-flags (`--enrichPhone`, `--enrichAddress`,
`--enrichDedup`, `--enrichEmail`, `--enrichTechStack`,
`--enrichSentiment`, `--enrichGeo`, `--enrichLeadScore`,
`--enrichConfidence`) all default to **on** when `--enrich on` is
passed — pass e.g. `--enrichEmail off` to skip a stage.
`--enrichBudget <usd>` caps total API spend (0 = unlimited);
`--enrichConcurrency N` (default 4) parallelizes the batch;
`--phoneDefaultCountry <ISO>` (e.g. `DE`, `BD`) hints local-format
phone numbers lacking a `+` prefix.

### Phone Normalization (3.1)

Converts every scraped phone to **E.164** format, detects its type
(`mobile` / `landline` / `toll_free` / `voip` / `invalid` / `unknown`),
resolves the ISO 3166-1 alpha-2 country code, and suppresses E.164 for
invalid numbers (so clients filtering on `phone_e164` for auto-dialing
never get a misleading dial string). Built on `libphonenumber-js/max`
— offline, no telco API. Flag: `--enrichPhone on|off` (default on);
`--phoneDefaultCountry <ISO>`. Persisted columns: `phone_e164`,
`phone_type`, `phone_country_code`.

### Address Parsing & Geocoding (3.2)

Parses the raw address string into structured fields
(street/city/state/postal/country). Geocoding to `lat`/`lng` is
**opt-in** via `--geocoder google|nominatim|mock` + `--geocodeApiKey`
+ `--geocodeBudget <usd>` + `--geocodeRateLimitMs`; without a geocoder
the structured fields still populate from the offline parser. Flag:
`--enrichAddress on|off` (default on). Persisted columns:
`address_street`, `address_city`, `address_state`, `address_postal`,
`address_country`, `lat`, `lng`, `geocode_confidence` (0.00–1.00 —
filter `>= 0.8` for high-precision leads).

### Deduplication (3.3)

Fuzzy-matches businesses listed under slightly different names
("McDonald's" vs "McDonalds" vs "McDonald's Restaurant") on
name + phone + address, clusters them into a canonical record, and
tracks the decisions so re-runs are idempotent. Flag: `--enrichDedup
on|off` (default on), `--dedupThreshold 0.00–1.00` (default `0.85` —
the similarity cutoff), `--dedupMerge on|off` (default on; `off` =
detect-only for auditing before enabling merge). Persists cluster
decisions to the `business_duplicates` table (no `businesses`-column
write); a `dedup_result` descriptor feeds lead scoring + confidence.

### Chain Detection & Spam/Fake-Listing Filtering (3.4)

Two always-on analyses: (A) **chain detection** matches the business
name against a curated catalogue of known brands (McDonald's,
Starbucks, Subway, 7-Eleven, …) via token + alias overlap; (B) a
**spam engine** evaluates ~11 heuristics (keyword stuffing, AAA-prefix
names, generic names, suspicious TLDs, no-website service businesses,
phone reuse, rating/review mismatches, …) and emits a `spamScore` +
`riskLevel` (`clean` / `low` / `medium` / `high`). Runs whenever
`--enrich on` is set (no separate flag). Results are in-memory
descriptors (`chain_result`, `spam_result`) that feed lead scoring —
a hard spam cap clamps any listing flagged `isSpam` with
`spamScore >= 65` to lead score 34 — and confidence. No
`businesses`-column write.

### Email Discovery & Verification (3.5)

For every business with a website, generates candidate contact emails
(common local-parts × domain + `mailto:`/page-text scan) and assigns
an `email_status` (`verified` / `unverified` / `invalid` / `no_mx`).
Discovery is heuristic and offline; **SMTP mailbox verification is
opt-in** (network — slow, can look like spam reconnaissance, and many
servers are catch-all). Flag: `--enrichEmail on|off` (default on).
Persisted columns: `email`, `email_status`. Verified emails carry more
weight than unverified ones in the confidence score.

### Website Tech-Stack Detection (3.6)

**Opt-in** (makes live HTTP requests): fetches each business's website,
classifies liveness (`live` / `dead` / `redirected` / `error`), runs a
signature detector over headers + HTML for the CMS / framework /
frontend / e-commerce / hosting / CDN / analytics stack (WordPress,
Shopify, Wix, Squarespace, React, Next.js, Cloudflare, …), and computes
a 0–100 sophistication score. Flag: `--enrichTechStack on|off`.
Persisted columns: `website_tech_stack` (JSONB array),
`website_status_code`, `website_liveness`. Powers the
`digital_maturity` lead-score signal.

### Review Sentiment Analysis (3.7)

Runs AFINN-based sentiment over each business's `top_reviews` and
cross-checks the review-derived polarity against the star rating — a
5.0★ rating paired with scathing review text is a strong fake-listing
tell surfaced as a `rating_review_mismatch` anomaly. Also extracts
aspect themes (food / service / price / ambience). Flag:
`--enrichSentiment on|off` (default on). Persisted columns:
`sentiment_score` (−1.00–+1.00), `sentiment_themes` (JSONB).

### Geo-Metrics (3.8)

For every business, computes spatial analytics relative to the rest of
the batch via haversine: competitor density within 1 km and 5 km
(overall + same-category), geographic isolation, and area-type flags
(dense commercial cluster vs isolated listing — a corroboration signal
for spam). Pure math, no network, no PostGIS requirement (a JS fallback
runs alongside the optional PostGIS GiST index). Flag: `--enrichGeo
on|off` (default on). Persisted columns: `competitor_density_1km`,
`competitor_density_5km`.

### Lead Scoring (3.9)

The capstone stage: fuses every prior signal into a single **0–100
composite** lead score across seven dimensions (legitimacy,
reputation, data_quality, digital_maturity, establishment, uniqueness,
geo), each normalized to 0–100 and combined by fixed per-profile
weights (summing to 1.0). Every subscore carries a human-readable
note, so the score is fully explainable (no black box). Flag:
`--enrichLeadScore on|off` (default on). Persisted columns:
`lead_score`, `lead_score_profile`.

#### Lead-scoring profiles

Each profile weights the seven signals differently to reflect what
makes a listing attractive for a given outreach workflow. The active
profile is selected at the pipeline layer (default `web-agency`); see
**[`ENRICHMENT.md`](ENRICHMENT.md)** for per-run profile selection.

| Profile | When to use | What it prioritizes |
|---|---|---|
| `web-agency` (default) | Selling website redesigns / dev services | Legitimacy, data_quality, establishment; `digital_maturity` is low-weight so a low-maturity site is the *opportunity*, not a disqualifier |
| `reputation-mgmt` | Selling review-management / ORM services | Reputation (heaviest weight — the signal you sell against); under-weights `digital_maturity` |
| `seo-agency` | Selling local SEO services | `digital_maturity` + `data_quality` (need a live site to optimize) + `geo` (local SEO matters) |
| `default` | Balanced baseline / general prospecting | Even split across all seven signals — no signal dominates |

### Confidence Scoring (3.10)

**Distinct from the lead score** — the lead score says *how
attractive* a listing is; confidence says *how well-evidenced* that
score is. A 5.0★ listing with zero reviews and a shaky geocode could
be a great lead or could be spam; confidence surfaces that uncertainty
so operators know which scores to trust and which need more enrichment
before outreach. Eight evidence dimensions (phone / address / dedup /
spam / chain / tech / review / geo coverage) deltas from a neutral
base of 50, banded `very_low` / `low` / `medium` / `high` /
`very_high`. Flag: `--enrichConfidence on|off` (default on). Persisted
column: `confidence_score` (0.00–1.00).

### Grid-Based Geospatial Coverage (3.11)

Google Maps caps search results at ~120 per query — a single
"Restaurant in Toronto" query misses ~95% of the city. Grid coverage
splits a region into a grid of `(lat,lng)` search points (each getting
its own Maps query, e.g. `plumber@43.6532,-79.3832`), so the scraper
harvests the **whole area** instead of the first 120 hits. Overlapping
result sets between adjacent cells are merged by Phase 3.3 dedup. This
is a **search-strategy** module (no `businesses`-column write); the
scraper's main loop calls `gridSearchPoints(region, {query, stepKm})`
to get the list of points to query, and `estimateCoverage()` reports a
coverage ratio (90th-percentile nearest-neighbour distance) as an
operator signal for whether to tighten `stepKm`.

```bash
# Cover a 5km area around downtown Toronto with a grid of search points
node src/index.js --query "Plumber" --location "Toronto" \
  --grid on --gridBounds "43.65,-79.38,5km" --output db --enrich on --yes
```

### Backward Compatibility

`--enrich off` (the default) produces output identical to Phase 2 — no
enrichment columns are populated, no `business_duplicates` rows are
written, and the scraper behaves byte-for-byte like the Phase 2
pipeline. Enrichment runs **outside** the DB transaction so a DB
failure never loses enrichment work, and enrichment columns are
excluded from `data_hash` / change-tracking — a re-enrichment
(algorithm update, different country hint) never triggers
snapshot/field_change rows or bumps `updated_at`; only a real scrape
change does.

## Quick start

```bash
# 1. Clone + install dependencies
npm install
npx playwright install chromium

# 2. Configure (optional — CLI flags override everything)
cp .env.example .env   # then edit DEFAULT_QUERY / DEFAULT_LOCATION

# 3. Run (list-view fields only — fast)
npm start -- --query "Restaurant" --location "Toronto" --maxResults 50

# 4. Run with detail-page deep scrape (slower, ~2-4s/business, richer data)
npm start -- --query "Cafe" --location "Berlin" --deepScrape true --maxResults 20

# 5. QA mode — deep-scrape every 5th business for a fast smoke test
npm start -- --query "Cafe" --location "Berlin" --deepScrape true --deepScrapeSampleStep 5
```

Output is written to `data/{query}_{location}_{timestamp}.*`:
- `.csv` — UTF-8-with-BOM, Excel-safe, 25-column stable schema
- `.json` — full nested data (arrays/objects preserved)
- `.summary.json` — run metadata (query, location, totals, extraction rates, timing, output paths)

### Phase 2 — 10,000-listing overnight run

The canonical Phase 2 acceptance test. Bring up the infrastructure,
submit a multi-query batch to the Redis queue, then run a 5-worker pool
with the full Phase 2 stack (proxies, fingerprint, stealth, session
rotation, incremental cache, CAPTCHA solving, deep-scrape) overnight.
See **[`OPERATIONS.md`](OPERATIONS.md)** for the full runbook and
**[`scripts/run-10k.sh`](scripts/run-10k.sh)** for a wrapper that handles
prerequisite checks + logging.

```bash
# 1. Start infrastructure (one-time)
docker compose up -d
npm run db:migrate

# 2. Populate .env: DATABASE_URL, REDIS_URL, CAPTCHA_API_KEY, PROXY_LIST_FILE

# 3. Submit the 52-query batch + run the 5-worker pool overnight
npm run batch -- --file queries-10k.csv --queue on
npm start -- --workers 5 --queue on --incremental --deepScrape true \
  --captchaProvider 2captcha --proxyStrategy random --sessionLength 50 --endless

# Monitor + review
npm run queue:status              # live dashboard
./scripts/run-10k.sh              # or run the whole flow with this helper
```

## CLI

```
Required:
  --query, -q <string>      What to search (e.g. "Restaurant")
  --location, -l <string>   Where to search (e.g. "Toronto")

Optional:
  --maxResults, --limit <n>  Cap result count (default: all available)
  --outputFile, -o <path>    Output path (default: auto-generated)
  --outputDir <path>         Output directory (default: ./data)
  --headless / --headed      Force browser mode (default: headless)
  --logLevel <level>         debug | info | warn | error (default: info)
  --verbose                  Alias for --logLevel debug
  --dryRun                   Smoke test: run pipeline but write NO output files
  --yes, -y                  Phase 1.10 — skip the 1s startup-banner delay (CI)
  --deepScrape true|false    Phase 1.5 — open each detail panel to fetch
                             hours, popular times, reviews, photos, links
  --deepScrapeSampleStep <n> Scrape every Nth business (1 = all, 5 = QA mode)
  --noDeepScrape             Force --deepScrape false (overrides .env)
  --resume / --fresh         Phase 1.7 — resume from / ignore .checkpoint.json
  --checkpointInterval <n>   Phase 1.7 — write checkpoint every N records (10)
  --maxRetries <n>           Phase 1.7 — retry attempts for transient ops (3)
  --retryBaseMs <ms>         Phase 1.7 — base backoff, doubles each retry (1000)
  --maxRPM <n>               Phase 1.8 — max Google requests per minute (30)
  --noHumanTyping            Phase 1.8 — disable char-by-char search typing
  --noCaptchaPause           Phase 1.8 — don't pause on CAPTCHA (just exit)
  --captchaWaitMs <ms>       Phase 1.8 — CAPTCHA pause duration (300000)
  --output <targets>         Phase 2.1 — output targets, comma-separated:
                             csv, json, db, or all (default: csv,json).
                             db writes to PostgreSQL (requires DATABASE_URL).
                             all = csv,json,db.
  --version                  Print version and exit
  --help, -h                 Show this help
```

## Project structure

```
scraper/
├── src/
│   ├── index.js     (CLI entry; pipeline orchestration + checkpoint)
│   ├── browser.js   (Playwright launch/teardown, withBrowser helper)
│   ├── search.js    (Maps navigation + search submit, retry-wrapped)
│   ├── scroll.js    (Phase 1.3 — infinite-scroll pagination w/ stall detection)
│   ├── extract.js   (Phase 1.4 — core field extraction, 17-field schema, per-record isolation)
│   ├── detail.js    (Phase 1.5 — detail-page deep scrape, 8 detail fields, retry-wrapped)
│   ├── export.js    (Phase 1.6 — CSV + JSON + summary export, RFC 4180 + BOM)
│   ├── retry.js     (Phase 1.7 — withRetry: exponential backoff for transient ops)
│   ├── checkpoint.js (Phase 1.7 — crash-recovery checkpoint: read/write/clear/resume)
│   ├── antiblock.js  (Phase 1.8 — rate limiter, human typing, CAPTCHA detection, UA rotation)
│   ├── banner.js    (Phase 1.10 — startup banner + 1s confirm delay, --yes to skip)
│   ├── config.js    (env + CLI config loader, validation)
│   └── logger.js    (dual-sink logger: console + JSON-lines file)
├── tests/
│   ├── extract.test.js    (Phase 1.4 unit tests — parsers, normalization, rates)
│   ├── detail.test.js     (Phase 1.5 unit tests — parsers, DI failure isolation, e2e)
│   ├── export.test.js     (Phase 1.6 unit tests — RFC 4180, BOM, multi-value, e2e)
│   ├── retry.test.js      (Phase 1.7 unit tests — backoff, retryIf, edge cases)
│   ├── checkpoint.test.js (Phase 1.7 unit tests — dedup, resume, corrupt handling)
│   ├── config.test.js     (Phase 1.7 config tests — new flags + validation)
│   ├── antiblock.test.js  (Phase 1.8 unit tests — rate limiter, human typing, CAPTCHA)
│   ├── logger.test.js     (Phase 1.9 unit tests — phase binding, sinks, memory buffer)
│   └── banner.test.js     (Phase 1.10 unit tests — startup banner, --yes, delay skip)
├── data/            (output CSV/JSON + .checkpoint.json, gitignored)
├── logs/            (run logs, gitignored)
├── .env.example
└── package.json
```

## Phase 1.4 — Core Field Extraction

Each extracted business record has these **15 canonical fields**:

| Field | Type | Source | Notes |
|---|---|---|---|
| `name` | string | List card | Business name |
| `rating` | float | List card | 0–5, `null` if absent |
| `reviews_count` | int | List card | Commas/parens stripped, `null` if absent |
| `price_level` | string | List card | `$` / `$$` / `$$$` / `$$$$`, `null` if absent |
| `category` | string | List card | e.g. "Mexican restaurant" |
| `address` | string | List card | Full address string |
| `phone` | string | List card | Raw tel: string (full normalization is Phase 3) |
| `website` | string | List card | Tracking params (utm_*, gclid, fbclid) stripped |
| `maps_url` | string | Constructed | Absolute Google Maps place URL |
| `place_id` | string | Parsed from URL | `0x…:0x…` CID or `ChIJ…` place_id |
| `plus_code` | string | List card | Open-location code, `null` if absent |
| `open_now` | bool | List card | `true`/`false`/`null` at time of scrape |
| `business_status` | enum | List card | `open` / `temporarily_closed` / `permanently_closed` |
| `is_sponsored` | bool | List card | `true` for ad/sponsored results |
| `scraped_at` | ISO string | Generated | Scrape timestamp |
| `query` | string | From config | What was searched |
| `location` | string | From config | Where it was searched |

### Extraction resilience

- **Multiple fallback selectors per field** — Google reshuffles the DOM often;
  each field has 2–4 candidate selectors tried in order.
- **Per-field extraction-rate log** — printed at end of every run, e.g.
  `phone: 198/200 = 99%`. Fields below 80% trigger a `WARN`.
- **Normalization** — `rating` → float, `reviews_count` → int, `website` →
  tracking-stripped, `phone` → raw, `place_id`/`plus_code` → parsed.
- **Closed businesses are not skipped** — flagged via `business_status`.
- **Sponsored results are flagged** — `is_sponsored: true`.

## Phase 1.5 — Detail-Page Deep Scrape (Optional)

When `--deepScrape true` is passed, the script clicks into each business's
detail panel after the list-view extraction to fetch additional fields not
visible in the list. This is **off by default** to keep runs fast.

Each detail-scraped business gets these **8 additional fields**:

| Field | Type | Source | Notes |
|---|---|---|---|
| `full_hours` | array\[{day,hours}\] | Detail panel | Per-day opening hours; `null` if absent |
| `popular_times` | array\[{day,busy}\] | Detail panel | Busyness histogram per day; `null` if absent (noisy) |
| `top_reviews` | array\[{author,rating,text,date}\] | Detail panel | Top N reviews (configurable, default 5) |
| `photos` | array\[url\] | Detail panel | First N photo URLs (configurable, default 5) |
| `reservation_url` | string | Detail panel | OpenTable/Resy/etc. link; `null` if absent |
| `menu_url` | string | Detail panel | Menu link; `null` if absent |
| `social_profiles` | array\[{platform,url}\] | Detail panel | Instagram/Facebook/X/LinkedIn/YouTube + website |
| `detail_scraped` | bool | Generated | `true` if detail load succeeded, `false` otherwise |

### Deep-scrape resilience

- **Per-business failure isolation** — a failed detail load (timeout, missing
  panel, selector crash) logs a warning and continues; that business keeps its
  list-view fields with `null`/empty detail fields. One bad business never
  crashes the run.
- **Always returns to list** — the `backFn` runs in a `finally` block, so a
  stranded detail panel on business N doesn't strand business N+1.
- **Randomized per-detail delay** (1–3s default) — avoids a metronomic request
  pattern that triggers anti-bot defenses.
- **Hard per-business timeout** (15s default) — a hanging detail page can't
  stall the whole run.
- **Success-rate tracking** — `attempted`, `succeeded`, `failed`, `successRate`,
  `avgMs`/`minMs`/`maxMs` per business, and an error tally. Logged at the end
  of every deep-scrape phase; warns when success rate < 80%.
- **Sample step** — `--deepScrapeSampleStep 5` scrapes every 5th business for
  fast QA smoke-tests against large result sets.
- **Stable output schema** — when `--deepScrape false` (default), every record
  is stamped with empty detail fields so the JSON/CSV shape is identical
  whether or not detail scraping ran (Phase 1.6 CSV column order won't shift).

## Phase 1.6 — CSV / JSON Export Engine

Every run writes **three files** sharing a common base name
(`data/{query}_{location}_{timestamp}.*`):

| File | Purpose |
|---|---|
| `.csv` | UTF-8-with-BOM, RFC 4180 escaping, 25-column stable schema. Opens cleanly in Excel/Sheets/Numbers. |
| `.json` | Full nested data (businesses + summary). Arrays/objects preserved (unlike CSV, which flattens). |
| `.summary.json` | Run metadata only: query, location, totals, per-field extraction rates, deep-scrape stats, timing, output file paths, column order. |

### CSV column order (25 columns)

The 17 canonical list-view fields (Phase 1.4) followed by the 8 detail fields
(Phase 1.5), in a fixed order so downstream pipelines don't break when fields
are added:

```
Name, Rating, Reviews Count, Price Level, Category, Address, Phone, Website,
Maps URL, Place ID, Plus Code, Open Now, Business Status, Sponsored,
Scraped At, Query, Location, Full Hours, Popular Times, Top Reviews, Photos,
Reservation URL, Menu URL, Social Profiles, Detail Scraped
```

### RFC 4180 escaping

- Field with **comma** → wrapped in double quotes: `"Smith, Jones & Co."`
- Field with **double-quote** → doubled and wrapped: `"say ""hi"""`
- Field with **newline** → wrapped in double quotes
- **UTF-8 with BOM** (`\uFEFF`) so Excel opens non-Latin text (Bengali, Arabic,
  emoji) without garbling — e.g. `Café Mününchen ☕`, `ঢাকা Restaurant`
- **CRLF line endings** (RFC 4180 standard)

### Multi-value field serialization

Nested detail fields are flattened to single CSV cells with documented delimiters:

| Field | Format | Example |
|---|---|---|
| `photos` | URLs joined with `\|` | `https://a.jpg\|https://b.jpg\|https://c.jpg` |
| `social_profiles` | `platform:url` joined with `\|` | `instagram:https://ig.com/x\|facebook:https://fb.com/y` |
| `full_hours` | `day: hours` joined with `; ` | `Monday: 9-5; Tuesday: 9-5; Wednesday: Closed` |
| `top_reviews` | JSON string (too structured for delimited) | `[{"author":"Jane","rating":5,...}]` |
| `popular_times` | JSON string (too structured for delimited) | `[{"day":"Monday","busy":[...]}]` |

The JSON sidecar preserves the full nested structure (arrays of objects) for
clients that need it; the CSV is for spreadsheet consumers.

### Hand-rolled (no csv-writer dependency)

The CSV writer is hand-rolled (~120 lines) to match the project's no-deps
philosophy (see `src/config.js`, `src/logger.js`) and to give full control over
BOM, nested-field serialization, and encoding. It's fully unit-tested against
the spec's exact acceptance criteria.

## Testing

```bash
npm test          # bun test tests/ (358 tests, 911 assertions)
npm run syntax    # node --check on every src file
```

Test coverage by phase: extract (67), detail (55), export (69), checkpoint
(37), retry (12), antiblock (91), config (Phase 1.8 flags), **logger (27 —
Phase 1.9)**.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (all businesses extracted/scraped cleanly) |
| 1 | Partial success (run completed but some businesses failed extraction or detail scrape) |
| 2 | Config error (missing/invalid args) |
| 3 | Runtime error (browser crash, selector failure, timeout) |
| 130 | SIGINT (Ctrl-C) — checkpoint preserved for `--resume` |

## Phase 1.7 — Reliability & Crash Recovery

The scraper survives transient failures and resumes from where it left off after
a crash. Three mechanisms work together:

### 1. Retry with exponential backoff

All transient operations (`page.goto`, `waitForSelector`, `page.evaluate`,
detail-panel open/back) are wrapped in `withRetry()`:

- **3 attempts** (configurable via `--maxRetries`)
- **Exponential backoff**: 1s → 2s → 4s (base via `--retryBaseMs`)
- On final failure, the error is re-thrown — the caller logs and skips the
  business (or exits 3 for systemic failures)
- Optional `retryIf` predicate: callers can exclude non-transient errors from
  wasting retry budget

```bash
npm start -- --query "Cafe" --location "Berlin" --maxRetries 5 --retryBaseMs 500
```

### 2. Checkpoint-based crash recovery

During the slow deep-scrape phase, a `.checkpoint.json` file is written to the
output directory every N businesses (default 10, via `--checkpointInterval`).
On the next run, if the checkpoint exists for the same query+location:

- With `--resume`: automatically loads the checkpoint and skips already-
  extracted businesses (deduped by `place_id` or name+address+phone hash)
- Without `--resume` (interactive TTY): prompts `Resume from checkpoint? [y/N]`
- With `--fresh`: ignores and deletes the checkpoint, starts from scratch

On successful completion, the checkpoint is **cleared automatically** — a
leftover checkpoint would cause a stale prompt on the next run. On crash
(Ctrl-C or runtime error), the checkpoint stays on disk for `--resume`.

```bash
# A 500-result run dies at result 200:
npm start -- --query "Restaurant" --location "Toronto" --deepScrape true
# Ctrl-C at result 200

# Resume — continues from ~200, doesn't restart:
npm start -- --query "Restaurant" --location "Toronto" --deepScrape true --resume
```

Already-deep-scraped businesses (with `detail_scraped: true`) are skipped on
resume — only the unfinished ones get re-scraped.

### 3. Per-business error isolation

A failed extraction or detail-scrape is **logged and counted**, never crashes
the run. The run summary tracks:

- **Total found** (from scroll)
- **Successfully extracted** (list-view fields)
- **Failed extraction** (with per-record error reasons)
- **Skipped** (already in checkpoint on resume)
- **Deep-scrape succeeded/failed** (with error breakdown)

The exit code reflects the outcome: `0` = all clean, `1` = partial success
(some failures but run completed), `3` = systemic crash.

## Phase 1.8 — Minimal Anti-Block Behavior

The scraper behaves politely enough to survive normal-size runs without
triggering CAPTCHAs or rate limits. Full anti-detection (proxies,
fingerprinting, CAPTCHA solving) is Phase 2 — here we just practice basic good
citizenship. All tactics live in `src/antiblock.js`.

### 1. Randomized human-like delays

Fixed/metronomic delays are replaced with randomized ranges (visible in debug
logs as `Inter-scroll delay`, `Pre-Enter delay`, etc.):

| Action                     | Range (ms)   | Config env vars                  |
|----------------------------|--------------|----------------------------------|
| Between scroll actions     | 800–2000    | `SCROLL_DELAY_MIN/MAX_MS`        |
| Before pressing Enter      | 500–1500    | `PRE_ENTER_DELAY_MIN/MAX_MS`     |
| Between detail-page visits | 1500–3500   | `DETAIL_DELAY_MIN/MAX_MS`        |
| Per keypress (typing)      | 50–150      | `TYPE_KEY_MIN/MAX_MS`            |

### 2. Human-like typing

The search query is typed character-by-character with 50–150ms jitter per key
instead of Playwright's instant `.fill()`. Visible in `--headed` mode as real
typing. Disable with `--noHumanTyping`.

### 3. Max requests per minute cap

A sliding-window `RateLimiter` (default **30 req/min**) gates every
Google-bound HTTP request (`page.goto` in search + each detail-panel open in
deep-scrape). If the script is going faster than the cap, it waits. Override
with `--maxRPM <n>`.

### 4. CAPTCHA / "unusual traffic" detection

After the search feed appears and after every detail scrape, the page body is
scanned for known block indicators (`unusual traffic`, `captcha`, `recaptcha`,
`not a robot`, etc.). On detection the script:

1. Prints a clear `CAPTCHA DETECTED` alert to stderr
2. Pauses for `--captchaWaitMs` (default 5 min) so the operator can solve it
   in `--headed` mode
3. Aborts with exit code 3 — the checkpoint is preserved for `--resume`

Disable the pause with `--noCaptchaPause` (still exits 3). Auto-solve is
Phase 2.

### 5. HTTP 429 / 503 detection

A `page.on('response')` watcher fires on Google 429 / 503 responses, logging
a warning with the status + URL. These combine with the rate limiter and
Phase 1.7 retry/backoff to handle transient throttling.

### 6. User-agent rotation

A user-agent is picked at random per run from a list of 8 recent real desktop
Chrome UAs (Windows / macOS / Linux) so each run looks like a different
machine.

```bash
# Polite default run (30 RPM, human typing, CAPTCHA pause on):
npm start -- --query "Cafe" --location "Berlin" --maxResults 200

# Aggressive QA mode (faster, still anti-block basics):
npm start -- --query "Cafe" --location "Berlin" --maxRPM 60 --noHumanTyping

# Headed run so you can solve a CAPTCHA manually if one appears:
npm start -- --query "Cafe" --location "Berlin" --headed --captchaWaitMs 600000
```

## Phase 1.9 — Logging & Observability

Every log line — console and file — carries a structured `phase` tag so an
operator can filter the JSON-lines log file by pipeline stage after the fact.

### Phases

| Phase | Where it's emitted |
|---|---|
| `system` | Config resolved, run complete, global timeout, SIGINT |
| `browser` | Browser launched (UA, viewport, headless mode) |
| `search` | Navigating to Maps, search submitted, results feed detected |
| `scroll` | Scroll loop start/progress/stop (with page number) |
| `extract` | Each business extracted (index, name, success/fail), per-field debug, rate summary |
| `detail` | Deep-scrape start/progress/complete, each detail outcome with timing |
| `export` | CSV/JSON/summary written (path, rows, bytes) |
| `recovery` | Checkpoint resume decisions |
| `antiblock` | Rate-limit pauses, 429/503 detection |
| `retry` | Transient-operation retry warnings |

### Console output

The console shows a dim `[phase]` tag on every line for scannability:

```
[2026-08-07T15:30:00.000Z] INFO  [system] Config resolved
[2026-08-07T15:30:01.234Z] INFO  [browser] Browser launched
[2026-08-07T15:30:02.456Z] INFO  [search] Search submitted
[2026-08-07T15:30:03.789Z] INFO  [scroll] Scroll progress
[2026-08-07T15:30:04.012Z] INFO  [extract] Business extracted
```

### Log file (JSON lines)

Every run writes `logs/{query}_{location}_{timestamp}.log`. Each line is a JSON
object with `ts`, `level`, `phase`, `msg`, and any context fields:

```json
{"ts":"2026-08-07T15:30:04.012Z","level":"info","phase":"extract","msg":"Business extracted","index":5,"name":"Joe's Diner","success":true,"sponsored":false,"status":"open"}
```

Filter by phase after a run:

```bash
jq 'select(.phase=="extract")' logs/Restaurant_Toronto_*.log | head
jq 'select(.level=="warn" or .level=="error")' logs/Restaurant_Toronto_*.log
```

### `--logLevel debug`

At debug level, every business emits a per-field breakdown so a missing
selector is obvious:

```
[extract] Normalized fields  index=5 name="Joe's Diner" fields={name:"Joe's Diner",rating:4.5,reviews_count:128,...,phone:null,...}
```

### End-of-run summary

The console banner now includes the log file path:

```
========================================
Run complete
Query:    Restaurant in Toronto
Results:  342 extracted (342 loaded, reason=endOfList)
Duration: 252.4s
Detail:   disabled (--deepScrape false)
CSV:      /home/z/Scraper/data/Restaurant_Toronto_2026-08-07_15-30-00.csv
JSON:     /home/z/Scraper/data/Restaurant_Toronto_2026-08-07_15-30-00.json
Summary:  /home/z/Scraper/data/Restaurant_Toronto_2026-08-07_15-30-00.summary.json
Log:      /home/z/Scraper/logs/Restaurant_Toronto_2026-08-07_15-30-00.log
========================================
```

A structured `Run complete` log line (phase: system) is also written to the
log file with duration, counts, and exit code for machine-parseable post-run
analysis.

## Phase 1.10 — CLI Polish & Developer Experience

A tool you have to fight is a tool you stop using. Phase 1.10 makes the
script pleasant to run, easy to debug, and self-documenting from the command
line.

### Startup banner

Before any browser is launched, the script prints a compact snapshot of the
**resolved** configuration so the operator gets one last chance to eyeball
"what am I about to run?" and `Ctrl-C` if something looks wrong (wrong city,
`--dryRun` off by accident, `--deepScrape` unexpectedly on, etc.):

```
========================================
gmaps-scraper v0.10.0
----------------------------------------
  Query             Cafe
  Location          Berlin
  Max results       50
  Output dir        ./data
  Output file       (auto)
  Dry run           no
  Headless          yes
  Log level         info
  Deep scrape       no
  Resume            no
  Fresh             no
  Checkpoint every  10 records
  Retry             3× (base 1000ms)
  Max RPM           30
  Human typing      yes
  CAPTCHA pause     yes (300000ms)
----------------------------------------
Starting in 1.0s — Ctrl-C to abort, --yes to skip.
========================================
```

The banner is followed by a **1-second delay** (so a human can react). The
delay is skippable with `--yes` (alias `-y`) for scripted / CI runs — the
banner still prints, but the run starts immediately:

```
  ...
  Starting immediately (--yes).
  ...
```

### CLI surface (Phase 1.10 checklist)

| Feature | Status |
|---|---|
| `--help` with every flag + usage example | ✅ |
| `--version` (reads `package.json`) | ✅ |
| `--dryRun` (full pipeline, no file writes) | ✅ |
| `--limit N` (alias for `--maxResults`) | ✅ |
| `--headless` / `--headed` overrides | ✅ |
| `--verbose` (alias for `--logLevel debug`) | ✅ |
| Startup banner + 1s confirm delay | ✅ |
| `--yes` / `-y` to skip the banner delay | ✅ |
| Friendly config errors (no stack traces) | ✅ |
| Exit codes 0 / 1 / 2 / 3 / 130 | ✅ |

## Troubleshooting

### Google shows a CAPTCHA / "Our systems have detected unusual traffic"

Google flags automated traffic. The scraper detects this (Phase 1.8) and
**pauses** for `CAPTCHA_WAIT_MS` (default 5 min) so you can solve it in a
`--headed` window, then aborts with exit code `3` — **leaving the checkpoint
on disk** so you can continue.

```bash
# 1. Rerun headed so you can see / solve the CAPTCHA
npm start -- --query "Restaurant" --location "Toronto" --headed --resume

# 2. If it keeps happening, lower the request rate
npm start -- --maxRPM 15 --query "Restaurant" --location "Toronto" --resume

# 3. Wait it out — blocks usually clear in a few hours. Then:
npm start -- --query "Restaurant" --location "Toronto" --resume
```

Prevention: keep `--maxRPM` at or below 30 (the default), leave human typing
on (the default), and avoid re-running the same query/location back-to-back.
Auto-solving CAPTCHAs is explicitly **Phase 2** scope (see `SCRAPER_FEATURES.md`).

### No results / "Results feed detected" never logs

- **Wrong query spelling or location granularity.** Try a broader location
  (e.g. `Toronto` instead of `Downtown Toronto ON`).
- **Google rendered the page in a non-English locale.** The scraper forces
  `hl=en` on the Maps URL, but if you're behind a regional redirect, add the
  country to the location: `"Dhaka, Bangladesh"`.
- **The results feed selector changed.** Check `SELECTORS.md` for how to
  inspect the live DOM and update the feed-detection selector.
- Run with `--verbose` (alias `--logLevel debug`) to see every scroll step
  and the raw result count.

### `Error: Executable doesn't exist at .../chromium-*/chrome` (Playwright not installed)

Playwright's npm package is JS-only; the browser binaries are a separate
download. Install them once after `npm install`:

```bash
npx playwright install chromium
```

If you're on a fresh OS image you may also need system deps:

```bash
npx playwright install-deps chromium   # Linux (apt)
```

### CSV opens in Excel with garbled non-Latin text (Bengali, Arabic, emoji)

The CSV is written **UTF-8 with BOM** (`\uFEFF`) and **CRLF** line endings
(RFC 4180) specifically so Excel auto-detects the encoding. If you still see
garbling:

- **You opened it as plain text first.** Open the `.csv` directly from
  Excel's *File → Open* (don't paste it in).
- **Excel's default import codec is wrong.** Use *Data → From Text/CSV* and
  pick `65001: Unicode (UTF-8)`.
- **You re-saved it from a text editor** that stripped the BOM. Re-export
  from the `.json` sidecar, or rerun the scraper.

### Encoding issues in the JSON sidecar

The `.json` file is UTF-8 (no BOM — JSON spec forbids it). Any modern parser
(Node, Python `json`, `jq`) handles it natively. If your tool shows `\uXXXX`
escapes, that's normal JSON Unicode escaping — the data is correct.

### The run finished but there's no CSV in `data/`

You almost certainly ran with `--dryRun`. That flag runs the **entire** pipeline
(launch browser → search → scroll → extract) but **writes no files** — it only
logs where it *would* have written them. Check the end of your log; you'll see:

```json
{"msg":"Dry run — skipping file output","wouldWrite":"data\\dryrun"}
{"msg":"Run complete", ... "csv":null, "json":null}
```

Re-run **without** `--dryRun` to actually produce the CSV:

```bash
npm start -- --query "Cafe" --location "Berlin" --maxResults 10
```

### Extraction rates show `phone`, `website`, `plus_code`, `price_level` at 0%

This is **expected** on modern Google Maps list-view cards — Google removed
those fields from the compact list layout. They live on the **detail panel**
now, so enable deep scrape to populate them:

```bash
npm start -- --query "Cafe" --location "Berlin" --deepScrape true
```

The extraction-rate reporter surfaces this as a `WARN (<80%)` line by
design — it's an early-warning signal, not a bug.

### The run crashed partway — how do I continue?

A `.checkpoint_{query}_{location}.json` file is left in `data/`. Just rerun
with `--resume`:

```bash
npm start -- --query "Restaurant" --location "Toronto" --resume
```

The scraper reloads the already-extracted businesses, re-searches +
re-scrolls (a live browser session can't be restored, only the data), and
**skips businesses already in the checkpoint** by `place_id` (or a
name+address+phone hash as fallback). To start completely fresh instead:

```bash
npm start -- --query "Restaurant" --location "Toronto" --fresh
```

### Exit code reference

| Code | Meaning |
|---|---|
| `0` | Success — all businesses extracted cleanly |
| `1` | Partial success — run completed but some businesses failed (see logs) |
| `2` | Config error — bad CLI input (e.g. `--maxResults abc`) |
| `3` | Runtime error — crash or CAPTCHA abort (checkpoint preserved for `--resume`) |
| `130` | `Ctrl-C` / `SIGINT` (checkpoint preserved) |

### Run aborted with exit code 3 (Phase 2.11 selector failure)

The Phase 2.11 self-healing selector subsystem aborted the run — either
the startup health check or the first-batch abort (after 10 businesses)
found core fields (`name`, `rating`, `reviews_count`, `address`) below
50%. This means Google changed the Maps DOM. To recover:

1. Inspect `data/selector-debug/` — `<field>_<timestamp>.html` files
   contain 500-char card snippets from the failed run.
2. Re-capture fixtures with `npm run capture-fixtures` (dev-only; needs
   a live browser session) against a known query.
3. Update the selectors in `src/extract.js` (add/update fallbacks per
   `SELECTORS.md`).
4. Bump the version + `lastVerifiedDate` in `src/selectors/version.js`.

Temporary workaround for emergency runs: `--skipHealthCheck` bypasses
both the startup check and the first-batch abort (the run continues, but
extraction rates will be poor until selectors are fixed).

### All proxies burned

Either the proxy provider has an outage, the pool is too small for the
request rate, or the scraper is being too aggressive. Fix:

- Lower `--maxRPM` (e.g. 15 instead of 30).
- Increase the proxy pool — add more lines to the file passed to
  `--proxyListFile`.
- Check `--proxyCooldownMs` (default 10 min); if the run is shorter than
  the cooldown, burned proxies never recover. Lower it for short runs.
- Inspect `data/proxy_burn_log.jsonl` for per-proxy burn reasons
  (403/429 / timeout / 407). HTTP 407 (auth) means the credentials are
  wrong; those proxies are removed permanently — fix the credentials in
  the list file.

### CAPTCHA budget exceeded early

The run is hitting more CAPTCHAs than expected — either the IP/proxy is
flagged or the budget is too low for the workload.

- Raise `--captchaBudget` (default $5.00; ~$0.003/solve for 2captcha,
  ~$0.002 for anticaptcha, ~$0.0008 for capsolver).
- Reduce `--workers` — fewer parallel sessions means fewer simultaneous
  CAPTCHA triggers.
- Check whether the IP/proxy is flagged: a single-worker `--maxResults 20`
  smoke test should produce 0–1 CAPTCHAs; if it produces 5+, the IP is
  burned. Rotate proxies.
- Use `--captchaProvider mock` for $0 smoke tests — returns a fake token,
  no API call. Useful for verifying the orchestrator wiring without
  spending money.

### Workers retiring (pool shrinking)

The site is blocking workers faster than they can cool down + revive.
Each retired worker (after `--workerCrashLimit` crashes in 10 min,
default 3) drops the pool size, so throughput collapses. Fix:

- Increase `--workerCooldownMs` (default 5 min) so blocked workers stay
  out longer before revival.
- Lower `--maxRPM` so each worker is less aggressive.
- Rotate proxies (`--proxyStrategy random`) and ensure the pool has
  enough healthy proxies.
- Reduce `--workers` so the remaining workers each get more proxy
  headroom.

### Heap / RSS growing

Chrome memory leaks accumulate over long runs. Fix:

- Set `--contextRestartEvery 25` (default 50) to force-restart each
  browser context more frequently, clearing leaks.
- Lower `--workers` (each Chromium ~150–300MB).
- Check for orphaned Chromium processes — the zombie reaper cleans these
  at startup + shutdown + hourly in `--endless` mode, but a hard kill
  (`SIGKILL`) bypasses it. Run `pgrep -af chromium` and `kill` stragglers.
- Monitor via `--healthPort <port>` then
  `curl http://127.0.0.1:<port>/health` — the JSON response includes
  `heap`, `rss`, `workers`, `queueDepth`, `endless`. Status `degraded`
  (HTTP 200) means pressure; `unhealthy` (HTTP 503) means the
  degradation sequence is actively running.

### Queue stalled / not draining

The worker isn't pulling jobs off BullMQ. Fix:

- Check Redis is up: `docker compose ps redis` (or `redis-cli ping`).
- Check `--redisUrl` (or `REDIS_URL` in `.env`) points to the right
  instance.
- `npm run queue:status` shows active + failed counts; failed jobs have
  exhausted `--queueAttempts` (default 3) and are in the dead-letter
  queue. Retry with `npm run queue:status -- --retryAll` or
  `--retry <jobId>`.
- If the worker process crashed mid-job, BullMQ auto-re-queues the job
  when the connection drops — restart the worker and it will resume.

### Incremental not caching (second run isn't fast)

The second run of the same (query, location) should be ~80% faster, but
isn't. Fix:

- Ensure `--output db` + `--incremental` are both set. Incremental mode
  requires the database (freshness is tracked in PostgreSQL via the
  `last_list_scraped` column).
- Run `npm run db:migrate` after upgrading — the Phase 2.12 columns
  (`last_list_scraped`, `last_detail_scraped`, `change_hash`) are added
  idempotently by the migration. Rows scraped before the migration will
  not be fresh until re-scraped once.
- Check the `last_list_scraped` column freshness:
  ```sql
  SELECT place_id, last_list_scraped, last_detail_scraped
  FROM businesses WHERE query='Cafe' AND location='Berlin'
  ORDER BY last_list_scraped DESC LIMIT 5;
  ```
- `--listFreshnessDays 0` forces a full re-scrape (treats every business
  as stale) — useful for debugging or one-off refreshes.
- `--noDetailCache` ignores the detail cache TTL and forces deep-scrape;
  the list-view incremental still applies.

### 0% detail-scrape success

The detail-panel selectors are broken (or the detail panel never opens).
Deep-scrape attempts return `detail_scraped: false` for every business.
Fix:

- Run a small debug scrape: `npm start -- --query "Cafe" --location
  "Berlin" --deepScrape true --maxResults 5 --verbose`. The per-business
  `triedSelectors` + `beforeUrl`/`afterUrl` diagnostics reveal what's
  failing.
- Check `data/selector-debug/` for detail-panel HTML snippets (Phase
  2.11 debug dumps fire when detail-field rates drop below 80%).
- If the detail panel never opens (vs. opens but selectors miss), the
  issue is in `src/detail.js` — see `SELECTORS.md` for the open/extract
  flow + fallback strategy.

## Known limitations (Phase 1 scope)

These are **deliberately deferred** to later phases (see `SCRAPER_FEATURES.md`):

- **No proxy / IP rotation.** All requests come from one IP. Sustained runs
  against the same query/location will eventually trip a CAPTCHA. Phase 2
  adds a proxy pool.
- **No auto-CAPTCHA solving.** On detection the scraper pauses (so you can
  solve it in a `--headed` window) then aborts with the checkpoint
  preserved. Auto-solve is Phase 2.
- **Single concurrent run.** One browser, one query, sequential extraction.
  Parallelism (multiple workers / queries) is Phase 3.
- **List-view field gaps.** `phone`, `website`, `plus_code`, and
  `price_level` are absent from modern list-view cards — populate them with
  `--deepScrape true` (Phase 1.5), which opens each detail panel
  (~2–4 s/business).
- **Selectors are DOM-coupled.** Google reshuffles the Maps DOM frequently.
  When a field's extraction rate drops, see `SELECTORS.md` for how to
  inspect the live DOM and add/update a fallback selector. There is no
  machine-learning fallback in Phase 1.
- **No incremental / scheduled runs.** Each run is a fresh search + scroll.
  Delta detection ("what changed since last week?") is Phase 4.
- **`commonjs`, not ESM.** The codebase uses `require()`/`module.exports`
  for Node 20 compatibility with zero build step. ESM migration is Phase 5
  housekeeping.
- **No GUI.** CLI only. A web dashboard is Phase 5.

## Roadmap

Phase 1 (tagged `v1.0.0-phase1`) delivers a **single-query,
single-machine, CSV-exporting** scraper that's robust against transient
failures and polite to Google. The master roadmap in
**[`SCRAPER_FEATURES.md`](SCRAPER_FEATURES.md)** covers Phases 2–5:

- **Phase 2 — Robustness & Scale** *(in progress, `phase2` branch)*: rotating
  proxies, browser fingerprint randomization, stealth patches, CAPTCHA
  auto-solving, multi-worker concurrency, job queue (BullMQ/Redis), PostgreSQL
  persistence with change tracking, self-healing selectors, and incremental
  scraping. Target: survive a 10,000+ listing overnight run unattended. See
  **[`PHASE2_EXECUTION_PLAN.md`](PHASE2_EXECUTION_PLAN.md)** for the granular
  13-sub-phase spec.
  - **2.0 — Audit, Fixtures & Dependency Setup** ✅ — baseline metrics, DOM
    fixtures, deps installed, `docker-compose.yml`.
  - **2.1 — PostgreSQL Persistence Layer** ✅ — `src/db.js` (idempotent upserts
    keyed by `place_id`, change-hash no-op detection, batched writes,
    transaction rollback), `schema.sql`, `npm run db:migrate`, `--output
    csv|json|db|all` flag. 475 tests / 1169 assertions.
  - **2.2 — Change Tracking & History** ✅ — `business_snapshots` +
    `field_changes` tables, `src/db/deltas.js` (pure `computeChanges` /
    `numericDelta`), snapshot-on-update, `changes_detected` on `scrape_runs`,
    `npm run db:history` CLI, change-breakdown banner. 551 tests / 1407 assertions.
  - 2.3–2.13 — proxies, fingerprints, stealth, CAPTCHA,
    sessions, worker pool, job queue, memory mgmt, self-healing selectors,
    incremental scraping, final integration *(not started)*.
- **Phase 3 — Data Quality & Enrichment:** phone/email normalization &
  validation, email discovery, deduplication, lead scoring, grid-based
  geo-coverage.
- **Phase 4 — Client Delivery & Monetization:** web dashboard, REST API,
  Stripe billing, CRM integrations, subscription tiers.
- **Phase 5 — Enterprise & World-Class:** distributed workers, Grafana
  monitoring, LLM-powered extraction, multi-source federation (Yelp, OSM,
  LinkedIn), real-time delta feeds, white-label.

See `PHASE1_EXECUTION_PLAN.md` for the granular Phase 1 sub-phase spec and
acceptance criteria, `PHASE2_EXECUTION_PLAN.md` for Phase 2, and
`CHANGELOG.md` for what shipped in each release.

## PostgreSQL persistence (Phase 2.1)

Scraped businesses can be upserted into PostgreSQL alongside (or instead of)
CSV/JSON files. Every business is keyed by `place_id`, so re-scraping the same
business updates the row instead of duplicating it; re-scraping with identical
data is a no-op (detected via a SHA-256 `data_hash` column).

### Quick start

```bash
# 1. Start PostgreSQL (one-time — docker-compose.yml ships Postgres 15 + Redis 7)
docker compose up -d postgres

# 2. Copy .env.example → .env and set DATABASE_URL
cp .env.example .env
# Edit .env:  DATABASE_URL=postgresql://gmaps:gmaps@localhost:5432/gmaps_scraper

# 3. Create the schema (idempotent — safe to re-run)
npm run db:migrate

# 4. Scrape to Postgres (or --output all for CSV + JSON + DB)
npm start -- --query "Cafe" --location "Berlin" --output db --yes
```

### Output targets

The `--output` flag (or `OUTPUT` env var) selects where results go:

| Target | Writes | Requires |
|---|---|---|
| `csv` (default) | `data/*.csv` | nothing |
| `json` (default) | `data/*.json` + `*.summary.json` | nothing |
| `db` | `businesses` + `scrape_runs` tables | `DATABASE_URL` (postgresql://) |
| `all` | CSV + JSON + DB | `DATABASE_URL` |

Comma-separated combinations work: `--output csv,db` writes CSV and Postgres
but skips JSON.

### Schema

Four tables (see `src/db/schema.sql`):

- **`businesses`** — one row per scraped business, keyed by `place_id` (UNIQUE).
  All 25 scraped fields (17 canonical list-view + 8 detail-scrape) plus
  `data_hash`, `run_id` (FK → `scrape_runs`), `updated_at`. Indexes on
  `place_id`, `(query, location)`, `scraped_at`, `business_status`, `updated_at`.
- **`scrape_runs`** — one row per pipeline invocation: query, location, timing,
  extracted/failed counts, exit code, log path, DB upsert counts
  (`db_inserted`, `db_updated`, `db_unchanged`), and `changes_detected`
  (Phase 2.2 — total field-level changes written this run).
- **`business_snapshots`** *(Phase 2.2)* — pre-update snapshot of the five
  high-value tracked fields (`rating`, `reviews_count`, `business_status`,
  `phone`, `website`) captured before every UPDATE. Indexed on
  `(business_id, snapshot_at DESC)`.
- **`field_changes`** *(Phase 2.2)* — computed, queryable per-field delta log
  (one row per field that changed, with `old_value`/`new_value`/`delta`).
  Indexed on `(business_id, field, detected_at DESC)`.

### Idempotent upserts

`upsertBusinessesBatch` classifies each business as `inserted`, `updated`, or
`unchanged` by comparing a SHA-256 hash of the comparable field values against
the stored `data_hash`. Only `updated` rows bump `updated_at` — identical
re-scrapes produce zero writes (and zero snapshots/changes — no noise). The
end-of-run banner reports the counts:

```
DB:       50 inserted, 30 updated (12 rating changes, 8 review-count changes, 2 status changes), 20 unchanged (run #3)
```

All queries are parameterized (no SQL injection surface). Writes happen in a
single transaction per run; a failure rolls back and is logged as a partial-
success (exit code 1) without discarding any CSV/JSON files already written.

## Change tracking & history (Phase 2.2)

Every time a business is re-scraped and its data has changed, the scraper now
snapshots the **old** values into `business_snapshots` and logs one
`field_changes` row per tracked field that actually changed. This turns the
scraper from a "snapshot tool" into a **trend data tool** — the foundation for
delta alerts (Phase 5) and freshness scoring.

### Tracked fields

Five high-value columns (the ones clients pay a premium for trend data on):

| Field | Delta type | Example change |
|---|---|---|
| `rating` | numeric (Δ) | 4.5 → 4.3 (Δ -0.2) |
| `reviews_count` | numeric (Δ) | 1234 → 1289 (Δ +55) |
| `business_status` | text (null delta) | open → permanently_closed |
| `phone` | text (null delta) | +1-555-0100 → +1-555-0200 |
| `website` | text (null delta) | https://old.example.com → null |

Re-scraping with **identical** data produces zero snapshots and zero changes
(detected via the `data_hash` no-op path from Phase 2.1 — no noise).

### Viewing a business's history

`npm run db:history` prints the full change timeline for a single business
(keyed by `place_id`), most recent first:

```bash
npm run db:history -- --placeId ChIJxxx
# or with aliases:
npm run db:history -- -p ChIJxxx --limit 20
```

```
Business:  Test Cafe (ChIJxxx)
Current:   rating 4.3 | reviews 1289 | status open | phone +1-555-0100 | website https://example.com

Timeline (5 change events, 2 snapshots):
  2026-08-07 14:03  rating 4.5 → 4.3  (Δ -0.2)
  2026-08-07 14:03  reviews 1234 → 1289 (Δ +55)
  2026-07-01 09:12  rating 4.6 → 4.5  (Δ -0.1)
  2026-06-15 18:44  status open → temporarily_closed
  2026-06-15 18:44  phone +1-555-0100 → +1-555-0200
```

Flags: `--placeId <id>` (required), `--place-id`/`-p` aliases, `--limit N`
(default 100), `--help`/`-h`. A positional connection string overrides
`DATABASE_URL`. The pure formatting helpers are exported from
`src/db/history.js` for unit testing.

### Transactional snapshotting

The snapshot + field_changes writes run **inside the same BEGIN/COMMIT
transaction** as the `businesses` UPDATE (in `persistRunResults`). A crash
mid-upsert rolls back the snapshot, the changes, and the update atomically —
the database is never left in a state where the old values were snapshotted
but the update didn't happen (or vice versa).


## Proxy management & rotation (Phase 2.3)

Phase 2.3 introduces a configurable proxy pool that sits between the scraper
and Google. Every browser launch (or every N requests, via `--sessionLength`)
pulls a different proxy from the pool. Burned proxies (3 consecutive 403/429,
<50% success rate over last 20 requests, 3 consecutive timeouts) are benched
for a cooldown window; permanently bad proxies (HTTP 407, provider-reported
retired) are removed entirely.

### Quick start

Create a proxy list file (one proxy per line):

```bash
# proxies.txt — accepted formats per line:
#   protocol://[user:pass@]host:port   e.g. http://u:p@1.2.3.4:8080
#   host:port:user:pass                e.g. 1.2.3.4:8080:u:p
#   host:port                           (no auth — public proxy)
http://user1:pass1@1.2.3.4:8080
http://5.6.7.8:3128
socks5://9.10.11.12:1080
```

Run with proxy rotation:

```bash
npm start -- --query "Cafe" --location "Berlin" --proxyListFile ./proxies.txt
npm start -- --query "Cafe" --location "Berlin" --proxyListFile ./proxies.txt --proxyStrategy round-robin
npm start -- --query "Cafe" --location "Berlin" --proxyListFile ./proxies.txt --proxyHealthCheck
```

Or via env vars (in `.env`):

```bash
PROXY_LIST_FILE=./proxies.txt
PROXY_STRATEGY=random
SESSION_LENGTH=1
PROXY_COOLDOWN_MS=600000
```

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `--proxyListFile <path>` | — | Proxy list file (one proxy per line) |
| `--proxyStrategy <s>` | `random` | `round-robin` \| `random` \| `sticky` |
| `--sessionLength <n>` | `1` | Requests per proxy before rotation (sticky only) |
| `--proxyCooldownMs <ms>` | `600000` | Burn cooldown window (10 min) |
| `--proxyHealthCheck` | off | Probe every proxy with a HEAD before scraping |
| `--noProxy` | off | Force direct connection (Phase 1 behavior) |

### Rotation strategies

- **`round-robin`** — cycle through the pool sequentially. Deterministic, best
  for evenly distributing load across a small pool.
- **`random`** (default) — pick uniformly at random. Better for large pools
  where round-robin's predictability could be fingerprinted.
- **`sticky`** — same proxy per session of N requests (`--sessionLength N`).
  Useful when Google's session cookies should stay consistent within a session.

### Burn detection

The burn detector (`src/proxy/burn-detector.js`) tracks per-proxy:
- request count, success count, last 10 status codes
- consecutive failures (resets on success)
- consecutive timeouts (resets on any non-timeout outcome)
- state: `healthy` | `cooldown` | `burned` (permanent)

Auto-burn rules:
- **3 consecutive 403/429** → cooldown (10 min default)
- **Success rate < 50%** over last 20 requests (min 5 samples) → cooldown
- **3 consecutive timeouts** (`statusCode === 'TIMEOUT'`) → cooldown
- **HTTP 407** (Proxy Authentication Required) → permanent (removed entirely)

Cooldown proxies auto-recover after `PROXY_COOLDOWN_MS`. Permanent proxies
never recover.

### Burn log

Every burn event is appended to `data/proxy_burn_log.jsonl` with timestamp,
proxy id, reason, recent status codes, provider, and burn kind. Used for ops
debugging and provider charge disputes.

```json
{"ts":"2026-08-07T16:08:24.501Z","kind":"cooldown","proxyId":"1.1.1.1:80","reason":"3 consecutive 403/429 responses","recentStatusCodes":[403,403,403],"provider":"file","stats":{...}}
{"ts":"2026-08-07T16:08:24.502Z","kind":"permanent","proxyId":"2.2.2.2:80","reason":"provider retired IP","manual":true,"provider":"manual","stats":{...}}
```

### Health check

`--proxyHealthCheck` probes every proxy with a HEAD to `google.com/robots.txt`
before scraping starts. Failed proxies are benched for one cooldown cycle. If
all proxies fail, the run aborts with exit code 3.

### End-of-run banner

The banner now includes a `Proxy:` line showing healthy/cooling/burned counts
+ strategy + avg success rate:

```
========================================
Run complete
Query:    Cafe in Berlin
Results:  50 extracted (50 loaded, reason=maxResults)
Duration: 42.3s
Detail:   disabled (--deepScrape false)
CSV:      data/cafe_berlin_2026-08-07_160824.csv
JSON:     data/cafe_berlin_2026-08-07_160824.json
Summary:  data/cafe_berlin_2026-08-07_160824_summary.json
Proxy:    4/5 healthy, 1 cooling, 0 burned (round-robin, 96% success)
Log:      logs/cafe_berlin_2026-08-07_160824.log
========================================
```

### Design notes

- **`--noProxy` preserves Phase 1 behavior.** When proxy rotation is disabled
  (the default), the scraper launches a direct browser with no proxy — exactly
  the Phase 1 code path.
- **CAPTCHA → 429 mapping.** When the pipeline aborts with `CAPTCHA_DETECTED`,
  the proxy is released with `statusCode: 429` (not `'TIMEOUT'`). This feeds
  the consecutive-block burn rule: 3 CAPTCHAs from the same proxy → cooldown.
  The signal is correct — a CAPTCHA means Google is rate-limiting that IP.
- **Provider API integration is Phase 2.7.** The `PROXY_PROVIDER` env var is
  parsed and validated but the actual provider fetch is a stub that returns an
  empty list. Use `--proxyListFile` for now; Bright Data / Smartproxy / Oxylabs
  integration lands in Phase 2.7 (Session & Cookie Rotation).
