/**
 * Scraper entry point.
 *
 * Phase 1.2: bulletproof browser lifecycle.
 *            - Global run timeout (config.run.timeoutMs, default 5 min). When
 *              it fires, the browser is force-closed and the process exits 3.
 *              The script can NEVER hang forever.
 *            - SIGINT (Ctrl-C) handler: first Ctrl-C closes the browser
 *              gracefully and exits 130; second Ctrl-C forces exit 137.
 *            - try/finally guarantees the browser is always torn down.
 *            - Removed the Phase 1.0/1.1 demo pause — the lifecycle is now
 *              real: launch → navigate → search → confirm feed → close.
 *
 * Exit codes:
 *   0    success
 *   1    partial success (some businesses failed — used once extraction exists)
 *   2    configuration error (missing/invalid CLI args or env)
 *   3    runtime error (browser crash, network failure, timeout)
 *   130  interrupted by user (SIGINT, graceful shutdown)
 *   137  interrupted by user (second SIGINT, forced shutdown)
 *
 * Phase 1.3 (TODO): add scroll -> extract -> export to the work pipeline.
 */
const { resolveConfig, ConfigError } = require('./config');
const logger = require('./logger');
const { launchBrowser, closeBrowser } = require('./browser');
const { navigateToMaps, performSearch } = require('./search');

/**
 * Thrown when the global run timeout fires. Caught by the main try/catch to
 * produce a clear "timed out" log line + exit code 3.
 */
class TimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Run exceeded global timeout of ${timeoutMs} ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

async function main() {
  // ---- Resolve + validate config (CLI > env > defaults) ----
  let config;
  try {
    config = resolveConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('\n  Configuration error:');
      console.error('  ' + err.message.split('\n').join('\n  '));
      console.error('\n  Run with --help for usage.\n');
      process.exit(2);
    }
    if (err && typeof err.code === 'string' && err.code.startsWith('commander.')) {
      // --help / --version / unknown flag: commander already printed its message.
      process.exit(2);
    }
    logger.error('Unexpected error during config resolution', { message: err.message, stack: err.stack });
    process.exit(3);
  }

  logResolvedConfig(config);

  // ---- Lifecycle state shared with signal handlers ----
  let browser = null;
  let interrupted = false;     // SIGINT received during the run
  let timedOut = false;        // global timeout fired during the run
  let timeoutId = null;        // global timeout timer handle
  let handlersInstalled = false;

  /**
   * SIGINT / SIGTERM handler.
   * - First signal: initiate graceful shutdown by closing the browser. The
   *   in-flight Playwright ops will reject, the main catch block sees
   *   `interrupted`, sets exit code 130, and the finally block finishes cleanup.
   * - Second signal: force exit immediately (escape hatch if browser.close()
   *   itself is hung).
   */
  const signalHandler = () => {
    if (interrupted) {
      logger.error('Second interrupt received — forcing immediate exit');
      process.exit(137);
    }
    interrupted = true;
    logger.warn('Interrupt received — shutting down gracefully (press Ctrl-C again to force exit)');
    // Closing the browser will cause any in-flight Playwright operations to
    // reject, which the main try/catch will handle and exit cleanly via finally.
    closeBrowser(browser).catch(() => {});
  };

  // ---- Run with global timeout ----
  try {
    // Install signal handlers
    process.on('SIGINT', signalHandler);
    process.on('SIGTERM', signalHandler);
    handlersInstalled = true;

    // Arm the global timeout. When it fires, mark timedOut and force-close
    // the browser so in-flight ops reject and the try/catch can take over.
    timeoutId = setTimeout(() => {
      timedOut = true;
      logger.warn('Global run timeout reached — force-closing browser', {
        timeoutMs: config.run.timeoutMs,
      });
      closeBrowser(browser).catch(() => {});
    }, config.run.timeoutMs);

    // ----- The actual work (Phase 1.3 will extend this) -----
    const { browser: b, page } = await launchBrowser(config);
    browser = b;

    await navigateToMaps(page);
    await performSearch(page, config.search.query, config.search.location);

    // Phase 1.2 scaffold: search confirmed, feed visible. The full pipeline
    // (scroll -> extract -> export) lands in Phases 1.3-1.6.
    logger.info('Phase 1.2 scaffold reached — search confirmed, closing cleanly.', {
      query: config.search.query,
      location: config.search.location,
      maxResults: config.search.maxResults == null ? 'all (enforced in Phase 1.3)' : config.search.maxResults,
    });
  } catch (err) {
    if (interrupted) {
      logger.warn('Run interrupted by user');
      process.exitCode = 130; // 128 + SIGINT(2)
    } else if (timedOut) {
      logger.error('Run timed out', { timeoutMs: config.run.timeoutMs });
      process.exitCode = 3;
    } else {
      logger.error('Run failed', { message: err.message, stack: err.stack });
      process.exitCode = 3;
    }
  } finally {
    // Cancel the global timeout (no-op if already fired).
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    // Detach signal handlers so they don't fire during/after final teardown.
    if (handlersInstalled) {
      process.off('SIGINT', signalHandler);
      process.off('SIGTERM', signalHandler);
      handlersInstalled = false;
    }
    // Idempotent: safe even if the signal handler or timeout already closed it.
    await closeBrowser(browser);
    logger.info('Scraper finished');
  }
}

/**
 * Print the resolved configuration in a scannable block so the operator can
 * confirm what's about to run before any browser activity begins.
 */
function logResolvedConfig(config) {
  const summary = {
    query: config.search.query,
    location: config.search.location,
    maxResults: config.search.maxResults == null ? 'all available' : config.search.maxResults,
    outputFile: config.output.file == null ? 'auto-generated' : config.output.file,
    outputDir: config.output.dir,
    headless: config.browser.headless,
    slowMo: config.browser.slowMo,
    viewport: `${config.browser.viewport.width}x${config.browser.viewport.height}`,
    timeoutMs: config.run.timeoutMs,
    logLevel: config.log.level,
  };
  logger.info('Scraper starting');
  logger.info('Resolved configuration', summary);
}

main();
