'use strict';

/**
 * src/selectors/debug-dump.js — Phase 2.11
 *
 * When a field's extraction rate drops below a threshold (default 80%),
 * write the first 500 chars of each card's innerHTML to
 * data/selector-debug/{field}_{timestamp}.html. This gives the developer
 * a sample of the actual DOM that's failing the selector, so they can
 * craft a new selector without re-running the scrape.
 *
 * Dumping is OFF by default for fields that are above the threshold, and
 * can be disabled entirely with --selectorDebugDump off. The dump dir is
 * configurable via --selectorDebugDir (default: ./data/selector-debug).
 *
 * Pure helpers (shouldDumpForField, buildDumpPath) are exported for unit
 * testing. dumpSelectorDebug is the side-effectful entry point.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default rate below which a field triggers a debug dump. */
const DEFAULT_DUMP_THRESHOLD_PCT = 80;

/** Default output directory for debug dumps. */
const DEFAULT_DUMP_DIR = './data/selector-debug';

/** Max chars of card innerHTML to include per card in the dump. */
const CARD_SNIPPET_LIMIT = 500;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Should a field be dumped given its current extraction rate?
 *
 * @param {string} field
 * @param {number} rate — 0..100
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=true] — master switch (--selectorDebugDump)
 * @param {number} [opts.thresholdPct=80] — dump when rate < threshold
 * @returns {boolean}
 */
function shouldDumpForField(field, rate, opts = {}) {
  const enabled = opts.enabled !== false;
  if (!enabled) return false;
  const threshold = opts.thresholdPct ?? DEFAULT_DUMP_THRESHOLD_PCT;
  if (rate == null || !Number.isFinite(rate)) return false;
  return rate < threshold;
}

/**
 * Build the dump file path for a field at a given time.
 *
 * @param {string} field
 * @param {object} [opts]
 * @param {string} [opts.dir='./data/selector-debug']
 * @param {Date} [now=new Date()]
 * @returns {string} — absolute or relative path
 */
function buildDumpPath(field, opts = {}) {
  const dir = opts.dir || DEFAULT_DUMP_DIR;
  const now = opts.now || new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const safeField = String(field).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safeField}_${ts}.html`);
}

/**
 * Build the dump file contents (HTML with comments). Pure function —
 * exported for unit testing the format without touching the filesystem.
 *
 * @param {string} field
 * @param {Array<{ index?: number, snippet?: string }>} cards
 * @param {object} [opts]
 * @param {number} [opts.rate]
 * @param {Date} [opts.now]
 * @returns {string}
 */
function buildDumpContent(field, cards, opts = {}) {
  const now = opts.now || new Date();
  const rate = opts.rate;
  const lines = [];
  lines.push(`<!-- Selector debug dump for field: ${field} -->`);
  lines.push(`<!-- Generated: ${now.toISOString()} -->`);
  if (rate != null) lines.push(`<!-- Extraction rate: ${rate}% (below threshold) -->`);
  lines.push(`<!-- Cards: ${cards.length} -->`);
  lines.push('');
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i] || {};
    const idx = c.index != null ? c.index : i;
    const snippet = (c.snippet || '').slice(0, CARD_SNIPPET_LIMIT);
    lines.push(`<!-- --- Card ${idx} --- -->`);
    lines.push(snippet);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Side-effectful entry point
// ---------------------------------------------------------------------------

/**
 * Write a debug dump for a field. Returns the path written, or null if
 * nothing was written (no cards / dump disabled).
 *
 * @param {string} field
 * @param {Array<{ index?: number, snippet?: string }>} cards
 * @param {object} [opts]
 * @param {string} [opts.dir='./data/selector-debug']
 * @param {number} [opts.rate]
 * @param {Date} [opts.now]
 * @param {object} [opts.logger]
 * @returns {string|null}
 */
function dumpSelectorDebug(field, cards, opts = {}) {
  const logger = opts.logger || { info() {}, warn() {}, debug() {}, error() {} };
  if (!cards || cards.length === 0) return null;

  const dir = opts.dir || DEFAULT_DUMP_DIR;
  const filepath = buildDumpPath(field, { dir, now: opts.now });
  const content = buildDumpContent(field, cards, opts);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filepath, content, 'utf8');
    logger.info(`Selector debug dump written for ${field}`, {
      field,
      path: filepath,
      cards: cards.length,
      rate: opts.rate,
      hint: 'Inspect the dump to craft a new selector, then add it to src/extract.js SELECTORS.' +
        field,
    });
    return filepath;
  } catch (err) {
    logger.warn(`Selector debug dump failed for ${field}`, {
      field,
      error: err.message,
      path: filepath,
    });
    return null;
  }
}

module.exports = {
  DEFAULT_DUMP_THRESHOLD_PCT,
  DEFAULT_DUMP_DIR,
  CARD_SNIPPET_LIMIT,
  shouldDumpForField,
  buildDumpPath,
  buildDumpContent,
  dumpSelectorDebug,
};
