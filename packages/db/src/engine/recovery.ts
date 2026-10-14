import { randomUUID } from 'node:crypto';
import {
  decideAfterAttempt,
  jitterUnitFor,
  type RetryPolicy,
  type RunConfig,
} from '@lab/shared';
import { Prisma, TX_OPTIONS, type Db } from '../client';
import { applyAttemptDecision } from './complete';
import { jobIdFor } from './events';

export function policyFromConfig(config: RunConfig | null | undefined, maxAttempts?: number): RetryPolicy {
  const c = config as Partial<RunConfig> | null | undefined;
  return {
    maxAttempts: maxAttempts ?? c?.maxAttempts ?? 5,
    baseDelayMs: c?.baseDelayMs ?? 1000,
    capDelayMs: c?.capDelayMs ?? 30_000,
    jitter: c?.jitter ?? 0.2,
    maxRetryAfterMs: c?.maxRetryAfterMs ?? 60_000,
    httpTimeoutMs: c?.httpTimeoutMs ?? 2000,
  };
}

export interface RecoveryReport {
  leaseExpired: number;
  deadFromLeaseExpiry: number;
  redispatched: number;
  missingOutbox: number;
}

interface ExpiredRow {
  id: string;
  attempt_count: number;
  max_attempts: number;
  ordinal: number;
  logical_index: number;
  seed: number;
  config: RunConfig;
}

/**
 * Case 2 of the recovery scheduler: the worker died (or hung) while holding the delivery and its
 * lease ran out. The in-progress attempt becomes `worker_lost` (outcome unknown, budget stays
 * spent) and the delivery either gets a new generation + outbox row (retry) or goes dead.
 */
export async function recoverExpiredLeases(
  db: Db,
  limit = 50,
): Promise<{ recovered: number; dead: number }> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ExpiredRow[]>`
      SELECT d.id, d.attempt_count, d.max_attempts, d.ordinal, e.logical_index, r.seed, r.config
      FROM deliveries d
      JOIN events e ON e.id = d.event_id
      JOIN scenario_runs r ON r.id = d.run_id
      WHERE d.state = 'in_flight' AND d.lease_until < now()
      ORDER BY d.lease_until
      LIMIT ${limit}
      FOR UPDATE OF d SKIP LOCKED`;

    let recovered = 0;
    let dead = 0;
    for (const row of rows) {
      const policy = policyFromConfig(row.config, row.max_attempts);
      const decision = decideAfterAttempt({
        attemptNo: row.attempt_count,
        policy,
        nowMs: Date.now(),
        result: { kind: 'worker_lost' },
        jitterUnit: jitterUnitFor(row.seed, {
          eventIndex: row.logical_index,
          deliveryOrdinal: row.ordinal,
          attemptNo: row.attempt_count,
        }),
      });
      const applied = await applyAttemptDecision(tx, {
        deliveryId: row.id,
        attemptNo: row.attempt_count,
        decision,
        observation: { httpStatus: null, errorCode: 'worker_lost', durationMs: null, responsePreview: null },
        fence: Prisma.sql`lease_until < now()`,
      });
      if (applied) {
        recovered++;
        if (decision.kind === 'dead') dead++;
      }
    }
    return { recovered, dead };
  }, TX_OPTIONS);
}

/**
 * Case 1 of the recovery scheduler: the delivery was published but nothing claimed it within the
 * grace period (job lost - Redis flushed, queue state gone, worker never picked it up). A new
 * generation is issued with a fresh outbox row; any surviving old job is rejected by the claim.
 * Also repairs deliveries that are waiting without any outbox row for their current generation.
 */
export async function reissueLostDispatches(
  db: Db,
  graceMs: number,
  limit = 100,
): Promise<{ redispatched: number; missingOutbox: number }> {
  return db.$transaction(async (tx) => {
    const lost = await tx.$queryRaw<Array<{ id: string; generation: number }>>`
      SELECT d.id, d.generation
      FROM deliveries d
      JOIN outbox o ON o.delivery_id = d.id AND o.generation = d.generation
      WHERE d.state IN ('queued', 'retry_wait')
        AND o.status = 'published'
        AND o.published_at < now() - (${graceMs}::int * interval '1 millisecond')
      ORDER BY o.published_at
      LIMIT ${limit}
      FOR UPDATE OF d SKIP LOCKED`;

    for (const row of lost) {
      const newGeneration = row.generation + 1;
      await tx.$executeRaw`
        UPDATE deliveries SET generation = ${newGeneration}, updated_at = now() WHERE id = ${row.id}`;
      await tx.$executeRaw`
        INSERT INTO outbox (id, delivery_id, generation, available_at, status, job_id, created_at)
        VALUES (${randomUUID()}, ${row.id}, ${newGeneration}, now(), 'pending',
                ${jobIdFor(row.id, newGeneration)}, now())`;
    }

    const orphans = await tx.$queryRaw<Array<{ id: string; generation: number }>>`
      SELECT d.id, d.generation
      FROM deliveries d
      WHERE d.state IN ('queued', 'retry_wait')
        AND d.updated_at < now() - (${graceMs}::int * interval '1 millisecond')
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.delivery_id = d.id AND o.generation = d.generation)
      LIMIT ${limit}
      FOR UPDATE OF d SKIP LOCKED`;
    for (const row of orphans) {
      await tx.$executeRaw`
        INSERT INTO outbox (id, delivery_id, generation, available_at, status, job_id, created_at)
        VALUES (${randomUUID()}, ${row.id}, ${row.generation}, now(), 'pending',
                ${jobIdFor(row.id, row.generation)}, now())`;
    }
    return { redispatched: lost.length, missingOutbox: orphans.length };
  }, TX_OPTIONS);
}

export async function runRecoveryTick(db: Db, graceMs: number): Promise<RecoveryReport> {
  const leases = await recoverExpiredLeases(db);
  const lost = await reissueLostDispatches(db, graceMs);
  return {
    leaseExpired: leases.recovered,
    deadFromLeaseExpiry: leases.dead,
    redispatched: lost.redispatched,
    missingOutbox: lost.missingOutbox,
  };
}
