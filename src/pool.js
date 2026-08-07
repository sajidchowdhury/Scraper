'use strict';

/**
 * src/pool.js — Phase 2.8 — Worker Pool & Concurrency
 *
 * A Pool manages N Workers and distributes tasks across them. It is the
 * scheduler + self-healer:
 *   - dispatch(task)        — assign one task to the next available worker
 *   - dispatchBatch(tasks)  — assign a batch; runs up to `size` in parallel
 *   - stats()               — per-worker + aggregate stats
 *   - shutdown()            — gracefully stop every worker (finish current task)
 *
 * Load balancing: round-robin (default) or least-busy (pick the worker with the
 * fewest completed tasks). Both only consider workers that are available (idle
 * + cooldown elapsed + not retired).
 *
 * Self-healing on per-worker failure:
 *   - Block (worker.run throws { code: 'WORKER_BLOCKED' }):
 *       1. The worker enters cooldown (state='cooldown').
 *       2. rotateIdentity() swaps in a fresh proxy + fingerprint + session.
 *       3. The task is re-queued to ANOTHER worker (not the same one — it's
 *          cooling down). The original dispatch() promise resolves when the
 *          task eventually completes.
 *       4. After cooldownMs the worker is lazy-revived back to idle.
 *   - Crash (any other thrown error):
 *       1. The worker records the crash timestamp.
 *       2. If crashCountInWindow >= crashLimit → the worker is RETIRED
 *          (state='retired', removed from the active pool). Pool size drops.
 *       3. Otherwise rotateIdentity() (the "restart" — next task gets a fresh
 *          browser + proxy + fingerprint) and re-queue the task.
 *   - Re-queue limit: a task is re-tried at most `taskRetries` times across
 *     workers (default = size, so each worker gets ~one shot). After that the
 *     dispatch() promise rejects with the last error.
 *
 * Concurrency model: the pool tracks a `busy` Set of worker ids. acquireWorker()
 * picks an available worker (sync — race-free under single-threaded JS), marks
 * it busy, and returns it. When no worker is available it polls on an
 * injectable sleepFn (default 25ms — negligible for scrape-length tasks,
 * instant under test sleepFn). If every worker is retired, acquireWorker
 * rejects with PoolError('pool exhausted').
 *
 * The pool is fully DI: createWorker + getIdentity are injectable so unit tests
 * never touch a real browser or proxy pool. In production, src/index.js wires
 * them to the real createWorker + a getIdentity() that acquires a proxy from
 * the proxy pool + generates a fingerprint + builds a session manager.
 *
 * Public API:
 *   const pool = createPool({ size, cfg, createWorker, getIdentity,
 *                             loadBalancer, crashLimit, crashWindowMs,
 *                             cooldownMs, taskRetries, clock, sleepFn,
 *                             pollIntervalMs, logger });
 *   const result = await pool.dispatch(task);
 *   const results = await pool.dispatchBatch(tasks);
 *   const s = pool.stats();
 *   await pool.shutdown();
 */

const { createWorker, WorkerError } = require('./worker');

// ---------------------------------------------------------------------------
// Defaults + errors
// ---------------------------------------------------------------------------

const DEFAULT_LOAD_BALANCER = 'round-robin';
const DEFAULT_TASK_RETRIES = null; // null = derive from size (each worker ~1 shot)
const DEFAULT_POLL_INTERVAL_MS = 25;

class PoolError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'PoolError';
    this.code = code || 'POOL_ERROR';
  }
}

function defaultClock() {
  return Date.now();
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
// Pool factory
// ---------------------------------------------------------------------------

/**
 * Create a worker pool.
 *
 * @param {object} opts
 * @param {number} opts.size                    — number of workers (>= 1)
 * @param {object} [opts.cfg]                   — shared base config (passed to workers)
 * @param {Function} [opts.createWorker]        — DI factory ({ id, cfg, logger, ...workerOpts }) => worker.
 *                                                Defaults to the real createWorker with getIdentity-supplied identity.
 * @param {Function} [opts.getIdentity]         — DI: async () => ({ proxy, fingerprint, sessionManager }).
 *                                                Called for initial worker identity + after every block/crash rotation.
 * @param {string} [opts.loadBalancer='round-robin'] — 'round-robin' | 'least-busy'
 * @param {number} [opts.crashLimit=3]          — retire a worker after this many crashes in the window
 * @param {number} [opts.crashWindowMs=600000]  — crash-counting window
 * @param {number} [opts.cooldownMs=300000]     — block cooldown
 * @param {number} [opts.taskRetries]           — max re-queues per task (default = size)
 * @param {()=>number} [opts.clock]             — injectable clock
 * @param {(ms:number)=>Promise<void>} [opts.sleepFn] — injectable sleep (for acquireWorker polling)
 * @param {number} [opts.pollIntervalMs=25]     — acquireWorker poll interval
 * @param {object} [opts.logger]                — parent logger
 * @returns {object} pool
 */
function createPool(opts = {}) {
  const size = Math.max(1, Math.floor(opts.size) || 1);
  const cfg = opts.cfg || null;
  const loadBalancer =
    opts.loadBalancer === 'least-busy' ? 'least-busy' : DEFAULT_LOAD_BALANCER;
  const crashLimit = Number.isFinite(opts.crashLimit) ? opts.crashLimit : 3;
  const crashWindowMs = Number.isFinite(opts.crashWindowMs) ? opts.crashWindowMs : 10 * 60 * 1000;
  const cooldownMs = Number.isFinite(opts.cooldownMs) ? opts.cooldownMs : 5 * 60 * 1000;
  const taskRetries =
    Number.isFinite(opts.taskRetries) && opts.taskRetries >= 0
      ? opts.taskRetries
      : size; // default: each worker gets ~one shot
  const clock = opts.clock || defaultClock;
  const sleepFn = opts.sleepFn || defaultSleep;
  const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) ? opts.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  const parentLogger = opts.logger || makeStubLogger();
  const logger =
    typeof parentLogger.child === 'function'
      ? parentLogger.child({ component: 'pool' })
      : parentLogger;

  // The DI createWorker factory. When omitted, use the real createWorker and
  // resolve the initial identity via getIdentity (also DI; defaults to null
  // identity → direct-connection, no-fingerprint worker — useful for tests
  // that inject their own runTask).
  const createWorkerFn = opts.createWorker || createWorker;
  const getIdentity =
    typeof opts.getIdentity === 'function'
      ? opts.getIdentity
      : async () => ({ proxy: null, fingerprint: null, sessionManager: null });

  // -----------------------------------------------------------------
  // Worker construction (async — getIdentity may await a proxy acquire)
  // -----------------------------------------------------------------

  const workers = [];
  const busy = new Set(); // worker ids currently running a task
  let rrIndex = 0; // round-robin cursor
  let dispatchCount = 0;
  let requeueCount = 0;
  const createdAt = clock();
  let shutDown = false;

  async function buildWorker(id) {
    let identity = { proxy: null, fingerprint: null, sessionManager: null };
    try {
      identity = await getIdentity();
    } catch (err) {
      logger.warn('getIdentity failed during worker construction (continuing with null identity)', {
        workerId: id,
        error: err.message,
      });
    }
    // The DI factory receives the resolved identity + per-worker opts. The
    // default createWorker uses these; a custom factory may ignore them.
    return createWorkerFn({
      id,
      cfg,
      proxy: identity.proxy,
      fingerprint: identity.fingerprint,
      sessionManager: identity.sessionManager,
      rateLimiter: identity.rateLimiter || null,
      // runTask + logger are injected by the DI factory (real createWorker
      // requires runTask; a custom factory supplies it). When using the real
      // createWorker WITHOUT a runTask, this throws — which is the intended
      // fail-fast for misconfiguration.
      crashLimit,
      crashWindowMs,
      cooldownMs,
      clock,
      sleepFn,
      logger: parentLogger,
      ...(identity.runTask ? { runTask: identity.runTask } : {}),
    });
  }

  // -----------------------------------------------------------------
  // Worker selection (load balancer)
  // -----------------------------------------------------------------

  function availableWorkers() {
    return workers.filter((w) => !busy.has(w.id) && w.isAvailable());
  }

  function pickWorker() {
    const avail = availableWorkers();
    if (avail.length === 0) return null;
    if (loadBalancer === 'least-busy') {
      // Pick the worker with the fewest completed tasks (most rested). Ties
      // broken by lowest id for determinism.
      avail.sort((a, b) => {
        const sa = a.stats();
        const sb = b.stats();
        if (sa.tasksCompleted !== sb.tasksCompleted) {
          return sa.tasksCompleted - sb.tasksCompleted;
        }
        return a.id - b.id;
      });
      return avail[0];
    }
    // round-robin: cycle through the currently-available workers. The cursor
    // wraps mod avail.length so each available worker gets a turn before any
    // is reused (when the available set is stable).
    const pick = avail[rrIndex % avail.length];
    rrIndex = (rrIndex + 1) % avail.length;
    return pick;
  }

  // -----------------------------------------------------------------
  // acquireWorker — wait until a worker is available, then claim it
  // -----------------------------------------------------------------

  async function acquireWorker() {
    // Loop until we can claim one. Single-threaded JS means the claim (busy.add)
    // is atomic between awaits — no double-dispatch to the same worker.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (shutDown) {
        throw new PoolError('pool is shut down', { code: 'POOL_SHUTDOWN' });
      }
      const activeCount = workers.filter((w) => !w.isRetired()).length;
      if (activeCount === 0) {
        throw new PoolError(
          'pool exhausted — every worker is retired (crash limit reached)',
          { code: 'POOL_EXHAUSTED' },
        );
      }
      const w = pickWorker();
      if (w) {
        busy.add(w.id);
        return w;
      }
      // No worker available right now — poll. Cooldown workers become available
      // lazily via isAvailable() (which checks the clock), so the poll naturally
      // revives them. pollIntervalMs is small (25ms default; instant in tests
      // with an injected no-op sleepFn).
      await sleepFn(pollIntervalMs);
    }
  }

  function releaseWorker(w) {
    busy.delete(w.id);
  }

  // -----------------------------------------------------------------
  // dispatch — assign a task, re-queue on block/crash
  // -----------------------------------------------------------------

  /**
   * Dispatch a single task. Resolves with the task result (whatever the
   * worker's runTask returned). Re-queues up to `taskRetries` times on
   * WORKER_BLOCKED or crash; rejects with the last error if all retries fail
   * or the pool is exhausted.
   *
   * The task is cloned (shallow) on each re-queue attempt so a worker can't
   * mutate the original. A `_attempts` counter is stamped on the task for
   * traceability (does not break JSON serialization).
   */
  async function dispatch(task) {
    if (shutDown) {
      throw new PoolError('pool is shut down', { code: 'POOL_SHUTDOWN' });
    }
    if (!task || typeof task !== 'object') {
      throw new PoolError('dispatch requires a task object', { code: 'POOL_CONFIG' });
    }
    dispatchCount++;
    const attemptTask = { ...task, _attempts: task._attempts || 0 };

    let lastErr = null;
    for (let attempt = 0; attempt <= taskRetries; attempt++) {
      attemptTask._attempts = attempt;
      let worker = null;
      try {
        worker = await acquireWorker();
      } catch (err) {
        // Pool exhausted — no point retrying.
        throw err;
      }
      try {
        const result = await worker.run(attemptTask);
        return result;
      } catch (err) {
        lastErr = err;
        const isBlock = err && err.code === 'WORKER_BLOCKED';
        requeueCount++;
        logger.warn('Task failed on worker — re-queuing', {
          taskId: attemptTask.id,
          taskType: attemptTask.type,
          workerId: worker.id,
          attempt,
          reason: isBlock ? 'blocked' : 'crashed',
          errorCode: err.code || null,
          errorMessage: err.message,
          retriesLeft: taskRetries - attempt,
        });

        // Self-heal the worker: rotate its identity so the NEXT task it runs
        // uses a fresh proxy + fingerprint + session. For crashes that retire
        // the worker, rotateIdentity is a no-op (retired workers never run
        // again). For blocks, the worker is in cooldown; rotation happens now
        // so it's ready when cooldown elapses.
        if (!worker.isRetired()) {
          try {
            const identity = await getIdentity();
            worker.rotateIdentity(identity);
          } catch (idErr) {
            logger.warn('getIdentity failed during rotation (worker keeps old identity)', {
              workerId: worker.id,
              error: idErr.message,
            });
          }
        }
      } finally {
        releaseWorker(worker);
      }
      // If the worker was retired by this crash, the pool size dropped. The
      // loop continues; acquireWorker will throw POOL_EXHAUSTED if no active
      // workers remain.
    }
    // Exhausted retries.
    const wrapped = lastErr || new PoolError('dispatch failed', { code: 'POOL_FAILED' });
    if (!wrapped.code) wrapped.code = 'POOL_FAILED';
    logger.error('Task exhausted all re-queue attempts', {
      taskId: attemptTask.id,
      taskType: attemptTask.type,
      attempts: taskRetries + 1,
      lastError: wrapped.message,
    });
    throw wrapped;
  }

  /**
   * Dispatch a batch of tasks. Runs up to `size` concurrently (the pool gates
   * concurrency). Returns an array of results IN INPUT ORDER (failed tasks
   * reject the whole batch — use dispatchBatchSettled for partial-failure).
   */
  async function dispatchBatch(tasks) {
    if (!Array.isArray(tasks)) {
      throw new PoolError('dispatchBatch requires an array of tasks', { code: 'POOL_CONFIG' });
    }
    // Promise.all preserves order. The pool's acquireWorker gating ensures at
    // most `size` tasks run at once (the rest wait in acquireWorker's poll).
    return Promise.all(tasks.map((t) => dispatch(t)));
  }

  /**
   * Dispatch a batch, never rejecting. Returns { results, errors, summary }
   * where results[i] = { status: 'fulfilled'|'rejected', value?, reason? } in
   * input order. Useful for detail-batch runs where some businesses fail but
   * the rest should still be exported.
   */
  async function dispatchBatchSettled(tasks) {
    if (!Array.isArray(tasks)) {
      throw new PoolError('dispatchBatchSettled requires an array of tasks', { code: 'POOL_CONFIG' });
    }
    const settled = await Promise.allSettled(tasks.map((t) => dispatch(t)));
    const fulfilled = settled.filter((s) => s.status === 'fulfilled').length;
    const rejected = settled.length - fulfilled;
    return {
      results: settled,
      fulfilled,
      rejected,
      total: settled.length,
    };
  }

  // -----------------------------------------------------------------
  // stats
  // -----------------------------------------------------------------

  function stats() {
    const perWorker = workers.map((w) => w.stats());
    const activeWorkers = perWorker.filter((w) => !w.retired);
    const totals = perWorker.reduce(
      (acc, w) => {
        acc.tasksAttempted += w.tasksAttempted;
        acc.tasksCompleted += w.tasksCompleted;
        acc.businessesScraped += w.businessesScraped;
        acc.errors += w.errors;
        acc.blocked += w.blocked;
        acc.crashes += w.crashes;
        return acc;
      },
      {
        tasksAttempted: 0,
        tasksCompleted: 0,
        businessesScraped: 0,
        errors: 0,
        blocked: 0,
        crashes: 0,
      },
    );
    return {
      size,
      activeSize: activeWorkers.length,
      retiredCount: perWorker.length - activeWorkers.length,
      loadBalancer,
      dispatchCount,
      requeueCount,
      uptimeMs: clock() - createdAt,
      totals,
      perWorker,
    };
  }

  // -----------------------------------------------------------------
  // shutdown
  // -----------------------------------------------------------------

  /**
   * Graceful shutdown: every worker finishes its current task (in-flight
   * dispatches settle), then shuts down (releases proxy + session). Best-effort
   * — never throws. After shutdown, dispatch() rejects with POOL_SHUTDOWN.
   */
  async function shutdown() {
    if (shutDown) return;
    shutDown = true;
    logger.info('Pool shutting down', {
      size,
      activeSize: workers.filter((w) => !w.isRetired()).length,
      dispatchCount,
      requeueCount,
    });
    // Wait for in-flight tasks to settle (busy workers). Poll until busy is
    // empty or a timeout elapses (best-effort — don't hang forever).
    const shutdownDeadline = clock() + 60_000;
    while (busy.size > 0 && clock() < shutdownDeadline) {
      await sleepFn(100);
    }
    const results = [];
    for (const w of workers) {
      try {
        const s = await w.shutdown();
        results.push(s);
      } catch (err) {
        logger.warn('Worker shutdown failed (non-fatal)', {
          workerId: w.id,
          error: err.message,
        });
      }
    }
    return results;
  }

  // -----------------------------------------------------------------
  // Public object
  // -----------------------------------------------------------------

  const pool = {
    get size() {
      return size;
    },
    get activeSize() {
      return workers.filter((w) => !w.isRetired()).length;
    },
    workers,
    dispatch,
    dispatchBatch,
    dispatchBatchSettled,
    stats,
    shutdown,
    // exposed for tests / introspection
    _pickWorker: pickWorker,
    _availableWorkers: availableWorkers,
    _busy: busy,
    _loadBalancer: loadBalancer,
  };

  // Construct workers eagerly (async). The returned pool has an `init()`
  // promise the caller can await before dispatching; dispatch() also awaits it
  // implicitly so callers can use the pool immediately.
  let initPromise = null;
  function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const built = [];
      for (let i = 0; i < size; i++) {
        try {
          built.push(await buildWorker(i));
        } catch (err) {
          // A worker build failure (e.g. getIdentity threw) is non-fatal — the
          // pool starts with fewer workers. Logged for visibility.
          logger.error('Worker construction failed — pool starts with fewer workers', {
            workerId: i,
            error: err.message,
          });
        }
      }
      workers.push(...built);
      if (workers.length === 0) {
        throw new PoolError(
          'pool has no workers — every construction failed (check getIdentity / createWorker)',
          { code: 'POOL_CONFIG' },
        );
      }
      logger.info('Pool initialized', {
        size,
        activeSize: workers.length,
        loadBalancer,
        crashLimit,
        cooldownMs,
        taskRetries,
      });
      return pool;
    })();
    return initPromise;
  }

  // Wrap dispatch + dispatchBatch to await init() first. This lets callers use
  // the pool immediately without an explicit await init().
  const _dispatch = dispatch;
  const _dispatchBatch = dispatchBatch;
  const _dispatchBatchSettled = dispatchBatchSettled;
  pool.dispatch = async (task) => {
    await init();
    return _dispatch(task);
  };
  pool.dispatchBatch = async (tasks) => {
    await init();
    return _dispatchBatch(tasks);
  };
  pool.dispatchBatchSettled = async (tasks) => {
    await init();
    return _dispatchBatchSettled(tasks);
  };
  pool.stats = () => {
    // stats works pre-init (returns zeros) so callers can inspect before init.
    if (workers.length === 0) {
      return {
        size,
        activeSize: 0,
        retiredCount: 0,
        loadBalancer,
        dispatchCount,
        requeueCount,
        uptimeMs: clock() - createdAt,
        totals: {
          tasksAttempted: 0,
          tasksCompleted: 0,
          businessesScraped: 0,
          errors: 0,
          blocked: 0,
          crashes: 0,
        },
        perWorker: [],
      };
    }
    return stats();
  };
  pool.init = init;

  return pool;
}

module.exports = {
  createPool,
  PoolError,
  DEFAULT_LOAD_BALANCER,
  DEFAULT_POLL_INTERVAL_MS,
};
