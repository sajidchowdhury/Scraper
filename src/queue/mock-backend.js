'use strict';

/**
 * src/queue/mock-backend.js — Phase 2.9 — Job Queue & Orchestration
 *
 * A PURE in-memory implementation of the subset of the BullMQ API that
 * src/queue/index.js depends on. This is the test seam: unit tests inject
 * { Queue: MockQueue, Worker: MockWorker } into createQueue() so they run
 * without a real Redis instance (an explicit acceptance criterion).
 *
 * It is NOT a full BullMQ re-implementation. It implements just enough of the
 * job lifecycle to exercise the queue adapter's contract:
 *
 *   MockQueue:
 *     - add(name, data, opts)         → MockJob
 *     - getJob(id)                     → MockJob | undefined
 *     - getJobCounts(...states)        → { waiting, active, completed, failed, delayed }
 *     - getFailed()                    → MockJob[]
 *     - getJobs(state)                 → MockJob[]
 *     - pause() / resume()             → stop/start processing
 *     - close()                        → disconnect (best-effort)
 *
 *   MockWorker(name, processor, opts):
 *     - polls the shared MockQueue's priority queue
 *     - on each job: state=active → processor(job) → state=completed|failed
 *     - on failure: retry up to `attempts` with exponential backoff
 *       (backoff is SYNCHRONOUS in the mock — real backoff has wall-clock
 *       delays; the mock uses an injectable clock + zero-length sleepFn so
 *       tests don't have to wait. The backoff CALCULATION is the same.)
 *     - after `attempts` failures: state=failed (dead-letter)
 *     - close()                        → stop polling (in-flight jobs finish)
 *
 *   MockJob:
 *     - id, name, data, opts
 *     - progress (number 0-100 | any value)
 *     - returnvalue (result on success)
 *     - failedReason (error message on failure)
 *     - attemptsMade (number of attempts so far)
 *     - timestamp (ms when added)
 *     - processedOn, finishedOn (ms timestamps)
 *     - getState()                     → 'waiting'|'active'|'completed'|'failed'|'delayed'
 *     - updateProgress(value)          → set progress
 *     - waitUntilFinished(timeoutMs)   → Promise that resolves with returnvalue or rejects with error
 *     - retry()                        → move a failed job back to waiting
 *     - remove()                       → delete the job from the queue
 *
 * Priority: lower number = higher priority (matches BullMQ). Jobs with the same
 * priority are processed FIFO (insertion order), matching BullMQ's behavior.
 *
 * Concurrency: the MockWorker polls with a configurable concurrency (default
 * 1). The queue adapter registers exactly one worker per createQueue() call, so
 * concurrency > 1 is rarely needed — but it's supported for completeness.
 *
 * The mock is intentionally event-driven (no real timers) so tests are
 * deterministic and fast. A real BullMQ Worker uses Redis BRPOPLPUSH; the mock
 * uses a simple poll loop with an injectable sleepFn (default: microtask yield).
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class MockQueueError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'MockQueueError';
    this.code = code || 'MOCK_QUEUE_ERROR';
  }
}

// ---------------------------------------------------------------------------
// Stub logger
// ---------------------------------------------------------------------------

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

function defaultClock() {
  return Date.now();
}

// Yield to the next event-loop iteration. We use setImmediate (NOT
// Promise.resolve()) so the poll loop yields to macrotasks (setTimeout, I/O)
// too — a microtask-only yield would starve the event loop and deadlock any
// test that uses real timers. setImmediate is the Node idiom for "run me
// after the current operation queue drains" which includes macrotasks.
function defaultSleep() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Shared registry — MockQueue + MockWorker talk via a single in-memory store.
// A MockQueue registers itself in the registry under its name; MockWorker
// looks up the queue by name. This mirrors BullMQ's Redis-backed coordination
// (Queue and Worker communicate via Redis keys, not direct references).
// ---------------------------------------------------------------------------

const REGISTRY = new Map();

// ---------------------------------------------------------------------------
// MockJob
// ---------------------------------------------------------------------------

let _jobSeq = 0;
function nextJobId() {
  _jobSeq = (_jobSeq + 1) % 1_000_000;
  return `job-${Date.now().toString(36)}-${_jobSeq.toString(36)}`;
}

class MockJob {
  constructor({ queue, name, data, opts, clock }) {
    this.id = nextJobId();
    this.name = name;
    this.data = data;
    this.opts = opts || {};
    this.queue = queue;
    this.progress = 0;
    this.returnvalue = null;
    this.failedReason = null;
    this.attemptsMade = 0;
    this.timestamp = clock();
    this.processedOn = null;
    this.finishedOn = null;
    this._state = 'waiting'; // 'waiting' | 'active' | 'completed' | 'failed' | 'delayed'
    this._delayedUntil = null;
    // waiters — array of { resolve, reject } waiting on waitUntilFinished()
    this._waiters = [];
  }

  getState() {
    return this._state;
  }

  async updateProgress(value) {
    this.progress = value;
  }

  /**
   * Wait until the job is completed or failed. Resolves with the returnvalue
   * on success, rejects with an Error on failure. Matches BullMQ's
   * job.waitUntilFinished() — but here it's a simple promise that the queue
   * resolves/rejects when the processor finishes.
   */
  waitUntilFinished() {
    if (this._state === 'completed') return Promise.resolve(this.returnvalue);
    if (this._state === 'failed') {
      return Promise.reject(new Error(this.failedReason || 'job failed'));
    }
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
  }

  _finish(returnvalue) {
    this.returnvalue = returnvalue;
    this._state = 'completed';
    this.finishedOn = this.queue._clock();
    for (const w of this._waiters) w.resolve(returnvalue);
    this._waiters = [];
  }

  _fail(reason) {
    this.failedReason = reason;
    this._state = 'failed';
    this.finishedOn = this.queue._clock();
    for (const w of this._waiters) w.reject(new Error(reason));
    this._waiters = [];
  }

  /**
   * Re-queue a failed (or completed) job. Resets state to 'waiting', clears
   * the failed reason / return value, and REMOVES the job from the _failed /
   * _completed sets so getFailed() no longer returns it. AttemptsMade is
   * reset to 0 so the job gets a fresh set of attempts (matches BullMQ's
   * retry() behavior — the original `attempts` option is re-applied).
   */
  async retry() {
    if (this._state !== 'failed' && this._state !== 'completed') {
      throw new MockQueueError(`retry() requires a failed or completed job (got ${this._state})`, {
        code: 'MOCK_QUEUE_INVALID_STATE',
      });
    }
    // Remove from the terminal-state set so getFailed() / getJobs('completed')
    // no longer return it. (Without this, a retried job that succeeds would
    // still show up in getFailed() — a real bug we hit in testing.)
    this.queue._failed.delete(this.id);
    this.queue._completed.delete(this.id);
    this._state = 'waiting';
    this.failedReason = null;
    this.returnvalue = null;
    this.finishedOn = null;
    this.processedOn = null;
    this.attemptsMade = 0; // fresh set of attempts
    this.queue._enqueue(this);
  }

  async remove() {
    this.queue._remove(this);
  }
}

// ---------------------------------------------------------------------------
// MockQueue — a priority queue with retry + dead-letter semantics
// ---------------------------------------------------------------------------

class MockQueue {
  constructor(name, opts = {}) {
    if (!name || typeof name !== 'string') {
      throw new MockQueueError('MockQueue requires a name', { code: 'MOCK_QUEUE_CONFIG' });
    }
    this.name = name;
    this._clock = opts.clock || defaultClock;
    this._logger = opts.logger || makeStubLogger();
    this._jobs = new Map(); // id → MockJob
    this._waiting = []; // array of job ids, sorted by priority then timestamp
    this._active = new Set(); // job ids currently being processed
    this._completed = new Set();
    this._failed = new Set(); // dead-letter
    this._delayed = []; // { id, until } — jobs scheduled for the future
    this._paused = false;
    this._closed = false;
    this._workers = new Set();
    REGISTRY.set(name, this);
  }

  // -----------------------------------------------------------------
  // add — submit a job
  // -----------------------------------------------------------------

  async add(name, data, opts = {}) {
    if (this._closed) {
      throw new MockQueueError('queue is closed', { code: 'MOCK_QUEUE_CLOSED' });
    }
    const job = new MockJob({
      queue: this,
      name,
      data,
      opts,
      clock: this._clock,
    });
    // Register the job in the _jobs map BEFORE _enqueue (the sort comparator
    // in _enqueue reads from _jobs, so the job must be present first).
    this._jobs.set(job.id, job);
    // Apply delay if specified — job goes into _delayed, not _waiting.
    const delayMs = Number(opts.delay) || 0;
    if (delayMs > 0) {
      job._state = 'delayed';
      job._delayedUntil = this._clock() + delayMs;
      this._delayed.push({ id: job.id, until: job._delayedUntil });
    } else {
      this._enqueue(job);
    }
    this._logger.debug('MockQueue: job added', {
      jobId: job.id,
      jobName: job.name,
      priority: opts.priority,
      attempts: opts.attempts,
      delay: delayMs,
    });
    // Wake up any waiting workers.
    this._notifyWorkers();
    return job;
  }

  /**
   * Push a job into the waiting queue, keeping it sorted by (priority asc,
   * timestamp asc). Lower priority number = higher priority = earlier.
   */
  _enqueue(job) {
    if (job._state === 'delayed') job._state = 'waiting';
    this._waiting.push(job.id);
    // Stable sort by priority (lower first), then by timestamp (earlier first).
    this._waiting.sort((aId, bId) => {
      const a = this._jobs.get(aId);
      const b = this._jobs.get(bId);
      const pa = Number(a.opts.priority) || 0;
      const pb = Number(b.opts.priority) || 0;
      if (pa !== pb) return pa - pb;
      return a.timestamp - b.timestamp;
    });
  }

  _remove(job) {
    this._jobs.delete(job.id);
    this._waiting = this._waiting.filter((id) => id !== job.id);
    this._active.delete(job.id);
    this._completed.delete(job.id);
    this._failed.delete(job.id);
    this._delayed = this._delayed.filter((d) => d.id !== job.id);
  }

  // -----------------------------------------------------------------
  // getJob / counts / getFailed / getJobs — introspection
  // -----------------------------------------------------------------

  getJob(id) {
    return this._jobs.get(id) || undefined;
  }

  async getJobCounts() {
    // Promote any delayed jobs whose time has come (lazily — matches BullMQ).
    this._promoteDelayed();
    return {
      waiting: this._waiting.length,
      active: this._active.size,
      completed: this._completed.size,
      failed: this._failed.size,
      delayed: this._delayed.length,
    };
  }

  async getFailed() {
    return Array.from(this._failed)
      .map((id) => this._jobs.get(id))
      .filter(Boolean);
  }

  async getJobs(state) {
    this._promoteDelayed();
    if (!state) return Array.from(this._jobs.values());
    if (state === 'waiting') return this._waiting.map((id) => this._jobs.get(id)).filter(Boolean);
    if (state === 'active') return Array.from(this._active).map((id) => this._jobs.get(id)).filter(Boolean);
    if (state === 'completed') return Array.from(this._completed).map((id) => this._jobs.get(id)).filter(Boolean);
    if (state === 'failed') return Array.from(this._failed).map((id) => this._jobs.get(id)).filter(Boolean);
    if (state === 'delayed') return this._delayed.map((d) => this._jobs.get(d.id)).filter(Boolean);
    return [];
  }

  // -----------------------------------------------------------------
  // pause / resume / close
  // -----------------------------------------------------------------

  async pause() {
    this._paused = true;
  }

  async resume() {
    this._paused = false;
    this._notifyWorkers();
  }

  async close() {
    this._closed = true;
    // Workers stop polling; in-flight jobs finish (close is non-blocking —
    // the worker.close() promise handles waiting for in-flight).
    for (const w of this._workers) {
      w._stop();
    }
    REGISTRY.delete(this.name);
  }

  // Alias for close() — BullMQ uses both close() and disconnect().
  async disconnect() {
    return this.close();
  }

  // -----------------------------------------------------------------
  // Worker coordination — internal polling
  // -----------------------------------------------------------------

  /**
   * Pull the next waiting job (highest priority, FIFO within priority).
   * Returns undefined if the queue is empty or paused.
   */
  _pull() {
    if (this._paused || this._closed) return null;
    this._promoteDelayed();
    while (this._waiting.length > 0) {
      const id = this._waiting.shift();
      const job = this._jobs.get(id);
      if (!job) continue; // was removed
      if (job._state !== 'waiting') continue; // already processed / removed
      this._active.add(id);
      job._state = 'active';
      job.processedOn = this._clock();
      return job;
    }
    return null;
  }

  /**
   * Move any delayed jobs whose time has come into the waiting queue.
   */
  _promoteDelayed() {
    if (this._delayed.length === 0) return;
    const now = this._clock();
    const ready = [];
    const stillDelayed = [];
    for (const d of this._delayed) {
      if (d.until <= now) {
        ready.push(d);
      } else {
        stillDelayed.push(d);
      }
    }
    this._delayed = stillDelayed;
    for (const d of ready) {
      const job = this._jobs.get(d.id);
      if (job) {
        job._delayedUntil = null;
        this._enqueue(job);
      }
    }
  }

  _notifyWorkers() {
    for (const w of this._workers) {
      w._poke();
    }
  }

  _registerWorker(w) {
    this._workers.add(w);
  }

  _unregisterWorker(w) {
    this._workers.delete(w);
  }
}

// ---------------------------------------------------------------------------
// MockWorker — polls the MockQueue and processes jobs
// ---------------------------------------------------------------------------

class MockWorker {
  constructor(name, processor, opts = {}) {
    if (typeof processor !== 'function') {
      throw new MockQueueError('MockWorker requires a processor function', {
        code: 'MOCK_QUEUE_CONFIG',
      });
    }
    this.name = name;
    this._processor = processor;
    this._concurrency = Math.max(1, Number(opts.concurrency) || 1);
    this._clock = opts.clock || defaultClock;
    this._sleepFn = opts.sleepFn || defaultSleep;
    this._logger = opts.logger || makeStubLogger();
    this._queue = REGISTRY.get(name);
    if (!this._queue) {
      throw new MockQueueError(`MockWorker: no queue named "${name}" registered`, {
        code: 'MOCK_QUEUE_NOT_FOUND',
      });
    }
    this._running = false;
    this._inFlight = new Set(); // job ids currently being processed
    this._stopResolve = null; // resolve() called when the poll loop exits
    this._closed = false;
    this._queue._registerWorker(this);
    // Start polling immediately (async — don't block construction).
    this._start();
  }

  _start() {
    if (this._running) return;
    this._running = true;
    // Track the poll loop's completion promise so close() can await it. The
    // poll loop exits when _running is false AND all in-flight jobs are done.
    this._pollDonePromise = this._pollLoop().catch((err) => {
      this._logger.error('MockWorker poll loop crashed', { error: err.message });
    });
  }

  _stop() {
    this._running = false;
  }

  /**
   * Poke the worker to check for jobs immediately (instead of waiting for the
   * next poll interval). Called by the queue when a new job is added.
   */
  _poke() {
    // The poll loop checks every microtask, so a poke is a no-op. Kept for API
    // compatibility + future optimization.
  }

  async _pollLoop() {
    while (this._running) {
      // Process up to `concurrency` jobs in parallel.
      while (this._inFlight.size < this._concurrency) {
        const job = this._queue._pull();
        if (!job) break;
        this._inFlight.add(job.id);
        // Fire and forget — the loop continues to pull more jobs.
        this._processJob(job).catch((err) => {
          this._logger.error('MockWorker: job processing threw unexpectedly', {
            jobId: job.id,
            error: err.message,
          });
        });
      }
      // Yield to the event loop so processors can run. Real BullMQ blocks on
      // BRPOPLPUSH; the mock just yields.
      await this._sleepFn(0);
    }
    // Wait for in-flight jobs to finish before resolving close().
    while (this._inFlight.size > 0) {
      await this._sleepFn(0);
    }
    // _pollDonePromise resolves here — close() awaits it.
  }

  async _processJob(job) {
    const maxAttempts = Math.max(1, Number(job.opts.attempts) || 1);
    try {
      job.attemptsMade = (job.attemptsMade || 0) + 1;
      const result = await this._processor(job);
      job._finish(result);
      this._queue._active.delete(job.id);
      this._queue._completed.add(job.id);
      this._logger.debug('MockWorker: job completed', {
        jobId: job.id,
        attemptsMade: job.attemptsMade,
      });
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      this._logger.debug('MockWorker: job attempt failed', {
        jobId: job.id,
        attempt: job.attemptsMade,
        maxAttempts,
        reason,
      });
      if (job.attemptsMade < maxAttempts) {
        // Retry — back to waiting. Real BullMQ applies exponential backoff
        // with a wall-clock delay; the mock re-queues immediately (tests
        // don't want to wait). The backoff CALCULATION is logged for traceability.
        const backoffMs = this._computeBackoff(job);
        this._logger.debug('MockWorker: retrying job', {
          jobId: job.id,
          nextAttempt: job.attemptsMade + 1,
          backoffMs,
        });
        job._state = 'waiting';
        this._queue._active.delete(job.id);
        this._queue._enqueue(job);
        this._queue._notifyWorkers();
      } else {
        // Dead-letter.
        job._fail(reason);
        this._queue._active.delete(job.id);
        this._queue._failed.add(job.id);
        this._logger.warn('MockWorker: job dead-lettered (max attempts exhausted)', {
          jobId: job.id,
          attempts: job.attemptsMade,
          reason,
        });
      }
    } finally {
      this._inFlight.delete(job.id);
    }
  }

  /**
   * Compute the exponential backoff delay for a retry attempt. Matches the
   * real BullMQ calculation: delay = base * 2^(attempt-1), capped at a max.
   * The mock doesn't actually sleep — this is purely informational (logged
   * for parity with production behavior).
   */
  _computeBackoff(job) {
    const base = (job.opts.backoff && job.opts.backoff.delay) || 1000;
    const type = (job.opts.backoff && job.opts.backoff.type) || 'exponential';
    if (type === 'fixed') return base;
    // exponential
    const exp = Math.max(0, job.attemptsMade - 1);
    return Math.min(base * 2 ** exp, 5 * 60 * 1000); // cap at 5 min
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    this._running = false;
    // Wait for the poll loop to exit AND in-flight jobs to finish. The poll
    // loop's promise (_pollDonePromise) resolves only after both conditions
    // are met, so close() never returns while a job is still being processed.
    if (this._pollDonePromise) {
      await this._pollDonePromise;
    }
    this._queue._unregisterWorker(this);
  }
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

module.exports = {
  MockQueue,
  MockWorker,
  MockJob,
  MockQueueError,
  // Test helper: clear the registry between tests so state doesn't leak.
  _resetRegistry() {
    REGISTRY.clear();
  },
  _registry: REGISTRY,
};
