#!/usr/bin/env node
'use strict';

/**
 * scripts/queue-status.js — Phase 2.9 — Job Queue & Orchestration
 *
 * Live, top-style status monitor for the BullMQ queue. Refreshes every 2s.
 * Prints:
 *   - Queue-wide counts: waiting / active / completed / failed / delayed / total
 *   - Active jobs: id, type, progress, attemptsMade, elapsed
 *   - Recently-failed jobs (dead-letter): id, type, reason, attemptsMade
 *
 * Modes:
 *   npm run queue:status                       — live view (refreshes 2s, Ctrl-C to exit)
 *   npm run queue:status -- --once             — single snapshot, then exit
 *   npm run queue:status -- --job <jobId>      — inspect a single job
 *   npm run queue:status -- --deadLetter       — list dead-letter jobs in detail
 *   npm run queue:status -- --retry <jobId>    — retry a dead-lettered job
 *   npm run queue:status -- --retryAll         — retry ALL dead-lettered jobs
 *
 * Environment variables (or .env):
 *   REDIS_URL              — Redis connection URL (default redis://localhost:6379)
 *   QUEUE_NAME             — queue name (default 'scraper')
 *
 * Exit codes:
 *   0  — clean exit (Ctrl-C or --once / --job / --deadLetter / --retry / --retryAll)
 *   2  — config error (missing REDIS_URL, can't connect)
 *   3  — runtime error
 */

const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { createQueue } = require('../src/queue');

const REFRESH_MS = 2000;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function fmtMs(ms) {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function fmtJobData(data) {
  if (!data) return '';
  if (data.query && data.location) return `"${data.query}" in "${data.location}"`;
  if (data.businessIds) return `${data.businessIds.length} businesses`;
  if (data.businesses) return `${data.businesses.length} businesses`;
  if (data.businessId) return `business ${data.businessId}`;
  return JSON.stringify(data).slice(0, 60);
}

// ---------------------------------------------------------------------------
// Snapshot — one refresh iteration
// ---------------------------------------------------------------------------

async function printSnapshot(queue, { now }) {
  const stats = await queue.getStats();
  const active = await queue.getActive({ limit: 20 });
  const failed = await queue.deadLetter.list({ limit: 10 });

  // Clear screen (ANSI) — but only in TTY mode. Non-TTY (piped) just prints.
  if (process.stdout.isTTY) {
    process.stdout.write('\x1B[2J\x1B[H');
  }

  const lines = [];
  lines.push('========================================');
  lines.push(`Queue: scraper  @  ${new Date(now).toISOString()}`);
  lines.push('----------------------------------------');
  lines.push(
    `  waiting:    ${pad(stats.waiting, 6)}   active:    ${pad(stats.active, 6)}   completed: ${pad(stats.completed, 6)}`,
  );
  lines.push(
    `  failed:     ${pad(stats.failed, 6)}   delayed:   ${pad(stats.delayed, 6)}   total:     ${pad(stats.total, 6)}`,
  );
  lines.push('========================================');
  lines.push('');

  // Active jobs
  lines.push('Active jobs:');
  if (active.length === 0) {
    lines.push('  (none — queue is idle)');
  } else {
    lines.push(
      `  ${pad('JOB ID', 24)}  ${pad('TYPE', 14)}  ${pad('PROG', 6)}  ${pad('TRY', 4)}  ${pad('ELAPSED', 8)}  DATA`,
    );
    for (const j of active) {
      const elapsed = j.processedOn ? now - j.processedOn : 0;
      lines.push(
        `  ${pad(j.id, 24)}  ${pad(j.type, 14)}  ${pad(String(j.progress || 0), 6)}  ${pad(String(j.attemptsMade || 0), 4)}  ${pad(fmtMs(elapsed), 8)}  ${truncate(fmtJobData(j.data), 40)}`,
      );
    }
  }
  lines.push('');

  // Recently-failed (dead-letter)
  lines.push(`Dead-letter jobs (last ${failed.jobs.length}${failed.total > failed.jobs.length ? ` of ${failed.total}` : ''}):`);
  if (failed.jobs.length === 0) {
    lines.push('  (none — no failed jobs)');
  } else {
    lines.push(
      `  ${pad('JOB ID', 24)}  ${pad('TYPE', 14)}  ${pad('TRY', 4)}  REASON`,
    );
    for (const j of failed.jobs) {
      lines.push(
        `  ${pad(j.id, 24)}  ${pad(j.name, 14)}  ${pad(String(j.attemptsMade || 0), 4)}  ${truncate(j.failedReason || '(no reason)', 50)}`,
      );
    }
    if (failed.total > failed.jobs.length) {
      lines.push(`  ... and ${failed.total - failed.jobs.length} more (use --deadLetter for full list)`);
    }
  }
  lines.push('');
  lines.push('Ctrl-C to exit | --once for single snapshot | --job <id> to inspect | --retry <id> | --retryAll');

  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// Single-job inspection
// ---------------------------------------------------------------------------

async function inspectJob(queue, jobId) {
  const status = await queue.getStatus(jobId);
  if (!status) {
    console.error(`Job not found: ${jobId}`);
    process.exit(1);
  }
  console.log('========================================');
  console.log(`Job: ${status.id}`);
  console.log('========================================');
  console.log(`  type:         ${status.type}`);
  console.log(`  state:        ${status.state}`);
  console.log(`  attemptsMade: ${status.attemptsMade}`);
  console.log(`  progress:     ${status.progress}`);
  console.log(`  timestamp:    ${status.timestamp ? new Date(status.timestamp).toISOString() : '—'}`);
  console.log(`  processedOn:  ${status.processedOn ? new Date(status.processedOn).toISOString() : '—'}`);
  console.log(`  finishedOn:   ${status.finishedOn ? new Date(status.finishedOn).toISOString() : '—'}`);
  console.log(`  error:        ${status.error || '—'}`);
  console.log('  data:');
  console.log(JSON.stringify(status.data, null, 4).replace(/^/gm, '    '));
  if (status.result) {
    console.log('  result:');
    console.log(JSON.stringify(status.result, null, 4).replace(/^/gm, '    '));
  }
}

// ---------------------------------------------------------------------------
// Dead-letter detail listing
// ---------------------------------------------------------------------------

async function listDeadLetter(queue) {
  const { jobs, total } = await queue.deadLetter.list({ limit: 1000 });
  console.log('========================================');
  console.log(`Dead-letter jobs: ${total}`);
  console.log('========================================');
  if (jobs.length === 0) {
    console.log('(none)');
    return;
  }
  for (const j of jobs) {
    console.log('');
    console.log(`  id:           ${j.id}`);
    console.log(`  type:         ${j.name}`);
    console.log(`  attemptsMade: ${j.attemptsMade}`);
    console.log(`  finishedOn:   ${j.finishedOn ? new Date(j.finishedOn).toISOString() : '—'}`);
    console.log(`  reason:       ${j.failedReason || '(none)'}`);
    console.log(`  data:         ${JSON.stringify(j.data)}`);
  }
  console.log('');
  console.log(`Retry a single job:  npm run queue:status -- --retry <jobId>`);
  console.log(`Retry all:           npm run queue:status -- --retryAll`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const cfg = loadConfig(process.argv.slice(2));
  cfg.queue.enabled = true;
  if (!cfg.queue.redisUrl) {
    console.error('ERROR: REDIS_URL is required for queue:status.');
    console.error('Set REDIS_URL in .env or pass --redisUrl <url>.');
    process.exit(2);
  }

  const argv = process.argv.slice(2);
  const logger = createLogger({ level: cfg.logLevel, silent: true });

  const queue = createQueue({
    redisUrl: cfg.queue.redisUrl,
    name: 'scraper',
    logger,
    defaultPriority: cfg.queue.priority,
    defaultAttempts: cfg.queue.attempts,
    concurrency: cfg.queue.concurrency,
  });

  // --job <id> — single-job inspection, then exit.
  const jobIdx = argv.indexOf('--job');
  if (jobIdx !== -1 && argv[jobIdx + 1]) {
    await inspectJob(queue, argv[jobIdx + 1]);
    await queue.shutdown();
    process.exit(0);
  }

  // --deadLetter — list all dead-letter jobs, then exit.
  if (argv.includes('--deadLetter')) {
    await listDeadLetter(queue);
    await queue.shutdown();
    process.exit(0);
  }

  // --retry <id> — retry a single dead-lettered job, then exit.
  const retryIdx = argv.indexOf('--retry');
  if (retryIdx !== -1 && argv[retryIdx + 1]) {
    const r = await queue.retryDeadLetter(argv[retryIdx + 1]);
    if (r.ok) {
      console.log(`✓ Re-queued: ${argv[retryIdx + 1]}`);
    } else {
      console.error(`✗ Failed: ${r.error}`);
    }
    await queue.shutdown();
    process.exit(r.ok ? 0 : 1);
  }

  // --retryAll — retry ALL dead-lettered jobs, then exit.
  if (argv.includes('--retryAll')) {
    const r = await queue.deadLetter.retryAll({ limit: 10000 });
    console.log(`Re-queued: ${r.retried} OK, ${r.failed} failed (of ${r.total})`);
    if (r.errors.length > 0) {
      for (const e of r.errors) {
        console.error(`  ${e.jobId}: ${e.error}`);
      }
    }
    await queue.shutdown();
    process.exit(r.failed > 0 ? 1 : 0);
  }

  // --once — single snapshot, then exit.
  if (argv.includes('--once')) {
    await printSnapshot(queue, { now: Date.now() });
    await queue.shutdown();
    process.exit(0);
  }

  // Default: live view (refreshes every 2s).
  console.log('Phase 2.9 — Queue Status Monitor (live, 2s refresh)');
  console.log('Ctrl-C to exit.\n');

  let stopped = false;
  const onSigInt = () => {
    if (stopped) process.exit(130);
    stopped = true;
    process.stdout.write('\nShutting down...\n');
    queue.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', onSigInt);

  // Print once immediately, then on an interval.
  while (!stopped) {
    try {
      await printSnapshot(queue, { now: Date.now() });
    } catch (err) {
      process.stdout.write(`\nError fetching status: ${err.message}\n`);
    }
    // Sleep REFRESH_MS, but break early if stopped.
    const until = Date.now() + REFRESH_MS;
    while (Date.now() < until && !stopped) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

main().catch((err) => {
  console.error('queue:status failed:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(3);
});
