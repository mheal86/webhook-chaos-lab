import { Inject, Injectable } from '@nestjs/common';
import { Prisma, computeRunMetrics, evaluateAssertions, DomainError, type Db } from '@lab/db';
import {
  UNKNOWN_AT_SENDER_OUTCOMES,
  type AssertionResult,
  type AssertionSpec,
  type AttemptDto,
  type DeliveryDto,
  type DeliveryState,
  type EndpointDto,
  type EventDetail,
  type EventSummary,
  type Paginated,
  type ReceiverRequestDto,
  type ReceiverStateDto,
  type RunDto,
  type RunListItem,
  type RunMetrics,
} from '@lab/shared';
import { DB } from './tokens';

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

interface EventRow {
  id: string;
  run_id: string;
  type: EventSummary['type'];
  aggregate_id: string;
  sequence: number;
  logical_index: number;
  occurred_at: Date;
  created_at: Date;
  payload_hash: string;
  raw_payload: string;
  correlation_id: string | null;
}

interface DeliveryRow {
  id: string;
  event_id: string;
  run_id: string;
  endpoint_id: string;
  consumer_id: string | null;
  replay_of_delivery_id: string | null;
  ordinal: number;
  state: DeliveryState;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: Date | null;
  lease_until: Date | null;
  generation: number;
  terminal_reason: string | null;
  last_error_code: string | null;
  created_at: Date;
  finished_at: Date | null;
}

interface AttemptRow {
  id: string;
  delivery_id: string;
  attempt_no: number;
  generation: number;
  started_at: Date;
  finished_at: Date | null;
  outcome: AttemptDto['outcome'];
  http_status: number | null;
  error_code: string | null;
  duration_ms: number | null;
  response_preview: string | null;
  retry_after_applied: boolean;
  scheduled_retry_at: Date | null;
  late_result: { receivedAt: string; httpStatus: number | null; errorCode: string | null } | null;
}

const DELIVERY_COLUMNS = Prisma.sql`d.id, d.event_id, d.run_id, d.endpoint_id, ep.consumer_id, d.replay_of_delivery_id,
  d.ordinal, d.state::text AS state, d.attempt_count, d.max_attempts, d.next_attempt_at, d.lease_until,
  d.generation, d.terminal_reason, d.last_error_code, d.created_at, d.finished_at`;

function toDelivery(r: DeliveryRow): DeliveryDto {
  return {
    id: r.id,
    eventId: r.event_id,
    runId: r.run_id,
    endpointId: r.endpoint_id,
    consumerId: r.consumer_id,
    replayOfDeliveryId: r.replay_of_delivery_id,
    ordinal: r.ordinal,
    state: r.state,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    nextAttemptAt: iso(r.next_attempt_at),
    leaseUntil: iso(r.lease_until),
    generation: r.generation,
    terminalReason: r.terminal_reason,
    lastErrorCode: r.last_error_code,
    createdAt: r.created_at.toISOString(),
    finishedAt: iso(r.finished_at),
  };
}

function toAttempt(r: AttemptRow): AttemptDto {
  return {
    id: r.id,
    deliveryId: r.delivery_id,
    attemptNo: r.attempt_no,
    generation: r.generation,
    startedAt: r.started_at.toISOString(),
    finishedAt: iso(r.finished_at),
    outcome: r.outcome,
    unknownAtSender: UNKNOWN_AT_SENDER_OUTCOMES.includes(r.outcome),
    httpStatus: r.http_status,
    errorCode: r.error_code,
    durationMs: r.duration_ms,
    responsePreview: r.response_preview,
    retryAfterApplied: r.retry_after_applied,
    scheduledRetryAt: iso(r.scheduled_retry_at),
    lateResult: r.late_result,
  };
}

@Injectable()
export class ReadModelsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async endpoints(): Promise<EndpointDto[]> {
    const rows = await this.db.endpoint.findMany({ orderBy: { consumerId: 'asc' } });
    return rows.map((e) => ({ id: e.id, consumerId: e.consumerId, name: e.name, url: e.url, enabled: e.enabled }));
  }

  async listEvents(q: {
    runId?: string;
    type?: string;
    q?: string;
    state?: string;
    from?: string;
    to?: string;
    limit: number;
    offset: number;
  }): Promise<Paginated<EventSummary>> {
    const where: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (q.runId) where.push(Prisma.sql`e.run_id = ${q.runId}`);
    if (q.type) where.push(Prisma.sql`e.type = ${q.type}`);
    if (q.q) where.push(Prisma.sql`(e.id = ${q.q} OR position(lower(${q.q}) in lower(e.aggregate_id)) > 0)`);
    if (q.state) {
      where.push(
        Prisma.sql`EXISTS (SELECT 1 FROM deliveries dx WHERE dx.event_id = e.id AND dx.state = ${q.state}::"DeliveryState")`,
      );
    }
    for (const [value, op] of [
      [q.from, '>='],
      [q.to, '<'],
    ] as const) {
      if (!value) continue;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new DomainError('invalid', `invalid date: ${value}`);
      where.push(Prisma.sql`e.created_at ${Prisma.raw(op)} ${date}`);
    }
    const whereSql = Prisma.join(where, ' AND ');

    const [{ n }] = await this.db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM events e WHERE ${whereSql}`;
    const rows = await this.db.$queryRaw<EventRow[]>`
      SELECT e.id, e.run_id, e.type, e.aggregate_id, e.sequence, e.logical_index, e.occurred_at, e.created_at,
             e.payload_hash, e.raw_payload, e.correlation_id
      FROM events e WHERE ${whereSql}
      ORDER BY e.created_at DESC, e.logical_index DESC, e.id
      LIMIT ${q.limit} OFFSET ${q.offset}`;
    const ids = rows.map((r) => r.id);
    const states = ids.length
      ? await this.db.$queryRaw<Array<{ event_id: string; state: DeliveryState; n: number }>>`
          SELECT event_id, state::text AS state, count(*)::int AS n FROM deliveries
          WHERE event_id = ANY(${ids}::text[]) GROUP BY 1, 2`
      : [];
    const items = rows.map((r): EventSummary => {
      const mine = states.filter((s) => s.event_id === r.id);
      return {
        id: r.id,
        runId: r.run_id,
        type: r.type,
        aggregateId: r.aggregate_id,
        sequence: r.sequence,
        logicalIndex: r.logical_index,
        occurredAt: r.occurred_at.toISOString(),
        createdAt: r.created_at.toISOString(),
        payloadHash: r.payload_hash,
        deliveryCount: mine.reduce((a, s) => a + s.n, 0),
        deliveryStates: Object.fromEntries(mine.map((s) => [s.state, s.n])),
      };
    });
    return { items, total: n, limit: q.limit, offset: q.offset };
  }

  async eventDetail(id: string): Promise<EventDetail> {
    const rows = await this.db.$queryRaw<EventRow[]>`
      SELECT id, run_id, type, aggregate_id, sequence, logical_index, occurred_at, created_at, payload_hash,
             raw_payload, correlation_id FROM events WHERE id = ${id}`;
    const e = rows[0];
    if (!e) throw new DomainError('not_found', `event ${id} not found`);
    const deliveries = await this.db.$queryRaw<DeliveryRow[]>`
      SELECT ${DELIVERY_COLUMNS} FROM deliveries d JOIN endpoints ep ON ep.id = d.endpoint_id
      WHERE d.event_id = ${id} ORDER BY d.created_at, d.ordinal`;
    const attempts = await this.db.$queryRaw<AttemptRow[]>`
      SELECT a.id, a.delivery_id, a.attempt_no, a.generation, a.started_at, a.finished_at, a.outcome::text AS outcome,
             a.http_status, a.error_code, a.duration_ms, a.response_preview, a.retry_after_applied,
             a.scheduled_retry_at, a.late_result
      FROM delivery_attempts a JOIN deliveries d ON d.id = a.delivery_id
      WHERE d.event_id = ${id} ORDER BY a.started_at, a.attempt_no`;
    const states: Partial<Record<DeliveryState, number>> = {};
    for (const d of deliveries) states[d.state] = (states[d.state] ?? 0) + 1;
    return {
      id: e.id,
      runId: e.run_id,
      type: e.type,
      aggregateId: e.aggregate_id,
      sequence: e.sequence,
      logicalIndex: e.logical_index,
      occurredAt: e.occurred_at.toISOString(),
      createdAt: e.created_at.toISOString(),
      payloadHash: e.payload_hash,
      rawPayload: e.raw_payload,
      correlationId: e.correlation_id,
      deliveryCount: deliveries.length,
      deliveryStates: states,
      deliveries: deliveries.map((d) => ({
        ...toDelivery(d),
        attempts: attempts.filter((a) => a.delivery_id === d.id).map(toAttempt),
      })),
    };
  }

  async delivery(id: string): Promise<DeliveryDto & { replays: DeliveryDto[] }> {
    const rows = await this.db.$queryRaw<DeliveryRow[]>`
      SELECT ${DELIVERY_COLUMNS} FROM deliveries d JOIN endpoints ep ON ep.id = d.endpoint_id WHERE d.id = ${id}`;
    const d = rows[0];
    if (!d) throw new DomainError('not_found', `delivery ${id} not found`);
    const replays = await this.db.$queryRaw<DeliveryRow[]>`
      SELECT ${DELIVERY_COLUMNS} FROM deliveries d JOIN endpoints ep ON ep.id = d.endpoint_id
      WHERE d.replay_of_delivery_id = ${id} ORDER BY d.created_at`;
    return { ...toDelivery(d), replays: replays.map(toDelivery) };
  }

  async attempts(deliveryId: string): Promise<AttemptDto[]> {
    const exists = await this.db.$queryRaw<Array<{ id: string }>>`SELECT id FROM deliveries WHERE id = ${deliveryId}`;
    if (exists.length === 0) throw new DomainError('not_found', `delivery ${deliveryId} not found`);
    const rows = await this.db.$queryRaw<AttemptRow[]>`
      SELECT id, delivery_id, attempt_no, generation, started_at, finished_at, outcome::text AS outcome, http_status,
             error_code, duration_ms, response_preview, retry_after_applied, scheduled_retry_at, late_result
      FROM delivery_attempts WHERE delivery_id = ${deliveryId} ORDER BY attempt_no`;
    return rows.map(toAttempt);
  }

  async deadLetters(q: { runId?: string; limit: number; offset: number }) {
    const runFilter = q.runId ? Prisma.sql`AND d.run_id = ${q.runId}` : Prisma.empty;
    const [{ n }] = await this.db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM deliveries d WHERE d.state = 'dead' ${runFilter}`;
    const rows = await this.db.$queryRaw<
      Array<DeliveryRow & { event_type: string; aggregate_id: string; replay_count: number; active_replays: number }>
    >`
      SELECT ${DELIVERY_COLUMNS}, e.type AS event_type, e.aggregate_id,
             (SELECT count(*)::int FROM deliveries c WHERE c.replay_of_delivery_id = d.id) AS replay_count,
             (SELECT count(*)::int FROM deliveries c WHERE c.replay_of_delivery_id = d.id
                AND c.state NOT IN ('succeeded', 'dead')) AS active_replays
      FROM deliveries d
      JOIN endpoints ep ON ep.id = d.endpoint_id
      JOIN events e ON e.id = d.event_id
      WHERE d.state = 'dead' ${runFilter}
      ORDER BY d.finished_at DESC NULLS LAST, d.id
      LIMIT ${q.limit} OFFSET ${q.offset}`;
    const ids = rows.map((r) => r.id);
    const attempts = ids.length
      ? await this.db.$queryRaw<AttemptRow[]>`
          SELECT id, delivery_id, attempt_no, generation, started_at, finished_at, outcome::text AS outcome, http_status,
                 error_code, duration_ms, response_preview, retry_after_applied, scheduled_retry_at, late_result
          FROM delivery_attempts WHERE delivery_id = ANY(${ids}::text[]) ORDER BY delivery_id, attempt_no`
      : [];
    return {
      total: n,
      limit: q.limit,
      offset: q.offset,
      items: rows.map((r) => ({
        ...toDelivery(r),
        eventType: r.event_type,
        aggregateId: r.aggregate_id,
        replayCount: r.replay_count,
        activeReplays: r.active_replays,
        attempts: attempts.filter((a) => a.delivery_id === r.id).map(toAttempt),
      })),
    };
  }

  async listRuns(limit = 50): Promise<RunListItem[]> {
    const rows = await this.db.scenarioRun.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map((r) => ({
      id: r.id,
      type: r.type as RunListItem['type'],
      status: r.status,
      seed: r.seed,
      createdAt: r.createdAt.toISOString(),
      finishedAt: iso(r.finishedAt),
    }));
  }

  async run(id: string): Promise<RunDto> {
    const r = await this.db.scenarioRun.findUnique({ where: { id } });
    if (!r) throw new DomainError('not_found', `run ${id} not found`);
    const specs = r.expected as unknown as AssertionSpec[];
    let assertions: AssertionResult[];
    const stored = r.result as { assertions?: AssertionResult[] } | null;
    if (r.status === 'running' || !stored?.assertions) {
      const metrics = await computeRunMetrics(this.db, id);
      assertions = evaluateAssertions(specs, metrics, r.status !== 'running' && r.status !== 'open');
    } else {
      assertions = stored.assertions;
    }
    return {
      id: r.id,
      type: r.type as RunDto['type'],
      status: r.status,
      seed: r.seed,
      phase: r.phase,
      config: r.config as unknown as RunDto['config'],
      faultPlan: r.faultPlan as unknown as RunDto['faultPlan'],
      steps: r.steps as unknown as RunDto['steps'],
      stepIndex: r.stepIndex,
      createdAt: r.createdAt.toISOString(),
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      failureReason: r.failureReason,
      assertions,
    };
  }

  async metrics(runId: string): Promise<RunMetrics> {
    const exists = await this.db.scenarioRun.findUnique({ where: { id: runId }, select: { id: true } });
    if (!exists) throw new DomainError('not_found', `run ${runId} not found`);
    return computeRunMetrics(this.db, runId);
  }

  async receiverState(runId: string): Promise<ReceiverStateDto> {
    const metrics = await this.metrics(runId);
    const requests = await this.db.$queryRaw<
      Array<{
        id: string;
        seq: number;
        run_id: string | null;
        consumer_id: string;
        event_id: string | null;
        delivery_id: string | null;
        attempt_no: number | null;
        received_at: Date;
        completed_at: Date | null;
        result: ReceiverRequestDto['result'];
        http_status: number | null;
        detail: string | null;
        signature_valid: boolean | null;
        event_sequence: number | null;
      }>
    >`
      SELECT id, seq, run_id, consumer_id, event_id, delivery_id, attempt_no, received_at, completed_at,
             result::text AS result, http_status, detail, signature_valid, event_sequence
      FROM receiver_requests WHERE run_id = ${runId} ORDER BY seq DESC LIMIT 200`;
    const [counter] = await this.db.$queryRaw<Array<{ aggregate_id: string; value: number; updated_at: Date }>>`
      SELECT aggregate_id, value, updated_at FROM counter_projections WHERE run_id = ${runId}
      ORDER BY updated_at DESC LIMIT 1`;
    const [order] = await this.db.$queryRaw<
      Array<{ aggregate_id: string; sequence: number; state: unknown; updated_at: Date }>
    >`SELECT aggregate_id, sequence, state, updated_at FROM order_projections WHERE run_id = ${runId}
      ORDER BY updated_at DESC LIMIT 1`;
    const effects = await this.db.$queryRaw<
      Array<{ id: string; event_id: string; kind: string; data: unknown; created_at: Date }>
    >`SELECT id, event_id, kind, data, created_at FROM business_effects WHERE run_id = ${runId}
      ORDER BY created_at DESC LIMIT 100`;
    return {
      runId,
      requests: requests.map((r) => ({
        id: r.id,
        seq: r.seq,
        runId: r.run_id,
        consumerId: r.consumer_id,
        eventId: r.event_id,
        deliveryId: r.delivery_id,
        attemptNo: r.attempt_no,
        receivedAt: r.received_at.toISOString(),
        completedAt: iso(r.completed_at),
        result: r.result,
        httpStatus: r.http_status,
        detail: r.detail,
        signatureValid: r.signature_valid,
        eventSequence: r.event_sequence,
      })),
      counter: counter
        ? { aggregateId: counter.aggregate_id, value: counter.value, updatedAt: counter.updated_at.toISOString() }
        : null,
      order: order
        ? {
            aggregateId: order.aggregate_id,
            sequence: order.sequence,
            state: order.state,
            updatedAt: order.updated_at.toISOString(),
          }
        : null,
      effects: effects.map((x) => ({
        id: x.id,
        eventId: x.event_id,
        kind: x.kind,
        data: x.data,
        createdAt: x.created_at.toISOString(),
      })),
      summary: { ...metrics.receiver, businessEffects: metrics.businessEffects },
    };
  }
}
