'use strict';

/**
 * src/health/server.js — Phase 2.10 — HTTP /health Endpoint
 *
 * A tiny HTTP server that exposes a single GET /health route returning a JSON
 * snapshot of the scraper's runtime state. Used in --endless mode (and
 * optionally in any mode via --healthPort) so an external monitor / load
 * balancer / Kubernetes liveness probe can check the scraper is alive without
 * parsing log files.
 *
 * Uses Node's built-in `http` module — no Express dependency. The server is
 * fully DI: the snapshot function is injectable so tests don't need a real
 * memory monitor + pool + queue. The default snapshot wires together the
 * memory monitor + pool + queue if they're passed in.
 *
 * Response shape (200 OK, application/json):
 *   {
 *     "status": "ok" | "degraded" | "unhealthy",
 *     "uptime": 12345,           // seconds since server start
 *     "startedAt": "2026-...",   // ISO timestamp
 *     "heap": { "usedMb": 512, "rssMb": 894, "highWaterMb": 1024 },
 *     "workers": { "size": 3, "activeSize": 3, "totals": {...} },
 *     "queue": { "waiting": 12, "active": 1, "completed": 480, "failed": 2 },
 *     "endless": true,
 *     "version": "1.0.0-phase2.10"
 *   }
 *
 * Status mapping:
 *   - "ok"        — heap below threshold, all workers healthy, queue alive
 *   - "degraded"  — RSS/heap above warning threshold OR a worker retired OR
 *                   queue backed up (>100 waiting) — but still processing
 *   - "unhealthy" — heap above critical threshold OR pool exhausted OR no
 *                   workers active (the operator should restart the process)
 *
 * Public API:
 *   const server = createHealthServer({
 *     port, host, logger, getSnapshot, clock,
 *   });
 *   await server.start();
 *   await server.stop();
 *   server.port();  // → actual port (useful when port=0 = random)
 */

const http = require('http');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 9100;
const DEFAULT_HOST = '127.0.0.1'; // bind to localhost by default (not exposed)
const DEFAULT_DEGRADED_HEAP_MB = 1024;
const DEFAULT_UNHEALTHY_HEAP_MB = 2048;
const DEFAULT_DEGRADED_QUEUE_DEPTH = 100;
const DEFAULT_UNHEALTHY_QUEUE_DEPTH = 1000;

function defaultClock() {
  return Date.now();
}

function makeStubLogger() {
  const noop = () => {};
  noop.debug = noop;
  noop.info = noop;
  noop.warn = noop;
  noop.error = noop;
  noop.phase = () => makeStubLogger();
  noop.child = () => makeStubLogger();
  return noop;
}

const MB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Default snapshot builder
// ---------------------------------------------------------------------------

/**
 * Build a default snapshot from the supplied runtime components. Each is
 * optional — when a component is missing, its section is null. This makes
 * the server usable in --workers 1 mode (no pool) and --queue off mode (no
 * queue), as well as in tests where everything is mocked.
 *
 * @param {object} args
 * @param {object} [args.memoryMonitor]  — Phase 2.10 memory monitor ({ snapshot, highWater })
 * @param {object} [args.pool]           — Phase 2.8 worker pool ({ stats })
 * @param {object} [args.queue]          — Phase 2.9 queue adapter ({ getStats })
 * @param {boolean} [args.endless]       — true when --endless mode
 * @param {string} [args.version]        — package version
 * @param {number} [args.startedAt]      — epoch ms when the run started
 * @param {object} [args.limits]         — degraded/unhealthy thresholds
 * @returns {function} getSnapshot — () => ({ status, uptime, heap, workers, queue, endless, version, startedAt })
 */
function createDefaultSnapshotBuilder({
  memoryMonitor,
  pool,
  queue,
  endless,
  version,
  startedAt,
  clock,
  limits,
}) {
  const clockFn = typeof clock === 'function' ? clock : defaultClock;
  const degradedHeapMb = (limits && limits.degradedHeapMb) || DEFAULT_DEGRADED_HEAP_MB;
  const unhealthyHeapMb = (limits && limits.unhealthyHeapMb) || DEFAULT_UNHEALTHY_HEAP_MB;
  const degradedQueueDepth = (limits && limits.degradedQueueDepth) || DEFAULT_DEGRADED_QUEUE_DEPTH;
  const unhealthyQueueDepth =
    (limits && limits.unhealthyQueueDepth) || DEFAULT_UNHEALTHY_QUEUE_DEPTH;

  return function getSnapshot() {
    const now = clockFn();
    const uptime = startedAt ? Math.round((now - startedAt) / 1000) : 0;

    // Heap section — from the memory monitor (if present).
    let heap = null;
    let heapUsedMb = 0;
    let highWaterMb = 0;
    if (memoryMonitor) {
      const snap = memoryMonitor.snapshot();
      // Support both getHighWater() (primary) and highWater() (legacy alias).
      const hwFn = memoryMonitor.getHighWater || memoryMonitor.highWater;
      const hw = typeof hwFn === 'function' ? hwFn.call(memoryMonitor) : null;
      if (snap) {
        heapUsedMb = snap.heapUsedMb;
        heap = {
          usedMb: snap.heapUsedMb,
          totalMb: snap.heapTotalMb,
          rssMb: snap.rssMb,
          workers: snap.workers,
        };
      }
      if (hw) {
        highWaterMb = hw.heapMb;
        if (heap) heap.highWaterMb = hw.heapMb;
      }
    }

    // Workers section — from the pool (if present).
    let workers = null;
    let activeSize = 0;
    let retiredCount = 0;
    let poolTotals = null;
    if (pool && typeof pool.stats === 'function') {
      const ps = pool.stats();
      activeSize = ps.activeSize || 0;
      retiredCount = ps.retiredCount || 0;
      poolTotals = ps.totals || null;
      workers = {
        size: ps.size,
        activeSize: ps.activeSize,
        retiredCount: ps.retiredCount,
        loadBalancer: ps.loadBalancer,
        totals: ps.totals,
      };
    }

    // Queue section — from the queue adapter (if present).
    let queueSection = null;
    let queueDepth = 0;
    let queueFailed = 0;
    if (queue && typeof queue.getStats === 'function') {
      try {
        const qs = queue.getStats();
        queueDepth = (qs.waiting || 0) + (qs.active || 0) + (qs.delayed || 0);
        queueFailed = qs.failed || 0;
        queueSection = qs;
      } catch {
        queueSection = null;
      }
    }

    // Status determination.
    let status = 'ok';
    if (heapUsedMb >= unhealthyHeapMb || activeSize === 0 || queueDepth >= unhealthyQueueDepth) {
      status = 'unhealthy';
    } else if (
      heapUsedMb >= degradedHeapMb ||
      retiredCount > 0 ||
      queueDepth >= degradedQueueDepth ||
      queueFailed > 0
    ) {
      status = 'degraded';
    }

    return {
      status,
      uptime,
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      heap,
      workers,
      queue: queueSection,
      endless: !!endless,
      version: version || null,
    };
  };
}

// ---------------------------------------------------------------------------
// createHealthServer
// ---------------------------------------------------------------------------

/**
 * Create (but don't start) the HTTP /health server.
 *
 * @param {object} opts
 * @param {number} [opts.port=9100]      — bind port (0 = random free port)
 * @param {string} [opts.host='127.0.0.1'] — bind host
 * @param {object} [opts.logger]
 * @param {function} [opts.getSnapshot]  — DI: () => snapshot object (default builder used otherwise)
 * @param {object} [opts.memoryMonitor]  — passed to the default builder
 * @param {object} [opts.pool]           — passed to the default builder
 * @param {object} [opts.queue]          — passed to the default builder
 * @param {boolean} [opts.endless]       — passed to the default builder
 * @param {string} [opts.version]        — passed to the default builder
 * @param {number} [opts.startedAt]      — passed to the default builder
 * @param {()=>number} [opts.clock]      — DI clock
 * @param {object} [opts.limits]         — degraded/unhealthy thresholds
 * @param {object} [opts.httpServer]     — DI: a pre-built http.Server (tests)
 * @returns {object} server — { start, stop, port, address }
 */
function createHealthServer(opts = {}) {
  const port = Number.isFinite(opts.port) ? opts.port : DEFAULT_PORT;
  const host = opts.host || DEFAULT_HOST;
  const logger = opts.logger || makeStubLogger();
  const clock = typeof opts.clock === 'function' ? opts.clock : defaultClock;
  const getSnapshot =
    typeof opts.getSnapshot === 'function'
      ? opts.getSnapshot
      : createDefaultSnapshotBuilder({
          memoryMonitor: opts.memoryMonitor,
          pool: opts.pool,
          queue: opts.queue,
          endless: opts.endless,
          version: opts.version,
          startedAt: opts.startedAt,
          clock,
          limits: opts.limits,
        });

  // Allow tests to inject a pre-built server (so they can bind to port 0
  // without us touching http.createServer). Production leaves this undefined.
  const server = opts.httpServer || http.createServer(handleRequest);

  let boundPort = null;
  let boundHost = null;

  function handleRequest(req, res) {
    // Only GET /health (and GET / for convenience). Everything else → 404.
    const url = (req.url || '').split('?')[0];
    if (req.method !== 'GET' || (url !== '/health' && url !== '/')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: url }));
      return;
    }
    let snap;
    try {
      snap = getSnapshot();
    } catch (err) {
      logger.error('Health server: getSnapshot() threw', { error: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'snapshot failed', message: err.message }));
      return;
    }
    const body = JSON.stringify(snap);
    // 200 for ok/degraded, 503 for unhealthy (so a load balancer routes around).
    const code = snap.status === 'unhealthy' ? 503 : 200;
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  /**
   * Start listening. Returns a promise that resolves once the server is bound.
   * Re-bind is a no-op.
   */
  function start() {
    return new Promise((resolve, reject) => {
      if (boundPort !== null) {
        resolve({ port: boundPort, host: boundHost });
        return;
      }
      server.on('error', (err) => {
        logger.error('Health server error', { error: err.message });
        reject(err);
      });
      server.listen(port, host, () => {
        const addr = server.address();
        boundPort = typeof addr === 'object' && addr ? addr.port : port;
        boundHost = host;
        logger.info('Health server listening', { port: boundPort, host: boundHost });
        resolve({ port: boundPort, host: boundHost });
      });
    });
  }

  /**
   * Stop listening. Returns a promise that resolves once the server is closed.
   * Idempotent.
   */
  function stop() {
    return new Promise((resolve) => {
      if (boundPort === null) {
        resolve();
        return;
      }
      server.close(() => {
        boundPort = null;
        boundHost = null;
        logger.info('Health server stopped');
        resolve();
      });
      // Safety: force-close any lingering keep-alive connections after 1s.
      setTimeout(() => {
        try {
          server.closeAllConnections && server.closeAllConnections();
        } catch {
          /* node < 18 — best-effort */
        }
      }, 1000);
    });
  }

  function getPort() {
    return boundPort;
  }

  function address() {
    return boundPort === null ? null : { port: boundPort, host: boundHost };
  }

  return {
    start,
    stop,
    port: getPort,
    getPort,
    address,
    // exposed for tests
    _handleRequest: handleRequest,
    _server: server,
  };
}

module.exports = {
  createHealthServer,
  createDefaultSnapshotBuilder,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_DEGRADED_HEAP_MB,
  DEFAULT_UNHEALTHY_HEAP_MB,
  DEFAULT_DEGRADED_QUEUE_DEPTH,
  DEFAULT_UNHEALTHY_QUEUE_DEPTH,
  defaultClock,
  makeStubLogger,
};
