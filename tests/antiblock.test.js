'use strict';

/**
 * tests/antiblock.test.js — Phase 1.8 unit tests for src/antiblock.js
 *
 * Coverage:
 *   1. pickUserAgent — returns a string from USER_AGENTS, respects rng
 *   2. randomInt — produces values within [min, max], handles min==max
 *   3. randomDelay — calls sleepFn with an in-range value, returns the delay
 *   4. humanType — types char-by-char, one typeFn call per char
 *   5. humanType — records per-key delays within [minMs, maxMs]
 *   6. humanType — empty/null text → 0 chars, no calls
 *   7. humanType — injectable typeFn/delayFn/sleepFn (no real waiting)
 *   8. RateLimiter — acquire under cap returns 0 wait
 *   9. RateLimiter — acquire over cap waits then succeeds
 *  10. RateLimiter — totalWaits increments on each block
 *  11. RateLimiter — invalid maxPerMin throws
 *  12. RateLimiter — inFlight reflects current window
 *  13. detectCaptchaInText — detects known phrases
 *  14. detectCaptchaInText — returns detected:false for normal text
 *  15. detectCaptchaInText — handles null/empty
 *  16. detectCaptcha — page-bound uses textFn
 *  17. detectCaptcha — swallows textFn errors (returns not-detected)
 *  18. isBlockStatus — 429/503 true, others false
 *  19. attachBlockWatcher — fires onBlocked for 429 from google.com
 *  20. attachBlockWatcher — ignores non-google URLs
 *  21. attachBlockWatcher — detach stops firing + returns count
 *  22. scroll.pickBatchDelay — randomized when min/max given
 *  23. scroll.pickBatchDelay — fixed when only batchDelayMs given
 *
 * Plus config tests for the new Phase 1.8 flags.
 *
 * Run: bun test tests/
 */

const {
  USER_AGENTS,
  pickUserAgent,
  randomInt,
  randomDelay,
  humanType,
  RateLimiter,
  CAPTCHA_INDICATORS,
  detectCaptchaInText,
  detectCaptcha,
  BLOCK_STATUSES,
  isBlockStatus,
  attachBlockWatcher,
} = require('../src/antiblock');
const { pickBatchDelay } = require('../src/scroll');
const { loadConfig, parseArgs, HELP_TEXT } = require('../src/config');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  const logs = { warn: [], debug: [], info: [], error: [] };
  return {
    warn: (m, c) => logs.warn.push({ m, c }),
    debug: (m, c) => logs.debug.push({ m, c }),
    info: (m, c) => logs.info.push({ m, c }),
    error: (m, c) => logs.error.push({ m, c }),
    _logs: logs,
  };
}

// Fake page with a stub keyboard for humanType tests
function makeFakePage() {
  const typed = [];
  return {
    keyboard: {
      type: async (ch) => {
        typed.push(ch);
      },
    },
    _typed: typed,
  };
}

// Recording sleep — records delays instead of actually waiting
function makeRecordingSleep() {
  const delays = [];
  return {
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    getDelays: () => delays,
  };
}

// Stub Response object for attachBlockWatcher tests
function makeFakeResponse(status, url) {
  return {
    status: () => status,
    url: () => url,
  };
}

// Fake page that emits 'response' events for attachBlockWatcher tests
function makeEventPage() {
  const handlers = [];
  return {
    on: (event, handler) => {
      if (event === 'response') handlers.push(handler);
    },
    off: (event, handler) => {
      if (event === 'response') {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
    },
    _emit: (response) => {
      // Call handlers snapshot to avoid mutation-during-iteration issues
      const snapshot = handlers.slice();
      return Promise.all(snapshot.map((h) => h(response)));
    },
  };
}

// ---------------------------------------------------------------------------
// pickUserAgent
// ---------------------------------------------------------------------------

describe('Phase 1.8 — pickUserAgent', () => {
  test('returns a string from USER_AGENTS', () => {
    const ua = pickUserAgent();
    expect(typeof ua).toBe('string');
    expect(USER_AGENTS).toContain(ua);
  });

  test('respects injectable rng (deterministic)', () => {
    // rng() = 0 → idx 0
    expect(pickUserAgent(() => 0)).toBe(USER_AGENTS[0]);
    // rng() = 0.999 → last index (clamped)
    const last = USER_AGENTS[USER_AGENTS.length - 1];
    expect(pickUserAgent(() => 0.999)).toBe(last);
  });

  test('USER_AGENTS has at least 6 entries (Windows/macOS/Linux variety)', () => {
    expect(USER_AGENTS.length).toBeGreaterThanOrEqual(6);
    const allChrome = USER_AGENTS.every((u) => u.includes('Chrome/'));
    expect(allChrome).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// randomInt
// ---------------------------------------------------------------------------

describe('Phase 1.8 — randomInt', () => {
  test('produces values within [min, max] over many draws', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 500; i++) {
      const v = randomInt(800, 2000);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThanOrEqual(800);
    expect(max).toBeLessThanOrEqual(2000);
  });

  test('handles min == max (returns that value)', () => {
    expect(randomInt(500, 500)).toBe(500);
  });

  test('handles swapped min/max (normalizes order)', () => {
    const v = randomInt(2000, 800);
    expect(v).toBeGreaterThanOrEqual(800);
    expect(v).toBeLessThanOrEqual(2000);
  });
});

// ---------------------------------------------------------------------------
// randomDelay
// ---------------------------------------------------------------------------

describe('Phase 1.8 — randomDelay', () => {
  test('calls sleepFn once with an in-range value', async () => {
    const rec = makeRecordingSleep();
    const delay = await randomDelay(500, 1500, { sleepFn: rec.sleep });
    expect(rec.getDelays()).toHaveLength(1);
    expect(rec.getDelays()[0]).toBe(delay);
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThanOrEqual(1500);
  });

  test('returns the chosen delay', async () => {
    const delay = await randomDelay(100, 100, { sleepFn: () => Promise.resolve() });
    expect(delay).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// humanType
// ---------------------------------------------------------------------------

describe('Phase 1.8 — humanType', () => {
  test('types char-by-char — one typeFn call per character', async () => {
    const page = makeFakePage();
    const typed = [];
    const result = await humanType(page, 'Cafe', {
      typeFn: (ch) => {
        typed.push(ch);
        return Promise.resolve();
      },
      sleepFn: () => Promise.resolve(),
      delayFn: () => 100,
    });
    expect(typed).toEqual(['C', 'a', 'f', 'e']);
    expect(result.chars).toBe(4);
    expect(result.delays).toHaveLength(4);
  });

  test('per-key delays within [minMs, maxMs]', async () => {
    const page = makeFakePage();
    const result = await humanType(page, 'hello world', {
      minMs: 50,
      maxMs: 150,
      typeFn: () => Promise.resolve(),
      sleepFn: () => Promise.resolve(),
    });
    for (const d of result.delays) {
      expect(d).toBeGreaterThanOrEqual(50);
      expect(d).toBeLessThanOrEqual(150);
    }
    expect(result.delays).toHaveLength(11);
  });

  test('empty/null text → 0 chars, no typeFn calls', async () => {
    const page = makeFakePage();
    let calls = 0;
    const r1 = await humanType(page, '', {
      typeFn: () => {
        calls++;
        return Promise.resolve();
      },
      sleepFn: () => Promise.resolve(),
    });
    expect(r1.chars).toBe(0);
    expect(calls).toBe(0);

    const r2 = await humanType(page, null, {
      typeFn: () => {
        calls++;
        return Promise.resolve();
      },
      sleepFn: () => Promise.resolve(),
    });
    expect(r2.chars).toBe(0);
    expect(calls).toBe(0);
  });

  test('uses default page.keyboard.type when typeFn not provided', async () => {
    const page = makeFakePage();
    const result = await humanType(page, 'AB', {
      sleepFn: () => Promise.resolve(),
      delayFn: () => 10,
    });
    expect(page._typed).toEqual(['A', 'B']);
    expect(result.chars).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

describe('Phase 1.8 — RateLimiter', () => {
  test('acquire under cap returns 0 wait', async () => {
    let now = 1000;
    const limiter = new RateLimiter(30, {
      nowFn: () => now,
      sleepFn: () => Promise.resolve(),
    });
    const wait = await limiter.acquire('req1');
    expect(wait).toBe(0);
    expect(limiter.inFlight).toBe(1);
  });

  test('acquire over cap waits then succeeds', async () => {
    // Simulate a clock that advances as sleeps resolve.
    let now = 1000;
    const sleepCalls = [];
    const limiter = new RateLimiter(2, {
      // window 1000ms for a fast test
      windowMs: 1000,
      nowFn: () => now,
      sleepFn: (ms) => {
        sleepCalls.push(ms);
        now += ms; // advance the clock by the slept amount
        return Promise.resolve();
      },
    });
    await limiter.acquire('a'); // t=1000, inFlight=1
    await limiter.acquire('b'); // t=1000, inFlight=2 (cap reached)
    // Third acquire must wait until the first timestamp (t=1000) ages out of
    // the 1000ms window → wait ~1ms (windowMs - (now - oldest) + 1 = 1000 - 0 + 1)
    const wait = await limiter.acquire('c');
    expect(wait).toBeGreaterThan(0);
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
    // After waiting, both a (t=1000) and b (t=1000) aged out of the 1000ms
    // window; only c (now advanced past the wait) remains.
    expect(limiter.inFlight).toBe(1);
  });

  test('totalWaits increments on each block', async () => {
    let now = 0;
    const limiter = new RateLimiter(1, {
      windowMs: 100,
      nowFn: () => now,
      sleepFn: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    await limiter.acquire('a');
    expect(limiter.totalWaits).toBe(0);
    await limiter.acquire('b'); // must wait
    expect(limiter.totalWaits).toBe(1);
  });

  test('invalid maxPerMin throws', () => {
    expect(() => new RateLimiter(0)).toThrow(/maxPerMin/);
    expect(() => new RateLimiter(-5)).toThrow(/maxPerMin/);
    expect(() => new RateLimiter(NaN)).toThrow(/maxPerMin/);
  });

  test('inFlight drops old timestamps after window expires', () => {
    let now = 1000;
    const limiter = new RateLimiter(10, {
      windowMs: 5000,
      nowFn: () => now,
    });
    limiter._timestamps.push(1000); // exactly at window edge later
    now = 7000; // 6000ms later → outside window
    expect(limiter.inFlight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectCaptchaInText / detectCaptcha
// ---------------------------------------------------------------------------

describe('Phase 1.8 — detectCaptchaInText', () => {
  test('detects "unusual traffic" phrase', () => {
    const r = detectCaptchaInText('Our systems have detected unusual traffic from your network');
    expect(r.detected).toBe(true);
    expect(r.indicator).toBeTruthy();
  });

  test('detects "captcha" substring', () => {
    const r = detectCaptchaInText('Please complete the CAPTCHA to continue');
    expect(r.detected).toBe(true);
  });

  test('detects "not a robot"', () => {
    const r = detectCaptchaInText("I'm not a robot checkbox");
    expect(r.detected).toBe(true);
  });

  test('detects recaptcha markers', () => {
    const r = detectCaptchaInText('<div class="g-recaptcha"></div>');
    expect(r.detected).toBe(true);
  });

  test('returns detected:false for normal results text', () => {
    const r = detectCaptchaInText('Restaurants in Toronto — 42 results found');
    expect(r.detected).toBe(false);
    expect(r.indicator).toBeNull();
  });

  test('handles null/empty/undefined', () => {
    expect(detectCaptchaInText(null).detected).toBe(false);
    expect(detectCaptchaInText('').detected).toBe(false);
    expect(detectCaptchaInText(undefined).detected).toBe(false);
  });

  test('case-insensitive matching', () => {
    const r = detectCaptchaInText('UNUSUAL TRAFFIC DETECTED');
    expect(r.detected).toBe(true);
  });

  test('CAPTCHA_INDICATORS is a non-empty array of strings', () => {
    expect(Array.isArray(CAPTCHA_INDICATORS)).toBe(true);
    expect(CAPTCHA_INDICATORS.length).toBeGreaterThan(3);
    for (const ind of CAPTCHA_INDICATORS) {
      expect(typeof ind).toBe('string');
    }
  });
});

describe('Phase 1.8 — detectCaptcha (page-bound)', () => {
  test('uses injectable textFn', async () => {
    const r = await detectCaptcha(
      {},
      { textFn: async () => 'Please verify you are not a robot' },
    );
    expect(r.detected).toBe(true);
  });

  test('returns not-detected when textFn yields normal text', async () => {
    const r = await detectCaptcha(
      {},
      { textFn: async () => 'Coffee Shop — 4.5 stars (120 reviews)' },
    );
    expect(r.detected).toBe(false);
  });

  test('swallows textFn errors (returns not-detected)', async () => {
    const r = await detectCaptcha(
      {},
      {
        textFn: async () => {
          throw new Error('execution context destroyed');
        },
      },
    );
    expect(r.detected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBlockStatus / BLOCK_STATUSES
// ---------------------------------------------------------------------------

describe('Phase 1.8 — isBlockStatus', () => {
  test('429 and 503 are block statuses', () => {
    expect(isBlockStatus(429)).toBe(true);
    expect(isBlockStatus(503)).toBe(true);
  });

  test('200/404/500 are NOT block statuses', () => {
    expect(isBlockStatus(200)).toBe(false);
    expect(isBlockStatus(404)).toBe(false);
    expect(isBlockStatus(500)).toBe(false);
  });

  test('BLOCK_STATUSES contains 429 and 503', () => {
    expect(BLOCK_STATUSES).toContain(429);
    expect(BLOCK_STATUSES).toContain(503);
  });
});

// ---------------------------------------------------------------------------
// attachBlockWatcher
// ---------------------------------------------------------------------------

describe('Phase 1.8 — attachBlockWatcher', () => {
  test('fires onBlocked for 429 from google.com', async () => {
    const page = makeEventPage();
    const blocked = [];
    const detach = attachBlockWatcher(page, {
      logger: makeLogger(),
      onBlocked: (info) => {
        blocked.push(info);
      },
    });
    await page._emit(makeFakeResponse(429, 'https://www.google.com/maps/foo'));
    expect(blocked).toHaveLength(1);
    expect(blocked[0].status).toBe(429);
    detach();
  });

  test('fires onBlocked for 503 too', async () => {
    const page = makeEventPage();
    const blocked = [];
    const detach = attachBlockWatcher(page, {
      onBlocked: (info) => blocked.push(info),
    });
    await page._emit(makeFakeResponse(503, 'https://maps.google.com/x'));
    expect(blocked).toHaveLength(1);
    detach();
  });

  test('ignores non-google URLs', async () => {
    const page = makeEventPage();
    const blocked = [];
    const detach = attachBlockWatcher(page, {
      onBlocked: (info) => blocked.push(info),
    });
    await page._emit(makeFakeResponse(429, 'https://example.com/foo'));
    expect(blocked).toHaveLength(0);
    detach();
  });

  test('ignores non-block statuses', async () => {
    const page = makeEventPage();
    const blocked = [];
    const detach = attachBlockWatcher(page, {
      onBlocked: (info) => blocked.push(info),
    });
    await page._emit(makeFakeResponse(200, 'https://www.google.com/maps'));
    await page._emit(makeFakeResponse(404, 'https://www.google.com/missing'));
    expect(blocked).toHaveLength(0);
    detach();
  });

  test('detach stops firing and returns blocked count', async () => {
    const page = makeEventPage();
    const blocked = [];
    const detach = attachBlockWatcher(page, {
      onBlocked: (info) => blocked.push(info),
    });
    await page._emit(makeFakeResponse(429, 'https://www.google.com/a'));
    const count = detach();
    await page._emit(makeFakeResponse(503, 'https://www.google.com/b'));
    expect(blocked).toHaveLength(1); // only the first one
    expect(count).toBe(1);
  });

  test('onBlocked errors do not crash the handler', async () => {
    const page = makeEventPage();
    const detach = attachBlockWatcher(page, {
      onBlocked: () => {
        throw new Error('listener bug');
      },
    });
    // Should not throw
    await page._emit(makeFakeResponse(429, 'https://www.google.com/x'));
    detach();
  });
});

// ---------------------------------------------------------------------------
// scroll.pickBatchDelay
// ---------------------------------------------------------------------------

describe('Phase 1.8 — scroll.pickBatchDelay', () => {
  test('randomized when batchDelayMinMs/MaxMs given', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 200; i++) {
      const v = pickBatchDelay({ batchDelayMs: 800, batchDelayMinMs: 800, batchDelayMaxMs: 2000 });
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(min).toBeGreaterThanOrEqual(800);
    expect(max).toBeLessThanOrEqual(2000);
  });

  test('fixed when only batchDelayMs given (legacy compat)', () => {
    const v = pickBatchDelay({ batchDelayMs: 800 });
    expect(v).toBe(800);
  });

  test('fixed when min/max are null', () => {
    const v = pickBatchDelay({ batchDelayMs: 500, batchDelayMinMs: null, batchDelayMaxMs: null });
    expect(v).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Config: Phase 1.8 flags
// ---------------------------------------------------------------------------

describe('Phase 1.8 — config flags', () => {
  test('--maxRPM sets antiblock.maxRequestsPerMin', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--maxRPM', '15',
    ]);
    expect(cfg.antiblock.maxRequestsPerMin).toBe(15);
  });

  test('--noHumanTyping sets antiblock.humanTyping false', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--noHumanTyping',
    ]);
    expect(cfg.antiblock.humanTyping).toBe(false);
  });

  test('--noCaptchaPause sets antiblock.captchaPause false', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--noCaptchaPause',
    ]);
    expect(cfg.antiblock.captchaPause).toBe(false);
  });

  test('--captchaWaitMs sets antiblock.captchaWaitMs', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--captchaWaitMs', '60000',
    ]);
    expect(cfg.antiblock.captchaWaitMs).toBe(60000);
  });

  test('defaults: maxRPM=30, humanTyping=true, captchaPause=true, captchaWaitMs=300000', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.antiblock.maxRequestsPerMin).toBe(30);
    expect(cfg.antiblock.humanTyping).toBe(true);
    expect(cfg.antiblock.captchaPause).toBe(true);
    expect(cfg.antiblock.captchaWaitMs).toBe(5 * 60 * 1000);
  });

  test('delay range defaults match spec', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.antiblock.scrollDelayMinMs).toBe(800);
    expect(cfg.antiblock.scrollDelayMaxMs).toBe(2000);
    expect(cfg.antiblock.detailDelayMinMs).toBe(1500);
    expect(cfg.antiblock.detailDelayMaxMs).toBe(3500);
    expect(cfg.antiblock.preEnterDelayMinMs).toBe(500);
    expect(cfg.antiblock.preEnterDelayMaxMs).toBe(1500);
    expect(cfg.antiblock.typeKeyMinMs).toBe(50);
    expect(cfg.antiblock.typeKeyMaxMs).toBe(150);
  });

  test('env var fallback: MAX_REQUESTS_PER_MIN', () => {
    process.env.MAX_REQUESTS_PER_MIN = '45';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.antiblock.maxRequestsPerMin).toBe(45);
    delete process.env.MAX_REQUESTS_PER_MIN;
  });

  test('env var fallback: HUMAN_TYPING=false disables', () => {
    process.env.HUMAN_TYPING = 'false';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.antiblock.humanTyping).toBe(false);
    delete process.env.HUMAN_TYPING;
  });

  test('env var fallback: CAPTCHA_PAUSE=false disables', () => {
    process.env.CAPTCHA_PAUSE = 'false';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.antiblock.captchaPause).toBe(false);
    delete process.env.CAPTCHA_PAUSE;
  });

  test('validation: maxRPM < 1 → error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--maxRPM', '0',
    ]);
    expect(cfg.errors.some((e) => e.includes('maxRPM'))).toBe(true);
  });

  test('validation: maxRPM > 600 → error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--maxRPM', '1000',
    ]);
    expect(cfg.errors.some((e) => e.includes('maxRPM'))).toBe(true);
  });

  test('validation: captchaWaitMs < 0 → error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--captchaWaitMs', '-1',
    ]);
    expect(cfg.errors.some((e) => e.includes('captchaWaitMs'))).toBe(true);
  });

  test('validation: valid antiblock config → no antiblock errors', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--maxRPM', '30',
      '--captchaWaitMs', '120000',
    ]);
    expect(cfg.errors.some((e) => e.includes('maxRPM'))).toBe(false);
    expect(cfg.errors.some((e) => e.includes('captchaWaitMs'))).toBe(false);
  });

  test('HELP_TEXT includes Phase 1.8 flags', () => {
    expect(HELP_TEXT).toContain('--maxRPM');
    expect(HELP_TEXT).toContain('--noHumanTyping');
    expect(HELP_TEXT).toContain('--noCaptchaPause');
    expect(HELP_TEXT).toContain('--captchaWaitMs');
    expect(HELP_TEXT).toContain('Phase 1.8');
  });

  test('parseArgs handles all Phase 1.8 flags', () => {
    const a = parseArgs([
      '--maxRPM', '20',
      '--noHumanTyping',
      '--noCaptchaPause',
      '--captchaWaitMs', '10000',
    ]);
    expect(a.maxRPM).toBe('20');
    expect(a.humanTyping).toBe(false);
    expect(a.captchaPause).toBe(false);
    expect(a.captchaWaitMs).toBe('10000');
  });
});
