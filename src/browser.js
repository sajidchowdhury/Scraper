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
 *
 * Phase 2.4 changes:
 *   - launchBrowser now accepts opts.fingerprint = { userAgent, platform,
 *     viewport, timezone, locale, languages, webglVendor, webglRenderer,
 *     canvasNoiseSeed, hardwareConcurrency, deviceMemory, geolocation, ... }.
 *     When present, it OVERRIDES the Phase 1 viewport/UA/locale/timezone
 *     context options with the coherent fingerprint, and injects an init
 *     script that spoofs navigator.platform / hardwareConcurrency /
 *     deviceMemory / languages, WebGL vendor+renderer, and adds canvas noise.
 *   - When no fingerprint is provided (cfg.fingerprint.profile === 'off' or
 *     opts.fingerprint === null), Phase 1 behavior is preserved exactly —
 *     pickUserAgent() + cfg.viewport + 'en-US' + 'America/Toronto'.
 *   - The "Browser launched" log line records the fingerprint summary so the
 *     JSON log can be cross-referenced with block events.
 *
 * Phase 2.5 changes:
 *   - launchBrowser now accepts opts.stealth = { enabled, debug }. When
 *     enabled, the browser is launched via playwright-extra with the
 *     puppeteer-extra-plugin-stealth plugin applied, AND the custom
 *     src/stealth-patches.js init script is injected (covering the bot
 *     signals the plugin misses: chrome.runtime, plugins.length,
 *     permissions.query, outerWidth/Height, Notification.permission,
 *     navigator.vendor, maxTouchPoints). The stealth patches run AFTER the
 *     fingerprint init script and yield to its overrides.
 *   - When stealth is disabled (--stealth off), the browser is launched via
 *     vanilla 'playwright' (Phase 1/2.4 behavior preserved exactly). This
 *     keeps the stealth layer fully opt-in and A/B-testable.
 *   - Stealth launch args (--disable-blink-features=AutomationControlled,
 *     --disable-infobars, --no-first-run, --disable-dev-shm-usage) are
 *     merged into chromium.launch({ args }) when stealth is on. These are
 *     the single most effective anti-detection measure — without
 *     --disable-blink-features=AutomationControlled, Chromium sets
 *     navigator.webdriver = true at the Blink level, which is the #1 bot
 *     signal Google checks.
 *   - The "Browser launched" log line records the stealth state (on/off,
 *     debug on/off, patch count) so the JSON log can be cross-referenced
 *     with block events.
 */

// Phase 2.5 — choose the chromium launcher dynamically. When stealth is
// enabled, we use playwright-extra (which supports .use(plugin)) with the
// puppeteer-extra-plugin-stealth plugin. When stealth is disabled, we use
// vanilla playwright to preserve Phase 1/2.4 behavior exactly.
//
// We require BOTH lazily inside launchBrowser() so a broken playwright-extra
// install never affects --stealth off runs, and so the stealth module is
// testable in isolation (tests can stub both launchers).
const vanillaPlaywright = require('playwright');
const { pickUserAgent, attachBlockWatcher } = require('./antiblock');
const {
  buildContextOptions,
  applyFingerprintToContext,
  summarizeFingerprint,
} = require('./fingerprint');
const {
  applyStealthPatches,
  buildStealthLaunchArgs,
  STEALTH_PATCHES,
} = require('./stealth-patches');

/**
 * Resolve the chromium launcher + stealth plugin state based on opts.
 * Returns { chromium, stealthPluginApplied }.
 *
 * - stealth enabled  → playwright-extra chromium with stealth plugin use()d
 * - stealth disabled → vanilla playwright chromium (no plugin)
 *
 * The stealth plugin is applied ONCE per process (playwright-extra's .use()
 * is idempotent). We guard against double-use() with a module-level flag.
 */
let _stealthPluginApplied = false;
function resolveChromiumLauncher(stealthEnabled) {
  if (!stealthEnabled) {
    return { chromium: vanillaPlaywright.chromium, stealthPluginApplied: false };
  }
  try {
    const { chromium: extraChromium } = require('playwright-extra');
    const stealth = require('puppeteer-extra-plugin-stealth');
    if (!_stealthPluginApplied) {
      extraChromium.use(stealth());
      _stealthPluginApplied = true;
    }
    return { chromium: extraChromium, stealthPluginApplied: true };
  } catch (err) {
    // playwright-extra or stealth plugin not installed — fall back to vanilla.
    // This is a non-fatal degradation: the custom stealth-patches.js init
    // script still runs (covering chrome.runtime, plugins, permissions,
    // etc.), but the plugin-level patches (CDP-level webdriver removal,
    // runtime.enable evasion) are skipped.
    return { chromium: vanillaPlaywright.chromium, stealthPluginApplied: false, pluginError: err.message };
  }
}

async function launchBrowser(cfg, opts = {}) {
  const rawLogger = opts.logger || null;
  // Phase 1.9 — bind every launch-related line to the 'browser' phase.
  const log = rawLogger && rawLogger.phase ? rawLogger.phase('browser') : rawLogger;

  // Phase 2.5 — resolve the chromium launcher + stealth plugin state.
  // stealth.enabled defaults to true (Phase 2.5 turns stealth ON by default).
  // --stealth off disables both the plugin AND the custom patches.
  const stealthOpts = opts.stealth || { enabled: false, debug: false };
  const stealthEnabled = !!stealthOpts.enabled;
  const stealthDebug = !!stealthOpts.debug;
  const { chromium, stealthPluginApplied, pluginError } = resolveChromiumLauncher(stealthEnabled);

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
  // Phase 2.5 — merge stealth launch args when stealth is enabled.
  // --disable-blink-features=AutomationControlled is the single most
  // important arg: it suppresses navigator.webdriver at the Blink level,
  // which is far more robust than patching it in-page after the fact.
  if (stealthEnabled) {
    launchOpts.args = buildStealthLaunchArgs(cfg);
  }

  const browser = await chromium.launch(launchOpts);

  // Phase 2.4 — build the context options. If a fingerprint is supplied, it
  // wins over the Phase 1 defaults (viewport/UA/locale/timezone). If not, we
  // fall back to the Phase 1 code path (pickUserAgent + cfg.viewport + en-US
  // + America/Toronto) so --noFingerprint is byte-identical to Phase 1.
  let contextOpts;
  let fingerprintSummary = null;
  if (opts.fingerprint) {
    contextOpts = buildContextOptions(opts.fingerprint);
    fingerprintSummary = summarizeFingerprint(opts.fingerprint);
  } else {
    const ua = pickUserAgent();
    contextOpts = {
      userAgent: ua,
      viewport: { width: cfg.viewportWidth, height: cfg.viewportHeight },
      locale: 'en-US',
      timezoneId: 'America/Toronto',
    };
    fingerprintSummary = null;
  }

  const context = await browser.newContext(contextOpts);

  // Phase 2.4 — inject the init script that overrides navigator/WebGL/canvas.
  // Only when a fingerprint is supplied (Phase 1 path skips this entirely).
  if (opts.fingerprint) {
    await applyFingerprintToContext(context, opts.fingerprint, { logger: rawLogger });
  }

  // Phase 2.5 — inject the custom stealth patches. Runs AFTER the fingerprint
  // script so it can detect (and yield to) the fingerprint's overrides for
  // navigator.languages + WebGL getParameter. The stealth patches cover the
  // bot-detection surfaces the fingerprint script never touches: webdriver,
  // chrome.runtime, plugins.length, permissions.query, outerWidth/Height,
  // Notification.permission, navigator.vendor, maxTouchPoints.
  //
  // Only injected when stealth is enabled (--stealth on, the default). With
  // --stealth off, this entire block is skipped, preserving Phase 1/2.4
  // behavior exactly.
  if (stealthEnabled) {
    await applyStealthPatches(context, { debug: stealthDebug, logger: rawLogger });
  }

  context.setDefaultTimeout(cfg.navTimeoutMs || 60000);

  const page = await context.newPage();

  // Phase 1.9 — record the exact launch config. The UA is truncated for log
  // readability (full UA is in the context, not needed in every log line).
  // Phase 2.3 — also record the proxy id + provider so the JSON log can be
  // cross-referenced with the proxy burn log (data/proxy_burn_log.jsonl).
  // Phase 2.4 — also record the fingerprint summary so block events can be
  // correlated with the exact fingerprint that triggered them.
  // Phase 2.5 — also record the stealth state (on/off, plugin applied, patch
  // count, debug on/off) so block events can be correlated with the stealth
  // config that was active.
  if (log) {
    const fp = opts.fingerprint;
    const launched = {
      headless: cfg.headless,
      viewport: fp ? fp.viewport : { width: cfg.viewportWidth, height: cfg.viewportHeight },
      userAgent: (fp ? fp.userAgent : contextOpts.userAgent)
        .slice(0, 80) + ((fp ? fp.userAgent : contextOpts.userAgent).length > 80 ? '...' : ''),
      slowMo: cfg.slowMo || 0,
      navTimeoutMs: cfg.navTimeoutMs || 60000,
      locale: fp ? fp.locale : 'en-US',
    };
    if (fp) {
      launched.fingerprint = {
        profile: 'random|fixed',
        summary: fingerprintSummary,
        platform: fp.platform,
        timezone: fp.timezone,
        webglVendor: fp.webglVendor,
        hardwareConcurrency: fp.hardwareConcurrency,
        deviceMemory: fp.deviceMemory,
      };
    }
    if (stealthEnabled) {
      launched.stealth = {
        enabled: true,
        pluginApplied: stealthPluginApplied,
        pluginError: pluginError || null,
        patchCount: STEALTH_PATCHES.length,
        debug: stealthDebug,
        launchArgs: buildStealthLaunchArgs(cfg),
      };
    } else {
      launched.stealth = { enabled: false };
    }
    const stealthTag = stealthEnabled
      ? ` [stealth: ${stealthPluginApplied ? 'plugin+' : ''}${STEALTH_PATCHES.length} patches${stealthDebug ? ' debug' : ''}${pluginError ? ' PLUGIN-FAIL' : ''}]`
      : ' [stealth: off]';
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
          (opts.proxy.provider ? ` (provider: ${opts.proxy.provider})` : '') +
          (fingerprintSummary ? ` [fp: ${fingerprintSummary}]` : '') +
          stealthTag,
        launched,
      );
    } else {
      log.info(
        'Browser launched (direct — no proxy)' +
          (fingerprintSummary ? ` [fp: ${fingerprintSummary}]` : '') +
          stealthTag,
        launched,
      );
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
 *
 * Phase 2.4: pass { fingerprint } in the third arg to apply a coherent
 * fingerprint to the browser context. The fingerprint is generated ONCE per
 * run in src/index.js (per-worker persistence is Phase 2.8) and passed in
 * here so the same fingerprint is used for the whole session. Rotating
 * fingerprints mid-session is suspicious (real users don't change UAs).
 *   const fingerprint = generateFingerprint({ logger });
 *   const result = await withBrowser(cfg, async ({ page }) => { ... },
 *                                    { fingerprint, logger });
 *
 * Phase 2.5: pass { stealth: { enabled, debug } } in the third arg to enable
 * the stealth layer (playwright-extra + stealth plugin + custom init-script
 * patches). When omitted or { enabled: false }, vanilla playwright is used
 * (Phase 1/2.4 behavior preserved). --stealth off in the CLI sets enabled:false.
 *   const result = await withBrowser(cfg, async ({ page }) => { ... },
 *                                    { fingerprint, stealth: { enabled: true }, logger });
 */
async function withBrowser(cfg, fn, opts = {}) {
  const { browser, page } = await launchBrowser(cfg, opts);
  try {
    return await fn({
      browser,
      page,
      proxy: opts.proxy || null,
      fingerprint: opts.fingerprint || null,
      stealth: opts.stealth || null,
    });
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
