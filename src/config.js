/**
 * Configuration loader.
 *
 * Phase 1.1: merges CLI arguments (commander) > environment variables (.env via
 *            dotenv) > defaults, then validates the result. Exposes
 *            `resolveConfig()` so the entry point can catch ConfigError and
 *            exit with a friendly message + code 2.
 *
 * Phase 1.2: added `run.timeoutMs` (global run timeout, default 5 min) with
 *            validation, so the entry point can guarantee the process never
 *            hangs forever.
 *
 * Precedence (highest → lowest):
 *   1. CLI flags:    --query --location --max-results --output-file
 *   2. Environment:  DEFAULT_QUERY / DEFAULT_LOCATION / DEFAULT_MAX_RESULTS /
 *                    OUTPUT_FILE / HEADLESS / SLOW_MO / VIEWPORT_* / OUTPUT_DIR /
 *                    RUN_TIMEOUT_MS / LOG_LEVEL
 *   3. Built-in defaults (only for non-required fields)
 *
 * Required fields (query, location) have NO built-in default — the operator
 * must supply them via CLI or .env, otherwise resolveConfig() throws.
 */
require('dotenv').config();
const { Command } = require('commander');

/**
 * Thrown when required config is missing or invalid. The entry point catches
 * this, prints a friendly message, and exits with code 2.
 */
class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse a maxResults value into a positive integer or null.
 * Returns null for empty/undefined. Returns NaN for garbage (caller validates).
 * @param {string|number|undefined} value
 * @returns {number|null}
 */
function parseMaxResults(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value;
  return parseInt(value, 10);
}

/**
 * Build the commander program. Kept separate so resolveConfig() can construct
 * a fresh instance on each call (safe to call multiple times, e.g. in tests).
 * @returns {Command}
 */
function buildProgram() {
  const program = new Command();
  program
    .name('googlemaps-scraper')
    .description('A Google Maps business scraper that exports CSVs of business data.')
    .version('1.0.0')
    .option('-q, --query <query>', 'what to search for (e.g. "Restaurant")')
    .option('-l, --location <location>', 'where to search (e.g. "Toronto")')
    .option('-m, --max-results <number>', 'max businesses to scrape (default: all available)', parseMaxResults)
    .option('-o, --output-file <path>', 'output CSV file path (default: auto-generated)')
    .allowExcessArguments(false);
  return program;
}

/**
 * Resolve the full application config from CLI + env + defaults.
 *
 * @param {string[]} [argv] - argv including node + script path (defaults to process.argv)
 * @returns {object} resolved config
 * @throws {ConfigError} if required fields are missing or invalid
 */
function resolveConfig(argv = process.argv) {
  const program = buildProgram();
  program.exitOverride(); // convert commander's process.exit() into throws (so --help is catchable in tests)
  let opts;
  try {
    program.parse(argv);
    opts = program.opts();
  } catch (err) {
    // --help / --version produce commander errors with exitCode; rethrow as-is
    // so the entry point can let the process exit naturally.
    throw err;
  }

  // ---- Merge: CLI > env > default ----
  const query = opts.query || process.env.DEFAULT_QUERY || null;
  const location = opts.location || process.env.DEFAULT_LOCATION || null;

  const maxResults =
    opts.maxResults != null
      ? opts.maxResults
      : parseMaxResults(process.env.DEFAULT_MAX_RESULTS);

  const outputFile = opts.outputFile || process.env.OUTPUT_FILE || null;

  const config = {
    search: { query, location, maxResults },
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
      file: outputFile,
    },
    run: {
      // Global run timeout in ms. If the run exceeds this, the browser is
      // force-closed and the process exits with code 3. Default: 5 minutes.
      timeoutMs: parseInt(process.env.RUN_TIMEOUT_MS || '300000', 10),
    },
    log: {
      level: process.env.LOG_LEVEL || 'info',
    },
  };

  // ---- Validate ----
  const errors = [];
  if (!query || !query.trim()) {
    errors.push('Missing required search query. Provide --query <value> on the CLI or set DEFAULT_QUERY in .env.');
  }
  if (!location || !location.trim()) {
    errors.push('Missing required search location. Provide --location <value> on the CLI or set DEFAULT_LOCATION in .env.');
  }
  if (maxResults != null) {
    if (!Number.isInteger(maxResults) || Number.isNaN(maxResults) || maxResults <= 0) {
      errors.push(`maxResults must be a positive integer greater than 0 (got: ${JSON.stringify(opts.maxResults != null ? opts.maxResults : process.env.DEFAULT_MAX_RESULTS)}).`);
    }
  }
  // Validate viewport dimensions
  const { width, height } = config.browser.viewport;
  if (!Number.isInteger(width) || width <= 0) {
    errors.push(`VIEWPORT_WIDTH must be a positive integer (got: ${JSON.stringify(process.env.VIEWPORT_WIDTH)}).`);
  }
  if (!Number.isInteger(height) || height <= 0) {
    errors.push(`VIEWPORT_HEIGHT must be a positive integer (got: ${JSON.stringify(process.env.VIEWPORT_HEIGHT)}).`);
  }
  // Validate run timeout (must be a positive integer; minimum 5s to avoid
  // accidental instant-timeout misconfigurations).
  const { timeoutMs } = config.run;
  if (!Number.isInteger(timeoutMs) || Number.isNaN(timeoutMs) || timeoutMs < 5000) {
    errors.push(`RUN_TIMEOUT_MS must be a positive integer >= 5000 ms (got: ${JSON.stringify(process.env.RUN_TIMEOUT_MS)}).`);
  }

  if (errors.length > 0) {
    const message = errors.length === 1 ? errors[0] : errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n');
    throw new ConfigError(message);
  }

  return config;
}

module.exports = { resolveConfig, ConfigError, parseMaxResults };
