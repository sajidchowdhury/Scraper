'use strict';

/**
 * src/health/worker-probe.js — Phase 2.10 — Worker Health Probe
 *
 * Periodically inspects every worker in the pool and fires a corrective
 * callback when one is misbehaving. Three failure modes are detected:
 *
 *   1. HEAP BLOAT — a worker's per-worker heap exceeds maxHeapMb (default
 *      500 MB). Chrome leaks over long runs; a single bloated worker drags
 *      the whole process toward OOM. Corrective action: force-restart its
 *      browser context (the caller wires this).
 *
 *   2. STUCK — a worker hasn't completed a task in stuckAfterMs (default
 *      10 min) while NOT being idle. Idle is fine (waiting for work). Busy
 *      for 10 min is a hang — typically a page.goto that never resolves or
 *      a CAPTCHA that's silently waiting. Corrective action: kill the worker
 *      + re-queue its task to another worker.
 *
 *   3. UNRESPONSIVE — a worker's browser process is alive but the page is
 *      frozen (e.g. infinite loop in page JS). Detected by calling a probe
 *      function (default: page.evaluate(() => 1)) with a timeout. Three
 *      consecutive timeouts → declare unresponsive. Corrective action: kill
 *      + restart the worker.
 *
 * Each worker is inspected by calling its `stats()` (Phase 2.8 contract).
 * The probe accepts an injectable `getWorkers()` so tests pass mock workers.
 * The corrective callback is `onIssue(worker, issue)` where issue is one of
 * { type: 'heap', ... } | { type: 'stuck', ... } | { type: 'unresponsive', ... }.
 *
 * The probe is best-effort: it never throws, never kills anything directly.
 * The caller decides how to react. Re-arming is automatic — once a worker
 * is reported as an issue, it isn't reported again until the issue clears
 * (heap drops back below threshold, the worker completes a task, etc.).
 *
 * Public API:
 *   const probe = startWorkerProbe({
 *     getWorkers, maxHeapMb, stuckAfterMs, probeTimeoutMs, probeThreshold,
 *     intervalMs, logger, onIssue, clock, setIntervalFn, clearIntervalFn,
 *     probeFn,  // async (worker) => boolean — default: page.evaluate ping
 *   });
 *   probe.inspect();  // → array of per-worker inspection results (sync)
 *   probe.stop();
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_HEAP_MB = 500; // per-worker heap threshold
const DEFAULT_STUCK_AFTER_MS = 10 * 60 * 1000; // 10 min busy with no completion
const DEFAULT_PROBE_TIMEOUT_MS = 5_000; // page.evaluate ping timeout
const DEFAULT_PROBE_THRESHOLD = 3; // consecutive timeouts → unresponsive
const DEFAULT_INTERVAL_MS = 60_000; // probe cadence (60s)

function defaultClock() {
  return Date.now();
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

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Per-worker state (tracked across probes so we can count consecutive
// timeouts + suppress duplicate issue reports until the issue clears).
// ---------------------------------------------------------------------------

function createWorkerTracker(workerId) {
  return {
    workerId,
    // Consecutive probe timeouts (resets to 0 on a successful ping).
    consecutiveTimeouts: 0,
    // True once an issue has been reported; cleared when the issue resolves
    // so the same root cause doesn't fire onIssue every interval.
    heapReported: false,
    stuckReported: false,
    unresponsiveReported: false,
    // Last seen task-completion timestamp (ms). Used for stuck detection.
    lastCompletedAt: 0,
  };
}

// ---------------------------------------------------------------------------
// startWorkerProbe
// ---------------------------------------------------------------------------

/**
 * Start the worker probe.
 *
 * @param {object} opts
 * @param {()=>Array|{workers:Array}} opts.getWorkers — DI: returns the worker array (or a pool with .workers)
 * @param {number} [opts.maxHeapMb=500]              — per-worker heap threshold
 * @param {number} [opts.stuckAfterMs=600000]        — busy-but-no-completion threshold (10 min)
 * @param {number} [opts.probeTimeoutMs=5000]        — page.evaluate ping timeout
 * @param {number} [opts.probeThreshold=3]           — consecutive timeouts → unresponsive
 * @param {number} [opts.intervalMs=60000]           — probe cadence
 * @param {object} [opts.logger]
 * @param {(worker, issue)=>void|Promise<void>} [opts.onIssue] — corrective callback
 * @param {(worker)=>Promise<boolean>} [opts.probeFn] — DI: ping a worker's page (default: stub → true)
 * @param {()=>number} [opts.clock]                  — DI clock
 * @param {Function} [opts.setIntervalFn]
 * @param {Function} [opts.clearIntervalFn]
 * @returns {object} probe — { inspect, stop, probeCount, lastIssues }
 */
function startWorkerProbe(opts = {}) {
  if (typeof opts.getWorkers !== 'function') {
    throw new Error('startWorkerProbe requires opts.getWorkers (DI: () => worker array)');
  }
  const getWorkers = opts.getWorkers;
  const maxHeapMb = Number.isFinite(opts.maxHeapMb) ? opts.maxHeapMb : DEFAULT_MAX_HEAP_MB;
  const stuckAfterMs = Number.isFinite(opts.stuckAfterMs) ? opts.stuckAfterMs : DEFAULT_STUCK_AFTER_MS;
  const probeTimeoutMs = Number.isFinite(opts.probeTimeoutMs) ? opts.probeTimeoutMs : DEFAULT_PROBE_TIMEOUT_MS;
  const probeThreshold = Number.isFinite(opts.probeThreshold) ? opts.probeThreshold : DEFAULT_PROBE_THRESHOLD;
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : DEFAULT_INTERVAL_MS;
  const logger = opts.logger || makeStubLogger();
  const onIssue = typeof opts.onIssue === 'function' ? opts.onIssue : null;
  const clock = typeof opts.clock === 'function' ? opts.clock : defaultClock;
  const setIntervalFn = typeof opts.setIntervalFn === 'function' ? opts.setIntervalFn : defaultSetInterval;
  const clearIntervalFn =
    typeof opts.clearIntervalFn === 'function' ? opts.clearIntervalFn : defaultClearInterval;
  // Default probeFn: a no-op that resolves true. The production caller wires
  // this to (worker) => page.evaluate(() => 1) with a timeout wrapper. Tests
  // inject a controllable probeFn that can return false / throw / hang.
  const probeFn = typeof opts.probeFn === 'function' ? opts.probeFn : async () => true;

  // Map: workerId → tracker. Lazily populated on first inspect().
  const trackers = new Map();
  let probeCount = 0;
  let lastIssues = [];
  let handle = null;

  function getTracker(workerId) {
    let t = trackers.get(workerId);
    if (!t) {
      t = createWorkerTracker(workerId);
      trackers.set(workerId, t);
    }
    return t;
  }

  /**
   * Extract the worker array from the getWorkers() return value. Accepts:
   *   - a bare array of workers
   *   - a pool object with .workers
   *   - null/undefined → []
   */
  function resolveWorkers() {
    let w;
    try {
      w = getWorkers();
    } catch {
      return [];
    }
    if (Array.isArray(w)) return w;
    if (w && Array.isArray(w.workers)) return w.workers;
    return [];
  }

  /**
   * Build a serializable inspection result for one worker. Pure — does not
   * mutate tracker state.
   */
  function inspectWorker(worker, stats, now) {
    const lastTaskAge = stats.lastTaskAt ? now - stats.lastTaskAt : null;
    const lastCompletedAge = stats.lastCompletedAt ? now - stats.lastCompletedAt : null;
    return {
      workerId: worker.id,
      state: stats.state || 'unknown',
      retired: !!stats.retired,
      tasksAttempted: stats.tasksAttempted || 0,
      tasksCompleted: stats.tasksCompleted || 0,
      businessesScraped: stats.businessesScraped || 0,
      crashes: stats.crashes || 0,
      blocked: stats.blocked || 0,
      heapUsedMb: stats.heapUsedMb !== undefined
        ? stats.heapUsedMb
        : (stats.heapUsed !== undefined ? Math.round((stats.heapUsed / MB)) : null),
      lastTaskAgeMs: lastTaskAge,
      lastCompletedAgeMs: lastCompletedAge,
      consecutiveTimeouts: getTracker(worker.id).consecutiveTimeouts,
    };
  }

  /**
   * Run the page-evaluate probe against a worker with a timeout. Resolves
   * true (alive), false (timed out / errored). Never throws.
   */
  async function probeWorker(worker) {
    try {
      const result = await Promise.race([
        Promise.resolve(probeFn(worker)),
        new Promise((resolve) => setTimeout(() => resolve(false), probeTimeoutMs)),
      ]);
      return result === true;
    } catch {
      return false;
    }
  }

  /**
   * Inspect every worker, fire onIssue for any worker in a bad state, and
   * return the array of inspection results. Synchronous parts run first
   * (heap + stuck); the async probe (page.evaluate) runs after.
   */
  async function inspect() {
    probeCount++;
    const now = clock();
    const workers = resolveWorkers();
    const results = [];
    const issues = [];

    for (const worker of workers) {
      if (!worker) continue;
      let stats;
      try {
        stats = typeof worker.stats === 'function' ? worker.stats() : {};
      } catch {
        stats = {};
      }
      const insp = inspectWorker(worker, stats, now);
      results.push(insp);

      // Skip retired workers — they're already gone.
      if (insp.retired) continue;

      const tracker = getTracker(worker.id);

      // --- HEAP BLOAT ---------------------------------------------------
      // A worker's per-worker heap is reported via stats.heapUsedMb (the
      // production worker-probe runner sets this from process.memoryUsage
      // — workers themselves don't track memory because each worker is in
      // the same process; the probe samples it externally).
      if (insp.heapUsedMb !== null && insp.heapUsedMb >= maxHeapMb) {
        if (!tracker.heapReported) {
          tracker.heapReported = true;
          const issue = {
            type: 'heap',
            workerId: worker.id,
            heapUsedMb: insp.heapUsedMb,
            thresholdMb: maxHeapMb,
            at: now,
          };
          issues.push(issue);
          logger.warn('Worker heap exceeds threshold — recommending context restart', issue);
          if (onIssue) {
            try {
              await onIssue(worker, issue);
            } catch (err) {
              logger.error('Worker probe: onIssue(heap) threw (non-fatal)', { error: err.message });
            }
          }
        }
      } else {
        // Heap dropped back below threshold — re-arm so a future crossing
        // fires again.
        tracker.heapReported = false;
      }

      // --- STUCK --------------------------------------------------------
      // Busy for > stuckAfterMs with no task completion in that window. We
      // approximate "busy" by checking worker.state === 'busy' (Phase 2.8
      // contract). lastCompletedAgeMs is null when no task has ever completed.
      const isBusy = stats.state === 'busy';
      const idleFor = insp.lastCompletedAgeMs;
      if (isBusy && (idleFor === null || idleFor >= stuckAfterMs)) {
        if (!tracker.stuckReported) {
          tracker.stuckReported = true;
          const issue = {
            type: 'stuck',
            workerId: worker.id,
            busyForMs: idleFor,
            thresholdMs: stuckAfterMs,
            currentTaskId: stats.currentTaskId || null,
            currentTaskType: stats.currentTaskType || null,
            at: now,
          };
          issues.push(issue);
          logger.warn('Worker stuck — no task completion in threshold window', issue);
          if (onIssue) {
            try {
              await onIssue(worker, issue);
            } catch (err) {
              logger.error('Worker probe: onIssue(stuck) threw (non-fatal)', { error: err.message });
            }
          }
        }
      } else {
        tracker.stuckReported = false;
      }
    }

    // --- UNRESPONSIVE (page.evaluate probe) ----------------------------
    // Run the async probe against every NON-retired worker in parallel. A
    // timeout increments consecutiveTimeouts; reaching probeThreshold fires
    // the unresponsive issue. A success resets the counter.
    const activeWorkers = workers.filter((w) => {
      if (!w) return false;
      if (typeof w.isRetired !== 'function') return true; // assume not retired
      return !w.isRetired();
    });
    if (activeWorkers.length > 0) {
      const probeResults = await Promise.all(
        activeWorkers.map(async (w) => ({ worker: w, alive: await probeWorker(w) })),
      );
      for (const { worker, alive } of probeResults) {
        const tracker = getTracker(worker.id);
        if (alive) {
          tracker.consecutiveTimeouts = 0;
          tracker.unresponsiveReported = false;
          continue;
        }
        tracker.consecutiveTimeouts++;
        if (
          tracker.consecutiveTimeouts >= probeThreshold &&
          !tracker.unresponsiveReported
        ) {
          tracker.unresponsiveReported = true;
          const issue = {
            type: 'unresponsive',
            workerId: worker.id,
            consecutiveTimeouts: tracker.consecutiveTimeouts,
            threshold: probeThreshold,
            at: clock(),
          };
          issues.push(issue);
          logger.error('Worker browser unresponsive — recommending kill + restart', issue);
          if (onIssue) {
            try {
              await onIssue(worker, issue);
            } catch (err) {
              logger.error('Worker probe: onIssue(unresponsive) threw (non-fatal)', {
                error: err.message,
              });
            }
          }
        }
      }
    }

    lastIssues = issues;
    return { results, issues };
  }

  /** Stop the probe interval. Idempotent. */
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

  // Start the interval. Unlike the memory monitor, the worker probe does NOT
  // fire an immediate inspect() on construction — that would race with tests
  // (which call inspect() explicitly and count issues). The first interval
  // tick runs after `intervalMs` (60s default). Tests inject a no-op
  // setIntervalFn and call inspect() directly.
  handle = setIntervalFn(() => {
    Promise.resolve(inspect()).catch(() => {});
  }, intervalMs);

  return {
    inspect,
    stop,
    get probeCount() {
      return probeCount;
    },
    get lastIssues() {
      return lastIssues;
    },
    // Exposed for tests
    _maxHeapMb: maxHeapMb,
    _stuckAfterMs: stuckAfterMs,
    _probeThreshold: probeThreshold,
    _intervalMs: intervalMs,
    _trackers: trackers,
  };
}

module.exports = {
  startWorkerProbe,
  createWorkerTracker,
  DEFAULT_MAX_HEAP_MB,
  DEFAULT_STUCK_AFTER_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_PROBE_THRESHOLD,
  DEFAULT_INTERVAL_MS,
  defaultClock,
  makeStubLogger,
};
