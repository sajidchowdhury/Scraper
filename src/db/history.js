'use strict';

/**
 * src/db/history.js — Phase 2.2 — Change Tracking & History CLI
 *
 * Prints the snapshot + change timeline for a single business (keyed by
 * place_id) from the `business_snapshots` + `field_changes` tables written
 * by src/db.js during re-scrapes.
 *
 * Usage:
 *   npm run db:history -- --placeId ChIJxxx
 *   node src/db/history.js --placeId ChIJxxx
 *   node src/db/history.js --placeId ChIJxxx --limit 20
 *   node src/db/history.js --placeId ChIJxxx "postgresql://user:pass@host:5432/db"
 *
 * Output (most recent first):
 *   Business:  Test Cafe (ChIJxxx)
 *   Current:   rating 4.3 | reviews 1289 | status open | phone +1-555-0100 | website https://example.com
 *
 *   Timeline (5 events):
 *   2026-08-07 14:03  rating 4.5 → 4.3  (Δ -0.2)
 *   2026-08-07 14:03  reviews 1234 → 1289 (Δ +55)
 *   2026-07-01 09:12  rating 4.6 → 4.5  (Δ -0.1)
 *   2026-06-15 18:44  status open → temporarily_closed
 *   2026-06-15 18:44  phone +1-555-0100 → +1-555-0200
 *
 * Exit codes:
 *   0 — timeline printed (even if empty)
 *   2 — configuration error (DATABASE_URL missing / no --placeId)
 *   3 — runtime error (cannot connect / query failed)
 */

const { createPool, closePool } = require('../db');

// ---------------------------------------------------------------------------
// Argument parsing — minimal, no deps. Recognizes --placeId <id> and an
// optional positional connection string. --limit N caps the timeline length.
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { placeId: null, limit: 100, connectionString: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--placeId' || a === '--place-id' || a === '-p') {
      args.placeId = rest[++i];
    } else if (a === '--limit' || a === '-l') {
      const n = parseInt(rest[++i], 10);
      if (Number.isFinite(n) && n > 0) args.limit = n;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (!a.startsWith('--') && !args.connectionString) {
      // First positional non-flag arg → connection string.
      args.connectionString = a;
    }
  }
  return args;
}

const HELP = `db:history — print the change timeline for a single business.

Usage:
  npm run db:history -- --placeId <place_id> [--limit N] [connectionString]

Options:
  --placeId <id>   Google place_id of the business (required).
  --limit N        Max events to print (default 100, most recent first).
  --help, -h       Show this help.

The connection string defaults to process.env.DATABASE_URL. Pass one explicitly
as the last positional arg to query a non-default database.`;

// ---------------------------------------------------------------------------
// Pure formatting helpers — exported for unit testing.
// ---------------------------------------------------------------------------

/**
 * Format a single value for display. null/undefined → '(none)'; numbers and
 * strings as-is. Used for both old and new values in change lines.
 */
function formatValue(v) {
  if (v === null || v === undefined) return '(none)';
  return String(v);
}

/**
 * Format the delta for a change line. Numeric deltas get a leading '+' for
 * positive values (so "Δ +55" not "Δ 55"); null deltas are omitted entirely
 * (text fields have no meaningful delta).
 */
function formatDelta(delta) {
  if (delta === null || delta === undefined) return '';
  const n = Number(delta);
  if (!Number.isFinite(n)) return '';
  const sign = n > 0 ? '+' : '';
  return ` (Δ ${sign}${n})`;
}

/**
 * Human-readable label for a field name (used in change lines + the current
 * summary). Maps the DB column names to the labels used in the plan's example
 * output ("reviews" for reviews_count, "status" for business_status).
 */
function fieldLabel(field) {
  switch (field) {
    case 'rating':
      return 'rating';
    case 'reviews_count':
      return 'reviews';
    case 'business_status':
      return 'status';
    case 'phone':
      return 'phone';
    case 'website':
      return 'website';
    default:
      return field;
  }
}

/**
 * Format a single field_changes row as a timeline line:
 *   "2026-08-07 14:03  rating 4.5 → 4.3  (Δ -0.2)"
 *
 * @param {{detected_at: string|Date, field: string, old_value: string|null, new_value: string|null, delta: string|null}} row
 * @returns {string}
 */
function formatChangeLine(row) {
  const ts = formatTimestamp(row.detected_at);
  const field = fieldLabel(row.field);
  const oldV = formatValue(row.old_value);
  const newV = formatValue(row.new_value);
  const delta = formatDelta(row.delta);
  return `${ts}  ${field} ${oldV} → ${newV}${delta}`;
}

/**
 * Format a timestamp (ISO string or Date) as "YYYY-MM-DD HH:MM" (local-ish,
 * no timezone shifting — we display the stored UTC value as-is for
 * determinism in tests).
 */
function formatTimestamp(v) {
  if (!v) return '----';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '----';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}

/**
 * Build the "Current:" summary line from the businesses row.
 *   "rating 4.3 | reviews 1289 | status open | phone +1-555-0100 | website https://example.com"
 */
function formatCurrentLine(row) {
  if (!row) return 'Current:   (business not found)';
  const parts = [
    `rating ${formatValue(row.rating)}`,
    `reviews ${formatValue(row.reviews_count)}`,
    `status ${formatValue(row.business_status)}`,
    `phone ${formatValue(row.phone)}`,
    `website ${formatValue(row.website)}`,
  ];
  return 'Current:   ' + parts.join(' | ');
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

/**
 * Fetch the current businesses row for a place_id (the tracked fields only).
 * Returns null if no such business.
 */
async function fetchCurrent(client, placeId) {
  const res = await client.query(
    'SELECT name, rating, reviews_count, business_status, phone, website ' +
      'FROM businesses WHERE place_id = $1',
    [placeId],
  );
  return res.rows && res.rows[0] ? res.rows[0] : null;
}

/**
 * Fetch the change timeline for a place_id, most recent first. Joins
 * field_changes (the computed delta log) — this is the source of truth for
 * the timeline because it already contains old/new/delta per field.
 */
async function fetchChanges(client, placeId, limit) {
  const res = await client.query(
    'SELECT field, old_value, new_value, delta, detected_at ' +
      'FROM field_changes WHERE place_id = $1 ' +
      'ORDER BY detected_at DESC, id DESC LIMIT $2',
    [placeId, limit],
  );
  return res.rows || [];
}

/**
 * Fetch snapshot count for a place_id (used in the header summary).
 */
async function fetchSnapshotCount(client, placeId) {
  const res = await client.query(
    'SELECT COUNT(*)::int AS n FROM business_snapshots WHERE place_id = $1',
    [placeId],
  );
  return res.rows && res.rows[0] ? res.rows[0].n : 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  const args = parseArgs(argv || process.argv);

  if (args.help) {
    // eslint-disable-next-line no-console
    console.log(HELP);
    process.exit(0);
  }

  if (!args.placeId) {
    // eslint-disable-next-line no-console
    console.error('db:history — --placeId is required.\n\n' + HELP);
    process.exit(2);
  }

  const connectionString = args.connectionString || process.env.DATABASE_URL;
  if (!connectionString) {
    // eslint-disable-next-line no-console
    console.error(
      'db:history — DATABASE_URL is not set.\n' +
        'Set it in .env (see .env.example) or pass a connection string:\n' +
        '  node src/db/history.js --placeId ChIJxxx "postgresql://..."',
    );
    process.exit(2);
  }

  const pool = createPool(connectionString);
  if (!pool) {
    // eslint-disable-next-line no-console
    console.error('db:history — invalid DATABASE_URL (must start with postgresql://).');
    process.exit(2);
  }

  try {
    const client = await pool.connect();
    try {
      const current = await fetchCurrent(client, args.placeId);
      const changes = await fetchChanges(client, args.placeId, args.limit);
      const snapshotCount = await fetchSnapshotCount(client, args.placeId);

      // Header — always print, even for an unknown place_id (helps debugging).
      const name = current && current.name ? current.name : '(unknown)';
      // eslint-disable-next-line no-console
      console.log(`Business:  ${name} (${args.placeId})`);
      // eslint-disable-next-line no-console
      console.log(formatCurrentLine(current));
      // eslint-disable-next-line no-console
      console.log('');
      // eslint-disable-next-line no-console
      console.log(
        `Timeline (${changes.length} change events, ${snapshotCount} snapshots):`,
      );
      if (changes.length === 0) {
        // eslint-disable-next-line no-console
        console.log('  (no changes recorded — business has never been re-scraped with differing data)');
      } else {
        for (const row of changes) {
          // eslint-disable-next-line no-console
          console.log('  ' + formatChangeLine(row));
        }
      }
    } finally {
      client.release();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('db:history — query failed:', err.message);
    await closePool(pool);
    process.exit(3);
  }

  await closePool(pool);
  process.exit(0);
}

module.exports = {
  // CLI entry
  main,
  parseArgs,
  HELP,
  // pure formatting helpers (exported for tests)
  formatValue,
  formatDelta,
  fieldLabel,
  formatTimestamp,
  formatChangeLine,
  formatCurrentLine,
  // DB queries (exported for integration tests)
  fetchCurrent,
  fetchChanges,
  fetchSnapshotCount,
};

// Run main() when invoked directly (`node src/db/history.js ...`), but NOT
// when required (so tests can import the helpers without side effects).
if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('db:history — uncaught error:', err);
    process.exit(3);
  });
}
