'use strict';

/**
 * src/selectors/index.js — Phase 2.11
 *
 * Barrel export for the self-healing selector subsystem.
 *
 *   version.js      — selector version registry + staleness warning
 *   auto-discover.js — heuristic field discovery when selectors fail
 *   health-check.js — startup health check + first-batch abort
 *   debug-dump.js   — DOM snippet dumps for low-rate fields
 *
 * Usage:
 *   const selectors = require('./selectors');
 *   selectors.logSelectorVersion(logger, { maxAgeDays: cfg.selectors.maxSelectorAge });
 *   const { ok } = await selectors.healthCheck(page, { logger });
 *   if (!ok) process.exit(selectors.SELECTOR_FAILURE_EXIT_CODE);
 */

const version = require('./version');
const autoDiscover = require('./auto-discover');
const healthCheck = require('./health-check');
const debugDump = require('./debug-dump');

module.exports = {
  // version.js
  SELECTOR_VERSIONS: version.SELECTOR_VERSIONS,
  parseDate: version.parseDate,
  getSelectorAgeDays: version.getSelectorAgeDays,
  isSelectorSetStale: version.isSelectorSetStale,
  getSelectorStatus: version.getSelectorStatus,
  logSelectorVersion: version.logSelectorVersion,

  // auto-discover.js
  DISCOVERABLE_FIELDS: autoDiscover.DISCOVERABLE_FIELDS,
  DISCOVERY_SCRIPT: autoDiscover.DISCOVERY_SCRIPT,
  buildDiscoveryRequests: autoDiscover.buildDiscoveryRequests,
  applyDiscoveryResults: autoDiscover.applyDiscoveryResults,
  discoverField: autoDiscover.discoverField,
  discoverMissingFields: autoDiscover.discoverMissingFields,

  // health-check.js
  SELECTOR_FAILURE_EXIT_CODE: healthCheck.SELECTOR_FAILURE_EXIT_CODE,
  CORE_FIELDS: healthCheck.CORE_FIELDS,
  SECONDARY_FIELDS: healthCheck.SECONDARY_FIELDS,
  CORE_THRESHOLD_PCT: healthCheck.CORE_THRESHOLD_PCT,
  SECONDARY_THRESHOLD_PCT: healthCheck.SECONDARY_THRESHOLD_PCT,
  DEFAULT_MIN_SAMPLE_SIZE: healthCheck.DEFAULT_MIN_SAMPLE_SIZE,
  evaluateHealth: healthCheck.evaluateHealth,
  isCriticalFailure: healthCheck.isCriticalFailure,
  buildSelectorFailureError: healthCheck.buildSelectorFailureError,
  checkExtractionRatesForAbort: healthCheck.checkExtractionRatesForAbort,
  healthCheck: healthCheck.healthCheck,

  // debug-dump.js
  DEFAULT_DUMP_THRESHOLD_PCT: debugDump.DEFAULT_DUMP_THRESHOLD_PCT,
  DEFAULT_DUMP_DIR: debugDump.DEFAULT_DUMP_DIR,
  shouldDumpForField: debugDump.shouldDumpForField,
  buildDumpPath: debugDump.buildDumpPath,
  buildDumpContent: debugDump.buildDumpContent,
  dumpSelectorDebug: debugDump.dumpSelectorDebug,
};
