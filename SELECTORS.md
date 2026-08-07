# Selector Strategy

> Google reshuffles the Google Maps DOM frequently. This document explains
> **where** the CSS selectors live in this codebase, **how** the fallback
> chain works, the **rules** every selector must follow, and **how to
> update** a selector when Google changes the DOM and a field's extraction
> rate drops.

## TL;DR

| What | Where | Key constant |
|---|---|---|
| List-view fields (name, rating, address, …) | `src/extract.js` | `SELECTORS` (object, ~line 71) |
| Detail-panel fields (hours, reviews, photos, …) | `src/detail.js` | `DETAIL_SELECTORS` (object, ~line 80) |
| Results-feed detection ("did the search load?") | `src/search.js` | `feedSelector` literal (`'div[role="feed"]'`, ~line 137) with `'a[href*="/maps/place/"]'` fallback |
| End-of-list detection ("stop scrolling") | `src/scroll.js` | `markers` array of inner-text phrases (~line 65) |
| Card scope (what counts as "one business") | `src/extract.js` | `SELECTORS.card` (first entry wins) |

## The fallback-chain pattern

Every field has **2–4 candidate selectors** in priority order. The in-browser
extraction code (`page.evaluate(...)`) walks the list and uses the **first**
selector that matches a non-empty element. This means:

- If Google renames a class (e.g. `.fontHeadlineSmall` → `.fontHeadlineMedium`),
  the structural fallback (`[role="article"] [aria-label]`) still works.
- If Google wraps a field in a new container, adding one new selector at the
  **top** of the list fixes it without disturbing the fallbacks.
- A field only goes to `null` when **all** candidates miss — which is the
  signal that the DOM genuinely changed and a new selector is needed.

Example (from `src/extract.js`):

```js
const SELECTORS = {
  name: [
    '.fontHeadlineSmall',                                  // primary (fastest)
    '[role="article"] [aria-label]',                       // structural fallback
    'div[role="feed"] a[href*="/maps/place/"] [aria-label]',
    '.qBF1Pd',                                             // legacy class
  ],
  rating: [
    '.fontBodyMedium > span[aria-label*="stars"]',
    'span[aria-label$="stars"]',
    'span.MW4etd',
    '[role="img"][aria-label*="Rated"]',
  ],
  // ...
};
```

## Rules every selector must follow

1. **Native CSS only.** Playwright's `:has-text()` and `:has()` pseudo-classes
   are **not valid inside `page.evaluate()`** — they only work with Playwright's
   own locator API (`page.locator(...)`), which we don't use for the bulk
   extraction (one `page.evaluate` round-trip is far faster than N locator
   calls). Stick to selectors that work in `document.querySelector()`.
   - ❌ `'button:has-text("Website")'`
   - ✅ `'a[data-item-id*="authority"]'`
   - ✅ `'a[aria-label*="Website"]'`

2. **Prefer `data-*` and `[aria-label]` over classes.** Google's generated
   classes (`.fontHeadlineSmall`, `.MW4etd`, `.W4Efsd`, …) change every few
   months. Semantic attributes (`data-item-id`, `aria-label`, `role`) are far
   more stable across redesigns. Put the attribute-based selector **first**,
   the class-based one as a last-resort fallback.

3. **Scope selectors to the card.** Inside `page.evaluate`, each field lookup
   runs within the card element (`anchor.closest('[role="article"]')`), so
   selectors are relative. A bare `'span'` would match the first span in the
   card — usually the wrong one. Always qualify: `'span[aria-label*="stars"]'`,
   not `'span'`.

4. **Never use `:nth-child` as a primary selector.** Positional selectors
   break when Google reorders siblings. The codebase removed
   `'.fontBodyMedium span:nth-child(2)'` for `price_level` because it kept
   matching the reviews-count span instead. Use text/attribute matching
   (`'span[data-value*="$"]'`) and fall back to a text scan in Node if needed.

5. **Multi-locale safety.** Google Maps renders in the browser's locale. The
   scraper forces `hl=en` on the URL (see `src/search.js`), but
   `aria-label` text still varies — e.g. "Sponsored" vs "贊助商廣告" vs
   "広告". For text-based detection (sponsored, business_status, CAPTCHA),
   maintain a list of localized phrases, not a single English string. See
   `CAPTCHA_INDICATORS` in `src/antiblock.js` and the sponsored/closed
   detection in `src/extract.js` for the pattern.

## How to update a selector when a field breaks

You'll know a selector broke because the extraction-rate table at the end of
a run shows a field dropping below 80% (logged as `WARN (<80%)`), or the
field is `null` for every business.

### Step 1 — Reproduce with `--verbose --dryRun`

```bash
npm start -- --query "Cafe" --location "Berlin" --maxResults 10 --verbose --dryRun
```

`--verbose` emits per-business, per-field debug logs so you can see exactly
which fields are missing. `--dryRun` skips the file write so you can iterate
fast.

### Step 2 — Inspect the live DOM with `--headed`

```bash
npm start -- --query "Cafe" --location "Berlin" --maxResults 10 --headed
```

When the browser opens, DevTools (F12) → Elements. Find a business card,
right-click the broken field (e.g. the rating), → Inspect. Note:

- The **stablest attribute** on the element or a close ancestor
  (`data-item-id`, `aria-label`, `role`).
- The **class** on the element (less stable, but sometimes the only signal).
- A **structural path** from the card root (`div[role="article"]`) to the
  field, using only `role` / `aria-label` / tag names.

### Step 3 — Add the new selector at the top of the list

In `src/extract.js` (for list-view fields) or `src/detail.js` (for detail
fields), add your new selector as the **first** entry in the field's array,
keeping the old ones as fallbacks:

```js
rating: [
  'YOUR_NEW_SELECTOR_HERE',                                // ← add here
  '.fontBodyMedium > span[aria-label*="stars"]',
  'span[aria-label$="stars"]',
  'span.MW4etd',
  '[role="img"][aria-label*="Rated"]',
],
```

### Step 4 — Verify against a fixture, then live

1. **Unit test:** add a fixture card to `tests/extract.test.js` (or
   `tests/detail.test.js`) that exercises the new selector. Run
   `bun test tests/extract.test.js`.
2. **Live:** rerun the same query with `--maxResults 10 --verbose` and
   confirm the field's extraction rate is back to ~100%.

### Step 5 — Bump the fallback list, don't delete

Even if a selector is currently broken, **leave it in the list** (move it
down, don't remove it). Google sometimes reverts DOM changes, and an old
selector may start working again. The list is cheap — the in-browser loop
short-circuits on the first match.

## Special cases

### The "card" scope (`SELECTORS.card`)

This is the most important selector — it defines what counts as "one
business." If this breaks, you get zero results (every field is null)
because the extraction loop can't find card boundaries.

- **Primary:** `'div[role="feed"] div[role="article"]'` — modern Maps wraps
  each result in a `div[role="article"]` inside the feed.
- **Fallback:** `'a[href*="/maps/place/"]'` — the place-link anchor. Used
  for older layouts where the whole card is one big `<a>`. Note: nested `<a>`
  is invalid HTML, so in that layout the website/phone links can't be
  children — the `div[role="article"]` layout is the reliable one.

If you see "0 businesses extracted" but the page clearly shows results, this
selector is the culprit.

### End-of-list detection (`src/scroll.js`)

Not a CSS selector — it's a list of **inner-text phrases** Google shows when
you've scrolled to the bottom:

```js
const markers = [
  "You've reached the end of the list",
  'reached the end',
  'No results found',
  'Try different search',
];
```

If the scraper scrolls forever (hits the `SCROLL_TIMEOUT_MS` cap instead of
stopping at "end of list"), Google probably reworded the marker. Run
`--headed --verbose`, scroll to the bottom manually, and add the new phrase
to the `markers` array.

### CAPTCHA detection (`src/antiblock.js`)

`CAPTCHA_INDICATORS` is a list of text snippets that appear on Google's
"unusual traffic" interstitial. If the scraper keeps running into blocks
without detecting them (i.e. it hangs instead of pausing), add the new
interstitial text here. Multi-locale: include CJK variants.

## Why not Playwright's locator API?

Playwright's `page.locator('text=Website')` is ergonomic but:

- Each call is a round-trip to the browser. For 17 fields × 200 businesses,
  that's 3,400 round-trips — seconds of overhead per run.
- `:has-text()` doesn't work inside `page.evaluate()`, which is where we do
  the bulk extraction in a single round-trip.
- The locator API auto-retries, which is great for tests but masks selector
  rot — we *want* a null field to surface immediately as a WARN so we know
  to update the selector.

The current design (one `page.evaluate` pulls all raw records, normalization
happens in Node) is ~50× faster than a locator-per-field approach and makes
extraction-rate reporting trivial.

## Test coverage

Every field parser has unit tests in `tests/extract.test.js` (67 tests) and
`tests/detail.test.js` (55 tests), including end-to-end extraction against
HTML fixture cards that match the live Maps DOM. When you add a new
selector, add a fixture card that exercises it — this catches regressions
when Google changes the DOM again.
