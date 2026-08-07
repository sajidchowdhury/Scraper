'use strict';

/**
 * src/checkpoint.js — Phase 1.7 — Crash-recovery checkpoint
 *
 * Writes the currently-extracted business data to a `.checkpoint.json` file
 * in the output dir every N results. On the next run, if the checkpoint
 * exists for the same query+location, the operator can resume: the already-
 * extracted businesses are loaded as the starting set, and businesses whose
 * place_id (or fallback key) already appears are skipped during re-extraction.
 *
 * Lifecycle:
 *   1. Startup: readCheckpoint() → null or { businesses, ... }
 *      - If cfg.fresh → clearCheckpoint() then return null.
 *      - If cfg.resume OR (checkpoint exists AND interactive prompt says yes)
 *        → return the checkpoint data (resume path).
 *      - Else → clearCheckpoint() and return null (start fresh).
 *   2. During extraction/deep-scrape: writeCheckpoint() every N new records.
 *   3. On successful completion: clearCheckpoint() (no leftover file).
 *   4. On crash: the checkpoint stays on disk for the next --resume.
 *
 * Checkpoint file format (JSON):
 *   {
 *     "version": 1,
 *     "query": "Restaurant",
 *     "location": "Toronto",
 *     "businesses": [ ... ],        // extracted records so far
 *     "extractionRates": { ... },   // last-computed rates (best-effort)
 *     "scroll": { ... },            // last scroll result (best-effort)
 *     "updatedAt": "2026-08-07T...",
 *     "count": 200
 *   }
 *
 * Resume matching is by query + location (sanitized). If the operator changes
 * the query or location, the checkpoint for the OLD query won't match the new
 * one (different filename), so there's no cross-contamination.
 *
 * Dedup key: place_id if present, else a hash of name+address+phone. This is
 * how we tell "already extracted this one" from "new business" on resume.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHECKPOINT_VERSION = 1;

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for safe use in a filename (matches export.js sanitizeName
 * but kept local to avoid a cross-module dependency for one helper).
 */
function sanitizeName(s) {
  return String(s || 'run').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
}

/**
 * Compute the checkpoint file path for a given query+location+outputDir.
 * Format: {outputDir}/.checkpoint_{query}_{location}.json
 *
 * The leading dot keeps the file out of the way of glob-based file listings
 * and signals "ephemeral / not a deliverable".
 */
function checkpointPath({ outputDir = './data', query = '', location = '' } = {}) {
  const base = `${sanitizeName(query)}_${sanitizeName(location)}`;
  return path.join(outputDir, `.checkpoint_${base}.json`);
}

// ---------------------------------------------------------------------------
// Dedup key
// ---------------------------------------------------------------------------

/**
 * Build a stable dedup key for a business record. Prefers place_id; falls
 * back to a hash of name+address+phone (the most stable combination in the
 * list view). Returns null only if the record is essentially empty.
 */
function dedupKey(business) {
  if (!business) return null;
  if (business.place_id) return `pid:${business.place_id}`;
  const name = business.name || '';
  const address = business.address || '';
  const phone = business.phone || '';
  const mapsUrl = business.maps_url || '';
  if (!name && !address && !phone && !mapsUrl) return null;
  const raw = `${name}|${address}|${phone}|${mapsUrl}`;
  return `h:${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)}`;
}

/**
 * Build a Set of dedup keys from a list of businesses (for fast O(1) lookup
 * during resume dedup).
 */
function buildDedupSet(businesses) {
  const set = new Set();
  for (const b of businesses || []) {
    const k = dedupKey(b);
    if (k) set.add(k);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Read / write / clear
// ---------------------------------------------------------------------------

/**
 * Read the checkpoint file for the given config. Returns null if the file
 * doesn't exist, can't be parsed, or belongs to a different query/location
 * (defensive — filename already encodes these, but we double-check inside).
 */
function readCheckpoint(cfg) {
  const file = checkpointPath(cfg);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    // Corrupt checkpoint — treat as no checkpoint. Caller should clear it.
    return { corrupt: true, path: file, error: err.message };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { corrupt: true, path: file, error: 'not an object' };
  }
  // Defensive: verify query/location match (filename already encodes them,
  // but a manually-copied file could mismatch).
  if (parsed.query !== cfg.query || parsed.location !== cfg.location) {
    return { mismatch: true, path: file, stored: { query: parsed.query, location: parsed.location } };
  }
  return parsed;
}

/**
 * Write the checkpoint file atomically (write to .tmp then rename). Includes
 * the current businesses array plus best-effort scroll/rates metadata.
 */
function writeCheckpoint(cfg, data) {
  const file = checkpointPath(cfg);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    version: CHECKPOINT_VERSION,
    query: cfg.query,
    location: cfg.location,
    businesses: data.businesses || [],
    extractionRates: data.extractionRates || null,
    scroll: data.scroll || null,
    detailStats: data.detailStats || null,
    updatedAt: new Date().toISOString(),
    count: (data.businesses || []).length,
  };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Delete the checkpoint file (if it exists). Idempotent — no error if the
 * file is already gone. Called on successful run completion, or when the
 * operator passes --fresh.
 */
function clearCheckpoint(cfg) {
  const file = checkpointPath(cfg);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch {
    // Best-effort — a leftover checkpoint is annoying but not fatal.
    return false;
  }
}

/**
 * Does a checkpoint exist for this config? (Quick check without parsing.)
 */
function checkpointExists(cfg) {
  return fs.existsSync(checkpointPath(cfg));
}

// ---------------------------------------------------------------------------
// Resume decision
// ---------------------------------------------------------------------------

/**
 * Default interactive prompt. Reads a single line from stdin, returns true
 * for "y"/"yes". Exported so tests can inject a mock.
 *
 * In non-TTY environments (piped stdin, CI) this returns false — we never
 * block waiting for input that will never come. The operator should use
 * --resume explicitly in those contexts.
 */
function defaultPrompt(question) {
  // eslint-disable-next-line no-console
  console.log(question);
  if (!process.stdin.isTTY) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => {
      process.stdin.pause();
      const answer = String(chunk).trim().toLowerCase();
      resolve(answer === 'y' || answer === 'yes');
    });
  });
}

/**
 * Decide whether to resume from a checkpoint, and load it if so.
 *
 * Decision matrix:
 *   - cfg.fresh === true      → clear any checkpoint, return null (fresh start)
 *   - cfg.resume === true     → load checkpoint (or null if none exists)
 *   - checkpoint doesn't exist → return null (nothing to resume from)
 *   - checkpoint exists, no flag, TTY → prompt the operator
 *   - checkpoint exists, no flag, non-TTY → don't resume, clear it
 *
 * @param {object} cfg
 * @param {object} [deps]        - { prompt } injectable for testing
 * @param {(q: string) => Promise<boolean>} [deps.prompt]
 * @param {object} [logger]
 * @returns {Promise<{ resume: boolean, checkpoint: object|null, skipped: number }>}
 *          `skipped` = number of businesses loaded from checkpoint (to be
 *          counted as "skipped (already in checkpoint)" in the run summary).
 */
async function shouldResume(cfg, deps = {}, logger = { info() {}, warn() {}, debug() {} }) {
  const prompt = deps.prompt || defaultPrompt;

  // --fresh: always start over
  if (cfg.fresh) {
    if (checkpointExists(cfg)) {
      logger.info('--fresh: deleting existing checkpoint');
      clearCheckpoint(cfg);
    }
    return { resume: false, checkpoint: null, skipped: 0 };
  }

  // No checkpoint present — nothing to resume from.
  if (!checkpointExists(cfg)) {
    return { resume: false, checkpoint: null, skipped: 0 };
  }

  const existing = readCheckpoint(cfg);

  // Corrupt / mismatched checkpoint — clear and start fresh.
  if (existing && (existing.corrupt || existing.mismatch)) {
    logger.warn('Checkpoint exists but is unreadable — clearing and starting fresh', existing);
    clearCheckpoint(cfg);
    return { resume: false, checkpoint: null, skipped: 0 };
  }

  // --resume: auto-load without prompting.
  if (cfg.resume) {
    logger.info('--resume: loading checkpoint', { count: existing.count });
    return { resume: true, checkpoint: existing, skipped: existing.count };
  }

  // No flag + checkpoint exists: prompt (TTY) or clear (non-TTY).
  const question =
    `A checkpoint exists for "${cfg.query}" in "${cfg.location}" ` +
    `with ${existing.count} businesses already scraped.\n` +
    `Resume from checkpoint? [y/N] `;
  const yes = await prompt(question);
  if (yes) {
    logger.info('Resuming from checkpoint', { count: existing.count });
    return { resume: true, checkpoint: existing, skipped: existing.count };
  }
  logger.info('Not resuming — clearing checkpoint and starting fresh');
  clearCheckpoint(cfg);
  return { resume: false, checkpoint: null, skipped: 0 };
}

module.exports = {
  CHECKPOINT_VERSION,
  checkpointPath,
  dedupKey,
  buildDedupSet,
  readCheckpoint,
  writeCheckpoint,
  clearCheckpoint,
  checkpointExists,
  shouldResume,
  defaultPrompt,
  sanitizeName,
};
