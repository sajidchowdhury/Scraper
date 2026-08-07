'use strict';

/**
 * src/session/index.js — Phase 2.7 barrel.
 *
 * Re-exports the session submodules so callers can do:
 *   const { createSessionManager, warmupContext, accountWarmup, createRealContextFactory } = require('./session');
 *
 * Submodules:
 *   - manager.js          — createSessionManager (the rotation engine)
 *   - warmup.js           — warmupContext (benign pre-Maps visits)
 *   - account-warmup.js   — accountWarmup + loadAccounts + pickAccount (opt-in)
 *   - context-factory.js  — createRealContextFactory (production createContext)
 */

const {
  createSessionManager,
  createSessionRecord,
  sessionInfoFor,
  SessionError,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_MAX_AGE_MS,
} = require('./manager');

const {
  warmupContext,
  performBenignSearch,
  DEFAULT_WARMUP_SITES,
  DEFAULT_WARMUP_SEARCHES,
  DEFAULT_DURATION_MS,
} = require('./warmup');

const {
  accountWarmup,
  loadAccounts,
  pickAccount,
  redactEmail,
  waitForSelector,
  AccountWarmupError,
} = require('./account-warmup');

const { createRealContextFactory } = require('./context-factory');

module.exports = {
  // manager
  createSessionManager,
  createSessionRecord,
  sessionInfoFor,
  SessionError,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_MAX_AGE_MS,
  // warmup
  warmupContext,
  performBenignSearch,
  DEFAULT_WARMUP_SITES,
  DEFAULT_WARMUP_SEARCHES,
  DEFAULT_DURATION_MS,
  // account-warmup
  accountWarmup,
  loadAccounts,
  pickAccount,
  redactEmail,
  waitForSelector,
  AccountWarmupError,
  // context-factory
  createRealContextFactory,
};
