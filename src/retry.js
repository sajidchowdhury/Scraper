'use strict';

/**
 * src/retry.js — Phase 1.7 — Retry with exponential backoff
 *
 * Wraps a transient async operation in a retry loop:
 *   - attempts: 3 (default)
 *   - backoff: 1s → 2s → 4s (default, exponential: base * 2^attempt)
 *   - on each failure: log WARN with attempt #, backoff ms, error message
 *   - on final failure: re-throw the last error so the caller can decide
 *     (skip / log / propagate). Per Phase 1.7 spec, transient failures should
 *     be logged-and-skipped at the business level, not crash the whole run.
 *
 * Design notes:
 *   - Backoff schedule is `[base*1, base*2, base*4, ...]` capped at attempts.
 *     With base=1000 and attempts=3 the sleeps are 1000ms, 2000ms, 4000ms
 *     BEFORE each retry (so a success on attempt 1 has zero sleep).
 *   - Optional `retryIf` predicate: if provided, only retries when
 *     `retryIf(err)` returns true. This lets callers exclude non-transient
 *     errors (e.g. a selector-not-found that won't fix itself) from wasting
 *     retry budget.
 *   - Sleep is injectable for unit testing (so tests don't actually wait).
 *
 * DI pattern matches src/scroll.js and src/detail.js.
 *
 * Phase 1.9: every log line is bound to the 'retry' phase so the JSON-lines
 * log file can be filtered by pipeline stage.
 */

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the backoff delay (ms) for a given attempt index (0-based).
 * attempt 0 → base*1, attempt 1 → base*2, attempt 2 → base*4, ...
 *
 * @param {number} attempt  0-based attempt index
 * @param {number} baseMs   base backoff in ms
 * @returns {number} delay in ms
 */
function backoffMs(attempt, baseMs) {
  return baseMs * Math.pow(2, attempt);
}

/**
 * Retry an async operation with exponential backoff.
 *
 * @param {() => Promise<T>} fn          - the operation to retry
 * @param {object} opts
 * @param {number} [opts.attempts=3]     - total attempts (including the first)
 * @param {number} [opts.baseMs=1000]    - base backoff; doubles each retry
 * @param {string} [opts.label]          - human-readable label for log lines
 * @param {(err: Error) => boolean} [opts.retryIf] - only retry if this returns true
 * @param {(ms: number) => Promise<void>} [opts.sleep] - injectable sleep (tests)
 * @param {object} [opts.logger]         - logger with .warn/.debug
 * @returns {Promise<T>} resolves with the first successful result; rejects
 *                        with the last error if all attempts fail.
 * @template T
 */
async function withRetry(fn, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  const label = opts.label || 'operation';
  const retryIf = opts.retryIf || (() => true);
  const sleep = opts.sleep || defaultSleep;
  const rawLogger = opts.logger || {
    warn() {},
    debug() {},
    info() {},
  };
  // Phase 1.9 — bind retry log lines to the 'retry' phase (no-op for stubs).
  const logger = rawLogger && rawLogger.phase ? rawLogger.phase('retry') : rawLogger;

  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        logger.debug(`${label} succeeded after retry`, { attempt: attempt + 1 });
      }
      return result;
    } catch (err) {
      lastErr = err;
      const isLast = attempt === attempts - 1;
      const willRetry = !isLast && retryIf(err);
      if (!willRetry) {
        // Either out of attempts, or retryIf says don't bother — re-throw.
        logger.warn(`${label} failed (no more retries)`, {
          attempt: attempt + 1,
          error: err.message,
        });
        throw err;
      }
      const delay = backoffMs(attempt, baseMs);
      logger.warn(`${label} failed — retrying`, {
        attempt: attempt + 1,
        nextAttemptMs: delay,
        error: err.message,
      });
      await sleep(delay);
    }
  }
  // Should be unreachable (loop throws on last attempt), but keep for safety.
  throw lastErr;
}

module.exports = { withRetry, backoffMs, defaultSleep };
