'use strict';

/**
 * tests/banner.test.js — Phase 1.10 unit tests for src/banner.js
 *
 * Coverage:
 *   1. buildStartupBanner — pure string output, no side effects
 *      - includes name + version header
 *      - includes all key resolved-config rows
 *      - formats booleans as yes/no, null as —
 *      - deep-scrape row includes sample step when enabled
 *      - hint line reflects delayed vs --yes
 *   2. showStartupBanner — side effects (stdout + sleep)
 *      - writes the banner to `out`
 *      - calls sleep(delayMs) when not --yes
 *      - skips sleep when cfg.yes = true
 *      - skips sleep when delayMs = 0
 *      - returns { delayed, delayMs, banner }
 *      - uses injected sleep (no real timer)
 *   3. fmt helper — booleans / null / numbers / strings
 *   4. DEFAULT_DELAY_MS === 1000
 *
 * Plus config tests for the new Phase 1.10 flag (--yes / -y).
 *
 * Run: bun test tests/
 */

const {
  buildStartupBanner,
  showStartupBanner,
  defaultSleep,
  fmt,
  DEFAULT_DELAY_MS,
} = require('../src/banner');
const { loadConfig, parseArgs, HELP_TEXT } = require('../src/config');

// A minimal writable-stream stub: collects all .write() calls into an array.
function makeFakeOut() {
  const chunks = [];
  return {
    write: (s) => {
      chunks.push(s);
      return true;
    },
    chunks,
    get text() {
      return chunks.join('');
    },
  };
}

// A sleep stub that records the requested delay instead of waiting.
function makeFakeSleep() {
  const calls = [];
  const fakeSleep = (ms) => {
    calls.push(ms);
    return Promise.resolve();
  };
  fakeSleep.calls = calls;
  return fakeSleep;
}

function baseCfg(overrides = {}) {
  return {
    query: 'Cafe',
    location: 'Berlin',
    maxResults: 50,
    outputDir: './data',
    outputFile: null,
    dryRun: false,
    headless: true,
    logLevel: 'info',
    deepScrape: false,
    detail: { sampleStep: 1 },
    resume: false,
    fresh: false,
    checkpointInterval: 10,
    retry: { attempts: 3, baseMs: 1000 },
    antiblock: {
      maxRequestsPerMin: 30,
      humanTyping: true,
      captchaPause: true,
      captchaWaitMs: 300000,
    },
    yes: false,
    ...overrides,
  };
}

describe('Phase 1.10 — buildStartupBanner (pure)', () => {
  test('includes name + version header', () => {
    const banner = buildStartupBanner(baseCfg(), { name: 'gmaps-scraper', version: '0.10.0' });
    expect(banner).toContain('gmaps-scraper');
    expect(banner).toContain('v0.10.0');
  });

  test('includes the resolved query + location', () => {
    const banner = buildStartupBanner(baseCfg({ query: 'Plumber', location: 'Dhaka, Bangladesh' }));
    expect(banner).toContain('Plumber');
    expect(banner).toContain('Dhaka, Bangladesh');
  });

  test('includes all key resolved-config rows', () => {
    const banner = buildStartupBanner(baseCfg());
    const expectedKeys = [
      'Query',
      'Location',
      'Max results',
      'Output dir',
      'Output file',
      'Dry run',
      'Headless',
      'Log level',
      'Deep scrape',
      'Resume',
      'Fresh',
      'Checkpoint every',
      'Retry',
      'Max RPM',
      'Human typing',
      'CAPTCHA pause',
    ];
    for (const k of expectedKeys) {
      expect(banner).toContain(k);
    }
  });

  test('formats booleans as yes/no and null output file as (auto)', () => {
    const banner = buildStartupBanner(baseCfg({ dryRun: true, headless: false, resume: true }));
    expect(banner).toMatch(/Dry run\s+yes/);
    expect(banner).toMatch(/Headless\s+no/);
    expect(banner).toMatch(/Resume\s+yes/);
    expect(banner).toMatch(/Output file\s+\(auto\)/);
  });

  test('max results "all" when null', () => {
    const banner = buildStartupBanner(baseCfg({ maxResults: null }));
    expect(banner).toMatch(/Max results\s+all/);
  });

  test('max results shows the integer when set', () => {
    const banner = buildStartupBanner(baseCfg({ maxResults: 250 }));
    expect(banner).toMatch(/Max results\s+250/);
  });

  test('deep-scrape row includes sample step when enabled', () => {
    const banner = buildStartupBanner(baseCfg({ deepScrape: true, detail: { sampleStep: 5 } }));
    expect(banner).toMatch(/Deep scrape\s+yes \(sample step 5\)/);
  });

  test('deep-scrape row shows no when disabled', () => {
    const banner = buildStartupBanner(baseCfg({ deepScrape: false }));
    expect(banner).toMatch(/Deep scrape\s+no/);
  });

  test('retry row shows attempts + base ms', () => {
    const banner = buildStartupBanner(baseCfg({ retry: { attempts: 5, baseMs: 2000 } }));
    expect(banner).toMatch(/Retry\s+5. \(base 2000ms\)/);
  });

  test('CAPTCHA pause row shows wait ms when on', () => {
    const banner = buildStartupBanner(baseCfg());
    expect(banner).toMatch(/CAPTCHA pause\s+yes \(300000ms\)/);
  });

  test('CAPTCHA pause row shows no when off', () => {
    const banner = buildStartupBanner(baseCfg({ antiblock: { ...baseCfg().antiblock, captchaPause: false } }));
    expect(banner).toMatch(/CAPTCHA pause\s+no/);
  });

  test('hint line shows delay duration when delayed', () => {
    const banner = buildStartupBanner(baseCfg(), { delayMs: 1000, delayed: true });
    expect(banner).toContain('Starting in 1.0s');
    expect(banner).toContain('Ctrl-C to abort');
    expect(banner).toContain('--yes to skip');
  });

  test('hint line says immediate when not delayed (--yes)', () => {
    const banner = buildStartupBanner(baseCfg(), { delayed: false });
    expect(banner).toContain('Starting immediately (--yes)');
    expect(banner).not.toContain('Ctrl-C to abort');
  });

  test('hint line respects custom delayMs', () => {
    const banner = buildStartupBanner(baseCfg(), { delayMs: 2500, delayed: true });
    expect(banner).toContain('Starting in 2.5s');
  });

  test('is a pure function — no stdout writes (does not throw when called)', () => {
    const spy = makeFakeOut();
    // Sneak the spy in via process.stdout monkey-patch to assert NO write happened.
    const orig = process.stdout.write.bind(process.stdout);
    let wrote = false;
    process.stdout.write = () => {
      wrote = true;
      return true;
    };
    try {
      const banner = buildStartupBanner(baseCfg());
      expect(typeof banner).toBe('string');
      expect(banner.length).toBeGreaterThan(0);
      expect(wrote).toBe(false);
    } finally {
      process.stdout.write = orig;
    }
    void spy; // unused — kept for clarity
  });
});

describe('Phase 1.10 — showStartupBanner (side effects)', () => {
  test('writes the banner to out', async () => {
    const out = makeFakeOut();
    const sleep = makeFakeSleep();
    const res = await showStartupBanner(baseCfg(), {
      out,
      sleep,
      name: 'gmaps-scraper',
      version: '0.10.0',
    });
    expect(out.text).toContain('gmaps-scraper');
    expect(out.text).toContain('v0.10.0');
    expect(out.text).toContain('Cafe');
    expect(out.text).toContain('Berlin');
    expect(out.text.endsWith('\n')).toBe(true);
    expect(res.banner).toContain('gmaps-scraper');
  });

  test('calls sleep(1000) when not --yes (default delay)', async () => {
    const out = makeFakeOut();
    const sleep = makeFakeSleep();
    const res = await showStartupBanner(baseCfg({ yes: false }), { out, sleep });
    expect(sleep.calls).toEqual([1000]);
    expect(res.delayed).toBe(true);
    expect(res.delayMs).toBe(1000);
  });

  test('skips sleep when cfg.yes = true', async () => {
    const out = makeFakeOut();
    const sleep = makeFakeSleep();
    const res = await showStartupBanner(baseCfg({ yes: true }), { out, sleep });
    expect(sleep.calls).toEqual([]);
    expect(res.delayed).toBe(false);
    expect(res.delayMs).toBe(0);
    // Banner still printed.
    expect(out.text).toContain('gmaps-scraper');
    expect(out.text).toContain('Starting immediately (--yes)');
  });

  test('skips sleep when delayMs = 0', async () => {
    const out = makeFakeOut();
    const sleep = makeFakeSleep();
    const res = await showStartupBanner(baseCfg({ yes: false }), { out, sleep, delayMs: 0 });
    expect(sleep.calls).toEqual([]);
    expect(res.delayed).toBe(false);
    expect(res.delayMs).toBe(0);
  });

  test('respects custom delayMs', async () => {
    const out = makeFakeOut();
    const sleep = makeFakeSleep();
    const res = await showStartupBanner(baseCfg({ yes: false }), { out, sleep, delayMs: 500 });
    expect(sleep.calls).toEqual([500]);
    expect(res.delayed).toBe(true);
    expect(res.delayMs).toBe(500);
    expect(out.text).toContain('Starting in 0.5s');
  });

  test('returns { delayed, delayMs, banner }', async () => {
    const out = makeFakeOut();
    const sleep = makeFakeSleep();
    const res = await showStartupBanner(baseCfg(), { out, sleep });
    expect(res).toHaveProperty('delayed');
    expect(res).toHaveProperty('delayMs');
    expect(res).toHaveProperty('banner');
    expect(typeof res.banner).toBe('string');
  });

  test('--yes still prints the banner but with the immediate hint', async () => {
    const out = makeFakeOut();
    const sleep = makeFakeSleep();
    await showStartupBanner(baseCfg({ yes: true }), { out, sleep });
    expect(out.text).toContain('gmaps-scraper');
    expect(out.text).toContain('Query');
    expect(out.text).toContain('Location');
    expect(out.text).toContain('Starting immediately (--yes)');
  });

  test('default sleep is a real promise-based delay (smoke)', async () => {
    // Don't actually wait 1000ms — just confirm defaultSleep returns a promise
    // and resolves. Use a tiny delay.
    const start = Date.now();
    await defaultSleep(5);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(3);
  });
});

describe('Phase 1.10 — fmt helper', () => {
  test('true → "yes"', () => {
    expect(fmt(true)).toBe('yes');
  });
  test('false → "no"', () => {
    expect(fmt(false)).toBe('no');
  });
  test('null → "—"', () => {
    expect(fmt(null)).toBe('—');
  });
  test('undefined → "—"', () => {
    expect(fmt(undefined)).toBe('—');
  });
  test('number → string', () => {
    expect(fmt(42)).toBe('42');
  });
  test('string passthrough', () => {
    expect(fmt('hello')).toBe('hello');
  });
});

describe('Phase 1.10 — DEFAULT_DELAY_MS', () => {
  test('is 1000 (1 second per spec)', () => {
    expect(DEFAULT_DELAY_MS).toBe(1000);
  });
});

describe('Phase 1.10 — config --yes flag', () => {
  function cleanEnv() {
    delete process.env.YES;
  }
  beforeEach(() => cleanEnv());

  test('parseArgs: --yes sets out.yes = true', () => {
    const out = parseArgs(['--query', 'Cafe', '--location', 'Berlin', '--yes']);
    expect(out.yes).toBe(true);
  });

  test('parseArgs: -y sets out.yes = true', () => {
    const out = parseArgs(['-y']);
    expect(out.yes).toBe(true);
  });

  test('parseArgs: absent → out.yes undefined', () => {
    const out = parseArgs(['--query', 'Cafe']);
    expect(out.yes).toBeUndefined();
  });

  test('loadConfig: cfg.yes = true with --yes', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--yes']);
    expect(cfg.yes).toBe(true);
  });

  test('loadConfig: cfg.yes = true with -y', () => {
    const cfg = loadConfig(['-q', 'Cafe', '-l', 'Berlin', '-y']);
    expect(cfg.yes).toBe(true);
  });

  test('loadConfig: cfg.yes = false by default', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.yes).toBe(false);
  });

  test('loadConfig: --yes does not produce config errors', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--yes']);
    expect(cfg.errors).toHaveLength(0);
  });

  test('HELP_TEXT documents --yes and -y', () => {
    expect(HELP_TEXT).toContain('--yes');
    expect(HELP_TEXT).toContain('-y');
    expect(HELP_TEXT).toContain('Skip the 1s startup-banner delay');
  });

  test('HELP_TEXT has a --yes example', () => {
    expect(HELP_TEXT).toContain('--yes --dryRun');
  });
});
