'use strict';

/**
 * tests/worker.test.js — Phase 2.8 (Worker Pool & Concurrency)
 *
 * Coverage:
 *   - createWorker: DI with mock runTask + injectable clock/sleep
 *     · throws WorkerError when id or runTask missing
 *     · returns the expected interface (run, isHealthy, isAvailable, markBlocked,
 *       markCrashed, rotateIdentity, stats, shutdown)
 *     · run(task) calls runTask(worker, task) and returns the result
 *     · run accumulates businessesScraped from { businesses: [...] } / { count } / array
 *     · run resets consecutiveErrors on success
 *   - Block signal (runTask throws { code: 'WORKER_BLOCKED' }):
 *     · worker.run increments `blocked`, enters cooldown, re-throws tagged
 *     · isAvailable false during cooldown; true after cooldown elapses (clock)
 *     · blocked count + consecutiveErrors tracked
 *   - Crash (any other thrown error):
 *     · worker.run increments errors + crashes, re-throws tagged WORKER_CRASHED
 *     · after crashLimit crashes in the window → retired (isHealthy false)
 *     · crash window pruning (old crashes don't count)
 *   - rotateIdentity swaps proxy/fingerprint/sessionManager
 *   - stats() returns all expected fields
 *   - shutdown() sets state='retired' + returns final stats
 *   - run on a retired/busy/cooldown worker throws the right code
 *
 * Run: bun test tests/worker.test.js
 */

const {
  createWorker,
  createSearchTask,
  createDetailTask,
  createResumeTask,
  validateTask,
  WorkerError,
  DEFAULT_CRASH_LIMIT,
  DEFAULT_COOLDOWN_MS,
} = require('../src/worker');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubLogger() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  const log = (level) => (msg, meta) => { calls[level].push({ msg, meta }); };
  const logger = {
    debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'),
    phase: () => logger,
    child: () => logger,
  };
  logger._calls = calls;
  return logger;
}

// A stepping clock for deterministic cooldown/crash-window tests.
function makeSteppingClock(start, step) {
  let t = start;
  return () => { const v = t; t += step; return v; };
}

function noopSleep() { return Promise.resolve(); }

// A mock runTask that resolves with a configurable result. Tests override
// `impl` to simulate success/block/crash.
function makeMockRunTask(impl) {
  const calls = [];
  const fn = async (worker, task) => {
    calls.push({ workerId: worker.id, taskId: task.id, taskType: task.type, at: Date.now() });
    if (typeof impl === 'function') return impl(worker, task);
    return { businesses: [{ name: 'B1' }, { name: 'B2' }] };
  };
  fn._calls = calls;
  fn._setImpl = (newImpl) => { impl = newImpl; };
  return fn;
}

// ===========================================================================
// createWorker — config + validation
// ===========================================================================

describe('Phase 2.8 — createWorker DI + validation', () => {
  test('throws WorkerError when id is missing', () => {
    expect(() => createWorker({ runTask: () => {} })).toThrow(WorkerError);
    expect(() => createWorker({ runTask: () => {} })).toThrow(/id/);
  });
  test('throws WorkerError when runTask is missing', () => {
    expect(() => createWorker({ id: 0 })).toThrow(WorkerError);
    expect(() => createWorker({ id: 0 })).toThrow(/runTask/);
  });
  test('returns the expected interface', () => {
    const w = createWorker({ id: 0, runTask: () => {}, logger: makeStubLogger() });
    expect(typeof w.run).toBe('function');
    expect(typeof w.isHealthy).toBe('function');
    expect(typeof w.isAvailable).toBe('function');
    expect(typeof w.isRetired).toBe('function');
    expect(typeof w.markBlocked).toBe('function');
    expect(typeof w.markCrashed).toBe('function');
    expect(typeof w.rotateIdentity).toBe('function');
    expect(typeof w.stats).toBe('function');
    expect(typeof w.shutdown).toBe('function');
    expect(w.id).toBe(0);
  });
  test('uses DEFAULT_CRASH_LIMIT=3 + DEFAULT_COOLDOWN_MS=300000 when omitted', () => {
    expect(DEFAULT_CRASH_LIMIT).toBe(3);
    expect(DEFAULT_COOLDOWN_MS).toBe(300000);
  });
});

// ===========================================================================
// run — success path
// ===========================================================================

describe('Phase 2.8 — worker.run success path', () => {
  test('calls runTask(worker, task) and returns the result', async () => {
    const runTask = makeMockRunTask();
    const w = createWorker({ id: 0, runTask, logger: makeStubLogger() });
    const task = createSearchTask({ query: 'Cafe', location: 'Berlin' });
    const result = await w.run(task);
    expect(runTask._calls.length).toBe(1);
    expect(runTask._calls[0].workerId).toBe(0);
    expect(runTask._calls[0].taskId).toBe(task.id);
    expect(result.businesses.length).toBe(2);
  });
  test('increments tasksAttempted + tasksCompleted on success', async () => {
    const w = createWorker({ id: 0, runTask: makeMockRunTask(), logger: makeStubLogger() });
    await w.run(createSearchTask({ query: 'Cafe', location: 'Berlin' }));
    await w.run(createSearchTask({ query: 'Bar', location: 'Berlin' }));
    const s = w.stats();
    expect(s.tasksAttempted).toBe(2);
    expect(s.tasksCompleted).toBe(2);
    expect(s.errors).toBe(0);
  });
  test('accumulates businessesScraped from { businesses: [...] } result', async () => {
    const runTask = makeMockRunTask(() => ({ businesses: [{}, {}, {}, {}] }));
    const w = createWorker({ id: 0, runTask, logger: makeStubLogger() });
    await w.run(createSearchTask({ query: 'Cafe', location: 'Berlin' }));
    expect(w.stats().businessesScraped).toBe(4);
  });
  test('accumulates businessesScraped from { count: n } result', async () => {
    const runTask = makeMockRunTask(() => ({ count: 7 }));
    const w = createWorker({ id: 0, runTask, logger: makeStubLogger() });
    await w.run(createSearchTask({ query: 'Cafe', location: 'Berlin' }));
    expect(w.stats().businessesScraped).toBe(7);
  });
  test('accumulates businessesScraped from a bare array result', async () => {
    const runTask = makeMockRunTask(() => [{}, {}, {}]);
    const w = createWorker({ id: 0, runTask, logger: makeStubLogger() });
    await w.run(createSearchTask({ query: 'Cafe', location: 'Berlin' }));
    expect(w.stats().businessesScraped).toBe(3);
  });
  test('resets consecutiveErrors on success after failures', async () => {
    let call = 0;
    const runTask = makeMockRunTask(() => {
      call++;
      if (call === 1) throw Object.assign(new Error('boom'), { code: 'CRASH' });
      return { businesses: [] };
    });
    const w = createWorker({ id: 0, runTask, crashLimit: 5, logger: makeStubLogger() });
    await expect(w.run(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow(/boom/);
    expect(w.stats().consecutiveErrors).toBe(1);
    await w.run(createSearchTask({ query: 'C', location: 'B' }));
    expect(w.stats().consecutiveErrors).toBe(0);
  });
  test('state transitions idle → busy → idle across run', async () => {
    let observedState;
    const runTask = makeMockRunTask((worker) => {
      observedState = worker.state;
      return { businesses: [] };
    });
    const w = createWorker({ id: 0, runTask, logger: makeStubLogger() });
    expect(w.state).toBe('idle');
    await w.run(createSearchTask({ query: 'C', location: 'B' }));
    expect(observedState).toBe('busy');
    expect(w.state).toBe('idle');
  });
});

// ===========================================================================
// Block signal
// ===========================================================================

describe('Phase 2.8 — worker block signal (WORKER_BLOCKED)', () => {
  test('run re-throws + increments blocked + enters cooldown', async () => {
    const runTask = makeMockRunTask(() => {
      const e = new Error('captcha');
      e.code = 'WORKER_BLOCKED';
      throw e;
    });
    const w = createWorker({ id: 0, runTask, cooldownMs: 1000, logger: makeStubLogger() });
    await expect(w.run(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow(/captcha/);
    const s = w.stats();
    expect(s.blocked).toBe(1);
    expect(s.state).toBe('cooldown');
    expect(s.cooldownRemainingMs).toBeGreaterThan(0);
  });
  test('isAvailable false during cooldown; true after cooldown elapses (clock)', async () => {
    // A controllable clock: we mutate `now` to advance time deterministically.
    let now = 1000;
    const clock = () => now;
    const runTask = makeMockRunTask(() => {
      const e = new Error('block');
      e.code = 'WORKER_BLOCKED';
      throw e;
    });
    const w = createWorker({
      id: 0, runTask, cooldownMs: 5000, clock, sleepFn: noopSleep, logger: makeStubLogger(),
    });
    await expect(w.run(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow();
    expect(w.isAvailable()).toBe(false);
    expect(w.state).toBe('cooldown');
    // Advance the clock past the cooldown (5000ms).
    now += 6000;
    expect(w.isAvailable()).toBe(true);
    expect(w.state).toBe('idle');
  });
  test('consecutiveErrors increments on block', async () => {
    const runTask = makeMockRunTask(() => {
      const e = new Error('block'); e.code = 'WORKER_BLOCKED'; throw e;
    });
    const w = createWorker({
      id: 0, runTask, cooldownMs: 0, clock: makeSteppingClock(1000, 0),
      sleepFn: noopSleep, logger: makeStubLogger(),
    });
    await expect(w.run(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow();
    expect(w.stats().consecutiveErrors).toBe(1);
  });
});

// ===========================================================================
// Crash + retirement
// ===========================================================================

describe('Phase 2.8 — worker crash + retirement', () => {
  test('run re-throws + increments errors + crashes; tags WORKER_CRASHED', async () => {
    const runTask = makeMockRunTask(() => { throw new Error('segfault'); });
    const w = createWorker({ id: 0, runTask, crashLimit: 5, logger: makeStubLogger() });
    let caught;
    try { await w.run(createSearchTask({ query: 'C', location: 'B' })); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('WORKER_CRASHED');
    expect(w.stats().errors).toBe(1);
    expect(w.stats().crashes).toBe(1);
  });
  test('worker retires after crashLimit crashes in the window', async () => {
    const runTask = makeMockRunTask(() => { throw new Error('crash'); });
    const clock = makeSteppingClock(1000, 100); // 100ms per call, well within the 10-min window
    const w = createWorker({
      id: 0, runTask, crashLimit: 3, crashWindowMs: 600000, clock, sleepFn: noopSleep,
      logger: makeStubLogger(),
    });
    expect(w.isHealthy()).toBe(true);
    await expect(w.run(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow();
    await expect(w.run(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow();
    expect(w.isHealthy()).toBe(true); // 2 crashes, not yet retired
    await expect(w.run(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow();
    expect(w.isRetired()).toBe(true); // 3rd crash → retired
    expect(w.isHealthy()).toBe(false);
    expect(w.state).toBe('retired');
  });
  test('run on a retired worker throws WORKER_RETIRED', async () => {
    const runTask = makeMockRunTask(() => { throw new Error('crash'); });
    const w = createWorker({
      id: 0, runTask, crashLimit: 1, clock: makeSteppingClock(1000, 0),
      sleepFn: noopSleep, logger: makeStubLogger(),
    });
    await expect(w.run(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow();
    await expect(w.run(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow(/retired/);
  });
  test('old crashes outside the window are pruned (not retired)', async () => {
    const runTask = makeMockRunTask(() => { throw new Error('crash'); });
    // Clock we can jump manually: 3 crashes spaced 10 minutes apart (each
    // outside the 5-min window) → never 3-in-window → never retired.
    let t = 1000;
    const clock = () => t;
    const w = createWorker({
      id: 0, runTask, crashLimit: 3, crashWindowMs: 300000, clock, sleepFn: noopSleep,
      logger: makeStubLogger(),
    });
    await expect(w.run(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow();
    t += 400000; // 400s later (> 5min window)
    await expect(w.run(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow();
    t += 400000;
    await expect(w.run(createSearchTask({ query: 'C', location: 'B' }))).rejects.toThrow();
    expect(w.isRetired()).toBe(false); // each crash was alone in its window
    expect(w.stats().crashes).toBe(3); // lifetime count still 3
    expect(w.stats().crashCountInWindow).toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// rotateIdentity
// ===========================================================================

describe('Phase 2.8 — rotateIdentity', () => {
  test('swaps proxy + fingerprint + sessionManager', () => {
    const w = createWorker({ id: 0, runTask: () => {}, logger: makeStubLogger() });
    expect(w.proxy).toBeNull();
    expect(w.fingerprint).toBeNull();
    w.rotateIdentity({
      proxy: { id: 'p1', server: 'http://1.2.3.4:8080' },
      fingerprint: { userAgent: 'UA1', platform: 'Win32' },
      sessionManager: { id: 'sm1' },
    });
    expect(w.proxy.id).toBe('p1');
    expect(w.fingerprint.userAgent).toBe('UA1');
    expect(w.sessionManager.id).toBe('sm1');
  });
  test('stats reflects the rotated proxyId', () => {
    const w = createWorker({ id: 0, runTask: () => {}, logger: makeStubLogger() });
    w.rotateIdentity({ proxy: { id: 'p42', server: 'http://x:1' } });
    expect(w.stats().proxyId).toBe('p42');
  });
});

// ===========================================================================
// stats
// ===========================================================================

describe('Phase 2.8 — worker.stats()', () => {
  test('returns all expected fields with correct initial values', () => {
    const w = createWorker({ id: 7, runTask: () => {}, logger: makeStubLogger() });
    const s = w.stats();
    expect(s.workerId).toBe(7);
    expect(s.state).toBe('idle');
    expect(s.retired).toBe(false);
    expect(s.tasksAttempted).toBe(0);
    expect(s.tasksCompleted).toBe(0);
    expect(s.businessesScraped).toBe(0);
    expect(s.errors).toBe(0);
    expect(s.blocked).toBe(0);
    expect(s.crashes).toBe(0);
    expect(s.consecutiveErrors).toBe(0);
    expect(s.crashLimit).toBe(3);
    expect(s.cooldownRemainingMs).toBe(0);
    expect(s.proxyId).toBeNull();
    expect(s.fingerprint).toBeNull();
    expect(s.lastError).toBeNull();
    expect(typeof s.uptimeMs).toBe('number');
  });
});

// ===========================================================================
// shutdown
// ===========================================================================

describe('Phase 2.8 — worker.shutdown()', () => {
  test('sets state=retired + returns final stats', async () => {
    const runTask = makeMockRunTask(() => ({ businesses: [{}, {}] }));
    const w = createWorker({ id: 0, runTask, logger: makeStubLogger() });
    await w.run(createSearchTask({ query: 'C', location: 'B' }));
    const final = await w.shutdown();
    expect(w.state).toBe('retired');
    expect(final.tasksCompleted).toBe(1);
    expect(final.businessesScraped).toBe(2);
  });
  test('releases the session manager (best-effort)', async () => {
    let released = false;
    const w = createWorker({
      id: 0, runTask: () => {}, logger: makeStubLogger(),
      sessionManager: { release: async () => { released = true; } },
    });
    await w.shutdown();
    expect(released).toBe(true);
  });
});

// ===========================================================================
// Task helpers
// ===========================================================================

describe('Phase 2.8 — task helpers (serializable descriptors)', () => {
  test('createSearchTask builds a valid search-task', () => {
    const t = createSearchTask({ query: 'Cafe', location: 'Berlin', maxResults: 50 });
    expect(t.type).toBe('search-task');
    expect(t.query).toBe('Cafe');
    expect(t.location).toBe('Berlin');
    expect(t.maxResults).toBe(50);
    expect(typeof t.id).toBe('string');
    expect(validateTask(t)).toEqual([]);
  });
  test('createDetailTask builds a valid detail-task', () => {
    const t = createDetailTask({ businesses: [{ name: 'B1' }] });
    expect(t.type).toBe('detail-task');
    expect(t.businesses.length).toBe(1);
    expect(validateTask(t)).toEqual([]);
  });
  test('createResumeTask builds a valid resume-task', () => {
    const t = createResumeTask({ checkpoint: { businesses: [] } });
    expect(t.type).toBe('resume-task');
    // resume-task reuses search-task validation (needs query+location)
    const t2 = createResumeTask({ checkpoint: {}, opts: { query: 'C', location: 'B' } });
    t2.query = 'C'; t2.location = 'B';
    expect(validateTask(t2)).toEqual([]);
  });
  test('tasks are JSON-serializable (persistable to the Phase 2.9 queue)', () => {
    const t = createSearchTask({ query: 'Cafe', location: 'Berlin' });
    expect(() => JSON.parse(JSON.stringify(t))).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(t));
    expect(parsed.type).toBe('search-task');
    expect(parsed.query).toBe('Cafe');
  });
  test('validateTask rejects bad types + missing fields', () => {
    expect(validateTask(null).length).toBeGreaterThan(0);
    expect(validateTask({ id: 'x', type: 'bogus' }).length).toBeGreaterThan(0);
    expect(validateTask({ id: 'x', type: 'search-task' }).length).toBeGreaterThan(0); // no query/location
    expect(validateTask({ id: 'x', type: 'detail-task', businesses: 'notarray' }).length).toBeGreaterThan(0);
  });
  test('each task gets a unique id', () => {
    const a = createSearchTask({ query: 'C', location: 'B' });
    const b = createSearchTask({ query: 'C', location: 'B' });
    expect(a.id).not.toBe(b.id);
  });
});
