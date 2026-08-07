'use strict';

/**
 * tests/retry.test.js — Phase 1.7 unit tests for src/retry.js
 *
 * Coverage:
 *   1. withRetry — happy path (succeeds on first attempt, no sleep)
 *   2. withRetry — succeeds on 2nd attempt (1 retry, 1 sleep call)
 *   3. withRetry — succeeds on 3rd attempt (2 retries, 2 sleep calls)
 *   4. withRetry — all attempts fail → throws last error
 *   5. withRetry — sleep is called with correct exponential backoff
 *      (base*1, base*2, base*4)
 *   6. withRetry — retryIf predicate: retries only when predicate returns true
 *   7. withRetry — retryIf predicate: false → throws immediately (no retry)
 *   8. withRetry — logger.warn called on each retry, logger.debug on success-after-retry
 *   9. backoffMs — exponential schedule (1000, 2000, 4000, 8000)
 *  10. withRetry — injectable sleep (no real waiting in tests)
 *  11. withRetry — attempts=1 means no retry (single attempt, throws on fail)
 *  12. withRetry — default sleep (real setTimeout, but we don't await long)
 *
 * Run: bun test tests/
 */

const { withRetry, backoffMs } = require('../src/retry');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFailingFn(failTimes) {
  let calls = 0;
  return {
    fn: async () => {
      calls++;
      if (calls <= failTimes) throw new Error(`fail #${calls}`);
      return `ok-${calls}`;
    },
    getCalls: () => calls,
  };
}

function makeLogger() {
  const logs = { warn: [], debug: [], info: [] };
  return {
    warn: (m, c) => logs.warn.push({ m, c }),
    debug: (m, c) => logs.debug.push({ m, c }),
    info: (m, c) => logs.info.push({ m, c }),
    _logs: logs,
  };
}

// Fake sleep that records delays instead of actually waiting.
function makeRecordingSleep() {
  const delays = [];
  return {
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    getDelays: () => delays,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('withRetry — happy path', () => {
  test('succeeds on first attempt — no sleep, no warn', async () => {
    const logger = makeLogger();
    const sleep = makeRecordingSleep();
    const result = await withRetry(async () => 'success', {
      attempts: 3,
      baseMs: 1000,
      logger,
      sleep: sleep.sleep,
      label: 'test',
    });
    expect(result).toBe('success');
    expect(sleep.getDelays()).toHaveLength(0);
    expect(logger._logs.warn).toHaveLength(0);
  });

  test('succeeds on first attempt — default sleep (no inject) works', async () => {
    const result = await withRetry(async () => 42, {
      attempts: 3,
      baseMs: 1,
      label: 'test',
    });
    expect(result).toBe(42);
  });
});

describe('withRetry — succeeds after retries', () => {
  test('succeeds on 2nd attempt (1 retry, 1 sleep)', async () => {
    const logger = makeLogger();
    const sleep = makeRecordingSleep();
    const { fn, getCalls } = makeFailingFn(1);

    const result = await withRetry(fn, {
      attempts: 3,
      baseMs: 1000,
      logger,
      sleep: sleep.sleep,
      label: 'op',
    });

    expect(result).toBe('ok-2');
    expect(getCalls()).toBe(2);
    expect(sleep.getDelays()).toEqual([1000]); // 1 backoff before attempt 2
    expect(logger._logs.warn).toHaveLength(1); // 1 retry warning
    expect(logger._logs.warn[0].m).toContain('op failed — retrying');
    expect(logger._logs.debug).toHaveLength(1); // success-after-retry debug
    expect(logger._logs.debug[0].m).toContain('op succeeded after retry');
  });

  test('succeeds on 3rd attempt (2 retries, 2 sleeps)', async () => {
    const logger = makeLogger();
    const sleep = makeRecordingSleep();
    const { fn, getCalls } = makeFailingFn(2);

    const result = await withRetry(fn, {
      attempts: 3,
      baseMs: 1000,
      logger,
      sleep: sleep.sleep,
      label: 'op',
    });

    expect(result).toBe('ok-3');
    expect(getCalls()).toBe(3);
    expect(sleep.getDelays()).toEqual([1000, 2000]); // exponential
    expect(logger._logs.warn).toHaveLength(2);
  });
});

describe('withRetry — all attempts fail', () => {
  test('throws last error after all attempts exhausted', async () => {
    const logger = makeLogger();
    const sleep = makeRecordingSleep();
    const { fn, getCalls } = makeFailingFn(99); // always fails

    await expect(
      withRetry(fn, {
        attempts: 3,
        baseMs: 100,
        logger,
        sleep: sleep.sleep,
        label: 'op',
      }),
    ).rejects.toThrow('fail #3');

    expect(getCalls()).toBe(3);
    expect(sleep.getDelays()).toEqual([100, 200]); // 2 backoffs before attempts 2 and 3
    // 2 retry warnings + 1 "no more retries" warning
    expect(logger._logs.warn).toHaveLength(3);
    expect(logger._logs.warn[2].m).toContain('no more retries');
  });
});

describe('withRetry — exponential backoff schedule', () => {
  test('backoff doubles each attempt: base, base*2, base*4', async () => {
    const sleep = makeRecordingSleep();
    const { fn } = makeFailingFn(99);

    await expect(
      withRetry(fn, {
        attempts: 4,
        baseMs: 500,
        sleep: sleep.sleep,
        logger: makeLogger(),
        label: 'op',
      }),
    ).rejects.toThrow();

    // 3 backoffs before attempts 2, 3, 4: 500, 1000, 2000
    expect(sleep.getDelays()).toEqual([500, 1000, 2000]);
  });
});

describe('withRetry — retryIf predicate', () => {
  test('retries when retryIf returns true', async () => {
    const logger = makeLogger();
    const sleep = makeRecordingSleep();
    const { fn, getCalls } = makeFailingFn(1);

    const result = await withRetry(fn, {
      attempts: 3,
      baseMs: 100,
      logger,
      sleep: sleep.sleep,
      retryIf: () => true,
      label: 'op',
    });

    expect(result).toBe('ok-2');
    expect(getCalls()).toBe(2);
  });

  test('does NOT retry when retryIf returns false — throws immediately', async () => {
    const logger = makeLogger();
    const sleep = makeRecordingSleep();
    const { fn, getCalls } = makeFailingFn(99);

    await expect(
      withRetry(fn, {
        attempts: 3,
        baseMs: 100,
        logger,
        sleep: sleep.sleep,
        retryIf: () => false,
        label: 'op',
      }),
    ).rejects.toThrow('fail #1');

    expect(getCalls()).toBe(1); // no retry
    expect(sleep.getDelays()).toHaveLength(0); // no backoff
  });

  test('retryIf receives the error — can discriminate transient vs fatal', async () => {
    const logger = makeLogger();
    const sleep = makeRecordingSleep();
    const seenErrors = [];
    let call = 0;
    const fn = async () => {
      call++;
      if (call === 1) throw new Error('transient');
      if (call === 2) throw new Error('fatal');
      return 'ok';
    };

    await expect(
      withRetry(fn, {
        attempts: 5,
        baseMs: 10,
        logger,
        sleep: sleep.sleep,
        retryIf: (err) => {
          seenErrors.push(err.message);
          return err.message === 'transient';
        },
        label: 'op',
      }),
    ).rejects.toThrow('fatal');

    expect(call).toBe(2); // retried once (transient), then stopped (fatal)
    // retryIf is called for EVERY error to decide whether to retry:
    //   'transient' → true (retry), 'fatal' → false (stop)
    expect(seenErrors).toEqual(['transient', 'fatal']);
    expect(sleep.getDelays()).toEqual([10]); // 1 backoff before attempt 2
  });
});

describe('withRetry — edge cases', () => {
  test('attempts=1 means single attempt, no retry', async () => {
    const logger = makeLogger();
    const sleep = makeRecordingSleep();
    const { fn, getCalls } = makeFailingFn(99);

    await expect(
      withRetry(fn, {
        attempts: 1,
        baseMs: 1000,
        logger,
        sleep: sleep.sleep,
        label: 'op',
      }),
    ).rejects.toThrow('fail #1');

    expect(getCalls()).toBe(1);
    expect(sleep.getDelays()).toHaveLength(0);
    expect(logger._logs.warn).toHaveLength(1); // "no more retries"
  });

  test('default attempts=3 when not specified', async () => {
    const sleep = makeRecordingSleep();
    const { fn, getCalls } = makeFailingFn(99);

    await expect(
      withRetry(fn, {
        baseMs: 10,
        sleep: sleep.sleep,
        logger: makeLogger(),
        label: 'op',
      }),
    ).rejects.toThrow();

    expect(getCalls()).toBe(3); // default
  });

  test('default label="operation" when not specified', async () => {
    const logger = makeLogger();
    const { fn } = makeFailingFn(1);

    await withRetry(fn, {
      attempts: 2,
      baseMs: 1,
      logger,
      sleep: makeRecordingSleep().sleep,
    });

    expect(logger._logs.warn[0].m).toContain('operation failed — retrying');
  });

  test('returns value of any type (object, array, number)', async () => {
    expect(await withRetry(async () => ({ a: 1 }), { attempts: 1, baseMs: 0 })).toEqual({ a: 1 });
    expect(await withRetry(async () => [1, 2, 3], { attempts: 1, baseMs: 0 })).toEqual([1, 2, 3]);
    expect(await withRetry(async () => null, { attempts: 1, baseMs: 0 })).toBeNull();
    expect(await withRetry(async () => undefined, { attempts: 1, baseMs: 0 })).toBeUndefined();
  });
});

describe('backoffMs — exponential schedule helper', () => {
  test('attempt 0 → base*1', () => {
    expect(backoffMs(0, 1000)).toBe(1000);
  });
  test('attempt 1 → base*2', () => {
    expect(backoffMs(1, 1000)).toBe(2000);
  });
  test('attempt 2 → base*4', () => {
    expect(backoffMs(2, 1000)).toBe(4000);
  });
  test('attempt 3 → base*8', () => {
    expect(backoffMs(3, 1000)).toBe(8000);
  });
  test('base=0 → always 0', () => {
    expect(backoffMs(5, 0)).toBe(0);
  });
  test('base=250 → 250, 500, 1000', () => {
    expect(backoffMs(0, 250)).toBe(250);
    expect(backoffMs(1, 250)).toBe(500);
    expect(backoffMs(2, 250)).toBe(1000);
  });
});

describe('withRetry — Phase 1.7 spec acceptance criteria', () => {
  test('3 attempts, exponential backoff 1s → 2s → 4s', async () => {
    const sleep = makeRecordingSleep();
    const { fn } = makeFailingFn(99);

    await expect(
      withRetry(fn, {
        attempts: 3,
        baseMs: 1000,
        sleep: sleep.sleep,
        logger: makeLogger(),
        label: 'transient',
      }),
    ).rejects.toThrow();

    // Spec: "3 attempts, exponential backoff: 1s → 2s → 4s"
    // 2 backoffs before attempts 2 and 3: 1000ms, 2000ms
    expect(sleep.getDelays()).toEqual([1000, 2000]);
  });

  test('on final failure, the error is re-thrown (caller decides to log+skip)', async () => {
    const { fn } = makeFailingFn(99);
    let caught = null;
    try {
      await withRetry(fn, {
        attempts: 2,
        baseMs: 1,
        sleep: makeRecordingSleep().sleep,
        logger: makeLogger(),
        label: 'op',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught.message).toMatch(/fail #2/);
  });
});
