'use strict';

/**
 * src/proxy/burn-detector.js — Phase 2.3
 *
 * Pure per-proxy health tracking + burn decision logic. Kept separate from
 * the proxy pool (src/proxy.js) so:
 *   - Unit tests can exercise burn thresholds without spinning up a pool.
 *   - The pool can delegate burn decisions to this module via DI.
 *   - Future strategies (e.g. ML-based anomaly detection) can be dropped in
 *     without touching the pool's acquire/release flow.
 *
 * Per-proxy tracked state:
 *   - requestCount       total acquire→release cycles seen
 *   - successCount       releases with { success: true }
 *   - recentStatusCodes  sliding window of the last N status codes (default 10)
 *   - consecutiveFails   running counter of failures since last success
 *   - consecutiveTimeouts running counter of connection timeouts
 *   - state              'healthy' | 'cooldown' | 'burned' (permanent)
 *   - burnedAt           epoch-ms when the proxy entered its current burn state
 *   - burnReason         human-readable string for the burn log
 *
 * Auto-burn conditions (any one triggers a *cooldown* burn, NOT permanent):
 *   1. Three (3) consecutive HTTP 403/429 responses.
 *   2. Success rate below 50% over the last 20 requests (min 5 requests first).
 *   3. Three (3) consecutive connection timeouts (statusCode === 'TIMEOUT').
 *
 * Permanent burn conditions (proxy removed from the pool entirely):
 *   - HTTP 407 (Proxy Authentication Required) — credentials are bad; retry
 *     is pointless.
 *   - Explicit markPermanent(proxyId, reason) call from the pool operator
 *     (e.g. the provider API says the IP is retired).
 *
 * Cooldown recovery:
 *   - A cooldown proxy re-enters rotation after `cooldownMs` (default 10 min).
 *   - isReusable(proxyId, now) returns true once the cooldown window elapses.
 *   - On reuse, the per-proxy counters are reset so the proxy gets a clean
 *     slate (but `burnedAt` is cleared so it's treated as healthy again).
 *
 * Design rules (per project conventions):
 *   - All functions are pure with respect to `now` (injectable clock) so tests
 *     are deterministic.
 *   - No I/O — no file writes, no network. The pool writes the burn log.
 *   - The detector does NOT decide which proxy to acquire next; it only answers
 *     "is this one usable right now?" and "should I burn it given this outcome?".
 */

// ---------------------------------------------------------------------------
// Constants & defaults
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW = 10; // recentStatusCodes sliding window
const DEFAULT_BURN_WINDOW = 20; // success-rate evaluation window
const DEFAULT_MIN_RATE_SAMPLES = 5; // need at least this many requests before rate-burn
const DEFAULT_RATE_THRESHOLD = 0.5; // burn if success rate < 50%
const DEFAULT_CONSEC_BLOCK = 3; // 3 consecutive 403/429 → burn
const DEFAULT_CONSEC_TIMEOUT = 3; // 3 consecutive timeouts → burn
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

const BLOCK_STATUSES = new Set([403, 429]);
const PERMANENT_STATUSES = new Set([407]);
const TIMEOUT_CODE = 'TIMEOUT';

/**
 * @typedef {'healthy'|'cooldown'|'burned'} ProxyState
 */

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a burn detector instance.
 *
 * @param {object} opts
 * @param {number} [opts.cooldownMs=600000]      How long a cooldown burn lasts.
 * @param {number} [opts.statusWindow=10]        Sliding window for recent codes.
 * @param {number} [opts.rateWindow=20]          Window for success-rate evaluation.
 * @param {number} [opts.rateThreshold=0.5]      Burn if success rate < this.
 * @param {number} [opts.minRateSamples=5]       Min requests before rate-burn.
 * @param {number} [opts.consecutiveBlock=3]     Consecutive 403/429 to burn.
 * @param {number} [opts.consecutiveTimeout=3]   Consecutive timeouts to burn.
 * @param {() => number} [opts.now]              Injectable clock (Date.now).
 * @returns {object} Burn detector API.
 */
function createBurnDetector(opts = {}) {
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const statusWindow = opts.statusWindow ?? DEFAULT_WINDOW;
  const rateWindow = opts.rateWindow ?? DEFAULT_BURN_WINDOW;
  const rateThreshold = opts.rateThreshold ?? DEFAULT_RATE_THRESHOLD;
  const minRateSamples = opts.minRateSamples ?? DEFAULT_MIN_RATE_SAMPLES;
  const consecutiveBlock = opts.consecutiveBlock ?? DEFAULT_CONSEC_BLOCK;
  const consecutiveTimeout = opts.consecutiveTimeout ?? DEFAULT_CONSEC_TIMEOUT;
  const now = opts.now || (() => Date.now());

  // proxyId → tracked state
  const proxies = new Map();

  function ensureEntry(proxyId) {
    if (!proxies.has(proxyId)) {
      proxies.set(proxyId, {
        id: proxyId,
        requestCount: 0,
        successCount: 0,
        recentStatusCodes: [], // sliding window of last `statusWindow` codes
        recentOutcomes: [], // sliding window of last `rateWindow` booleans (true=success)
        consecutiveFails: 0,
        consecutiveTimeouts: 0,
        state: 'healthy', // ProxyState
        burnedAt: null, // epoch-ms when state last changed to cooldown/burned
        burnReason: null,
        burnCount: 0, // how many times this proxy has entered cooldown
      });
    }
    return proxies.get(proxyId);
  }

  /**
   * Decide whether a status code (number or 'TIMEOUT' string) should count as
   * a "blocked" response for the consecutive-block burn rule.
   */
  function isBlockCode(code) {
    return typeof code === 'number' && BLOCK_STATUSES.has(code);
  }
  function isPermanentCode(code) {
    return typeof code === 'number' && PERMANENT_STATUSES.has(code);
  }
  function isTimeoutCode(code) {
    return code === TIMEOUT_CODE;
  }

  /**
   * Inspect the current state of a proxy and decide if it should be burned.
   * Returns null (healthy) or { kind: 'cooldown'|'permanent', reason }.
   *
   * Pure — does not mutate state. The caller (record) applies the decision.
   */
  function evaluate(entry) {
    // Permanent auth failure → remove entirely.
    // (The most recent status code is checked first because it's the most
    // informative signal; a 407 on any single request means the credentials
    // are wrong and retrying won't help.)
    const lastCode = entry.recentStatusCodes[entry.recentStatusCodes.length - 1];
    if (isPermanentCode(lastCode)) {
      return {
        kind: 'permanent',
        reason: `HTTP 407 (Proxy Authentication Required) on last request`,
      };
    }

    // 3 consecutive 403/429 → cooldown burn.
    if (entry.consecutiveFails >= consecutiveBlock) {
      // Check that the last N failures were all block codes (not just any fail).
      const tail = entry.recentStatusCodes.slice(-consecutiveBlock);
      if (tail.length === consecutiveBlock && tail.every(isBlockCode)) {
        return {
          kind: 'cooldown',
          reason: `${consecutiveBlock} consecutive 403/429 responses`,
        };
      }
    }

    // 3 consecutive timeouts → cooldown burn.
    if (entry.consecutiveTimeouts >= consecutiveTimeout) {
      return {
        kind: 'cooldown',
        reason: `${consecutiveTimeout} consecutive connection timeouts`,
      };
    }

    // Success rate < threshold over the last `rateWindow` requests.
    if (entry.recentOutcomes.length >= minRateSamples) {
      const window = entry.recentOutcomes.slice(-rateWindow);
      const successes = window.filter(Boolean).length;
      const rate = successes / window.length;
      if (rate < rateThreshold) {
        return {
          kind: 'cooldown',
          reason: `success rate ${Math.round(rate * 100)}% over last ${window.length} requests (threshold ${Math.round(rateThreshold * 100)}%)`,
        };
      }
    }

    return null;
  }

  function applyBurn(entry, decision) {
    entry.burnCount += 1;
    entry.burnedAt = now();
    entry.burnReason = decision.reason;
    if (decision.kind === 'permanent') {
      entry.state = 'burned';
    } else {
      entry.state = 'cooldown';
    }
  }

  /**
   * Record the outcome of a single acquire→release cycle for a proxy.
   * Mutates state; may transition the proxy to cooldown or burned.
   *
   * @param {string} proxyId
   * @param {{success: boolean, statusCode?: number|string}} outcome
   * @returns {{burned: boolean, kind?: 'cooldown'|'permanent', reason?: string}}
   */
  function record(proxyId, outcome) {
    const entry = ensureEntry(proxyId);
    entry.requestCount += 1;

    const success = !!outcome.success;
    if (success) {
      entry.successCount += 1;
      entry.consecutiveFails = 0;
      entry.consecutiveTimeouts = 0;
    } else {
      entry.consecutiveFails += 1;
      if (isTimeoutCode(outcome.statusCode)) {
        entry.consecutiveTimeouts += 1;
      } else {
        // A non-timeout failure resets the timeout streak (different failure mode).
        entry.consecutiveTimeouts = 0;
      }
    }

    // Sliding windows.
    entry.recentStatusCodes.push(outcome.statusCode ?? null);
    if (entry.recentStatusCodes.length > statusWindow) {
      entry.recentStatusCodes.shift();
    }
    entry.recentOutcomes.push(success);
    if (entry.recentOutcomes.length > rateWindow) {
      entry.recentOutcomes.shift();
    }

    // If the proxy is currently in a burn state, a successful release should
    // clear it back to healthy (the operator reused it after cooldown and it
    // worked). A failure keeps it in whatever burn state it's in.
    if (entry.state !== 'healthy') {
      if (entry.state === 'burned') {
        // Permanent — never auto-recovers.
        return { burned: true, kind: 'permanent', reason: entry.burnReason };
      }
      // cooldown: success clears it; failure leaves it (cooldown window still
      // applies via isReusable below).
      if (success) {
        entry.state = 'healthy';
        entry.burnedAt = null;
        entry.burnReason = null;
        return { burned: false };
      }
      return { burned: true, kind: 'cooldown', reason: entry.burnReason };
    }

    // Healthy proxy — evaluate burn rules.
    const decision = evaluate(entry);
    if (decision) {
      applyBurn(entry, decision);
      return { burned: true, kind: decision.kind, reason: decision.reason };
    }
    return { burned: false };
  }

  /**
   * Mark a proxy as permanently burned (removed from pool). Used by the pool
   * operator when a provider API reports the IP as retired, or any other
   * out-of-band signal.
   */
  function markPermanent(proxyId, reason) {
    const entry = ensureEntry(proxyId);
    entry.burnCount += 1;
    entry.burnedAt = now();
    entry.burnReason = reason || 'manually marked permanent';
    entry.state = 'burned';
    return { burned: true, kind: 'permanent', reason: entry.burnReason };
  }

  /**
   * Force a proxy into cooldown (e.g. operator wants to bench it without
   * a hard burn). Auto-recovers after cooldownMs.
   */
  function markCooldown(proxyId, reason) {
    const entry = ensureEntry(proxyId);
    entry.burnCount += 1;
    entry.burnedAt = now();
    entry.burnReason = reason || 'manually marked cooldown';
    entry.state = 'cooldown';
    return { burned: true, kind: 'cooldown', reason: entry.burnReason };
  }

  /**
   * Force-clear a proxy back to healthy (manual override). Resets counters.
   */
  function clear(proxyId) {
    const entry = ensureEntry(proxyId);
    entry.state = 'healthy';
    entry.burnedAt = null;
    entry.burnReason = null;
    entry.consecutiveFails = 0;
    entry.consecutiveTimeouts = 0;
  }

  /**
   * Is the proxy currently usable? Returns false for permanent burns and for
   * cooldown burns whose window hasn't elapsed.
   */
  function isReusable(proxyId) {
    const entry = proxies.get(proxyId);
    if (!entry) return true; // unknown proxy → assume usable (pool's job to know)
    if (entry.state === 'burned') return false;
    if (entry.state === 'cooldown') {
      if (entry.burnedAt === null) return true;
      return now() - entry.burnedAt >= cooldownMs;
    }
    return true;
  }

  function state(proxyId) {
    const entry = proxies.get(proxyId);
    if (!entry) return 'healthy';
    // Lazy-promote a cooldown proxy to healthy if the window has elapsed.
    if (entry.state === 'cooldown' && isReusable(proxyId)) {
      return 'healthy';
    }
    return entry.state;
  }

  function stats(proxyId) {
    const entry = proxies.get(proxyId);
    if (!entry) {
      return {
        id: proxyId,
        state: 'healthy',
        requestCount: 0,
        successCount: 0,
        successRate: null,
        consecutiveFails: 0,
        consecutiveTimeouts: 0,
        recentStatusCodes: [],
        burnedAt: null,
        burnReason: null,
        burnCount: 0,
      };
    }
    const rate = entry.requestCount > 0 ? entry.successCount / entry.requestCount : null;
    return {
      id: entry.id,
      state: state(proxyId),
      requestCount: entry.requestCount,
      successCount: entry.successCount,
      successRate: rate,
      consecutiveFails: entry.consecutiveFails,
      consecutiveTimeouts: entry.consecutiveTimeouts,
      recentStatusCodes: entry.recentStatusCodes.slice(),
      burnedAt: entry.burnedAt,
      burnReason: entry.burnReason,
      burnCount: entry.burnCount,
    };
  }

  /**
   * Reset a proxy's counters (called by the pool when a cooldown proxy is
   * reused so it gets a fresh slate).
   */
  function resetCounters(proxyId) {
    const entry = proxies.get(proxyId);
    if (!entry) return;
    entry.consecutiveFails = 0;
    entry.consecutiveTimeouts = 0;
    // Keep recentStatusCodes/recentOutcomes — they're useful for trend analysis
    // even after reuse. But clear the burn flags.
    entry.state = 'healthy';
    entry.burnedAt = null;
    entry.burnReason = null;
  }

  function all() {
    return Array.from(proxies.values()).map((e) => stats(e.id));
  }

  function cooldownRemainingMs(proxyId) {
    const entry = proxies.get(proxyId);
    if (!entry || entry.state !== 'cooldown' || entry.burnedAt === null) return 0;
    const elapsed = now() - entry.burnedAt;
    return Math.max(0, cooldownMs - elapsed);
  }

  return {
    record,
    markPermanent,
    markCooldown,
    clear,
    isReusable,
    state,
    stats,
    all,
    resetCounters,
    cooldownRemainingMs,
    // Exposed for tests / introspection
    _config: {
      cooldownMs,
      statusWindow,
      rateWindow,
      rateThreshold,
      minRateSamples,
      consecutiveBlock,
      consecutiveTimeout,
    },
  };
}

module.exports = {
  createBurnDetector,
  // Constants re-exported for tests / docs
  DEFAULT_COOLDOWN_MS,
  DEFAULT_WINDOW,
  DEFAULT_BURN_WINDOW,
  DEFAULT_RATE_THRESHOLD,
  DEFAULT_MIN_RATE_SAMPLES,
  DEFAULT_CONSEC_BLOCK,
  DEFAULT_CONSEC_TIMEOUT,
  BLOCK_STATUSES,
  PERMANENT_STATUSES,
  TIMEOUT_CODE,
};
