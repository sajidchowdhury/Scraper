'use strict';

/**
 * src/logger.js — Phase 1.9 (Logging & Observability)
 *
 * Dual-sink structured logger. Every log line — console and file — carries a
 * standardized `phase` tag (search / scroll / extract / detail / export /
 * recovery / antiblock / retry / browser / system) so an operator can filter
 * the JSON-lines log file by pipeline stage after the fact.
 *
 * Sinks:
 *   - Console: colorized, human-readable, with a dim `[phase]` tag.
 *   - File: JSON lines at logs/{query}_{location}_{timestamp}.log. Each line:
 *       { "ts", "level", "phase", "msg", ...context }
 *     Writes are synchronous (fs.appendFileSync) so every line is on disk
 *     before the next operation begins — critical because the pipeline calls
 *     logger.close() immediately before process.exit(), and an async stream
 *     could lose the last few buffered lines on exit.
 *   - Memory: in-memory ring buffer (last 5000 records) for the run-summary
 *     writer and for unit tests (no temp files needed).
 *
 * Levels: debug < info < warn < error. Configurable via `--logLevel`.
 *
 * Phase binding:
 *   const log = logger.phase('extract');      // every call tags phase: 'extract'
 *   log.info('Business extracted', { index: 5, name: 'Foo' });
 *   // → file: { ts, level:'info', phase:'extract', msg:'Business extracted', index:5, name:'Foo' }
 *   // → console: [ts] INFO  [extract] Business extracted
 *
 *   A one-off `phase` key in the context object overrides the bound phase:
 *   log.info('cap event', { phase: 'antiblock' });   // tags 'antiblock' for this line only
 *
 * Backward compat: the legacy `child(extra)` API still works (merges context),
 * and plain `logger.info(msg, ctx)` calls default to phase 'system'.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = {
  debug: '\x1b[90m', // bright black / gray
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
  dim: '\x1b[2m',
};

const MEMORY_LIMIT = 5000;

/**
 * Canonical phase names. Used for validation in tests and as a reference list
 * in the README. A phase outside this set is still logged (best-effort), but
 * the list documents the contract.
 */
const PHASES = [
  'system',
  'browser',
  'search',
  'scroll',
  'extract',
  'detail',
  'export',
  'recovery',
  'antiblock',
  'retry',
];

function ts() {
  return new Date().toISOString();
}

function sanitizeName(s) {
  return String(s || 'run').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/**
 * Create a logger.
 *
 * @param {object} [opts]
 * @param {string} [opts.level='info']      - debug | info | warn | error
 * @param {string} [opts.query='run']       - used in the log filename
 * @param {string} [opts.location='loc']    - used in the log filename
 * @param {string} [opts.logDir='./logs']   - directory for the JSON-lines file
 * @param {string} [opts.phase='system']    - default phase for unbound calls
 * @param {boolean} [opts.silent=false]     - suppress console output (tests)
 * @param {boolean} [opts.file=true]        - write JSON-lines file (tests may disable)
 * @param {object} [opts.consoleOut]        - injectable console sink (tests)
 * @returns {Logger}
 */
function createLogger({
  level = 'info',
  query = 'run',
  location = 'loc',
  logDir = './logs',
  phase: defaultPhase = 'system',
  silent = false,
  file = true,
  consoleOut = null,
} = {}) {
  const minLevel = LEVELS[level] ?? LEVELS.info;
  const memoryBuffer = [];

  let filePath = null;
  if (file) {
    try {
      fs.mkdirSync(path.resolve(logDir), { recursive: true });
      filePath = path.join(logDir, `${sanitizeName(query)}_${sanitizeName(location)}_${stamp()}.log`);
    } catch {
      /* best-effort — filePath stays null, file logging silently disabled */
    }
  }

  const con = consoleOut || console;

  /**
   * Core log emitter. `boundPhase` is the phase inherited from a `.phase()`
   * call; an explicit `ctx.phase` overrides it for a single line.
   */
  function emit(levelName, msg, ctx, boundPhase) {
    if (LEVELS[levelName] < minLevel) return;
    const inheritedPhase = boundPhase || defaultPhase;
    // An explicit ctx.phase wins for this line only (doesn't mutate the bound logger).
    const phase = (ctx && ctx.phase) || inheritedPhase;
    // Strip phase out of the spread context so it isn't duplicated.
    const { phase: _ignoredPhase, ...rest } = ctx || {};

    const record = { ts: ts(), level: levelName, phase, msg, ...rest };

    // Console — colorized, with a dim [phase] tag for scannability.
    if (!silent) {
      const color = COLORS[levelName] || '';
      const phaseTag = `${COLORS.dim}[${phase}]${COLORS.reset}`;
      const line = `[${record.ts}] ${levelName.toUpperCase().padEnd(5)} ${phaseTag} ${msg}`;
      // eslint-disable-next-line no-console
      con.log(`${color}${line}${COLORS.reset}`);
    }

    // File — JSON lines (machine-parseable). Synchronous so every line is
    // flushed before the next operation (the pipeline calls close() then
    // process.exit() — an async stream could lose buffered lines on exit).
    if (filePath) {
      try {
        fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
      } catch {
        /* best-effort — file logging is non-fatal */
      }
    }

    // Memory ring buffer — for run-summary writer + tests.
    memoryBuffer.push(record);
    if (memoryBuffer.length > MEMORY_LIMIT) memoryBuffer.shift();
  }

  /**
   * Build a phase-bound view of the logger. Returns the same interface
   * (debug/info/warn/error + phase/child) so it can be passed anywhere a
   * logger is expected.
   */
  function phaseBound(p, mergedCtx) {
    const extra = mergedCtx || {};
    return {
      debug: (m, c) => emit('debug', m, { ...extra, ...c }, p),
      info: (m, c) => emit('info', m, { ...extra, ...c }, p),
      warn: (m, c) => emit('warn', m, { ...extra, ...c }, p),
      error: (m, c) => emit('error', m, { ...extra, ...c }, p),
      // Nesting: phase('extract').phase('detail') → 'detail'.
      // (Phases are flat tags, so nesting overrides rather than concatenates.)
      phase: (p2) => phaseBound(p2, extra),
      // child() merges context but keeps the current phase.
      child: (e2) => phaseBound(p, { ...extra, ...e2 }),
    };
  }

  return {
    debug: (m, c) => emit('debug', m, c, defaultPhase),
    info: (m, c) => emit('info', m, c, defaultPhase),
    warn: (m, c) => emit('warn', m, c, defaultPhase),
    error: (m, c) => emit('error', m, c, defaultPhase),
    /** Return a logger whose every line is tagged with `p`. */
    phase: (p) => phaseBound(p),
    /** Merge context into every subsequent line (legacy API). */
    child: (extra) => phaseBound(defaultPhase, extra),
    /** No-op now that file writes are synchronous. Kept for API compat. */
    close: () => {
      /* Synchronous writes flush immediately — nothing to close. */
    },
    /** Path of the JSON-lines log file (null if file logging is disabled). */
    getLogFile: () => filePath,
    /** Snapshot of the in-memory buffer (oldest → newest). */
    getMemory: () => memoryBuffer.slice(),
    /**
     * Filter the memory buffer. `pred` receives each record. Convenience for
     * tests and for the run-summary writer.
     */
    filter: (pred) => memoryBuffer.filter(pred),
    /** Current minimum log level (numeric). */
    get minLevel() {
      return minLevel;
    },
  };
}

module.exports = { createLogger, LEVELS, PHASES, COLORS };
