'use strict';

/**
 * src/antiblock.js — Phase 1.8 (Minimal Anti-Block Behavior)
 *
 * Centralizes every "be polite to Google" tactic so the rest of the pipeline
 * can stay focused on extraction. Full anti-detection (proxies, fingerprinting,
 * CAPTCHA solving) is Phase 2 of the master roadmap — here we only need basic
 * good citizenship for small-to-medium runs.
 *
 * What this module provides:
 *   - USER_AGENTS + pickUserAgent() — randomized UA per run (moved from browser.js,
 *     expanded to a wider list of recent real Chrome UAs)
 *   - randomInt(min, max) / randomDelay(min, max) — randomized human-like waits
 *   - humanType(page, text, opts) — character-by-character typing with jitter,
 *     injectable typeFn/delayFn for unit tests
 *   - RateLimiter — sliding-window max-requests-per-minute cap (default 30/min)
 *   - detectCaptchaInText(text) — pure predicate for CAPTCHA / "unusual traffic"
 *   - detectCaptcha(page) — page-bound helper that pulls body text first
 *   - BLOCK_STATUSES + isBlockStatus(status) — HTTP 429 / 503 detection
 *   - attachBlockWatcher(page, logger, onBlock) — page.on('response') listener
 *     that fires onBlocked for Google 429/503 responses
 *
 * Design rules (per project conventions):
 *   - Pure functions take a string/number and return a value — easy to test.
 *   - Page-bound functions are thin wrappers over the pure ones.
 *   - Async functions accept injectable sleep/type/delay functions for fast,
 *     deterministic unit tests (see tests/antiblock.test.js).
 */

// ---------------------------------------------------------------------------
// User-agent rotation
// ---------------------------------------------------------------------------

const USER_AGENTS = [
  // Recent real desktop Chrome UAs (Windows / macOS / Linux). Picked at random
  // per launch so each run looks like a different machine. Kept current-ish so
  // Google doesn't fingerprint an obsolete build.
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
];

function pickUserAgent(rng) {
  const r = rng ? rng() : Math.random();
  const idx = Math.floor(r * USER_AGENTS.length);
  // Clamp in case rng() returned exactly 1
  return USER_AGENTS[Math.min(idx, USER_AGENTS.length - 1)];
}

// ---------------------------------------------------------------------------
// Randomized delays
// ---------------------------------------------------------------------------

function randomInt(minMs, maxMs, rng) {
  const r = rng ? rng() : Math.random();
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  // inclusive of lo, exclusive of hi → use floor
  return lo + Math.floor(r * (hi - lo + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait a random duration in [minMs, maxMs]. Accepts an injectable sleepFn
 * (for tests) so no real time elapses.
 *
 * @param {number} minMs
 * @param {number} maxMs
 * @param {object} [opts]
 * @param {(ms:number)=>Promise<void>} [opts.sleepFn]
 * @param {()=>number} [opts.rng]
 * @returns {Promise<number>} the actual delay chosen (ms)
 */
async function randomDelay(minMs, maxMs, opts = {}) {
  const delay = randomInt(minMs, maxMs, opts.rng);
  const sleeper = opts.sleepFn || sleep;
  await sleeper(delay);
  return delay;
}

// ---------------------------------------------------------------------------
// Human-like typing
// ---------------------------------------------------------------------------

/**
 * Type text character-by-character with a randomized inter-key delay, instead
 * of Playwright's instant page.fill(). Visible in headed mode as real typing.
 *
 * Accepts injectable typeFn / delayFn so unit tests run instantly and
 * deterministically.
 *
 * @param {object} page — Playwright Page (or a stub with keyboard.type)
 * @param {string} text
 * @param {object} [opts]
 * @param {(ch:string)=>Promise<void>} [opts.typeFn] — defaults to page.keyboard.type
 * @param {(min:number,max:number)=>number} [opts.delayFn] — defaults to randomInt
 * @param {number} [opts.minMs=50]
 * @param {number} [opts.maxMs=150]
 * @returns {Promise<{ chars: number, delays: number[] }>}
 */
async function humanType(page, text, opts = {}) {
  if (text === null || text === undefined) text = '';
  const str = String(text);
  const minMs = opts.minMs ?? 50;
  const maxMs = opts.maxMs ?? 150;
  const typeFn =
    opts.typeFn ||
    ((ch) => page.keyboard.type(ch, { delay: 0 }));
  const delayFn = opts.delayFn || ((mn, mx) => randomInt(mn, mx));

  const delays = [];
  for (const ch of str) {
    await typeFn(ch);
    const d = delayFn(minMs, maxMs);
    delays.push(d);
    // Real sleep between keys (overridable in tests via opts.sleepFn)
    const sleeper = opts.sleepFn || sleep;
    await sleeper(d);
  }
  return { chars: str.length, delays };
}

// ---------------------------------------------------------------------------
// Rate limiter — sliding window of timestamps, max N per 60s
// ---------------------------------------------------------------------------

/**
 * Sliding-window rate limiter. acquire() resolves immediately if under the cap,
 * otherwise waits until enough old timestamps age out of the window.
 *
 * @example
 *   const limiter = new RateLimiter(30, { logger });
 *   await limiter.acquire(); // call before each Google-bound request
 */
class RateLimiter {
  constructor(maxPerMin, opts = {}) {
    if (!Number.isFinite(maxPerMin) || maxPerMin < 1) {
      throw new Error(`RateLimiter: maxPerMin must be >= 1 (got ${maxPerMin})`);
    }
    this.maxPerMin = maxPerMin;
    this.windowMs = opts.windowMs || 60_000;
    this.sleepFn = opts.sleepFn || sleep;
    this.nowFn = opts.nowFn || (() => Date.now());
    this.logger = opts.logger || null;
    this._timestamps = [];
    this._waits = 0; // total times we blocked
  }

  /**
   * Block until a request slot is available, then record the timestamp.
   * Returns the wait duration in ms (0 if no wait was needed).
   */
  async acquire(label) {
    let waitMs = 0;
    for (;;) {
      const now = this.nowFn();
      // Drop timestamps older than the window
      this._timestamps = this._timestamps.filter((t) => now - t < this.windowMs);
      if (this._timestamps.length < this.maxPerMin) {
        break;
      }
      // Need to wait until the oldest timestamp falls out of the window
      const oldest = this._timestamps[0];
      const need = this.windowMs - (now - oldest) + 1;
      if (this.logger) {
        this.logger.debug('Rate limit reached — pausing', {
          label: label || 'request',
          waitMs: need,
          inFlight: this._timestamps.length,
          maxPerMin: this.maxPerMin,
        });
      }
      await this.sleepFn(need);
      waitMs += need;
      this._waits++;
    }
    this._timestamps.push(this.nowFn());
    return waitMs;
  }

  /** Current number of requests recorded in the window (for stats/tests). */
  get inFlight() {
    const now = this.nowFn();
    this._timestamps = this._timestamps.filter((t) => now - t < this.windowMs);
    return this._timestamps.length;
  }

  /** Total times acquire() had to wait. */
  get totalWaits() {
    return this._waits;
  }
}

// ---------------------------------------------------------------------------
// CAPTCHA / "unusual traffic" detection
// ---------------------------------------------------------------------------

// Phrases Google shows when it throttles / challenges a scraper. Lowercased
// for substring matching against document.body.innerText.
const CAPTCHA_INDICATORS = [
  "our systems have detected unusual traffic",
  'unusual traffic',
  'not a robot',
  'captcha',
  'recaptcha',
  'are you a robot',
  'verify you are a human',
  'confirm you are not a robot',
  '/recaptcha/api2/',
  'g-recaptcha',
];

/**
 * Pure predicate: scan a text blob for known CAPTCHA / block indicators.
 * Returns { detected, indicator } so callers can log which phrase matched.
 *
 * @param {string} text
 * @returns {{ detected: boolean, indicator: string|null }}
 */
function detectCaptchaInText(text) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack) return { detected: false, indicator: null };
  for (const ind of CAPTCHA_INDICATORS) {
    if (haystack.includes(ind.toLowerCase())) {
      return { detected: true, indicator: ind };
    }
  }
  return { detected: false, indicator: null };
}

/**
 * Page-bound helper: pull document.body.innerText then run detectCaptchaInText.
 * Accepts an injectable textFn (returns the body text) for unit tests.
 *
 * @param {object} page
 * @param {object} [opts]
 * @param {()=>Promise<string>} [opts.textFn]
 * @returns {Promise<{ detected: boolean, indicator: string|null }>}
 */
async function detectCaptcha(page, opts = {}) {
  let text;
  try {
    text = opts.textFn
      ? await opts.textFn()
      : await page.evaluate(() => document.body ? (document.body.innerText || '') : '');
  } catch {
    // If we can't read the body (navigation mid-evaluate), assume no captcha —
    // the caller's own operation will surface the real error.
    return { detected: false, indicator: null };
  }
  return detectCaptchaInText(text);
}

// ---------------------------------------------------------------------------
// HTTP 429 / 503 detection
// ---------------------------------------------------------------------------

const BLOCK_STATUSES = [429, 503];

function isBlockStatus(status) {
  return BLOCK_STATUSES.includes(status);
}

/**
 * Attach a page.on('response') listener that fires onBlocked when Google
 * returns 429 / 503. Returns a detach function.
 *
 * @param {object} page
 * @param {object} opts — { logger, onBlocked, hostFilter }
 * @returns {() => void} detach
 */
function attachBlockWatcher(page, opts = {}) {
  const logger = opts.logger || null;
  const onBlocked = opts.onBlocked || (() => {});
  const hostFilter = opts.hostFilter || 'google.com';
  let blockedCount = 0;

  const handler = async (response) => {
    let status;
    try {
      status = response.status();
    } catch {
      return; // response already disposed
    }
    if (!isBlockStatus(status)) return;
    let url = '';
    try {
      url = response.url();
    } catch {
      /* ignore */
    }
    if (hostFilter && !url.includes(hostFilter)) return;
    blockedCount++;
    if (logger) {
      logger.warn('Blocked HTTP response detected from Google', {
        status,
        url,
        count: blockedCount,
      });
    }
    try {
      await onBlocked({ status, url, count: blockedCount });
    } catch {
      /* listener errors must not break the response handler */
    }
  };

  page.on('response', handler);

  return function detach() {
    try {
      page.off('response', handler);
    } catch {
      /* best-effort */
    }
    return blockedCount;
  };
}

module.exports = {
  USER_AGENTS,
  pickUserAgent,
  randomInt,
  sleep,
  randomDelay,
  humanType,
  RateLimiter,
  CAPTCHA_INDICATORS,
  detectCaptchaInText,
  detectCaptcha,
  BLOCK_STATUSES,
  isBlockStatus,
  attachBlockWatcher,
};
