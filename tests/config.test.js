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
