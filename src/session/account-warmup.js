'use strict';

/**
 * src/session/account-warmup.js — Phase 2.7 — Google account warmup (opt-in)
 *
 * Logs into a Google account in a fresh browser context to establish an
 * authenticated session. Logged-in sessions get more data (full review text,
 * some private fields) and significantly fewer CAPTCHAs from Google.
 *
 * SECURITY:
 *   - Credentials are read from .env / a gitignored accounts file ONLY.
 *   - Credentials are NEVER logged (the logger redacts email to a prefix + ***).
 *   - The accounts file must be mode 0600 (owner-read-only) — we warn if not.
 *   - Each account is used for max 1 session per day (configurable) to avoid
 *     all accounts getting flagged together.
 *
 * This module is OFF by default (--accountWarmup off). Enabling it requires
 * an accounts file (--accountsFile). Account burn is a real risk — use only
 * with burner / dedicated scraping accounts, never primary accounts.
 *
 * Public API:
 *   const accounts = loadAccounts({ filePath, logger });
 *   const r = await accountWarmup(page, { email, password, logger, sleepFn, rng });
 *   const pick = pickAccount(accounts, { usedToday: Set, logger });
 */

const fs = require('fs');
const path = require('path');
const { randomInt } = require('../antiblock');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class AccountWarmupError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'AccountWarmupError';
    this.code = code || 'ACCOUNT_WARMUP_ERROR';
  }
}

// ---------------------------------------------------------------------------
// Account file loader
// ---------------------------------------------------------------------------

/**
 * Load Google account credentials from a JSON file.
 *
 * Expected format: an array of { email, password } objects. The file MUST
 * exist and be readable; a missing/malformed file throws AccountWarmupError
 * (fail-fast — the operator should know before the run starts).
 *
 * SECURITY: the file's permissions are checked — if it's world-readable, we
 * warn (non-fatal) that credentials may be exposed. The file should be mode
 * 0600 (owner-read-only).
 *
 * @param {object} opts { filePath, logger, fs: fsDep }
 * @returns {Array<{email: string, password: string}>}
 */
function loadAccounts(opts = {}) {
  const filePath = opts.filePath;
  const fsDep = opts.fs || fs;
  const logger = opts.logger || null;
  if (!filePath) {
    throw new AccountWarmupError('loadAccounts requires a filePath', { code: 'NO_FILE' });
  }
  if (!fsDep.existsSync(filePath)) {
    throw new AccountWarmupError(`Accounts file not found: ${filePath}`, { code: 'FILE_NOT_FOUND' });
  }
  // Permission check — warn (non-fatal) if world-readable.
  try {
    const stat = fsDep.statSync(filePath);
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      if (logger) {
        logger.warn('Accounts file is group/world-readable — tighten permissions', {
          filePath,
          mode: mode.toString(8),
          hint: 'chmod 600 ' + filePath,
        });
      }
    }
  } catch { /* best-effort */ }
  let raw;
  try {
    raw = fsDep.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new AccountWarmupError(`Cannot read accounts file: ${err.message}`, { code: 'READ_FAILED' });
  }
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (err) {
    throw new AccountWarmupError(`Accounts file is not valid JSON: ${err.message}`, { code: 'PARSE_FAILED' });
  }
  if (!Array.isArray(arr)) {
    throw new AccountWarmupError('Accounts file must contain a JSON array of {email, password} objects', { code: 'NOT_ARRAY' });
  }
  // Validate each entry has email + password (non-empty strings).
  const accounts = [];
  for (let i = 0; i < arr.length; i++) {
    const e = arr[i];
    if (!e || typeof e !== 'object') {
      throw new AccountWarmupError(`Accounts file entry ${i} is not an object`, { code: 'INVALID_ENTRY' });
    }
    if (typeof e.email !== 'string' || !e.email.trim()) {
      throw new AccountWarmupError(`Accounts file entry ${i} missing "email"`, { code: 'MISSING_EMAIL' });
    }
    if (typeof e.password !== 'string' || !e.password) {
      throw new AccountWarmupError(`Accounts file entry ${i} missing "password"`, { code: 'MISSING_PASSWORD' });
    }
    accounts.push({ email: e.email.trim(), password: e.password });
  }
  if (accounts.length === 0) {
    throw new AccountWarmupError('Accounts file is empty', { code: 'EMPTY' });
  }
  return accounts;
}

// ---------------------------------------------------------------------------
// Account picker — avoids reusing an account in the same day
// ---------------------------------------------------------------------------

/**
 * Pick the next account to use, skipping any in `usedToday`.
 *
 * @param {Array<{email,password}>} accounts
 * @param {object} opts { usedToday: Set<string>, rng, logger }
 * @returns {{email,password}|null} — null if all accounts were used today
 */
function pickAccount(accounts, opts = {}) {
  const usedToday = opts.usedToday || new Set();
  const rng = opts.rng || Math.random;
  const available = accounts.filter((a) => !usedToday.has(a.email));
  if (available.length === 0) return null;
  return available[Math.floor(rng() * available.length)];
}

// ---------------------------------------------------------------------------
// Redaction — never log raw credentials
// ---------------------------------------------------------------------------

/**
 * Redact an email for logging: "user@gmail.com" → "use***@gmail.com".
 * The domain is kept (it's not secret); only the local-part is masked.
 */
function redactEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const prefix = local.slice(0, 3);
  return prefix + '***' + domain;
}

// ---------------------------------------------------------------------------
// accountWarmup — log into Google in the given page's context
// ---------------------------------------------------------------------------

/**
 * Log into a Google account in the given page. Establishes an authenticated
 * session (cookies) for the rest of the scrape.
 *
 * The login flow is best-effort and intentionally simple: navigate to the
 * Google sign-in page, type the email, click Next, type the password, click
 * Next. Google's exact flow varies (2FA, device verification, etc.) — this
 * module handles the common path and surfaces failures clearly so the
 * operator can fix the account / flow.
 *
 * SECURITY: the password is NEVER logged. Only the redacted email appears in
 * log lines.
 *
 * @param {object} page — Playwright Page (or stub with goto/keyboard/$/click)
 * @param {object} args { email, password, logger, sleepFn, rng }
 * @returns {Promise<{ loggedIn: boolean, email: string, error?: string }>}
 */
async function accountWarmup(page, args = {}) {
  const email = args.email;
  const password = args.password;
  const logger = args.logger || null;
  const sleepFn = args.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rng = args.rng || Math.random;
  const redacted = redactEmail(email);

  if (!email || !password) {
    throw new AccountWarmupError('accountWarmup requires email + password', { code: 'MISSING_CREDENTIALS' });
  }

  if (logger) logger.info('Account warmup: starting login', { email: redacted });

  try {
    // 1. Navigate to the Google sign-in page.
    await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // 2. Type the email into the email input.
    const emailInput = await waitForSelector(page, 'input[type="email"]', { sleepFn });
    if (!emailInput) {
      return { loggedIn: false, email: redacted, error: 'email input not found' };
    }
    await emailInput.click({ delay: randomInt(50, 150, rng) });
    await page.keyboard.type(email, { delay: randomInt(50, 150, rng) });
    await sleepFn(randomInt(300, 800, rng));
    await page.keyboard.press('Enter');

    // 3. Wait for the password page to load.
    await sleepFn(randomInt(1500, 3000, rng));
    const pwInput = await waitForSelector(page, 'input[type="password"]', { sleepFn });
    if (!pwInput) {
      // Google may have shown a "couldn't find your Google Account" or a 2FA
      // challenge. Surface a clear error.
      return { loggedIn: false, email: redacted, error: 'password input not found (account may be invalid or 2FA required)' };
    }
    await pwInput.click({ delay: randomInt(50, 150, rng) });
    await page.keyboard.type(password, { delay: randomInt(50, 150, rng) });
    await sleepFn(randomInt(300, 800, rng));
    await page.keyboard.press('Enter');

    // 4. Wait for the post-login redirect. A successful login lands on
    // myaccount.google.com or the Google homepage.
    await sleepFn(randomInt(2000, 4000, rng));
    let url = '';
    try { url = page.url ? page.url() : ''; } catch { /* best-effort */ }

    // Heuristic: if we're NOT back on the sign-in page, login likely succeeded.
    const stillOnSignin = /accounts\.google\.com\/signin/.test(url);
    const loggedIn = !stillOnSignin;
    if (logger) {
      logger[loggedIn ? 'info' : 'warn']('Account warmup: login ' + (loggedIn ? 'succeeded' : 'failed'), {
        email: redacted,
        url: url.slice(0, 80),
      });
    }
    return { loggedIn, email: redacted, error: loggedIn ? null : 'still on sign-in page after submit' };
  } catch (err) {
    if (logger) logger.warn('Account warmup: login threw', { email: redacted, error: err.message });
    return { loggedIn: false, email: redacted, error: err.message };
  }
}

/**
 * Wait for a selector to appear, polling with sleepFn. Returns the element
 * handle or null after maxAttempts tries. Extracted so tests can inject a
 * stub page whose $() returns synchronously.
 */
async function waitForSelector(page, selector, { sleepFn, maxAttempts = 10, intervalMs = 500 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    let el = null;
    try {
      el = await page.$(selector);
    } catch { /* best-effort */ }
    if (el) return el;
    if (sleepFn) await sleepFn(intervalMs);
  }
  return null;
}

module.exports = {
  accountWarmup,
  loadAccounts,
  pickAccount,
  redactEmail,
  waitForSelector,
  AccountWarmupError,
};
