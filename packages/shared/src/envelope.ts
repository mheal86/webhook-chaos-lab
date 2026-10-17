import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EVENT_TYPES, LIMITS } from './constants';

export const counterDataSchema = z.object({
  delta: z.number().int().min(-1_000_000).max(1_000_000),
});

export const orderStatusSchema = z.enum(['created', 'paid', 'shipped', 'delivered', 'cancelled']);

export const orderDataSchema = z.object({
  orderId: z.string().min(1).max(64),
  status: orderStatusSchema,
  items: z
    .array(z.object({ sku: z.string().min(1).max(64), qty: z.number().int().min(1).max(1000) }))
    .max(50),
  totalCents: z.number().int().min(0).max(100_000_000),
});

export const envelopeSchema = z
  .object({
    id: z.uuid(),
    type: z.enum([EVENT_TYPES.counterIncrement, EVENT_TYPES.orderSnapshot]),
    runId: z.uuid(),
    aggregateId: z.string().min(1).max(128),
    sequence: z.number().int().min(0),
    occurredAt: z.iso.datetime(),
    data: z.unknown(),
  })
  .superRefine((value, ctx) => {
    const schema =
      value.type === EVENT_TYPES.counterIncrement ? counterDataSchema : orderDataSchema;
    const parsed = schema.safeParse(value.data);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: 'custom', path: ['data', ...issue.path], message: issue.message });
      }
    }
  });

export type EventEnvelope = {
  id: string;
  type: (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];
  runId: string;
  aggregateId: string;
  sequence: number;
  occurredAt: string;
  data: unknown;
};

export type CounterData = z.infer<typeof counterDataSchema>;
export type OrderData = z.infer<typeof orderDataSchema>;

/**
 * Serialize once. The resulting string is what gets stored (`events.raw_payload`),
 * hashed, signed and sent on every attempt - retries and replays never re-serialize.
 */
export function serializeEnvelope(envelope: EventEnvelope): string {
  // Key order is fixed explicitly so the same envelope always yields the same bytes.
  return JSON.stringify({
    id: envelope.id,
    type: envelope.type,
    runId: envelope.runId,
    aggregateId: envelope.aggregateId,
    sequence: envelope.sequence,
    occurredAt: envelope.occurredAt,
    data: envelope.data,
  });
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function payloadByteLength(raw: string): number {
  return Buffer.byteLength(raw, 'utf8');
}

export function isPayloadWithinLimit(raw: string): boolean {
  return payloadByteLength(raw) <= LIMITS.maxPayloadBytes;
}

/** Deterministic UUID (v4-shaped) derived from a string; used for reproducible scenario event ids. */
export function deterministicUuid(seedMaterial: string): string {
  const hex = createHash('sha256').update(seedMaterial).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16]!, 16) % 4]!;
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
