'use strict';

/**
 * src/queue/dead-letter.js — Phase 2.9 — Job Queue & Orchestration
 *
 * Dead-letter helpers for the BullMQ-backed queue. A dead-letter job is one
 * that exhausted all retry attempts (default 3) and landed in the `failed`
 * state. Operators inspect + re-queue them manually after fixing the root
 * cause (e.g. a broken selector, a network partition, a CAPTCHA budget that
 * ran out).
 *
 * BullMQ doesn't have a separate "dead-letter queue" data structure — failed
 * jobs live alongside completed ones, tagged with state='failed'. We expose
 * them through a thin wrapper so the operator-facing API matches the Phase
 * 2.9 spec ("queue.deadLetter() — lists failed jobs; queue.retryDeadLetter(jobId)
 * — re-queues").
 *
 * Public API (returned by queue.deadLetter()):
 *   await dl.list({ limit, offset })  → { jobs: [...], total }
 *   await dl.get(jobId)               → job | null
 *   await dl.retry(jobId)             → { ok: true } | { ok: false, error }
 *   await dl.retryAll({ limit })      → { retried: n, failed: m, errors: [...] }
 *   await dl.remove(jobId)            → { ok: true } | { ok: false, error }
 *   await dl.clear()                  → { removed: n }   (purge all failed jobs)
 *   await dl.count()                  → number
 *
 * The wrapper is DI: it accepts the backend queue (BullMQ or MockQueue) so
 * unit tests can drive it without real Redis.
 */

class DeadLetterError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'DeadLetterError';
    this.code = code || 'DEAD_LETTER_ERROR';
  }
}

/**
 * Build a dead-letter helper bound to a queue instance.
 *
 * @param {object} opts
 * @param {object} opts.queue        — the backend queue (BullMQ Queue or MockQueue)
 * @param {object} [opts.logger]     — parent logger
 * @returns {object} deadLetter helper
 */
function createDeadLetter({ queue, logger }) {
  if (!queue) {
    throw new DeadLetterError('createDeadLetter requires a queue instance', {
      code: 'DEAD_LETTER_CONFIG',
    });
  }
  const log = logger || {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  /**
   * List failed (dead-letter) jobs. Returns the raw job objects + a total
   * count. Pagination via { limit, offset } so a queue with thousands of
   * failures doesn't blow up memory.
   */
  async function list({ limit = 100, offset = 0 } = {}) {
    const failed = await queue.getFailed();
    const total = failed.length;
    const slice = failed.slice(offset, offset + limit);
    return {
      jobs: slice.map(serializeJob),
      total,
    };
  }

  /** Get a single dead-letter job by id. Returns null if not found or not failed. */
  async function get(jobId) {
    if (!jobId) return null;
    const job = await queue.getJob(jobId);
    if (!job) return null;
    const state = typeof job.getState === 'function' ? job.getState() : null;
    if (state && state !== 'failed') return null;
    return serializeJob(job);
  }

  /**
   * Retry a dead-letter job. Calls job.retry() (BullMQ + MockQueue both
   * implement this) which moves the job back to the waiting state with a
   * fresh set of attempts. Returns { ok: true } on success or
   * { ok: false, error } on failure (e.g. job not found, not in failed state).
   */
  async function retry(jobId) {
    if (!jobId) {
      return { ok: false, error: 'retry requires a jobId' };
    }
    const job = await queue.getJob(jobId);
    if (!job) {
      return { ok: false, error: `job not found: ${jobId}` };
    }
    const state = typeof job.getState === 'function' ? job.getState() : null;
    if (state && state !== 'failed') {
      return { ok: false, error: `job ${jobId} is not in failed state (got "${state}")` };
    }
    try {
      await job.retry();
      log.info('Dead-letter job re-queued', { jobId });
      return { ok: true };
    } catch (err) {
      log.warn('Dead-letter retry failed', { jobId, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  /**
   * Retry ALL dead-letter jobs (up to a limit). Useful after fixing a
   * systemic issue (e.g. a CAPTCHA budget bump, a selector fix). Returns a
   * summary so the operator knows how many actually re-queued vs failed.
   */
  async function retryAll({ limit = 1000 } = {}) {
    const failed = await queue.getFailed();
    const slice = failed.slice(0, limit);
    let retried = 0;
    let failedCount = 0;
    const errors = [];
    for (const job of slice) {
      const r = await retry(job.id);
      if (r.ok) {
        retried++;
      } else {
        failedCount++;
        errors.push({ jobId: job.id, error: r.error });
      }
    }
    log.info('Dead-letter retryAll complete', { retried, failed: failedCount, total: slice.length });
    return { retried, failed: failedCount, total: slice.length, errors };
  }

  /**
   * Permanently remove a dead-letter job from the queue. The job data is
   * lost (BullMQ deletes it from Redis). Use when the job is genuinely
   * un-retryable (e.g. invalid payload that slipped past validation).
   */
  async function remove(jobId) {
    if (!jobId) return { ok: false, error: 'remove requires a jobId' };
    const job = await queue.getJob(jobId);
    if (!job) return { ok: false, error: `job not found: ${jobId}` };
    try {
      await job.remove();
      log.info('Dead-letter job removed', { jobId });
      return { ok: true };
    } catch (err) {
      log.warn('Dead-letter remove failed', { jobId, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  /** Purge all dead-letter jobs. Returns the count removed. */
  async function clear() {
    const failed = await queue.getFailed();
    let removed = 0;
    for (const job of failed) {
      try {
        await job.remove();
        removed++;
      } catch (err) {
        log.warn('Dead-letter clear: job remove failed', { jobId: job.id, error: err.message });
      }
    }
    log.info('Dead-letter cleared', { removed, total: failed.length });
    return { removed, total: failed.length };
  }

  /** Count of dead-letter jobs (cheap — just getFailed().length). */
  async function count() {
    const failed = await queue.getFailed();
    return failed.length;
  }

  return {
    list,
    get,
    retry,
    retryAll,
    remove,
    clear,
    count,
  };
}

/**
 * Serialize a BullMQ / MockJob into a plain object for CLI / API output.
 * Strips methods + circular refs so the result is JSON-safe.
 */
function serializeJob(job) {
  if (!job) return null;
  const state = typeof job.getState === 'function' ? job.getState() : null;
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    state,
    progress: job.progress,
    returnvalue: job.returnvalue,
    failedReason: job.failedReason,
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    opts: job.opts,
  };
}

module.exports = {
  createDeadLetter,
  DeadLetterError,
  serializeJob,
};
