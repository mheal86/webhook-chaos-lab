import type { AttemptOutcome } from './constants';

/**
 * Retry policy. PostgreSQL (`deliveries.next_attempt_at`) is the only retry owner; BullMQ jobs are
 * configured with `attempts: 1`.
 *
 * Attempt numbering: attempt numbers are 1-based and count every attempt that consumed budget,
 * including attempts whose outcome is unknown (worker lost). `maxAttempts` includes the first send.
 */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  capDelayMs: number;
  /** Fraction in [0,1]. 0 = deterministic delay, 1 = "full jitter" (delay uniformly in [0, raw)). */
  jitter: number;
  /** Upper bound applied to a valid Retry-After header before it is merged into the schedule. */
  maxRetryAfterMs: number;
  httpTimeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  capDelayMs: 30_000,
  jitter: 0.2,
  maxRetryAfterMs: 60_000,
  httpTimeoutMs: 2000,
};

export type HttpClassification = 'success' | 'retryable' | 'permanent';

/** 2xx = success; 408, 429 and 5xx = retryable; everything else (incl. 3xx, 401, 409) = permanent. */
export function classifyHttpStatus(status: number): HttpClassification {
  if (status >= 200 && status < 300) return 'success';
  if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return 'retryable';
  return 'permanent';
}

const HTTP_DATE_FORMAT = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const MAX_RETRY_AFTER_SECONDS = 31_536_000; // ignore absurd values (> 1 year) as invalid

/**
 * Parses Retry-After. Valid forms: non-negative integer seconds, or an IMF-fixdate HTTP-date.
 * Anything else (negative, fractional, empty, garbage) is invalid and returns null so the caller
 * falls back to exponential backoff. A date in the past yields 0.
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | null {
  if (header === null || header === undefined) return null;
  const value = header.trim();
  if (value === '') return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds > MAX_RETRY_AFTER_SECONDS) return null;
    return seconds * 1000;
  }
  if (HTTP_DATE_FORMAT.test(value)) {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return null;
    return Math.max(0, at - nowMs);
  }
  return null;
}

/**
 * delay = raw * (1 - jitter) + raw * jitter * u,  raw = min(cap, base * 2^(failedAttemptNo - 1))
 * `jitterUnit` u in [0,1) comes from the seeded fault module so schedules are reproducible.
 * After attempt 1 fails the wait is ~base, after attempt 2 ~2*base, and so on, until `cap`.
 */
export function backoffDelayMs(
  failedAttemptNo: number,
  policy: Pick<RetryPolicy, 'baseDelayMs' | 'capDelayMs' | 'jitter'>,
  jitterUnit: number,
): number {
  const exponent = Math.max(0, failedAttemptNo - 1);
  const raw = Math.min(policy.capDelayMs, policy.baseDelayMs * 2 ** Math.min(exponent, 30));
  const j = Math.min(1, Math.max(0, policy.jitter));
  const u = Math.min(1, Math.max(0, jitterUnit));
  return Math.round(raw * (1 - j) + raw * j * u);
}

export type SendResult =
  | { kind: 'http'; status: number; retryAfterHeader?: string | null }
  | { kind: 'network_error'; code: string }
  | { kind: 'timeout' }
  | { kind: 'worker_lost' }
  | { kind: 'local_error'; code: string };

export type AttemptDecision =
  | { kind: 'succeeded'; outcome: 'success'; errorCode: null }
  | {
      kind: 'retry';
      outcome: AttemptOutcome;
      errorCode: string;
      delayMs: number;
      nextAttemptAtMs: number;
      retryAfterApplied: boolean;
    }
  | {
      kind: 'dead';
      outcome: AttemptOutcome;
      errorCode: string;
      reason: 'permanent_failure' | 'attempts_exhausted';
    };

export interface DecideInput {
  attemptNo: number;
  policy: RetryPolicy;
  nowMs: number;
  result: SendResult;
  jitterUnit: number;
}

/** Pure decision function: what happens to a delivery after one attempt finished. */
export function decideAfterAttempt(input: DecideInput): AttemptDecision {
  const { attemptNo, policy, nowMs, result, jitterUnit } = input;

  let outcome: AttemptOutcome;
  let errorCode: string;
  let retryable: boolean;
  let retryAfterHeader: string | null | undefined;

  switch (result.kind) {
    case 'http': {
      const cls = classifyHttpStatus(result.status);
      if (cls === 'success') return { kind: 'succeeded', outcome: 'success', errorCode: null };
      retryable = cls === 'retryable';
      outcome = retryable ? 'http_retryable' : 'http_permanent';
      errorCode =
        result.status >= 300 && result.status < 400 ? 'redirect_blocked' : `http_${result.status}`;
      retryAfterHeader = result.retryAfterHeader;
      break;
    }
    case 'network_error':
      outcome = 'network_error';
      errorCode = `network_${result.code}`;
      retryable = true;
      break;
    case 'timeout':
      outcome = 'timeout';
      errorCode = 'timeout';
      retryable = true;
      break;
    case 'worker_lost':
      outcome = 'worker_lost';
      errorCode = 'worker_lost';
      retryable = true;
      break;
    case 'local_error':
      outcome = 'http_permanent';
      errorCode = result.code;
      retryable = false;
      break;
  }

  if (!retryable) return { kind: 'dead', outcome, errorCode, reason: 'permanent_failure' };
  if (attemptNo >= policy.maxAttempts) {
    return { kind: 'dead', outcome, errorCode, reason: 'attempts_exhausted' };
  }

  let delayMs = backoffDelayMs(attemptNo, policy, jitterUnit);
  let retryAfterApplied = false;
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader, nowMs);
  if (retryAfterMs !== null) {
    const clamped = Math.min(retryAfterMs, policy.maxRetryAfterMs);
    if (clamped > delayMs) {
      delayMs = clamped;
      retryAfterApplied = true;
    }
  }
  return {
    kind: 'retry',
    outcome,
    errorCode,
    delayMs,
    nextAttemptAtMs: nowMs + delayMs,
    retryAfterApplied,
  };
}
