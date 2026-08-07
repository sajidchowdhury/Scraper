'use strict';

/**
 * src/export.js — Phase 1.6 — CSV / JSON Export Engine
 *
 * Writes three files per run, all sharing a common base name:
 *   {base}.csv           — UTF-8-with-BOM CSV, RFC 4180 escaping, stable
 *                          column order (CANONICAL_FIELDS + DETAIL_FIELDS).
 *                          Excel/Sheets/Numbers-safe.
 *   {base}.json          — Full nested data (businesses + summary), preserves
 *                          arrays/objects that CSV flattens.
 *   {base}.summary.json  — Run metadata only (query, location, totals,
 *                          extraction rates, deep-scrape stats, timing, paths).
 *
 * Design rules (per Phase 1.6 spec):
 *   - Stable column order: CANONICAL_FIELDS (17) + DETAIL_FIELDS (8) = 25 cols
 *   - RFC 4180 escaping:
 *       field has comma     → wrap in double quotes
 *       field has double-quote → escape by doubling ("")
 *       field has newline   → wrap in double quotes
 *   - Multi-value serialization (documented delimiters):
 *       photos             → join URLs with "|"            e.g. "url1|url2|url3"
 *       social_profiles    → join "platform:url" with "|"  e.g. "instagram:x|facebook:y"
 *       full_hours         → join "day: hours" with "; "   e.g. "Monday: 9-5; Tuesday: 9-5"
 *       popular_times      → JSON string (too nested for delimited)
 *       top_reviews        → JSON string (too nested for delimited)
 *   - UTF-8 with BOM (\uFEFF) so Excel opens non-Latin (Bengali, Arabic, emoji)
 *     without garbling.
 *   - Auto-generated filename: data/{query}_{location}_{YYYY-MM-DD_HH-mm-ss}.{ext}
 *     — query/location sanitized for filesystem safety.
 *   - Absolute output paths printed at end of run.
 *
 * Hand-rolled (no csv-writer dep) to match the project's no-deps philosophy
 * (see src/config.js, src/logger.js) and to give full control over BOM,
 * nested-field serialization, and encoding.
 */

const fs = require('fs');
const path = require('path');

const { CANONICAL_FIELDS } = require('./extract');
const { DETAIL_FIELDS } = require('./detail');

// ---------------------------------------------------------------------------
// Column schema — stable order for CSV header row.
// Each entry: { id: <fieldName>, title: <humanReadableHeader> }
// ---------------------------------------------------------------------------

const COLUMN_SCHEMA = [
  // Phase 1.4 — canonical list-view fields
  { id: 'name', title: 'Name' },
  { id: 'rating', title: 'Rating' },
  { id: 'reviews_count', title: 'Reviews Count' },
  { id: 'price_level', title: 'Price Level' },
  { id: 'category', title: 'Category' },
  { id: 'address', title: 'Address' },
  { id: 'phone', title: 'Phone' },
  { id: 'website', title: 'Website' },
  { id: 'maps_url', title: 'Maps URL' },
  { id: 'place_id', title: 'Place ID' },
  { id: 'plus_code', title: 'Plus Code' },
  { id: 'open_now', title: 'Open Now' },
  { id: 'business_status', title: 'Business Status' },
  { id: 'is_sponsored', title: 'Sponsored' },
  { id: 'scraped_at', title: 'Scraped At' },
  { id: 'query', title: 'Query' },
  { id: 'location', title: 'Location' },
  // Phase 1.5 — detail-page deep-scrape fields
  { id: 'full_hours', title: 'Full Hours' },
  { id: 'popular_times', title: 'Popular Times' },
  { id: 'top_reviews', title: 'Top Reviews' },
  { id: 'photos', title: 'Photos' },
  { id: 'reservation_url', title: 'Reservation URL' },
  { id: 'menu_url', title: 'Menu URL' },
  { id: 'social_profiles', title: 'Social Profiles' },
  { id: 'detail_scraped', title: 'Detail Scraped' },
];

const CSV_COLUMNS = COLUMN_SCHEMA.map((c) => c.id);

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for use in a filename: replace anything that's not
 * alphanumeric, underscore, or hyphen with a single underscore, then truncate.
 */
function sanitizeName(s) {
  return String(s || 'run').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
}

/**
 * Build a timestamp string: YYYY-MM-DD_HH-mm-ss (filesystem-safe, sortable).
 */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * Build the auto-generated base name: {query}_{location}_{timestamp}
 * (no extension).
 */
function autoBaseName(query, location, d = new Date()) {
  return `${sanitizeName(query)}_${sanitizeName(location)}_${stamp(d)}`;
}

/**
 * Given a user-supplied outputFile (may have any/no extension), derive the
 * base path (extension stripped). If null, auto-generate.
 */
function resolveBasePath({ outputFile, outputDir, query, location, d = new Date() }) {
  if (outputFile) {
    // Strip extension, keep directory
    const ext = path.extname(outputFile);
    return outputFile.slice(0, -ext.length || undefined);
  }
  return path.join(outputDir || './data', autoBaseName(query, location, d));
}

// ---------------------------------------------------------------------------
// Field serializers — flatten nested structures to CSV-cell strings
// ---------------------------------------------------------------------------

/**
 * Serialize a value to a CSV cell string.
 *   null/undefined  → '' (empty cell)
 *   boolean         → 'true' / 'false'
 *   number          → String(number)
 *   string          → as-is (escaping happens in escapeCsvField)
 *   array           → depends on field (see serializeField below)
 *   object          → JSON.stringify
 */
function toCellString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join('|'); // default for arrays
  return JSON.stringify(value); // objects
}

/**
 * Field-specific serialization for nested detail fields.
 * Delimiters are documented per-field (see module header).
 */
function serializeField(fieldId, value) {
  if (value === null || value === undefined) return '';

  switch (fieldId) {
    case 'photos':
      // Array of URL strings → "url1|url2|url3"
      return Array.isArray(value) ? value.filter(Boolean).join('|') : String(value);

    case 'social_profiles':
      // Array of {platform, url} → "instagram:url1|facebook:url2"
      if (!Array.isArray(value)) return String(value);
      return value
        .filter((p) => p && p.url)
        .map((p) => `${p.platform || 'other'}:${p.url}`)
        .join('|');

    case 'full_hours':
      // Array of {day, hours} → "Monday: 9-5; Tuesday: 9-5; Wednesday: Closed"
      if (!Array.isArray(value)) return String(value);
      return value
        .filter((h) => h && h.day)
        .map((h) => `${h.day}: ${h.hours || ''}`.trim())
        .join('; ');

    case 'top_reviews':
      // Array of {author, rating, text, date} → JSON string
      // (too structured for a delimited cell; JSON preserves full data)
      return Array.isArray(value) && value.length > 0 ? JSON.stringify(value) : '';

    case 'popular_times':
      // Array of {day, busy:[{hour, level, label}]} → JSON string
      return Array.isArray(value) && value.length > 0 ? JSON.stringify(value) : '';

    default:
      // All canonical list-view fields are primitives (string/number/bool/null)
      return toCellString(value);
  }
}

// ---------------------------------------------------------------------------
// RFC 4180 CSV escaping
// ---------------------------------------------------------------------------

/**
 * Escape a single field value per RFC 4180:
 *   - If the field contains a comma, double-quote, OR newline (CR/LF),
 *     wrap the entire field in double quotes.
 *   - Any double-quote inside the field is escaped by doubling it ("").
 *
 * Reference: https://tools.ietf.org/html/rfc4180#section-2
 */
function escapeCsvField(s) {
  if (s === null || s === undefined) return '';
  const str = String(s);
  // Fields needing quoting: contain comma, double-quote, CR, or LF
  if (/[",\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Build a single CSV row from an array of pre-serialized cell strings.
 */
function buildCsvRow(cells) {
  return cells.map(escapeCsvField).join(',');
}

/**
 * Build the full CSV document string (BOM + header + rows).
 * @param {Array<object>} businesses
 * @param {object} [opts] — { includeBom: true (default) }
 * @returns {string}
 */
function buildCsv(businesses, opts = {}) {
  const includeBom = opts.includeBom !== false;
  const lines = [];

  // Header row — stable column order from COLUMN_SCHEMA
  lines.push(buildCsvRow(COLUMN_SCHEMA.map((c) => c.title)));

  // Data rows — one per business, fields serialized + escaped
  for (const b of businesses) {
    const cells = CSV_COLUMNS.map((fieldId) => serializeField(fieldId, b ? b[fieldId] : null));
    lines.push(buildCsvRow(cells));
  }

  const body = lines.join('\r\n'); // RFC 4180 uses CRLF line endings
  return includeBom ? '\uFEFF' + body : body;
}

// ---------------------------------------------------------------------------
// Main entry: exportResults
// ---------------------------------------------------------------------------

/**
 * Export business records to CSV + JSON sidecar + run summary.
 *
 * @param {object} params
 * @param {Array} params.businesses        - extracted records (with detail fields merged)
 * @param {object} params.summary          - run metadata (query, location, totals, rates, etc.)
 * @param {string} [params.outputFile]     - explicit output path (base; ext stripped)
 * @param {string} [params.outputDir]      - output directory (default ./data)
 * @param {boolean} [params.writeJson]     - write JSON sidecar (default true)
 * @param {boolean} [params.writeSummary]  - write summary JSON (default true)
 * @param {object} [params.logger]
 * @returns {Promise<{ csvPath, jsonPath, summaryPath, csvBytes, jsonBytes, rows }>}
 */
async function exportResults({
  businesses,
  summary,
  outputFile = null,
  outputDir = './data',
  writeJson = true,
  writeSummary = true,
  logger = { info() {}, debug() {}, warn() {} },
}) {
  const basePath = resolveBasePath({
    outputFile,
    outputDir,
    query: summary && summary.query,
    location: summary && summary.location,
  });
  const dir = path.dirname(path.resolve(basePath));
  fs.mkdirSync(dir, { recursive: true });

  const csvPath = basePath + '.csv';
  const jsonPath = basePath + '.json';
  const summaryPath = basePath + '.summary.json';

  // --- CSV (UTF-8 with BOM) ---
  const csvContent = buildCsv(businesses);
  fs.writeFileSync(csvPath, csvContent, 'utf8');
  const csvBytes = Buffer.byteLength(csvContent, 'utf8');
  logger.info('CSV written', {
    path: path.resolve(csvPath),
    rows: businesses.length,
    bytes: csvBytes,
  });

  // --- JSON sidecar (full nested data) ---
  let jsonBytes = 0;
  if (writeJson) {
    const jsonPayload = { summary, businesses };
    const jsonContent = JSON.stringify(jsonPayload, null, 2);
    fs.writeFileSync(jsonPath, jsonContent, 'utf8');
    jsonBytes = Buffer.byteLength(jsonContent, 'utf8');
    logger.info('JSON sidecar written', {
      path: path.resolve(jsonPath),
      rows: businesses.length,
      bytes: jsonBytes,
    });
  }

  // --- Run summary JSON (metadata only, no business rows) ---
  if (writeSummary) {
    const summaryPayload = {
      ...summary,
      outputFiles: {
        csv: path.resolve(csvPath),
        json: writeJson ? path.resolve(jsonPath) : null,
        summary: path.resolve(summaryPath),
      },
      columnOrder: CSV_COLUMNS,
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summaryPayload, null, 2), 'utf8');
    logger.info('Run summary written', { path: path.resolve(summaryPath) });
  }

  return {
    csvPath: path.resolve(csvPath),
    jsonPath: writeJson ? path.resolve(jsonPath) : null,
    summaryPath: path.resolve(summaryPath),
    csvBytes,
    jsonBytes,
    rows: businesses.length,
  };
}

// ---------------------------------------------------------------------------
// Legacy stub API (kept for backward compat — delegates to exportResults)
// ---------------------------------------------------------------------------

async function exportToCsv(businesses, options = {}) {
  return exportResults({
    businesses,
    summary: {
      query: options.query,
      location: options.location,
      total: businesses.length,
    },
    outputFile: options.outputFile,
    outputDir: options.outputDir,
    writeJson: options.writeJson !== false,
    writeSummary: options.writeSummary !== false,
    logger: options.logger,
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  COLUMN_SCHEMA,
  CSV_COLUMNS,
  // Filename helpers
  sanitizeName,
  stamp,
  autoBaseName,
  resolveBasePath,
  // Field serializers (exported for unit testing)
  toCellString,
  serializeField,
  // CSV escaping (exported for unit testing)
  escapeCsvField,
  buildCsvRow,
  buildCsv,
  // Main entry
  exportResults,
  exportToCsv, // legacy alias
};
