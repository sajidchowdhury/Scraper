# Google Maps Scraper — World-Class Feature Roadmap

> **Perspective:** This document is written from the viewpoint of a **professional scraping service provider** who sells scraped business data to paying clients (lead-gen agencies, real-estate firms, sales teams, market researchers, directory builders).
>
> The goal is to take the current scaffold (`main.js` — opens Maps, searches, detects feed) and evolve it into a **commercial-grade, sellable scraping product**. Features are organized in phases, from MVP to enterprise. **No code — only feature specs.**

---

## Table of Contents

1. [Guiding Principles](#1-guiding-principles)
2. [Phase 1 — MVP: Get Sellable Data Fast](#2-phase-1--mvp-get-sellable-data-fast)
3. [Phase 2 — Robustness & Scale](#3-phase-2--robustness--scale)
4. [Phase 3 — Data Quality & Enrichment](#4-phase-3--data-quality--enrichment)
5. [Phase 4 — Client Delivery & Monetization](#5-phase-4--client-delivery--monetization)
6. [Phase 5 — Enterprise & World-Class](#6-phase-5--enterprise--world-class)
7. [Compliance, Ethics & Legal Layer](#7-compliance-ethics--legal-layer)
8. [Feature Priority Matrix](#8-feature-priority-matrix)

---

## 1. Guiding Principles

As a scraper-as-a-service business, every feature must serve one of these goals:

| Goal | Why it matters for a paid service |
|---|---|
| **Data accuracy** | Clients pay for *correct* data. Wrong phone numbers = refunds and lost clients. |
| **Reliability / uptime** | Scraping breaks constantly (Google changes UI). Self-healing = fewer support tickets. |
| **Scale** | One client wants 50 results; another wants 500,000. The engine must handle both. |
| **Stealth / longevity** | Getting blocked kills the business. Anti-detection is a core feature, not an add-on. |
| **Client self-service** | The less hand-holding, the higher the margin. Dashboards & APIs beat email attachments. |
| **Compliance** | One legal complaint can shut everything down. Built-in respect for `robots.txt`, rate limits, and ToS. |

---

## 2. Phase 1 — MVP: Get Sellable Data Fast

*The first milestone a paying client would actually accept. Turns "I can open Maps" into "I can deliver a CSV of 200 restaurants with real contact info."*

### 2.1 Search & Input
- **Search query input** via CLI argument, config file, or `.env` (instead of hardcoded `"Restaurant Toronto"`).
- **Location targeting** — search by city, state, country, postal code, or custom lat/lng radius.
- **Category / keyword lists** — accept a file of multiple queries (e.g., `plumber, electrician, hvac`) and run them sequentially.
- **Pagination / infinite scroll handling** — auto-scroll the results feed until all businesses in the area are loaded (Google Maps lazy-loads; without this you only get ~20 results).

### 2.2 Core Data Extraction (the "money fields")
For each business, extract:

- Business name
- Average rating (e.g., 4.5)
- Number of reviews (e.g., 1,234)
- Price level ($, $$, $$$, $$$$)
- Category / type (e.g., "Mexican restaurant")
- Full address (street, city, state, postal code, country — parsed into separate columns)
- Phone number (E.164 normalized + raw)
- Website URL
- Google Maps place URL / CID / place_id
- Plus code (open-location code)
- Opening hours (per-day, structured)
- "Open now" status at time of scrape
- Geographic coordinates (latitude / longitude)
- Business status (operational, permanently closed, temporarily closed)
- Claimed / unclaimed listing status

### 2.3 Basic Output
- **CSV export** (already has `csv-writer` dependency) with sensible column order.
- **JSON export** for clients who want nested data (hours, categories as arrays).
- **UTF-8 / Excel-safe CSV** (handle commas, quotes, non-Latin characters, emojis in business names).
- Timestamp column on every row (`scraped_at`) so clients know data freshness.

### 2.4 Basic Reliability
- **Retry on transient failure** (network blips, slow loads) — 3 attempts with backoff.
- **Timeout protection** — never hang forever on a stuck page (currently `main.js` does `await new Promise(() => {})` which hangs indefinitely — must be removed).
- **Crash recovery** — if the script dies at row 150/200, resume from 150 instead of restarting.
- **Structured logging** — console + file log with timestamps, severity levels (INFO/WARN/ERROR).

### 2.5 Minimal Anti-Block
- **Realistic delays** between actions (random 1–4s, not fixed).
- **Human-like typing speed** in the search box.
- **Respect rate limiting** — configurable max requests per minute.

---

## 3. Phase 2 — Robustness & Scale

*Now the scraper survives a full overnight run of 10,000+ listings without dying.*

### 3.1 Anti-Detection & Stealth
- **Rotating residential proxies** — integrate proxy pools (Bright Data, Smartproxy, Oxylabs, or self-hosted). Rotate per request or per session.
- **Browser fingerprint randomization** — randomize user-agent, viewport, timezone, language, WebGL, canvas, fonts, screen resolution per session.
- **Stealth plugin** — patch `navigator.webdriver`, automate permissions, spoof headless indicators.
- **Headless + headed modes** — run headless in production, headed for debugging.
- **CAPTCHA detection & solving** — detect reCAPTCHA/hCaptcha triggers; integrate solving services (2Captcha, Anti-Captcha, CapSolver) as fallback.
- **Cookie / session rotation** — start fresh session every N requests.
- **Google account warmup (optional)** — log in with aged accounts to unlock more data and reduce challenge frequency.

### 3.2 Concurrency & Performance
- **Multi-browser / multi-context concurrency** — run N pages in parallel (e.g., 5–20 workers).
- **Job queue** (BullMQ / Redis or in-memory) — queue hundreds of search tasks, process with worker pool.
- **Per-worker proxy assignment** — each worker uses its own proxy + fingerprint.
- **Graceful degradation** — if one worker gets blocked, mark its proxy as burned, rotate to a new one, continue.
- **Memory management** — periodically restart browser contexts to avoid Playwright memory leaks on long runs.

### 3.3 Detail-Page Crawling
- **Deep scrape per business** — click into each business's detail panel to fetch fields not in the list view:
  - Full opening hours (all 7 days)
  - Popular times histogram
  - Top reviews (text + author + rating + date)
  - Photos (URLs + metadata)
  - Q&A section
  - "People also search for" related businesses
  - Menu (for restaurants)
  - Reservation / booking links
  - Social media profiles (Instagram, Facebook)
- **Detail-page caching** — don't re-scrape a business already scraped in the last X days.

### 3.4 Self-Healing Selectors
- **Multiple fallback selectors** per field — Google changes DOM constantly; if `div[role="feed"]` breaks, try alternates.
- **Selector auto-discovery** — heuristic-based field detection (find the element containing a phone-number pattern, etc.).
- **Health checks** — after each scrape, verify expected field count; alert if extraction rate drops below threshold (early warning of a DOM change).

### 3.5 Robust Data Pipeline
- **PostgreSQL persistence** (dependency already installed) — store raw + cleaned data with proper schema.
- **Idempotency** — re-scraping the same place updates the row instead of duplicating.
- **Change tracking** — keep history of rating/review-count changes over time (clients love trend data).
- **Incremental scraping** — only re-scrape listings modified since last run (via place_id + last-updated heuristic).

---

## 4. Phase 3 — Data Quality & Enrichment

*This is where you stop selling "scraped data" and start selling **enriched, verified leads** — at 5× the price.*

### 4.1 Data Cleaning & Normalization
- **Phone number normalization** — convert all formats to E.164; detect and flag invalid/mobile/landline/toll-free.
- **Address parsing & verification** — split into structured fields; verify against Google Geocoding API or postal services.
- **Deduplication** — detect same business listed under slightly different names (fuzzy match on name + address + phone).
- **Chain detection** — flag businesses that belong to a franchise/chain (e.g., all "Subway" locations).
- **Spam / fake-listing detection** — flag listings with suspicious patterns (new, no reviews, no website, keyword-stuffed name).
- **Language / locale normalization** — detect listing language; translate category names to English if needed.

### 4.2 Enrichment (third-party data stitched in)
- **Email discovery** — guess/verify business emails from website domain (e.g., info@, contact@, hello@) via pattern + SMTP verification.
- **Website tech stack detection** — what CMS/framework the business's site uses (Wix, WordPress, Shopify, custom) — valuable for web-dev agencies selling redesigns.
- **Social media follower counts** — pull from Instagram/Facebook APIs or scraping.
- **Review sentiment analysis** — run NLP on reviews to classify positive/negative themes (food quality, service, cleanliness).
- **Competitor density** — count nearby same-category businesses within X km.
- **Foot-traffic estimates** — from popular-times data, estimate peak hours and busyness.
- **Domain authority / SEO metrics** — for businesses with websites, pull DA/backlinks (via Moz/Ahrefs APIs) — great for SEO-agency clients.
- **Lead scoring** — combine signals (no website → high-value lead for web agencies; low rating → lead for reputation-management services).

### 4.3 Data Validation
- **Phone verification** — SMTP/caller-style ping to confirm the number is live.
- **Email verification** — syntax + domain MX + mailbox existence check.
- **Website liveness check** — HTTP HEAD to confirm site is up; flag dead links.
- **Confidence score per field** — 0–100% based on source reliability and cross-checks.

### 4.4 Geospatial Features
- **Polygon / radius search** — scrape every business inside a drawn area on a map, not just a city name.
- **Grid-based coverage** — split a large region into a grid of search points to avoid Google's result cap (~120 per query).
- **Distance calculations** — compute distance from a target point for each result.
- **Heatmap export** — generate density maps of scraped businesses.

---

## 5. Phase 4 — Client Delivery & Monetization

*Now it's a product, not a script. Clients can self-serve, pay, and download without emailing you.*

### 5.1 Client Web Dashboard
- **Account registration & login** (NextAuth — already in stack).
- **Order wizard** — client picks: location, category, number of leads, fields needed, delivery format.
- **Live job progress** — see their scrape running in real time (progress bar, rows scraped, ETA).
- **Data preview** — preview first 10 rows before downloading.
- **Download center** — re-download past orders for 30/90 days.
- **Saved searches / subscriptions** — "scrape plumbers in NYC every Monday and email me the new ones."
- **Usage & billing dashboard** — credits remaining, invoices, payment history.

### 5.2 API Access (for developer clients)
- **REST API** with API keys — `GET /api/v1/search?location=...&category=...&limit=...`.
- **Webhook callbacks** — notify client's system when a large async job finishes.
- **Async job submission** — `POST /jobs` returns a `job_id`; poll or webhook for results.
- **Rate limiting per API tier** — free/pro/enterprise quotas.
- **API documentation** — OpenAPI/Swagger spec + interactive docs.
- **SDKs** — official Python/JS/PHP clients (huge differentiator).

### 5.3 Delivery Formats
- CSV, XLSX, JSON, JSONL
- **Direct-to-client integrations**: push to their Google Sheets, Airtable, HubSpot, Salesforce, Pipedrive, Webflow.
- **Webhook to Zapier/Make.com** for no-code clients.
- **Postgres / MySQL direct export** to client's DB.
- **Custom field mapping** — client maps scraped fields to their CRM schema.

### 5.4 Monetization / Billing
- **Credit-based pricing** — 1 credit = 1 enriched lead; packages of 100/1k/10k.
- **Subscription tiers** — monthly plans with included credits + overage pricing.
- **Pay-per-custom-field** — base price + upsells (email discovery, sentiment, SEO metrics).
- **Stripe / Razorpay / PayPal integration**.
- **Invoice generation** (PDF) + tax handling (VAT/GST).
- **Free trial credits** on signup (e.g., 50 free leads).
- **Referral / affiliate program** — clients earn credits for referring others.

### 5.5 Niche Product Packages
Pre-built, market-ready datasets verticals love to buy:
- **Restaurants without a website** → sell to web-design agencies.
- **Businesses with <3-star rating** → sell to reputation-management firms.
- **Newly opened businesses (last 30 days)** → sell to signage/insurance/POS vendors.
- **Businesses with Instagram but no booking system** → sell to booking-software vendors.
- **Salons/barbershops in a city** → sell to beauty-supply wholesalers.

### 5.6 Notifications & Comms
- **Email notifications** — job started / completed / failed.
- **Slack/Discord/Telegram bot** — instant alerts for clients and internal ops.
- **In-app toasts** for dashboard actions.

---

## 6. Phase 5 — Enterprise & World-Class

*The tier where you compete with Apollo.io, ZoomInfo-tier local data, and win B2B contracts.*

### 6.1 Scheduling & Orchestration
- **Cron-style scheduler** — run scrapes daily/weekly/monthly per client.
- **Distributed workers** — multiple machines/containers behind a queue manager.
- **Kubernetes / Docker deployment** — auto-scale workers based on queue depth.
- **Job priorities** — paid clients jump the queue ahead of free-tier.
- **Dependency graphs** — scrape categories → enrich → validate → deliver, as a DAG.

### 6.2 Monitoring & Observability
- **Real-time dashboard** (Grafana) — requests/sec, success rate, proxy health, CAPTCHA solve rate, cost per lead.
- **Per-proxy burn-rate tracking** — auto-retire dead proxies, alert when pool low.
- **Alerting** — PagerDuty/Slack on: block-rate > 5%, extraction-rate < 80%, queue backlog, worker death.
- **Audit trail** — every scrape logged with who/what/when for compliance.
- **Uptime SLO tracking** — 99.5% job success rate guarantees for enterprise contracts.

### 6.3 Data Freshness & Live Feeds
- **Continuous freshness scoring** — every record has a `last_verified` timestamp.
- **Auto re-scrape cadence** — high-value records refreshed weekly; others monthly.
- **Delta detection** — flag businesses that changed (closed, moved, rebranded) and notify subscribed clients.
- **Streaming API** (WebSocket / Kafka) — push new/changed businesses to clients in real time.

### 6.4 Multi-Source Federation
Google Maps alone has gaps. A world-class product cross-references:
- **Yelp** — for additional reviews and categories.
- **Yellow Pages / Yelp / Foursquare** — for businesses missing from Google.
- **OpenStreetMap / Overpass API** — free, open data fallback.
- **Facebook Places** — for social-native businesses.
- **LinkedIn** — for B2B firmographics (employee count, industry, revenue).
- **Official business registries** — UK Companies House, US state registries, etc.
- **Apple Maps** — growing data source, less scraped.

Merge into a single canonical record per business with source provenance on each field.

### 6.5 AI / ML Layer
- **LLM-powered field extraction** — when DOM selectors break, use a vision-language model to read the page and extract fields semantically (huge resilience boost).
- **Auto-classification** — LLM categorizes businesses into a clean taxonomy even when Google's categories are messy.
- **Review summarization** — "Customers praise the tacos but complain about slow service" auto-generated per business.
- **Anomaly detection** — ML flags suspicious data (likely-closed businesses, fake reviews).
- **Smart query expansion** — given "plumber," auto-expand to "plumbing contractor," "emergency plumber," "gas fitter" to maximize coverage.
- **Predictive lead scoring** — ML model predicts which businesses are most likely to buy a client's service.

### 6.6 Compliance & Governance (enterprise-grade)
- **GDPR / CCPA compliance** — only scrape public business data (not personal data); provide deletion endpoints.
- **Data licensing clarity** — explicit terms on what clients can do with the data.
- **PII redaction** — strip reviewer names/emails from review exports unless licensed.
- **Robots.txt / ToS respect mode** — configurable per-source compliance level.
- **SOC 2 / ISO 27001 readiness** — logging, access controls, encryption for enterprise sales.

### 6.7 White-Label & Reseller
- **White-label dashboard** — clients can resell your data under their own brand.
- **Reseller API keys** — sub-accounts with revenue sharing.
- **Custom data feeds** — SFTP/CSV drops to enterprise clients on a schedule.

---

## 7. Compliance, Ethics & Legal Layer

*Non-negotiable for a sustainable scraping business. Skipping this = lawsuits and takedowns.*

### 7.1 Technical Compliance
- **Configurable request rate** — never exceed a per-domain RPS cap.
- **robots.txt parser** — respect per-path directives; log violations.
- **Off-peak scheduling** — bias heavy scrapes to nights/weekends to minimize impact.
- **Cached re-serving** — never re-scrape what you already have fresh; serve from cache.
- **Exponential backoff on 429/503** — back off immediately when rate-limited.

### 7.2 Data Governance
- **Source provenance** — every field stores which source + scrape-time it came from.
- **Retention policies** — auto-delete raw HTML after N days; keep only structured data.
- **Right-to-be-forgotten workflow** — process takedown requests within 48h (manual + automated path).
- **Public-data-only commitment** — documented policy that no private individual data is collected.
- **ToS review per source** — maintain a living doc of each source's ToS and scraping posture.

### 7.3 Client Contracts
- **Clear data-license agreement** — clients agree to use data lawfully.
- **Indemnification clause** — clients bear responsibility for their use of the data.
- **Acceptable-use policy** — no spamming, no stalking, no discriminatory use.

---

## 8. Feature Priority Matrix

Quick reference for what to build when, ranked by **revenue impact vs. effort**.

| Phase | Feature | Revenue Impact | Effort | Priority |
|---|---|---|---|---|
| 1 | Core field extraction (name/phone/address/website) | 🔴 Critical | Low | **P0** |
| 1 | Pagination / infinite scroll | 🔴 Critical | Low | **P0** |
| 1 | CSV + JSON export | 🔴 Critical | Low | **P0** |
| 1 | Remove infinite-hang bug | 🔴 Critical | Trivial | **P0** |
| 1 | Config-driven search input | 🟡 High | Low | **P0** |
| 2 | Detail-page deep scrape | 🔴 Critical | Medium | **P1** |
| 2 | Rotating proxies | 🔴 Critical | Medium | **P1** |
| 2 | Stealth / fingerprinting | 🔴 Critical | Medium | **P1** |
| 2 | PostgreSQL persistence | 🟡 High | Low | **P1** |
| 2 | CAPTCHA solving | 🟡 High | Medium | **P1** |
| 2 | Self-healing selectors | 🟡 High | Medium | **P1** |
| 3 | Phone/email validation | 🔴 Critical | Medium | **P2** |
| 3 | Email discovery | 🔴 Critical | Medium | **P2** |
| 3 | Deduplication | 🟡 High | Medium | **P2** |
| 3 | Website tech-stack detection | 🟡 High | Low | **P2** |
| 3 | Grid-based geo-coverage | 🟡 High | Medium | **P2** |
| 4 | Client web dashboard | 🔴 Critical | High | **P2** |
| 4 | REST API | 🔴 Critical | High | **P2** |
| 4 | Stripe billing | 🔴 Critical | Medium | **P2** |
| 4 | CRM/Sheets integrations | 🟡 High | Medium | **P3** |
| 4 | Subscription/saved searches | 🟡 High | Medium | **P3** |
| 5 | Scheduling & distributed workers | 🟡 High | High | **P3** |
| 5 | Monitoring (Grafana/PagerDuty) | 🟡 High | Medium | **P3** |
| 5 | LLM field extraction (resilience) | 🟢 Medium | High | **P3** |
| 5 | Multi-source federation | 🟢 Medium | High | **P3** |
| 5 | Real-time delta feeds | 🟢 Medium | High | **P4** |
| 5 | White-label / reseller | 🟢 Medium | High | **P4** |

---

## Summary: From Script to Business

| Stage | What you have | What clients pay |
|---|---|---|
| **Today** | A script that opens Maps and finds the feed | Nothing — not sellable yet |
| **End of Phase 1** | A script that exports CSVs of business data | $50–$200 per dataset (hand-delivered) |
| **End of Phase 2** | A reliable scraper that survives 10k+ listings overnight | $500–$2k per bulk order |
| **End of Phase 3** | Enriched, verified, scored leads | $0.05–$0.50 per lead (10× price) |
| **End of Phase 4** | Self-serve SaaS with dashboard + API + billing | $50–$2k/month recurring revenue per client |
| **End of Phase 5** | Enterprise platform competing with Apollo/ZoomInfo-tier local data | $5k–$50k/month enterprise contracts |

The leap from **Phase 3 → Phase 4** is the biggest inflection point: it's where you stop trading time for money and start building a scalable, sellable product.
