'use strict';

/**
 * tests/fingerprint.test.js — Phase 2.4 (Browser Fingerprint Randomization)
 *
 * Coverage:
 *   - generateFingerprint() produces coherent profiles (1000× stress test)
 *   - UA → platform coherence (Windows→Win32, Mac→MacIntel, Linux→Linux x86_64)
 *   - locale → timezone coherence (de-DE → Europe/Berlin|Vienna, en-US → American)
 *   - canvas noise seed determinism (same seed → same noise)
 *   - WebGL vendor ↔ renderer always paired
 *   - validateCoherence() catches every kind of mismatch
 *   - buildContextOptions() returns the right Playwright newContext() options
 *   - buildInitScript() contains navigator/WebGL/canvas overrides
 *   - summarizeFingerprint() format
 *   - mulberry32 / hashStringToSeed determinism
 *   - LOCALE_PROFILES / WEBGL_PAIRS tables well-formed
 *   - generateFingerprint with fixed profile (coherent passes, incoherent fails)
 *   - generateFingerprint with custom rng (reproducibility)
 *   - generateFingerprint with custom pickUserAgent (DI)
 *   - --noFingerprint / profile 'off' returns null (Phase 1 behavior preserved)
 *   - init script actually overrides navigator.platform when eval'd (stub page)
 *
 * Run: bun test tests/fingerprint.test.js
 */

const {
  generateFingerprint,
  validateCoherence,
  buildContextOptions,
  buildInitScript,
  applyFingerprintToContext,
  summarizeFingerprint,
  fingerprintProfileSchema,
  derivePlatformFromUA,
  deriveOsLabelFromUA,
  deriveBrowserLabelFromUA,
  LOCALE_PROFILES,
  WEBGL_PAIRS,
  COMMON_VIEWPORTS,
  HARDWARE_CONCURRENCY_OPTIONS,
  DEVICE_MEMORY_OPTIONS,
  mulberry32,
  hashStringToSeed,
} = require('../src/fingerprint');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LINUX_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// A fully coherent profile for tests that need a known-good baseline.
function coherentProfile(overrides = {}) {
  return {
    userAgent: WIN_UA,
    platform: 'Win32',
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    timezone: 'America/New_York',
    locale: 'en-US',
    languages: ['en-US', 'en'],
    webglVendor: 'Intel Inc.',
    webglRenderer: 'Intel(R) UHD Graphics 630',
    canvasNoiseSeed: 12345,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    geolocation: { latitude: 40.7128, longitude: -74.006 },
    _meta: { browser: 'Chrome/131', os: 'Win', nonce: 1, generatedAt: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

// A seeded RNG for reproducible fingerprints in tests.
function seededRng(seed) {
  return mulberry32(seed);
}

// ---------------------------------------------------------------------------
// Coherence tables — well-formed?
// ---------------------------------------------------------------------------

describe('Phase 2.4 — coherence tables', () => {
  test('LOCALE_PROFILES has the expected locales', () => {
    expect(Object.keys(LOCALE_PROFILES).sort()).toEqual(
      ['de-DE', 'en-AU', 'en-GB', 'en-US', 'es-ES', 'fr-FR'].sort(),
    );
  });

  test('every locale has at least one timezone + matching geolocation', () => {
    for (const [locale, p] of Object.entries(LOCALE_PROFILES)) {
      expect(p.timezones.length).toBeGreaterThan(0);
      expect(p.languages.length).toBeGreaterThan(0);
      expect(p.languages[0]).toBe(locale);
      for (const tz of p.timezones) {
        expect(p.geoByTimezone[tz], `${locale} → ${tz} missing geolocation`).toBeDefined();
        const g = p.geoByTimezone[tz];
        expect(typeof g.latitude).toBe('number');
        expect(typeof g.longitude).toBe('number');
      }
    }
  });

  test('every locale includes en-US/en in its fallback chain (or is itself en-*)', () => {
    for (const [locale, p] of Object.entries(LOCALE_PROFILES)) {
      if (locale.startsWith('en-')) continue; // en locales don't need the en fallback
      expect(p.languages).toContain('en');
    }
  });

  test('WEBGL_PAIRS has 4 vendors, each with ≥2 renderers', () => {
    expect(WEBGL_PAIRS.length).toBe(4);
    for (const pair of WEBGL_PAIRS) {
      expect(pair.vendor).toBeTruthy();
      expect(pair.renderers.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('WEBGL_PAIRS vendors are unique', () => {
    const vendors = WEBGL_PAIRS.map((p) => p.vendor);
    expect(new Set(vendors).size).toBe(vendors.length);
  });

  test('WEBGL_PAIRS renderers are unique within a vendor', () => {
    for (const pair of WEBGL_PAIRS) {
      expect(new Set(pair.renderers).size).toBe(pair.renderers.length);
    }
  });

  test('COMMON_VIEWPORTS has 6+ resolutions, all positive integers', () => {
    expect(COMMON_VIEWPORTS.length).toBeGreaterThanOrEqual(6);
    for (const v of COMMON_VIEWPORTS) {
      expect(v.width).toBeGreaterThan(0);
      expect(v.height).toBeGreaterThan(0);
      expect(Number.isInteger(v.width)).toBe(true);
      expect(Number.isInteger(v.height)).toBe(true);
    }
  });

  test('HARDWARE_CONCURRENCY_OPTIONS is [4, 8, 12, 16]', () => {
    expect(HARDWARE_CONCURRENCY_OPTIONS).toEqual([4, 8, 12, 16]);
  });

  test('DEVICE_MEMORY_OPTIONS is [4, 8, 16]', () => {
    expect(DEVICE_MEMORY_OPTIONS).toEqual([4, 8, 16]);
  });
});

// ---------------------------------------------------------------------------
// derivePlatformFromUA / deriveOsLabelFromUA / deriveBrowserLabelFromUA
// ---------------------------------------------------------------------------

describe('Phase 2.4 — UA → platform derivation', () => {
  test('Windows UA → Win32 (even on Win64 — Chrome always reports Win32)', () => {
    expect(derivePlatformFromUA(WIN_UA)).toBe('Win32');
  });

  test('Mac UA → MacIntel', () => {
    expect(derivePlatformFromUA(MAC_UA)).toBe('MacIntel');
  });

  test('Linux UA → Linux x86_64', () => {
    expect(derivePlatformFromUA(LINUX_UA)).toBe('Linux x86_64');
  });

  test('unknown UA → null', () => {
    expect(derivePlatformFromUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBeNull();
  });

  test('null/undefined/empty → null', () => {
    expect(derivePlatformFromUA(null)).toBeNull();
    expect(derivePlatformFromUA(undefined)).toBeNull();
    expect(derivePlatformFromUA('')).toBeNull();
    expect(derivePlatformFromUA(123)).toBeNull();
  });

  test('OS label derivation', () => {
    expect(deriveOsLabelFromUA(WIN_UA)).toBe('Win');
    expect(deriveOsLabelFromUA(MAC_UA)).toBe('Mac');
    expect(deriveOsLabelFromUA(LINUX_UA)).toBe('Linux');
    expect(deriveOsLabelFromUA('')).toBe('?');
  });

  test('browser label derivation', () => {
    expect(deriveBrowserLabelFromUA(WIN_UA)).toBe('Chrome/131');
    const ffUA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';
    expect(deriveBrowserLabelFromUA(ffUA)).toBe('Firefox/121');
    const safariUA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';
    expect(deriveBrowserLabelFromUA(safariUA)).toBe('Safari/17');
    expect(deriveBrowserLabelFromUA('')).toBe('?');
  });
});

// ---------------------------------------------------------------------------
// PRNG utilities — determinism
// ---------------------------------------------------------------------------

describe('Phase 2.4 — mulberry32 + hashStringToSeed', () => {
  test('mulberry32 is deterministic for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  test('mulberry32 differs for different seeds', () => {
    const a = mulberry32(42);
    const b = mulberry32(43);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  test('mulberry32 returns floats in [0, 1)', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('hashStringToSeed is deterministic', () => {
    expect(hashStringToSeed('hello world')).toBe(hashStringToSeed('hello world'));
  });

  test('hashStringToSeed differs for different inputs', () => {
    expect(hashStringToSeed('hello world')).not.toBe(hashStringToSeed('world hello'));
  });

  test('hashStringToSeed returns a 32-bit unsigned int', () => {
    const h = hashStringToSeed('anything');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

// ---------------------------------------------------------------------------
// validateCoherence — catches every kind of mismatch
// ---------------------------------------------------------------------------

describe('Phase 2.4 — validateCoherence', () => {
  test('coherent profile → zero issues', () => {
    expect(validateCoherence(coherentProfile())).toEqual([]);
  });

  test('UA/platform mismatch caught (Windows UA + MacIntel)', () => {
    const issues = validateCoherence(coherentProfile({ platform: 'MacIntel' }));
    expect(issues.some((s) => s.includes('UA/platform mismatch'))).toBe(true);
  });

  test('UA/platform mismatch caught (Mac UA + Win32)', () => {
    const issues = validateCoherence(coherentProfile({ userAgent: MAC_UA, platform: 'Win32' }));
    expect(issues.some((s) => s.includes('UA/platform mismatch'))).toBe(true);
  });

  test('locale/timezone mismatch caught (en-US + Europe/Berlin)', () => {
    const issues = validateCoherence(coherentProfile({ timezone: 'Europe/Berlin' }));
    expect(issues.some((s) => s.includes('locale/timezone mismatch'))).toBe(true);
  });

  test('locale/timezone mismatch caught (de-DE + America/New_York)', () => {
    const issues = validateCoherence(
      coherentProfile({
        locale: 'de-DE',
        timezone: 'America/New_York',
        languages: ['de-DE', 'de', 'en-US', 'en'],
        geolocation: { latitude: 40.7128, longitude: -74.006 },
      }),
    );
    expect(issues.some((s) => s.includes('locale/timezone mismatch'))).toBe(true);
  });

  test('languages[0] != locale caught', () => {
    const issues = validateCoherence(coherentProfile({ languages: ['de-DE', 'en'] }));
    expect(issues.some((s) => s.includes('languages[0]') && s.includes('locale'))).toBe(true);
  });

  test('geolocation not matching timezone caught', () => {
    const issues = validateCoherence(
      coherentProfile({ geolocation: { latitude: 0, longitude: 0 } }),
    );
    expect(issues.some((s) => s.includes('geolocation does not match'))).toBe(true);
  });

  test('screen < viewport caught (width)', () => {
    const issues = validateCoherence(
      coherentProfile({ screen: { width: 1000, height: 1080 } }),
    );
    expect(issues.some((s) => s.includes('screen.width'))).toBe(true);
  });

  test('screen < viewport caught (height)', () => {
    const issues = validateCoherence(
      coherentProfile({ screen: { width: 1920, height: 500 } }),
    );
    expect(issues.some((s) => s.includes('screen.height'))).toBe(true);
  });

  test('WebGL vendor/renderer mismatch caught (Intel vendor + NVIDIA renderer)', () => {
    const issues = validateCoherence(
      coherentProfile({ webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 ...)' }),
    );
    expect(issues.some((s) => s.includes('webglVendor/renderer mismatch'))).toBe(true);
  });

  test('unknown WebGL vendor caught', () => {
    const issues = validateCoherence(coherentProfile({ webglVendor: 'Fake GPU Co' }));
    expect(issues.some((s) => s.includes('unknown webglVendor'))).toBe(true);
  });

  test('hardwareConcurrency out of range caught', () => {
    const issues = validateCoherence(coherentProfile({ hardwareConcurrency: 7 }));
    expect(issues.some((s) => s.includes('hardwareConcurrency out of range'))).toBe(true);
  });

  test('deviceMemory out of range caught', () => {
    const issues = validateCoherence(coherentProfile({ deviceMemory: 32 }));
    expect(issues.some((s) => s.includes('deviceMemory out of range'))).toBe(true);
  });

  test('unknown locale caught', () => {
    const issues = validateCoherence(coherentProfile({ locale: 'xx-XX' }));
    expect(issues.some((s) => s.includes('unknown locale'))).toBe(true);
  });

  test('missing userAgent caught', () => {
    const issues = validateCoherence(coherentProfile({ userAgent: undefined }));
    expect(issues.some((s) => s.includes('userAgent missing'))).toBe(true);
  });

  test('non-object input caught', () => {
    expect(validateCoherence(null)).toEqual(['profile is not an object']);
    expect(validateCoherence('string')).toEqual(['profile is not an object']);
  });
});

// ---------------------------------------------------------------------------
// generateFingerprint — coherence stress test (1000× per acceptance criteria)
// ---------------------------------------------------------------------------

describe('Phase 2.4 — generateFingerprint coherence (1000× stress)', () => {
  test('1000 generated fingerprints have zero incoherent combinations', () => {
    let totalIssues = 0;
    const seenUAs = new Set();
    for (let i = 0; i < 1000; i++) {
      const fp = generateFingerprint();
      expect(fp).not.toBeNull();
      const issues = validateCoherence(fp);
      if (issues.length > 0) {
        // Fail loudly with the first incoherent profile so debugging is easy.
        // (Avoid 1000× console noise — only show the first failure.)
        if (totalIssues === 0) {
          console.error('First incoherent fingerprint:', JSON.stringify(fp, null, 2));
          console.error('Issues:', issues);
        }
        totalIssues += issues.length;
      }
      seenUAs.add(fp.userAgent);
    }
    expect(totalIssues).toBe(0);
    // Sanity: we saw more than one UA across 1000 runs (else rng is broken).
    expect(seenUAs.size).toBeGreaterThan(1);
  });

  test('UA says Windows → platform is Win32 (across 200 runs)', () => {
    for (let i = 0; i < 200; i++) {
      const fp = generateFingerprint();
      if (fp.userAgent.includes('Windows NT')) {
        expect(fp.platform).toBe('Win32');
      }
    }
  });

  test('UA says Mac → platform is MacIntel (across 200 runs)', () => {
    let sawMac = false;
    for (let i = 0; i < 500; i++) {
      const fp = generateFingerprint();
      if (/Macintosh|Mac OS X/.test(fp.userAgent)) {
        sawMac = true;
        expect(fp.platform).toBe('MacIntel');
      }
    }
    // We can't guarantee we'll see a Mac UA in 500 runs (user-agents lib is
    // random), but if we do, the assertion above must hold. If we never see
    // one, the test still passes (no assertion violated).
    // Log whether we saw one, for test diagnostics.
    if (!sawMac) console.log('Note: no Mac UA seen in 500 runs (acceptable — RNG-dependent)');
  });

  test('UA says Linux → platform is Linux x86_64 (across 200 runs)', () => {
    let sawLinux = false;
    for (let i = 0; i < 500; i++) {
      const fp = generateFingerprint();
      if (/X11; Linux/.test(fp.userAgent)) {
        sawLinux = true;
        expect(fp.platform).toBe('Linux x86_64');
      }
    }
    if (!sawLinux) console.log('Note: no Linux UA seen in 500 runs (acceptable — RNG-dependent)');
  });

  test('locale de-DE → timezone is European (Berlin or Vienna)', () => {
    let sawDe = false;
    for (let i = 0; i < 2000; i++) {
      const fp = generateFingerprint();
      if (fp.locale === 'de-DE') {
        sawDe = true;
        expect(['Europe/Berlin', 'Europe/Vienna']).toContain(fp.timezone);
      }
    }
    if (!sawDe) console.log('Note: no de-DE locale seen in 2000 runs (acceptable — RNG-dependent)');
  });

  test('locale en-US → timezone is American', () => {
    let sawEnUs = false;
    for (let i = 0; i < 2000; i++) {
      const fp = generateFingerprint();
      if (fp.locale === 'en-US') {
        sawEnUs = true;
        expect(fp.timezone.startsWith('America/')).toBe(true);
      }
    }
    if (!sawEnUs) console.log('Note: no en-US locale seen in 2000 runs (acceptable — RNG-dependent)');
  });

  test('every generated profile has all canonical fields', () => {
    const schema = fingerprintProfileSchema();
    for (let i = 0; i < 100; i++) {
      const fp = generateFingerprint();
      for (const field of schema) {
        expect(fp[field], `missing field ${field}`).toBeDefined();
      }
    }
  });

  test('every generated profile has a _meta with browser + os labels', () => {
    for (let i = 0; i < 50; i++) {
      const fp = generateFingerprint();
      expect(fp._meta).toBeDefined();
      expect(fp._meta.browser).toBeTruthy();
      expect(fp._meta.os).toBeTruthy();
      expect(fp._meta.nonce).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// generateFingerprint — reproducibility with custom rng + pickUserAgent
// ---------------------------------------------------------------------------

describe('Phase 2.4 — generateFingerprint reproducibility + DI', () => {
  test('same seeded rng → same fingerprint (reproducibility)', () => {
    const fp1 = generateFingerprint({ rng: seededRng(42) });
    const fp2 = generateFingerprint({ rng: seededRng(42) });
    // The user-agents lib uses Math.random internally (not our rng), so the
    // UA may differ. But everything WE control (locale, timezone, viewport,
    // WebGL, hwConcurrency, deviceMemory) must match.
    expect(fp1.locale).toBe(fp2.locale);
    expect(fp1.timezone).toBe(fp2.timezone);
    expect(fp1.webglVendor).toBe(fp2.webglVendor);
    expect(fp1.webglRenderer).toBe(fp2.webglRenderer);
    expect(fp1.hardwareConcurrency).toBe(fp2.hardwareConcurrency);
    expect(fp1.deviceMemory).toBe(fp2.deviceMemory);
  });

  test('custom pickUserAgent is honored (DI)', () => {
    const macPicker = () => ({
      userAgent: MAC_UA,
      platform: 'MacIntel',
      viewport: { width: 1440, height: 900 },
      screen: { width: 1440, height: 900 },
    });
    const fp = generateFingerprint({ pickUserAgent: macPicker, rng: seededRng(1) });
    expect(fp.userAgent).toBe(MAC_UA);
    expect(fp.platform).toBe('MacIntel');
    expect(fp.viewport).toEqual({ width: 1440, height: 900 });
    // Coherence still holds.
    expect(validateCoherence(fp)).toEqual([]);
  });

  test('pickUserAgent returning null falls back to hardcoded Windows Chrome', () => {
    const fp = generateFingerprint({
      pickUserAgent: () => null,
      rng: seededRng(1),
    });
    expect(fp).not.toBeNull();
    expect(fp.userAgent).toContain('Windows NT');
    expect(fp.platform).toBe('Win32');
    expect(validateCoherence(fp)).toEqual([]);
  });

  test('pickUserAgent without viewport data falls back to COMMON_VIEWPORTS', () => {
    const minimalPicker = () => ({
      userAgent: WIN_UA,
      platform: 'Win32',
      viewport: null,
      screen: null,
    });
    const fp = generateFingerprint({ pickUserAgent: minimalPicker, rng: seededRng(7) });
    expect(fp.viewport).toBeDefined();
    expect(fp.viewport.width).toBeGreaterThan(0);
    expect(fp.viewport.height).toBeGreaterThan(0);
    // Screen derived from viewport + extras, must be ≥ viewport.
    expect(fp.screen.width).toBeGreaterThanOrEqual(fp.viewport.width);
    expect(fp.screen.height).toBeGreaterThanOrEqual(fp.viewport.height);
    expect(validateCoherence(fp)).toEqual([]);
  });

  test('pickUserAgent with screen < viewport is corrected (coherence enforced)', () => {
    const badPicker = () => ({
      userAgent: WIN_UA,
      platform: 'Win32',
      viewport: { width: 1920, height: 1080 },
      screen: { width: 1000, height: 500 }, // smaller than viewport
    });
    const fp = generateFingerprint({ pickUserAgent: badPicker, rng: seededRng(1) });
    // Generator bumps screen up to viewport (coherence enforced, not just documented).
    expect(fp.screen.width).toBeGreaterThanOrEqual(fp.viewport.width);
    expect(fp.screen.height).toBeGreaterThanOrEqual(fp.viewport.height);
    expect(validateCoherence(fp)).toEqual([]);
  });

  test('languages chain always starts with locale and includes en fallback', () => {
    for (let i = 0; i < 200; i++) {
      const fp = generateFingerprint();
      expect(fp.languages[0]).toBe(fp.locale);
      if (!fp.locale.startsWith('en-')) {
        expect(fp.languages).toContain('en');
      }
    }
  });

  test('geolocation matches the timezone region', () => {
    for (let i = 0; i < 200; i++) {
      const fp = generateFingerprint();
      const lp = LOCALE_PROFILES[fp.locale];
      const expected = lp.geoByTimezone[fp.timezone];
      expect(fp.geolocation.latitude).toBe(expected.latitude);
      expect(fp.geolocation.longitude).toBe(expected.longitude);
    }
  });

  test('canvasNoiseSeed is a 32-bit unsigned int', () => {
    for (let i = 0; i < 100; i++) {
      const fp = generateFingerprint();
      expect(Number.isInteger(fp.canvasNoiseSeed)).toBe(true);
      expect(fp.canvasNoiseSeed).toBeGreaterThanOrEqual(0);
      expect(fp.canvasNoiseSeed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

// ---------------------------------------------------------------------------
// generateFingerprint — fixed profile (–fixedFingerprint)
// ---------------------------------------------------------------------------

describe('Phase 2.4 — generateFingerprint with fixed profile', () => {
  test('coherent fixed profile returned as-is', () => {
    const fixed = coherentProfile();
    const fp = generateFingerprint({ fixed });
    expect(fp).toEqual(fixed);
  });

  test('incoherent fixed profile (UA/platform mismatch) rejected → null', () => {
    const bad = coherentProfile({ platform: 'MacIntel' }); // Windows UA + MacIntel
    const fp = generateFingerprint({ fixed: bad });
    expect(fp).toBeNull();
  });

  test('incoherent fixed profile (locale/timezone mismatch) rejected → null', () => {
    const bad = coherentProfile({ timezone: 'Europe/Berlin' }); // en-US + Berlin
    const fp = generateFingerprint({ fixed: bad });
    expect(fp).toBeNull();
  });

  test('incoherent fixed profile (WebGL mismatch) rejected → null', () => {
    const bad = coherentProfile({ webglRenderer: 'ANGLE (NVIDIA, ...)' }); // Intel vendor + NVIDIA renderer
    const fp = generateFingerprint({ fixed: bad });
    expect(fp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildContextOptions — Playwright newContext() options
// ---------------------------------------------------------------------------

describe('Phase 2.4 — buildContextOptions', () => {
  test('returns empty object for null profile', () => {
    expect(buildContextOptions(null)).toEqual({});
  });

  test('returns all required Playwright context options', () => {
    const fp = coherentProfile();
    const opts = buildContextOptions(fp);
    expect(opts.userAgent).toBe(fp.userAgent);
    expect(opts.viewport).toEqual(fp.viewport);
    expect(opts.locale).toBe(fp.locale);
    expect(opts.timezoneId).toBe(fp.timezone);
    expect(opts.geolocation).toEqual(fp.geolocation);
    expect(opts.permissions).toContain('geolocation');
  });

  test('Accept-Language header matches the languages chain', () => {
    const fp = coherentProfile({ locale: 'de-DE', languages: ['de-DE', 'de', 'en-US', 'en'] });
    const opts = buildContextOptions(fp);
    expect(opts.extraHTTPHeaders['Accept-Language']).toBe('de-DE,de,en-US,en');
  });

  test('viewport is a defensive copy (mutating result does not affect profile)', () => {
    const fp = coherentProfile();
    const opts = buildContextOptions(fp);
    opts.viewport.width = 1;
    expect(fp.viewport.width).toBe(1920); // unchanged
  });
});

// ---------------------------------------------------------------------------
// buildInitScript — the injected JS
// ---------------------------------------------------------------------------

describe('Phase 2.4 — buildInitScript', () => {
  test('returns a non-empty string', () => {
    const script = buildInitScript(coherentProfile());
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(500);
  });

  test('is an IIFE (immediately-invoked function expression)', () => {
    const script = buildInitScript(coherentProfile());
    expect(script.trim().startsWith('(function')).toBe(true);
    expect(script.trim().endsWith(')();')).toBe(true);
  });

  test('embeds the profile as a JSON literal (FP = {...})', () => {
    const fp = coherentProfile({ platform: 'Win32', hardwareConcurrency: 8 });
    const script = buildInitScript(fp);
    expect(script).toContain('var FP =');
    expect(script).toContain('"platform":"Win32"');
    expect(script).toContain('"hardwareConcurrency":8');
  });

  test('does NOT embed _meta or geolocation (sensitive / not needed in-page)', () => {
    const fp = coherentProfile();
    const script = buildInitScript(fp);
    expect(script).not.toContain('_meta');
    expect(script).not.toContain('geolocation');
  });

  test('overrides navigator.platform', () => {
    const script = buildInitScript(coherentProfile({ platform: 'MacIntel' }));
    expect(script).toContain("defineProp(navigator, 'platform'");
    expect(script).toContain('MacIntel');
  });

  test('overrides navigator.hardwareConcurrency', () => {
    const script = buildInitScript(coherentProfile({ hardwareConcurrency: 12 }));
    expect(script).toContain("defineProp(navigator, 'hardwareConcurrency'");
  });

  test('overrides navigator.deviceMemory', () => {
    const script = buildInitScript(coherentProfile({ deviceMemory: 16 }));
    expect(script).toContain("defineProp(navigator, 'deviceMemory'");
  });

  test('overrides navigator.languages + language', () => {
    const script = buildInitScript(coherentProfile({ languages: ['de-DE', 'de', 'en-US', 'en'] }));
    expect(script).toContain("defineProp(navigator, 'languages'");
    expect(script).toContain("defineProp(navigator, 'language'");
  });

  test('overrides WebGL getParameter for UNMASKED_VENDOR + UNMASKED_RENDERER', () => {
    const script = buildInitScript(coherentProfile());
    expect(script).toContain('UNMASKED_VENDOR_WEBGL');
    expect(script).toContain('UNMASKED_RENDERER_WEBGL');
    expect(script).toContain('WebGLRenderingContext.prototype.getParameter');
  });

  test('overrides WebGL2RenderingContext too', () => {
    const script = buildInitScript(coherentProfile());
    expect(script).toContain('WebGL2RenderingContext');
  });

  test('overrides canvas toDataURL + toBlob with noise', () => {
    const script = buildInitScript(coherentProfile());
    expect(script).toContain('HTMLCanvasElement.prototype.toDataURL');
    expect(script).toContain('HTMLCanvasElement.prototype.toBlob');
    expect(script).toContain('noiseImageData');
    expect(script).toContain('mulberry32');
  });

  test('embeds the canvas noise seed', () => {
    const fp = coherentProfile({ canvasNoiseSeed: 99999 });
    const script = buildInitScript(fp);
    expect(script).toContain('"canvasNoiseSeed":99999');
  });

  test('uses the embedded FP value (not a hardcoded one)', () => {
    // Build two scripts with different platforms → the embedded value differs.
    const winScript = buildInitScript(coherentProfile({ platform: 'Win32' }));
    const macScript = buildInitScript(coherentProfile({ platform: 'MacIntel' }));
    expect(winScript).toContain('"platform":"Win32"');
    expect(macScript).toContain('"platform":"MacIntel"');
    expect(winScript).not.toBe(macScript);
  });
});

// ---------------------------------------------------------------------------
// buildInitScript — actually overrides navigator when eval'd (stub page)
// ---------------------------------------------------------------------------

describe('Phase 2.4 — buildInitScript actually overrides navigator (stub page)', () => {
  // We eval the init script in a fresh sandbox and check the overrides took.
  // This is the closest we can get to a real browser test without launching
  // Chromium. The init script is plain JS with no browser-specific deps at
  // eval time (it only references navigator/WebGLRenderingContext/etc., which
  // we stub).
  function evalInStub(fp) {
    // Minimal stubs for the browser globals the init script touches.
    const navigator = {
      platform: 'OriginalPlatform',
      hardwareConcurrency: 2,
      deviceMemory: 2,
      languages: ['en-US'],
      language: 'en-US',
    };
    // Object.defineProperty must work — Node's navigator is non-configurable,
    // so we use a plain object (which IS configurable).
    const stubGlobals = { navigator };
    // WebGLRenderingContext stub: getParameter returns null by default.
    function WebGLRenderingContextStub() {}
    WebGLRenderingContextStub.prototype.getParameter = function () {
      return null;
    };
    function WebGL2RenderingContextStub() {}
    WebGL2RenderingContextStub.prototype.getParameter = function () {
      return null;
    };
    // HTMLCanvasElement stub: toDataURL returns a fixed string.
    function HTMLCanvasElementStub() {}
    HTMLCanvasElementStub.prototype.toDataURL = function () {
      return 'data:image/png;base64,ORIGINAL';
    };
    HTMLCanvasElementStub.prototype.toBlob = function () {};

    // Build a sandbox with the stubs + a global scope.
    const sandbox = {
      navigator,
      WebGLRenderingContext: WebGLRenderingContextStub,
      WebGL2RenderingContext: WebGL2RenderingContextStub,
      HTMLCanvasElement: HTMLCanvasElementStub,
      Object,
      Math,
      Number,
    };

    const script = buildInitScript(fp);
    // Run the IIFE in the sandbox. We use Function constructor with the
    // sandbox properties exposed as locals via with().
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      'sandbox',
      'with (sandbox) { ' + script + ' }',
    );
    fn(sandbox);
    return sandbox;
  }

  test('navigator.platform is overridden to the profile value', () => {
    const fp = coherentProfile({ platform: 'MacIntel' });
    const sandbox = evalInStub(fp);
    expect(sandbox.navigator.platform).toBe('MacIntel');
  });

  test('navigator.hardwareConcurrency is overridden', () => {
    const fp = coherentProfile({ hardwareConcurrency: 12 });
    const sandbox = evalInStub(fp);
    expect(sandbox.navigator.hardwareConcurrency).toBe(12);
  });

  test('navigator.deviceMemory is overridden', () => {
    const fp = coherentProfile({ deviceMemory: 16 });
    const sandbox = evalInStub(fp);
    expect(sandbox.navigator.deviceMemory).toBe(16);
  });

  test('navigator.languages is overridden to the profile chain', () => {
    const fp = coherentProfile({ languages: ['de-DE', 'de', 'en-US', 'en'] });
    const sandbox = evalInStub(fp);
    expect(sandbox.navigator.languages).toEqual(['de-DE', 'de', 'en-US', 'en']);
    expect(sandbox.navigator.language).toBe('de-DE');
  });

  test('WebGL getParameter returns the spoofed vendor/renderer', () => {
    const fp = coherentProfile({
      webglVendor: 'Google Inc. (NVIDIA)',
      webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 ...)',
    });
    const sandbox = evalInStub(fp);
    const gl = new sandbox.WebGLRenderingContext();
    // UNMASKED_VENDOR_WEBGL = 37445, UNMASKED_RENDERER_WEBGL = 37446
    expect(gl.getParameter(37445)).toBe('Google Inc. (NVIDIA)');
    expect(gl.getParameter(37446)).toBe('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 ...)');
  });

  test('WebGL2 getParameter also returns the spoofed vendor', () => {
    const fp = coherentProfile({ webglVendor: 'Intel Inc.' });
    const sandbox = evalInStub(fp);
    const gl2 = new sandbox.WebGL2RenderingContext();
    expect(gl2.getParameter(37445)).toBe('Intel Inc.');
  });

  test('non-UNMASKED params still pass through to the original getParameter', () => {
    const fp = coherentProfile();
    const sandbox = evalInStub(fp);
    const gl = new sandbox.WebGLRenderingContext();
    // A different param (e.g. MAX_TEXTURE_SIZE = 3379) should call the
    // original getParameter, which returns null in our stub.
    expect(gl.getParameter(3379)).toBeNull();
  });

  test('canvas toDataURL is wrapped (calls noiseImageData then original)', () => {
    const fp = coherentProfile({ canvasNoiseSeed: 42 });
    const sandbox = evalInStub(fp);
    // Create a canvas stub whose getContext returns null (so noiseImageData
    // skips silently — matching real-browser behavior on tainted canvases).
    // The wrapped toDataURL should still return the original value.
    const canvas = new sandbox.HTMLCanvasElement();
    canvas.getContext = () => null;
    // toDataURL is on the prototype, so this works.
    expect(canvas.toDataURL()).toBe('data:image/png;base64,ORIGINAL');
  });
});

// ---------------------------------------------------------------------------
// Canvas noise determinism — same seed → same noise
// ---------------------------------------------------------------------------

describe('Phase 2.4 — canvas noise determinism', () => {
  test('two profiles with the same canvasNoiseSeed apply identical noise', () => {
    // We can't easily test real canvas rendering in unit tests, but we CAN
    // verify that the init script's mulberry32(seed) produces the same
    // sequence → same per-pixel perturbation.
    const seed = 12345;
    const rngA = mulberry32(seed);
    const rngB = mulberry32(seed);
    const seqA = Array.from({ length: 100 }, () => rngA());
    const seqB = Array.from({ length: 100 }, () => rngB());
    expect(seqA).toEqual(seqB);
  });

  test('two profiles with different seeds apply different noise', () => {
    const rngA = mulberry32(1);
    const rngB = mulberry32(2);
    const seqA = Array.from({ length: 100 }, () => rngA());
    const seqB = Array.from({ length: 100 }, () => rngB());
    expect(seqA).not.toEqual(seqB);
  });

  test('canvas noise seed is derived from UA + locale + timezone + nonce', () => {
    // We can't easily assert the exact seed (it depends on hashStringToSeed),
    // but we can assert that the SAME inputs produce the SAME seed.
    const ua = WIN_UA;
    const locale = 'en-US';
    const tz = 'America/New_York';
    const nonce = 42;
    const seedA = hashStringToSeed(`${ua}|${locale}|${tz}|${nonce}`);
    const seedB = hashStringToSeed(`${ua}|${locale}|${tz}|${nonce}`);
    expect(seedA).toBe(seedB);

    // Different nonce → different seed.
    const seedC = hashStringToSeed(`${ua}|${locale}|${tz}|${nonce + 1}`);
    expect(seedA).not.toBe(seedC);
  });
});

// ---------------------------------------------------------------------------
// summarizeFingerprint — log format
// ---------------------------------------------------------------------------

describe('Phase 2.4 — summarizeFingerprint', () => {
  test('returns "none" for null profile', () => {
    expect(summarizeFingerprint(null)).toBe('none');
  });

  test('includes browser label, OS label, timezone, viewport, webgl vendor', () => {
    const fp = coherentProfile();
    const summary = summarizeFingerprint(fp);
    expect(summary).toContain('Chrome/131');
    expect(summary).toContain('Win');
    expect(summary).toContain('America/New_York');
    expect(summary).toContain('1920x1080');
    expect(summary).toContain('Intel Inc.');
  });

  test('format: "Chrome/131 Win, tz=America/New_York, vp=1920x1080, webgl=Intel Inc."', () => {
    const fp = coherentProfile();
    const summary = summarizeFingerprint(fp);
    expect(summary).toMatch(/^Chrome\/131 Win, tz=America\/New_York, vp=1920x1080, webgl=Intel Inc\.$/);
  });

  test('handles a profile without _meta (falls back to deriving from UA)', () => {
    const fp = coherentProfile();
    delete fp._meta;
    const summary = summarizeFingerprint(fp);
    expect(summary).toContain('Chrome/131');
    expect(summary).toContain('Win');
  });
});

// ---------------------------------------------------------------------------
// fingerprintProfileSchema
// ---------------------------------------------------------------------------

describe('Phase 2.4 — fingerprintProfileSchema', () => {
  test('returns all 13 canonical fields', () => {
    const schema = fingerprintProfileSchema();
    expect(schema).toEqual([
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
    ]);
  });

  test('does not include _meta (internal provenance, not a fingerprint field)', () => {
    const schema = fingerprintProfileSchema();
    expect(schema).not.toContain('_meta');
  });
});

// ---------------------------------------------------------------------------
// applyFingerprintToContext — integration with a stub context
// ---------------------------------------------------------------------------

describe('Phase 2.4 — applyFingerprintToContext', () => {
  test('calls context.addInitScript with the init script', async () => {
    let addedScripts = [];
    const fakeContext = {
      addInitScript: async (script) => {
        addedScripts.push(script);
      },
    };
    const fp = coherentProfile();
    await applyFingerprintToContext(fakeContext, fp);
    expect(addedScripts.length).toBe(1);
    expect(addedScripts[0]).toContain('var FP =');
    expect(addedScripts[0]).toContain('"platform":"Win32"');
  });

  test('no-op for null profile (Phase 1 behavior)', async () => {
    let callCount = 0;
    const fakeContext = {
      addInitScript: async () => {
        callCount++;
      },
    };
    await applyFingerprintToContext(fakeContext, null);
    expect(callCount).toBe(0);
  });

  test('logs the fingerprint summary when logger provided', async () => {
    const logs = [];
    const fakeLogger = {
      debug: () => {},
      info: (msg, meta) => logs.push({ msg, meta }),
      warn: () => {},
      error: () => {},
    };
    const fakeContext = { addInitScript: async () => {} };
    const fp = coherentProfile();
    await applyFingerprintToContext(fakeContext, fp, { logger: fakeLogger });
    expect(logs.length).toBe(1);
    expect(logs[0].msg).toContain('Fingerprint applied');
    expect(logs[0].msg).toContain('Chrome/131');
  });

  test('survives addInitScript throwing (non-fatal)', async () => {
    const fakeContext = {
      addInitScript: async () => {
        throw new Error('injection blocked');
      },
    };
    const fakeLogger = {
      debug: () => {},
      info: () => {},
      warn: (msg, meta) => {},
      error: () => {},
    };
    const fp = coherentProfile();
    // Should not throw.
    await expect(
      applyFingerprintToContext(fakeContext, fp, { logger: fakeLogger }),
    ).resolves.toBeUndefined();
  });
});
