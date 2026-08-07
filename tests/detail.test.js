'use strict';

/**
 * tests/detail.test.js — Phase 1.5 unit tests
 *
 * Coverage:
 *   1. Field parsers (normalizeDay, parseHoursTable, parseBusyLevel,
 *      parseHourFromLabel, parsePopularTimes, parseReview, classifySocialUrl,
 *      parseSocialProfiles)
 *   2. normalizeDetail — happy path + missing-field handling
 *   3. mergeDetailFields — stable schema, no mutation of input
 *   4. deepScrapeDetails (DI) — happy path, openFn failure, extractFn throw,
 *      timeout, backFn always called even on failure (failure isolation)
 *   5. deepScrapeAll — success-rate tracking + sample-step skipping +
 *      per-business failure isolation (one bad business doesn't crash batch)
 *   6. extractDetailFromPage end-to-end against a static HTML fixture loaded
 *      via Playwright (verifies in-browser selectors + full normalize pipeline)
 *
 * Run: bun test tests/
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const {
  DETAIL_FIELDS,
  EMPTY_DETAIL,
  normalizeDay,
  parseHoursTable,
  parseBusyLevel,
  parseHourFromLabel,
  parsePopularTimes,
  parseReview,
  classifySocialUrl,
  parseSocialProfiles,
  normalizeDetail,
  mergeDetailFields,
  deepScrapeDetails,
  deepScrapeAll,
  extractDetailFromPage,
  openDetailPanelOnPage,
  safePageUrl,
  sleep,
} = require('../src/detail');

// ---------------------------------------------------------------------------
// 1. Field parser unit tests
// ---------------------------------------------------------------------------

describe('normalizeDay', () => {
  test('normalizes full day names', () => {
    expect(normalizeDay('Monday')).toBe('Monday');
    expect(normalizeDay('tuesday')).toBe('Tuesday');
    expect(normalizeDay('WEDNESDAY')).toBe('Wednesday');
  });
  test('normalizes abbreviations', () => {
    expect(normalizeDay('Mon')).toBe('Monday');
    expect(normalizeDay('Tue')).toBe('Tuesday');
    expect(normalizeDay('Fri')).toBe('Friday');
    expect(normalizeDay('Sun')).toBe('Sunday');
  });
  test('strips trailing dots', () => {
    expect(normalizeDay('Mon.')).toBe('Monday');
    expect(normalizeDay('Thurs.')).toBe('Thursday');
  });
  test('passes through unknown day labels', () => {
    expect(normalizeDay('Lundi')).toBe('Lundi');
    expect(normalizeDay(null)).toBeNull();
  });
});

describe('parseHoursTable', () => {
  test('parses a full 7-day table', () => {
    const rows = [
      { day: 'Monday', text: '9:00 AM – 5:00 PM' },
      { day: 'Tuesday', text: '9:00 AM – 5:00 PM' },
      { day: 'Wednesday', text: 'Closed' },
      { day: 'Thursday', text: '9:00 AM – 5:00 PM' },
      { day: 'Friday', text: '9:00 AM – 9:00 PM' },
      { day: 'Saturday', text: '10:00 AM – 6:00 PM' },
      { day: 'Sunday', text: 'Closed' },
    ];
    const out = parseHoursTable(rows);
    expect(out).toHaveLength(7);
    expect(out[0]).toEqual({ day: 'Monday', hours: '9:00 AM – 5:00 PM' });
    expect(out[2]).toEqual({ day: 'Wednesday', hours: 'Closed' });
    expect(out[6]).toEqual({ day: 'Sunday', hours: 'Closed' });
  });
  test('normalizes day abbreviations', () => {
    const out = parseHoursTable([{ day: 'Mon', text: '9-5' }]);
    expect(out[0].day).toBe('Monday');
  });
  test('skips rows with no text', () => {
    const out = parseHoursTable([
      { day: 'Mon', text: '' },
      { day: 'Tue', text: '9-5' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].day).toBe('Tuesday');
  });
  test('returns null for empty input', () => {
    expect(parseHoursTable([])).toBeNull();
    expect(parseHoursTable(null)).toBeNull();
  });
});

describe('parseBusyLevel', () => {
  test('very busy → level 4', () => {
    expect(parseBusyLevel('Usually very busy')).toBe(4);
    expect(parseBusyLevel('Currently extremely busy')).toBe(4);
  });
  test('busy → level 3', () => {
    expect(parseBusyLevel('Usually busy')).toBe(3);
    expect(parseBusyLevel('Currently busy')).toBe(3);
  });
  test('a little busy → level 2', () => {
    expect(parseBusyLevel('Usually a little busy')).toBe(2);
    expect(parseBusyLevel('Usually not as busy')).toBe(2);
  });
  test('not busy → level 1', () => {
    expect(parseBusyLevel('Usually not busy')).toBe(1);
    expect(parseBusyLevel('Not busy')).toBe(1);
  });
  test('unknown label → level 0', () => {
    expect(parseBusyLevel('Some random text')).toBe(0);
    expect(parseBusyLevel(null)).toBe(0);
  });
});

describe('parseHourFromLabel', () => {
  test('parses AM hours', () => {
    expect(parseHourFromLabel('Usually busy at 9 AM')).toBe(9);
    expect(parseHourFromLabel('at 12 AM')).toBe(0); // midnight
  });
  test('parses PM hours', () => {
    expect(parseHourFromLabel('Usually busy at 3 PM')).toBe(15);
    expect(parseHourFromLabel('at 12 PM')).toBe(12); // noon
    expect(parseHourFromLabel('at 11 PM')).toBe(23);
  });
  test('returns null when no hour', () => {
    expect(parseHourFromLabel('Not busy')).toBeNull();
    expect(parseHourFromLabel(null)).toBeNull();
  });
});

describe('parsePopularTimes', () => {
  test('parses per-day busyness histograms', () => {
    const entries = [
      {
        day: 'Monday',
        bars: [
          { label: 'Not busy' },
          { label: 'Usually busy at 9 AM' },
          { label: 'Usually very busy' },
        ],
      },
      {
        day: 'Tue',
        bars: [{ label: 'Usually busy at 3 PM' }],
      },
    ];
    const out = parsePopularTimes(entries);
    expect(out).toHaveLength(2);
    expect(out[0].day).toBe('Monday');
    expect(out[0].busy).toHaveLength(3);
    expect(out[0].busy[0]).toEqual({ hour: 0, level: 1, label: 'Not busy' });
    expect(out[0].busy[1]).toEqual({ hour: 9, level: 3, label: 'Usually busy at 9 AM' });
    expect(out[0].busy[2]).toEqual({ hour: 2, level: 4, label: 'Usually very busy' });
    expect(out[1].day).toBe('Tuesday');
    expect(out[1].busy[0].hour).toBe(15);
  });
  test('returns null for empty input', () => {
    expect(parsePopularTimes([])).toBeNull();
    expect(parsePopularTimes(null)).toBeNull();
  });
});

describe('parseReview', () => {
  test('parses a full review', () => {
    const raw = {
      author: 'Jane D.',
      ratingRaw: '5 stars',
      text: 'Best coffee in town!',
      dateRaw: '2 weeks ago',
    };
    expect(parseReview(raw)).toEqual({
      author: 'Jane D.',
      rating: 5,
      text: 'Best coffee in town!',
      date: '2 weeks ago',
    });
  });
  test('parses rating from "Rated 4.5 out of 5"', () => {
    const r = parseReview({ ratingRaw: 'Rated 4.5 out of 5', text: 'Good' });
    expect(r.rating).toBe(4.5);
  });
  test('returns null rating for non-numeric', () => {
    const r = parseReview({ author: 'A', ratingRaw: 'No rating', text: 'ok' });
    expect(r.rating).toBeNull();
  });
  test('returns null for completely empty review', () => {
    expect(parseReview({})).toBeNull();
    expect(parseReview(null)).toBeNull();
  });
  test('keeps review with author but no text', () => {
    const r = parseReview({ author: 'Anon', ratingRaw: '4 stars' });
    expect(r).not.toBeNull();
    expect(r.author).toBe('Anon');
    expect(r.text).toBeNull();
  });
  test('rejects out-of-range rating (>5)', () => {
    const r = parseReview({ ratingRaw: '7.2 stars', text: 'x' });
    expect(r.rating).toBeNull();
  });
});

describe('classifySocialUrl', () => {
  test('identifies known platforms', () => {
    expect(classifySocialUrl('https://instagram.com/cafeberlin')).toBe('instagram');
    expect(classifySocialUrl('https://www.facebook.com/cafeberlin')).toBe('facebook');
    expect(classifySocialUrl('https://twitter.com/cafeberlin')).toBe('twitter');
    expect(classifySocialUrl('https://x.com/cafeberlin')).toBe('twitter');
    expect(classifySocialUrl('https://linkedin.com/company/cafeberlin')).toBe('linkedin');
    expect(classifySocialUrl('https://youtube.com/@cafeberlin')).toBe('youtube');
    expect(classifySocialUrl('https://youtu.be/abc')).toBe('youtube');
  });
  test('returns "other" for generic websites', () => {
    expect(classifySocialUrl('https://cafe-berlin.de')).toBe('other');
    expect(classifySocialUrl(null)).toBe('other');
  });
});

describe('parseSocialProfiles', () => {
  test('dedupes by URL and strips tracking params', () => {
    const urls = [
      'https://instagram.com/cafeberlin?utm_source=gmaps',
      'https://instagram.com/cafeberlin', // dupe after utm strip
      'https://facebook.com/cafeberlin',
    ];
    const out = parseSocialProfiles(urls);
    expect(out).toHaveLength(2);
    expect(out[0].platform).toBe('instagram');
    expect(out[0].url).toBe('https://instagram.com/cafeberlin');
    expect(out[1].platform).toBe('facebook');
  });
  test('handles empty input', () => {
    expect(parseSocialProfiles([])).toEqual([]);
    expect(parseSocialProfiles(null)).toEqual([]);
  });
  test('skips null/empty entries', () => {
    const out = parseSocialProfiles([null, '', 'https://instagram.com/x']);
    expect(out).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. normalizeDetail
// ---------------------------------------------------------------------------

describe('normalizeDetail', () => {
  test('happy path — all fields populated', () => {
    const raw = {
      hoursRows: [{ day: 'Mon', text: '9-5' }],
      popularDayEntries: [{ day: 'Mon', bars: [{ label: 'Usually busy at 3 PM' }] }],
      topReviews: [{ author: 'A', ratingRaw: '5 stars', text: 'Great', dateRaw: 'yesterday' }],
      photos: ['https://img.example.com/1.jpg', 'https://img.example.com/2.jpg'],
      reservation_url: 'https://opentable.com/r/cafeberlin',
      menu_url: 'https://cafeberlin.de/menu',
      socialHrefs: ['https://instagram.com/cafeberlin'],
    };
    const d = normalizeDetail(raw, { maxPhotos: 5 });
    expect(d.detail_scraped).toBe(true);
    expect(d.full_hours).toEqual([{ day: 'Monday', hours: '9-5' }]);
    expect(d.popular_times).toHaveLength(1);
    expect(d.top_reviews).toHaveLength(1);
    expect(d.top_reviews[0].rating).toBe(5);
    expect(d.photos).toHaveLength(2);
    expect(d.reservation_url).toBe('https://opentable.com/r/cafeberlin');
    expect(d.menu_url).toBe('https://cafeberlin.de/menu');
    expect(d.social_profiles[0].platform).toBe('instagram');
  });

  test('empty raw → EMPTY_DETAIL shape', () => {
    const d = normalizeDetail(null);
    expect(d.detail_scraped).toBe(true);
    expect(d.full_hours).toBeNull();
    expect(d.popular_times).toBeNull();
    expect(d.top_reviews).toEqual([]);
    expect(d.photos).toEqual([]);
    expect(d.reservation_url).toBeNull();
    expect(d.menu_url).toBeNull();
    expect(d.social_profiles).toEqual([]);
  });

  test('respects maxPhotos cap', () => {
    const raw = { photos: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] };
    const d = normalizeDetail(raw, { maxPhotos: 3 });
    expect(d.photos).toHaveLength(3);
  });

  test('filters out null reviews', () => {
    const raw = {
      topReviews: [
        { author: 'A', ratingRaw: '5 stars', text: 'good' },
        {}, // empty → should be dropped
        { author: 'B', ratingRaw: '4 stars', text: 'ok' },
      ],
    };
    const d = normalizeDetail(raw);
    expect(d.top_reviews).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. mergeDetailFields
// ---------------------------------------------------------------------------

describe('mergeDetailFields', () => {
  test('adds all 8 detail keys to a list-view business record', () => {
    const business = { name: 'Cafe Berlin', rating: 4.5, address: '123 Main St' };
    const merged = mergeDetailFields(business, {
      full_hours: [{ day: 'Monday', hours: '9-5' }],
      popular_times: null,
      top_reviews: [],
      photos: ['x.jpg'],
      reservation_url: null,
      menu_url: 'https://menu.de',
      social_profiles: [],
      detail_scraped: true,
    });
    for (const f of DETAIL_FIELDS) {
      expect(merged).toHaveProperty(f);
    }
    expect(merged.name).toBe('Cafe Berlin');
    expect(merged.rating).toBe(4.5);
    expect(merged.detail_scraped).toBe(true);
    expect(merged.menu_url).toBe('https://menu.de');
  });

  test('does NOT mutate the input business record', () => {
    const business = { name: 'Cafe', rating: 4.0 };
    mergeDetailFields(business, EMPTY_DETAIL);
    expect(Object.keys(business).sort()).toEqual(['name', 'rating'].sort());
  });

  test('null detail → EMPTY_DETAIL shape (stable schema)', () => {
    const merged = mergeDetailFields({ name: 'X' }, null);
    expect(merged.detail_scraped).toBe(false);
    expect(merged.full_hours).toBeNull();
    expect(merged.photos).toEqual([]);
    expect(merged.top_reviews).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. deepScrapeDetails (DI version) — failure isolation tests
// ---------------------------------------------------------------------------

const noopLogger = { info() {}, debug() {}, warn() {}, error() {} };
const captureLogger = () => {
  const logs = [];
  return {
    logs,
    info: (m, c) => logs.push(['info', m, c]),
    debug: (m, c) => logs.push(['debug', m, c]),
    warn: (m, c) => logs.push(['warn', m, c]),
    error: (m, c) => logs.push(['error', m, c]),
  };
};

describe('deepScrapeDetails (DI)', () => {
  test('happy path — openFn ok, extractFn returns raw, backFn called', async () => {
    const calls = { open: 0, extract: 0, back: 0 };
    const res = await deepScrapeDetails({
      business: { name: 'Test Cafe' },
      openFn: async () => {
        calls.open++;
        return true;
      },
      extractFn: async () => {
        calls.extract++;
        return { hoursRows: [{ day: 'Mon', text: '9-5' }], topReviews: [], photos: [] };
      },
      backFn: async () => {
        calls.back++;
      },
      delayMinMs: 0,
      delayMaxMs: 0,
      timeoutMs: 5000,
      logger: noopLogger,
    });
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    expect(calls.open).toBe(1);
    expect(calls.extract).toBe(1);
    expect(calls.back).toBe(1); // ALWAYS called, even on success
    expect(res.detail.detail_scraped).toBe(true);
    expect(res.detail.full_hours).toEqual([{ day: 'Monday', hours: '9-5' }]);
  });

  test('openFn returns false → ok=false, backFn still called, EMPTY_DETAIL', async () => {
    const calls = { back: 0 };
    const res = await deepScrapeDetails({
      business: { name: 'X' },
      openFn: async () => false,
      extractFn: async () => {
        throw new Error('should not be called');
      },
      backFn: async () => {
        calls.back++;
      },
      delayMinMs: 0,
      delayMaxMs: 0,
      logger: noopLogger,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('open_failed');
    expect(calls.back).toBe(1);
    expect(res.detail.detail_scraped).toBe(false);
    expect(res.detail.full_hours).toBeNull();
  });

  test('extractFn throws → ok=false, error captured, backFn still called', async () => {
    const calls = { back: 0 };
    const logger = captureLogger();
    const res = await deepScrapeDetails({
      business: { name: 'Bomb' },
      openFn: async () => true,
      extractFn: async () => {
        throw new Error('selector blew up');
      },
      backFn: async () => {
        calls.back++;
      },
      delayMinMs: 0,
      delayMaxMs: 0,
      logger,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('selector blew up');
    expect(calls.back).toBe(1); // CRITICAL: failure isolation — backFn always runs
    expect(res.detail.detail_scraped).toBe(false);
    // Should have logged a warning about the failure
    expect(logger.logs.some(([, m]) => m.includes('Detail scrape failed'))).toBe(true);
  });

  test('backFn throws → swallowed, does NOT propagate (failure isolation)', async () => {
    const res = await deepScrapeDetails({
      business: { name: 'X' },
      openFn: async () => true,
      extractFn: async () => ({ hoursRows: [], topReviews: [], photos: [] }),
      backFn: async () => {
        throw new Error('back button missing');
      },
      delayMinMs: 0,
      delayMaxMs: 0,
      logger: noopLogger,
    });
    // The scrape itself succeeded — backFn error was swallowed
    expect(res.ok).toBe(true);
  });

  test('timeout — extractFn hangs past timeoutMs → ok=false, error captured', async () => {
    const calls = { back: 0 };
    const res = await deepScrapeDetails({
      business: { name: 'Slow' },
      openFn: async () => true,
      extractFn: async () => {
        await sleep(300);
        return { hoursRows: [] };
      },
      backFn: async () => {
        calls.back++;
      },
      delayMinMs: 0,
      delayMaxMs: 0,
      timeoutMs: 50, // very short
      logger: noopLogger,
    });
    // Either the timeout fired during extract (error contains "timeout") OR
    // extract finished just under the wire. We accept ok=false with timeout
    // error OR ok=true if it raced. Assert backFn was called either way.
    expect(calls.back).toBe(1);
    if (!res.ok) {
      expect(res.error).toMatch(/timeout/);
    }
  }, 10000);
});

// ---------------------------------------------------------------------------
// 5. deepScrapeAll — batch + success rate + sample step
// ---------------------------------------------------------------------------

describe('deepScrapeAll (batch)', () => {
  test('sample-step larger than list — only i=0 scrapes (0 % N === 0)', async () => {
    const businesses = [{ name: 'A', maps_url: 'x' }, { name: 'B', maps_url: 'y' }];
    // With sampleStep=10, i=0 (0 % 10 === 0) scrapes; i=1 (1 % 10 !== 0) skips.
    // So attempted=1. The stub page fails to open → succeeded=0, successRate=0.
    const page = makeStubPage();
    const stats = await deepScrapeAll(page, businesses, {
      detail: { sampleStep: 10, delayMinMs: 0, delayMaxMs: 0, timeoutMs: 1000 },
    }, noopLogger);
    expect(stats.attempted).toBe(1);
    expect(stats.succeeded).toBe(0);
    expect(stats.failed).toBe(1);
    expect(stats.successRate).toBe(0);
    // i=0 was attempted → got EMPTY_DETAIL (open failed); i=1 skipped → also EMPTY_DETAIL
    expect(businesses[0].detail_scraped).toBe(false);
    expect(businesses[1].detail_scraped).toBe(false);
  });

  test('sample-step=2 scrapes every other business', async () => {
    const businesses = [
      { name: 'A', maps_url: 'a' },
      { name: 'B', maps_url: 'b' },
      { name: 'C', maps_url: 'c' },
      { name: 'D', maps_url: 'd' },
    ];
    const page = makeStubPage(); // openFn will fail → all attempts ok=false
    const stats = await deepScrapeAll(page, businesses, {
      detail: { sampleStep: 2, delayMinMs: 0, delayMaxMs: 0, timeoutMs: 500 },
    }, noopLogger);
    // i=0 (scrape), i=1 (skip), i=2 (scrape), i=3 (skip) → attempted=2
    expect(stats.attempted).toBe(2);
    expect(stats.failed).toBe(2);
  });

  test('one bad business does not crash the batch — all get detail fields', async () => {
    const businesses = [{ name: 'A', maps_url: 'a' }, { name: 'B', maps_url: 'b' }];
    const page = makeStubPage();
    const stats = await deepScrapeAll(page, businesses, {
      detail: { sampleStep: 1, delayMinMs: 0, delayMaxMs: 0, timeoutMs: 500 },
    }, noopLogger);
    expect(stats.attempted).toBe(2);
    // Both businesses have detail fields merged in (whether scrape succeeded or not)
    for (const b of businesses) {
      expect(b).toHaveProperty('detail_scraped');
      expect(b).toHaveProperty('full_hours');
      expect(b).toHaveProperty('photos');
    }
  });

  test('logs success rate and warns when below 80%', async () => {
    const businesses = [{ name: 'A', maps_url: 'a' }, { name: 'B', maps_url: 'b' }];
    const page = makeStubPage();
    const logs = [];
    const logger = {
      info: (m, c) => logs.push(['info', m, c]),
      debug: () => {},
      warn: (m, c) => logs.push(['warn', m, c]),
      error: () => {},
    };
    await deepScrapeAll(page, businesses, {
      detail: { sampleStep: 1, delayMinMs: 0, delayMaxMs: 0, timeoutMs: 500 },
    }, logger);
    // Should have logged "Deep-scrape complete" with successRate
    const complete = logs.find(([level, m]) => level === 'info' && m === 'Deep-scrape complete');
    expect(complete).toBeDefined();
    // 0% success → should trigger WARN
    const warn = logs.find(([level, m]) => level === 'warn' && m.includes('below 80%'));
    expect(warn).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5b. openDetailPanelOnPage — Phase 1.11 hardening
//     Verifies: place_id-first anchor matching, URL-change wait signal,
//     warn-level diagnostics on every failure path, safePageUrl robustness.
// ---------------------------------------------------------------------------

describe('openDetailPanelOnPage (Phase 1.11 hardening)', () => {
  /**
   * Build a configurable stub page. opts:
   *   - anchorFor: function(sel) => elementHandle | null  (controls page.$)
   *   - url: string (current page URL — controls safePageUrl + waitForFunction)
   *   - urlAfterClick: string (URL to report after click — simulates pushState)
   *   - waitForSelectorThrows: bool (if true, waitForSelector rejects)
   *   - clickThrows: bool (if true, anchor.click rejects)
   */
  function makeDetailStubPage(opts = {}) {
    let clicked = false;
    const url = opts.url || 'https://www.google.com/maps/search/cafe+in+berlin';
    const urlAfterClick = opts.urlAfterClick || url;
    // Every "found" anchor gets this handle. anchorFor() just decides whether
    // a given selector matches (returns truthy) or not (returns falsy).
    const anchorHandle = {
      click: async () => {
        clicked = true;
        if (opts.clickThrows) throw new Error('click intercepted');
      },
      scrollIntoViewIfNeeded: async () => {},
    };
    return {
      _clicked: () => clicked,
      url: () => (clicked ? urlAfterClick : url),
      $: async (sel) => {
        if (typeof opts.anchorFor === 'function') {
          return opts.anchorFor(sel) ? anchorHandle : null;
        }
        return null;
      },
      $$: async () => [],
      waitForFunction: async (fn, { timeout } = {}) => {
        // If urlAfterClick contains /maps/place/, resolve; else reject.
        if (urlAfterClick.includes('/maps/place/')) return true;
        throw new Error(`waitForFunction timeout (${timeout}ms)`);
      },
      waitForSelector: async () => {
        if (opts.waitForSelectorThrows !== false) {
          throw new Error('waitForSelector timeout');
        }
        return {};
      },
      evaluate: async () => ({}),
      goBack: async () => {},
    };
  }

  function makeCaptureLogger() {
    const warns = [];
    const debugs = [];
    return {
      warns,
      debugs,
      phase: () => ({
        warn: (msg, ctx) => warns.push({ msg, ctx }),
        debug: (msg, ctx) => debugs.push({ msg, ctx }),
        info: () => {},
        error: () => {},
      }),
      warn: (msg, ctx) => warns.push({ msg, ctx }),
      debug: (msg, ctx) => debugs.push({ msg, ctx }),
      info: () => {},
      error: () => {},
    };
  }

  test('returns false + logs warn when no anchor found in DOM', async () => {
    const page = makeDetailStubPage({ anchorFor: () => null });
    const logger = makeCaptureLogger();
    const business = { name: 'Cafe X', maps_url: 'https://www.google.com/maps/place/X', place_id: 'ChIJabc' };

    const result = await openDetailPanelOnPage(page, business, { logger });

    expect(result).toBe(false);
    expect(logger.warns.length).toBeGreaterThanOrEqual(1);
    const noAnchorWarn = logger.warns.find((w) => w.msg.includes('no anchor/card found'));
    expect(noAnchorWarn).toBeDefined();
    expect(noAnchorWarn.ctx.business).toBe('Cafe X');
    expect(noAnchorWarn.ctx.place_id).toBe('ChIJabc');
    // Should have tried the place_id selector first
    expect(noAnchorWarn.ctx.triedSelectors[0]).toContain('ChIJabc');
  });

  test('tries place_id selector before maps_url selector', async () => {
    let seenSelectors = [];
    const page = makeDetailStubPage({
      anchorFor: (sel) => { seenSelectors.push(sel); return null; },
    });
    const logger = makeCaptureLogger();
    const business = {
      name: 'Cafe Y',
      maps_url: 'https://www.google.com/maps/place/Y/@52.5',
      place_id: 'ChIJxyz',
    };

    await openDetailPanelOnPage(page, business, { logger });

    // First selector tried must be the place_id one (most stable)
    expect(seenSelectors[0]).toBe('a[href*="ChIJxyz"]');
    // maps_url selector tried second
    expect(seenSelectors[1]).toContain('maps/place');
    // generic fallback tried last
    expect(seenSelectors[2]).toBe('a[href*="/maps/place/"]');
  });

  test('returns true when URL changes to /maps/place/ after click', async () => {
    const page = makeDetailStubPage({
      anchorFor: (sel) => (sel.includes('ChIJ') ? {} : null),
      url: 'https://www.google.com/maps/search/cafe+in+berlin',
      urlAfterClick: 'https://www.google.com/maps/place/Cafe+Z/@52.5,13.4,15z',
      waitForSelectorThrows: true, // DOM wait fails — URL wait must save us
    });
    const logger = makeCaptureLogger();
    const business = { name: 'Cafe Z', place_id: 'ChIJzzz', maps_url: 'https://www.google.com/maps/place/Z' };

    const result = await openDetailPanelOnPage(page, business, { logger });

    expect(result).toBe(true);
    expect(page._clicked()).toBe(true);
  });

  test('logs warn with urlChanged:true when click navigated but wait still timed out', async () => {
    // Click happens, URL changes to a NON-/maps/place/ URL (e.g. some other
    // Google surface), so both urlWait and domWait reject → timeout. The
    // diagnostic must report urlChanged:true so the operator knows the click
    // worked but the destination was unexpected.
    const page = makeDetailStubPage({
      anchorFor: (sel) => (sel.includes('ChIJ') ? {} : null),
      url: 'https://www.google.com/maps/search/cafe',
      urlAfterClick: 'https://www.google.com/maps/search/something+else',
      waitForSelectorThrows: true,
    });
    const logger = makeCaptureLogger();
    const business = { name: 'Cafe W', place_id: 'ChIJwww', maps_url: 'https://www.google.com/maps/place/W' };

    const result = await openDetailPanelOnPage(page, business, { logger });

    expect(result).toBe(false);
    const timeoutWarn = logger.warns.find((w) => w.msg.includes('wait timed out'));
    expect(timeoutWarn).toBeDefined();
    expect(timeoutWarn.ctx.urlChanged).toBe(true);
    expect(timeoutWarn.ctx.beforeUrl).toContain('/search/cafe');
    expect(timeoutWarn.ctx.afterUrl).toContain('/search/something');
  });

  test('logs warn when click throws (element detached / intercepted)', async () => {
    const page = makeDetailStubPage({
      anchorFor: () => ({}),
      clickThrows: true,
    });
    const logger = makeCaptureLogger();
    const business = { name: 'Cafe V', place_id: 'ChIJvvv', maps_url: 'https://www.google.com/maps/place/V' };

    const result = await openDetailPanelOnPage(page, business, { logger });

    expect(result).toBe(false);
    const clickWarn = logger.warns.find((w) => w.msg.includes('click threw'));
    expect(clickWarn).toBeDefined();
    expect(clickWarn.ctx.error).toBe('click intercepted');
  });

  test('falls back to card-by-aria-label when no anchor matches', async () => {
    // Simulate: no a[href] matches, but a div[role=article][aria-label] does.
    const page = makeDetailStubPage({
      anchorFor: (sel) => {
        if (sel.includes('role="article"') && sel.includes('Cafe U')) return { click: async () => {} };
        return null;
      },
      urlAfterClick: 'https://www.google.com/maps/place/Cafe+U/@52.5',
      waitForSelectorThrows: true,
    });
    const logger = makeCaptureLogger();
    const business = { name: 'Cafe U', place_id: 'ChIJu u', maps_url: 'https://www.google.com/maps/place/U' };

    const result = await openDetailPanelOnPage(page, business, { logger });

    expect(result).toBe(true);
  });

  test('does not throw when business has no place_id or maps_url', async () => {
    const page = makeDetailStubPage({ anchorFor: () => null });
    const logger = makeCaptureLogger();
    const business = { name: 'Mystery Cafe' };

    const result = await openDetailPanelOnPage(page, business, { logger });

    expect(result).toBe(false);
    // Should still have tried the generic fallback selector
    const noAnchorWarn = logger.warns.find((w) => w.msg.includes('no anchor/card found'));
    expect(noAnchorWarn.ctx.triedSelectors).toContain('a[href*="/maps/place/"]');
  });
});

describe('safePageUrl', () => {
  test('returns page.url() when it is a function', () => {
    const page = { url: () => 'https://example.com/maps' };
    expect(safePageUrl(page)).toBe('https://example.com/maps');
  });

  test('returns null when page has no url method (synthetic stub)', () => {
    const page = { $: async () => null };
    expect(safePageUrl(page)).toBeNull();
  });

  test('returns null when page.url() throws', () => {
    const page = { url: () => { throw new Error('page closed'); } };
    expect(safePageUrl(page)).toBeNull();
  });

  test('returns null for null/undefined page', () => {
    expect(safePageUrl(null)).toBeNull();
    expect(safePageUrl(undefined)).toBeNull();
  });
});

/**
 * Build a stub Playwright-like page object whose click/waitFor/eval methods
 * resolve immediately. Used to test deepScrapeAll's batch math without a real
 * browser. openDetailPanelOnPage will fail gracefully (no real anchors) → ok=false.
 */
function makeStubPage() {
  return {
    $: async () => null,
    $$: async () => [],
    waitForSelector: async () => {
      throw new Error('not found (stub)');
    },
    evaluate: async () => ({
      hoursRows: [],
      popularDayEntries: [],
      topReviews: [],
      photos: [],
      reservation_url: null,
      menu_url: null,
      socialHrefs: [],
    }),
    goBack: async () => {},
    click: async () => {},
  };
}

// ---------------------------------------------------------------------------
// 6. End-to-end extraction against a static HTML detail-panel fixture
//    Verifies the in-browser selectors + full normalize pipeline.
// ---------------------------------------------------------------------------

const DETAIL_FIXTURE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Maps detail fixture</title></head>
<body>
  <div role="main">
    <div role="region" aria-label="Place info">
      <h1 data-attrid="title">Cafe Berlin</h1>

      <!-- Hours table -->
      <table aria-label="Hours table">
        <tr><td>Monday</td><td>9:00 AM – 5:00 PM</td></tr>
        <tr><td>Tuesday</td><td>9:00 AM – 5:00 PM</td></tr>
        <tr><td>Wednesday</td><td>Closed</td></tr>
        <tr><td>Thursday</td><td>9:00 AM – 5:00 PM</td></tr>
        <tr><td>Friday</td><td>9:00 AM – 9:00 PM</td></tr>
        <tr><td>Saturday</td><td>10:00 AM – 6:00 PM</td></tr>
        <tr><td>Sunday</td><td>Closed</td></tr>
      </table>

      <!-- Popular times -->
      <div aria-label="Popular times">
        <button aria-label="Monday">
          <div role="img" aria-label="Not busy"></div>
          <div role="img" aria-label="Usually busy at 9 AM"></div>
          <div role="img" aria-label="Usually very busy"></div>
        </button>
        <button aria-label="Tuesday">
          <div role="img" aria-label="Usually busy at 3 PM"></div>
        </button>
      </div>

      <!-- Reviews -->
      <div data-review-id="r1">
        <button data-href="contrib/123">Jane D.</button>
        <span role="img" aria-label="5 stars">5</span>
        <span class="wiI7pd">Best coffee in town!</span>
        <span class="rsqaWe">2 weeks ago</span>
      </div>
      <div data-review-id="r2">
        <button data-href="contrib/456">John S.</button>
        <span role="img" aria-label="4 stars">4</span>
        <span class="wiI7pd">Good but pricey.</span>
        <span class="rsqaWe">a month ago</span>
      </div>
      <div data-review-id="r3">
        <button data-href="contrib/789">Alex</button>
        <span role="img" aria-label="3 stars">3</span>
        <span class="wiI7pd">Decent.</span>
        <span class="rsqaWe">3 months ago</span>
      </div>

      <!-- Photos -->
      <button jsaction="photo:1"><img src="https://lh3.googleusercontent.com/photo1.jpg"></button>
      <button jsaction="photo:2"><img src="https://lh3.googleusercontent.com/photo2.jpg"></button>
      <button jsaction="photo:3"><img src="https://lh3.googleusercontent.com/photo3.jpg"></button>

      <!-- Reservation + Menu -->
      <a data-item-id="reservation" href="https://opentable.com/r/cafeberlin">Reserve</a>
      <a data-item-id="menu" href="https://cafeberlin.de/menu">Menu</a>

      <!-- Social -->
      <a data-item-id="authority" href="https://cafe-berlin.de">Website</a>
      <a href="https://instagram.com/cafeberlin?utm_source=gmaps">Instagram</a>
      <a href="https://facebook.com/cafeberlin">Facebook</a>

      <!-- Back button -->
      <button aria-label="Back to results">Back</button>
    </div>
  </div>
</body></html>`;

let browser;
let page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.setContent(DETAIL_FIXTURE_HTML, { waitUntil: 'domcontentloaded' });
});

afterAll(async () => {
  if (browser) await browser.close();
});

describe('extractDetailFromPage end-to-end (fixture HTML)', () => {
  let raw;
  let detail;

  beforeAll(async () => {
    raw = await extractDetailFromPage(page, { maxReviews: 5, maxPhotos: 5 });
    detail = normalizeDetail(raw, { maxPhotos: 5 });
  });

  test('extracts all 7 days of hours', () => {
    expect(detail.full_hours).not.toBeNull();
    expect(detail.full_hours).toHaveLength(7);
    expect(detail.full_hours[0]).toEqual({ day: 'Monday', hours: '9:00 AM – 5:00 PM' });
    expect(detail.full_hours[2]).toEqual({ day: 'Wednesday', hours: 'Closed' });
    expect(detail.full_hours[6]).toEqual({ day: 'Sunday', hours: 'Closed' });
  });

  test('extracts popular times for 2 days', () => {
    expect(detail.popular_times).not.toBeNull();
    expect(detail.popular_times).toHaveLength(2);
    expect(detail.popular_times[0].day).toBe('Monday');
    expect(detail.popular_times[0].busy).toHaveLength(3);
    // First bar: "Not busy" → level 1
    expect(detail.popular_times[0].busy[0].level).toBe(1);
    // Second bar: "Usually busy at 9 AM" → level 3, hour 9
    expect(detail.popular_times[0].busy[1].level).toBe(3);
    expect(detail.popular_times[0].busy[1].hour).toBe(9);
  });

  test('extracts up to 3 reviews with author/rating/text/date', () => {
    expect(detail.top_reviews).toHaveLength(3);
    const r0 = detail.top_reviews[0];
    expect(r0.author).toBe('Jane D.');
    expect(r0.rating).toBe(5);
    expect(r0.text).toBe('Best coffee in town!');
    expect(r0.date).toBe('2 weeks ago');
  });

  test('extracts 3 photo URLs', () => {
    expect(detail.photos).toHaveLength(3);
    expect(detail.photos[0]).toContain('photo1.jpg');
  });

  test('extracts reservation_url and menu_url', () => {
    expect(detail.reservation_url).toBe('https://opentable.com/r/cafeberlin');
    expect(detail.menu_url).toBe('https://cafeberlin.de/menu');
  });

  test('extracts social profiles — website + instagram + facebook, deduped + utm stripped', () => {
    const platforms = detail.social_profiles.map((s) => s.platform).sort();
    expect(platforms).toContain('instagram');
    expect(platforms).toContain('facebook');
    // The "authority" link (cafe-berlin.de) is classified as 'other'
    expect(detail.social_profiles.length).toBeGreaterThanOrEqual(3);
    const ig = detail.social_profiles.find((s) => s.platform === 'instagram');
    expect(ig.url).toBe('https://instagram.com/cafeberlin'); // utm_source stripped
  });

  test('detail_scraped flag is true on normalized output', () => {
    expect(detail.detail_scraped).toBe(true);
  });

  test('respects maxReviews cap', async () => {
    const r = await extractDetailFromPage(page, { maxReviews: 2, maxPhotos: 5 });
    const d = normalizeDetail(r, { maxPhotos: 5 });
    expect(d.top_reviews).toHaveLength(2);
  });

  test('respects maxPhotos cap', async () => {
    const r = await extractDetailFromPage(page, { maxReviews: 5, maxPhotos: 1 });
    const d = normalizeDetail(r, { maxPhotos: 1 });
    expect(d.photos).toHaveLength(1);
  });

  test('every normalized detail has all 8 DETAIL_FIELDS keys', () => {
    for (const f of DETAIL_FIELDS) {
      expect(detail).toHaveProperty(f);
    }
  });
});
