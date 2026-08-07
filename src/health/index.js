'use strict';

/**
 * src/health/index.js — Phase 2.10 — Health Subsystem Barrel
 *
 * Re-exports the four Phase 2.10 health modules + the orchestrator that wires
 * them together for use in src/index.js. The orchestrator (createHealthStack)
 * bundles the memory monitor + worker probe + zombie reaper + degradation
 * handler into a single object so the main entry point can start/stop them
 * with one call.
 *
 * Modules:
 *   - memory-monitor.js : startMemoryMonitor — periodic heap polling
 *   - worker-probe.js   : startWorkerProbe — stuck/bloat/unresponsive detection
 *   - zombie-reaper.js  : createZombieReaper — orphan Chromium cleanup
 *   - degradation.js    : createDegradation — graceful recovery under RSS pressure
 *   - server.js         : createHealthServer — HTTP /health endpoint
 *
 * Public API:
 *   const stack = createHealthStack({
 *     cfg, logger, pool, queue, memoryMonitor, getWorkers, getRss, gcFn,
 *     onMemoryThreshold, onWorkerIssue, startedAt, version,
 *   });
 *   await stack.start();   // starts monitor + probe + server (if enabled)
 *   await stack.stop();    // stops all intervals + closes the server
 *   stack.snapshot();      // → combined snapshot for /health
 */

const {
  startMemoryMonitor,
  buildSnapshot,
  formatMemoryLine,
  formatHighWaterLine,
  DEFAULT_INTERVAL_MS: DEFAULT_MEMORY_INTERVAL_MS,
  DEFAULT_LOG_EVERY_MS,
  DEFAULT_THRESHOLD_MB,
} = require('./memory-monitor');
const {
  startWorkerProbe,
  DEFAULT_MAX_HEAP_MB,
  DEFAULT_STUCK_AFTER_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_PROBE_THRESHOLD,
  DEFAULT_INTERVAL_MS: DEFAULT_PROBE_INTERVAL_MS,
} = require('./worker-probe');
const {
  createZombieReaper,
  DEFAULT_PATTERN,
} = require('./zombie-reaper');
const {
  createDegradation,
  DEFAULT_MAX_RSS_MB,
} = require('./degradation');
const {
  createHealthServer,
  createDefaultSnapshotBuilder,
  DEFAULT_PORT,
} = require('./server');

// ---------------------------------------------------------------------------
// createHealthStack — the orchestrator
// ---------------------------------------------------------------------------

/**
 * Create a health stack: memory monitor + worker probe + degradation handler
 * + (optional) HTTP server, all wired together. The caller passes the runtime
 * components (pool, queue) and callbacks; the stack handles start/stop.
 *
 * @param {object} opts
 * @param {object} opts.cfg                 — resolved Phase 2.10 config (cfg.health)
 * @param {object} [opts.logger]
 * @param {object} [opts.pool]              — Phase 2.8 worker pool
 * @param {object} [opts.queue]             — Phase 2.9 queue adapter
 * @param {()=>Array|{workers:Array}} [opts.getWorkers] — DI workers accessor (default: () => cfg.pool.workers)
 * @param {()=>number} [opts.getRss]        — DI RSS accessor (default process.memoryUsage().rss)
 * @param {()=>boolean} [opts.gcFn]         — global.gc wrapper (only when --expose-gc)
 * @param {(snap)=>void} [opts.onMemoryThreshold] — fires when heap crosses --maxHeapMb
 * @param {(worker,issue)=>void} [opts.onWorkerIssue] — fires when a worker is misbehaving
 * @param {number} [opts.startedAt]         — epoch ms (for the /health uptime)
 * @param {string} [opts.version]           — package version (for /health)
 * @param {boolean} [opts.endless]          — true when --endless mode
 * @returns {object} stack — { memoryMonitor, workerProbe, degradation, zombieReaper, server, start, stop, snapshot }
 */
function createHealthStack(opts = {}) {
  const cfg = opts.cfg || {};
  const healthCfg = cfg.health || {};
  const logger = opts.logger || require('./memory-monitor').makeStubLogger();
  const getWorkers =
    typeof opts.getWorkers === 'function'
      ? opts.getWorkers
      : () => (opts.pool && opts.pool.workers ? opts.pool.workers : []);
  const getRss = typeof opts.getRss === 'function' ? opts.getRss : null;
  const gcFn = typeof opts.gcFn === 'function' ? opts.gcFn : null;
  const startedAt = opts.startedAt || Date.now();
  const version = opts.version || null;
  const endless = !!opts.endless;

  // 1) Memory monitor — polls heap every healthCfg.memoryIntervalMs (default 30s),
  //    logs a snapshot every 5 min, fires onThreshold when heap crosses
  //    healthCfg.maxHeapMb (default 1024 MB).
  const memoryMonitor = startMemoryMonitor({
    intervalMs: healthCfg.memoryIntervalMs,
    logEveryMs: healthCfg.logEveryMs,
    thresholdMb: healthCfg.maxHeapMb,
    logger,
    onThreshold: opts.onMemoryThreshold || null,
    getWorkers,
  });

  // 2) Worker probe — inspects every worker every healthCfg.workerProbeIntervalMs
  //    (default 60s). Fires onWorkerIssue when a worker is bloated / stuck /
  //    unresponsive. The probe is only useful when a pool exists.
  const workerProbe = opts.pool
    ? startWorkerProbe({
        getWorkers,
        maxHeapMb: healthCfg.workerMaxHeapMb,
        stuckAfterMs: healthCfg.stuckAfterMs,
        probeTimeoutMs: healthCfg.probeTimeoutMs,
        probeThreshold: healthCfg.probeThreshold,
        intervalMs: healthCfg.workerProbeIntervalMs,
        logger,
        onIssue: opts.onWorkerIssue || null,
      })
    : null;

  // 3) Zombie reaper — created up front; reapOnStartup / reapOnShutdown are
  //    called explicitly from src/index.js (startup + SIGINT).
  const zombieReaper = createZombieReaper({ logger });

  // 4) Degradation handler — runs the pause → wait → restart → gc → resume →
  //    reduce-pool sequence when RSS crosses healthCfg.maxRssMb. The caller
  //    wires pauseFn/resumeFn/restartWorkerFn/reducePoolFn.
  const degradation = createDegradation({
    maxRssMb: healthCfg.maxRssMb,
    logger,
    getRss,
    getWorkers,
    pauseFn: opts.pauseFn || null,
    resumeFn: opts.resumeFn || null,
    restartWorkerFn: opts.restartWorkerFn || null,
    reducePoolFn: opts.reducePoolFn || null,
    gcFn,
  });

  // 5) HTTP /health server — only when --healthPort is set OR --endless is on.
  const startServer = healthCfg.serverEnabled || endless;
  const server = startServer
    ? createHealthServer({
        port: healthCfg.port,
        host: healthCfg.host,
        logger,
        memoryMonitor,
        pool: opts.pool,
        queue: opts.queue,
        endless,
        version,
        startedAt,
      })
    : null;

  async function start() {
    if (server) {
      try {
        await server.start();
      } catch (err) {
        logger.warn('Health server failed to start (non-fatal — continuing)', {
          error: err.message,
        });
      }
    }
    logger.info('Health stack started', {
      memoryMonitor: true,
      workerProbe: !!workerProbe,
      server: !!server,
      endless,
    });
  }

  async function stop() {
    // Stop the memory monitor + worker probe intervals.
    try {
      memoryMonitor.stop();
    } catch {
      /* best-effort */
    }
    if (workerProbe) {
      try {
        workerProbe.stop();
      } catch {
        /* best-effort */
      }
    }
    if (server) {
      try {
        await server.stop();
      } catch {
        /* best-effort */
      }
    }
  }

  function snapshot() {
    return createDefaultSnapshotBuilder({
      memoryMonitor,
      pool: opts.pool,
      queue: opts.queue,
      endless,
      version,
      startedAt,
      clock: require('./memory-monitor').defaultClock,
    })();
  }

  return {
    memoryMonitor,
    workerProbe,
    zombieReaper,
    degradation,
    server,
    start,
    stop,
    snapshot,
  };
}

module.exports = {
  // orchestrator
  createHealthStack,
  // memory monitor
  startMemoryMonitor,
  buildSnapshot,
  formatMemoryLine,
  formatHighWaterLine,
  DEFAULT_MEMORY_INTERVAL_MS,
  DEFAULT_LOG_EVERY_MS,
  DEFAULT_THRESHOLD_MB,
  // worker probe
  startWorkerProbe,
  DEFAULT_MAX_HEAP_MB,
  DEFAULT_STUCK_AFTER_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_PROBE_THRESHOLD,
  DEFAULT_PROBE_INTERVAL_MS,
  // zombie reaper
  createZombieReaper,
  DEFAULT_PATTERN,
  // degradation
  createDegradation,
  DEFAULT_MAX_RSS_MB,
  // server
  createHealthServer,
  createDefaultSnapshotBuilder,
  DEFAULT_PORT,
};
