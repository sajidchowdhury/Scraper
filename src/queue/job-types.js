'use strict';

/**
 * src/queue/job-types.js — Phase 2.9 — Job Queue & Orchestration
 *
 * Job-type registry + schema validators for the BullMQ-backed scraper queue.
 * Three job types (Phase 2.9 spec):
 *
 *   search        — { query, location, maxResults, deepScrape }
 *                   → produces businesses (search + scroll + extract + optional
 *                     deep-scrape). The highest-level job; the batch CLI submits
 *                     one per CSV row.
 *
 *   detail-batch  — { businessIds: [...], deepScrape }
 *                   → deep-scrapes a batch of already-extracted businesses by id.
 *                   Useful for re-scraping detail fields (hours, reviews, photos)
 *                   without re-running the search.
 *
 *   enrich        — { businessId }  (Phase 3 placeholder)
 *                   → enriches a single business with third-party data (Yelp,
 *                     Facebook, etc.). Reserved for Phase 3; the queue accepts
 *                   the job but the worker is a no-op stub until Phase 3 lands.
 *
 * Each job type has:
 *   - a canonical `name` (string, used as the BullMQ job name)
 *   - a `validate(payload)` function returning an array of error strings
 *     (empty = valid). Invalid jobs are rejected by the queue BEFORE they are
 *     added — fail fast, don't persist garbage.
 *   - a `toTask(payload)` function that converts the validated payload into a
 *     serializable task descriptor (compatible with Phase 2.8's
 *     createSearchTask / createDetailTask). The queue worker calls this then
 *     hands the task to pool.dispatch.
 *   - a `priority` hint (1 = high / 5 = normal / 10 = low) used when the
 *     payload doesn't specify one.
 *
 * The registry is exported as JOB_TYPES so the queue adapter + tests can
 * iterate / look up types by name. New types are added by appending to the
 * registry + a validator + a toTask mapper — no changes to the queue adapter
 * itself (open/closed).
 */

// ---------------------------------------------------------------------------
// Priority bands (BullMQ: lower number = higher priority)
// ---------------------------------------------------------------------------

const PRIORITY_HIGH = 1; // paid client jobs, resume-after-crash jobs
const PRIORITY_NORMAL = 5; // standard batch jobs
const PRIORITY_LOW = 10; // background re-scrape jobs

const PRIORITY_BANDS = {
  high: PRIORITY_HIGH,
  normal: PRIORITY_NORMAL,
  low: PRIORITY_LOW,
};

function resolvePriority(p) {
  if (p === undefined || p === null) return PRIORITY_NORMAL;
  const n = Number(p);
  if (!Number.isFinite(n)) return PRIORITY_NORMAL;
  // Clamp to BullMQ's supported range (1-2^31). Negative priorities are
  // rejected (they'd invert the ordering). Priority 0 is allowed (highest).
  if (n < 0) return PRIORITY_NORMAL;
  if (n > 2 ** 31 - 1) return 2 ** 31 - 1;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isString(v) {
  return typeof v === 'string';
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isFiniteInt(v) {
  return Number.isFinite(v) && Number.isInteger(v);
}

function isBool(v) {
  return typeof v === 'boolean';
}

function isArray(v) {
  return Array.isArray(v);
}

/**
 * Check that a value is JSON-serializable (so BullMQ can persist it to Redis).
 * BullMQ uses JSON.stringify under the hood; non-serializable values (functions,
 * symbols, circular refs) would throw at add() time. We pre-validate so the
 * error is thrown at submit time with a clear message, not deep inside BullMQ.
 */
function isJsonSerializable(v) {
  try {
    JSON.stringify(v);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// search job — { query, location, maxResults?, deepScrape? }
// ---------------------------------------------------------------------------

function validateSearch(payload) {
  const errs = [];
  if (!payload || typeof payload !== 'object') {
    return ['search payload must be an object'];
  }
  if (!isNonEmptyString(payload.query)) {
    errs.push('search payload requires a non-empty "query" string');
  }
  if (!isNonEmptyString(payload.location)) {
    errs.push('search payload requires a non-empty "location" string');
  }
  if (payload.maxResults !== undefined && payload.maxResults !== null) {
    if (!isFiniteInt(payload.maxResults) || payload.maxResults < 1 || payload.maxResults > 100000) {
      errs.push(
        `search payload.maxResults must be an integer between 1 and 100000 (got ${JSON.stringify(payload.maxResults)})`,
      );
    }
  }
  if (payload.deepScrape !== undefined && payload.deepScrape !== null) {
    if (!isBool(payload.deepScrape)) {
      errs.push(
        `search payload.deepScrape must be a boolean (got ${JSON.stringify(payload.deepScrape)})`,
      );
    }
  }
  if (!isJsonSerializable(payload)) {
    errs.push('search payload must be JSON-serializable');
  }
  return errs;
}

function searchToTask(payload) {
  return {
    type: 'search-task',
    query: payload.query,
    location: payload.location,
    maxResults: payload.maxResults || null,
    opts: { deepScrape: !!payload.deepScrape },
  };
}

// ---------------------------------------------------------------------------
// detail-batch job — { businessIds?: string[], businesses?: object[], deepScrape? }
// ---------------------------------------------------------------------------
// Two payload shapes are accepted:
//   1. { businessIds: ['id1', 'id2', ...], deepScrape } — for the Phase 3
//      re-scrape-by-id use case. The worker resolves ids → business objects
//      (via the DB) before dispatching to the pool.
//   2. { businesses: [{...}, {...}], deepScrape } — for the Phase 2.9 main
//      flow where the businesses are already in memory (just extracted by the
//      search job). No DB lookup needed; the worker dispatches directly.
// At least one of the two must be provided. If both are provided, `businesses`
// wins (it's the resolved form).

function validateDetailBatch(payload) {
  const errs = [];
  if (!payload || typeof payload !== 'object') {
    return ['detail-batch payload must be an object'];
  }
  const hasIds = isArray(payload.businessIds);
  const hasBusinesses = isArray(payload.businesses);
  if (!hasIds && !hasBusinesses) {
    errs.push('detail-batch payload requires either "businessIds" (string[]) or "businesses" (object[])');
  }
  if (hasIds) {
    if (payload.businessIds.length === 0 && !hasBusinesses) {
      errs.push('detail-batch payload.businessIds must not be empty');
    }
    if (payload.businessIds.length > 500) {
      errs.push(
        `detail-batch payload.businessIds is too large (${payload.businessIds.length} > 500) — split into smaller batches`,
      );
    }
    for (let i = 0; i < payload.businessIds.length; i++) {
      const id = payload.businessIds[i];
      if (!isString(id) || id.trim().length === 0) {
        errs.push(`detail-batch payload.businessIds[${i}] must be a non-empty string`);
      }
    }
  }
  if (hasBusinesses) {
    if (payload.businesses.length === 0 && !hasIds) {
      errs.push('detail-batch payload.businesses must not be empty');
    }
    if (payload.businesses.length > 500) {
      errs.push(
        `detail-batch payload.businesses is too large (${payload.businesses.length} > 500) — split into smaller batches`,
      );
    }
  }
  if (payload.deepScrape !== undefined && payload.deepScrape !== null) {
    if (!isBool(payload.deepScrape)) {
      errs.push(
        `detail-batch payload.deepScrape must be a boolean (got ${JSON.stringify(payload.deepScrape)})`,
      );
    }
  }
  if (!isJsonSerializable(payload)) {
    errs.push('detail-batch payload must be JSON-serializable');
  }
  return errs;
}

function detailBatchToTask(payload) {
  // If `businesses` is provided, pass them through directly (the worker
  // dispatches without a DB lookup). Otherwise pass `businessIds` through and
  // leave `businesses` empty — the worker resolves them just before dispatch.
  return {
    type: 'detail-task',
    businessIds: isArray(payload.businessIds) ? payload.businessIds.slice() : [],
    businesses: isArray(payload.businesses) ? payload.businesses.slice() : [],
    opts: { deepScrape: payload.deepScrape !== false },
  };
}

// ---------------------------------------------------------------------------
// enrich job — { businessId: string, source?: string } (Phase 3 placeholder)
// ---------------------------------------------------------------------------

function validateEnrich(payload) {
  const errs = [];
  if (!payload || typeof payload !== 'object') {
    return ['enrich payload must be an object'];
  }
  if (!isNonEmptyString(payload.businessId)) {
    errs.push('enrich payload requires a non-empty "businessId" string');
  }
  if (payload.source !== undefined && payload.source !== null) {
    if (!isNonEmptyString(payload.source)) {
      errs.push('enrich payload.source must be a non-empty string when provided');
    }
  }
  if (!isJsonSerializable(payload)) {
    errs.push('enrich payload must be JSON-serializable');
  }
  return errs;
}

function enrichToTask(payload) {
  return {
    type: 'enrich-task',
    businessId: payload.businessId,
    source: payload.source || null,
    opts: {},
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const JOB_TYPES = {
  search: {
    name: 'search',
    priority: PRIORITY_NORMAL,
    validate: validateSearch,
    toTask: searchToTask,
  },
  'detail-batch': {
    name: 'detail-batch',
    priority: PRIORITY_NORMAL,
    validate: validateDetailBatch,
    toTask: detailBatchToTask,
  },
  enrich: {
    name: 'enrich',
    priority: PRIORITY_LOW,
    validate: validateEnrich,
    toTask: enrichToTask,
  },
};

const JOB_TYPE_NAMES = Object.keys(JOB_TYPES);

/**
 * Validate a job request: { type, payload, priority?, attempts?, delay? }.
 * Returns an array of error strings (empty = valid). Used by the queue adapter
 * to fail-fast on bad submissions BEFORE they hit Redis.
 */
function validateJobRequest(req) {
  const errs = [];
  if (!req || typeof req !== 'object') {
    return ['job request must be an object'];
  }
  if (!JOB_TYPE_NAMES.includes(req.type)) {
    return [`job.type must be one of ${JOB_TYPE_NAMES.join(', ')} (got "${req.type}")`];
  }
  // Delegate payload validation to the type-specific validator.
  const typeErrs = JOB_TYPES[req.type].validate(req.payload);
  errs.push(...typeErrs);
  if (req.priority !== undefined && req.priority !== null) {
    const n = Number(req.priority);
    if (!Number.isFinite(n) || n < 0) {
      errs.push(`job.priority must be a non-negative number (got ${JSON.stringify(req.priority)})`);
    }
  }
  if (req.attempts !== undefined && req.attempts !== null) {
    const n = Number(req.attempts);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 50) {
      errs.push(`job.attempts must be an integer between 1 and 50 (got ${JSON.stringify(req.attempts)})`);
    }
  }
  if (req.delay !== undefined && req.delay !== null) {
    const n = Number(req.delay);
    if (!Number.isFinite(n) || n < 0 || n > 7 * 24 * 60 * 60 * 1000) {
      errs.push(`job.delay must be a non-negative number of ms up to 7 days (got ${JSON.stringify(req.delay)})`);
    }
  }
  return errs;
}

module.exports = {
  JOB_TYPES,
  JOB_TYPE_NAMES,
  validateJobRequest,
  validateSearch,
  validateDetailBatch,
  validateEnrich,
  searchToTask,
  detailBatchToTask,
  enrichToTask,
  PRIORITY_HIGH,
  PRIORITY_NORMAL,
  PRIORITY_LOW,
  PRIORITY_BANDS,
  resolvePriority,
};
