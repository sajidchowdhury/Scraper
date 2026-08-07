'use strict';

/**
 * src/db/deltas.js — Phase 2.2 — Change Tracking & History (pure helpers)
 *
 * Pure, side-effect-free helpers for computing field-level deltas between an
 * existing businesses row and an incoming scrape. These are extracted into
 * their own module so they can be unit-tested in isolation (no database, no
 * pg, no I/O) and reused by both the upsert path (src/db.js) and the history
 * CLI formatter (src/db/history.js).
 *
 * Design rules (per PHASE2_EXECUTION_PLAN.md §2.2):
 *   - `computeChanges(oldRow, newRow, fields?)` → array of `{ field, old, new, delta }`
 *     for each tracked field that actually changed. Empty array = no changes.
 *   - `numericDelta(old, new)` → `new - old` for finite numbers, `null` for
 *     non-numeric / null / undefined. Used for the `delta` column on numeric
 *     fields (rating, reviews_count); text fields get `null` delta.
 *   - Normalization: null / undefined / empty-string all collapse to `null`
 *     before comparison (consistent with src/db.js normalizeForHash). This
 *     means a field going from `''` to `null` is NOT a change (no noise).
 *   - `valuesEqual` is exposed for tests + the history formatter.
 *
 * Tracked fields (the high-value columns clients pay for trend data on):
 *   rating, reviews_count, business_status, phone, website
 *
 * Public API:
 *   TRACKED_FIELDS               — constant array of tracked field names.
 *   normalizeValue(v)            — null/undefined/'' → null; finite number kept; else as-is.
 *   valuesEqual(a, b)            — true if a and b are equal after normalization.
 *   numericDelta(old, new)       — numeric delta or null.
 *   computeChanges(oldRow, newRow, fields?) — array of change descriptors.
 *   summarizeChanges(changes)    — { total, byField } rollup for run banners.
 */

// ---------------------------------------------------------------------------
// Tracked fields — the columns snapshotted into business_snapshots AND
// compared in field_changes. Keep in sync with src/db/schema.sql
// (business_snapshots columns) and the SELECT in upsertBusinessesBatch.
// ---------------------------------------------------------------------------
const TRACKED_FIELDS = [
  'rating',
  'reviews_count',
  'business_status',
  'phone',
  'website',
];

/**
 * Normalize a value for comparison + storage. null / undefined / empty-string
 * all collapse to `null` (so a field going from '' to null is NOT a change).
 * Finite numbers are kept as numbers; everything else is returned as-is.
 *
 * @param {*} v
 * @returns {*}
 */
function normalizeValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.length === 0) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return v;
}

/**
 * Compare two values for equality after normalization. Numbers compare by
 * value (so `4.5` and `'4.5'` are equal); everything else compares by
 * stringified form (so `true` and `'true'` are equal — matches how the
 * DB stores text and how the history formatter prints values).
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function valuesEqual(a, b) {
  const na = normalizeValue(a);
  const nb = normalizeValue(b);
  if (na === null && nb === null) return true;
  if (typeof na === 'number' && typeof nb === 'number') return na === nb;
  if (na === null || nb === null) return false;
  return String(na) === String(nb);
}

/**
 * Try to coerce a value to a finite number. Returns the number for numeric
 * inputs and numeric strings ('4.5', '100'); returns null for null /
 * undefined / empty-string / non-numeric strings / NaN / Infinity.
 *
 * Used internally by numericDelta so that stringified DB values (TEXT columns
 * read back as strings) still produce a meaningful delta. normalizeValue (used
 * by valuesEqual + computeChanges) does NOT coerce — it keeps strings as
 * strings so 'open' !== 'closed' comparisons work.
 *
 * @param {*} v
 * @returns {number|null}
 */
function coerceNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Compute the numeric delta (new - old) for two values. Returns `null` when
 * the NEW side is non-numeric (after coercion), so text fields get a `null`
 * delta in field_changes. When the OLD side is null/undefined (a business
 * gaining its first rating), the delta is the new value itself (treated as a
 * gain from 0) — this surfaces "this business just got a rating" as a +delta.
 *
 * Edge cases:
 *   - null → 5      → delta 5    (a business gaining its first rating)
 *   - 5 → null      → delta null (rating lost — new side is non-numeric)
 *   - '4.5' → '4.3' → delta -0.2 (string numbers are coerced)
 *   - 'open' → 'closed' → null   (text field — neither side coerces)
 *   - NaN → 5       → null       (NaN is not finite)
 *
 * @param {*} oldVal
 * @param {*} newVal
 * @returns {number|null}
 */
function numericDelta(oldVal, newVal) {
  const n = coerceNumber(newVal);
  if (n === null) return null; // new side must be numeric for a delta to exist
  // Old side: null / undefined / '' → treat as 0 (gaining a value from
  // nothing — e.g. a business getting its first rating). This is the only
  // "no prior value" case that produces a meaningful +delta.
  if (oldVal === null || oldVal === undefined || oldVal === '') return n;
  const o = coerceNumber(oldVal);
  if (o === null) return null; // NaN / Infinity / non-numeric string → can't compute
  // Floating-point rating deltas are rounded to 1 decimal place to match the
  // NUMERIC(2,1) column precision and produce clean banner output
  // ("Δ -0.2" not "Δ -0.19999999999996").
  const d = n - o;
  return Math.round(d * 10) / 10;
}

/**
 * Compute the list of field-level changes between an existing businesses row
 * and an incoming scrape. Returns one descriptor per tracked field that
 * actually changed (after normalization). Empty array = nothing changed.
 *
 * Each descriptor has the shape:
 *   { field: 'rating', old: 4.5, new: 4.3, delta: -0.2 }
 *   { field: 'business_status', old: 'open', new: 'permanently_closed', delta: null }
 *   { field: 'phone', old: null, new: '+1-555-0100', delta: null }
 *
 * @param {object|null|undefined} oldRow — the existing businesses row (must
 *   contain the tracked fields). null/undefined → empty array (treated as
 *   "no prior data", so every field is technically new, but we don't emit
 *   changes for a brand-new insert — only for updates).
 * @param {object|null|undefined} newRow — the incoming scrape.
 * @param {string[]} [fields] — override the tracked-field list (for tests).
 * @returns {Array<{field: string, old: *, new: *, delta: number|null}>}
 */
function computeChanges(oldRow, newRow, fields) {
  const cols = Array.isArray(fields) && fields.length > 0 ? fields : TRACKED_FIELDS;
  if (!oldRow || !newRow) return [];
  const changes = [];
  for (const field of cols) {
    const o = oldRow[field];
    const n = newRow[field];
    if (!valuesEqual(o, n)) {
      changes.push({
        field,
        old: normalizeValue(o),
        new: normalizeValue(n),
        delta: numericDelta(o, n),
      });
    }
  }
  return changes;
}

/**
 * Summarize a list of change descriptors into a rollup suitable for the
 * end-of-run banner and the scrape_runs.changes_detected stamp:
 *   { total: 22, byField: { rating: 12, reviews_count: 8, business_status: 2, phone: 0, website: 0 } }
 *
 * `byField` always contains every tracked field (0 when none changed), so the
 * banner can do `byField.rating` without undefined checks.
 *
 * @param {Array<{field: string}>} changes — output of computeChanges.
 * @param {string[]} [fields] — override the tracked-field list (for tests).
 * @returns {{total: number, byField: Record<string, number>}}
 */
function summarizeChanges(changes, fields) {
  const cols = Array.isArray(fields) && fields.length > 0 ? fields : TRACKED_FIELDS;
  const byField = {};
  for (const f of cols) byField[f] = 0;
  const list = Array.isArray(changes) ? changes : [];
  for (const c of list) {
    if (c && c.field && byField[c.field] !== undefined) byField[c.field]++;
  }
  let total = 0;
  for (const f of cols) total += byField[f];
  return { total, byField };
}

module.exports = {
  TRACKED_FIELDS,
  normalizeValue,
  coerceNumber,
  valuesEqual,
  numericDelta,
  computeChanges,
  summarizeChanges,
};
