'use strict';

/**
 * tests/helpers/mock-dom.js — Phase 2.6 test helper.
 *
 * A minimal mock DOM built from an HTML fixture string, used by
 * tests/captcha.test.js to exercise the pure injector functions
 * (injectTokenIntoDom, triggerCallbackInDom) WITHOUT a real browser.
 *
 * Supports just enough of the DOM API the injector touches:
 *   - document.querySelector(sel) / querySelectorAll(sel)
 *   - element.getAttribute(name), setAttribute, removeAttribute
 *   - element.style (plain object), element.value, element.dispatchEvent
 *   - form.submit()
 *   - window.___grecaptcha_cfg (parsed from a <script> JSON-ish blob)
 *
 * This is NOT a general-purpose DOM — it only has to support the reCAPTCHA
 * fixture in tests/fixtures/recaptcha-v2.html.
 */

/**
 * Build a mock document + window from an HTML string.
 *
 * @param {string} html
 * @returns {{ document: object, window: object, Event: Function }}
 */
function buildMockDom(html) {
  // --- Tiny HTML parser: scan ALL opening tags (handles nesting) -------------
  // We only need each element's tag + attributes (the injector reads
  // data-sitekey, data-callback, name, etc. via querySelector). We do NOT need
  // parent/child relationships for the reCAPTCHA fixture, so a flat scan of
  // opening tags (self-closing or not) is sufficient + robust against nesting.
  const elements = [];
  const tagRe = /<(\w+)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1];
    const attrsRaw = m[2] || '';
    // Skip closing tags (matched by \w+ but start with /) — actually the regex
    // requires a word char immediately after <, so </div> won't match (the /
    // isn't \w). Good. But we DO want to skip <script> content being parsed as
    // tags — the regex would match e.g. <function> inside script text. To avoid
    // that, we skip any tag that appears inside a <script>...</script> block.
    // Simplest: skip tags whose name isn't a known HTML element OR isn't one the
    // injector cares about. We whitelist the tags we actually need.
    if (!['div', 'textarea', 'form', 'input', 'button', 'script'].includes(tag)) continue;
    const attrs = parseAttrs(attrsRaw);
    elements.push({ tag, attrs, inner: '' });
  }

  function parseAttrs(raw) {
    const attrs = {};
    const re = /(\w[\w-]*)\s*=\s*"([^"]*)"|(\w[\w-]*)\s*=\s*'([^']*)'|(\w[\w-]*)\s*=\s*(\S+)/g;
    let am;
    while ((am = re.exec(raw)) !== null) {
      const k = am[1] || am[3] || am[5];
      const v = am[2] || am[4] || am[6] || '';
      attrs[k] = v;
    }
    // Also capture bare attributes (e.g. `readonly` with no value).
    const bareRe = /\s(\w[\w-]+)(?=\s|$|=)/g;
    let bm;
    while ((bm = bareRe.exec(raw)) !== null) {
      if (!(bm[1] in attrs)) attrs[bm[1]] = '';
    }
    return attrs;
  }

  // Build mock elements with the methods the injector calls.
  function makeEl(node) {
    return {
      tagName: (node.tag || '').toUpperCase(),
      _attrs: { ...node.attrs },
      _inner: node.inner,
      style: {},
      value: '',
      getAttribute(name) { return this._attrs[name] !== undefined ? this._attrs[name] : null; },
      setAttribute(name, val) { this._attrs[name] = String(val); },
      removeAttribute(name) { delete this._attrs[name]; },
      dispatchEvent() { /* no-op */ },
      submit() { this._submitted = true; },
    };
  }

  const allElements = elements.map(makeEl);

  const documentImpl = {
    _elements: allElements,
    querySelector(sel) {
      return allElements.find((el) => matches(el, sel)) || null;
    },
    querySelectorAll(sel) {
      const found = allElements.filter((el) => matches(el, sel));
      // Return a NodeList-like with forEach.
      return {
        length: found.length,
        forEach(fn) { found.forEach(fn); },
        item(i) { return found[i]; },
        [Symbol.iterator]() { return found[Symbol.iterator](); },
      };
    },
  };

  // Selector matcher: supports `tag`, `.class`, `tag[attr]`, `tag[attr=value]`,
  // `#id`, and simple compound selectors like `.g-recaptcha[data-callback]`.
  function matches(el, sel) {
    const parts = sel.trim().split(/\s+/).filter(Boolean);
    // We only support single-combinator selectors (no descendant matching here —
    // the injector uses simple selectors only). For multi-part, match the LAST
    // part against the element (good enough for the fixture).
    const last = parts[parts.length - 1];
    return matchSingle(el, last);
  }

  function matchSingle(el, sel) {
    // #id
    if (sel.startsWith('#')) {
      return el._attrs.id === sel.slice(1);
    }
    // tag[attr=value] or tag[attr] or .class[attr]
    const compoundRe = /^(\w+)?(\.([\w-]+))?(#([\w-]+))?(\[([\w-]+)(=("[^"]*"|'[^']*'|[^\]]+))?\])?$/;
    const cm = sel.match(compoundRe);
    if (!cm) return false;
    const tag = cm[1];
    const cls = cm[3];
    const id = cm[5];
    const attrName = cm[7];
    const attrVal = cm[9];
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    if (id && el._attrs.id !== id) return false;
    if (cls) {
      const elClass = (el._attrs.class || '').split(/\s+/);
      if (!elClass.includes(cls)) return false;
    }
    if (attrName) {
      if (!(attrName in el._attrs)) return false;
      if (attrVal !== undefined) {
        const v = attrVal.replace(/^["']|["']$/g, '');
        if (el._attrs[attrName] !== v) return false;
      }
    }
    return true;
  }

  // --- Parse the <script> block to reconstruct window.___grecaptcha_cfg ------
  const windowImpl = {
    ___grecaptcha_cfg: null,
    __captchaCallbackCalled: false,
    __captchaCallbackToken: null,
    __dataCallbackCalled: false,
    __dataCallbackToken: null,
  };

  // Install the callback the injector will find by walking ___grecaptcha_cfg.clients.
  const hasGrecaptchaCfg = /___grecaptcha_cfg\s*=/.test(html);
  if (hasGrecaptchaCfg) {
    windowImpl.___grecaptcha_cfg = {
      clients: {
        '100000': {
          widget: {
            callback: function (token) {
              windowImpl.__captchaCallbackCalled = true;
              windowImpl.__captchaCallbackToken = token;
            },
          },
        },
      },
    };
  }
  // The data-callback global name is read from the widget's data-callback attr.
  const widgetEl = allElements.find((el) => (el._attrs.class || '').includes('g-recaptcha'));
  if (widgetEl && widgetEl._attrs['data-callback']) {
    const cbName = widgetEl._attrs['data-callback'];
    windowImpl[cbName] = function (token) {
      windowImpl.__dataCallbackCalled = true;
      windowImpl.__dataCallbackToken = token;
    };
  }

  // A minimal Event constructor (the injector dispatches input/change events).
  function EventCtor(type, opts) {
    return { type, bubbles: !!(opts && opts.bubbles) };
  }

  return { document: documentImpl, window: windowImpl, Event: EventCtor };
}

module.exports = { buildMockDom };
