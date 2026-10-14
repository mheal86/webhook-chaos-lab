/**
 * Deterministic fault planning. A fault is chosen from (seed, phase, logical event index,
 * delivery ordinal, attempt number) only - never from wall-clock time, thread order or random UUIDs.
 */

export type FaultAction =
  | { kind: 'none' }
  /** Receiver answers with `status` before touching the database (no marker, no effect). */
  | { kind: 'respond'; status: number; retryAfter?: string }
  /** Receiver commits normally, then delays the response so the sender times out. */
  | { kind: 'commit_then_delay'; delayMs: number }
  /** Sender signs with a wrong key so the receiver must reject with 401. */
  | { kind: 'sign_invalid' }
  /** Receiver inserts the idempotency marker then fails before commit (transaction rolls back). */
  | { kind: 'fail_after_marker' };

export interface FaultContext {
  /** 0-based logical index of the event within its run (emission order). */
  eventIndex: number;
  /** 1-based ordinal of the delivery within its event (replays continue the numbering). */
  deliveryOrdinal: number;
  attemptNo: number;
}

export interface FaultRule {
  /** Run phase the rule applies to; omitted = every phase. */
  phase?: number;
  eventIndex?: number;
  deliveryOrdinal?: number;
  /** A single attempt number or an inclusive range. */
  attemptNo?: number | { from: number; to?: number };
  action: FaultAction;
}

export interface FaultPlan {
  seed: number;
  rules: FaultRule[];
  /** Seeded pseudo-random failures: fails when seededUnit(seed, ctx) < rate. */
  randomFailure?: { rate: number; status: number };
}

export const NO_FAULT: FaultAction = { kind: 'none' };

/** cyrb53 string hash -> 53-bit integer. Deterministic and platform independent. */
function cyrb53(input: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Uniform value in [0,1) derived from the seed and labelled parts. */
export function seededUnit(seed: number, ...parts: Array<string | number>): number {
  return cyrb53(`${seed}|${parts.join('|')}`) / 2 ** 53;
}

export function jitterUnitFor(seed: number, ctx: FaultContext): number {
  return seededUnit(seed, 'jitter', ctx.eventIndex, ctx.deliveryOrdinal, ctx.attemptNo);
}

function attemptMatches(rule: FaultRule['attemptNo'], attemptNo: number): boolean {
  if (rule === undefined) return true;
  if (typeof rule === 'number') return rule === attemptNo;
  return attemptNo >= rule.from && (rule.to === undefined || attemptNo <= rule.to);
}

export function decideFault(plan: FaultPlan | null | undefined, phase: number, ctx: FaultContext): FaultAction {
  if (!plan) return NO_FAULT;
  for (const rule of plan.rules) {
    if (rule.phase !== undefined && rule.phase !== phase) continue;
    if (rule.eventIndex !== undefined && rule.eventIndex !== ctx.eventIndex) continue;
    if (rule.deliveryOrdinal !== undefined && rule.deliveryOrdinal !== ctx.deliveryOrdinal) continue;
    if (!attemptMatches(rule.attemptNo, ctx.attemptNo)) continue;
    return rule.action;
  }
  if (plan.randomFailure && plan.randomFailure.rate > 0) {
    const u = seededUnit(plan.seed, 'fail', ctx.eventIndex, ctx.deliveryOrdinal, ctx.attemptNo);
    if (u < plan.randomFailure.rate) return { kind: 'respond', status: plan.randomFailure.status };
  }
  return NO_FAULT;
}
