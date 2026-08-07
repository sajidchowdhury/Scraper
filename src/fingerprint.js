'use strict';

/**
 * src/fingerprint.js — Phase 2.4 (Browser Fingerprint Randomization)
 *
 * Generates a randomized but COHERENT browser fingerprint for each session:
 *   - userAgent   (recent desktop Chrome / Firefox / Safari via `user-agents`)
 *   - platform    (derived from the UA — Win32 / MacIntel / Linux x86_64)
 *   - viewport    (coherent with the UA's declared screen size when available)
 *   - screen      (viewport + random "available" extra, like a taskbar)
 *   - timezone    (coherent with locale — de-DE → Europe/Berlin, etc.)
 *   - locale      (matches timezone region)
 *   - language    (locale + fallback chain, e.g. ['de-DE','de','en-US','en'])
 *   - webglVendor / webglRenderer  (always a coherent pair)
 *   - canvasNoise (deterministic seed → sub-pixel noise on canvas reads)
 *   - hardwareConcurrency  (4 / 8 / 12 / 16)
 *   - deviceMemory         (4 / 8 / 16)
 *   - geolocation  (lat/lng coherent with the timezone's region)
 *
 * Coherence is ENFORCED, not documented:
 *   - Windows UA  → platform Win32
 *   - Mac UA      → platform MacIntel
 *   - Linux UA    → platform Linux x86_64
 *   - locale de-DE → timezone ∈ {Europe/Berlin, Europe/Vienna}
 *   - locale en-US → timezone ∈ American zones (NYC/Chicago/LA/Toronto)
 *   - WebGL vendor ↔ renderer always paired (Intel→Intel, NVIDIA→NVIDIA, etc.)
 *
 * Public API:
 *   generateFingerprint({ rng, pickUserAgent, logger, fixed }) → profile | null
 *   buildInitScript(profile)        → string (injected via addInitScript)
 *   applyFingerprintToContext(ctx, profile, { logger }) → Promise<void>
 *   summarizeFingerprint(profile)   → string ("Chrome/131 Win, tz=America/New_York, vp=1920x1080, webgl=Intel")
 *   fingerprintProfileSchema()      → list of fields (for docs / tests)
 *
 * Design notes:
 *   - The generator is PURE given its injected deps (rng, pickUserAgent).
 *     Tests pass a seeded rng to get reproducible fingerprints.
 *   - Canvas noise uses a seeded PRNG (mulberry32) so the same seed always
 *     produces the same per-pixel perturbation — reproducibility matters for
 *     debugging a block event against the exact fingerprint that triggered it.
 *   - The init script is a STRING (not a closure) because Playwright's
 *     addInitScript serializes the function — closures over Node-side state
 *     don't survive. We embed the profile as a JSON literal.
 */

// ---------------------------------------------------------------------------
// Coherence tables
// ---------------------------------------------------------------------------

/**
 * Locale → { timezones, languages, geo: [lat,lng] candidates }
 * Each locale maps to a set of plausible IANA timezones and a representative
 * lat/lng (used for navigator.geolocation spoofing). The language chain is
 * [locale, primary, 'en-US', 'en'] — the en-US/en tail is what real browsers
 * always append as a fallback, so omitting it would itself be a fingerprint.
 */
const LOCALE_PROFILES = {
  'en-US': {
    timezones: ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'America/Toronto', 'America/Denver'],
    geoByTimezone: {
      'America/New_York': { latitude: 40.7128, longitude: -74.006 },
      'America/Chicago': { latitude: 41.8781, longitude: -87.6298 },
      'America/Los_Angeles': { latitude: 34.0522, longitude: -118.2437 },
      'America/Toronto': { latitude: 43.6532, longitude: -79.3832 },
      'America/Denver': { latitude: 39.7392, longitude: -104.9903 },
    },
    languages: ['en-US', 'en'],
  },
  'en-GB': {
    timezones: ['Europe/London'],
    geoByTimezone: { 'Europe/London': { latitude: 51.5074, longitude: -0.1278 } },
    languages: ['en-GB', 'en'],
  },
  'de-DE': {
    timezones: ['Europe/Berlin', 'Europe/Vienna'],
    geoByTimezone: {
      'Europe/Berlin': { latitude: 52.52, longitude: 13.405 },
      'Europe/Vienna': { latitude: 48.2082, longitude: 16.3738 },
    },
    languages: ['de-DE', 'de', 'en-US', 'en'],
  },
  'fr-FR': {
    timezones: ['Europe/Paris'],
    geoByTimezone: { 'Europe/Paris': { latitude: 48.8566, longitude: 2.3522 } },
    languages: ['fr-FR', 'fr', 'en-US', 'en'],
  },
  'es-ES': {
    timezones: ['Europe/Madrid'],
    geoByTimezone: { 'Europe/Madrid': { latitude: 40.4168, longitude: -3.7038 } },
    languages: ['es-ES', 'es', 'en-US', 'en'],
  },
  'en-AU': {
    timezones: ['Australia/Sydney', 'Australia/Melbourne'],
    geoByTimezone: {
      'Australia/Sydney': { latitude: -33.8688, longitude: 151.2093 },
      'Australia/Melbourne': { latitude: -37.8136, longitude: 144.9631 },
    },
    languages: ['en-AU', 'en'],
  },
};

const LOCALE_KEYS = Object.keys(LOCALE_PROFILES);

/**
 * WebGL vendor ↔ renderer pairs. Chrome on Windows/Linux reports the ANGLE
 * wrapper ("Google Inc. (Vendor)") with a renderer string that names the
 * underlying GPU; Chrome on Mac reports "Google Inc." with the actual GPU.
 * We pair them so a vendor/renderer mismatch never leaks.
 */
const WEBGL_PAIRS = [
  {
    vendor: 'Intel Inc.',
    renderers: [
      'Intel(R) UHD Graphics 630',
      'Intel(R) Iris(TM) Plus Graphics 640',
      'Intel(R) HD Graphics 530',
    ],
  },
  {
    vendor: 'Google Inc. (Intel)',
    renderers: [
      'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ],
  },
  {
    vendor: 'Google Inc. (NVIDIA)',
    renderers: [
      'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ],
  },
  {
    vendor: 'Google Inc. (AMD)',
    renderers: [
      'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
    ],
  },
];

/**
 * Common desktop viewport sizes (width × height). Used as a fallback when the
 * `user-agents` library doesn't supply viewport data for the picked UA.
 * Ordered roughly by market share.
 */
const COMMON_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
];

const HARDWARE_CONCURRENCY_OPTIONS = [4, 8, 12, 16];
const DEVICE_MEMORY_OPTIONS = [4, 8, 16];

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic given a seed
// ---------------------------------------------------------------------------

/**
 * mulberry32(seed) → function returning a float in [0, 1).
 * Deterministic for the same seed. Used for canvas noise so the same
 * fingerprint always perturbs the canvas identically (reproducibility).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hash an arbitrary string into a 32-bit unsigned int (FNV-1a).
 * Used to derive a numeric seed from the UA + locale + a random nonce.
 */
function hashStringToSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Default RNG + UA picker (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Default RNG: Math.random. Tests inject a seeded mulberry32 instead.
 * @returns {number} float in [0, 1)
 */
function defaultRng() {
  return Math.random();
}

/**
 * Default UA picker: uses the `user-agents` library filtered to desktop only.
 * Returns { userAgent, platform, viewport, screen } or null on failure.
 * Injectable so tests can pin a specific UA.
 *
 * @param {function} rng  optional rng for reproducible selection
 * @returns {object|null}
 */
function defaultPickUserAgent(rng) {
  try {
    // Lazy-load so the module loads in environments without user-agents
    // (e.g. minimal test sandboxes). The error is caught and returns null.
    const UserAgent = require('user-agents');
    // Filter to desktop Chrome/Firefox/Safari — mobile UAs have a totally
    // different fingerprint surface (touch, no WebGL, different viewport
    // ranges) and would break coherence with our desktop WebGL pairs.
    const ua = new UserAgent({ deviceCategory: 'desktop' });
    const data = ua.data || {};
    const userAgentStr = ua.toString();
    if (!userAgentStr) return null;
    const platform = derivePlatformFromUA(userAgentStr) || data.platform || 'Win32';
    return {
      userAgent: userAgentStr,
      platform,
      viewport:
        data.viewportWidth && data.viewportHeight
          ? { width: data.viewportWidth, height: data.viewportHeight }
          : null,
      screen:
        data.screenWidth && data.screenHeight
          ? { width: data.screenWidth, height: data.screenHeight }
          : null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Coherence helpers
// ---------------------------------------------------------------------------

/**
 * Derive navigator.platform from a UA string.
 *   Windows UA → 'Win32'   (even on 64-bit — Chrome always reports Win32)
 *   Mac UA     → 'MacIntel'
 *   Linux UA   → 'Linux x86_64'
 * Returns null if the UA doesn't match a known desktop OS.
 */
function derivePlatformFromUA(ua) {
  if (!ua || typeof ua !== 'string') return null;
  if (/Windows NT/.test(ua)) return 'Win32';
  if (/Macintosh|Mac OS X/.test(ua)) return 'MacIntel';
  if (/Linux/.test(ua)) return 'Linux x86_64';
  return null;
}

/**
 * Derive a short OS label from a UA for log summarization.
 *   Windows → 'Win', Mac → 'Mac', Linux → 'Linux'
 */
function deriveOsLabelFromUA(ua) {
  if (!ua || typeof ua !== 'string') return '?';
  if (/Windows NT/.test(ua)) return 'Win';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux';
  return '?';
}

/**
 * Derive a short browser+version label from a UA for log summarization.
 *   'Chrome/131' | 'Firefox/120' | 'Safari/17'
 */
function deriveBrowserLabelFromUA(ua) {
  if (!ua || typeof ua !== 'string') return '?';
  const chrome = ua.match(/Chrome\/(\d+)/);
  if (chrome) return `Chrome/${chrome[1]}`;
  const firefox = ua.match(/Firefox\/(\d+)/);
  if (firefox) return `Firefox/${firefox[1]}`;
  const safari = ua.match(/Version\/(\d+).*Safari/);
  if (safari) return `Safari/${safari[1]}`;
  return '?';
}

/**
 * Pick a random element from an array using the injected rng.
 */
function pickFromArray(arr, rng) {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const idx = Math.floor(rng() * arr.length);
  return arr[Math.min(idx, arr.length - 1)];
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * generateFingerprint({ rng, pickUserAgent, logger, fixed }) → profile | null
 *
 * Returns a coherent fingerprint profile, or null if fingerprinting is
 * disabled (the caller treats null as "use Phase 1 defaults").
 *
 * @param {object}  opts
 * @param {function} opts.rng            optional seeded RNG (default: Math.random)
 * @param {function} opts.pickUserAgent  optional UA picker (default: user-agents lib)
 * @param {object}  opts.logger          optional logger (debug logs)
 * @param {object}  opts.fixed           optional fixed profile (returned as-is, for --fixedFingerprint)
 * @returns {object|null}
 */
function generateFingerprint(opts = {}) {
  const rng = opts.rng || defaultRng;
  const pickUA = opts.pickUserAgent || defaultPickUserAgent;
  const log = opts.logger && opts.logger.debug ? opts.logger : null;

  // --fixedFingerprint: caller supplies a complete profile (for debugging).
  // We still validate coherence and refuse to return an incoherent fixed
  // profile (better to fail loudly than to ship a detectable mismatch).
  if (opts.fixed) {
    const issues = validateCoherence(opts.fixed);
    if (issues.length > 0) {
      if (log) log.warn('Fixed fingerprint failed coherence check', { issues });
      return null;
    }
    return opts.fixed;
  }

  // 1. Pick a locale → timezone → geolocation (the anchor of coherence).
  const locale = pickFromArray(LOCALE_KEYS, rng);
  const localeProfile = LOCALE_PROFILES[locale];
  const timezone = pickFromArray(localeProfile.timezones, rng);
  const geolocation = localeProfile.geoByTimezone[timezone];
  const languages = localeProfile.languages.slice();

  // 2. Pick a user-agent (desktop). Fall back to a sane default if the
  // library is unavailable — the fingerprint is still internally coherent.
  let uaInfo = pickUA(rng);
  if (!uaInfo) {
    // Hardcoded fallback (Windows Chrome 131) — keeps tests + offline runs working.
    uaInfo = {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'Win32',
      viewport: { width: 1920, height: 1080 },
      screen: { width: 1920, height: 1080 },
    };
  }
  const userAgent = uaInfo.userAgent;
  // ALWAYS re-derive platform from the UA — never trust the picker's claim,
  // because a UA/platform mismatch is the single most common detection signal.
  const platform = derivePlatformFromUA(userAgent) || uaInfo.platform || 'Win32';

  // 3. Viewport + screen. Prefer the UA's declared viewport (more coherent),
  // fall back to a random common resolution.
  let viewport = uaInfo.viewport || pickFromArray(COMMON_VIEWPORTS, rng);
  // Defensive copy — we never want to mutate the input.
  viewport = { width: viewport.width, height: viewport.height };

  // Screen = viewport + a little extra (taskbar / dock). Real screens are at
  // least as large as the viewport; the difference is small and noisy.
  let screen = uaInfo.screen
    ? { width: uaInfo.screen.width, height: uaInfo.screen.height }
    : null;
  if (!screen) {
    const extraW = Math.floor(rng() * 80); // 0-79px
    const extraH = Math.floor(rng() * 120); // 0-119px (taskbar)
    screen = { width: viewport.width + extraW, height: viewport.height + extraH };
  }
  // Coherence: screen MUST be ≥ viewport. If the UA picker gave us a screen
  // smaller than the viewport (rare but possible), bump it up.
  if (screen.width < viewport.width) screen.width = viewport.width;
  if (screen.height < viewport.height) screen.height = viewport.height;

  // 4. WebGL vendor ↔ renderer (always a coherent pair).
  const webglPair = pickFromArray(WEBGL_PAIRS, rng);
  const webglVendor = webglPair.vendor;
  const webglRenderer = pickFromArray(webglPair.renderers, rng);

  // 5. Canvas noise seed. The seed is a random 32-bit int, but the noise
  // applied to a given canvas is DETERMINISTIC for that seed (mulberry32).
  // We also derive the seed from the UA+locale so reproducibility tests can
  // re-derive the same noise from the profile's seed field.
  const nonce = Math.floor(rng() * 0xffffffff) >>> 0;
  const seedSource = `${userAgent}|${locale}|${timezone}|${nonce}`;
  const canvasNoiseSeed = hashStringToSeed(seedSource);

  // 6. Hardware concurrency + device memory (independent of UA).
  const hardwareConcurrency = pickFromArray(HARDWARE_CONCURRENCY_OPTIONS, rng);
  const deviceMemory = pickFromArray(DEVICE_MEMORY_OPTIONS, rng);

  const profile = {
    userAgent,
    platform,
    viewport,
    screen,
    timezone,
    locale,
    languages,
    webglVendor,
    webglRenderer,
    canvasNoiseSeed,
    hardwareConcurrency,
    deviceMemory,
    geolocation,
    // Provenance — recorded so the burn/block log can correlate a block event
    // with the exact fingerprint that triggered it. Not injected into the page.
    _meta: {
      browser: deriveBrowserLabelFromUA(userAgent),
      os: deriveOsLabelFromUA(userAgent),
      nonce,
      generatedAt: new Date().toISOString(),
    },
  };

  if (log) {
    log.debug('Fingerprint generated', {
      ua: summarizeFingerprint(profile),
      locale,
      timezone,
      webgl: webglVendor,
    });
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Coherence validation (used by generator + tests + --fixedFingerprint)
// ---------------------------------------------------------------------------

/**
 * validateCoherence(profile) → string[]  (empty array = fully coherent)
 *
 * Returns a list of human-readable coherence violations. Used internally by
 * generateFingerprint() to reject incoherent --fixedFingerprint input, and
 * by the test suite to assert 1000 generated fingerprints have zero issues.
 */
function validateCoherence(profile) {
  const issues = [];
  if (!profile || typeof profile !== 'object') return ['profile is not an object'];

  const { userAgent, platform, locale, timezone, viewport, screen, webglVendor, webglRenderer, languages, geolocation } = profile;

  if (!userAgent || typeof userAgent !== 'string') {
    issues.push('userAgent missing');
  } else {
    // UA → platform coherence
    const derived = derivePlatformFromUA(userAgent);
    if (derived && platform !== derived) {
      issues.push(`UA/platform mismatch: UA says ${derived} but platform is ${platform}`);
    }
  }

  // Locale → timezone coherence
  if (locale && LOCALE_PROFILES[locale]) {
    const lp = LOCALE_PROFILES[locale];
    if (timezone && !lp.timezones.includes(timezone)) {
      issues.push(`locale/timezone mismatch: ${locale} does not map to ${timezone}`);
    }
    // Languages must start with the locale
    if (languages && languages[0] !== locale) {
      issues.push(`languages[0] (${languages[0]}) != locale (${locale})`);
    }
    // Geolocation must match the timezone
    if (timezone && geolocation) {
      const expected = lp.geoByTimezone[timezone];
      if (expected && (expected.latitude !== geolocation.latitude || expected.longitude !== geolocation.longitude)) {
        issues.push(`geolocation does not match timezone ${timezone}`);
      }
    }
  } else if (locale) {
    issues.push(`unknown locale: ${locale}`);
  }

  // Screen ≥ viewport coherence
  if (viewport && screen) {
    if (screen.width < viewport.width) {
      issues.push(`screen.width (${screen.width}) < viewport.width (${viewport.width})`);
    }
    if (screen.height < viewport.height) {
      issues.push(`screen.height (${screen.height}) < viewport.height (${viewport.height})`);
    }
  }

  // WebGL vendor ↔ renderer coherence
  if (webglVendor && webglRenderer) {
    const pair = WEBGL_PAIRS.find((p) => p.vendor === webglVendor);
    if (!pair) {
      issues.push(`unknown webglVendor: ${webglVendor}`);
    } else if (!pair.renderers.includes(webglRenderer)) {
      issues.push(`webglVendor/renderer mismatch: ${webglVendor} does not pair with ${webglRenderer}`);
    }
  }

  // hardwareConcurrency + deviceMemory sanity
  if (profile.hardwareConcurrency && !HARDWARE_CONCURRENCY_OPTIONS.includes(profile.hardwareConcurrency)) {
    issues.push(`hardwareConcurrency out of range: ${profile.hardwareConcurrency}`);
  }
  if (profile.deviceMemory && !DEVICE_MEMORY_OPTIONS.includes(profile.deviceMemory)) {
    issues.push(`deviceMemory out of range: ${profile.deviceMemory}`);
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Init-script builder (injected via context.addInitScript)
// ---------------------------------------------------------------------------

/**
 * buildInitScript(profile) → string
 *
 * Returns a JS source string that, when eval'd in the page BEFORE any site
 * script runs, overrides the fingerprint-exposed surfaces:
 *   - navigator.platform
 *   - navigator.hardwareConcurrency
 *   - navigator.deviceMemory
 *   - navigator.languages
 *   - navigator.language
 *   - WebGLRenderingContext.getParameter (UNMASKED_VENDOR / UNMASKED_RENDERER)
 *   - HTMLCanvasElement.prototype.toDataURL / toBlob (sub-pixel noise)
 *
 * The script is a STRING (not a closure) because Playwright serializes the
 * function and closures over Node-side state don't survive. We embed the
 * profile as a JSON literal at the top.
 */
function buildInitScript(profile) {
  // Embed only the fields the page needs — drop _meta + geolocation (geolocation
  // is set via context.options, not init script).
  const fp = {
    platform: profile.platform,
    hardwareConcurrency: profile.hardwareConcurrency,
    deviceMemory: profile.deviceMemory,
    languages: profile.languages,
    locale: profile.locale,
    webglVendor: profile.webglVendor,
    webglRenderer: profile.webglRenderer,
    canvasNoiseSeed: profile.canvasNoiseSeed,
  };
  const fpJson = JSON.stringify(fp);

  return `
(function () {
  'use strict';
  var FP = ${fpJson};

  // --- navigator overrides -------------------------------------------------
  function defineProp(obj, prop, value) {
    try {
      Object.defineProperty(obj, prop, { get: function () { return value; }, configurable: true });
    } catch (e) {
      // If the property is non-configurable, fall back silently. Real Chrome
      // allows redefining these, so this only fires in weird test contexts.
    }
  }
  defineProp(navigator, 'platform', FP.platform);
  defineProp(navigator, 'hardwareConcurrency', FP.hardwareConcurrency);
  if ('deviceMemory' in navigator) {
    defineProp(navigator, 'deviceMemory', FP.deviceMemory);
  }
  defineProp(navigator, 'languages', FP.languages);
  defineProp(navigator, 'language', FP.languages[0]);

  // --- WebGL vendor/renderer override -------------------------------------
  var UNMASKED_VENDOR_WEBGL = 37445;
  var UNMASKED_RENDERER_WEBGL = 37446;
  var origGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === UNMASKED_VENDOR_WEBGL) return FP.webglVendor;
    if (param === UNMASKED_RENDERER_WEBGL) return FP.webglRenderer;
    return origGetParameter.apply(this, arguments);
  };
  // WebGL2 inherits — override there too.
  if (typeof WebGL2RenderingContext !== 'undefined') {
    var origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (param) {
      if (param === UNMASKED_VENDOR_WEBGL) return FP.webglVendor;
      if (param === UNMASKED_RENDERER_WEBGL) return FP.webglRenderer;
      return origGetParameter2.apply(this, arguments);
    };
  }

  // --- Canvas noise -------------------------------------------------------
  // Seeded PRNG (mulberry32) so the same seed always perturbs the canvas
  // identically. We add a tiny per-pixel perturbation to the red channel
  // (1-bit-ish noise) — enough to change the hash of toDataURL output, not
  // enough to be visually detectable.
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rng = mulberry32(FP.canvasNoiseSeed);
  var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  var origToBlob = HTMLCanvasElement.prototype.toBlob;
  function noiseImageData(canvas) {
    try {
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      var w = canvas.width, h = canvas.height;
      if (w === 0 || h === 0) return;
      var img = ctx.getImageData(0, 0, w, h);
      var d = img.data;
      for (var i = 0; i < d.length; i += 4) {
        // Add 0 or 1 to the red channel — sub-pixel, deterministic per seed.
        d[i] = (d[i] + (rng() > 0.5 ? 1 : 0)) & 0xff;
      }
      ctx.putImageData(img, 0, 0);
    } catch (e) {
      // getImageData throws on a tainted canvas (cross-origin). Skip silently —
      // the original toDataURL still works, just without noise. This matches
      // real-browser behavior (canvas noise only applies to same-origin canvases).
    }
  }
  HTMLCanvasElement.prototype.toDataURL = function () {
    noiseImageData(this);
    return origToDataURL.apply(this, arguments);
  };
  HTMLCanvasElement.prototype.toBlob = function () {
    noiseImageData(this);
    return origToBlob.apply(this, arguments);
  };
})();
`;
}

// ---------------------------------------------------------------------------
// Context application
// ---------------------------------------------------------------------------

/**
 * applyFingerprintToContext(context, profile, { logger }) → Promise<void>
 *
 * Applies the fingerprint to a Playwright browser context:
 *   - viewport, userAgent, locale, timezoneId, geolocation via context options
 *   - navigator/WebGL/canvas overrides via context.addInitScript(buildInitScript)
 *
 * NOTE: viewport / userAgent / locale / timezoneId / geolocation MUST be set
 * at context creation time (they're immutable after the context exists). The
 * caller should pass these into browser.newContext() and only use this helper
 * for the addInitScript injection. We expose buildContextOptions(profile) for
 * the caller to merge into its newContext() call.
 */

/**
 * buildContextOptions(profile) → object
 *
 * Returns the Playwright newContext() options implied by the fingerprint.
 * The caller merges these into its own options (it may also set proxy, etc.).
 */
function buildContextOptions(profile) {
  if (!profile) return {};
  return {
    userAgent: profile.userAgent,
    // Defensive copies — the caller may mutate the returned viewport/geolocation
    // (e.g. Playwright itself may touch the object) and we don't want those
    // mutations to leak back into the profile (which is logged + may be reused
    // for the next worker in Phase 2.8).
    viewport: { width: profile.viewport.width, height: profile.viewport.height },
    locale: profile.locale,
    timezoneId: profile.timezone,
    geolocation: profile.geolocation
      ? { latitude: profile.geolocation.latitude, longitude: profile.geolocation.longitude }
      : undefined,
    permissions: profile.geolocation ? ['geolocation'] : [],
    extraHTTPHeaders: {
      'Accept-Language': profile.languages.join(','),
    },
  };
}

/**
 * applyFingerprintToContext(context, profile, { logger }) → Promise<void>
 *
 * Injects the init script that overrides navigator/WebGL/canvas. Called AFTER
 * the context is created with buildContextOptions() merged in.
 */
async function applyFingerprintToContext(context, profile, opts = {}) {
  if (!profile) return;
  const log = opts.logger && opts.logger.debug ? opts.logger : null;
  try {
    await context.addInitScript(buildInitScript(profile));
    if (log) {
      log.info(`Fingerprint applied (${summarizeFingerprint(profile)})`, {
        phase: 'browser',
        fingerprint: {
          ua: profile._meta.browser,
          os: profile._meta.os,
          timezone: profile.timezone,
          locale: profile.locale,
          viewport: `${profile.viewport.width}x${profile.viewport.height}`,
          webgl: profile.webglVendor,
        },
      });
    }
  } catch (err) {
    if (log) log.warn('Fingerprint injection failed (non-fatal)', { error: err.message });
    // Non-fatal — the page still works, just without the overrides.
  }
}

// ---------------------------------------------------------------------------
// Summarization (for logs)
// ---------------------------------------------------------------------------

/**
 * summarizeFingerprint(profile) → string
 *
 * Short one-line summary for log lines: "Chrome/131 Win, tz=America/New_York, vp=1920x1080, webgl=Intel Inc."
 */
function summarizeFingerprint(profile) {
  if (!profile) return 'none';
  const browser = (profile._meta && profile._meta.browser) || deriveBrowserLabelFromUA(profile.userAgent);
  const os = (profile._meta && profile._meta.os) || deriveOsLabelFromUA(profile.userAgent);
  const vp = profile.viewport ? `${profile.viewport.width}x${profile.viewport.height}` : '?';
  return `${browser} ${os}, tz=${profile.timezone}, vp=${vp}, webgl=${profile.webglVendor}`;
}

// ---------------------------------------------------------------------------
// Schema (for docs / tests)
// ---------------------------------------------------------------------------

/**
 * fingerprintProfileSchema() → string[]
 * Returns the list of canonical profile fields (excluding _meta).
 */
function fingerprintProfileSchema() {
  return [
    'userAgent',
    'platform',
    'viewport',
    'screen',
    'timezone',
    'locale',
    'languages',
    'webglVendor',
    'webglRenderer',
    'canvasNoiseSeed',
    'hardwareConcurrency',
    'deviceMemory',
    'geolocation',
  ];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Generator
  generateFingerprint,
  validateCoherence,
  // Context application
  buildContextOptions,
  buildInitScript,
  applyFingerprintToContext,
  // Summarization / docs
  summarizeFingerprint,
  fingerprintProfileSchema,
  // Coherence helpers (exported for tests)
  derivePlatformFromUA,
  deriveOsLabelFromUA,
  deriveBrowserLabelFromUA,
  // Tables (exported for tests + external validation)
  LOCALE_PROFILES,
  WEBGL_PAIRS,
  COMMON_VIEWPORTS,
  HARDWARE_CONCURRENCY_OPTIONS,
  DEVICE_MEMORY_OPTIONS,
  // PRNG utilities
  mulberry32,
  hashStringToSeed,
};
