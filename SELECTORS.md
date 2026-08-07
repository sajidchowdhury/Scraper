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

### Detail-panel open strategy (`src/detail.js` — `openDetailPanelOnPage`)

Unlike list-view extraction (which reads the DOM in one `page.evaluate`),
opening a detail panel is an **interaction**: find the link, click it, wait
for the panel. This is where most deep-scrape breakages happen. The strategy
has three stages, each with diagnostic logging at `warn` level so failures
are visible at the default `info` log level:

**Stage 1 — Find the anchor** (tried in order, first match wins):

| # | Selector | Why |
|---|---|---|
| 1 | `a[href*="<place_id>"]` | Most stable — `place_id` is a short base64-ish string (`ChIJ...`) with no CSS-special characters. Always present in the href. |
| 2 | `a[href*="<maps_url>"]` | Canonical URL substring. Works but the URL contains `( ) ! : @ ,` which can occasionally confuse attribute matching. |
| 3 | `a[href*="/maps/place/"]` | Generic fallback — matches any place link. May open the wrong business if the first two fail, but at least the panel opens. |
| 4 | `div[role="article"][aria-label*="<name>"]` | Card-container fallback for layouts where the card itself is the clickable element (not a nested `<a>`). |

If all four fail → `warn: no anchor/card found in DOM` with the business name,
place_id, and the full list of tried selectors.

**Stage 2 — Click** (with `scrollIntoViewIfNeeded` first):

After scroll-to-load, the target card may be off-screen (Google Maps
virtualizes the feed). Playwright's auto-scroll can miss on virtualized lists,
so we explicitly scroll the anchor into view, then click. If the click throws
(element detached, overlay intercepting) → `warn: click threw` with the error
message and which selector matched.

**Stage 3 — Wait for the panel** (two signals race, first wins):

| Signal | Method | Why |
|---|---|---|
| URL change | `page.waitForFunction(() => location.pathname.includes('/maps/place/'))` | **Most robust.** Google Maps uses pushState navigation — the URL changes from `/search/...` to `/place/...` the instant the panel opens. Immune to DOM rewrites. |
| DOM element | `page.waitForSelector('button[aria-label*="Back"], div[role="region"], h1, ...')` | Secondary. Catches cases where the URL didn't change (rare). |

If neither fires within 12s → `warn: wait timed out` with `beforeUrl`,
`afterUrl`, and `urlChanged` (boolean). **This is the key diagnostic**: if
`urlChanged: true` but the wait still timed out, the click worked but landed
somewhere unexpected. If `urlChanged: false`, the click was a no-op (element
was the wrong target, or Google swallowed the click).

> **Historical note:** the old code waited only for DOM selectors including
> `h1[data-attrid="title"]`, which was a 2020-era Google Maps selector that no
> longer exists. Every detail open timed out (0% success rate) with no
> diagnostic output because failures only logged at `debug` level. The Phase
> 1.11 hardening added the URL-change signal and promoted diagnostics to
> `warn`.

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
`tests/detail.test.js` (66 tests, including 11 for the Phase 1.11
`openDetailPanelOnPage` hardening), including end-to-end extraction against
HTML fixture cards that match the live Maps DOM. When you add a new
selector, add a fixture card that exercises it — this catches regressions
when Google changes the DOM again.

## Self-healing selectors (Phase 2.11)

Phase 2.11 adds a self-healing layer on top of the fallback-chain pattern:
when all selectors for a field miss, the scraper falls back to pattern-based
discovery, and when extraction rates drop below a threshold, it aborts early
+ dumps the DOM for the operator to craft a fix. This section documents the
four layers of defense and how to use them.

### Layer 1 — Selector versioning (`src/selectors/version.js`)

Every selector set (list-view, detail-panel, search-feed, scroll-markers)
has a `version` and `lastVerifiedDate` in `src/selectors/version.js`. On
startup the scraper logs the active version:

```
[selectors] Selectors list v3 (last verified 2026-08-07, 12 days ago)
[selectors] Selectors detail v2 (last verified 2026-08-07, 12 days ago)
```

If a set is older than `--maxSelectorAge` (default: 30 days), a warning is
logged:

```
[selectors] WARN: Selectors last verified 45 days ago (list v3) — consider
re-running the fixture test (bun test tests/selectors-fixture.test.js) and
bumping the version in src/selectors/version.js if the DOM changed.
```

**When you re-verify selectors against a new fixture**, bump the version
number and update `lastVerifiedDate` to today's date in
`src/selectors/version.js`. This is the single source of truth that the
staleness warning reads from.

### Layer 2 — Startup health check (`src/selectors/health-check.js`)

Before the main scrape, the scraper loads a known-good HTML fixture
(default: `tests/fixtures/Cafe_Berlin_feed.html`), runs `extractBusinesses`,
and checks the extraction rates:

- **Core fields** (name, rating, reviews_count, address) must extract at
  ≥ 50%. If any is below, the run is **aborted** with exit code 3 and a
  clear error message.
- **Secondary fields** (phone, website, plus_code, etc.) below 30% log a
  warning but the run continues.

The check takes ~15s (browser launch + fixture load + extraction). Skip it
with `--skipHealthCheck` for emergency runs.

```
[selectors] Running extraction-rate health check
[selectors] Health check passed (total=14, coreRates={name:100%, rating:93%, ...})
```

On failure:

```
[selectors] ERROR: Health check FAILED — aborting run
  failingCore: ['rating', 'reviews_count']
  coreRates: {name:100%, rating:42%, reviews_count:35%, address:100%}
  reason: Extraction rates critically low (rating=42%, reviews_count=35%) —
          likely a DOM change. Run scripts/capture-fixtures.js and update
          selectors. Use --skipHealthCheck to force.
  hint: Run `npm run capture-fixtures` to refresh fixtures, then
        `bun test tests/selectors-fixture.test.js`. Use --skipHealthCheck
        to bypass for an emergency run.
```

### Layer 3 — First-batch abort (in `src/extract.js`)

After the first 10 businesses of a real scrape, `extractBusinesses` checks
the extraction rates. If any core field is below 50%, it throws a
`SELECTOR_FAILURE` error with `exitCode=3`. This catches a DOM change that
the startup check missed (e.g. the fixture was stale but the live page moved
further). The error is caught in `src/index.js`, which exits with code 3
and logs the failing fields + a hint to run `scripts/capture-fixtures.js`.

```
[extract] WARN: Secondary fields below threshold (continuing)
  failingSecondary: ['phone', 'website']
  secondaryRates: {phone:25%, website:20%, ...}
```

On critical failure (propagates to `src/index.js`):

```
ERROR: Run aborted — selector failure (extraction rates critically low)
  failingCore: ['rating']
  coreRates: {name:100%, rating:30%, reviews_count:95%, address:100%}
  reason: Extraction rates critically low (rating=30%) — likely a DOM change.
  hint: Run `npm run capture-fixtures` to refresh fixtures, then
        `bun test tests/selectors-fixture.test.js`. Inspect
        data/selector-debug/ for DOM snippets. Use --skipHealthCheck to
        bypass for an emergency run.
```

### Layer 4 — Heuristic auto-discovery (`src/selectors/auto-discover.js`)

When all selectors for a discoverable field miss on a card, the scraper
falls back to pattern-based discovery. Discoverable fields:

| Field | Pattern |
|---|---|
| `phone` | element with `aria-label*="phone"` + phone regex, OR `a[href^="tel:"]`, OR `[data-item-id*="phone"]`, OR any element whose text matches `^[+]?[\d\s\-()]{7,}$` |
| `website` | `<a href^="http">` whose host is NOT `google.com` / `maps.google.*` |
| `rating` | element with `aria-label` containing "rated" or "stars", OR `[role="img"]` with aria-label matching a number |
| `reviews_count` | element whose text matches `^\(\d[\d,]*\)$` or `^\d[\d,]*\s+reviews?$` |

Discovery is a **fallback, not a primary strategy** — it's slow (one pass per
missing field per card) and produces a less reliable value. The intent is to
keep extraction alive (non-null fields) when Google changes the DOM, until a
human can craft a new selector. Every successful discovery is logged so the
operator can copy the suggested selector:

```
[extract] Auto-discovered phone field (selector: span[aria-label*="Phone"])
  — add to SELECTORS.js
  cardIndex: 5, field: phone, value: +49 123 4567890
```

Disable with `--autoDiscover off` (discovery is on by default).

### Layer 5 — Selector debug dumps (`src/selectors/debug-dump.js`)

When a field's extraction rate drops below 80% (the dump threshold), the
scraper writes the first 500 chars of each card's innerHTML to
`data/selector-debug/{field}_{timestamp}.html`. This gives the developer a
sample of the actual DOM that's failing the selector, so they can craft a
new selector without re-running the scrape.

```
[extract] WARN: Selector debug dump written for low-rate field: phone
  field: phone, rate: 25%, threshold: 80%, missingCount: 15
  path: data/selector-debug/phone_2026-08-07T12-00-00-000Z.html
  hint: Inspect the dump to craft a new selector, then add it to
        src/extract.js SELECTORS.phone
```

Disable with `--selectorDebugDump off` (dumps are on by default). Override
the directory with `--selectorDebugDir <path>`.

### Fixture-based regression test (`tests/selectors-fixture.test.js`)

Run `bun test tests/selectors-fixture.test.js` to verify the selectors
against the captured HTML fixtures. The test loads each fixture in
`tests/fixtures/*_feed.html`, runs `extractBusinesses`, and asserts:

- Core fields extract at ≥ 70% (catches selector breakage; allows for
  legitimate nulls on real fixtures).
- Secondary fields extract at ≥ 15% (catches total breakage; allows for
  sparse fields like phone/website that are often detail-panel-only).

When this test fails, it means Google changed the DOM and a selector needs
updating. The failure message includes the field name, rate, and a hint to
run `scripts/capture-fixtures.js` + inspect `data/selector-debug/`.

### Config flags summary

| Flag | Default | Description |
|---|---|---|
| `--skipHealthCheck` | off | Skip the startup extraction-rate health check (emergency runs) |
| `--autoDiscover on\|off` | on | Heuristic field auto-discovery when selectors fail |
| `--selectorDebugDump on\|off` | on | Write DOM snippets for low-rate fields to `data/selector-debug/` |
| `--maxSelectorAge <days>` | 30 | Warn when selector sets are older than this |
| `--selectorDebugDir <path>` | `./data/selector-debug` | Override the debug-dump directory |

### How to update selectors when the DOM changes

1. **Run the fixture test** to identify which fields broke:
   ```bash
   bun test tests/selectors-fixture.test.js
   ```

2. **Inspect the debug dumps** for the broken field:
   ```bash
   ls data/selector-debug/
   # phone_2026-08-07T12-00-00-000Z.html  rating_2026-08-07T12-00-00-000Z.html
   ```
   The dump contains the first 500 chars of each card's innerHTML — enough
   to identify the new DOM structure.

3. **Add the new selector** at the TOP of the field's array in
   `src/extract.js` (keep the old ones as fallbacks):
   ```js
   rating: [
     'YOUR_NEW_SELECTOR_HERE',                                // ← add here
     '.fontBodyMedium > span[aria-label*="stars"]',
     'span[aria-label$="stars"]',
     // ...
   ],
   ```

4. **Bump the version + lastVerifiedDate** in `src/selectors/version.js`:
   ```js
   list: {
     version: 4,                                    // ← bump
     lastVerifiedDate: '2026-09-15',                // ← today's date
     // ...
   },
   ```

5. **Re-run the fixture test** to confirm the fix:
   ```bash
   bun test tests/selectors-fixture.test.js
   ```

6. **Re-capture fixtures** if the DOM has changed significantly:
   ```bash
   npm run capture-fixtures -- --query "Cafe" --location "Berlin"
   ```
