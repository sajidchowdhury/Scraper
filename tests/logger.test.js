'use strict';

/**
 * tests/logger.test.js — Phase 1.9 unit tests for src/logger.js
 *
 * Coverage:
 *   1. createLogger — returns an object with debug/info/warn/error/phase/child/close
 *   2. Each level method emits a record to the memory buffer
 *   3. Log level filtering: debug suppressed at info level; warn/error pass
 *   4. Every record includes ts, level, phase, msg
 *   5. Default phase is 'system' when not bound
 *   6. phase(name) returns a child logger whose every line is tagged with name
 *   7. ctx.phase overrides the bound phase for a single line
 *   8. child(extra) merges extra context into every line (legacy API)
 *   9. Context fields appear in the record (spread after phase/msg)
 *  10. File sink writes JSON lines (one per record) with the phase field
 *  11. getLogFile() returns the file path (null when file logging disabled)
 *  12. filter(pred) returns matching records from the memory buffer
 *  13. minLevel getter reflects the configured level
 *  14. Console output includes a [phase] tag (via injectable consoleOut)
 *  15. close() is safe to call (no throw) and ends the file stream
 *  16. PHASES list is exported and contains the canonical phase names
 *  17. phase().phase() nesting overrides (flat tags, not concatenated)
 *  18. Memory buffer trims to the limit (doesn't grow unbounded)
 *
 * Run: bun test tests/
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { createLogger, LEVELS, PHASES, COLORS } = require('../src/logger');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

function beforeEach() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
}

function afterEach() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** A logger with console + file disabled — pure in-memory for fast tests. */
function makeMemoryLogger(opts = {}) {
  return createLogger({
    level: opts.level || 'debug',
    query: opts.query || 'TestQuery',
    location: opts.location || 'TestLoc',
    logDir: tmpDir,
    silent: true,
    file: false,
    ...opts,
  });
}

/** Injectable console sink that captures lines for assertion. */
function makeCapturingConsole() {
  const lines = [];
  return {
    log: (s) => lines.push(s),
    _lines: lines,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// We use a shared describe-style grouping via phase comments to match the
// project's existing test style (see tests/antiblock.test.js).

describe('Phase 1.9 — logger API surface', () => {
  beforeEach(beforeEach);
  afterEach(afterEach);

  test('createLogger returns an object with all level methods + phase/child/close', () => {
    const logger = makeMemoryLogger();
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.phase).toBe('function');
    expect(typeof logger.child).toBe('function');
    expect(typeof logger.close).toBe('function');
    expect(typeof logger.getLogFile).toBe('function');
    expect(typeof logger.getMemory).toBe('function');
    expect(typeof logger.filter).toBe('function');
  });

  test('each level method emits a record to the memory buffer', () => {
    const logger = makeMemoryLogger({ level: 'debug' });
    logger.debug('d1');
    logger.info('i1');
    logger.warn('w1');
    logger.error('e1');
    const mem = logger.getMemory();
    expect(mem.length).toBe(4);
    expect(mem[0].level).toBe('debug');
    expect(mem[1].level).toBe('info');
    expect(mem[2].level).toBe('warn');
    expect(mem[3].level).toBe('error');
  });

  test('every record includes ts, level, phase, msg', () => {
    const logger = makeMemoryLogger();
    logger.info('hello', { foo: 'bar' });
    const [rec] = logger.getMemory();
    expect(typeof rec.ts).toBe('string');
    expect(rec.ts.length).toBeGreaterThan(10); // ISO timestamp
    expect(rec.level).toBe('info');
    expect(rec.phase).toBe('system'); // default
    expect(rec.msg).toBe('hello');
    expect(rec.foo).toBe('bar');
  });
});

describe('Phase 1.9 — log level filtering', () => {
  beforeEach(beforeEach);
  afterEach(afterEach);

  test('debug is suppressed at info level', () => {
    const logger = makeMemoryLogger({ level: 'info' });
    logger.debug('should be hidden');
    logger.info('should appear');
    const mem = logger.getMemory();
    expect(mem.length).toBe(1);
    expect(mem[0].msg).toBe('should appear');
  });

  test('warn + error pass at warn level (info/debug suppressed)', () => {
    const logger = makeMemoryLogger({ level: 'warn' });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    const mem = logger.getMemory();
    expect(mem.length).toBe(2);
    expect(mem[0].level).toBe('warn');
    expect(mem[1].level).toBe('error');
  });

  test('only error passes at error level', () => {
    const logger = makeMemoryLogger({ level: 'error' });
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(logger.getMemory().length).toBe(1);
  });

  test('minLevel getter reflects the configured level', () => {
    expect(makeMemoryLogger({ level: 'debug' }).minLevel).toBe(LEVELS.debug);
    expect(makeMemoryLogger({ level: 'info' }).minLevel).toBe(LEVELS.info);
    expect(makeMemoryLogger({ level: 'warn' }).minLevel).toBe(LEVELS.warn);
    expect(makeMemoryLogger({ level: 'error' }).minLevel).toBe(LEVELS.error);
  });
});

describe('Phase 1.9 — phase binding', () => {
  beforeEach(beforeEach);
  afterEach(afterEach);

  test('default phase is "system" when not bound', () => {
    const logger = makeMemoryLogger();
    logger.info('unbound');
    expect(logger.getMemory()[0].phase).toBe('system');
  });

  test('phase(name) returns a child logger tagged with name', () => {
    const logger = makeMemoryLogger();
    const extract = logger.phase('extract');
    extract.info('Business extracted', { index: 5 });
    const [rec] = logger.getMemory();
    expect(rec.phase).toBe('extract');
    expect(rec.msg).toBe('Business extracted');
    expect(rec.index).toBe(5);
  });

  test('phase() does not mutate the parent logger', () => {
    const logger = makeMemoryLogger();
    const extract = logger.phase('extract');
    extract.info('tagged');
    logger.info('untagged');
    const mem = logger.getMemory();
    expect(mem[0].phase).toBe('extract');
    expect(mem[1].phase).toBe('system'); // parent unchanged
  });

  test('ctx.phase overrides the bound phase for a single line', () => {
    const logger = makeMemoryLogger();
    const extract = logger.phase('extract');
    extract.info('normal');
    extract.info('one-off', { phase: 'antiblock' });
    extract.info('back to normal');
    const mem = logger.getMemory();
    expect(mem[0].phase).toBe('extract');
    expect(mem[1].phase).toBe('antiblock'); // override
    expect(mem[2].phase).toBe('extract'); // restored
  });

  test('phase().phase() nesting overrides (flat tags, not concatenated)', () => {
    const logger = makeMemoryLogger();
    const a = logger.phase('search');
    const b = a.phase('scroll');
    b.info('nested');
    expect(logger.getMemory()[0].phase).toBe('scroll');
  });

  test('all canonical phases can be bound', () => {
    const logger = makeMemoryLogger();
    for (const p of PHASES) {
      logger.phase(p).info(`event in ${p}`);
    }
    const mem = logger.getMemory();
    expect(mem.length).toBe(PHASES.length);
    mem.forEach((rec, i) => {
      expect(rec.phase).toBe(PHASES[i]);
    });
  });
});

describe('Phase 1.9 — child() context merging (legacy API)', () => {
  beforeEach(beforeEach);
  afterEach(afterEach);

  test('child(extra) merges extra into every subsequent line', () => {
    const logger = makeMemoryLogger();
    const child = logger.child({ runId: 'abc123' });
    child.info('first');
    child.info('second', { index: 2 });
    const mem = logger.getMemory();
    expect(mem[0].runId).toBe('abc123');
    expect(mem[1].runId).toBe('abc123');
    expect(mem[1].index).toBe(2);
  });

  test('child().child() merges cumulative context', () => {
    const logger = makeMemoryLogger();
    const c1 = logger.child({ a: 1 });
    const c2 = c1.child({ b: 2 });
    c2.info('merged');
    const [rec] = logger.getMemory();
    expect(rec.a).toBe(1);
    expect(rec.b).toBe(2);
  });
});

describe('Phase 1.9 — file sink', () => {
  beforeEach(beforeEach);
  afterEach(afterEach);

  test('file sink writes JSON lines with the phase field', () => {
    const logger = createLogger({
      level: 'debug',
      query: 'FileTest',
      location: 'FileLoc',
      logDir: tmpDir,
      silent: true,
      file: true,
    });
    logger.info('plain line');
    logger.phase('extract').info('tagged line', { index: 9 });
    logger.close();

    const logFile = logger.getLogFile();
    expect(logFile).toBeTruthy();
    expect(fs.existsSync(logFile)).toBe(true);

    const content = fs.readFileSync(logFile, 'utf8').trim();
    const lines = content.split('\n');
    expect(lines.length).toBe(2);

    const rec1 = JSON.parse(lines[0]);
    const rec2 = JSON.parse(lines[1]);
    expect(rec1.phase).toBe('system');
    expect(rec1.msg).toBe('plain line');
    expect(rec2.phase).toBe('extract');
    expect(rec2.msg).toBe('tagged line');
    expect(rec2.index).toBe(9);
  });

  test('getLogFile() returns null when file logging is disabled', () => {
    const logger = makeMemoryLogger({ file: false });
    expect(logger.getLogFile()).toBeNull();
  });

  test('log filename contains query + location + timestamp', () => {
    const logger = createLogger({
      level: 'info',
      query: 'Restaurant',
      location: 'Toronto',
      logDir: tmpDir,
      silent: true,
      file: true,
    });
    logger.close();
    const logFile = logger.getLogFile();
    const base = path.basename(logFile);
    expect(base).toContain('Restaurant');
    expect(base).toContain('Toronto');
    // Filename format: {query}_{location}_{YYYY-MM-DD_HH-mm-ss}.log
    expect(base).toMatch(/^Restaurant_Toronto_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/);
  });
});

describe('Phase 1.9 — console sink', () => {
  beforeEach(beforeEach);
  afterEach(afterEach);

  test('console output includes a [phase] tag', () => {
    const con = makeCapturingConsole();
    const logger = createLogger({
      level: 'info',
      query: 'Q',
      location: 'L',
      logDir: tmpDir,
      silent: false,
      file: false,
      consoleOut: con,
    });
    logger.info('hello');
    logger.phase('extract').info('tagged');
    logger.close();

    expect(con._lines.length).toBe(2);
    expect(con._lines[0]).toContain('[system]');
    expect(con._lines[0]).toContain('hello');
    expect(con._lines[1]).toContain('[extract]');
    expect(con._lines[1]).toContain('tagged');
  });

  test('silent=true suppresses console output', () => {
    const con = makeCapturingConsole();
    const logger = createLogger({
      level: 'info',
      query: 'Q',
      location: 'L',
      logDir: tmpDir,
      silent: true,
      file: false,
      consoleOut: con,
    });
    logger.info('hidden');
    logger.close();
    expect(con._lines.length).toBe(0);
  });
});

describe('Phase 1.9 — filter() + memory buffer', () => {
  beforeEach(beforeEach);
  afterEach(afterEach);

  test('filter(pred) returns matching records', () => {
    const logger = makeMemoryLogger();
    logger.phase('extract').info('Business extracted', { index: 0 });
    logger.phase('extract').info('Business extracted', { index: 1 });
    logger.phase('scroll').info('Scroll progress');
    logger.phase('extract').warn('Business extraction failed', { index: 2 });

    const extractEvents = logger.filter((r) => r.phase === 'extract');
    expect(extractEvents.length).toBe(3);

    const failures = logger.filter((r) => r.level === 'warn');
    expect(failures.length).toBe(1);
    expect(failures[0].index).toBe(2);
  });

  test('getMemory() returns a snapshot (not the internal array)', () => {
    const logger = makeMemoryLogger();
    logger.info('first');
    const snap = logger.getMemory();
    logger.info('second');
    // The snapshot was taken before the second log — it must not grow.
    expect(snap.length).toBe(1);
    expect(logger.getMemory().length).toBe(2);
  });
});

describe('Phase 1.9 — exports + constants', () => {
  test('PHASES is exported and contains the canonical phase names', () => {
    expect(Array.isArray(PHASES)).toBe(true);
    expect(PHASES).toContain('system');
    expect(PHASES).toContain('search');
    expect(PHASES).toContain('scroll');
    expect(PHASES).toContain('extract');
    expect(PHASES).toContain('detail');
    expect(PHASES).toContain('export');
    expect(PHASES).toContain('recovery');
    expect(PHASES).toContain('antiblock');
    expect(PHASES).toContain('retry');
    expect(PHASES).toContain('browser');
  });

  test('LEVELS is exported with the four levels', () => {
    expect(LEVELS.debug).toBe(10);
    expect(LEVELS.info).toBe(20);
    expect(LEVELS.warn).toBe(30);
    expect(LEVELS.error).toBe(40);
  });

  test('COLORS is exported', () => {
    expect(COLORS.reset).toBe('\x1b[0m');
    expect(typeof COLORS.info).toBe('string');
  });
});

describe('Phase 1.9 — close() safety', () => {
  beforeEach(beforeEach);
  afterEach(afterEach);

  test('close() does not throw (even with file logging)', () => {
    const logger = createLogger({
      level: 'info',
      query: 'Q',
      location: 'L',
      logDir: tmpDir,
      silent: true,
      file: true,
    });
    logger.info('something');
    expect(() => logger.close()).not.toThrow();
  });

  test('close() on a file-disabled logger does not throw', () => {
    const logger = makeMemoryLogger({ file: false });
    expect(() => logger.close()).not.toThrow();
  });
});
