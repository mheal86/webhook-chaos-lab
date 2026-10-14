import { randomUUID } from 'node:crypto';
import type { AttemptDecision } from '@lab/shared';
import { Prisma, TX_OPTIONS, type Db, type Tx } from '../client';
import { jobIdFor } from './events';

export interface AttemptObservation {
  httpStatus: number | null;
  errorCode: string | null;
  durationMs: number | null;
  responsePreview: string | null;
}

interface DeliveryAfterUpdate {
  generation: number;
  next_attempt_at: Date | null;
}

/**
 * Applies the outcome of an attempt to the delivery and its attempt row. Must run inside a
 * transaction. `fence` restricts which delivery row may be updated (claim token match for a live
 * worker, expired lease for the recovery scheduler). Returns false when the fence did not match.
 */
export async function applyAttemptDecision(
  tx: Tx,
  p: {
    deliveryId: string;
    attemptNo: number;
    decision: AttemptDecision;
    observation: AttemptObservation;
    fence: Prisma.Sql;
  },
): Promise<boolean> {
  const { deliveryId, attemptNo, decision, observation, fence } = p;
  let after: DeliveryAfterUpdate | undefined;

  if (decision.kind === 'succeeded') {
    [after] = await tx.$queryRaw<DeliveryAfterUpdate[]>`
      UPDATE deliveries
      SET state = 'succeeded', claim_token = NULL, lease_until = NULL, next_attempt_at = NULL,
          last_error_code = NULL, terminal_reason = NULL, finished_at = now(), updated_at = now()
      WHERE id = ${deliveryId} AND state = 'in_flight' AND ${fence}
      RETURNING generation, next_attempt_at`;
  } else if (decision.kind === 'retry') {
    [after] = await tx.$queryRaw<DeliveryAfterUpdate[]>`
      UPDATE deliveries
      SET state = 'retry_wait', claim_token = NULL, lease_until = NULL,
          next_attempt_at = now() + (${decision.delayMs}::int * interval '1 millisecond'),
          generation = generation + 1, last_error_code = ${decision.errorCode}, updated_at = now()
      WHERE id = ${deliveryId} AND state = 'in_flight' AND ${fence}
      RETURNING generation, next_attempt_at`;
  } else {
    [after] = await tx.$queryRaw<DeliveryAfterUpdate[]>`
      UPDATE deliveries
      SET state = 'dead', claim_token = NULL, lease_until = NULL, next_attempt_at = NULL,
          terminal_reason = ${decision.reason}, last_error_code = ${decision.errorCode},
          finished_at = now(), updated_at = now()
      WHERE id = ${deliveryId} AND state = 'in_flight' AND ${fence}
      RETURNING generation, next_attempt_at`;
  }
  if (!after) return false;

  const retry = decision.kind === 'retry' ? decision : null;
  await tx.$executeRaw`
    UPDATE delivery_attempts
    SET finished_at = now(),
        outcome = ${decision.outcome}::"AttemptOutcome",
        http_status = ${observation.httpStatus},
        error_code = ${observation.errorCode ?? (decision.kind === 'succeeded' ? null : decision.errorCode)},
        duration_ms = ${observation.durationMs},
        response_preview = ${observation.responsePreview},
        retry_after_applied = ${retry?.retryAfterApplied ?? false},
        scheduled_retry_at = ${retry ? after.next_attempt_at : null}
    WHERE delivery_id = ${deliveryId} AND attempt_no = ${attemptNo} AND outcome = 'in_progress'`;

  if (retry && after.next_attempt_at) {
    await tx.$executeRaw`
      INSERT INTO outbox (id, delivery_id, generation, available_at, status, job_id, created_at)
      VALUES (${randomUUID()}, ${deliveryId}, ${after.generation}, ${after.next_attempt_at}, 'pending',
              ${jobIdFor(deliveryId, after.generation)}, now())`;
  }
  return true;
}

/**
 * Records the result of an attempt. Fenced by the claim token: a worker whose lease was taken over
 * (recovery already marked its attempt worker_lost and issued a new generation) can never overwrite
 * the newer delivery state; its result is kept on the attempt row as informational `late_result`.
 */
export async function completeAttempt(
  db: Db,
  p: {
    deliveryId: string;
    attemptNo: number;
    claimToken: string;
    decision: AttemptDecision;
    observation: AttemptObservation;
  },
): Promise<{ applied: boolean }> {
  return db.$transaction(async (tx) => {
    const applied = await applyAttemptDecision(tx, {
      deliveryId: p.deliveryId,
      attemptNo: p.attemptNo,
      decision: p.decision,
      observation: p.observation,
      fence: Prisma.sql`claim_token = ${p.claimToken}`,
    });
    if (!applied) {
      const late = JSON.stringify({
        receivedAt: new Date().toISOString(),
        httpStatus: p.observation.httpStatus,
        errorCode: p.observation.errorCode,
      });
      await tx.$executeRaw`
        UPDATE delivery_attempts SET late_result = ${late}::jsonb
        WHERE delivery_id = ${p.deliveryId} AND attempt_no = ${p.attemptNo}
          AND claim_token = ${p.claimToken} AND outcome <> 'in_progress' AND late_result IS NULL`;
    }
    return { applied };
  }, TX_OPTIONS);
}
