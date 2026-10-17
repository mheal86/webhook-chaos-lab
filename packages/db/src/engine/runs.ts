import { randomUUID } from 'node:crypto';
import {
  deterministicUuid,
  type AssertionResult,
  type AssertionSpec,
  type Blueprint,
  type RunStatus,
  type RunType,
  type ScenarioStep,
} from '@lab/shared';
import { TX_OPTIONS, isUniqueViolation, type Db, type Tx } from '../client';
import { DomainError } from '../errors';
import { insertEventWithDeliveries } from './events';
import { computeRunMetrics, evaluateAssertions } from './metrics';
import { replayDeliveryTx } from './replay';

/**
 * Creates a run in `running` state and executes its first steps. A partial unique index allows at
 * most one `running` run, so a second concurrent run fails with `run_already_active`.
 */
export async function createRun(
  db: Db,
  p: { blueprint: Blueprint; runType?: RunType; runId?: string },
): Promise<{ runId: string }> {
  const runId = p.runId ?? randomUUID();
  const { blueprint } = p;
  try {
    await db.scenarioRun.create({
      data: {
        id: runId,
        type: p.runType ?? blueprint.type,
        status: 'running',
        seed: blueprint.seed,
        phase: 1,
        config: blueprint.config as never,
        faultPlan: blueprint.faultPlan as never,
        steps: blueprint.steps as never,
        stepIndex: 0,
        expected: blueprint.assertions as never,
        startedAt: new Date(),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new DomainError(
        'run_already_active',
        'another run is still active; wait for it to finish',
      );
    }
    throw err;
  }
  await advanceRun(db, runId);
  return { runId };
}

interface RunRow {
  id: string;
  status: RunStatus;
  seed: number;
  phase: number;
  config: { maxAttempts: number };
  steps: ScenarioStep[];
  step_index: number;
  expected: AssertionSpec[];
  elapsed_ms: number;
}

/**
 * Drives a run forward as far as it can go in one transaction: emits events, waits for terminal
 * deliveries, flips the fixture phase, replays dead deliveries and finally evaluates the
 * expected-vs-actual assertions. Idempotent; safe to call from several processes (row lock).
 */
export async function advanceRun(
  db: Db,
  runId: string,
  opts: { runTimeoutMs?: number } = {},
): Promise<{ status: RunStatus | 'missing' }> {
  const timeoutMs = opts.runTimeoutMs ?? 300_000;
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<RunRow[]>`
      SELECT id, status::text AS status, seed, phase, config, steps, step_index, expected,
             (EXTRACT(EPOCH FROM (now() - COALESCE(started_at, created_at))) * 1000)::int AS elapsed_ms
      FROM scenario_runs WHERE id = ${runId} FOR UPDATE`;
    const run = rows[0];
    if (!run) return { status: 'missing' as const };
    if (run.status !== 'running') return { status: run.status };

    let stepIndex = run.step_index;
    let finished = false;
    while (stepIndex < run.steps.length) {
      const step = run.steps[stepIndex]!;
      if (step.kind === 'await_terminal') {
        const [{ n }] = await tx.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM deliveries
          WHERE run_id = ${runId} AND state NOT IN ('succeeded', 'dead')`;
        if (n > 0) break;
      } else if (step.kind === 'emit') {
        await emitStep(tx, runId, step, run.config.maxAttempts);
      } else if (step.kind === 'set_phase') {
        await tx.$executeRaw`UPDATE scenario_runs SET phase = ${step.phase} WHERE id = ${runId}`;
      } else if (step.kind === 'replay_dead') {
        const dead = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT d.id FROM deliveries d
          WHERE d.run_id = ${runId} AND d.state = 'dead'
            AND NOT EXISTS (SELECT 1 FROM deliveries c WHERE c.replay_of_delivery_id = d.id)
          ORDER BY d.created_at, d.id`;
        for (const d of dead) await replayDeliveryTx(tx, d.id);
      }
      stepIndex++;
    }
    finished = stepIndex >= run.steps.length;

    if (finished) {
      return finalizeRun(tx, runId, run.expected, stepIndex, null);
    }
    if (run.elapsed_ms > timeoutMs) {
      return finalizeRun(tx, runId, run.expected, stepIndex, 'run_timeout');
    }
    if (stepIndex !== run.step_index) {
      await tx.$executeRaw`UPDATE scenario_runs SET step_index = ${stepIndex} WHERE id = ${runId}`;
    }
    return { status: 'running' as const };
  }, TX_OPTIONS);
}

async function emitStep(
  tx: Tx,
  runId: string,
  step: Extract<ScenarioStep, { kind: 'emit' }>,
  maxAttempts: number,
): Promise<void> {
  const endpoints = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM endpoints WHERE enabled = true ORDER BY consumer_id`;
  if (endpoints.length === 0) throw new DomainError('invalid', 'no enabled endpoint is configured');
  const [{ n }] = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM events WHERE run_id = ${runId}`;
  let logicalIndex = n;
  for (const spec of step.events) {
    await insertEventWithDeliveries(tx, {
      runId,
      eventId: deterministicUuid(`${runId}:${logicalIndex}`),
      type: spec.type,
      aggregateId: spec.aggregateId,
      sequence: spec.sequence,
      data: spec.data,
      logicalIndex,
      endpointIds: endpoints.map((e) => e.id),
      copies: spec.deliveries,
      maxAttempts,
    });
    logicalIndex++;
  }
}

async function finalizeRun(
  tx: Tx,
  runId: string,
  expected: AssertionSpec[],
  stepIndex: number,
  failureReason: string | null,
): Promise<{ status: RunStatus }> {
  const metrics = await computeRunMetrics(tx, runId);
  const results: AssertionResult[] = evaluateAssertions(expected, metrics, true);
  const passed = failureReason === null && results.every((r) => r.status === 'passed');
  const status: RunStatus = passed ? 'passed' : 'failed';
  await tx.$executeRaw`
    UPDATE scenario_runs
    SET status = ${status}::"RunStatus", step_index = ${stepIndex}, finished_at = now(),
        result = ${JSON.stringify({ assertions: results, metrics })}::jsonb,
        failure_reason = ${failureReason}
    WHERE id = ${runId}`;
  return { status };
}

export async function listRunningRunIds(db: Db): Promise<string[]> {
  const rows = await db.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM scenario_runs WHERE status = 'running'`;
  return rows.map((r) => r.id);
}
