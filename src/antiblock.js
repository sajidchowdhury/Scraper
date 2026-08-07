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
 *
 * Phase 1.9: every log line is bound to the 'antiblock' phase so the
 * JSON-lines log file can be filtered by pipeline stage.
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
    // Phase 1.9 — bind to the 'antiblock' phase (no-op for plain stubs).
    const rawLogger = opts.logger || null;
    this.logger = rawLogger && rawLogger.phase ? rawLogger.phase('antiblock') : rawLogger;
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
// Phase 2.6 — CAPTCHA type detection
// ---------------------------------------------------------------------------
// Phase 1.8's detectCaptcha() answers a yes/no question. Phase 2.6 needs more:
//   - WHICH type of challenge (reCAPTCHA v2 checkbox, reCAPTCHA v3 invisible,
//     or the text-based "unusual traffic" interstitial)?
//   - WHAT is the data-sitekey (so a solver service can solve it)?
//   - WHERE is it (url, for the solver's pageurl parameter)?
//
// detectCaptchaType() returns a richer object the CAPTCHA orchestrator
// (src/captcha/orchestrator.js) consumes to drive a third-party solver.
// All functions are pure / injectable so tests never touch a real browser.

const CAPTCHA_TYPES = {
  NONE: 'none',
  RECAPTCHA_V2: 'recaptcha-v2',
  RECAPTCHA_V3: 'recaptcha-v3',
  UNUSUAL_TRAFFIC: 'unusual-traffic',
};

// Phrases Google shows specifically on the "unusual traffic" interstitial (a
// full-page block, not a widget). Lowercased for substring matching.
const UNUSUAL_TRAFFIC_INDICATORS = [
  'our systems have detected unusual traffic',
  'unusual traffic from your computer network',
  'unusual traffic from your network',
];

/**
 * Extract the reCAPTCHA data-sitekey from a page.
 *
 * Looks for:
 *   1. `.g-recaptcha[data-sitekey]` (the standard v2 widget div)
 *   2. `iframe[src*="recaptcha/api2"]` → parse the `render=` query param
 *      (the sitekey is passed as render= in the iframe URL)
 *   3. `[data-sitekey]` (generic fallback — some sites use a custom class)
 *
 * Returns the sitekey string, or null when none is found.
 *
 * Accepts an injectable `evalFn` (returns the raw extraction result) for unit
 * tests so no real browser is needed.
 *
 * @param {object} page
 * @param {object} [opts]
 * @param {()=>Promise<string|null>} [opts.evalFn]
 * @returns {Promise<string|null>}
 */
async function extractSitekey(page, opts = {}) {
  try {
    if (opts.evalFn) return await opts.evalFn();
    return await page.evaluate(() => {
      // 1. Standard v2 widget div.
      const widget = document.querySelector('.g-recaptcha[data-sitekey]');
      if (widget) return widget.getAttribute('data-sitekey');
      // 2. Generic [data-sitekey] (covers enterprise + custom integrations).
      const generic = document.querySelector('[data-sitekey]');
      if (generic) return generic.getAttribute('data-sitekey');
      // 3. reCAPTCHA iframe — parse the render= query param.
      const iframe = document.querySelector('iframe[src*="recaptcha/api2"]');
      if (iframe) {
        try {
          const u = new URL(iframe.getAttribute('src'));
          const render = u.searchParams.get('render');
          if (render && render !== 'explicit') return render;
        } catch { /* not a valid URL — ignore */ }
      }
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Detect the type of CAPTCHA / block currently on the page.
 *
 * Decision tree:
 *   1. If body text matches an UNUSUAL_TRAFFIC_INDICATOR → type 'unusual-traffic'
 *      (Google's full-page interstitial; may or may not have a sitekey).
 *   2. Else if a reCAPTCHA sitekey is present AND a visible checkbox exists
 *      (`.recaptcha-checkbox`) → type 'recaptcha-v2'.
 *   3. Else if a reCAPTCHA sitekey is present but NO visible checkbox → type
 *      'recaptcha-v3' (invisible, score-based — usually means "slow down").
 *   4. Else if the body text matches any generic CAPTCHA_INDICATOR → type
 *      'unusual-traffic' (conservative default for text-only blocks).
 *   5. Else → type 'none'.
 *
 * Returns { detected, type, sitekey, url, indicator }.
 *
 * Accepts injectable `textFn`, `sitekeyFn`, `urlFn`, `checkboxFn` for tests.
 *
 * @param {object} page
 * @param {object} [opts]
 * @param {()=>Promise<string>} [opts.textFn]
 * @param {()=>Promise<string|null>} [opts.sitekeyFn]
 * @param {()=>Promise<string>} [opts.urlFn]
 * @param {()=>Promise<boolean>} [opts.checkboxFn]
 * @returns {Promise<{ detected: boolean, type: string, sitekey: string|null, url: string, indicator: string|null }>}
 */
async function detectCaptchaType(page, opts = {}) {
  let text = '';
  try {
    text = opts.textFn ? await opts.textFn() : await page.evaluate(() =>
      document.body ? (document.body.innerText || '') : ''
    );
  } catch { /* navigation mid-evaluate — treat as empty */ }
  const haystack = String(text || '').toLowerCase();

  let sitekey = null;
  try {
    sitekey = opts.sitekeyFn ? await opts.sitekeyFn() : await extractSitekey(page);
  } catch { /* best-effort */ }
  let url = '';
  try {
    url = opts.urlFn ? await opts.urlFn() : (page.url ? page.url() : '');
  } catch { /* best-effort */ }
  let hasCheckbox = false;
  try {
    hasCheckbox = opts.checkboxFn
      ? await opts.checkboxFn()
      : await page.evaluate(() => !!document.querySelector('.recaptcha-checkbox, [role="checkbox"]'));
  } catch { /* best-effort */ }

  // 1. "Unusual traffic" interstitial (text-based, full-page block).
  for (const ind of UNUSUAL_TRAFFIC_INDICATORS) {
    if (haystack.includes(ind.toLowerCase())) {
      return { detected: true, type: CAPTCHA_TYPES.UNUSUAL_TRAFFIC, sitekey, url, indicator: ind };
    }
  }
  // 2 + 3. reCAPTCHA widget present — distinguish v2 (checkbox) from v3 (invisible).
  if (sitekey) {
    if (hasCheckbox) {
      return { detected: true, type: CAPTCHA_TYPES.RECAPTCHA_V2, sitekey, url, indicator: 'g-recaptcha' };
    }
    return { detected: true, type: CAPTCHA_TYPES.RECAPTCHA_V3, sitekey, url, indicator: '/recaptcha/api2/' };
  }
  // 4. Generic CAPTCHA indicator in the text (e.g. "not a robot") with no widget.
  for (const ind of CAPTCHA_INDICATORS) {
    if (haystack.includes(ind.toLowerCase())) {
      return { detected: true, type: CAPTCHA_TYPES.UNUSUAL_TRAFFIC, sitekey: null, url, indicator: ind };
    }
  }
  // 5. Nothing detected.
  return { detected: false, type: CAPTCHA_TYPES.NONE, sitekey: null, url, indicator: null };
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
  const rawLogger = opts.logger || null;
  // Phase 1.9 — bind to the 'antiblock' phase (no-op for plain stubs).
  const logger = rawLogger && rawLogger.phase ? rawLogger.phase('antiblock') : rawLogger;
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
  // Phase 2.6 — typed CAPTCHA detection
  CAPTCHA_TYPES,
  UNUSUAL_TRAFFIC_INDICATORS,
  extractSitekey,
  detectCaptchaType,
  BLOCK_STATUSES,
  isBlockStatus,
  attachBlockWatcher,
};
