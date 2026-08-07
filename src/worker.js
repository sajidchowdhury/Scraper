'use strict';

/**
 * src/worker.js — Phase 2.8 — Worker Pool & Concurrency
 *
 * A Worker is ONE isolated scrape unit: it owns a browser identity (proxy,
 * fingerprint, session manager, rate limiter) and runs serializable tasks
 * (search-task / detail-task / resume-task) one at a time. The Worker itself
 * never touches Playwright — that is the job of the injected `runTask`
 * function (DI), so the worker is fully unit-testable with mocks.
 *
 * Lifecycle states:
 *   idle      — available for a new task
 *   busy      — running a task
 *   cooldown  — blocked; sitting out for cooldownMs before it can run again
 *   retired   — permanently removed (crashed >= crashLimit times in the window)
 *
 * Failure handling (the pool drives the high-level re-queue, the worker just
 * records + transitions state):
 *   - Block signal (runTask throws { code: 'WORKER_BLOCKED' }):
 *       worker.run() increments `blocked`, calls markBlocked() (→ cooldown),
 *       then re-throws so the pool can re-queue the task to another worker.
 *       The pool calls worker.rotateIdentity() to swap in a fresh proxy +
 *       fingerprint + session before the worker comes off cooldown.
 *   - Crash (any other thrown error):
 *       worker.run() increments `errors` + `crashes`, calls markCrashed()
 *       which records a timestamp. If crashCountInWindow >= crashLimit the
 *       worker is retired (state='retired', never runs again). Otherwise the
 *       pool calls worker.rotateIdentity() (the "restart" — the next task
 *       launches a fresh browser with the new identity) and re-queues.
 *
 * Public API:
 *   const w = createWorker({ id, cfg, proxy, fingerprint, sessionManager,
 *                            rateLimiter, runTask, crashLimit, crashWindowMs,
 *                            cooldownMs, clock, sleepFn, logger });
 *   await w.run(task);          // → task result (throws on block/crash)
 *   w.isHealthy();              // true unless retired
 *   w.isAvailable();            // true if healthy && not busy && cooldown elapsed
 *   w.markBlocked();            // → cooldown (pool calls this implicitly via run)
 *   w.markCrashed(err);         // → { retired, crashCountInWindow }
 *   w.rotateIdentity({...});    // swap proxy/fingerprint/session
 *   w.stats();                  // → per-worker stats snapshot
 *   await w.shutdown();         // release proxy, close session, log final stats
 *
 * The worker is intentionally agnostic about WHAT runTask does — it only
 * cares about the { code: 'WORKER_BLOCKED' } contract for block signals and
 * any-other-throw for crashes. This keeps the module testable and decoupled
 * from the Playwright pipeline (which lives in src/index.js).
 */

// ---------------------------------------------------------------------------
// Defaults + errors
// ---------------------------------------------------------------------------

const DEFAULT_CRASH_LIMIT = 3; // retire after 3 crashes in the window
const DEFAULT_CRASH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes (per execution plan)

class WorkerError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'WorkerError';
    this.code = code || 'WORKER_ERROR';
  }
}

function defaultClock() {
  return Date.now();
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Stub logger (used when no logger is supplied — keeps the worker silent)
// ---------------------------------------------------------------------------

function makeStubLogger() {
  const noop = () => {};
  const log = () => noop;
  log.debug = noop;
  log.info = noop;
  log.warn = noop;
  log.error = noop;
  log.phase = () => makeStubLogger();
  log.child = () => makeStubLogger();
  return log;
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

/**
 * Create a worker.
 *
 * @param {object} opts
 * @param {number} opts.id                       — worker id (0-based)
 * @param {object} [opts.cfg]                    — shared base config (read-only)
 * @param {object} [opts.proxy]                  — initial proxy descriptor { id, server, ... }
 * @param {object} [opts.fingerprint]            — initial fingerprint (Phase 2.4)
 * @param {object} [opts.sessionManager]         — per-worker session manager (Phase 2.7)
 * @param {object} [opts.rateLimiter]            — per-worker RateLimiter (Phase 1.8)
 * @param {Function} opts.runTask                — async (worker, task) => result  [DI — required]
 * @param {number} [opts.crashLimit=3]           — retire after this many crashes in the window
 * @param {number} [opts.crashWindowMs=600000]   — crash-counting window (10 min)
 * @param {number} [opts.cooldownMs=300000]      — block cooldown (5 min)
 * @param {()=>number} [opts.clock]              — injectable clock (default Date.now)
 * @param {(ms:number)=>Promise<void>} [opts.sleepFn] — injectable sleep
 * @param {object} [opts.logger]                 — parent logger (worker binds workerId)
 * @returns {object} worker
 */
function createWorker(opts = {}) {
  if (opts.id === undefined || opts.id === null) {
    throw new WorkerError('createWorker requires opts.id', { code: 'WORKER_CONFIG' });
  }
  if (typeof opts.runTask !== 'function') {
    throw new WorkerError(
      'createWorker requires opts.runTask (async (worker, task) => result) — inject a mock for tests',
      { code: 'WORKER_CONFIG' },
    );
  }

  const id = opts.id;
  const cfg = opts.cfg || null;
  const crashLimit = Number.isFinite(opts.crashLimit) ? opts.crashLimit : DEFAULT_CRASH_LIMIT;
  const crashWindowMs = Number.isFinite(opts.crashWindowMs)
    ? opts.crashWindowMs
    : DEFAULT_CRASH_WINDOW_MS;
  const cooldownMs = Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : DEFAULT_COOLDOWN_MS;
  const clock = opts.clock || defaultClock;
  const sleepFn = opts.sleepFn || defaultSleep;
  const parentLogger = opts.logger || makeStubLogger();
  // Bind workerId to every log line so the operator can trace which worker did
  // what. child() merges the context into every subsequent line.
  const logger =
    typeof parentLogger.child === 'function'
      ? parentLogger.child({ workerId: id })
      : parentLogger;

  // Per-worker identity. Rotated by rotateIdentity() after a block/crash so the
  // next task launches a fresh browser with a new proxy + fingerprint + session.
  let proxy = opts.proxy || null;
  let fingerprint = opts.fingerprint || null;
  let sessionManager = opts.sessionManager || null;
  const rateLimiter = opts.rateLimiter || null;

  // State machine
  let state = 'idle'; // 'idle' | 'busy' | 'cooldown' | 'retired'
  let cooldownUntil = 0; // epoch ms; 0 = not cooling down
  let currentTask = null;

  // Stats counters
  let tasksAttempted = 0;
  let tasksCompleted = 0;
  let businessesScraped = 0; // accumulated from task results
  let errors = 0; // task failures (crashes)
  let blocked = 0; // block signals received
  let crashes = 0; // lifetime crash count (for stats)
  let consecutiveErrors = 0; // reset on success; used for fast-fail heuristics
  let lastError = null; // { message, code, stack, at }
  const crashTimestamps = []; // epoch ms of recent crashes (pruned by window)
  let retired = false;
  let retiredAt = null;
  const createdAt = clock();

  // -----------------------------------------------------------------
  // Identity
  // -----------------------------------------------------------------

  /**
   * Swap in a fresh proxy + fingerprint + session. Called by the pool after a
   * block or crash so the worker's NEXT task uses a new identity (a "restart").
   * The browser itself is per-task (launched inside runTask via withBrowser),
   * so rotateIdentity() is all that's needed to restart with a clean identity.
   *
   * @param {object} identity — { proxy?, fingerprint?, sessionManager? }
   */
  function rotateIdentity(identity = {}) {
    if (identity.proxy !== undefined) proxy = identity.proxy;
    if (identity.fingerprint !== undefined) fingerprint = identity.fingerprint;
    if (identity.sessionManager !== undefined) sessionManager = identity.sessionManager;
    logger.debug('Worker identity rotated', {
      workerId: id,
      proxyId: proxy ? proxy.id || null : null,
      fingerprint: fingerprint ? fingerprint.userAgent : null,
    });
  }

  // -----------------------------------------------------------------
  // State transitions
  // -----------------------------------------------------------------

  function markBlocked() {
    blocked++;
    consecutiveErrors++;
    state = 'cooldown';
    cooldownUntil = clock() + cooldownMs;
    logger.warn('Worker blocked — entering cooldown', {
      workerId: id,
      blocked,
      cooldownMs,
      cooldownUntil,
      hint: 'Task will be re-queued to another worker; identity rotated before revival',
    });
  }

  /**
   * Record a crash. Returns { retired, crashCountInWindow } so the pool knows
   * whether to retire the worker or restart it.
   */
  function markCrashed(err) {
    errors++;
    crashes++;
    consecutiveErrors++;
    lastError = {
      message: err && err.message ? err.message : String(err),
      code: err && err.code ? err.code : null,
      stack: err && err.stack ? err.stack : null,
      at: new Date(clock()).toISOString(),
    };
    const now = clock();
    crashTimestamps.push(now);
    // Prune crashes older than the window.
    const cutoff = now - crashWindowMs;
    while (crashTimestamps.length > 0 && crashTimestamps[0] < cutoff) {
      crashTimestamps.shift();
    }
    const crashCountInWindow = crashTimestamps.length;
    if (crashCountInWindow >= crashLimit) {
      retired = true;
      retiredAt = now;
      state = 'retired';
      logger.error('Worker retired — crash limit reached in window', {
        workerId: id,
        crashes: crashCountInWindow,
        crashLimit,
        crashWindowMs,
        hint: 'Pool size effectively reduced; remaining workers absorb the load',
      });
    } else {
      logger.warn('Worker crashed — will restart on next task', {
        workerId: id,
        crashes: crashCountInWindow,
        crashLimit,
        error: lastError.message,
        hint: `Retires after ${crashLimit} crashes in ${crashWindowMs / 1000}s`,
      });
    }
    return { retired, crashCountInWindow };
  }

  // -----------------------------------------------------------------
  // Health + availability
  // -----------------------------------------------------------------

  function isRetired() {
    return retired;
  }

  function isHealthy() {
    return !retired;
  }

  /**
   * Available = healthy AND not busy AND cooldown has elapsed.
   * Cooldown is checked lazily against the clock so no timer is needed.
   */
  function isAvailable() {
    if (retired) return false;
    if (state === 'busy') return false;
    if (state === 'cooldown' && clock() < cooldownUntil) return false;
    // Cooldown elapsed — transition back to idle (lazy revival).
    if (state === 'cooldown') {
      state = 'idle';
      cooldownUntil = 0;
      logger.debug('Worker cooldown elapsed — back to idle', { workerId: id });
    }
    return true;
  }

  // -----------------------------------------------------------------
  // run(task)
  // -----------------------------------------------------------------

  /**
   * Execute a task via the injected runTask. Tracks stats + handles block/crash
   * signals. Throws on failure so the pool can re-queue; the thrown error is
   * tagged with { code } so the pool can distinguish block vs crash.
   *
   * Block contract: runTask throws an Error with err.code === 'WORKER_BLOCKED'
   * (or returns { blocked: true } — treated the same). Anything else thrown is
   * a crash.
   *
   * @returns {Promise<*>} the task result (whatever runTask resolved to)
   */
  async function run(task) {
    if (retired) {
      throw new WorkerError(`worker ${id} is retired`, { code: 'WORKER_RETIRED' });
    }
    if (state === 'busy') {
      throw new WorkerError(`worker ${id} is busy`, { code: 'WORKER_BUSY' });
    }
    if (state === 'cooldown' && clock() < cooldownUntil) {
      throw new WorkerError(`worker ${id} is in cooldown`, { code: 'WORKER_COOLDOWN' });
    }

    state = 'busy';
    currentTask = task;
    tasksAttempted++;
    const taskStartedAt = clock();
    logger.debug('Worker picked up task', {
      workerId: id,
      taskId: task && task.id ? task.id : null,
      taskType: task && task.type ? task.type : null,
    });

    try {
      const result = await opts.runTask(worker, task);
      tasksCompleted++;
      consecutiveErrors = 0;
      // Accumulate businessesScraped from common result shapes. runTask may
      // return { businesses: [...] } (search/detail) or { businessesScraped: n }
      // or a bare array. We sum whatever we can find so pool.stats() reflects
      // real throughput. (Array check FIRST — arrays are also typeof 'object'.)
      if (Array.isArray(result)) {
        businessesScraped += result.length;
      } else if (result && typeof result === 'object') {
        if (typeof result.businessesScraped === 'number') {
          businessesScraped += result.businessesScraped;
        } else if (Array.isArray(result.businesses)) {
          businessesScraped += result.businesses.length;
        } else if (typeof result.count === 'number') {
          businessesScraped += result.count;
        }
      }
      logger.debug('Worker completed task', {
        workerId: id,
        taskId: task && task.id ? task.id : null,
        taskType: task && task.type ? task.type : null,
        durationMs: clock() - taskStartedAt,
        tasksCompleted,
      });
      return result;
    } catch (err) {
      // Block signal — explicit or via { blocked: true } return (rare).
      const isBlock =
        (err && err.code === 'WORKER_BLOCKED') ||
        (err && err.blocked === true);
      if (isBlock) {
        markBlocked();
        // Re-throw tagged so the pool can re-queue without double-counting.
        if (!err || !err.code) {
          const e = new WorkerError('worker blocked', { code: 'WORKER_BLOCKED' });
          throw e;
        }
        throw err;
      }
      // Crash — any other error.
      const r = markCrashed(err);
      const tagged = err && err.code ? err : new WorkerError(
        (err && err.message) || 'worker crashed',
        { code: 'WORKER_CRASHED' },
      );
      tagged.workerRetired = r.retired;
      tagged.crashCountInWindow = r.crashCountInWindow;
      throw tagged;
    } finally {
      currentTask = null;
      // Only reset to idle if still busy (markBlocked → cooldown, markCrashed
      // → retired leave state alone; success path leaves it busy until now).
      if (state === 'busy') {
        state = 'idle';
      }
    }
  }

  // -----------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------

  function stats() {
    return {
      workerId: id,
      state,
      retired,
      proxyId: proxy ? proxy.id || null : null,
      proxyServer: proxy ? proxy.server || null : null,
      fingerprint: fingerprint
        ? {
            userAgent: fingerprint.userAgent || null,
            platform: fingerprint.platform || null,
          }
        : null,
      tasksAttempted,
      tasksCompleted,
      businessesScraped,
      errors,
      blocked,
      crashes,
      consecutiveErrors,
      crashCountInWindow: crashTimestamps.length,
      crashLimit,
      cooldownRemainingMs:
        state === 'cooldown' ? Math.max(0, cooldownUntil - clock()) : 0,
      createdAt,
      uptimeMs: clock() - createdAt,
      retiredAt,
      lastError,
      currentTaskId: currentTask && currentTask.id ? currentTask.id : null,
      currentTaskType: currentTask && currentTask.type ? currentTask.type : null,
    };
  }

  // -----------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------

  /**
   * Graceful shutdown: release the proxy (if a releaseFn is wired), close the
   * session manager, log final stats. Best-effort — never throws.
   */
  async function shutdown() {
    const finalStats = stats();
    logger.info('Worker shutting down', {
      workerId: id,
      tasksCompleted: finalStats.tasksCompleted,
      businessesScraped: finalStats.businessesScraped,
      errors: finalStats.errors,
      blocked: finalStats.blocked,
      crashes: finalStats.crashes,
      retired: finalStats.retired,
    });
    // Close the per-worker session manager (closes the current context).
    if (sessionManager && typeof sessionManager.release === 'function') {
      try {
        await sessionManager.release();
      } catch (err) {
        logger.warn('Worker session release failed (non-fatal)', {
          workerId: id,
          error: err.message,
        });
      }
    }
    state = 'retired';
    return finalStats;
  }

  // -----------------------------------------------------------------
  // Assemble the worker object
  // -----------------------------------------------------------------

  const worker = {
    id,
    // identity (read via getters so tests/pool can inspect but not mutate freely)
    get proxy() {
      return proxy;
    },
    get fingerprint() {
      return fingerprint;
    },
    get sessionManager() {
      return sessionManager;
    },
    get rateLimiter() {
      return rateLimiter;
    },
    get cfg() {
      return cfg;
    },
    get logger() {
      return logger;
    },
    // state
    get state() {
      return state;
    },
    get currentTask() {
      return currentTask;
    },
    // lifecycle
    run,
    isHealthy,
    isAvailable,
    isRetired,
    markBlocked,
    markCrashed,
    rotateIdentity,
    stats,
    shutdown,
    // exposed for the pool / tests (not part of the public contract)
    _crashLimit: crashLimit,
    _crashWindowMs: crashWindowMs,
    _cooldownMs: cooldownMs,
    _crashTimestamps: crashTimestamps,
  };

  return worker;
}

// ---------------------------------------------------------------------------
// Task helpers — serializable task descriptors (JSON-safe so they can be
// persisted to the Phase 2.9 job queue). Each task has a stable `id` + `type`
// so the pool can trace + re-queue it.
// ---------------------------------------------------------------------------

let _taskSeq = 0;
function nextTaskId() {
  _taskSeq = (_taskSeq + 1) % 1_000_000;
  return `task-${Date.now().toString(36)}-${_taskSeq.toString(36)}`;
}

/**
 * Build a search-task. A full search + scroll + extract for one query/location
 * pair. Result shape: { businesses: Business[], scrollResult, extractionRates }.
 */
function createSearchTask({ query, location, maxResults, opts } = {}) {
  return {
    id: nextTaskId(),
    type: 'search-task',
    query,
    location,
    maxResults: maxResults || null,
    opts: opts || {},
  };
}

/**
 * Build a detail-task. Deep-scrape a batch of businesses (e.g. 20 at a time).
 * Result shape: { businesses: Business[] (with detail fields filled), detailStats }.
 */
function createDetailTask({ businesses, opts } = {}) {
  return {
    id: nextTaskId(),
    type: 'detail-task',
    businesses: Array.isArray(businesses) ? businesses : [],
    opts: opts || {},
  };
}

/**
 * Build a resume-task. Resume a crashed search-task from a checkpoint.
 * Result shape: same as search-task (the businesses the resumed run produced).
 */
function createResumeTask({ checkpoint, opts } = {}) {
  return {
    id: nextTaskId(),
    type: 'resume-task',
    checkpoint: checkpoint || null,
    opts: opts || {},
  };
}

/** Validate a task descriptor. Returns an array of error strings (empty = ok). */
function validateTask(task) {
  const errs = [];
  if (!task || typeof task !== 'object') {
    return ['task must be an object'];
  }
  if (!['search-task', 'detail-task', 'resume-task'].includes(task.type)) {
    errs.push(`task.type must be one of search-task, detail-task, resume-task (got "${task.type}")`);
  }
  if (!task.id || typeof task.id !== 'string') {
    errs.push('task.id must be a string');
  }
  if (task.type === 'search-task' || task.type === 'resume-task') {
    if (!task.query || !String(task.query).trim()) errs.push('search/resume task requires task.query');
    if (!task.location || !String(task.location).trim()) errs.push('search/resume task requires task.location');
  }
  if (task.type === 'detail-task') {
    if (!Array.isArray(task.businesses)) errs.push('detail task requires task.businesses array');
  }
  // Serializable? (JSON-safe so it can be persisted to the Phase 2.9 queue)
  try {
    JSON.stringify(task);
  } catch (e) {
    errs.push(`task must be JSON-serializable: ${e.message}`);
  }
  return errs;
}

module.exports = {
  createWorker,
  createSearchTask,
  createDetailTask,
  createResumeTask,
  validateTask,
  WorkerError,
  DEFAULT_CRASH_LIMIT,
  DEFAULT_CRASH_WINDOW_MS,
  DEFAULT_COOLDOWN_MS,
};
