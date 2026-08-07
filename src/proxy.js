'use strict';

/**
 * src/proxy.js — Phase 2.3 (Proxy Management & Rotation)
 *
 * A configurable proxy pool that sits between the scraper and Google. Every
 * browser launch (or every N requests, via --sessionLength) pulls a different
 * proxy from the pool. Burned proxies (3 consecutive 403/429, <50% success
 * rate, 3 consecutive timeouts) are benched for a cooldown window; permanently
 * bad proxies (HTTP 407, provider-reported retired) are removed entirely.
 *
 * Public API:
 *   createProxyPool({ sources, strategy, logger, ... }) → pool
 *   pool.acquire()                  → { url, server, username, password, id, provider, ... } | null
 *   pool.release(proxyId, outcome)  → void (records outcome, may trigger burn)
 *   pool.markBurned(proxyId, reason, { permanent }) → void
 *   pool.stats()                    → { total, healthy, burned, cooldown, avgSuccessRate, ... }
 *   pool.healthCheck({ fetchFn })   → async { healthy: string[], dead: string[] }
 *   pool.close()                    → flushes the burn log writer
 *
 * Rotation strategies (configurable via --proxyStrategy):
 *   - round-robin  cycle through the pool in insertion order
 *   - random       pick uniformly at random (DEFAULT — best load distribution)
 *   - sticky       same proxy per "session" of N requests (--sessionLength N)
 *
 * Sources:
 *   - file     read a proxy list from `sources.file` (one proxy per line)
 *   - list     inline array in `sources.list` (for tests / manual lists)
 *   - provider async function `sources.provider()` returning [{ url, ... }]
 *              (Bright Data / Smartproxy / Oxylabs — caller supplies the impl)
 *
 * Proxy list line formats (auto-detected):
 *   - protocol://[user:pass@]host:port   e.g. http://u:p@1.2.3.4:8080
 *   - host:port:user:pass                e.g. 1.2.3.4:8080:u:p
 *   - host:port                           (no auth — public proxy)
 *
 * Burn log:
 *   Every burn event is appended to `data/proxy_burn_log.jsonl` with timestamp,
 *   proxy id, reason, recent status codes, provider, and burn kind (cooldown vs
 *   permanent). Used for ops debugging + provider charge disputes.
 *
 * Design rules:
 *   - All clocks (`now`) and randomness (`rng`) are injectable → deterministic tests.
 *   - No real network in unit tests: provider fetch and healthCheck are DI'd in.
 *   - The pool is single-process; Phase 2.8 (worker pool) will shard it across
 *     workers via a shared Redis-backed pool. For now, in-process is enough.
 */

const fs = require('fs');
const path = require('path');

const { createBurnDetector } = require('./proxy/burn-detector');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const STRATEGIES = new Set(['round-robin', 'random', 'sticky']);
const DEFAULT_STRATEGY = 'random';
const DEFAULT_SESSION_LENGTH = 1; // rotate every request
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_BURN_LOG = path.join('data', 'proxy_burn_log.jsonl');
const DEFAULT_HEALTHCHECK_URL = 'https://www.google.com/robots.txt';
const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Proxy URL parsing (pure — exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse a single proxy line into a normalized descriptor.
 *
 * Accepted formats:
 *   - protocol://[user:pass@]host:port
 *   - host:port:user:pass
 *   - host:port
 *
 * @param {string} raw
 * @param {number} idx  position in the source list (used to build a stable id)
 * @returns {{id, server, url, username, password, host, port, protocol, provider, raw}|null}
 */
function parseProxyLine(raw, idx = 0) {
  if (!raw) return null;
  const line = String(raw).trim();
  if (!line || line.startsWith('#')) return null;

  let protocol = 'http';
  let username = null;
  let password = null;
  let host = null;
  let port = null;

  if (/^[a-z0-9]+:\/\//i.test(line)) {
    // protocol://[user:pass@]host:port
    try {
      const u = new URL(line);
      protocol = u.protocol.replace(/:$/, '').toLowerCase();
      if (u.username) username = decodeURIComponent(u.username);
      if (u.password) password = decodeURIComponent(u.password);
      host = u.hostname;
      port = u.port || null;
      // Node's URL strips default ports (80 for http, 443 for https, 1080 for
      // socks5). Restore them so the descriptor always has an explicit port.
      if (!port) {
        if (protocol === 'http') port = '80';
        else if (protocol === 'https') port = '443';
        else if (protocol === 'socks5' || protocol === 'socks4') port = '1080';
        else return null; // unknown protocol with no port — can't guess
      }
    } catch {
      return null;
    }
  } else {
    // host:port[:user:pass]
    const parts = line.split(':');
    if (parts.length < 2) return null;
    host = parts[0];
    port = parts[1];
    if (parts.length >= 4) {
      username = parts[2];
      password = parts[3];
    }
  }

  if (!host || !port) return null;
  const portNum = Number.parseInt(port, 10);
  if (!Number.isFinite(portNum) || portNum < 1 || portNum > 65535) return null;

  const auth = username ? `${username}:${password || ''}@` : '';
  const url = `${protocol}://${auth}${host}:${portNum}`;
  const id = `${host}:${portNum}`;

  return {
    id,
    server: `${protocol}://${host}:${portNum}`,
    url,
    username: username || null,
    password: password || null,
    host,
    port: portNum,
    protocol,
    provider: null, // filled in by the source
    raw: line,
    _idx: idx,
  };
}

/**
 * Read a proxy list file. Each line is parsed; blanks and # comments are
 * skipped. Returns an array of normalized descriptors.
 *
 * @param {string} filePath
 * @returns {Array}
 */
function readProxyFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Proxy list file not found: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const parsed = parseProxyLine(line, i);
    if (parsed) out.push(parsed);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Burn log writer
// ---------------------------------------------------------------------------

/**
 * Create an append-only JSONL writer for burn events. Writes are synchronous
 * (proxy burns are rare; we want durability, not throughput).
 *
 * @param {string} filePath  Path to the burn log.
 * @param {object} [logger]  Optional logger for open/error events.
 */
function createBurnLogWriter(filePath, logger) {
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (logger && logger.warn) {
      logger.warn('Burn log dir create failed (non-fatal)', { dir, error: err.message });
    }
  }

  function append(event) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    try {
      fs.appendFileSync(filePath, line, { encoding: 'utf8' });
    } catch (err) {
      if (logger && logger.warn) {
        logger.warn('Burn log write failed (non-fatal)', { file: filePath, error: err.message });
      }
    }
  }

  return { append, path: filePath };
}

// ---------------------------------------------------------------------------
// Pool factory
// ---------------------------------------------------------------------------

/**
 * Create a proxy pool.
 *
 * @param {object} opts
 * @param {object} [opts.sources]               { file, list, provider } — at least one.
 * @param {'round-robin'|'random'|'sticky'} [opts.strategy='random']
 * @param {number} [opts.sessionLength=1]       Requests per proxy (sticky only).
 * @param {number} [opts.cooldownMs=600000]     Cooldown burn duration.
 * @param {string} [opts.burnLogPath]           Override burn log path.
 * @param {object} [opts.logger]                Logger instance (phase-bound).
 * @param {() => number} [opts.now]             Injectable clock.
 * @param {() => number} [opts.rng]             Injectable RNG (Math.random).
 * @param {object} [opts.burnDetector]          Inject a custom burn detector.
 * @param {object} [opts.burnLogWriter]         Inject a custom burn log writer.
 * @param {boolean} [opts.dryRun]               If true, never write the burn log.
 */
function createProxyPool(opts = {}) {
  const sources = opts.sources || {};
  const strategy = STRATEGIES.has(opts.strategy) ? opts.strategy : DEFAULT_STRATEGY;
  const sessionLength = Math.max(1, Number(opts.sessionLength) || DEFAULT_SESSION_LENGTH);
  const cooldownMs = Number(opts.cooldownMs) || DEFAULT_COOLDOWN_MS;
  const logger = opts.logger || null;
  const now = opts.now || (() => Date.now());
  const rng = opts.rng || Math.random;
  const dryRun = !!opts.dryRun;

  // Bind the logger to a 'proxy' phase for grep-ability.
  const log = logger && logger.phase ? logger.phase('proxy') : logger;

  // Burn detector + burn log
  const detector =
    opts.burnDetector ||
    createBurnDetector({ cooldownMs, now, logger: log });
  const burnLog = opts.burnLogWriter ||
    (dryRun ? null : createBurnLogWriter(opts.burnLogPath || DEFAULT_BURN_LOG, log));

  // The pool is loaded eagerly for sync sources (file + list) and lazily for
  // async sources (provider()). `loadPromise` ensures concurrent acquire()
  // calls share one load. For sync sources, the pool is available immediately
  // after construction so stats() / markBurned() work without an acquire first.
  let pool = null; // array of normalized descriptors
  let loadPromise = null;
  let rrIndex = 0; // round-robin cursor
  const sticky = {
    current: null, // current sticky proxy id
    used: 0, // requests served in this sticky session
  };
  const activeAcquires = new Map(); // proxyId → count of in-flight acquires

  // -----------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------

  function loadSync() {
    const collected = [];
    if (sources.list && sources.list.length > 0) {
      for (let i = 0; i < sources.list.length; i++) {
        const item = sources.list[i];
        if (typeof item === 'string') {
          const parsed = parseProxyLine(item, i);
          if (parsed) {
            parsed.provider = 'manual';
            collected.push(parsed);
          }
        } else if (item && item.server) {
          collected.push({ ...item, provider: item.provider || 'manual' });
        }
      }
    }
    if (sources.file) {
      const fromFile = readProxyFile(sources.file);
      for (const p of fromFile) {
        p.provider = p.provider || 'file';
        collected.push(p);
      }
    }
    return collected;
  }

  async function loadAsync() {
    const collected = loadSync();
    if (typeof sources.provider === 'function') {
      const fromProvider = await sources.provider();
      if (Array.isArray(fromProvider)) {
        for (let i = 0; i < fromProvider.length; i++) {
          const item = fromProvider[i];
          if (typeof item === 'string') {
            const parsed = parseProxyLine(item, i);
            if (parsed) {
              parsed.provider = 'provider';
              collected.push(parsed);
            }
          } else if (item && item.server) {
            collected.push({ ...item, provider: item.provider || 'provider' });
          }
        }
      }
    }
    return collected;
  }

  async function ensureLoaded() {
    if (pool) return pool;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      pool = await loadAsync();
      if (log) {
        log.info('Proxy pool loaded', {
          count: pool.length,
          strategy,
          sessionLength,
          cooldownMs,
          sources: {
            list: sources.list ? sources.list.length : 0,
            file: sources.file || null,
            provider: typeof sources.provider === 'function',
          },
        });
      }
      return pool;
    })();
    return loadPromise;
  }

  /**
   * Synchronously ensure the pool is loaded. Only works for sync sources
   * (file + list). If a provider() is configured, this is a no-op and the
   * pool stays null until the first async acquire()/healthCheck() call.
   */
  function ensureLoadedSync() {
    if (pool) return pool;
    if (typeof sources.provider === 'function') return null; // needs async
    pool = loadSync();
    if (log) {
      log.info('Proxy pool loaded', {
        count: pool.length,
        strategy,
        sessionLength,
        cooldownMs,
        sources: {
          list: sources.list ? sources.list.length : 0,
          file: sources.file || null,
          provider: false,
        },
      });
    }
    return pool;
  }

  // -----------------------------------------------------------------
  // Selection (per strategy)
  // -----------------------------------------------------------------

  function pickRoundRobin(usable) {
    if (usable.length === 0) return null;
    const start = rrIndex % usable.length;
    let picked = null;
    for (let off = 0; off < usable.length; off++) {
      const idx = (start + off) % usable.length;
      const cand = usable[idx];
      if (activeAcquires.get(cand.id) >= 1_000) continue; // saturation guard
      picked = cand;
      rrIndex = idx + 1;
      break;
    }
    return picked;
  }

  function pickRandom(usable) {
    if (usable.length === 0) return null;
    const idx = Math.floor(rng() * usable.length);
    return usable[idx];
  }

  function pickSticky(usable) {
    if (usable.length === 0) return null;
    // Continue the current sticky session if it's still under sessionLength
    // AND the proxy is still usable.
    if (sticky.current && sticky.used < sessionLength) {
      const cand = usable.find((p) => p.id === sticky.current);
      if (cand) {
        sticky.used += 1;
        return cand;
      }
    }
    // Otherwise pick a new one (random) and start a fresh session.
    const picked = pickRandom(usable);
    if (picked) {
      sticky.current = picked.id;
      sticky.used = 1;
    }
    return picked;
  }

  function selectByStrategy(usable) {
    switch (strategy) {
      case 'round-robin':
        return pickRoundRobin(usable);
      case 'sticky':
        return pickSticky(usable);
      case 'random':
      default:
        return pickRandom(usable);
    }
  }

  // -----------------------------------------------------------------
  // Public: acquire
  // -----------------------------------------------------------------

  /**
   * Acquire the next proxy per the rotation strategy. Skips proxies currently
   * in cooldown or permanently burned. Returns null if the pool is exhausted
   * (every proxy is burned) — the caller must then fall back to a direct
   * connection or abort.
   *
   * @returns {Promise<object|null>} A proxy descriptor (with server/username/
   *   password ready to pass to Playwright's chromium.launch({ proxy })), or
   *   null if no usable proxy is available.
   */
  async function acquire() {
    await ensureLoaded();
    if (!pool || pool.length === 0) return null;

    // Promote any cooldown proxies whose window has elapsed back to healthy.
    // (The detector's state() does this lazily, but we also reset counters so
    // the proxy gets a clean slate on reuse.)
    for (const p of pool) {
      if (detector.state(p.id) === 'healthy' && detector.stats(p.id).burnCount > 0) {
        // Only reset if it was previously in cooldown (not on first acquire).
        const st = detector.stats(p.id);
        if (st.burnedAt !== null) {
          detector.resetCounters(p.id);
        }
      }
    }

    const usable = pool.filter((p) => detector.isReusable(p.id));
    if (usable.length === 0) {
      if (log) {
        log.warn('Proxy pool exhausted — every proxy is burned', {
          total: pool.length,
          burned: pool.length - usable.length,
        });
      }
      return null;
    }

    const picked = selectByStrategy(usable);
    if (!picked) return null;

    activeAcquires.set(picked.id, (activeAcquires.get(picked.id) || 0) + 1);

    if (log) {
      log.debug('Proxy acquired', {
        id: picked.id,
        provider: picked.provider,
        protocol: picked.protocol,
        host: picked.host,
        port: picked.port,
        strategy,
        stickySession: strategy === 'sticky' ? sticky.used : null,
      });
    }

    // Return a copy with the fields Playwright needs at the top level.
    return {
      id: picked.id,
      server: picked.server,
      url: picked.url,
      username: picked.username,
      password: picked.password,
      host: picked.host,
      port: picked.port,
      protocol: picked.protocol,
      provider: picked.provider,
    };
  }

  // -----------------------------------------------------------------
  // Public: release
  // -----------------------------------------------------------------

  /**
   * Report the outcome of a completed acquire→use cycle. The detector decides
   * whether to burn the proxy based on the outcome history.
   *
   * @param {string} proxyId
   * @param {{success: boolean, statusCode?: number|string}} outcome
   */
  function release(proxyId, outcome) {
    if (!proxyId) return;
    const inflight = activeAcquires.get(proxyId) || 0;
    if (inflight > 0) activeAcquires.set(proxyId, inflight - 1);

    const decision = detector.record(proxyId, outcome || { success: true });
    if (decision.burned) {
      burnLogAppend({
        kind: decision.kind,
        proxyId,
        reason: decision.reason,
        recentStatusCodes: detector.stats(proxyId).recentStatusCodes,
        provider: lookupProvider(proxyId),
        stats: detector.stats(proxyId),
      });
      if (log) {
        const level = decision.kind === 'permanent' ? 'error' : 'warn';
        log[level]('Proxy burned', {
          id: proxyId,
          kind: decision.kind,
          reason: decision.reason,
          provider: lookupProvider(proxyId),
        });
      }
    } else if (log) {
      log.debug('Proxy released', {
        id: proxyId,
        success: outcome && outcome.success,
        statusCode: outcome && outcome.statusCode,
      });
    }
  }

  function lookupProvider(proxyId) {
    if (!pool) return null;
    const found = pool.find((p) => p.id === proxyId);
    return found ? found.provider : null;
  }

  // -----------------------------------------------------------------
  // Public: markBurned
  // -----------------------------------------------------------------

  function markBurned(proxyId, reason, opts2 = {}) {
    if (!proxyId) return;
    ensureLoadedSync(); // populate pool for sync sources so lookupProvider works
    const decision = opts2.permanent
      ? detector.markPermanent(proxyId, reason)
      : detector.markCooldown(proxyId, reason);
    burnLogAppend({
      kind: decision.kind,
      proxyId,
      reason: decision.reason,
      manual: true,
      provider: lookupProvider(proxyId),
      stats: detector.stats(proxyId),
    });
    if (log) {
      log[opts2.permanent ? 'error' : 'warn']('Proxy manually burned', {
        id: proxyId,
        kind: decision.kind,
        reason: decision.reason,
      });
    }
  }

  function burnLogAppend(event) {
    if (!burnLog || dryRun) return;
    burnLog.append(event);
  }

  // -----------------------------------------------------------------
  // Public: stats
  // -----------------------------------------------------------------

  function stats() {
    // Eagerly load sync sources so stats() works without an acquire first.
    if (!pool) ensureLoadedSync();
    if (!pool) {
      return {
        loaded: false,
        total: 0,
        healthy: 0,
        cooldown: 0,
        burned: 0,
        avgSuccessRate: null,
        strategy,
        sessionLength,
      };
    }
    let healthy = 0;
    let cooldown = 0;
    let burned = 0;
    let totalReqs = 0;
    let totalSuccess = 0;
    const perProxy = [];
    for (const p of pool) {
      const st = detector.stats(p.id);
      const liveState = detector.state(p.id);
      if (liveState === 'healthy') healthy++;
      else if (liveState === 'cooldown') cooldown++;
      else if (liveState === 'burned') burned++;
      totalReqs += st.requestCount;
      totalSuccess += st.successCount;
      perProxy.push({
        id: p.id,
        provider: p.provider,
        state: liveState,
        requestCount: st.requestCount,
        successCount: st.successCount,
        successRate: st.successRate,
        burnCount: st.burnCount,
        cooldownRemainingMs: detector.cooldownRemainingMs(p.id),
      });
    }
    return {
      loaded: true,
      total: pool.length,
      healthy,
      cooldown,
      burned,
      avgSuccessRate: totalReqs > 0 ? totalSuccess / totalReqs : null,
      totalRequests: totalReqs,
      totalSuccess,
      strategy,
      sessionLength,
      perProxy,
    };
  }

  // -----------------------------------------------------------------
  // Public: healthCheck (async — uses an injectable fetchFn)
  // -----------------------------------------------------------------

  /**
   * Probe every proxy with a HEAD request to a fast endpoint (default:
   * google.com/robots.txt). Proxies that fail or time out are marked burned
   * (cooldown). Returns a summary.
   *
   * NO real network is used unless a fetchFn is provided — unit tests inject
   * a stub. The default fetchFn uses Node's global fetch (Node 18+).
   *
   * @param {object} p
   * @param {function} [p.fetchFn]   async (url, { proxy, timeoutMs }) → { ok, status, error }
   * @param {string} [p.url]         URL to probe.
   * @param {number} [p.timeoutMs]   Per-proxy timeout.
   */
  async function healthCheck(p = {}) {
    await ensureLoaded();
    if (!pool || pool.length === 0) {
      return { healthy: [], dead: [], total: 0 };
    }
    const fetchFn =
      p.fetchFn ||
      (async (url, opts) => {
        const ctl = AbortSignal.timeout
          ? AbortSignal.timeout(opts.timeoutMs || DEFAULT_HEALTHCHECK_TIMEOUT_MS)
          : null;
        try {
          const r = await fetch(url, { signal: ctl, method: 'HEAD' });
          return { ok: r.ok, status: r.status, error: null };
        } catch (err) {
          return { ok: false, status: null, error: err.message };
        }
      });

    const probeUrl = p.url || DEFAULT_HEALTHCHECK_URL;
    const timeoutMs = p.timeoutMs || DEFAULT_HEALTHCHECK_TIMEOUT_MS;
    const healthy = [];
    const dead = [];

    await Promise.all(
      pool.map(async (proxy) => {
        const res = await fetchFn(probeUrl, { proxy, timeoutMs });
        if (res.ok) {
          healthy.push(proxy.id);
        } else {
          dead.push(proxy.id);
          // A failed health check is a soft signal — bench the proxy for one
          // cooldown cycle rather than burning it permanently.
          detector.markCooldown(proxy.id, `health check failed: ${res.error || res.status}`);
          burnLogAppend({
            kind: 'cooldown',
            proxyId: proxy.id,
            reason: `health check failed: ${res.error || res.status}`,
            manual: false,
            provider: proxy.provider,
          });
        }
      }),
    );

    if (log) {
      log.info('Proxy health check complete', {
        total: pool.length,
        healthy: healthy.length,
        dead: dead.length,
      });
    }
    return { healthy, dead, total: pool.length };
  }

  // -----------------------------------------------------------------
  // Public: close
  // -----------------------------------------------------------------

  function close() {
    // Burn log writer uses sync writes, so there's no buffer to flush.
    // Kept for symmetry with the DB pool's close() and future buffering.
  }

  return {
    acquire,
    release,
    markBurned,
    stats,
    healthCheck,
    close,
    // Exposed for tests / introspection (not part of the public contract)
    _strategy: strategy,
    _sessionLength: sessionLength,
    _detector: detector,
    _ensureLoaded: ensureLoaded,
  };
}

module.exports = {
  createProxyPool,
  parseProxyLine,
  readProxyFile,
  createBurnLogWriter,
  STRATEGIES,
  DEFAULT_STRATEGY,
  DEFAULT_SESSION_LENGTH,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_BURN_LOG,
};
