import {
  ATTEMPT_OUTCOMES,
  RECEIVER_RESULTS,
  type AssertionResult,
  type AssertionSpec,
  type AttemptOutcome,
  type ReceiverResult,
  type RunMetrics,
} from '@lab/shared';
import type { DbOrTx } from '../client';

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

/**
 * Metric definitions (all scoped to one run):
 * - delivery success  = deliveries in state `succeeded` (a delivery may need several HTTP attempts)
 * - attempt success   = attempts with outcome `success` (HTTP 2xx)
 * - business effects  = rows in `business_effects` written by the receiver transaction
 * These three numbers are intentionally different things.
 * - latency p95       = nearest-rank (percentile_disc 0.95) of attempt duration, over attempts of this
 *   run that received an HTTP response (timeouts / network errors / lost workers are excluded).
 */
export async function computeRunMetrics(db: DbOrTx, runId: string): Promise<RunMetrics> {
  const [events] = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM events WHERE run_id = ${runId}`;

  const deliveryRows = await db.$queryRaw<Array<{ state: string; terminal_reason: string | null; n: number }>>`
    SELECT state::text AS state, terminal_reason, count(*)::int AS n
    FROM deliveries WHERE run_id = ${runId} GROUP BY 1, 2`;
  const deliveries: RunMetrics['deliveries'] = {
    total: 0,
    queued: 0,
    in_flight: 0,
    retry_wait: 0,
    succeeded: 0,
    dead: 0,
    nonTerminal: 0,
    deadByReason: {},
  };
  for (const r of deliveryRows) {
    deliveries.total += r.n;
    (deliveries as unknown as Record<string, number>)[r.state] += r.n;
    if (r.state !== 'succeeded' && r.state !== 'dead') deliveries.nonTerminal += r.n;
    if (r.state === 'dead') {
      const reason = r.terminal_reason ?? 'unknown';
      deliveries.deadByReason[reason] = (deliveries.deadByReason[reason] ?? 0) + r.n;
    }
  }

  const attemptRows = await db.$queryRaw<Array<{ outcome: AttemptOutcome; n: number }>>`
    SELECT outcome::text AS outcome, count(*)::int AS n
    FROM delivery_attempts WHERE run_id = ${runId} GROUP BY 1`;
  const byOutcome = zeroed(ATTEMPT_OUTCOMES);
  let attemptsTotal = 0;
  for (const r of attemptRows) {
    byOutcome[r.outcome] = r.n;
    attemptsTotal += r.n;
  }
  const [maxPer] = await db.$queryRaw<Array<{ n: number }>>`
    SELECT COALESCE(max(c), 0)::int AS n
    FROM (SELECT count(*) AS c FROM delivery_attempts WHERE run_id = ${runId} GROUP BY delivery_id) t`;
  const [latency] = await db.$queryRaw<Array<{ p95: number | null; n: number }>>`
    SELECT percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95, count(*)::int AS n
    FROM delivery_attempts
    WHERE run_id = ${runId} AND duration_ms IS NOT NULL
      AND outcome IN ('success', 'http_retryable', 'http_permanent')`;

  const receiverRows = await db.$queryRaw<Array<{ result: ReceiverResult; n: number }>>`
    SELECT result::text AS result, count(*)::int AS n
    FROM receiver_requests WHERE run_id = ${runId} GROUP BY 1`;
  const byResult = zeroed(RECEIVER_RESULTS);
  let requests = 0;
  for (const r of receiverRows) {
    byResult[r.result] = r.n;
    requests += r.n;
  }
  const [order] = await db.$queryRaw<Array<{ order: string | null }>>`
    SELECT string_agg(event_sequence::text, ',' ORDER BY seq) AS "order"
    FROM receiver_requests
    WHERE run_id = ${runId} AND signature_valid IS TRUE AND event_sequence IS NOT NULL`;

  const [effects] = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM business_effects WHERE run_id = ${runId}`;
  const [counter] = await db.$queryRaw<Array<{ value: number }>>`
    SELECT value FROM counter_projections WHERE run_id = ${runId} ORDER BY updated_at DESC LIMIT 1`;
  const [orderProj] = await db.$queryRaw<Array<{ sequence: number }>>`
    SELECT sequence FROM order_projections WHERE run_id = ${runId} ORDER BY updated_at DESC LIMIT 1`;

  const [lineage] = await db.$queryRaw<Array<{ replays: number; dead_with_replay: number }>>`
    SELECT count(*)::int AS replays,
           count(DISTINCT c.replay_of_delivery_id) FILTER (WHERE p.state = 'dead')::int AS dead_with_replay
    FROM deliveries c JOIN deliveries p ON p.id = c.replay_of_delivery_id
    WHERE c.run_id = ${runId}`;

  return {
    runId,
    events: events?.n ?? 0,
    deliveries,
    attempts: {
      total: attemptsTotal,
      byOutcome,
      maxPerDelivery: maxPer?.n ?? 0,
      latency: {
        p95: latency?.p95 ?? null,
        sampleCount: latency?.n ?? 0,
        unit: 'ms',
        window: 'attempts of this run that received an HTTP response (success, http_retryable, http_permanent); run lifetime',
      },
    },
    receiver: { requests, byResult, receiveOrder: order?.order ?? '' },
    businessEffects: effects?.n ?? 0,
    projections: { counterValue: counter?.value ?? null, orderSequence: orderProj?.sequence ?? null },
    lineage: { replayDeliveries: lineage?.replays ?? 0, deadWithReplay: lineage?.dead_with_replay ?? 0 },
    generatedAt: new Date().toISOString(),
  };
}

function getPath(obj: unknown, path: string): number | string | null {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === 'number' || typeof cur === 'string' ? cur : null;
}

/**
 * While a run is active an assertion is `passed` as soon as actual == expected, otherwise `pending`.
 * Once the run is final, unmet assertions become `failed`.
 */
export function evaluateAssertions(
  specs: AssertionSpec[],
  metrics: RunMetrics,
  final: boolean,
): AssertionResult[] {
  return specs.map((spec) => {
    const actual = getPath(metrics, spec.metric);
    const expectedValue = spec.expectedMetric ? getPath(metrics, spec.expectedMetric) : (spec.expected ?? null);
    const met = actual !== null && expectedValue !== null && String(actual) === String(expectedValue);
    return {
      ...spec,
      actual,
      expectedValue,
      status: met ? 'passed' : final ? 'failed' : 'pending',
    };
  });
}
