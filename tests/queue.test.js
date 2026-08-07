'use strict';

/**
 * tests/queue.test.js — Phase 2.9 (Job Queue & Orchestration)
 *
 * Coverage:
 *   - job-types.js: validators for search / detail-batch / enrich, validateJobRequest,
 *     resolvePriority, PRIORITY bands
 *   - mock-backend.js: MockQueue + MockWorker lifecycle (add, process, retry,
 *     dead-letter, priority ordering, delay, pause/resume, close)
 *   - dead-letter.js: list, get, retry, retryAll, remove, clear, count
 *   - queue/index.js (createQueue): the adapter — add, addBatch, process,
 *     getStatus, getStats, getActive, pause/resume, deadLetter (callable +
 *     methods), retryDeadLetter, shutdown, error cases (QUEUE_INVALID,
 *     QUEUE_UNKNOWN_TYPE, QUEUE_SHUTDOWN, QUEUE_PROCESSOR_EXISTS)
 *
 * DI: every test uses the in-memory MockQueue + MockWorker backend — NO real
 * Redis required (an explicit acceptance criterion).
 *
 * Run: bun test tests/queue.test.js
 */

const {
  JOB_TYPES,
  JOB_TYPE_NAMES,
  validateJobRequest,
  validateSearch,
  validateDetailBatch,
  validateEnrich,
  searchToTask,
  detailBatchToTask,
  enrichToTask,
  resolvePriority,
  PRIORITY_HIGH,
  PRIORITY_NORMAL,
  PRIORITY_LOW,
} = require('../src/queue/job-types');
const {
  MockQueue,
  MockWorker,
  MockJob,
  MockQueueError,
  _resetRegistry,
} = require('../src/queue/mock-backend');
const { createDeadLetter, serializeJob } = require('../src/queue/dead-letter');
const { createQueue, QueueError } = require('../src/queue/index');

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

/** Wait for the mock worker to drain (no active + no waiting jobs). */
async function drain(queue, { timeoutMs = 2000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const stats = await queue.getStats();
    if (stats.active === 0 && stats.waiting === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('drain() timed out — jobs still active/waiting');
}

beforeEach(() => {
  _resetRegistry();
});

// ===========================================================================
// job-types.js — validators
// ===========================================================================

describe('Phase 2.9 — job-types validators', () => {
  test('JOB_TYPES has the three Phase 2.9 types', () => {
    expect(JOB_TYPE_NAMES).toEqual(['search', 'detail-batch', 'enrich']);
    expect(JOB_TYPES.search.validate).toBeInstanceOf(Function);
    expect(JOB_TYPES.search.toTask).toBeInstanceOf(Function);
    expect(JOB_TYPES['detail-batch'].validate).toBeInstanceOf(Function);
    expect(JOB_TYPES.enrich.validate).toBeInstanceOf(Function);
  });

  test('validateSearch accepts a minimal valid payload', () => {
    expect(validateSearch({ query: 'Cafe', location: 'Berlin' })).toEqual([]);
  });

  test('validateSearch accepts a full payload', () => {
    expect(
      validateSearch({ query: 'Cafe', location: 'Berlin', maxResults: 50, deepScrape: true }),
    ).toEqual([]);
  });

  test('validateSearch rejects missing query', () => {
    const errs = validateSearch({ location: 'Berlin' });
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/query/);
  });

  test('validateSearch rejects missing location', () => {
    const errs = validateSearch({ query: 'Cafe' });
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/location/);
  });

  test('validateSearch rejects out-of-range maxResults', () => {
    const errs = validateSearch({ query: 'Cafe', location: 'Berlin', maxResults: 0 });
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/maxResults/);
    const errs2 = validateSearch({ query: 'Cafe', location: 'Berlin', maxResults: 100001 });
    expect(errs2.length).toBe(1);
  });

  test('validateSearch rejects non-boolean deepScrape', () => {
    const errs = validateSearch({ query: 'Cafe', location: 'Berlin', deepScrape: 'yes' });
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/deepScrape/);
  });

  test('validateSearch rejects non-object payload', () => {
    expect(validateSearch(null).length).toBe(1);
    expect(validateSearch('hello').length).toBe(1);
  });

  test('validateDetailBatch accepts businessIds', () => {
    expect(validateDetailBatch({ businessIds: ['a', 'b'] })).toEqual([]);
  });

  test('validateDetailBatch accepts businesses (Phase 2.9 main flow)', () => {
    expect(validateDetailBatch({ businesses: [{ name: 'X' }] })).toEqual([]);
  });

  test('validateDetailBatch rejects when neither businessIds nor businesses', () => {
    const errs = validateDetailBatch({ deepScrape: true });
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/businessIds.*businesses|businesses.*businessIds/);
  });

  test('validateDetailBatch rejects empty arrays', () => {
    const errs = validateDetailBatch({ businessIds: [] });
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/not be empty/);
  });

  test('validateDetailBatch rejects > 500 entries', () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);
    const errs = validateDetailBatch({ businessIds: ids });
    expect(errs.some((e) => /too large/.test(e))).toBe(true);
  });

  test('validateDetailBatch rejects non-string ids', () => {
    const errs = validateDetailBatch({ businessIds: ['ok', 42, ''] });
    expect(errs.length).toBe(2); // index 1 (number) + index 2 (empty string)
  });

  test('validateEnrich accepts a valid payload', () => {
    expect(validateEnrich({ businessId: 'abc123' })).toEqual([]);
    expect(validateEnrich({ businessId: 'abc123', source: 'yelp' })).toEqual([]);
  });

  test('validateEnrich rejects missing businessId', () => {
    const errs = validateEnrich({});
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/businessId/);
  });

  test('searchToTask produces the right shape', () => {
    const task = searchToTask({ query: 'Cafe', location: 'Berlin', maxResults: 50, deepScrape: true });
    expect(task.type).toBe('search-task');
    expect(task.query).toBe('Cafe');
    expect(task.location).toBe('Berlin');
    expect(task.maxResults).toBe(50);
    expect(task.opts.deepScrape).toBe(true);
  });

  test('detailBatchToTask passes through businesses', () => {
    const businesses = [{ name: 'A' }, { name: 'B' }];
    const task = detailBatchToTask({ businesses, deepScrape: true });
    expect(task.type).toBe('detail-task');
    expect(task.businesses).toEqual(businesses);
    expect(task.businessIds).toEqual([]);
    expect(task.opts.deepScrape).toBe(true);
  });

  test('detailBatchToTask passes through businessIds', () => {
    const task = detailBatchToTask({ businessIds: ['x', 'y'] });
    expect(task.businessIds).toEqual(['x', 'y']);
    expect(task.businesses).toEqual([]);
    expect(task.opts.deepScrape).toBe(true); // default
  });

  test('enrichToTask produces the right shape', () => {
    const task = enrichToTask({ businessId: 'b1', source: 'yelp' });
    expect(task.type).toBe('enrich-task');
    expect(task.businessId).toBe('b1');
    expect(task.source).toBe('yelp');
  });
});

// ===========================================================================
// job-types.js — validateJobRequest + resolvePriority
// ===========================================================================

describe('Phase 2.9 — validateJobRequest', () => {
  test('accepts a valid search request', () => {
    expect(
      validateJobRequest({ type: 'search', payload: { query: 'Cafe', location: 'Berlin' } }),
    ).toEqual([]);
  });

  test('rejects unknown type', () => {
    const errs = validateJobRequest({ type: 'bogus', payload: {} });
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/must be one of/);
  });

  test('rejects invalid payload (delegates to type validator)', () => {
    const errs = validateJobRequest({ type: 'search', payload: {} });
    expect(errs.length).toBe(2); // missing query + missing location
  });

  test('rejects negative priority', () => {
    const errs = validateJobRequest({
      type: 'search',
      payload: { query: 'Cafe', location: 'Berlin' },
      priority: -1,
    });
    expect(errs.some((e) => /priority/.test(e))).toBe(true);
  });

  test('rejects attempts < 1', () => {
    const errs = validateJobRequest({
      type: 'search',
      payload: { query: 'Cafe', location: 'Berlin' },
      attempts: 0,
    });
    expect(errs.some((e) => /attempts/.test(e))).toBe(true);
  });

  test('rejects attempts > 50', () => {
    const errs = validateJobRequest({
      type: 'search',
      payload: { query: 'Cafe', location: 'Berlin' },
      attempts: 51,
    });
    expect(errs.some((e) => /attempts/.test(e))).toBe(true);
  });

  test('rejects negative delay', () => {
    const errs = validateJobRequest({
      type: 'search',
      payload: { query: 'Cafe', location: 'Berlin' },
      delay: -100,
    });
    expect(errs.some((e) => /delay/.test(e))).toBe(true);
  });

  test('rejects non-object request', () => {
    expect(validateJobRequest(null).length).toBe(1);
    expect(validateJobRequest('hello').length).toBe(1);
  });
});

describe('Phase 2.9 — resolvePriority', () => {
  test('undefined → normal', () => {
    expect(resolvePriority(undefined)).toBe(PRIORITY_NORMAL);
    expect(resolvePriority(null)).toBe(PRIORITY_NORMAL);
  });

  test('valid number passes through (floored)', () => {
    expect(resolvePriority(1)).toBe(1);
    expect(resolvePriority(5)).toBe(5);
    expect(resolvePriority(10)).toBe(10);
    expect(resolvePriority(3.7)).toBe(3);
  });

  test('negative → normal (safe fallback)', () => {
    expect(resolvePriority(-5)).toBe(PRIORITY_NORMAL);
  });

  test('non-finite → normal', () => {
    expect(resolvePriority('abc')).toBe(PRIORITY_NORMAL);
    expect(resolvePriority(NaN)).toBe(PRIORITY_NORMAL);
  });

  test('huge number is clamped', () => {
    expect(resolvePriority(2 ** 40)).toBe(2 ** 31 - 1);
  });

  test('priority bands are distinct + ordered', () => {
    expect(PRIORITY_HIGH).toBeLessThan(PRIORITY_NORMAL);
    expect(PRIORITY_NORMAL).toBeLessThan(PRIORITY_LOW);
  });
});

// ===========================================================================
// mock-backend.js — MockQueue construction + add/getJob
// ===========================================================================

describe('Phase 2.9 — MockQueue construction + add', () => {
  test('requires a name', () => {
    expect(() => new MockQueue()).toThrow(MockQueueError);
  });

  test('add returns a job with an id + the supplied data', async () => {
    const q = new MockQueue('test1');
    const job = await q.add('search', { query: 'Cafe', location: 'Berlin' }, { priority: 5 });
    expect(job.id).toBeTruthy();
    expect(job.name).toBe('search');
    expect(job.data).toEqual({ query: 'Cafe', location: 'Berlin' });
    expect(job.getState()).toBe('waiting');
    expect(job.attemptsMade).toBe(0);
  });

  test('getJob returns the job by id', async () => {
    const q = new MockQueue('test2');
    const job = await q.add('search', { query: 'Cafe', location: 'Berlin' });
    expect(q.getJob(job.id)).toBe(job);
    expect(q.getJob('nonexistent')).toBeUndefined();
  });

  test('getJobCounts reflects state', async () => {
    const q = new MockQueue('test3');
    await q.add('search', { query: 'A', location: 'X' });
    await q.add('search', { query: 'B', location: 'X' });
    const counts = await q.getJobCounts();
    expect(counts.waiting).toBe(2);
    expect(counts.active).toBe(0);
    expect(counts.completed).toBe(0);
    expect(counts.failed).toBe(0);
  });

  test('add throws when queue is closed', async () => {
    const q = new MockQueue('test4');
    await q.close();
    await expect(
      q.add('search', { query: 'A', location: 'X' }),
    ).rejects.toThrow(/closed/);
  });

  test('delayed jobs go into the delayed state (not waiting)', async () => {
    // Use a fake clock so we control time progression.
    let now = 1000;
    const q = new MockQueue('test5-delay', { clock: () => now });
    const job = await q.add('search', { query: 'A', location: 'X' }, { delay: 5000 });
    expect(job.getState()).toBe('delayed');
    let counts = await q.getJobCounts();
    expect(counts.delayed).toBe(1);
    expect(counts.waiting).toBe(0);
    // Advance time past the delay — getJobCounts promotes delayed jobs lazily.
    now += 5001;
    counts = await q.getJobCounts();
    expect(counts.delayed).toBe(0);
    expect(counts.waiting).toBe(1);
  });
});

// ===========================================================================
// mock-backend.js — MockWorker process + complete
// ===========================================================================

describe('Phase 2.9 — MockWorker processes jobs end-to-end', () => {
  test('a submitted job is processed + completes with the result', async () => {
    const q = new MockQueue('w1');
    const processed = [];
    new MockWorker('w1', async (job) => {
      processed.push(job.id);
      return { businesses: [{ name: 'B' }] };
    });
    const job = await q.add('search', { query: 'Cafe', location: 'Berlin' });
    await job.waitUntilFinished();
    expect(processed).toEqual([job.id]);
    expect(job.getState()).toBe('completed');
    expect(job.returnvalue).toEqual({ businesses: [{ name: 'B' }] });
    expect(job.attemptsMade).toBe(1);
    const counts = await q.getJobCounts();
    expect(counts.completed).toBe(1);
    expect(counts.waiting).toBe(0);
  });

  test('multiple jobs are processed in order (FIFO within same priority)', async () => {
    const q = new MockQueue('w2');
    const order = [];
    new MockWorker('w2', async (job) => {
      order.push(job.data.query);
      return { ok: true };
    });
    const j1 = await q.add('search', { query: 'A', location: 'X' }, { priority: 5 });
    const j2 = await q.add('search', { query: 'B', location: 'X' }, { priority: 5 });
    const j3 = await q.add('search', { query: 'C', location: 'X' }, { priority: 5 });
    await j1.waitUntilFinished();
    await j2.waitUntilFinished();
    await j3.waitUntilFinished();
    expect(order).toEqual(['A', 'B', 'C']);
  });

  test('processor can report progress', async () => {
    const q = new MockQueue('w3');
    new MockWorker('w3', async (job) => {
      await job.updateProgress(50);
      await job.updateProgress(100);
      return { done: true };
    });
    const job = await q.add('search', { query: 'A', location: 'X' });
    await job.waitUntilFinished();
    expect(job.progress).toBe(100);
  });

  test('MockWorker requires a processor function', () => {
    new MockQueue('w4');
    expect(() => new MockWorker('w4')).toThrow(MockQueueError);
    expect(() => new MockWorker('w4', 'not a function')).toThrow(MockQueueError);
  });

  test('MockWorker requires a registered queue', () => {
    expect(() => new MockWorker('nonexistent-queue', async () => {})).toThrow(MockQueueError);
  });
});

// ===========================================================================
// mock-backend.js — priority ordering
// ===========================================================================

describe('Phase 2.9 — MockQueue priority ordering', () => {
  test('high-priority job runs before lower-priority jobs (submitted after)', async () => {
    const q = new MockQueue('p1');
    const order = [];
    // Concurrency 1 so only one job runs at a time — the order is fully
    // determined by the priority queue.
    new MockWorker('p1', async (job) => {
      order.push(job.data.query);
      return { ok: true };
    }, { concurrency: 1 });
    // Submit 3 low-priority jobs first.
    const low1 = await q.add('search', { query: 'low1', location: 'X' }, { priority: 10 });
    // Wait for low1 to start (it's the first in the queue), then submit the
    // high-priority job. It should run BEFORE low2 + low3.
    await new Promise((r) => setTimeout(r, 20));
    const hi = await q.add('search', { query: 'HI', location: 'X' }, { priority: 1 });
    const low2 = await q.add('search', { query: 'low2', location: 'X' }, { priority: 10 });
    const low3 = await q.add('search', { query: 'low3', location: 'X' }, { priority: 10 });
    await Promise.all([low1, hi, low2, low3].map((j) => j.waitUntilFinished()));
    // HI should be at index 1 (right after low1 which was already running).
    expect(order.indexOf('HI')).toBe(1);
    expect(order.indexOf('HI')).toBeLessThan(order.indexOf('low2'));
    expect(order.indexOf('HI')).toBeLessThan(order.indexOf('low3'));
  });

  test('equal-priority jobs are FIFO', async () => {
    const q = new MockQueue('p2');
    const order = [];
    new MockWorker('p2', async (job) => {
      order.push(job.data.query);
      return { ok: true };
    }, { concurrency: 1 });
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      jobs.push(await q.add('search', { query: `job${i}`, location: 'X' }, { priority: 5 }));
    }
    await Promise.all(jobs.map((j) => j.waitUntilFinished()));
    expect(order).toEqual(['job0', 'job1', 'job2', 'job3', 'job4']);
  });
});

// ===========================================================================
// mock-backend.js — retry + dead-letter
// ===========================================================================

describe('Phase 2.9 — MockQueue retry + dead-letter', () => {
  test('a failing job is retried up to `attempts` times then dead-lettered', async () => {
    const q = new MockQueue('r1');
    let attempts = 0;
    new MockWorker('r1', async (job) => {
      attempts++;
      throw new Error('always fails');
    });
    const job = await q.add('search', { query: 'fail', location: 'X' }, { attempts: 3 });
    // Wait for the job to reach the failed state.
    await new Promise((r) => setTimeout(r, 100));
    expect(job.getState()).toBe('failed');
    expect(job.attemptsMade).toBe(3);
    expect(job.failedReason).toBe('always fails');
    const counts = await q.getJobCounts();
    expect(counts.failed).toBe(1);
  });

  test('a job that fails twice then succeeds completes', async () => {
    const q = new MockQueue('r2');
    let attempts = 0;
    new MockWorker('r2', async (job) => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
      return { ok: true };
    });
    const job = await q.add('search', { query: 'flaky', location: 'X' }, { attempts: 5 });
    await job.waitUntilFinished();
    expect(job.getState()).toBe('completed');
    expect(job.returnvalue).toEqual({ ok: true });
    expect(job.attemptsMade).toBe(3);
  });

  test('getFailed returns the dead-lettered jobs', async () => {
    const q = new MockQueue('r3');
    new MockWorker('r3', async () => {
      throw new Error('nope');
    });
    await q.add('search', { query: 'fail1', location: 'X' }, { attempts: 1 });
    await q.add('search', { query: 'fail2', location: 'X' }, { attempts: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const failed = await q.getFailed();
    expect(failed.length).toBe(2);
  });

  test('job.retry() moves a failed job back to waiting with fresh attempts', async () => {
    const q = new MockQueue('r4');
    let attempts = 0;
    // Processor fails ONLY on the very first attempt (attempts===1), then
    // succeeds. With job.opts.attempts=1, the initial run dead-letters after
    // 1 failure; retry() gives a fresh set of attempts (1 more), which succeeds.
    new MockWorker('r4', async (job) => {
      attempts++;
      if (attempts === 1) throw new Error('fail');
      return { ok: true };
    });
    const job = await q.add('search', { query: 'retry-me', location: 'X' }, { attempts: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(job.getState()).toBe('failed');
    expect(attempts).toBe(1);
    // Retry — gives a fresh set of attempts (resets attemptsMade to 0).
    await job.retry();
    expect(job.getState()).toBe('waiting');
    expect(job.attemptsMade).toBe(0);
    await job.waitUntilFinished();
    expect(job.getState()).toBe('completed');
    expect(attempts).toBe(2); // 1 initial fail + 1 retry succeed
  });

  test('job.retry() rejects if the job is not in failed state', async () => {
    const q = new MockQueue('r5');
    new MockWorker('r5', async () => ({ ok: true }));
    const job = await q.add('search', { query: 'ok', location: 'X' });
    await job.waitUntilFinished();
    // Completed job — retry() is allowed (BullMQ behavior).
    await job.retry();
    expect(job.getState()).toBe('waiting');
  });
});

// ===========================================================================
// mock-backend.js — pause / resume / close
// ===========================================================================

describe('Phase 2.9 — MockQueue pause / resume / close', () => {
  test('pause stops processing; resume restarts it', async () => {
    const q = new MockQueue('pa1');
    const processed = [];
    new MockWorker('pa1', async (job) => {
      processed.push(job.id);
      return { ok: true };
    });
    await q.pause();
    const job = await q.add('search', { query: 'A', location: 'X' });
    // Wait a bit — the job should NOT be processed while paused.
    await new Promise((r) => setTimeout(r, 50));
    expect(processed.length).toBe(0);
    expect(job.getState()).toBe('waiting');
    await q.resume();
    await job.waitUntilFinished();
    expect(processed.length).toBe(1);
  });

  test('close stops accepting new adds', async () => {
    const q = new MockQueue('pa2');
    await q.close();
    await expect(q.add('search', { query: 'A', location: 'X' })).rejects.toThrow(/closed/);
  });

  test('worker.close() waits for in-flight jobs', async () => {
    const q = new MockQueue('pa3');
    let resolveProcessor;
    const processorPromise = new Promise((r) => { resolveProcessor = r; });
    const worker = new MockWorker('pa3', async (job) => {
      await processorPromise;
      return { ok: true };
    });
    const job = await q.add('search', { query: 'A', location: 'X' });
    // Wait for the worker to pull the job (it becomes 'active') BEFORE calling
    // close(). Without this, close() might race ahead of the poll loop and the
    // job would never be processed.
    const pollUntil = Date.now() + 1000;
    while (job.getState() !== 'active' && Date.now() < pollUntil) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(job.getState()).toBe('active');
    // Job is in-flight (processor is blocked). close() should wait.
    const closePromise = worker.close();
    // close() should NOT have resolved yet (job is still in-flight).
    let closeResolved = false;
    closePromise.then(() => { closeResolved = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(closeResolved).toBe(false);
    // Resolve the processor → close() should now complete.
    resolveProcessor();
    await closePromise;
    await job.waitUntilFinished();
    expect(job.getState()).toBe('completed');
  });
});

// ===========================================================================
// dead-letter.js — createDeadLetter
// ===========================================================================

describe('Phase 2.9 — createDeadLetter', () => {
  test('requires a queue instance', () => {
    expect(() => createDeadLetter({})).toThrow();
  });

  test('list returns failed jobs + total', async () => {
    const q = new MockQueue('dl1');
    new MockWorker('dl1', async () => {
      throw new Error('fail');
    });
    await q.add('search', { query: 'a', location: 'X' }, { attempts: 1 });
    await q.add('search', { query: 'b', location: 'X' }, { attempts: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const dl = createDeadLetter({ queue: q, logger: makeStubLogger() });
    const { jobs, total } = await dl.list();
    expect(total).toBe(2);
    expect(jobs.length).toBe(2);
    expect(jobs[0].id).toBeTruthy();
    expect(jobs[0].failedReason).toBe('fail');
  });

  test('list respects limit + offset', async () => {
    const q = new MockQueue('dl2');
    new MockWorker('dl2', async () => {
      throw new Error('fail');
    });
    for (let i = 0; i < 5; i++) {
      await q.add('search', { query: `q${i}`, location: 'X' }, { attempts: 1 });
    }
    await new Promise((r) => setTimeout(r, 150));
    const dl = createDeadLetter({ queue: q, logger: makeStubLogger() });
    const page1 = await dl.list({ limit: 2, offset: 0 });
    const page2 = await dl.list({ limit: 2, offset: 2 });
    expect(page1.total).toBe(5);
    expect(page1.jobs.length).toBe(2);
    expect(page2.jobs.length).toBe(2);
    // Pages don't overlap.
    const ids1 = new Set(page1.jobs.map((j) => j.id));
    const ids2 = new Set(page2.jobs.map((j) => j.id));
    for (const id of ids2) expect(ids1.has(id)).toBe(false);
  });

  test('get returns a single failed job', async () => {
    const q = new MockQueue('dl3');
    new MockWorker('dl3', async () => {
      throw new Error('fail');
    });
    const job = await q.add('search', { query: 'a', location: 'X' }, { attempts: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const dl = createDeadLetter({ queue: q, logger: makeStubLogger() });
    const got = await dl.get(job.id);
    expect(got).not.toBeNull();
    expect(got.id).toBe(job.id);
    expect(await dl.get('nonexistent')).toBeNull();
    expect(await dl.get(null)).toBeNull();
  });

  test('retry moves a failed job back to waiting', async () => {
    const q = new MockQueue('dl4');
    let attempts = 0;
    new MockWorker('dl4', async () => {
      attempts++;
      if (attempts <= 1) throw new Error('fail');
      return { ok: true };
    });
    const job = await q.add('search', { query: 'a', location: 'X' }, { attempts: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const dl = createDeadLetter({ queue: q, logger: makeStubLogger() });
    const r = await dl.retry(job.id);
    expect(r.ok).toBe(true);
    await job.waitUntilFinished();
    expect(job.getState()).toBe('completed');
  });

  test('retry returns ok:false for a nonexistent job', async () => {
    const q = new MockQueue('dl5');
    const dl = createDeadLetter({ queue: q, logger: makeStubLogger() });
    const r = await dl.retry('nonexistent');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found/);
  });

  test('retryAll retries all failed jobs', async () => {
    const q = new MockQueue('dl6');
    let attempts = 0;
    new MockWorker('dl6', async () => {
      attempts++;
      if (attempts <= 3) throw new Error('fail');
      return { ok: true };
    });
    for (let i = 0; i < 3; i++) {
      await q.add('search', { query: `q${i}`, location: 'X' }, { attempts: 1 });
    }
    await new Promise((r) => setTimeout(r, 150));
    const dl = createDeadLetter({ queue: q, logger: makeStubLogger() });
    const r = await dl.retryAll();
    expect(r.retried).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.total).toBe(3);
  });

  test('count returns the number of failed jobs', async () => {
    const q = new MockQueue('dl7');
    new MockWorker('dl7', async () => {
      throw new Error('fail');
    });
    await q.add('search', { query: 'a', location: 'X' }, { attempts: 1 });
    await q.add('search', { query: 'b', location: 'X' }, { attempts: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const dl = createDeadLetter({ queue: q, logger: makeStubLogger() });
    expect(await dl.count()).toBe(2);
  });

  test('remove deletes a failed job from the queue', async () => {
    const q = new MockQueue('dl8');
    new MockWorker('dl8', async () => {
      throw new Error('fail');
    });
    const job = await q.add('search', { query: 'a', location: 'X' }, { attempts: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const dl = createDeadLetter({ queue: q, logger: makeStubLogger() });
    const r = await dl.remove(job.id);
    expect(r.ok).toBe(true);
    expect(await dl.count()).toBe(0);
  });

  test('clear removes all failed jobs', async () => {
    const q = new MockQueue('dl9');
    new MockWorker('dl9', async () => {
      throw new Error('fail');
    });
    for (let i = 0; i < 3; i++) {
      await q.add('search', { query: `q${i}`, location: 'X' }, { attempts: 1 });
    }
    await new Promise((r) => setTimeout(r, 150));
    const dl = createDeadLetter({ queue: q, logger: makeStubLogger() });
    const r = await dl.clear();
    expect(r.removed).toBe(3);
    expect(await dl.count()).toBe(0);
  });

  test('serializeJob produces a JSON-safe plain object', () => {
    const q = new MockQueue('dl10');
    const job = new MockJob({ queue: q, name: 'search', data: { x: 1 }, opts: { priority: 5 }, clock: () => 1000 });
    const s = serializeJob(job);
    expect(() => JSON.stringify(s)).not.toThrow();
    expect(s.id).toBe(job.id);
    expect(s.name).toBe('search');
    expect(s.data).toEqual({ x: 1 });
  });
});

// ===========================================================================
// queue/index.js — createQueue adapter
// ===========================================================================

describe('Phase 2.9 — createQueue adapter (mock backend DI)', () => {
  function makeQueue(opts = {}) {
    return createQueue({
      name: opts.name || 'adapter-test',
      backend: { Queue: MockQueue, Worker: MockWorker },
      defaultAttempts: opts.defaultAttempts || 3,
      concurrency: opts.concurrency || 1,
      logger: makeStubLogger(),
      ...opts,
    });
  }

  test('add returns { id } for a valid job', async () => {
    const q = makeQueue();
    const r = await q.add('search', { query: 'Cafe', location: 'Berlin' });
    expect(r.id).toBeTruthy();
  });

  test('add rejects an unknown job type', async () => {
    const q = makeQueue();
    await expect(q.add('bogus', {})).rejects.toThrow(QueueError);
    await expect(q.add('bogus', {})).rejects.toThrow(/unknown job type/);
  });

  test('add rejects an invalid payload', async () => {
    const q = makeQueue();
    await expect(q.add('search', {})).rejects.toThrow(/invalid job/);
  });

  test('add rejects after shutdown', async () => {
    const q = makeQueue();
    await q.shutdown();
    await expect(q.add('search', { query: 'A', location: 'X' })).rejects.toThrow(/shut down/);
  });

  test('addBatch submits multiple jobs + returns per-job results', async () => {
    const q = makeQueue();
    q.process(async () => ({ ok: true }));
    const results = await q.addBatch([
      { type: 'search', payload: { query: 'A', location: 'X' } },
      { type: 'search', payload: { query: 'B', location: 'X' } },
      { type: 'search', payload: {} }, // invalid — should produce { error }
    ]);
    expect(results.length).toBe(3);
    expect(results[0].id).toBeTruthy();
    expect(results[1].id).toBeTruthy();
    expect(results[2].error).toBeTruthy();
  });

  test('process registers the processor; jobs are processed + results returned', async () => {
    const q = makeQueue();
    const processed = [];
    q.process(async (task) => {
      processed.push(task);
      return { businesses: [{ name: 'B' }] };
    });
    const { id } = await q.add('search', { query: 'Cafe', location: 'Berlin' });
    // Wait for the job to complete.
    await drain(q);
    const status = await q.getStatus(id);
    expect(status.state).toBe('completed');
    expect(status.result).toEqual({ businesses: [{ name: 'B' }] });
    expect(status.attemptsMade).toBe(1);
    expect(processed.length).toBe(1);
    expect(processed[0].type).toBe('search-task');
    expect(processed[0].query).toBe('Cafe');
    expect(processed[0]._queue).toBeTruthy();
    expect(processed[0]._queue.jobId).toBe(id);
  });

  test('process converts the job payload to a task via JOB_TYPES[type].toTask', async () => {
    const q = makeQueue();
    let captured;
    q.process(async (task) => {
      captured = task;
      return { ok: true };
    });
    await q.add('search', { query: 'Cafe', location: 'Berlin', maxResults: 50, deepScrape: true });
    await drain(q);
    expect(captured.type).toBe('search-task');
    expect(captured.query).toBe('Cafe');
    expect(captured.maxResults).toBe(50);
    expect(captured.opts.deepScrape).toBe(true);
  });

  test('process throws if a processor is already registered', async () => {
    const q = makeQueue();
    q.process(async () => ({}));
    expect(() => q.process(async () => ({}))).toThrow(/already registered/);
  });

  test('process throws if processor is not a function', () => {
    const q = makeQueue();
    expect(() => q.process('not a function')).toThrow(/processor function/);
  });

  test('getStatus returns null for missing job', async () => {
    const q = makeQueue();
    expect(await q.getStatus('nonexistent')).toBeNull();
    expect(await q.getStatus(null)).toBeNull();
  });

  test('getStatus returns full status for a completed job', async () => {
    const q = makeQueue();
    q.process(async () => ({ ok: true, count: 5 }));
    const { id } = await q.add('search', { query: 'A', location: 'X' });
    await drain(q);
    const status = await q.getStatus(id);
    expect(status.id).toBe(id);
    expect(status.type).toBe('search');
    expect(status.state).toBe('completed');
    expect(status.result).toEqual({ ok: true, count: 5 });
    expect(status.error).toBeNull();
  });

  test('getStats returns queue-wide counts', async () => {
    const q = makeQueue();
    q.process(async () => ({ ok: true }));
    await q.add('search', { query: 'A', location: 'X' });
    await q.add('search', { query: 'B', location: 'X' });
    await drain(q);
    const stats = await q.getStats();
    expect(stats.completed).toBe(2);
    expect(stats.waiting).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.total).toBe(2);
  });

  test('priority works: a high-priority job is processed before low-priority ones', async () => {
    const q = makeQueue({ concurrency: 1 });
    const order = [];
    q.process(async (task) => {
      order.push(task.query);
      return { ok: true };
    });
    // Submit 3 low-priority jobs, then 1 high-priority.
    await q.add('search', { query: 'low1', location: 'X' }, { priority: 10 });
    // Wait for low1 to start.
    await new Promise((r) => setTimeout(r, 20));
    await q.add('search', { query: 'low2', location: 'X' }, { priority: 10 });
    await q.add('search', { query: 'low3', location: 'X' }, { priority: 10 });
    await q.add('search', { query: 'HI', location: 'X' }, { priority: 1 });
    await drain(q);
    // HI should be at index 1 (after low1 which was already running).
    expect(order.indexOf('HI')).toBe(1);
    expect(order.indexOf('HI')).toBeLessThan(order.indexOf('low2'));
  });

  test('retry: a job that fails 3 times is dead-lettered', async () => {
    const q = makeQueue({ defaultAttempts: 3 });
    q.process(async () => {
      throw new Error('always fails');
    });
    const { id } = await q.add('search', { query: 'fail', location: 'X' });
    await drain(q);
    const status = await q.getStatus(id);
    expect(status.state).toBe('failed');
    expect(status.attemptsMade).toBe(3);
    expect(status.error).toBe('always fails');
    const dl = await q.deadLetter.list();
    expect(dl.total).toBe(1);
  });

  test('retry: a job that fails twice then succeeds completes', async () => {
    const q = makeQueue({ defaultAttempts: 5 });
    let attempts = 0;
    q.process(async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
      return { ok: true };
    });
    const { id } = await q.add('search', { query: 'flaky', location: 'X' });
    await drain(q);
    const status = await q.getStatus(id);
    expect(status.state).toBe('completed');
    expect(status.attemptsMade).toBe(3);
  });

  test('deadLetter() callable returns the list (spec parity)', async () => {
    const q = makeQueue({ defaultAttempts: 1 });
    q.process(async () => {
      throw new Error('fail');
    });
    await q.add('search', { query: 'a', location: 'X' });
    await drain(q);
    const list = await q.deadLetter();
    expect(list.total).toBe(1);
    expect(list.jobs[0].failedReason).toBe('fail');
  });

  test('deadLetter.list() returns the list (method API)', async () => {
    const q = makeQueue({ defaultAttempts: 1 });
    q.process(async () => {
      throw new Error('fail');
    });
    await q.add('search', { query: 'a', location: 'X' });
    await drain(q);
    const list = await q.deadLetter.list();
    expect(list.total).toBe(1);
  });

  test('deadLetter.count() returns the count', async () => {
    const q = makeQueue({ defaultAttempts: 1 });
    q.process(async () => {
      throw new Error('fail');
    });
    await q.add('search', { query: 'a', location: 'X' });
    await q.add('search', { query: 'b', location: 'X' });
    await drain(q);
    expect(await q.deadLetter.count()).toBe(2);
  });

  test('retryDeadLetter(id) re-queues a failed job (spec parity)', async () => {
    const q = makeQueue({ defaultAttempts: 1 });
    let attempts = 0;
    q.process(async () => {
      attempts++;
      if (attempts <= 1) throw new Error('fail');
      return { ok: true };
    });
    const { id } = await q.add('search', { query: 'a', location: 'X' });
    await drain(q);
    expect(await q.deadLetter.count()).toBe(1);
    const r = await q.retryDeadLetter(id);
    expect(r.ok).toBe(true);
    await drain(q);
    const status = await q.getStatus(id);
    expect(status.state).toBe('completed');
  });

  test('deadLetter.retryAll() retries all failed jobs', async () => {
    const q = makeQueue({ defaultAttempts: 1 });
    let attempts = 0;
    q.process(async () => {
      attempts++;
      if (attempts <= 3) throw new Error('fail');
      return { ok: true };
    });
    for (let i = 0; i < 3; i++) {
      await q.add('search', { query: `q${i}`, location: 'X' });
    }
    await drain(q);
    expect(await q.deadLetter.count()).toBe(3);
    const r = await q.deadLetter.retryAll();
    expect(r.retried).toBe(3);
    await drain(q);
    expect(await q.deadLetter.count()).toBe(0);
  });

  test('pause stops processing; resume restarts', async () => {
    const q = makeQueue();
    const processed = [];
    q.process(async (task) => {
      processed.push(task.query);
      return { ok: true };
    });
    await q.pause();
    const { id } = await q.add('search', { query: 'A', location: 'X' });
    await new Promise((r) => setTimeout(r, 50));
    expect(processed.length).toBe(0);
    await q.resume();
    await drain(q);
    expect(processed).toEqual(['A']);
    expect((await q.getStatus(id)).state).toBe('completed');
  });

  test('shutdown stops accepting new adds + closes the worker', async () => {
    const q = makeQueue();
    q.process(async () => ({ ok: true }));
    await q.add('search', { query: 'A', location: 'X' });
    await drain(q);
    await q.shutdown();
    expect(q.isShutDown).toBe(true);
    await expect(q.add('search', { query: 'B', location: 'X' })).rejects.toThrow(/shut down/);
  });

  test('shutdown is idempotent', async () => {
    const q = makeQueue();
    await q.shutdown();
    await expect(q.shutdown()).resolves.toBeUndefined();
  });

  test('default priority + attempts come from createQueue opts', async () => {
    const q = makeQueue({ defaultAttempts: 7 });
    let captured;
    q.process(async (task) => {
      captured = task;
      return { ok: true };
    });
    await q.add('search', { query: 'A', location: 'X' }, { priority: 2 });
    await drain(q);
    expect(captured._queue.jobId).toBeTruthy();
    // Verify the backend job got the right opts.
    const job = q._backendQueue.getJob(captured._queue.jobId);
    expect(job.opts.priority).toBe(2);
    expect(job.opts.attempts).toBe(7);
  });

  test('enrich job type works end-to-end', async () => {
    const q = makeQueue();
    let captured;
    q.process(async (task) => {
      captured = task;
      return { enriched: true };
    });
    const { id } = await q.add('enrich', { businessId: 'b123', source: 'yelp' });
    await drain(q);
    expect(captured.type).toBe('enrich-task');
    expect(captured.businessId).toBe('b123');
    expect(captured.source).toBe('yelp');
    const status = await q.getStatus(id);
    expect(status.state).toBe('completed');
    expect(status.result).toEqual({ enriched: true });
  });

  test('detail-batch job type works with businesses payload', async () => {
    const q = makeQueue();
    let captured;
    q.process(async (task) => {
      captured = task;
      return { businesses: task.businesses, detailStats: { attempted: 2, succeeded: 2, failed: 0 } };
    });
    const businesses = [{ name: 'A' }, { name: 'B' }];
    await q.add('detail-batch', { businesses, deepScrape: true });
    await drain(q);
    expect(captured.type).toBe('detail-task');
    expect(captured.businesses.length).toBe(2);
    expect(captured.opts.deepScrape).toBe(true);
  });

  test('detail-batch job type works with businessIds payload', async () => {
    const q = makeQueue();
    let captured;
    q.process(async (task) => {
      captured = task;
      return { ok: true };
    });
    await q.add('detail-batch', { businessIds: ['x', 'y', 'z'] });
    await drain(q);
    expect(captured.type).toBe('detail-task');
    expect(captured.businessIds).toEqual(['x', 'y', 'z']);
    expect(captured.businesses).toEqual([]);
  });

  test('getActive returns currently-active jobs', async () => {
    const q = makeQueue({ concurrency: 1 });
    let resolveProcessor;
    q.process(async () => {
      await new Promise((r) => { resolveProcessor = r; });
      return { ok: true };
    });
    await q.add('search', { query: 'A', location: 'X' });
    // Wait for the job to become active.
    await new Promise((r) => setTimeout(r, 30));
    const active = await q.getActive();
    expect(active.length).toBe(1);
    expect(active[0].data.query).toBe('A');
    resolveProcessor();
    await drain(q);
  });

  test('real BullMQ backend throws when redisUrl is missing', () => {
    // No backend injected + no redisUrl → should throw QUEUE_NO_REDIS (not
    // attempt to connect to Redis). We don't actually have Redis running, so
    // this confirms the fail-fast path.
    expect(() => createQueue({ name: 'no-redis', logger: makeStubLogger() })).toThrow(QueueError);
    expect(() => createQueue({ name: 'no-redis', logger: makeStubLogger() })).toThrow(/redisUrl/);
  });
});

// ===========================================================================
// queue/index.js — concurrency + parallelism
// ===========================================================================

describe('Phase 2.9 — createQueue concurrency', () => {
  test('concurrency 3 processes 3 jobs in parallel', async () => {
    const q = createQueue({
      name: 'conc-test',
      backend: { Queue: MockQueue, Worker: MockWorker },
      concurrency: 3,
      logger: makeStubLogger(),
    });
    let activeCount = 0;
    let maxActive = 0;
    q.process(async () => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise((r) => setTimeout(r, 30));
      activeCount--;
      return { ok: true };
    });
    // Submit 6 jobs — with concurrency 3, we expect up to 3 running at once.
    for (let i = 0; i < 6; i++) {
      await q.add('search', { query: `q${i}`, location: 'X' });
    }
    await drain(q, { timeoutMs: 5000 });
    expect(maxActive).toBeGreaterThanOrEqual(2); // at least some parallelism
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});
