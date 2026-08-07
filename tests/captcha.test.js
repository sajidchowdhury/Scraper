'use strict';

/**
 * tests/captcha.test.js — Phase 2.6 (CAPTCHA Auto-Solving)
 *
 * Coverage:
 *   - Detector (antiblock.js): detectCaptchaType, extractSitekey, CAPTCHA_TYPES
 *     · v2 (sitekey + checkbox), v3 (sitekey, no checkbox), unusual-traffic, none
 *     · injectable textFn/sitekeyFn/urlFn/checkboxFn (no real browser)
 *   - Solver (solver.js): createSolver for mock / 2captcha / anticaptcha / capsolver / none
 *     · DI: injectable httpClient (no real API calls), clock, sleepFn
 *     · submit + poll + balance for each real provider (stubbed HTTP)
 *     · CAPCHA_NOT_READY then ready (2captcha); processing then ready (anti/cap)
 *     · submit failure → SolverError; poll timeout → SolverError
 *     · stats accumulate (solves, totalCost, totalSolveMs)
 *     · unknown provider → throws; real provider without apiKey → throws
 *   - BudgetGuard: canSolve, record, exceeded, remaining, float drift, invalid
 *   - createSolverChain: primary success, retry, fallback, all-fail, budget-not-retried
 *   - CostLogger: append JSONL, summary aggregation, mkdir, non-fatal on write error
 *   - Injector (pure): injectTokenIntoDom + triggerCallbackInDom against the
 *     reCAPTCHA v2 fixture (tests/fixtures/recaptcha-v2.html via mock-dom helper)
 *   - Orchestrator: handleCaptcha — none-detected, solved, no-solver fallback,
 *     budget-exceeded fallback, solve-failed fallback, cost-log + budget record
 *
 * Run: bun test tests/captcha.test.js
 */

const fs = require('fs');
const path = require('path');
const {
  createSolver,
  createSolverChain,
  BudgetGuard,
  BudgetExceededError,
  SolverError,
  PROVIDERS,
  COST_PER_SOLVE,
  PROVIDER_IMPLS,
} = require('../src/captcha/solver');
const { createCostLogger } = require('../src/captcha/cost-log');
const {
  injectTokenIntoDom,
  injectTokenIntoDomWithEvents,
  triggerCallbackInDom,
  injectRecaptchaToken,
  submitRecaptcha,
  solveAndInject,
} = require('../src/captcha/injector');
const { handleCaptcha } = require('../src/captcha/orchestrator');
const {
  CAPTCHA_TYPES,
  detectCaptchaType,
  extractSitekey,
} = require('../src/antiblock');
const { buildMockDom } = require('./helpers/mock-dom');

// ---------------------------------------------------------------------------
// Helpers — a stub logger that captures calls + a no-op sleep.
// ---------------------------------------------------------------------------

function makeStubLogger() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  const log = (level) => (msg, meta) => { calls[level].push({ msg, meta }); };
  const logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    phase: () => logger, // phase() returns self so logger.phase('captcha').info() works
  };
  logger._calls = calls;
  return logger;
}

function noopSleep() { return Promise.resolve(); }

// A stub HTTP client that returns canned responses in sequence.
function makeStubHttpClient(responses) {
  const calls = [];
  const client = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const r = responses.shift();
    if (!r) throw new Error('stub httpClient: no more canned responses');
    if (r.throw) throw new Error(r.throw);
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.json,
      text: async () => (typeof r.text === 'string' ? r.text : JSON.stringify(r.json)),
    };
  };
  client._calls = calls;
  return client;
}

// A clock that advances by `step` each call (deterministic for poll-timeout tests).
function makeSteppingClock(start, step) {
  let t = start;
  return () => { const v = t; t += step; return v; };
}

// ===========================================================================
// DETECTOR — antiblock.js (Phase 2.6 typed detection)
// ===========================================================================

describe('Phase 2.6 — CAPTCHA_TYPES constants', () => {
  test('exports the four expected type strings', () => {
    expect(CAPTCHA_TYPES.NONE).toBe('none');
    expect(CAPTCHA_TYPES.RECAPTCHA_V2).toBe('recaptcha-v2');
    expect(CAPTCHA_TYPES.RECAPTCHA_V3).toBe('recaptcha-v3');
    expect(CAPTCHA_TYPES.UNUSUAL_TRAFFIC).toBe('unusual-traffic');
  });
});

describe('Phase 2.6 — detectCaptchaType (injectable)', () => {
  test('returns none when no indicators + no sitekey', async () => {
    const r = await detectCaptchaType({}, {
      textFn: async () => 'Welcome to Google Maps',
      sitekeyFn: async () => null,
      urlFn: async () => 'https://www.google.com/maps',
      checkboxFn: async () => false,
    });
    expect(r.detected).toBe(false);
    expect(r.type).toBe(CAPTCHA_TYPES.NONE);
    expect(r.sitekey).toBeNull();
  });

  test('detects recaptcha-v2 when sitekey present + checkbox visible', async () => {
    const r = await detectCaptchaType({}, {
      textFn: async () => 'Some page content',
      sitekeyFn: async () => '6Lc_aAAAAAAAAAAAAAAA',
      urlFn: async () => 'https://www.google.com/sorry',
      checkboxFn: async () => true,
    });
    expect(r.detected).toBe(true);
    expect(r.type).toBe(CAPTCHA_TYPES.RECAPTCHA_V2);
    expect(r.sitekey).toBe('6Lc_aAAAAAAAAAAAAAAA');
    expect(r.indicator).toBe('g-recaptcha');
  });

  test('detects recaptcha-v3 when sitekey present but no checkbox', async () => {
    const r = await detectCaptchaType({}, {
      textFn: async () => 'Some page content',
      sitekeyFn: async () => '6Lc_aAAAAAAAAAAAAAAA',
      urlFn: async () => 'https://www.google.com/maps',
      checkboxFn: async () => false,
    });
    expect(r.detected).toBe(true);
    expect(r.type).toBe(CAPTCHA_TYPES.RECAPTCHA_V3);
    expect(r.sitekey).toBe('6Lc_aAAAAAAAAAAAAAAA');
  });

  test('detects unusual-traffic interstitial (text match, even without sitekey)', async () => {
    const r = await detectCaptchaType({}, {
      textFn: async () => 'Our systems have detected unusual traffic from your computer network.',
      sitekeyFn: async () => null,
      urlFn: async () => 'https://www.google.com/sorry',
      checkboxFn: async () => false,
    });
    expect(r.detected).toBe(true);
    expect(r.type).toBe(CAPTCHA_TYPES.UNUSUAL_TRAFFIC);
    expect(r.indicator).toContain('unusual traffic');
  });

  test('unusual-traffic takes priority over a present sitekey', async () => {
    // Google embeds a reCAPTCHA widget on the interstitial too — but the text
    // match wins so the orchestrator knows it's the full-page block.
    const r = await detectCaptchaType({}, {
      textFn: async () => 'unusual traffic from your network',
      sitekeyFn: async () => '6Lc_aAAAAAAAAAAAAAAA',
      urlFn: async () => 'https://www.google.com/sorry',
      checkboxFn: async () => true,
    });
    expect(r.type).toBe(CAPTCHA_TYPES.UNUSUAL_TRAFFIC);
    expect(r.sitekey).toBe('6Lc_aAAAAAAAAAAAAAAA'); // sitekey still extracted
  });

  test('falls back to unusual-traffic for generic captcha text with no widget', async () => {
    const r = await detectCaptchaType({}, {
      textFn: async () => 'Please verify you are not a robot',
      sitekeyFn: async () => null,
      urlFn: async () => 'https://www.google.com/sorry',
      checkboxFn: async () => false,
    });
    expect(r.detected).toBe(true);
    expect(r.type).toBe(CAPTCHA_TYPES.UNUSUAL_TRAFFIC);
  });

  test('case-insensitive text matching', async () => {
    const r = await detectCaptchaType({}, {
      textFn: async () => 'UNUSUAL TRAFFIC FROM YOUR COMPUTER NETWORK',
      sitekeyFn: async () => null,
      urlFn: async () => '',
      checkboxFn: async () => false,
    });
    expect(r.detected).toBe(true);
    expect(r.type).toBe(CAPTCHA_TYPES.UNUSUAL_TRAFFIC);
  });

  test('survives a throwing textFn (treats as empty → none)', async () => {
    const r = await detectCaptchaType({}, {
      textFn: async () => { throw new Error('navigation'); },
      sitekeyFn: async () => null,
      urlFn: async () => '',
      checkboxFn: async () => false,
    });
    expect(r.detected).toBe(false);
    expect(r.type).toBe(CAPTCHA_TYPES.NONE);
  });

  test('includes the page url in the result', async () => {
    const r = await detectCaptchaType({}, {
      textFn: async () => '',
      sitekeyFn: async () => null,
      urlFn: async () => 'https://maps.google.com/foo',
      checkboxFn: async () => false,
    });
    expect(r.url).toBe('https://maps.google.com/foo');
  });
});

describe('Phase 2.6 — extractSitekey (injectable)', () => {
  test('returns the evalFn result directly', async () => {
    const sk = await extractSitekey({}, { evalFn: async () => '6Lc_KEY' });
    expect(sk).toBe('6Lc_KEY');
  });
  test('returns null when evalFn throws', async () => {
    const sk = await extractSitekey({}, { evalFn: async () => { throw new Error('x'); } });
    expect(sk).toBeNull();
  });
  test('returns null when evalFn returns null', async () => {
    const sk = await extractSitekey({}, { evalFn: async () => null });
    expect(sk).toBeNull();
  });
});

// ===========================================================================
// SOLVER — createSolver + providers (DI, no real API calls)
// ===========================================================================

describe('Phase 2.6 — PROVIDERS + COST_PER_SOLVE registry', () => {
  test('PROVIDERS lists all five providers', () => {
    expect(PROVIDERS).toEqual(['2captcha', 'anticaptcha', 'capsolver', 'mock', 'none']);
  });
  test('COST_PER_SOLVE has a numeric cost for every real provider', () => {
    expect(COST_PER_SOLVE['2captcha']).toBeGreaterThan(0);
    expect(COST_PER_SOLVE['anticaptcha']).toBeGreaterThan(0);
    expect(COST_PER_SOLVE['capsolver']).toBeGreaterThan(0);
    expect(COST_PER_SOLVE['mock']).toBe(0);
    expect(COST_PER_SOLVE['none']).toBe(0);
  });
  test('PROVIDER_IMPLS has submit/poll/balance for every non-none provider', () => {
    for (const p of ['2captcha', 'anticaptcha', 'capsolver', 'mock']) {
      expect(typeof PROVIDER_IMPLS[p].submit).toBe('function');
      expect(typeof PROVIDER_IMPLS[p].poll).toBe('function');
      expect(typeof PROVIDER_IMPLS[p].balance).toBe('function');
    }
  });
});

describe('Phase 2.6 — createSolver({ provider: "mock" })', () => {
  test('returns a token + zero cost after solving', async () => {
    const solver = createSolver({ provider: 'mock', logger: makeStubLogger() });
    const r = await solver.solve({ type: 'recaptcha-v2', sitekey: '6Lc_KEY', url: 'https://example.com' });
    expect(r.token).toMatch(/^mock-token-/);
    expect(r.cost).toBe(0);
    expect(r.solveTimeMs).toBeGreaterThanOrEqual(0);
    expect(r.provider).toBe('mock');
  });
  test('token encodes the type + sitekey (deterministic)', async () => {
    const solver = createSolver({ provider: 'mock' });
    const r = await solver.solve({ type: 'recaptcha-v2', sitekey: '6Lc_KEY', url: 'https://x.com' });
    expect(r.token).toContain('recaptcha-v2');
    expect(r.token).toContain('6Lc_KEY');
  });
  test('balance() returns 10.0 (mock credit)', async () => {
    const solver = createSolver({ provider: 'mock' });
    expect(await solver.balance()).toBe(10.0);
  });
  test('stats accumulate across solves', async () => {
    const solver = createSolver({ provider: 'mock', clock: makeSteppingClock(1000, 50) });
    await solver.solve({ type: 'recaptcha-v2', sitekey: 'k1', url: 'u' });
    await solver.solve({ type: 'recaptcha-v2', sitekey: 'k2', url: 'u' });
    const s = solver.stats();
    expect(s.solves).toBe(2);
    expect(s.totalCost).toBe(0);
    expect(s.totalSolveMs).toBeGreaterThanOrEqual(0);
  });
  test('mockDelayMs > 0 triggers the injected sleepFn (no real timer)', async () => {
    let slept = 0;
    const solver = createSolver({
      provider: 'mock',
      mockDelayMs: 250,
      sleepFn: async (ms) => { slept += ms; },
    });
    await solver.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' });
    expect(slept).toBe(250);
  });
});

describe('Phase 2.6 — createSolver({ provider: "none" })', () => {
  test('solve() throws SOLVER_DISABLED', async () => {
    const solver = createSolver({ provider: 'none' });
    await expect(solver.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' }))
      .rejects.toThrow(/disabled/);
  });
  test('balance() returns null (no API)', async () => {
    const solver = createSolver({ provider: 'none' });
    expect(await solver.balance()).toBeNull();
  });
  test('stats show zero solves', () => {
    const solver = createSolver({ provider: 'none' });
    expect(solver.stats().solves).toBe(0);
  });
});

describe('Phase 2.6 — createSolver({ provider: "2captcha" }) with stub httpClient', () => {
  test('submit + poll (NOT_READY → ready) returns the token', async () => {
    const http = makeStubHttpClient([
      { json: { status: 1, request: 'JOB123' } },                 // in.php submit
      { json: { status: 0, request: 'CAPCHA_NOT_READY' } },       // res.php poll #1
      { json: { status: 1, request: 'TOKEN_ABC' } },              // res.php poll #2
    ]);
    const solver = createSolver({
      provider: '2captcha',
      apiKey: 'KEY',
      httpClient: http,
      sleepFn: noopSleep,
      clock: makeSteppingClock(1000, 100),
      pollIntervalMs: 10,
      pollTimeoutMs: 1000,
    });
    const r = await solver.solve({ type: 'recaptcha-v2', sitekey: '6Lc_KEY', url: 'https://example.com' });
    expect(r.token).toBe('TOKEN_ABC');
    expect(r.provider).toBe('2captcha');
    expect(r.cost).toBe(COST_PER_SOLVE['2captcha']);
    // The submit URL hit in.php with the sitekey + pageurl.
    expect(http._calls[0].url).toContain('2captcha.com/in.php');
    expect(http._calls[0].url).toContain('googlekey=6Lc_KEY');
    expect(http._calls[0].url).toContain('pageurl=https%3A%2F%2Fexample.com');
    // The poll URL hit res.php with action=get + the job id.
    expect(http._calls[1].url).toContain('2captcha.com/res.php');
    expect(http._calls[1].url).toContain('action=get');
    expect(http._calls[1].url).toContain('id=JOB123');
  });

  test('balance() calls res.php?action=getbalance', async () => {
    const http = makeStubHttpClient([{ json: { status: 1, request: '4.200' } }]);
    const solver = createSolver({
      provider: '2captcha', apiKey: 'KEY', httpClient: http,
    });
    expect(await solver.balance()).toBe(4.2);
    expect(http._calls[0].url).toContain('action=getbalance');
  });

  test('submit failure (status 0) → SolverError SUBMIT_FAILED', async () => {
    const http = makeStubHttpClient([{ json: { status: 0, request: 'ERROR_KEY_DOES_NOT_EXIST' } }]);
    const solver = createSolver({
      provider: '2captcha', apiKey: 'BAD', httpClient: http,
    });
    await expect(solver.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' }))
      .rejects.toThrow(/submit failed/);
  });

  test('poll failure (status 0, not NOT_READY) → SolverError POLL_FAILED', async () => {
    const http = makeStubHttpClient([
      { json: { status: 1, request: 'JOB1' } },
      { json: { status: 0, request: 'ERROR_CAPTCHA_UNSOLVABLE' } },
    ]);
    const solver = createSolver({
      provider: '2captcha', apiKey: 'KEY', httpClient: http,
      sleepFn: noopSleep, clock: makeSteppingClock(0, 100),
      pollIntervalMs: 10, pollTimeoutMs: 1000,
    });
    await expect(solver.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' }))
      .rejects.toThrow(/poll failed/);
  });

  test('poll timeout → SolverError POLL_TIMEOUT', async () => {
    // Always returns NOT_READY; the clock advances past the deadline.
    const http = makeStubHttpClient([
      { json: { status: 1, request: 'JOB1' } },
      { json: { status: 0, request: 'CAPCHA_NOT_READY' } },
      { json: { status: 0, request: 'CAPCHA_NOT_READY' } },
      { json: { status: 0, request: 'CAPCHA_NOT_READY' } },
    ]);
    const solver = createSolver({
      provider: '2captcha', apiKey: 'KEY', httpClient: http,
      sleepFn: noopSleep,
      clock: makeSteppingClock(0, 6000), // 6s per call → exceeds 5000ms deadline on 2nd poll
      pollIntervalMs: 10, pollTimeoutMs: 5000,
    });
    await expect(solver.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' }))
      .rejects.toThrow(/timed out/);
  });
});

describe('Phase 2.6 — createSolver({ provider: "anticaptcha" }) with stub httpClient', () => {
  test('createTask (errorId 0) + getTaskResult (processing → ready)', async () => {
    const http = makeStubHttpClient([
      { json: { errorId: 0, taskId: 77 } },                       // createTask
      { json: { errorId: 0, status: 'processing' } },             // getTaskResult #1
      { json: { errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'AC_TOKEN' } } },
    ]);
    const solver = createSolver({
      provider: 'anticaptcha', apiKey: 'KEY', httpClient: http,
      sleepFn: noopSleep, clock: makeSteppingClock(0, 100),
      pollIntervalMs: 10, pollTimeoutMs: 5000,
    });
    const r = await solver.solve({ type: 'recaptcha-v2', sitekey: '6Lc_KEY', url: 'https://x.com' });
    expect(r.token).toBe('AC_TOKEN');
    expect(r.cost).toBe(COST_PER_SOLVE['anticaptcha']);
    expect(http._calls[0].url).toContain('api.anti-captcha.com/createTask');
    const body0 = JSON.parse(http._calls[0].opts.body);
    expect(body0.clientKey).toBe('KEY');
    expect(body0.task.type).toBe('NoCaptchaTaskProxyless');
    expect(body0.task.websiteKey).toBe('6Lc_KEY');
  });

  test('createTask error → SolverError SUBMIT_FAILED', async () => {
    const http = makeStubHttpClient([
      { json: { errorId: 1, errorDescription: 'bad key' } },
    ]);
    const solver = createSolver({
      provider: 'anticaptcha', apiKey: 'KEY', httpClient: http,
    });
    await expect(solver.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' }))
      .rejects.toThrow(/submit failed/);
  });

  test('balance() via getBalance RPC', async () => {
    const http = makeStubHttpClient([{ json: { errorId: 0, balance: 2.5 } }]);
    const solver = createSolver({
      provider: 'anticaptcha', apiKey: 'KEY', httpClient: http,
    });
    expect(await solver.balance()).toBe(2.5);
    expect(http._calls[0].url).toContain('api.anti-captcha.com/getBalance');
  });
});

describe('Phase 2.6 — createSolver({ provider: "capsolver" }) with stub httpClient', () => {
  test('createTask + getTaskResult (ready)', async () => {
    const http = makeStubHttpClient([
      { json: { errorId: 0, taskId: 'cs-1' } },
      { json: { errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'CS_TOKEN' } } },
    ]);
    const solver = createSolver({
      provider: 'capsolver', apiKey: 'KEY', httpClient: http,
      sleepFn: noopSleep, clock: makeSteppingClock(0, 100),
      pollIntervalMs: 10, pollTimeoutMs: 5000,
    });
    const r = await solver.solve({ type: 'recaptcha-v2', sitekey: '6Lc_KEY', url: 'https://x.com' });
    expect(r.token).toBe('CS_TOKEN');
    expect(r.cost).toBe(COST_PER_SOLVE['capsolver']);
    const body0 = JSON.parse(http._calls[0].opts.body);
    expect(body0.task.type).toBe('ReCaptchaV2TaskProxyless');
    expect(http._calls[0].url).toContain('api.capsolver.com/createTask');
  });

  test('balance() via getBalance', async () => {
    const http = makeStubHttpClient([{ json: { errorId: 0, balance: 1.25 } }]);
    const solver = createSolver({ provider: 'capsolver', apiKey: 'KEY', httpClient: http });
    expect(await solver.balance()).toBe(1.25);
  });
});

describe('Phase 2.6 — createSolver validation', () => {
  test('unknown provider → SolverError UNKNOWN_PROVIDER', () => {
    expect(() => createSolver({ provider: 'mystery' })).toThrow(/Unknown CAPTCHA provider/);
  });
  test('real provider without apiKey → SolverError MISSING_API_KEY', () => {
    expect(() => createSolver({ provider: '2captcha' })).toThrow(/apiKey/);
    expect(() => createSolver({ provider: 'anticaptcha' })).toThrow(/apiKey/);
    expect(() => createSolver({ provider: 'capsolver' })).toThrow(/apiKey/);
  });
  test('mock + none do NOT require apiKey', () => {
    expect(() => createSolver({ provider: 'mock' })).not.toThrow();
    expect(() => createSolver({ provider: 'none' })).not.toThrow();
  });
  test('a real solve uses the injected httpClient (never global fetch)', async () => {
    let fetchCalled = false;
    const origFetch = global.fetch;
    global.fetch = () => { fetchCalled = true; throw new Error('should not be called'); };
    try {
      const http = makeStubHttpClient([
        { json: { status: 1, request: 'J1' } },
        { json: { status: 1, request: 'TOK' } },
      ]);
      const solver = createSolver({
        provider: '2captcha', apiKey: 'K', httpClient: http,
        sleepFn: noopSleep, clock: makeSteppingClock(0, 100),
        pollIntervalMs: 1, pollTimeoutMs: 1000,
      });
      await solver.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' });
      expect(fetchCalled).toBe(false);
    } finally {
      global.fetch = origFetch;
    }
  });
});

// ===========================================================================
// BudgetGuard
// ===========================================================================

describe('Phase 2.6 — BudgetGuard', () => {
  test('canSolve() true when under budget', () => {
    const g = new BudgetGuard({ budget: 5.0 });
    expect(g.canSolve()).toBe(true);
    expect(g.exceeded).toBe(false);
  });
  test('record() accumulates spend; canSolve() false once exceeded', () => {
    const g = new BudgetGuard({ budget: 0.01 });
    g.record(0.003);
    expect(g.canSolve()).toBe(true);
    g.record(0.003);
    g.record(0.003);
    g.record(0.003); // total 0.012 > 0.01
    expect(g.exceeded).toBe(true);
    expect(g.canSolve()).toBe(false);
  });
  test('remaining calculates correctly', () => {
    const g = new BudgetGuard({ budget: 5.0 });
    g.record(0.003);
    expect(g.remaining).toBe(4.997);
  });
  test('remaining clamps to 0 when exceeded', () => {
    const g = new BudgetGuard({ budget: 0.001 });
    g.record(0.01);
    expect(g.remaining).toBe(0);
  });
  test('float drift handled (0.003 × 3 rounds cleanly)', () => {
    const g = new BudgetGuard({ budget: 100 });
    for (let i = 0; i < 3; i++) g.record(0.003);
    expect(g.spent).toBe(0.009);
  });
  test('solves counter increments', () => {
    const g = new BudgetGuard({ budget: 10 });
    g.record(0.003); g.record(0.003);
    expect(g.solves).toBe(2);
  });
  test('invalid budget → SolverError', () => {
    expect(() => new BudgetGuard({ budget: -1 })).toThrow();
    expect(() => new BudgetGuard({ budget: NaN })).toThrow();
    expect(() => new BudgetGuard({ budget: Infinity })).toThrow();
  });
  test('Infinity budget is rejected (must be finite)', () => {
    expect(() => new BudgetGuard({ budget: Infinity })).toThrow(/finite/);
  });
  test('budget 0 → canSolve() immediately false (allow no solves)', () => {
    const g = new BudgetGuard({ budget: 0 });
    expect(g.canSolve()).toBe(false);
    expect(g.exceeded).toBe(true);
  });
});

// ===========================================================================
// createSolverChain — retry + fallback
// ===========================================================================

describe('Phase 2.6 — createSolverChain', () => {
  test('primary succeeds on first try (no fallback called)', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = {
      provider: '2captcha',
      solve: async () => { primaryCalls++; return { token: 'T', cost: 0.003, solveTimeMs: 100, provider: '2captcha' }; },
      balance: async () => 5,
      stats: () => ({ solves: primaryCalls, totalCost: 0, totalSolveMs: 0, failures: 0 }),
    };
    const fallback = {
      provider: 'mock',
      solve: async () => { fallbackCalls++; return { token: 'F', cost: 0, solveTimeMs: 0, provider: 'mock' }; },
      balance: async () => 10,
      stats: () => ({ solves: 0, totalCost: 0, totalSolveMs: 0, failures: 0 }),
    };
    const chain = createSolverChain({ primary, fallback, logger: makeStubLogger() });
    const r = await chain.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' });
    expect(r.token).toBe('T');
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(0);
  });

  test('primary fails once then succeeds on retry (no fallback)', async () => {
    let calls = 0;
    const primary = {
      provider: '2captcha',
      solve: async () => {
        calls++;
        if (calls === 1) throw new SolverError('transient', { code: 'POLL_FAILED' });
        return { token: 'T2', cost: 0.003, solveTimeMs: 200, provider: '2captcha' };
      },
      balance: async () => 5,
      stats: () => ({ solves: 0, totalCost: 0, totalSolveMs: 0, failures: 0 }),
    };
    const chain = createSolverChain({ primary, logger: makeStubLogger() });
    const r = await chain.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' });
    expect(r.token).toBe('T2');
    expect(calls).toBe(2);
  });

  test('primary fails twice, fallback succeeds', async () => {
    const primary = {
      provider: '2captcha',
      solve: async () => { throw new SolverError('down', { code: 'POLL_FAILED' }); },
      balance: async () => 5,
      stats: () => ({ solves: 0, totalCost: 0, totalSolveMs: 0, failures: 0 }),
    };
    const fallback = {
      provider: 'mock',
      solve: async () => ({ token: 'FB', cost: 0, solveTimeMs: 5, provider: 'mock' }),
      balance: async () => 10,
      stats: () => ({ solves: 1, totalCost: 0, totalSolveMs: 5, failures: 0 }),
    };
    const chain = createSolverChain({ primary, fallback, logger: makeStubLogger() });
    const r = await chain.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' });
    expect(r.token).toBe('FB');
    expect(r.provider).toBe('mock');
  });

  test('primary fails twice, no fallback → throws last error', async () => {
    const primary = {
      provider: '2captcha',
      solve: async () => { throw new SolverError('down', { code: 'POLL_FAILED' }); },
      balance: async () => 5,
      stats: () => ({ solves: 0, totalCost: 0, totalSolveMs: 0, failures: 0 }),
    };
    const chain = createSolverChain({ primary, logger: makeStubLogger() });
    await expect(chain.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' }))
      .rejects.toThrow(/down/);
  });

  test('primary fails twice, fallback also fails → throws fallback error', async () => {
    const primary = {
      provider: '2captcha',
      solve: async () => { throw new SolverError('primary down', { code: 'POLL_FAILED' }); },
      balance: async () => 5, stats: () => ({ solves: 0, totalCost: 0, totalSolveMs: 0, failures: 0 }),
    };
    const fallback = {
      provider: 'anticaptcha',
      solve: async () => { throw new SolverError('fallback down', { code: 'POLL_FAILED' }); },
      balance: async () => 5, stats: () => ({ solves: 0, totalCost: 0, totalSolveMs: 0, failures: 0 }),
    };
    const chain = createSolverChain({ primary, fallback, logger: makeStubLogger() });
    await expect(chain.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' }))
      .rejects.toThrow(/fallback down/);
  });

  test('BudgetExceededError from primary is NOT retried (surfaces immediately)', async () => {
    let calls = 0;
    const primary = {
      provider: '2captcha',
      solve: async () => {
        calls++;
        throw new BudgetExceededError('over budget', { spent: 5, budget: 5 });
      },
      balance: async () => 0, stats: () => ({ solves: 0, totalCost: 0, totalSolveMs: 0, failures: 0 }),
    };
    const fallback = {
      provider: 'mock',
      solve: async () => ({ token: 'X', cost: 0, solveTimeMs: 0, provider: 'mock' }),
      balance: async () => 10, stats: () => ({ solves: 0, totalCost: 0, totalSolveMs: 0, failures: 0 }),
    };
    const chain = createSolverChain({ primary, fallback, logger: makeStubLogger() });
    await expect(chain.solve({ type: 'recaptcha-v2', sitekey: 'k', url: 'u' }))
      .rejects.toThrow(/over budget/);
    expect(calls).toBe(1); // not retried
  });

  test('stats() aggregates primary + fallback', () => {
    const primary = {
      provider: '2captcha',
      solve: async () => ({}), balance: async () => 5,
      stats: () => ({ solves: 3, totalCost: 0.009, totalSolveMs: 600, failures: 1 }),
    };
    const fallback = {
      provider: 'mock',
      solve: async () => ({}), balance: async () => 10,
      stats: () => ({ solves: 1, totalCost: 0, totalSolveMs: 5, failures: 0 }),
    };
    const chain = createSolverChain({ primary, fallback });
    const s = chain.stats();
    expect(s.solves).toBe(4);
    expect(s.totalCost).toBe(0.009);
    expect(s.totalSolveMs).toBe(605);
    expect(s.byProvider).toHaveProperty('2captcha');
    expect(s.byProvider).toHaveProperty('mock');
  });

  test('requires a primary solver', () => {
    expect(() => createSolverChain({})).toThrow(/primary/);
  });
});

// ===========================================================================
// CostLogger
// ===========================================================================

describe('Phase 2.6 — createCostLogger', () => {
  test('append writes a JSONL line + summary aggregates', () => {
    const files = {};
    const fsStub = {
      existsSync: () => true,
      mkdirSync: () => {},
      appendFileSync: (p, line) => { files[p] = (files[p] || '') + line; },
    };
    const log = createCostLogger({
      filePath: '/tmp/captcha.jsonl',
      fs: fsStub,
      nowFn: () => '2024-01-01T00:00:00Z',
      mkdirp: false,
    });
    log.append({ provider: '2captcha', type: 'recaptcha-v2', cost: 0.003, solveTimeMs: 4200, success: true, url: 'https://x' });
    log.append({ provider: '2captcha', type: 'recaptcha-v2', cost: 0.003, solveTimeMs: 4000, success: true, url: 'https://y' });
    log.append({ provider: 'mock', type: 'recaptcha-v2', cost: 0, solveTimeMs: 1, success: false, url: 'https://z', error: 'fail' });
    const s = log.summary();
    expect(s.count).toBe(3);
    expect(s.successCount).toBe(2);
    expect(s.successRate).toBe(66.7);
    expect(s.totalCost).toBe(0.006);
    expect(s.avgMs).toBe(2734); // (4200+4000+1)/3 ≈ 2733.67 → rounded
    expect(s.byProvider['2captcha'].count).toBe(2);
    expect(s.byProvider['2captcha'].totalCost).toBe(0.006);
    expect(s.byProvider['mock'].count).toBe(1);
    expect(s.byProvider['mock'].successCount).toBe(0);
    // The file got 3 JSONL lines.
    const lines = files['/tmp/captcha.jsonl'].trim().split('\n');
    expect(lines.length).toBe(3);
    const rec0 = JSON.parse(lines[0]);
    expect(rec0.provider).toBe('2captcha');
    expect(rec0.cost).toBe(0.003);
    expect(rec0.ts).toBe('2024-01-01T00:00:00Z');
  });

  test('append failure is non-fatal (logger.warn, no throw)', () => {
    const fsStub = {
      existsSync: () => true,
      mkdirSync: () => {},
      appendFileSync: () => { throw new Error('disk full'); },
    };
    const logger = makeStubLogger();
    const log = createCostLogger({ filePath: '/tmp/x.jsonl', fs: fsStub, logger, mkdirp: false });
    expect(() => log.append({ provider: '2captcha', cost: 0.003, success: true })).not.toThrow();
    expect(logger._calls.warn.length).toBeGreaterThan(0);
    // The in-memory record was still kept (summary works).
    expect(log.summary().count).toBe(1);
  });

  test('summary on an empty log returns zeros', () => {
    const log = createCostLogger({ filePath: '/tmp/empty.jsonl', fs: { existsSync: () => true }, mkdirp: false });
    const s = log.summary();
    expect(s.count).toBe(0);
    expect(s.totalCost).toBe(0);
    expect(s.avgMs).toBe(0);
    expect(s.successRate).toBe(0);
  });

  test('mkdirp creates the parent dir when missing', () => {
    let mkdirCalled = null;
    const fsStub = {
      existsSync: () => false,
      mkdirSync: (dir, opts) => { mkdirCalled = { dir, opts }; },
      appendFileSync: () => {},
    };
    createCostLogger({ filePath: '/tmp/nested/deep/captcha.jsonl', fs: fsStub, mkdirp: true });
    expect(mkdirCalled).not.toBeNull();
    expect(mkdirCalled.dir).toBe('/tmp/nested/deep');
    expect(mkdirCalled.opts).toEqual({ recursive: true });
  });

  test('getRecords returns a defensive copy', () => {
    const log = createCostLogger({ filePath: '/tmp/x.jsonl', fs: { existsSync: () => true }, mkdirp: false });
    log.append({ provider: '2captcha', cost: 0.003, success: true });
    const r1 = log.getRecords();
    r1.push({ hijacked: true });
    const r2 = log.getRecords();
    expect(r2.length).toBe(1);
  });
});

// ===========================================================================
// Injector — pure functions against the reCAPTCHA v2 fixture
// ===========================================================================

const FIXTURE_HTML = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'recaptcha-v2.html'),
  'utf8',
);

describe('Phase 2.6 — injectTokenIntoDom (pure, against fixture)', () => {
  test('populates the hidden #g-recaptcha-response textarea with the token', () => {
    const { document } = buildMockDom(FIXTURE_HTML);
    const touched = injectTokenIntoDom('SOLVED_TOKEN_123', document);
    expect(touched).toBeGreaterThanOrEqual(1);
    const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
    expect(ta).not.toBeNull();
    expect(ta.value).toBe('SOLVED_TOKEN_123');
  });

  test('makes the textarea visible (display block, readonly removed)', () => {
    const { document } = buildMockDom(FIXTURE_HTML);
    injectTokenIntoDom('TOK', document);
    const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
    expect(ta.style.display).toBe('block');
    expect(ta.style.visibility).toBe('visible');
    // The fixture marks it readonly; the injector removes that.
    expect(ta.getAttribute('readonly')).toBeNull();
  });

  test('returns 0 for an empty token', () => {
    const { document } = buildMockDom(FIXTURE_HTML);
    expect(injectTokenIntoDom('', document)).toBe(0);
  });

  test('injectTokenIntoDomWithEvents dispatches input + change (no throw)', () => {
    const { document, Event } = buildMockDom(FIXTURE_HTML);
    const touched = injectTokenIntoDomWithEvents('TOK', document, Event);
    expect(touched).toBeGreaterThanOrEqual(1);
  });

  test('handles a document with no matching textarea (returns 0)', () => {
    const emptyDoc = {
      querySelectorAll: () => ({ forEach: () => {}, length: 0 }),
      querySelector: () => null,
    };
    expect(injectTokenIntoDom('TOK', emptyDoc)).toBe(0);
  });
});

describe('Phase 2.6 — triggerCallbackInDom (pure, against fixture)', () => {
  test('walks ___grecaptcha_cfg.clients and calls the callback with the token', () => {
    const { document, window } = buildMockDom(FIXTURE_HTML);
    const r = triggerCallbackInDom('SOLVED_TOKEN', document, window);
    expect(r.ok).toBe(true);
    expect(r.method).toBe('callback');
    expect(window.__captchaCallbackCalled).toBe(true);
    expect(window.__captchaCallbackToken).toBe('SOLVED_TOKEN');
  });

  test('falls back to data-callback global when ___grecaptcha_cfg is absent', () => {
    const { document, window } = buildMockDom(FIXTURE_HTML);
    // Remove the cfg so the data-callback path is exercised.
    window.___grecaptcha_cfg = null;
    const r = triggerCallbackInDom('TOK2', document, window);
    expect(r.ok).toBe(true);
    expect(r.method).toBe('data-callback');
    expect(r.name).toBe('onCaptchaSuccess');
    expect(window.__dataCallbackCalled).toBe(true);
    expect(window.__dataCallbackToken).toBe('TOK2');
  });

  test('falls back to form.submit() when no callback + no data-callback', () => {
    const { document, window } = buildMockDom(FIXTURE_HTML);
    window.___grecaptcha_cfg = null;
    // Remove the data-callback attribute from the widget so the form path is hit.
    const widget = document.querySelector('.g-recaptcha');
    if (widget) widget.removeAttribute('data-callback');
    // Also remove the onCaptchaSuccess global.
    delete window.onCaptchaSuccess;
    const r = triggerCallbackInDom('TOK3', document, window);
    expect(r.ok).toBe(true);
    expect(r.method).toBe('form-submit');
  });

  test('returns ok:false when nothing can be triggered', () => {
    const emptyDoc = { querySelector: () => null };
    const emptyWin = {};
    const r = triggerCallbackInDom('TOK', emptyDoc, emptyWin);
    expect(r.ok).toBe(false);
    expect(r.method).toBeNull();
  });

  test('prefers a callback whose path contains "callback" over "submit"', () => {
    // Build a window with both a "submit" fn and a "callback" fn under clients.
    let callbackCalled = false;
    let submitCalled = false;
    const win = {
      ___grecaptcha_cfg: {
        clients: {
          c1: {
            widget: {
              submit: () => { submitCalled = true; },
              callback: (t) => { callbackCalled = true; },
            },
          },
        },
      },
    };
    const doc = { querySelector: () => null };
    const r = triggerCallbackInDom('T', doc, win);
    expect(r.method).toBe('callback');
    expect(callbackCalled).toBe(true);
    expect(submitCalled).toBe(false);
  });
});

describe('Phase 2.6 — page-bound wrappers (injectable evalFn)', () => {
  test('injectRecaptchaToken uses evalFn + returns the touched count', async () => {
    const evalFn = async (fn, token) => fn(token); // run the callback in Node
    // The callback uses `document` — install a stub global for the duration.
    const { document } = buildMockDom(FIXTURE_HTML);
    const origDoc = global.document;
    global.document = document;
    try {
      const n = await injectRecaptchaToken({}, 'TOK', { evalFn });
      expect(n).toBeGreaterThanOrEqual(1);
    } finally {
      global.document = origDoc;
    }
  });
  test('injectRecaptchaToken returns 0 for empty token (no evalFn call)', async () => {
    let called = false;
    const evalFn = async () => { called = true; return 0; };
    const n = await injectRecaptchaToken({}, '', { evalFn });
    expect(n).toBe(0);
    expect(called).toBe(false);
  });
  test('submitRecaptcha returns true when the evalFn result.ok is true', async () => {
    const evalFn = async () => ({ ok: true, method: 'callback' });
    const ok = await submitRecaptcha({}, 'TOK', { evalFn });
    expect(ok).toBe(true);
  });
  test('submitRecaptcha returns false when evalFn throws', async () => {
    const evalFn = async () => { throw new Error('page gone'); };
    const ok = await submitRecaptcha({}, 'TOK', { evalFn });
    expect(ok).toBe(false);
  });
});

describe('Phase 2.6 — solveAndInject (orchestrator helper)', () => {
  test('resolved:true when solver succeeds + navWaitFn reports navigation', async () => {
    const solver = createSolver({ provider: 'mock' });
    const detection = { detected: true, type: 'recaptcha-v2', sitekey: '6Lc_KEY', url: 'https://x', indicator: 'g-recaptcha' };
    const r = await solveAndInject({}, solver, detection, {
      sleepFn: noopSleep,
      evalFn: async () => 1, // injectRecaptchaToken touches 1 textarea
      navWaitFn: async () => true,
    });
    expect(r.resolved).toBe(true);
    expect(r.token).toMatch(/^mock-token-/);
    expect(r.provider).toBe('mock');
    expect(r.cost).toBe(0);
  });

  test('resolved:false when solver is null', async () => {
    const r = await solveAndInject({}, null, { detected: true, type: 'recaptcha-v2', sitekey: 'k', url: 'u' }, { sleepFn: noopSleep });
    expect(r.resolved).toBe(false);
  });

  test('resolved:false when detection.detected is false', async () => {
    const solver = createSolver({ provider: 'mock' });
    const r = await solveAndInject({}, solver, { detected: false, type: 'none', sitekey: null, url: 'u' }, { sleepFn: noopSleep });
    expect(r.resolved).toBe(false);
  });

  test('resolved:false when sitekey is null (cannot solve via service)', async () => {
    const solver = createSolver({ provider: 'mock' });
    const r = await solveAndInject({}, solver, { detected: true, type: 'unusual-traffic', sitekey: null, url: 'u' }, { sleepFn: noopSleep });
    expect(r.resolved).toBe(false);
  });

  test('resolved:false when solver.solve throws', async () => {
    const solver = { provider: '2captcha', solve: async () => { throw new SolverError('down', { code: 'POLL_FAILED' }); } };
    const r = await solveAndInject({}, solver, { detected: true, type: 'recaptcha-v2', sitekey: 'k', url: 'u' }, { sleepFn: noopSleep });
    expect(r.resolved).toBe(false);
    expect(r.provider).toBe('2captcha');
  });

  test('resolved:false when navWaitFn reports no navigation (token injected but page did not move)', async () => {
    const solver = createSolver({ provider: 'mock' });
    const r = await solveAndInject({}, solver, { detected: true, type: 'recaptcha-v2', sitekey: 'k', url: 'u' }, {
      sleepFn: noopSleep,
      evalFn: async () => 1,
      navWaitFn: async () => false,
    });
    expect(r.resolved).toBe(false);
    expect(r.token).toMatch(/^mock-token-/); // token was still produced
  });
});

// ===========================================================================
// Orchestrator — handleCaptcha (all paths)
// ===========================================================================

describe('Phase 2.6 — handleCaptcha orchestrator', () => {
  test('none detected → resolved:true, method:none (no solver cost)', async () => {
    const r = await handleCaptcha({}, {
      detectFn: async () => ({ detected: false, type: 'none', sitekey: null, url: 'u', indicator: null }),
      sleepFn: noopSleep,
    });
    expect(r.resolved).toBe(true);
    expect(r.method).toBe('none');
    expect(r.cost).toBe(0);
  });

  test('solver resolves the captcha → resolved:true, method:solved, cost recorded', async () => {
    const solver = createSolver({ provider: 'mock' });
    const guard = new BudgetGuard({ budget: 5 });
    const costLog = createCostLogger({ filePath: '/tmp/cl.jsonl', fs: { existsSync: () => true }, mkdirp: false });
    const r = await handleCaptcha({}, {
      solver,
      budgetGuard: guard,
      costLogger: costLog,
      detectFn: async () => ({ detected: true, type: 'recaptcha-v2', sitekey: '6Lc_KEY', url: 'https://x', indicator: 'g-recaptcha' }),
      solveAndInjectFn: async () => ({ resolved: true, token: 'TOK', cost: 0.003, solveTimeMs: 100, provider: 'mock', method: 'callback' }),
      sleepFn: noopSleep,
    });
    expect(r.resolved).toBe(true);
    expect(r.method).toBe('solved');
    expect(r.cost).toBe(0.003);
    expect(guard.spent).toBe(0.003);
    const s = costLog.summary();
    expect(s.count).toBe(1);
    expect(s.successCount).toBe(1);
    expect(s.totalCost).toBe(0.003);
  });

  test('no solver configured → falls back to pause-and-alert, cost logged as failed', async () => {
    let fallbackCalled = false;
    let paused = 0;
    const costLog = createCostLogger({ filePath: '/tmp/cl2.jsonl', fs: { existsSync: () => true }, mkdirp: false });
    const r = await handleCaptcha({}, {
      solver: null, // no solver
      costLogger: costLog,
      detectFn: async () => ({ detected: true, type: 'unusual-traffic', sitekey: null, url: 'u', indicator: 'unusual traffic' }),
      sleepFn: async (ms) => { paused += ms; },
      captchaWaitMs: 5000,
      onFallback: async () => { fallbackCalled = true; },
    });
    expect(r.resolved).toBe(false);
    expect(r.method).toBe('paused');
    expect(fallbackCalled).toBe(true);
    expect(paused).toBe(5000);
    const s = costLog.summary();
    expect(s.count).toBe(1);
    expect(s.successCount).toBe(0);
    expect(s.totalCost).toBe(0);
  });

  test('provider=none solver → falls back (treated as no solver)', async () => {
    const noneSolver = createSolver({ provider: 'none' });
    const r = await handleCaptcha({}, {
      solver: noneSolver,
      detectFn: async () => ({ detected: true, type: 'recaptcha-v2', sitekey: 'k', url: 'u', indicator: 'g-recaptcha' }),
      solveAndInjectFn: async () => ({ resolved: true, token: 'T', cost: 0, solveTimeMs: 0, provider: 'none', method: 'callback' }),
      sleepFn: noopSleep,
      captchaWaitMs: 1,
    });
    // provider 'none' → canAutoSolve is false → fallback path.
    expect(r.resolved).toBe(false);
    expect(r.method).toBe('paused');
  });

  test('budget exceeded → falls back (does NOT spend more)', async () => {
    const solver = createSolver({ provider: 'mock' });
    const guard = new BudgetGuard({ budget: 0.001 });
    guard.record(0.01); // push over budget
    let solveCalled = false;
    const r = await handleCaptcha({}, {
      solver,
      budgetGuard: guard,
      detectFn: async () => ({ detected: true, type: 'recaptcha-v2', sitekey: 'k', url: 'u', indicator: 'g-recaptcha' }),
      solveAndInjectFn: async () => { solveCalled = true; return { resolved: true }; },
      sleepFn: noopSleep,
      captchaWaitMs: 1,
    });
    expect(r.resolved).toBe(false);
    expect(r.method).toBe('paused');
    expect(r.budgetExceeded).toBe(true);
    expect(solveCalled).toBe(false); // solver never called (budget guard blocked it)
  });

  test('solve fails → falls back to pause-and-alert, cost logged as failed', async () => {
    const solver = createSolver({ provider: '2captcha', apiKey: 'K', httpClient: makeStubHttpClient([]) });
    const guard = new BudgetGuard({ budget: 5 });
    const costLog = createCostLogger({ filePath: '/tmp/cl3.jsonl', fs: { existsSync: () => true }, mkdirp: false });
    const r = await handleCaptcha({}, {
      solver,
      budgetGuard: guard,
      costLogger: costLog,
      detectFn: async () => ({ detected: true, type: 'recaptcha-v2', sitekey: 'k', url: 'u', indicator: 'g-recaptcha' }),
      solveAndInjectFn: async () => ({ resolved: false, token: null, cost: 0, solveTimeMs: 0, provider: '2captcha', method: null }),
      sleepFn: noopSleep,
      captchaWaitMs: 1,
    });
    expect(r.resolved).toBe(false);
    expect(r.method).toBe('solve-failed');
    expect(guard.spent).toBe(0); // failed solve does NOT burn budget
    const s = costLog.summary();
    expect(s.count).toBe(1);
    expect(s.successCount).toBe(0);
  });

  test('detectFn throws → treated as no-captcha (non-fatal, scrape continues)', async () => {
    const r = await handleCaptcha({}, {
      detectFn: async () => { throw new Error('page gone'); },
      sleepFn: noopSleep,
    });
    expect(r.resolved).toBe(true);
    expect(r.method).toBe('detect-failed');
  });

  test('solveAndInjectFn throws → fallback path, no crash', async () => {
    const solver = createSolver({ provider: 'mock' });
    const r = await handleCaptcha({}, {
      solver,
      detectFn: async () => ({ detected: true, type: 'recaptcha-v2', sitekey: 'k', url: 'u', indicator: 'g-recaptcha' }),
      solveAndInjectFn: async () => { throw new Error('inject blew up'); },
      sleepFn: noopSleep,
      captchaWaitMs: 1,
    });
    expect(r.resolved).toBe(false);
    expect(['solve-failed', 'paused']).toContain(r.method);
  });

  test('onFallback receives the detection + pauseMs', async () => {
    let received = null;
    const r = await handleCaptcha({}, {
      solver: null,
      detectFn: async () => ({ detected: true, type: 'unusual-traffic', sitekey: null, url: 'u', indicator: 'unusual traffic' }),
      sleepFn: noopSleep,
      captchaWaitMs: 7000,
      onFallback: async (ctx) => { received = ctx; },
    });
    expect(r.resolved).toBe(false);
    expect(received).not.toBeNull();
    expect(received.detection.type).toBe('unusual-traffic');
    expect(received.pauseMs).toBe(7000);
  });

  test('budget guard record() only on success (failed solve does not burn budget)', async () => {
    const solver = createSolver({ provider: 'mock' });
    const guard = new BudgetGuard({ budget: 5 });
    const costLog = createCostLogger({ filePath: '/tmp/cl4.jsonl', fs: { existsSync: () => true }, mkdirp: false });
    // First: a failed solve.
    await handleCaptcha({}, {
      solver, budgetGuard: guard, costLogger: costLog,
      detectFn: async () => ({ detected: true, type: 'recaptcha-v2', sitekey: 'k', url: 'u', indicator: 'g-recaptcha' }),
      solveAndInjectFn: async () => ({ resolved: false, token: null, cost: 0, solveTimeMs: 0, provider: 'mock', method: null }),
      sleepFn: noopSleep, captchaWaitMs: 1,
    });
    expect(guard.spent).toBe(0);
    // Second: a successful solve.
    await handleCaptcha({}, {
      solver, budgetGuard: guard, costLogger: costLog,
      detectFn: async () => ({ detected: true, type: 'recaptcha-v2', sitekey: 'k', url: 'u', indicator: 'g-recaptcha' }),
      solveAndInjectFn: async () => ({ resolved: true, token: 'T', cost: 0.003, solveTimeMs: 100, provider: 'mock', method: 'callback' }),
      sleepFn: noopSleep,
    });
    expect(guard.spent).toBe(0.003);
    // Cost log has 2 records (1 failed + 1 success).
    const s = costLog.summary();
    expect(s.count).toBe(2);
    expect(s.successCount).toBe(1);
  });
});
