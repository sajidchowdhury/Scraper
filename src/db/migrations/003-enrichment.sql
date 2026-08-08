-- ===========================================================================
-- gmaps-scraper — Phase 3.0 — Enrichment Schema Extension
-- ===========================================================================
-- Idempotent: every statement uses IF NOT EXISTS or a DO $$ guard, so this
-- file can be re-run safely on an existing Phase 2 database (it will no-op).
-- Run via `npm run db:migrate` (the migration runner executes schema.sql first,
-- then every *.sql file in src/db/migrations/ in sorted order).
--
-- Design notes:
--   - This migration adds the columns every Phase 3 enrichment sub-phase writes
--     into. Adding them all up-front means no migration churn mid-phase (3.1
--     phone, 3.2 address, 3.5 email, 3.6 tech-stack, 3.7 sentiment, 3.8 geo,
--     3.9 lead-score, 3.10 confidence all reuse these columns).
--   - Every ALTER TABLE is wrapped in a DO $$ ... IF NOT EXISTS (...) guard so
--     the migration is re-runnable against a Phase 2.12 database.
--   - A new `business_duplicates` table records dedup-cluster decisions
--     (Phase 3.3) so re-runs don't re-compute fuzzy matches.
--   - `enrichment_version` lets future re-enrichment triggers detect stale
--     rows (bump the version when the enrichment algorithm changes; rows with
--     a lower version get re-enriched).
--   - All NULL-defaultable — Phase 2 behavior is preserved until enrichment
--     actually runs (enrichment is opt-in via --enrich).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Phase 3.1 — Phone normalization & validation
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'phone_e164'
  ) THEN
    ALTER TABLE businesses ADD COLUMN phone_e164 TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'phone_type'
  ) THEN
    ALTER TABLE businesses ADD COLUMN phone_type TEXT;
    -- mobile | landline | toll_free | voip | invalid | unknown
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'phone_country_code'
  ) THEN
    ALTER TABLE businesses ADD COLUMN phone_country_code TEXT;
    -- ISO 3166-1 alpha-2 (e.g. 'US', 'GB', 'BD')
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Phase 3.2 — Address parsing & geocoding
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'address_street'
  ) THEN
    ALTER TABLE businesses ADD COLUMN address_street TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'address_city'
  ) THEN
    ALTER TABLE businesses ADD COLUMN address_city TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'address_state'
  ) THEN
    ALTER TABLE businesses ADD COLUMN address_state TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'address_postal'
  ) THEN
    ALTER TABLE businesses ADD COLUMN address_postal TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'address_country'
  ) THEN
    ALTER TABLE businesses ADD COLUMN address_country TEXT;
  END IF;
END $$;

-- Geocoded coordinates (Phase 3.2 writes verified lat/lng here; distinct from
-- the Phase 1 forward-compatible latitude/longitude columns which hold the
-- raw scrape coordinates). geocode_confidence is 0.00–1.00.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'lat'
  ) THEN
    ALTER TABLE businesses ADD COLUMN lat NUMERIC(10, 7);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'lng'
  ) THEN
    ALTER TABLE businesses ADD COLUMN lng NUMERIC(10, 7);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'geocode_confidence'
  ) THEN
    ALTER TABLE businesses ADD COLUMN geocode_confidence NUMERIC(3, 2);
    -- 0.00–1.00
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Phase 3.5 — Email discovery & verification
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'email'
  ) THEN
    ALTER TABLE businesses ADD COLUMN email TEXT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'email_status'
  ) THEN
    ALTER TABLE businesses ADD COLUMN email_status TEXT;
    -- verified | unverified | invalid | no_mx
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Phase 3.6 — Website tech-stack detection (+ Phase 3.3 liveness check)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'website_tech_stack'
  ) THEN
    ALTER TABLE businesses ADD COLUMN website_tech_stack JSONB;
    -- ["WordPress","MySQL","Nginx", ...]
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'website_status_code'
  ) THEN
    ALTER TABLE businesses ADD COLUMN website_status_code INT;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'website_liveness'
  ) THEN
    ALTER TABLE businesses ADD COLUMN website_liveness TEXT;
    -- live | dead | redirected | error
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Phase 3.7 — Review sentiment analysis
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'sentiment_score'
  ) THEN
    ALTER TABLE businesses ADD COLUMN sentiment_score NUMERIC(4, 2);
    -- -1.00 to +1.00
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'sentiment_themes'
  ) THEN
    ALTER TABLE businesses ADD COLUMN sentiment_themes JSONB;
    -- { "food": 0.6, "service": -0.3, "cleanliness": 0.1 }
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Phase 3.8 — Competitor density (geospatial metrics)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'competitor_density_1km'
  ) THEN
    ALTER TABLE businesses ADD COLUMN competitor_density_1km INT;
    -- same-category count within 1 km
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'competitor_density_5km'
  ) THEN
    ALTER TABLE businesses ADD COLUMN competitor_density_5km INT;
    -- same-category count within 5 km
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Phase 3.9 — Lead scoring
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'lead_score'
  ) THEN
    ALTER TABLE businesses ADD COLUMN lead_score INT;
    -- 0–100 composite
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'lead_score_profile'
  ) THEN
    ALTER TABLE businesses ADD COLUMN lead_score_profile TEXT;
    -- which scoring profile was used (e.g. 'web-agency', 'reputation-mgmt')
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Phase 3.10 — Per-field confidence score
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'confidence_score'
  ) THEN
    ALTER TABLE businesses ADD COLUMN confidence_score NUMERIC(4, 2);
    -- 0.00–1.00 per-record composite
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Enrichment provenance + re-enrichment trigger columns
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'enriched_at'
  ) THEN
    ALTER TABLE businesses ADD COLUMN enriched_at TIMESTAMPTZ;
    -- when enrichment last ran for this row
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'businesses' AND column_name = 'enrichment_version'
  ) THEN
    ALTER TABLE businesses ADD COLUMN enrichment_version INT;
    -- schema version for re-enrichment triggers (bump to force re-enrich)
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Indexes to support enrichment queries:
--   1. (lead_score) — "show me my top leads" ordering.
--   2. (enrichment_version) — "find stale rows needing re-enrichment".
--   3. (enriched_at) — "find rows never enriched" (NULL) or oldest.
--   4. (email_status) — "show me verified-email leads only".
--   5. (phone_type) — "show me mobile numbers only" (SMS campaigns).
--   6. (website_liveness) — "show me businesses with dead websites" (web-agency leads).
--   7. (lat, lng) GiST point — competitor-density radius queries (Phase 3.8).
--      Uses a geography(point) expression index for ST_DWithin queries.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_businesses_lead_score
  ON businesses (lead_score DESC);

CREATE INDEX IF NOT EXISTS idx_businesses_enrichment_version
  ON businesses (enrichment_version);

CREATE INDEX IF NOT EXISTS idx_businesses_enriched_at
  ON businesses (enriched_at);

CREATE INDEX IF NOT EXISTS idx_businesses_email_status
  ON businesses (email_status);

CREATE INDEX IF NOT EXISTS idx_businesses_phone_type
  ON businesses (phone_type);

CREATE INDEX IF NOT EXISTS idx_businesses_website_liveness
  ON businesses (website_liveness);

-- GiST point index for geospatial radius queries (Phase 3.8 competitor density
-- + Phase 3.11 grid coverage). Created via DO $$ guard so it no-ops if the
-- extension or index already exists. Requires PostGIS for ST_DWithin; if
-- PostGIS is not installed this block is skipped (competitor density falls
-- back to a haversine JS computation — see src/enrichment/geo-metrics.js).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'postgis'
  ) THEN
    -- PostGIS not installed — skip the GiST index. The haversine fallback in
    -- src/enrichment/geo-metrics.js handles radius queries without PostGIS.
    RAISE NOTICE 'PostGIS not installed — skipping geo GiST index (haversine fallback will be used).';
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE indexname = 'idx_businesses_geo_point'
    ) THEN
      CREATE INDEX idx_businesses_geo_point
        ON businesses USING GIST (ST_Point(lng, lat)::geography);
    END IF;
  END IF;
END $$;

-- ===========================================================================
-- business_duplicates — dedup cluster tracking (Phase 3.3)
-- ===========================================================================
-- One row per (canonical, duplicate) pair. The canonical business is the one
-- that survives (kept in `businesses`); the duplicate is soft-merged (its
-- place_id is recorded so future scrapes skip it). similarity_score is the
-- fuzzy-match confidence (0.0–1.0); match_method records which signal(s)
-- triggered the match (name+address, phone, website, ...).
--
-- This table is append-only on first discovery; re-runs update the
-- similarity_score / matched_at if a stronger match is found.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_duplicates (
  id                  SERIAL PRIMARY KEY,
  canonical_place_id  TEXT NOT NULL,   -- the surviving business
  duplicate_place_id  TEXT NOT NULL,   -- the merged-away business
  similarity_score    NUMERIC(4, 3) NOT NULL,  -- 0.000–1.000
  match_method        TEXT NOT NULL,   -- 'name+address' | 'phone' | 'website' | 'compound'
  matched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Enforce one row per (canonical, duplicate) pair so re-runs upsert rather
  -- than duplicate rows.
  CONSTRAINT uq_business_duplicates_pair
    UNIQUE (canonical_place_id, duplicate_place_id)
);

-- "Is this place_id a known duplicate?" — O(1) lookup during scraping.
CREATE INDEX IF NOT EXISTS idx_dup_duplicate_place_id
  ON business_duplicates (duplicate_place_id);
-- "Show me the cluster for this canonical business."
CREATE INDEX IF NOT EXISTS idx_dup_canonical_place_id
  ON business_duplicates (canonical_place_id);
-- "Show me high-confidence matches first."
CREATE INDEX IF NOT EXISTS idx_dup_similarity
  ON business_duplicates (similarity_score DESC);
