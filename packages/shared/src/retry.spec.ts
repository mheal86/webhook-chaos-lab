import {
  DEFAULT_RETRY_POLICY,
  backoffDelayMs,
  classifyHttpStatus,
  decideAfterAttempt,
  parseRetryAfterMs,
  type RetryPolicy,
} from './retry';

const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, jitter: 0 };

describe('classifyHttpStatus', () => {
  it.each([200, 201, 204, 299])('%i is success', (s) =>
    expect(classifyHttpStatus(s)).toBe('success'),
  );
  it.each([408, 429, 500, 502, 503, 599])('%i is retryable', (s) =>
    expect(classifyHttpStatus(s)).toBe('retryable'),
  );
  it.each([301, 302, 400, 401, 403, 404, 409, 410, 422])('%i is permanent', (s) =>
    expect(classifyHttpStatus(s)).toBe('permanent'),
  );
});

describe('backoffDelayMs', () => {
  it('doubles from base and is capped (jitter 0)', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n, policy, 0.5));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('keeps jittered delay within [raw*(1-j), raw)', () => {
    const p = { ...policy, jitter: 0.25 };
    expect(backoffDelayMs(3, p, 0)).toBe(3000); // raw 4000 * 0.75
    expect(backoffDelayMs(3, p, 0.999999)).toBeLessThanOrEqual(4000);
    expect(backoffDelayMs(3, p, 0.999999)).toBeGreaterThanOrEqual(3990);
  });

  it('full jitter can approach zero', () => {
    expect(backoffDelayMs(2, { ...policy, jitter: 1 }, 0)).toBe(0);
  });

  it('is deterministic for the same unit', () => {
    const p = { ...policy, jitter: 0.5 };
    expect(backoffDelayMs(4, p, 0.37)).toBe(backoffDelayMs(4, p, 0.37));
  });
});

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  it('parses delta seconds', () => expect(parseRetryAfterMs('7', now)).toBe(7000));
  it('parses an HTTP date', () =>
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000));
  it('past dates become 0', () =>
    expect(parseRetryAfterMs('Wed, 31 Dec 2025 23:00:00 GMT', now)).toBe(0));
  it.each(['', '  ', '-5', '1.5', 'abc', '2026-01-01', '99999999999'])('rejects %p', (v) =>
    expect(parseRetryAfterMs(v, now)).toBeNull(),
  );
  it('rejects null/undefined', () => {
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
  });
});

describe('decideAfterAttempt (fake clock)', () => {
  const T0 = Date.parse('2026-01-01T00:00:00Z');

  it('2xx succeeds', () => {
    expect(
      decideAfterAttempt({
        attemptNo: 1,
        policy,
        nowMs: T0,
        result: { kind: 'http', status: 200 },
        jitterUnit: 0,
      }).kind,
    ).toBe('succeeded');
  });

  it('retries 500 on the exponential schedule using the injected clock', () => {
    const schedule: number[] = [];
    let now = T0;
    for (let attemptNo = 1; attemptNo < policy.maxAttempts; attemptNo++) {
      const d = decideAfterAttempt({
        attemptNo,
        policy,
        nowMs: now,
        result: { kind: 'http', status: 500 },
        jitterUnit: 0,
      });
      if (d.kind !== 'retry') throw new Error('expected retry');
      expect(d.nextAttemptAtMs).toBe(now + d.delayMs);
      schedule.push(d.delayMs);
      now = d.nextAttemptAtMs;
    }
    expect(schedule).toEqual([1000, 2000, 4000, 8000]);
    expect(now - T0).toBe(15_000);
  });

  it('goes dead when the budget is exhausted, counting every attempt', () => {
    const d = decideAfterAttempt({
      attemptNo: 5,
      policy,
      nowMs: T0,
      result: { kind: 'http', status: 503 },
      jitterUnit: 0,
    });
    expect(d).toMatchObject({ kind: 'dead', reason: 'attempts_exhausted', errorCode: 'http_503' });
  });

  it('a lost worker consumes budget like any other attempt', () => {
    const d = decideAfterAttempt({
      attemptNo: 5,
      policy,
      nowMs: T0,
      result: { kind: 'worker_lost' },
      jitterUnit: 0,
    });
    expect(d).toMatchObject({ kind: 'dead', outcome: 'worker_lost' });
  });

  it.each([400, 401, 404, 409])('%i is a permanent failure without retry', (status) => {
    const d = decideAfterAttempt({
      attemptNo: 1,
      policy,
      nowMs: T0,
      result: { kind: 'http', status },
      jitterUnit: 0,
    });
    expect(d).toMatchObject({
      kind: 'dead',
      reason: 'permanent_failure',
      outcome: 'http_permanent',
    });
  });

  it('treats a redirect as a permanent failure with a dedicated code', () => {
    const d = decideAfterAttempt({
      attemptNo: 1,
      policy,
      nowMs: T0,
      result: { kind: 'http', status: 302 },
      jitterUnit: 0,
    });
    expect(d).toMatchObject({ kind: 'dead', errorCode: 'redirect_blocked' });
  });

  it('timeouts and network errors are retryable', () => {
    expect(
      decideAfterAttempt({
        attemptNo: 1,
        policy,
        nowMs: T0,
        result: { kind: 'timeout' },
        jitterUnit: 0,
      }),
    ).toMatchObject({
      kind: 'retry',
      outcome: 'timeout',
    });
    expect(
      decideAfterAttempt({
        attemptNo: 1,
        policy,
        nowMs: T0,
        result: { kind: 'network_error', code: 'econnrefused' },
        jitterUnit: 0,
      }),
    ).toMatchObject({ kind: 'retry', outcome: 'network_error', errorCode: 'network_econnrefused' });
  });

  it('local (allowlist/secret) errors are permanent', () => {
    expect(
      decideAfterAttempt({
        attemptNo: 1,
        policy,
        nowMs: T0,
        result: { kind: 'local_error', code: 'endpoint_not_allowlisted' },
        jitterUnit: 0,
      }),
    ).toMatchObject({ kind: 'dead', errorCode: 'endpoint_not_allowlisted' });
  });

  it('honours Retry-After when larger than backoff, clamped to maxRetryAfterMs', () => {
    const p = { ...policy, maxRetryAfterMs: 20_000 };
    const big = decideAfterAttempt({
      attemptNo: 1,
      policy: p,
      nowMs: T0,
      result: { kind: 'http', status: 429, retryAfterHeader: '3600' },
      jitterUnit: 0,
    });
    expect(big).toMatchObject({ kind: 'retry', delayMs: 20_000, retryAfterApplied: true });
    const mid = decideAfterAttempt({
      attemptNo: 1,
      policy: p,
      nowMs: T0,
      result: { kind: 'http', status: 503, retryAfterHeader: '5' },
      jitterUnit: 0,
    });
    expect(mid).toMatchObject({ delayMs: 5000, retryAfterApplied: true });
  });

  it('ignores Retry-After smaller than the backoff and invalid values', () => {
    const small = decideAfterAttempt({
      attemptNo: 3,
      policy,
      nowMs: T0,
      result: { kind: 'http', status: 429, retryAfterHeader: '1' },
      jitterUnit: 0,
    });
    expect(small).toMatchObject({ delayMs: 4000, retryAfterApplied: false });
    const invalid = decideAfterAttempt({
      attemptNo: 1,
      policy,
      nowMs: T0,
      result: { kind: 'http', status: 429, retryAfterHeader: 'soon' },
      jitterUnit: 0,
    });
    expect(invalid).toMatchObject({ delayMs: 1000, retryAfterApplied: false });
  });
});
