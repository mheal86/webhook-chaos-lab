import { randomUUID } from 'node:crypto';
import type { FaultPlan, RunConfig } from '@lab/shared';
import type { Db } from '../client';
import { TX_OPTIONS } from '../client';

export interface ClaimedDelivery {
  deliveryId: string;
  eventId: string;
  runId: string;
  endpointId: string;
  attemptNo: number;
  maxAttempts: number;
  generation: number;
  ordinal: number;
  claimToken: string;
  attemptId: string;
}

export type ClaimRejection =
  'not_found' | 'stale_generation' | 'terminal' | 'held_by_other' | 'not_due' | 'budget_exhausted';

export type ClaimResult =
  { claimed: true; claim: ClaimedDelivery } | { claimed: false; reason: ClaimRejection };

interface ClaimRow {
  id: string;
  event_id: string;
  run_id: string;
  endpoint_id: string;
  attempt_count: number;
  max_attempts: number;
  generation: number;
  ordinal: number;
}

/**
 * Atomically claims a delivery for one HTTP attempt.
 *
 * A single conditional UPDATE decides: the delivery must carry the job's generation, be waiting
 * (queued / retry_wait), be due and still have budget. The claim installs a fresh fencing token and
 * a lease, consumes one unit of attempt budget and inserts the attempt row - all in one short
 * transaction. No transaction is held while the HTTP request is in flight.
 */
export async function claimDelivery(
  db: Db,
  params: { deliveryId: string; generation: number; leaseMs: number },
): Promise<ClaimResult> {
  const claimToken = randomUUID();
  const attemptId = randomUUID();

  const result = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimRow[]>`
      UPDATE deliveries
      SET state = 'in_flight',
          claim_token = ${claimToken},
          lease_until = now() + (${params.leaseMs}::int * interval '1 millisecond'),
          attempt_count = attempt_count + 1,
          updated_at = now()
      WHERE id = ${params.deliveryId}
        AND generation = ${params.generation}
        AND state IN ('queued', 'retry_wait')
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        AND attempt_count < max_attempts
      RETURNING id, event_id, run_id, endpoint_id, attempt_count, max_attempts, generation, ordinal`;
    const row = rows[0];
    if (!row) return null;

    await tx.$executeRaw`
      INSERT INTO delivery_attempts (id, delivery_id, run_id, attempt_no, generation, claim_token,
                                     started_at, outcome)
      VALUES (${attemptId}, ${row.id}, ${row.run_id}, ${row.attempt_count}, ${row.generation},
              ${claimToken}, now(), 'in_progress')`;
    return row;
  }, TX_OPTIONS);

  if (result) {
    return {
      claimed: true,
      claim: {
        deliveryId: result.id,
        eventId: result.event_id,
        runId: result.run_id,
        endpointId: result.endpoint_id,
        attemptNo: result.attempt_count,
        maxAttempts: result.max_attempts,
        generation: result.generation,
        ordinal: result.ordinal,
        claimToken,
        attemptId,
      },
    };
  }
  return {
    claimed: false,
    reason: await diagnoseRejection(db, params.deliveryId, params.generation),
  };
}

async function diagnoseRejection(
  db: Db,
  deliveryId: string,
  generation: number,
): Promise<ClaimRejection> {
  const rows = await db.$queryRaw<
    Array<{
      generation: number;
      state: string;
      attempt_count: number;
      max_attempts: number;
      due: boolean;
    }>
  >`SELECT generation, state, attempt_count, max_attempts,
           (next_attempt_at IS NULL OR next_attempt_at <= now()) AS due
    FROM deliveries WHERE id = ${deliveryId}`;
  const row = rows[0];
  if (!row) return 'not_found';
  if (row.state === 'succeeded' || row.state === 'dead') return 'terminal';
  if (row.generation !== generation) return 'stale_generation';
  if (row.state === 'in_flight') return 'held_by_other';
  if (row.attempt_count >= row.max_attempts) return 'budget_exhausted';
  return 'not_due';
}

export interface SendContext {
  rawPayload: string;
  payloadHash: string;
  correlationId: string | null;
  eventType: string;
  eventSequence: number;
  logicalIndex: number;
  endpoint: { id: string; consumerId: string; url: string; secretRef: string; enabled: boolean };
  run: { id: string; seed: number; phase: number; config: RunConfig; faultPlan: FaultPlan };
}

interface SendContextRow {
  raw_payload: string;
  payload_hash: string;
  correlation_id: string | null;
  event_type: string;
  event_sequence: number;
  logical_index: number;
  endpoint_id: string;
  consumer_id: string;
  url: string;
  secret_ref: string;
  enabled: boolean;
  run_id: string;
  seed: number;
  phase: number;
  config: RunConfig;
  fault_plan: FaultPlan;
}

/** Everything the worker needs to send one attempt (read after the claim, outside any transaction). */
export async function loadSendContext(db: Db, claim: ClaimedDelivery): Promise<SendContext> {
  const rows = await db.$queryRaw<SendContextRow[]>`
    SELECT e.raw_payload, e.payload_hash, e.correlation_id, e.type AS event_type,
           e.sequence AS event_sequence, e.logical_index,
           ep.id AS endpoint_id, ep.consumer_id, ep.url, ep.secret_ref, ep.enabled,
           r.id AS run_id, r.seed, r.phase, r.config, r.fault_plan
    FROM deliveries d
    JOIN events e ON e.id = d.event_id
    JOIN endpoints ep ON ep.id = d.endpoint_id
    JOIN scenario_runs r ON r.id = d.run_id
    WHERE d.id = ${claim.deliveryId}`;
  const row = rows[0];
  if (!row) throw new Error(`delivery ${claim.deliveryId} vanished after claim`);
  return {
    rawPayload: row.raw_payload,
    payloadHash: row.payload_hash,
    correlationId: row.correlation_id,
    eventType: row.event_type,
    eventSequence: row.event_sequence,
    logicalIndex: row.logical_index,
    endpoint: {
      id: row.endpoint_id,
      consumerId: row.consumer_id,
      url: row.url,
      secretRef: row.secret_ref,
      enabled: row.enabled,
    },
    run: {
      id: row.run_id,
      seed: row.seed,
      phase: row.phase,
      config: row.config,
      faultPlan: row.fault_plan,
    },
  };
}
