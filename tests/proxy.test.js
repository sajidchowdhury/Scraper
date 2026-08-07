'use strict';

/**
 * tests/proxy.test.js — Phase 2.3 (Proxy Management & Rotation)
 *
 * Coverage (mapped to PHASE2_EXECUTION_PLAN.md acceptance criteria):
 *
 *  A. parseProxyLine (pure URL parsing)
 *     1.  protocol://user:pass@host:port
 *     2.  host:port:user:pass
 *     3.  host:port (no auth)
 *     4.  socks5:// scheme preserved
 *     5.  blank / comment lines → null
 *     6.  invalid port → null
 *
 *  B. Burn detector (pure logic)
 *     7.  record() tracks request/success counts
 *     8.  3 consecutive 403 → cooldown burn
 *     9.  3 consecutive 429 → cooldown burn
 *    10.  success rate < 50% over last 20 → cooldown burn (after min samples)
 *    11.  3 consecutive timeouts → cooldown burn
 *    12.  HTTP 407 → permanent burn
 *    13.  cooldown proxy recovers after cooldownMs
 *    14.  permanent proxy never recovers
 *    15.  isReusable() for unknown proxy → true
 *    16.  clear() resets a burned proxy
 *    17.  stats() returns null successRate for unseen proxy
 *    18.  markPermanent() via explicit call
 *
 *  C. Proxy pool — strategies
 *    19.  round-robin cycles through pool in order
 *    20.  random returns a proxy from the pool (with seeded rng, deterministic)
 *    21.  sticky keeps the same proxy for sessionLength requests
 *    22.  sticky rotates after sessionLength
 *    23.  5-proxy pool with sessionLength=1 → 5 acquires use 5 different proxies (round-robin)
 *
 *  D. Proxy pool — burn integration
 *    24.  release({success:false, statusCode:429}) × 3 → next acquire skips it
 *    25.  markBurned() removes from rotation
 *    26.  pool exhausted (all burned) → acquire returns null
 *    27.  cooldown proxy re-enters rotation after cooldownMs
 *    28.  stats() reports healthy/burned/avgSuccessRate correctly
 *
 *  E. Burn log writer
 *    29.  createBurnLogWriter appends JSONL events to disk
 *    30.  burn events include ts, proxyId, reason, kind
 *
 *  F. Health check (DI'd fetchFn — no real network)
 *    31.  healthCheck() with stubbed fetchFn → healthy + dead lists
 *    32.  failed proxies are benched (cooldown)
 *
 *  G. DI / no-network guarantees
 *    33.  createProxyPool accepts inline `list` source (no file I/O)
 *    34.  createProxyPool accepts injected `provider()` async fn
 *    35.  acquire() with empty pool returns null
 *
 *  H. Config integration
 *    36.  --noProxy sets cfg.proxy.enabled = false
 *    37.  --proxyListFile / PROXY_LIST_FILE enables the pool
 *    38.  invalid --proxyStrategy → config error
 *    39.  invalid --sessionLength → config error
 *    40.  non-existent --proxyListFile → config error
 *
 * Run: bun test tests/proxy.test.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  createProxyPool,
  parseProxyLine,
  createBurnLogWriter,
  STRATEGIES,
} = require('../src/proxy');
const { createBurnDetector } = require('../src/proxy/burn-detector');
const { loadConfig } = require('../src/config');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  const logs = { info: [], warn: [], error: [], debug: [] };
  return {
    info: (m, c) => logs.info.push({ m, c }),
    warn: (m, c) => logs.warn.push({ m, c }),
    error: (m, c) => logs.error.push({ m, c }),
    debug: (m, c) => logs.debug.push({ m, c }),
    phase: () => makeLogger(),
    _logs: logs,
  };
}

// Deterministic RNG that cycles through a fixed sequence.
function makeSeededRng(seq) {
  let i = 0;
  return () => {
    const v = seq[i % seq.length];
    i++;
    return v;
  };
}

// Injectable clock for burn-detector cooldown tests.
function makeClock(start = 1000000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function tmpFile(prefix = 'proxy-test') {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jsonl`,
  );
}

// ---------------------------------------------------------------------------
// A. parseProxyLine
// ---------------------------------------------------------------------------

describe('Phase 2.3 — parseProxyLine', () => {
  test('1. protocol://user:pass@host:port', () => {
    const p = parseProxyLine('http://alice:s3cret@1.2.3.4:8080');
    expect(p).not.toBe(null);
    expect(p.protocol).toBe('http');
    expect(p.host).toBe('1.2.3.4');
    expect(p.port).toBe(8080);
    expect(p.username).toBe('alice');
    expect(p.password).toBe('s3cret');
    expect(p.server).toBe('http://1.2.3.4:8080');
    expect(p.id).toBe('1.2.3.4:8080');
  });

  test('2. host:port:user:pass', () => {
    const p = parseProxyLine('1.2.3.4:8080:bob:pwd');
    expect(p).not.toBe(null);
    expect(p.host).toBe('1.2.3.4');
    expect(p.port).toBe(8080);
    expect(p.username).toBe('bob');
    expect(p.password).toBe('pwd');
  });

  test('3. host:port (no auth)', () => {
    const p = parseProxyLine('1.2.3.4:8080');
    expect(p).not.toBe(null);
    expect(p.host).toBe('1.2.3.4');
    expect(p.port).toBe(8080);
    expect(p.username).toBe(null);
    expect(p.password).toBe(null);
  });

  test('4. socks5:// scheme preserved', () => {
    const p = parseProxyLine('socks5://1.2.3.4:1080');
    expect(p).not.toBe(null);
    expect(p.protocol).toBe('socks5');
    expect(p.server).toBe('socks5://1.2.3.4:1080');
  });

  test('5. blank / comment lines → null', () => {
    expect(parseProxyLine('')).toBe(null);
    expect(parseProxyLine('   ')).toBe(null);
    expect(parseProxyLine('# this is a comment')).toBe(null);
  });

  test('6. invalid port → null', () => {
    expect(parseProxyLine('1.2.3.4:notaport')).toBe(null);
    expect(parseProxyLine('1.2.3.4:99999')).toBe(null);
    expect(parseProxyLine('1.2.3.4:0')).toBe(null);
    expect(parseProxyLine('1.2.3.4:-1')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// B. Burn detector
// ---------------------------------------------------------------------------

describe('Phase 2.3 — burn detector (pure logic)', () => {
  test('7. record() tracks request/success counts', () => {
    const d = createBurnDetector();
    d.record('p1', { success: true });
    d.record('p1', { success: true });
    d.record('p1', { success: false, statusCode: 500 });
    const s = d.stats('p1');
    expect(s.requestCount).toBe(3);
    expect(s.successCount).toBe(2);
    expect(s.consecutiveFails).toBe(1);
  });

  test('8. 3 consecutive 403 → cooldown burn', () => {
    const d = createBurnDetector();
    let r;
    r = d.record('p1', { success: false, statusCode: 403 });
    expect(r.burned).toBe(false);
    r = d.record('p1', { success: false, statusCode: 403 });
    expect(r.burned).toBe(false);
    r = d.record('p1', { success: false, statusCode: 403 });
    expect(r.burned).toBe(true);
    expect(r.kind).toBe('cooldown');
    expect(d.state('p1')).toBe('cooldown');
  });

  test('9. 3 consecutive 429 → cooldown burn', () => {
    const d = createBurnDetector();
    d.record('p1', { success: false, statusCode: 429 });
    d.record('p1', { success: false, statusCode: 429 });
    const r = d.record('p1', { success: false, statusCode: 429 });
    expect(r.burned).toBe(true);
    expect(r.kind).toBe('cooldown');
  });

  test('10. success rate < 50% over last 20 → cooldown burn (after min samples)', () => {
    const d = createBurnDetector({ minRateSamples: 5, rateWindow: 20, rateThreshold: 0.5 });
    // 5 requests, only 1 success (20% < 50%) → burn
    d.record('p1', { success: true, statusCode: 200 });
    let r;
    r = d.record('p1', { success: false, statusCode: 500 });
    r = d.record('p1', { success: false, statusCode: 500 });
    r = d.record('p1', { success: false, statusCode: 500 });
    r = d.record('p1', { success: false, statusCode: 500 });
    r = d.record('p1', { success: false, statusCode: 500 });
    expect(r.burned).toBe(true);
    expect(r.kind).toBe('cooldown');
    expect(d.state('p1')).toBe('cooldown');
  });

  test('11. 3 consecutive timeouts → cooldown burn', () => {
    const d = createBurnDetector();
    d.record('p1', { success: false, statusCode: 'TIMEOUT' });
    d.record('p1', { success: false, statusCode: 'TIMEOUT' });
    const r = d.record('p1', { success: false, statusCode: 'TIMEOUT' });
    expect(r.burned).toBe(true);
    expect(r.kind).toBe('cooldown');
  });

  test('12. HTTP 407 → permanent burn', () => {
    const d = createBurnDetector();
    const r = d.record('p1', { success: false, statusCode: 407 });
    expect(r.burned).toBe(true);
    expect(r.kind).toBe('permanent');
    expect(d.state('p1')).toBe('burned');
  });

  test('13. cooldown proxy recovers after cooldownMs', () => {
    const clock = makeClock(1000000);
    const d = createBurnDetector({ cooldownMs: 60000, now: clock.now });
    // Burn via 3x 403
    d.record('p1', { success: false, statusCode: 403 });
    d.record('p1', { success: false, statusCode: 403 });
    d.record('p1', { success: false, statusCode: 403 });
    expect(d.isReusable('p1')).toBe(false);
    expect(d.state('p1')).toBe('cooldown');
    // Advance time past cooldown window
    clock.advance(60001);
    expect(d.isReusable('p1')).toBe(true);
    expect(d.state('p1')).toBe('healthy');
  });

  test('14. permanent proxy never recovers', () => {
    const clock = makeClock(1000000);
    const d = createBurnDetector({ cooldownMs: 60000, now: clock.now });
    d.record('p1', { success: false, statusCode: 407 });
    expect(d.state('p1')).toBe('burned');
    expect(d.isReusable('p1')).toBe(false);
    clock.advance(999999999);
    expect(d.isReusable('p1')).toBe(false);
    expect(d.state('p1')).toBe('burned');
  });

  test('15. isReusable() for unknown proxy → true', () => {
    const d = createBurnDetector();
    expect(d.isReusable('never-seen')).toBe(true);
  });

  test('16. clear() resets a burned proxy', () => {
    const d = createBurnDetector();
    d.record('p1', { success: false, statusCode: 403 });
    d.record('p1', { success: false, statusCode: 403 });
    d.record('p1', { success: false, statusCode: 403 });
    expect(d.state('p1')).toBe('cooldown');
    d.clear('p1');
    expect(d.state('p1')).toBe('healthy');
    expect(d.isReusable('p1')).toBe(true);
  });

  test('17. stats() returns null successRate for unseen proxy', () => {
    const d = createBurnDetector();
    const s = d.stats('never-seen');
    expect(s.requestCount).toBe(0);
    expect(s.successRate).toBe(null);
    expect(s.state).toBe('healthy');
  });

  test('18. markPermanent() via explicit call', () => {
    const d = createBurnDetector();
    const r = d.markPermanent('p1', 'provider retired IP');
    expect(r.burned).toBe(true);
    expect(r.kind).toBe('permanent');
    expect(d.state('p1')).toBe('burned');
  });

  test('consecutive fails reset on success', () => {
    // Disable rate-based burn (rateThreshold=0) so we isolate the consecutive
    // rule. With the default rate rule, 3 fails out of 5 requests would also
    // trigger a burn — but that's a separate mechanism tested elsewhere.
    const d = createBurnDetector({ rateThreshold: 0 });
    d.record('p1', { success: false, statusCode: 403 });
    d.record('p1', { success: false, statusCode: 403 });
    d.record('p1', { success: true, statusCode: 200 });
    expect(d.stats('p1').consecutiveFails).toBe(0);
    // Now 2 more 403s should NOT burn (need 3 consecutive)
    d.record('p1', { success: false, statusCode: 403 });
    d.record('p1', { success: false, statusCode: 403 });
    expect(d.state('p1')).toBe('healthy');
  });

  test('cooldown proxy: success on reuse clears burn state', () => {
    const clock = makeClock(1000000);
    const d = createBurnDetector({ cooldownMs: 1000, now: clock.now });
    d.record('p1', { success: false, statusCode: 403 });
    d.record('p1', { success: false, statusCode: 403 });
    d.record('p1', { success: false, statusCode: 403 });
    expect(d.state('p1')).toBe('cooldown');
    // Reuse after cooldown
    clock.advance(1001);
    expect(d.isReusable('p1')).toBe(true);
    // Successful release → state flips back to healthy
    const r = d.record('p1', { success: true, statusCode: 200 });
    expect(r.burned).toBe(false);
    expect(d.state('p1')).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// C. Proxy pool — strategies
// ---------------------------------------------------------------------------

describe('Phase 2.3 — proxy pool strategies', () => {
  function makePool(strategy, opts = {}) {
    return createProxyPool({
      sources: {
        list: [
          'http://1.1.1.1:80',
          'http://2.2.2.2:80',
          'http://3.3.3.3:80',
          'http://4.4.4.4:80',
          'http://5.5.5.5:80',
        ],
      },
      strategy,
      sessionLength: opts.sessionLength || 1,
      cooldownMs: 60000,
      logger: makeLogger(),
      burnLogWriter: { append: () => {} }, // no-op
      ...opts,
    });
  }

  test('19. round-robin cycles through pool in order', async () => {
    const pool = makePool('round-robin');
    const a1 = await pool.acquire();
    const a2 = await pool.acquire();
    const a3 = await pool.acquire();
    expect(a1.id).toBe('1.1.1.1:80');
    expect(a2.id).toBe('2.2.2.2:80');
    expect(a3.id).toBe('3.3.3.3:80');
  });

  test('20. random returns a proxy from the pool (seeded rng, deterministic)', async () => {
    const rng = makeSeededRng([0.0, 0.5, 0.9]);
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80', 'http://2.2.2.2:80', 'http://3.3.3.3:80'] },
      strategy: 'random',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
      rng,
    });
    const a1 = await pool.acquire();
    const a2 = await pool.acquire();
    const a3 = await pool.acquire();
    // rng 0.0 → idx 0, 0.5 → idx 1, 0.9 → idx 2
    expect(a1.id).toBe('1.1.1.1:80');
    expect(a2.id).toBe('2.2.2.2:80');
    expect(a3.id).toBe('3.3.3.3:80');
  });

  test('21. sticky keeps the same proxy for sessionLength requests', async () => {
    const rng = makeSeededRng([0.5]); // picks index 2 of 5
    const pool = createProxyPool({
      sources: {
        list: [
          'http://1.1.1.1:80',
          'http://2.2.2.2:80',
          'http://3.3.3.3:80',
          'http://4.4.4.4:80',
          'http://5.5.5.5:80',
        ],
      },
      strategy: 'sticky',
      sessionLength: 3,
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
      rng,
    });
    const a1 = await pool.acquire();
    const a2 = await pool.acquire();
    const a3 = await pool.acquire();
    expect(a1.id).toBe(a2.id);
    expect(a2.id).toBe(a3.id);
  });

  test('22. sticky rotates after sessionLength', async () => {
    const rng = makeSeededRng([0.0, 0.9]); // first session: idx 0, second: idx 4
    const pool = createProxyPool({
      sources: {
        list: [
          'http://1.1.1.1:80',
          'http://2.2.2.2:80',
          'http://3.3.3.3:80',
          'http://4.4.4.4:80',
          'http://5.5.5.5:80',
        ],
      },
      strategy: 'sticky',
      sessionLength: 2,
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
      rng,
    });
    const a1 = await pool.acquire();
    const a2 = await pool.acquire();
    const a3 = await pool.acquire();
    expect(a1.id).toBe(a2.id); // first session (2 requests)
    expect(a3.id).not.toBe(a1.id); // rotated
  });

  test('23. 5-proxy pool with sessionLength=1 → 5 acquires use 5 different proxies (round-robin)', async () => {
    const pool = makePool('round-robin', { sessionLength: 1 });
    const ids = new Set();
    for (let i = 0; i < 5; i++) {
      const p = await pool.acquire();
      ids.add(p.id);
    }
    expect(ids.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// D. Proxy pool — burn integration
// ---------------------------------------------------------------------------

describe('Phase 2.3 — proxy pool burn integration', () => {
  test('24. release({success:false, statusCode:429}) × 3 → next acquire skips it', async () => {
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80', 'http://2.2.2.2:80'] },
      strategy: 'round-robin',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    const p1 = await pool.acquire(); // 1.1.1.1
    pool.release(p1.id, { success: false, statusCode: 429 });
    pool.release(p1.id, { success: false, statusCode: 429 });
    pool.release(p1.id, { success: false, statusCode: 429 });
    // Now 1.1.1.1 is burned. Next acquire should return 2.2.2.2 (the only healthy one).
    const p2 = await pool.acquire();
    expect(p2.id).toBe('2.2.2.2:80');
  });

  test('25. markBurned() removes from rotation', async () => {
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80', 'http://2.2.2.2:80'] },
      strategy: 'round-robin',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    pool.markBurned('1.1.1.1:80', 'manual test burn');
    const p = await pool.acquire();
    expect(p.id).toBe('2.2.2.2:80');
  });

  test('26. pool exhausted (all burned) → acquire returns null', async () => {
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80', 'http://2.2.2.2:80'] },
      strategy: 'round-robin',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    pool.markBurned('1.1.1.1:80', 'reason1', { permanent: true });
    pool.markBurned('2.2.2.2:80', 'reason2', { permanent: true });
    const p = await pool.acquire();
    expect(p).toBe(null);
  });

  test('27. cooldown proxy re-enters rotation after cooldownMs', async () => {
    const clock = makeClock(1000000);
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80', 'http://2.2.2.2:80'] },
      strategy: 'round-robin',
      cooldownMs: 1000,
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
      now: clock.now,
    });
    // Burn 1.1.1.1 via 3x 429
    pool.release('1.1.1.1:80', { success: false, statusCode: 429 });
    pool.release('1.1.1.1:80', { success: false, statusCode: 429 });
    pool.release('1.1.1.1:80', { success: false, statusCode: 429 });
    // Before cooldown: only 2.2.2.2 is healthy.
    expect(pool.stats().healthy).toBe(1);
    expect(pool.stats().cooldown).toBe(1);
    // Advance past cooldown
    clock.advance(1001);
    // After cooldown: 1.1.1.1 is healthy again. Acquire multiple times to
    // confirm it re-enters rotation (round-robin may return 2.2.2.2 first
    // depending on cursor position, but 1.1.1.1 must be available).
    expect(pool.stats().healthy).toBe(2);
    const seen = new Set();
    for (let i = 0; i < 4; i++) {
      const p = await pool.acquire();
      seen.add(p.id);
    }
    expect(seen.has('1.1.1.1:80')).toBe(true);
  });

  test('28. stats() reports healthy/burned/avgSuccessRate correctly', async () => {
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80', 'http://2.2.2.2:80', 'http://3.3.3.3:80'] },
      strategy: 'round-robin',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    pool.release('1.1.1.1:80', { success: true });
    pool.release('1.1.1.1:80', { success: true });
    pool.release('2.2.2.2:80', { success: false, statusCode: 500 });
    pool.markBurned('3.3.3.3:80', 'manual', { permanent: true });
    const s = pool.stats();
    expect(s.total).toBe(3);
    expect(s.burned).toBe(1); // 3.3.3.3 permanent
    expect(s.healthy).toBe(2); // 1.1.1.1 + 2.2.2.2
    expect(s.totalRequests).toBe(3);
    expect(s.totalSuccess).toBe(2);
    expect(Math.round(s.avgSuccessRate * 100)).toBe(67);
  });
});

// ---------------------------------------------------------------------------
// E. Burn log writer
// ---------------------------------------------------------------------------

describe('Phase 2.3 — burn log writer', () => {
  test('29. createBurnLogWriter appends JSONL events to disk', () => {
    const file = tmpFile('burn-log');
    const writer = createBurnLogWriter(file, makeLogger());
    writer.append({ kind: 'cooldown', proxyId: '1.1.1.1:80', reason: 'test' });
    writer.append({ kind: 'permanent', proxyId: '2.2.2.2:80', reason: 'auth fail' });
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
    const e1 = JSON.parse(lines[0]);
    expect(e1.kind).toBe('cooldown');
    expect(e1.proxyId).toBe('1.1.1.1:80');
    expect(e1.ts).toBeDefined();
    const e2 = JSON.parse(lines[1]);
    expect(e2.kind).toBe('permanent');
    expect(e2.proxyId).toBe('2.2.2.2:80');
    fs.unlinkSync(file);
  });

  test('30. burn events include ts, proxyId, reason, kind', () => {
    const file = tmpFile('burn-log');
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80'] },
      strategy: 'round-robin',
      logger: makeLogger(),
      burnLogPath: file,
    });
    pool.release('1.1.1.1:80', { success: false, statusCode: 403 });
    pool.release('1.1.1.1:80', { success: false, statusCode: 403 });
    pool.release('1.1.1.1:80', { success: false, statusCode: 403 });
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);
    const evt = JSON.parse(lines[0]);
    expect(evt.ts).toBeDefined();
    expect(evt.proxyId).toBe('1.1.1.1:80');
    expect(evt.reason).toMatch(/consecutive 403\/429/);
    expect(evt.kind).toBe('cooldown');
    fs.unlinkSync(file);
  });
});

// ---------------------------------------------------------------------------
// F. Health check (DI'd fetchFn — no real network)
// ---------------------------------------------------------------------------

describe('Phase 2.3 — health check (no real network)', () => {
  test('31. healthCheck() with stubbed fetchFn → healthy + dead lists', async () => {
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80', 'http://2.2.2.2:80', 'http://3.3.3.3:80'] },
      strategy: 'random',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    // Stub fetchFn: 1.1.1.1 + 2.2.2.2 are healthy, 3.3.3.3 is dead.
    const fetchFn = async (url, opts) => {
      if (opts.proxy.host === '3.3.3.3') {
        return { ok: false, status: 502, error: 'Bad Gateway' };
      }
      return { ok: true, status: 200, error: null };
    };
    const result = await pool.healthCheck({ fetchFn });
    expect(result.total).toBe(3);
    expect(result.healthy.length).toBe(2);
    expect(result.dead.length).toBe(1);
    expect(result.dead[0]).toBe('3.3.3.3:80');
  });

  test('32. failed proxies are benched (cooldown)', async () => {
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80', 'http://2.2.2.2:80'] },
      strategy: 'round-robin',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    const fetchFn = async (url, opts) => {
      if (opts.proxy.host === '1.1.1.1') {
        return { ok: false, status: 0, error: 'timeout' };
      }
      return { ok: true, status: 200, error: null };
    };
    await pool.healthCheck({ fetchFn });
    // 1.1.1.1 should now be in cooldown → next acquire returns 2.2.2.2
    const p = await pool.acquire();
    expect(p.id).toBe('2.2.2.2:80');
  });
});

// ---------------------------------------------------------------------------
// G. DI / no-network guarantees
// ---------------------------------------------------------------------------

describe('Phase 2.3 — DI / no-network guarantees', () => {
  test('33. createProxyPool accepts inline `list` source (no file I/O)', async () => {
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80'] },
      strategy: 'random',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    const p = await pool.acquire();
    expect(p.id).toBe('1.1.1.1:80');
  });

  test('34. createProxyPool accepts injected `provider()` async fn', async () => {
    const pool = createProxyPool({
      sources: {
        provider: async () => ['http://10.0.0.1:80', 'http://10.0.0.2:80'],
      },
      strategy: 'round-robin',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    const p1 = await pool.acquire();
    const p2 = await pool.acquire();
    expect(p1.id).toBe('10.0.0.1:80');
    expect(p2.id).toBe('10.0.0.2:80');
    expect(p1.provider).toBe('provider');
  });

  test('35. acquire() with empty pool returns null', async () => {
    const pool = createProxyPool({
      sources: { list: [] },
      strategy: 'random',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    const p = await pool.acquire();
    expect(p).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// H. Config integration
// ---------------------------------------------------------------------------

describe('Phase 2.3 — config integration', () => {
  test('36. --noProxy sets cfg.proxy.enabled = false', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--noProxy',
      '--proxyListFile', '/tmp/whatever',
    ]);
    // --noProxy overrides everything → enabled = false even though a list file was given.
    expect(cfg.proxy.enabled).toBe(false);
  });

  test('37. --proxyListFile enables the pool (when file exists)', () => {
    // Create a temp proxy list file so the existence check passes.
    const file = tmpFile('proxy-list');
    fs.writeFileSync(file, 'http://1.1.1.1:80\nhttp://2.2.2.2:80\n');
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--proxyListFile', file,
    ]);
    expect(cfg.proxy.enabled).toBe(true);
    expect(cfg.proxy.listFile).toBe(file);
    fs.unlinkSync(file);
  });

  test('38. invalid --proxyStrategy → config error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--proxyListFile', '/dev/null',
      '--proxyStrategy', 'invalid-strategy',
    ]);
    expect(cfg.errors.some((e) => e.includes('proxyStrategy'))).toBe(true);
  });

  test('39. invalid --sessionLength → config error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--proxyListFile', '/dev/null',
      '--sessionLength', '0',
    ]);
    expect(cfg.errors.some((e) => e.includes('sessionLength'))).toBe(true);
  });

  test('40. non-existent --proxyListFile → config error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--proxyListFile', '/this/path/does/not/exist.txt',
    ]);
    expect(cfg.errors.some((e) => e.includes('proxyListFile'))).toBe(true);
    // enabled stays false because the existence check in loadConfig already failed
    // (we surface the error rather than crashing at runtime)
  });

  test('default proxy config (no flags) → disabled', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.proxy.enabled).toBe(false);
    expect(cfg.proxy.strategy).toBe('random');
    expect(cfg.proxy.sessionLength).toBe(1);
    expect(cfg.proxy.cooldownMs).toBe(600000);
  });

  test('PROXY_LIST_FILE env var enables the pool', () => {
    const file = tmpFile('proxy-list');
    fs.writeFileSync(file, 'http://1.1.1.1:80\n');
    process.env.PROXY_LIST_FILE = file;
    try {
      const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
      expect(cfg.proxy.enabled).toBe(true);
      expect(cfg.proxy.listFile).toBe(file);
    } finally {
      delete process.env.PROXY_LIST_FILE;
      fs.unlinkSync(file);
    }
  });

  test('PROXY_STRATEGY env var sets the strategy', () => {
    process.env.PROXY_STRATEGY = 'sticky';
    try {
      const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
      expect(cfg.proxy.strategy).toBe('sticky');
    } finally {
      delete process.env.PROXY_STRATEGY;
    }
  });
});

// ---------------------------------------------------------------------------
// I. Acceptance criteria from PHASE2_EXECUTION_PLAN.md
// ---------------------------------------------------------------------------

describe('Phase 2.3 — acceptance criteria (spec)', () => {
  test('AC1: 5-proxy pool, --sessionLength 1, 5 launches use 5 different proxies', async () => {
    const pool = createProxyPool({
      sources: {
        list: [
          'http://1.1.1.1:80',
          'http://2.2.2.2:80',
          'http://3.3.3.3:80',
          'http://4.4.4.4:80',
          'http://5.5.5.5:80',
        ],
      },
      strategy: 'round-robin',
      sessionLength: 1,
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    const ids = new Set();
    for (let i = 0; i < 5; i++) {
      const p = await pool.acquire();
      ids.add(p.id);
      pool.release(p.id, { success: true });
    }
    expect(ids.size).toBe(5);
  });

  test('AC2: 3× 403 from a proxy marks it burned; subsequent acquire() skips it', async () => {
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80', 'http://2.2.2.2:80'] },
      strategy: 'round-robin',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    pool.release('1.1.1.1:80', { success: false, statusCode: 403 });
    pool.release('1.1.1.1:80', { success: false, statusCode: 403 });
    pool.release('1.1.1.1:80', { success: false, statusCode: 403 });
    const next = await pool.acquire();
    expect(next.id).not.toBe('1.1.1.1:80');
  });

  test('AC3: after cooldown, proxy re-enters rotation', async () => {
    const clock = makeClock(1000000);
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80', 'http://2.2.2.2:80'] },
      strategy: 'round-robin',
      cooldownMs: 5000,
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
      now: clock.now,
    });
    pool.release('1.1.1.1:80', { success: false, statusCode: 429 });
    pool.release('1.1.1.1:80', { success: false, statusCode: 429 });
    pool.release('1.1.1.1:80', { success: false, statusCode: 429 });
    expect(pool.stats().healthy).toBe(1);
    clock.advance(5001);
    expect(pool.stats().healthy).toBe(2);
  });

  test('AC4: pool.stats() accurately reports healthy/burned counts', async () => {
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80', 'http://2.2.2.2:80', 'http://3.3.3.3:80'] },
      strategy: 'round-robin',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    pool.markBurned('1.1.1.1:80', 'test', { permanent: true });
    const s = pool.stats();
    expect(s.total).toBe(3);
    expect(s.healthy).toBe(2);
    expect(s.burned).toBe(1);
  });

  test('AC5: --noProxy falls back to direct-connection behavior', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--noProxy',
      '--proxyListFile', '/dev/null',
    ]);
    expect(cfg.proxy.enabled).toBe(false);
  });

  test('AC6: burn log captures every event with enough detail to dispute charges', () => {
    const file = tmpFile('burn-log');
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80'] },
      strategy: 'random',
      logger: makeLogger(),
      burnLogPath: file,
    });
    // Burn via 407 (permanent)
    pool.release('1.1.1.1:80', { success: false, statusCode: 407 });
    const content = fs.readFileSync(file, 'utf8');
    const evt = JSON.parse(content.trim());
    expect(evt.proxyId).toBe('1.1.1.1:80');
    expect(evt.kind).toBe('permanent');
    expect(evt.reason).toMatch(/407/);
    expect(evt.ts).toBeDefined();
    expect(evt.recentStatusCodes).toBeDefined();
    fs.unlinkSync(file);
  });

  test('AC7: no unit test makes a real network call (healthCheck uses DI)', async () => {
    // This test itself is the assertion: if a real network call were made,
    // it would either fail (no network) or hit Google. We use a stub that
    // records calls instead.
    const calls = [];
    const fetchFn = async (url, opts) => {
      calls.push({ url, proxy: opts.proxy.id });
      return { ok: true, status: 200, error: null };
    };
    const pool = createProxyPool({
      sources: { list: ['http://1.1.1.1:80'] },
      strategy: 'random',
      logger: makeLogger(),
      burnLogWriter: { append: () => {} },
    });
    await pool.healthCheck({ fetchFn });
    expect(calls.length).toBe(1);
    expect(calls[0].proxy).toBe('1.1.1.1:80');
  });
});
