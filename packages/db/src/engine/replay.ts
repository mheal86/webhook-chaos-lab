import { randomUUID } from 'node:crypto';
import type { DeliveryState } from '@lab/shared';
import { TX_OPTIONS, type Db, type Tx } from '../client';
import { DomainError } from '../errors';
import { jobIdFor } from './events';
import { policyFromConfig } from './recovery';

export interface ReplayResult {
  deliveryId: string;
  replayOfDeliveryId: string;
  eventId: string;
  ordinal: number;
}

interface ParentRow {
  id: string;
  event_id: string;
  endpoint_id: string;
  run_id: string;
  state: DeliveryState;
  config: unknown;
}

/** Replays a terminal delivery inside the caller's transaction. */
export async function replayDeliveryTx(tx: Tx, deliveryId: string): Promise<ReplayResult> {
  // Lock the parent so two concurrent replay requests serialize.
  const parents = await tx.$queryRaw<ParentRow[]>`
    SELECT d.id, d.event_id, d.endpoint_id, d.run_id, d.state, r.config
    FROM deliveries d JOIN scenario_runs r ON r.id = d.run_id
    WHERE d.id = ${deliveryId}
    FOR UPDATE OF d`;
  const parent = parents[0];
  if (!parent) throw new DomainError('not_found', `delivery ${deliveryId} not found`);
  if (parent.state !== 'dead' && parent.state !== 'succeeded') {
    throw new DomainError('not_terminal', `delivery is ${parent.state}; only terminal deliveries can be replayed`);
  }

  const active = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM deliveries
    WHERE replay_of_delivery_id = ${deliveryId} AND state NOT IN ('succeeded', 'dead') LIMIT 1`;
  if (active.length > 0) {
    throw new DomainError('replay_in_progress', 'a replay of this delivery is still in progress');
  }

  const [{ next_ordinal }] = await tx.$queryRaw<Array<{ next_ordinal: number }>>`
    SELECT COALESCE(max(ordinal), 0)::int + 1 AS next_ordinal
    FROM deliveries WHERE event_id = ${parent.event_id} AND endpoint_id = ${parent.endpoint_id}`;

  const policy = policyFromConfig(parent.config as never);
  const newId = randomUUID();
  await tx.$executeRaw`
    INSERT INTO deliveries (id, event_id, endpoint_id, run_id, replay_of_delivery_id, ordinal, state,
                            max_attempts, next_attempt_at, generation, created_at, updated_at)
    VALUES (${newId}, ${parent.event_id}, ${parent.endpoint_id}, ${parent.run_id}, ${parent.id},
            ${next_ordinal}, 'queued', ${policy.maxAttempts}, now(), 1, now(), now())`;
  await tx.$executeRaw`
    INSERT INTO outbox (id, delivery_id, generation, available_at, status, job_id, created_at)
    VALUES (${randomUUID()}, ${newId}, 1, now(), 'pending', ${jobIdFor(newId, 1)}, now())`;

  return { deliveryId: newId, replayOfDeliveryId: parent.id, eventId: parent.event_id, ordinal: next_ordinal };
}

/**
 * Manual replay: same eventId and raw payload (the event row is untouched), a new deliveryId with a
 * fresh attempt budget and `replay_of_delivery_id` pointing at the original, which keeps its history.
 */
export async function replayDelivery(db: Db, deliveryId: string): Promise<ReplayResult> {
  return db.$transaction((tx) => replayDeliveryTx(tx, deliveryId), TX_OPTIONS);
}
