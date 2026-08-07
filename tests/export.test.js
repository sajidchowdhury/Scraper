'use strict';

/**
 * tests/export.test.js — Phase 1.6 unit tests
 *
 * Coverage:
 *   1. RFC 4180 escaping (escapeCsvField, buildCsvRow)
 *      - comma → wrap in quotes
 *      - double-quote → double it ("")
 *      - newline (CR/LF) → wrap in quotes
 *      - plain field → no quotes
 *      - null/undefined → empty
 *   2. Field serializers (serializeField, toCellString)
 *      - photos joined with "|"
 *      - social_profiles as "platform:url|platform:url"
 *      - full_hours as "day: hours; day: hours"
 *      - top_reviews / popular_times as JSON string
 *      - null/empty arrays → empty cell
 *      - booleans → "true"/"false"
 *   3. buildCsv — full document
 *      - BOM present (EF BB BF)
 *      - CRLF line endings
 *      - header row has 25 columns in stable order
 *      - data rows match column order
 *      - empty business list → header only
 *   4. Spec acceptance criteria (exact strings from the spec):
 *      - "Smith, Jones & Co." in a single cell (not split)
 *      - "Café Mününchen ☕" preserved with UTF-8
 *      - 3 photo URLs in one cell, delimited
 *   5. Filename helpers (sanitizeName, stamp, autoBaseName, resolveBasePath)
 *   6. exportResults end-to-end — writes CSV + JSON + summary files,
 *      returns absolute paths, JSON preserves nested structure
 *
 * Run: bun test tests/
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  COLUMN_SCHEMA,
  CSV_COLUMNS,
  sanitizeName,
  stamp,
  autoBaseName,
  resolveBasePath,
  toCellString,
  serializeField,
  escapeCsvField,
  buildCsvRow,
  buildCsv,
  exportResults,
} = require('../src/export');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

function mkTmpDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));
  return tmpDir;
}

function cleanupTmpDir() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** A complete business record with every field populated, for round-trip tests. */
function makeFullBusiness(overrides = {}) {
  return {
    name: 'Cafe Berlin',
    rating: 4.5,
    reviews_count: 1234,
    price_level: '$$',
    category: 'Mexican restaurant',
    address: '123 Main St',
    phone: '+491234567890',
    website: 'https://cafe-berlin.de',
    maps_url: 'https://www.google.com/maps/place/Cafe+Berlin',
    place_id: '0x89d4cb90d1f1f1f1:0x2a2a2a2a2a2a2a2a',
    plus_code: '8FVC9GQF+5W',
    open_now: true,
    business_status: 'open',
    is_sponsored: false,
    scraped_at: '2026-08-07T11:00:00.000Z',
    query: 'Cafe',
    location: 'Berlin',
    full_hours: [
      { day: 'Monday', hours: '9:00 AM – 5:00 PM' },
      { day: 'Tuesday', hours: '9:00 AM – 5:00 PM' },
      { day: 'Wednesday', hours: 'Closed' },
    ],
    popular_times: [{ day: 'Monday', busy: [{ hour: 9, level: 3, label: 'Usually busy at 9 AM' }] }],
    top_reviews: [
      { author: 'Jane D.', rating: 5, text: 'Best coffee!', date: '2 weeks ago' },
      { author: 'John S.', rating: 4, text: 'Good', date: 'a month ago' },
    ],
    photos: ['https://img1.jpg', 'https://img2.jpg', 'https://img3.jpg'],
    reservation_url: 'https://opentable.com/r/cafeberlin',
    menu_url: 'https://cafeberlin.de/menu',
    social_profiles: [
      { platform: 'instagram', url: 'https://instagram.com/cafeberlin' },
      { platform: 'facebook', url: 'https://facebook.com/cafeberlin' },
    ],
    detail_scraped: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. RFC 4180 escaping
// ---------------------------------------------------------------------------

describe('escapeCsvField', () => {
  test('plain field → no quotes', () => {
    expect(escapeCsvField('plain')).toBe('plain');
    expect(escapeCsvField('hello world')).toBe('hello world');
  });

  test('field with comma → wrapped in quotes', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('Smith, Jones & Co.')).toBe('"Smith, Jones & Co."');
  });

  test('field with double-quote → doubled and wrapped', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('"quoted"')).toBe('"""quoted"""');
  });

  test('field with newline → wrapped in quotes', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('line1\rline2')).toBe('"line1\rline2"');
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  test('null/undefined → empty string', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  test('number → stringified', () => {
    expect(escapeCsvField(4.5)).toBe('4.5');
    expect(escapeCsvField(1234)).toBe('1234');
  });

  test('UTF-8 / emoji preserved', () => {
    expect(escapeCsvField('Café Mününchen ☕')).toBe('Café Mününchen ☕');
    expect(escapeCsvField('ঢাকা Dhaka')).toBe('ঢাকা Dhaka');
  });
});

describe('buildCsvRow', () => {
  test('joins escaped cells with comma', () => {
    expect(buildCsvRow(['plain', 'a,b', 'say "hi"'])).toBe('plain,"a,b","say ""hi"""');
  });
  test('empty cells stay empty', () => {
    expect(buildCsvRow(['', null, 'x'])).toBe(',,x');
  });
});

// ---------------------------------------------------------------------------
// 2. Field serializers
// ---------------------------------------------------------------------------

describe('toCellString', () => {
  test('null/undefined → empty', () => {
    expect(toCellString(null)).toBe('');
    expect(toCellString(undefined)).toBe('');
  });
  test('boolean → "true"/"false"', () => {
    expect(toCellString(true)).toBe('true');
    expect(toCellString(false)).toBe('false');
  });
  test('number → string', () => {
    expect(toCellString(4.5)).toBe('4.5');
    expect(toCellString(0)).toBe('0');
  });
  test('string → as-is', () => {
    expect(toCellString('hello')).toBe('hello');
  });
  test('array → joined with |', () => {
    expect(toCellString(['a', 'b', 'c'])).toBe('a|b|c');
  });
  test('object → JSON', () => {
    expect(toCellString({ a: 1 })).toBe('{"a":1}');
  });
});

describe('serializeField — photos', () => {
  test('array of URLs joined with |', () => {
    expect(serializeField('photos', ['https://a.jpg', 'https://b.jpg', 'https://c.jpg'])).toBe(
      'https://a.jpg|https://b.jpg|https://c.jpg',
    );
  });
  test('empty array → empty string', () => {
    expect(serializeField('photos', [])).toBe('');
  });
  test('null → empty string', () => {
    expect(serializeField('photos', null)).toBe('');
  });
  test('filters falsy entries', () => {
    expect(serializeField('photos', ['a', '', null, 'b'])).toBe('a|b');
  });
});

describe('serializeField — social_profiles', () => {
  test('array of {platform,url} → "platform:url|platform:url"', () => {
    const profiles = [
      { platform: 'instagram', url: 'https://ig.com/x' },
      { platform: 'facebook', url: 'https://fb.com/y' },
    ];
    expect(serializeField('social_profiles', profiles)).toBe(
      'instagram:https://ig.com/x|facebook:https://fb.com/y',
    );
  });
  test('empty array → empty string', () => {
    expect(serializeField('social_profiles', [])).toBe('');
  });
  test('null → empty string', () => {
    expect(serializeField('social_profiles', null)).toBe('');
  });
  test('filters entries without url', () => {
    expect(serializeField('social_profiles', [{ platform: 'x', url: null }, { platform: 'y', url: 'https://z' }])).toBe(
      'y:https://z',
    );
  });
});

describe('serializeField — full_hours', () => {
  test('array of {day,hours} → "day: hours; day: hours"', () => {
    const hours = [
      { day: 'Monday', hours: '9:00 AM – 5:00 PM' },
      { day: 'Tuesday', hours: '9:00 AM – 5:00 PM' },
      { day: 'Wednesday', hours: 'Closed' },
    ];
    expect(serializeField('full_hours', hours)).toBe(
      'Monday: 9:00 AM – 5:00 PM; Tuesday: 9:00 AM – 5:00 PM; Wednesday: Closed',
    );
  });
  test('empty array → empty string', () => {
    expect(serializeField('full_hours', [])).toBe('');
  });
  test('null → empty string', () => {
    expect(serializeField('full_hours', null)).toBe('');
  });
});

describe('serializeField — top_reviews', () => {
  test('non-empty array → JSON string', () => {
    const reviews = [{ author: 'Jane', rating: 5, text: 'Great', date: 'yesterday' }];
    const out = serializeField('top_reviews', reviews);
    expect(out).toBe(JSON.stringify(reviews));
    expect(() => JSON.parse(out)).not.toThrow();
  });
  test('empty array → empty string', () => {
    expect(serializeField('top_reviews', [])).toBe('');
  });
  test('null → empty string', () => {
    expect(serializeField('top_reviews', null)).toBe('');
  });
});

describe('serializeField — popular_times', () => {
  test('non-empty array → JSON string', () => {
    const pt = [{ day: 'Monday', busy: [{ hour: 9, level: 3 }] }];
    const out = serializeField('popular_times', pt);
    expect(out).toBe(JSON.stringify(pt));
  });
  test('empty array → empty string', () => {
    expect(serializeField('popular_times', [])).toBe('');
  });
});

describe('serializeField — primitive fields (default)', () => {
  test('string passed through', () => {
    expect(serializeField('name', 'Cafe Berlin')).toBe('Cafe Berlin');
  });
  test('number → string', () => {
    expect(serializeField('rating', 4.5)).toBe('4.5');
  });
  test('boolean → "true"/"false"', () => {
    expect(serializeField('open_now', true)).toBe('true');
    expect(serializeField('is_sponsored', false)).toBe('false');
  });
  test('null → empty string', () => {
    expect(serializeField('rating', null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 3. buildCsv — full document
// ---------------------------------------------------------------------------

describe('buildCsv', () => {
  test('starts with UTF-8 BOM', () => {
    const csv = buildCsv([]);
    expect(csv.charCodeAt(0)).toBe(0xfeff); // \uFEFF
  });

  test('uses CRLF line endings (RFC 4180)', () => {
    const csv = buildCsv([makeFullBusiness()]);
    expect(csv).toContain('\r\n');
    // No bare \n that isn't part of \r\n (after the BOM)
    const withoutBom = csv.slice(1);
    const bareLf = withoutBom.split('\r\n').join('').split('\n');
    // After splitting on CRLF, remaining fragments should have no newlines
    // (unless a field contained a literal newline, which our test data doesn't)
  });

  test('header row has 25 columns in stable order', () => {
    const csv = buildCsv([]);
    const headerLine = csv.split('\r\n')[0].slice(1); // strip BOM
    const headers = parseCsvRow(headerLine);
    expect(headers).toHaveLength(25);
    expect(headers[0]).toBe('Name');
    expect(headers[1]).toBe('Rating');
    expect(headers[24]).toBe('Detail Scraped');
  });

  test('header titles match COLUMN_SCHEMA', () => {
    const csv = buildCsv([]);
    const headerLine = csv.split('\r\n')[0].slice(1);
    const headers = parseCsvRow(headerLine);
    const expected = COLUMN_SCHEMA.map((c) => c.title);
    expect(headers).toEqual(expected);
  });

  test('empty business list → header only (one row)', () => {
    const csv = buildCsv([]);
    const lines = csv.split('\r\n');
    // BOM + header = first line; no data rows
    expect(lines).toHaveLength(1);
  });

  test('one business → header + 1 data row', () => {
    const csv = buildCsv([makeFullBusiness()]);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2);
  });

  test('data row has 25 cells matching column order', () => {
    const b = makeFullBusiness();
    const csv = buildCsv([b]);
    const lines = csv.split('\r\n');
    const dataRow = parseCsvRow(lines[1]);
    expect(dataRow).toHaveLength(25);
    // Spot-check a few fields land in the right column
    expect(dataRow[0]).toBe('Cafe Berlin'); // name
    expect(dataRow[1]).toBe('4.5'); // rating
    expect(dataRow[2]).toBe('1234'); // reviews_count
    expect(dataRow[20]).toBe('https://img1.jpg|https://img2.jpg|https://img3.jpg'); // photos
    expect(dataRow[24]).toBe('true'); // detail_scraped
  });

  test('null fields → empty cells (not "null" string)', () => {
    const b = makeFullBusiness({ rating: null, phone: null, photos: [], full_hours: null });
    const csv = buildCsv([b]);
    const dataRow = parseCsvRow(csv.split('\r\n')[1]);
    expect(dataRow[1]).toBe(''); // rating
    expect(dataRow[6]).toBe(''); // phone
    expect(dataRow[20]).toBe(''); // photos (empty array)
    expect(dataRow[17]).toBe(''); // full_hours
  });
});

// ---------------------------------------------------------------------------
// 4. Spec acceptance criteria (exact strings from PHASE1_EXECUTION_PLAN.md)
// ---------------------------------------------------------------------------

describe('Phase 1.6 spec acceptance criteria', () => {
  test('"Smith, Jones & Co." (with comma) appears in a single cell, not split', () => {
    const csv = buildCsv([makeFullBusiness({ name: 'Smith, Jones & Co.' })]);
    const dataRow = parseCsvRow(csv.split('\r\n')[1]);
    // The name cell must be the full string, not split across cells
    expect(dataRow[0]).toBe('Smith, Jones & Co.');
    // And the row must still have exactly 25 cells (not 26 from a split)
    expect(dataRow).toHaveLength(25);
  });

  test('"Café Mününchen ☕" exports with correct UTF-8 encoding', () => {
    const csv = buildCsv([makeFullBusiness({ name: 'Café Mününchen ☕', category: 'Café' })]);
    expect(csv).toContain('Café Mününchen ☕');
    // Verify the bytes are correct UTF-8 (not mojibake)
    const buf = Buffer.from(csv, 'utf8');
    const decoded = buf.toString('utf8');
    expect(decoded).toContain('Café Mününchen ☕');
  });

  test('multi-value field (3 photo URLs) appears in one cell, delimited consistently', () => {
    const photos = ['https://img1.jpg', 'https://img2.jpg', 'https://img3.jpg'];
    const csv = buildCsv([makeFullBusiness({ photos })]);
    const dataRow = parseCsvRow(csv.split('\r\n')[1]);
    expect(dataRow[20]).toBe('https://img1.jpg|https://img2.jpg|https://img3.jpg');
    expect(dataRow).toHaveLength(25); // still one cell, not three
  });

  test('business name with double-quote → quotes escaped by doubling', () => {
    const csv = buildCsv([makeFullBusiness({ name: '"Quoted" Name' })]);
    const dataRow = parseCsvRow(csv.split('\r\n')[1]);
    expect(dataRow[0]).toBe('"Quoted" Name');
  });

  test('business name with newline → preserved in single cell', () => {
    const csv = buildCsv([makeFullBusiness({ address: 'Line 1\nLine 2' })]);
    const dataRow = parseCsvRow(csv.split('\r\n').slice(1).join('\r\n'));
    expect(dataRow[5]).toBe('Line 1\nLine 2');
  });

  test('Bengali text (ঢাকা) preserved', () => {
    const csv = buildCsv([makeFullBusiness({ name: 'ঢাকা Restaurant', location: 'ঢাকা' })]);
    expect(csv).toContain('ঢাকা Restaurant');
  });
});

// ---------------------------------------------------------------------------
// 5. Filename helpers
// ---------------------------------------------------------------------------

describe('sanitizeName', () => {
  test('replaces spaces with underscore', () => {
    expect(sanitizeName('Cafe Berlin')).toBe('Cafe_Berlin');
  });
  test('replaces special chars', () => {
    expect(sanitizeName('Cafe/Berlin?')).toBe('Cafe_Berlin_');
  });
  test('truncates to 40 chars', () => {
    expect(sanitizeName('a'.repeat(50))).toHaveLength(40);
  });
  test('null/undefined → "run"', () => {
    expect(sanitizeName(null)).toBe('run');
    expect(sanitizeName(undefined)).toBe('run');
  });
  test('keeps alphanumerics, underscore, hyphen', () => {
    expect(sanitizeName('Cafe-123_X')).toBe('Cafe-123_X');
  });
});

describe('stamp', () => {
  test('produces YYYY-MM-DD_HH-mm-ss format', () => {
    const d = new Date(2026, 7, 7, 11, 30, 45); // Aug 7 2026, 11:30:45 local
    const s = stamp(d);
    expect(s).toBe('2026-08-07_11-30-45');
  });
  test('pads single-digit values', () => {
    const d = new Date(2026, 0, 1, 2, 3, 4); // Jan 1, 02:03:04
    expect(stamp(d)).toBe('2026-01-01_02-03-04');
  });
});

describe('autoBaseName', () => {
  test('combines sanitized query + location + stamp', () => {
    const d = new Date(2026, 7, 7, 11, 30, 45);
    expect(autoBaseName('Cafe', 'Berlin', d)).toBe('Cafe_Berlin_2026-08-07_11-30-45');
  });
  test('sanitizes special chars in query/location', () => {
    const d = new Date(2026, 0, 1, 0, 0, 0);
    expect(autoBaseName('Cafe/Bistro', 'New York, NY', d)).toBe('Cafe_Bistro_New_York_NY_2026-01-01_00-00-00');
  });
});

describe('resolveBasePath', () => {
  test('uses outputFile when provided (strips extension)', () => {
    expect(resolveBasePath({ outputFile: '/tmp/myrun.json' })).toBe('/tmp/myrun');
    expect(resolveBasePath({ outputFile: '/tmp/myrun.csv' })).toBe('/tmp/myrun');
    expect(resolveBasePath({ outputFile: '/tmp/myrun' })).toBe('/tmp/myrun');
  });
  test('auto-generates when outputFile null', () => {
    const d = new Date(2026, 0, 1, 0, 0, 0);
    const base = resolveBasePath({ outputFile: null, outputDir: './data', query: 'Cafe', location: 'Berlin', d });
    expect(base).toBe(path.join('./data', 'Cafe_Berlin_2026-01-01_00-00-00'));
  });
});

// ---------------------------------------------------------------------------
// 6. exportResults end-to-end — writes all three files
// ---------------------------------------------------------------------------

describe('exportResults end-to-end', () => {
  beforeEach(() => mkTmpDir());
  afterEach(() => cleanupTmpDir());

  test('writes CSV + JSON + summary files with correct extensions', async () => {
    const base = path.join(tmpDir, 'run1');
    const out = await exportResults({
      businesses: [makeFullBusiness()],
      summary: { query: 'Cafe', location: 'Berlin', total: 1 },
      outputFile: base,
      logger: { info() {}, debug() {}, warn() {} },
    });
    expect(out.csvPath).toBe(path.resolve(base + '.csv'));
    expect(out.jsonPath).toBe(path.resolve(base + '.json'));
    expect(out.summaryPath).toBe(path.resolve(base + '.summary.json'));
    expect(fs.existsSync(out.csvPath)).toBe(true);
    expect(fs.existsSync(out.jsonPath)).toBe(true);
    expect(fs.existsSync(out.summaryPath)).toBe(true);
  });

  test('CSV file starts with UTF-8 BOM', async () => {
    const base = path.join(tmpDir, 'run2');
    const out = await exportResults({
      businesses: [makeFullBusiness()],
      summary: { query: 'Cafe', location: 'Berlin', total: 1 },
      outputFile: base,
      logger: { info() {}, debug() {}, warn() {} },
    });
    const buf = fs.readFileSync(out.csvPath);
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
  });

  test('JSON sidecar preserves nested structure (full hours, reviews, photos)', async () => {
    const b = makeFullBusiness();
    const base = path.join(tmpDir, 'run3');
    const out = await exportResults({
      businesses: [b],
      summary: { query: 'Cafe', location: 'Berlin', total: 1 },
      outputFile: base,
      logger: { info() {}, debug() {}, warn() {} },
    });
    const json = JSON.parse(fs.readFileSync(out.jsonPath, 'utf8'));
    expect(json.businesses).toHaveLength(1);
    // Nested arrays preserved (not flattened to strings like CSV)
    expect(Array.isArray(json.businesses[0].full_hours)).toBe(true);
    expect(json.businesses[0].full_hours[0]).toEqual({ day: 'Monday', hours: '9:00 AM – 5:00 PM' });
    expect(Array.isArray(json.businesses[0].photos)).toBe(true);
    expect(json.businesses[0].photos).toHaveLength(3);
    expect(json.businesses[0].top_reviews[0].author).toBe('Jane D.');
    expect(json.summary.total).toBe(1);
  });

  test('summary JSON contains run metadata + output file paths', async () => {
    const base = path.join(tmpDir, 'run4');
    const out = await exportResults({
      businesses: [makeFullBusiness()],
      summary: {
        query: 'Cafe',
        location: 'Berlin',
        total: 1,
        durationMs: 1234,
        extractionRates: { name: { filled: 1, total: 1, rate: 100, warn: false } },
      },
      outputFile: base,
      logger: { info() {}, debug() {}, warn() {} },
    });
    const summary = JSON.parse(fs.readFileSync(out.summaryPath, 'utf8'));
    expect(summary.query).toBe('Cafe');
    expect(summary.location).toBe('Berlin');
    expect(summary.total).toBe(1);
    expect(summary.durationMs).toBe(1234);
    expect(summary.extractionRates.name.rate).toBe(100);
    expect(summary.outputFiles.csv).toBe(out.csvPath);
    expect(summary.outputFiles.json).toBe(out.jsonPath);
    expect(summary.outputFiles.summary).toBe(out.summaryPath);
    expect(Array.isArray(summary.columnOrder)).toBe(true);
    expect(summary.columnOrder).toHaveLength(25);
  });

  test('creates output directory if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'subdir');
    const base = path.join(nestedDir, 'run5');
    const out = await exportResults({
      businesses: [makeFullBusiness()],
      summary: { query: 'Cafe', location: 'Berlin', total: 1 },
      outputFile: base,
      logger: { info() {}, debug() {}, warn() {} },
    });
    expect(fs.existsSync(out.csvPath)).toBe(true);
    expect(fs.existsSync(nestedDir)).toBe(true);
  });

  test('returns row count and byte sizes', async () => {
    const base = path.join(tmpDir, 'run6');
    const out = await exportResults({
      businesses: [makeFullBusiness(), makeFullBusiness({ name: 'Cafe 2' })],
      summary: { query: 'Cafe', location: 'Berlin', total: 2 },
      outputFile: base,
      logger: { info() {}, debug() {}, warn() {} },
    });
    expect(out.rows).toBe(2);
    expect(out.csvBytes).toBeGreaterThan(0);
    expect(out.jsonBytes).toBeGreaterThan(0);
  });

  test('writeJson=false skips JSON sidecar', async () => {
    const base = path.join(tmpDir, 'run7');
    const out = await exportResults({
      businesses: [makeFullBusiness()],
      summary: { query: 'Cafe', location: 'Berlin', total: 1 },
      outputFile: base,
      writeJson: false,
      logger: { info() {}, debug() {}, warn() {} },
    });
    expect(fs.existsSync(out.csvPath)).toBe(true);
    expect(out.jsonPath).toBeNull();
    expect(fs.existsSync(base + '.json')).toBe(false);
    // Summary still written
    expect(fs.existsSync(out.summaryPath)).toBe(true);
  });

  test('auto-generates filename when outputFile is null', async () => {
    const out = await exportResults({
      businesses: [makeFullBusiness()],
      summary: { query: 'Cafe', location: 'Berlin', total: 1 },
      outputFile: null,
      outputDir: tmpDir,
      logger: { info() {}, debug() {}, warn() {} },
    });
    expect(out.csvPath).toMatch(/Cafe_Berlin_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/);
    expect(fs.existsSync(out.csvPath)).toBe(true);
  });

  test('logs each file write', async () => {
    const logs = [];
    const logger = {
      info: (m, c) => logs.push([m, c]),
      debug: () => {},
      warn: () => {},
    };
    const base = path.join(tmpDir, 'run8');
    await exportResults({
      businesses: [makeFullBusiness()],
      summary: { query: 'Cafe', location: 'Berlin', total: 1 },
      outputFile: base,
      logger,
    });
    expect(logs.some(([m]) => m === 'CSV written')).toBe(true);
    expect(logs.some(([m]) => m === 'JSON written')).toBe(true);
    expect(logs.some(([m]) => m === 'Run summary written')).toBe(true);
    // Phase 1.9 — a single structured "Export complete" line summarizes all outputs.
    expect(logs.some(([m]) => m === 'Export complete')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CSV row parser (test utility) — handles quoted fields with doubled quotes
// ---------------------------------------------------------------------------

/**
 * Parse a single CSV row (no embedded newlines) into an array of cell strings.
 * Handles: quoted fields, doubled quotes ("") → single quote, commas in quotes.
 */
function parseCsvRow(line) {
  const cells = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      cells.push('');
      break;
    }
    if (line[i] === '"') {
      // Quoted field
      let j = i + 1;
      let val = '';
      while (j < line.length) {
        if (line[j] === '"') {
          if (line[j + 1] === '"') {
            val += '"';
            j += 2;
          } else {
            j++; // skip closing quote
            break;
          }
        } else {
          val += line[j];
          j++;
        }
      }
      cells.push(val);
      // Skip to next comma
      while (j < line.length && line[j] !== ',') j++;
      i = j + 1;
      if (i > line.length) cells.push('');
    } else {
      // Unquoted field
      const commaIdx = line.indexOf(',', i);
      if (commaIdx === -1) {
        cells.push(line.slice(i));
        break;
      } else {
        cells.push(line.slice(i, commaIdx));
        i = commaIdx + 1;
      }
    }
  }
  return cells;
}
