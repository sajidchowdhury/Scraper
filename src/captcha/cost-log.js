'use strict';

/**
 * src/captcha/cost-log.js — Phase 2.6 — CAPTCHA cost tracking
 *
 * Appends one JSON-lines record per CAPTCHA solve attempt to
 * data/captcha_cost_log.jsonl. The end-of-run summary reads the log to report
 * total solves, total spend, and average solve time.
 *
 * Each record: { ts, provider, type, cost, solveTimeMs, success, url, error? }
 *
 * The logger is injectable (fs + nowFn) so tests never touch real disk time.
 *
 * Public API:
 *   const log = createCostLogger({ filePath, logger, fs: fsDep, nowFn });
 *   log.append({ provider, type, cost, solveTimeMs, success, url, error });
 *   const s = log.summary(); // { count, totalCost, avgMs, byProvider, successRate }
 *   log.flush(); // sync close (no-op for the default appender)
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_COST_LOG_PATH = path.join('data', 'captcha_cost_log.jsonl');

function defaultNow() {
  return new Date().toISOString();
}

/**
 * Create a cost logger that appends JSONL records to `filePath`.
 *
 * @param {object} opts
 * @param {string} [opts.filePath]   — default data/captcha_cost_log.jsonl
 * @param {object} [opts.logger]     — application logger (debug logs only)
 * @param {object} [opts.fs]         — injectable fs (default require('fs'))
 * @param {()=>string} [opts.nowFn]  — injectable timestamp (default ISO string)
 * @param {boolean} [opts.mkdirp]    — ensure the parent dir exists (default true)
 */
function createCostLogger(opts = {}) {
  const filePath = opts.filePath || DEFAULT_COST_LOG_PATH;
  const logger = opts.logger || null;
  const fsDep = opts.fs || fs;
  const nowFn = opts.nowFn || defaultNow;
  const mkdirp = opts.mkdirp !== false;

  // Ensure the parent directory exists so the first append doesn't throw.
  if (mkdirp) {
    try {
      const dir = path.dirname(filePath);
      if (dir && !fsDep.existsSync(dir)) {
        fsDep.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      if (logger) logger.warn('captcha cost-log mkdir failed (non-fatal)', { dir: path.dirname(filePath), error: err.message });
    }
  }

  // In-memory mirror so summary() works without re-reading the file (and so
  // tests with an in-memory fs still get a summary).
  const records = [];

  /**
   * Append a cost record. Never throws — a log write failure is non-fatal.
   * @param {object} rec { provider, type, cost, solveTimeMs, success, url, error? }
   */
  function append(rec) {
    const record = {
      ts: nowFn(),
      provider: rec.provider || null,
      type: rec.type || null,
      cost: Number(rec.cost) || 0,
      solveTimeMs: Number(rec.solveTimeMs) || 0,
      success: rec.success !== false,
      url: rec.url || null,
      error: rec.error || null,
    };
    records.push(record);
    try {
      fsDep.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      if (logger) logger.warn('captcha cost-log append failed (non-fatal)', { filePath, error: err.message });
    }
  }

  /**
   * Aggregate the in-memory records into a run summary.
   * Returns { count, totalCost, avgMs, successCount, successRate, byProvider }.
   */
  function summary() {
    const count = records.length;
    const successCount = records.filter((r) => r.success).length;
    const totalCost = Math.round(records.reduce((s, r) => s + r.cost, 0) * 1e6) / 1e6;
    const totalMs = records.reduce((s, r) => s + r.solveTimeMs, 0);
    const avgMs = count === 0 ? 0 : Math.round(totalMs / count);
    const byProvider = {};
    for (const r of records) {
      const k = r.provider || 'unknown';
      if (!byProvider[k]) byProvider[k] = { count: 0, totalCost: 0, totalMs: 0, successCount: 0 };
      byProvider[k].count++;
      byProvider[k].totalCost = Math.round((byProvider[k].totalCost + r.cost) * 1e6) / 1e6;
      byProvider[k].totalMs += r.solveTimeMs;
      if (r.success) byProvider[k].successCount++;
    }
    return {
      count,
      successCount,
      successRate: count === 0 ? 0 : Math.round((successCount / count) * 1000) / 10,
      totalCost,
      avgMs,
      byProvider,
    };
  }

  /** Read access to the in-memory records (for tests). */
  function getRecords() {
    return records.slice();
  }

  function flush() {
    // appendFileSync is synchronous — nothing to flush. Kept for API symmetry
    // with future stream-based implementations + the proxy burn log.
  }

  return {
    filePath,
    append,
    summary,
    getRecords,
    flush,
  };
}

module.exports = {
  createCostLogger,
  DEFAULT_COST_LOG_PATH,
  defaultNow,
};
