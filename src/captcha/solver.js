'use strict';

/**
 * src/captcha/solver.js — Phase 2.6 — CAPTCHA Auto-Solving
 *
 * Solver abstraction over third-party CAPTCHA-solving services. Each provider
 * is implemented as a thin HTTP client so the solver is fully testable with an
 * injectable `httpClient` — NO test ever makes a real API call or spends real
 * money.
 *
 * Providers:
 *   - 2captcha     — REST API (in.php submit + res.php poll). $0.003 / reCAPTCHA v2.
 *   - anticaptcha  — JSON-RPC (createTask + getTaskResult). $0.002 / reCAPTCHA v2.
 *   - capsolver    — JSON-RPC (createTask + getTaskResult). $0.0008 / reCAPTCHA v2.
 *   - mock         — returns a fake token after a configurable delay (tests + dry runs).
 *   - none         — sentinel: never solves; the orchestrator falls back to pause-and-alert.
 *
 * Public API:
 *   const solver = createSolver({ provider, apiKey, logger, httpClient, clock, sleepFn, ... });
 *   const { token, cost, solveTimeMs, provider } = await solver.solve({ type, sitekey, url });
 *   const balance = await solver.balance();
 *   const stats = solver.stats(); // { solves, totalCost, totalSolveMs }
 *
 * Budget guard:
 *   const guard = new BudgetGuard({ budget: 5.00, logger });
 *   if (guard.canSolve()) { ... guard.record(cost); }
 *   guard.exceeded → true once cumulative spend >= budget.
 *
 * Solver chain (retry + fallback provider):
 *   const chain = createSolverChain({ primary, fallback, logger });
 *   chain.solve(...) tries primary; on failure retries once, then tries fallback.
 *
 * Design rules (per project conventions):
 *   - Pure where possible; async functions accept injectable sleepFn / clock / httpClient.
 *   - A solver instance carries its own cumulative stats (solves, cost, solveTimeMs).
 *   - BudgetGuard is SEPARATE from the solver so the orchestrator can check it
 *     before calling solve() (and so a single guard can span multiple solvers in a chain).
 */

// ---------------------------------------------------------------------------
// Provider registry + cost table
// ---------------------------------------------------------------------------

const PROVIDERS = ['2captcha', 'anticaptcha', 'capsolver', 'mock', 'none'];

// Approximate cost per reCAPTCHA v2 solve (USD), as of 2024 pricing pages.
// Used for budget tracking + the cost log. Real invoices may differ slightly.
const COST_PER_SOLVE = {
  '2captcha': 0.003,
  'anticaptcha': 0.002,
  'capsolver': 0.0008,
  'mock': 0.0,
  'none': 0.0,
};

// API endpoints (only used by the real providers; mock/none never hit the network).
const ENDPOINTS = {
  '2captcha': {
    submit: 'https://2captcha.com/in.php',
    poll: 'https://2captcha.com/res.php',
  },
  'anticaptcha': 'https://api.anti-captcha.com',
  'capsolver': 'https://api.capsolver.com',
};

// Default polling cadence + timeout for the real providers.
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_POLL_TIMEOUT_MS = 180_000; // 3 min — most solves finish in <30s

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class SolverError extends Error {
  constructor(message, { provider, code } = {}) {
    super(message);
    this.name = 'SolverError';
    this.provider = provider || null;
    this.code = code || 'SOLVER_ERROR';
  }
}

class BudgetExceededError extends SolverError {
  constructor(message, { spent, budget } = {}) {
    super(message, { code: 'BUDGET_EXCEEDED' });
    this.name = 'BudgetExceededError';
    this.spent = spent;
    this.budget = budget;
  }
}

// ---------------------------------------------------------------------------
// Default HTTP client — uses global fetch (Node 18+). Overridable in tests.
// ---------------------------------------------------------------------------

/** @type {(url: string, opts?: object) => Promise<{ ok: boolean, status: number, json: ()=>Promise<any>, text: ()=>Promise<string> }>} */
function defaultHttpClient(url, opts = {}) {
  // eslint-disable-next-line no-undef
  if (typeof fetch === 'function') {
    return fetch(url, opts).then((r) => ({
      ok: r.ok,
      status: r.status,
      json: () => r.json(),
      text: () => r.text(),
    }));
  }
  throw new SolverError('No fetch available — pass an injectable httpClient', { code: 'NO_HTTP_CLIENT' });
}

function defaultClock() {
  return Date.now();
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------
// Each provider is an object: { submit({ sitekey, url, type, httpClient, apiKey }), poll({ id, httpClient, apiKey, sleepFn, clock, pollIntervalMs, pollTimeoutMs }) }
// submit() returns { id } (the solver job id). poll() returns { token }.
// Both throw SolverError on failure.

// --- 2captcha (REST, GET in.php / res.php with json=1) ----------------------
const twoCaptchaProvider = {
  async submit({ sitekey, url, httpClient, apiKey }) {
    const u = new URL(ENDPOINTS['2captcha'].submit);
    u.searchParams.set('key', apiKey);
    u.searchParams.set('method', 'userrecaptcha');
    u.searchParams.set('googlekey', sitekey);
    u.searchParams.set('pageurl', url);
    u.searchParams.set('json', '1');
    const resp = await httpClient(u.toString(), { method: 'GET' });
    const body = await resp.json();
    if (body.status !== 1) {
      throw new SolverError(`2captcha submit failed: ${body.request || 'unknown'}`, {
        provider: '2captcha',
        code: 'SUBMIT_FAILED',
      });
    }
    return { id: String(body.request) };
  },
  async poll({ id, httpClient, apiKey, sleepFn, clock, pollIntervalMs, pollTimeoutMs }) {
    const deadline = clock() + pollTimeoutMs;
    for (;;) {
      if (clock() >= deadline) {
        throw new SolverError(`2captcha poll timed out after ${pollTimeoutMs}ms (id=${id})`, {
          provider: '2captcha',
          code: 'POLL_TIMEOUT',
        });
      }
      const u = new URL(ENDPOINTS['2captcha'].poll);
      u.searchParams.set('key', apiKey);
      u.searchParams.set('action', 'get');
      u.searchParams.set('id', id);
      u.searchParams.set('json', '1');
      const resp = await httpClient(u.toString(), { method: 'GET' });
      const body = await resp.json();
      if (body.status === 1) {
        return { token: String(body.request) };
      }
      // CAPCHA_NOT_READY is the expected "try again later" signal.
      if (body.request !== 'CAPCHA_NOT_READY') {
        throw new SolverError(`2captcha poll failed: ${body.request || 'unknown'}`, {
          provider: '2captcha',
          code: 'POLL_FAILED',
        });
      }
      await sleepFn(pollIntervalMs);
    }
  },
  async balance({ httpClient, apiKey }) {
    const u = new URL(ENDPOINTS['2captcha'].poll);
    u.searchParams.set('key', apiKey);
    u.searchParams.set('action', 'getbalance');
    u.searchParams.set('json', '1');
    const resp = await httpClient(u.toString(), { method: 'GET' });
    const body = await resp.json();
    if (body.status !== 1) {
      throw new SolverError(`2captcha balance failed: ${body.request || 'unknown'}`, {
        provider: '2captcha',
        code: 'BALANCE_FAILED',
      });
    }
    return Number(body.request);
  },
};

// --- anti-captcha (JSON-RPC POST) ------------------------------------------
const antiCaptchaProvider = {
  async submit({ sitekey, url, httpClient, apiKey }) {
    const resp = await httpClient(ENDPOINTS.anticaptcha + '/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: 'NoCaptchaTaskProxyless',
          websiteURL: url,
          websiteKey: sitekey,
        },
      }),
    });
    const body = await resp.json();
    if (body.errorId !== 0) {
      throw new SolverError(`anticaptcha submit failed: ${body.errorDescription || body.errorCode || 'unknown'}`, {
        provider: 'anticaptcha',
        code: 'SUBMIT_FAILED',
      });
    }
    return { id: String(body.taskId) };
  },
  async poll({ id, httpClient, apiKey, sleepFn, clock, pollIntervalMs, pollTimeoutMs }) {
    const deadline = clock() + pollTimeoutMs;
    for (;;) {
      if (clock() >= deadline) {
        throw new SolverError(`anticaptcha poll timed out after ${pollTimeoutMs}ms (taskId=${id})`, {
          provider: 'anticaptcha',
          code: 'POLL_TIMEOUT',
        });
      }
      const resp = await httpClient(ENDPOINTS.anticaptcha + '/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId: Number(id) }),
      });
      const body = await resp.json();
      if (body.errorId !== 0) {
        throw new SolverError(`anticaptcha poll failed: ${body.errorDescription || body.errorCode || 'unknown'}`, {
          provider: 'anticaptcha',
          code: 'POLL_FAILED',
        });
      }
      if (body.status === 'ready') {
        return { token: body.solution && body.solution.gRecaptchaResponse };
      }
      await sleepFn(pollIntervalMs);
    }
  },
  async balance({ httpClient, apiKey }) {
    const resp = await httpClient(ENDPOINTS.anticaptcha + '/getBalance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey }),
    });
    const body = await resp.json();
    if (body.errorId !== 0) {
      throw new SolverError(`anticaptcha balance failed: ${body.errorDescription || body.errorCode || 'unknown'}`, {
        provider: 'anticaptcha',
        code: 'BALANCE_FAILED',
      });
    }
    return Number(body.balance);
  },
};

// --- capsolver (JSON-RPC POST, very similar to anti-captcha) ----------------
const capSolverProvider = {
  async submit({ sitekey, url, httpClient, apiKey }) {
    const resp = await httpClient(ENDPOINTS.capsolver + '/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: 'ReCaptchaV2TaskProxyless',
          websiteURL: url,
          websiteKey: sitekey,
        },
      }),
    });
    const body = await resp.json();
    if (body.errorId !== 0) {
      throw new SolverError(`capsolver submit failed: ${body.errorDescription || body.errorCode || 'unknown'}`, {
        provider: 'capsolver',
        code: 'SUBMIT_FAILED',
      });
    }
    return { id: String(body.taskId) };
  },
  async poll({ id, httpClient, apiKey, sleepFn, clock, pollIntervalMs, pollTimeoutMs }) {
    const deadline = clock() + pollTimeoutMs;
    for (;;) {
      if (clock() >= deadline) {
        throw new SolverError(`capsolver poll timed out after ${pollTimeoutMs}ms (taskId=${id})`, {
          provider: 'capsolver',
          code: 'POLL_TIMEOUT',
        });
      }
      const resp = await httpClient(ENDPOINTS.capsolver + '/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId: id }),
      });
      const body = await resp.json();
      if (body.errorId !== 0) {
        throw new SolverError(`capsolver poll failed: ${body.errorDescription || body.errorCode || 'unknown'}`, {
          provider: 'capsolver',
          code: 'POLL_FAILED',
        });
      }
      if (body.status === 'ready') {
        return { token: body.solution && body.solution.gRecaptchaResponse };
      }
      await sleepFn(pollIntervalMs);
    }
  },
  async balance({ httpClient, apiKey }) {
    const resp = await httpClient(ENDPOINTS.capsolver + '/getBalance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey }),
    });
    const body = await resp.json();
    if (body.errorId !== 0) {
      throw new SolverError(`capsolver balance failed: ${body.errorDescription || body.errorCode || 'unknown'}`, {
        provider: 'capsolver',
        code: 'BALANCE_FAILED',
      });
    }
    return Number(body.balance);
  },
};

// --- mock provider (no network; for tests + dry runs) ----------------------
// Returns a deterministic-ish fake token after `mockDelayMs` (default 0 so
// tests run instantly). The token encodes the inputs so tests can assert it
// was generated from the right challenge.
const mockProvider = {
  async submit({ sitekey, url, type }) {
    return { id: `mock-job-${type}-${sitekey || 'nositekey'}` };
  },
  async poll({ id, sleepFn }) {
    if (sleepFn) await sleepFn(0); // cooperative — never real time in tests
    return { token: `mock-token-${id}` };
  },
  async balance() {
    return 10.0; // pretend we have $10 of mock credit
  },
};

const PROVIDER_IMPLS = {
  '2captcha': twoCaptchaProvider,
  'anticaptcha': antiCaptchaProvider,
  'capsolver': capSolverProvider,
  'mock': mockProvider,
  // 'none' has no impl — solve() throws so the orchestrator falls back.
};

// ---------------------------------------------------------------------------
// Solver factory
// ---------------------------------------------------------------------------

/**
 * Create a CAPTCHA solver for a single provider.
 *
 * @param {object} opts
 * @param {string} opts.provider     — 2captcha | anticaptcha | capsolver | mock | none
 * @param {string} [opts.apiKey]     — API key (required for real providers)
 * @param {object} [opts.logger]
 * @param {Function} [opts.httpClient] — injectable; default uses global fetch
 * @param {()=>number} [opts.clock]    — injectable clock (default Date.now)
 * @param {(ms:number)=>Promise<void>} [opts.sleepFn] — injectable sleep (default setTimeout)
 * @param {number} [opts.mockDelayMs=0] — delay before the mock provider returns
 * @param {number} [opts.pollIntervalMs=5000] — real-provider poll interval
 * @param {number} [opts.pollTimeoutMs=180000] — real-provider poll deadline
 * @returns {{ solve, balance, provider, stats }}
 */
function createSolver(opts = {}) {
  const provider = opts.provider;
  if (!PROVIDERS.includes(provider)) {
    throw new SolverError(`Unknown CAPTCHA provider: "${provider}". Valid: ${PROVIDERS.join(', ')}`, {
      code: 'UNKNOWN_PROVIDER',
    });
  }
  const apiKey = opts.apiKey || null;
  const logger = opts.logger || null;
  const httpClient = opts.httpClient || defaultHttpClient;
  const clock = opts.clock || defaultClock;
  const sleepFn = opts.sleepFn || defaultSleep;
  const mockDelayMs = opts.mockDelayMs ?? 0;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

  // Real providers need an API key. mock/none do not.
  if (['2captcha', 'anticaptcha', 'capsolver'].includes(provider) && !apiKey) {
    throw new SolverError(`Provider "${provider}" requires an apiKey (set --captchaApiKey or CAPTCHA_API_KEY)`, {
      provider,
      code: 'MISSING_API_KEY',
    });
  }

  // Cumulative stats for this solver instance.
  const stats = { solves: 0, totalCost: 0, totalSolveMs: 0, failures: 0 };

  async function solve({ type, sitekey, url }) {
    if (provider === 'none') {
      throw new SolverError('CAPTCHA solver is disabled (provider=none) — orchestrator must fall back', {
        provider: 'none',
        code: 'SOLVER_DISABLED',
      });
    }
    const impl = PROVIDER_IMPLS[provider];
    const startedAt = clock();

    // For the mock provider, honor mockDelayMs before submitting+polling so a
    // realistic delay can be simulated (tests pass 0 for instant results).
    if (provider === 'mock' && mockDelayMs > 0) {
      await sleepFn(mockDelayMs);
    }

    if (logger) {
      logger.debug('CAPTCHA solve requested', { provider, type, sitekey: sitekey ? sitekey.slice(0, 12) + '…' : null, url });
    }

    const submitArgs = { sitekey, url, type, httpClient, apiKey };
    const { id } = await impl.submit(submitArgs);
    if (logger) logger.debug('CAPTCHA job submitted', { provider, id });

    const pollArgs = { id, httpClient, apiKey, sleepFn, clock, pollIntervalMs, pollTimeoutMs };
    const { token } = await impl.poll(pollArgs);

    const solveTimeMs = clock() - startedAt;
    const cost = COST_PER_SOLVE[provider] || 0;
    stats.solves++;
    stats.totalCost = Math.round((stats.totalCost + cost) * 1e6) / 1e6; // avoid float drift
    stats.totalSolveMs += solveTimeMs;

    if (logger) {
      logger.info('CAPTCHA solved', {
        provider,
        cost: `$${cost.toFixed(4)}`,
        time: `${(solveTimeMs / 1000).toFixed(2)}s`,
        tokenPreview: token ? token.slice(0, 16) + '…' : null,
      });
    }
    if (!token) {
      throw new SolverError(`${provider} returned an empty token`, { provider, code: 'EMPTY_TOKEN' });
    }
    return { token, cost, solveTimeMs, provider };
  }

  async function balance() {
    if (provider === 'none') return null;
    const impl = PROVIDER_IMPLS[provider];
    return impl.balance({ httpClient, apiKey });
  }

  function getStats() {
    return { ...stats };
  }

  return {
    provider,
    solve,
    balance,
    stats: getStats,
  };
}

// ---------------------------------------------------------------------------
// Budget guard — caps cumulative solver spend for a whole run
// ---------------------------------------------------------------------------

/**
 * Tracks cumulative CAPTCHA-solving cost. The orchestrator checks canSolve()
 * before calling solver.solve(); record() after a successful solve.
 *
 * Once `spent >= budget`, canSolve() returns false and the orchestrator falls
 * back to pause-and-alert (instead of spending more money).
 */
class BudgetGuard {
  constructor({ budget = Infinity, logger = null } = {}) {
    if (!Number.isFinite(budget) || budget < 0) {
      throw new SolverError(`captchaBudget must be a finite non-negative number (got ${budget})`, {
        code: 'INVALID_BUDGET',
      });
    }
    this.budget = budget;
    this.spent = 0;
    this.solves = 0;
    this.logger = logger;
  }

  /** True when we can still afford another solve (spent < budget). */
  canSolve() {
    return this.spent < this.budget;
  }

  get exceeded() {
    return this.spent >= this.budget;
  }

  get remaining() {
    return Math.max(0, Math.round((this.budget - this.spent) * 1e6) / 1e6);
  }

  /** Record a successful solve's cost. Returns the new spent total. */
  record(cost) {
    const c = Number(cost) || 0;
    this.spent = Math.round((this.spent + c) * 1e6) / 1e6;
    this.solves++;
    if (this.logger) {
      this.logger.debug('CAPTCHA cost recorded', {
        cost: `$${c.toFixed(4)}`,
        spent: `$${this.spent.toFixed(4)}`,
        budget: `$${this.budget.toFixed(2)}`,
        remaining: `$${this.remaining.toFixed(4)}`,
        exceeded: this.exceeded,
      });
    }
    return this.spent;
  }
}

// ---------------------------------------------------------------------------
// Solver chain — primary → retry → fallback provider
// ---------------------------------------------------------------------------

/**
 * Wrap a list of solvers into a single chain. solve() tries the primary; on
 * failure it retries the primary once; if that also fails and a fallback is
 * configured, it tries the fallback. The chain's stats aggregate all solvers.
 *
 * @param {object} opts
 * @param {object} opts.primary   — primary solver (required)
 * @param {object} [opts.fallback] — fallback solver (optional)
 * @param {object} [opts.logger]
 * @returns {{ solve, balance, provider, stats, providers }}
 */
function createSolverChain(opts = {}) {
  const primary = opts.primary;
  if (!primary) throw new SolverError('createSolverChain requires a primary solver', { code: 'NO_PRIMARY' });
  const fallback = opts.fallback || null;
  const logger = opts.logger || null;

  async function solve({ type, sitekey, url }) {
    let lastErr = null;
    // Try primary, then retry primary once.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await primary.solve({ type, sitekey, url });
      } catch (err) {
        lastErr = err;
        if (logger) {
          logger.warn('CAPTCHA solve attempt failed', {
            provider: primary.provider,
            attempt,
            error: err.message,
            code: err.code || null,
          });
        }
        // Budget exceeded is not retryable — surface immediately.
        if (err instanceof BudgetExceededError) throw err;
      }
    }
    // Fallback provider (if any).
    if (fallback) {
      try {
        if (logger) logger.info('CAPTCHA falling back to secondary provider', { primary: primary.provider, fallback: fallback.provider });
        return await fallback.solve({ type, sitekey, url });
      } catch (err) {
        lastErr = err;
        if (logger) {
          logger.warn('CAPTCHA fallback solve failed', {
            provider: fallback.provider,
            error: err.message,
            code: err.code || null,
          });
        }
      }
    }
    throw lastErr || new SolverError('All CAPTCHA solver attempts failed', { code: 'ALL_FAILED' });
  }

  async function balance() {
    // Report the primary's balance (the fallback is a safety net, not budgeted).
    try {
      return await primary.balance();
    } catch {
      return null;
    }
  }

  function stats() {
    const p = primary.stats();
    const f = fallback ? fallback.stats() : { solves: 0, totalCost: 0, totalSolveMs: 0, failures: 0 };
    return {
      solves: p.solves + f.solves,
      totalCost: Math.round((p.totalCost + f.totalCost) * 1e6) / 1e6,
      totalSolveMs: p.totalSolveMs + f.totalSolveMs,
      failures: p.failures + f.failures,
      byProvider: { [primary.provider]: p, ...(fallback ? { [fallback.provider]: f } : {}) },
    };
  }

  return {
    provider: primary.provider,
    providers: fallback ? [primary.provider, fallback.provider] : [primary.provider],
    solve,
    balance,
    stats,
  };
}

module.exports = {
  PROVIDERS,
  COST_PER_SOLVE,
  ENDPOINTS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  SolverError,
  BudgetExceededError,
  BudgetGuard,
  createSolver,
  createSolverChain,
  // Exposed for unit tests (so each provider's submit/poll/balance can be
  // tested in isolation with a stub httpClient).
  PROVIDER_IMPLS,
  defaultHttpClient,
  defaultClock,
  defaultSleep,
};
