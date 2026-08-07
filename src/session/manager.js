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
 * @returns {{ getContext, tickRequest, shouldRotate, rotate, release, stats, current }}
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

  // --- Internal state -----------------------------------------------------
  // The "current" session is the one serving requests. It's replaced on
  // rotation. The `sessions` array holds ALL sessions (current + historical)
  // so stats() can compute averages across the whole run.
  let current = null; // { context, page, record }
  let nextId = 1;
  const sessions = []; // all session records (for stats)
  let rotations = 0;

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
   * True when requestCount >= maxRequests OR age >= maxAgeMs.
   * Returns { rotate, reason, requestCount, ageMs }.
   */
  function shouldRotate() {
    if (!current) return { rotate: false, reason: null, requestCount: 0, ageMs: 0 };
    const now = clock();
    const ageMs = now - current.record.createdAt;
    const requestCount = current.record.requestCount;
    if (requestCount >= maxRequests) {
      return { rotate: true, reason: 'max-requests', requestCount, ageMs };
    }
    if (ageMs >= maxAgeMs) {
      return { rotate: true, reason: 'max-age', requestCount, ageMs };
    }
    return { rotate: false, reason: null, requestCount, ageMs };
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
   * @param {object} [args] { browser, proxy, fingerprint, label }
   * @returns {Promise<{ rotated: boolean, reason: string|null, page: object, sessionInfo: object }>}
   */
  async function tickRequest({ browser, proxy, fingerprint, label } = {}) {
    if (!current) {
      // No session yet — open one. This counts as the first request.
      const r = await openSession({ browser, proxy, fingerprint });
      current.record.requestCount = 1;
      return { rotated: true, reason: 'initial', page: r.page, sessionInfo: r.sessionInfo };
    }
    current.record.requestCount++;
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
        label: label || null,
      });
    }
    const r = await rotate({ browser, proxy, fingerprint, reason: check.reason });
    return { rotated: true, reason: check.reason, page: r.page, sessionInfo: r.sessionInfo };
  }

  /**
   * Aggregate stats across all sessions (current + historical).
   * Returns { sessionsCreated, rotations, totalRequests, avgRequestsPerSession, avgAgeMs, current }.
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
  defaultClock,
  defaultSleep,
};
