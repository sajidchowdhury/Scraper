'use strict';

/**
 * src/browser.js — Phase 1.2
 *
 * Launches Playwright Chromium with config-driven options (headless, slowMo,
 * viewport). Returns { browser, page }. Caller is responsible for closing
 * in a try/finally — see withBrowser() helper below.
 */

const { chromium } = require('playwright');

const USER_AGENTS = [
  // Real recent desktop Chrome UAs — picked at random per launch (Phase 1.8 prep)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

function pickUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function launchBrowser(cfg) {
  const browser = await chromium.launch({
    headless: cfg.headless,
    slowMo: cfg.slowMo || undefined,
  });

  const context = await browser.newContext({
    viewport: { width: cfg.viewportWidth, height: cfg.viewportHeight },
    userAgent: pickUserAgent(),
    locale: 'en-US',
    timezoneId: 'America/Toronto',
  });

  context.setDefaultTimeout(cfg.navTimeoutMs || 60000);

  const page = await context.newPage();
  return { browser, context, page };
}

async function closeBrowser(browser) {
  if (!browser) return;
  try {
    await browser.close();
  } catch {
    /* best-effort */
  }
}

/**
 * Convenience wrapper: ensures browser closes even on error.
 * Usage: await withBrowser(cfg, async ({ page }) => { ... })
 */
async function withBrowser(cfg, fn) {
  const { browser, page } = await launchBrowser(cfg);
  try {
    return await fn({ browser, page });
  } finally {
    await closeBrowser(browser);
  }
}

module.exports = { launchBrowser, closeBrowser, withBrowser, pickUserAgent };
