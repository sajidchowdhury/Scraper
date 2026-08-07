'use strict';

/**
 * src/stealth-patches.js — Phase 2.5 (Stealth Hardening)
 *
 * Custom Maps-specific stealth overrides applied via context.addInitScript,
 * COMPLEMENTARY to the Phase 2.4 fingerprint module. The two modules address
 * DIFFERENT detection surfaces:
 *
 *   Phase 2.4 fingerprint  → who the browser CLAIMS to be
 *                            (UA, platform, viewport, timezone, WebGL vendor,
 *                             canvas noise — the "identity" surface)
 *
 *   Phase 2.5 stealth      → whether the browser LOOKS automated
 *                            (navigator.webdriver, chrome.runtime, plugins,
 *                             permissions, outerWidth/Height, headless tells —
 *                             the "automation" surface)
 *
 * A real Chrome user has BOTH a coherent identity AND no automation signals.
 * We need both layers. The two init scripts are designed to coexist: stealth
 * touches properties the fingerprint script never touches, and vice versa.
 * The only overlap is navigator.languages + WebGL getParameter — stealth
 * defends those as a belt-and-suspenders measure in case --noFingerprint is
 * set (Phase 1 behavior), but yields to the fingerprint script's values when
 * both are present (fingerprint runs FIRST via applyFingerprintToContext, so
 * its defineProp calls win; stealth only patches if the property is still
 * missing/wrong).
 *
 * Public API:
 *   buildStealthInitScript({ debug }) → string (injected via addInitScript)
 *   applyStealthPatches(context, { debug, logger }) → Promise<void>
 *   summarizeStealthPatches() → string[] (list of patches, for logging)
 *   STEALTH_LAUNCH_ARGS → string[] (Chromium args for headless evasion)
 *   buildStealthLaunchArgs(cfg) → string[] (args merged with cfg)
 *
 * Patches applied (in order):
 *   1. navigator.webdriver → undefined  (stealth plugin handles this too, but
 *      we belt-and-suspenders it because Google's detection specifically tests
 *      `navigator.webdriver === true` as the #1 bot signal)
 *   2. window.chrome = { runtime: {} }  (headless Chromium lacks the chrome
 *      object entirely; real Chrome has chrome.runtime)
 *   3. navigator.permissions.query → returns 'prompt' for 'notifications'
 *      (headless returns 'denied', which is a tell)
 *   4. navigator.plugins → fake Chrome PDF plugin entries  (headless has
 *      empty plugins.length === 0, which is a tell)
 *   5. navigator.languages → ['en-US', 'en'] fallback  (only if not already
 *      set by the fingerprint script)
 *   6. WebGLRenderingContext.getParameter for UNMASKED_VENDOR/RENDERER →
 *      returns 'Intel Inc.' / 'Intel(R) HD Graphics' fallback  (only if not
 *      already overridden by the fingerprint script)
 *   7. window.outerWidth / outerHeight → set to viewport size  (headless
 *      reports 0, which is a tell)
 *   8. Notification.permission → 'default'  (headless reports 'denied')
 *   9. navigator.vendor → 'Google Inc.'  (headless sometimes reports '')
 *   10. navigator.maxTouchPoints → 0  (desktop, never touch — headless
 *       sometimes leaks non-zero on hybrid devices)
 *
 * Design notes:
 *   - The init script is a STRING (not a closure) for the same reason as the
 *     fingerprint script: Playwright serializes addInitScript functions and
 *     closures over Node-side state don't survive.
 *   - Each patch is individually guarded with `if (!alreadySet)` so it
 *     gracefully coexists with the fingerprint init script AND the
 *     puppeteer-extra-plugin-stealth patches (which also set some of these).
 *   - The debug flag emits console.warn calls from inside the page so the
 *     operator can see exactly which patches applied. Off by default — the
 *     warns would pollute the page console during real scraping.
 */

// ---------------------------------------------------------------------------
// Launch args (Chromium flags for headless detection evasion)
// ---------------------------------------------------------------------------

/**
 * Chromium launch args that reduce headless-detection signals. These are
 * applied IN ADDITION to whatever the caller passes to chromium.launch().
 *
 *   --disable-blink-features=AutomationControlled
 *     The single most important arg. Without it, Chromium sets
 *     `navigator.webdriver = true` and injects the "Chrome is being controlled
 *     by automated software" infobar. With it, both are suppressed at the
 *     Blink (rendering engine) level — much harder to detect than patching
 *     navigator.webdriver after the fact.
 *
 *   --disable-features=AutomationControlled
 *     Companion to the above; disables the feature flag entirely.
 *
 *   --disable-infobars
 *     Removes the "Chrome is being controlled" infobar in headed mode.
 *
 *   --disable-dev-shm-usage
 *     Avoids /dev/shm exhaustion in Docker (not strictly stealth, but
 *     essential for long-running headless sessions — a crash is the loudest
 *     "this is a bot" signal of all).
 *
 *   --no-first-run / --no-default-browser-check
 *     Suppress first-run dialogs that don't appear in real user sessions.
 *
 * Note: --exclude-switches=enable-automation is NOT a Chromium arg — it's a
 * Chrome DevTools Protocol concept. The equivalent in Playwright is to NOT
 * pass `--enable-automation` (which Playwright doesn't by default). We
 * document this here so future maintainers don't go chasing a non-existent
 * flag.
 */
const STEALTH_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=AutomationControlled',
  '--disable-infobars',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-default-browser-check',
];

/**
 * buildStealthLaunchArgs(cfg) → string[]
 *
 * Returns the launch args to merge into chromium.launch({ args }). Includes
 * the STEALTH_LAUNCH_ARGS plus any cfg-driven args (e.g. a custom user-data-dir).
 * Pure — no side effects.
 */
function buildStealthLaunchArgs(cfg) {
  const args = STEALTH_LAUNCH_ARGS.slice();
  // Future: cfg-driven args can be appended here.
  return args;
}

// ---------------------------------------------------------------------------
// Patch list (for logging + tests)
// ---------------------------------------------------------------------------

const STEALTH_PATCHES = [
  { id: 'webdriver', target: 'navigator.webdriver', description: 'Set to undefined (belt-and-suspenders; stealth plugin also handles this)' },
  { id: 'chrome.runtime', target: 'window.chrome.runtime', description: 'Add chrome.runtime object (headless Chromium lacks it)' },
  { id: 'permissions.query', target: 'navigator.permissions.query', description: "Return 'prompt' for notifications (headless returns 'denied')" },
  { id: 'plugins', target: 'navigator.plugins', description: 'Populate with fake Chrome PDF plugin entries (headless has 0)' },
  { id: 'languages', target: 'navigator.languages', description: "Fallback to ['en-US','en'] if fingerprint script didn't set it" },
  { id: 'webgl', target: 'WebGLRenderingContext.getParameter', description: 'Fallback vendor/renderer if fingerprint script didn\'t set them' },
  { id: 'outerSize', target: 'window.outerWidth/outerHeight', description: 'Set to viewport size (headless reports 0)' },
  { id: 'notification.permission', target: 'Notification.permission', description: "Set to 'default' (headless reports 'denied')" },
  { id: 'vendor', target: 'navigator.vendor', description: "Set to 'Google Inc.' (headless sometimes reports '')" },
  { id: 'maxTouchPoints', target: 'navigator.maxTouchPoints', description: 'Set to 0 (desktop, never touch)' },
];

/**
 * summarizeStealthPatches() → string[]
 * Returns the list of patch descriptions (for --stealthDebug logging).
 */
function summarizeStealthPatches() {
  return STEALTH_PATCHES.map((p) => `${p.id}: ${p.description}`);
}

// ---------------------------------------------------------------------------
// Init-script builder
// ---------------------------------------------------------------------------

/**
 * buildStealthInitScript({ debug }) → string
 *
 * Returns a JS source string that, when eval'd in the page BEFORE any site
 * script runs, patches the bot-detection surfaces. Designed to COEXIST with
 * the Phase 2.4 fingerprint init script (which runs first) and the
 * puppeteer-extra-plugin-stealth patches (which also touch some of these).
 *
 * The script is defensive: every patch checks whether the property is already
 * set correctly before patching, so it never fights the fingerprint script.
 *
 * @param {object}  opts
 * @param {boolean} opts.debug  when true, emits console.warn for each patch
 *                              applied (for --stealthDebug). Off by default.
 * @returns {string}  IIFE source string
 */
function buildStealthInitScript(opts = {}) {
  const debug = !!opts.debug;

  return `
(function () {
  'use strict';
  var DEBUG = ${debug};
  function log(msg) { if (DEBUG) { try { console.warn('[stealth] ' + msg); } catch (e) {} } }

  // --- 1. navigator.webdriver → undefined --------------------------------
  // The #1 bot signal. stealth plugin handles this via CDP, but we
  // belt-and-suspenders it in-page in case the plugin missed an edge case
  // (e.g. a worker context).
  try {
    if (navigator.webdriver !== undefined && navigator.webdriver !== false) {
      Object.defineProperty(navigator, 'webdriver', {
        get: function () { return undefined; },
        configurable: true,
      });
      log('patched navigator.webdriver → undefined');
    }
  } catch (e) { log('webdriver patch failed: ' + e.message); }

  // --- 2. window.chrome.runtime ------------------------------------------
  // Headless Chromium lacks the window.chrome object entirely. Real Chrome
  // has chrome.runtime (even on pages without an extension). We add a
  // minimal stub.
  try {
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        // Real chrome.runtime has these; sites check for their existence,
        // not their values. We stub enough to pass existence checks.
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
        connect: function () { return { disconnect: function () {}, onMessage: { addListener: function () {} }, postMessage: function () {} }; },
        sendMessage: function () {},
        id: undefined,
      };
      log('patched window.chrome.runtime');
    }
  } catch (e) { log('chrome.runtime patch failed: ' + e.message); }

  // --- 3. navigator.permissions.query ------------------------------------
  // Headless Chromium returns 'denied' for notifications; real Chrome returns
  // 'prompt'. The 'denied' result is a strong headless tell.
  try {
    if (navigator.permissions && navigator.permissions.query) {
      var origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function (desc) {
        if (desc && desc.name === 'notifications') {
          return Promise.resolve({ state: 'prompt', onchange: null });
        }
        return origQuery(desc);
      };
      log('patched navigator.permissions.query (notifications → prompt)');
    }
  } catch (e) { log('permissions.query patch failed: ' + e.message); }

  // --- 4. navigator.plugins ----------------------------------------------
  // Headless Chromium reports an empty plugin list; real Chrome has the PDF
  // viewer + native client plugins. We stub a realistic plugin array.
  try {
    var fakePlugins = [
      {
        name: 'PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        length: 2,
        0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        1: { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      },
      {
        name: 'Chrome PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        length: 2,
        0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        1: { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      },
      {
        name: 'Chromium PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        length: 2,
        0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        1: { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      },
      {
        name: 'Microsoft Edge PDF Viewer',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        length: 2,
        0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        1: { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      },
      {
        name: 'WebKit built-in PDF',
        filename: 'internal-pdf-viewer',
        description: 'Portable Document Format',
        length: 2,
        0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
        1: { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
      },
    ];
    // Make it look like a PluginArray (has length + numeric indices).
    var pluginArray = { length: fakePlugins.length };
    for (var i = 0; i < fakePlugins.length; i++) {
      pluginArray[i] = fakePlugins[i];
    }
    // Only patch if plugins is empty or missing (fingerprint script may have set it).
    if (!navigator.plugins || navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', {
        get: function () { return pluginArray; },
        configurable: true,
      });
      log('patched navigator.plugins (length=' + fakePlugins.length + ')');
    }
  } catch (e) { log('plugins patch failed: ' + e.message); }

  // --- 5. navigator.languages (fallback) ---------------------------------
  // Only patch if the fingerprint script didn't already set it. We check for
  // the default headless value ['en-US'] (length 1) — real Chrome has at
  // least 2 entries (locale + 'en' fallback).
  try {
    if (!navigator.languages || navigator.languages.length < 2) {
      Object.defineProperty(navigator, 'languages', {
        get: function () { return ['en-US', 'en']; },
        configurable: true,
      });
      log('patched navigator.languages (fallback)');
    }
  } catch (e) { log('languages patch failed: ' + e.message); }

  // --- 6. WebGL vendor/renderer (fallback) -------------------------------
  // Only patch if the fingerprint script didn't already override getParameter.
  // We detect the fingerprint override by checking if getParameter is already
  // wrapped (its toString will mention 'FP.webglVendor' if the fingerprint
  // script patched it).
  try {
    var UNMASKED_VENDOR_WEBGL = 37445;
    var UNMASKED_RENDERER_WEBGL = 37446;
    var origGetParameter = WebGLRenderingContext && WebGLRenderingContext.prototype.getParameter;
    if (origGetParameter && origGetParameter.toString().indexOf('FP.webglVendor') === -1) {
      WebGLRenderingContext.prototype.getParameter = function (param) {
        if (param === UNMASKED_VENDOR_WEBGL) return 'Intel Inc.';
        if (param === UNMASKED_RENDERER_WEBGL) return 'Intel(R) HD Graphics 530';
        return origGetParameter.apply(this, arguments);
      };
      log('patched WebGLRenderingContext.getParameter (fallback)');
    }
    // WebGL2 too.
    if (typeof WebGL2RenderingContext !== 'undefined') {
      var origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      if (origGetParameter2 && origGetParameter2.toString().indexOf('FP.webglVendor') === -1) {
        WebGL2RenderingContext.prototype.getParameter = function (param) {
          if (param === UNMASKED_VENDOR_WEBGL) return 'Intel Inc.';
          if (param === UNMASKED_RENDERER_WEBGL) return 'Intel(R) HD Graphics 530';
          return origGetParameter2.apply(this, arguments);
        };
        log('patched WebGL2RenderingContext.getParameter (fallback)');
      }
    }
  } catch (e) { log('webgl patch failed: ' + e.message); }

  // --- 7. window.outerWidth / outerHeight --------------------------------
  // Headless Chromium reports outerWidth/outerHeight === 0; real Chrome
  // reports the browser window size (≥ viewport). We set them to the
  // viewport size as a sane lower bound.
  try {
    if (window.outerWidth === 0 || window.outerHeight === 0) {
      Object.defineProperty(window, 'outerWidth', {
        get: function () { return window.innerWidth; },
        configurable: true,
      });
      Object.defineProperty(window, 'outerHeight', {
        get: function () { return window.innerHeight + 85; }, // +85 for browser chrome (tabs/toolbar)
        configurable: true,
      });
      log('patched window.outerWidth/outerHeight');
    }
  } catch (e) { log('outerSize patch failed: ' + e.message); }

  // --- 8. Notification.permission ----------------------------------------
  // Headless reports 'denied'; real Chrome reports 'default' (the user hasn't
  // been asked yet). This is a minor tell but easy to patch.
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      Object.defineProperty(Notification, 'permission', {
        get: function () { return 'default'; },
        configurable: true,
      });
      log('patched Notification.permission → default');
    }
  } catch (e) { log('notification.permission patch failed: ' + e.message); }

  // --- 9. navigator.vendor ------------------------------------------------
  // Headless sometimes reports '' instead of 'Google Inc.'. Defensive patch.
  try {
    if (!navigator.vendor || navigator.vendor === '') {
      Object.defineProperty(navigator, 'vendor', {
        get: function () { return 'Google Inc.'; },
        configurable: true,
      });
      log('patched navigator.vendor → Google Inc.');
    }
  } catch (e) { log('vendor patch failed: ' + e.message); }

  // --- 10. navigator.maxTouchPoints --------------------------------------
  // Desktop Chrome reports 0; some hybrid headless setups leak non-zero.
  // We force 0 to match a desktop fingerprint.
  try {
    if (navigator.maxTouchPoints !== 0) {
      Object.defineProperty(navigator, 'maxTouchPoints', {
        get: function () { return 0; },
        configurable: true,
      });
      log('patched navigator.maxTouchPoints → 0');
    }
  } catch (e) { log('maxTouchPoints patch failed: ' + e.message); }

  // Final debug summary.
  if (DEBUG) {
    try {
      log('stealth patches applied. webdriver=' + navigator.webdriver +
          ', chrome.runtime=' + (typeof (window.chrome && window.chrome.runtime)) +
          ', plugins.length=' + (navigator.plugins ? navigator.plugins.length : 'none') +
          ', outerWidth=' + window.outerWidth);
    } catch (e) {}
  }
})();
`;
}

// ---------------------------------------------------------------------------
// Context application
// ---------------------------------------------------------------------------

/**
 * applyStealthPatches(context, { debug, logger }) → Promise<void>
 *
 * Injects the stealth init script into the browser context. Called AFTER
 * applyFingerprintToContext() so the stealth patches can detect (and yield to)
 * the fingerprint script's overrides.
 *
 * Non-fatal: if addInitScript throws, we log a warning and continue. The page
 * still works, just without the stealth patches.
 *
 * @param {object} context   Playwright browser context
 * @param {object} opts
 * @param {boolean} opts.debug  when true, the init script emits console.warn per patch
 * @param {object} opts.logger  optional logger for the "Stealth patches applied" log line
 * @returns {Promise<void>}
 */
async function applyStealthPatches(context, opts = {}) {
  if (!context || typeof context.addInitScript !== 'function') {
    return;
  }
  const log = opts.logger && opts.logger.info ? opts.logger : null;
  const debug = !!opts.debug;
  try {
    await context.addInitScript(buildStealthInitScript({ debug }));
    if (log) {
      log.info(
        `Stealth patches applied (${STEALTH_PATCHES.length} patches${debug ? ', debug on' : ''})`,
        {
          phase: 'browser',
          stealth: {
            patches: STEALTH_PATCHES.length,
            debug,
            patchIds: STEALTH_PATCHES.map((p) => p.id),
          },
        },
      );
    }
  } catch (err) {
    if (log && log.warn) {
      log.warn('Stealth patch injection failed (non-fatal)', {
        error: err.message,
        phase: 'browser',
      });
    }
    // Non-fatal — the page still works, just without stealth patches.
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Init script
  buildStealthInitScript,
  applyStealthPatches,
  // Launch args
  STEALTH_LAUNCH_ARGS,
  buildStealthLaunchArgs,
  // Patch metadata (for logging + tests)
  STEALTH_PATCHES,
  summarizeStealthPatches,
};
