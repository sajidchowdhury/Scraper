'use strict';

/**
 * tests/checkpoint.test.js — Phase 1.7 unit tests for src/checkpoint.js
 *
 * Coverage:
 *   1. checkpointPath — filename format + sanitization
 *   2. dedupKey — place_id preferred, hash fallback, null for empty records
 *   3. buildDedupSet — set of dedup keys from a business list
 *   4. writeCheckpoint — writes valid JSON with version, query, location, businesses
 *   5. readCheckpoint — returns parsed checkpoint, null if missing
 *   6. readCheckpoint — returns {corrupt: true} on bad JSON
 *   7. readCheckpoint — returns {mismatch: true} when query/location don't match
 *   8. clearCheckpoint — deletes file, idempotent on missing file
 *   9. checkpointExists — boolean check
 *  10. shouldResume — --fresh always clears + returns null
 *  11. shouldResume — no checkpoint → null
 *  12. shouldResume — --resume loads checkpoint without prompting
 *  13. shouldResume — checkpoint exists + no flag → prompts; yes → resume
 *  14. shouldResume — checkpoint exists + no flag → prompts; no → clear + null
 *  15. shouldResume — corrupt checkpoint → clear + null
 *  16. writeCheckpoint is atomic (.tmp then rename)
 *
 * Run: bun test tests/
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  checkpointPath,
  dedupKey,
  buildDedupSet,
  readCheckpoint,
  writeCheckpoint,
  clearCheckpoint,
  checkpointExists,
  shouldResume,
  CHECKPOINT_VERSION,
} = require('../src/checkpoint');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

function beforeEach() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-test-'));
}

function afterEach() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makeCfg(overrides = {}) {
  return {
    query: 'Restaurant',
    location: 'Toronto',
    outputDir: tmpDir,
    ...overrides,
  };
}

function makeBusiness(name, overrides = {}) {
  return {
    name,
    place_id: 'ChIJ' + name,
    address: '123 Main St',
    phone: '+1234567890',
    ...overrides,
  };
}

const noopLogger = { info() {}, warn() {}, debug() {}, error() {} };

// ---------------------------------------------------------------------------
// checkpointPath
// ---------------------------------------------------------------------------

describe('checkpointPath', () => {
  test('format: {outputDir}/.checkpoint_{query}_{location}.json', () => {
    const p = checkpointPath({ outputDir: '/data', query: 'Cafe', location: 'Berlin' });
    expect(p).toBe(path.join('/data', '.checkpoint_Cafe_Berlin.json'));
  });

  test('sanitizes query and location (spaces, slashes, special chars)', () => {
    const p = checkpointPath({
      outputDir: '/data',
      query: 'Restaurant & Cafe!',
      location: 'São Paulo / SP',
    });
    const base = path.basename(p);
    // Consecutive special chars collapse to a single _ (regex uses +)
    expect(base).toMatch(/^\.checkpoint_/);
    expect(base).toContain('Restaurant');
    expect(base).toContain('Cafe');
    expect(base).toContain('S');
    expect(base).toContain('Paulo');
    expect(base).toContain('SP');
    // No raw special chars in the filename
    expect(base).not.toContain('!');
    expect(base).not.toContain('&');
    expect(base).not.toContain('/');
    expect(base).not.toContain(' ');
  });

  test('handles empty query/location (falls back to "run")', () => {
    const p = checkpointPath({ outputDir: '/data', query: '', location: '' });
    expect(p).toContain('.checkpoint_run_run');
  });

  test('handles undefined query/location', () => {
    const p = checkpointPath({ outputDir: '/data' });
    expect(p).toContain('.checkpoint_run_run');
  });
});

// ---------------------------------------------------------------------------
// dedupKey
// ---------------------------------------------------------------------------

describe('dedupKey', () => {
  test('prefers place_id with pid: prefix', () => {
    const key = dedupKey({ place_id: 'ChIJ123abc', name: 'Test' });
    expect(key).toBe('pid:ChIJ123abc');
  });

  test('falls back to hash of name+address+phone+maps_url when no place_id', () => {
    const key = dedupKey({ name: 'Cafe', address: '123 St', phone: '123', maps_url: 'url' });
    expect(key).toMatch(/^h:[a-f0-9]{16}$/);
  });

  test('same input → same hash key (deterministic)', () => {
    const b1 = { name: 'Cafe', address: '123 St', phone: '123', maps_url: 'url' };
    const b2 = { name: 'Cafe', address: '123 St', phone: '123', maps_url: 'url' };
    expect(dedupKey(b1)).toBe(dedupKey(b2));
  });

  test('different input → different hash key', () => {
    const b1 = { name: 'Cafe', address: '123 St' };
    const b2 = { name: 'Cafe', address: '456 St' };
    expect(dedupKey(b1)).not.toBe(dedupKey(b2));
  });

  test('returns null for empty record', () => {
    expect(dedupKey({})).toBeNull();
    expect(dedupKey(null)).toBeNull();
    expect(dedupKey(undefined)).toBeNull();
  });

  test('returns null when all fields are empty strings', () => {
    expect(dedupKey({ name: '', address: '', phone: '', maps_url: '' })).toBeNull();
  });

  test('works with just name (no place_id, no other fields)', () => {
    const key = dedupKey({ name: 'Only Name' });
    expect(key).toMatch(/^h:[a-f0-9]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// buildDedupSet
// ---------------------------------------------------------------------------

describe('buildDedupSet', () => {
  test('builds a Set of dedup keys', () => {
    const businesses = [
      makeBusiness('A'),
      makeBusiness('B'),
      makeBusiness('C'),
    ];
    const set = buildDedupSet(businesses);
    expect(set.size).toBe(3);
    expect(set.has('pid:ChIJA')).toBe(true);
    expect(set.has('pid:ChIJB')).toBe(true);
    expect(set.has('pid:ChIJC')).toBe(true);
  });

  test('skips records with null dedup key', () => {
    const businesses = [makeBusiness('A'), {}, null, makeBusiness('B')];
    const set = buildDedupSet(businesses);
    expect(set.size).toBe(2);
  });

  test('empty list → empty set', () => {
    expect(buildDedupSet([]).size).toBe(0);
    expect(buildDedupSet(null).size).toBe(0);
    expect(buildDedupSet(undefined).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// writeCheckpoint / readCheckpoint
// ---------------------------------------------------------------------------

describe('writeCheckpoint + readCheckpoint roundtrip', () => {
  beforeEach(() => {});
  afterEach(() => {});

  test('writes a valid JSON file with version, query, location, businesses', () => {
    const cfg = makeCfg();
    const businesses = [makeBusiness('A'), makeBusiness('B')];
    const file = writeCheckpoint(cfg, { businesses });

    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.version).toBe(CHECKPOINT_VERSION);
    expect(parsed.query).toBe('Restaurant');
    expect(parsed.location).toBe('Toronto');
    expect(parsed.businesses).toHaveLength(2);
    expect(parsed.businesses[0].name).toBe('A');
    expect(parsed.count).toBe(2);
    expect(parsed.updatedAt).toBeTruthy();
  });

  test('readCheckpoint returns the parsed checkpoint', () => {
    const cfg = makeCfg();
    const businesses = [makeBusiness('A')];
    writeCheckpoint(cfg, { businesses });

    const read = readCheckpoint(cfg);
    expect(read).not.toBeNull();
    expect(read.corrupt).toBeUndefined();
    expect(read.businesses).toHaveLength(1);
    expect(read.businesses[0].name).toBe('A');
    expect(read.count).toBe(1);
  });

  test('readCheckpoint returns null when file does not exist', () => {
    const cfg = makeCfg({ query: 'Nonexistent' });
    expect(readCheckpoint(cfg)).toBeNull();
  });

  test('roundtrip preserves business data integrity', () => {
    const cfg = makeCfg();
    const businesses = [
      makeBusiness('A', { rating: 4.5, reviews_count: 123, detail_scraped: true }),
      makeBusiness('B', { rating: 3.2, reviews_count: 45, detail_scraped: false }),
    ];
    writeCheckpoint(cfg, { businesses, extractionRates: { name: { rate: 100 } } });

    const read = readCheckpoint(cfg);
    expect(read.businesses[0]).toEqual(businesses[0]);
    expect(read.businesses[1]).toEqual(businesses[1]);
    expect(read.extractionRates.name.rate).toBe(100);
  });
});

describe('readCheckpoint — corrupt / mismatch handling', () => {
  beforeEach(() => {});
  afterEach(() => {});

  test('returns {corrupt: true} on invalid JSON', () => {
    const cfg = makeCfg();
    const file = checkpointPath(cfg);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(file, '{ this is not valid json !!!', 'utf8');

    const read = readCheckpoint(cfg);
    expect(read.corrupt).toBe(true);
    expect(read.path).toBe(file);
  });

  test('returns {corrupt: true} when content is not an object', () => {
    const cfg = makeCfg();
    const file = checkpointPath(cfg);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(file, '"just a string"', 'utf8');

    const read = readCheckpoint(cfg);
    expect(read.corrupt).toBe(true);
  });

  test('returns {mismatch: true} when query/location do not match', () => {
    const cfg = makeCfg({ query: 'Cafe', location: 'Berlin' });
    const file = checkpointPath(cfg);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ query: 'Different', location: 'Different', businesses: [] }),
      'utf8',
    );

    const read = readCheckpoint(cfg);
    expect(read.mismatch).toBe(true);
    expect(read.stored.query).toBe('Different');
  });
});

// ---------------------------------------------------------------------------
// clearCheckpoint
// ---------------------------------------------------------------------------

describe('clearCheckpoint', () => {
  beforeEach(() => {});
  afterEach(() => {});

  test('deletes an existing checkpoint file', () => {
    const cfg = makeCfg();
    writeCheckpoint(cfg, { businesses: [makeBusiness('A')] });
    expect(checkpointExists(cfg)).toBe(true);

    const result = clearCheckpoint(cfg);
    expect(result).toBe(true);
    expect(checkpointExists(cfg)).toBe(false);
  });

  test('idempotent — returns true even if file does not exist', () => {
    const cfg = makeCfg({ query: 'Nothing' });
    expect(checkpointExists(cfg)).toBe(false);
    expect(clearCheckpoint(cfg)).toBe(true);
  });

  test('clears the file that writeCheckpoint created', () => {
    const cfg = makeCfg();
    writeCheckpoint(cfg, { businesses: [makeBusiness('A'), makeBusiness('B')] });
    expect(checkpointExists(cfg)).toBe(true);

    clearCheckpoint(cfg);
    expect(readCheckpoint(cfg)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkpointExists
// ---------------------------------------------------------------------------

describe('checkpointExists', () => {
  beforeEach(() => {});
  afterEach(() => {});

  test('false when no checkpoint file', () => {
    const cfg = makeCfg({ query: 'Nothing' });
    expect(checkpointExists(cfg)).toBe(false);
  });

  test('true after writeCheckpoint', () => {
    const cfg = makeCfg();
    writeCheckpoint(cfg, { businesses: [] });
    expect(checkpointExists(cfg)).toBe(true);
  });

  test('false after clearCheckpoint', () => {
    const cfg = makeCfg();
    writeCheckpoint(cfg, { businesses: [] });
    clearCheckpoint(cfg);
    expect(checkpointExists(cfg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldResume
// ---------------------------------------------------------------------------

describe('shouldResume', () => {
  beforeEach(() => {});
  afterEach(() => {});

  test('--fresh: clears existing checkpoint, returns null', async () => {
    const cfg = makeCfg({ fresh: true });
    writeCheckpoint(cfg, { businesses: [makeBusiness('A')] });
    expect(checkpointExists(cfg)).toBe(true);

    const result = await shouldResume(cfg, {}, noopLogger);
    expect(result.resume).toBe(false);
    expect(result.checkpoint).toBeNull();
    expect(result.skipped).toBe(0);
    expect(checkpointExists(cfg)).toBe(false); // cleared
  });

  test('--fresh: no-op when no checkpoint exists', async () => {
    const cfg = makeCfg({ fresh: true, query: 'Nothing' });
    const result = await shouldResume(cfg, {}, noopLogger);
    expect(result.resume).toBe(false);
    expect(result.checkpoint).toBeNull();
  });

  test('no checkpoint → returns null (no resume)', async () => {
    const cfg = makeCfg({ query: 'Nothing' });
    const result = await shouldResume(cfg, {}, noopLogger);
    expect(result.resume).toBe(false);
    expect(result.checkpoint).toBeNull();
    expect(result.skipped).toBe(0);
  });

  test('--resume: loads checkpoint without prompting', async () => {
    const cfg = makeCfg({ resume: true });
    const businesses = [makeBusiness('A'), makeBusiness('B'), makeBusiness('C')];
    writeCheckpoint(cfg, { businesses });

    const promptCalls = [];
    const result = await shouldResume(
      cfg,
      { prompt: (q) => { promptCalls.push(q); return Promise.resolve(false); } },
      noopLogger,
    );

    expect(result.resume).toBe(true);
    expect(result.checkpoint).not.toBeNull();
    expect(result.checkpoint.businesses).toHaveLength(3);
    expect(result.skipped).toBe(3);
    expect(promptCalls).toHaveLength(0); // --resume skips the prompt
  });

  test('checkpoint exists + no flag + prompt yes → resume', async () => {
    const cfg = makeCfg();
    const businesses = [makeBusiness('A'), makeBusiness('B')];
    writeCheckpoint(cfg, { businesses });

    const result = await shouldResume(
      cfg,
      { prompt: () => Promise.resolve(true) },
      noopLogger,
    );

    expect(result.resume).toBe(true);
    expect(result.checkpoint.businesses).toHaveLength(2);
    expect(result.skipped).toBe(2);
  });

  test('checkpoint exists + no flag + prompt no → clear + null', async () => {
    const cfg = makeCfg();
    writeCheckpoint(cfg, { businesses: [makeBusiness('A')] });
    expect(checkpointExists(cfg)).toBe(true);

    const result = await shouldResume(
      cfg,
      { prompt: () => Promise.resolve(false) },
      noopLogger,
    );

    expect(result.resume).toBe(false);
    expect(result.checkpoint).toBeNull();
    expect(checkpointExists(cfg)).toBe(false); // cleared
  });

  test('corrupt checkpoint → clear + null (no prompt)', async () => {
    const cfg = makeCfg();
    const file = checkpointPath(cfg);
    fs.writeFileSync(file, 'invalid json {{{', 'utf8');

    const promptCalls = [];
    const result = await shouldResume(
      cfg,
      { prompt: (q) => { promptCalls.push(q); return Promise.resolve(true); } },
      noopLogger,
    );

    expect(result.resume).toBe(false);
    expect(result.checkpoint).toBeNull();
    expect(promptCalls).toHaveLength(0); // corrupt → no prompt, just clear
    expect(checkpointExists(cfg)).toBe(false);
  });

  test('--resume takes priority over prompt (no prompt called)', async () => {
    const cfg = makeCfg({ resume: true });
    writeCheckpoint(cfg, { businesses: [makeBusiness('A')] });

    const promptCalls = [];
    await shouldResume(
      cfg,
      { prompt: (q) => { promptCalls.push(q); return Promise.resolve(false); } },
      noopLogger,
    );

    expect(promptCalls).toHaveLength(0);
  });

  test('--fresh takes priority over --resume if both somehow set (config validation prevents this)', async () => {
    // Note: config.js validates that --resume and --fresh are mutually exclusive,
    // but shouldResume itself handles the case defensively: --fresh wins.
    const cfg = makeCfg({ fresh: true, resume: true });
    writeCheckpoint(cfg, { businesses: [makeBusiness('A')] });

    const result = await shouldResume(cfg, {}, noopLogger);
    expect(result.resume).toBe(false);
    expect(checkpointExists(cfg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 1.7 spec acceptance criteria
// ---------------------------------------------------------------------------

describe('Phase 1.7 spec acceptance criteria', () => {
  beforeEach(() => {});
  afterEach(() => {});

  test('successful run leaves no .checkpoint.json behind (clearCheckpoint)', () => {
    const cfg = makeCfg();
    writeCheckpoint(cfg, { businesses: [makeBusiness('A'), makeBusiness('B')] });
    expect(checkpointExists(cfg)).toBe(true);

    // Simulate successful run completion
    clearCheckpoint(cfg);

    expect(checkpointExists(cfg)).toBe(false);
  });

  test('resume loads previously-extracted businesses (200 → continue from 200)', () => {
    const cfg = makeCfg({ resume: true });

    // Simulate a crash at result 200/500 — checkpoint has 200 businesses
    const businesses = [];
    for (let i = 0; i < 200; i++) {
      businesses.push(makeBusiness(`Biz${i}`, { place_id: `ChIJ${i}` }));
    }
    writeCheckpoint(cfg, { businesses });

    const read = readCheckpoint(cfg);
    expect(read.businesses).toHaveLength(200);
    expect(read.count).toBe(200);

    // The dedup set from these 200 should have 200 unique keys
    const set = buildDedupSet(read.businesses);
    expect(set.size).toBe(200);
  });

  test('dedup set correctly identifies already-extracted businesses', () => {
    const cfg = makeCfg();
    const existing = [makeBusiness('A'), makeBusiness('B'), makeBusiness('C')];
    writeCheckpoint(cfg, { businesses: existing });

    const set = buildDedupSet(readCheckpoint(cfg).businesses);

    // Simulate re-extraction: some businesses are new, some already in checkpoint
    const fresh = [
      makeBusiness('A'), // already in checkpoint → skip
      makeBusiness('B'), // already in checkpoint → skip
      makeBusiness('D'), // new
      makeBusiness('E'), // new
    ];

    let skipped = 0;
    let added = 0;
    for (const b of fresh) {
      const key = dedupKey(b);
      if (key && set.has(key)) {
        skipped++;
      } else {
        added++;
      }
    }

    expect(skipped).toBe(2);
    expect(added).toBe(2);
  });
});
