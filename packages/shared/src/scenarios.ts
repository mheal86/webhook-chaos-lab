import { z } from 'zod';
import { EVENT_TYPES, LIMITS, type EventType } from './constants';
import type { FaultPlan } from './faults';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './retry';

export const SCENARIO_TYPES = [
  'healthy',
  'fail_twice',
  'duplicate_storm',
  'timeout_after_commit',
  'out_of_order',
  'exhaust_and_replay',
  'invalid_signature',
] as const;
export type ScenarioType = (typeof SCENARIO_TYPES)[number];
/** `custom` runs are created by tests/internal tooling only; they are not exposed over HTTP. */
export type RunType = ScenarioType | 'custom' | 'manual';

export interface RunConfig extends RetryPolicy {
  /** Number of logical events (healthy, fail_twice, timeout_after_commit, exhaust_and_replay, invalid_signature). */
  eventCount: number;
  /** Deliveries created for the single event in duplicate_storm. */
  duplicateCount: number;
  /** Probability of a seeded random HTTP 500 (healthy scenario only). */
  chaosRate: number;
}

export const DEFAULT_RUN_CONFIG: RunConfig = {
  ...DEFAULT_RETRY_POLICY,
  eventCount: 1,
  duplicateCount: LIMITS.maxDuplicatesPerEvent,
  chaosRate: 0,
};

export const runConfigInputSchema = z
  .object({
    eventCount: z.number().int().min(1).max(LIMITS.maxEventsPerRun),
    duplicateCount: z.number().int().min(2).max(LIMITS.maxDuplicatesPerEvent),
    maxAttempts: z.number().int().min(1).max(LIMITS.maxAttemptsCeiling),
    baseDelayMs: z.number().int().min(10).max(60_000),
    capDelayMs: z.number().int().min(10).max(120_000),
    jitter: z.number().min(0).max(1),
    maxRetryAfterMs: z.number().int().min(0).max(300_000),
    httpTimeoutMs: z.number().int().min(100).max(LIMITS.httpTimeoutHardCapMs),
    chaosRate: z.number().min(0).max(0.9),
  })
  .partial()
  .strict();
export type RunConfigInput = z.infer<typeof runConfigInputSchema>;

export function resolveRunConfig(input: RunConfigInput | undefined, type: ScenarioType | 'custom'): RunConfig {
  const parsed = runConfigInputSchema.parse(input ?? {});
  const config: RunConfig = { ...DEFAULT_RUN_CONFIG, ...parsed };
  if (config.capDelayMs < config.baseDelayMs) config.capDelayMs = config.baseDelayMs;
  if (type !== 'healthy') config.chaosRate = 0;
  return config;
}

export interface EventSpec {
  type: EventType;
  aggregateId: string;
  sequence: number;
  data: unknown;
  /** Number of deliveries created for this event (>1 only for duplicate_storm). */
  deliveries: number;
}

export type ScenarioStep =
  | { kind: 'emit'; events: EventSpec[] }
  | { kind: 'await_terminal' }
  | { kind: 'set_phase'; phase: number }
  | { kind: 'replay_dead' };

export interface AssertionSpec {
  key: string;
  label: string;
  /** Dot path into RunMetrics. */
  metric: string;
  /** Constant expectation (number or string)... */
  expected?: number | string;
  /** ...or compare against another metric (used where the expectation depends on observed state). */
  expectedMetric?: string;
}

export interface Blueprint {
  type: ScenarioType;
  seed: number;
  config: RunConfig;
  faultPlan: FaultPlan;
  steps: ScenarioStep[];
  assertions: AssertionSpec[];
}

export interface ScenarioCatalogEntry {
  type: ScenarioType;
  title: string;
  summary: string;
  /** What the dashboard should show when the scenario passes. */
  expectation: string;
  configurable: Array<keyof RunConfig>;
}

export const SCENARIO_CATALOG: ScenarioCatalogEntry[] = [
  {
    type: 'healthy',
    title: 'Healthy',
    summary: 'Receiver answers 200. One delivery per event, one business effect per event.',
    expectation: 'All deliveries succeed on attempt 1; effects = events.',
    configurable: ['eventCount', 'chaosRate'],
  },
  {
    type: 'fail_twice',
    title: 'Fail twice then recover',
    summary: 'Receiver returns 500 before commit on attempts 1 and 2, then succeeds on attempt 3.',
    expectation: 'Exactly 3 attempts per delivery, 1 effect per event.',
    configurable: ['eventCount', 'baseDelayMs', 'jitter'],
  },
  {
    type: 'duplicate_storm',
    title: 'Duplicate storm',
    summary: 'The same event (same eventId and payload) is delivered many times concurrently.',
    expectation: 'All requests reach the receiver, exactly 1 effect and N-1 duplicates.',
    configurable: ['duplicateCount'],
  },
  {
    type: 'timeout_after_commit',
    title: 'Timeout after commit',
    summary:
      'Receiver commits the business effect, then answers slower than the HTTP timeout. The sender times out and retries.',
    expectation: 'Attempt 1 times out (outcome unknown at sender), retry succeeds, still 1 effect.',
    configurable: ['eventCount', 'httpTimeoutMs', 'baseDelayMs'],
  },
  {
    type: 'out_of_order',
    title: 'Out-of-order snapshots',
    summary: 'Order snapshots are deliberately received as sequence 3, 1, 2 (one after another).',
    expectation: 'Receive order is 3,1,2; projection stays at sequence 3; 2 stale snapshots ignored.',
    configurable: [],
  },
  {
    type: 'exhaust_and_replay',
    title: 'Exhaust retries and replay',
    summary:
      'Fixture always returns 500 until the retry budget is spent (dead letter). The fixture then turns healthy and the dead delivery is replayed.',
    expectation: 'Original delivery stays dead with full history; the replay delivery succeeds.',
    configurable: ['eventCount', 'maxAttempts', 'baseDelayMs', 'capDelayMs', 'jitter'],
  },
  {
    type: 'invalid_signature',
    title: 'Invalid signature',
    summary: 'The sender signs with a wrong key. The receiver must reject with 401.',
    expectation: 'No marker and no effect at the receiver; delivery ends dead with a permanent error.',
    configurable: ['eventCount'],
  },
];

function counterEvents(count: number, deliveries = 1): EventSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    type: EVENT_TYPES.counterIncrement,
    aggregateId: 'counter-demo',
    sequence: i + 1,
    data: { delta: 1 },
    deliveries,
  }));
}

function orderSnapshot(sequence: number, status: 'created' | 'paid' | 'shipped'): EventSpec {
  return {
    type: EVENT_TYPES.orderSnapshot,
    aggregateId: 'order-1001',
    sequence,
    data: {
      orderId: 'order-1001',
      status,
      items: [{ sku: 'SKU-CHAOS-1', qty: sequence }],
      totalCents: 1500 * sequence,
    },
    deliveries: 1,
  };
}

const EMIT_AND_WAIT = (events: EventSpec[]): ScenarioStep[] => [
  { kind: 'emit', events },
  { kind: 'await_terminal' },
];

export function buildBlueprint(type: ScenarioType, seed: number, input?: RunConfigInput): Blueprint {
  const config = resolveRunConfig(input, type);
  const n = config.eventCount;

  switch (type) {
    case 'healthy': {
      const plan: FaultPlan = { seed, rules: [] };
      if (config.chaosRate > 0) plan.randomFailure = { rate: config.chaosRate, status: 500 };
      const chaos = config.chaosRate > 0;
      return {
        type,
        seed,
        config,
        faultPlan: plan,
        steps: EMIT_AND_WAIT(counterEvents(n)),
        assertions: chaos
          ? [
              { key: 'all_terminal', label: 'Every delivery reached a terminal state', metric: 'deliveries.nonTerminal', expected: 0 },
              { key: 'effects_match_success', label: 'Business effects equal succeeded deliveries', metric: 'businessEffects', expectedMetric: 'deliveries.succeeded' },
              { key: 'events', label: 'Events created', metric: 'events', expected: n },
            ]
          : [
              { key: 'succeeded', label: 'Deliveries succeeded', metric: 'deliveries.succeeded', expected: n },
              { key: 'dead', label: 'Deliveries dead', metric: 'deliveries.dead', expected: 0 },
              { key: 'attempts', label: 'HTTP attempts', metric: 'attempts.total', expected: n },
              { key: 'effects', label: 'Business effects', metric: 'businessEffects', expected: n },
              { key: 'duplicates', label: 'Receiver duplicates', metric: 'receiver.byResult.duplicate', expected: 0 },
            ],
      };
    }
    case 'fail_twice':
      return {
        type,
        seed,
        config,
        faultPlan: {
          seed,
          rules: [{ attemptNo: { from: 1, to: 2 }, action: { kind: 'respond', status: 500 } }],
        },
        steps: EMIT_AND_WAIT(counterEvents(n)),
        assertions: [
          { key: 'succeeded', label: 'Deliveries succeeded', metric: 'deliveries.succeeded', expected: n },
          { key: 'attempts', label: 'HTTP attempts (3 per delivery)', metric: 'attempts.total', expected: 3 * n },
          { key: 'max_per_delivery', label: 'Max attempts on one delivery', metric: 'attempts.maxPerDelivery', expected: 3 },
          { key: 'receiver_500', label: 'Receiver injected 500s', metric: 'receiver.byResult.injected_failure', expected: 2 * n },
          { key: 'effects', label: 'Business effects', metric: 'businessEffects', expected: n },
        ],
      };
    case 'duplicate_storm': {
      const d = config.duplicateCount;
      return {
        type,
        seed,
        config,
        faultPlan: { seed, rules: [] },
        steps: EMIT_AND_WAIT(counterEvents(1, d)),
        assertions: [
          { key: 'deliveries', label: 'Deliveries for the single event', metric: 'deliveries.total', expected: d },
          { key: 'succeeded', label: 'Deliveries succeeded', metric: 'deliveries.succeeded', expected: d },
          { key: 'requests', label: 'Requests received', metric: 'receiver.requests', expected: d },
          { key: 'effects', label: 'Business effects', metric: 'businessEffects', expected: 1 },
          { key: 'duplicates', label: 'Receiver duplicates', metric: 'receiver.byResult.duplicate', expected: d - 1 },
        ],
      };
    }
    case 'timeout_after_commit':
      return {
        type,
        seed,
        config,
        faultPlan: {
          seed,
          rules: [
            {
              attemptNo: 1,
              action: { kind: 'commit_then_delay', delayMs: config.httpTimeoutMs + 1500 },
            },
          ],
        },
        steps: EMIT_AND_WAIT(counterEvents(n)),
        assertions: [
          { key: 'succeeded', label: 'Deliveries succeeded', metric: 'deliveries.succeeded', expected: n },
          { key: 'attempts', label: 'HTTP attempts (2 per delivery)', metric: 'attempts.total', expected: 2 * n },
          { key: 'timeouts', label: 'Attempts that timed out (outcome unknown at sender)', metric: 'attempts.byOutcome.timeout', expected: n },
          { key: 'requests', label: 'Requests received', metric: 'receiver.requests', expected: 2 * n },
          { key: 'duplicates', label: 'Receiver duplicates (retry after commit)', metric: 'receiver.byResult.duplicate', expected: n },
          { key: 'effects', label: 'Business effects', metric: 'businessEffects', expected: n },
        ],
      };
    case 'out_of_order':
      return {
        type,
        seed,
        config,
        faultPlan: { seed, rules: [] },
        steps: [
          ...EMIT_AND_WAIT([orderSnapshot(3, 'shipped')]),
          ...EMIT_AND_WAIT([orderSnapshot(1, 'created')]),
          ...EMIT_AND_WAIT([orderSnapshot(2, 'paid')]),
        ],
        assertions: [
          { key: 'receive_order', label: 'Receive order (event sequence)', metric: 'receiver.receiveOrder', expected: '3,1,2' },
          { key: 'projection', label: 'Order projection sequence', metric: 'projections.orderSequence', expected: 3 },
          { key: 'processed', label: 'Snapshots applied', metric: 'receiver.byResult.processed', expected: 1 },
          { key: 'stale', label: 'Stale snapshots ignored', metric: 'receiver.byResult.stale', expected: 2 },
          { key: 'effects', label: 'Business effects', metric: 'businessEffects', expected: 1 },
          { key: 'succeeded', label: 'Deliveries succeeded', metric: 'deliveries.succeeded', expected: 3 },
        ],
      };
    case 'exhaust_and_replay':
      return {
        type,
        seed,
        config,
        faultPlan: { seed, rules: [{ phase: 1, action: { kind: 'respond', status: 500 } }] },
        steps: [
          ...EMIT_AND_WAIT(counterEvents(n)),
          { kind: 'set_phase', phase: 2 },
          { kind: 'replay_dead' },
          { kind: 'await_terminal' },
        ],
        assertions: [
          { key: 'dead', label: 'Original deliveries dead (history kept)', metric: 'deliveries.dead', expected: n },
          { key: 'succeeded', label: 'Replay deliveries succeeded', metric: 'deliveries.succeeded', expected: n },
          { key: 'lineage', label: 'Dead deliveries with a replay child', metric: 'lineage.deadWithReplay', expected: n },
          { key: 'attempts', label: 'HTTP attempts (budget + 1 replay each)', metric: 'attempts.total', expected: n * (config.maxAttempts + 1) },
          { key: 'receiver_500', label: 'Receiver injected 500s', metric: 'receiver.byResult.injected_failure', expected: n * config.maxAttempts },
          { key: 'effects', label: 'Business effects', metric: 'businessEffects', expected: n },
        ],
      };
    case 'invalid_signature':
      return {
        type,
        seed,
        config,
        faultPlan: { seed, rules: [{ action: { kind: 'sign_invalid' } }] },
        steps: EMIT_AND_WAIT(counterEvents(n)),
        assertions: [
          { key: 'dead', label: 'Deliveries dead', metric: 'deliveries.dead', expected: n },
          { key: 'permanent', label: 'Dead with permanent_failure', metric: 'deliveries.deadByReason.permanent_failure', expected: n },
          { key: 'attempts', label: 'HTTP attempts (no retry)', metric: 'attempts.total', expected: n },
          { key: 'rejected', label: 'Receiver rejected signature', metric: 'receiver.byResult.rejected_signature', expected: n },
          { key: 'processed', label: 'Receiver processed', metric: 'receiver.byResult.processed', expected: 0 },
          { key: 'effects', label: 'Business effects', metric: 'businessEffects', expected: 0 },
        ],
      };
  }
}
