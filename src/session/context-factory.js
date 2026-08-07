'use strict';

/**
 * src/session/context-factory.js — Phase 2.7 — Production createContext
 *
 * Wires the session manager's injectable `createContext` to a real function
 * that calls `browser.newContext(opts)` and applies the Phase 2.4 fingerprint
 * + Phase 2.5 stealth patches to the new context.
 *
 * This is the bridge between the session manager (which is browser-agnostic
 * + DI for tests) and the actual Playwright context creation (which needs the
 * fingerprint + stealth modules).
 *
 * Public API:
 *   const factory = createRealContextFactory({ cfg, logger });
 *   const { context, page } = await factory({ browser, proxy, fingerprint });
 */

const { buildContextOptions, applyFingerprintToContext, summarizeFingerprint } = require('../fingerprint');
const { applyStealthPatches, STEALTH_PATCHES } = require('../stealth-patches');
const { pickUserAgent } = require('../antiblock');

/**
 * Create a real createContext function bound to the run's cfg + logger.
 *
 * The returned function:
 *   1. Builds context options from the fingerprint (or Phase 1 defaults).
 *   2. Calls browser.newContext(opts).
 *   3. Applies the fingerprint init script (navigator.platform, WebGL, canvas, ...).
 *   4. Applies the stealth patches (webdriver, chrome.runtime, plugins, ...).
 *   5. Sets the default timeout.
 *   6. Creates a page + returns { context, page }.
 *
 * @param {object} opts { cfg, logger, stealth: {enabled, debug} }
 * @returns {Function} createContext({ browser, proxy, fingerprint }) => { context, page }
 */
function createRealContextFactory(opts = {}) {
  const cfg = opts.cfg;
  const rawLogger = opts.logger || null;
  const stealth = opts.stealth || { enabled: false, debug: false };

  return async function createContext({ browser, proxy, fingerprint } = {}) {
    // 1. Build context options.
    let contextOpts;
    if (fingerprint) {
      contextOpts = buildContextOptions(fingerprint);
    } else {
      // Phase 1 fallback (no fingerprint): pickUserAgent + cfg viewport + en-US.
      contextOpts = {
        userAgent: pickUserAgent(),
        viewport: { width: cfg.viewportWidth, height: cfg.viewportHeight },
        locale: 'en-US',
        timezoneId: 'America/Toronto',
      };
    }

    // 2. Create the context.
    const context = await browser.newContext(contextOpts);

    // 3. Apply fingerprint init script.
    if (fingerprint) {
      await applyFingerprintToContext(context, fingerprint, { logger: rawLogger });
    }

    // 4. Apply stealth patches (after fingerprint, so they yield to its overrides).
    if (stealth && stealth.enabled) {
      await applyStealthPatches(context, { debug: stealth.debug, logger: rawLogger });
    }

    // 5. Default timeout.
    context.setDefaultTimeout(cfg.navTimeoutMs || 60000);

    // 6. Create a page.
    const page = await context.newPage();

    if (rawLogger) {
      rawLogger.debug('Session context-factory: created context', {
        fingerprint: fingerprint ? summarizeFingerprint(fingerprint) : null,
        stealth: stealth.enabled ? STEALTH_PATCHES.length + ' patches' : 'off',
        proxy: proxy ? proxy.id || proxy.server : 'direct',
      });
    }

    return { context, page };
  };
}

module.exports = {
  createRealContextFactory,
};
