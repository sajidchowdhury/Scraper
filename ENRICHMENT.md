# Enrichment Runbook (Phase 3)

## 1. Purpose

This runbook describes how to operate the Phase 3 enrichment pipeline: the
post-scrape stage that turns raw Google Maps listings into verified,
normalized, deduplicated, enriched, scored leads. It covers the canonical
end-to-end invocation, a feature-by-feature reference for all 11 enrichment
sub-systems, budgeting for the paid network phases, provider setup, the four
lead-scoring profiles, the grid-coverage guide for whole-city scraping,
troubleshooting, backward-compatibility guarantees, and the full persisted-
columns reference.

> **Milestone:** Phase 3 (sub-phases 3.0–3.12 complete, version
> `3.0.0-phase3`). Every enrichment feature is **opt-in**. With `--enrich off`
> (the default) the scraper behaves byte-for-byte like Phase 2 — no
> enrichment runs, no enrichment columns are written, no network calls are
> made beyond what Phase 2 already does. See
> [§9 Backward compatibility](#9-backward-compatibility).
>
> **Companion docs:**
> - [`OPERATIONS.md`](OPERATIONS.md) — Phase 2 production runbook (10k-listing
>   overnight run, proxy + CAPTCHA budgeting, monitoring, recovery).
> - [`ARCHITECTURE.md`](ARCHITECTURE.md) — system architecture and module map.
> - [`PHASE3_EXECUTION_PLAN.md`](PHASE3_EXECUTION_PLAN.md) — granular per-sub-phase
>   spec, acceptance criteria, and status (Phase 3 complete).

## Table of contents

1. [Purpose](#1-purpose)
2. [Quick start](#2-quick-start)
3. [Feature-by-feature reference](#3-feature-by-feature-reference)
   - [3.1 Phone normalization](#31-phone-normalization)
   - [3.2 Address parsing & geocoding](#32-address-parsing--geocoding)
   - [3.3 Deduplication](#33-deduplication)
   - [3.4 Chain detection & spam filtering](#34-chain-detection--spam-filtering)
   - [3.5 Email discovery & verification](#35-email-discovery--verification)
   - [3.6 Tech-stack detection](#36-tech-stack-detection)
   - [3.7 Review sentiment](#37-review-sentiment)
   - [3.8 Geo-metrics](#38-geo-metrics)
   - [3.9 Lead score](#39-lead-score)
   - [3.10 Confidence](#310-confidence)
   - [3.11 Grid coverage](#311-grid-coverage)
4. [Budgeting](#4-budgeting)
5. [Provider setup](#5-provider-setup)
6. [Lead-scoring profiles](#6-lead-scoring-profiles)
7. [Grid-coverage guide](#7-grid-coverage-guide)
8. [Troubleshooting](#8-troubleshooting)
9. [Backward compatibility](#9-backward-compatibility)
10. [Persisted columns reference](#10-persisted-columns-reference)

---

## 2. Quick start

The enrichment pipeline chains 11 sub-phases (3.1 → 3.11) after each scrape.
Every sub-phase is ON by default once `--enrich on` is passed, but the three
**network** sub-phases (geocoding, SMTP email verification, tech-stack HTTP
fetch) require additional opt-in flags — so the default enriched run is fully
offline and costs $0.

### Default run — fully offline, $0 cost

```bash
node src/index.js \
  --query "Restaurant" \
  --location "Toronto" \
  --maxResults 100 \
  --output db \
  --enrich on \
  --phoneDefaultCountry CA \
  --yes
```

What this does:
- Scrapes 100 Toronto restaurants into PostgreSQL (Phase 2 behavior).
- Runs the enrichment pipeline (`src/enrichment/pipeline.js#enrichBatch`)
  on the result batch before persistence.
- Phone normalization, address parsing, dedup, chain/spam detection, email
  *discovery* (pattern-guess only — no SMTP), sentiment, geo-metrics, lead
  score, and confidence all run.
- `lat` / `lng` are **not** geocoded (no `--geocoder` flag → the address
  phase parses the string but skips geocoding). The raw scrape coordinates
  are used as the fallback for geo-metrics.
- `email_status` is `unverified` for every discovered email (no SMTP probe).
- `website_tech_stack` stays `NULL` (no `--enrichTechStack` fetch).
- Writes 25 enrichment columns to the `businesses` table + dedup decisions
  to `business_duplicates` (see [§10](#10-persisted-columns-reference)).

### Opt-in network run — geocoding + SMTP verification + tech-stack fetch

```bash
node src/index.js \
  --query "Plumber" \
  --location "Berlin" \
  --maxResults 200 \
  --output db \
  --enrich on \
  --phoneDefaultCountry DE \
  --geocoder google \
  --geocodeApiKey "$GEOCODING_API_KEY" \
  --geocodeBudget 2 \
  --enrichEmail on \
  --enrichTechStack on \
  --enrichBudget 3 \
  --yes
```

This adds: precise geocoding (capped at $2), SMTP mailbox verification
(~5 s per probe, bounded concurrency), and website HTTP fetch + tech-stack
detection (~10 s per site, 2 MB body cap). Total spend is bounded by
`--enrichBudget 3` (USD). See [§4 Budgeting](#4-budgeting).

### Standalone enrichment (`npm run enrich`)

The `npm run enrich` script (added by the Phase 3.13 CLI-integration track)
runs the same pipeline against an already-scraped dataset — useful for
re-enriching after an algorithm bump or for trying a different lead-scoring
profile without re-scraping. It invokes `enrichBatch` from
`src/enrichment/pipeline.js` with the same `--enrich*` / `--geocode*` /
`--dedupThreshold` flags as the post-scrape path. Example:

```bash
npm run enrich -- --enrich on --enrichEmail on --enrichTechStack on \
  --geocoder nominatim --leadProfile reputation-mgmt
```

> The pipeline is idempotent: re-running it on the same batch produces the
> same enrichment columns. Enrichment columns are **excluded** from the
> `data_hash` that drives change-tracking, so a re-enrichment never triggers
> spurious `field_changes` rows or bumps `updated_at` — only a real scrape
> change does.

### Phase order (executed by `enrichBatch`)

```
 3.1  phone          (always on, offline)
 3.2  address        (parse always on; geocode opt-in via --geocoder)
 3.3  dedup          (always on, batch-wide)
 3.4  chain + spam   (always on, batch-wide)
 3.5  email          (discover always; SMTP verify opt-in via --enrichEmail)
 3.6  tech-stack     (opt-in HTTP fetch via --enrichTechStack)
 3.7  sentiment      (always on, offline — AFINN bundled)
 3.8  geo-metrics    (always on, batch-wide — haversine, no PostGIS)
 3.9  lead score     (always on — fuses all signals)
 3.10 confidence     (always on — evidence depth, distinct from lead score)
 ── 3.11 grid coverage is a search-strategy utility, NOT a per-business
     enrichment phase. It's invoked separately (see [§3.11](#311-grid-coverage)
     and [§7](#7-grid-coverage-guide)).
```

Each phase is wrapped in `try/catch` so one failure doesn't abort the whole
run. A failed phase logs + contributes empty results; downstream phases
degrade gracefully (they treat missing descriptors as neutral). The pipeline
returns `{ enriched, skipped, failed, costUsd, phases }`.

### Master flag reference

| Flag | Default | Purpose |
|---|---|---|
| `--enrich on\|off` | `off` | Master switch. `off` = Phase 2 behavior. |
| `--enrichPhone on\|off` | `on` (when `--enrich on`) | E.164 phone normalization + type detection. |
| `--enrichAddress on\|off` | `on` | Structured address parsing + geocoding. |
| `--enrichDedup on\|off` | `on` | Fuzzy dedup + `business_duplicates` tracking. |
| `--enrichEmail on\|off` | `on` | Email discovery (SMTP verify is separate opt-in). |
| `--enrichTechStack on\|off` | `on` | Tech-stack detection (HTTP fetch is separate opt-in). |
| `--enrichSentiment on\|off` | `on` | AFINN review sentiment + aspect detection. |
| `--enrichGeo on\|off` | `on` | Competitor density (1 km / 5 km) + isolation. |
| `--enrichLeadScore on\|off` | `on` | Composite 0–100 lead score + grade + tier. |
| `--enrichConfidence on\|off` | `on` | Per-record evidence-depth confidence. |
| `--enrichBudget <usd>` | `0` (unlimited) | USD cap on paid features (geocode, SMTP, HTTP). `0` = unlimited. |
| `--enrichConcurrency <n>` | `4` | Parallel enrichment workers. |
| `--phoneDefaultCountry <ISO>` | none | ISO 2-letter phone-region hint (`US`, `DE`, `BD`, …). |
| `--geocoder google\|nominatim\|mock` | `nominatim` | Geocoder provider. `nominatim` = free, `google` = paid, `mock` = $0 testing. |
| `--geocodeApiKey <key>` | none | Google Geocoding API key (env: `GEOCODING_API_KEY`). |
| `--geocodeRateLimitMs <ms>` | provider default | Override the provider's inter-request gap. |
| `--geocodeBudget <usd>` | `0` (unlimited) | USD cap on Google geocoding only. |
| `--dedupThreshold <0.00–1.00>` | `0.85` | Fuzzy-match cutoff above which two listings are duplicates. |
| `--dedupMerge on\|off` | `on` | `on` = merge duplicates into canonical; `off` = detect-only. |
| `--leadProfile <name>` † | `web-agency` | Lead-scoring profile: `default`, `web-agency`, `reputation-mgmt`, `seo-agency`. |
| `--gridStepKm <km>` † | `5` | Grid-coverage step size (env: `GRID_STEP_KM`). See [§7](#7-grid-coverage-guide). |

> † **Pending CLI wiring.** `--leadProfile`, `--emailVerify` (§3.5), and
> `--gridStepKm` are part of the Phase 3.13 CLI-integration track — the same
> track that adds the `npm run enrich` script. The underlying pipeline
> options (`opts.leadProfile`, `opts.emailVerify`, `GRID_STEP_KM` env) are
> shipped and supported today via the programmatic API
> (`require('./src/enrichment/pipeline').enrichBatch(businesses, opts)`); the
> CLI flag parsing in `src/config.js` lands with that track. Every other flag
> in this table is already parsed by `src/config.js`.

---

## 3. Feature-by-feature reference

Each subsection below covers one enrichment feature: what it does, the flag
that controls it, the persisted columns it writes, and a worked example.

### 3.1 Phone normalization

**Module:** `src/enrichment/phone.js` (Phase 3.1) · **Flag:** `--enrichPhone on|off` · **Region hint:** `--phoneDefaultCountry <ISO>`

Converts every scraped phone to **E.164** format (`+14165550123`), detects
its type, resolves the ISO 3166-1 alpha-2 country code, and flags invalid
numbers. Built on `libphonenumber-js/max` (pure JS, offline — no telco API
calls). Handles 20+ raw format variations including non-Latin digits
(Arabic-Indic `٠١٢٣`, Persian `۰۱۲۳`, Devanagari `०१२३`, Bengali `০১২৩`) and
extensions (`ext`, `x`, `,`, `;`, `#`).

**Type taxonomy** (6 values): `mobile` | `landline` | `toll_free` | `voip` |
`invalid` | `unknown`. `FIXED_LINE_OR_MOBILE` is conservatively classified
as `landline` (we can't tell, and `mobile` is the higher-value signal so we
avoid false claims).

**Safety rule:** `phone_e164` is suppressed (`NULL`) for **invalid** numbers.
`libphonenumber-js` returns a best-effort `.number` even for invalid parses,
but clients filter on `phone_e164` for auto-dialing — an invalid E.164 would
be misleading/dangerous.

**Persisted columns** (3):

| Column | Type | Notes |
|---|---|---|
| `phone_e164` | TEXT | `+14165550123`, or `NULL` if invalid. |
| `phone_type` | TEXT | One of the 6-value taxonomy above. |
| `phone_country_code` | TEXT | ISO 2-letter (`US`, `DE`, `BD`, …). |

**Example:**

```bash
node src/index.js --query "Cafe" --location "Berlin" --maxResults 50 \
  --output db --enrich on --phoneDefaultCountry DE --yes
```

A scraped phone `030 1234567` (German local format) with
`--phoneDefaultCountry DE` becomes `phone_e164=+49301234567`,
`phone_type=landline`, `phone_country_code=DE`. Without the country hint,
local-format numbers without a `+` prefix fail to parse and get
`phone_e164=NULL`, `phone_type=invalid`.

---

### 3.2 Address parsing & geocoding

**Module:** `src/enrichment/address.js` (Phase 3.2) · **Flag:** `--enrichAddress on|off` · **Geocode opt-in:** `--geocoder google|nominatim|mock`

Splits the raw single-line Google Maps address string into 5 structured
fields, and (optionally) geocodes each business to verified `lat`/`lng`
coordinates with a 0.00–1.00 confidence score.

**Parsing heuristics** cover 15+ country formats (US/CA, DE/AT, GB, FR/IT,
JP block-system, BD/IN, plus a generic comma-splitter fallback). The country
hint selects the parser; if none is given, the country is sniffed from the
last comma-separated token (matched against ~60 country aliases).

**Geocoder providers:**

| Provider | Cost | Rate limit | Notes |
|---|---|---|---|
| `nominatim` (default) | Free | 1 req/s | OpenStreetMap. No key required. |
| `google` | $5 / 1k after free tier | 50 req/s | Uses `place_id` first (free-ish), falls back to address text. Requires `--geocodeApiKey`. |
| `mock` | Free | none | Returns canned coordinates. For $0 testing. |

All providers return `{ lat, lng, confidence, source }`. Confidence bands:
`EXACT` 1.0 (place_id match), `ROOFTOP` 0.9, `INTERPOLATED` 0.75, `CENTER`
0.6, `APPROXIMATE` 0.4, `CENTROID` 0.3, `NONE` 0.0.

**Budget guard:** every Google geocode call debits a running budget; when
exhausted, the geocoder falls back to `mock` (no coordinates) so the run
completes without overspending. Nominatim + mock are $0 (never debited).

**Persisted columns** (8):

| Column | Type | Notes |
|---|---|---|
| `address_street` | TEXT | "123 Main St" |
| `address_city` | TEXT | "Springfield" |
| `address_state` | TEXT | "IL" |
| `address_postal` | TEXT | "62701" |
| `address_country` | TEXT | ISO 2-letter ("US"). |
| `lat` | NUMERIC(10,7) | Geocoded latitude (NULL if no geocode). |
| `lng` | NUMERIC(10,7) | Geocoded longitude. |
| `geocode_confidence` | NUMERIC(3,2) | 0.00–1.00. |

**Examples:**

```bash
# Free geocoding via OpenStreetMap (1 req/s rate limit):
node src/index.js --query "Restaurant" --location "Toronto" --maxResults 100 \
  --output db --enrich on --geocoder nominatim --yes

# Paid Google geocoding, capped at $2:
node src/index.js --query "Plumber" --location "Berlin" --maxResults 200 \
  --output db --enrich on --geocoder google --geocodeApiKey "$GEOCODING_API_KEY" \
  --geocodeBudget 2 --yes
```

---

### 3.3 Deduplication

**Module:** `src/enrichment/dedup.js` (Phase 3.3) · **Flag:** `--enrichDedup on|off` · **Threshold:** `--dedupThreshold <0.00–1.00>` (default `0.85`) · **Merge:** `--dedupMerge on|off` (default `on`)

Detects businesses listed under slightly different names (e.g. "McDonald's"
vs "McDonalds" vs "McDonald's Restaurant"), clusters them into canonical
records, and tracks the decisions in the `business_duplicates` table so
re-runs are idempotent.

**Similarity model** (weighted, must sum to 1.0):

| Signal | Weight | Scoring |
|---|---|---|
| Name fuzzy match (Fuse.js) | 0.5 | 0.0–1.0 similarity. |
| Phone E.164 exact match | 0.3 | Binary (1.0 or 0.0). |
| Address proximity (< 100 m) | 0.2 | Binary (1.0 or 0.0). |

A pair is a "duplicate" when the weighted score ≥ `--dedupThreshold`
(default `0.85`). The threshold was tuned against the Phase 3 fixture: it
catches "McDonald's" vs "McDonalds" (0.95) and "Burger King" vs "Burger King
Restaurant" (0.88), but not "Burger King" vs "Burger Joint" (0.55).

**Blocking** keeps the comparison near-linear (not O(n²)): three blocking
strategies (name-prefix+country, phone E.164, geocode-cell at ~100 m). A
business appears in up to 3 blocks; within-block comparisons use the full
similarity function.

**Idempotent:** re-running on the same input produces the same clusters. The
`business_duplicates` table upserts (`ON CONFLICT`) so re-runs don't
duplicate rows.

**Persisted columns:** none on `businesses`. Dedup writes to a separate
`business_duplicates` table (canonical place_id, duplicate place_id,
similarity score, match method). Each business also gets an in-memory
`dedup_result` descriptor (cluster ID, `isPrimary`, duplicates list,
`maxSimilarity`) that feeds lead-score (§3.9) and confidence (§3.10) — this
descriptor is NOT persisted.

**Example — detect-only mode (no merge):**

```bash
node src/index.js --query "Cafe" --location "London" --maxResults 200 \
  --output db --enrich on --dedupMerge off --dedupThreshold 0.90 --yes
```

Raise `--dedupThreshold` if legitimate distinct businesses are being merged;
lower it if obvious duplicates are slipping through. See
[§8 Troubleshooting](#8-troubleshooting).

---

### 3.4 Chain detection & spam filtering

**Module:** `src/enrichment/chain-detection.js` (Phase 3.4) · **Flag:** always on when `--enrich on` (no separate toggle)

Two complementary analyses run on every business:

**(A) Chain detection** — matches the business name against a curated
catalogue of known chain brand tokens (McDonald's, Starbucks, Subway,
7-Eleven, Dunkin', Wendy's, Chipotle, Target, Walmart, Costco, Whole Foods).
Matching uses normalized token overlap + alias lists so "McDonald's of Times
Square" still resolves to the McDonald's chain.

**(B) Spam / fake-listing detection** — a rule engine evaluates **11
heuristics** and emits weighted `SpamFlag`s:

| # | Flag code | Trigger |
|---|---|---|
| 1 | `KEYWORD_STUFFING` | CAPS, superlatives, "24/7", "#1", "cheap", "best", "AAA" in the name. |
| 2 | `AAA_PREFIX` | Name starts with "AAA" (lead-gen shell pattern). |
| 3 | `PO_BOX_ADDRESS` | PO Box / mailbox address with no physical storefront. |
| 4 | `PHONE_AREA_MISMATCH` | Phone area code doesn't match the address region (NYC number on a LA address). |
| 5 | `PHONE_REUSE` | Same E.164 phone reused across multiple listings in the batch. |
| 6 | `SUSPICIOUS_RATING` | Perfect 5.0★ rating with very few reviews. |
| 7 | `GENERIC_NAME` | Generic / placeholder name ("Professional Services LLC"). |
| 8 | `SUSPICIOUS_TLD` | Suspicious TLD (`.xyz`, `.tk`, `.top`, `.gq`, `.cf`). |
| 9 | `NO_WEBSITE_SERVICE` | Service business with no website (category doesn't fit phone-only). |
| 10 | `CATEGORY_MISMATCH` | Category doesn't fit the phone type (e.g. "Plumber" running a toll-free number). |
| 11 | `NETWORK_PATTERN` | Same phone/address reused for multiple "AAA …" branches. |

Flags aggregate into a 0–100 `spamScore` and a `riskLevel`
(`low` | `medium` | `high` | `critical`). Listings with `isSpam=true` and
`spamScore ≥ 65` are **hard-capped at lead_score 34** (grade F, tier
`disqualify`) — see [§3.9](#39-lead-score).

**Persisted columns:** none directly. Chain + spam signals feed
`lead_score` (§3.9) and `confidence_score` (§3.10) via in-memory
`chain_result` and `spam_result` descriptors (NOT persisted). To audit a
spam verdict, review the descriptor's `flags` array — see
[§8 Troubleshooting](#8-troubleshooting).

**Example:** A listing named "AAA CHEAP PLUMBER 24/7 #1" with a PO Box
address and a `.xyz` website will trip `AAA_PREFIX`, `KEYWORD_STUFFING`,
`PO_BOX_ADDRESS`, and `SUSPICIOUS_TLD`, producing `spamScore ≥ 65`,
`isSpam=true`, `riskLevel=critical` — and its `lead_score` will be capped at
34 regardless of how strong its other signals are.

---

### 3.5 Email discovery & verification

**Module:** `src/enrichment/email.js` (Phase 3.5) · **Flag:** `--enrichEmail on|off` (discovery always on when enrichment is on; SMTP verify is opt-in)

Two stages:

**(A) Discovery** (heuristic, always runs for businesses with a website) —
generates candidate contact emails by combining common local-parts
(`info`, `contact`, `hello`, `admin`, `sales`, `support`, `office`, `mail`,
`booking`, `reservations`) with the bare website domain. Phase 3.6
(tech-stack) owns HTTP fetching; when it runs, the HTML scan
(`discoverEmailsFromHtml`) pulls real addresses out of `mailto:` links and
page text — a more accurate source than pattern guesses.

**(B) Verification** (opt-in, off by default) — for each candidate email:
1. MX lookup via `dns.resolveMx(domain)`. No MX records → `no_mx`.
2. SMTP mailbox probe — connect to the primary MX host on port 25, send
   `EHLO` + `MAIL FROM` + `RCPT TO`, interpret the reply:
   - `250`/`251` → `verified`
   - `550`/`551`/`553` → `invalid`
   - anything else (4xx, timeout, connection drop) → `unverified`

Verification is opt-in because SMTP probing is **slow** (~5 s/probe), can
look like spam reconnaissance, and many mail servers silently accept all
`RCPT TO` (catch-all) which makes `verified` a soft signal at best. The
probe catches everything (DNS errors, socket errors, timeouts, premature
closes) and degrades to `unverified` rather than throwing — a single flaky
mail server never aborts a batch.

**Email statuses** (4): `verified` | `unverified` | `invalid` | `no_mx`.
Default (discovery only, no verify) is `unverified`.

**Persisted columns** (2):

| Column | Type | Notes |
|---|---|---|
| `email` | TEXT | Best candidate email (or `NULL` if no website). |
| `email_status` | TEXT | One of the 4 statuses above. |

**Examples:**

```bash
# Discovery only (default — fast, free, all emails 'unverified'):
node src/index.js --query "Dentist" --location "Toronto" --maxResults 100 \
  --output db --enrich on --enrichEmail on --yes

# Discovery + SMTP verification (slow, ~5s/probe, blacklist risk — see §8):
node src/index.js --query "Dentist" --location "Toronto" --maxResults 100 \
  --output db --enrich on --enrichEmail on --emailVerify on --yes
```

> **Note:** `--emailVerify` is the flag the pipeline's `opts.emailVerify`
> option maps to. SMTP verification uses Node's built-in `net` module (no
> external deps, no config needed) but carries blacklist risk — see
> [§8 Troubleshooting](#8-troubleshooting). The `--emailVerify` CLI flag is
> pending Phase 3.13 CLI wiring (†); until then, pass `verify: true` via the
> programmatic API (`enrichEmailsBatch(businesses, { verify: true })`).

---

### 3.6 Tech-stack detection

**Module:** `src/enrichment/tech-stack.js` (Phase 3.6) · **Flag:** `--enrichTechStack on|off` (HTTP fetch is opt-in)

For every business with a website, this module:
- **(A)** Fetches the site over HTTP (GET, redirect-following, 10 s timeout,
  **2 MB body cap** — signatures live in `<head>`) and classifies its
  liveness: `live` | `dead` | `redirected` | `error`.
- **(B)** Runs **27 signature-based detection rules** over the response
  headers + HTML to identify the CMS / framework / frontend / e-commerce /
  hosting / CDN / analytics stack (WordPress, Shopify, Wix, Squarespace,
  Drupal, Joomla, Magento, React, Vue, Angular, Next.js, jQuery, Bootstrap,
  Tailwind, Cloudflare, Nginx, Apache, Google Analytics, …).
- **(C)** Computes a 0–100 `sophisticationScore` from the detected signals.
  A hand-coded static HTML page scores ~3; a Next.js + Vercel + Cloudflare
  + GA4 stack scores ~90+. This feeds the lead-score `digital_maturity`
  signal (§3.9).

HTTP fetching is **opt-in** via `--enrichTechStack on`. With it off (or
`--enrich on` alone), `analyzeWebsite` returns early with liveness `error`
and an empty tech stack — no network calls. The fetcher uses Node's built-in
`http`/`https` modules (no `node-fetch`/`axios` dependency), follows
redirects up to a cap, and is defensive: dead domains, TLS errors, 500s,
redirect chains to Facebook, 10 MB pages, encoding weirdness, and
HEAD-not-supported servers are all caught — no single bad site can crash
the batch.

**Persisted columns** (3):

| Column | Type | Notes |
|---|---|---|
| `website_tech_stack` | JSONB | Array of detected technology names. |
| `website_status_code` | INTEGER | HTTP status (or `NULL` if unreachable). |
| `website_liveness` | TEXT | `live` \| `dead` \| `redirected` \| `error`. |

**Example:**

```bash
node src/index.js --query "Restaurant" --location "Toronto" --maxResults 100 \
  --output db --enrich on --enrichTechStack on --enrichBudget 1 --yes
```

A WordPress + WooCommerce + Cloudflare + GA4 site produces
`website_tech_stack=["WordPress","WooCommerce","Cloudflare","Google Analytics"]`,
`website_status_code=200`, `website_liveness=live`, sophistication score ~75.

---

### 3.7 Review sentiment

**Module:** `src/enrichment/sentiment.js` (Phase 3.7) · **Flag:** `--enrichSentiment on|off`

Runs **AFINN-165** sentiment analysis (via the `sentiment` npm package,
bundled, free, offline) over each business's `top_reviews` and cross-checks
the review-derived polarity against the listing's star rating. A 5.0★ rating
paired with scathing review text is a strong fake-listing tell that the
Phase 3.4 spam engine cannot see on its own — surfaced as a
`rating_review_mismatch` anomaly consumed by lead-score (§3.9) and
confidence (§3.10).

Two engines run side by side:

- **Overall sentiment** — per-review `.comparative` score (−1..+1, clamped).
  The business-level score is the mean of per-review scores.
- **Aspect detection** (keyword-based, no ML) — a curated lexicon maps
  review keywords to one of **8 aspects**: `food`, `service`, `price`,
  `cleanliness`, `atmosphere`, `wait`, `value`, `location`, each with a
  signed polarity (−3..+3; 0 for neutral aspect markers). Per-aspect
  polarity is squashed to −1..+1 via `tanh`.

**Rating-vs-review consistency:** the star rating maps to an expected −1..+1
sentiment `(rating−3)/2`. A gap ≥ 0.6 is a `severe_mismatch` (high-severity
anomaly); ≥ 0.3 is a `mismatch`.

**Anomalies emitted:** `rating_review_mismatch` / `rating_review_mismatch_high`,
`extreme_rating_low_volume`, `uniformly_perfect_reviews`, `no_reviews`.

**Persisted columns** (2):

| Column | Type | Notes |
|---|---|---|
| `sentiment_score` | NUMERIC(4,2) | −1.00..+1.00 (mean of per-review scores). |
| `sentiment_themes` | JSONB | `{aspect: score}` for the 8 aspects (e.g. `{"food":0.6,"service":-0.3}`). |

**Example:** A 4.5★ restaurant whose reviews mention "amazing pizza" but
"rude staff" and "long wait" produces `sentiment_score=0.42`,
`sentiment_themes={"food":0.7,"service":-0.5,"wait":-0.4,...}`, no anomalies.
A 5.0★ listing with 2 reviews saying "terrible, do not go" produces
`sentiment_score=-0.6` and a `rating_review_mismatch_high` anomaly — strong
fake-listing signal.

---

### 3.8 Geo-metrics

**Module:** `src/enrichment/geo-metrics.js` (Phase 3.8) · **Flag:** `--enrichGeo on|off`

For every business, computes spatial analytics relative to the rest of the
batch: how many other businesses sit within walking distance (1 km) and
driving distance (5 km), whether the listing is geographically isolated (a
spam signal), whether it sits in a dense commercial cluster, and the
proximity of the nearest chain location.

Pure math — no network, no DB, no external deps. The haversine formula is
implemented inline so the module works on any Postgres install (**PostGIS
not required**). O(n²) over the batch — fine for typical batch sizes
(hundreds to low thousands of listings per scrape). For 10k+ batches a
spatial index (R-tree / k-d tree in JS, or `ST_DWithin` pushed down to
PostGIS) would be needed.

**Coordinate priority:** `business.lat`/`business.lng` (Phase 3.2 geocoded,
preferred) → `business.latitude`/`business.longitude` (raw scrape pin,
fallback). Listings with no usable coordinate get a `no_geocode` flag and
are excluded from distance math (their density columns are 0).

**Persisted columns** (2):

| Column | Type | Notes |
|---|---|---|
| `competitor_density_1km` | INTEGER | Other businesses within 1 km. |
| `competitor_density_5km` | INTEGER | Other businesses within 5 km. |

An in-memory `geo_result` descriptor (nearest-neighbour distance,
`sameCategoryWithin1km`, `isolation`, `areaType`, flags) feeds lead-score
and confidence — NOT persisted.

**Example:** A plumber in a dense downtown core might have
`competitor_density_1km=12`, `competitor_density_5km=47`, `areaType=dense`.
The same plumber in a rural town might have `competitor_density_1km=0`,
`competitor_density_5km=2`, `areaType=isolated` — the isolation flag feeds
the spam engine (an isolated service business can corroborate or soften a
Phase 3.4 spam verdict).

---

### 3.9 Lead score

**Module:** `src/enrichment/lead-score.js` (Phase 3.9) · **Flag:** `--enrichLeadScore on|off` · **Profile:** `--leadProfile <name>` (default `web-agency`)

The capstone stage. Every prior phase produces an independent signal; this
stage fuses them into a single **0–100 composite lead score** that ranks how
attractive each listing is as a prospect. The model is deliberately
transparent and additive: **7 signal dimensions**, each normalized to a
0–100 subscore, combined by fixed weights that sum to 1.0 (per profile).
Every subscore carries a human-readable note and the weighted contribution
is exposed, so the score is fully explainable (no black box).

| Signal | Sources |
|---|---|
| `legitimacy` | Phase 3.4 spam (inverse) + chain flag. |
| `reputation` | Phase 3.7 sentiment + star rating + consistency. |
| `data_quality` | Phase 3.1 phone + 3.2 address + website + reviews. |
| `digital_maturity` | Phase 3.6 tech-stack sophistication + liveness. |
| `establishment` | Review volume (maturity / longevity proxy). |
| `uniqueness` | Phase 3.3 dedup (primary vs duplicate) + phone reuse. |
| `geo` | Phase 3.8 isolation / competition / area type. |

**Hard spam cap (critical rule):** a listing flagged `isSpam` by Phase 3.4
with `spamScore ≥ 65` is hard-capped at **34** (grade F, tier `disqualify`)
regardless of how strong its other signals are. `spamCapped=true` is set on
the result so the cap is auditable.

**Grades** (from the capped score):

| Score | Grade | Tier |
|---|---|---|
| ≥ 85 | A | `priority` |
| 70–84 | B | `qualified` |
| 55–69 | C | `nurture` |
| 40–54 | D | `monitor` |
| < 40 | F | `disqualify` |
| (spam-capped) | F | `disqualify` |

**Defensive reads:** prior phases may not have run (tech-stack is opt-in,
sentiment needs reviews, geo needs coords, …). When a descriptor is missing,
the affected signal degrades to neutral (score 50) with a note explaining
the gap, so the composite still produces a sensible number.

**Persisted columns** (2):

| Column | Type | Notes |
|---|---|---|
| `lead_score` | INTEGER | 0–100 (spam-capped at 34). |
| `lead_score_profile` | TEXT | The profile used (`web-agency`, `reputation-mgmt`, …). |

An in-memory `lead_result` descriptor (full breakdown: per-signal subscores,
contributions, top strengths/risks, recommendation) is NOT persisted — it
powers the CLI banner and downstream phases.

**Example:**

```bash
# Score with the reputation-mgmt profile (prioritizes review volume):
node src/index.js --query "Restaurant" --location "Toronto" --maxResults 100 \
  --output db --enrich on --leadProfile reputation-mgmt --yes
```

See [§6 Lead-scoring profiles](#6-lead-scoring-profiles) for the full
profile-by-profile reference.

---

### 3.10 Confidence

**Module:** `src/enrichment/confidence.js` (Phase 3.10) · **Flag:** `--enrichConfidence on|off`

Confidence is **distinct** from the lead score. The lead score says how
*attractive* a listing is; confidence says how much *evidence* underpins
that score. A 5.0★ listing with zero reviews, no website, and a shaky
geocode could be a fantastic lead or could be spam — the lead score can't
tell those two apart, but confidence can. It surfaces the uncertainty so an
operator knows which lead scores to trust and which need enrichment before
outreach.

```
  Lead score (3.9)  →  "how attractive?"      (0-100, graded A-F)
  Confidence (3.10) →  "how well-evidenced?"   (0-100, banded 5 ways)
```

**Model:** neutral base of 50, then signed deltas from **8 evidence
dimensions**: phone reliability, address reliability, dedup state, spam
uncertainty, chain membership, tech coverage, review volume, geo context
(plus a "lead present" check). Each dimension emits a
`{code, label, detail, impact, delta}` factor so the reasoning is
transparent. Raw field gaps (`name`/`phone`/`address`/`website`/`rating`/
`reviews`/`lat-lng`) each nibble 2 points off the base; high-impact gaps
(phone, website, address, geocode) additionally fire explicit `MISSING_*`
factors. Pipeline descriptors that didn't run contribute nothing — neither
positive nor negative.

**Bands:**

| Score | Band | Label |
|---|---|---|
| ≥ 80 | `very_high` | Very high |
| 60–79 | `high` | High |
| 40–59 | `medium` | Medium |
| 20–39 | `low` | Low |
| < 20 | `very_low` | Very low |

**Persisted column** (1):

| Column | Type | Notes |
|---|---|---|
| `confidence_score` | NUMERIC(4,2) | 0.00–1.00 (computed as 0–100 internally, divided by 100 for storage). |

An in-memory `confidence_result` descriptor (full 0–100 score, band, all
factors, `missingFields[]`, `signalCoverage`, note) is NOT persisted.

**Example:** A business with a verified email, geocoded address, 200
reviews, and a live WordPress website might score `confidence_score=0.82`
(band `very_high`). The same business with no email, no geocode, 2 reviews,
and a dead website might score `confidence_score=0.31` (band `low`) — even
if both have the same `lead_score=72`, the first is trustworthy and the
second needs enrichment before outreach.

---

### 3.11 Grid coverage

**Module:** `src/enrichment/grid-coverage.js` (Phase 3.11) · **Step size:** `--gridStepKm <km>` (env: `GRID_STEP_KM`, default `5`)

> **Note on CLI wiring:** the grid-coverage **module** is shipped and fully
> usable today via its programmatic API (`gridSearchPoints`,
> `generateGrid`, `estimateCoverage`). The full `--grid on` /
> `--gridBounds <string>` / `--gridCellSizeKm` CLI flags listed in
> `PHASE3_EXECUTION_PLAN.md` §3.11 are part of the Phase 3.13 CLI-integration
> track (the same track that adds the `npm run enrich` script). Until those
> flags land, drive grid coverage programmatically as shown in
> [§7 Grid-coverage guide](#7-grid-coverage-guide).

Google Maps caps search results at ~120 per query. A city like Toronto has
5,000+ restaurants — a single "Restaurant in Toronto" query misses 95%.
Grid coverage splits a region into a grid of `(lat, lng)` search points,
each receiving its own Maps query, so the scraper harvests the WHOLE area
instead of the first 120 hits. This is a **search-strategy** module: it
produces the list of points to query, not per-business enrichment columns
(`ENRICHMENT_COLUMNS = []`).

The scraper's main loop calls `gridSearchPoints(region, {query, stepKm})`
to get the list of search points, then runs one Maps query per point
(e.g. `"plumber@43.6532,-79.3832"`). Overlapping result sets between
adjacent cells are merged by Phase 3.3 dedup.

**Region specs** (one of):
- `{ center: {lat, lng}, radiusKm: number }` → bbox of side `2×radiusKm`.
- `{ bbox: {north, south, east, west} }` → use the bbox directly.
- `{ polygon: [{lat, lng}, ...] }` → bbox of the polygon, then filter
  points to inside it (ray-casting, even-odd rule).

**Key constants:**
- `DEFAULT_STEP_KM = 3` (module default when none derived).
- `MAX_GRID_POINTS = 10000` (safety cap — prevents accidental
  million-point grids from swapped bbox units).
- `GOOGLE_RESULT_RADIUS_KM = 3` (typical Maps result radius for a category
  search; used by `estimateCoverage`).
- `DEFAULT_URBAN_DENSITY = 5` listings/km² (mid-range for service
  categories; dense categories like restaurants run 20–50/km² in city
  cores).

**Longitude compression:** the east-west step is recomputed per row
(`kmToLngDegrees(km, lat)`) so the grid stays regular in **kilometres**, not
degrees — 1° longitude shrinks as `cos(lat) → 0` at higher latitudes.

**Persisted columns:** none. Grid drives search input, not DB columns.

**Example (programmatic — works today):**

```js
const { gridSearchPoints, estimateCoverage } = require('./src/enrichment/grid-coverage');

const points = gridSearchPoints(
  { center: { lat: 43.6532, lng: -79.3832 }, radiusKm: 5 },
  { query: 'plumber', stepKm: 2 },
);
// → [{lat: 43.6045, lng: -79.4319, query: 'plumber@43.604500,-79.431900',
//     label: 'grid-r0c0'}, ...]

const cov = estimateCoverage(points, 8 /* listings/km² */);
// → { totalPoints: 25, areaKm2: 100, estimatedListings: 800, coverageRatio: 1.0 }
```

See [§7 Grid-coverage guide](#7-grid-coverage-guide) for the full whole-city
workflow.

---

## 4. Budgeting

Three enrichment features cost money or time. The pipeline tracks `costUsd`
per phase and a running total, returned in the `enrichBatch` result
(`{ enriched, skipped, failed, costUsd, phases }`).

| Feature | Cost | Time | Cap flag |
|---|---|---|---|
| **Google geocoding** (`--geocoder google`) | **$5 / 1k** after the $200/mo free tier | ~50 req/s | `--geocodeBudget <usd>` |
| **Nominatim geocoding** (`--geocoder nominatim`, default) | **Free** | 1 req/s (self-imposed) | none ($0) |
| **SMTP email verification** | Free | **~5 s / probe** (bounded concurrency, default 3) | `--enrichBudget <usd>` |
| **Tech-stack HTTP fetch** | Free | **~10 s / site** (bounded concurrency, default 3) | `--enrichBudget <usd>` |
| **AFINN sentiment** | Free (bundled) | < 1 ms / review | none |
| All other phases | Free | < 1 ms / business | none |

### How `costUsd` is reported

- The `address.geocodeBatch` phase returns `{ geocoded, costUsd }`. Google
  calls debit the budget at $5/1k; Nominatim and mock are $0 (never
  debited). When the Google budget is exhausted, the geocoder falls back to
  `mock` (no coordinates) so the run completes without overspending.
- The `email.enrichEmailsBatch` and `techStack.detectTechStackBatch` phases
  return `costUsd: 0` (no paid APIs — reserved for parity).
- The pipeline sums all phase `costUsd` into the top-level `costUsd` field
  of the `enrichBatch` result. The CLI banner prints the total.

### Budget flags

- `--enrichBudget <usd>` — global USD cap across all paid features
  (geocoding, SMTP, HTTP). `0` = unlimited.
- `--geocodeBudget <usd>` — USD cap on **Google geocoding only**. `0` =
  unlimited. When hit, geocoding stops (falls back to mock); other
  enrichment phases continue.
- `--enrichConcurrency <n>` (default 4) — parallel enrichment workers.
  Lower this if SMTP/HTTP probing is saturating your bandwidth or tripping
  rate limits.

### Worked example — 500-business dataset

| Phase | Cost | Time (concurrency 4) |
|---|---|---|
| Phone, address-parse, dedup, chain/spam, sentiment, geo, lead, confidence | $0 | < 5 s total |
| Email discovery (no verify) | $0 | < 1 s |
| Email discovery + SMTP verify | $0 | ~10 min (500 sites × ~5 s / 3 workers) |
| Tech-stack fetch | $0 | ~25 min (500 sites × ~10 s / 3 workers) |
| Nominatim geocoding | $0 | ~8 min (500 × 1 req/s) |
| Google geocoding | ~$2.50 (500 × $0.005) | < 1 min |

**Phase 3.13 acceptance target:** total enrichment cost < $2 (geocoding
only; SMTP/HTTP/AFINN are free) and total enrichment time < 30 minutes for
a 500-business dataset.

---

## 5. Provider setup

### Google Geocoding API (`--geocoder google`)

1. Create a project at <https://console.cloud.google.com/> and enable the
   **Geocoding API**.
2. Create an API key (Credentials → Create credentials → API key).
3. Restrict the key to the Geocoding API + your IP/referrer in production.
4. Set it via env or flag:
   ```bash
   export GEOCODING_API_KEY="AIza..."
   # or:
   --geocodeApiKey "AIza..."
   ```
5. Pricing: $5 per 1k requests after the $200/mo free tier (= 5k free
   geocodes/mo). Budget with `--geocodeBudget <usd>`.

### Nominatim (`--geocoder nominatim`, default)

Free, no key, no setup. OpenStreetMap's public instance is rate-limited to
**1 request/second** (the pipeline self-throttles to this). For high-volume
runs, self-host a Nominatim instance (see
<https://nominatim.org/release-docs/latest/admin/Installation/>) and the
module will hit your endpoint instead — or just use Google.

### Mock (`--geocoder mock`)

Returns canned coordinates for $0 testing. No setup. Use in CI and dry
runs:

```bash
node src/index.js --query "Cafe" --location "Berlin" --maxResults 10 \
  --output db --enrich on --geocoder mock --yes
```

### SMTP email verification (`--enrichEmail on` + `--emailVerify on`)

Uses Node's built-in `net` module to open a raw SMTP conversation on port
25 — **no config, no external deps, no API key**. The probe sends
`EHLO` + `MAIL FROM:<>` + `RCPT TO:<candidate>` and reads the reply code.

> **Blacklist risk:** aggressive SMTP probing from a single IP can get that
> IP greylisted or blacklisted by RBLs (Spamhaus, etc.). For batch
> verification, run from a disposable IP, throttle with
> `--enrichConcurrency 1`, or stick to discovery-only (the default) and
> verify a shortlist manually. See [§8 Troubleshooting](#8-troubleshooting).

### AFINN sentiment (`--enrichSentiment on`)

Bundled — the `sentiment` npm package ships the AFINN-165 lexicon
in-repo. No API key, no network, $0. Loaded via a DI seam so tests inject
a stub and skip the import. If the package is missing for any reason,
`analyzeSentiment` degrades to 0 and the aspect/anomaly logic still runs on
keyword signals.

### libphonenumber-js (`--enrichPhone on`)

Bundled — the `libphonenumber-js/max` build (full metadata for accurate
mobile-vs-landline detection, ~140 KB) ships in `node_modules`. No API key,
no network, $0. Loaded via a DI seam; falls back to the min build if `max`
is unavailable (type detection degrades to `unknown`, but E.164 + country +
validity still work).

---

## 6. Lead-scoring profiles

Each profile weights the 7 lead-score signals differently to reflect what
makes a listing attractive for a given outreach workflow. Weights sum to
1.0 per profile. Select with `--leadProfile <name>` (default `web-agency`).

| Profile | When to use | What it prioritizes |
|---|---|---|
| **`default`** | Balanced, general outreach. No specific angle. | Even split — no signal dominates. Mirrors the dashboard's published baseline. |
| **`web-agency`** *(default)* | Selling website redesigns / web presence. | Legitimacy + data quality + establishment. Keeps `digital_maturity` low-weight so low maturity (the opportunity) doesn't tank the composite. |
| **`reputation-mgmt`** | Selling reputation-management services. | Heavily weights `reputation` (the signal they sell against); underweights `digital_maturity` (orthogonal to their offer). |
| **`seo-agency`** | Selling SEO optimization. | Weights `digital_maturity` + `data_quality` (need a site to optimize) + `geo` (local SEO matters). |

### Per-profile weights

| Signal | `default` | `web-agency` | `reputation-mgmt` | `seo-agency` |
|---|---|---|---|---|
| `legitimacy` | 0.25 | 0.20 | 0.20 | 0.15 |
| `reputation` | 0.25 | 0.15 | **0.35** | 0.15 |
| `data_quality` | 0.20 | 0.20 | 0.15 | 0.20 |
| `digital_maturity` | 0.10 | 0.10 | 0.05 | **0.20** |
| `establishment` | 0.10 | 0.15 | 0.15 | 0.10 |
| `uniqueness` | 0.05 | 0.10 | 0.05 | 0.10 |
| `geo` | 0.05 | 0.10 | 0.05 | 0.10 |

### Examples

```bash
# Web agency — find legitimate, established businesses with outdated websites:
node src/index.js --query "Restaurant" --location "Toronto" --maxResults 200 \
  --output db --enrich on --enrichTechStack on --leadProfile web-agency --yes

# Reputation management — find businesses with high review volume + sentiment issues:
node src/index.js --query "Hotel" --location "Las Vegas" --maxResults 200 \
  --output db --enrich on --leadProfile reputation-mgmt --yes

# SEO agency — find businesses with a live site but low digital maturity:
node src/index.js --query "Plumber" --location "Austin" --maxResults 200 \
  --output db --enrich on --enrichTechStack on --leadProfile seo-agency --yes
```

> The `--leadProfile` CLI flag is pending Phase 3.13 CLI wiring († — see the
> master flag table in [§2](#2-quick-start)). The pipeline accepts the profile
> via `opts.leadProfile` today (`enrichBatch(businesses, { leadProfile:
> 'reputation-mgmt' })`); the default profile is `web-agency`.

The profile name is persisted in `lead_score_profile` so you can re-sort a
mixed batch later. The score itself reflects **signal strength**, not lead
value — e.g. low `digital_maturity` yields a low maturity subscore (which
modestly lowers the composite under `web-agency`), but the recommendation
surface flags "low maturity = outreach angle for web agencies".

The **spam cap** (§3.4) applies regardless of profile: a listing with
`isSpam=true` and `spamScore ≥ 65` is hard-capped at `lead_score=34`
(grade F, tier `disqualify`).

---

## 7. Grid-coverage guide

Whole-city scraping requires splitting the area into a grid of search
points because Google caps each query at ~120 results. This section walks
through the workflow.

> **CLI status:** the `--grid on` / `--gridBounds <string>` /
> `--gridCellSizeKm <km>` flags are part of the Phase 3.13 CLI-integration
> track (tracked separately, same as `npm run enrich`). The
> `--gridStepKm <km>` flag (env: `GRID_STEP_KM`, default `5`) is reserved
> in `.env.example`. Until the full CLI lands, drive grid coverage
> programmatically via `src/enrichment/grid-coverage.js`. The flags below
> are the **planned** names from `PHASE3_EXECUTION_PLAN.md` §3.11.

### Step 1 — Define the region

Three region shapes are supported:

```js
// (a) Center + radius (most common for whole-city):
const region = { center: { lat: 43.6532, lng: -79.3832 }, radiusKm: 10 };

// (b) Bounding box (S,W,N,E — for rectangular areas):
const region = { bbox: { south: 43.5, west: -79.6, north: 44.0, east: -79.1 } };

// (c) Polygon (for irregular city boundaries):
const region = { polygon: [{lat:43.6,lng:-79.4},{lat:43.7,lng:-79.4},/*...*/] };
```

Planned CLI equivalents:
```bash
--grid on --gridBounds "43.6532,-79.3832,10km"          # center,lat,lng,radiusKm
--grid on --gridBounds "43.5,-79.6,44.0,-79.1"          # south,west,north,east
```

### Step 2 — Generate the search points

```js
const { gridSearchPoints, estimateCoverage } = require('./src/enrichment/grid-coverage');

const points = gridSearchPoints(region, { query: 'restaurant', stepKm: 2 });
// → [{lat: 43.6045, lng: -79.4319, query: 'restaurant@43.604500,-79.431900',
//     label: 'grid-r0c0'}, ...]
```

**Step size matters:**
- Too coarse (step > 5 km) → gaps between grid points exceed Google's
  ~3 km result radius and businesses are missed.
- Too fine (step < 1 km) → wasted queries (overlapping result sets, more
  dedup work).
- Default urban range: **2–5 km**. Dense categories (restaurants) tighten
  to 1–2 km; sparse categories (plumbers) widen to 3–5 km.

### Step 3 — Submit one Maps query per point

Each point's `query` field is already formatted for the scraper's search
loop (`"term@lat,lng"`). The scraper submits one Maps query per point and
collects up to ~120 results per cell. For a 10 km × 10 km area at 2 km
step, that's a 5×5 grid = 25 cells = up to ~3,000 raw results.

### Step 4 — Merge overlapping results

Adjacent grid cells overlap by design (the boundary is fully covered).
The same business appears in multiple cells — Phase 3.3 dedup
([§3.3](#33-deduplication)) merges them by E.164 phone + name fuzzy match
+ address proximity, picking a canonical record and tracking the rest in
`business_duplicates`. No manual merge logic needed.

### Step 5 — Estimate coverage before you commit

```js
const cov = estimateCoverage(points, 8 /* listings/km² for restaurants */);
// → { totalPoints: 25, areaKm2: 100, estimatedListings: 800, coverageRatio: 1.0 }
```

- `coverageRatio` is `GOOGLE_RESULT_RADIUS_KM / (stepKm/√2)`, capped at 1.0.
  When `stepKm ≤ ~4.2 km`, the worst-case distance from any location to its
  nearest grid point stays within Google's result radius → `1.0` (full
  coverage). Coarser grids drop below 1.0, signalling gaps. **Aim for
  `coverageRatio = 1.0`.**
- `estimatedListings = areaKm2 × density`. Rough order-of-magnitude; real
  density varies by category (5/km² for plumbers, 20–50/km² for restaurants
  in city cores).

### Worked example — scrape all Toronto restaurants

```js
const { gridSearchPoints, estimateCoverage } = require('./src/enrichment/grid-coverage');

const region = { center: { lat: 43.6532, lng: -79.3832 }, radiusKm: 12 };
const points = gridSearchPoints(region, { query: 'restaurant', stepKm: 2 });

console.log(estimateCoverage(points, 25)); // Toronto restaurants ~25/km²
// → { totalPoints: ~169, areaKm2: ~576, estimatedListings: ~14400, coverageRatio: 1.0 }

// Then submit one Maps query per point to the scraper's queue, collect
// up to 120 results per cell, and let Phase 3.3 dedup merge overlaps.
```

**Safety cap:** `MAX_GRID_POINTS = 10000`. A 10000-point grid at 3 km
spacing covers ~90,000 km² (roughly all of Portugal) — anything larger is
almost certainly a caller mistake (swapped bbox units, decimal-degree
confusion with km). The cap prevents accidentally queueing millions of
search jobs.

---

## 8. Troubleshooting

### SMTP blacklisting

**Symptom:** `email_status='unverified'` for most emails; your IP ends up
on Spamhaus/greylists; downstream mail from the same IP starts bouncing.

**Cause:** Aggressive SMTP probing from a single IP looks like spam
reconnaissance. Many mail servers silently accept all `RCPT TO`
(catch-all), so `verified` is a soft signal at best anyway.

**Fix:**
- Run discovery-only (the default — no `--emailVerify on` flag). All
  `email_status='unverified'`, $0, no blacklist risk. Most outreach
  workflows only need the candidate email + a manual verify of a shortlist.
- If you must verify in bulk: run from a disposable IP, set
  `--enrichConcurrency 1`, and verify in off-peak batches.
- The probe already degrades to `unverified` on any error (DNS, socket,
  timeout, premature close) — a single flaky mail server never aborts a
  batch.

### Geocode quota exceeded

**Symptom:** Google geocoding stops partway through; `lat`/`lng` stay
`NULL` for the tail of the batch; log shows budget exhausted.

**Cause:** `--geocodeBudget <usd>` was hit (Google is $5/1k after the
$200/mo free tier).

**Fix:**
- Raise `--geocodeBudget`, or switch to `--geocoder nominatim` (free, 1
  req/s — slower but $0).
- The geocoder already falls back to `mock` (no coordinates) when the
  budget is exhausted, so the run completes — other enrichment phases
  continue. Geo-metrics (§3.8) falls back to raw scrape coordinates.
- Re-run the un-geocoded rows later: `SELECT place_id FROM businesses
  WHERE lat IS NULL` → feed to a standalone `npm run enrich` job with a
  fresh budget.

### Tech-stack false positives

**Symptom:** `website_tech_stack` lists technologies the site doesn't
actually use (e.g. a static HTML site flagged as "WordPress").

**Cause:** Signature collision — some detection rules match generic
patterns (`<meta name="generator">`, `/wp-includes/` paths, cookie names)
that can appear in non-standard sites. The 2 MB body cap may also truncate
large pages before the disambiguating signature loads.

**Fix:**
- Review the full `tech_stack_result` descriptor (NOT persisted — capture
  it from the CLI banner or a one-off script). It includes per-technology
  evidence (which rule matched, which header/HTML snippet).
- The fetcher is permissive on TLS (expired/self-signed certs are
  accepted) to maximize reach — this is by design. If it causes false
  `live` verdicts on dead domains, cross-check `website_status_code`.
- The 2 MB cap (`DEFAULT_MAX_BYTES = 2 * 1024 * 1024`) is deliberate —
  signatures live in `<head>`. If you need full-page detection, raise
  `maxBytes` in the programmatic API.

### Dedup over-merging

**Symptom:** Legitimately distinct businesses with similar names (two
independent "Burger King" franchises at different addresses, or "Joe's
Diner" and "Joe's Diner II") are merged into one canonical record.

**Cause:** `--dedupThreshold` too low (e.g. 0.75), or the name fuzzy match
(0.5 weight) is dominating because phone and address signals are missing.

**Fix:**
- Raise `--dedupThreshold` to `0.90` or `0.95`. The default `0.85` catches
  "McDonald's" vs "McDonalds" (0.95) and "Burger King" vs "Burger King
  Restaurant" (0.88), but not "Burger King" vs "Burger Joint" (0.55).
- Run `--dedupMerge off` (detect-only) first to inspect the
  `business_duplicates` table before committing to merges:
  ```sql
  SELECT canonical_place_id, duplicate_place_id, similarity_score, match_method
  FROM business_duplicates ORDER BY similarity_score ASC LIMIT 20;
  ```
- Ensure Phase 3.1 (phone E.164) and 3.2 (geocoded lat/lng) ran first —
  the phone (0.3 weight) and address-proximity (0.2 weight) signals
  disambiguate same-name distinct businesses.

### Dedup under-merging (false negatives)

**Symptom:** Obvious duplicates ("McDonald's" and "McDonalds" at the same
address) are NOT merged.

**Cause:** `--dedupThreshold` too high, or phone/address signals are
missing so the weighted score can't reach the threshold on name alone.

**Fix:** Lower `--dedupThreshold` to `0.80`. Ensure phone + geocode ran —
exact phone match (0.3) + address proximity (0.2) alone reach 0.5, so a
name fuzzy score of 0.35+ clears 0.85.

### Spam false positives

**Symptom:** A legitimate business is flagged `isSpam=true` and
`lead_score` is hard-capped at 34.

**Cause:** One of the 11 spam heuristics fired a false positive. The most
common culprits: `SUSPICIOUS_RATING` (a genuinely great new business with
5.0★ and few reviews), `GENERIC_NAME` (a real business with a generic
name), or `PHONE_REUSE` (two legitimate branches sharing a central
booking line).

**Fix:**
- Review the `spam_result.flags` array (NOT persisted — capture from the
  CLI banner or a one-off script). Each flag carries a `code`, `weight`,
  and `detail` explaining the trigger.
- The spam cap only fires when `spamScore ≥ 65` AND `isSpam=true`. A
  single low-weight flag rarely trips the cap on its own — usually 3+
  flags compound.
- If a flag is systematically wrong, the heuristic can be tuned in
  `src/enrichment/chain-detection.js` (each rule has a weight; lower the
  offending rule's weight). Don't disable rules wholesale — they catch
  real spam.

### Confidence too low

**Symptom:** Most listings have `confidence_score < 0.40` (band `low` or
`very_low`), even ones with strong lead scores.

**Cause:** Missing fields. Each of `name`/`phone`/`address`/`website`/
`rating`/`reviews`/`lat-lng` missing nibbles 2 points off the base of 50;
high-impact gaps (phone, website, address, geocode) fire additional
explicit `MISSING_*` factors. Pipeline descriptors that didn't run
(tech-stack skipped, no reviews for sentiment) contribute nothing — only
their absence from `signalCoverage` is noted.

**Fix:**
- Check the `confidence_result.missingFields` array (NOT persisted —
  capture from the CLI banner). It lists exactly which fields are missing.
- Run the network phases you skipped: `--enrichTechStack on` (fills
  `website_*`), `--geocoder nominatim` (fills `lat`/`lng`/
  `geocode_confidence`), `--enrichEmail on` (fills `email`).
- If missing fields are a scrape-quality issue (Phase 1/2 extraction
  rates), address that first — enrichment can't synthesize data the
  scraper didn't collect.

### Phone normalization failures

**Symptom:** `phone_e164` is `NULL` and `phone_type='invalid'` for numbers
that look valid.

**Cause:** Local-format numbers without a `+` prefix can't be parsed
without a region hint. `libphonenumber-js` doesn't infer the country from
the number alone.

**Fix:** Pass `--phoneDefaultCountry <ISO>` (e.g. `--phoneDefaultCountry
CA` for Toronto, `DE` for Berlin, `BD` for Dhaka). The hint is used when a
scraped phone lacks a `+` prefix. The pipeline's region-resolution
priority is: `opts.defaultCountry` > `business.phone_default_country` >
`business.address_country` > `null`.

### Grid generates too many / too few points

**Symptom:** `estimateCoverage` returns `totalPoints` in the thousands (too
many) or `coverageRatio < 1.0` (gaps).

**Cause:** Step size mismatched to the region or category density.

**Fix:**
- Too many points → raise `stepKm` (e.g. 2 → 5). The `MAX_GRID_POINTS =
  10000` cap will refuse grids larger than that anyway.
- Gaps (`coverageRatio < 1.0`) → lower `stepKm`. Aim for `coverageRatio =
  1.0`, which requires `stepKm ≤ ~4.2 km` (so the worst-case distance from
  any location to its nearest grid point stays within Google's ~3 km result
  radius).
- For dense categories (restaurants in city cores), use `stepKm: 1–2`.
  For sparse categories (rural plumbers), `stepKm: 3–5` is fine.

---

## 9. Backward compatibility

`--enrich off` (the default) preserves Phase 2 behavior **byte-for-byte**:

- No enrichment pipeline runs.
- No enrichment columns are written (all 25 stay `NULL`).
- No network calls beyond what Phase 2 already makes (no geocoding, no
  SMTP, no tech-stack HTTP).
- No `business_duplicates` rows are written.
- `data_hash` is computed exactly as in Phase 2 (enrichment columns are
  excluded from the hash, but they're also `NULL` so it's a no-op).
- CSV/JSON export column order is unchanged (enrichment columns are
  DB-only — they don't appear in CSV/JSON unless you SELECT them
  explicitly).

When `--enrich on` is passed but a specific feature is off (e.g.
`--enrichTechStack off`), that feature's columns stay `NULL` and downstream
phases degrade gracefully (lead-score's `digital_maturity` signal falls
back to neutral 50 with a note).

### Enrichment columns and `data_hash`

Enrichment columns are **excluded** from `data_hash` (the SHA-256 that
drives Phase 2.2 change-tracking). A re-enrichment (algorithm update,
different country hint, different scoring profile) does **NOT** trigger
`field_changes` rows or bump `updated_at` — only a real scrape change
(rating/reviews/phone/website/business_status) counts as "the business's
data changed". This keeps the change-tracking feed clean: it reflects
scrape-side reality, not enrichment-side recomputation.

### Enrichment versioning

Each enriched row is stamped with `enrichment_version=1` (the current
pipeline version) and `enriched_at=<timestamp>`. When the algorithm or
schema changes, bump `ENRICHMENT_VERSION` in `src/enrichment/index.js`;
rows with a lower version get re-enriched on the next pipeline run.

---

## 10. Persisted columns reference

The canonical list is `ENRICHMENT_COLUMNS` in
`src/enrichment/index.js` (aggregated from each sub-phase module). Mirrored
by `migrations/003-enrichment.sql`. 25 columns total — `dedup` and
`grid-coverage` contribute none (dedup writes to a separate
`business_duplicates` table; grid drives search input, not DB columns).

| Column | Phase | Type | Notes |
|---|---|---|---|
| `phone_e164` | 3.1 | TEXT | `+14165550123`, or `NULL` if invalid. |
| `phone_type` | 3.1 | TEXT | `mobile` \| `landline` \| `toll_free` \| `voip` \| `invalid` \| `unknown`. |
| `phone_country_code` | 3.1 | TEXT | ISO 2-letter (`US`, `DE`, `BD`, …). |
| `address_street` | 3.2 | TEXT | "123 Main St". |
| `address_city` | 3.2 | TEXT | "Springfield". |
| `address_state` | 3.2 | TEXT | "IL". |
| `address_postal` | 3.2 | TEXT | "62701". |
| `address_country` | 3.2 | TEXT | ISO 2-letter (`US`). |
| `lat` | 3.2 | NUMERIC(10,7) | Geocoded latitude (NULL if no geocode). |
| `lng` | 3.2 | NUMERIC(10,7) | Geocoded longitude. |
| `geocode_confidence` | 3.2 | NUMERIC(3,2) | 0.00–1.00. |
| `email` | 3.5 | TEXT | Best candidate email (or `NULL`). |
| `email_status` | 3.5 | TEXT | `verified` \| `unverified` \| `invalid` \| `no_mx`. |
| `website_tech_stack` | 3.6 | JSONB | Array of detected technology names. |
| `website_status_code` | 3.6 | INTEGER | HTTP status (or `NULL` if unreachable). |
| `website_liveness` | 3.6 | TEXT | `live` \| `dead` \| `redirected` \| `error`. |
| `sentiment_score` | 3.7 | NUMERIC(4,2) | −1.00..+1.00. |
| `sentiment_themes` | 3.7 | JSONB | `{aspect: score}` for the 8 aspects. |
| `competitor_density_1km` | 3.8 | INTEGER | Other businesses within 1 km. |
| `competitor_density_5km` | 3.8 | INTEGER | Other businesses within 5 km. |
| `lead_score` | 3.9 | INTEGER | 0–100 (spam-capped at 34). |
| `lead_score_profile` | 3.9 | TEXT | `default` \| `web-agency` \| `reputation-mgmt` \| `seo-agency`. |
| `confidence_score` | 3.10 | NUMERIC(4,2) | 0.00–1.00. |
| `enriched_at` | pipeline | TIMESTAMPTZ | When enrichment last ran. |
| `enrichment_version` | pipeline | INTEGER | Pipeline algorithm version (currently `1`). |

### Separate table: `business_duplicates` (Phase 3.3)

| Column | Type | Notes |
|---|---|---|
| `canonical_place_id` | TEXT | The chosen canonical business's `place_id`. |
| `duplicate_place_id` | TEXT | The merged duplicate's `place_id`. |
| `similarity_score` | NUMERIC(4,3) | 0.000–1.000. |
| `match_method` | TEXT | `name` \| `phone` \| `address` \| `composite`. |

Unique constraint on `(canonical_place_id, duplicate_place_id)` makes
re-runs idempotent.

### Not persisted (in-memory descriptors)

These descriptors are attached to each business object during the pipeline
run, consumed by downstream phases, and discarded before persistence. To
inspect them, capture the CLI banner output or run a one-off script
calling `enrichBatch` directly.

| Descriptor | Phase | Feeds |
|---|---|---|
| `phone_normalized` | 3.1 | lead-score, confidence |
| `address_parsed` | 3.2 | (debug only) |
| `dedup_result` | 3.3 | lead-score, confidence |
| `chain_result` | 3.4 | lead-score, confidence |
| `spam_result` | 3.4 | lead-score (spam cap), confidence |
| `tech_stack_result` | 3.6 | lead-score, confidence |
| `sentiment_result` | 3.7 | lead-score, confidence |
| `geo_result` | 3.8 | lead-score, confidence |
| `lead_result` | 3.9 | CLI banner |
| `confidence_result` | 3.10 | CLI banner |

---

*End of ENRICHMENT.md — Phase 3 enrichment runbook. For the production
scrape runbook (10k-listing overnight run, proxy + CAPTCHA budgeting,
monitoring, recovery), see [`OPERATIONS.md`](OPERATIONS.md). For the
system architecture and module map, see [`ARCHITECTURE.md`](ARCHITECTURE.md).*
