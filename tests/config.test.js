'use strict';

/**
 * tests/config.test.js — Phase 1.7 config tests for new flags
 *
 * Coverage:
 *   - --resume / --fresh parsing
 *   - --checkpointInterval parsing + default
 *   - --maxRetries / --retryBaseMs parsing + defaults
 *   - cfg.retry object shape
 *   - validation: --resume + --fresh mutually exclusive → error
 *   - validation: checkpointInterval out of range → error
 *   - validation: maxRetries out of range → error
 *   - HELP_TEXT includes Phase 1.7 flags
 *
 * Run: bun test tests/
 */

const { loadConfig, parseArgs, validate, HELP_TEXT } = require('../src/config');

// Clean env for each test (loadConfig reads process.env)
function cleanEnv() {
  delete process.env.CHECKPOINT_INTERVAL;
  delete process.env.MAX_RETRIES;
  delete process.env.RETRY_BASE_MS;
  delete process.env.RESUME;
  delete process.env.FRESH;
  // Phase 2.4 — fingerprint env vars
  delete process.env.NO_FINGERPRINT;
  delete process.env.FINGERPRINT_PROFILE;
  delete process.env.FIXED_FINGERPRINT;
  // Phase 2.5 — stealth env vars
  delete process.env.STEALTH;
  delete process.env.STEALTH_DEBUG;
}

describe('Phase 1.7 — CLI flag parsing', () => {
  beforeEach(() => cleanEnv());

  test('--resume sets cfg.resume = true', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--resume']);
    expect(cfg.resume).toBe(true);
    expect(cfg.fresh).toBe(false);
  });

  test('--fresh sets cfg.fresh = true', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--fresh']);
    expect(cfg.fresh).toBe(true);
    expect(cfg.resume).toBe(false);
  });

  test('default: resume=false, fresh=false', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.resume).toBe(false);
    expect(cfg.fresh).toBe(false);
  });

  test('--checkpointInterval <n> sets cfg.checkpointInterval', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--checkpointInterval', '25']);
    expect(cfg.checkpointInterval).toBe(25);
  });

  test('default checkpointInterval = 10', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.checkpointInterval).toBe(10);
  });

  test('--maxRetries <n> sets cfg.retry.attempts', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--maxRetries', '5']);
    expect(cfg.retry.attempts).toBe(5);
  });

  test('--retryBaseMs <ms> sets cfg.retry.baseMs', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--retryBaseMs', '500']);
    expect(cfg.retry.baseMs).toBe(500);
  });

  test('default retry = { attempts: 3, baseMs: 1000 }', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.retry.attempts).toBe(3);
    expect(cfg.retry.baseMs).toBe(1000);
  });
});

describe('Phase 1.7 — env var fallbacks', () => {
  beforeEach(() => cleanEnv());

  test('CHECKPOINT_INTERVAL env var', () => {
    process.env.CHECKPOINT_INTERVAL = '20';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.checkpointInterval).toBe(20);
  });

  test('MAX_RETRIES env var', () => {
    process.env.MAX_RETRIES = '4';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.retry.attempts).toBe(4);
  });

  test('RETRY_BASE_MS env var', () => {
    process.env.RETRY_BASE_MS = '2000';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.retry.baseMs).toBe(2000);
  });

  test('CLI flag overrides env var', () => {
    process.env.CHECKPOINT_INTERVAL = '20';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--checkpointInterval', '5']);
    expect(cfg.checkpointInterval).toBe(5);
  });
});

describe('Phase 1.7 — validation', () => {
  beforeEach(() => cleanEnv());

  test('--resume + --fresh are mutually exclusive → config error', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--resume', '--fresh']);
    expect(cfg.errors).toContain('--resume and --fresh are mutually exclusive');
  });

  test('checkpointInterval < 1 → error', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--checkpointInterval', '0']);
    expect(cfg.errors.some((e) => e.includes('checkpointInterval must be between 1 and 10000'))).toBe(true);
  });

  test('checkpointInterval > 10000 → error', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--checkpointInterval', '99999']);
    expect(cfg.errors.some((e) => e.includes('checkpointInterval must be between 1 and 10000'))).toBe(true);
  });

  test('maxRetries < 1 → error', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--maxRetries', '0']);
    expect(cfg.errors.some((e) => e.includes('maxRetries must be between 1 and 10'))).toBe(true);
  });

  test('maxRetries > 10 → error', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--maxRetries', '11']);
    expect(cfg.errors.some((e) => e.includes('maxRetries must be between 1 and 10'))).toBe(true);
  });

  test('retryBaseMs > 60000 → error', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--retryBaseMs', '70000']);
    expect(cfg.errors.some((e) => e.includes('retryBaseMs must be between 0 and 60000'))).toBe(true);
  });

  test('valid Phase 1.7 config → no errors', () => {
    const cfg = loadConfig([
      '--query', 'Cafe',
      '--location', 'Berlin',
      '--resume',
      '--checkpointInterval', '15',
      '--maxRetries', '3',
      '--retryBaseMs', '1000',
    ]);
    expect(cfg.errors).toHaveLength(0);
    expect(cfg.resume).toBe(true);
    expect(cfg.checkpointInterval).toBe(15);
    expect(cfg.retry.attempts).toBe(3);
    expect(cfg.retry.baseMs).toBe(1000);
  });
});

describe('Phase 1.7 — HELP_TEXT', () => {
  test('includes --resume', () => {
    expect(HELP_TEXT).toContain('--resume');
    expect(HELP_TEXT).toContain('resume from .checkpoint.json');
  });

  test('includes --fresh', () => {
    expect(HELP_TEXT).toContain('--fresh');
    expect(HELP_TEXT).toContain('ignore/delete checkpoint');
  });

  test('includes --checkpointInterval', () => {
    expect(HELP_TEXT).toContain('--checkpointInterval');
    expect(HELP_TEXT).toContain('Write checkpoint every N new records');
  });

  test('includes --maxRetries', () => {
    expect(HELP_TEXT).toContain('--maxRetries');
    expect(HELP_TEXT).toContain('Retry attempts for transient ops');
  });

  test('includes --retryBaseMs', () => {
    expect(HELP_TEXT).toContain('--retryBaseMs');
    expect(HELP_TEXT).toContain('Base backoff for retries');
  });

  test('includes --resume example', () => {
    expect(HELP_TEXT).toContain('--resume   # continue after a crash');
  });
});

// ---------------------------------------------------------------------------
// Phase 2.4 — fingerprint config flags
// ---------------------------------------------------------------------------

describe('Phase 2.4 — fingerprint CLI flag parsing', () => {
  beforeEach(() => cleanEnv());

  test('default: fingerprint.profile = "random" (on by default)', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.fingerprint.profile).toBe('random');
    expect(cfg.fingerprint.fixedJson).toBeNull();
    expect(cfg.fingerprint.resolved).toBeNull(); // resolved later in index.js
  });

  test('--noFingerprint sets profile to "off"', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--noFingerprint']);
    expect(cfg.fingerprint.profile).toBe('off');
  });

  test('NO_FINGERPRINT=true env sets profile to "off"', () => {
    process.env.NO_FINGERPRINT = 'true';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.fingerprint.profile).toBe('off');
  });

  test('--fingerprintProfile random sets profile explicitly', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin', '--fingerprintProfile', 'random',
    ]);
    expect(cfg.fingerprint.profile).toBe('random');
  });

  test('--fingerprintProfile fixed sets profile to "fixed"', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--fingerprintProfile', 'fixed',
      '--fixedFingerprint', '{"userAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131","platform":"Win32","locale":"en-US","timezone":"America/New_York","languages":["en-US","en"],"viewport":{"width":1920,"height":1080},"screen":{"width":1920,"height":1080},"webglVendor":"Intel Inc.","webglRenderer":"Intel(R) UHD Graphics 630","canvasNoiseSeed":42,"hardwareConcurrency":8,"deviceMemory":8,"geolocation":{"latitude":40.7128,"longitude":-74.006}}',
    ]);
    expect(cfg.fingerprint.profile).toBe('fixed');
    expect(cfg.fingerprint.fixedJson).toContain('"platform":"Win32"');
  });

  test('FINGERPRINT_PROFILE env var is honored', () => {
    process.env.FINGERPRINT_PROFILE = 'off';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.fingerprint.profile).toBe('off');
  });

  test('--noFingerprint overrides --fingerprintProfile random', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--fingerprintProfile', 'random', '--noFingerprint',
    ]);
    expect(cfg.fingerprint.profile).toBe('off');
  });
});

describe('Phase 2.4 — fingerprint validation', () => {
  beforeEach(() => cleanEnv());

  test('invalid fingerprintProfile value → error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--fingerprintProfile', 'bogus',
    ]);
    expect(cfg.errors).toContainEqual(
      expect.stringContaining('fingerprintProfile must be one of random, fixed, off'),
    );
  });

  test('fingerprintProfile=fixed without --fixedFingerprint → error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--fingerprintProfile', 'fixed',
    ]);
    expect(cfg.errors).toContainEqual(
      expect.stringContaining('fingerprintProfile=fixed requires --fixedFingerprint'),
    );
  });

  test('fingerprintProfile=fixed with invalid JSON → error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--fingerprintProfile', 'fixed',
      '--fixedFingerprint', '{not valid json',
    ]);
    expect(cfg.errors).toContainEqual(
      expect.stringContaining('--fixedFingerprint is not valid JSON'),
    );
  });

  test('fingerprintProfile=fixed with non-object JSON (array) → error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--fingerprintProfile', 'fixed',
      '--fixedFingerprint', '[1,2,3]',
    ]);
    expect(cfg.errors).toContainEqual(
      expect.stringContaining('--fixedFingerprint must be a JSON object'),
    );
  });

  test('valid fixed fingerprint → no fingerprint errors', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--fingerprintProfile', 'fixed',
      '--fixedFingerprint', '{"userAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131","platform":"Win32","locale":"en-US","timezone":"America/New_York","languages":["en-US","en"],"viewport":{"width":1920,"height":1080},"screen":{"width":1920,"height":1080},"webglVendor":"Intel Inc.","webglRenderer":"Intel(R) UHD Graphics 630","canvasNoiseSeed":42,"hardwareConcurrency":8,"deviceMemory":8,"geolocation":{"latitude":40.7128,"longitude":-74.006}}',
    ]);
    const fpErrors = cfg.errors.filter((e) => e.toLowerCase().includes('fingerprint'));
    expect(fpErrors).toEqual([]);
  });

  test('profile random → no fingerprint errors', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    const fpErrors = cfg.errors.filter((e) => e.toLowerCase().includes('fingerprint'));
    expect(fpErrors).toEqual([]);
  });

  test('profile off → no fingerprint errors', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--noFingerprint']);
    const fpErrors = cfg.errors.filter((e) => e.toLowerCase().includes('fingerprint'));
    expect(fpErrors).toEqual([]);
  });
});

describe('Phase 2.4 — HELP_TEXT', () => {
  beforeEach(() => cleanEnv());

  test('includes --fingerprintProfile', () => {
    expect(HELP_TEXT).toContain('--fingerprintProfile');
    expect(HELP_TEXT).toContain('random | fixed | off');
  });

  test('includes --fixedFingerprint', () => {
    expect(HELP_TEXT).toContain('--fixedFingerprint');
    expect(HELP_TEXT).toContain('pin a specific fingerprint');
  });

  test('includes --noFingerprint', () => {
    expect(HELP_TEXT).toContain('--noFingerprint');
    expect(HELP_TEXT).toContain('disable randomization');
  });

  test('includes Phase 2.4 examples', () => {
    expect(HELP_TEXT).toContain('Phase 2.4 — fingerprint randomization');
    expect(HELP_TEXT).toContain('--noFingerprint   # Phase 1 behavior');
  });
});

// ---------------------------------------------------------------------------
// Phase 2.5 — stealth config flags
// ---------------------------------------------------------------------------

describe('Phase 2.5 — stealth CLI flag parsing', () => {
  beforeEach(() => cleanEnv());

  test('default: stealth.profile = "on" (on by default in Phase 2.5)', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.stealth.profile).toBe('on');
    expect(cfg.stealth.debug).toBe(false);
    expect(cfg.stealth.resolved).toBeNull(); // resolved later in index.js
  });

  test('--noStealth sets profile to "off"', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--noStealth']);
    expect(cfg.stealth.profile).toBe('off');
  });

  test('--stealth off sets profile to "off"', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--stealth', 'off']);
    expect(cfg.stealth.profile).toBe('off');
  });

  test('--stealth on sets profile explicitly', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--stealth', 'on']);
    expect(cfg.stealth.profile).toBe('on');
  });

  test('--stealthDebug sets debug flag', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--stealthDebug']);
    expect(cfg.stealth.debug).toBe(true);
  });

  test('STEALTH=off env sets profile to "off"', () => {
    process.env.STEALTH = 'off';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.stealth.profile).toBe('off');
  });

  test('STEALTH=on env is honored', () => {
    process.env.STEALTH = 'on';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.stealth.profile).toBe('on');
  });

  test('STEALTH_DEBUG=true env sets debug flag', () => {
    process.env.STEALTH_DEBUG = 'true';
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.stealth.debug).toBe(true);
  });

  test('--noStealth overrides --stealth on', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--stealth', 'on', '--noStealth',
    ]);
    expect(cfg.stealth.profile).toBe('off');
  });
});

describe('Phase 2.5 — stealth validation', () => {
  beforeEach(() => cleanEnv());

  test('invalid stealth value → error', () => {
    const cfg = loadConfig([
      '--query', 'Cafe', '--location', 'Berlin',
      '--stealth', 'bogus',
    ]);
    expect(cfg.errors).toContainEqual(
      expect.stringContaining('stealth must be one of on, off'),
    );
  });

  test('profile on → no stealth errors', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    const stealthErrors = cfg.errors.filter((e) => e.toLowerCase().includes('stealth'));
    expect(stealthErrors).toEqual([]);
  });

  test('profile off → no stealth errors', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--noStealth']);
    const stealthErrors = cfg.errors.filter((e) => e.toLowerCase().includes('stealth'));
    expect(stealthErrors).toEqual([]);
  });

  test('--stealthDebug alone (without --stealth) → no errors', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin', '--stealthDebug']);
    const stealthErrors = cfg.errors.filter((e) => e.toLowerCase().includes('stealth'));
    expect(stealthErrors).toEqual([]);
    expect(cfg.stealth.debug).toBe(true);
  });
});

describe('Phase 2.5 — HELP_TEXT', () => {
  beforeEach(() => cleanEnv());

  test('includes --stealth', () => {
    expect(HELP_TEXT).toContain('--stealth on|off');
    expect(HELP_TEXT).toContain('stealth hardening');
  });

  test('includes --noStealth', () => {
    expect(HELP_TEXT).toContain('--noStealth');
    expect(HELP_TEXT).toContain('alias for --stealth off');
  });

  test('includes --stealthDebug', () => {
    expect(HELP_TEXT).toContain('--stealthDebug');
    expect(HELP_TEXT).toContain('log every patch applied');
  });

  test('includes Phase 2.5 examples', () => {
    expect(HELP_TEXT).toContain('Phase 2.5 — stealth hardening');
    expect(HELP_TEXT).toContain('--noStealth   # disable stealth');
  });
});

// ===========================================================================
// Phase 2.8 — Worker pool & concurrency
// ===========================================================================

describe('Phase 2.8 — worker pool CLI flag parsing', () => {
  beforeEach(() => {
    delete process.env.WORKERS;
    delete process.env.WORKER_PROXY_STRATEGY;
    delete process.env.WORKER_CRASH_LIMIT;
    delete process.env.WORKER_COOLDOWN_MS;
    delete process.env.WORKER_LOAD_BALANCER;
    delete process.env.WORKER_DETAIL_BATCH_SIZE;
    delete process.env.WORKER_TASK_RETRIES;
  });

  test('defaults: size=1, isolated, crashLimit=3, cooldown=300000, round-robin, batch=20', () => {
    const cfg = loadConfig(['--query', 'Cafe', '--location', 'Berlin']);
    expect(cfg.workers.size).toBe(1);
    expect(cfg.workers.proxyStrategy).toBe('isolated');
    expect(cfg.workers.crashLimit).toBe(3);
    expect(cfg.workers.cooldownMs).toBe(300000);
    expect(cfg.workers.loadBalancer).toBe('round-robin');
    expect(cfg.workers.detailBatchSize).toBe(20);
    expect(cfg.workers.taskRetries).toBeNull(); // null = derive from size
    expect(cfg.workers.resolved).toBeNull(); // resolved at runtime in index.js
  });

  test('--workers N sets size', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--workers', '4']);
    expect(cfg.workers.size).toBe(4);
  });

  test('--workerProxyStrategy shared', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--workerProxyStrategy', 'shared']);
    expect(cfg.workers.proxyStrategy).toBe('shared');
  });

  test('--workerCrashLimit + --workerCooldownMs', () => {
    const cfg = loadConfig([
      '--query', 'C', '--location', 'B',
      '--workerCrashLimit', '5',
      '--workerCooldownMs', '120000',
    ]);
    expect(cfg.workers.crashLimit).toBe(5);
    expect(cfg.workers.cooldownMs).toBe(120000);
  });

  test('--workerLoadBalancer least-busy', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--workerLoadBalancer', 'least-busy']);
    expect(cfg.workers.loadBalancer).toBe('least-busy');
  });

  test('--workerDetailBatchSize + --workerTaskRetries', () => {
    const cfg = loadConfig([
      '--query', 'C', '--location', 'B',
      '--workerDetailBatchSize', '50',
      '--workerTaskRetries', '8',
    ]);
    expect(cfg.workers.detailBatchSize).toBe(50);
    expect(cfg.workers.taskRetries).toBe(8);
  });

  test('env var fallbacks (WORKERS, WORKER_PROXY_STRATEGY, ...)', () => {
    process.env.WORKERS = '6';
    process.env.WORKER_PROXY_STRATEGY = 'shared';
    process.env.WORKER_CRASH_LIMIT = '4';
    process.env.WORKER_COOLDOWN_MS = '60000';
    process.env.WORKER_LOAD_BALANCER = 'least-busy';
    process.env.WORKER_DETAIL_BATCH_SIZE = '15';
    process.env.WORKER_TASK_RETRIES = '3';
    const cfg = loadConfig(['--query', 'C', '--location', 'B']);
    expect(cfg.workers.size).toBe(6);
    expect(cfg.workers.proxyStrategy).toBe('shared');
    expect(cfg.workers.crashLimit).toBe(4);
    expect(cfg.workers.cooldownMs).toBe(60000);
    expect(cfg.workers.loadBalancer).toBe('least-busy');
    expect(cfg.workers.detailBatchSize).toBe(15);
    expect(cfg.workers.taskRetries).toBe(3);
  });

  test('CLI flags override env vars', () => {
    process.env.WORKERS = '6';
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--workers', '2']);
    expect(cfg.workers.size).toBe(2);
  });
});

describe('Phase 2.8 — worker pool validation', () => {
  beforeEach(() => {
    delete process.env.WORKERS;
    delete process.env.WORKER_PROXY_STRATEGY;
    delete process.env.WORKER_CRASH_LIMIT;
    delete process.env.WORKER_COOLDOWN_MS;
    delete process.env.WORKER_LOAD_BALANCER;
    delete process.env.WORKER_DETAIL_BATCH_SIZE;
    delete process.env.WORKER_TASK_RETRIES;
  });

  test('workers < 1 → error', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--workers', '0']);
    expect(cfg.errors.join('\n')).toMatch(/workers must be between 1 and 64/);
  });

  test('workers > 64 → error', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--workers', '65']);
    expect(cfg.errors.join('\n')).toMatch(/workers must be between 1 and 64/);
  });

  test('bad proxyStrategy → error', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--workerProxyStrategy', 'bogus']);
    expect(cfg.errors.join('\n')).toMatch(/workerProxyStrategy must be one of shared, isolated/);
  });

  test('bad loadBalancer → error', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--workerLoadBalancer', 'random']);
    expect(cfg.errors.join('\n')).toMatch(/workerLoadBalancer must be one of round-robin, least-busy/);
  });

  test('crashLimit out of range → error', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--workerCrashLimit', '0']);
    expect(cfg.errors.join('\n')).toMatch(/workerCrashLimit must be between 1 and 50/);
  });

  test('cooldownMs out of range → error', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--workerCooldownMs', '999999999']);
    expect(cfg.errors.join('\n')).toMatch(/workerCooldownMs must be between 0 and 86400000/);
  });

  test('detailBatchSize out of range → error', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--workerDetailBatchSize', '0']);
    expect(cfg.errors.join('\n')).toMatch(/workerDetailBatchSize must be between 1 and 500/);
  });

  test('--workers 1 (default) produces no worker-pool errors (Phase 1 behavior preserved)', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B']);
    expect(cfg.errors.join('\n')).not.toMatch(/worker/);
  });
});

describe('Phase 2.8 — HELP_TEXT', () => {
  test('includes --workers', () => {
    expect(HELP_TEXT).toContain('--workers <n>');
    expect(HELP_TEXT).toContain('parallel browser workers');
  });
  test('includes --workerProxyStrategy', () => {
    expect(HELP_TEXT).toContain('--workerProxyStrategy');
    expect(HELP_TEXT).toContain('shared | isolated');
  });
  test('includes --workerCrashLimit + --workerCooldownMs', () => {
    expect(HELP_TEXT).toContain('--workerCrashLimit');
    expect(HELP_TEXT).toContain('--workerCooldownMs');
  });
  test('includes --workerLoadBalancer', () => {
    expect(HELP_TEXT).toContain('--workerLoadBalancer');
    expect(HELP_TEXT).toContain('round-robin (default) | least-busy');
  });
  test('includes Phase 2.8 examples', () => {
    expect(HELP_TEXT).toContain('Phase 2.8 — worker pool & concurrency');
    expect(HELP_TEXT).toContain('--workers 3   # 3 parallel workers');
  });
});

describe('Phase 2.11 — self-healing selectors config', () => {
  test('cfg.selectors section exists with all fields', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B']);
    expect(cfg.selectors).toBeDefined();
    expect(cfg.selectors).toHaveProperty('skipHealthCheck');
    expect(cfg.selectors).toHaveProperty('autoDiscover');
    expect(cfg.selectors).toHaveProperty('selectorDebugDump');
    expect(cfg.selectors).toHaveProperty('maxSelectorAge');
    expect(cfg.selectors).toHaveProperty('debugDumpDir');
    expect(cfg.selectors).toHaveProperty('healthCheckFixture');
  });

  test('defaults: healthCheck on, autoDiscover on, debugDump on, maxSelectorAge 30', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B']);
    expect(cfg.selectors.skipHealthCheck).toBe(false);
    expect(cfg.selectors.autoDiscover).toBe(true);
    expect(cfg.selectors.selectorDebugDump).toBe(true);
    expect(cfg.selectors.maxSelectorAge).toBe(30);
  });

  test('--skipHealthCheck sets skipHealthCheck=true', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--skipHealthCheck']);
    expect(cfg.selectors.skipHealthCheck).toBe(true);
  });

  test('--autoDiscover off sets autoDiscover=false', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--autoDiscover', 'off']);
    expect(cfg.selectors.autoDiscover).toBe(false);
  });

  test('--autoDiscover on sets autoDiscover=true', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--autoDiscover', 'on']);
    expect(cfg.selectors.autoDiscover).toBe(true);
  });

  test('--selectorDebugDump off sets selectorDebugDump=false', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--selectorDebugDump', 'off']);
    expect(cfg.selectors.selectorDebugDump).toBe(false);
  });

  test('--maxSelectorAge 60 sets maxSelectorAge=60', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--maxSelectorAge', '60']);
    expect(cfg.selectors.maxSelectorAge).toBe(60);
  });

  test('--selectorDebugDir /tmp/dumps sets debugDumpDir', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--selectorDebugDir', '/tmp/dumps']);
    expect(cfg.selectors.debugDumpDir).toBe('/tmp/dumps');
  });

  test('default debugDumpDir is ./data/selector-debug', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B']);
    expect(cfg.selectors.debugDumpDir).toBe('./data/selector-debug');
  });

  test('default healthCheckFixture points to tests/fixtures/Cafe_Berlin_feed.html', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B']);
    expect(cfg.selectors.healthCheckFixture).toContain('Cafe_Berlin_feed.html');
  });

  test('AUTO_DISCOVER=off env var disables autoDiscover', () => {
    process.env.AUTO_DISCOVER = 'off';
    const cfg = loadConfig(['--query', 'C', '--location', 'B']);
    expect(cfg.selectors.autoDiscover).toBe(false);
    delete process.env.AUTO_DISCOVER;
  });

  test('SKIP_HEALTH_CHECK=true env var skips health check', () => {
    process.env.SKIP_HEALTH_CHECK = 'true';
    const cfg = loadConfig(['--query', 'C', '--location', 'B']);
    expect(cfg.selectors.skipHealthCheck).toBe(true);
    delete process.env.SKIP_HEALTH_CHECK;
  });

  test('HEALTH_CHECK=off env var skips health check', () => {
    process.env.HEALTH_CHECK = 'off';
    const cfg = loadConfig(['--query', 'C', '--location', 'B']);
    expect(cfg.selectors.skipHealthCheck).toBe(true);
    delete process.env.HEALTH_CHECK;
  });

  test('MAX_SELECTOR_AGE env var sets maxSelectorAge', () => {
    process.env.MAX_SELECTOR_AGE = '45';
    const cfg = loadConfig(['--query', 'C', '--location', 'B']);
    expect(cfg.selectors.maxSelectorAge).toBe(45);
    delete process.env.MAX_SELECTOR_AGE;
  });

  test('maxSelectorAge validation rejects 0', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--maxSelectorAge', '0']);
    expect(cfg.errors.join('\n')).toMatch(/maxSelectorAge must be between 1 and 365/);
  });

  test('maxSelectorAge validation rejects 366', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--maxSelectorAge', '366']);
    expect(cfg.errors.join('\n')).toMatch(/maxSelectorAge must be between 1 and 365/);
  });

  test('maxSelectorAge accepts 365 (boundary)', () => {
    const cfg = loadConfig(['--query', 'C', '--location', 'B', '--maxSelectorAge', '365']);
    expect(cfg.errors.join('\n')).not.toMatch(/maxSelectorAge/);
  });
});

describe('Phase 2.11 — HELP_TEXT', () => {
  test('includes --skipHealthCheck', () => {
    expect(HELP_TEXT).toContain('--skipHealthCheck');
    expect(HELP_TEXT).toContain('Phase 2.11');
  });

  test('includes --autoDiscover', () => {
    expect(HELP_TEXT).toContain('--autoDiscover on|off');
    expect(HELP_TEXT).toContain('heuristic field auto-discovery');
  });

  test('includes --selectorDebugDump', () => {
    expect(HELP_TEXT).toContain('--selectorDebugDump on|off');
    expect(HELP_TEXT).toContain('data/selector-debug/');
  });

  test('includes --maxSelectorAge', () => {
    expect(HELP_TEXT).toContain('--maxSelectorAge <days>');
    expect(HELP_TEXT).toContain('selector sets are older');
  });

  test('includes --selectorDebugDir', () => {
    expect(HELP_TEXT).toContain('--selectorDebugDir <path>');
  });
});
