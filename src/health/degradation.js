'use strict';

/**
 * src/health/degradation.js — Phase 2.10 — Graceful Degradation Under Memory Pressure
 *
 * When the total process RSS exceeds --maxRssMb (default 4096 MB), the scraper
 * is heading for an OOM kill. This module orchestrates a graceful recovery:
 *
 *   1. Pause the queue (stop accepting new jobs).
 *   2. Wait for in-flight tasks to finish (with a deadline).
 *   3. Restart every worker's browser context (close + reopen).
 *   4. Optionally run global.gc() if Node was started with --expose-gc.
 *   5. Resume the queue.
 *   6. If RSS is STILL above threshold after restart → reduce pool size by 1
 *      worker (retire one) and log a warning. This sheds load until RSS drops.
 *
 * The whole flow is DI: pauseFn / resumeFn / restartWorkerFn / reducePoolFn
 * are injectable so unit tests pass mocks. The real wiring in src/index.js
 * passes:
 *   - pauseFn: () => queue.pause()
 *   - resumeFn: () => queue.resume()
 *   - restartWorkerFn: (worker) => worker.sessionManager.rotate(...)
 *   - reducePoolFn: () => pool.retireOne()   (a Phase 2.10 helper on the pool)
 *   - getRss: () => process.memoryUsage().rss
 *
 * The degradation is a one-shot per threshold crossing. After it runs, it
 * won't fire again until RSS drops back below the threshold and then crosses
 * it again (re-arm semantics, same as the memory monitor).
 *
 * Public API:
 *   const deg = createDegradation({
 *     maxRssMb, logger, getRss, getWorkers,
 *     pauseFn, resumeFn, restartWorkerFn, reducePoolFn, gcFn,
 *     waitFn, waitDeadlineMs, clock,
 *   });
 *   const r = await deg.handlePressure();  // → { acted, rssBefore, rssAfter, reducedPoolSize, steps }
 *   deg.shouldRun();   // → boolean (pure check: is RSS above threshold + not already running)
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RSS_MB = 4096; // 4 GB total process RSS
const DEFAULT_WAIT_DEADLINE_MS = 60_000; // wait up to 60s for in-flight tasks
const DEFAULT_REDUCE_POOL_LIMIT = 1; // never reduce below 1 worker

const MB = 1024 * 1024;

function defaultClock() {
  return Date.now();
}

function defaultGetRss() {
  try {
    return process.memoryUsage().rss;
  } catch {
    return 0;
  }
}

function defaultGetWorkers() {
  return [];
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultGc() {
  // Only available when Node was started with --expose-gc. The caller checks
  // typeof global.gc === 'function' before wiring this; if not, gcFn is null
  // and the degradation skips the GC step.
  if (typeof global.gc === 'function') {
    global.gc();
    return true;
  }
  return false;
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
// createDegradation
// ---------------------------------------------------------------------------

/**
 * Create a degradation handler.
 *
 * @param {object} opts
 * @param {number} [opts.maxRssMb=4096]       — RSS threshold (MB)
 * @param {object} [opts.logger]
 * @param {()=>number} [opts.getRss]          — DI: returns current RSS in BYTES (default process.memoryUsage().rss)
 * @param {()=>Array|{workers:Array}} [opts.getWorkers] — DI: returns the worker array
 * @param {()=>Promise<void>} [opts.pauseFn]  — pause the queue (stop new tasks)
 * @param {()=>Promise<void>} [opts.resumeFn] — resume the queue
 * @param {(worker)=>Promise<void>} [opts.restartWorkerFn] — restart one worker's context
 * @param {()=>number} [opts.reducePoolFn]    — retire one worker; returns new active size
 * @param {()=>boolean} [opts.gcFn]           — run global.gc() (only if --expose-gc)
 * @param {(ms:number)=>Promise<void>} [opts.waitFn] — DI sleep (for in-flight wait)
 * @param {number} [opts.waitDeadlineMs=60000] — max wait for in-flight tasks
 * @param {number} [opts.reducePoolLimit=1]   — never reduce below this active size
 * @param {()=>number} [opts.clock]           — DI clock
 * @returns {object} degradation — { shouldRun, handlePressure, getActive }
 */
function createDegradation(opts = {}) {
  const maxRssMb = Number.isFinite(opts.maxRssMb) ? opts.maxRssMb : DEFAULT_MAX_RSS_MB;
  const logger = opts.logger || makeStubLogger();
  const getRss = typeof opts.getRss === 'function' ? opts.getRss : defaultGetRss;
  const getWorkers =
    typeof opts.getWorkers === 'function' ? opts.getWorkers : defaultGetWorkers;
  const pauseFn = typeof opts.pauseFn === 'function' ? opts.pauseFn : null;
  const resumeFn = typeof opts.resumeFn === 'function' ? opts.resumeFn : null;
  const restartWorkerFn = typeof opts.restartWorkerFn === 'function' ? opts.restartWorkerFn : null;
  const reducePoolFn = typeof opts.reducePoolFn === 'function' ? opts.reducePoolFn : null;
  const gcFn = typeof opts.gcFn === 'function' ? opts.gcFn : null;
  const waitFn = typeof opts.waitFn === 'function' ? opts.waitFn : defaultSleep;
  const waitDeadlineMs = Number.isFinite(opts.waitDeadlineMs)
    ? opts.waitDeadlineMs
    : DEFAULT_WAIT_DEADLINE_MS;
  const reducePoolLimit = Number.isFinite(opts.reducePoolLimit)
    ? opts.reducePoolLimit
    : DEFAULT_REDUCE_POOL_LIMIT;
  const clock = typeof opts.clock === 'function' ? opts.clock : defaultClock;

  let active = false; // true while a degradation cycle is running
  let armed = true; // re-arm semantics: false after acting, true when RSS drops below threshold

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

  function currentRssMb() {
    const rss = getRss();
    return Math.round((rss || 0) / MB);
  }

  /**
   * Pure check: should degradation run right now?
   *   - RSS must be above threshold
   *   - Not currently running
   *   - Armed (i.e. RSS has dropped back below threshold since the last fire)
   */
  function shouldRun() {
    if (active) return false;
    if (!armed) {
      // Re-arm if RSS drops back below threshold (so a follow-up crossing
      // fires again).
      if (currentRssMb() < maxRssMb) {
        armed = true;
      }
      return false;
    }
    return currentRssMb() >= maxRssMb;
  }

  /**
   * Wait for in-flight (busy) workers to finish. Polls every 100ms up to
   * waitDeadlineMs. Returns the number of workers still busy when the
   * deadline elapsed (0 = all finished cleanly).
   */
  async function waitForInFlight() {
    const deadline = clock() + waitDeadlineMs;
    let busy = 0;
    while (clock() < deadline) {
      const workers = resolveWorkers();
      busy = workers.filter((w) => {
        if (!w) return false;
        if (typeof w.state === 'string') return w.state === 'busy';
        if (typeof w.stats === 'function') {
          try {
            const s = w.stats();
            return s.state === 'busy';
          } catch {
            return false;
          }
        }
        return false;
      }).length;
      if (busy === 0) return 0;
      await waitFn(100);
    }
    return busy;
  }

  /**
   * Run the full degradation sequence. No-op (returns { acted: false }) if
   * shouldRun() is false. Otherwise:
   *   1. Pause the queue
   *   2. Wait for in-flight tasks
   *   3. Restart every worker's browser context
   *   4. Run global.gc() if available
   *   5. Resume the queue
   *   6. If RSS still above threshold → reduce pool size by 1
   *
   * @returns {Promise<{acted:boolean, rssBeforeMb:number, rssAfterMb:number, stillBusy:number, reducedPoolSize:boolean, steps:string[]}>}
   */
  async function handlePressure() {
    if (!shouldRun()) {
      return { acted: false, rssBeforeMb: currentRssMb(), rssAfterMb: currentRssMb(), steps: [] };
    }
    active = true;
    armed = false;
    const steps = [];
    const rssBeforeMb = currentRssMb();
    let stillBusy = 0;
    let reducedPoolSize = false;

    logger.warn('Memory pressure: initiating graceful degradation', {
      rssMb: rssBeforeMb,
      thresholdMb: maxRssMb,
    });

    // 1) Pause the queue (stop accepting new jobs).
    if (pauseFn) {
      try {
        await pauseFn();
        steps.push('queue-paused');
        logger.info('Memory pressure: queue paused');
      } catch (err) {
        logger.warn('Memory pressure: pauseFn failed (continuing)', { error: err.message });
        steps.push('queue-pause-failed');
      }
    } else {
      steps.push('queue-pause-skipped');
    }

    // 2) Wait for in-flight tasks to finish.
    try {
      stillBusy = await waitForInFlight();
      steps.push(`in-flight-waited${stillBusy === 0 ? '' : `-partial-${stillBusy}busy`}`);
      if (stillBusy > 0) {
        logger.warn('Memory pressure: in-flight tasks did not finish within deadline', {
          stillBusy,
          deadlineMs: waitDeadlineMs,
        });
      }
    } catch (err) {
      steps.push('in-flight-wait-failed');
      logger.warn('Memory pressure: in-flight wait failed (continuing)', { error: err.message });
    }

    // 3) Restart every worker's browser context.
    if (restartWorkerFn) {
      const workers = resolveWorkers();
      let restarted = 0;
      for (const w of workers) {
        if (!w) continue;
        try {
          await restartWorkerFn(w);
          restarted++;
        } catch (err) {
          logger.warn('Memory pressure: worker context restart failed (continuing)', {
            workerId: w.id,
            error: err.message,
          });
        }
      }
      steps.push(`contexts-restarted-${restarted}`);
      logger.info('Memory pressure: worker contexts restarted', { count: restarted });
    } else {
      steps.push('contexts-restart-skipped');
    }

    // 4) Run global.gc() if available (--expose-gc).
    if (gcFn) {
      try {
        const ok = gcFn();
        steps.push(ok ? 'gc-ran' : 'gc-unavailable');
        if (ok) logger.info('Memory pressure: global.gc() invoked (--expose-gc)');
      } catch (err) {
        steps.push('gc-failed');
        logger.warn('Memory pressure: global.gc() failed (non-fatal)', { error: err.message });
      }
    } else {
      steps.push('gc-skipped');
    }

    // 5) Resume the queue.
    if (resumeFn) {
      try {
        await resumeFn();
        steps.push('queue-resumed');
        logger.info('Memory pressure: queue resumed');
      } catch (err) {
        logger.warn('Memory pressure: resumeFn failed (continuing)', { error: err.message });
        steps.push('queue-resume-failed');
      }
    } else {
      steps.push('queue-resume-skipped');
    }

    // 6) If RSS is STILL above threshold → reduce pool size by 1 worker.
    const rssAfterMb = currentRssMb();
    if (rssAfterMb >= maxRssMb && reducePoolFn) {
      // Only reduce if the active pool size is above the limit.
      const workers = resolveWorkers();
      const activeCount = workers.filter((w) => w && !(typeof w.isRetired === 'function' && w.isRetired())).length;
      if (activeCount > reducePoolLimit) {
        try {
          const newSize = reducePoolFn();
          reducedPoolSize = true;
          steps.push(`pool-reduced-${newSize}`);
          logger.warn('Memory pressure: RSS still above threshold after restart — reducing pool size', {
            rssMb: rssAfterMb,
            thresholdMb: maxRssMb,
            newActiveSize: newSize,
          });
        } catch (err) {
          logger.warn('Memory pressure: reducePoolFn failed (continuing)', { error: err.message });
          steps.push('pool-reduce-failed');
        }
      } else {
        steps.push(`pool-reduce-skipped-at-limit-${activeCount}`);
        logger.warn('Memory pressure: RSS still above threshold but pool already at minimum', {
          rssMb: rssAfterMb,
          activeCount,
          limit: reducePoolLimit,
        });
      }
    }

    active = false;
    const finalRssMb = currentRssMb();
    logger.info('Memory pressure: graceful degradation complete', {
      rssBeforeMb,
      rssAfterMb: finalRssMb,
      reducedPoolSize,
      steps,
    });

    return {
      acted: true,
      rssBeforeMb,
      rssAfterMb: finalRssMb,
      stillBusy,
      reducedPoolSize,
      steps,
    };
  }

  function getActive() {
    return active;
  }

  return {
    shouldRun,
    handlePressure,
    getActive,
    currentRssMb,
    // exposed for tests
    _maxRssMb: maxRssMb,
    _waitDeadlineMs: waitDeadlineMs,
    _reducePoolLimit: reducePoolLimit,
    get _armed() {
      return armed;
    },
  };
}

module.exports = {
  createDegradation,
  DEFAULT_MAX_RSS_MB,
  DEFAULT_WAIT_DEADLINE_MS,
  DEFAULT_REDUCE_POOL_LIMIT,
  defaultClock,
  defaultGetRss,
  defaultGetWorkers,
  defaultGc,
  defaultSleep,
  makeStubLogger,
};
