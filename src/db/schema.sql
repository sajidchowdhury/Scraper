-- ===========================================================================
-- gmaps-scraper — Phase 2.1 PostgreSQL schema
-- ===========================================================================
-- Idempotent: every object uses IF NOT EXISTS, so this file can be re-run
-- safely on an existing database (it will no-op). Run via `npm run db:migrate`.
--
-- Design notes:
--   - `place_id` is the canonical key (Google's stable place identifier,
--     extracted from the maps_url). `id` is an internal SERIAL PK.
--   - `data_hash` (SHA-256 hex of the comparable field values) lets us detect
--     "unchanged" re-scrapes in O(1) without diffing every column. Computed
--     in JS (src/db.js → computeRowHash) so the logic is unit-testable
--     without a live database.
--   - JSONB columns store nested detail-scrape data (hours, popular times,
--     reviews, photos, social profiles) that CSV flattens.
--   - `scrape_runs` records one row per pipeline invocation — the run_id is
--     stamped on every business upserted during that run, giving us
--     "which run produced this row" provenance.
--   - Indexes cover the common query patterns: place_id lookup, query+location
--     filtering, recency ordering, and status filtering.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- businesses — one row per scraped Google Maps business, keyed by place_id
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS businesses (
  id              SERIAL PRIMARY KEY,

  -- Canonical key (stable across re-scrapes)
  place_id        TEXT UNIQUE NOT NULL,

  -- Phase 1.4 — canonical list-view fields (17)
  name            TEXT,
  rating          NUMERIC(2, 1),
  reviews_count   INTEGER,
  price_level     TEXT,
  category        TEXT,
  address         TEXT,
  phone           TEXT,
  website         TEXT,
  maps_url        TEXT,
  plus_code       TEXT,
  open_now        BOOLEAN,
  business_status TEXT,   -- open | temporarily_closed | permanently_closed
  is_sponsored    BOOLEAN,
  scraped_at      TIMESTAMPTZ,
  query           TEXT,
  location        TEXT,

  -- Phase 1.5 — detail-scrape fields (8)
  full_hours        JSONB,   -- { "Monday": "9:00–17:00", ... }
  popular_times     JSONB,   -- { "Monday": [0,0,...,23], ... }
  top_reviews       JSONB,   -- [ { author, rating, text, time }, ... ]
  photos            JSONB,   -- [ "url1", "url2", ... ]
  reservation_url   TEXT,
  menu_url          TEXT,
  social_profiles   JSONB,   -- [ "instagram:handle", "facebook:url", ... ]
  detail_scraped    BOOLEAN,

  -- Forward-compatible geo columns (Phase 1 does not yet extract lat/long;
  -- these are NULL until a future phase populates them from the maps_url
  -- or the detail panel.)
  latitude         NUMERIC(10, 7),
  longitude        NUMERIC(10, 7),

  -- Phase 2.1 — change detection + provenance
  data_hash        TEXT,    -- SHA-256 hex of comparable field values
  run_id           INTEGER, -- FK to scrape_runs(id), added after that table
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes — IF NOT EXISTS so re-running the migration is safe.
CREATE INDEX IF NOT EXISTS idx_businesses_place_id       ON businesses (place_id);
CREATE INDEX IF NOT EXISTS idx_businesses_query_location ON businesses (query, location);
CREATE INDEX IF NOT EXISTS idx_businesses_scraped_at     ON businesses (scraped_at);
CREATE INDEX IF NOT EXISTS idx_businesses_status         ON businesses (business_status);
CREATE INDEX IF NOT EXISTS idx_businesses_updated_at     ON businesses (updated_at);

-- ---------------------------------------------------------------------------
-- scrape_runs — one row per pipeline invocation (metadata + counts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scrape_runs (
  id            SERIAL PRIMARY KEY,
  query         TEXT,
  location      TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  extracted     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  exit_code     INTEGER,
  log_path      TEXT,
  -- Phase 2.1 — DB upsert result counts (NULL for runs that didn't write to DB)
  db_inserted   INTEGER,
  db_updated    INTEGER,
  db_unchanged  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_scrape_runs_started_at ON scrape_runs (started_at);
CREATE INDEX IF NOT EXISTS idx_scrape_runs_query_loc  ON scrape_runs (query, location);

-- ---------------------------------------------------------------------------
-- Foreign key: businesses.run_id → scrape_runs(id)
-- Added via ALTER (with IF NOT EXISTS guard emulated via a DO block) so the
-- migration is re-runnable. The constraint is harmless if it already exists.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'businesses_run_id_fkey'
      AND conrelid = 'businesses'::regclass
  ) THEN
    ALTER TABLE businesses
      ADD CONSTRAINT businesses_run_id_fkey
      FOREIGN KEY (run_id) REFERENCES scrape_runs (id) ON DELETE SET NULL;
  END IF;
END $$;

-- ===========================================================================
-- Phase 2.2 — Change Tracking & History
-- ===========================================================================
-- Two new tables turn re-scrapes into trend data:
--   - business_snapshots: the OLD values of high-value fields, captured the
--     moment before an UPDATE overwrites them. One row per update event.
--   - field_changes: a computed, queryable delta log — one row per field that
--     actually changed in a given update. Supports fast "show me every rating
--     change for business X" queries without diffing snapshot rows.
--
-- Tracked fields (the ones clients pay a premium for trend data on):
--   rating, reviews_count, business_status, phone, website
-- These are the columns snapshotted AND the fields compared in field_changes.
-- The full businesses row is never overwritten without a snapshot being
-- written first, inside the same transaction (see src/db.js upsertBusinessesBatch).
--
-- `changes_detected` is added to scrape_runs so the end-of-run banner can
-- report "30 updated (12 rating changes, 8 review-count changes, ...)".
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- business_snapshots — pre-update snapshot of high-value fields
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_snapshots (
  id              SERIAL PRIMARY KEY,
  business_id     INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  place_id        TEXT NOT NULL,   -- denormalized for fast lookups without joins
  rating          NUMERIC(2, 1),
  reviews_count   INTEGER,
  business_status TEXT,
  phone           TEXT,
  website         TEXT,
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id          INTEGER REFERENCES scrape_runs(id) ON DELETE SET NULL
);

-- "Latest N snapshots for a business" — the common history-query pattern.
CREATE INDEX IF NOT EXISTS idx_snapshots_business_time
  ON business_snapshots (business_id, snapshot_at DESC);
-- Lookup by place_id (used by the `db:history` CLI helper).
CREATE INDEX IF NOT EXISTS idx_snapshots_place_id
  ON business_snapshots (place_id);
-- Lookup by run_id (used by run-summary rollups).
CREATE INDEX IF NOT EXISTS idx_snapshots_run_id
  ON business_snapshots (run_id);

-- ---------------------------------------------------------------------------
-- field_changes — computed, queryable per-field delta log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field_changes (
  id            SERIAL PRIMARY KEY,
  business_id   INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  place_id      TEXT NOT NULL,     -- denormalized for fast lookups without joins
  field         TEXT NOT NULL,     -- e.g. 'rating', 'reviews_count', 'business_status'
  old_value     TEXT,              -- stringified old value (null → 'null' omitted)
  new_value     TEXT,              -- stringified new value
  delta         TEXT,              -- numeric delta for numeric fields, NULL for text
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id        INTEGER REFERENCES scrape_runs(id) ON DELETE SET NULL
);

-- "Show me every rating change for business X, most recent first."
CREATE INDEX IF NOT EXISTS idx_changes_business_field_time
  ON field_changes (business_id, field, detected_at DESC);
-- Lookup by place_id (used by the `db:history` CLI helper).
CREATE INDEX IF NOT EXISTS idx_changes_place_id_time
  ON field_changes (place_id, detected_at DESC);
-- Lookup by run_id (used by run-summary rollups).
CREATE INDEX IF NOT EXISTS idx_changes_run_id
  ON field_changes (run_id);

-- ---------------------------------------------------------------------------
-- scrape_runs.changes_detected — total field_changes rows written this run.
-- Added via ALTER (with IF NOT EXISTS guard emulated via a DO block) so the
-- migration is re-runnable against Phase 2.1 databases.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scrape_runs' AND column_name = 'changes_detected'
  ) THEN
    ALTER TABLE scrape_runs ADD COLUMN changes_detected INTEGER;
  END IF;
END $$;
