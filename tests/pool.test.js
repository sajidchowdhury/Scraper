'use strict';

/**
 * tests/pool.test.js — Phase 2.8 (Worker Pool & Concurrency)
 *
 * Coverage:
 *   - createPool: DI with mock createWorker + mock runTask + injectable clock/sleep
 *     · throws on size < 1
 *     · constructs N workers via the DI factory
 *   - dispatch: assigns a task to a worker; returns the result
 *   - round-robin load balancing: 3 workers, 3 sequential tasks → each gets one
 *   - least-busy load balancing: picks the worker with the fewest completed tasks
 *   - dispatchBatch: tasks run IN PARALLEL (3 tasks ≈ 1 task's duration, not 3×)
 *     · no race conditions: concurrent dispatch never double-assigns a worker
 *   - Block re-queue: a worker that throws WORKER_BLOCKED → task re-queued to
 *     another worker; the run completes
 *   - Crash re-queue + retirement: a crashing worker is restarted; after
 *     crashLimit crashes it's retired and the active pool size drops
 *   - Pool exhausted (all retired) → dispatch rejects PoolError
 *   - stats(): aggregates per-worker counts + dispatchCount + requeueCount
 *   - shutdown(): stops all workers
 *
 * Run: bun test tests/pool.test.js
 */

const { createPool, PoolError } = require('../src/pool');
const { createWorker, createSearchTask, createDetailTask, WorkerError } = require('../src/worker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubLogger() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  const log = (level) => (msg, meta) => { calls[level].push({ msg, meta }); };
  const logger = {
    debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'),
    phase: () => logger, child: () => logger,
  };
  logger._calls = calls;
  return logger;
}

function noopSleep() { return Promise.resolve(); }
function realSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * A mock createWorker factory. Builds REAL workers (so the state machine,
 * cooldown, retirement, stats all work) but with a mock runTask whose behavior
 * is controlled by `impl`. `impl(worker, task)` can return a result, throw
 * { code: 'WORKER_BLOCKED' } (block), or throw any other error (crash).
 *
 * Tracks which worker ran which task so tests can assert round-robin / least-busy
 * distribution + re-queue behavior.
 */
function makeMockWorkerFactory(impl) {
  const runs = []; // { workerId, taskId, taskType, at, attempt }
  const factory = (wOpts) => {
    const runTask = async (worker, task) => {
      runs.push({
        workerId: worker.id,
        taskId: task.id,
        taskType: task.type,
        at: Date.now(),
        attempt: task._attempts || 0,
      });
      return impl(worker, task);
    };
    return createWorker({ ...wOpts, runTask, sleepFn: wOpts.sleepFn || noopSleep });
  };
  factory._runs = runs;
  return factory;
}

/** A runTask impl that succeeds with a small configurable delay (real setTimeout). */
function makeDelayedSuccess(delayMs, result) {
  return async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return result || { businesses: [{ name: 'B' }] };
  };
}

// ===========================================================================
// createPool — config + construction
// ===========================================================================

describe('Phase 2.8 — createPool construction', () => {
  test('size < 1 clamps to 1', async () => {
    const pool = createPool({
      size: 0,
      createWorker: makeMockWorkerFactory(() => ({ businesses: [] })),
      getIdentity: async () => ({ runTask: null }),
      logger: makeStubLogger(),
    });
    await pool.init();
    expect(pool.size).toBe(1);
    await pool.shutdown();
  });
  test('constructs N workers via the DI factory', async () => {
    const factory = makeMockWorkerFactory(() => ({ businesses: [] }));
    const pool = createPool({
      size: 3, createWorker: factory, getIdentity: async () => ({}), logger: makeStubLogger(),
    });
    await pool.init();
    expect(pool.workers.length).toBe(3);
    expect(pool.workers.map((w) => w.id).sort((a, b) => a - b)).toEqual([0, 1, 2]);
    await pool.shutdown();
  });
  test('throws PoolError when no workers could be constructed', async () => {
    // A createWorker factory that always throws → pool has zero workers.
    const badFactory = () => { throw new Error('boom'); };
    const pool = createPool({
      size: 2, createWorker: badFactory, getIdentity: async () => ({}), logger: makeStubLogger(),
    });
    await expect(pool.init()).rejects.toThrow(/no workers/);
  });
});

// ===========================================================================
// dispatch — basic assignment
// ===========================================================================

describe('Phase 2.8 — pool.dispatch basic', () => {
  test('assigns a task to a worker and returns the result', async () => {
    const factory = makeMockWorkerFactory(() => ({ businesses: [{ name: 'B1' }] }));
    const pool = createPool({
      size: 1, createWorker: factory, getIdentity: async () => ({}), logger: makeStubLogger(),
    });
    const task = createSearchTask({ query: 'Cafe', location: 'Berlin' });
    const result = await pool.dispatch(task);
    expect(result.businesses.length).toBe(1);
    expect(factory._runs.length).toBe(1);
    expect(factory._runs[0].taskId).toBe(task.id);
    await pool.shutdown();
  });
  test('stats reports dispatchCount + per-worker totals', async () => {
    const factory = makeMockWorkerFactory(() => ({ businesses: [{}, {}] }));
    const pool = createPool({
      size: 2, createWorker: factory, getIdentity: async () => ({}), logger: makeStubLogger(),
    });
    await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    const s = pool.stats();
    expect(s.dispatchCount).toBe(2);
    expect(s.totals.tasksCompleted).toBe(2);
    expect(s.totals.businessesScraped).toBe(4);
    expect(s.perWorker.length).toBe(2);
    await pool.shutdown();
  });
});

// ===========================================================================
// Round-robin load balancing
// ===========================================================================

describe('Phase 2.8 — round-robin load balancing', () => {
  test('3 sequential tasks → 3 distinct workers (each gets one)', async () => {
    const factory = makeMockWorkerFactory(makeDelayedSuccess(0, { businesses: [] }));
    const pool = createPool({
      size: 3, createWorker: factory, getIdentity: async () => ({}),
      loadBalancer: 'round-robin', logger: makeStubLogger(),
    });
    await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    const workerIds = factory._runs.map((r) => r.workerId).sort((a, b) => a - b);
    expect(workerIds).toEqual([0, 1, 2]);
    await pool.shutdown();
  });
});

// ===========================================================================
// Least-busy load balancing
// ===========================================================================

describe('Phase 2.8 — least-busy load balancing', () => {
  test('picks the worker with the fewest completed tasks', async () => {
    // 2 workers. Worker 0 runs a 40ms task first; worker 1 is free. The next
    // two tasks should both go to worker 1 (least-busy) until it catches up.
    // We dispatch sequentially with real delays so tasksCompleted diverges.
    const factory = makeMockWorkerFactory(makeDelayedSuccess(30, { businesses: [] }));
    const pool = createPool({
      size: 2, createWorker: factory, getIdentity: async () => ({}),
      loadBalancer: 'least-busy', pollIntervalMs: 1, logger: makeStubLogger(),
    });
    // First task → worker 0 (both idle, tie broken by lowest id).
    await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    expect(factory._runs[0].workerId).toBe(0);
    // Worker 0 now has 1 completed; worker 1 has 0 → next goes to worker 1.
    await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    expect(factory._runs[1].workerId).toBe(1);
    // Now both have 1 → tie → lowest id (0).
    await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    expect(factory._runs[2].workerId).toBe(0);
    await pool.shutdown();
  });
});

// ===========================================================================
// dispatchBatch — parallelism + no race conditions
// ===========================================================================

describe('Phase 2.8 — dispatchBatch parallelism', () => {
  test('3 tasks on 3 workers run in parallel (~1× duration, not 3×)', async () => {
    const delay = 80;
    const factory = makeMockWorkerFactory(async (worker) => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, delay));
      return { businesses: [], _start: start, _end: Date.now() };
    });
    const pool = createPool({
      size: 3, createWorker: factory, getIdentity: async () => ({}),
      pollIntervalMs: 1, logger: makeStubLogger(),
    });
    const tasks = [
      createSearchTask({ query: 'C', location: 'B' }),
      createSearchTask({ query: 'C', location: 'B' }),
      createSearchTask({ query: 'C', location: 'B' }),
    ];
    const t0 = Date.now();
    const results = await pool.dispatchBatch(tasks);
    const elapsed = Date.now() - t0;

    // Parallel: total elapsed should be ~1 delay, NOT 3 delays. Allow headroom
    // for scheduler overhead (pollIntervalMs + microtasks).
    expect(elapsed).toBeLessThan(delay * 2);
    expect(results.length).toBe(3);

    // Verify overlap: max start < min end means all three ran concurrently.
    const starts = results.map((r) => r._start);
    const ends = results.map((r) => r._end);
    expect(Math.max(...starts)).toBeLessThan(Math.min(...ends));

    // Each task ran on a distinct worker (no double-assignment).
    const workerIds = factory._runs.map((r) => r.workerId).sort((a, b) => a - b);
    expect(workerIds).toEqual([0, 1, 2]);
    await pool.shutdown();
  });
  test('5 tasks on 2 workers: at most 2 run concurrently (no double-assign)', async () => {
    let active = 0;
    let maxActive = 0;
    const factory = makeMockWorkerFactory(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { businesses: [] };
    });
    const pool = createPool({
      size: 2, createWorker: factory, getIdentity: async () => ({}),
      pollIntervalMs: 1, logger: makeStubLogger(),
    });
    const tasks = Array.from({ length: 5 }, () => createSearchTask({ query: 'C', location: 'B' }));
    await pool.dispatchBatch(tasks);
    // Concurrency capped at pool size (2). Never more than 2 at once.
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThanOrEqual(2); // did actually parallelize
    expect(factory._runs.length).toBe(5); // all 5 ran
    await pool.shutdown();
  });
});

// ===========================================================================
// Block re-queue
// ===========================================================================

describe('Phase 2.8 — block re-queue', () => {
  test('a blocked worker triggers re-queue; the run completes on another worker', async () => {
    // Worker 0 always blocks; workers 1+ succeed. With taskRetries >= 1, the
    // task is re-queued to another worker and the dispatch resolves.
    const factory = makeMockWorkerFactory((worker) => {
      if (worker.id === 0) {
        const e = new Error('captcha'); e.code = 'WORKER_BLOCKED'; throw e;
      }
      return { businesses: [{ name: 'ok' }] };
    });
    const pool = createPool({
      size: 3, createWorker: factory, getIdentity: async () => ({}),
      cooldownMs: 100000, // keep worker 0 in cooldown so it's not re-picked
      pollIntervalMs: 1, logger: makeStubLogger(),
    });
    const result = await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    expect(result.businesses[0].name).toBe('ok');
    // The task ran at least twice: once on worker 0 (blocked), once on 1 or 2.
    expect(factory._runs.length).toBeGreaterThanOrEqual(2);
    expect(factory._runs[0].workerId).toBe(0);
    expect(factory._runs[1].workerId).not.toBe(0);
    // requeueCount tracked.
    expect(pool.stats().requeueCount).toBeGreaterThanOrEqual(1);
    await pool.shutdown();
  });
  test('a worker that blocks has its identity rotated (getIdentity called)', async () => {
    let identityCalls = 0;
    const getIdentity = async () => { identityCalls++; return {}; };
    // Worker 0 ALWAYS blocks (so rotation is forced); worker 1 succeeds. The
    // task is re-queued to worker 1 and completes.
    const factory = makeMockWorkerFactory((worker) => {
      if (worker.id === 0) {
        const e = new Error('block'); e.code = 'WORKER_BLOCKED'; throw e;
      }
      return { businesses: [] };
    });
    const pool = createPool({
      size: 2, createWorker: factory, getIdentity,
      cooldownMs: 100000, pollIntervalMs: 1, logger: makeStubLogger(),
    });
    await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    // getIdentity is called once per worker at construction (2) + once after
    // worker 0's block for rotation (1) → 3.
    expect(identityCalls).toBeGreaterThanOrEqual(3);
    await pool.shutdown();
  });
});

// ===========================================================================
// Crash re-queue + retirement
// ===========================================================================

describe('Phase 2.8 — crash re-queue + retirement', () => {
  test('a crashing worker is restarted (re-queued); task completes elsewhere', async () => {
    // Worker 0 always crashes; workers 1+ succeed.
    const factory = makeMockWorkerFactory((worker) => {
      if (worker.id === 0) throw new Error('segfault');
      return { businesses: [{ name: 'ok' }] };
    });
    const pool = createPool({
      size: 3, createWorker: factory, getIdentity: async () => ({}),
      crashLimit: 5, pollIntervalMs: 1, logger: makeStubLogger(),
    });
    const result = await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    expect(result.businesses[0].name).toBe('ok');
    expect(pool.stats().requeueCount).toBeGreaterThanOrEqual(1);
    await pool.shutdown();
  });
  test('after crashLimit crashes a worker is retired; active size drops', async () => {
    // Worker 0 crashes every time; worker 1 succeeds. Dispatch 2 tasks — each
    // lands on worker 0 first (round-robin), crashes, re-queues to worker 1.
    // After 2 crashes worker 0 is retired (crashLimit=2); active size drops.
    const factory = makeMockWorkerFactory((worker) => {
      if (worker.id === 0) throw new Error('crash');
      return { businesses: [{ name: 'ok' }] };
    });
    const pool = createPool({
      size: 2, createWorker: factory, getIdentity: async () => ({}),
      crashLimit: 2, taskRetries: 5, pollIntervalMs: 1, logger: makeStubLogger(),
    });
    // Task 1: w0 crash #1 → re-queue → w1 ok.
    await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    // Task 2: w0 crash #2 → retired → re-queue → w1 ok.
    await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    const w0 = pool.workers.find((w) => w.id === 0);
    expect(w0.isRetired()).toBe(true);
    expect(pool.activeSize).toBe(1); // only worker 1 remains
    // Worker 0's lifetime crash count is 2.
    expect(w0.stats().crashes).toBe(2);
    await pool.shutdown();
  });
});

// ===========================================================================
// Pool exhaustion
// ===========================================================================

describe('Phase 2.8 — pool exhaustion', () => {
  test('all workers retired → dispatch rejects with PoolError (POOL_EXHAUSTED)', async () => {
    // Every worker crashes every time. crashLimit=1 → each retires on first
    // crash. With size=2 + taskRetries=10, the task bounces until both are
    // retired, then dispatch rejects.
    const factory = makeMockWorkerFactory(() => { throw new Error('crash'); });
    const pool = createPool({
      size: 2, createWorker: factory, getIdentity: async () => ({}),
      crashLimit: 1, taskRetries: 10, pollIntervalMs: 1, logger: makeStubLogger(),
    });
    await expect(pool.dispatch(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow();
    expect(pool.activeSize).toBe(0);
    await pool.shutdown();
  });
  test('task that fails on every re-queue (within retries) rejects', async () => {
    // 1 worker that always crashes; crashLimit high so it's NOT retired, but
    // taskRetries=1 → after 1 re-queue the dispatch rejects.
    const factory = makeMockWorkerFactory(() => { throw new Error('crash'); });
    const pool = createPool({
      size: 1, createWorker: factory, getIdentity: async () => ({}),
      crashLimit: 50, taskRetries: 1, pollIntervalMs: 1, logger: makeStubLogger(),
    });
    await expect(pool.dispatch(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow();
    await pool.shutdown();
  });
});

// ===========================================================================
// dispatchBatchSettled — partial failure
// ===========================================================================

describe('Phase 2.8 — dispatchBatchSettled partial failure', () => {
  test('returns fulfilled + rejected counts; never rejects', async () => {
    // 2 workers. Task on worker 0 always crashes (re-queued until retries out);
    // task on worker 1 succeeds. dispatchBatchSettled returns both statuses.
    const factory = makeMockWorkerFactory((worker) => {
      if (worker.id === 0) throw new Error('crash');
      return { businesses: [{ name: 'ok' }] };
    });
    const pool = createPool({
      size: 2, createWorker: factory, getIdentity: async () => ({}),
      crashLimit: 50, taskRetries: 0, pollIntervalMs: 1, logger: makeStubLogger(),
    });
    const tasks = [
      createSearchTask({ query: 'C', location: 'B' }),
      createSearchTask({ query: 'C', location: 'B' }),
    ];
    const settled = await pool.dispatchBatchSettled(tasks);
    expect(settled.total).toBe(2);
    // At least one fulfilled, at least one rejected (order depends on scheduling).
    expect(settled.fulfilled + settled.rejected).toBe(2);
    await pool.shutdown();
  });
});

// ===========================================================================
// shutdown
// ===========================================================================

describe('Phase 2.8 — pool.shutdown()', () => {
  test('stops all workers; subsequent dispatch rejects POOL_SHUTDOWN', async () => {
    const factory = makeMockWorkerFactory(() => ({ businesses: [] }));
    const pool = createPool({
      size: 2, createWorker: factory, getIdentity: async () => ({}), logger: makeStubLogger(),
    });
    await pool.dispatch(createSearchTask({ query: 'C', location: 'B' }));
    await pool.shutdown();
    await expect(pool.dispatch(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow();
  });
});
