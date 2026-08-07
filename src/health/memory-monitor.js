'use strict';

/**
 * src/health/memory-monitor.js — Phase 2.10 — Memory Management
 *
 * Polls process.memoryUsage() on a fixed cadence and:
 *   - Logs a one-line memory snapshot periodically (default every 5 min).
 *   - Tracks the all-time high-water mark for heap + rss (with timestamp).
 *   - Fires an `onThreshold` callback the moment heapUsed crosses thresholdMb
 *     (default 1024 MB). The caller wires this to "restart the current browser
 *     context" so a single runaway context can't OOM the whole process.
 *
 * Everything is DI so unit tests never touch a real setInterval or
 * process.memoryUsage:
 *   - getMemory()      → injectable (default: process.memoryUsage.bind(process))
 *   - getWorkers()     → injectable (default: () => []) — for the log line's
 *                        "workers=N" count when a pool is in use.
 *   - clock()          → injectable (default: Date.now)
 *   - setIntervalFn    → injectable (default: global.setInterval) — tests use
 *                        a fake that fires synchronously.
 *   - clearIntervalFn  → injectable (default: global.clearInterval).
 *
 * The monitor is a "soft" alarm: it never throws and never kills anything.
 * The onThreshold callback decides what to do (e.g. restart a context, pause
 * the queue). Re-arming happens automatically after each fire — the same
 * monitor can fire repeatedly across a long run, once per threshold crossing.
 *
 * Public API:
 *   const mon = startMemoryMonitor({
 *     intervalMs: 30_000,          // poll every 30s
 *     logEveryMs: 5 * 60 * 1000,   // log a snapshot every 5 min
 *     thresholdMb: 1024,           // fire onThreshold when heapUsed crosses this
 *     logger,
 *     onThreshold: (snap) => { ... },
 *     getMemory, getWorkers, clock, setIntervalFn, clearIntervalFn,
 *   });
 *   mon.snapshot();   // → { heapMb, rssMb, workers, ts, highWater }
 *   mon.getHighWater();  // → { heapMb, rssMb, heapAt, rssAt }
 *   mon.stop();       // clears the interval (idempotent)
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 30_000; // 30s — poll cadence
const DEFAULT_LOG_EVERY_MS = 5 * 60 * 1000; // 5 min — snapshot log cadence
const DEFAULT_THRESHOLD_MB = 1024; // 1 GB heap → trigger onThreshold

const MB = 1024 * 1024;

function defaultClock() {
  return Date.now();
}

function defaultGetMemory() {
  return process.memoryUsage();
}

function defaultGetWorkers() {
  return [];
}

function defaultSetInterval(fn, ms) {
  return global.setInterval(fn, ms);
}

function defaultClearInterval(handle) {
  return global.clearInterval(handle);
}

function makeStubLogger() {
  const noop = () => {};
  noop.debug = noop;
  noop.info = noop;
  noop.warn = noop;
  noop.error = noop;
  noop.phase = () => makeStubLogger();
  noop.child = () => makeStubLogger();
  return noop;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Build a memory snapshot from a process.memoryUsage() result.
 * Returns plain numbers (MB) so the snapshot is JSON-serializable for the
 * /health endpoint + logs.
 */
function buildSnapshot(mem, { workers, ts }) {
  return {
    heapUsedMb: Math.round((mem.heapUsed || 0) / MB),
    heapTotalMb: Math.round((mem.heapTotal || 0) / MB),
    rssMb: Math.round((mem.rss || 0) / MB),
    externalMb: Math.round((mem.external || 0) / MB),
    arrayBuffersMb: Math.round((mem.arrayBuffers || 0) / MB),
    workers: workers || 0,
    ts,
  };
}

/**
 * Format the periodic log line. The execution plan calls for:
 *   "Memory: heap=512MB rss=894MB workers=5"
 */
function formatMemoryLine(snap) {
  return `Memory: heap=${snap.heapUsedMb}MB rss=${snap.rssMb}MB workers=${snap.workers}`;
}

/**
 * Format the high-water mark line:
 *   "Memory high-water: heap=1024MB at 2026-08-07T03:14:22Z"
 */
function formatHighWaterLine(hw) {
  if (!hw) return null;
  const iso = new Date(hw.heapAt || hw.ts).toISOString();
  return `Memory high-water: heap=${hw.heapMb}MB rss=${hw.rssMb}MB at ${iso}`;
}

// ---------------------------------------------------------------------------
// startMemoryMonitor
// ---------------------------------------------------------------------------

/**
 * Start polling process.memoryUsage() every `intervalMs`.
 *
 * @param {object} opts
 * @param {number} [opts.intervalMs=30000]   — poll cadence (ms)
 * @param {number} [opts.logEveryMs=300000]  — snapshot log cadence (ms)
 * @param {number} [opts.thresholdMb=1024]   — onThreshold fires when heapUsed crosses this
 * @param {object} [opts.logger]
 * @param {(snap)=>void|Promise<void>} [opts.onThreshold] — fires once per threshold crossing
 * @param {()=>object} [opts.getMemory]      — DI (default process.memoryUsage)
 * @param {()=>Array|number} [opts.getWorkers] — DI (default () => [])
 * @param {()=>number} [opts.clock]          — DI (default Date.now)
 * @param {Function} [opts.setIntervalFn]    — DI (default global.setInterval)
 * @param {Function} [opts.clearIntervalFn]  — DI (default global.clearInterval)
 * @returns {object} monitor — { snapshot, getHighWater, stop, tick, pollCount }
 */
function startMemoryMonitor(opts = {}) {
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : DEFAULT_INTERVAL_MS;
  const logEveryMs = Number.isFinite(opts.logEveryMs) ? opts.logEveryMs : DEFAULT_LOG_EVERY_MS;
  const thresholdMb = Number.isFinite(opts.thresholdMb) ? opts.thresholdMb : DEFAULT_THRESHOLD_MB;
  const logger = opts.logger || makeStubLogger();
  const onThreshold = typeof opts.onThreshold === 'function' ? opts.onThreshold : null;
  const getMemory = typeof opts.getMemory === 'function' ? opts.getMemory : defaultGetMemory;
  const getWorkers = typeof opts.getWorkers === 'function' ? opts.getWorkers : defaultGetWorkers;
  const clock = typeof opts.clock === 'function' ? opts.clock : defaultClock;
  const setIntervalFn = typeof opts.setIntervalFn === 'function' ? opts.setIntervalFn : defaultSetInterval;
  const clearIntervalFn =
    typeof opts.clearIntervalFn === 'function' ? opts.clearIntervalFn : defaultClearInterval;

  if (intervalMs < 1) {
    throw new Error(`startMemoryMonitor: intervalMs must be >= 1 (got ${intervalMs})`);
  }
  if (thresholdMb < 1) {
    throw new Error(`startMemoryMonitor: thresholdMb must be >= 1 (got ${thresholdMb})`);
  }

  // Internal state
  let lastLogTs = 0;
  let lastSnapshot = null;
  let highWaterMark = null; // { heapMb, rssMb, heapAt, rssAt }
  let pollCount = 0;
  let armed = true; // false between a threshold crossing + the next drop below
  let handle = null;

  /**
   * Count "workers" from the getWorkers() result. Accepts a pool object with
   * .workers array, a bare array of workers, or a number.
   */
  function countWorkers() {
    try {
      const w = getWorkers();
      if (typeof w === 'number') return w;
      if (Array.isArray(w)) return w.length;
      if (w && Array.isArray(w.workers)) return w.workers.length;
      if (w && typeof w.activeSize === 'number') return w.activeSize;
      if (w && typeof w.size === 'number') return w.size;
      return 0;
    } catch {
      return 0;
    }
  }

  /**
   * One poll iteration. Reads memory, updates high-water, fires onThreshold,
   * emits the periodic log line. Exported as `tick()` for tests so they can
   * drive the monitor synchronously without a real timer.
   */
  async function tick() {
    pollCount++;
    const ts = clock();
    let mem;
    try {
      mem = getMemory();
    } catch (err) {
      logger.warn('Memory monitor: getMemory() failed (non-fatal)', { error: err.message });
      return null;
    }
    const workers = countWorkers();
    const snap = buildSnapshot(mem, { workers, ts });
    lastSnapshot = snap;

    // High-water mark — track the all-time peak for heap + rss independently.
    if (!highWaterMark || snap.heapUsedMb > highWaterMark.heapMb) {
      highWaterMark = {
        heapMb: snap.heapUsedMb,
        rssMb: snap.rssMb,
        heapAt: ts,
        rssAt: highWaterMark ? highWaterMark.rssAt : ts,
      };
      if (pollCount > 1) {
        // Don't log on the very first poll (it would always fire — the first
        // reading is by definition the high-water mark so far).
        logger.debug('Memory high-water mark updated', formatHighWaterLine(highWaterMark));
      }
    }
    if (!highWaterMark || snap.rssMb > highWaterMark.rssMb) {
      highWaterMark = {
        heapMb: highWaterMark ? highWaterMark.heapMb : snap.heapUsedMb,
        rssMb: snap.rssMb,
        heapAt: highWaterMark ? highWaterMark.heapAt : ts,
        rssAt: ts,
      };
    }

    // Threshold alarm — fire onThreshold once per crossing (re-arm when heap
    // drops back below the threshold so a follow-up crossing fires again).
    if (snap.heapUsedMb >= thresholdMb) {
      if (armed && onThreshold) {
        armed = false;
        logger.warn('Memory threshold exceeded — firing onThreshold', {
          heapMb: snap.heapUsedMb,
          thresholdMb,
          workers: snap.workers,
        });
        try {
          await onThreshold(snap);
        } catch (err) {
          logger.error('Memory monitor: onThreshold callback threw (non-fatal)', {
            error: err.message,
          });
        }
      }
    } else {
      armed = true;
    }

    // Periodic snapshot log. Fires on the first tick + every logEveryMs after.
    if (ts - lastLogTs >= logEveryMs || lastLogTs === 0) {
      logger.info(formatMemoryLine(snap));
      lastLogTs = ts;
    }

    return snap;
  }

  /** Read-only accessor for the latest snapshot (null before the first tick). */
  function snapshot() {
    return lastSnapshot;
  }

  /** Read-only accessor for the high-water mark. */
  function getHighWater() {
    return highWaterMark;
  }

  /** Stop polling. Idempotent — safe to call twice. */
  function stop() {
    if (handle !== null) {
      try {
        clearIntervalFn(handle);
      } catch {
        /* best-effort */
      }
      handle = null;
    }
  }

  // Start the interval. The first poll happens immediately so the operator
  // sees a baseline reading in the log without waiting `intervalMs`.
  // (Tests inject a no-op setIntervalFn and call tick() directly.)
  handle = setIntervalFn(() => {
    // Intentionally not awaited — the interval is fire-and-forget. Any error
    // inside tick() is caught + logged; it never propagates to the timer.
    Promise.resolve(tick()).catch(() => {});
  }, intervalMs);

  // Fire the first tick on the next tick of the event loop so the caller's
  // startMemoryMonitor() returns before we read memory (keeps construction
  // synchronous). Tests that inject a no-op setIntervalFn call tick() directly.
  Promise.resolve(tick()).catch(() => {});

  return {
    snapshot,
    getHighWater,
    highWater: getHighWater, // backward-compat alias
    tick,
    stop,
    get pollCount() {
      return pollCount;
    },
    get armed() {
      return armed;
    },
    // Exposed for tests / introspection
    _intervalMs: intervalMs,
    _thresholdMb: thresholdMb,
    _logEveryMs: logEveryMs,
  };
}

module.exports = {
  startMemoryMonitor,
  buildSnapshot,
  formatMemoryLine,
  formatHighWaterLine,
  DEFAULT_INTERVAL_MS,
  DEFAULT_LOG_EVERY_MS,
  DEFAULT_THRESHOLD_MB,
  MB,
  defaultClock,
  defaultGetMemory,
  defaultGetWorkers,
  makeStubLogger,
};
