'use strict';

/**
 * src/enrichment/index.js — Phase 3.0 — Enrichment Module Barrel
 *
 * Single entry point for the Phase 3 enrichment pipeline. Re-exports every
 * sub-phase module so callers can do:
 *
 *   const { phone, address, dedup, leadScore } = require('./enrichment');
 *
 * Each sub-phase module is a stub as of Phase 3.0 (exports an empty function +
 * a `__version` constant + its ENRICHMENT_COLUMNS list). The implementations
 * land in their respective sub-phases (3.1 → 3.12).
 *
 * The ENRICHMENT_COLUMNS aggregation below is the single source of truth for
 * which `businesses` columns the enrichment pipeline owns — used by the
 * pipeline (3.12) to build UPDATE statements and by the confidence scorer
 * (3.10) to know which fields to weight.
 */

const phone = require('./phone');
const address = require('./address');
const dedup = require('./dedup');
const chainDetection = require('./chain-detection');
const email = require('./email');
const techStack = require('./tech-stack');
const sentiment = require('./sentiment');
const geoMetrics = require('./geo-metrics');
const leadScore = require('./lead-score');
const confidence = require('./confidence');
const gridCoverage = require('./grid-coverage');
const pipeline = require('./pipeline');

// Aggregate every enrichment column the pipeline can write. De-duplicated
// (dedup.js and grid-coverage.js contribute no businesses columns). This is
// the canonical list mirrored by migrations/003-enrichment.sql.
const ENRICHMENT_COLUMNS = Array.from(
  new Set([
    ...phone.ENRICHMENT_COLUMNS,
    ...address.ENRICHMENT_COLUMNS,
    ...dedup.ENRICHMENT_COLUMNS,
    ...chainDetection.ENRICHMENT_COLUMNS,
    ...email.ENRICHMENT_COLUMNS,
    ...techStack.ENRICHMENT_COLUMNS,
    ...sentiment.ENRICHMENT_COLUMNS,
    ...geoMetrics.ENRICHMENT_COLUMNS,
    ...leadScore.ENRICHMENT_COLUMNS,
    ...confidence.ENRICHMENT_COLUMNS,
    ...gridCoverage.ENRICHMENT_COLUMNS,
    ...pipeline.ENRICHMENT_COLUMNS,
    // Provenance columns (written by the pipeline, not a single sub-phase).
    'enriched_at',
    'enrichment_version',
  ]),
);

// Bump this when the enrichment algorithm or schema changes. Rows with a lower
// `enrichment_version` get re-enriched on the next pipeline run.
const ENRICHMENT_VERSION = 1;

module.exports = {
  // Sub-phase modules
  phone,
  address,
  dedup,
  chainDetection,
  email,
  techStack,
  sentiment,
  geoMetrics,
  leadScore,
  confidence,
  gridCoverage,
  pipeline,
  // Aggregates
  ENRICHMENT_COLUMNS,
  ENRICHMENT_VERSION,
};
