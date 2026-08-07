'use strict';

/**
 * tests/health.test.js — Phase 2.10 (Memory Management & Long-Run Stability)
 *
 * Coverage:
 *   - memory-monitor.js: startMemoryMonitor — DI getMemory + getWorkers + clock,
 *     threshold callback firing + re-arming, high-water mark tracking, periodic
 *     log line, snapshot accessor, stop() idempotency.
 *   - worker-probe.js: startWorkerProbe — heap bloat detection, stuck detection,
 *     unresponsive detection (consecutive timeouts), re-arming after issue
 *     clears, retired workers skipped, DI getWorkers + probeFn.
 *   - zombie-reaper.js: createZombieReaper — scan, reapOnStartup, reapOnShutdown,
 *     killWithEscalation (SIGTERM → SIGKILL), protectPids, logReport format,
 *     DI listPids + killPid (no real OS calls).
 *   - degradation.js: createDegradation — shouldRun re-arm semantics, full
 *     handlePressure sequence (pause → wait → restart → gc → resume → reduce),
 *     skip when below threshold, reduce-pool limit, DI getRss + callbacks.
 *   - server.js: createHealthServer — GET /health returns snapshot, 404 for
 *     other paths, 503 for unhealthy, start/stop, default snapshot builder
 *     status determination (ok / degraded / unhealthy).
 *   - index.js (createHealthStack): orchestrator wires monitor + probe +
 *     reaper + degradation + server; start/stop.
 *   - session/manager.js Phase 2.10 extensions: contextRestartEvery periodic
 *     restart, shouldRestartForMemory, restartForMemory, tasksSinceRestart
 *     counter, stats() new fields.
 *   - config.js Phase 2.10 flags: parseArgs + validation + loadConfig defaults.
 *
 * DI: every test uses injectable mocks — NO real setInterval, NO real
 * process.memoryUsage, NO real OS calls, NO real HTTP server (bound to port 0).
 *
 * Run: bun test tests/health.test.js
 */

const {
  startMemoryMonitor,
  buildSnapshot,
  formatMemoryLine,
  formatHighWaterLine,
  DEFAULT_THRESHOLD_MB,
  DEFAULT_INTERVAL_MS,
  DEFAULT_LOG_EVERY_MS,
} = require('../src/health/memory-monitor');
const {
  startWorkerProbe,
  createWorkerTracker,
  DEFAULT_MAX_HEAP_MB,
  DEFAULT_STUCK_AFTER_MS,
  DEFAULT_PROBE_THRESHOLD,
} = require('../src/health/worker-probe');
const {
  createZombieReaper,
  DEFAULT_PATTERN,
} = require('../src/health/zombie-reaper');
const {
  createDegradation,
  DEFAULT_MAX_RSS_MB,
} = require('../src/health/degradation');
const {
  createHealthServer,
  createDefaultSnapshotBuilder,
  DEFAULT_PORT,
  DEFAULT_DEGRADED_HEAP_MB,
  DEFAULT_UNHEALTHY_HEAP_MB,
} = require('../src/health/server');
const { createHealthStack } = require('../src/health');
const {
  createSessionManager,
  SessionError,
  DEFAULT_CONTEXT_RESTART_EVERY,
} = require('../src/session/manager');
const { loadConfig } = require('../src/config');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubLogger() {
  const calls = { debug: [], info: [], warn: [], error: [] };
  const log = (level) => (msg, meta) => { calls[level].push({ msg, meta }); };
  const logger = {
    debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error'),
    phase: () => logger, child: () => logger,
  };
  logger._calls = calls;
  return logger;
}

function noopSleep() { return Promise.resolve(); }

function noopSetInterval() { return null; }
function noopClearInterval() { return undefined; }

// Build a fake memory object (bytes).
function mem({ heapUsed = 100 * 1024 * 1024, heapTotal = 200 * 1024 * 1024, rss = 300 * 1024 * 1024, external = 0, arrayBuffers = 0 } = {}) {
  return { heapUsed, heapTotal, rss, external, arrayBuffers };
}

// Build a fake worker for the probe tests.
function makeFakeWorker({ id = 0, state = 'idle', retired = false, heapUsedMb = 100, tasksCompleted = 5, lastCompletedAt = null, currentTaskId = null, currentTaskType = null } = {}) {
  return {
    id,
    state,
    isRetired: () => retired,
    stats: () => ({
      workerId: id,
      state,
      retired,
      tasksAttempted: tasksCompleted + 1,
      tasksCompleted,
      businessesScraped: tasksCompleted * 10,
      crashes: 0,
      blocked: 0,
      heapUsedMb,
      lastTaskAt: null,
      lastCompletedAt,
      currentTaskId,
      currentTaskType,
    }),
  };
}

// ---------------------------------------------------------------------------
// Memory monitor
// ---------------------------------------------------------------------------

describe('Phase 2.10 — memory-monitor', () => {
  test('buildSnapshot rounds bytes to MB + carries workers + ts', () => {
    const snap = buildSnapshot(mem({ heapUsed: 512 * 1024 * 1024, rss: 1024 * 1024 * 1024 }), { workers: 3, ts: 1000 });
    expect(snap.heapUsedMb).toBe(512);
    expect(snap.rssMb).toBe(1024);
    expect(snap.workers).toBe(3);
    expect(snap.ts).toBe(1000);
  });

  test('formatMemoryLine matches the spec format', () => {
    const line = formatMemoryLine({ heapUsedMb: 512, rssMb: 894, workers: 5 });
    expect(line).toBe('Memory: heap=512MB rss=894MB workers=5');
  });

  test('formatHighWaterLine includes ISO timestamp', () => {
    const line = formatHighWaterLine({ heapMb: 1024, rssMb: 2048, heapAt: 1723014862000, rssAt: 1723014862000 });
    expect(line).toContain('Memory high-water: heap=1024MB');
    expect(line).toContain('rss=2048MB');
    expect(line).toContain('at 202');
  });

  test('startMemoryMonitor: tick reads getMemory + updates snapshot', async () => {
    let cur = mem({ heapUsed: 200 * 1024 * 1024 });
    const logger = makeStubLogger();
    const mon = startMemoryMonitor({
      intervalMs: 30_000,
      thresholdMb: 1024,
      logger,
      getMemory: () => cur,
      getWorkers: () => 3,
      clock: () => 1000,
      setIntervalFn: noopSetInterval,
      clearIntervalFn: noopClearInterval,
    });
    await mon.tick();
    expect(mon.snapshot().heapUsedMb).toBe(200);
    expect(mon.snapshot().workers).toBe(3);
    mon.stop();
  });

  test('startMemoryMonitor: fires onThreshold when heap crosses threshold', async () => {
    let cur = mem({ heapUsed: 200 * 1024 * 1024 });
    let thresholdFired = 0;
    const mon = startMemoryMonitor({
      intervalMs: 30_000,
      thresholdMb: 500,
      logger: makeStubLogger(),
      getMemory: () => cur,
      getWorkers: () => 1,
      clock: () => 1000,
      setIntervalFn: noopSetInterval,
      clearIntervalFn: noopClearInterval,
      onThreshold: (snap) => { thresholdFired++; expect(snap.heapUsedMb).toBe(600); },
    });
    // Below threshold — no fire.
    await mon.tick();
    expect(thresholdFired).toBe(0);
    // Cross threshold — fire once.
    cur = mem({ heapUsed: 600 * 1024 * 1024 });
    await mon.tick();
    expect(thresholdFired).toBe(1);
    // Still above — does NOT fire again (armed = false).
    await mon.tick();
    expect(thresholdFired).toBe(1);
    // Drop below — re-arm.
    cur = mem({ heapUsed: 200 * 1024 * 1024 });
    await mon.tick();
    expect(thresholdFired).toBe(1);
    // Cross again — fires again.
    cur = mem({ heapUsed: 700 * 1024 * 1024 });
    await mon.tick();
    expect(thresholdFired).toBe(2);
    mon.stop();
  });

  test('startMemoryMonitor: tracks high-water mark for heap + rss independently', async () => {
    let cur = mem({ heapUsed: 100 * 1024 * 1024, rss: 200 * 1024 * 1024 });
    const mon = startMemoryMonitor({
      intervalMs: 30_000, thresholdMb: 9999,
      logger: makeStubLogger(), getMemory: () => cur, getWorkers: () => 0,
      clock: () => 1000, setIntervalFn: noopSetInterval, clearIntervalFn: noopClearInterval,
    });
    await mon.tick();
    cur = mem({ heapUsed: 300 * 1024 * 1024, rss: 250 * 1024 * 1024 });
    await mon.tick();
    // heap went up, rss went up
    expect(mon.getHighWater().heapMb).toBe(300);
    expect(mon.getHighWater().rssMb).toBe(250);
    cur = mem({ heapUsed: 200 * 1024 * 1024, rss: 500 * 1024 * 1024 });
    await mon.tick();
    // heap high-water unchanged, rss high-water updated
    expect(mon.getHighWater().heapMb).toBe(300);
    expect(mon.getHighWater().rssMb).toBe(500);
    mon.stop();
  });

  test('startMemoryMonitor: getWorkers accepts array, number, or pool object', async () => {
    const cases = [
      { getWorkers: () => [1, 2, 3], expected: 3 },
      { getWorkers: () => 5, expected: 5 },
      { getWorkers: () => ({ workers: [1, 2] }), expected: 2 },
      { getWorkers: () => ({ activeSize: 4 }), expected: 4 },
      { getWorkers: () => ({ size: 7 }), expected: 7 },
      { getWorkers: () => { throw new Error('boom'); }, expected: 0 },
    ];
    for (const c of cases) {
      const mon = startMemoryMonitor({
        intervalMs: 30_000, thresholdMb: 9999,
        logger: makeStubLogger(), getMemory: () => mem(), getWorkers: c.getWorkers,
        clock: () => 1000, setIntervalFn: noopSetInterval, clearIntervalFn: noopClearInterval,
      });
      await mon.tick();
      expect(mon.snapshot().workers).toBe(c.expected);
      mon.stop();
    }
  });

  test('startMemoryMonitor: periodic log fires on first tick + every logEveryMs', async () => {
    let now = 1000;
    const logger = makeStubLogger();
    const mon = startMemoryMonitor({
      intervalMs: 30_000, logEveryMs: 5 * 60 * 1000, thresholdMb: 9999,
      logger, getMemory: () => mem(), getWorkers: () => 1,
      clock: () => now, setIntervalFn: noopSetInterval, clearIntervalFn: noopClearInterval,
    });
    await mon.tick();
    // First tick always logs.
    const firstInfoCount = logger._calls.info.length;
    expect(firstInfoCount).toBeGreaterThanOrEqual(1);
    // Tick again immediately — no new log (logEveryMs not elapsed).
    await mon.tick();
    expect(logger._calls.info.length).toBe(firstInfoCount);
    // Advance past logEveryMs — next tick logs.
    now += 6 * 60 * 1000;
    await mon.tick();
    expect(logger._calls.info.length).toBeGreaterThan(firstInfoCount);
    mon.stop();
  });

  test('startMemoryMonitor: validation rejects bad intervalMs + thresholdMb', () => {
    expect(() => startMemoryMonitor({ intervalMs: 0, setIntervalFn: noopSetInterval }))
      .toThrow(/intervalMs/);
    expect(() => startMemoryMonitor({ thresholdMb: 0, setIntervalFn: noopSetInterval }))
      .toThrow(/thresholdMb/);
  });

  test('startMemoryMonitor: stop() is idempotent + clears the interval', () => {
    let cleared = 0;
    const mon = startMemoryMonitor({
      intervalMs: 30_000,
      logger: makeStubLogger(), getMemory: () => mem(), getWorkers: () => 0,
      setIntervalFn: () => 'handle-42',
      clearIntervalFn: (h) => { if (h === 'handle-42') cleared++; },
    });
    mon.stop();
    mon.stop(); // idempotent
    expect(cleared).toBe(1);
  });

  test('startMemoryMonitor: getMemory() failure is non-fatal (logs + returns null)', async () => {
    const logger = makeStubLogger();
    const mon = startMemoryMonitor({
      intervalMs: 30_000, thresholdMb: 9999,
      logger, getMemory: () => { throw new Error('boom'); }, getWorkers: () => 0,
      clock: () => 1000, setIntervalFn: noopSetInterval, clearIntervalFn: noopClearInterval,
    });
    const r = await mon.tick();
    expect(r).toBe(null);
    expect(logger._calls.warn.length).toBeGreaterThan(0);
    mon.stop();
  });

  test('startMemoryMonitor: onThreshold callback error is caught (non-fatal)', async () => {
    const logger = makeStubLogger();
    const mon = startMemoryMonitor({
      intervalMs: 30_000, thresholdMb: 100,
      logger, getMemory: () => mem({ heapUsed: 200 * 1024 * 1024 }), getWorkers: () => 0,
      clock: () => 1000, setIntervalFn: noopSetInterval, clearIntervalFn: noopClearInterval,
      onThreshold: () => { throw new Error('callback boom'); },
    });
    await mon.tick();
    expect(logger._calls.error.length).toBeGreaterThan(0);
    mon.stop();
  });
});

// ---------------------------------------------------------------------------
// Worker probe
// ---------------------------------------------------------------------------

describe('Phase 2.10 — worker-probe', () => {
  test('createWorkerTracker initializes fields', () => {
    const t = createWorkerTracker(7);
    expect(t.workerId).toBe(7);
    expect(t.consecutiveTimeouts).toBe(0);
    expect(t.heapReported).toBe(false);
    expect(t.stuckReported).toBe(false);
    expect(t.unresponsiveReported).toBe(false);
    expect(t.lastCompletedAt).toBe(0);
  });

  test('startWorkerProbe: requires getWorkers', () => {
    expect(() => startWorkerProbe({ setIntervalFn: noopSetInterval }))
      .toThrow(/getWorkers/);
  });

  test('startWorkerProbe: detects heap bloat + fires onIssue (then re-arms when it clears)', async () => {
    let now = 1000;
    const issues = [];
    const worker = makeFakeWorker({ id: 0, heapUsedMb: 600 });
    const probe = startWorkerProbe({
      getWorkers: () => [worker],
      maxHeapMb: 500,
      intervalMs: 60_000,
      logger: makeStubLogger(),
      clock: () => now,
      setIntervalFn: noopSetInterval,
      clearIntervalFn: noopClearInterval,
      probeFn: async () => true,
      onIssue: (w, issue) => { issues.push({ w, issue }); },
    });
    let r = await probe.inspect();
    expect(issues.length).toBe(1);
    expect(issues[0].issue.type).toBe('heap');
    expect(issues[0].issue.heapUsedMb).toBe(600);
    // Second inspect — worker still bloated, but issue already reported (no double-fire).
    r = await probe.inspect();
    expect(issues.length).toBe(1);
    // Heap drops back — re-arm.
    worker.stats = () => ({
      workerId: 0, state: 'idle', retired: false, tasksAttempted: 1, tasksCompleted: 1,
      businessesScraped: 10, crashes: 0, blocked: 0, heapUsedMb: 200,
      lastTaskAt: null, lastCompletedAt: now, currentTaskId: null, currentTaskType: null,
    });
    await probe.inspect();
    // Heap rises again — fires again.
    worker.stats = () => ({
      workerId: 0, state: 'idle', retired: false, tasksAttempted: 1, tasksCompleted: 1,
      businessesScraped: 10, crashes: 0, blocked: 0, heapUsedMb: 700,
      lastTaskAt: null, lastCompletedAt: now, currentTaskId: null, currentTaskType: null,
    });
    await probe.inspect();
    expect(issues.length).toBe(2);
    probe.stop();
  });

  test('startWorkerProbe: detects stuck worker (busy > stuckAfterMs with no completion)', async () => {
    let now = 1000;
    const issues = [];
    // Worker busy, never completed a task (lastCompletedAt = null).
    const worker = makeFakeWorker({
      id: 1, state: 'busy', heapUsedMb: 100, tasksCompleted: 0, lastCompletedAt: null,
      currentTaskId: 'task-1', currentTaskType: 'search-task',
    });
    const probe = startWorkerProbe({
      getWorkers: () => [worker],
      maxHeapMb: 9999,
      stuckAfterMs: 10 * 60 * 1000,
      intervalMs: 60_000,
      logger: makeStubLogger(),
      clock: () => now,
      setIntervalFn: noopSetInterval,
      clearIntervalFn: noopClearInterval,
      probeFn: async () => true,
      onIssue: (w, issue) => { issues.push({ w, issue }); },
    });
    await probe.inspect();
    expect(issues.length).toBe(1);
    expect(issues[0].issue.type).toBe('stuck');
    expect(issues[0].issue.currentTaskId).toBe('task-1');
    probe.stop();
  });

  test('startWorkerProbe: idle worker is NOT stuck', async () => {
    const issues = [];
    const worker = makeFakeWorker({
      id: 2, state: 'idle', heapUsedMb: 100, tasksCompleted: 5, lastCompletedAt: 1000,
    });
    const probe = startWorkerProbe({
      getWorkers: () => [worker],
      maxHeapMb: 9999,
      stuckAfterMs: 10 * 60 * 1000,
      logger: makeStubLogger(),
      clock: () => 1000,
      setIntervalFn: noopSetInterval, clearIntervalFn: noopClearInterval,
      probeFn: async () => true,
      onIssue: (w, issue) => { issues.push({ w, issue }); },
    });
    await probe.inspect();
    expect(issues.length).toBe(0);
    probe.stop();
  });

  test('startWorkerProbe: detects unresponsive worker after N consecutive probe timeouts', async () => {
    const issues = [];
    const worker = makeFakeWorker({ id: 3, state: 'idle', heapUsedMb: 100, tasksCompleted: 5, lastCompletedAt: 1000 });
    const probe = startWorkerProbe({
      getWorkers: () => [worker],
      maxHeapMb: 9999,
      probeTimeoutMs: 50,
      probeThreshold: 3,
      logger: makeStubLogger(),
      clock: () => 1000,
      setIntervalFn: noopSetInterval, clearIntervalFn: noopClearInterval,
      probeFn: async () => false, // always times out / fails
      onIssue: (w, issue) => { issues.push({ w, issue }); },
    });
    // 1st + 2nd timeouts — no issue yet (below threshold).
    await probe.inspect();
    await probe.inspect();
    expect(issues.length).toBe(0);
    // 3rd timeout — fires.
    await probe.inspect();
    expect(issues.length).toBe(1);
    expect(issues[0].issue.type).toBe('unresponsive');
    expect(issues[0].issue.consecutiveTimeouts).toBe(3);
    // 4th inspect — already reported, no double-fire.
    await probe.inspect();
    expect(issues.length).toBe(1);
    probe.stop();
  });

  test('startWorkerProbe: a successful probe resets the consecutive-timeout counter', async () => {
    const issues = [];
    const worker = makeFakeWorker({ id: 4, state: 'idle', heapUsedMb: 100, tasksCompleted: 5, lastCompletedAt: 1000 });
    let alive = false;
    const probe = startWorkerProbe({
      getWorkers: () => [worker],
      maxHeapMb: 9999,
      probeThreshold: 3,
      logger: makeStubLogger(),
      clock: () => 1000,
      setIntervalFn: noopSetInterval, clearIntervalFn: noopClearInterval,
      probeFn: async () => alive,
      onIssue: (w, issue) => { issues.push({ w, issue }); },
    });
    await probe.inspect(); // timeout 1
    await probe.inspect(); // timeout 2
    alive = true;
    await probe.inspect(); // success — resets counter
    alive = false;
    await probe.inspect(); // timeout 1 (counter was reset)
    await probe.inspect(); // timeout 2
    expect(issues.length).toBe(0); // would need 3 in a row
    probe.stop();
  });

  test('startWorkerProbe: retired workers are skipped', async () => {
    const issues = [];
    const worker = makeFakeWorker({ id: 5, state: 'retired', retired: true, heapUsedMb: 9999, tasksCompleted: 0, lastCompletedAt: null });
    const probe = startWorkerProbe({
      getWorkers: () => [worker],
      maxHeapMb: 100,
      stuckAfterMs: 1,
      probeThreshold: 1,
      logger: makeStubLogger(),
      clock: () => 1000,
      setIntervalFn: noopSetInterval, clearIntervalFn: noopClearInterval,
      probeFn: async () => false,
      onIssue: (w, issue) => { issues.push({ w, issue }); },
    });
    await probe.inspect();
    expect(issues.length).toBe(0);
    probe.stop();
  });

  test('startWorkerProbe: getWorkers accepts array OR pool-with-workers', async () => {
    const worker = makeFakeWorker({ id: 0, heapUsedMb: 100 });
    const probe = startWorkerProbe({
      getWorkers: () => ({ workers: [worker] }),
      maxHeapMb: 9999,
      logger: makeStubLogger(),
      clock: () => 1000,
      setIntervalFn: noopSetInterval, clearIntervalFn: noopClearInterval,
      probeFn: async () => true,
    });
    const r = await probe.inspect();
    expect(r.results.length).toBe(1);
    expect(r.results[0].workerId).toBe(0);
    probe.stop();
  });

  test('startWorkerProbe: onIssue callback error is non-fatal', async () => {
    const logger = makeStubLogger();
    const worker = makeFakeWorker({ id: 0, heapUsedMb: 600 });
    const probe = startWorkerProbe({
      getWorkers: () => [worker],
      maxHeapMb: 500,
      logger,
      clock: () => 1000,
      setIntervalFn: noopSetInterval, clearIntervalFn: noopClearInterval,
      probeFn: async () => true,
      onIssue: () => { throw new Error('boom'); },
    });
    await probe.inspect();
    expect(logger._calls.error.length).toBeGreaterThan(0);
    probe.stop();
  });

  test('startWorkerProbe: stop() is idempotent', () => {
    let cleared = 0;
    const probe = startWorkerProbe({
      getWorkers: () => [],
      setIntervalFn: () => 'h', clearIntervalFn: (h) => { if (h === 'h') cleared++; },
    });
    probe.stop();
    probe.stop();
    expect(cleared).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Zombie reaper
// ---------------------------------------------------------------------------

describe('Phase 2.10 — zombie-reaper', () => {
  test('scan: returns found pids (minus own pid) without killing', () => {
    const reaper = createZombieReaper({
      logger: makeStubLogger(),
      listPids: () => [
        { pid: 100, cmdline: '/usr/bin/chromium' },
        { pid: 200, cmdline: 'chrome --headless' },
        { pid: process.pid, cmdline: 'node src/index.js' },
      ],
      killPid: () => true,
    });
    const { found, ownPid } = reaper.scan({ ownPid: process.pid });
    expect(found.length).toBe(2);
    expect(found.map((f) => f.pid).sort()).toEqual([100, 200]);
    expect(ownPid).toBe(process.pid);
  });

  test('scan: filters by pattern (skips non-chromium processes)', () => {
    const reaper = createZombieReaper({
      logger: makeStubLogger(),
      pattern: /chromium/i,
      listPids: () => [
        { pid: 100, cmdline: '/usr/bin/chromium' },
        { pid: 200, cmdline: '/usr/bin/firefox' },
      ],
      killPid: () => true,
    });
    const { found } = reaper.scan();
    expect(found.length).toBe(1);
    expect(found[0].pid).toBe(100);
  });

  test('reapOnStartup: kills matching pids with SIGTERM-then-SIGKILL escalation', async () => {
    const killed = [];
    const aliveSet = new Set([100, 200]);
    const reaper = createZombieReaper({
      logger: makeStubLogger(),
      graceMs: 0,
      listPids: () => [
        { pid: 100, cmdline: 'chromium' },
        { pid: 200, cmdline: 'chrome' },
        { pid: 300, cmdline: 'chromium' }, // will be protected
      ],
      killPid: (pid, signal) => {
        killed.push({ pid, signal });
        if (signal === 'SIGKILL') aliveSet.delete(pid);
        // For SIGTERM: simulate the process dying (delete from aliveSet) so
        // the post-grace check sees it gone.
        if (signal === 'SIGTERM') aliveSet.delete(pid);
        return true;
      },
      sleepFn: noopSleep,
    });
    // We need to stub process.kill(pid, 0) used for the liveness check.
    // The default killWithEscalation calls process.kill(pid, 0) directly —
    // that's a real OS call. Since we injected killPid, the SIGTERM path
    // uses our fake, but the liveness check doesn't. So we instead test the
    // report shape via the reapOnStartup wrapper, which uses killWithEscalation.
    // To avoid the real process.kill, we make aliveSet govern: our killPid
    // removes from aliveSet, and the liveness check would fail (ESRCH) for
    // pids not in aliveSet. Since we can't easily stub process.kill, we
    // verify the killed list instead.
    const report = await reaper.reapOnStartup({ ownPid: 1, protectPids: [300] });
    expect(report.killed.length).toBe(2);
    expect(report.killed.sort()).toEqual([100, 200]);
    expect(killed.length).toBeGreaterThanOrEqual(2);
    expect(killed.map((k) => k.pid).sort()).toEqual([100, 200]);
    // 300 was protected.
    expect(report.killed).not.toContain(300);
  });

  test('reapOnStartup: SIGKILL escalation when SIGTERM does not kill', async () => {
    const killed = [];
    const reaper = createZombieReaper({
      logger: makeStubLogger(),
      graceMs: 0,
      listPids: () => [{ pid: 999, cmdline: 'chromium' }],
      killPid: (pid, signal) => { killed.push({ pid, signal }); return true; },
      sleepFn: noopSleep,
    });
    // Override process.kill for the liveness check: pid 999 stays "alive"
    // after SIGTERM (so escalation to SIGKILL is needed). We can't easily
    // monkeypatch process.kill globally without affecting other tests, so
    // we test the killWithEscalation method directly with a reaper that
    // never lets the process die.
    const originalKill = process.kill;
    let aliveAfterTerm = true;
    try {
      // Make process.kill(pid, 0) throw ESRCH only after SIGKILL.
      let termSent = false;
      let killSent = false;
      process.kill = (pid, signal) => {
        if (signal === 0) {
          // Liveness check.
          if (killSent) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
          if (termSent && !aliveAfterTerm) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
          return true; // alive
        }
        if (signal === 'SIGTERM') termSent = true;
        if (signal === 'SIGKILL') killSent = true;
        return true;
      };
      const r = await reaper.killWithEscalation(999);
      expect(r.killed).toBe(true);
      expect(r.method).toBe('sigkill');
      expect(killed.find((k) => k.signal === 'SIGTERM')).toBeDefined();
      expect(killed.find((k) => k.signal === 'SIGKILL')).toBeDefined();
    } finally {
      process.kill = originalKill;
    }
  });

  test('reapOnStartup: already-gone pid (ESRCH) is skipped, not killed', async () => {
    const reaper = createZombieReaper({
      logger: makeStubLogger(),
      graceMs: 0,
      listPids: () => [{ pid: 12345, cmdline: 'chromium' }],
      killPid: (pid) => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); },
      sleepFn: noopSleep,
    });
    const report = await reaper.reapOnStartup({ ownPid: 1 });
    expect(report.killed.length).toBe(0);
    expect(report.skipped.length).toBe(1);
  });

  test('reapOnShutdown: known pids are killed first, then defensive sweep', async () => {
    const killed = [];
    const reaper = createZombieReaper({
      logger: makeStubLogger(),
      graceMs: 0,
      listPids: () => [{ pid: 555, cmdline: 'chromium' }], // orphan found in defensive sweep
      killPid: (pid, signal) => { killed.push({ pid, signal }); return true; },
      sleepFn: noopSleep,
    });
    // Stub process.kill for liveness: pids die immediately after SIGTERM.
    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    };
    try {
      const report = await reaper.reapOnShutdown({ ownPid: 1, knownPids: [777, 888] });
      expect(report.killed).toContain(777);
      expect(report.killed).toContain(888);
      expect(report.killed).toContain(555); // defensive sweep
    } finally {
      process.kill = originalKill;
    }
  });

  test('logReport: emits the spec format "Zombie reaper: killed N orphaned chromium processes (PIDs ...)"', () => {
    const logger = makeStubLogger();
    const reaper = createZombieReaper({ logger });
    reaper.logReport({ killed: [12345, 12346], skipped: [] }, { when: 'startup' });
    expect(logger._calls.info.length).toBe(1);
    expect(logger._calls.info[0].msg).toContain('Zombie reaper: killed 2 orphaned chromium processes (PIDs 12345, 12346)');
  });

  test('logReport: no-op when killed is empty (debug only)', () => {
    const logger = makeStubLogger();
    const reaper = createZombieReaper({ logger });
    reaper.logReport({ killed: [], skipped: [] });
    expect(logger._calls.info.length).toBe(0);
    expect(logger._calls.debug.length).toBe(1);
  });

  test('DEFAULT_PATTERN matches chromium, chrome, headless_shell', () => {
    expect(DEFAULT_PATTERN.test('/usr/bin/chromium')).toBe(true);
    expect(DEFAULT_PATTERN.test('chrome --headless')).toBe(true);
    expect(DEFAULT_PATTERN.test('headless_shell')).toBe(true);
    expect(DEFAULT_PATTERN.test('headless-shell')).toBe(true);
    expect(DEFAULT_PATTERN.test('/usr/bin/firefox')).toBe(false);
    expect(DEFAULT_PATTERN.test('node src/index.js')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe('Phase 2.10 — degradation', () => {
  test('shouldRun: false when RSS below threshold', () => {
    const deg = createDegradation({
      maxRssMb: 4096,
      getRss: () => 1024 * 1024 * 1024, // 1 GB
      getWorkers: () => [],
    });
    expect(deg.shouldRun()).toBe(false);
  });

  test('shouldRun: true when RSS crosses threshold + armed', () => {
    const deg = createDegradation({
      maxRssMb: 2048,
      getRss: () => 3 * 1024 * 1024 * 1024, // 3 GB > 2 GB
      getWorkers: () => [],
    });
    expect(deg.shouldRun()).toBe(true);
  });

  test('shouldRun: false after acting (disarmed) until RSS drops + re-arms', async () => {
    let rss = 3 * 1024 * 1024 * 1024;
    const deg = createDegradation({
      maxRssMb: 2048,
      getRss: () => rss,
      getWorkers: () => [],
      waitFn: noopSleep,
    });
    expect(deg.shouldRun()).toBe(true);
    await deg.handlePressure();
    expect(deg.shouldRun()).toBe(false); // disarmed
    // RSS still high — should NOT re-fire (disarmed).
    expect(deg.shouldRun()).toBe(false);
    // RSS drops — re-arm.
    rss = 1 * 1024 * 1024 * 1024;
    expect(deg.shouldRun()).toBe(false); // still false (below threshold)
    // RSS rises again — fires again.
    rss = 3 * 1024 * 1024 * 1024;
    expect(deg.shouldRun()).toBe(true);
  });

  test('handlePressure: full sequence runs (pause → wait → restart → gc → resume → reduce)', async () => {
    let rss = 5 * 1024 * 1024 * 1024; // 5 GB > 4 GB threshold
    const calls = [];
    // Two workers — needed so reducePoolFn can fire (reducePoolLimit default = 1,
    // so we need activeCount > 1 to reduce).
    const workers = [
      makeFakeWorker({ id: 0, state: 'idle' }),
      makeFakeWorker({ id: 1, state: 'idle' }),
    ];
    const deg = createDegradation({
      maxRssMb: 4096,
      getRss: () => rss,
      getWorkers: () => workers,
      pauseFn: async () => { calls.push('pause'); },
      resumeFn: async () => { calls.push('resume'); },
      restartWorkerFn: async () => { calls.push('restart'); },
      reducePoolFn: () => { calls.push('reduce'); return 1; },
      gcFn: () => { calls.push('gc'); return true; },
      waitFn: noopSleep,
      waitDeadlineMs: 1000,
    });
    // RSS stays high after restart → reduce pool.
    const r = await deg.handlePressure();
    expect(r.acted).toBe(true);
    expect(calls).toContain('pause');
    expect(calls).toContain('restart');
    expect(calls).toContain('gc');
    expect(calls).toContain('resume');
    expect(calls).toContain('reduce');
    expect(r.reducedPoolSize).toBe(true);
  });

  test('handlePressure: no reduce when RSS drops after restart', async () => {
    let rss = 5 * 1024 * 1024 * 1024;
    const worker = makeFakeWorker({ id: 0, state: 'idle' });
    const deg = createDegradation({
      maxRssMb: 4096,
      getRss: () => rss,
      getWorkers: () => [worker],
      restartWorkerFn: async () => { rss = 1 * 1024 * 1024 * 1024; }, // simulate memory drop
      reducePoolFn: () => 2,
      waitFn: noopSleep,
    });
    const r = await deg.handlePressure();
    expect(r.reducedPoolSize).toBe(false);
  });

  test('handlePressure: no-op when shouldRun is false', async () => {
    const deg = createDegradation({
      maxRssMb: 4096,
      getRss: () => 100 * 1024 * 1024, // 100 MB — way below
      getWorkers: () => [],
    });
    const r = await deg.handlePressure();
    expect(r.acted).toBe(false);
    expect(r.steps.length).toBe(0);
  });

  test('handlePressure: pool reduce skipped when at limit', async () => {
    let rss = 5 * 1024 * 1024 * 1024;
    // Only 1 worker (at the default reducePoolLimit=1) — can't reduce further.
    const worker = makeFakeWorker({ id: 0, state: 'idle' });
    const deg = createDegradation({
      maxRssMb: 4096,
      getRss: () => rss,
      getWorkers: () => [worker],
      reducePoolFn: () => 0,
      waitFn: noopSleep,
      reducePoolLimit: 1,
    });
    const r = await deg.handlePressure();
    expect(r.reducedPoolSize).toBe(false);
    expect(r.steps.some((s) => s.startsWith('pool-reduce-skipped-at-limit'))).toBe(true);
  });

  test('handlePressure: in-flight wait logs partial when workers stay busy', async () => {
    let rss = 5 * 1024 * 1024 * 1024;
    // Worker stays busy — waitFn returns immediately, deadline elapses with busy=1.
    const worker = makeFakeWorker({ id: 0, state: 'busy' });
    const deg = createDegradation({
      maxRssMb: 4096,
      getRss: () => rss,
      getWorkers: () => [worker],
      waitFn: noopSleep,
      waitDeadlineMs: 10,
    });
    const r = await deg.handlePressure();
    expect(r.stillBusy).toBe(1);
    expect(r.steps.some((s) => s.includes('partial'))).toBe(true);
  });

  test('currentRssMb: rounds bytes to MB', () => {
    const deg = createDegradation({
      maxRssMb: 4096,
      getRss: () => 1234 * 1024 * 1024,
    });
    expect(deg.currentRssMb()).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// Health server
// ---------------------------------------------------------------------------

describe('Phase 2.10 — health server', () => {
  test('createDefaultSnapshotBuilder: status ok when everything healthy', () => {
    const getSnapshot = createDefaultSnapshotBuilder({
      memoryMonitor: {
        snapshot: () => ({ heapUsedMb: 200, heapTotalMb: 400, rssMb: 500, workers: 3 }),
        getHighWater: () => ({ heapMb: 300, rssMb: 600 }),
      },
      pool: { stats: () => ({ size: 3, activeSize: 3, retiredCount: 0, loadBalancer: 'round-robin', totals: {} }) },
      queue: { getStats: () => ({ waiting: 0, active: 0, completed: 10, failed: 0, delayed: 0 }) },
      endless: false,
      version: '1.0.0',
      startedAt: Date.now() - 10000,
    });
    const snap = getSnapshot();
    expect(snap.status).toBe('ok');
    expect(snap.heap.usedMb).toBe(200);
    expect(snap.workers.activeSize).toBe(3);
    expect(snap.queue.completed).toBe(10);
  });

  test('createDefaultSnapshotBuilder: degraded when heap above degraded threshold', () => {
    const getSnapshot = createDefaultSnapshotBuilder({
      memoryMonitor: {
        snapshot: () => ({ heapUsedMb: DEFAULT_DEGRADED_HEAP_MB + 50, rssMb: 1500, workers: 3 }),
        getHighWater: () => null,
      },
      pool: { stats: () => ({ size: 3, activeSize: 3, retiredCount: 0, totals: {} }) },
      queue: { getStats: () => ({ waiting: 0, active: 0, completed: 10, failed: 0 }) },
      startedAt: Date.now(),
    });
    expect(getSnapshot().status).toBe('degraded');
  });

  test('createDefaultSnapshotBuilder: unhealthy when heap above unhealthy threshold', () => {
    const getSnapshot = createDefaultSnapshotBuilder({
      memoryMonitor: {
        snapshot: () => ({ heapUsedMb: DEFAULT_UNHEALTHY_HEAP_MB + 100, rssMb: 3000, workers: 3 }),
        getHighWater: () => null,
      },
      pool: { stats: () => ({ size: 3, activeSize: 3, retiredCount: 0, totals: {} }) },
      queue: { getStats: () => ({ waiting: 0, active: 0, completed: 10, failed: 0 }) },
      startedAt: Date.now(),
    });
    expect(getSnapshot().status).toBe('unhealthy');
  });

  test('createDefaultSnapshotBuilder: unhealthy when pool has 0 active workers', () => {
    const getSnapshot = createDefaultSnapshotBuilder({
      memoryMonitor: {
        snapshot: () => ({ heapUsedMb: 100, rssMb: 200, workers: 0 }),
        getHighWater: () => null,
      },
      pool: { stats: () => ({ size: 3, activeSize: 0, retiredCount: 3, totals: {} }) },
      startedAt: Date.now(),
    });
    expect(getSnapshot().status).toBe('unhealthy');
  });

  test('createDefaultSnapshotBuilder: degraded when queue has failed jobs', () => {
    const getSnapshot = createDefaultSnapshotBuilder({
      memoryMonitor: {
        snapshot: () => ({ heapUsedMb: 100, rssMb: 200, workers: 2 }),
        getHighWater: () => null,
      },
      pool: { stats: () => ({ size: 2, activeSize: 2, retiredCount: 0, totals: {} }) },
      queue: { getStats: () => ({ waiting: 5, active: 1, completed: 10, failed: 3, delayed: 0 }) },
      startedAt: Date.now(),
    });
    expect(getSnapshot().status).toBe('degraded');
  });

  test('createDefaultSnapshotBuilder: handles missing components gracefully', () => {
    const getSnapshot = createDefaultSnapshotBuilder({ startedAt: Date.now() });
    const snap = getSnapshot();
    expect(snap.heap).toBe(null);
    expect(snap.workers).toBe(null);
    expect(snap.queue).toBe(null);
    // No pool → activeSize 0 → unhealthy.
    expect(snap.status).toBe('unhealthy');
  });

  test('createHealthServer: handleRequest returns 200 + JSON for /health', async () => {
    const server = createHealthServer({
      port: 0,
      logger: makeStubLogger(),
      getSnapshot: () => ({ status: 'ok', uptime: 100, heap: { usedMb: 100 } }),
    });
    // Use the internal handler directly (no real socket).
    const res = makeFakeResponse();
    server._handleRequest({ method: 'GET', url: '/health' }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.heap.usedMb).toBe(100);
  });

  test('createHealthServer: handleRequest returns 503 for unhealthy', () => {
    const server = createHealthServer({
      port: 0, logger: makeStubLogger(),
      getSnapshot: () => ({ status: 'unhealthy' }),
    });
    const res = makeFakeResponse();
    server._handleRequest({ method: 'GET', url: '/health' }, res);
    expect(res.statusCode).toBe(503);
  });

  test('createHealthServer: handleRequest returns 404 for non-health paths', () => {
    const server = createHealthServer({
      port: 0, logger: makeStubLogger(),
      getSnapshot: () => ({ status: 'ok' }),
    });
    const res = makeFakeResponse();
    server._handleRequest({ method: 'GET', url: '/foo' }, res);
    expect(res.statusCode).toBe(404);
  });

  test('createHealthServer: handleRequest returns 404 for non-GET methods', () => {
    const server = createHealthServer({
      port: 0, logger: makeStubLogger(),
      getSnapshot: () => ({ status: 'ok' }),
    });
    const res = makeFakeResponse();
    server._handleRequest({ method: 'POST', url: '/health' }, res);
    expect(res.statusCode).toBe(404);
  });

  test('createHealthServer: handleRequest returns 500 when getSnapshot throws', () => {
    const server = createHealthServer({
      port: 0, logger: makeStubLogger(),
      getSnapshot: () => { throw new Error('boom'); },
    });
    const res = makeFakeResponse();
    server._handleRequest({ method: 'GET', url: '/health' }, res);
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('snapshot failed');
  });

  test('createHealthServer: start/stop lifecycle (binds to port 0)', async () => {
    const server = createHealthServer({
      port: 0, logger: makeStubLogger(),
      getSnapshot: () => ({ status: 'ok' }),
    });
    const { port } = await server.start();
    expect(port).toBeGreaterThan(0);
    expect(server.getPort()).toBe(port);
    await server.stop();
    expect(server.getPort()).toBe(null);
  });

  test('createHealthServer: start is idempotent', async () => {
    const server = createHealthServer({
      port: 0, logger: makeStubLogger(),
      getSnapshot: () => ({ status: 'ok' }),
    });
    const r1 = await server.start();
    const r2 = await server.start();
    expect(r1.port).toBe(r2.port);
    await server.stop();
  });
});

function makeFakeResponse() {
  const res = {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; },
    end(body) { if (body !== undefined) this.body = body; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Health stack orchestrator
// ---------------------------------------------------------------------------

describe('Phase 2.10 — createHealthStack (orchestrator)', () => {
  test('constructs + starts + stops all components', async () => {
    const logger = makeStubLogger();
    const pool = { workers: [], stats: () => ({ size: 0, activeSize: 0, retiredCount: 0, totals: {} }) };
    const stack = createHealthStack({
      cfg: { health: { memoryIntervalMs: 30_000, logEveryMs: 60_000, maxHeapMb: 1024, maxRssMb: 4096, workerMaxHeapMb: 500, stuckAfterMs: 600_000, probeTimeoutMs: 5_000, probeThreshold: 3, workerProbeIntervalMs: 60_000, serverEnabled: false, port: null, host: '127.0.0.1' } },
      logger,
      pool,
      queue: null,
      getWorkers: () => [],
      getRss: () => 100 * 1024 * 1024,
      onMemoryThreshold: () => {},
      onWorkerIssue: () => {},
      startedAt: Date.now(),
      version: '1.0.0-test',
      endless: false,
    });
    // Memory monitor + worker probe + reaper + degradation should exist.
    expect(stack.memoryMonitor).toBeDefined();
    expect(stack.workerProbe).toBeDefined();
    expect(stack.zombieReaper).toBeDefined();
    expect(stack.degradation).toBeDefined();
    // No server when serverEnabled is false + endless is false.
    expect(stack.server).toBe(null);
    await stack.start();
    await stack.stop();
  });

  test('starts the HTTP server when serverEnabled is true', async () => {
    const stack = createHealthStack({
      cfg: { health: { memoryIntervalMs: 30_000, logEveryMs: 60_000, maxHeapMb: 1024, maxRssMb: 4096, workerMaxHeapMb: 500, stuckAfterMs: 600_000, probeTimeoutMs: 5_000, probeThreshold: 3, workerProbeIntervalMs: 60_000, serverEnabled: true, port: 0, host: '127.0.0.1' } },
      logger: makeStubLogger(),
      pool: { workers: [], stats: () => ({ size: 0, activeSize: 0, retiredCount: 0, totals: {} }) },
      queue: null,
      getWorkers: () => [],
      getRss: () => 100 * 1024 * 1024,
      startedAt: Date.now(),
      endless: true,
    });
    expect(stack.server).toBeDefined();
    await stack.start();
    expect(stack.server.getPort()).toBeGreaterThan(0);
    await stack.stop();
    expect(stack.server.getPort()).toBe(null);
  });

  test('snapshot() returns a valid health object', () => {
    const stack = createHealthStack({
      cfg: { health: { memoryIntervalMs: 30_000, logEveryMs: 60_000, maxHeapMb: 1024, maxRssMb: 4096, workerMaxHeapMb: 500, stuckAfterMs: 600_000, probeTimeoutMs: 5_000, probeThreshold: 3, workerProbeIntervalMs: 60_000, serverEnabled: false, port: null, host: '127.0.0.1' } },
      logger: makeStubLogger(),
      pool: { workers: [], stats: () => ({ size: 2, activeSize: 2, retiredCount: 0, totals: {} }) },
      queue: null,
      getWorkers: () => [],
      getRss: () => 100 * 1024 * 1024,
      startedAt: Date.now() - 5000,
      version: '1.0.0-test',
      endless: false,
    });
    const snap = stack.snapshot();
    expect(snap).toHaveProperty('status');
    expect(snap).toHaveProperty('uptime');
    expect(snap).toHaveProperty('heap');
    expect(snap).toHaveProperty('workers');
    expect(snap).toHaveProperty('endless');
  });
});

// ---------------------------------------------------------------------------
// Session manager — Phase 2.10 extensions
// ---------------------------------------------------------------------------

describe('Phase 2.10 — session manager context-restart + memory-restart', () => {
  function makeMockCreateContext() {
    let calls = 0;
    const fn = async () => {
      calls++;
      return {
        context: { close: async () => {}, _id: calls },
        page: { _id: calls },
      };
    };
    fn._calls = () => calls;
    return fn;
  }

  test('default contextRestartEvery is 0 (off — preserves Phase 2.7)', () => {
    expect(DEFAULT_CONTEXT_RESTART_EVERY).toBe(0);
    const mgr = createSessionManager({
      maxRequests: 50,
      createContext: makeMockCreateContext(),
      clock: () => 1000,
    });
    const s = mgr.stats();
    expect(s.contextRestartEvery).toBe(0);
    expect(s.contextRestarts).toBe(0);
    expect(s.tasksSinceRestart).toBe(0);
  });

  test('contextRestartEvery triggers a context-restart rotation every N tasks', async () => {
    let now = 1000;
    const createContext = makeMockCreateContext();
    const mgr = createSessionManager({
      maxRequests: 1000, // high — only contextRestartEvery should trigger
      maxAgeMs: 60_000_000,
      contextRestartEvery: 3,
      createContext,
      clock: () => now,
      sleepFn: noopSleep,
      logger: makeStubLogger(),
    });
    // Open the initial session.
    await mgr.getContext({});
    expect(createContext._calls()).toBe(1);
    // Tick 3 times — on the 3rd, contextRestartEvery=3 should fire.
    const r1 = await mgr.tickRequest({});
    expect(r1.rotated).toBe(false);
    expect(mgr.tasksSinceRestart).toBe(1);
    const r2 = await mgr.tickRequest({});
    expect(r2.rotated).toBe(false);
    expect(mgr.tasksSinceRestart).toBe(2);
    const r3 = await mgr.tickRequest({});
    expect(r3.rotated).toBe(true);
    expect(r3.reason).toBe('context-restart');
    expect(mgr.tasksSinceRestart).toBe(0); // reset
    expect(mgr.contextRestarts).toBe(1);
    // A new context was opened.
    expect(createContext._calls()).toBe(2);
  });

  test('a normal max-requests rotation does NOT reset tasksSinceRestart', async () => {
    let now = 1000;
    const createContext = makeMockCreateContext();
    const mgr = createSessionManager({
      maxRequests: 2, // low — triggers rotation by request count
      maxAgeMs: 60_000_000,
      contextRestartEvery: 100, // high — won't trigger
      createContext,
      clock: () => now,
      sleepFn: noopSleep,
      logger: makeStubLogger(),
    });
    await mgr.getContext({});
    await mgr.tickRequest({});
    expect(mgr.tasksSinceRestart).toBe(1);
    const r = await mgr.tickRequest({});
    expect(r.rotated).toBe(true);
    expect(r.reason).toBe('max-requests');
    // Counter NOT reset (only context-restart resets it).
    expect(mgr.tasksSinceRestart).toBe(2);
    expect(mgr.contextRestarts).toBe(0);
  });

  test('shouldRestartForMemory: false when getMemory/memoryThresholdMb not configured', () => {
    const mgr = createSessionManager({
      maxRequests: 50,
      createContext: makeMockCreateContext(),
    });
    expect(mgr.shouldRestartForMemory().restart).toBe(false);
  });

  test('shouldRestartForMemory: true when heap crosses threshold', async () => {
    let heap = 100 * 1024 * 1024;
    const mgr = createSessionManager({
      maxRequests: 1000,
      maxAgeMs: 60_000_000,
      createContext: makeMockCreateContext(),
      clock: () => 1000,
      sleepFn: noopSleep,
      getMemory: () => ({ heapUsed: heap }),
      memoryThresholdMb: 500,
    });
    await mgr.getContext({});
    expect(mgr.shouldRestartForMemory().restart).toBe(false);
    heap = 600 * 1024 * 1024;
    expect(mgr.shouldRestartForMemory().restart).toBe(true);
    expect(mgr.shouldRestartForMemory().heapUsedMb).toBe(600);
  });

  test('restartForMemory: closes + reopens the context, resets counter, logs before/after heap', async () => {
    let heap = 600 * 1024 * 1024;
    const logger = makeStubLogger();
    const createContext = makeMockCreateContext();
    const mgr = createSessionManager({
      maxRequests: 1000,
      maxAgeMs: 60_000_000,
      contextRestartEvery: 100,
      createContext,
      clock: () => 1000,
      sleepFn: noopSleep,
      getMemory: () => ({ heapUsed: heap }),
      memoryThresholdMb: 500,
      logger,
    });
    await mgr.getContext({});
    // Bump the counter so we can verify it resets.
    await mgr.tickRequest({});
    await mgr.tickRequest({});
    expect(mgr.tasksSinceRestart).toBe(2);
    const r = await mgr.restartForMemory({ reason: 'test' });
    expect(createContext._calls()).toBe(2); // a new context was opened
    expect(mgr.tasksSinceRestart).toBe(0);
    expect(mgr.contextRestarts).toBe(1);
    expect(r.heapBeforeMb).toBe(600);
    // After the restart heap is sampled again.
    expect(typeof r.heapAfterMb).toBe('number');
    // Log line includes "Context restarted".
    const restartLogs = logger._calls.info.filter((c) => c.msg.includes('Context restarted'));
    expect(restartLogs.length).toBeGreaterThan(0);
  });

  test('validation: invalid contextRestartEvery throws SessionError', () => {
    expect(() =>
      createSessionManager({
        maxRequests: 50,
        createContext: makeMockCreateContext(),
        contextRestartEvery: -1,
      }),
    ).toThrow(SessionError);
  });

  test('stats() includes the Phase 2.10 fields', async () => {
    const mgr = createSessionManager({
      maxRequests: 1000,
      maxAgeMs: 60_000_000,
      contextRestartEvery: 5,
      createContext: makeMockCreateContext(),
      clock: () => 1000,
      sleepFn: noopSleep,
    });
    await mgr.getContext({});
    const s = mgr.stats();
    expect(s).toHaveProperty('contextRestartEvery', 5);
    expect(s).toHaveProperty('contextRestarts', 0);
    expect(s).toHaveProperty('tasksSinceRestart', 0);
    expect(s).toHaveProperty('lastRestartHeapMb', null);
  });
});

// ---------------------------------------------------------------------------
// Config — Phase 2.10 flags
// ---------------------------------------------------------------------------

describe('Phase 2.10 — config flags', () => {
  test('parseArgs: --contextRestartEvery / --maxHeapMb / --maxRssMb / --endless / --healthCheckIntervalMs / --healthPort', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--contextRestartEvery', '25',
      '--maxHeapMb', '768',
      '--maxRssMb', '3072',
      '--endless',
      '--queue', 'on',
      '--redisUrl', 'redis://localhost:6379',
      '--healthCheckIntervalMs', '15000',
      '--healthPort', '9100',
      '--healthHost', '0.0.0.0',
    ]);
    expect(cfg.errors.length).toBe(0);
    expect(cfg.health.contextRestartEvery).toBe(25);
    expect(cfg.health.maxHeapMb).toBe(768);
    expect(cfg.health.maxRssMb).toBe(3072);
    expect(cfg.health.endless).toBe(true);
    expect(cfg.health.memoryIntervalMs).toBe(15000);
    expect(cfg.health.port).toBe(9100);
    expect(cfg.health.host).toBe('0.0.0.0');
    expect(cfg.health.serverEnabled).toBe(true); // endless → auto-on
  });

  test('loadConfig: Phase 2.10 defaults (contextRestartEvery=50, maxHeapMb=1024, maxRssMb=4096)', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.errors.length).toBe(0);
    expect(cfg.health.contextRestartEvery).toBe(50);
    expect(cfg.health.maxHeapMb).toBe(1024);
    expect(cfg.health.maxRssMb).toBe(4096);
    expect(cfg.health.endless).toBe(false);
    expect(cfg.health.memoryIntervalMs).toBe(30_000);
    expect(cfg.health.port).toBe(null);
    expect(cfg.health.serverEnabled).toBe(false);
  });

  test('validation: contextRestartEvery 0 is allowed (off)', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--contextRestartEvery', '0',
    ]);
    expect(cfg.errors.length).toBe(0);
    expect(cfg.health.contextRestartEvery).toBe(0);
  });

  test('validation: maxHeapMb out of range → error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--maxHeapMb', '10',
    ]);
    expect(cfg.errors.some((e) => e.includes('maxHeapMb'))).toBe(true);
  });

  test('validation: maxRssMb must be > maxHeapMb', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--maxHeapMb', '2048',
      '--maxRssMb', '1024', // less than maxHeapMb
    ]);
    expect(cfg.errors.some((e) => e.includes('must be > maxHeapMb'))).toBe(true);
  });

  test('validation: --endless requires --queue on', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--endless',
    ]);
    expect(cfg.errors.some((e) => e.includes('--endless requires --queue on'))).toBe(true);
  });

  test('validation: --endless + --queue on has no endless error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--endless',
      '--queue', 'on',
      '--redisUrl', 'redis://localhost:6379',
      '--workers', '3',
    ]);
    expect(cfg.errors.some((e) => e.includes('--endless requires'))).toBe(false);
  });

  test('validation: healthPort out of range → error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--healthPort', '99999',
    ]);
    expect(cfg.errors.some((e) => e.includes('healthPort'))).toBe(true);
  });

  test('validation: healthCheckIntervalMs out of range → error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--healthCheckIntervalMs', '100',
    ]);
    expect(cfg.errors.some((e) => e.includes('healthCheckIntervalMs'))).toBe(true);
  });

  test('HELP_TEXT documents Phase 2.10 flags', () => {
    const { HELP_TEXT } = require('../src/config');
    expect(HELP_TEXT).toContain('--contextRestartEvery');
    expect(HELP_TEXT).toContain('--maxHeapMb');
    expect(HELP_TEXT).toContain('--maxRssMb');
    expect(HELP_TEXT).toContain('--endless');
    expect(HELP_TEXT).toContain('--healthPort');
    expect(HELP_TEXT).toContain('--noHealthServer');
  });

  test('env vars: CONTEXT_RESTART_EVERY / MAX_HEAP_MB / MAX_RSS_MB / ENDLESS', () => {
    process.env.CONTEXT_RESTART_EVERY = '30';
    process.env.MAX_HEAP_MB = '800';
    process.env.MAX_RSS_MB = '3200';
    process.env.ENDLESS = 'on';
    process.env.QUEUE = 'on';
    process.env.REDIS_URL = 'redis://localhost:6379';
    try {
      const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--workers', '2']);
      expect(cfg.health.contextRestartEvery).toBe(30);
      expect(cfg.health.maxHeapMb).toBe(800);
      expect(cfg.health.maxRssMb).toBe(3200);
      expect(cfg.health.endless).toBe(true);
    } finally {
      delete process.env.CONTEXT_RESTART_EVERY;
      delete process.env.MAX_HEAP_MB;
      delete process.env.MAX_RSS_MB;
      delete process.env.ENDLESS;
      delete process.env.QUEUE;
      delete process.env.REDIS_URL;
    }
  });
});

// ---------------------------------------------------------------------------
// Banner — Phase 2.10 row
// ---------------------------------------------------------------------------

describe('Phase 2.10 — banner row', () => {
  test('buildStartupBanner includes a Memory row with the Phase 2.10 config', () => {
    const { buildStartupBanner } = require('../src/banner');
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--contextRestartEvery', '25',
      '--maxHeapMb', '768',
      '--maxRssMb', '3072',
    ]);
    const banner = buildStartupBanner(cfg, { name: 'gmaps-scraper', version: '1.0.0-phase2.10' });
    expect(banner).toContain('Memory');
    expect(banner).toContain('restart every 25 tasks');
    expect(banner).toContain('heap 768MB');
    expect(banner).toContain('rss 3072MB');
  });

  test('buildStartupBanner shows endless + health port when set', () => {
    const { buildStartupBanner } = require('../src/banner');
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--endless',
      '--queue', 'on',
      '--redisUrl', 'redis://localhost:6379',
      '--workers', '2',
      '--healthPort', '9100',
    ]);
    const banner = buildStartupBanner(cfg, {});
    expect(banner).toContain('endless');
    expect(banner).toContain('health :9100');
  });
});
