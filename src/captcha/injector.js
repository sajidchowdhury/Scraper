'use strict';

/**
 * src/captcha/injector.js — Phase 2.6 — CAPTCHA token injection
 *
 * After a solver returns a reCAPTCHA token, we must:
 *   1. Inject it into the hidden `#g-recaptcha-response` textarea (and the
 *      enterprise variant `textarea[name="g-recaptcha-response"]`).
 *   2. Trigger the reCAPTCHA callback so Google accepts the token. Google
 *      registers callbacks on `window.___grecaptcha_cfg.clients`; we walk that
 *      object to find the callback, falling back to submitting the host form.
 *   3. Wait for the page to navigate (Google reloads the results on success).
 *
 * The DOM-touching logic is extracted into PURE functions (injectTokenIntoDom,
 * triggerCallbackInDom) that take `(token, document, window, EventCtor)` — so
 * unit tests run them against a mock DOM built from a reCAPTCHA HTML fixture,
 * with NO real browser and NO page.evaluate.
 *
 * The page-bound wrappers (injectRecaptchaToken, submitRecaptcha,
 * solveAndInject) are thin shells that call the pure functions via
 * page.evaluate (or an injectable evalFn for tests).
 *
 * Public API:
 *   await injectRecaptchaToken(page, token, { evalFn });
 *   const triggered = await submitRecaptcha(page, token, { evalFn });
 *   const r = await solveAndInject(page, solver, detection, { ... });
 *   // pure (exported for direct unit testing):
 *   injectTokenIntoDom(token, documentImpl) → number
 *   triggerCallbackInDom(token, documentImpl, windowImpl, EventCtor) → { ok, method, path?, name? }
 */

// ---------------------------------------------------------------------------
// Pure DOM logic — extracted so tests can call them with a mock DOM.
// ---------------------------------------------------------------------------

/**
 * Inject the token into every reCAPTCHA response textarea on the page.
 * PURE: takes a document-like object. Returns the count of textareas touched.
 *
 * @param {string} token
 * @param {object} documentImpl — must support querySelectorAll(sel)
 * @returns {number}
 */
function injectTokenIntoDom(token, documentImpl) {
  if (!token) return 0;
  const sels = [
    '#g-recaptcha-response',
    'textarea[name="g-recaptcha-response"]',
    'textarea[name="g-recaptcha-response-100000"]',
  ];
  let touched = 0;
  for (const sel of sels) {
    const els = documentImpl.querySelectorAll(sel);
    if (!els) continue;
    // Support both NodeList (forEach) and arrays.
    const list = els.forEach ? els : Array.from(els);
    list.forEach((el) => {
      // Make it writable (Google sets display:none + readonly).
      if (el.style) {
        el.style.display = 'block';
        el.style.visibility = 'visible';
      }
      try { el.removeAttribute && el.removeAttribute('readonly'); } catch { /* ignore */ }
      el.value = token;
      if (el.dispatchEvent && typeof EventCtorRef !== 'undefined') {
        try { el.dispatchEvent(new EventCtorRef('input', { bubbles: true })); } catch { /* ignore */ }
        try { el.dispatchEvent(new EventCtorRef('change', { bubbles: true })); } catch { /* ignore */ }
      }
      touched++;
    });
  }
  return touched;
}

// Reference to the global Event constructor; overridable via the page-bound
// wrapper's evalFn context. In the pure function we accept an EventCtor arg.
// (Kept here only so the un-bound pure function can dispatch events when given
// an EventCtor — see injectTokenIntoDomWithEvents below.)
let EventCtorRef = typeof Event !== 'undefined' ? Event : function DummyEvent() {};

/**
 * Inject the token AND dispatch input/change events. PURE + injectable EventCtor.
 * (Tests that don't care about events can use injectTokenIntoDom with a stub
 * document whose elements have no-op dispatchEvent.)
 *
 * @param {string} token
 * @param {object} documentImpl
 * @param {Function} EventCtor — Event constructor (default global Event)
 * @returns {number}
 */
function injectTokenIntoDomWithEvents(token, documentImpl, EventCtor) {
  if (!token) return 0;
  const EC = EventCtor || EventCtorRef;
  const sels = [
    '#g-recaptcha-response',
    'textarea[name="g-recaptcha-response"]',
    'textarea[name="g-recaptcha-response-100000"]',
  ];
  let touched = 0;
  for (const sel of sels) {
    const els = documentImpl.querySelectorAll(sel);
    if (!els) continue;
    const list = els.forEach ? els : Array.from(els);
    list.forEach((el) => {
      if (el.style) {
        el.style.display = 'block';
        el.style.visibility = 'visible';
      }
      try { el.removeAttribute && el.removeAttribute('readonly'); } catch { /* ignore */ }
      el.value = token;
      if (el.dispatchEvent && EC) {
        try { el.dispatchEvent(new EC('input', { bubbles: true })); } catch { /* ignore */ }
        try { el.dispatchEvent(new EC('change', { bubbles: true })); } catch { /* ignore */ }
      }
      touched++;
    });
  }
  return touched;
}

/**
 * Trigger the reCAPTCHA success callback so Google accepts the token.
 * PURE: takes document + window. Returns { ok, method, path?, name? }.
 *
 * Strategy (in priority order):
 *   1. Walk `window.___grecaptcha_cfg.clients` to find a callable callback
 *      whose key matches /callback|submit|success/i. Call it with the token.
 *   2. Look for `data-callback` on the widget div → named global function.
 *   3. Submit the host <form>.
 *
 * @param {string} token
 * @param {object} documentImpl
 * @param {object} windowImpl
 * @returns {{ ok: boolean, method: string|null, path?: string, name?: string }}
 */
function triggerCallbackInDom(token, documentImpl, windowImpl) {
  const win = windowImpl || {};
  // 1. Walk ___grecaptcha_cfg.clients to find a callable callback.
  const cfg = win.___grecaptcha_cfg;
  if (cfg && cfg.clients) {
    const clients = cfg.clients;
    const found = [];
    // Depth-limited DFS (max depth 8) to avoid walking huge / cyclic objects.
    const visit = (node, path, depth) => {
      if (!node || typeof node !== 'object' || depth > 8) return;
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === 'function' && /callback|submit|success/i.test(k)) {
          found.push({ fn: v, path: path + '.' + k });
        } else if (v && typeof v === 'object') {
          visit(v, path + '.' + k, depth + 1);
        }
      }
    };
    for (const cid of Object.keys(clients)) visit(clients[cid], 'clients.' + cid, 0);
    // Prefer callbacks whose path mentions "callback" over "submit".
    found.sort((a, b) => {
      const ac = /callback/i.test(a.path) ? 0 : 1;
      const bc = /callback/i.test(b.path) ? 0 : 1;
      return ac - bc;
    });
    if (found.length > 0) {
      try { found[0].fn(token); return { ok: true, method: 'callback', path: found[0].path }; } catch { /* try next */ }
    }
  }
  // 2. data-callback attribute → named global function.
  const widget = documentImpl.querySelector && documentImpl.querySelector('.g-recaptcha[data-callback]');
  if (widget) {
    const cbName = widget.getAttribute('data-callback');
    if (cbName && typeof win[cbName] === 'function') {
      try { win[cbName](token); return { ok: true, method: 'data-callback', name: cbName }; } catch { /* fall through */ }
    }
  }
  // 3. Submit the host form.
  const form = documentImpl.querySelector && documentImpl.querySelector('form');
  if (form && typeof form.submit === 'function') {
    try { form.submit(); return { ok: true, method: 'form-submit' }; } catch { /* ignore */ }
  }
  return { ok: false, method: null };
}

// ---------------------------------------------------------------------------
// Page-bound wrappers (thin shells over page.evaluate)
// ---------------------------------------------------------------------------

/**
 * Inject the solver's token into the hidden reCAPTCHA response textarea(s).
 * Returns the number of textareas populated (0 = none found).
 *
 * @param {object} page
 * @param {string} token
 * @param {object} [opts]
 * @param {(fn:Function,arg:any)=>Promise<any>} [opts.evalFn] — injectable page.evaluate
 * @returns {Promise<number>}
 */
async function injectRecaptchaToken(page, token, opts = {}) {
  if (!token) return 0;
  const evalFn = opts.evalFn || ((fn, arg) => page.evaluate(fn, arg));
  try {
    return await evalFn((tkn) => {
      const sels = [
        '#g-recaptcha-response',
        'textarea[name="g-recaptcha-response"]',
        'textarea[name="g-recaptcha-response-100000"]',
      ];
      let touched = 0;
      for (const sel of sels) {
        document.querySelectorAll(sel).forEach((el) => {
          el.style.display = 'block';
          el.style.visibility = 'visible';
          try { el.removeAttribute('readonly'); } catch { /* ignore */ }
          el.value = tkn;
          try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* ignore */ }
          try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch { /* ignore */ }
          touched++;
        });
      }
      return touched;
    }, token);
  } catch {
    return 0;
  }
}

/**
 * Trigger the reCAPTCHA success callback / submit the form.
 * Returns true when a callback was invoked OR a form was submitted.
 *
 * @param {object} page
 * @param {string} token
 * @param {object} [opts]
 * @param {(fn:Function,arg:any)=>Promise<any>} [opts.evalFn]
 * @returns {Promise<boolean>}
 */
async function submitRecaptcha(page, token, opts = {}) {
  const evalFn = opts.evalFn || ((fn, arg) => page.evaluate(fn, arg));
  try {
    const result = await evalFn((tkn) => {
      // 1. Walk ___grecaptcha_cfg.clients for a callable callback.
      const cfg = window.___grecaptcha_cfg;
      if (cfg && cfg.clients) {
        const found = [];
        const visit = (node, path, depth) => {
          if (!node || typeof node !== 'object' || depth > 8) return;
          for (const k of Object.keys(node)) {
            const v = node[k];
            if (typeof v === 'function' && /callback|submit|success/i.test(k)) {
              found.push({ fn: v, path: path + '.' + k });
            } else if (v && typeof v === 'object') {
              visit(v, path + '.' + k, depth + 1);
            }
          }
        };
        for (const cid of Object.keys(cfg.clients)) visit(cfg.clients[cid], 'clients.' + cid, 0);
        found.sort((a, b) => {
          const ac = /callback/i.test(a.path) ? 0 : 1;
          const bc = /callback/i.test(b.path) ? 0 : 1;
          return ac - bc;
        });
        if (found.length > 0) {
          try { found[0].fn(tkn); return { ok: true, method: 'callback', path: found[0].path }; } catch { /* try next */ }
        }
      }
      // 2. data-callback → named global.
      const widget = document.querySelector('.g-recaptcha[data-callback]');
      if (widget) {
        const cbName = widget.getAttribute('data-callback');
        if (cbName && typeof window[cbName] === 'function') {
          try { window[cbName](tkn); return { ok: true, method: 'data-callback', name: cbName }; } catch { /* fall through */ }
        }
      }
      // 3. Submit the host form.
      const form = document.querySelector('form');
      if (form) {
        try { form.submit(); return { ok: true, method: 'form-submit' }; } catch { /* ignore */ }
      }
      return { ok: false, method: null };
    }, token);
    return !!(result && result.ok);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Solve + inject + wait-for-navigation orchestrator helper
// ---------------------------------------------------------------------------

/**
 * Solve a CAPTCHA and inject the resulting token into the page, then wait for
 * navigation (Google reloads to the results on success).
 *
 * @param {object} page
 * @param {object} solver       — from createSolver() / createSolverChain()
 * @param {object} detection    — from detectCaptchaType(): { type, sitekey, url, detected }
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @param {(ms:number)=>Promise<void>} [opts.sleepFn]
 * @param {()=>Promise<boolean>} [opts.navWaitFn] — returns true when nav happened
 * @param {(fn:Function,...args)=>Promise<any>} [opts.evalFn]
 * @param {number} [opts.navTimeoutMs=15000] — max wait for navigation
 * @param {number} [opts.navPollMs=250] — poll interval for navWaitFn
 * @returns {Promise<{ resolved: boolean, token: string|null, cost: number, solveTimeMs: number, provider: string|null, method: string|null }>}
 */
async function solveAndInject(page, solver, detection, opts = {}) {
  const logger = opts.logger || null;
  const sleepFn = opts.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const navTimeoutMs = opts.navTimeoutMs ?? 15_000;
  const navPollMs = opts.navPollMs ?? 250;
  const navWaitFn = opts.navWaitFn || (async () => {
    // Default: poll page.url() until it changes OR the captcha indicator
    // disappears from the body text. Returns true when the page "moved on".
    const before = detection.url || '';
    const start = Date.now();
    while (Date.now() - start < navTimeoutMs) {
      try {
        const url = page.url ? page.url() : '';
        const text = await page.evaluate(() => document.body ? (document.body.innerText || '') : '').catch(() => '');
        const stillCaptcha = /unusual traffic|not a robot|g-recaptcha/i.test(text);
        if ((url && url !== before) || (!stillCaptcha && text.length > 200)) {
          return true;
        }
      } catch { /* page mid-navigation — keep polling */ }
      await sleepFn(navPollMs);
    }
    return false;
  });

  if (!solver || solver.provider === 'none') {
    return { resolved: false, token: null, cost: 0, solveTimeMs: 0, provider: null, method: null };
  }
  if (!detection || !detection.detected) {
    return { resolved: false, token: null, cost: 0, solveTimeMs: 0, provider: null, method: null };
  }

  // For the "unusual traffic" interstitial, Google embeds a reCAPTCHA widget
  // too — if there's no sitekey we can't solve it via a service.
  if (!detection.sitekey) {
    if (logger) logger.warn('CAPTCHA detected but no sitekey — cannot solve via service', { type: detection.type, url: detection.url });
    return { resolved: false, token: null, cost: 0, solveTimeMs: 0, provider: null, method: null };
  }

  let solved;
  try {
    solved = await solver.solve({
      type: detection.type,
      sitekey: detection.sitekey,
      url: detection.url || (page.url ? page.url() : ''),
    });
  } catch (err) {
    if (logger) logger.warn('CAPTCHA solver failed during solveAndInject', { error: err.message, code: err.code || null });
    return { resolved: false, token: null, cost: 0, solveTimeMs: 0, provider: solver.provider, method: null };
  }

  // Inject the token into the hidden textarea(s).
  const touched = await injectRecaptchaToken(page, solved.token, { evalFn: opts.evalFn });
  if (logger) logger.debug('CAPTCHA token injected', { textareas: touched, provider: solved.provider });

  // Trigger the callback / submit the form.
  const triggered = await submitRecaptcha(page, solved.token, { evalFn: opts.evalFn });
  if (logger) logger.debug('CAPTCHA submit triggered', { triggered });

  // Wait for the page to navigate / the captcha to clear.
  const navigated = await navWaitFn();
  if (logger) {
    logger.info('CAPTCHA solve+inject complete', {
      resolved: navigated,
      provider: solved.provider,
      cost: `$${solved.cost.toFixed(4)}`,
      time: `${(solved.solveTimeMs / 1000).toFixed(2)}s`,
      method: triggered ? 'callback-or-submit' : 'inject-only',
    });
  }

  return {
    resolved: navigated,
    token: solved.token,
    cost: solved.cost,
    solveTimeMs: solved.solveTimeMs,
    provider: solved.provider,
    method: triggered ? 'callback-or-submit' : (touched > 0 ? 'inject-only' : null),
  };
}

module.exports = {
  // Page-bound wrappers
  injectRecaptchaToken,
  submitRecaptcha,
  solveAndInject,
  // Pure DOM logic (exported for direct unit testing with a mock DOM)
  injectTokenIntoDom,
  injectTokenIntoDomWithEvents,
  triggerCallbackInDom,
};
