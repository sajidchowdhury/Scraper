'use strict';

/**
 * src/captcha/orchestrator.js — Phase 2.6 — CAPTCHA handling orchestrator
 *
 * The single entry point the scraper pipeline calls when a CAPTCHA might be
 * present. It:
 *   1. Runs detectCaptchaType() to find out what (if anything) is blocking us.
 *   2. If nothing is detected → returns { resolved: true, method: 'none' } so
 *      the caller can continue immediately (no solver cost).
 *   3. If a CAPTCHA IS detected AND a solver is configured (provider != none)
 *      AND the budget allows → solveAndInject() (solver → inject → nav wait).
 *   4. If solving fails OR no solver OR budget exceeded → fall back to Phase
 *      1.8 behavior: pause `captchaWaitMs`, alert the operator, return
 *      { resolved: false, method: 'paused' } so the caller can abort/resume.
 *
 * The orchestrator is fully DI: detectFn, sleepFn, onFallback, costLogger,
 * solver are all injectable so tests never touch a real browser or API.
 *
 * Public API:
 *   const r = await handleCaptcha(page, {
 *     solver,            // from createSolver()/createSolverChain(); null = no auto-solve
 *     budgetGuard,       // BudgetGuard instance; null = no budget cap
 *     costLogger,        // from createCostLogger(); null = no cost logging
 *     logger,
 *     detectFn,          // injectable; default detectCaptchaType
 *     solveAndInjectFn,  // injectable; default solveAndInject
 *     sleepFn,           // injectable sleep (default setTimeout)
 *     captchaWaitMs,     // pause duration when falling back (default 300000)
 *     onFallback,        // async callback fired before the pause (e.g. alert)
 *   });
 *   // r = { resolved, method, type, sitekey, cost, solveTimeMs, provider, budgetExceeded }
 */

const { detectCaptchaType } = require('../antiblock');
const { solveAndInject } = require('./injector');
const { BudgetExceededError } = require('./solver');

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} page
 * @param {object} ctx
 * @returns {Promise<{ resolved: boolean, method: string, type: string|null, sitekey: string|null, cost: number, solveTimeMs: number, provider: string|null, budgetExceeded: boolean, indicator: string|null }>}
 */
async function handleCaptcha(page, ctx = {}) {
  const logger = ctx.logger || null;
  const sleepFn = ctx.sleepFn || defaultSleep;
  const captchaWaitMs = ctx.captchaWaitMs ?? 300_000;
  const detectFn = ctx.detectFn || ((p) => detectCaptchaType(p));
  const solveAndInjectFn = ctx.solveAndInjectFn || solveAndInject;
  const solver = ctx.solver || null;
  const budgetGuard = ctx.budgetGuard || null;
  const costLogger = ctx.costLogger || null;
  const onFallback = ctx.onFallback || null;

  // 1. Detect.
  let detection;
  try {
    detection = await detectFn(page);
  } catch (err) {
    if (logger) logger.warn('CAPTCHA detectFn threw (non-fatal)', { error: err.message });
    // Treat a detection failure as "no captcha" so the scrape can continue —
    // the caller's own operation will surface a real error if Google blocked.
    return {
      resolved: true,
      method: 'detect-failed',
      type: null,
      sitekey: null,
      cost: 0,
      solveTimeMs: 0,
      provider: null,
      budgetExceeded: false,
      indicator: null,
    };
  }

  // 2. Nothing detected → caller continues.
  if (!detection || !detection.detected) {
    return {
      resolved: true,
      method: 'none',
      type: detection ? detection.type : 'none',
      sitekey: null,
      cost: 0,
      solveTimeMs: 0,
      provider: null,
      budgetExceeded: budgetGuard ? budgetGuard.exceeded : false,
      indicator: detection ? detection.indicator : null,
    };
  }

  // A CAPTCHA is present. Log it.
  if (logger) {
    logger.warn('CAPTCHA detected', {
      type: detection.type,
      sitekey: detection.sitekey ? detection.sitekey.slice(0, 12) + '…' : null,
      url: detection.url,
      indicator: detection.indicator,
      solver: solver ? solver.provider : 'none',
      budgetRemaining: budgetGuard ? `$${budgetGuard.remaining.toFixed(4)}` : null,
    });
  }

  // 3. Decide whether to auto-solve or fall back.
  const canAutoSolve = solver && solver.provider !== 'none';
  const budgetOk = !budgetGuard || budgetGuard.canSolve();

  if (!canAutoSolve || !budgetOk) {
    const reason = !canAutoSolve ? 'no-solver' : 'budget-exceeded';
    if (logger) {
      logger.error('CAPTCHA auto-solve unavailable — falling back to pause-and-alert', {
        reason,
        solver: solver ? solver.provider : null,
        budgetExceeded: budgetGuard ? budgetGuard.exceeded : false,
        pauseMs: captchaWaitMs,
      });
    }
    // Cost-log a failed (non-solved) record so the run summary accounts for it.
    if (costLogger) {
      costLogger.append({
        provider: solver ? solver.provider : null,
        type: detection.type,
        cost: 0,
        solveTimeMs: 0,
        success: false,
        url: detection.url,
        error: reason,
      });
    }
    await runFallback({ onFallback, sleepFn, captchaWaitMs, detection, logger });
    return {
      resolved: false,
      method: 'paused',
      type: detection.type,
      sitekey: detection.sitekey,
      cost: 0,
      solveTimeMs: 0,
      provider: solver ? solver.provider : null,
      budgetExceeded: budgetGuard ? budgetGuard.exceeded : false,
      indicator: detection.indicator,
    };
  }

  // 4. Attempt to solve + inject + navigate.
  let result;
  try {
    result = await solveAndInjectFn(page, solver, detection, { logger, sleepFn });
  } catch (err) {
    if (logger) logger.warn('CAPTCHA solveAndInject threw — falling back', { error: err.message, code: err.code || null });
    result = { resolved: false, token: null, cost: 0, solveTimeMs: 0, provider: solver.provider, method: null };
  }

  // Budget-exceeded surfaces as a thrown error from solve() in some flows —
  // catch it explicitly so we still fall back cleanly.
  const budgetExceeded = result && result.budgetExceeded === true ? true : (budgetGuard ? budgetGuard.exceeded : false);

  // 5. Record cost (success OR failure) in the cost log.
  if (costLogger) {
    costLogger.append({
      provider: result.provider || solver.provider,
      type: detection.type,
      cost: result.cost || 0,
      solveTimeMs: result.solveTimeMs || 0,
      success: !!result.resolved,
      url: detection.url,
      error: result.resolved ? null : 'solve-or-inject-failed',
    });
  }
  // Record the spend in the budget guard (only on success — a failed solve
  // shouldn't burn budget for a service that didn't deliver).
  if (budgetGuard && result.resolved && result.cost) {
    budgetGuard.record(result.cost);
  }

  // 6. If solved → caller continues.
  if (result.resolved) {
    if (logger) {
      logger.info('CAPTCHA solved — resuming scrape', {
        provider: result.provider,
        cost: `$${(result.cost || 0).toFixed(4)}`,
        time: `${((result.solveTimeMs || 0) / 1000).toFixed(2)}s`,
        method: result.method,
      });
    }
    return {
      resolved: true,
      method: 'solved',
      type: detection.type,
      sitekey: detection.sitekey,
      cost: result.cost || 0,
      solveTimeMs: result.solveTimeMs || 0,
      provider: result.provider,
      budgetExceeded,
      indicator: detection.indicator,
    };
  }

  // 7. Solve failed → fall back to pause-and-alert.
  if (logger) {
    logger.error('CAPTCHA auto-solve failed — falling back to pause-and-alert', {
      provider: result.provider,
      pauseMs: captchaWaitMs,
      hint: 'The checkpoint is preserved — rerun with --resume after the block clears',
    });
  }
  await runFallback({ onFallback, sleepFn, captchaWaitMs, detection, logger });
  return {
    resolved: false,
    method: 'solve-failed',
    type: detection.type,
    sitekey: detection.sitekey,
    cost: result.cost || 0,
    solveTimeMs: result.solveTimeMs || 0,
    provider: result.provider,
    budgetExceeded,
    indicator: detection.indicator,
  };
}

/**
 * Run the Phase 1.8 fallback: alert the operator (via onFallback) then pause
 * `captchaWaitMs`. Extracted so the success/failure paths share one impl.
 */
async function runFallback({ onFallback, sleepFn, captchaWaitMs, detection, logger }) {
  if (typeof onFallback === 'function') {
    try {
      await onFallback({ detection, pauseMs: captchaWaitMs });
    } catch (err) {
      if (logger) logger.warn('CAPTCHA onFallback callback threw (non-fatal)', { error: err.message });
    }
  }
  await sleepFn(captchaWaitMs);
}

module.exports = {
  handleCaptcha,
  runFallback,
  BudgetExceededError,
};
