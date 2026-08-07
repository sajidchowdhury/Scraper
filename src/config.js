/**
 * Configuration loader.
 *
 * Phase 1.0: reads from environment variables (.env file) with sensible defaults
 *            that preserve the original main.js behavior ("Restaurant Toronto").
 *
 * Phase 1.1 (TODO): merge in CLI argument overrides (commander/yargs) and add
 *                    maxResults, outputFile, deepScrape, etc.
 */
require('dotenv').config();

const config = {
  search: {
    query: process.env.DEFAULT_QUERY || 'Restaurant',
    location: process.env.DEFAULT_LOCATION || 'Toronto',
    // TODO Phase 1.1: maxResults (null = scrape all available)
  },
  browser: {
    headless: process.env.HEADLESS === 'true',
    slowMo: parseInt(process.env.SLOW_MO || '200', 10),
    viewport: {
      width: parseInt(process.env.VIEWPORT_WIDTH || '1400', 10),
      height: parseInt(process.env.VIEWPORT_HEIGHT || '900', 10),
    },
  },
  output: {
    dir: process.env.OUTPUT_DIR || './data',
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
  // TODO Phase 1.1: add deepScrape, outputFile, resume, etc.
};

module.exports = config;
