'use strict';

/**
 * src/db.js — Phase 2.1 — PostgreSQL Persistence Layer
 *
 * Provides a thin, DI-friendly layer over `pg` that upserts scraped businesses
 * into PostgreSQL, keyed by `place_id`. Re-scraping the same business updates
 * the row instead of duplicating it; re-scraping with identical data is a
 * no-op (detected via a SHA-256 `data_hash` column).
 *
 * Design rules (per PHASE2_EXECUTION_PLAN.md §2.1):
 *   - Idempotent upserts keyed by `place_id`.
 *   - Per-row action reporting: 'inserted' | 'updated' | 'unchanged'.
 *   - No-op detection via a hash of comparable field values (avoids touching
 *     `updated_at` on every re-scrape — only real changes bump it).
 *   - Batched writes (default 50 rows per round-trip) to avoid per-row latency.
 *   - Parameterized queries everywhere — no SQL injection surface.
 *   - DI-friendly: every public method accepts an explicit `client` (or
 *     `pool`) argument, so tests can pass a mock client without touching
 *     Postgres. Integration tests (guarded on DATABASE_URL) exercise the
 *     real path.
 *
 * Public API:
 *   createPool(connectionString)        → pg.Pool (or null if no URL)
 *   getClient(pool)                     → acquires a client from the pool
 *   closePool(pool)                     → graceful shutdown
 *   runMigration(poolOrClient)          → reads schema.sql, executes idempotently
 *   computeRowHash(business)            → SHA-256 hex of comparable fields (pure)
 *   decideAction(existingHash, business)→ 'inserted'|'updated'|'unchanged' (pure)
 *   insertRunSummary(client, summary)   → writes scrape_runs row, returns runId
 *   upsertBusiness(client, business, {runId})            → single-business upsert
 *   upsertBusinessesBatch(client, businesses, {runId, batchSize})  → batched
 *   persistRunResults(pool, {businesses, summary, logger})  → full pipeline hook
 *
 * The mock-client contract (for tests): an object with a single async method
 *   `query(text, params) → { rows: [...] }`
 * matching `pg`'s Client/PoolClient interface.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Phase 2.2 — pure change-tracking helpers (computeChanges, numericDelta, etc.).
// Kept in a separate module so they're unit-testable without a database.
const deltas = require('./db/deltas');
const {
  TRACKED_FIELDS,
  computeChanges,
  summarizeChanges,
} = deltas;

// Phase 2.12 — incremental scraping helpers. `computeChangeHash` is a SHA-256
// of the LIST-VIEW fields only (distinct from `computeRowHash` below, which
// hashes the full row including detail JSONB). Kept in a separate module so
// the incremental subsystem is unit-testable in isolation. db.js →
// incremental.js is a one-way require (incremental.js does NOT require db.js),
// so there's no circular dependency.
const {
  computeChangeHash,
} = require('./incremental');

// `pg` is an optional runtime dependency: the scraper still works without it
// (Phase 1 file-only behavior) as long as `--output db` is never requested.
// We lazy-require it inside createPool() so `require('./db')` never throws
// even when pg is absent (e.g. a minimal CI image). This matches the
// "Phase 2 features are opt-in" philosophy in .env.example.
let pgModule = null;
function loadPg() {
  if (pgModule) return pgModule;
  try {
    pgModule = require('pg');
    return pgModule;
  } catch (err) {
    throw new Error(
      "The 'pg' package is required for database output but is not installed. " +
        'Run `npm install` (Phase 2.0 installs pg), or omit --output db.',
    );
  }
}

// ---------------------------------------------------------------------------
// Field schema — the columns that map 1:1 to business object keys.
// Kept in sync with src/extract.js CANONICAL_FIELDS + src/detail.js DETAIL_FIELDS.
// Order is significant: it drives the parameterized INSERT/UPDATE builders.
// ---------------------------------------------------------------------------

// Scalar columns (TEXT / NUMERIC / BOOLEAN / TIMESTAMPTZ) — bound directly.
const SCALAR_COLUMNS = [
  'place_id',
  'name',
  'rating',
  'reviews_count',
  'price_level',
  'category',
  'address',
  'phone',
  'website',
  'maps_url',
  'plus_code',
  'open_now',
  'business_status',
  'is_sponsored',
  'scraped_at',
  'query',
  'location',
  // detail scalars
  'reservation_url',
  'menu_url',
  'detail_scraped',
  // geo (forward-compatible — NULL until a future phase populates them)
  'latitude',
  'longitude',
];

// JSONB columns — stringified before binding (pg handles JSONB via JSON.stringify
// when the column type is jsonb, but we normalize explicitly for safety).
const JSONB_COLUMNS = [
  'full_hours',
  'popular_times',
  'top_reviews',
  'photos',
  'social_profiles',
];

// Columns that are excluded from `data_hash` because they are managed by the
// DB or are provenance metadata (not "business data" whose change we track).
// `scraped_at` is excluded because it is the moment we saw the data, not the
// data itself; `run_id` / `updated_at` / `data_hash` are bookkeeping.
const HASH_EXCLUDED = new Set(['scraped_at', 'run_id', 'updated_at', 'data_hash']);

// All comparable business-data columns (used for hashing) — scalar + jsonb,
// minus the excluded bookkeeping columns.
const HASH_COLUMNS = [...SCALAR_COLUMNS, ...JSONB_COLUMNS].filter(
  (c) => !HASH_EXCLUDED.has(c),
);

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without a database)
// ---------------------------------------------------------------------------

/**
 * Coerce a value to a normalized form for stable hashing. Arrays/objects are
 * JSON-stringified with sorted keys; null/undefined become null; everything
 * else is returned as-is. This makes `computeRowHash` insensitive to key
 * ordering in nested objects (e.g. a review whose keys arrive in a different
 * order across two scrapes still hashes identically).
 */
function normalizeForHash(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value === '') return null; // empty string normalizes to null (matches toText coercion)
  if (typeof value === 'object') {
    return JSON.stringify(sortKeysDeep(value));
  }
  return value;
}

/**
 * Recursively sort object keys for deterministic JSON serialization.
 * Arrays are preserved (order matters), but object keys within each element
 * are sorted.
 */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = sortKeysDeep(value[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * Compute a SHA-256 hex hash of a business's comparable field values.
 * Two businesses with the same name/rating/reviews/etc. produce the same hash,
 * so a re-scrape that finds nothing changed is detected as 'unchanged' without
 * a full column-by-column diff.
 *
 * Pure function — safe to unit-test without a database.
 *
 * @param {object} business — a scraped business record.
 * @returns {string} 64-char lowercase hex digest.
 */
function computeRowHash(business) {
  const parts = [];
  for (const col of HASH_COLUMNS) {
    parts.push(col + '=' + normalizeForHash(business ? business[col] : undefined));
  }
  return crypto.createHash('sha256').update(parts.join('\u0001'), 'utf8').digest('hex');
}

/**
 * Decide what upsert action a business would produce, given the existing
 * row's data_hash (or null if no existing row). Pure function — the
 * unit-testable core of the action-classification logic.
 *
 * @param {string|null|undefined} existingHash — the stored data_hash, or null.
 * @param {object} business — the incoming business record.
 * @returns {'inserted'|'updated'|'unchanged'}
 */
function decideAction(existingHash, business) {
  const incomingHash = computeRowHash(business);
  if (existingHash === undefined || existingHash === null) return 'inserted';
  if (existingHash === incomingHash) return 'unchanged';
  return 'updated';
}

// ---------------------------------------------------------------------------
// Value coercion — maps a JS business value to a pg-bindable value per column.
// ---------------------------------------------------------------------------

function toBool(v) {
  if (v === undefined || v === null) return null;
  return !!v;
}

function toInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v);
  return s.length ? s : null;
}

function toTimestamp(v) {
  if (!v) return null;
  // Accept ISO strings, Date objects, or epoch-ms numbers.
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Build the bind-value for a given column from a business record.
 * Centralizes all coercion so INSERT and UPDATE builders stay in sync.
 */
function columnValue(col, business) {
  const v = business ? business[col] : undefined;
  switch (col) {
    case 'rating':
    case 'latitude':
    case 'longitude':
      return toNum(v);
    case 'reviews_count':
      return toInt(v);
    case 'open_now':
    case 'is_sponsored':
    case 'detail_scraped':
      return toBool(v);
    case 'scraped_at':
      return toTimestamp(v);
    case 'full_hours':
    case 'popular_times':
    case 'top_reviews':
    case 'photos':
    case 'social_profiles':
      // JSONB: null stays null; objects/arrays are stringified.
      if (v === undefined || v === null) return null;
      return JSON.stringify(v);
    default:
      return toText(v);
  }
}

// Full ordered column list for INSERT (excludes the SERIAL `id`, the
// DEFAULT `updated_at`, and `run_id`/`data_hash` which are added explicitly).
const INSERT_COLUMNS = [
  ...SCALAR_COLUMNS,
  ...JSONB_COLUMNS,
  'data_hash',
  'run_id',
];

// ---------------------------------------------------------------------------
// Pool / client lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a `pg.Pool` from a connection string (or process.env.DATABASE_URL).
 * Returns null if no connection string is available — callers should treat
 * this as "DB output not configured" rather than an error (the config layer
 * enforces that --output db requires DATABASE_URL). Also returns null if the
 * URL is not a PostgreSQL connection string (e.g. a SQLite `file:` URL), so
 * the scraper fails cleanly instead of producing a confusing connection error.
 *
 * @param {string} [connectionString] — defaults to process.env.DATABASE_URL.
 * @returns {import('pg').Pool|null}
 */
function createPool(connectionString) {
  const cs = connectionString || process.env.DATABASE_URL;
  if (!cs) return null;
  if (!/^postgres(ql)?:\/\//.test(cs)) return null;
  const { Pool } = loadPg();
  return new Pool({
    connectionString: cs,
    // Fail fast on a bad connection rather than hanging the pipeline.
    connectionTimeoutMillis: 10_000,
    // Conservative pool size for a single-machine scraper; Phase 2.8 (worker
    // pool) will raise this per-worker.
    max: 10,
  });
}

/**
 * Acquire a client from the pool. The caller is responsible for releasing it
 * (use `client.release()` in a finally block, or use `withClient`).
 */
async function getClient(pool) {
  if (!pool) throw new Error('getClient: pool is null (DATABASE_URL not set?)');
  return pool.connect();
}

/**
 * Run an async function with a pooled client, always releasing it.
 */
async function withClient(pool, fn) {
  const client = await getClient(pool);
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Gracefully close a pool. Safe to call with null (no-op).
 */
async function closePool(pool) {
  if (!pool) return;
  await pool.end();
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Run the schema migration (src/db/schema.sql) idempotently. Accepts either a
 * Pool or a single Client. Reads the SQL file, executes it as one batch.
 *
 * @param {import('pg').Pool|import('pg').Client|object} poolOrClient
 * @returns {Promise<void>}
 */
async function runMigration(poolOrClient) {
  if (!poolOrClient) throw new Error('runMigration: poolOrClient is null');
  const sqlPath = path.join(__dirname, 'db', 'schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Both pg.Pool (via .query) and pg.Client (via .query) expose query().
  // For a Pool we use .query directly (auto-acquires/releases a client).
  await poolOrClient.query(sql);
}

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

/**
 * Insert a row into `scrape_runs` and return its generated id.
 *
 * @param {object} client — pg Client or mock with .query(text, params).
 * @param {object} summary — { query, location, startedAt, finishedAt, extracted, failed, exitCode, logPath, dbInserted, dbUpdated, dbUnchanged }
 * @returns {Promise<number>} the new run id.
 */
async function insertRunSummary(client, summary) {
  if (!client) throw new Error('insertRunSummary: client is null');
  const s = summary || {};
  const res = await client.query(
    `INSERT INTO scrape_runs
       (query, location, started_at, finished_at, extracted, failed, exit_code, log_path, db_inserted, db_updated, db_unchanged)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      toText(s.query),
      toText(s.location),
      toTimestamp(s.startedAt) || new Date().toISOString(),
      toTimestamp(s.finishedAt) || new Date().toISOString(),
      toInt(s.extracted) ?? 0,
      toInt(s.failed) ?? 0,
      toInt(s.exitCode),
      toText(s.logPath),
      toInt(s.dbInserted),
      toInt(s.dbUpdated),
      toInt(s.dbUnchanged),
    ],
  );
  return res.rows[0] ? res.rows[0].id : null;
}

// ---------------------------------------------------------------------------
// Upsert — batched, with per-row action reporting
// ---------------------------------------------------------------------------

/**
 * Build a parameterized multi-row INSERT for a batch of new businesses.
 * Uses ON CONFLICT (place_id) DO NOTHING as a safety net against concurrent
 * inserts (the pre-flight hash SELECT is the primary insert detector).
 *
 * Phase 2.12 — also populates the freshness columns:
 *   - change_hash        : the list-view hash (passed in, pre-computed).
 *   - last_list_scraped  : NOW() (we just verified the list fields).
 *   - last_detail_scraped: NOW() when business.detail_scraped is true, else
 *                          NULL (never detail-scraped — the TTL check treats
 *                          NULL as "no cache", forcing a future deep-scrape).
 *
 * @param {object[]} rows — array of { business, hash, changeHash }.
 * @param {number|null} runId
 * @returns {{ text: string, params: any[] }}
 */
function buildBatchInsert(rows, runId) {
  const cols = [...INSERT_COLUMNS, 'change_hash', 'last_list_scraped', 'last_detail_scraped'];
  const placeholders = [];
  const params = [];
  let idx = 1;
  const nowIso = new Date().toISOString();
  for (const { business, hash, changeHash } of rows) {
    const rowPh = [];
    for (const col of INSERT_COLUMNS) {
      if (col === 'data_hash') {
        rowPh.push('$' + idx);
        params.push(hash);
      } else if (col === 'run_id') {
        rowPh.push('$' + idx);
        params.push(runId);
      } else {
        rowPh.push('$' + idx);
        params.push(columnValue(col, business));
      }
      idx++;
    }
    // change_hash (list-view-only hash, Phase 2.12). Default to null when the
    // caller didn't pre-compute it (backward-compatible with pre-2.12 callers).
    rowPh.push('$' + idx);
    params.push(changeHash !== undefined ? changeHash : null);
    idx++;
    // last_list_scraped — always NOW() (list fields just verified)
    rowPh.push('$' + idx);
    params.push(nowIso);
    idx++;
    // last_detail_scraped — NOW() when detail_scraped, else NULL
    rowPh.push('$' + idx);
    params.push(business && business.detail_scraped === true ? nowIso : null);
    idx++;
    placeholders.push('(' + rowPh.join(', ') + ')');
  }
  const text =
    'INSERT INTO businesses (' +
    cols.join(', ') +
    ') VALUES ' +
    placeholders.join(', ') +
    ' ON CONFLICT (place_id) DO NOTHING';
  return { text, params };
}

/**
 * Build a parameterized UPDATE for a single business (whose data_hash differs
 * from the stored value). Returns { text, params }.
 *
 * Phase 2.12 — also refreshes the freshness columns:
 *   - change_hash        : updated to the new list-view hash.
 *   - last_list_scraped  : NOW() (list fields just re-verified).
 *   - last_detail_scraped: CASE WHEN detail_scraped THEN NOW() ELSE
 *                          last_detail_scraped END — refreshed only when a
 *                          detail scrape happened this run; otherwise the
 *                          existing cached timestamp is preserved (so a re-
 *                          scrape that skipped the detail-panel keeps its
 *                          TTL freshness intact).
 */
function buildUpdate(business, hash, runId, changeHash) {
  const setCols = [...SCALAR_COLUMNS, ...JSONB_COLUMNS, 'data_hash', 'run_id'];
  const setClauses = [];
  const params = [];
  let idx = 1;
  for (const col of setCols) {
    if (col === 'data_hash') {
      setClauses.push('data_hash = $' + idx);
      params.push(hash);
    } else if (col === 'run_id') {
      setClauses.push('run_id = $' + idx);
      params.push(runId);
    } else {
      setClauses.push(col + ' = $' + idx);
      params.push(columnValue(col, business));
    }
    idx++;
  }
  // change_hash (Phase 2.12). Default to null when not provided (backward-
  // compatible with pre-2.12 callers that don't pre-compute the list hash).
  setClauses.push('change_hash = $' + idx);
  params.push(changeHash !== undefined ? changeHash : null);
  idx++;
  // last_list_scraped — always NOW()
  setClauses.push('last_list_scraped = $' + idx);
  params.push(new Date().toISOString());
  idx++;
  // last_detail_scraped — CASE: refresh when detail_scraped, else preserve.
  const detailFlagIdx = idx;
  params.push(business && business.detail_scraped === true);
  idx++;
  const nowIdx = idx;
  params.push(new Date().toISOString());
  idx++;
  setClauses.push(
    'last_detail_scraped = CASE WHEN $' + detailFlagIdx + ' THEN $' + nowIdx +
      ' ELSE last_detail_scraped END',
  );
  // place_id is the WHERE key (last param).
  setClauses.push('updated_at = NOW()');
  params.push(business.place_id);
  const text =
    'UPDATE businesses SET ' +
    setClauses.join(', ') +
    ' WHERE place_id = $' + idx;
  return { text, params };
}

/**
 * Phase 2.12 — Build a batched UPDATE that refreshes `last_list_scraped` and
 * `change_hash` for unchanged businesses (data_hash matched). Advances the
 * freshness timestamp so frequently-re-scraped businesses stay "fresh" without
 * a full re-scrape. Does NOT touch `updated_at` (preserves the Phase 2.1
 * "unchanged = no updated_at bump" contract) and does NOT write snapshots /
 * field_changes (nothing changed).
 *
 * Uses a VALUES-table join so the whole batch is one round-trip:
 *   UPDATE businesses SET last_list_scraped = NOW(), change_hash = c.change_hash
 *   FROM (VALUES ($1, $2), ($3, $4), ...) AS c(place_id, change_hash)
 *   WHERE businesses.place_id = c.place_id
 *
 * @param {Array<{placeId: string, changeHash: string}>} rows
 * @returns {{text: string, params: any[]}|null} null when rows is empty.
 */
function buildUnchangedRefresh(rows) {
  if (!rows || rows.length === 0) return null;
  const params = [];
  const values = [];
  let idx = 1;
  for (const { placeId, changeHash } of rows) {
    values.push('($' + idx + ', $' + (idx + 1) + ')');
    params.push(placeId);
    params.push(changeHash);
    idx += 2;
  }
  const text =
    'UPDATE businesses SET last_list_scraped = NOW(), change_hash = c.change_hash ' +
      'FROM (VALUES ' + values.join(', ') + ') AS c(place_id, change_hash) ' +
      'WHERE businesses.place_id = c.place_id';
  return { text, params };
}

// ---------------------------------------------------------------------------
// Phase 2.2 — Change-tracking SQL builders
// ---------------------------------------------------------------------------
// These run BEFORE the businesses UPDATE (inside the same transaction) to
// snapshot the old row and log per-field deltas. Both are pure functions
// returning { text, params } — exported for unit testing.
//
// Tracked fields (kept in sync with src/db/schema.sql + src/db/deltas.js):
//   rating, reviews_count, business_status, phone, website
// ---------------------------------------------------------------------------

// Columns snapshotted into business_snapshots (the high-value tracked fields).
// `business_id` and `place_id` come from the existing row; `snapshot_at` and
// `run_id` are supplied by the caller. Order here MUST match the VALUES order
// in buildSnapshotInsert.
const SNAPSHOT_COLUMNS = [
  'business_id',
  'place_id',
  'rating',
  'reviews_count',
  'business_status',
  'phone',
  'website',
  'run_id',
];

/**
 * Build a parameterized multi-row INSERT into business_snapshots. Each row is
 * the OLD values of one business about to be updated. `snapshotAt` defaults
 * to NOW() in the schema, so we omit it here (let Postgres stamp it).
 *
 * @param {Array<{oldRow: object, runId: number|null}>} rows
 * @returns {{text: string, params: any[]}}
 */
function buildSnapshotInsert(rows) {
  const params = [];
  const placeholders = [];
  let idx = 1;
  for (const { oldRow, runId } of rows) {
    const rowPh = [];
    for (const col of SNAPSHOT_COLUMNS) {
      rowPh.push('$' + idx);
      if (col === 'business_id') {
        params.push(oldRow ? toInt(oldRow.id) : null);
      } else if (col === 'run_id') {
        params.push(runId !== undefined ? runId : null);
      } else if (col === 'rating') {
        params.push(oldRow ? toNum(oldRow.rating) : null);
      } else if (col === 'reviews_count') {
        params.push(oldRow ? toInt(oldRow.reviews_count) : null);
      } else {
        // business_status / phone / website → text
        params.push(oldRow ? toText(oldRow[col]) : null);
      }
      idx++;
    }
    placeholders.push('(' + rowPh.join(', ') + ')');
  }
  const text =
    'INSERT INTO business_snapshots (' +
    SNAPSHOT_COLUMNS.join(', ') +
    ') VALUES ' +
    placeholders.join(', ');
  return { text, params };
}

// Columns written into field_changes. `detected_at` defaults to NOW() in the
// schema, so we omit it here.
const FIELD_CHANGE_COLUMNS = [
  'business_id',
  'place_id',
  'field',
  'old_value',
  'new_value',
  'delta',
  'run_id',
];

/**
 * Build a parameterized multi-row INSERT into field_changes. Each row is one
 * field that changed on one business. `old_value` / `new_value` are stringified
 * (the column is TEXT); `delta` is the numeric delta for numeric fields, null
 * for text fields.
 *
 * @param {Array<{change: {field, old, new, delta}, placeId: string, businessId: number|null, runId: number|null}>} rows
 * @returns {{text: string, params: any[]}}
 */
function buildFieldChangesInsert(rows) {
  const params = [];
  const placeholders = [];
  let idx = 1;
  for (const { change, placeId, businessId, runId } of rows) {
    const rowPh = [];
    for (const col of FIELD_CHANGE_COLUMNS) {
      rowPh.push('$' + idx);
      if (col === 'business_id') {
        params.push(businessId !== undefined && businessId !== null ? toInt(businessId) : null);
      } else if (col === 'place_id') {
        params.push(toText(placeId));
      } else if (col === 'field') {
        params.push(toText(change.field));
      } else if (col === 'old_value') {
        params.push(change.old === null || change.old === undefined ? null : String(change.old));
      } else if (col === 'new_value') {
        params.push(change.new === null || change.new === undefined ? null : String(change.new));
      } else if (col === 'delta') {
        params.push(change.delta === null || change.delta === undefined ? null : String(change.delta));
      } else if (col === 'run_id') {
        params.push(runId !== undefined ? runId : null);
      }
      idx++;
    }
    placeholders.push('(' + rowPh.join(', ') + ')');
  }
  const text =
    'INSERT INTO field_changes (' +
    FIELD_CHANGE_COLUMNS.join(', ') +
    ') VALUES ' +
    placeholders.join(', ');
  return { text, params };
}

/**
 * Upsert a batch of businesses in a single transaction. For each batch:
 *   1. SELECT existing place_id + data_hash for the whole batch (1 round-trip).
 *   2. Classify each business as insert / update / unchanged (in JS).
 *   3. Multi-row INSERT for the new ones (1 round-trip).
 *   4. For changed businesses (Phase 2.2 change tracking):
 *      a. SELECT the existing rows' id + tracked fields (1 round-trip).
 *      b. Compute per-field deltas (pure — src/db/deltas.js).
 *      c. INSERT old values into business_snapshots (1 round-trip, multi-row).
 *      d. INSERT per-field changes into field_changes (1 round-trip, multi-row).
 *      e. Per-row UPDATE for changed businesses (N round-trips — optimization
 *         deferred; the common case is a fresh scrape with 0 updates).
 *
 * The snapshot + field_changes writes happen INSIDE the same transaction as
 * the UPDATE (the caller — persistRunResults — wraps everything in BEGIN/COMMIT,
 * and a crash mid-batch rolls back via ROLLBACK). This guarantees the
 * acceptance criterion: "a crash mid-upsert leaves the DB consistent (old
 * snapshot written, or nothing written)."
 *
 * @param {object} client — pg Client or mock with .query(text, params).
 * @param {object[]} businesses
 * @param {object} [opts] — { runId, batchSize, incremental }
 * @returns {Promise<{ inserted: number, updated: number, unchanged: number, changesByField: object, changesTotal: number, snapshotsWritten: number, details: object[] }>}
 */
async function upsertBusinessesBatch(client, businesses, opts) {
  if (!client) throw new Error('upsertBusinessesBatch: client is null');
  const o = opts || {};
  const runId = o.runId !== undefined ? o.runId : null;
  const batchSize = o.batchSize || 50;
  // Phase 2.12 — when true, unchanged businesses get a lightweight refresh of
  // last_list_scraped + change_hash (we just re-verified the list fields, so
  // the freshness timestamp should advance even though no data changed).
  // When false (default), unchanged = pure no-op (Phase 2.1 behavior).
  const incremental = !!o.incremental;

  const list = Array.isArray(businesses) ? businesses : [];
  const totals = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    changesByField: summarizeChanges([]).byField, // { rating:0, reviews_count:0, ... }
    changesTotal: 0,
    snapshotsWritten: 0,
    details: [],
  };

  for (let i = 0; i < list.length; i += batchSize) {
    const chunk = list.slice(i, i + batchSize);

    // 1. Fetch existing hashes for this chunk (empty chunk → skip the query).
    if (chunk.length === 0) continue;
    const placeIds = chunk.map((b) => b && b.place_id).filter((p) => p);
    if (placeIds.length === 0) continue;

    const selRes = await client.query(
      'SELECT place_id, data_hash FROM businesses WHERE place_id = ANY($1)',
      [placeIds],
    );
    const existing = new Map();
    for (const row of selRes.rows || []) {
      existing.set(row.place_id, row.data_hash);
    }

    // 2. Classify.
    const toInsert = [];
    const toUpdate = [];
    const unchangedRefresh = []; // Phase 2.12 — { placeId, changeHash } for freshness refresh
    for (const business of chunk) {
      if (!business || !business.place_id) continue;
      const hash = computeRowHash(business);
      const changeHash = computeChangeHash(business); // Phase 2.12 — list-view-only hash
      const action = decideAction(existing.get(business.place_id) || null, business);
      if (action === 'inserted') {
        toInsert.push({ business, hash, changeHash });
      } else if (action === 'updated') {
        toUpdate.push({ business, hash, changeHash });
      } else {
        totals.unchanged++;
        totals.details.push({ place_id: business.place_id, action: 'unchanged', changes: [] });
        // Phase 2.12 — collect for the freshness refresh (issued below).
        if (incremental) {
          unchangedRefresh.push({ placeId: business.place_id, changeHash });
        }
      }
    }

    // 3. Multi-row INSERT for new businesses.
    if (toInsert.length > 0) {
      const ins = buildBatchInsert(toInsert, runId);
      await client.query(ins.text, ins.params);
      totals.inserted += toInsert.length;
      for (const { business } of toInsert) {
        totals.details.push({ place_id: business.place_id, action: 'inserted', changes: [] });
      }
    }

    // 4. Change tracking + UPDATE for changed businesses.
    if (toUpdate.length > 0) {
      // 4a. Fetch the existing rows' id + tracked fields (1 round-trip).
      const updatePlaceIds = toUpdate.map((u) => u.business.place_id);
      const trackedSel = await client.query(
        'SELECT id, place_id, rating, reviews_count, business_status, phone, website ' +
          'FROM businesses WHERE place_id = ANY($1)',
        [updatePlaceIds],
      );
      const oldRows = new Map();
      for (const row of trackedSel.rows || []) {
        oldRows.set(row.place_id, row);
      }

      // 4b. Compute per-field deltas + collect snapshot/field-change rows.
      const snapshotRows = [];
      const fieldChangeRows = [];
      const perBusinessChanges = new Map(); // place_id → changes[]
      for (const { business } of toUpdate) {
        const oldRow = oldRows.get(business.place_id) || null;
        const changes = computeChanges(oldRow, business);
        perBusinessChanges.set(business.place_id, changes);
        // Always snapshot the old row when updating — even if no tracked
        // field changed, the data_hash differed (some non-tracked field
        // changed), so the snapshot records the pre-update state. This
        // keeps "what did this business look like before run N?" answerable.
        snapshotRows.push({ oldRow, runId });
        for (const change of changes) {
          fieldChangeRows.push({
            change,
            placeId: business.place_id,
            businessId: oldRow ? oldRow.id : null,
            runId,
          });
        }
      }

      // 4c. INSERT old values into business_snapshots (1 round-trip, multi-row).
      if (snapshotRows.length > 0) {
        const snapIns = buildSnapshotInsert(snapshotRows);
        await client.query(snapIns.text, snapIns.params);
        totals.snapshotsWritten += snapshotRows.length;
      }

      // 4d. INSERT per-field changes into field_changes (1 round-trip, multi-row).
      if (fieldChangeRows.length > 0) {
        const fcIns = buildFieldChangesInsert(fieldChangeRows);
        await client.query(fcIns.text, fcIns.params);
      }

      // 4e. Per-row UPDATE for changed businesses + roll up change counts.
      for (const { business, hash, changeHash } of toUpdate) {
        const upd = buildUpdate(business, hash, runId, changeHash);
        await client.query(upd.text, upd.params);
        totals.updated++;
        const changes = perBusinessChanges.get(business.place_id) || [];
        // Roll up per-field counts for the run banner.
        const summary = summarizeChanges(changes);
        for (const f of Object.keys(summary.byField)) {
          totals.changesByField[f] = (totals.changesByField[f] || 0) + summary.byField[f];
        }
        totals.changesTotal += summary.total;
        totals.details.push({
          place_id: business.place_id,
          action: 'updated',
          changes: changes.map((c) => c.field),
        });
      }
    }

    // 5. Phase 2.12 — freshness refresh for unchanged businesses (incremental
    //    mode only). One batched UPDATE advances last_list_scraped to NOW()
    //    and re-stamps change_hash, WITHOUT touching updated_at (preserving
    //    Phase 2.1's "don't bump updated_at on unchanged" contract) and
    //    WITHOUT writing snapshots/field_changes (nothing changed). This keeps
    //    frequently-re-scraped businesses "fresh" so they don't fall through
    //    to a full re-scrape just because the original timestamp aged out.
    if (unchangedRefresh.length > 0) {
      const refresh = buildUnchangedRefresh(unchangedRefresh);
      if (refresh) {
        try {
          await client.query(refresh.text, refresh.params);
        } catch (err) {
          // Non-fatal — the upsert already succeeded; only the freshness
          // timestamp failed to advance. The business will be re-classified
          // as stale on the next run, which is correct (conservative).
          // Swallow so a transient DB error doesn't roll back the transaction.
        }
      }
    }
  }

  return totals;
}

/**
 * Upsert a single business. Thin wrapper around the batch version for callers
 * that operate one record at a time.
 *
 * @returns {Promise<{ action: 'inserted'|'updated'|'unchanged', place_id: string }>}
 */
async function upsertBusiness(client, business, opts) {
  if (!business || !business.place_id) {
    throw new Error('upsertBusiness: business.place_id is required');
  }
  const res = await upsertBusinessesBatch(client, [business], opts);
  const detail = res.details[0] || { action: 'unchanged', place_id: business.place_id };
  return { action: detail.action, place_id: business.place_id };
}

// ---------------------------------------------------------------------------
// Pipeline integration hook — used by src/index.js after extraction.
// ---------------------------------------------------------------------------

/**
 * Persist a full run's results to PostgreSQL:
 *   1. Open a transaction.
 *   2. Insert the run summary (returns runId).
 *   3. Upsert all businesses in batches (stamped with runId).
 *   4. Update the run summary with the DB counts.
 *   5. Commit (or rollback on any error).
 *
 * @param {import('pg').Pool} pool
 * @param {object} args — { businesses, summary, logger, incremental }
 * @returns {Promise<{ runId, inserted, updated, unchanged }>}
 */
async function persistRunResults(pool, args) {
  if (!pool) throw new Error('persistRunResults: pool is null');
  const { businesses, summary, logger } = args || {};
  const incremental = !!(args && args.incremental);
  const list = Array.isArray(businesses) ? businesses : [];

  return withClient(pool, async (client) => {
    try {
      await client.query('BEGIN');

      const runId = await insertRunSummary(client, {
        query: summary && summary.query,
        location: summary && summary.location,
        startedAt: summary && summary.startedAt,
        finishedAt: new Date().toISOString(),
        extracted: list.length,
        failed: (summary && summary.extractionStats && summary.extractionStats.failed) || 0,
        exitCode: summary && summary.exitCode,
        logPath: summary && summary.logPath,
      });

      // Phase 2.12 — pass `incremental` so unchanged businesses get a
      // freshness-timestamp refresh (advancing last_list_scraped without a
      // full data update).
      const upsertRes = await upsertBusinessesBatch(client, list, {
        runId,
        batchSize: 50,
        incremental,
      });

      // Stamp the DB counts + change-detection totals back onto the run row.
      // (Phase 2.2 — `changes_detected` is the total field_changes rows written
      // this run, surfaced in the end-of-run banner.)
      await client.query(
        'UPDATE scrape_runs SET db_inserted = $1, db_updated = $2, db_unchanged = $3, changes_detected = $4 WHERE id = $5',
        [
          upsertRes.inserted,
          upsertRes.updated,
          upsertRes.unchanged,
          upsertRes.changesTotal,
          runId,
        ],
      );

      await client.query('COMMIT');

      if (logger && logger.info) {
        logger.info('DB: persistence complete', {
          phase: 'db',
          runId,
          inserted: upsertRes.inserted,
          updated: upsertRes.updated,
          unchanged: upsertRes.unchanged,
          changesDetected: upsertRes.changesTotal,
          changesByField: upsertRes.changesByField,
          snapshotsWritten: upsertRes.snapshotsWritten,
        });
      }

      return {
        runId,
        inserted: upsertRes.inserted,
        updated: upsertRes.updated,
        unchanged: upsertRes.unchanged,
        changesDetected: upsertRes.changesTotal,
        changesByField: upsertRes.changesByField,
        snapshotsWritten: upsertRes.snapshotsWritten,
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_rbErr) {
        /* best-effort rollback; original error is more important */
      }
      throw err;
    }
  });
}

module.exports = {
  // constants (exported for tests + downstream modules)
  SCALAR_COLUMNS,
  JSONB_COLUMNS,
  HASH_COLUMNS,
  INSERT_COLUMNS,
  // Phase 2.2 — change tracking constants + builders
  TRACKED_FIELDS,
  SNAPSHOT_COLUMNS,
  FIELD_CHANGE_COLUMNS,
  // pure helpers
  computeRowHash,
  decideAction,
  normalizeForHash,
  sortKeysDeep,
  // value coercion (exported for tests)
  columnValue,
  toBool,
  toInt,
  toNum,
  toText,
  toTimestamp,
  // SQL builders (exported for tests)
  buildBatchInsert,
  buildUpdate,
  buildUnchangedRefresh,
  buildSnapshotInsert,
  buildFieldChangesInsert,
  // pool / client lifecycle
  createPool,
  getClient,
  withClient,
  closePool,
  // migration
  runMigration,
  // run summary
  insertRunSummary,
  // upserts
  upsertBusiness,
  upsertBusinessesBatch,
  // pipeline hook
  persistRunResults,
  // Phase 2.2 — re-export the pure change-tracking helpers (so callers can
  // `const { computeChanges } = require('./db')` without a second import).
  computeChanges,
  summarizeChanges,
  // Phase 2.12 — re-export the list-view-only change hash (so callers can
  // `const { computeChangeHash } = require('./db')` without a second import).
  computeChangeHash,
  // internal: loadPg (for monkey-patching in tests)
  _loadPg: loadPg,
  _deltas: deltas,
};
