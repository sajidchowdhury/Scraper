'use strict';

/**
 * tests/session.test.js — Phase 2.7 (Session & Cookie Rotation)
 *
 * Coverage:
 *   - createSessionManager: DI with mock createContext + injectable clock/sleep
 *     · getContext creates a session on first call
 *     · getContext returns the SAME context when not exhausted (no churn)
 *     · shouldRotate: false under thresholds; true when requestCount >= maxRequests
 *     · shouldRotate: true when age >= maxAgeMs (independent of count)
 *     · tickRequest increments count + auto-rotates when threshold hit
 *     · tickRequest returns { rotated, reason, page } with the new page on rotation
 *     · rotate() force-rotates + records reason on the old session
 *     · release() closes the current context
 *     · stats(): sessionsCreated, rotations, totalRequests, avgRequestsPerSession, avgAgeMs
 *     · warmup runs on each new context when warmupFn provided
 *     · warmup failure is non-fatal (session still usable)
 *     · validation: missing createContext → SessionError; invalid maxRequests/maxAge → SessionError
 *   - Cookie isolation: two mock contexts don't share cookie state
 *   - warmupContext: visits benign URLs + waits (injectable page/sleep/rng)
 *     · visits google.com first + a random second site
 *     · waits a randomized 2-5s between visits (capped by durationMs)
 *     · performs a benign search on google.com (search=true)
 *     · search=false skips the search
 *     · a goto failure is non-fatal
 *     · returns { visited, waitedMs, searched, query }
 *   - accountWarmup: opt-in, off by default
 *     · loadAccounts: valid file → array; missing file → error; malformed JSON → error
 *     · permission warning when world-readable (non-fatal)
 *     · pickAccount skips used-today accounts
 *     · redactEmail masks the local-part
 *     · accountWarmup logs in (stub page) + never logs the password
 *   - createRealContextFactory: calls browser.newContext + applies fingerprint + stealth
 *
 * Run: bun test tests/session.test.js
 */

const fs = require('fs');
const path = require('path');
const {
  createSessionManager,
  createSessionRecord,
  sessionInfoFor,
  SessionError,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_MAX_AGE_MS,
} = require('../src/session/manager');
const {
  warmupContext,
  performBenignSearch,
  DEFAULT_WARMUP_SITES,
  DEFAULT_WARMUP_SEARCHES,
} = require('../src/session/warmup');
const {
  accountWarmup,
  loadAccounts,
  pickAccount,
  redactEmail,
  AccountWarmupError,
} = require('../src/session/account-warmup');
const { createRealContextFactory } = require('../src/session/context-factory');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubLogger() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  const log = (level) => (msg, meta) => { calls[level].push({ msg, meta }); };
  const logger = {
    debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'),
    phase: () => logger,
  };
  logger._calls = calls;
  return logger;
}

function noopSleep() { return Promise.resolve(); }

// A mock createContext that returns a fresh { context, page } each call.
// Each context has its own cookie jar (object) so isolation can be tested.
function makeMockCreateContext() {
  const created = [];
  const factory = async ({ browser, proxy, fingerprint } = {}) => {
    const cookieJar = {};
    const context = {
      _cookieJar: cookieJar,
      _closed: false,
      _fingerprint: fingerprint,
      _proxy: proxy,
      close: async () => { context._closed = true; },
      setDefaultTimeout: () => {},
      newPage: async () => page,
    };
    const page = {
      _cookieJar: cookieJar,
      _navigations: [],
      _url: 'about:blank',
      goto: async (url) => { page._navigations.push(url); page._url = url; },
      url: () => page._url,
      $: async () => null,
      keyboard: { type: async () => {}, press: async () => {} },
    };
    created.push({ context, page });
    return { context, page };
  };
  factory._created = created;
  return factory;
}

// A stepping clock for deterministic age-based rotation tests.
function makeSteppingClock(start, step) {
  let t = start;
  return () => { const v = t; t += step; return v; };
}

// A stub page for warmup tests that records navigations.
function makeStubPage() {
  const p = {
    _navigations: [],
    _url: 'about:blank',
    goto: async (url) => { p._navigations.push(url); p._url = url; },
    url: () => p._url,
    $: async () => null,
    keyboard: { type: async () => {}, press: async () => {} },
  };
  return p;
}

// ===========================================================================
// createSessionManager — core rotation logic
// ===========================================================================

describe('Phase 2.7 — createSessionManager DI + validation', () => {
  test('throws SessionError when createContext is missing', () => {
    expect(() => createSessionManager({})).toThrow(/createContext/);
  });
  test('throws SessionError for invalid maxRequests', () => {
    expect(() => createSessionManager({ createContext: () => ({}), maxRequests: 0 })).toThrow(/maxRequests/);
    expect(() => createSessionManager({ createContext: () => ({}), maxRequests: NaN })).toThrow(/maxRequests/);
  });
  test('throws SessionError for invalid maxAgeMs', () => {
    expect(() => createSessionManager({ createContext: () => ({}), maxAgeMs: 0 })).toThrow(/maxAgeMs/);
    expect(() => createSessionManager({ createContext: () => ({}), maxAgeMs: Infinity })).toThrow(/maxAgeMs/);
  });
  test('uses DEFAULT_MAX_REQUESTS=50 + DEFAULT_MAX_AGE_MS=600000 when omitted', () => {
    expect(DEFAULT_MAX_REQUESTS).toBe(50);
    expect(DEFAULT_MAX_AGE_MS).toBe(600000);
  });
});

describe('Phase 2.7 — getContext creates a session on first call', () => {
  test('first call creates a new context (isNew:true); second returns the same (isNew:false)', async () => {
    const factory = makeMockCreateContext();
    const mgr = createSessionManager({
      createContext: factory,
      clock: makeSteppingClock(1000, 0), // frozen clock (no age rotation)
      logger: makeStubLogger(),
    });
    const a = await mgr.getContext({ browser: {}, proxy: null, fingerprint: null });
    expect(a.isNew).toBe(true);
    expect(a.context).toBeDefined();
    expect(a.page).toBeDefined();
    const b = await mgr.getContext({ browser: {}, proxy: null, fingerprint: null });
    expect(b.isNew).toBe(false);
    expect(b.context).toBe(a.context); // same context
    expect(factory._created.length).toBe(1); // only one context created
  });
  test('sessionInfo includes id, ageMs, requestCount', async () => {
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      clock: makeSteppingClock(1000, 100),
      logger: makeStubLogger(),
    });
    const a = await mgr.getContext({});
    expect(a.sessionInfo.id).toMatch(/^session-/);
    expect(a.sessionInfo.ageMs).toBeGreaterThanOrEqual(0);
    expect(a.sessionInfo.requestCount).toBe(0);
  });
});

describe('Phase 2.7 — shouldRotate (count + age triggers)', () => {
  test('false when under both thresholds', async () => {
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      maxRequests: 10,
      maxAgeMs: 60000,
      clock: makeSteppingClock(1000, 100),
      logger: makeStubLogger(),
    });
    await mgr.getContext({});
    // Simulate 5 requests
    for (let i = 0; i < 5; i++) mgr.current().record.requestCount++;
    const check = mgr.shouldRotate();
    expect(check.rotate).toBe(false);
  });
  test('true when requestCount >= maxRequests (reason: max-requests)', async () => {
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      maxRequests: 5,
      maxAgeMs: 60000,
      clock: makeSteppingClock(1000, 0),
      logger: makeStubLogger(),
    });
    await mgr.getContext({});
    for (let i = 0; i < 5; i++) mgr.current().record.requestCount++;
    const check = mgr.shouldRotate();
    expect(check.rotate).toBe(true);
    expect(check.reason).toBe('max-requests');
    expect(check.requestCount).toBe(5);
  });
  test('true when age >= maxAgeMs (reason: max-age, independent of count)', async () => {
    const clock = makeSteppingClock(1000, 10000); // 10s per call
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      maxRequests: 1000, // high so count doesn't trigger
      maxAgeMs: 5000,     // 5s — exceeded after one clock tick
      clock,
      logger: makeStubLogger(),
    });
    await mgr.getContext({}); // createdAt = 1000; next clock() = 11000
    const check = mgr.shouldRotate(); // ageMs = 11000 - 1000 = 10000 >= 5000
    expect(check.rotate).toBe(true);
    expect(check.reason).toBe('max-age');
  });
  test('returns rotate:false when no current session', () => {
    const mgr = createSessionManager({ createContext: makeMockCreateContext(), logger: makeStubLogger() });
    const check = mgr.shouldRotate();
    expect(check.rotate).toBe(false);
  });
});

describe('Phase 2.7 — tickRequest increments + auto-rotates', () => {
  test('tickRequest creates a session on first call (reason: initial)', async () => {
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      maxRequests: 10,
      clock: makeSteppingClock(1000, 0),
      logger: makeStubLogger(),
    });
    const r = await mgr.tickRequest({ browser: {} });
    expect(r.rotated).toBe(true);
    expect(r.reason).toBe('initial');
    expect(r.page).toBeDefined();
    expect(mgr.current().record.requestCount).toBe(1);
  });
  test('tickRequest does NOT rotate under thresholds', async () => {
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      maxRequests: 10,
      clock: makeSteppingClock(1000, 0),
      logger: makeStubLogger(),
    });
    await mgr.tickRequest({ browser: {} }); // initial (count=1)
    const r = await mgr.tickRequest({ browser: {} }); // count=2
    expect(r.rotated).toBe(false);
    expect(r.reason).toBeNull();
    expect(mgr.current().record.requestCount).toBe(2);
  });
  test('tickRequest rotates when count hits maxRequests (reason: max-requests)', async () => {
    const factory = makeMockCreateContext();
    const mgr = createSessionManager({
      createContext: factory,
      maxRequests: 3,
      clock: makeSteppingClock(1000, 0),
      logger: makeStubLogger(),
    });
    await mgr.tickRequest({ browser: {} }); // count=1
    await mgr.tickRequest({ browser: {} }); // count=2
    const r = await mgr.tickRequest({ browser: {} }); // count=3 → rotate
    expect(r.rotated).toBe(true);
    expect(r.reason).toBe('max-requests');
    expect(r.page).toBeDefined();
    // A new context was created (2 total now: initial + rotated)
    expect(factory._created.length).toBe(2);
    // The new session starts at requestCount=0 (the tickRequest that triggered
    // rotation does NOT count against the new session)
    expect(mgr.current().record.requestCount).toBe(0);
  });
  test('tickRequest rotates when age hits maxAgeMs (reason: max-age)', async () => {
    const clock = makeSteppingClock(0, 60000); // 60s per call
    const factory = makeMockCreateContext();
    const mgr = createSessionManager({
      createContext: factory,
      maxRequests: 1000,
      maxAgeMs: 30000, // 30s — exceeded after one tick
      clock,
      logger: makeStubLogger(),
    });
    await mgr.tickRequest({ browser: {} }); // initial at t=0
    const r = await mgr.tickRequest({ browser: {} }); // t=60000, age=60000 >= 30000
    expect(r.rotated).toBe(true);
    expect(r.reason).toBe('max-age');
    expect(factory._created.length).toBe(2);
  });
});

describe('Phase 2.7 — rotate() force rotation', () => {
  test('force-rotates + records reason on the old session', async () => {
    const factory = makeMockCreateContext();
    const mgr = createSessionManager({
      createContext: factory,
      maxRequests: 100,
      clock: makeSteppingClock(1000, 0),
      logger: makeStubLogger(),
    });
    const first = await mgr.getContext({});
    const r = await mgr.rotate({ browser: {}, reason: 'manual' });
    expect(r.isNew).toBe(true);
    expect(r.context).not.toBe(first.context);
    expect(factory._created.length).toBe(2);
    // The old session's record has rotatedAt + reason set.
    const oldRecord = mgr.stats();
    // sessionsCreated counts both; the first session's rotationReason is 'manual'.
    // We can verify via stats: rotations=1.
    expect(oldRecord.rotations).toBe(1);
  });
  test('rotate without a current session just opens one', async () => {
    const factory = makeMockCreateContext();
    const mgr = createSessionManager({
      createContext: factory,
      clock: makeSteppingClock(0, 0),
      logger: makeStubLogger(),
    });
    const r = await mgr.rotate({ browser: {} });
    expect(r.isNew).toBe(true);
    expect(factory._created.length).toBe(1);
    expect(mgr.stats().rotations).toBe(0); // nothing to rotate from
  });
});

describe('Phase 2.7 — release() closes the current context', () => {
  test('release closes the context + clears current', async () => {
    const factory = makeMockCreateContext();
    const mgr = createSessionManager({
      createContext: factory,
      clock: makeSteppingClock(0, 0),
      logger: makeStubLogger(),
    });
    const a = await mgr.getContext({});
    expect(mgr.current()).not.toBeNull();
    await mgr.release();
    expect(mgr.current()).toBeNull();
    expect(a.context._closed).toBe(true);
  });
  test('release is a no-op when no current session', async () => {
    const mgr = createSessionManager({ createContext: makeMockCreateContext(), logger: makeStubLogger() });
    await expect(mgr.release()).resolves.toBeUndefined();
  });
  test('release survives context.close() throwing (non-fatal)', async () => {
    const factory = async () => ({
      context: { close: async () => { throw new Error('already closed'); }, setDefaultTimeout: () => {} },
      page: {},
    });
    const mgr = createSessionManager({ createContext: factory, logger: makeStubLogger() });
    await mgr.getContext({});
    await expect(mgr.release()).resolves.toBeUndefined();
    expect(mgr.current()).toBeNull();
  });
});

describe('Phase 2.7 — stats()', () => {
  test('tracks sessionsCreated, rotations, totalRequests', async () => {
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      maxRequests: 2,
      clock: makeSteppingClock(1000, 0),
      logger: makeStubLogger(),
    });
    await mgr.tickRequest({ browser: {} }); // session 1, count=1
    await mgr.tickRequest({ browser: {} }); // count=2 → rotate → session 2
    await mgr.tickRequest({ browser: {} }); // session 2, count=1
    const s = mgr.stats();
    expect(s.sessionsCreated).toBe(2);
    expect(s.rotations).toBe(1);
    expect(s.totalRequests).toBe(3); // 2 from session 1 + 1 from session 2
  });
  test('avgRequestsPerSession = totalRequests / sessionsCreated', async () => {
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      maxRequests: 100,
      clock: makeSteppingClock(0, 0),
      logger: makeStubLogger(),
    });
    await mgr.tickRequest({ browser: {} });
    await mgr.tickRequest({ browser: {} });
    await mgr.tickRequest({ browser: {} });
    const s = mgr.stats();
    expect(s.sessionsCreated).toBe(1);
    expect(s.totalRequests).toBe(3);
    expect(s.avgRequestsPerSession).toBe(3);
  });
  test('avgAgeMs averages closed sessions', async () => {
    const clock = makeSteppingClock(1000, 1000); // 1s per call
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      maxRequests: 2,
      maxAgeMs: 10_000_000,
      clock,
      logger: makeStubLogger(),
    });
    await mgr.tickRequest({ browser: {} }); // t=1000, session1 created
    await mgr.tickRequest({ browser: {} }); // t=2000, count=2
    await mgr.tickRequest({ browser: {} }); // t=3000, count=3 → rotate (session1 closed at 3000, age=2000)
    const s = mgr.stats();
    expect(s.sessionsCreated).toBe(2);
    expect(s.avgAgeMs).toBeGreaterThanOrEqual(0);
  });
  test('stats includes maxRequests, maxAgeMs, warmup config', async () => {
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      maxRequests: 42,
      maxAgeMs: 99000,
      warmup: true,
      clock: makeSteppingClock(0, 0),
      logger: makeStubLogger(),
    });
    const s = mgr.stats();
    expect(s.maxRequests).toBe(42);
    expect(s.maxAgeMs).toBe(99000);
    expect(s.warmup).toBe(true);
  });
});

describe('Phase 2.7 — warmup runs on each new context', () => {
  test('warmupFn is called when a session is created', async () => {
    let warmupCalls = 0;
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      warmup: true,
      warmupFn: async () => { warmupCalls++; return { visited: ['https://www.google.com'], waitedMs: 100 }; },
      clock: makeSteppingClock(0, 0),
      logger: makeStubLogger(),
    });
    await mgr.getContext({});
    expect(warmupCalls).toBe(1);
  });
  test('warmup is NOT called when warmup:false', async () => {
    let warmupCalls = 0;
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      warmup: false,
      warmupFn: async () => { warmupCalls++; },
      clock: makeSteppingClock(0, 0),
      logger: makeStubLogger(),
    });
    await mgr.getContext({});
    expect(warmupCalls).toBe(0);
  });
  test('warmup failure is non-fatal (session still usable)', async () => {
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      warmup: true,
      warmupFn: async () => { throw new Error('network down'); },
      clock: makeSteppingClock(0, 0),
      logger: makeStubLogger(),
    });
    const a = await mgr.getContext({});
    expect(a.context).toBeDefined(); // session created despite warmup failure
    expect(mgr.current()).not.toBeNull();
  });
  test('warmup runs on rotated sessions too', async () => {
    let warmupCalls = 0;
    const mgr = createSessionManager({
      createContext: makeMockCreateContext(),
      maxRequests: 1,
      warmup: true,
      warmupFn: async () => { warmupCalls++; return { visited: [], waitedMs: 0 }; },
      clock: makeSteppingClock(0, 0),
      logger: makeStubLogger(),
    });
    await mgr.tickRequest({ browser: {} }); // initial + warmup (1)
    await mgr.tickRequest({ browser: {} }); // rotate → new session + warmup (2)
    expect(warmupCalls).toBe(2);
  });
});

// ===========================================================================
// Cookie isolation — two contexts don't share cookie state
// ===========================================================================

describe('Phase 2.7 — cookie isolation between contexts', () => {
  test('context A cookies are not visible in context B', async () => {
    const factory = makeMockCreateContext();
    const mgr = createSessionManager({
      createContext: factory,
      maxRequests: 1, // rotate after 1 request
      clock: makeSteppingClock(0, 0),
      logger: makeStubLogger(),
    });
    // Session 1
    const a = await mgr.tickRequest({ browser: {} });
    a.page._cookieJar['SID'] = 'session-1-cookie';
    // Rotate (maxRequests=1 → next tick rotates)
    const b = await mgr.tickRequest({ browser: {} });
    // The new context has its own (empty) cookie jar
    expect(b.page._cookieJar.SID).toBeUndefined();
    expect(b.page._cookieJar).not.toBe(a.page._cookieJar);
  });
  test('each mock context gets a fresh cookie jar object', async () => {
    const factory = makeMockCreateContext();
    const mgr = createSessionManager({
      createContext: factory,
      maxRequests: 1,
      clock: makeSteppingClock(0, 0),
      logger: makeStubLogger(),
    });
    const a = await mgr.tickRequest({ browser: {} });
    const b = await mgr.tickRequest({ browser: {} });
    const c = await mgr.tickRequest({ browser: {} });
    expect(a.page._cookieJar).not.toBe(b.page._cookieJar);
    expect(b.page._cookieJar).not.toBe(c.page._cookieJar);
    expect(a.page._cookieJar).not.toBe(c.page._cookieJar);
  });
});

// ===========================================================================
// warmupContext — benign pre-Maps visits
// ===========================================================================

describe('Phase 2.7 — warmupContext', () => {
  test('visits google.com first + a second site', async () => {
    const page = makeStubPage();
    const r = await warmupContext(page, {
      sleepFn: noopSleep,
      rng: () => 0.5,
      durationMs: 100000,
      search: false, // skip search for this test
    });
    expect(r.visited.length).toBeGreaterThanOrEqual(1);
    expect(r.visited[0]).toBe('https://www.google.com');
    expect(r.searched).toBe(false);
  });
  test('waits a randomized 2-5s between visits (capped by durationMs)', async () => {
    const page = makeStubPage();
    let slept = 0;
    const r = await warmupContext(page, {
      sleepFn: async (ms) => { slept += ms; },
      rng: () => 0.5,
      durationMs: 100000,
      search: false,
    });
    expect(slept).toBeGreaterThan(0);
    expect(r.waitedMs).toBe(slept);
  });
  test('performs a benign search on google.com when search=true', async () => {
    // Stub page with a search input so performBenignSearch finds it.
    const page = {
      _navigations: [],
      _url: 'about:blank',
      goto: async (url) => { page._navigations.push(url); page._url = url; },
      url: () => page._url,
      $: async (sel) => {
        if (sel.includes('[name="q"]') || sel.includes('input')) {
          return { click: async () => {}, fill: async () => {} };
        }
        return null;
      },
      keyboard: { type: async () => {}, press: async () => {} },
    };
    const r = await warmupContext(page, {
      sleepFn: noopSleep,
      rng: () => 0.5,
      durationMs: 100000,
      search: true,
    });
    expect(r.searched).toBe(true);
    expect(r.query).toBeTruthy();
    expect(DEFAULT_WARMUP_SEARCHES).toContain(r.query);
  });
  test('search=false skips the search', async () => {
    const page = makeStubPage();
    const r = await warmupContext(page, {
      sleepFn: noopSleep,
      rng: () => 0.5,
      durationMs: 100000,
      search: false,
    });
    expect(r.searched).toBe(false);
    expect(r.query).toBeNull();
  });
  test('a goto failure is non-fatal (other visits continue)', async () => {
    const page = {
      _navigations: [],
      _url: 'about:blank',
      goto: async (url) => {
        if (url.includes('youtube')) throw new Error('blocked');
        page._navigations.push(url); page._url = url;
      },
      url: () => page._url,
      $: async () => null,
      keyboard: { type: async () => {}, press: async () => {} },
    };
    const r = await warmupContext(page, {
      sleepFn: noopSleep,
      rng: () => 0.5,
      durationMs: 100000,
      search: false,
      sites: ['https://www.google.com', 'https://www.youtube.com'],
    });
    // google.com visited; youtube.com failed but didn't crash.
    expect(r.visited).toContain('https://www.google.com');
    expect(r.visited).not.toContain('https://www.youtube.com');
  });
  test('durationMs caps total wait time', async () => {
    const page = makeStubPage();
    let slept = 0;
    const r = await warmupContext(page, {
      sleepFn: async (ms) => { slept += ms; },
      rng: () => 0.9, // max wait (5s)
      durationMs: 3000, // cap at 3s
      search: false,
    });
    expect(slept).toBeLessThanOrEqual(6000); // 2 visits × up to 5s each, capped by 3s budget
  });
  test('uses DEFAULT_WARMUP_SITES (google.com first)', () => {
    expect(DEFAULT_WARMUP_SITES[0]).toBe('https://www.google.com');
    expect(DEFAULT_WARMUP_SITES.length).toBeGreaterThanOrEqual(3);
  });
});

// ===========================================================================
// account-warmup — opt-in, off by default
// ===========================================================================

describe('Phase 2.7 — loadAccounts', () => {
  test('loads a valid JSON array of {email, password}', () => {
    const tmp = path.join('/tmp', 'test-accounts-' + Date.now() + '.json');
    fs.writeFileSync(tmp, JSON.stringify([
      { email: 'a@example.com', password: 'pw1' },
      { email: 'b@example.com', password: 'pw2' },
    ]), { mode: 0o600 });
    try {
      const accts = loadAccounts({ filePath: tmp, logger: makeStubLogger() });
      expect(accts.length).toBe(2);
      expect(accts[0].email).toBe('a@example.com');
      expect(accts[0].password).toBe('pw1');
    } finally {
      fs.unlinkSync(tmp);
    }
  });
  test('throws AccountWarmupError when file not found', () => {
    expect(() => loadAccounts({ filePath: '/tmp/nonexistent-xyz.json' }))
      .toThrow(/not found/i);
  });
  test('throws AccountWarmupError for malformed JSON', () => {
    const tmp = path.join('/tmp', 'test-accounts-bad-' + Date.now() + '.json');
    fs.writeFileSync(tmp, 'not json {', { mode: 0o600 });
    try {
      expect(() => loadAccounts({ filePath: tmp })).toThrow(/not valid JSON/i);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
  test('throws AccountWarmupError when not an array', () => {
    const tmp = path.join('/tmp', 'test-accounts-notarray-' + Date.now() + '.json');
    fs.writeFileSync(tmp, JSON.stringify({ email: 'x', password: 'y' }), { mode: 0o600 });
    try {
      expect(() => loadAccounts({ filePath: tmp })).toThrow(/JSON array/i);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
  test('throws when an entry is missing email or password', () => {
    const tmp = path.join('/tmp', 'test-accounts-missing-' + Date.now() + '.json');
    fs.writeFileSync(tmp, JSON.stringify([{ email: 'x@example.com' }]), { mode: 0o600 });
    try {
      expect(() => loadAccounts({ filePath: tmp })).toThrow(/password/i);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
  test('throws when array is empty', () => {
    const tmp = path.join('/tmp', 'test-accounts-empty-' + Date.now() + '.json');
    fs.writeFileSync(tmp, '[]', { mode: 0o600 });
    try {
      expect(() => loadAccounts({ filePath: tmp })).toThrow(/empty/i);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
  test('warns (non-fatal) when file is world-readable', () => {
    const tmp = path.join('/tmp', 'test-accounts-world-' + Date.now() + '.json');
    fs.writeFileSync(tmp, JSON.stringify([{ email: 'a@b.com', password: 'x' }]), { mode: 0o644 });
    const logger = makeStubLogger();
    try {
      const accts = loadAccounts({ filePath: tmp, logger });
      expect(accts.length).toBe(1);
      expect(logger._calls.warn.length).toBeGreaterThan(0);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe('Phase 2.7 — pickAccount', () => {
  test('returns an available account (skips used-today)', () => {
    const accounts = [
      { email: 'a@example.com', password: '1' },
      { email: 'b@example.com', password: '2' },
    ];
    const used = new Set(['a@example.com']);
    const pick = pickAccount(accounts, { usedToday: used, rng: () => 0 });
    expect(pick.email).toBe('b@example.com');
  });
  test('returns null when all accounts used today', () => {
    const accounts = [{ email: 'a@example.com', password: '1' }];
    const used = new Set(['a@example.com']);
    const pick = pickAccount(accounts, { usedToday: used });
    expect(pick).toBeNull();
  });
  test('picks randomly from available accounts', () => {
    const accounts = [
      { email: 'a@example.com', password: '1' },
      { email: 'b@example.com', password: '2' },
      { email: 'c@example.com', password: '3' },
    ];
    const picks = new Set();
    for (let i = 0; i < 30; i++) {
      const p = pickAccount(accounts, { usedToday: new Set(), rng: () => i / 30 });
      picks.add(p.email);
    }
    expect(picks.size).toBeGreaterThan(1); // not always the same one
  });
});

describe('Phase 2.7 — redactEmail', () => {
  test('masks the local-part, keeps the domain', () => {
    expect(redactEmail('user@gmail.com')).toBe('use***@gmail.com');
    expect(redactEmail('longname@example.org')).toBe('lon***@example.org');
  });
  test('handles short local-parts', () => {
    expect(redactEmail('a@b.com')).toBe('a***@b.com');
  });
  test('returns null for falsy input', () => {
    expect(redactEmail(null)).toBeNull();
    expect(redactEmail('')).toBeNull();
  });
  test('handles strings with no @', () => {
    expect(redactEmail('noatsign')).toBe('***');
  });
});

describe('Phase 2.7 — accountWarmup (stub page)', () => {
  test('throws when email or password missing', async () => {
    await expect(accountWarmup({}, { email: '', password: '' })).rejects.toThrow(/email.*password/);
  });
  test('returns loggedIn:false when email input not found', async () => {
    const page = {
      goto: async () => {},
      url: () => 'https://accounts.google.com/signin',
      $: async () => null,
      keyboard: { type: async () => {}, press: async () => {} },
    };
    const r = await accountWarmup(page, {
      email: 'test@example.com',
      password: 'secret',
      logger: makeStubLogger(),
      sleepFn: noopSleep,
    });
    expect(r.loggedIn).toBe(false);
    expect(r.email).toBe('tes***@example.com'); // redacted
  });
  test('returns loggedIn:true when the URL changes away from /signin', async () => {
    const page = {
      _url: 'https://accounts.google.com/signin',
      goto: async (url) => { page._url = url; },
      url: () => page._url,
      $: async (sel) => {
        if (sel === 'input[type="email"]' || sel === 'input[type="password"]') {
          return { click: async () => {} };
        }
        return null;
      },
      keyboard: { type: async () => {}, press: async (key) => {
        if (key === 'Enter') {
          // Simulate the post-login redirect after the password Enter.
          if (page._url.includes('password') || page._url.includes('signin')) {
            page._url = 'https://myaccount.google.com';
          }
        }
      } },
    };
    const r = await accountWarmup(page, {
      email: 'test@example.com',
      password: 'secret',
      logger: makeStubLogger(),
      sleepFn: noopSleep,
      rng: () => 0.5,
    });
    expect(r.loggedIn).toBe(true);
    expect(r.email).toBe('tes***@example.com');
  });
  test('never logs the raw password', async () => {
    const logger = makeStubLogger();
    const page = {
      goto: async () => {},
      url: () => 'https://accounts.google.com/signin',
      $: async () => null,
      keyboard: { type: async () => {}, press: async () => {} },
    };
    await accountWarmup(page, {
      email: 'test@example.com',
      password: 'SUPERSECRETPASSWORD',
      logger,
      sleepFn: noopSleep,
    });
    const allLogs = JSON.stringify(logger._calls);
    expect(allLogs).not.toContain('SUPERSECRETPASSWORD');
  });
});

// ===========================================================================
// createRealContextFactory — production createContext
// ===========================================================================

describe('Phase 2.7 — createRealContextFactory', () => {
  test('calls browser.newContext + returns { context, page }', async () => {
    let newContextCalls = 0;
    let newPageCalls = 0;
    const browser = {
      newContext: async () => {
        newContextCalls++;
        return {
          setDefaultTimeout: () => {},
          newPage: async () => { newPageCalls++; return { _url: 'about:blank' }; },
        };
      },
    };
    const cfg = { viewportWidth: 1400, viewportHeight: 900, navTimeoutMs: 60000 };
    const factory = createRealContextFactory({ cfg, logger: makeStubLogger(), stealth: { enabled: false } });
    const r = await factory({ browser, fingerprint: null });
    expect(newContextCalls).toBe(1);
    expect(newPageCalls).toBe(1);
    expect(r.context).toBeDefined();
    expect(r.page).toBeDefined();
  });
  test('applies fingerprint context options when a fingerprint is provided', async () => {
    let contextOpts = null;
    const browser = {
      newContext: async (opts) => {
        contextOpts = opts;
        return { setDefaultTimeout: () => {}, newPage: async () => ({}) };
      },
    };
    const cfg = { viewportWidth: 1400, viewportHeight: 900, navTimeoutMs: 60000 };
    const factory = createRealContextFactory({ cfg, logger: makeStubLogger(), stealth: { enabled: false } });
    const fingerprint = {
      userAgent: 'Mozilla/5.0 Test',
      platform: 'Win32',
      viewport: { width: 1920, height: 1080 },
      timezone: 'America/New_York',
      locale: 'en-US',
      languages: ['en-US', 'en'],
    };
    await factory({ browser, fingerprint });
    // The fingerprint's viewport overrides cfg's.
    expect(contextOpts.viewport).toEqual({ width: 1920, height: 1080 });
    expect(contextOpts.userAgent).toBe('Mozilla/5.0 Test');
  });
  test('falls back to Phase 1 defaults when no fingerprint', async () => {
    let contextOpts = null;
    const browser = {
      newContext: async (opts) => {
        contextOpts = opts;
        return { setDefaultTimeout: () => {}, newPage: async () => ({}) };
      },
    };
    const cfg = { viewportWidth: 1400, viewportHeight: 900, navTimeoutMs: 60000 };
    const factory = createRealContextFactory({ cfg, logger: makeStubLogger(), stealth: { enabled: false } });
    await factory({ browser, fingerprint: null });
    expect(contextOpts.viewport).toEqual({ width: 1400, height: 900 });
    expect(contextOpts.locale).toBe('en-US');
    expect(contextOpts.timezoneId).toBe('America/Toronto');
  });
});

// ===========================================================================
// createSessionRecord + sessionInfoFor (helpers)
// ===========================================================================

describe('Phase 2.7 — createSessionRecord + sessionInfoFor', () => {
  test('createSessionRecord initializes fields', () => {
    const r = createSessionRecord({ id: 's1', createdAt: 1000, proxy: { id: 'p1' }, fingerprint: { userAgent: 'UA', platform: 'Win32' } });
    expect(r.id).toBe('s1');
    expect(r.createdAt).toBe(1000);
    expect(r.requestCount).toBe(0);
    expect(r.closedAt).toBeNull();
    expect(r.proxy.id).toBe('p1');
    expect(r.fingerprint.platform).toBe('Win32');
  });
  test('sessionInfoFor computes ageMs from the clock', () => {
    const rec = createSessionRecord({ id: 's1', createdAt: 1000 });
    const info = sessionInfoFor(rec, { clock: () => 3000 });
    expect(info.ageMs).toBe(2000);
    expect(info.id).toBe('s1');
  });
});
