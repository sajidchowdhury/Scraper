#!/usr/bin/env node
'use strict';

/**
 * scripts/batch.js — Phase 2.9 — Job Queue & Orchestration
 *
 * Batch-submits search jobs to the BullMQ queue from a CSV file. Each CSV row
 * becomes one `search` job. The script submits all jobs, prints their IDs,
 * and exits — it does NOT wait for completion (that's what queue:status is for).
 *
 * CSV format (header row required):
 *   query,location,maxResults,deepScrape,priority
 *   Cafe,Berlin,50,true,5
 *   Restaurant,Toronto,,false,1
 *   Plumber,"Dhaka, Bangladesh",100,,10
 *
 * Only `query` and `location` are required. `maxResults` may be empty (= all).
 * `deepScrape` may be empty (= false). `priority` may be empty (= cfg default).
 * Values are case-insensitive for booleans (true/yes/1 → true).
 *
 * Quoted values with commas are supported (standard CSV). Lines starting with
 * `#` are comments. Blank lines are skipped.
 *
 * Usage:
 *   npm run batch -- --file queries.csv
 *   npm run batch -- --file queries.csv --queue on --redisUrl redis://localhost:6379
 *   npm run batch -- --file queries.csv --priority 1          # all jobs high-priority
 *   npm run batch -- --file queries.csv --attempts 5          # override retry count
 *   npm run batch -- --file queries.csv --dryRun              # parse + print, don't submit
 *
 * Environment variables (or .env):
 *   REDIS_URL              — Redis connection URL (default redis://localhost:6379)
 *   QUEUE_NAME             — queue name (default 'scraper')
 *   QUEUE_PRIORITY         — default priority (default 5)
 *   QUEUE_ATTEMPTS         — default attempts (default 3)
 *
 * Exit codes:
 *   0  — all jobs submitted successfully (or --dryRun parse OK)
 *   1  — some jobs failed to submit (invalid rows); details printed
 *   2  — config error (file not found, unreadable, missing REDIS_URL, ...)
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { createQueue } = require('../src/queue');

// ---------------------------------------------------------------------------
// CSV parser (hand-rolled — no external dep, handles quotes + commas)
// ---------------------------------------------------------------------------

/**
 * Parse a single CSV line into fields. Handles double-quoted fields (with
 * escaped quotes via "") and commas inside quotes. Returns string[].
 */
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

/**
 * Parse a CSV file into an array of row objects. The first non-comment /
 * non-blank line is the header row. Returns { rows, errors } where errors is
 * an array of { line, message } for malformed rows.
 */
function parseCsvFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  let header = null;
  const rows = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const fields = parseCsvLine(line);
    if (!header) {
      header = fields.map((f) => f.toLowerCase());
      continue;
    }
    if (fields.length < 2) {
      errors.push({ line: i + 1, message: `expected at least 2 fields (query, location), got ${fields.length}` });
      continue;
    }
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = fields[j] || '';
    }
    rows.push({ line: i + 1, row });
  }
  if (!header) {
    errors.push({ line: 0, message: 'CSV file has no header row' });
  }
  return { rows, errors, header };
}

function parseBool(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(s)) return true;
  if (['false', 'no', '0', 'off'].includes(s)) return false;
  return undefined;
}

function parseIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Reuse the main config loader so --redisUrl / --queuePriority / --queueAttempts
  // resolve consistently between `npm start --queue on` and `npm run batch`.
  const cfg = loadConfig(process.argv.slice(2));

  // The batch CLI uses --queue on implicitly (it's the whole point). We force
  // it on here so the operator doesn't have to repeat --queue on.
  cfg.queue.enabled = true;
  if (!cfg.queue.redisUrl) {
    console.error('ERROR: REDIS_URL is required for batch submission.');
    console.error('Set REDIS_URL in .env or pass --redisUrl <url>.');
    process.exit(2);
  }

  // Parse the --file argument (re-parse argv since loadConfig doesn't expose it).
  const argv = process.argv.slice(2);
  let fileIdx = argv.indexOf('--file');
  if (fileIdx === -1) fileIdx = argv.indexOf('-f');
  if (fileIdx === -1 || !argv[fileIdx + 1]) {
    console.error('ERROR: --file <path> is required.');
    console.error('Usage: npm run batch -- --file queries.csv [--priority 1] [--attempts 5] [--dryRun]');
    process.exit(2);
  }
  const filePath = path.resolve(argv[fileIdx + 1]);
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: file not found: ${filePath}`);
    process.exit(2);
  }

  const logger = createLogger({ level: cfg.logLevel, silent: true });
  console.log(`=== Phase 2.9 — Batch Job Submission ===`);
  console.log(`CSV:       ${filePath}`);
  console.log(`Redis:     ${cfg.queue.redisUrl}`);
  console.log(`Queue:     scraper (priority ${cfg.queue.priority}, ${cfg.queue.attempts} attempts)`);
  console.log('');

  // Parse the CSV.
  const { rows, errors: parseErrors, header } = parseCsvFile(filePath);
  if (parseErrors.length > 0) {
    console.error('CSV parse errors:');
    for (const e of parseErrors) {
      console.error(`  line ${e.line}: ${e.message}`);
    }
    process.exit(2);
  }
  console.log(`Header:    ${header.join(', ')}`);
  console.log(`Rows:      ${rows.length}`);
  console.log('');

  // Build the job requests.
  const jobRequests = [];
  const rowErrors = [];
  for (const { line, row } of rows) {
    if (!row.query || !row.query.trim()) {
      rowErrors.push({ line, message: 'missing query' });
      continue;
    }
    if (!row.location || !row.location.trim()) {
      rowErrors.push({ line, message: 'missing location' });
      continue;
    }
    const maxResults = parseIntOrNull(row.maxresults);
    const deepScrape = parseBool(row.deepscrape);
    const priority = parseIntOrNull(row.priority) ?? cfg.queue.priority;
    jobRequests.push({
      type: 'search',
      payload: {
        query: row.query,
        location: row.location,
        ...(maxResults !== null ? { maxResults } : {}),
        ...(deepScrape !== undefined ? { deepScrape } : {}),
      },
      priority,
      attempts: cfg.queue.attempts,
    });
  }

  if (rowErrors.length > 0) {
    console.error('Row validation errors:');
    for (const e of rowErrors) {
      console.error(`  line ${e.line}: ${e.message}`);
    }
    // Continue — submit the valid rows. Exit code 1 at the end.
  }

  console.log(`Valid jobs: ${jobRequests.length}`);
  console.log(`Skipped:    ${rowErrors.length}`);
  console.log('');

  if (cfg.dryRun || jobRequests.length === 0) {
    console.log('Dry run — not submitting. Job requests:');
    for (const j of jobRequests) {
      console.log(`  [${j.priority}] search: "${j.payload.query}" in "${j.payload.location}"` +
        (j.payload.maxResults ? ` (max ${j.payload.maxResults})` : '') +
        (j.payload.deepScrape ? ' +deepScrape' : ''));
    }
    if (cfg.dryRun) process.exit(0);
    if (jobRequests.length === 0) process.exit(1);
  }

  // Build the queue + submit.
  const queue = createQueue({
    redisUrl: cfg.queue.redisUrl,
    name: 'scraper',
    logger,
    defaultPriority: cfg.queue.priority,
    defaultAttempts: cfg.queue.attempts,
    concurrency: cfg.queue.concurrency,
  });

  console.log('Submitting jobs...');
  const submitted = await queue.addBatch(jobRequests);
  let ok = 0;
  let fail = 0;
  const jobIds = [];
  for (let i = 0; i < submitted.length; i++) {
    const s = submitted[i];
    const j = jobRequests[i];
    if (s.id) {
      ok++;
      jobIds.push(s.id);
      console.log(`  ✓ [${j.priority}] ${s.id}  "${j.payload.query}" in "${j.payload.location}"`);
    } else {
      fail++;
      console.log(`  ✗ "${j.payload.query}" in "${j.payload.location}" — ${s.error}`);
    }
  }

  console.log('');
  console.log(`Submitted: ${ok} OK, ${fail} failed`);
  if (jobIds.length > 0) {
    console.log('');
    console.log('Job IDs:');
    for (const id of jobIds) console.log(`  ${id}`);
    console.log('');
    console.log('Monitor with:  npm run queue:status');
    console.log('Inspect a job: npm run queue:status -- --job ' + jobIds[0]);
  }

  // Graceful shutdown — close the queue connection (don't wait for jobs to process).
  await queue.shutdown();

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Batch submission failed:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(3);
});
