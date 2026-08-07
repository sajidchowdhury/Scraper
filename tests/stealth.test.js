'use strict';

/**
 * tests/stealth.test.js — Phase 2.5 (Stealth Hardening)
 *
 * Coverage:
 *   - buildStealthInitScript() returns a non-empty IIFE string
 *   - The init script contains overrides for all 10 bot-detection surfaces:
 *     webdriver, chrome.runtime, permissions.query, plugins, languages,
 *     webgl, outerWidth/Height, Notification.permission, vendor, maxTouchPoints
 *   - The init script, when eval'd in a stub page, ACTUALLY overrides:
 *       navigator.webdriver → undefined
 *       window.chrome.runtime → exists (object)
 *       navigator.permissions.query({name:'notifications'}) → 'prompt'
 *       navigator.plugins.length → > 0
 *       window.outerWidth / outerHeight → > 0
 *       Notification.permission → 'default'
 *       navigator.vendor → 'Google Inc.'
 *       navigator.maxTouchPoints → 0
 *   - The init script COEXISTS with the Phase 2.4 fingerprint script:
 *       when the fingerprint script already set navigator.languages +
 *       WebGL getParameter, the stealth script yields (doesn't double-patch)
 *   - applyStealthPatches() calls context.addInitScript with the script
 *   - applyStealthPatches() is a no-op for null context
 *   - applyStealthPatches() survives addInitScript throwing (non-fatal)
 *   - applyStealthPatches() logs the patch count when logger provided
 *   - --stealth off disables all patches (verified via buildStealthInitScript
 *     not being called — integration tested via config)
 *   - --stealthDebug enables console.warn per patch (verified via debug flag
 *     in the init script)
 *   - STEALTH_LAUNCH_ARGS includes --disable-blink-features=AutomationControlled
 *   - buildStealthLaunchArgs(cfg) returns the expected args
 *   - STEALTH_PATCHES has 10 entries with id/target/description
 *   - summarizeStealthPatches() returns a string[] of descriptions
 *
 * Run: bun test tests/stealth.test.js
 */

const {
  buildStealthInitScript,
  applyStealthPatches,
  STEALTH_LAUNCH_ARGS,
  buildStealthLaunchArgs,
  STEALTH_PATCHES,
  summarizeStealthPatches,
} = require('../src/stealth-patches');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a stub "page" environment with the bot-detection surfaces a real
 * headless Chromium would expose. The init script is eval'd against this
 * stub so we can assert the patches took effect.
 *
 * The stub is intentionally minimal — we only need the properties the stealth
 * script touches. Anything else would require JSDOM (not installed) and
 * wouldn't add test coverage.
 */
function makeStubPage(overrides = {}) {
  const navigator = {
    webdriver: true,
    plugins: { length: 0 },
    languages: ['en-US'],
    language: 'en-US',
    vendor: '',
    maxTouchPoints: 1,
    // Phase 2.4 fingerprint script checks `if ('deviceMemory' in navigator)`
    // before patching — so the stub must have these properties present.
    platform: 'OriginalPlatform',
    hardwareConcurrency: 2,
    deviceMemory: 2,
    permissions: {
      query: () => Promise.resolve({ state: 'denied', onchange: null }),
    },
    ...overrides.navigator,
  };
  const window = {
    outerWidth: 0,
    outerHeight: 0,
    innerWidth: 1920,
    innerHeight: 1080,
    chrome: undefined,
    ...overrides.window,
  };
  const Notification = { permission: 'denied', ...overrides.Notification };
  function WebGLRenderingContextStub() {}
  WebGLRenderingContextStub.prototype.getParameter = function () {
    return null;
  };
  function WebGL2RenderingContextStub() {}
  WebGL2RenderingContextStub.prototype.getParameter = function () {
    return null;
  };
  function HTMLCanvasElementStub() {}
  HTMLCanvasElementStub.prototype.toDataURL = function () {
    return 'data:image/png;base64,ORIGINAL';
  };

  return {
    navigator,
    window,
    Notification,
    WebGLRenderingContext: WebGLRenderingContextStub,
    WebGL2RenderingContext: WebGL2RenderingContextStub,
    HTMLCanvasElement: HTMLCanvasElementStub,
    console: { warn: () => {} },
    Object,
    Math,
    Promise,
  };
}

/**
 * Eval the stealth init script in a stub page sandbox.
 * Returns the sandbox (mutated in place) so tests can assert on the result.
 */
function evalStealthInStub(stub, opts = {}) {
  const script = buildStealthInitScript(opts);
  // eslint-disable-next-line no-new-func
  const fn = new Function('sandbox', 'with (sandbox) { ' + script + ' }');
  fn(stub);
  return stub;
}

// ---------------------------------------------------------------------------
// STEALTH_PATCHES metadata
// ---------------------------------------------------------------------------

describe('Phase 2.5 — STEALTH_PATCHES metadata', () => {
  test('has 10 patches (one per bot-detection surface)', () => {
    expect(STEALTH_PATCHES.length).toBe(10);
  });

  test('every patch has id, target, description', () => {
    for (const p of STEALTH_PATCHES) {
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.target).toBe('string');
      expect(p.target.length).toBeGreaterThan(0);
      expect(typeof p.description).toBe('string');
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  test('patch ids are unique', () => {
    const ids = STEALTH_PATCHES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('covers the expected surfaces', () => {
    const ids = STEALTH_PATCHES.map((p) => p.id);
    expect(ids).toContain('webdriver');
    expect(ids).toContain('chrome.runtime');
    expect(ids).toContain('permissions.query');
    expect(ids).toContain('plugins');
    expect(ids).toContain('languages');
    expect(ids).toContain('webgl');
    expect(ids).toContain('outerSize');
    expect(ids).toContain('notification.permission');
    expect(ids).toContain('vendor');
    expect(ids).toContain('maxTouchPoints');
  });

  test('summarizeStealthPatches() returns a string[] matching patch count', () => {
    const summary = summarizeStealthPatches();
    expect(Array.isArray(summary)).toBe(true);
    expect(summary.length).toBe(STEALTH_PATCHES.length);
    for (const line of summary) {
      expect(typeof line).toBe('string');
      expect(line.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// STEALTH_LAUNCH_ARGS
// ---------------------------------------------------------------------------

describe('Phase 2.5 — STEALTH_LAUNCH_ARGS', () => {
  test('is a non-empty string[]', () => {
    expect(Array.isArray(STEALTH_LAUNCH_ARGS)).toBe(true);
    expect(STEALTH_LAUNCH_ARGS.length).toBeGreaterThan(0);
    for (const arg of STEALTH_LAUNCH_ARGS) {
      expect(typeof arg).toBe('string');
      expect(arg.startsWith('--')).toBe(true);
    }
  });

  test('includes --disable-blink-features=AutomationControlled (the #1 anti-detection arg)', () => {
    expect(STEALTH_LAUNCH_ARGS).toContain('--disable-blink-features=AutomationControlled');
  });

  test('includes --disable-infobars', () => {
    expect(STEALTH_LAUNCH_ARGS).toContain('--disable-infobars');
  });

  test('includes --disable-dev-shm-usage (Docker stability)', () => {
    expect(STEALTH_LAUNCH_ARGS).toContain('--disable-dev-shm-usage');
  });

  test('includes --no-first-run and --no-default-browser-check', () => {
    expect(STEALTH_LAUNCH_ARGS).toContain('--no-first-run');
    expect(STEALTH_LAUNCH_ARGS).toContain('--no-default-browser-check');
  });

  test('buildStealthLaunchArgs(cfg) returns the same args (pure function)', () => {
    const args = buildStealthLaunchArgs({});
    expect(args).toEqual(STEALTH_LAUNCH_ARGS);
  });

  test('buildStealthLaunchArgs() returns a defensive copy (mutating result does not affect the constant)', () => {
    const args = buildStealthLaunchArgs({});
    args.push('--custom-arg');
    expect(STEALTH_LAUNCH_ARGS).not.toContain('--custom-arg');
  });
});

// ---------------------------------------------------------------------------
// buildStealthInitScript — content
// ---------------------------------------------------------------------------

describe('Phase 2.5 — buildStealthInitScript content', () => {
  test('returns a non-empty string', () => {
    const script = buildStealthInitScript();
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(2000);
  });

  test('is an IIFE (immediately-invoked function expression)', () => {
    const script = buildStealthInitScript();
    expect(script.trim().startsWith('(function')).toBe(true);
    expect(script.trim().endsWith(')();')).toBe(true);
  });

  test('embeds DEBUG=false by default', () => {
    const script = buildStealthInitScript();
    expect(script).toContain('var DEBUG = false');
  });

  test('embeds DEBUG=true when opts.debug', () => {
    const script = buildStealthInitScript({ debug: true });
    expect(script).toContain('var DEBUG = true');
  });

  test('contains navigator.webdriver patch', () => {
    const script = buildStealthInitScript();
    expect(script).toContain("defineProperty(navigator, 'webdriver'");
    expect(script).toContain('return undefined');
  });

  test('contains window.chrome.runtime patch', () => {
    const script = buildStealthInitScript();
    expect(script).toContain('window.chrome');
    expect(script).toContain('chrome.runtime');
  });

  test('contains navigator.permissions.query patch', () => {
    const script = buildStealthInitScript();
    expect(script).toContain('navigator.permissions');
    expect(script).toContain('permissions.query');
    expect(script).toContain("name === 'notifications'");
    expect(script).toContain("'prompt'");
  });

  test('contains navigator.plugins patch with fake PDF entries', () => {
    const script = buildStealthInitScript();
    expect(script).toContain('navigator.plugins');
    expect(script).toContain('PDF Viewer');
    expect(script).toContain('Chrome PDF Viewer');
    expect(script).toContain('application/pdf');
  });

  test('contains navigator.languages fallback patch', () => {
    const script = buildStealthInitScript();
    expect(script).toContain("defineProperty(navigator, 'languages'");
    expect(script).toContain("'en-US', 'en'");
  });

  test('contains WebGL getParameter fallback patch (yields to fingerprint)', () => {
    const script = buildStealthInitScript();
    expect(script).toContain('UNMASKED_VENDOR_WEBGL');
    expect(script).toContain('UNMASKED_RENDERER_WEBGL');
    expect(script).toContain('WebGLRenderingContext.prototype.getParameter');
    expect(script).toContain("indexOf('FP.webglVendor')"); // yields to fingerprint
  });

  test('contains WebGL2RenderingContext patch too', () => {
    const script = buildStealthInitScript();
    expect(script).toContain('WebGL2RenderingContext');
  });

  test('contains window.outerWidth/outerHeight patch', () => {
    const script = buildStealthInitScript();
    expect(script).toContain("defineProperty(window, 'outerWidth'");
    expect(script).toContain("defineProperty(window, 'outerHeight'");
    expect(script).toContain('innerWidth');
    expect(script).toContain('innerHeight');
  });

  test('contains Notification.permission patch', () => {
    const script = buildStealthInitScript();
    expect(script).toContain('Notification');
    expect(script).toContain("'default'");
  });

  test('contains navigator.vendor patch', () => {
    const script = buildStealthInitScript();
    expect(script).toContain("defineProperty(navigator, 'vendor'");
    expect(script).toContain("'Google Inc.'");
  });

  test('contains navigator.maxTouchPoints patch', () => {
    const script = buildStealthInitScript();
    expect(script).toContain("defineProperty(navigator, 'maxTouchPoints'");
  });

  test('debug script emits console.warn calls', () => {
    const script = buildStealthInitScript({ debug: true });
    expect(script).toContain("console.warn('[stealth] '");
    expect(script).toContain('log(');
  });
});

// ---------------------------------------------------------------------------
// buildStealthInitScript — stub-page eval (acceptance criteria)
// ---------------------------------------------------------------------------

describe('Phase 2.5 — buildStealthInitScript stub-page eval (acceptance criteria)', () => {
  test('navigator.webdriver → undefined', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    expect(stub.navigator.webdriver).toBeUndefined();
  });

  test('window.chrome.runtime exists (is an object)', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    expect(stub.window.chrome).toBeDefined();
    expect(typeof stub.window.chrome.runtime).toBe('object');
    expect(stub.window.chrome.runtime).not.toBeNull();
  });

  test('window.chrome.runtime has the expected Chrome runtime properties', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    expect(stub.window.chrome.runtime.OnInstalledReason).toBeDefined();
    expect(stub.window.chrome.runtime.PlatformOs).toBeDefined();
    expect(typeof stub.window.chrome.runtime.connect).toBe('function');
    expect(typeof stub.window.chrome.runtime.sendMessage).toBe('function');
  });

  test('navigator.permissions.query({name:"notifications"}) → "prompt"', async () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    const result = await stub.navigator.permissions.query({ name: 'notifications' });
    expect(result.state).toBe('prompt');
  });

  test('navigator.permissions.query for non-notifications still works (passes through)', async () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    const result = await stub.navigator.permissions.query({ name: 'geolocation' });
    // Original returns 'denied' in the stub — stealth doesn't touch non-notifications.
    expect(result.state).toBe('denied');
  });

  test('navigator.plugins.length > 0 (headless reports 0)', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    expect(stub.navigator.plugins.length).toBeGreaterThan(0);
  });

  test('navigator.plugins has the expected PDF plugin entries', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    // We stubbed 5 plugins (PDF Viewer, Chrome PDF Viewer, Chromium PDF Viewer,
    // Microsoft Edge PDF Viewer, WebKit built-in PDF).
    expect(stub.navigator.plugins.length).toBe(5);
    expect(stub.navigator.plugins[0].name).toBe('PDF Viewer');
    expect(stub.navigator.plugins[1].name).toBe('Chrome PDF Viewer');
  });

  test('navigator.languages has at least 2 entries (fallback)', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    expect(stub.navigator.languages.length).toBeGreaterThanOrEqual(2);
    expect(stub.navigator.languages).toContain('en-US');
    expect(stub.navigator.languages).toContain('en');
  });

  test('WebGL getParameter returns spoofed vendor/renderer (fallback)', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    const gl = new stub.WebGLRenderingContext();
    expect(gl.getParameter(37445)).toBe('Intel Inc.'); // UNMASKED_VENDOR_WEBGL
    expect(gl.getParameter(37446)).toMatch(/Intel/); // UNMASKED_RENDERER_WEBGL
  });

  test('WebGL2 getParameter also returns spoofed vendor', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    const gl2 = new stub.WebGL2RenderingContext();
    expect(gl2.getParameter(37445)).toBe('Intel Inc.');
  });

  test('WebGL non-UNMASKED params still pass through to original getParameter', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    const gl = new stub.WebGLRenderingContext();
    // MAX_TEXTURE_SIZE = 3379 — original returns null in our stub.
    expect(gl.getParameter(3379)).toBeNull();
  });

  test('window.outerWidth > 0 (headless reports 0)', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    expect(stub.window.outerWidth).toBeGreaterThan(0);
  });

  test('window.outerHeight > 0 (headless reports 0)', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    expect(stub.window.outerHeight).toBeGreaterThan(0);
  });

  test('Notification.permission → "default" (headless reports "denied")', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    expect(stub.Notification.permission).toBe('default');
  });

  test('navigator.vendor → "Google Inc." (headless reports "")', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    expect(stub.navigator.vendor).toBe('Google Inc.');
  });

  test('navigator.maxTouchPoints → 0 (desktop, never touch)', () => {
    const stub = makeStubPage();
    evalStealthInStub(stub);
    expect(stub.navigator.maxTouchPoints).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildStealthInitScript — idempotency (doesn't double-patch already-correct values)
// ---------------------------------------------------------------------------

describe('Phase 2.5 — buildStealthInitScript idempotency', () => {
  test('does not patch navigator.webdriver if already undefined', () => {
    const stub = makeStubPage({ navigator: { webdriver: undefined } });
    // Should be a no-op for webdriver (already correct).
    evalStealthInStub(stub);
    expect(stub.navigator.webdriver).toBeUndefined();
  });

  test('does not patch navigator.plugins if already populated', () => {
    const stub = makeStubPage({
      navigator: { plugins: { length: 3, 0: { name: 'Existing' } } },
    });
    evalStealthInStub(stub);
    // Stealth should NOT overwrite — plugins already has length > 0.
    expect(stub.navigator.plugins.length).toBe(3);
    expect(stub.navigator.plugins[0].name).toBe('Existing');
  });

  test('does not patch navigator.languages if already has 2+ entries', () => {
    const stub = makeStubPage({
      navigator: { languages: ['de-DE', 'de', 'en-US', 'en'] },
    });
    evalStealthInStub(stub);
    // Stealth should NOT overwrite — languages already has 2+ entries (set by fingerprint).
    expect(stub.navigator.languages).toEqual(['de-DE', 'de', 'en-US', 'en']);
  });

  test('does not patch navigator.vendor if already "Google Inc."', () => {
    const stub = makeStubPage({ navigator: { vendor: 'Google Inc.' } });
    evalStealthInStub(stub);
    expect(stub.navigator.vendor).toBe('Google Inc.');
  });

  test('does not patch navigator.maxTouchPoints if already 0', () => {
    const stub = makeStubPage({ navigator: { maxTouchPoints: 0 } });
    evalStealthInStub(stub);
    expect(stub.navigator.maxTouchPoints).toBe(0);
  });

  test('does not patch window.outerWidth if already > 0', () => {
    const stub = makeStubPage({ window: { outerWidth: 1920, outerHeight: 1080, innerWidth: 1920, innerHeight: 1080 } });
    evalStealthInStub(stub);
    expect(stub.window.outerWidth).toBe(1920);
    expect(stub.window.outerHeight).toBe(1080);
  });

  test('does not patch Notification.permission if already "default"', () => {
    const stub = makeStubPage({ Notification: { permission: 'default' } });
    evalStealthInStub(stub);
    expect(stub.Notification.permission).toBe('default');
  });

  test('does not patch window.chrome.runtime if already exists', () => {
    const existingRuntime = { existing: true };
    const stub = makeStubPage({ window: { chrome: { runtime: existingRuntime } } });
    evalStealthInStub(stub);
    // Stealth should NOT overwrite — chrome.runtime already exists.
    expect(stub.window.chrome.runtime).toBe(existingRuntime);
  });
});

// ---------------------------------------------------------------------------
// buildStealthInitScript — coexistence with Phase 2.4 fingerprint script
// ---------------------------------------------------------------------------

describe('Phase 2.5 — coexists with Phase 2.4 fingerprint script', () => {
  test('stealth yields to fingerprint for WebGL getParameter', () => {
    // Simulate the fingerprint script having already patched WebGL getParameter.
    // The fingerprint script's getParameter references "FP.webglVendor" in its
    // toString — the stealth script checks for this marker and skips its own patch.
    // Note: the marker must be in actual CODE (not a comment) because Bun's
    // JavaScriptCore strips comments from function.toString(). The real fingerprint
    // script uses `return FP.webglVendor` — we use a string literal to the same effect.
    const stub = makeStubPage();
    stub.WebGLRenderingContext.prototype.getParameter = function (param) {
      var marker = 'FP.webglVendor'; // stealth detects this marker and yields
      if (param === 37445) return 'NVIDIA Corporation';
      if (param === 37446) return 'GeForce RTX 3060';
      return null;
    };

    evalStealthInStub(stub);

    // Stealth should have yielded — the fingerprint's values are preserved.
    const gl = new stub.WebGLRenderingContext();
    expect(gl.getParameter(37445)).toBe('NVIDIA Corporation'); // NOT 'Intel Inc.'
    expect(gl.getParameter(37446)).toBe('GeForce RTX 3060');
  });

  test('stealth + fingerprint applied in sequence → coherent result', () => {
    // Apply the fingerprint script first, then the stealth script.
    const { buildInitScript: buildFpScript } = require('../src/fingerprint');
    const stub = makeStubPage();

    // Use a coherent fingerprint profile for the fingerprint script.
    const fp = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131',
      platform: 'Win32',
      viewport: { width: 1920, height: 1080 },
      screen: { width: 1920, height: 1080 },
      timezone: 'America/New_York',
      locale: 'en-US',
      languages: ['en-US', 'en'],
      webglVendor: 'Intel Inc.',
      webglRenderer: 'Intel(R) UHD Graphics 630',
      canvasNoiseSeed: 42,
      hardwareConcurrency: 8,
      deviceMemory: 8,
      geolocation: { latitude: 40.7128, longitude: -74.006 },
    };

    // Eval fingerprint script first.
    const fpScript = buildFpScript(fp);
    // eslint-disable-next-line no-new-func
    new Function('sandbox', 'with (sandbox) { ' + fpScript + ' }')(stub);

    // Eval stealth script second.
    evalStealthInStub(stub);

    // Both layers should be active:
    // - fingerprint: navigator.platform, hardwareConcurrency, deviceMemory, languages
    expect(stub.navigator.platform).toBe('Win32');
    expect(stub.navigator.hardwareConcurrency).toBe(8);
    expect(stub.navigator.deviceMemory).toBe(8);
    expect(stub.navigator.languages).toEqual(['en-US', 'en']);
    // - fingerprint: WebGL (stealth yielded)
    const gl = new stub.WebGLRenderingContext();
    expect(gl.getParameter(37445)).toBe('Intel Inc.'); // fingerprint's value
    expect(gl.getParameter(37446)).toBe('Intel(R) UHD Graphics 630');
    // - stealth: webdriver, chrome.runtime, plugins, outerWidth, vendor, maxTouchPoints
    expect(stub.navigator.webdriver).toBeUndefined();
    expect(stub.window.chrome.runtime).toBeDefined();
    expect(stub.navigator.plugins.length).toBeGreaterThan(0);
    expect(stub.window.outerWidth).toBeGreaterThan(0);
    expect(stub.navigator.vendor).toBe('Google Inc.');
    expect(stub.navigator.maxTouchPoints).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildStealthInitScript — debug mode
// ---------------------------------------------------------------------------

describe('Phase 2.5 — buildStealthInitScript debug mode', () => {
  test('debug mode emits console.warn for each patch applied', () => {
    const warns = [];
    const stub = makeStubPage();
    stub.console = { warn: (msg) => warns.push(msg) };

    evalStealthInStub(stub, { debug: true });

    // Should have at least one warn per patch that actually applied.
    expect(warns.length).toBeGreaterThan(0);
    // Every warn should be prefixed with [stealth].
    for (const w of warns) {
      expect(w).toContain('[stealth]');
    }
  });

  test('debug mode off (default) emits zero console.warn calls', () => {
    const warns = [];
    const stub = makeStubPage();
    stub.console = { warn: (msg) => warns.push(msg) };

    evalStealthInStub(stub, { debug: false });

    expect(warns.length).toBe(0);
  });

  test('debug mode final summary line includes the patched values', () => {
    const warns = [];
    const stub = makeStubPage();
    stub.console = { warn: (msg) => warns.push(msg) };

    evalStealthInStub(stub, { debug: true });

    const summary = warns.find((w) => w.includes('stealth patches applied'));
    expect(summary).toBeDefined();
    expect(summary).toContain('webdriver=undefined');
    expect(summary).toContain('plugins.length=');
    expect(summary).toContain('outerWidth=');
  });
});

// ---------------------------------------------------------------------------
// applyStealthPatches — integration with a stub context
// ---------------------------------------------------------------------------

describe('Phase 2.5 — applyStealthPatches', () => {
  test('calls context.addInitScript with the stealth script', async () => {
    const addedScripts = [];
    const fakeContext = {
      addInitScript: async (script) => {
        addedScripts.push(script);
      },
    };
    await applyStealthPatches(fakeContext, {});
    expect(addedScripts.length).toBe(1);
    expect(addedScripts[0]).toContain('navigator.webdriver');
    expect(addedScripts[0]).toContain('chrome.runtime');
    expect(addedScripts[0]).toContain('var DEBUG = false');
  });

  test('passes debug flag through to the init script', async () => {
    const addedScripts = [];
    const fakeContext = {
      addInitScript: async (script) => {
        addedScripts.push(script);
      },
    };
    await applyStealthPatches(fakeContext, { debug: true });
    expect(addedScripts[0]).toContain('var DEBUG = true');
  });

  test('no-op for null context', async () => {
    // Should not throw.
    await expect(applyStealthPatches(null, {})).resolves.toBeUndefined();
  });

  test('no-op for context without addInitScript', async () => {
    await expect(applyStealthPatches({}, {})).resolves.toBeUndefined();
  });

  test('survives addInitScript throwing (non-fatal)', async () => {
    const fakeContext = {
      addInitScript: async () => {
        throw new Error('injection blocked');
      },
    };
    const fakeLogger = {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    };
    // Should not throw.
    await expect(
      applyStealthPatches(fakeContext, { logger: fakeLogger }),
    ).resolves.toBeUndefined();
  });

  test('logs the patch count when logger provided', async () => {
    const logs = [];
    const fakeLogger = {
      info: (msg, meta) => logs.push({ msg, meta }),
      warn: () => {},
      debug: () => {},
      error: () => {},
    };
    const fakeContext = { addInitScript: async () => {} };
    await applyStealthPatches(fakeContext, { logger: fakeLogger });
    expect(logs.length).toBe(1);
    expect(logs[0].msg).toContain('Stealth patches applied');
    expect(logs[0].msg).toContain(String(STEALTH_PATCHES.length));
    expect(logs[0].meta.stealth.patches).toBe(STEALTH_PATCHES.length);
    expect(logs[0].meta.phase).toBe('browser');
  });

  test('logs debug flag in the metadata when debug on', async () => {
    const logs = [];
    const fakeLogger = {
      info: (msg, meta) => logs.push({ msg, meta }),
      warn: () => {},
      debug: () => {},
      error: () => {},
    };
    const fakeContext = { addInitScript: async () => {} };
    await applyStealthPatches(fakeContext, { debug: true, logger: fakeLogger });
    expect(logs[0].meta.stealth.debug).toBe(true);
    expect(logs[0].msg).toContain('debug on');
  });

  test('does not log when no logger provided', async () => {
    const fakeContext = { addInitScript: async () => {} };
    // Should not throw — just a silent no-op for logging.
    await expect(applyStealthPatches(fakeContext, {})).resolves.toBeUndefined();
  });

  test('logs warning when addInitScript throws (with logger)', async () => {
    const warns = [];
    const fakeLogger = {
      info: () => {},
      warn: (msg, meta) => warns.push({ msg, meta }),
      debug: () => {},
      error: () => {},
    };
    const fakeContext = {
      addInitScript: async () => {
        throw new Error('injection blocked');
      },
    };
    await applyStealthPatches(fakeContext, { logger: fakeLogger });
    expect(warns.length).toBe(1);
    expect(warns[0].msg).toContain('Stealth patch injection failed');
    expect(warns[0].meta.error).toBe('injection blocked');
  });
});
