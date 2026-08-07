'use strict';

/**
 * tests/db-deltas.test.js — Phase 2.2 — Change Tracking & History (pure helpers)
 *
 * Coverage (per PHASE2_EXECUTION_PLAN.md §2.2 task checklist):
 *   - normalizeValue: null / undefined / '' / NaN / finite-number handling
 *   - valuesEqual: null↔value, type coercion, string vs number
 *   - numericDelta: nulls, strings, NaN, rating deltas (rounded to 1 dp)
 *   - computeChanges: detects rating / review-count / status / phone / website
 *     changes; returns [] when nothing changed; returns [] when oldRow is null
 *   - summarizeChanges: per-field rollup + total
 *   - src/db/history.js pure formatters: formatValue, formatDelta, fieldLabel,
 *     formatTimestamp, formatChangeLine, formatCurrentLine, parseArgs
 *
 * No database, no I/O — every function here is pure. Run: bun test tests/db-deltas.test.js
 */

const {
  TRACKED_FIELDS,
  normalizeValue,
  valuesEqual,
  numericDelta,
  computeChanges,
  summarizeChanges,
} = require('../src/db/deltas');
const {
  parseArgs,
  formatValue,
  formatDelta,
  fieldLabel,
  formatTimestamp,
  formatChangeLine,
  formatCurrentLine,
} = require('../src/db/history');

// ---------------------------------------------------------------------------
// 1. normalizeValue
// ---------------------------------------------------------------------------

describe('Phase 2.2 — normalizeValue', () => {
  test('null / undefined / empty-string all collapse to null', () => {
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(undefined)).toBeNull();
    expect(normalizeValue('')).toBeNull();
  });

  test('finite numbers are kept as numbers', () => {
    expect(normalizeValue(4.5)).toBe(4.5);
    expect(normalizeValue(0)).toBe(0);
    expect(normalizeValue(-3)).toBe(-3);
  });

  test('NaN / Infinity collapse to null', () => {
    expect(normalizeValue(NaN)).toBeNull();
    expect(normalizeValue(Infinity)).toBeNull();
    expect(normalizeValue(-Infinity)).toBeNull();
  });

  test('non-empty strings are kept as-is', () => {
    expect(normalizeValue('open')).toBe('open');
    expect(normalizeValue('+1-555-0100')).toBe('+1-555-0100');
  });

  test('objects/arrays are passed through (JSON-stringified elsewhere)', () => {
    expect(normalizeValue({ a: 1 })).toEqual({ a: 1 });
    expect(normalizeValue([1, 2])).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// 2. valuesEqual
// ---------------------------------------------------------------------------

describe('Phase 2.2 — valuesEqual', () => {
  test('null === null === "" === undefined (no change between them)', () => {
    expect(valuesEqual(null, null)).toBe(true);
    expect(valuesEqual(null, undefined)).toBe(true);
    expect(valuesEqual('', null)).toBe(true);
    expect(valuesEqual(undefined, '')).toBe(true);
  });

  test('numbers compare by value', () => {
    expect(valuesEqual(4.5, 4.5)).toBe(true);
    expect(valuesEqual(4.5, 4.3)).toBe(false);
    expect(valuesEqual(100, 100)).toBe(true);
  });

  test('numeric string vs number compare equal (4.5 === "4.5")', () => {
    expect(valuesEqual(4.5, '4.5')).toBe(true);
    expect(valuesEqual('100', 100)).toBe(true);
  });

  test('null vs a value is NOT equal', () => {
    expect(valuesEqual(null, 'open')).toBe(false);
    expect(valuesEqual('open', null)).toBe(false);
    expect(valuesEqual(4.5, null)).toBe(false);
  });

  test('text values compare by stringified form', () => {
    expect(valuesEqual('open', 'open')).toBe(true);
    expect(valuesEqual('open', 'closed')).toBe(false);
    expect(valuesEqual('+1-555-0100', '+1-555-0100')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. numericDelta
// ---------------------------------------------------------------------------

describe('Phase 2.2 — numericDelta', () => {
  test('new - old for finite numbers', () => {
    expect(numericDelta(4.5, 4.3)).toBe(-0.2);
    expect(numericDelta(100, 150)).toBe(50);
    expect(numericDelta(0, 5)).toBe(5);
    expect(numericDelta(5, 0)).toBe(-5);
  });

  test('null → number returns the number (first rating gained)', () => {
    expect(numericDelta(null, 5)).toBe(5);
    expect(numericDelta(undefined, 4.5)).toBe(4.5);
  });

  test('number → null returns null (rating lost — non-numeric new side)', () => {
    expect(numericDelta(4.5, null)).toBeNull();
    expect(numericDelta(4.5, undefined)).toBeNull();
  });

  test('null → null returns null', () => {
    expect(numericDelta(null, null)).toBeNull();
  });

  test('string numbers are parsed', () => {
    expect(numericDelta('4.5', '4.3')).toBe(-0.2);
    expect(numericDelta('100', '150')).toBe(50);
  });

  test('text values return null (no meaningful delta)', () => {
    expect(numericDelta('open', 'closed')).toBeNull();
    expect(numericDelta('+1-555-0100', '+1-555-0200')).toBeNull();
  });

  test('NaN inputs return null', () => {
    expect(numericDelta(NaN, 5)).toBeNull();
    expect(numericDelta(5, NaN)).toBeNull();
    expect(numericDelta(Infinity, 5)).toBeNull();
  });

  test('rating deltas are rounded to 1 decimal place (avoids FP noise)', () => {
    // 4.3 - 4.5 = -0.19999999999996 in raw IEEE-754; we round to -0.2.
    expect(numericDelta(4.5, 4.3)).toBe(-0.2);
    expect(numericDelta(3.7, 4.1)).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// 4. computeChanges
// ---------------------------------------------------------------------------

describe('Phase 2.2 — computeChanges', () => {
  test('returns [] when nothing changed', () => {
    const old = { rating: 4.5, reviews_count: 100, business_status: 'open', phone: 'p', website: 'w' };
    const now = { rating: 4.5, reviews_count: 100, business_status: 'open', phone: 'p', website: 'w' };
    expect(computeChanges(old, now)).toEqual([]);
  });

  test('returns [] when oldRow is null (brand-new insert, no prior data)', () => {
    const now = { rating: 4.5, reviews_count: 100 };
    expect(computeChanges(null, now)).toEqual([]);
    expect(computeChanges(undefined, now)).toEqual([]);
  });

  test('returns [] when newRow is null', () => {
    const old = { rating: 4.5 };
    expect(computeChanges(old, null)).toEqual([]);
  });

  test('detects a rating change with numeric delta', () => {
    const changes = computeChanges(
      { rating: 4.5, reviews_count: 100, business_status: 'open', phone: 'p', website: 'w' },
      { rating: 4.3, reviews_count: 100, business_status: 'open', phone: 'p', website: 'w' },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('rating');
    expect(changes[0].old).toBe(4.5);
    expect(changes[0].new).toBe(4.3);
    expect(changes[0].delta).toBe(-0.2);
  });

  test('detects a reviews_count change with +delta', () => {
    const changes = computeChanges(
      { rating: 4.5, reviews_count: 1234, business_status: 'open', phone: 'p', website: 'w' },
      { rating: 4.5, reviews_count: 1289, business_status: 'open', phone: 'p', website: 'w' },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('reviews_count');
    expect(changes[0].delta).toBe(55);
  });

  test('detects a business_status change with null delta (text field)', () => {
    const changes = computeChanges(
      { rating: 4.5, reviews_count: 100, business_status: 'open', phone: 'p', website: 'w' },
      { rating: 4.5, reviews_count: 100, business_status: 'permanently_closed', phone: 'p', website: 'w' },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('business_status');
    expect(changes[0].old).toBe('open');
    expect(changes[0].new).toBe('permanently_closed');
    expect(changes[0].delta).toBeNull();
  });

  test('detects a phone change with null delta', () => {
    const changes = computeChanges(
      { rating: 4.5, reviews_count: 100, business_status: 'open', phone: '+1-555-0100', website: 'w' },
      { rating: 4.5, reviews_count: 100, business_status: 'open', phone: '+1-555-0200', website: 'w' },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('phone');
    expect(changes[0].delta).toBeNull();
  });

  test('detects a website change (clients care if a business loses its website)', () => {
    const changes = computeChanges(
      { rating: 4.5, reviews_count: 100, business_status: 'open', phone: 'p', website: 'https://old.example.com' },
      { rating: 4.5, reviews_count: 100, business_status: 'open', phone: 'p', website: null },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('website');
    expect(changes[0].old).toBe('https://old.example.com');
    expect(changes[0].new).toBeNull();
    expect(changes[0].delta).toBeNull();
  });

  test('detects ALL five tracked fields changing at once', () => {
    const old = { rating: 4.5, reviews_count: 100, business_status: 'open', phone: 'p1', website: 'w1' };
    const now = { rating: 4.2, reviews_count: 130, business_status: 'closed', phone: 'p2', website: 'w2' };
    const changes = computeChanges(old, now);
    expect(changes).toHaveLength(5);
    const fields = changes.map((c) => c.field).sort();
    expect(fields).toEqual(['business_status', 'phone', 'rating', 'reviews_count', 'website'].sort());
  });

  test('null → value is detected as a change (e.g. business gains a phone)', () => {
    const changes = computeChanges(
      { rating: 4.5, reviews_count: 100, business_status: 'open', phone: null, website: 'w' },
      { rating: 4.5, reviews_count: 100, business_status: 'open', phone: '+1-555-0100', website: 'w' },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('phone');
    expect(changes[0].old).toBeNull();
    expect(changes[0].new).toBe('+1-555-0100');
  });

  test('empty-string → null is NOT a change (both normalize to null)', () => {
    const changes = computeChanges(
      { rating: 4.5, reviews_count: 100, business_status: 'open', phone: '', website: 'w' },
      { rating: 4.5, reviews_count: 100, business_status: 'open', phone: null, website: 'w' },
    );
    expect(changes).toEqual([]);
  });

  test('respects a custom field list (only compares the given fields)', () => {
    const old = { rating: 4.5, reviews_count: 100, business_status: 'open', phone: 'p', website: 'w' };
    const now = { rating: 4.3, reviews_count: 200, business_status: 'closed', phone: 'p2', website: 'w2' };
    const changes = computeChanges(old, now, ['rating']);
    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('rating');
  });

  test('TRACKED_FIELDS is the default field list', () => {
    expect(TRACKED_FIELDS).toEqual([
      'rating',
      'reviews_count',
      'business_status',
      'phone',
      'website',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. summarizeChanges
// ---------------------------------------------------------------------------

describe('Phase 2.2 — summarizeChanges', () => {
  test('empty input → total 0, every tracked field 0', () => {
    const s = summarizeChanges([]);
    expect(s.total).toBe(0);
    for (const f of TRACKED_FIELDS) expect(s.byField[f]).toBe(0);
  });

  test('non-array input → treated as empty', () => {
    const s = summarizeChanges(null);
    expect(s.total).toBe(0);
    expect(s.byField.rating).toBe(0);
  });

  test('counts per field + total', () => {
    const changes = [
      { field: 'rating' },
      { field: 'rating' },
      { field: 'reviews_count' },
      { field: 'business_status' },
      { field: 'phone' },
      { field: 'website' },
    ];
    const s = summarizeChanges(changes);
    expect(s.total).toBe(6);
    expect(s.byField.rating).toBe(2);
    expect(s.byField.reviews_count).toBe(1);
    expect(s.byField.business_status).toBe(1);
    expect(s.byField.phone).toBe(1);
    expect(s.byField.website).toBe(1);
  });

  test('ignores unknown fields (defensive)', () => {
    const s = summarizeChanges([{ field: 'name' }, { field: 'rating' }]);
    expect(s.total).toBe(1);
    expect(s.byField.rating).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. history.js — parseArgs
// ---------------------------------------------------------------------------

describe('Phase 2.2 — history.parseArgs', () => {
  test('parses --placeId', () => {
    const a = parseArgs(['node', 'history.js', '--placeId', 'ChIJ123']);
    expect(a.placeId).toBe('ChIJ123');
  });

  test('parses --place-id (kebab-case alias)', () => {
    const a = parseArgs(['node', 'history.js', '--place-id', 'ChIJ456']);
    expect(a.placeId).toBe('ChIJ456');
  });

  test('parses -p (short alias)', () => {
    const a = parseArgs(['node', 'history.js', '-p', 'ChIJ789']);
    expect(a.placeId).toBe('ChIJ789');
  });

  test('parses --limit', () => {
    const a = parseArgs(['node', 'history.js', '--placeId', 'X', '--limit', '20']);
    expect(a.limit).toBe(20);
  });

  test('default limit is 100', () => {
    const a = parseArgs(['node', 'history.js', '--placeId', 'X']);
    expect(a.limit).toBe(100);
  });

  test('positional connection string is captured', () => {
    const a = parseArgs([
      'node',
      'history.js',
      '--placeId',
      'X',
      'postgresql://user:pass@host:5432/db',
    ]);
    expect(a.connectionString).toBe('postgresql://user:pass@host:5432/db');
  });

  test('--help sets args.help = true', () => {
    const a = parseArgs(['node', 'history.js', '--help']);
    expect(a.help).toBe(true);
  });

  test('missing --placeId → placeId is null', () => {
    const a = parseArgs(['node', 'history.js']);
    expect(a.placeId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. history.js — pure formatters
// ---------------------------------------------------------------------------

describe('Phase 2.2 — history formatters', () => {
  test('formatValue: null/undefined → "(none)"', () => {
    expect(formatValue(null)).toBe('(none)');
    expect(formatValue(undefined)).toBe('(none)');
  });

  test('formatValue: numbers + strings as-is', () => {
    expect(formatValue(4.5)).toBe('4.5');
    expect(formatValue('+1-555-0100')).toBe('+1-555-0100');
  });

  test('formatDelta: positive gets a leading +', () => {
    expect(formatDelta(55)).toBe(' (Δ +55)');
    expect(formatDelta(0.4)).toBe(' (Δ +0.4)');
  });

  test('formatDelta: negative has no leading +', () => {
    expect(formatDelta(-0.2)).toBe(' (Δ -0.2)');
    expect(formatDelta(-5)).toBe(' (Δ -5)');
  });

  test('formatDelta: null/undefined → empty string (text fields get no delta)', () => {
    expect(formatDelta(null)).toBe('');
    expect(formatDelta(undefined)).toBe('');
  });

  test('fieldLabel: reviews_count → "reviews", business_status → "status"', () => {
    expect(fieldLabel('rating')).toBe('rating');
    expect(fieldLabel('reviews_count')).toBe('reviews');
    expect(fieldLabel('business_status')).toBe('status');
    expect(fieldLabel('phone')).toBe('phone');
    expect(fieldLabel('website')).toBe('website');
    // Unknown fields pass through.
    expect(fieldLabel('custom')).toBe('custom');
  });

  test('formatTimestamp: ISO string → "YYYY-MM-DD HH:MM"', () => {
    const ts = '2026-08-07T14:03:22.000Z';
    const out = formatTimestamp(ts);
    // Format check (exact digits depend on TZ, but the shape is stable).
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  test('formatTimestamp: invalid → "----"', () => {
    expect(formatTimestamp('not-a-date')).toBe('----');
    expect(formatTimestamp(null)).toBe('----');
    expect(formatTimestamp(undefined)).toBe('----');
  });

  test('formatChangeLine: numeric field with delta', () => {
    const line = formatChangeLine({
      detected_at: '2026-08-07T14:03:22.000Z',
      field: 'rating',
      old_value: '4.5',
      new_value: '4.3',
      delta: '-0.2',
    });
    expect(line).toContain('rating');
    expect(line).toContain('4.5 → 4.3');
    expect(line).toContain('(Δ -0.2)');
  });

  test('formatChangeLine: text field without delta', () => {
    const line = formatChangeLine({
      detected_at: '2026-08-07T14:03:22.000Z',
      field: 'business_status',
      old_value: 'open',
      new_value: 'permanently_closed',
      delta: null,
    });
    expect(line).toContain('status open → permanently_closed');
    // No delta clause for text fields.
    expect(line).not.toContain('Δ');
  });

  test('formatChangeLine: null old/new rendered as "(none)"', () => {
    const line = formatChangeLine({
      detected_at: '2026-08-07T14:03:22.000Z',
      field: 'phone',
      old_value: null,
      new_value: '+1-555-0100',
      delta: null,
    });
    expect(line).toContain('phone (none) → +1-555-0100');
  });

  test('formatCurrentLine: full tracked-field summary', () => {
    const line = formatCurrentLine({
      name: 'Test Cafe',
      rating: 4.3,
      reviews_count: 1289,
      business_status: 'open',
      phone: '+1-555-0100',
      website: 'https://example.com',
    });
    expect(line).toContain('rating 4.3');
    expect(line).toContain('reviews 1289');
    expect(line).toContain('status open');
    expect(line).toContain('phone +1-555-0100');
    expect(line).toContain('website https://example.com');
  });

  test('formatCurrentLine: null row → "(business not found)"', () => {
    const line = formatCurrentLine(null);
    expect(line).toContain('(business not found)');
  });

  test('formatCurrentLine: null tracked values render as "(none)"', () => {
    const line = formatCurrentLine({
      name: 'X',
      rating: null,
      reviews_count: null,
      business_status: null,
      phone: null,
      website: null,
    });
    expect(line).toContain('rating (none)');
    expect(line).toContain('reviews (none)');
  });
});
