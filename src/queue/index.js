'use strict';

/**
 * src/queue/index.js — Phase 2.9 — Job Queue & Orchestration
 *
 * The public queue adapter. Wraps BullMQ (production) or the in-memory mock
 * backend (tests) behind a single contract so the rest of the codebase —
 * src/index.js, scripts/batch.js, scripts/queue-status.js — never has to
 * know which backend is in use.
 *
 * Design:
 *   - The adapter accepts an injectable `backend` ({ Queue, Worker }) so unit
 *     tests pass { Queue: MockQueue, Worker: MockWorker } and run without a
 *     real Redis instance. Production leaves `backend` undefined → the adapter
 *     lazily requires('bullmq').
 *   - Job submission always validates via JOB_TYPES first (fail-fast on bad
 *     payloads — never persist garbage to Redis).
 *   - The worker processor is injected (DI) — it's an async (task) => result
 *     function. In production, src/index.js wires it to pool.dispatch(task)
 *     after converting the job payload into a Phase 2.8 task descriptor.
 *   - Graceful shutdown: stop accepting new adds, finish in-flight jobs,
 *     close the worker + queue. Best-effort — never throws.
 *
 * Public API:
 *   const queue = createQueue({
 *     redisUrl, name, logger,
 *     backend?,                  // { Queue, Worker } — DI for tests
 *     defaultPriority?,          // default 5 (normal)
 *     defaultAttempts?,          // default 3
 *     backoff?,                  // { type, delay } — default exponential 1000ms
 *     concurrency?,              // worker concurrency — default 1
 *   });
 *
 *   const { id } = await queue.add('search', { query, location }, { priority, attempts, delay });
 *   queue.process(async (task) => { /* run the task; return result *\/ });
 *   const status = await queue.getStatus(id);   // { state, progress, result, error, attemptsMade }
 *   const stats = await queue.getStats();       // { waiting, active, completed, failed, delayed, total }
 *   const dl = queue.deadLetter();              // { list, get, retry, retryAll, remove, clear, count }
 *   await queue.pause(); await queue.resume();
 *   await queue.shutdown();                     // graceful
 *
 * The adapter is event-driven — add() returns immediately with a job id; the
 * caller polls getStatus() (or awaits job.waitUntilFinished() via the backend
 * job). This decouples submission from execution, which is the whole point of
 * the queue: a CLI can submit 10,000 jobs and exit, while a worker process
 * pulls them off over hours.
 */

const {
  JOB_TYPES,
  JOB_TYPE_NAMES,
  validateJobRequest,
  resolvePriority,
  PRIORITY_NORMAL,
} = require('./job-types');
const { createDeadLetter } = require('./dead-letter');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class QueueError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'QueueError';
    this.code = code || 'QUEUE_ERROR';
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_NAME = 'scraper';
const DEFAULT_PRIORITY = PRIORITY_NORMAL;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF = { type: 'exponential', delay: 1000 };
const DEFAULT_CONCURRENCY = 1;

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
// createQueue — the public factory
// ---------------------------------------------------------------------------

/**
 * Create a queue adapter.
 *
 * @param {object} opts
 * @param {string} [opts.redisUrl]      — Redis URL (required for real BullMQ backend)
 * @param {string} [opts.name]          — queue name (default 'scraper')
 * @param {object} [opts.logger]        — parent logger
 * @param {object} [opts.backend]       — DI: { Queue, Worker } (default: real bullmq)
 * @param {number} [opts.defaultPriority]  — default 5 (normal)
 * @param {number} [opts.defaultAttempts]  — default 3
 * @param {object} [opts.backoff]       — { type, delay } (default exponential 1000ms)
 * @param {number} [opts.concurrency]   — worker concurrency (default 1)
 * @returns {object} queue adapter
 */
function createQueue(opts = {}) {
  const name = opts.name || DEFAULT_NAME;
  const parentLogger = opts.logger || makeStubLogger();
  const logger =
    typeof parentLogger.child === 'function'
      ? parentLogger.child({ component: 'queue' })
      : parentLogger;
  const defaultPriority = resolvePriority(opts.defaultPriority ?? DEFAULT_PRIORITY);
  const defaultAttempts = Math.max(1, Math.min(50, Number(opts.defaultAttempts) || DEFAULT_ATTEMPTS));
  const backoff = opts.backoff || DEFAULT_BACKOFF;
  const concurrency = Math.max(1, Number(opts.concurrency) || DEFAULT_CONCURRENCY);

  // Resolve the backend. Production leaves `opts.backend` undefined → we lazily
  // require('bullmq') so the dependency only loads when a queue is actually
  // constructed. Tests pass { Queue: MockQueue, Worker: MockWorker }.
  let QueueClass;
  let WorkerClass;
  if (opts.backend && opts.backend.Queue && opts.backend.Worker) {
    QueueClass = opts.backend.Queue;
    WorkerClass = opts.backend.Worker;
  } else {
    // Lazy require so the queue module is loadable in environments without
    // bullmq installed (shouldn't happen in production, but keeps the test
    // surface clean — tests never hit this branch).
    let bullmq;
    try {
      bullmq = require('bullmq');
    } catch (err) {
      throw new QueueError(
        'bullmq is not installed but no test backend was provided. ' +
          'Run `npm install bullmq ioredis` or pass { backend: { Queue, Worker } } to createQueue().',
        { code: 'QUEUE_NO_BACKEND' },
      );
    }
    QueueClass = bullmq.Queue;
    WorkerClass = bullmq.Worker;
  }

  // Construct the backend queue. For BullMQ, pass a connection config; for the
  // mock, pass nothing (it uses an in-memory registry keyed by name).
  let backendQueue;
  if (opts.backend) {
    // Mock backend — constructor is (name, opts).
    backendQueue = new QueueClass(name, { logger });
  } else {
    // Real BullMQ — constructor is (name, opts) where opts.connection is the
    // Redis URL or ioredis instance.
    if (!opts.redisUrl) {
      throw new QueueError(
        'createQueue requires redisUrl when using the real BullMQ backend ' +
          '(pass --redisUrl or set REDIS_URL). For tests, pass { backend: { Queue, Worker } }.',
        { code: 'QUEUE_NO_REDIS' },
      );
    }
    backendQueue = new QueueClass(name, {
      connection: { url: opts.redisUrl },
      defaultJobOptions: {
        attempts: defaultAttempts,
        backoff,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }

  let worker = null;
  let processing = false;
  let shutDown = false;

  // -----------------------------------------------------------------
  // add — submit a job
  // -----------------------------------------------------------------

  /**
   * Submit a job. Validates the request first (fail-fast on bad payloads),
   * then delegates to the backend queue's add(). Returns { id }.
   *
   * @param {string} type                 — job type ('search' | 'detail-batch' | 'enrich')
   * @param {object} payload              — job payload (validated against JOB_TYPES[type])
   * @param {object} [addOpts]
   * @param {number} [addOpts.priority]   — 1 (high) | 5 (normal) | 10 (low); default 5
   * @param {number} [addOpts.attempts]   — retry attempts; default 3
   * @param {number} [addOpts.delay]      — delay in ms before the job is processed
   * @returns {Promise<{ id: string }>}
   */
  async function add(type, payload, addOpts = {}) {
    if (shutDown) {
      throw new QueueError('queue is shut down', { code: 'QUEUE_SHUTDOWN' });
    }
    if (!JOB_TYPE_NAMES.includes(type)) {
      throw new QueueError(
        `unknown job type "${type}". Valid types: ${JOB_TYPE_NAMES.join(', ')}`,
        { code: 'QUEUE_UNKNOWN_TYPE' },
      );
    }
    const req = {
      type,
      payload,
      priority: addOpts.priority,
      attempts: addOpts.attempts,
      delay: addOpts.delay,
    };
    const errs = validateJobRequest(req);
    if (errs.length > 0) {
      throw new QueueError(`invalid job: ${errs.join('; ')}`, { code: 'QUEUE_INVALID' });
    }
    const priority = resolvePriority(addOpts.priority ?? JOB_TYPES[type].priority ?? defaultPriority);
    const attempts = Math.max(1, Math.min(50, Number(addOpts.attempts) || defaultAttempts));
    const delay = Number(addOpts.delay) || 0;

    const bullOpts = {
      priority,
      attempts,
      delay,
      backoff,
    };
    const job = await backendQueue.add(type, payload, bullOpts);
    logger.info('Job submitted', {
      jobId: job.id,
      type,
      priority,
      attempts,
      delay,
    });
    return { id: job.id };
  }

  /**
   * Submit a batch of jobs in one call. Returns an array of { id } in input
   * order, with nulls for any individual submission that failed (so a bad row
   * in a CSV doesn't tank the whole batch). The caller can inspect the
   * returned array to see which rows succeeded.
   *
   * @param {Array<{ type, payload, priority?, attempts?, delay? }>} jobs
   * @returns {Promise<Array<{ id: string } | { error: string }>>}
   */
  async function addBatch(jobs) {
    if (!Array.isArray(jobs)) {
      throw new QueueError('addBatch requires an array of job requests', { code: 'QUEUE_CONFIG' });
    }
    const results = [];
    for (const j of jobs) {
      try {
        const { id } = await add(j.type, j.payload, {
          priority: j.priority,
          attempts: j.attempts,
          delay: j.delay,
        });
        results.push({ id });
      } catch (err) {
        results.push({ error: err.message });
      }
    }
    return results;
  }

  // -----------------------------------------------------------------
  // process — register the worker processor
  // -----------------------------------------------------------------

  /**
   * Register the worker processor. The processor receives a TASK (the job
   * payload converted via JOB_TYPES[type].toTask) and returns a result. The
   * adapter handles the job → task conversion so the processor is agnostic
   * to the queue's job-type schema.
   *
   * Only one processor can be registered per queue (BullMQ limitation). Calling
   * process() twice throws.
   *
   * @param {Function} processor — async (task, job) => result
   */
  function process(processor) {
    if (processing) {
      throw new QueueError('a processor is already registered for this queue', {
        code: 'QUEUE_PROCESSOR_EXISTS',
      });
    }
    if (typeof processor !== 'function') {
      throw new QueueError('process() requires an async processor function', {
        code: 'QUEUE_CONFIG',
      });
    }
    processing = true;

    const workerOpts = opts.backend
      ? { concurrency, logger }
      : { connection: { url: opts.redisUrl }, concurrency };
    worker = new WorkerClass(
      name,
      async (job) => {
        const type = job.name;
        const def = JOB_TYPES[type];
        if (!def) {
          throw new Error(`unknown job type from backend: ${type}`);
        }
        const task = def.toTask(job.data);
        // Stamp the task with queue metadata so the pool / processor can trace
        // it back to the originating job.
        task._queue = { jobId: job.id, type, attemptsMade: job.attemptsMade || 0 };
        const result = await processor(task, job);
        return result;
      },
      workerOpts,
    );
    logger.info('Queue worker registered', { name, concurrency });
  }

  // -----------------------------------------------------------------
  // getStatus — single-job introspection
  // -----------------------------------------------------------------

  /**
   * Get the status of a single job. Returns a normalized object regardless of
   * backend (BullMQ vs mock):
   *   { id, type, state, progress, result, error, attemptsMade, data, timestamp }
   *
   * Returns null if the job doesn't exist.
   */
  async function getStatus(jobId) {
    if (!jobId) return null;
    const job = await backendQueue.getJob(jobId);
    if (!job) return null;
    const state = typeof job.getState === 'function' ? await job.getState() : null;
    return {
      id: job.id,
      type: job.name,
      data: job.data,
      state,
      progress: job.progress,
      result: job.returnvalue,
      error: job.failedReason,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
    };
  }

  // -----------------------------------------------------------------
  // getStats — queue-wide counts
  // -----------------------------------------------------------------

  /**
   * Get queue-wide counts: { waiting, active, completed, failed, delayed, total }.
   * `total` is the sum of all states (everything currently in the queue).
   */
  async function getStats() {
    const counts = await backendQueue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
    const total =
      (counts.waiting || 0) +
      (counts.active || 0) +
      (counts.completed || 0) +
      (counts.failed || 0) +
      (counts.delayed || 0);
    return {
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
      total,
    };
  }

  // -----------------------------------------------------------------
  // getActive — list currently-active jobs (for the status CLI)
  // -----------------------------------------------------------------

  async function getActive({ limit = 100 } = {}) {
    const jobs = await backendQueue.getJobs('active');
    return jobs.slice(0, limit).map((j) => ({
      id: j.id,
      type: j.name,
      data: j.data,
      progress: j.progress,
      attemptsMade: j.attemptsMade,
      timestamp: j.timestamp,
      processedOn: j.processedOn,
    }));
  }

  // -----------------------------------------------------------------
  // pause / resume
  // -----------------------------------------------------------------

  async function pause() {
    await backendQueue.pause();
    logger.info('Queue paused');
  }

  async function resume() {
    await backendQueue.resume();
    logger.info('Queue resumed');
  }

  // -----------------------------------------------------------------
  // dead-letter — failed-jobs helper
  // -----------------------------------------------------------------
  // The Phase 2.9 spec calls for `queue.deadLetter()` (lists failed jobs) and
  // `queue.retryDeadLetter(jobId)` (re-queues). We expose BOTH that minimal
  // surface AND the richer dead-letter helper (list/get/retry/retryAll/remove/
  // clear/count) by making `deadLetter` a callable function with the helper
  // methods attached as properties (the "callable module" pattern). Calling
  // queue.deadLetter() with no args returns the list (matches spec); calling
  // queue.deadLetter.list({ limit }) does the same with pagination; calling
  // queue.deadLetter.retry(jobId) re-queues a single job. For spec parity we
  // ALSO expose queue.retryDeadLetter(jobId) as a top-level method.

  const dlHelper = createDeadLetter({ queue: backendQueue, logger });
  // Make deadLetter callable: deadLetter() === deadLetter.list().
  const deadLetter = function deadLetterFn(opts) {
    return dlHelper.list(opts || {});
  };
  // Attach the rich methods.
  deadLetter.list = dlHelper.list;
  deadLetter.get = dlHelper.get;
  deadLetter.retry = dlHelper.retry;
  deadLetter.retryAll = dlHelper.retryAll;
  deadLetter.remove = dlHelper.remove;
  deadLetter.clear = dlHelper.clear;
  deadLetter.count = dlHelper.count;

  /** Spec-parity alias: queue.retryDeadLetter(jobId) === queue.deadLetter.retry(jobId). */
  async function retryDeadLetter(jobId) {
    return dlHelper.retry(jobId);
  }

  // -----------------------------------------------------------------
  // shutdown — graceful
  // -----------------------------------------------------------------

  /**
   * Graceful shutdown:
   *   1. Stop accepting new adds (the add() guard throws QUEUE_SHUTDOWN).
   *   2. Close the worker — in-flight jobs finish, then the poll loop exits.
   *   3. Close the backend queue — disconnects from Redis.
   * Best-effort — never throws. After shutdown, add() rejects + process() is
   * a no-op.
   */
  async function shutdown() {
    if (shutDown) return;
    shutDown = true;
    logger.info('Queue shutting down');
    const errors = [];
    if (worker) {
      try {
        await worker.close();
      } catch (err) {
        errors.push(`worker.close: ${err.message}`);
      }
    }
    try {
      // BullMQ uses close(); the mock supports both close() and disconnect().
      if (typeof backendQueue.close === 'function') {
        await backendQueue.close();
      } else if (typeof backendQueue.disconnect === 'function') {
        await backendQueue.disconnect();
      }
    } catch (err) {
      errors.push(`queue.close: ${err.message}`);
    }
    if (errors.length > 0) {
      logger.warn('Queue shutdown completed with non-fatal errors', { errors });
    }
  }

  // -----------------------------------------------------------------
  // Public object
  // -----------------------------------------------------------------

  return {
    get name() {
      return name;
    },
    get isShutDown() {
      return shutDown;
    },
    get isProcessing() {
      return processing;
    },
    add,
    addBatch,
    process,
    getStatus,
    getStats,
    getActive,
    pause,
    resume,
    deadLetter,
    retryDeadLetter,
    shutdown,
    // exposed for tests / introspection
    _backendQueue: backendQueue,
    _backendWorker: () => worker,
  };
}

module.exports = {
  createQueue,
  QueueError,
  DEFAULT_NAME,
  DEFAULT_PRIORITY,
  DEFAULT_ATTEMPTS,
  DEFAULT_BACKOFF,
  DEFAULT_CONCURRENCY,
  // re-export the job-types + dead-letter for convenience
  ...require('./job-types'),
  createDeadLetter,
};
