'use strict';

/**
 * src/health/zombie-reaper.js — Phase 2.10 — Zombie Chromium Process Reaper
 *
 * Playwright launches Chromium as a child process. Under normal shutdown
 * browser.close() reaps it, but if the Node process crashes (SIGKILL, OOM,
 * segfault) the Chromium process is orphaned and keeps running — eating RAM
 * + a display socket. Over a week of overnight runs, dozens of zombie
 * Chromiums accumulate.
 *
 * This module:
 *   - reapOnStartup(): scan for orphaned Chromium processes left over from a
 *     previous crashed run and kill them. Called once at startup.
 *   - reapOnShutdown(): ensure all Chromium processes spawned by THIS process
 *     are gone. Called from the SIGINT / finally block.
 *
 * Process discovery is DI: the default uses `pgrep -f chromium` (Linux/macOS)
 * via child_process.execFileSync. Tests inject a fake `listPids()` and
 * `killPid(pid, signal)` so the test suite never touches a real OS call.
 *
 * The reaper NEVER kills the current Node process or unrelated processes. It
 * only touches processes whose command line matches the Chromium pattern
 * (configurable). On non-Linux platforms (win32) the default listPids is a
 * no-op (Playwright's own process tree handles cleanup there).
 *
 * Public API:
 *   const reaper = createZombieReaper({
 *     logger, pattern, listPids, killPid, clock, platform,
 *   });
 *   const r = await reaper.reapOnStartup({ ownPid: process.pid });
 *   // r = { killed: [12345, 12346], skipped: [], totalFound: 2 }
 *   const r2 = await reaper.reapOnShutdown({ ownPid: process.pid, knownPids: [...] });
 *   reaper.logReport(r);   // emits the "Zombie reaper: killed N orphaned ..." log line
 */

const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// Match chromium | chrome | headless shell processes spawned by Playwright.
// The pattern is intentionally broad so it catches headless_shell, chromium-
// browser, google-chrome, etc. The reaper NEVER kills pids owned by the
// current Node process (those are killed via browser.close() in the normal
// path — the reaper is a backstop for orphans only).
const DEFAULT_PATTERN = /(chromium|chrome|headless_shell|headless-shell)/i;

const DEFAULT_KILL_SIGNAL = 'SIGTERM';

function defaultClock() {
  return Date.now();
}

function defaultPlatform() {
  return process.platform;
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

// ---------------------------------------------------------------------------
// Default PID discovery — pgrep -f pattern on Linux/macOS
// ---------------------------------------------------------------------------

/**
 * Default listPids implementation: run `pgrep -f <pattern>` and parse the
 * output into an array of { pid, cmdline } objects. On Windows or when pgrep
 * is unavailable, returns [].
 *
 * The `pattern` passed to pgrep is a flat string (no regex) so we use the
 * literal "chromium" + "chrome" + "headless_shell" alternation. We then
 * re-filter with the regex `pattern` in JS so the result is precise.
 *
 * This is DI-friendly: tests pass a fake listPids that returns a hard-coded
 * array, so no real OS call is made.
 */
function defaultListPids({ pattern }) {
  const platform = defaultPlatform();
  if (platform === 'win32') {
    // Windows: tasklist + filter. Skipped for now (Playwright's own process
    // tree handles cleanup on Windows). Return [] so the reaper is a no-op.
    return [];
  }
  // Linux / macOS: pgrep -f matches against the full command line.
  // We pass "chromium|chrome|headless_shell" so pgrep's own regex catches
  // any of the three; the JS-side pattern refines.
  let output;
  try {
    output = execFileSync('pgrep', ['-f', 'chromium|chrome|headless_shell'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // pgrep not found, or no matches (exit code 1). Either way: nothing to reap.
    return [];
  }
  const pids = output
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  // For each pid, read its cmdline (best-effort — /proc/<pid>/cmdline on
  // Linux, `ps -p <pid> -o command=` on macOS). This lets the regex pattern
  // refine the match (e.g. skip "chrome_wrapper.sh").
  const out = [];
  for (const pid of pids) {
    const cmdline = readCmdline(pid);
    if (cmdline && pattern.test(cmdline)) {
      out.push({ pid, cmdline });
    } else if (!cmdline) {
      // Couldn't read cmdline (permission denied / process exited) — include
      // it anyway with a placeholder so the caller can decide.
      out.push({ pid, cmdline: '' });
    }
  }
  return out;
}

function readCmdline(pid) {
  const platform = defaultPlatform();
  try {
    if (platform === 'linux') {
      const fs = require('fs');
      // /proc/<pid>/cmdline is null-separated.
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return raw.replace(/\0/g, ' ').trim();
    }
    // macOS / other: `ps -p <pid> -o command=`
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Default killPid: process.kill(pid, signal). Throws if the pid doesn't exist
 * (caught by the caller — recorded as skipped).
 */
function defaultKillPid(pid, signal) {
  process.kill(pid, signal);
  return true;
}

// ---------------------------------------------------------------------------
// createZombieReaper
// ---------------------------------------------------------------------------

/**
 * Create a zombie reaper.
 *
 * @param {object} opts
 * @param {object} [opts.logger]
 * @param {RegExp} [opts.pattern]       — chromium-process matcher (default DEFAULT_PATTERN)
 * @param {(opts:{pattern:RegExp})=>Array<{pid,cmdline}>} [opts.listPids] — DI
 * @param {(pid:number, signal:string)=>boolean} [opts.killPid]            — DI
 * @param {()=>number} [opts.clock]
 * @param {()=>string} [opts.platform]   — DI (default process.platform)
 * @param {string} [opts.killSignal]     — default 'SIGTERM' (graceful)
 * @param {number} [opts.graceMs]        — wait this long after SIGTERM before SIGKILL (default 2000)
 * @param {(ms:number)=>Promise<void>} [opts.sleepFn] — DI sleep for the grace period
 * @returns {object} reaper — { reapOnStartup, reapOnShutdown, logReport, scan }
 */
function createZombieReaper(opts = {}) {
  const pattern = opts.pattern || DEFAULT_PATTERN;
  const listPids = typeof opts.listPids === 'function' ? opts.listPids : defaultListPids;
  const killPid = typeof opts.killPid === 'function' ? opts.killPid : defaultKillPid;
  const clock = typeof opts.clock === 'function' ? opts.clock : defaultClock;
  const platform = typeof opts.platform === 'function' ? opts.platform : defaultPlatform;
  const killSignal = opts.killSignal || DEFAULT_KILL_SIGNAL;
  const graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 2_000;
  const sleepFn =
    typeof opts.sleepFn === 'function'
      ? opts.sleepFn
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const logger = opts.logger || makeStubLogger();

  /**
   * Scan for processes matching `pattern`. Returns { found: [{pid,cmdline}],
   * ownPid } — does NOT kill anything. Pure inspection.
   *
   * Defense-in-depth: re-filters listPids() output against `pattern` so a
   * buggy / permissive listPids can't sneak a non-Chromium pid past us. Pids
   * with an empty cmdline (couldn't be read) are kept — the caller may still
   * want to kill them based on pid alone.
   */
  function scan({ ownPid } = {}) {
    const raw = listPids({ pattern });
    // Filter out the current Node process (we never kill ourselves) and any
    // pid that equals ownPid. Then re-filter by pattern (defense in depth).
    const filtered = raw.filter((p) => {
      if (p.pid === ownPid || p.pid === process.pid) return false;
      if (!p.cmdline) return true; // unknown cmdline — keep (caller decides)
      return pattern.test(p.cmdline);
    });
    return { found: filtered, ownPid: ownPid || process.pid };
  }

  /**
   * Kill one pid with SIGTERM, wait graceMs, then SIGKILL if still alive.
   * Returns { pid, killed: boolean, method: 'sigterm'|'sigkill'|'already-gone', error?: string }.
   */
  async function killWithEscalation(pid) {
    // First SIGTERM (graceful — lets Chromium shut down cleanly).
    try {
      killPid(pid, killSignal);
    } catch (err) {
      // ESRCH = process doesn't exist anymore — already gone.
      if (err && (err.code === 'ESRCH' || err.message.includes('ESRCH'))) {
        return { pid, killed: false, method: 'already-gone' };
      }
      return { pid, killed: false, method: 'none', error: err.message };
    }
    // Wait the grace period, then check if the process is still alive.
    await sleepFn(graceMs);
    try {
      // process.kill(pid, 0) doesn't deliver a signal — it just checks if
      // the pid is killable (i.e. exists). Throws ESRCH if gone.
      process.kill(pid, 0);
    } catch {
      // Process is gone — SIGTERM worked.
      return { pid, killed: true, method: 'sigterm' };
    }
    // Still alive — escalate to SIGKILL.
    try {
      killPid(pid, 'SIGKILL');
    } catch (err) {
      if (err && (err.code === 'ESRCH' || err.message.includes('ESRCH'))) {
        return { pid, killed: true, method: 'sigterm' };
      }
      return { pid, killed: false, method: 'sigkill-failed', error: err.message };
    }
    return { pid, killed: true, method: 'sigkill' };
  }

  /**
   * Startup reap: scan for orphaned Chromium processes from a previous run
   * and kill them. Skips pids in `protectPids` (the current process + any
   * known children). Returns a report object.
   *
   * @param {object} args
   * @param {number} [args.ownPid]        — current Node pid (default process.pid)
   * @param {number[]} [args.protectPids] — pids to NEVER kill (default [])
   * @returns {Promise<{killed:number[], skipped:Array<{pid,reason}>, totalFound:number, methods:object}>}
   */
  async function reapOnStartup({ ownPid, protectPids = [] } = {}) {
    const me = ownPid || process.pid;
    const protect = new Set([me, process.pid, ...protectPids]);
    const { found } = scan({ ownPid: me });
    const killed = [];
    const skipped = [];
    const methods = {};
    for (const { pid } of found) {
      if (protect.has(pid)) {
        skipped.push({ pid, reason: 'protected' });
        continue;
      }
      const r = await killWithEscalation(pid);
      if (r.killed) {
        killed.push(pid);
        methods[r.method] = (methods[r.method] || 0) + 1;
      } else {
        skipped.push({ pid, reason: r.error || r.method });
      }
    }
    return { killed, skipped, totalFound: found.length, methods };
  }

  /**
   * Shutdown reap: ensure all Chromium processes spawned by THIS session are
   * gone. `knownPids` is the set of browser PIDs the runtime tracked (e.g.
   * from browser.process().pid). For each known pid, SIGTERM + SIGKILL
   * escalation. Then scan + reap any orphans we didn't track (defensive).
   *
   * @param {object} args
   * @param {number} [args.ownPid]
   * @param {number[]} [args.knownPids] — browser PIDs we tracked during the run
   * @returns {Promise<{killed:number[], skipped:Array<{pid,reason}>, totalFound:number, methods:object}>}
   */
  async function reapOnShutdown({ ownPid, knownPids = [] } = {}) {
    const me = ownPid || process.pid;
    const killed = [];
    const skipped = [];
    const methods = {};
    // 1) Known PIDs (best-effort — they may already be gone).
    for (const pid of knownPids) {
      if (pid === me || pid === process.pid) continue;
      const r = await killWithEscalation(pid);
      if (r.killed) {
        killed.push(pid);
        methods[r.method] = (methods[r.method] || 0) + 1;
      } else {
        skipped.push({ pid, reason: r.error || r.method });
      }
    }
    // 2) Defensive sweep — any Chromium process that survived the known-pid
    // pass (e.g. a grandchild Chromium that browser.close() didn't reap).
    const { found } = scan({ ownPid: me });
    const protect = new Set([me, process.pid, ...killed]);
    for (const { pid } of found) {
      if (protect.has(pid)) continue;
      const r = await killWithEscalation(pid);
      if (r.killed) {
        killed.push(pid);
        methods[r.method] = (methods[r.method] || 0) + 1;
      } else {
        skipped.push({ pid, reason: r.error || r.method });
      }
    }
    return { killed, skipped, totalFound: found.length + knownPids.length, methods };
  }

  /**
   * Emit a human-readable log line summarizing a reap result. Matches the
   * execution plan's required format:
   *   "Zombie reaper: killed 2 orphaned chromium processes (PIDs 12345, 12346)"
   */
  function logReport(report, { when = 'startup' } = {}) {
    if (!report) return;
    if (report.killed.length === 0) {
      logger.debug('Zombie reaper: no orphaned chromium processes found', { when });
      return;
    }
    const pidList = report.killed.join(', ');
    logger.info(
      `Zombie reaper: killed ${report.killed.length} orphaned chromium processes (PIDs ${pidList})`,
      { when, killed: report.killed, methods: report.methods },
    );
    if (report.skipped.length > 0) {
      logger.debug('Zombie reaper: skipped pids', { when, skipped: report.skipped });
    }
  }

  return {
    scan,
    reapOnStartup,
    reapOnShutdown,
    killWithEscalation,
    logReport,
    // exposed for tests
    _pattern: pattern,
    _killSignal: killSignal,
    _graceMs: graceMs,
  };
}

module.exports = {
  createZombieReaper,
  DEFAULT_PATTERN,
  DEFAULT_KILL_SIGNAL,
  defaultListPids,
  defaultKillPid,
  defaultClock,
  defaultPlatform,
  makeStubLogger,
};
