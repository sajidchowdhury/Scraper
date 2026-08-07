'use strict';

/**
 * src/captcha/index.js — Phase 2.6 barrel.
 *
 * Re-exports the CAPTCHA submodules so callers can do:
 *   const { createSolver, BudgetGuard, handleCaptcha, createCostLogger } = require('./captcha');
 *
 * Submodules:
 *   - solver.js      — createSolver, createSolverChain, BudgetGuard, PROVIDERS, COST_PER_SOLVE
 *   - cost-log.js    — createCostLogger
 *   - injector.js    — injectRecaptchaToken, submitRecaptcha, solveAndInject
 *   - orchestrator.js — handleCaptcha (the pipeline-facing entry point)
 *   - detector re-exported from ../antiblock (CAPTCHA_TYPES, detectCaptchaType, extractSitekey)
 */

const {
  PROVIDERS,
  COST_PER_SOLVE,
  ENDPOINTS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  SolverError,
  BudgetExceededError,
  BudgetGuard,
  createSolver,
  createSolverChain,
  PROVIDER_IMPLS,
} = require('./solver');

const { createCostLogger, DEFAULT_COST_LOG_PATH } = require('./cost-log');
const { injectRecaptchaToken, submitRecaptcha, solveAndInject } = require('./injector');
const { handleCaptcha, runFallback } = require('./orchestrator');

// Re-export the typed detector (lives in antiblock.js per the execution plan).
const {
  CAPTCHA_TYPES,
  UNUSUAL_TRAFFIC_INDICATORS,
  detectCaptchaType,
  extractSitekey,
} = require('../antiblock');

module.exports = {
  // solver
  PROVIDERS,
  COST_PER_SOLVE,
  ENDPOINTS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  SolverError,
  BudgetExceededError,
  BudgetGuard,
  createSolver,
  createSolverChain,
  PROVIDER_IMPLS,
  // cost log
  createCostLogger,
  DEFAULT_COST_LOG_PATH,
  // injector
  injectRecaptchaToken,
  submitRecaptcha,
  solveAndInject,
  // orchestrator
  handleCaptcha,
  runFallback,
  // detector (re-exported)
  CAPTCHA_TYPES,
  UNUSUAL_TRAFFIC_INDICATORS,
  detectCaptchaType,
  extractSitekey,
};
