'use strict';

/**
 * tests/enrichment-tech-stack.test.js — Phase 3.6 — Website Tech-Stack Detection tests
 *
 * Coverage (per PHASE3_EXECUTION_PLAN.md §3.6 task checklist + acceptance):
 *   - URL normalization + domain extraction
 *   - Header helpers (case-insensitive lookup, cookie parsing)
 *   - HTML extraction (script srcs, generator meta)
 *   - Liveness classification (live / dead / redirected / error)
 *   - fetchWebsite via _setHttp DI stub (coerced URL, opts pass-through, errors)
 *   - detectTechStack signature engine — at least 5 rules across CMS, framework,
 *     commerce, analytics, server/CDN (WordPress, Next.js, Shopify, Google
 *     Analytics, Nginx, Cloudflare, …)
 *   - computeSophisticationScore (0–100, clamped, combo bonuses)
 *   - buildSnapshot shape
 *   - checkWebsiteLiveness (HEAD → 405/501 → GET fallback)
 *   - analyzeWebsite (mutates business, opt-in fetch, error on failure)
 *   - detectTechStackBatch (opt-in fetch, stats shape, empty batch)
 *   - ENRICHMENT_COLUMNS + DETECTION_RULES + CATEGORY_SCORES exports
 *
 * All fetches go through the _setHttp DI seam — zero network I/O.
 *
 * Run: bun test tests/enrichment-tech-stack.test.js
 */

const {
  __version,
  ENRICHMENT_COLUMNS,
  fetchWebsite,
  detectTechStack,
  checkWebsiteLiveness,
  analyzeWebsite,
  detectTechStackBatch,
  normalizeUrl,
  domainOf,
  classifyLiveness,
  parseCookieNames,
  extractScriptSrcs,
  extractGeneratorMeta,
  buildSnapshot,
  computeSophisticationScore,
  lowercaseKeys,
  headerGet,
  DETECTION_RULES,
  CATEGORY_SCORES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  _setHttp,
} = require('../src/enrichment/tech-stack');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fetch result matching the DI-seam fetcher contract. */
function makeFetchResult(overrides) {
  return {
    reachable: true,
    statusCode: 200,
    finalUrl: 'https://example.com/',
    html: '',
    headers: {},
    redirected: false,
    liveness: 'live',
    error: null,
    truncated: false,
    ...overrides,
  };
}

/** Build a stub fetcher that records every call and returns a canned result. */
function makeStub(resultOrFn) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts: opts || {} });
    return typeof resultOrFn === 'function' ? resultOrFn(url, opts || {}) : resultOrFn;
  };
  fn._calls = calls;
  return fn;
}

// Reset the DI seam after every test so stubs never leak between tests.
afterEach(() => _setHttp(null));

// ---------------------------------------------------------------------------
// 1. URL helpers
// ---------------------------------------------------------------------------

describe('Phase 3.6 — normalizeUrl', () => {
  test('strips a single trailing slash from a full URL', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  test('leaves an already-normalized URL and a bare domain untouched', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeUrl('example.com')).toBe('example.com');
  });

  test('returns empty string for null / undefined / empty', () => {
    expect(normalizeUrl(null)).toBe('');
    expect(normalizeUrl(undefined)).toBe('');
    expect(normalizeUrl('')).toBe('');
  });
});

describe('Phase 3.6 — domainOf', () => {
  test('extracts the lowercase hostname from a full URL (with and without www)', () => {
    expect(domainOf('https://www.example.com/path?q=1')).toBe('www.example.com');
    expect(domainOf('https://example.com')).toBe('example.com');
  });

  test('ignores the port and returns null for an unparseable string', () => {
    expect(domainOf('http://example.com:8080/path')).toBe('example.com');
    expect(domainOf('not a url')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 2. Header helpers
// ---------------------------------------------------------------------------

describe('Phase 3.6 — lowercaseKeys / headerGet', () => {
  test('lowercaseKeys lowercases all keys and unwraps single-element arrays', () => {
    expect(lowercaseKeys({ 'Content-Type': 'text/html', 'X-Powered-By': 'Next.js' }))
      .toEqual({ 'content-type': 'text/html', 'x-powered-by': 'Next.js' });
    expect(lowercaseKeys({ 'Set-Cookie': ['a=1'] })).toEqual({ 'set-cookie': 'a=1' });
    expect(lowercaseKeys({ 'Set-Cookie': ['a=1', 'b=2'] })).toEqual({ 'set-cookie': ['a=1', 'b=2'] });
  });

  test('lowercaseKeys returns empty object for null / non-object', () => {
    expect(lowercaseKeys(null)).toEqual({});
    expect(lowercaseKeys(undefined)).toEqual({});
  });

  test('headerGet is case-insensitive and returns the first value for arrays', () => {
    expect(headerGet({ 'content-type': 'text/html' }, 'Content-Type')).toBe('text/html');
    expect(headerGet({ 'set-cookie': ['a=1', 'b=2'] }, 'Set-Cookie')).toBe('a=1');
    expect(headerGet({}, 'x-missing')).toBeUndefined();
    expect(headerGet(null, 'x-missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Cookie / script / generator extraction
// ---------------------------------------------------------------------------

describe('Phase 3.6 — parseCookieNames', () => {
  test('extracts the cookie name from a Set-Cookie header value', () => {
    expect(parseCookieNames({ 'set-cookie': 'session=abc123; Path=/; HttpOnly' }))
      .toEqual(['session']);
    expect(parseCookieNames(lowercaseKeys({ 'Set-Cookie': '_ga=GA1.2.123; Path=/' })))
      .toEqual(['_ga']);
  });

  test('returns an empty array when there is no Set-Cookie header', () => {
    expect(parseCookieNames({})).toEqual([]);
    expect(parseCookieNames(null)).toEqual([]);
  });
});

describe('Phase 3.6 — extractScriptSrcs', () => {
  test('pulls <script src="..."> values — relative, absolute, single + double quotes', () => {
    const html = `
      <script src="/assets/app.js"></script>
      <script src="https://cdn.example.com/lib.js"></script>
      <script src='single-quote.js'></script>
    `;
    expect(extractScriptSrcs(html)).toEqual([
      '/assets/app.js',
      'https://cdn.example.com/lib.js',
      'single-quote.js',
    ]);
  });

  test('returns an empty array for inline-only scripts and non-string input', () => {
    expect(extractScriptSrcs('<script>console.log("inline")</script>')).toEqual([]);
    expect(extractScriptSrcs(null)).toEqual([]);
    expect(extractScriptSrcs('')).toEqual([]);
  });
});

describe('Phase 3.6 — extractGeneratorMeta', () => {
  test('extracts content from both attribute orders', () => {
    expect(extractGeneratorMeta('<meta name="generator" content="WordPress 6.2">'))
      .toBe('WordPress 6.2');
    expect(extractGeneratorMeta('<meta content="Drupal 10" name="generator">'))
      .toBe('Drupal 10');
  });

  test('returns null when there is no generator meta tag', () => {
    expect(extractGeneratorMeta('<meta name="description" content="stuff">')).toBe(null);
    expect(extractGeneratorMeta('')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 4. classifyLiveness
// ---------------------------------------------------------------------------

describe('Phase 3.6 — classifyLiveness', () => {
  test('200–399 same-domain → live', () => {
    expect(classifyLiveness(200, false)).toBe('live');
    expect(classifyLiveness(301, false)).toBe('live'); // same-domain redirect
    expect(classifyLiveness(304, false)).toBe('live');
  });

  test('400–599 same-domain → dead', () => {
    expect(classifyLiveness(404, false)).toBe('dead');
    expect(classifyLiveness(500, false)).toBe('dead');
  });

  test('redirected flag takes precedence over any status code', () => {
    expect(classifyLiveness(301, true)).toBe('redirected');
    expect(classifyLiveness(200, true)).toBe('redirected');
  });

  test('null status (network / timeout failure) → error', () => {
    expect(classifyLiveness(null, false)).toBe('error');
    expect(classifyLiveness(undefined, false)).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// 5. fetchWebsite (DI stub)
// ---------------------------------------------------------------------------

describe('Phase 3.6 — fetchWebsite via _setHttp stub', () => {
  test('calls the stub with the coerced URL (http:// prepended for bare domain)', async () => {
    const stub = makeStub(makeFetchResult());
    _setHttp(stub);
    await fetchWebsite('example.com');
    expect(stub._calls).toHaveLength(1);
    expect(stub._calls[0].url).toBe('http://example.com');
  });

  test('passes opts (timeout / maxRedirects / maxBytes) through to the stub', async () => {
    const stub = makeStub(makeFetchResult());
    _setHttp(stub);
    await fetchWebsite('https://example.com', {
      timeout: 5000,
      maxRedirects: 3,
      maxBytes: 1024,
      userAgent: 'TestBot/1.0',
    });
    expect(stub._calls[0].opts).toMatchObject({
      timeout: 5000,
      maxRedirects: 3,
      maxBytes: 1024,
      userAgent: 'TestBot/1.0',
    });
  });

  test('returns the stub result and catches a throwing stub as an error result', async () => {
    const canned = makeFetchResult({ statusCode: 200, html: '<h1>hi</h1>', liveness: 'live' });
    _setHttp(makeStub(canned));
    const out = await fetchWebsite('https://example.com');
    expect(out).toBe(canned);

    _setHttp(async () => { throw new Error('ECONNREFUSED'); });
    const err = await fetchWebsite('https://example.com');
    expect(err.liveness).toBe('error');
    expect(err.reachable).toBe(false);
    expect(err.error).toContain('ECONNREFUSED');
  });

  test('returns an error result for an empty / invalid website (stub never called)', async () => {
    const stub = makeStub(makeFetchResult());
    _setHttp(stub);
    const out = await fetchWebsite('');
    expect(out.liveness).toBe('error');
    expect(out.reachable).toBe(false);
    expect(stub._calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 6. detectTechStack (signature engine)
// ---------------------------------------------------------------------------

describe('Phase 3.6 — detectTechStack detection rules', () => {
  test('detects WordPress (CMS) from generator meta + wp-content asset paths', async () => {
    const html = `<html><head><meta name="generator" content="WordPress 6.2"></head>
      <body><script src="/wp-content/themes/twentytwo/app.js"></script></body></html>`;
    _setHttp(makeStub(makeFetchResult({ html })));
    const r = await detectTechStack('https://wp-site.com');
    expect(r.technologies.map((t) => t.name)).toContain('WordPress');
    expect(r.cms).toBe('WordPress');
  });

  test('detects Next.js (framework) from the __NEXT_DATA__ global', async () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>`;
    _setHttp(makeStub(makeFetchResult({ html })));
    const r = await detectTechStack('https://next-site.com');
    expect(r.technologies.map((t) => t.name)).toContain('Next.js');
    expect(r.framework).toBe('Next.js');
  });

  test('detects Shopify (ecommerce) from cdn.shopify.com assets', async () => {
    const html = `<link rel="stylesheet" href="https://cdn.shopify.com/s/files/main.css">`;
    _setHttp(makeStub(makeFetchResult({ html })));
    const r = await detectTechStack('https://shop.com');
    expect(r.technologies.map((t) => t.name)).toContain('Shopify');
    expect(r.ecommerce).toBe('Shopify');
  });

  test('detects Google Analytics (analytics) from the gtag/js GA4 snippet', async () => {
    const html = `<script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script>
      <script>gtag('config', 'G-TEST');</script>`;
    _setHttp(makeStub(makeFetchResult({ html })));
    const r = await detectTechStack('https://site.com');
    expect(r.technologies.map((t) => t.name)).toContain('Google Analytics');
    expect(r.analytics).toContain('Google Analytics');
  });

  test('detects Nginx (server) and Cloudflare (CDN) from response headers', async () => {
    _setHttp(makeStub(makeFetchResult({ headers: { server: 'cloudflare' } })));
    const r1 = await detectTechStack('https://cf-site.com');
    expect(r1.technologies.map((t) => t.name)).toContain('Cloudflare');
    expect(r1.cdn).toBe('Cloudflare');

    _setHttp(makeStub(makeFetchResult({ headers: { server: 'nginx/1.18.0' } })));
    const r2 = await detectTechStack('https://nginx-site.com');
    expect(r2.technologies.map((t) => t.name)).toContain('Nginx');
    const nginx = r2.technologies.find((t) => t.name === 'Nginx');
    expect(nginx.category).toBe('server');
  });

  test('kitchen-sink page detects 5+ technologies across 5+ categories', async () => {
    const html = `<html><head>
      <meta name="generator" content="WordPress 6.2">
      <link rel="stylesheet" href="https://cdn.shopify.com/s/files/main.css">
      <script src="/wp-content/themes/app/jquery-3.6.0.min.js"></script>
      <script async src="https://www.googletagmanager.com/gtag/js?id=G-TEST"></script>
      <script>gtag('config', 'G-TEST');</script>
      <script src="https://cdn.tailwindcss.com"></script>
      <script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>
      </head><body>
      <div id="root" data-reactroot></div>
      </body></html>`;
    _setHttp(makeStub(makeFetchResult({
      html,
      headers: { server: 'nginx/1.18.0' },
    })));
    const r = await detectTechStack('https://kitchen-sink.com');
    const names = r.technologies.map((t) => t.name);
    // CMS + framework + commerce + frontend + analytics + server — 6 categories.
    expect(names).toContain('WordPress');
    expect(names).toContain('Next.js');
    expect(names).toContain('Shopify');
    expect(names).toContain('Google Analytics');
    expect(names).toContain('Nginx');
    const categories = new Set(r.technologies.map((t) => t.category));
    expect(categories.size).toBeGreaterThanOrEqual(5);
    expect(r.sophisticationScore).toBeGreaterThan(0);
  });

  test('technology items have {name, category, confidence, evidence} shape', async () => {
    _setHttp(makeStub(makeFetchResult({ headers: { server: 'nginx/1.18.0' } })));
    const r = await detectTechStack('https://site.com');
    const item = r.technologies.find((t) => t.name === 'Nginx');
    expect(item).toEqual(expect.objectContaining({
      name: 'Nginx',
      category: 'server',
      confidence: expect.any(Number),
      evidence: expect.any(String),
    }));
    expect(item.confidence).toBeGreaterThan(0);
    expect(item.evidence.length).toBeGreaterThan(0);
  });

  test('returns error result with no technologies when the fetch fails', async () => {
    _setHttp(makeStub(makeFetchResult({
      reachable: false, statusCode: null, liveness: 'error', error: 'timeout',
    })));
    const r = await detectTechStack('https://dead-site.com');
    expect(r.liveness).toBe('error');
    expect(r.technologies).toEqual([]);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  test('returns error result for an empty website (stub never called)', async () => {
    const stub = makeStub(makeFetchResult());
    _setHttp(stub);
    const r = await detectTechStack('');
    expect(r.url).toBe('');
    expect(r.technologies).toEqual([]);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(stub._calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. computeSophisticationScore
// ---------------------------------------------------------------------------

describe('Phase 3.6 — computeSophisticationScore', () => {
  test('returns 0 for an empty / null technology list', () => {
    expect(computeSophisticationScore([])).toBe(0);
    expect(computeSophisticationScore(null)).toBe(0);
  });

  test('a single server tech scores low; diverse stack scores much higher', () => {
    const low = computeSophisticationScore([{ name: 'Nginx', category: 'server' }]);
    expect(low).toBe(3);
    const high = computeSophisticationScore([
      { name: 'Next.js', category: 'framework' },
      { name: 'WordPress', category: 'cms' },
      { name: 'Shopify', category: 'ecommerce' },
      { name: 'Cloudflare', category: 'cdn' },
      { name: 'Nginx', category: 'server' },
    ]);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(50);
  });

  test('clamped to 100 even with a huge stack', () => {
    const techs = [
      { name: 'Next.js', category: 'framework' },
      { name: 'WordPress', category: 'cms' },
      { name: 'Shopify', category: 'ecommerce' },
      { name: 'jQuery', category: 'frontend' },
      { name: 'Vercel', category: 'hosting' },
      { name: 'Cloudflare', category: 'cdn' },
      { name: 'Google Analytics', category: 'analytics' },
      { name: 'Google Tag Manager', category: 'marketing' },
      { name: 'Nginx', category: 'server' },
    ];
    expect(computeSophisticationScore(techs)).toBe(100);
  });

  test('Next.js + Vercel combo bonus is applied', () => {
    const without = computeSophisticationScore([
      { name: 'Next.js', category: 'framework' },
      { name: 'Nginx', category: 'server' },
    ]);
    const withVercel = computeSophisticationScore([
      { name: 'Next.js', category: 'framework' },
      { name: 'Vercel', category: 'hosting' },
      { name: 'Nginx', category: 'server' },
    ]);
    // +10 (hosting) + 5 (Next.js+Vercel combo) = +15
    expect(withVercel - without).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 8. buildSnapshot
// ---------------------------------------------------------------------------

describe('Phase 3.6 — buildSnapshot', () => {
  test('constructs the snapshot shape with parsed cookies, scripts, and generator', () => {
    const fr = makeFetchResult({
      statusCode: 200,
      finalUrl: 'https://example.com/page',
      html: `<head><meta name="generator" content="WordPress 6.2"></head>
        <script src="/app.js"></script>`,
      headers: { 'set-cookie': 'session=abc; Path=/' },
    });
    const snap = buildSnapshot(fr, 'https://example.com');
    expect(snap.url).toBe('https://example.com/page');
    expect(snap.status).toBe(200);
    expect(snap.headers).toEqual({ 'set-cookie': 'session=abc; Path=/' });
    expect(snap.html).toContain('generator');
    expect(snap.cookies).toEqual(['session']);
    expect(snap.scripts).toEqual(['/app.js']);
    expect(snap.generatorMeta).toBe('WordPress 6.2');
  });

  test('falls back to the original URL when finalUrl is missing', () => {
    const snap = buildSnapshot(
      { finalUrl: '', statusCode: null, headers: {}, html: '' },
      'https://fallback.com'
    );
    expect(snap.url).toBe('https://fallback.com');
    expect(snap.status).toBe(null);
    expect(snap.cookies).toEqual([]);
    expect(snap.scripts).toEqual([]);
    expect(snap.generatorMeta).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 9. checkWebsiteLiveness
// ---------------------------------------------------------------------------

describe('Phase 3.6 — checkWebsiteLiveness', () => {
  test('HEAD 200 → returns live without GET fallback', async () => {
    const stub = makeStub(makeFetchResult({ statusCode: 200, liveness: 'live' }));
    _setHttp(stub);
    const out = await checkWebsiteLiveness('https://example.com');
    expect(out).toEqual({ statusCode: 200, liveness: 'live' });
    expect(stub._calls).toHaveLength(1);
    expect(stub._calls[0].opts.method).toBe('HEAD');
  });

  test('HEAD 405 / 501 → falls back to GET', async () => {
    for (const headStatus of [405, 501]) {
      const stub = makeStub((url, opts) => {
        if (opts.method === 'HEAD') {
          return makeFetchResult({ statusCode: headStatus, reachable: false, liveness: 'dead' });
        }
        return makeFetchResult({ statusCode: 200, liveness: 'live' });
      });
      _setHttp(stub);
      const out = await checkWebsiteLiveness('https://example.com');
      expect(out).toEqual({ statusCode: 200, liveness: 'live' });
      expect(stub._calls).toHaveLength(2);
      expect(stub._calls[0].opts.method).toBe('HEAD');
      expect(stub._calls[1].opts.method).toBe('GET');
    }
  });

  test('stub throws → returns error liveness; empty website → error', async () => {
    _setHttp(async () => { throw new Error('network down'); });
    const out = await checkWebsiteLiveness('https://example.com');
    expect(out).toEqual({ statusCode: null, liveness: 'error' });

    const empty = await checkWebsiteLiveness('');
    expect(empty).toEqual({ statusCode: null, liveness: 'error' });
  });
});

// ---------------------------------------------------------------------------
// 10. analyzeWebsite
// ---------------------------------------------------------------------------

describe('Phase 3.6 — analyzeWebsite', () => {
  test('business with website + fetch:true → sets all four fields', async () => {
    _setHttp(makeStub(makeFetchResult({
      html: '<meta name="generator" content="WordPress 6.2">',
      headers: { server: 'nginx' },
    })));
    const biz = { website: 'https://example.com' };
    const result = await analyzeWebsite(biz, { fetch: true });
    expect(biz.website_tech_stack).toEqual(expect.arrayContaining(['WordPress', 'Nginx']));
    expect(biz.website_status_code).toBe(200);
    expect(biz.website_liveness).toBe('live');
    expect(biz.tech_stack_result).toBe(result);
    expect(result.technologies.length).toBeGreaterThan(0);
    expect(result.skipped).toBeUndefined();
  });

  test('business without website → skipped, liveness error', async () => {
    _setHttp(makeStub(makeFetchResult()));
    const biz = {};
    const result = await analyzeWebsite(biz, { fetch: true });
    expect(biz.website_tech_stack).toEqual([]);
    expect(biz.website_status_code).toBeNull();
    expect(biz.website_liveness).toBe('error');
    expect(result.skipped).toBe(true);
    expect(result.issues[0]).toMatch(/no website/i);
  });

  test('fetch:false (default) → skipped, no network calls', async () => {
    const stub = makeStub(makeFetchResult());
    _setHttp(stub);
    const biz = { website: 'https://example.com' };
    const result = await analyzeWebsite(biz); // no opts → fetch falsy
    expect(biz.website_tech_stack).toEqual([]);
    expect(biz.website_liveness).toBe('error');
    expect(result.skipped).toBe(true);
    expect(stub._calls).toHaveLength(0);
  });

  test('fetch failure → liveness error and empty tech stack', async () => {
    _setHttp(makeStub(makeFetchResult({
      reachable: false, statusCode: null, liveness: 'error', error: 'timeout',
    })));
    const biz = { website: 'https://example.com' };
    await analyzeWebsite(biz, { fetch: true });
    expect(biz.website_tech_stack).toEqual([]);
    expect(biz.website_status_code).toBeNull();
    expect(biz.website_liveness).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// 11. detectTechStackBatch
// ---------------------------------------------------------------------------

describe('Phase 3.6 — detectTechStackBatch', () => {
  test('fetch:false → all skipped, no network calls, stats shape correct', async () => {
    const stub = makeStub(makeFetchResult());
    _setHttp(stub);
    const businesses = [
      { website: 'https://a.com' },
      { website: 'https://b.com' },
    ];
    const stats = await detectTechStackBatch(businesses); // no fetch
    expect(stats).toEqual({
      total: 2, analyzed: 0, reachable: 0, avgSophistication: 0, skipped: 2, costUsd: 0,
    });
    expect(stub._calls).toHaveLength(0);
    expect(businesses[0].website_liveness).toBe('error');
  });

  test('fetch:true → analyzes businesses with websites, skips those without', async () => {
    _setHttp(makeStub(makeFetchResult({
      html: '<meta name="generator" content="WordPress 6.2">',
      headers: { server: 'nginx' },
    })));
    const businesses = [
      { website: 'https://a.com' },
      { name: 'no-website biz' },
      { website: '' },
    ];
    const stats = await detectTechStackBatch(businesses, { fetch: true, concurrency: 2 });
    expect(stats.total).toBe(3);
    expect(stats.analyzed).toBe(1);
    expect(stats.reachable).toBe(1);
    expect(stats.skipped).toBe(2);
    expect(stats.avgSophistication).toBeGreaterThan(0);
    expect(stats.costUsd).toBe(0);
    expect(businesses[0].website_tech_stack).toContain('WordPress');
    expect(businesses[1].website_liveness).toBe('error');
  });

  test('empty batch → all-zero stats', async () => {
    const stats = await detectTechStackBatch([], { fetch: true });
    expect(stats).toEqual({
      total: 0, analyzed: 0, reachable: 0, avgSophistication: 0, skipped: 0, costUsd: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// 12. Constants & exports
// ---------------------------------------------------------------------------

describe('Phase 3.6 — constants & exports', () => {
  test('ENRICHMENT_COLUMNS equals the 3 persisted columns', () => {
    expect(ENRICHMENT_COLUMNS).toEqual([
      'website_tech_stack',
      'website_status_code',
      'website_liveness',
    ]);
  });

  test('DETECTION_RULES is a non-empty array of {name, category, test}', () => {
    expect(Array.isArray(DETECTION_RULES)).toBe(true);
    expect(DETECTION_RULES.length).toBeGreaterThan(10);
    for (const rule of DETECTION_RULES) {
      expect(typeof rule.name).toBe('string');
      expect(typeof rule.category).toBe('string');
      expect(typeof rule.test).toBe('function');
    }
  });

  test('CATEGORY_SCORES is an object mapping categories to positive numbers', () => {
    expect(typeof CATEGORY_SCORES).toBe('object');
    expect(CATEGORY_SCORES).not.toBeNull();
    expect(Object.keys(CATEGORY_SCORES).length).toBeGreaterThan(5);
    for (const v of Object.values(CATEGORY_SCORES)) {
      expect(typeof v).toBe('number');
      expect(v).toBeGreaterThan(0);
    }
  });

  test('__version and DEFAULT_* constants are positive', () => {
    expect(__version).toBeGreaterThan(0);
    expect(DEFAULT_MAX_REDIRECTS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
