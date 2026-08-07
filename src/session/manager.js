'use strict';

/**
 * src/session/manager.js — Phase 2.7 — Session & Cookie Rotation
 *
 * Manages browser-context lifecycle so a long scrape distributes traffic across
 * many distinct sessions instead of one long-lived cookie jar. Each session:
 *   - starts with ZERO cookies (Playwright contexts are isolated by default)
 *   - has its own fingerprint + proxy (passed in at creation time)
 *   - is optionally "warmed up" (visits a benign page before hitting Maps)
 *   - is rotated when EITHER maxRequests OR maxAgeMs is exceeded
 *
 * The manager is fully DI: createContext / clock / sleepFn are injectable so
 * unit tests never touch a real browser. In production, createContext is wired
 * to a function that calls browser.newContext(opts) + applies fingerprint +
 * stealth + returns { context, page } (see src/session/context-factory.js).
 *
 * Public API:
 *   const mgr = createSessionManager({ maxRequests, maxAgeMs, warmup, warmupFn, createContext, clock, logger });
 *   const { context, page, isNew, sessionInfo } = await mgr.getContext({ browser, proxy, fingerprint });
 *   const r = await mgr.tickRequest({ label });           // increments counter; rotates if needed
 *   const yes = mgr.shouldRotate();                        // pure check (count OR age)
 *   const r = await mgr.rotate({ browser, proxy, fingerprint }); // force rotation
 *   await mgr.release();                                   // close current context
 *   const s = mgr.stats();                                 // { sessionsCreated, rotations, ... }
 */

// ---------------------------------------------------------------------------
// Defaults + errors
// ---------------------------------------------------------------------------

const DEFAULT_MAX_REQUESTS = 50;
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

// Phase 2.10 — periodic context restart. Default 0 = disabled (preserves
// Phase 2.7 behavior exactly). When > 0, the context is force-restarted every
// N tasks REGARDLESS of session rotation, to clear accumulated Chrome memory
// that session rotation alone doesn't reclaim. This is the "memory mitigation"
// knob — see PHASE2_EXECUTION_PLAN.md → Phase 2.10.
const DEFAULT_CONTEXT_RESTART_EVERY = 0;

class SessionError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'SessionError';
    this.code = code || 'SESSION_ERROR';
  }
}

function defaultClock() {
  return Date.now();
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Session record — one per created context
// ---------------------------------------------------------------------------

/**
 * A session record tracks ONE context's lifecycle: when it was created, how
 * many requests it has served, and whether it has been rotated out.
 * Kept as a plain object so stats() is a pure aggregation over the array.
 */
function createSessionRecord({ id, createdAt, proxy, fingerprint }) {
  return {
    id,
    createdAt,
    closedAt: null,
    rotatedAt: null,
    rotationReason: null, // 'max-requests' | 'max-age' | 'manual' | null
    requestCount: 0,
    proxy: proxy ? { id: proxy.id || null, server: proxy.server || null } : null,
    fingerprint: fingerprint
      ? { userAgent: fingerprint.userAgent, platform: fingerprint.platform }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Manager factory
// ---------------------------------------------------------------------------

/**
 * Create a session manager.
 *
 * @param {object} opts
 * @param {number} [opts.maxRequests=50]     — rotate after this many requests
 * @param {number} [opts.maxAgeMs=600000]    — rotate after this many ms
 * @param {boolean} [opts.warmup=true]       — run warmupFn on each new context
 * @param {Function} [opts.warmupFn]         — async (page, ctx) => { visited, waitedMs }
 * @param {Function} [opts.createContext]    — async ({ browser, proxy, fingerprint }) => { context, page }
 * @param {()=>number} [opts.clock]          — injectable clock (default Date.now)
 * @param {(ms:number)=>Promise<void>} [opts.sleepFn] — injectable sleep
 * @param {object} [opts.logger]
 * @param {number} [opts.contextRestartEvery=0] — Phase 2.10: force-restart the context
 *                                              every N tasks (independent of rotation).
 *                                              0 = off (preserves Phase 2.7 behavior).
 * @param {()=>object} [opts.getMemory]      — Phase 2.10: DI process.memoryUsage accessor.
 *                                              When supplied + memoryThresholdMb set, the
 *                                              manager can force-restart the context on
 *                                              heap pressure (see shouldRestartForMemory).
 * @param {number} [opts.memoryThresholdMb]  — Phase 2.10: heap threshold (MB) that triggers
 *                                              a forced context restart.
 * @returns {{ getContext, tickRequest, shouldRotate, rotate, release, stats, current,
 *             shouldRestartForMemory, restartForMemory, tasksSinceRestart, contextRestarts }}
 */
function createSessionManager(opts = {}) {
  const maxRequests = opts.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const warmupEnabled = opts.warmup !== false;
  const warmupFn = opts.warmupFn || null;
  const createContext = opts.createContext;
  const clock = opts.clock || defaultClock;
  const sleepFn = opts.sleepFn || defaultSleep;
  const logger = opts.logger || null;
  // Phase 2.10 — periodic context restart. When > 0, the context is force-
  // restarted every N tasks (independent of session rotation) to reclaim
  // Chrome memory. Default 0 = off (preserves Phase 2.7 behavior).
  // Validation: an explicit negative number is an error (throw). A non-finite
  // value or undefined falls back to the default.
  let contextRestartEvery;
  if (opts.contextRestartEvery === undefined || opts.contextRestartEvery === null) {
    contextRestartEvery = DEFAULT_CONTEXT_RESTART_EVERY;
  } else if (!Number.isFinite(opts.contextRestartEvery)) {
    throw new SessionError(
      `contextRestartEvery must be a finite number (got ${opts.contextRestartEvery})`,
      { code: 'INVALID_CONTEXT_RESTART_EVERY' },
    );
  } else if (opts.contextRestartEvery < 0) {
    throw new SessionError(
      `contextRestartEvery must be 0 (off) or >= 1 (got ${opts.contextRestartEvery})`,
      { code: 'INVALID_CONTEXT_RESTART_EVERY' },
    );
  } else {
    contextRestartEvery = opts.contextRestartEvery > 0 ? Math.floor(opts.contextRestartEvery) : 0;
  }
  // Phase 2.10 — DI memory accessor for forced memory-based restart. When
  // supplied, shouldRestartForMemory() reads it + returns true when heap
  // exceeds the threshold. The main entry point wires this to a per-worker
  // process.memoryUsage() reader. Default null = memory-based restart off.
  const getMemory =
    typeof opts.getMemory === 'function' ? opts.getMemory : null;
  const memoryThresholdMb =
    Number.isFinite(opts.memoryThresholdMb) && opts.memoryThresholdMb > 0
      ? opts.memoryThresholdMb
      : null;

  if (typeof createContext !== 'function') {
    throw new SessionError('createSessionManager requires a createContext function', {
      code: 'NO_CREATE_CONTEXT',
    });
  }
  if (!Number.isFinite(maxRequests) || maxRequests < 1) {
    throw new SessionError(`maxRequests must be a finite number >= 1 (got ${maxRequests})`, {
      code: 'INVALID_MAX_REQUESTS',
    });
  }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 1) {
    throw new SessionError(`maxAgeMs must be a finite number >= 1 (got ${maxAgeMs})`, {
      code: 'INVALID_MAX_AGE',
    });
  }
  // (Phase 2.10 contextRestartEvery validation moved up to the resolution
  // block — we need to throw on a bad EXPLICIT value, not the resolved
  // default.)

  // --- Internal state -----------------------------------------------------
  // The "current" session is the one serving requests. It's replaced on
  // rotation. The `sessions` array holds ALL sessions (current + historical)
  // so stats() can compute averages across the whole run.
  let current = null; // { context, page, record }
  let nextId = 1;
  const sessions = []; // all session records (for stats)
  let rotations = 0;
  // Phase 2.10 — periodic context restart counters. `tasksSinceRestart` is
  // reset to 0 every time the context is force-restarted (via contextRestartEvery
  // OR via restartForMemory). `contextRestarts` is the lifetime count.
  let tasksSinceRestart = 0;
  let contextRestarts = 0;
  // Phase 2.10 — high-water heap observed at the moment of the last forced
  // restart (for the "Context restarted (tasks=50, heapBefore=X, heapAfter=Y)"
  // log line). null before the first restart.
  let lastRestartHeapMb = null;

  /**
   * Create a brand-new context + page, record it as the current session, and
   * optionally warm it up. Does NOT close any prior context — call release()
   * or rotate() for that.
   *
   * @param {object} args { browser, proxy, fingerprint }
   * @returns {Promise<{ context, page, isNew, sessionInfo }>}
   */
  async function openSession({ browser, proxy, fingerprint }) {
    const id = `session-${nextId++}`;
    const createdAt = clock();
    if (logger) {
      logger.debug('Session manager: opening new session', {
        sessionId: id,
        proxy: proxy ? proxy.id || proxy.server : null,
        fingerprint: fingerprint ? fingerprint.platform : null,
        warmup: warmupEnabled,
      });
    }
    const { context, page } = await createContext({ browser, proxy, fingerprint });
    const record = createSessionRecord({ id, createdAt, proxy, fingerprint });
    sessions.push(record);
    current = { context, page, record };

    // Warmup: visit a benign page so the session doesn't look like a
    // zero-history bot hitting Maps directly. Best-effort — a warmup failure
    // is non-fatal (the session is still usable).
    if (warmupEnabled && warmupFn) {
      try {
        const r = await warmupFn(page, { logger, sleepFn });
        record.warmup = r;
        if (logger) {
          logger.info('Session warmup complete', {
            sessionId: id,
            visited: r.visited,
            waitedMs: r.waitedMs,
          });
        }
      } catch (err) {
        if (logger) logger.warn('Session warmup failed (non-fatal)', { sessionId: id, error: err.message });
      }
    }

    if (logger) {
      logger.info('Session created', {
        sessionId: id,
        proxy: proxy ? proxy.id || proxy.server : 'direct',
        maxRequests,
        maxAgeMs,
      });
    }
    return {
      context,
      page,
      isNew: true,
      sessionInfo: sessionInfoFor(current.record, { clock }),
    };
  }

  /**
   * Get the current context, creating one if none exists. Does NOT rotate —
   * call tickRequest() for that. Returns { context, page, isNew, sessionInfo }.
   */
  async function getContext({ browser, proxy, fingerprint } = {}) {
    if (current) {
      return {
        context: current.context,
        page: current.page,
        isNew: false,
        sessionInfo: sessionInfoFor(current.record, { clock }),
      };
    }
    return openSession({ browser, proxy, fingerprint });
  }

  /**
   * Pure check: should the current session be rotated?
   * True when requestCount >= maxRequests OR age >= maxAgeMs OR (Phase 2.10)
   * tasksSinceRestart >= contextRestartEvery.
   * Returns { rotate, reason, requestCount, ageMs, tasksSinceRestart }.
   */
  function shouldRotate() {
    if (!current) {
      return { rotate: false, reason: null, requestCount: 0, ageMs: 0, tasksSinceRestart };
    }
    const now = clock();
    const ageMs = now - current.record.createdAt;
    const requestCount = current.record.requestCount;
    if (requestCount >= maxRequests) {
      return { rotate: true, reason: 'max-requests', requestCount, ageMs, tasksSinceRestart };
    }
    if (ageMs >= maxAgeMs) {
      return { rotate: true, reason: 'max-age', requestCount, ageMs, tasksSinceRestart };
    }
    // Phase 2.10 — periodic context restart takes precedence over normal
    // session rotation when configured. The reason is distinct ('context-restart')
    // so the caller can log it differently + the post-rotation tasksSinceRestart
    // counter resets (a normal rotation does NOT reset it — only a forced
    // context restart does, because the whole point is clearing Chrome memory).
    if (contextRestartEvery > 0 && tasksSinceRestart >= contextRestartEvery) {
      return {
        rotate: true,
        reason: 'context-restart',
        requestCount,
        ageMs,
        tasksSinceRestart,
      };
    }
    return { rotate: false, reason: null, requestCount, ageMs, tasksSinceRestart };
  }

  /**
   * Phase 2.10 — Pure check: should the current context be force-restarted
   * because of heap pressure? Reads getMemory() (DI) and compares heapUsed
   * against memoryThresholdMb. Returns { restart, heapUsedMb, thresholdMb }.
   * When getMemory or memoryThresholdMb is not configured, always returns
   * { restart: false } (memory-based restart disabled — preserves Phase 2.7).
   */
  function shouldRestartForMemory() {
    if (!getMemory || !memoryThresholdMb || !current) {
      return { restart: false, heapUsedMb: null, thresholdMb: memoryThresholdMb || null };
    }
    let mem;
    try {
      mem = getMemory();
    } catch {
      return { restart: false, heapUsedMb: null, thresholdMb: memoryThresholdMb };
    }
    const heapUsedMb = Math.round((mem.heapUsed || 0) / (1024 * 1024));
    return {
      restart: heapUsedMb >= memoryThresholdMb,
      heapUsedMb,
      thresholdMb: memoryThresholdMb,
    };
  }

  /**
   * Phase 2.10 — Force a context restart for memory reclamation. Closes the
   * current context (with a brief wait for Chrome to settle), opens a new one,
   * and resets tasksSinceRestart. Logs the before/after heap so the operator
   * can see the sawtooth pattern. Best-effort — never throws.
   *
   * @param {object} args { browser, proxy, fingerprint, reason }
   * @returns {Promise<{ context, page, sessionInfo, heapBeforeMb, heapAfterMb }>}
   */
  async function restartForMemory({ browser, proxy, fingerprint, reason = 'memory' } = {}) {
    const heapBeforeMb = (() => {
      if (!getMemory) return null;
      try {
        return Math.round((getMemory().heapUsed || 0) / (1024 * 1024));
      } catch {
        return null;
      }
    })();
    if (logger) {
      logger.info('Context restart — reclaiming memory', {
        reason,
        tasksSinceRestart,
        heapBeforeMb,
        thresholdMb: memoryThresholdMb,
      });
    }
    // Rotate (close + reopen). The rotation reason is recorded on the OLD
    // session's record for stats. We pass reason='context-restart' so stats()
    // can distinguish memory-driven restarts from rotation-driven ones.
    const r = await rotate({ browser, proxy, fingerprint, reason: 'context-restart' });
    contextRestarts++;
    lastRestartHeapMb = heapBeforeMb;
    tasksSinceRestart = 0;
    // Give Chrome a moment to actually release the old context's memory before
    // we sample heapAfter (otherwise we'd read the pre-GC number).
    if (sleepFn) await sleepFn(50);
    const heapAfterMb = (() => {
      if (!getMemory) return null;
      try {
        return Math.round((getMemory().heapUsed || 0) / (1024 * 1024));
      } catch {
        return null;
      }
    })();
    if (logger) {
      logger.info(
        `Context restarted (tasks=${tasksSinceRestart}, heapBefore=${heapBeforeMb === null ? '?' : heapBeforeMb + 'MB'}, heapAfter=${heapAfterMb === null ? '?' : heapAfterMb + 'MB'})`,
        { reason, contextRestarts, heapBeforeMb, heapAfterMb },
      );
    }
    return {
      context: r.context,
      page: r.page,
      sessionInfo: r.sessionInfo,
      heapBeforeMb,
      heapAfterMb,
    };
  }

  /**
   * Close the current context (clearing its cookies + storage). Does NOT
   * create a new one — the next getContext() / openSession() call does that.
   */
  async function release() {
    if (!current) return;
    const rec = current.record;
    rec.closedAt = clock();
    try {
      await current.context.close();
    } catch (err) {
      if (logger) logger.warn('Session manager: context.close() failed (non-fatal)', { sessionId: rec.id, error: err.message });
    }
    if (logger) {
      logger.debug('Session closed', {
        sessionId: rec.id,
        requestCount: rec.requestCount,
        ageMs: rec.closedAt - rec.createdAt,
      });
    }
    current = null;
  }

  /**
   * Force a rotation: close the current context, open a new one (with warmup),
   * and return the new { context, page, sessionInfo }. The rotation reason is
   * recorded on the OLD session's record (for stats).
   *
   * @param {object} args { browser, proxy, fingerprint, reason }
   */
  async function rotate({ browser, proxy, fingerprint, reason = 'manual' } = {}) {
    if (current) {
      const now = clock();
      current.record.rotatedAt = now;
      current.record.rotationReason = reason;
      rotations++;
      if (logger) {
        logger.info('Session rotated', {
          sessionId: current.record.id,
          reason,
          requests: current.record.requestCount,
          age: `${((now - current.record.createdAt) / 1000 / 60).toFixed(1)}min`,
        });
      }
    }
    await release();
    return openSession({ browser, proxy, fingerprint });
  }

  /**
   * Record a request against the current session. If the session is exhausted
   * (count OR age), rotate automatically. Returns the rotation result so the
   * caller knows whether the page reference changed (and must re-navigate).
   *
   * Phase 2.10 — also bumps `tasksSinceRestart`. When a context-restart
   * rotation fires (tasksSinceRestart >= contextRestartEvery), the counter
   * is reset (a forced restart reclaims Chrome memory; the rotation alone
   * does not, so we only reset on the forced-restart path).
   *
   * @param {object} [args] { browser, proxy, fingerprint, label }
   * @returns {Promise<{ rotated: boolean, reason: string|null, page: object, sessionInfo: object }>}
   */
  async function tickRequest({ browser, proxy, fingerprint, label } = {}) {
    if (!current) {
      // No session yet — open one. This counts as the first request.
      const r = await openSession({ browser, proxy, fingerprint });
      current.record.requestCount = 1;
      tasksSinceRestart++;
      return { rotated: true, reason: 'initial', page: r.page, sessionInfo: r.sessionInfo };
    }
    current.record.requestCount++;
    tasksSinceRestart++;
    const check = shouldRotate();
    if (!check.rotate) {
      return {
        rotated: false,
        reason: null,
        page: current.page,
        sessionInfo: sessionInfoFor(current.record, { clock }),
      };
    }
    if (logger) {
      logger.debug('Session manager: rotation triggered', {
        reason: check.reason,
        requestCount: check.requestCount,
        ageMs: check.ageMs,
        tasksSinceRestart: check.tasksSinceRestart,
        label: label || null,
      });
    }
    const r = await rotate({ browser, proxy, fingerprint, reason: check.reason });
    // Phase 2.10 — only a context-restart rotation resets the counter. A
    // normal max-requests / max-age rotation does NOT (the context was
    // rotated for anti-block reasons, not memory reclamation).
    if (check.reason === 'context-restart') {
      contextRestarts++;
      tasksSinceRestart = 0;
      if (logger) {
        logger.info('Context restarted (periodic)', {
          reason: check.reason,
          contextRestarts,
          requestCount: check.requestCount,
        });
      }
    }
    return { rotated: true, reason: check.reason, page: r.page, sessionInfo: r.sessionInfo };
  }

  /**
   * Aggregate stats across all sessions (current + historical).
   * Returns { sessionsCreated, rotations, totalRequests, avgRequestsPerSession, avgAgeMs, current,
   *            contextRestarts, tasksSinceRestart, lastRestartHeapMb }.
   */
  function stats() {
    const closedSessions = sessions.filter((s) => s.closedAt !== null);
    const totalRequests = sessions.reduce((sum, s) => sum + s.requestCount, 0);
    const ages = closedSessions.map((s) => s.closedAt - s.createdAt);
    const avgAgeMs = ages.length === 0 ? 0 : Math.round(ages.reduce((a, b) => a + b, 0) / ages.length);
    const avgReqs = sessions.length === 0 ? 0 : Math.round((totalRequests / sessions.length) * 10) / 10;
    return {
      sessionsCreated: sessions.length,
      rotations,
      totalRequests,
      avgRequestsPerSession: avgReqs,
      avgAgeMs,
      current: current
        ? sessionInfoFor(current.record, { clock })
        : null,
      maxRequests,
      maxAgeMs,
      warmup: warmupEnabled,
      // Phase 2.10
      contextRestartEvery,
      contextRestarts,
      tasksSinceRestart,
      lastRestartHeapMb,
    };
  }

  /** Read-only accessor for the current session's { context, page, record }. */
  function currentSession() {
    return current;
  }

  return {
    getContext,
    tickRequest,
    shouldRotate,
    rotate,
    release,
    stats,
    current: currentSession,
    // Phase 2.10
    shouldRestartForMemory,
    restartForMemory,
    get tasksSinceRestart() {
      return tasksSinceRestart;
    },
    get contextRestarts() {
      return contextRestarts;
    },
  };
}

/**
 * Build a serializable snapshot of a session record for logging / return values.
 */
function sessionInfoFor(record, { clock }) {
  const now = (clock || defaultClock)();
  return {
    id: record.id,
    createdAt: record.createdAt,
    ageMs: now - record.createdAt,
    requestCount: record.requestCount,
    proxy: record.proxy,
    fingerprint: record.fingerprint,
    warmup: record.warmup || null,
  };
}

module.exports = {
  createSessionManager,
  createSessionRecord,
  sessionInfoFor,
  SessionError,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_CONTEXT_RESTART_EVERY,
  defaultClock,
  defaultSleep,
};
