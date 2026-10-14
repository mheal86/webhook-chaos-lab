import { randomUUID } from 'node:crypto';
import {
  envelopeSchema,
  isPayloadWithinLimit,
  serializeEnvelope,
  sha256Hex,
  type EventEnvelope,
  type EventType,
} from '@lab/shared';
import type { Tx } from '../client';
import { DomainError } from '../errors';

export interface NewEventParams {
  runId: string;
  eventId?: string;
  type: EventType;
  aggregateId: string;
  sequence: number;
  logicalIndex: number;
  data: unknown;
  occurredAt?: Date;
  correlationId?: string | null;
  /** Endpoints that receive the event. */
  endpointIds: string[];
  /** Deliveries per endpoint (>1 only for the duplicate scenario). */
  copies: number;
  maxAttempts: number;
}

export interface AcceptedEvent {
  eventId: string;
  rawPayload: string;
  payloadHash: string;
  deliveryIds: string[];
}

export function jobIdFor(deliveryId: string, generation: number): string {
  // BullMQ rejects custom job ids containing ':'.
  return `${deliveryId}_g${generation}`;
}

/**
 * Persists an event, its deliveries and one outbox row per delivery. The caller owns the
 * transaction: nothing is dispatched until that transaction commits, and the HTTP 202 is only
 * returned after the commit.
 */
export async function insertEventWithDeliveries(tx: Tx, p: NewEventParams): Promise<AcceptedEvent> {
  const eventId = p.eventId ?? randomUUID();
  const envelope: EventEnvelope = {
    id: eventId,
    type: p.type,
    runId: p.runId,
    aggregateId: p.aggregateId,
    sequence: p.sequence,
    occurredAt: (p.occurredAt ?? new Date()).toISOString(),
    data: p.data,
  };
  const parsed = envelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new DomainError(
      'invalid',
      'event does not match the envelope schema',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const rawPayload = serializeEnvelope(envelope);
  if (!isPayloadWithinLimit(rawPayload)) {
    throw new DomainError('payload_too_large', 'payload exceeds 64 KiB');
  }
  const payloadHash = sha256Hex(rawPayload);

  await tx.event.create({
    data: {
      id: eventId,
      runId: p.runId,
      type: p.type,
      aggregateId: p.aggregateId,
      sequence: p.sequence,
      logicalIndex: p.logicalIndex,
      occurredAt: new Date(envelope.occurredAt),
      rawPayload,
      payloadHash,
      correlationId: p.correlationId ?? null,
    },
  });

  const deliveryIds: string[] = [];
  for (const endpointId of p.endpointIds) {
    for (let ordinal = 1; ordinal <= p.copies; ordinal++) {
      const deliveryId = randomUUID();
      deliveryIds.push(deliveryId);
      await tx.$executeRaw`
        INSERT INTO deliveries (id, event_id, endpoint_id, run_id, ordinal, state, max_attempts,
                                next_attempt_at, generation, created_at, updated_at)
        VALUES (${deliveryId}, ${eventId}, ${endpointId}, ${p.runId}, ${ordinal}, 'queued', ${p.maxAttempts},
                now(), 1, now(), now())`;
      await tx.$executeRaw`
        INSERT INTO outbox (id, delivery_id, generation, available_at, status, job_id, created_at)
        VALUES (${randomUUID()}, ${deliveryId}, 1, now(), 'pending', ${jobIdFor(deliveryId, 1)}, now())`;
    }
  }
  return { eventId, rawPayload, payloadHash, deliveryIds };
}
