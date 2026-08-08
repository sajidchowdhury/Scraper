'use strict';

/**
 * src/enrichment/tech-stack.js — Phase 3.6 — Website Tech-Stack Detection
 *
 * For every business that has a website, this module:
 *   (A) Fetches the site over HTTP (GET, redirect-following, 10s timeout) and
 *       classifies its liveness — `live` | `dead` | `redirected` | `error`.
 *   (B) Runs a signature-based detector over the response headers + HTML to
 *       identify the CMS / framework / frontend / e-commerce / hosting / CDN /
 *       analytics stack powering the site (WordPress, Shopify, Wix, Squarespace,
 *       Drupal, Joomla, Magento, React, Vue, Angular, Next.js, jQuery,
 *       Bootstrap, Tailwind, Cloudflare, Nginx, Apache, Google Analytics, …).
 *   (C) Computes a 0-100 sophistication score from the detected signals — a
 *       hand-coded static HTML page scores ~3, a Next.js + Vercel + Cloudflare
 *       + GA4 stack scores ~90+. This feeds the lead-score "digital_maturity"
 *       signal (Phase 3.9).
 *
 * WHY THIS MODULE EXISTS
 *   A business's website is the single richest signal of its digital maturity
 *   and legitimacy. A WordPress + WooCommerce shop with GA4 and Cloudflare is a
 *   real, invested business; a 1-page .xyz site with no CMS, no analytics, and
 *   a Facebook redirect is almost certainly a spam/lead-gen shell. Tech-stack
 *   detection turns the website URL (a string) into structured, filterable
 *   columns clients can segment on ("show me all plumbers running Shopify" or
 *   "flag listings whose site just redirects to Facebook").
 *
 * DESIGN RULES (per PHASE3_EXECUTION_PLAN.md §3.6)
 *   - HTTP fetching is OPT-IN. `opts.fetch` defaults to `false` because real
 *     fetches are slow (10s timeout × thousands of rows) AND make external
 *     network requests that an operator must explicitly authorize. With
 *     `opts.fetch=false`, analyzeWebsite returns early with liveness 'error'
 *     and an empty tech stack — no network calls, no surprises.
 *   - The HTTP fetcher lives behind a DI seam (`_loadHttp` / `_setHttp`).
 *     Production uses Node's built-in `http` / `https` modules (no dependency
 *     on node-fetch / axios — keeps the scraper dep-light and lets us control
 *     redirect/timeout/TLS behavior precisely). Tests inject a stub fetcher
 *     that returns canned snapshots so the detection rules can be unit-tested
 *     with zero network I/O.
 *   - Be defensive. Real business websites are a mess: dead domains, TLS
 *     certificate errors, 500s, redirect chains to Facebook, 10MB pages,
 *     encoding weirdness, HEAD-not-supported servers. Every fetch is wrapped,
 *     every error is caught, and no single bad site can crash the batch.
 *   - Detection rules are ported from the dashboard's
 *     `src/lib/pipeline/techstack.ts` signature engine (generator meta tags,
 *     asset paths, header values, cookie names, framework globals) and
 *     extended with the additional signatures called out in the Phase 3.6
 *     spec (Joomla, Vue, Angular, Bootstrap, Tailwind, /wp-includes/,
 *     /skin/frontend/, __REACT_DEVTOOLS_GLOBAL_HOOK__).
 *   - The business object is mutated IN PLACE by analyzeWebsite /
 *     detectTechStackBatch. Three persisted columns are written
 *     (website_tech_stack, website_status_code, website_liveness) plus a
 *     debug-only `tech_stack_result` descriptor holding the full detection
 *     output (NOT persisted — used by the CLI banner + lead scoring).
 *
 * PUBLIC API
 *   fetchWebsite(website, opts?)            → async { reachable, statusCode, finalUrl, html, headers, redirected, liveness }
 *   detectTechStack(website, opts?)         → async { technologies[], cms, framework, frontend, hosting, cdn, ecommerce, analytics[], sophisticationScore, issues[], url, reachable }
 *   checkWebsiteLiveness(website, opts?)    → async { statusCode, liveness }
 *   analyzeWebsite(business, opts?)         → async (mutates business; returns the tech_stack_result descriptor)
 *   detectTechStackBatch(businesses, opts?) → async { total, analyzed, reachable, avgSophistication, skipped, costUsd:0 }
 *   ENRICHMENT_COLUMNS                      → ['website_tech_stack','website_status_code','website_liveness']
 */

const http = require('http');
const https = require('https');

// ---------------------------------------------------------------------------
// DI seam for the HTTP fetcher. Production lazy-loads a real fetcher built on
// Node's http/https; tests inject a stub via _setHttp(async (url, opts) => ({...}))
// to run the detection rules against canned snapshots with zero network I/O.
// The fetcher contract:
//   async (url, opts) => {
//     reachable: boolean,
//     statusCode: number|null,
//     finalUrl: string,
//     html: string,
//     headers: Record<string,string>,   // lowercased keys
//     redirected: boolean,              // true if the final URL's domain differs
//     liveness: 'live'|'dead'|'redirected'|'error',
//     error: string|null,
//     truncated: boolean                // true if the body was capped at maxBytes
//   }
// ---------------------------------------------------------------------------
let _http = null;
function _loadHttp() {
  if (_http) return _http;
  _http = _createRealFetcher();
  return _http;
}
// Test hook: inject a stub fetcher. Pass null to reset to the real fetcher.
function _setHttp(stub) {
  _http = stub;
}

const __version = 1;

const ENRICHMENT_COLUMNS = ['website_tech_stack', 'website_status_code', 'website_liveness'];

const DEFAULT_UA =
  'Mozilla/5.0 (compatible; GMapsScraper/3.6; +tech-stack-detection) bot';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB body cap — signatures live in <head>

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Lowercase all keys of a headers object (Node returns lowercased keys
 *  already, but set-cookie / multi-value headers can sneak through with
 *  varying case depending on the Node version — normalize defensively). */
function lowercaseKeys(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const k of Object.keys(headers)) {
    const v = headers[k];
    if (Array.isArray(v)) {
      out[String(k).toLowerCase()] = v.length === 1 ? v[0] : v;
    } else {
      out[String(k).toLowerCase()] = v;
    }
  }
  return out;
}

/** Read a header value that may be a string or an array (multi-valued). */
function headerGet(headers, name) {
  if (!headers) return undefined;
  const v = headers[String(name).toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Extract cookie names from the Set-Cookie response header(s). */
function parseCookieNames(headers) {
  const sc = headerGet(headers, 'set-cookie');
  if (!sc) return [];
  const arr = Array.isArray(sc) ? sc : [sc];
  const names = [];
  for (const c of arr) {
    const m = /^([^=;,\s]+)/.exec(String(c));
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** Extract <script src="..."> values from an HTML document. */
function extractScriptSrcs(html) {
  const srcs = [];
  if (typeof html !== 'string' || !html) return srcs;
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) srcs.push(m[1]);
  return srcs;
}

/** Extract the <meta name="generator" content="..."> value, if present.
 *  Handles both attribute orders (name-then-content and content-then-name). */
function extractGeneratorMeta(html) {
  if (typeof html !== 'string' || !html) return null;
  let m = /<meta\b[^>]*\bname\s*=\s*["']generator["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i.exec(html);
  if (!m) {
    m = /<meta\b[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\bname\s*=\s*["']generator["']/i.exec(html);
  }
  return m ? m[1] : null;
}

/** Normalize a URL for domain comparison (lowercase host, strip trailing slash). */
function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (u.endsWith('/') && u.length > 8 && u[u.length - 2] !== '/') u = u.slice(0, -1);
  return u;
}

/** Extract the lowercase hostname from a URL string (null if unparseable). */
function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_e) {
    return null;
  }
}

/**
 * Classify a fetch result's liveness.
 *
 *   'error'      — network / timeout / TLS failure (no status code).
 *   'redirected' — the final URL's domain differs from the original (e.g. a
 *                  business site that 302s to facebook.com). Takes precedence
 *                  over live/dead because the original site is effectively
 *                  gone — this is the actionable signal for spam/low-quality
 *                  detection.
 *   'live'       — final response 200-399, same domain.
 *   'dead'       — final response 400-599, same domain.
 *
 * @param {number|null} statusCode
 * @param {boolean} redirected
 * @returns {string}
 */
function classifyLiveness(statusCode, redirected) {
  if (redirected) return 'redirected';
  if (statusCode == null) return 'error';
  if (statusCode >= 200 && statusCode < 400) return 'live';
  if (statusCode >= 400 && statusCode < 600) return 'dead';
  return 'error';
}

/** Build an empty error fetch result. */
function _errResult(message, url) {
  return {
    reachable: false,
    statusCode: null,
    finalUrl: url || '',
    html: '',
    headers: {},
    redirected: false,
    liveness: 'error',
    error: message || 'unknown error',
    truncated: false,
  };
}

// ---------------------------------------------------------------------------
// Real HTTP fetcher (production). Built on Node's http/https so we have no
// dependency on node-fetch / axios and can control redirect/timeout/TLS
// behavior precisely. Follows up to DEFAULT_MAX_REDIRECTS hops, enforces a
// DEFAULT_TIMEOUT_MS socket timeout, caps the body at DEFAULT_MAX_BYTES, and
// is permissive on TLS (rejectUnauthorized:false) because many small-business
// sites have expired/self-signed certs — we're doing signature detection, not
// transmitting secrets, so accepting weird certs is the right trade-off.
// ---------------------------------------------------------------------------
function _createRealFetcher() {
  return function fetcher(targetUrl, callOpts) {
    const o = callOpts || {};
    const timeout = o.timeout || DEFAULT_TIMEOUT_MS;
    const maxRedirects = o.maxRedirects != null ? o.maxRedirects : DEFAULT_MAX_REDIRECTS;
    const maxBytes = o.maxBytes || DEFAULT_MAX_BYTES;
    const userAgent = o.userAgent || DEFAULT_UA;
    const baseHeaders = Object.assign(
      { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      o.headers || {}
    );

    let currentMethod = o.method || 'GET';
    let originalDomain = null;
    let redirected = false;
    let hopCount = 0;
    let currentUrl = targetUrl;
    let settled = false;

    return new Promise((resolve) => {
      function settle(result) {
        if (settled) return;
        settled = true;
        resolve(result);
      }

      function attempt() {
        let parsed;
        try {
          parsed = new URL(currentUrl);
        } catch (_e) {
          settle(_errResult('invalid url', currentUrl));
          return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          settle(_errResult('unsupported protocol: ' + parsed.protocol, currentUrl));
          return;
        }
        if (!originalDomain) originalDomain = parsed.hostname.toLowerCase();

        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;
        const reqOpts = {
          method: currentMethod,
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: (parsed.pathname || '/') + (parsed.search || ''),
          headers: baseHeaders,
          timeout,
        };
        if (isHttps) {
          // Permissive TLS — many small-business sites have broken certs.
          reqOpts.rejectUnauthorized = false;
        }

        let req;
        try {
          req = lib.request(reqOpts, onResponse);
        } catch (e) {
          settle(_errResult(e.message, currentUrl));
          return;
        }
        req.on('error', (err) => {
          settle(_errResult(err.message, currentUrl));
        });
        req.on('timeout', () => {
          req.destroy(new Error('request timeout after ' + timeout + 'ms'));
        });
        req.end();

        function onResponse(res) {
          const status = res.statusCode || 0;
          const headers = lowercaseKeys(res.headers || {});
          const loc = headerGet(headers, 'location');
          const redirectable = status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

          if (redirectable && loc && hopCount < maxRedirects) {
            hopCount++;
            let nextUrl;
            try {
              nextUrl = new URL(loc, currentUrl).toString();
            } catch (_e) {
              nextUrl = loc;
            }
            const nextDomain = domainOf(nextUrl);
            if (nextDomain && nextDomain !== originalDomain) redirected = true;
            // Method transitions per HTTP spec + browser behavior:
            //   303 → always GET on the next hop.
            //   301/302 on a HEAD request → switch to GET (browsers do this).
            //   307/308 → preserve method.
            if (status === 303 || (currentMethod === 'HEAD' && (status === 301 || status === 302))) {
              currentMethod = 'GET';
            }
            currentUrl = nextUrl;
            res.resume(); // drain the redirect response
            attempt();
            return;
          }

          // Collect the body (skip for HEAD — there shouldn't be one, but
          // some servers send a body anyway; we drain it).
          const chunks = [];
          let bytes = 0;
          let truncated = false;
          if (currentMethod !== 'HEAD') {
            res.on('data', (chunk) => {
              if (truncated) return;
              bytes += chunk.length;
              if (bytes > maxBytes) {
                truncated = true;
                res.destroy();
                return;
              }
              chunks.push(chunk);
            });
          }
          res.on('end', () => {
            const finalDomain = parsed.hostname.toLowerCase();
            if (finalDomain !== originalDomain) redirected = true;
            const html = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
            settle({
              reachable: status >= 200 && status < 400,
              statusCode: status,
              finalUrl: currentUrl,
              html,
              headers,
              redirected,
              liveness: classifyLiveness(status, redirected),
              error: null,
              truncated,
            });
          });
          res.on('error', (err) => {
            const finalDomain = parsed.hostname.toLowerCase();
            if (finalDomain !== originalDomain) redirected = true;
            const html = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
            settle({
              reachable: status >= 200 && status < 400,
              statusCode: status,
              finalUrl: currentUrl,
              html,
              headers,
              redirected,
              liveness: classifyLiveness(status, redirected),
              error: err.message,
              truncated,
            });
          });
        }
      }
      attempt();
    });
  };
}

// ---------------------------------------------------------------------------
// Public fetchWebsite — thin wrapper over the DI-seam fetcher.
// ---------------------------------------------------------------------------

/**
 * Fetch a website over HTTP GET with redirect-following + timeout.
 *
 * @param {string} website — full URL (http:// or https://). If a scheme is
 *   missing, 'http://' is prepended (then upgraded via redirect if the site
 *   forces HTTPS).
 * @param {object} [opts] — { timeout, maxRedirects, maxBytes, userAgent, headers }
 * @returns {Promise<{reachable:boolean, statusCode:number|null, finalUrl:string, html:string, headers:object, redirected:boolean, liveness:string, error:string|null, truncated:boolean}>}
 */
async function fetchWebsite(website, opts) {
  const url = _coerceUrl(website);
  if (!url) return _errResult('no website url provided', '');
  const fetcher = _loadHttp();
  try {
    return await fetcher(url, opts || {});
  } catch (e) {
    return _errResult(e && e.message ? e.message : 'fetch threw', url);
  }
}

/** Coerce a raw website string into a fetchable URL (prepend http:// if bare). */
function _coerceUrl(website) {
  if (!website || typeof website !== 'string') return '';
  const trimmed = website.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Bare domain / path — prepend http:// (sites that require HTTPS will 301 us).
  return 'http://' + trimmed;
}

// ---------------------------------------------------------------------------
// Detection rules (ported from the dashboard's techstack.ts + spec additions).
// Each rule: { name, category, test(snap, url) => string|null }.
//   snap = { url, status, headers, html, cookies[], scripts[], generatorMeta }
// A non-null return is the evidence string (recorded on the TechStackItem).
// ---------------------------------------------------------------------------

const DETECTION_RULES = [
  // ── CMS ─────────────────────────────────────────────────────────────────
  {
    name: 'WordPress',
    category: 'cms',
    test: (s) => {
      if (s.generatorMeta && /wordpress/i.test(s.generatorMeta))
        return `generator meta: "${s.generatorMeta}"`;
      if (/wp-content\//.test(s.html)) return 'wp-content asset paths';
      if (/wp-includes\//.test(s.html)) return 'wp-includes asset paths';
      if (s.cookies.some((c) => c.toLowerCase().startsWith('wordpress'))) return 'wordpress_* cookies';
      return null;
    },
  },
  {
    name: 'Drupal',
    category: 'cms',
    test: (s) => {
      if (s.generatorMeta && /drupal/i.test(s.generatorMeta))
        return `generator meta: "${s.generatorMeta}"`;
      const xGen = headerGet(s.headers, 'x-generator');
      if (xGen && /drupal/i.test(xGen)) return 'x-generator: Drupal';
      if (/sites\/default\/files\//.test(s.html)) return 'Drupal sites/default/files path';
      if (s.cookies.some((c) => c.startsWith('SSESS'))) return 'SSESS session cookie';
      return null;
    },
  },
  {
    name: 'Wix',
    category: 'cms',
    test: (s, url) => {
      const server = headerGet(s.headers, 'server');
      if (server && /wix/i.test(server)) return `server: ${server}`;
      if (/wixsite\.com/i.test(url)) return 'wixsite.com subdomain';
      if (/X-Wix-Meta-Site-Id/i.test(s.html)) return 'X-Wix-Meta-Site-Id meta';
      if (/parastorage\.com/.test(s.html)) return 'parastorage.com assets';
      return null;
    },
  },
  {
    name: 'Squarespace',
    category: 'cms',
    test: (s) => {
      const server = headerGet(s.headers, 'server');
      if (server && /squarespace/i.test(server)) return `server: ${server}`;
      if (/static1\.squarespace\.com/.test(s.html)) return 'static1.squarespace.com assets';
      if (s.cookies.includes('SS_MID')) return 'SS_MID cookie';
      return null;
    },
  },
  {
    name: 'Webflow',
    category: 'cms',
    test: (s) => {
      if (s.generatorMeta && /webflow/i.test(s.generatorMeta)) return `generator: ${s.generatorMeta}`;
      const xpb = headerGet(s.headers, 'x-powered-by');
      if (xpb && /webflow/i.test(xpb)) return 'x-powered-by: Webflow';
      if (/uploads-ssl\.webflow\.com/.test(s.html)) return 'uploads-ssl.webflow.com assets';
      if (/data-wf-page/.test(s.html)) return 'data-wf-page attribute';
      return null;
    },
  },
  {
    name: 'Joomla',
    category: 'cms',
    test: (s) => {
      if (s.generatorMeta && /joomla/i.test(s.generatorMeta))
        return `generator meta: "${s.generatorMeta}"`;
      if (/media\/joomla\//.test(s.html)) return 'media/joomla asset path';
      if (s.cookies.some((c) => c.toLowerCase().startsWith('joomla'))) return 'joomla_* cookies';
      return null;
    },
  },
  {
    name: 'Adobe Experience Manager',
    category: 'cms',
    test: (s) => {
      if (/\/etc\.clientlibs\//.test(s.html)) return '/etc.clientlibs/ asset path (AEM)';
      if (/\/content\/dam\//.test(s.html)) return '/content/dam/ path (AEM DAM)';
      if (s.cookies.some((c) => c.startsWith('cq-') || c.startsWith('bc-session')))
        return 'cq-* cookie (AEM)';
      return null;
    },
  },

  // ── Frameworks / Frontend ───────────────────────────────────────────────
  {
    name: 'Next.js',
    category: 'framework',
    test: (s) => {
      const xpb = headerGet(s.headers, 'x-powered-by');
      if (xpb && /next\.?js/i.test(xpb)) return 'x-powered-by: Next.js';
      if (headerGet(s.headers, 'x-vercel-id')) return 'x-vercel-id header';
      if (s.html.includes('__NEXT_DATA__')) return '__NEXT_DATA__ global';
      if (/_next\/static\//.test(s.html)) return '_next/static asset path';
      return null;
    },
  },
  {
    name: 'React',
    category: 'frontend',
    test: (s) => {
      if (s.html.includes('data-reactroot')) return 'data-reactroot attribute';
      if (s.html.includes('__REACT_DEVTOOLS_GLOBAL_HOOK__')) return '__REACT_DEVTOOLS_GLOBAL_HOOK__ global';
      if (s.html.includes('__PRELOAD__')) return '__PRELOAD__ global (React hydration)';
      if (/react-loaded/.test(s.html)) return 'React root marker class';
      return null;
    },
  },
  {
    name: 'Vue',
    category: 'frontend',
    test: (s) => {
      if (s.html.includes('__VUE__')) return '__VUE__ global';
      if (s.html.includes('__VUE_DEVTOOLS_GLOBAL_HOOK__')) return '__VUE_DEVTOOLS_GLOBAL_HOOK__ global';
      if (/data-v-[a-f0-9]{8}/i.test(s.html)) return 'data-v-* scoped attribute';
      return null;
    },
  },
  {
    name: 'Angular',
    category: 'frontend',
    test: (s) => {
      if (/ng-version\s*=/.test(s.html)) return 'ng-version attribute';
      if (/\bng-app\b/.test(s.html)) return 'ng-app directive';
      return null;
    },
  },
  {
    name: 'jQuery',
    category: 'frontend',
    test: (s) => {
      if (/jquery[/-]\d/.test(s.html)) return 'jQuery script tag';
      if (s.scripts.some((sc) => /jquery/i.test(sc))) return 'jquery script src';
      return null;
    },
  },
  {
    name: 'Bootstrap',
    category: 'frontend',
    test: (s) => {
      if (/bootstrap(?:\.min)?\.css/i.test(s.html)) return 'bootstrap.css stylesheet';
      if (s.scripts.some((sc) => /bootstrap/i.test(sc))) return 'bootstrap script src';
      return null;
    },
  },
  {
    name: 'Tailwind CSS',
    category: 'frontend',
    test: (s) => {
      if (/cdn\.tailwindcss\.com/.test(s.html)) return 'cdn.tailwindcss.com Play CDN';
      if (/\/tailwind(?:\.min)?\.css/i.test(s.html)) return 'tailwind.css stylesheet';
      if (s.scripts.some((sc) => /tailwind/i.test(sc))) return 'tailwind script src';
      if (s.generatorMeta && /tailwind/i.test(s.generatorMeta)) return `generator: ${s.generatorMeta}`;
      return null;
    },
  },

  // ── E-commerce ──────────────────────────────────────────────────────────
  {
    name: 'Shopify',
    category: 'ecommerce',
    test: (s) => {
      if (headerGet(s.headers, 'x-shopify-stage')) return 'x-shopify-stage header';
      if (headerGet(s.headers, 'x-shopify-id')) return 'x-shopify-id header';
      if (/cdn\.shopify\.com/.test(s.html)) return 'cdn.shopify.com assets';
      if (s.html.includes('shopify-checkout-api-token')) return 'shopify-checkout-api-token meta';
      if (s.cookies.some((c) => c.toLowerCase().startsWith('_shopify'))) return '_shopify_* cookies';
      return null;
    },
  },
  {
    name: 'WooCommerce',
    category: 'ecommerce',
    test: (s) => {
      if (/woocommerce/i.test(s.html)) return 'woocommerce asset paths / class';
      if (s.cookies.some((c) => c.startsWith('woocommerce_') || c.startsWith('wp_woocommerce_')))
        return 'woocommerce session cookies';
      return null;
    },
  },
  {
    name: 'Magento',
    category: 'ecommerce',
    test: (s) => {
      if (headerGet(s.headers, 'x-magento-cache-debug')) return 'x-magento-cache-debug header';
      if (/pub\/static\/.*Magento/i.test(s.html)) return 'Magento pub/static path';
      if (/\/skin\/frontend\//.test(s.html)) return '/skin/frontend/ asset path (Magento 1.x)';
      if (s.cookies.includes('X-Magento-Vary') || s.cookies.includes('form_key'))
        return 'X-Magento-Vary / form_key cookies';
      return null;
    },
  },
  {
    name: 'Salesforce Commerce Cloud',
    category: 'ecommerce',
    test: (s) => {
      const server = headerGet(s.headers, 'server');
      if (server && /demandware/i.test(server)) return `server: ${server}`;
      if (/on\/demandware\./.test(s.html)) return 'on/demandware.* paths';
      if (s.cookies.some((c) => c.startsWith('dw') || c === 'dwsid')) return 'dw* / dwsid cookies';
      return null;
    },
  },

  // ── Hosting / CDN / Server ──────────────────────────────────────────────
  {
    name: 'Vercel',
    category: 'hosting',
    test: (s) => {
      const server = headerGet(s.headers, 'server');
      if (server && /vercel/i.test(server)) return 'server: Vercel';
      const vid = headerGet(s.headers, 'x-vercel-id');
      if (vid) return `x-vercel-id: ${vid}`;
      return null;
    },
  },
  {
    name: 'Cloudflare',
    category: 'cdn',
    test: (s) => {
      const server = headerGet(s.headers, 'server');
      if (server && /cloudflare/i.test(server)) return `server: ${server}`;
      const cf = headerGet(s.headers, 'cf-ray');
      if (cf) return `cf-ray: ${cf}`;
      if (s.cookies.includes('cf_clearance') || s.cookies.includes('__cf_bm'))
        return 'cf_clearance / __cf_bm cookies';
      return null;
    },
  },
  {
    name: 'Akamai',
    category: 'cdn',
    test: (s) => {
      const server = headerGet(s.headers, 'server');
      if (server && /akamai/i.test(server)) return `server: ${server}`;
      if (headerGet(s.headers, 'x-akamai-transformed')) return 'x-akamai-transformed header';
      if (s.cookies.includes('_abck')) return '_abck cookie (Akamai Bot Manager)';
      return null;
    },
  },
  {
    name: 'Nginx',
    category: 'server',
    test: (s) => {
      const server = headerGet(s.headers, 'server');
      return server && /nginx/i.test(server) ? `server: ${server}` : null;
    },
  },
  {
    name: 'Apache',
    category: 'server',
    test: (s) => {
      const server = headerGet(s.headers, 'server');
      return server && /apache/i.test(server) ? `server: ${server}` : null;
    },
  },

  // ── Analytics / Marketing ───────────────────────────────────────────────
  {
    name: 'Google Analytics',
    category: 'analytics',
    test: (s) => {
      if (/googletagmanager\.com\/gtag\/js\?id=G-/i.test(s.html)) return 'gtag/js GA4 snippet';
      if (/google-analytics\.com/i.test(s.html)) return 'google-analytics.com beacon';
      if (/\bgtag\s*\(/.test(s.html)) return 'gtag() call';
      if (s.cookies.some((c) => c.startsWith('_ga_') || c === '_ga')) return '_ga / _ga_* cookies';
      return null;
    },
  },
  {
    name: 'Google Tag Manager',
    category: 'marketing',
    test: (s) =>
      /googletagmanager\.com\/gtm\.js/i.test(s.html) ? 'GTM container snippet' : null,
  },
  {
    name: 'Adobe Experience Platform',
    category: 'marketing',
    test: (s) => {
      if (/assets\.adobedtm\.com/.test(s.html)) return 'Adobe DTM launch script';
      if (s.cookies.some((c) => c.startsWith('AMCV_'))) return 'AMCV_* (Adobe MC) cookie';
      return null;
    },
  },
  {
    name: 'Facebook Pages',
    category: 'marketing',
    test: (s, url) => {
      if (/facebook\.com/i.test(url)) return 'hosted on facebook.com';
      if (s.html.includes('og:site_name" content="Facebook')) return 'Facebook og:site_name';
      if (s.cookies.includes('c_user')) return 'c_user cookie (Facebook session)';
      return null;
    },
  },
];

// Per-category sophistication contributions (max one hit per category counts).
const CATEGORY_SCORES = {
  framework: 25, // modern SPA framework (Next.js / React / Vue / Angular)
  cms: 15, // any real CMS
  ecommerce: 15, // commerce platform
  frontend: 5, // jQuery / Bootstrap / Tailwind etc.
  hosting: 10,
  cdn: 10,
  analytics: 8,
  marketing: 7,
  security: 5,
  server: 3,
};

/**
 * Compute a 0-100 sophistication score from the detected tech list. Sums the
 * max per-category contribution, then applies "modern stack" combo bonuses.
 *
 * @param {object[]} techs — TechStackItem[]
 * @returns {number}
 */
function computeSophisticationScore(techs) {
  if (!techs || !techs.length) return 0;
  const byCat = new Map();
  for (const t of techs) {
    const v = CATEGORY_SCORES[t.category] || 0;
    byCat.set(t.category, Math.max(byCat.get(t.category) || 0, v));
  }
  let score = 0;
  for (const v of byCat.values()) score += v;

  const names = new Set(techs.map((t) => t.name));
  // Modern-stack combos.
  if (names.has('Next.js') && names.has('Vercel')) score += 5;
  if (names.has('Cloudflare')) score += 3;
  if (names.has('Google Analytics') || names.has('Google Tag Manager')) score += 2;
  // Modern frontend framework bonus (React/Vue/Angular — not jQuery).
  if (names.has('React') || names.has('Vue') || names.has('Angular')) score += 3;

  return Math.min(100, score);
}

/**
 * Build a snapshot object (the shape the detection rules expect) from a raw
 * fetch result. Parses cookies, script srcs, and the generator meta tag once
 * so every rule sees the same pre-computed fields.
 *
 * @param {object} fetchResult — from fetchWebsite / the DI-seam fetcher.
 * @param {string} originalUrl — the URL we asked for (for the snap.url fallback).
 * @returns {{url:string, status:number|null, headers:object, html:string, cookies:string[], scripts:string[], generatorMeta:string|null}}
 */
function buildSnapshot(fetchResult, originalUrl) {
  const fr = fetchResult || {};
  return {
    url: fr.finalUrl || originalUrl || '',
    status: fr.statusCode != null ? fr.statusCode : null,
    headers: fr.headers || {},
    html: fr.html || '',
    cookies: parseCookieNames(fr.headers || {}),
    scripts: extractScriptSrcs(fr.html || ''),
    generatorMeta: extractGeneratorMeta(fr.html || ''),
  };
}

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Detect the technologies powering a single website URL.
 *
 * Fetches the site (HTTP GET, redirect-following, 10s timeout), then runs the
 * signature engine over the response headers + HTML. Returns a TechStackResult
 * descriptor: the flat technologies list, per-category convenience fields, the
 * 0-100 sophistication score, and any issues encountered.
 *
 * @param {string} website
 * @param {object} [opts] — passed through to fetchWebsite ({ fetch, timeout,
 *   maxRedirects, maxBytes, userAgent, headers, snapshot }). `opts.snapshot`
 *   lets a caller pass a pre-fetched snapshot to skip the HTTP step.
 * @returns {Promise<object>}
 */
async function detectTechStack(website, opts) {
  const o = opts || {};
  const url = _coerceUrl(website);
  const result = {
    url: url,
    reachable: false,
    statusCode: null,
    liveness: 'error',
    finalUrl: url,
    technologies: [],
    cms: null,
    framework: null,
    frontend: null,
    hosting: null,
    cdn: null,
    ecommerce: null,
    analytics: [],
    sophisticationScore: 0,
    issues: [],
  };

  if (!url) {
    result.issues.push('No website URL provided.');
    return result;
  }

  // Allow a caller to supply a pre-fetched snapshot (skips HTTP entirely).
  let fetchResult;
  if (o.snapshot) {
    fetchResult = o.snapshot;
  } else {
    fetchResult = await fetchWebsite(url, o);
  }

  result.reachable = !!(fetchResult && fetchResult.reachable);
  result.statusCode = fetchResult && fetchResult.statusCode != null ? fetchResult.statusCode : null;
  result.liveness = fetchResult && fetchResult.liveness ? fetchResult.liveness : 'error';
  result.finalUrl = (fetchResult && fetchResult.finalUrl) || url;

  if (!fetchResult || fetchResult.liveness === 'error') {
    result.issues.push(
      `Fetch failed${fetchResult && fetchResult.error ? `: ${fetchResult.error}` : ''} — no response to analyze.`
    );
    return result;
  }

  if (!result.reachable) {
    result.issues.push(`HTTP ${fetchResult.statusCode} — site not reachable.`);
  }
  if (fetchResult.redirected) {
    result.issues.push(`Redirected to a different domain: ${fetchResult.finalUrl}`);
  }
  if (fetchResult.truncated) {
    result.issues.push('Response body truncated at 2 MB — detection ran on the head only.');
  }

  const snap = buildSnapshot(fetchResult, url);
  const technologies = [];
  for (const rule of DETECTION_RULES) {
    let evidence = null;
    try {
      evidence = rule.test(snap, url);
    } catch (_e) {
      // A single buggy rule must not abort detection.
      evidence = null;
    }
    if (evidence) {
      technologies.push({
        name: rule.name,
        category: rule.category,
        confidence: 0.95,
        evidence,
      });
    }
  }

  // Facebook-only "website" — demote with a note (no dedicated domain).
  if (technologies.length === 1 && technologies[0].name === 'Facebook Pages') {
    result.issues.push('Website is a Facebook page — no dedicated domain.');
  }

  // Plain static HTML (no CMS, no framework, no commerce platform) — low
  // sophistication. Only flag when the site was actually reachable.
  const hasAnyPlatform = technologies.some((t) =>
    ['cms', 'framework', 'frontend', 'ecommerce'].includes(t.category)
  );
  if (!hasAnyPlatform && result.reachable) {
    result.issues.push(
      'No CMS / framework / commerce platform detected — likely hand-coded static HTML.'
    );
  }

  result.technologies = technologies;
  result.cms = _firstByCategory(technologies, 'cms');
  result.framework = _firstByCategory(technologies, 'framework');
  result.frontend = _firstByCategory(technologies, 'frontend');
  result.hosting = _firstByCategory(technologies, 'hosting');
  result.cdn = _firstByCategory(technologies, 'cdn');
  result.ecommerce = _firstByCategory(technologies, 'ecommerce');
  result.analytics = technologies
    .filter((t) => t.category === 'analytics' || t.category === 'marketing')
    .map((t) => t.name);
  result.sophisticationScore = computeSophisticationScore(technologies);

  return result;
}

/** Return the name of the first technology in a category, or null. */
function _firstByCategory(techs, category) {
  const hit = techs.find((t) => t.category === category);
  return hit ? hit.name : null;
}

// ---------------------------------------------------------------------------
// Liveness check (lightweight HEAD, falls back to GET)
// ---------------------------------------------------------------------------

/**
 * Check whether a website is live via a lightweight HEAD request. Some servers
 * reject HEAD (405 / 501) — on those we fall back to a GET but discard the
 * body (we only care about the status code + final domain for liveness).
 *
 * @param {string} website
 * @param {object} [opts] — { timeout, maxRedirects, userAgent, headers }
 * @returns {Promise<{statusCode:number|null, liveness:string}>}
 */
async function checkWebsiteLiveness(website, opts) {
  const url = _coerceUrl(website);
  if (!url) return { statusCode: null, liveness: 'error' };

  const fetcher = _loadHttp();
  const baseOpts = Object.assign({}, opts || {}, { method: 'HEAD', maxBytes: 64 * 1024 });

  let res;
  try {
    res = await fetcher(url, baseOpts);
  } catch (e) {
    return { statusCode: null, liveness: 'error' };
  }

  // HEAD unsupported (405 Method Not Allowed / 501 Not Implemented) — retry GET.
  if (res && (res.statusCode === 405 || res.statusCode === 501)) {
    try {
      res = await fetcher(url, Object.assign({}, baseOpts, { method: 'GET' }));
    } catch (_e) {
      return { statusCode: res.statusCode, liveness: 'error' };
    }
  }

  if (!res) return { statusCode: null, liveness: 'error' };
  return { statusCode: res.statusCode, liveness: res.liveness };
}

// ---------------------------------------------------------------------------
// Per-business analysis (mutates the business object in place)
// ---------------------------------------------------------------------------

/**
 * Run the full tech-stack + liveness analysis on a single business record.
 *
 * Mutates the business in place:
 *   - business.website_tech_stack  — string[] (tech names; JSONB array in the DB)
 *   - business.website_status_code — number|null (INT in the DB)
 *   - business.website_liveness    — 'live'|'dead'|'redirected'|'error' (TEXT)
 *   - business.tech_stack_result   — full descriptor (debug; NOT persisted)
 *
 * HTTP fetching is OPT-IN: if `opts.fetch` is not truthy, returns early with
 * liveness 'error' and an empty tech stack (no network calls). This keeps the
 * default pipeline run cheap and side-effect-free; the operator must
 * explicitly enable website analysis.
 *
 * @param {object} business — must have a `website` field (string).
 * @param {object} [opts] — { fetch, timeout, maxRedirects, maxBytes, userAgent, headers, logger }
 * @returns {Promise<object>} the tech_stack_result descriptor.
 */
async function analyzeWebsite(business, opts) {
  const o = opts || {};
  const website = business && business.website ? String(business.website) : '';

  // OPT-OUT path: no fetch requested → record the empty result and bail.
  if (!o.fetch) {
    const skippedResult = {
      url: website,
      reachable: false,
      technologies: [],
      cms: null,
      framework: null,
      frontend: null,
      hosting: null,
      cdn: null,
      ecommerce: null,
      analytics: [],
      sophisticationScore: 0,
      issues: ['fetch disabled — pass opts.fetch=true to enable HTTP website analysis.'],
      skipped: true,
    };
    business.website_tech_stack = [];
    business.website_status_code = null;
    business.website_liveness = 'error';
    business.tech_stack_result = skippedResult;
    return skippedResult;
  }

  // No website to analyze.
  if (!website.trim()) {
    const emptyResult = {
      url: '',
      reachable: false,
      technologies: [],
      cms: null,
      framework: null,
      frontend: null,
      hosting: null,
      cdn: null,
      ecommerce: null,
      analytics: [],
      sophisticationScore: 0,
      issues: ['Business has no website URL.'],
      skipped: true,
    };
    business.website_tech_stack = [];
    business.website_status_code = null;
    business.website_liveness = 'error';
    business.tech_stack_result = emptyResult;
    return emptyResult;
  }

  const fetchOpts = {
    timeout: o.timeout,
    maxRedirects: o.maxRedirects,
    maxBytes: o.maxBytes,
    userAgent: o.userAgent,
    headers: o.headers,
  };
  const result = await detectTechStack(website, fetchOpts);

  // Persisted columns — read straight off the descriptor.
  business.website_tech_stack = result.technologies.map((t) => t.name);
  business.website_status_code = result.statusCode;
  business.website_liveness = result.liveness || 'error';
  business.tech_stack_result = result;
  return result;
}

// ---------------------------------------------------------------------------
// Batch wrapper (concurrency-limited)
// ---------------------------------------------------------------------------

/**
 * Run mapPool over a list with a bounded concurrency so we don't hammer sites
 * (or trip rate limits / get flagged as a scanner).
 *
 * @param {any[]} items
 * @param {number} concurrency
 * @param {(item:any, index:number) => Promise<any>} fn
 * @returns {Promise<any[]>}
 */
async function _mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { __error: e && e.message ? e.message : 'thrown' };
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  const workers = [];
  for (let w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Run tech-stack detection across a batch IN PLACE. Each business is mutated
 * with the three persisted columns (website_tech_stack, website_status_code,
 * website_liveness) plus the debug `tech_stack_result` descriptor.
 *
 * Respects `opts.fetch` (default false — when false, every business is skipped
 * with no network calls), `opts.timeout` (default 10000ms per site), and
 * `opts.concurrency` (default 3 — keeps us polite to external servers).
 *
 * @param {object[]} businesses — mutated in place.
 * @param {object} [opts] — { fetch, timeout, concurrency, maxRedirects, maxBytes, userAgent, headers, logger }
 * @returns {Promise<{total:number, analyzed:number, reachable:number, avgSophistication:number, skipped:number, costUsd:number}>}
 */
async function detectTechStackBatch(businesses, opts) {
  const o = opts || {};
  const list = Array.isArray(businesses) ? businesses : [];
  const concurrency = o.concurrency != null && o.concurrency > 0 ? o.concurrency : 3;
  const perSiteOpts = {
    fetch: !!o.fetch,
    timeout: o.timeout,
    maxRedirects: o.maxRedirects,
    maxBytes: o.maxBytes,
    userAgent: o.userAgent,
    headers: o.headers,
  };

  const stats = {
    total: list.length,
    analyzed: 0,
    reachable: 0,
    avgSophistication: 0,
    skipped: 0,
    costUsd: 0, // no paid APIs in this phase
  };

  let sophSum = 0;
  await _mapPool(list, concurrency, async (business) => {
    if (!business || typeof business !== 'object') {
      stats.skipped++;
      return;
    }
    const hasWebsite = business.website && String(business.website).trim();
    if (!o.fetch || !hasWebsite) {
      // Still call analyzeWebsite so the persisted columns + descriptor are set
      // uniformly (it short-circuits with liveness 'error' + empty stack).
      try {
        await analyzeWebsite(business, perSiteOpts);
      } catch (_e) {
        business.website_tech_stack = [];
        business.website_status_code = null;
        business.website_liveness = 'error';
        business.tech_stack_result = { url: String(business.website || ''), reachable: false, technologies: [], sophisticationScore: 0, issues: ['analyzeWebsite threw'], skipped: true };
      }
      stats.skipped++;
      return;
    }
    stats.analyzed++;
    try {
      const result = await analyzeWebsite(business, perSiteOpts);
      if (result && result.reachable) stats.reachable++;
      sophSum += (result && result.sophisticationScore) || 0;
    } catch (_e) {
      business.website_tech_stack = [];
      business.website_status_code = null;
      business.website_liveness = 'error';
      business.tech_stack_result = { url: String(business.website || ''), reachable: false, technologies: [], sophisticationScore: 0, issues: ['analyzeWebsite threw'], skipped: false };
    }
  });

  stats.avgSophistication = stats.analyzed ? Math.round((sophSum / stats.analyzed) * 100) / 100 : 0;
  return stats;
}

module.exports = {
  __version,
  ENRICHMENT_COLUMNS,
  // Core API
  fetchWebsite,
  detectTechStack,
  checkWebsiteLiveness,
  analyzeWebsite,
  detectTechStackBatch,
  // Helpers exported for unit tests
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
  // Catalogues / constants (for tests + extension)
  DETECTION_RULES,
  CATEGORY_SCORES,
  DEFAULT_UA,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_BYTES,
  // Test seam
  _loadHttp,
  _setHttp,
};
