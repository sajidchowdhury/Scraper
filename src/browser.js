'use strict';

/**
 * src/browser.js — Phase 1.2 (Phase 1.8: anti-block, Phase 2.3: proxy)
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
 *
 * Phase 2.3 changes:
 *   - launchBrowser now accepts opts.proxy = { server, username, password, id,
 *     provider, host, port }. When present, it's passed to Playwright's
 *     chromium.launch({ proxy }) so all browser traffic flows through it.
 *   - When no proxy is provided, the launch is direct (Phase 1 behavior
 *     preserved). This keeps --noProxy / "no proxies configured" identical to
 *     the original code path.
 *   - The "Browser launched" log line now records the proxy id + provider so
 *     the JSON-lines log can be cross-referenced with the proxy burn log.
 */

const { chromium } = require('playwright');
const { pickUserAgent, attachBlockWatcher } = require('./antiblock');

async function launchBrowser(cfg, opts = {}) {
  const rawLogger = opts.logger || null;
  // Phase 1.9 — bind every launch-related line to the 'browser' phase.
  const log = rawLogger && rawLogger.phase ? rawLogger.phase('browser') : rawLogger;

  // Phase 2.3 — build the Playwright launch options. If a proxy descriptor is
  // supplied (from the proxy pool), pass it through. Playwright expects:
  //   { server: 'http://host:port', username?, password?, bypass? }
  // When no proxy is configured, omit the key entirely → direct connection
  // (Phase 1 behavior).
  const launchOpts = {
    headless: cfg.headless,
    // slowMo default 0 — Phase 1.8 relies on explicit randomized delays at
    // each action site instead of a global slowMo (which is metronomic and
    // thus fingerprintable). SLOW_MO env still honored for debugging.
    slowMo: cfg.slowMo || undefined,
  };
  if (opts.proxy && opts.proxy.server) {
    launchOpts.proxy = {
      server: opts.proxy.server,
      ...(opts.proxy.username ? { username: opts.proxy.username } : {}),
      ...(opts.proxy.password ? { password: opts.proxy.password } : {}),
    };
  }

  const browser = await chromium.launch(launchOpts);

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
  // Phase 2.3 — also record the proxy id + provider so the JSON log can be
  // cross-referenced with the proxy burn log (data/proxy_burn_log.jsonl).
  if (log) {
    const launched = {
      headless: cfg.headless,
      viewport: { width: cfg.viewportWidth, height: cfg.viewportHeight },
      userAgent: ua.slice(0, 80) + (ua.length > 80 ? '...' : ''),
      slowMo: cfg.slowMo || 0,
      navTimeoutMs: cfg.navTimeoutMs || 60000,
      locale: 'en-US',
    };
    if (opts.proxy && opts.proxy.server) {
      launched.proxy = {
        id: opts.proxy.id || null,
        server: opts.proxy.server,
        provider: opts.proxy.provider || null,
        host: opts.proxy.host || null,
        port: opts.proxy.port || null,
      };
      log.info(
        `Browser launched via proxy ${opts.proxy.id || opts.proxy.server}` +
          (opts.proxy.provider ? ` (provider: ${opts.proxy.provider})` : ''),
        launched,
      );
    } else {
      log.info('Browser launched (direct — no proxy)', launched);
    }
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
 *
 * Phase 2.3: pass { proxy } in the third arg to launch through a proxy from
 * the proxy pool. The descriptor is also returned in the result so the caller
 * can release it to the pool with the appropriate outcome (success/blocked).
 *   const proxy = await pool.acquire();
 *   const result = await withBrowser(cfg, async ({ page, proxy }) => { ... },
 *                                    { proxy, logger });
 *   pool.release(proxy.id, { success: !err, statusCode: ... });
 */
async function withBrowser(cfg, fn, opts = {}) {
  const { browser, page } = await launchBrowser(cfg, opts);
  try {
    return await fn({ browser, page, proxy: opts.proxy || null });
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
