'use strict';

/**
 * src/browser.js — Phase 1.2 (Phase 1.8: anti-block integration)
 *
 * Launches Playwright Chromium with config-driven options (headless, viewport,
 * randomized user-agent). Returns { browser, context, page }. Caller is
 * responsible for closing in a try/finally — see withBrowser() helper below.
 *
 * Phase 1.8 changes:
 *   - User-agent list + pickUserAgent() moved to src/antiblock.js (expanded to
 *     8 recent real Chrome UAs across Windows / macOS / Linux).
 *   - slowMo no longer has a default — randomized delays are applied at each
 *     action site (scroll / type / detail) instead of a global metronome. The
 *     SLOW_MO env var still works for debugging but defaults to 0.
 *   - Optional attachBlockWatcher hook: callers can pass an onBlocked callback
 *     to be notified of Google 429 / 503 responses (handled in index.js).
 *
 * Phase 1.9 changes:
 *   - Emits a structured "Browser launched" event (phase: browser) with UA,
 *     viewport, headless mode so the log file records the exact launch config
 *     for post-run debugging.
 */

const { chromium } = require('playwright');
const { pickUserAgent, attachBlockWatcher } = require('./antiblock');

async function launchBrowser(cfg, opts = {}) {
  const rawLogger = opts.logger || null;
  // Phase 1.9 — bind every launch-related line to the 'browser' phase.
  const log = rawLogger && rawLogger.phase ? rawLogger.phase('browser') : rawLogger;

  const browser = await chromium.launch({
    headless: cfg.headless,
    // slowMo default 0 — Phase 1.8 relies on explicit randomized delays at
    // each action site instead of a global slowMo (which is metronomic and
    // thus fingerprintable). SLOW_MO env still honored for debugging.
    slowMo: cfg.slowMo || undefined,
  });

  const ua = pickUserAgent();
  const context = await browser.newContext({
    viewport: { width: cfg.viewportWidth, height: cfg.viewportHeight },
    userAgent: ua,
    locale: 'en-US',
    timezoneId: 'America/Toronto',
  });

  context.setDefaultTimeout(cfg.navTimeoutMs || 60000);

  const page = await context.newPage();

  // Phase 1.9 — record the exact launch config. The UA is truncated for log
  // readability (full UA is in the context, not needed in every log line).
  if (log) {
    log.info('Browser launched', {
      headless: cfg.headless,
      viewport: { width: cfg.viewportWidth, height: cfg.viewportHeight },
      userAgent: ua.slice(0, 80) + (ua.length > 80 ? '...' : ''),
      slowMo: cfg.slowMo || 0,
      navTimeoutMs: cfg.navTimeoutMs || 60000,
      locale: 'en-US',
    });
  }

  // Phase 1.8 — attach the HTTP 429/503 watcher if a callback was provided.
  // The callback decides what to do (pause + alert, or exit). The watcher
  // itself just detects and forwards.
  let detachWatcher = null;
  if (typeof opts.onBlocked === 'function' || opts.logger) {
    detachWatcher = attachBlockWatcher(page, {
      logger: opts.logger || null,
      onBlocked: opts.onBlocked || null,
      hostFilter: 'google.com',
    });
  }

  // Expose detach so the caller can read blockedCount at teardown if wanted.
  page._antiblockDetach = detachWatcher;

  return { browser, context, page };
}

async function closeBrowser(browser) {
  if (!browser) return;
  try {
    await browser.close();
  } catch {
    /* best-effort */
  }
}

/**
 * Convenience wrapper: ensures browser closes even on error.
 * Usage: await withBrowser(cfg, async ({ page }) => { ... })
 *
 * Phase 1.8: pass { logger, onBlocked } in the third arg to wire the
 * 429/503 watcher into the page.
 */
async function withBrowser(cfg, fn, opts = {}) {
  const { browser, page } = await launchBrowser(cfg, opts);
  try {
    return await fn({ browser, page });
  } finally {
    if (typeof page._antiblockDetach === 'function') {
      try {
        page._antiblockDetach();
      } catch {
        /* best-effort */
      }
    }
    await closeBrowser(browser);
  }
}

module.exports = { launchBrowser, closeBrowser, withBrowser };
