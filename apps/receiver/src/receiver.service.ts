import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type Db } from '@lab/db';
import {
  EVENT_TYPES,
  HEADERS,
  decideFault,
  envelopeSchema,
  errorFields,
  sha256Hex,
  verifySignature,
  type AppConfig,
  type FaultAction,
  type FaultPlan,
  type Logger,
  type ReceiverResult,
} from '@lab/shared';
import { APP_CONFIG, DB, LOGGER } from './tokens';

export interface WebhookInput {
  consumerId: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  nowMs?: number;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Delay applied before the response is written (commit_then_delay fault). */
  delayMs?: number;
}

class InjectedFailure extends Error {}

type ProcessOutcome = { result: 'processed' | 'duplicate' | 'stale' | 'conflict'; detail?: string };

function header(headers: WebhookInput['headers'], name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

@Injectable()
export class ReceiverService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async handleWebhook(input: WebhookInput): Promise<WebhookResponse> {
    const startedAt = Date.now();
    const requestId = randomUUID();
    const eventIdHeader = header(input.headers, HEADERS.eventId);
    const deliveryIdHeader = header(input.headers, HEADERS.deliveryId);
    const attemptNoRaw = header(input.headers, HEADERS.attemptNo);
    const attemptNo = attemptNoRaw && /^\d{1,4}$/.test(attemptNoRaw) ? Number(attemptNoRaw) : null;

    // Evidence row at arrival: even a request that kills the process leaves a trace.
    await this.db.$executeRaw`
      INSERT INTO receiver_requests (id, consumer_id, event_id, delivery_id, attempt_no, received_at, result, run_id)
      VALUES (${requestId}, ${input.consumerId}, ${eventIdHeader ?? null}, ${deliveryIdHeader ?? null},
              ${attemptNo}, now(), 'received',
              -- label the evidence row with the run even for requests rejected before the body is trusted
              (SELECT run_id FROM deliveries WHERE id = ${deliveryIdHeader ?? null}))`;

    const finish = async (
      result: ReceiverResult,
      status: number,
      detail: string | null,
      extra: { runId?: string; eventId?: string; eventSequence?: number; payloadHash?: string; signatureValid?: boolean } = {},
    ) => {
      await this.db.$executeRaw`
        UPDATE receiver_requests
        SET result = ${result}::"ReceiverResult", http_status = ${status}, detail = ${detail}, completed_at = now(),
            run_id = COALESCE(${extra.runId ?? null}, run_id),
            event_id = COALESCE(${extra.eventId ?? null}, event_id),
            event_sequence = COALESCE(${extra.eventSequence ?? null}, event_sequence),
            payload_hash = COALESCE(${extra.payloadHash ?? null}, payload_hash),
            signature_valid = COALESCE(${extra.signatureValid ?? null}, signature_valid)
        WHERE id = ${requestId}`;
      this.log.info('webhook handled', {
        requestId,
        result,
        status,
        detail,
        runId: extra.runId ?? null,
        eventId: extra.eventId ?? eventIdHeader ?? null,
        deliveryId: deliveryIdHeader ?? null,
        attemptNo,
        durationMs: Date.now() - startedAt,
      });
    };

    try {
      if (input.consumerId !== 'receiver-fixture') {
        await finish('rejected_bad_request', 404, 'unknown_consumer');
        return { status: 404, body: { error: 'unknown_consumer' } };
      }

      // 1) Signature over the raw bytes. Nothing is parsed or persisted before this passes.
      const verdict = verifySignature({
        secret: this.config.RECEIVER_SECRET,
        timestampHeader: header(input.headers, HEADERS.timestamp),
        signatureHeader: header(input.headers, HEADERS.signature),
        rawBody: input.rawBody,
        nowMs: input.nowMs ?? Date.now(),
      });
      if (!verdict.ok) {
        await finish('rejected_signature', 401, verdict.code, { signatureValid: false });
        return { status: 401, body: { error: 'invalid_signature', code: verdict.code } };
      }

      // 2) Envelope + header consistency.
      let json: unknown;
      try {
        json = JSON.parse(input.rawBody.toString('utf8'));
      } catch {
        await finish('rejected_bad_request', 400, 'invalid_json', { signatureValid: true });
        return { status: 400, body: { error: 'invalid_json' } };
      }
      const parsed = envelopeSchema.safeParse(json);
      if (!parsed.success) {
        await finish('rejected_bad_request', 400, 'invalid_envelope', { signatureValid: true });
        return { status: 400, body: { error: 'invalid_envelope' } };
      }
      const envelope = parsed.data;
      const base = {
        runId: envelope.runId,
        eventId: envelope.id,
        eventSequence: envelope.sequence,
        signatureValid: true,
      };
      if (eventIdHeader !== envelope.id) {
        await finish('rejected_bad_request', 400, 'event_id_header_mismatch', base);
        return { status: 400, body: { error: 'event_id_header_mismatch' } };
      }
      const payloadHash = sha256Hex(input.rawBody);

      // 3) Fixture fault plan (looked up by delivery; absent for ad-hoc requests).
      const action = await this.lookupFault(deliveryIdHeader, envelope.id, attemptNo);
      if (action.kind === 'respond') {
        await finish('injected_failure', action.status, 'fault:respond', { ...base, payloadHash });
        return {
          status: action.status,
          body: { error: 'injected_failure', status: action.status },
          headers: action.retryAfter ? { 'retry-after': action.retryAfter } : undefined,
        };
      }

      // 4) Idempotent processing in the receiver's own transaction.
      let outcome: ProcessOutcome;
      try {
        outcome = await this.process({
          consumerId: input.consumerId,
          envelope,
          payloadHash,
          failAfterMarker: action.kind === 'fail_after_marker',
        });
      } catch (err) {
        if (err instanceof InjectedFailure) {
          await finish('injected_failure', 500, 'fault:fail_after_marker (rolled back)', { ...base, payloadHash });
          return { status: 500, body: { error: 'injected_failure' } };
        }
        throw err;
      }

      if (outcome.result === 'conflict') {
        await finish('conflict', 409, 'same_event_id_different_payload', { ...base, payloadHash });
        return { status: 409, body: { error: 'payload_conflict', eventId: envelope.id } };
      }
      await finish(outcome.result, 200, outcome.detail ?? null, { ...base, payloadHash });
      return {
        status: 200,
        body: { result: outcome.result },
        ...(action.kind === 'commit_then_delay' ? { delayMs: action.delayMs } : {}),
      };
    } catch (err) {
      this.log.error('webhook failed', { requestId, ...errorFields(err) });
      try {
        await finish('error', 500, 'internal_error');
      } catch {
        /* best effort */
      }
      return { status: 500, body: { error: 'internal_error' } };
    }
  }

  private async lookupFault(
    deliveryId: string | undefined,
    eventId: string,
    attemptNo: number | null,
  ): Promise<FaultAction> {
    if (!deliveryId || attemptNo === null) return { kind: 'none' };
    const rows = await this.db.$queryRaw<
      Array<{ ordinal: number; logical_index: number; fault_plan: FaultPlan; phase: number }>
    >`
      SELECT d.ordinal, e.logical_index, r.fault_plan, r.phase
      FROM deliveries d
      JOIN events e ON e.id = d.event_id
      JOIN scenario_runs r ON r.id = d.run_id
      WHERE d.id = ${deliveryId} AND d.event_id = ${eventId}`;
    const row = rows[0];
    if (!row) return { kind: 'none' };
    return decideFault(row.fault_plan, row.phase, {
      eventIndex: row.logical_index,
      deliveryOrdinal: row.ordinal,
      attemptNo,
    });
  }

  /**
   * The marker insert and the business effect share ONE transaction: if anything fails after the
   * marker, both roll back and a later valid request is processed normally. Duplicate detection
   * relies on the unique key (`INSERT ... ON CONFLICT DO NOTHING`), never on SELECT-then-INSERT.
   */
  private async process(p: {
    consumerId: string;
    envelope: ReturnType<typeof envelopeSchema.parse>;
    payloadHash: string;
    failAfterMarker: boolean;
  }): Promise<ProcessOutcome> {
    const { envelope, consumerId, payloadHash } = p;
    return this.db.$transaction(
      async (tx): Promise<ProcessOutcome> => {
        const inserted = await tx.$executeRaw`
          INSERT INTO processed_events (consumer_id, event_id, payload_hash, run_id, processed_at)
          VALUES (${consumerId}, ${envelope.id}, ${payloadHash}, ${envelope.runId}, now())
          ON CONFLICT (consumer_id, event_id) DO NOTHING`;
        if (inserted === 0) {
          const existing = await tx.$queryRaw<Array<{ payload_hash: string }>>`
            SELECT payload_hash FROM processed_events
            WHERE consumer_id = ${consumerId} AND event_id = ${envelope.id}`;
          return existing[0]?.payload_hash === payloadHash
            ? { result: 'duplicate' }
            : { result: 'conflict' };
        }

        if (p.failAfterMarker) throw new InjectedFailure('fail_after_marker');

        if (envelope.type === EVENT_TYPES.counterIncrement) {
          const delta = (envelope.data as { delta: number }).delta;
          await tx.$executeRaw`
            INSERT INTO counter_projections (run_id, aggregate_id, value, updated_at)
            VALUES (${envelope.runId}, ${envelope.aggregateId}, ${delta}, now())
            ON CONFLICT (run_id, aggregate_id)
            DO UPDATE SET value = counter_projections.value + EXCLUDED.value, updated_at = now()`;
          await this.recordEffect(tx, consumerId, envelope, 'counter.incremented', { delta });
          return { result: 'processed' };
        }

        // demo.order.snapshot: full-state replacement; only a strictly newer sequence wins.
        const state = JSON.stringify(envelope.data);
        const applied = await tx.$queryRaw<Array<{ sequence: number }>>`
          INSERT INTO order_projections (run_id, aggregate_id, sequence, state, updated_at)
          VALUES (${envelope.runId}, ${envelope.aggregateId}, ${envelope.sequence}, ${state}::jsonb, now())
          ON CONFLICT (run_id, aggregate_id)
          DO UPDATE SET sequence = EXCLUDED.sequence, state = EXCLUDED.state, updated_at = now()
          WHERE order_projections.sequence < EXCLUDED.sequence
          RETURNING sequence`;
        if (applied.length === 0) {
          return { result: 'stale', detail: 'older_than_projection' };
        }
        await this.recordEffect(tx, consumerId, envelope, 'order.snapshot_applied', {
          sequence: envelope.sequence,
          state: envelope.data,
        });
        return { result: 'processed' };
      },
      { maxWait: 5000, timeout: 20_000 },
    );
  }

  private async recordEffect(
    tx: Prisma.TransactionClient,
    consumerId: string,
    envelope: { id: string; runId: string },
    kind: string,
    data: unknown,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO business_effects (id, run_id, consumer_id, event_id, kind, data, created_at)
      VALUES (${randomUUID()}, ${envelope.runId}, ${consumerId}, ${envelope.id}, ${kind},
              ${JSON.stringify(data)}::jsonb, now())`;
  }

  async diagnostics(runId?: string): Promise<Record<string, unknown>> {
    const rows = runId
      ? await this.db.$queryRaw<Array<{ result: string; n: number }>>`
          SELECT result::text AS result, count(*)::int AS n FROM receiver_requests WHERE run_id = ${runId} GROUP BY 1`
      : await this.db.$queryRaw<Array<{ result: string; n: number }>>`
          SELECT result::text AS result, count(*)::int AS n FROM receiver_requests GROUP BY 1`;
    const [effects] = runId
      ? await this.db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM business_effects WHERE run_id = ${runId}`
      : await this.db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM business_effects`;
    return {
      runId: runId ?? null,
      requestsByResult: Object.fromEntries(rows.map((r) => [r.result, r.n])),
      businessEffects: effects?.n ?? 0,
    };
  }

  async ping(): Promise<void> {
    await this.db.$queryRaw`SELECT 1`;
  }
}
