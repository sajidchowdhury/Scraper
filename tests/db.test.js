'use strict';

/**
 * tests/db.test.js — Phase 2.1 — PostgreSQL Persistence Layer tests
 *
 * Coverage (per PHASE2_EXECUTION_PLAN.md §2.1 task checklist):
 *   - Pure-function: computeRowHash (deterministic, key-order-independent, change-detecting)
 *   - Pure-function: decideAction (inserted / updated / unchanged classification)
 *   - DI mock-client: upsert insert → update → unchanged cycle
 *   - DI mock-client: re-scrape with identical data → 'unchanged' (no mutation)
 *   - DI mock-client: re-scrape with changed reviews_count → 'updated'
 *   - DI mock-client: transaction rollback on error (persistRunResults)
 *   - SQL-injection safety: malicious place_id is parameterized, not interpolated
 *   - SQL builders: multi-row INSERT uses ON CONFLICT DO NOTHING + parameterization
 *   - Config: resolveOutputTargets (csv, json, db, all, comma-separated, de-dup)
 *   - Config: --output db requires DATABASE_URL (validation)
 *   - Config: invalid target rejected (validation)
 *   - Integration (guarded on DATABASE_URL): real Postgres migrate → upsert cycle
 *
 * The mock client (`makeMockClient`) simulates the businesses + scrape_runs
 * tables in-memory using the SAME SQL interface (query(text, params) → {rows})
 * that `pg` exposes. This lets the upsert logic run end-to-end without a live
 * database. Integration tests against a real Postgres are included but skipped
 * automatically when DATABASE_URL is not set.
 *
 * Run: bun test tests/db.test.js
 */

const {
  computeRowHash,
  decideAction,
  upsertBusiness,
  upsertBusinessesBatch,
  insertRunSummary,
  persistRunResults,
  buildBatchInsert,
  buildUpdate,
  createPool,
  runMigration,
  closePool,
  SCALAR_COLUMNS,
  JSONB_COLUMNS,
  HASH_COLUMNS,
  columnValue,
  toBool,
  toInt,
  toNum,
  toText,
} = require('../src/db');
const { loadConfig, resolveOutputTargets } = require('../src/config');

// ---------------------------------------------------------------------------
// Mock client — simulates the businesses + scrape_runs tables in-memory.
// Implements the same `query(text, params) → { rows: [...] }` interface as
// pg's Client/PoolClient. Recognizes the exact SQL shapes emitted by src/db.js.
// ---------------------------------------------------------------------------

function makeMockClient({ failOnNthQuery = 0 } = {}) {
  // In-memory tables
  const businesses = new Map(); // place_id → row object
  const scrapeRuns = []; // array of run-summary rows
  let nextRunId = 1;
  let nextBusinessId = 1;

  // Transaction state: a stack of snapshots for ROLLBACK support.
  const txStack = [];
  let queryCount = 0;

  function snapshot() {
    return {
      businesses: new Map(
        Array.from(businesses.entries()).map(([k, v]) => [k, { ...v }]),
      ),
      scrapeRuns: scrapeRuns.slice(),
      nextRunId,
      nextBusinessId,
    };
  }

  function restore(snap) {
    businesses.clear();
    for (const [k, v] of snap.businesses.entries()) businesses.set(k, { ...v });
    scrapeRuns.length = 0;
    scrapeRuns.push(...snap.scrapeRuns);
    nextRunId = snap.nextRunId;
    nextBusinessId = snap.nextBusinessId;
  }

  const client = {
    queryCalls: [],
    async query(text, params) {
      this.queryCalls.push({ text, params: params ? params.slice() : [] });
      queryCount++;

      // Configurable failure injection (for rollback tests).
      if (failOnNthQuery > 0 && queryCount === failOnNthQuery) {
        throw new Error(`MOCK_INJECTED_FAILURE at query #${queryCount}`);
      }

      const t = String(text).trim();

      // Transaction control
      if (t === 'BEGIN') {
        txStack.push(snapshot());
        return { rows: [] };
      }
      if (t === 'COMMIT') {
        txStack.pop();
        return { rows: [] };
      }
      if (t === 'ROLLBACK') {
        const snap = txStack.pop();
        if (snap) restore(snap);
        return { rows: [] };
      }

      // SELECT existing hashes for a batch
      if (t.startsWith('SELECT place_id, data_hash FROM businesses')) {
        const ids = params[0] || [];
        const rows = [];
        for (const id of ids) {
          if (businesses.has(id)) {
            rows.push({ place_id: id, data_hash: businesses.get(id).data_hash });
          }
        }
        return { rows };
      }

      // Multi-row INSERT ... ON CONFLICT (place_id) DO NOTHING
      if (t.startsWith('INSERT INTO businesses') && t.includes('ON CONFLICT')) {
        // Parse column list + values. The columns are between the first parens.
        const colMatch = t.match(/INSERT INTO businesses \(([^)]+)\) VALUES/);
        const cols = colMatch ? colMatch[1].split(', ').map((s) => s.trim()) : [];
        const nCols = cols.length;
        let idx = 0;
        while (idx < params.length) {
          const rowVals = params.slice(idx, idx + nCols);
          const row = {};
          cols.forEach((c, i) => (row[c] = rowVals[i]));
          if (!businesses.has(row.place_id)) {
            businesses.set(row.place_id, {
              id: nextBusinessId++,
              ...row,
              updated_at: new Date().toISOString(),
            });
          }
          idx += nCols;
        }
        return { rows: [] };
      }

      // Single-row UPDATE businesses SET ... WHERE place_id = $N
      if (t.startsWith('UPDATE businesses SET')) {
        const setMatch = t.match(/SET (.+) WHERE place_id = \$(\d+)/);
        if (setMatch) {
          const setClause = setMatch[1];
          const placeIdParamIdx = parseInt(setMatch[2], 10) - 1;
          const placeId = params[placeIdParamIdx];
          if (businesses.has(placeId)) {
            const existing = businesses.get(placeId);
            // Parse "col = $X, col = $Y, ..., updated_at = NOW()"
            const assignments = setClause
              .split(', ')
              .filter((s) => !s.includes('NOW()'));
            for (const a of assignments) {
              const m = a.match(/^(\w+) = \$(\d+)$/);
              if (m) {
                const col = m[1];
                const pIdx = parseInt(m[2], 10) - 1;
                existing[col] = params[pIdx];
              }
            }
            existing.updated_at = new Date().toISOString();
          }
        }
        return { rows: [] };
      }

      // INSERT INTO scrape_runs ... RETURNING id
      if (t.startsWith('INSERT INTO scrape_runs') && t.includes('RETURNING id')) {
        const run = { id: nextRunId++, _params: params };
        scrapeRuns.push(run);
        return { rows: [{ id: run.id }] };
      }

      // UPDATE scrape_runs SET db_inserted = ... WHERE id = ...
      if (t.startsWith('UPDATE scrape_runs SET db_inserted')) {
        return { rows: [] };
      }

      // Migration (schema.sql) — accept any multi-statement DDL.
      if (t.includes('CREATE TABLE') || t.includes('CREATE INDEX') || t.includes('DO $$')) {
        return { rows: [] };
      }

      // Default: no-op (unrecognized query logged for debugging).
      return { rows: [] };
    },
    release() {},
    // Test-inspection helpers
    _businesses: businesses,
    _scrapeRuns: scrapeRuns,
    _snapshot: snapshot,
  };

  return client;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeBusiness(overrides = {}) {
  return {
    place_id: 'ChIJTest1',
    name: 'Test Cafe',
    rating: 4.5,
    reviews_count: 123,
    price_level: '$$',
    category: 'Cafe',
    address: '123 Main St',
    phone: '+1-555-0100',
    website: 'https://example.com',
    maps_url: 'https://maps.google.com/?cid=123',
    plus_code: 'ABC123+',
    open_now: true,
    business_status: 'open',
    is_sponsored: false,
    scraped_at: '2026-08-07T12:00:00.000Z',
    query: 'Cafe',
    location: 'Berlin',
    full_hours: { Monday: '9:00–17:00' },
    popular_times: { Monday: [0, 0, 5, 10] },
    top_reviews: [{ author: 'Alice', rating: 5, text: 'Great!' }],
    photos: ['https://example.com/p1.jpg'],
    reservation_url: null,
    menu_url: 'https://example.com/menu',
    social_profiles: ['instagram:testcafe'],
    detail_scraped: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Pure-function tests: computeRowHash
// ---------------------------------------------------------------------------

describe('Phase 2.1 — computeRowHash (pure)', () => {
  test('is deterministic — same input → same hash', () => {
    const b = makeBusiness();
    expect(computeRowHash(b)).toBe(computeRowHash(b));
  });

  test('two businesses with identical comparable fields produce the same hash', () => {
    const a = makeBusiness();
    const b = makeBusiness();
    expect(computeRowHash(a)).toBe(computeRowHash(b));
  });

  test('changing a comparable field (reviews_count) changes the hash', () => {
    const a = makeBusiness({ reviews_count: 123 });
    const b = makeBusiness({ reviews_count: 200 });
    expect(computeRowHash(a)).not.toBe(computeRowHash(b));
  });

  test('changing a non-comparable field (scraped_at) does NOT change the hash', () => {
    const a = makeBusiness({ scraped_at: '2026-08-07T12:00:00.000Z' });
    const b = makeBusiness({ scraped_at: '2026-08-08T09:00:00.000Z' });
    expect(computeRowHash(a)).toBe(computeRowHash(b));
  });

  test('key ordering in nested objects does not affect the hash', () => {
    const a = makeBusiness({ full_hours: { Monday: '9-5', Tuesday: '9-5' } });
    const b = makeBusiness({ full_hours: { Tuesday: '9-5', Monday: '9-5' } });
    expect(computeRowHash(a)).toBe(computeRowHash(b));
  });

  test('changing a nested value (review text) changes the hash', () => {
    const a = makeBusiness({ top_reviews: [{ author: 'Alice', rating: 5, text: 'Great' }] });
    const b = makeBusiness({ top_reviews: [{ author: 'Alice', rating: 5, text: 'Good' }] });
    expect(computeRowHash(a)).not.toBe(computeRowHash(b));
  });

  test('null vs undefined vs empty-string all normalize to null (no hash change)', () => {
    const a = makeBusiness({ phone: undefined });
    const b = makeBusiness({ phone: null });
    const c = makeBusiness({ phone: '' });
    expect(computeRowHash(a)).toBe(computeRowHash(b));
    expect(computeRowHash(b)).toBe(computeRowHash(c));
  });

  test('returns a 64-char hex string', () => {
    const hash = computeRowHash(makeBusiness());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('handles null/undefined business without throwing', () => {
    expect(() => computeRowHash(null)).not.toThrow();
    expect(() => computeRowHash(undefined)).not.toThrow();
    expect(computeRowHash(null)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('HASH_COLUMNS excludes bookkeeping fields (scraped_at, run_id, updated_at, data_hash)', () => {
    expect(HASH_COLUMNS).not.toContain('scraped_at');
    expect(HASH_COLUMNS).not.toContain('run_id');
    expect(HASH_COLUMNS).not.toContain('updated_at');
    expect(HASH_COLUMNS).not.toContain('data_hash');
    // ... but includes the real data fields.
    expect(HASH_COLUMNS).toContain('name');
    expect(HASH_COLUMNS).toContain('reviews_count');
    expect(HASH_COLUMNS).toContain('full_hours');
  });
});

// ---------------------------------------------------------------------------
// 2. Pure-function tests: decideAction
// ---------------------------------------------------------------------------

describe('Phase 2.1 — decideAction (pure)', () => {
  test('null existingHash → "inserted"', () => {
    expect(decideAction(null, makeBusiness())).toBe('inserted');
  });

  test('undefined existingHash → "inserted"', () => {
    expect(decideAction(undefined, makeBusiness())).toBe('inserted');
  });

  test('matching hash → "unchanged"', () => {
    const b = makeBusiness();
    const hash = computeRowHash(b);
    expect(decideAction(hash, b)).toBe('unchanged');
  });

  test('differing hash → "updated"', () => {
    const original = makeBusiness({ reviews_count: 100 });
    const updated = makeBusiness({ reviews_count: 200 });
    const originalHash = computeRowHash(original);
    expect(decideAction(originalHash, updated)).toBe('updated');
  });

  test('rating change (4.5 → 4.3) is detected as "updated"', () => {
    const original = makeBusiness({ rating: 4.5 });
    const updated = makeBusiness({ rating: 4.3 });
    expect(decideAction(computeRowHash(original), updated)).toBe('updated');
  });

  test('business_status flip (open → permanently_closed) is detected', () => {
    const original = makeBusiness({ business_status: 'open' });
    const updated = makeBusiness({ business_status: 'permanently_closed' });
    expect(decideAction(computeRowHash(original), updated)).toBe('updated');
  });
});

// ---------------------------------------------------------------------------
// 3. Value-coercion helpers
// ---------------------------------------------------------------------------

describe('Phase 2.1 — columnValue coercion', () => {
  test('rating coerces to number', () => {
    expect(columnValue('rating', { rating: '4.5' })).toBe(4.5);
    expect(columnValue('rating', { rating: 4.5 })).toBe(4.5);
    expect(columnValue('rating', { rating: null })).toBeNull();
    expect(columnValue('rating', { rating: '' })).toBeNull();
  });

  test('reviews_count coerces to integer', () => {
    expect(columnValue('reviews_count', { reviews_count: '123' })).toBe(123);
    expect(columnValue('reviews_count', { reviews_count: 123.9 })).toBe(123);
    expect(columnValue('reviews_count', { reviews_count: null })).toBeNull();
  });

  test('open_now / is_sponsored / detail_scraped coerce to boolean', () => {
    expect(columnValue('open_now', { open_now: true })).toBe(true);
    expect(columnValue('open_now', { open_now: 0 })).toBe(false);
    expect(columnValue('is_sponsored', { is_sponsored: 'yes' })).toBe(true);
    expect(columnValue('detail_scraped', { detail_scraped: null })).toBeNull();
  });

  test('JSONB columns are stringified', () => {
    expect(columnValue('full_hours', { full_hours: { Mon: '9-5' } })).toBe(
      JSON.stringify({ Mon: '9-5' }),
    );
    expect(columnValue('photos', { photos: ['a', 'b'] })).toBe(JSON.stringify(['a', 'b']));
    expect(columnValue('full_hours', { full_hours: null })).toBeNull();
  });

  test('scraped_at coerces to ISO timestamp', () => {
    const ts = columnValue('scraped_at', { scraped_at: '2026-08-07T12:00:00.000Z' });
    expect(ts).toBe('2026-08-07T12:00:00.000Z');
    expect(columnValue('scraped_at', { scraped_at: null })).toBeNull();
  });

  test('text columns coerce to string or null', () => {
    expect(columnValue('name', { name: 'Cafe' })).toBe('Cafe');
    expect(columnValue('name', { name: 42 })).toBe('42');
    expect(columnValue('name', { name: null })).toBeNull();
    expect(columnValue('name', { name: '' })).toBeNull();
  });

  test('coercion helpers export correctly', () => {
    expect(toBool(1)).toBe(true);
    expect(toBool(0)).toBe(false);
    expect(toBool(null)).toBeNull();
    expect(toInt('42')).toBe(42);
    expect(toInt(null)).toBeNull();
    expect(toNum('4.5')).toBe(4.5);
    expect(toNum(null)).toBeNull();
    expect(toText('hi')).toBe('hi');
    expect(toText(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. SQL-builder tests (parameterization + structure)
// ---------------------------------------------------------------------------

describe('Phase 2.1 — buildBatchInsert', () => {
  test('produces a parameterized multi-row INSERT with ON CONFLICT DO NOTHING', () => {
    const rows = [
      { business: makeBusiness({ place_id: 'A' }), hash: 'hashA' },
      { business: makeBusiness({ place_id: 'B' }), hash: 'hashB' },
    ];
    const { text, params } = buildBatchInsert(rows, 1);
    expect(text).toContain('INSERT INTO businesses');
    expect(text).toContain('VALUES');
    expect(text).toContain('ON CONFLICT (place_id) DO NOTHING');
    // Two rows × N columns = params length
    expect(params.length).toBe(rows.length * (SCALAR_COLUMNS.length + JSONB_COLUMNS.length + 2));
  });

  test('SQL-injection safety: malicious place_id appears in params, NOT in SQL text', () => {
    const evil = "'; DROP TABLE businesses; --";
    const rows = [{ business: makeBusiness({ place_id: evil }), hash: 'h' }];
    const { text, params } = buildBatchInsert(rows, 1);
    // The evil string must be a bind parameter, not interpolated.
    expect(text).not.toContain("DROP TABLE");
    expect(text).not.toContain(evil);
    expect(params).toContain(evil);
  });

  test('placeholders are sequential ($1, $2, ...)', () => {
    const rows = [{ business: makeBusiness({ place_id: 'X' }), hash: 'hX' }];
    const { text } = buildBatchInsert(rows, 1);
    expect(text).toContain('$1');
  });
});

describe('Phase 2.1 — buildUpdate', () => {
  test('produces a parameterized UPDATE keyed by place_id', () => {
    const b = makeBusiness({ place_id: 'UPDATE_ME' });
    const { text, params } = buildUpdate(b, 'newHash', 5);
    expect(text).toContain('UPDATE businesses SET');
    expect(text).toContain('WHERE place_id = $');
    expect(text).toContain('updated_at = NOW()');
    // The place_id should be the last parameter.
    expect(params[params.length - 1]).toBe('UPDATE_ME');
  });

  test('SQL-injection safety: malicious place_id in WHERE is parameterized', () => {
    const evil = "x' OR '1'='1";
    const b = makeBusiness({ place_id: evil });
    const { text, params } = buildUpdate(b, 'h', 1);
    expect(text).not.toContain(evil);
    expect(text).not.toContain("OR '1'='1");
    expect(params).toContain(evil);
  });
});

// ---------------------------------------------------------------------------
// 5. DI mock-client: upsert insert → update → unchanged cycle
// ---------------------------------------------------------------------------

describe('Phase 2.1 — upsert cycle (DI mock client)', () => {
  test('first upsert of a business → action "inserted"', async () => {
    const client = makeMockClient();
    const b = makeBusiness({ place_id: 'CYCLE_1' });
    const res = await upsertBusiness(client, b, { runId: 1 });
    expect(res.action).toBe('inserted');
    expect(res.place_id).toBe('CYCLE_1');
    // The mock store now has the row.
    expect(client._businesses.has('CYCLE_1')).toBe(true);
  });

  test('re-upsert with IDENTICAL data → action "unchanged" (no UPDATE issued)', async () => {
    const client = makeMockClient();
    const b = makeBusiness({ place_id: 'CYCLE_2', reviews_count: 100 });
    await upsertBusiness(client, b, { runId: 1 });

    // Clear query log, then re-upsert the same data.
    client.queryCalls.length = 0;
    const res = await upsertBusiness(client, b, { runId: 2 });
    expect(res.action).toBe('unchanged');

    // No INSERT or UPDATE should have been issued (only the SELECT hash check).
    const sqlOps = client.queryCalls.map((c) => c.text.split(' ')[0]);
    expect(sqlOps).not.toContain('INSERT');
    expect(sqlOps).not.toContain('UPDATE');
  });

  test('re-upsert with CHANGED reviews_count → action "updated"', async () => {
    const client = makeMockClient();
    const original = makeBusiness({ place_id: 'CYCLE_3', reviews_count: 100 });
    await upsertBusiness(client, original, { runId: 1 });

    // Capture the stored updated_at, then re-upsert with a new review count.
    const beforeTs = client._businesses.get('CYCLE_3').updated_at;
    // Wait a tick so the new updated_at (if bumped) differs.
    await new Promise((r) => setTimeout(r, 5));

    const changed = makeBusiness({ place_id: 'CYCLE_3', reviews_count: 150 });
    const res = await upsertBusiness(client, changed, { runId: 2 });
    expect(res.action).toBe('updated');

    // The stored reviews_count should now be 150.
    expect(client._businesses.get('CYCLE_3').reviews_count).toBe(150);
    // updated_at should have been bumped.
    const afterTs = client._businesses.get('CYCLE_3').updated_at;
    expect(afterTs).not.toBe(beforeTs);
  });

  test('rating change (4.5 → 4.3) → action "updated"', async () => {
    const client = makeMockClient();
    await upsertBusiness(client, makeBusiness({ place_id: 'CYCLE_4', rating: 4.5 }), { runId: 1 });
    const res = await upsertBusiness(
      client,
      makeBusiness({ place_id: 'CYCLE_4', rating: 4.3 }),
      { runId: 2 },
    );
    expect(res.action).toBe('updated');
    expect(client._businesses.get('CYCLE_4').rating).toBe(4.3);
  });

  test('three-business batch: 2 new + 1 unchanged → inserted=2, unchanged=1', async () => {
    const client = makeMockClient();
    // Pre-seed one business so it'll be "unchanged" on the batch upsert.
    const seeded = makeBusiness({ place_id: 'BATCH_SEED', reviews_count: 50 });
    await upsertBusiness(client, seeded, { runId: 1 });

    const batch = [
      makeBusiness({ place_id: 'BATCH_NEW_1' }),
      makeBusiness({ place_id: 'BATCH_NEW_2' }),
      seeded, // identical to the seeded row → unchanged
    ];
    const res = await upsertBusinessesBatch(client, batch, { runId: 2, batchSize: 50 });
    expect(res.inserted).toBe(2);
    expect(res.unchanged).toBe(1);
    expect(res.updated).toBe(0);
    expect(res.details).toHaveLength(3);
  });

  test('batched upsert respects batchSize (multiple SELECT round-trips)', async () => {
    const client = makeMockClient();
    const batch = [];
    for (let i = 0; i < 7; i++) {
      batch.push(makeBusiness({ place_id: 'BATCHSZ_' + i }));
    }
    const res = await upsertBusinessesBatch(client, batch, { runId: 1, batchSize: 3 });
    expect(res.inserted).toBe(7);
    // 7 businesses / batchSize 3 → ceil(7/3) = 3 SELECT queries.
    const selects = client.queryCalls.filter((c) =>
      c.text.startsWith('SELECT place_id, data_hash'),
    );
    expect(selects.length).toBe(3);
  });

  test('businesses without a place_id are skipped (no throw)', async () => {
    const client = makeMockClient();
    const batch = [
      makeBusiness({ place_id: 'OK_1' }),
      { name: 'NoPlaceId' }, // no place_id — should be skipped
      makeBusiness({ place_id: 'OK_2' }),
    ];
    const res = await upsertBusinessesBatch(client, batch, { runId: 1 });
    expect(res.inserted).toBe(2);
  });

  test('upsertBusiness throws if business.place_id is missing', async () => {
    const client = makeMockClient();
    await expect(upsertBusiness(client, { name: 'NoId' })).rejects.toThrow(/place_id/);
  });
});

// ---------------------------------------------------------------------------
// 6. SQL-injection safety (end-to-end via mock client)
// ---------------------------------------------------------------------------

describe('Phase 2.1 — SQL-injection safety', () => {
  test('place_id containing DROP TABLE is stored literally, not executed', async () => {
    const client = makeMockClient();
    const evil = "'; DROP TABLE businesses; --";
    const b = makeBusiness({ place_id: evil });
    const res = await upsertBusiness(client, b, { runId: 1 });
    expect(res.action).toBe('inserted');
    // The evil string is stored as the place_id verbatim.
    expect(client._businesses.has(evil)).toBe(true);
    // No DROP TABLE appears in any issued SQL text (it was a bind param).
    const allSql = client.queryCalls.map((c) => c.text).join(' ');
    expect(allSql).not.toContain('DROP TABLE');
  });

  test('place_id containing comment syntax is stored literally', async () => {
    const client = makeMockClient();
    const evil = "x'--";
    await upsertBusiness(client, makeBusiness({ place_id: evil }), { runId: 1 });
    expect(client._businesses.has(evil)).toBe(true);
  });

  test('name field with SQL payload is parameterized', async () => {
    const client = makeMockClient();
    const evil = "'); DELETE FROM businesses; --";
    const b = makeBusiness({ place_id: 'INJ_NAME', name: evil });
    await upsertBusiness(client, b, { runId: 1 });
    expect(client._businesses.get('INJ_NAME').name).toBe(evil);
    const allSql = client.queryCalls.map((c) => c.text).join(' ');
    expect(allSql).not.toContain('DELETE FROM');
  });
});

// ---------------------------------------------------------------------------
// 7. Transaction rollback (persistRunResults)
// ---------------------------------------------------------------------------

describe('Phase 2.1 — transaction rollback (persistRunResults)', () => {
  test('on upsert error, ROLLBACK is issued and no businesses are committed', async () => {
    // failOnNthQuery: inject a failure on the 3rd query (after BEGIN + INSERT scrape_runs,
    // during the SELECT hash check). persistRunResults should ROLLBACK and rethrow.
    const client = makeMockClient({ failOnNthQuery: 3 });
    // We need a pool-like object whose .connect() returns our mock client.
    const pool = {
      connect: async () => client,
      end: async () => {},
    };

    const businesses = [makeBusiness({ place_id: 'RB_1' }), makeBusiness({ place_id: 'RB_2' })];
    await expect(
      persistRunResults(pool, {
        businesses,
        summary: { query: 'Cafe', location: 'Berlin', startedAt: new Date().toISOString() },
        logger: { info() {}, warn() {}, error() {} },
      }),
    ).rejects.toThrow(/MOCK_INJECTED_FAILURE/);

    // ROLLBACK must have been issued.
    const sqlOps = client.queryCalls.map((c) => c.text.trim());
    expect(sqlOps).toContain('ROLLBACK');
    // No businesses should remain (rollback restored the empty snapshot).
    expect(client._businesses.size).toBe(0);
  });

  test('successful persistRunResults issues BEGIN, upserts, COMMIT', async () => {
    const client = makeMockClient();
    const pool = { connect: async () => client, end: async () => {} };

    const res = await persistRunResults(pool, {
      businesses: [makeBusiness({ place_id: 'OK_RB_1' }), makeBusiness({ place_id: 'OK_RB_2' })],
      summary: { query: 'Cafe', location: 'Berlin', startedAt: new Date().toISOString() },
      logger: { info() {}, warn() {}, error() {} },
    });

    expect(res.inserted).toBe(2);
    expect(res.updated).toBe(0);
    expect(res.unchanged).toBe(0);
    expect(res.runId).toBe(1);

    const sqlOps = client.queryCalls.map((c) => c.text.trim());
    expect(sqlOps).toContain('BEGIN');
    expect(sqlOps).toContain('COMMIT');
    expect(sqlOps).not.toContain('ROLLBACK');
    expect(client._businesses.size).toBe(2);
  });

  test('persistRunResults stamps db counts back onto the run summary row', async () => {
    const client = makeMockClient();
    const pool = { connect: async () => client, end: async () => {} };

    await persistRunResults(pool, {
      businesses: [
        makeBusiness({ place_id: 'STAMP_1' }),
        makeBusiness({ place_id: 'STAMP_2' }),
        makeBusiness({ place_id: 'STAMP_3' }),
      ],
      summary: { query: 'Q', location: 'L', startedAt: new Date().toISOString() },
      logger: { info() {}, warn() {}, error() {} },
    });

    // The UPDATE scrape_runs SET db_inserted=... query should have been issued.
    const stampQuery = client.queryCalls.find(
      (c) => c.text.startsWith('UPDATE scrape_runs SET db_inserted'),
    );
    expect(stampQuery).toBeTruthy();
    expect(stampQuery.params[0]).toBe(3); // db_inserted
  });
});

// ---------------------------------------------------------------------------
// 8. insertRunSummary
// ---------------------------------------------------------------------------

describe('Phase 2.1 — insertRunSummary', () => {
  test('inserts a row and returns the new run id', async () => {
    const client = makeMockClient();
    const id = await insertRunSummary(client, {
      query: 'Cafe',
      location: 'Berlin',
      startedAt: '2026-08-07T12:00:00Z',
      finishedAt: '2026-08-07T12:01:00Z',
      extracted: 50,
      failed: 2,
      exitCode: 0,
      logPath: '/logs/run.log',
      dbInserted: 48,
      dbUpdated: 2,
      dbUnchanged: 0,
    });
    expect(id).toBe(1);
    expect(client._scrapeRuns).toHaveLength(1);
  });

  test('throws if client is null', async () => {
    await expect(insertRunSummary(null, {})).rejects.toThrow(/client is null/);
  });

  test('defaults extracted/failed to 0 when missing', async () => {
    const client = makeMockClient();
    const id = await insertRunSummary(client, { query: 'Q', location: 'L' });
    expect(id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Config: resolveOutputTargets + --output validation
// ---------------------------------------------------------------------------

describe('Phase 2.1 — resolveOutputTargets', () => {
  test('default (no arg) → [csv, json]', () => {
    expect(resolveOutputTargets(undefined)).toEqual(['csv', 'json']);
    expect(resolveOutputTargets('')).toEqual(['csv', 'json']);
  });

  test("'csv' → ['csv']", () => {
    expect(resolveOutputTargets('csv')).toEqual(['csv']);
  });

  test("'db' → ['db']", () => {
    expect(resolveOutputTargets('db')).toEqual(['db']);
  });

  test("'all' → ['csv', 'json', 'db']", () => {
    expect(resolveOutputTargets('all')).toEqual(['csv', 'json', 'db']);
  });

  test('comma-separated → array (de-duped, order preserved)', () => {
    expect(resolveOutputTargets('csv,json,db')).toEqual(['csv', 'json', 'db']);
    expect(resolveOutputTargets('db,db,csv')).toEqual(['db', 'csv']);
  });

  test('case-insensitive + trims whitespace', () => {
    expect(resolveOutputTargets(' CSV , JSON ')).toEqual(['csv', 'json']);
  });
});

describe('Phase 2.1 — config --output validation', () => {
  beforeEach(() => {
    delete process.env.OUTPUT;
    delete process.env.DATABASE_URL;
  });

  test('cfg.output defaults to [csv, json]', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.output).toEqual(['csv', 'json']);
  });

  test('--output db without DATABASE_URL → config error', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--output', 'db']);
    expect(cfg.errors.length).toBeGreaterThan(0);
    expect(cfg.errors.some((e) => e.includes('DATABASE_URL'))).toBe(true);
  });

  test('--output db WITH DATABASE_URL → no error', () => {
    process.env.DATABASE_URL = 'postgresql://gmaps:gmaps@localhost:5432/gmaps_scraper';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--output', 'db']);
    expect(cfg.errors).toEqual([]);
    expect(cfg.output).toEqual(['db']);
    expect(cfg.databaseUrl).toBeTruthy();
  });

  test('--output all requires DATABASE_URL', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--output', 'all']);
    expect(cfg.errors.some((e) => e.includes('DATABASE_URL'))).toBe(true);
  });

  test('invalid target (xml) → config error', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--output', 'xml']);
    expect(cfg.errors.some((e) => e.includes('--output target'))).toBe(true);
  });

  test('OUTPUT env var is respected', () => {
    process.env.OUTPUT = 'csv';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.output).toEqual(['csv']);
  });

  test('--output flag overrides OUTPUT env var', () => {
    process.env.OUTPUT = 'csv';
    process.env.DATABASE_URL = 'postgresql://gmaps:gmaps@localhost:5432/gmaps_scraper';
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin', '--output', 'db',
    ]);
    expect(cfg.output).toEqual(['db']);
  });
});

// ---------------------------------------------------------------------------
// 10. Pool / migration lifecycle
// ---------------------------------------------------------------------------

describe('Phase 2.1 — pool + migration lifecycle', () => {
  test('createPool returns null when no connection string', () => {
    delete process.env.DATABASE_URL;
    expect(createPool()).toBeNull();
    expect(createPool(null)).toBeNull();
    expect(createPool('')).toBeNull();
  });

  test('createPool returns a Pool when a connection string is given', () => {
    const pool = createPool('postgresql://gmaps:gmaps@localhost:5432/gmaps_scraper');
    expect(pool).toBeTruthy();
    expect(typeof pool.query).toBe('function');
    expect(typeof pool.connect).toBe('function');
    expect(typeof pool.end).toBe('function');
  });

  test('closePool(null) is a no-op', async () => {
    await expect(closePool(null)).resolves.toBeUndefined();
  });

  test('closePool ends a real pool', async () => {
    const pool = createPool('postgresql://gmaps:gmaps@localhost:5432/gmaps_scraper');
    let ended = false;
    pool.end = async () => {
      ended = true;
    };
    await closePool(pool);
    expect(ended).toBe(true);
  });

  test('runMigration executes schema.sql against the client (mock)', async () => {
    const client = makeMockClient();
    await runMigration(client);
    const migrateQuery = client.queryCalls.find(
      (c) => c.text.includes('CREATE TABLE') && c.text.includes('businesses'),
    );
    expect(migrateQuery).toBeTruthy();
  });

  test('runMigration throws if poolOrClient is null', async () => {
    await expect(runMigration(null)).rejects.toThrow(/poolOrClient is null/);
  });
});

// ---------------------------------------------------------------------------
// 11. Integration tests — guarded on DATABASE_URL (real Postgres)
//     The block is only DEFINED when DATABASE_URL is a PostgreSQL connection
//     string at module-load time, so bun never attempts to run it (or its
//     beforeAll hooks) when no Postgres is available. To run these:
//       DATABASE_URL=postgresql://gmaps:gmaps@localhost:5432/gmaps_scraper bun test tests/db.test.js
// ---------------------------------------------------------------------------

const PG_URL = process.env.DATABASE_URL && /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL)
  ? process.env.DATABASE_URL
  : null;

if (PG_URL) {
  describe('Phase 2.1 — integration (real PostgreSQL)', () => {
    let pool;

    beforeAll(async () => {
      pool = createPool(PG_URL);
      // Clean slate: drop + recreate the schema (integration test only).
      await pool.query('DROP TABLE IF EXISTS businesses CASCADE;');
      await pool.query('DROP TABLE IF EXISTS scrape_runs CASCADE;');
      await runMigration(pool);
    });

    afterAll(async () => {
      await closePool(pool);
    });

    test('migrate creates businesses + scrape_runs tables', async () => {
      const res = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_name IN ('businesses','scrape_runs') ORDER BY table_name",
      );
      expect(res.rows.map((r) => r.table_name)).toEqual(['businesses', 'scrape_runs']);
    });

    test('full upsert cycle: insert → unchanged → updated', async () => {
      const client = await pool.connect();
      try {
        const place_id = 'INT_TEST_CYCLE_' + Date.now();
        const b1 = makeBusiness({ place_id, reviews_count: 100 });
        const r1 = await upsertBusiness(client, b1, { runId: 1 });
        expect(r1.action).toBe('inserted');

        const r2 = await upsertBusiness(client, b1, { runId: 1 });
        expect(r2.action).toBe('unchanged');

        const b2 = makeBusiness({ place_id, reviews_count: 150 });
        const r3 = await upsertBusiness(client, b2, { runId: 1 });
        expect(r3.action).toBe('updated');

        // Verify the row in the DB has the new review count.
        const sel = await client.query(
          'SELECT reviews_count FROM businesses WHERE place_id = $1',
          [place_id],
        );
        expect(sel.rows[0].reviews_count).toBe(150);
      } finally {
        client.release();
      }
    });

    test('re-migrating is idempotent (no error)', async () => {
      await expect(runMigration(pool)).resolves.toBeUndefined();
    });
  });
} else {
  // Sentinel test so the integration suite always reports something (and
  // documents why it's skipped) rather than silently disappearing.
  test('Phase 2.1 — integration tests skipped (no PostgreSQL DATABASE_URL)', () => {
    // To enable: set DATABASE_URL=postgresql://... and re-run.
    expect(PG_URL).toBeFalsy();
  });
}
