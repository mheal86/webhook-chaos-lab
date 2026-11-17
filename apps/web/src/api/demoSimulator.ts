import {
  buildBlueprint,
  DEFAULT_RUN_CONFIG,
  EVENT_TYPES,
  SCENARIO_CATALOG,
  type AttemptDto,
  type AttemptOutcome,
  type BusinessEffectDto,
  type DeliveryDto,
  type EventDetail,
  type EventSummary,
  type Paginated,
  type ReceiverRequestDto,
  type ReceiverResult,
  type ReceiverStateDto,
  type RunConfig,
  type RunDto,
  type RunListItem,
  type RunMetrics,
  type ScenarioCatalogEntry,
  type ScenarioType,
} from '@lab/shared/web';
import type { DeadLetterItem, EventsQuery } from './client';

interface SimulatedRunData {
  run: RunDto;
  metrics: RunMetrics;
  events: EventDetail[];
  receiver: ReceiverStateDto;
}

const store = new Map<string, SimulatedRunData>();
let runCounter = 100;

function getByPath(obj: unknown, path: string): number | string | null {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'number' || typeof cur === 'string' ? cur : 0;
}

function buildSimulatedRun(
  type: ScenarioType,
  seed: number,
  customConfig?: Record<string, number>,
  createdAtOffsetMs = 0,
): SimulatedRunData {
  runCounter += 1;
  const runId = `run-${type.replace(/_/g, '-')}-${runCounter}`;
  const bp = buildBlueprint(type, seed, customConfig);
  const cfg = bp.config;
  const n = cfg.eventCount;
  const baseTs = Date.now() - createdAtOffsetMs;
  const iso = (offsetMs: number) => new Date(baseTs + offsetMs).toISOString();

  const events: EventDetail[] = [];
  const requests: ReceiverRequestDto[] = [];
  const effects: BusinessEffectDto[] = [];
  let reqSeq = 0;

  const byOutcome: Record<AttemptOutcome, number> = {
    in_progress: 0,
    success: 0,
    http_retryable: 0,
    http_permanent: 0,
    network_error: 0,
    timeout: 0,
    worker_lost: 0,
  };
  const byResult: Record<ReceiverResult, number> = {
    received: 0,
    processed: 0,
    duplicate: 0,
    stale: 0,
    conflict: 0,
    rejected_signature: 0,
    rejected_bad_request: 0,
    injected_failure: 0,
    error: 0,
  };

  let totalDeliveries = 0;
  let succeededDeliveries = 0;
  let deadDeliveries = 0;
  const deadByReason: Record<string, number> = {};
  let maxPerDelivery = 0;
  let replayDeliveries = 0;
  let deadWithReplay = 0;
  const receiveOrderList: number[] = [];

  if (type === 'out_of_order') {
    const seqs: Array<{ seq: number; status: 'created' | 'paid' | 'shipped' }> = [
      { seq: 3, status: 'shipped' },
      { seq: 1, status: 'created' },
      { seq: 2, status: 'paid' },
    ];
    seqs.forEach((item, idx) => {
      const evId = `${runId}-ev-${idx + 1}`;
      const delId = `${runId}-del-${idx + 1}`;
      const attId = `${runId}-att-${idx + 1}-1`;
      const t0 = idx * 400;
      totalDeliveries += 1;
      succeededDeliveries += 1;
      maxPerDelivery = Math.max(maxPerDelivery, 1);
      byOutcome.success += 1;
      reqSeq += 1;
      receiveOrderList.push(item.seq);
      const isFirst = idx === 0;
      if (isFirst) {
        byResult.processed += 1;
        effects.push({
          id: `${runId}-eff-1`,
          eventId: evId,
          kind: 'order.snapshot_applied',
          data: { orderId: 'order-1001', sequence: 3, status: 'shipped' },
          createdAt: iso(t0 + 45),
        });
      } else {
        byResult.stale += 1;
      }
      requests.push({
        id: `${runId}-req-${reqSeq}`,
        seq: reqSeq,
        runId,
        consumerId: 'receiver-fixture',
        eventId: evId,
        deliveryId: delId,
        attemptNo: 1,
        receivedAt: iso(t0 + 20),
        completedAt: iso(t0 + 48),
        result: isFirst ? 'processed' : 'stale',
        httpStatus: 200,
        detail: isFirst
          ? 'Applied order snapshot sequence 3 (shipped)'
          : `Ignored stale snapshot sequence ${item.seq} < current sequence 3`,
        signatureValid: true,
        eventSequence: item.seq,
      });
      const attempt: AttemptDto = {
        id: attId,
        deliveryId: delId,
        attemptNo: 1,
        generation: 1,
        startedAt: iso(t0 + 10),
        finishedAt: iso(t0 + 52),
        outcome: 'success',
        unknownAtSender: false,
        httpStatus: 200,
        errorCode: null,
        durationMs: 42,
        responsePreview: JSON.stringify({ status: isFirst ? 'processed' : 'stale_ignored', currentSeq: 3 }),
        retryAfterApplied: false,
        scheduledRetryAt: null,
        lateResult: null,
      };
      const delivery: DeliveryDto & { attempts: AttemptDto[] } = {
        id: delId,
        eventId: evId,
        runId,
        endpointId: '00000000-0000-4000-8000-000000000001',
        consumerId: 'receiver-fixture',
        replayOfDeliveryId: null,
        ordinal: 1,
        state: 'succeeded',
        attemptCount: 1,
        maxAttempts: cfg.maxAttempts,
        nextAttemptAt: null,
        leaseUntil: null,
        generation: 1,
        terminalReason: null,
        lastErrorCode: null,
        createdAt: iso(t0),
        finishedAt: iso(t0 + 52),
        attempts: [attempt],
      };
      events.push({
        id: evId,
        runId,
        type: EVENT_TYPES.orderSnapshot,
        aggregateId: 'order-1001',
        sequence: item.seq,
        logicalIndex: idx + 1,
        occurredAt: iso(t0),
        createdAt: iso(t0),
        payloadHash: `sha256:9f8e7d0${item.seq}`,
        deliveryCount: 1,
        deliveryStates: { succeeded: 1 },
        rawPayload: JSON.stringify({
          eventId: evId,
          type: EVENT_TYPES.orderSnapshot,
          aggregateId: 'order-1001',
          sequence: item.seq,
          data: { orderId: 'order-1001', status: item.status, totalCents: 1500 * item.seq },
        }, null, 2),
        correlationId: `corr-${runId}-${idx + 1}`,
        deliveries: [delivery],
      });
    });
  } else if (type === 'duplicate_storm') {
    const d = cfg.duplicateCount;
    const evId = `${runId}-ev-1`;
    const deliveries: Array<DeliveryDto & { attempts: AttemptDto[] }> = [];
    totalDeliveries = d;
    succeededDeliveries = d;
    maxPerDelivery = 1;
    byOutcome.success = d;
    byResult.processed = 1;
    byResult.duplicate = d - 1;

    effects.push({
      id: `${runId}-eff-1`,
      eventId: evId,
      kind: 'counter.increment',
      data: { aggregateId: 'counter-demo', delta: 1, newValue: 1 },
      createdAt: iso(35),
    });

    for (let i = 1; i <= d; i++) {
      const delId = `${runId}-del-${i}`;
      const isWinner = i === 1;
      reqSeq += 1;
      receiveOrderList.push(1);
      requests.push({
        id: `${runId}-req-${i}`,
        seq: reqSeq,
        runId,
        consumerId: 'receiver-fixture',
        eventId: evId,
        deliveryId: delId,
        attemptNo: 1,
        receivedAt: iso(15 + i * 2),
        completedAt: iso(35 + i * 2),
        result: isWinner ? 'processed' : 'duplicate',
        httpStatus: 200,
        detail: isWinner
          ? 'Inserted inbox marker & committed counter increment (+1)'
          : 'Unique constraint on inbox(consumer_id, event_id): duplicate ignored safely',
        signatureValid: true,
        eventSequence: 1,
      });
      deliveries.push({
        id: delId,
        eventId: evId,
        runId,
        endpointId: '00000000-0000-4000-8000-000000000001',
        consumerId: 'receiver-fixture',
        replayOfDeliveryId: null,
        ordinal: i,
        state: 'succeeded',
        attemptCount: 1,
        maxAttempts: cfg.maxAttempts,
        nextAttemptAt: null,
        leaseUntil: null,
        generation: 1,
        terminalReason: null,
        lastErrorCode: null,
        createdAt: iso(0),
        finishedAt: iso(40 + i * 2),
        attempts: [
          {
            id: `${delId}-att-1`,
            deliveryId: delId,
            attemptNo: 1,
            generation: 1,
            startedAt: iso(10 + i * 2),
            finishedAt: iso(40 + i * 2),
            outcome: 'success',
            unknownAtSender: false,
            httpStatus: 200,
            errorCode: null,
            durationMs: 28,
            responsePreview: JSON.stringify({ status: isWinner ? 'processed' : 'duplicate_ignored' }),
            retryAfterApplied: false,
            scheduledRetryAt: null,
            lateResult: null,
          },
        ],
      });
    }
    events.push({
      id: evId,
      runId,
      type: EVENT_TYPES.counterIncrement,
      aggregateId: 'counter-demo',
      sequence: 1,
      logicalIndex: 1,
      occurredAt: iso(0),
      createdAt: iso(0),
      payloadHash: 'sha256:dupstorm01',
      deliveryCount: d,
      deliveryStates: { succeeded: d },
      rawPayload: JSON.stringify({
        eventId: evId,
        type: EVENT_TYPES.counterIncrement,
        aggregateId: 'counter-demo',
        sequence: 1,
        data: { delta: 1 },
      }, null, 2),
      correlationId: `corr-${runId}-1`,
      deliveries,
    });
  } else {
    for (let i = 1; i <= n; i++) {
      const evId = `${runId}-ev-${i}`;
      const delId = `${runId}-del-${i}`;
      const t0 = (i - 1) * 500;
      const deliveries: Array<DeliveryDto & { attempts: AttemptDto[] }> = [];

      if (type === 'healthy') {
        totalDeliveries += 1;
        succeededDeliveries += 1;
        maxPerDelivery = Math.max(maxPerDelivery, 1);
        byOutcome.success += 1;
        byResult.processed += 1;
        reqSeq += 1;
        receiveOrderList.push(i);
        effects.push({
          id: `${runId}-eff-${i}`,
          eventId: evId,
          kind: 'counter.increment',
          data: { aggregateId: 'counter-demo', delta: 1, newValue: i },
          createdAt: iso(t0 + 35),
        });
        requests.push({
          id: `${runId}-req-${reqSeq}`,
          seq: reqSeq,
          runId,
          consumerId: 'receiver-fixture',
          eventId: evId,
          deliveryId: delId,
          attemptNo: 1,
          receivedAt: iso(t0 + 15),
          completedAt: iso(t0 + 38),
          result: 'processed',
          httpStatus: 200,
          detail: 'Processed on first attempt',
          signatureValid: true,
          eventSequence: i,
        });
        deliveries.push({
          id: delId,
          eventId: evId,
          runId,
          endpointId: '00000000-0000-4000-8000-000000000001',
          consumerId: 'receiver-fixture',
          replayOfDeliveryId: null,
          ordinal: 1,
          state: 'succeeded',
          attemptCount: 1,
          maxAttempts: cfg.maxAttempts,
          nextAttemptAt: null,
          leaseUntil: null,
          generation: 1,
          terminalReason: null,
          lastErrorCode: null,
          createdAt: iso(t0),
          finishedAt: iso(t0 + 42),
          attempts: [
            {
              id: `${delId}-att-1`,
              deliveryId: delId,
              attemptNo: 1,
              generation: 1,
              startedAt: iso(t0 + 10),
              finishedAt: iso(t0 + 42),
              outcome: 'success',
              unknownAtSender: false,
              httpStatus: 200,
              errorCode: null,
              durationMs: 32,
              responsePreview: '{"status":"processed"}',
              retryAfterApplied: false,
              scheduledRetryAt: null,
              lateResult: null,
            },
          ],
        });
      } else if (type === 'fail_twice') {
        totalDeliveries += 1;
        succeededDeliveries += 1;
        maxPerDelivery = Math.max(maxPerDelivery, 3);
        byOutcome.http_retryable += 2;
        byOutcome.success += 1;
        byResult.injected_failure += 2;
        byResult.processed += 1;
        const attempts: AttemptDto[] = [];
        for (let a = 1; a <= 3; a++) {
          const ok = a === 3;
          reqSeq += 1;
          receiveOrderList.push(i);
          requests.push({
            id: `${runId}-req-${reqSeq}`,
            seq: reqSeq,
            runId,
            consumerId: 'receiver-fixture',
            eventId: evId,
            deliveryId: delId,
            attemptNo: a,
            receivedAt: iso(t0 + a * 1200),
            completedAt: iso(t0 + a * 1200 + 35),
            result: ok ? 'processed' : 'injected_failure',
            httpStatus: ok ? 200 : 500,
            detail: ok
              ? 'Receiver healthy on attempt 3 -> committed business effect'
              : `Fault rule matched attempt ${a}: returned HTTP 500 before DB commit`,
            signatureValid: true,
            eventSequence: i,
          });
          attempts.push({
            id: `${delId}-att-${a}`,
            deliveryId: delId,
            attemptNo: a,
            generation: a,
            startedAt: iso(t0 + a * 1200 - 5),
            finishedAt: iso(t0 + a * 1200 + 40),
            outcome: ok ? 'success' : 'http_retryable',
            unknownAtSender: false,
            httpStatus: ok ? 200 : 500,
            errorCode: ok ? null : 'HTTP_500',
            durationMs: 45,
            responsePreview: ok ? '{"status":"processed"}' : '{"error":"Injected 500 fault before commit"}',
            retryAfterApplied: false,
            scheduledRetryAt: ok ? null : iso(t0 + (a + 1) * 1200 - 10),
            lateResult: null,
          });
        }
        effects.push({
          id: `${runId}-eff-${i}`,
          eventId: evId,
          kind: 'counter.increment',
          data: { aggregateId: 'counter-demo', delta: 1, newValue: i },
          createdAt: iso(t0 + 3635),
        });
        deliveries.push({
          id: delId,
          eventId: evId,
          runId,
          endpointId: '00000000-0000-4000-8000-000000000001',
          consumerId: 'receiver-fixture',
          replayOfDeliveryId: null,
          ordinal: 1,
          state: 'succeeded',
          attemptCount: 3,
          maxAttempts: cfg.maxAttempts,
          nextAttemptAt: null,
          leaseUntil: null,
          generation: 3,
          terminalReason: null,
          lastErrorCode: null,
          createdAt: iso(t0),
          finishedAt: iso(t0 + 3640),
          attempts,
        });
      } else if (type === 'timeout_after_commit') {
        totalDeliveries += 1;
        succeededDeliveries += 1;
        maxPerDelivery = Math.max(maxPerDelivery, 2);
        byOutcome.timeout += 1;
        byOutcome.success += 1;
        byResult.processed += 1;
        byResult.duplicate += 1;

        reqSeq += 1;
        receiveOrderList.push(i);
        requests.push({
          id: `${runId}-req-${reqSeq}`,
          seq: reqSeq,
          runId,
          consumerId: 'receiver-fixture',
          eventId: evId,
          deliveryId: delId,
          attemptNo: 1,
          receivedAt: iso(t0 + 20),
          completedAt: iso(t0 + 3100),
          result: 'processed',
          httpStatus: 200,
          detail: 'Committed effect in DB first, then delayed HTTP response beyond sender timeout',
          signatureValid: true,
          eventSequence: i,
        });

        reqSeq += 1;
        receiveOrderList.push(i);
        requests.push({
          id: `${runId}-req-${reqSeq}`,
          seq: reqSeq,
          runId,
          consumerId: 'receiver-fixture',
          eventId: evId,
          deliveryId: delId,
          attemptNo: 2,
          receivedAt: iso(t0 + 2500),
          completedAt: iso(t0 + 2530),
          result: 'duplicate',
          httpStatus: 200,
          detail: 'Idempotency key already committed on attempt 1 -> returned 200 duplicate without re-applying',
          signatureValid: true,
          eventSequence: i,
        });

        effects.push({
          id: `${runId}-eff-${i}`,
          eventId: evId,
          kind: 'counter.increment',
          data: { aggregateId: 'counter-demo', delta: 1, newValue: i },
          createdAt: iso(t0 + 30),
        });

        deliveries.push({
          id: delId,
          eventId: evId,
          runId,
          endpointId: '00000000-0000-4000-8000-000000000001',
          consumerId: 'receiver-fixture',
          replayOfDeliveryId: null,
          ordinal: 1,
          state: 'succeeded',
          attemptCount: 2,
          maxAttempts: cfg.maxAttempts,
          nextAttemptAt: null,
          leaseUntil: null,
          generation: 2,
          terminalReason: null,
          lastErrorCode: null,
          createdAt: iso(t0),
          finishedAt: iso(t0 + 2535),
          attempts: [
            {
              id: `${delId}-att-1`,
              deliveryId: delId,
              attemptNo: 1,
              generation: 1,
              startedAt: iso(t0 + 10),
              finishedAt: iso(t0 + 1510),
              outcome: 'timeout',
              unknownAtSender: true,
              httpStatus: null,
              errorCode: 'ETIMEDOUT',
              durationMs: 1500,
              responsePreview: null,
              retryAfterApplied: false,
              scheduledRetryAt: iso(t0 + 2500),
              lateResult: { receivedAt: iso(t0 + 3100), httpStatus: 200, errorCode: null },
            },
            {
              id: `${delId}-att-2`,
              deliveryId: delId,
              attemptNo: 2,
              generation: 2,
              startedAt: iso(t0 + 2495),
              finishedAt: iso(t0 + 2535),
              outcome: 'success',
              unknownAtSender: false,
              httpStatus: 200,
              errorCode: null,
              durationMs: 40,
              responsePreview: '{"status":"duplicate_ignored","idempotent":true}',
              retryAfterApplied: false,
              scheduledRetryAt: null,
              lateResult: null,
            },
          ],
        });
      } else if (type === 'exhaust_and_replay') {
        totalDeliveries += 2;
        deadDeliveries += 1;
        succeededDeliveries += 1;
        deadByReason.retry_budget_exhausted = (deadByReason.retry_budget_exhausted ?? 0) + 1;
        replayDeliveries += 1;
        deadWithReplay += 1;
        maxPerDelivery = Math.max(maxPerDelivery, cfg.maxAttempts);
        byOutcome.http_retryable += cfg.maxAttempts;
        byOutcome.success += 1;
        byResult.injected_failure += cfg.maxAttempts;
        byResult.processed += 1;

        const deadAttempts: AttemptDto[] = [];
        for (let a = 1; a <= cfg.maxAttempts; a++) {
          reqSeq += 1;
          receiveOrderList.push(i);
          requests.push({
            id: `${runId}-req-${reqSeq}`,
            seq: reqSeq,
            runId,
            consumerId: 'receiver-fixture',
            eventId: evId,
            deliveryId: delId,
            attemptNo: a,
            receivedAt: iso(t0 + a * 800),
            completedAt: iso(t0 + a * 800 + 30),
            result: 'injected_failure',
            httpStatus: 500,
            detail: `Phase 1 outage: HTTP 500 on attempt ${a}/${cfg.maxAttempts}`,
            signatureValid: true,
            eventSequence: i,
          });
          deadAttempts.push({
            id: `${delId}-att-${a}`,
            deliveryId: delId,
            attemptNo: a,
            generation: a,
            startedAt: iso(t0 + a * 800 - 5),
            finishedAt: iso(t0 + a * 800 + 35),
            outcome: 'http_retryable',
            unknownAtSender: false,
            httpStatus: 500,
            errorCode: 'HTTP_500',
            durationMs: 40,
            responsePreview: '{"error":"Downstream database unavailable (phase 1)"}',
            retryAfterApplied: false,
            scheduledRetryAt: a < cfg.maxAttempts ? iso(t0 + (a + 1) * 800 - 10) : null,
            lateResult: null,
          });
        }

        const replayDelId = `${delId}-replay-1`;
        const replayTime = t0 + (cfg.maxAttempts + 1) * 800;
        reqSeq += 1;
        receiveOrderList.push(i);
        requests.push({
          id: `${runId}-req-${reqSeq}`,
          seq: reqSeq,
          runId,
          consumerId: 'receiver-fixture',
          eventId: evId,
          deliveryId: replayDelId,
          attemptNo: 1,
          receivedAt: iso(replayTime + 15),
          completedAt: iso(replayTime + 45),
          result: 'processed',
          httpStatus: 200,
          detail: 'Phase 2 recovered: replay delivery succeeded & committed effect',
          signatureValid: true,
          eventSequence: i,
        });

        effects.push({
          id: `${runId}-eff-${i}`,
          eventId: evId,
          kind: 'counter.increment',
          data: { aggregateId: 'counter-demo', delta: 1, newValue: i },
          createdAt: iso(replayTime + 45),
        });

        deliveries.push(
          {
            id: delId,
            eventId: evId,
            runId,
            endpointId: '00000000-0000-4000-8000-000000000001',
            consumerId: 'receiver-fixture',
            replayOfDeliveryId: null,
            ordinal: 1,
            state: 'dead',
            attemptCount: cfg.maxAttempts,
            maxAttempts: cfg.maxAttempts,
            nextAttemptAt: null,
            leaseUntil: null,
            generation: cfg.maxAttempts,
            terminalReason: 'retry_budget_exhausted',
            lastErrorCode: 'HTTP_500',
            createdAt: iso(t0),
            finishedAt: iso(t0 + cfg.maxAttempts * 800 + 35),
            attempts: deadAttempts,
          },
          {
            id: replayDelId,
            eventId: evId,
            runId,
            endpointId: '00000000-0000-4000-8000-000000000001',
            consumerId: 'receiver-fixture',
            replayOfDeliveryId: delId,
            ordinal: 2,
            state: 'succeeded',
            attemptCount: 1,
            maxAttempts: cfg.maxAttempts,
            nextAttemptAt: null,
            leaseUntil: null,
            generation: 1,
            terminalReason: null,
            lastErrorCode: null,
            createdAt: iso(replayTime),
            finishedAt: iso(replayTime + 50),
            attempts: [
              {
                id: `${replayDelId}-att-1`,
                deliveryId: replayDelId,
                attemptNo: 1,
                generation: 1,
                startedAt: iso(replayTime + 10),
                finishedAt: iso(replayTime + 50),
                outcome: 'success',
                unknownAtSender: false,
                httpStatus: 200,
                errorCode: null,
                durationMs: 40,
                responsePreview: '{"status":"processed","replayed":true}',
                retryAfterApplied: false,
                scheduledRetryAt: null,
                lateResult: null,
              },
            ],
          },
        );
      } else if (type === 'invalid_signature') {
        totalDeliveries += 1;
        deadDeliveries += 1;
        deadByReason.permanent_failure = (deadByReason.permanent_failure ?? 0) + 1;
        maxPerDelivery = Math.max(maxPerDelivery, 1);
        byOutcome.http_permanent += 1;
        byResult.rejected_signature += 1;
        reqSeq += 1;
        requests.push({
          id: `${runId}-req-${reqSeq}`,
          seq: reqSeq,
          runId,
          consumerId: 'receiver-fixture',
          eventId: evId,
          deliveryId: delId,
          attemptNo: 1,
          receivedAt: iso(t0 + 15),
          completedAt: iso(t0 + 30),
          result: 'rejected_signature',
          httpStatus: 401,
          detail: 'HMAC-SHA256 signature mismatch (401 Unauthorized) -> rejected before business logic',
          signatureValid: false,
          eventSequence: i,
        });
        deliveries.push({
          id: delId,
          eventId: evId,
          runId,
          endpointId: '00000000-0000-4000-8000-000000000001',
          consumerId: 'receiver-fixture',
          replayOfDeliveryId: null,
          ordinal: 1,
          state: 'dead',
          attemptCount: 1,
          maxAttempts: cfg.maxAttempts,
          nextAttemptAt: null,
          leaseUntil: null,
          generation: 1,
          terminalReason: 'permanent_failure',
          lastErrorCode: 'HTTP_401',
          createdAt: iso(t0),
          finishedAt: iso(t0 + 35),
          attempts: [
            {
              id: `${delId}-att-1`,
              deliveryId: delId,
              attemptNo: 1,
              generation: 1,
              startedAt: iso(t0 + 10),
              finishedAt: iso(t0 + 35),
              outcome: 'http_permanent',
              unknownAtSender: false,
              httpStatus: 401,
              errorCode: 'HTTP_401',
              durationMs: 25,
              responsePreview: '{"error":"Invalid HMAC signature"}',
              retryAfterApplied: false,
              scheduledRetryAt: null,
              lateResult: null,
            },
          ],
        });
      }

      const statesCount: Record<string, number> = {};
      for (const d of deliveries) {
        statesCount[d.state] = (statesCount[d.state] ?? 0) + 1;
      }

      events.push({
        id: evId,
        runId,
        type: EVENT_TYPES.counterIncrement,
        aggregateId: 'counter-demo',
        sequence: i,
        logicalIndex: i,
        occurredAt: iso(t0),
        createdAt: iso(t0),
        payloadHash: `sha256:8a4b2c0${i}`,
        deliveryCount: deliveries.length,
        deliveryStates: statesCount,
        rawPayload: JSON.stringify({
          eventId: evId,
          type: EVENT_TYPES.counterIncrement,
          aggregateId: 'counter-demo',
          sequence: i,
          data: { delta: 1 },
        }, null, 2),
        correlationId: `corr-${runId}-${i}`,
        deliveries,
      });
    }
  }

  const totalAttempts = Object.values(byOutcome).reduce((a, b) => a + b, 0);
  const metrics: RunMetrics = {
    runId,
    events: events.length,
    deliveries: {
      total: totalDeliveries,
      queued: 0,
      in_flight: 0,
      retry_wait: 0,
      succeeded: succeededDeliveries,
      dead: deadDeliveries,
      nonTerminal: 0,
      deadByReason,
    },
    attempts: {
      total: totalAttempts,
      byOutcome,
      maxPerDelivery,
      latency: {
        p95: type === 'timeout_after_commit' ? 1500 : 45,
        sampleCount: totalAttempts,
        unit: 'ms',
        window: 'all attempts in run',
      },
    },
    receiver: {
      requests: requests.length,
      byResult,
      receiveOrder: receiveOrderList.join(','),
    },
    businessEffects: effects.length,
    projections: {
      counterValue: type === 'out_of_order' ? null : effects.length,
      orderSequence: type === 'out_of_order' ? 3 : null,
    },
    lineage: {
      replayDeliveries,
      deadWithReplay,
    },
    generatedAt: iso(5000),
  };

  const assertions = bp.assertions.map((spec) => {
    const actual = getByPath(metrics, spec.metric);
    const expectedValue =
      spec.expected !== undefined
        ? spec.expected
        : spec.expectedMetric
          ? getByPath(metrics, spec.expectedMetric)
          : null;
    return {
      ...spec,
      actual,
      expectedValue,
      status: actual === expectedValue ? ('passed' as const) : ('failed' as const),
    };
  });

  const run: RunDto = {
    id: runId,
    type,
    status: 'passed',
    seed,
    phase: type === 'exhaust_and_replay' ? 2 : 1,
    config: cfg,
    faultPlan: bp.faultPlan,
    steps: bp.steps,
    stepIndex: bp.steps.length,
    createdAt: iso(0),
    startedAt: iso(5),
    finishedAt: iso(4500),
    failureReason: null,
    assertions,
  };

  const receiver: ReceiverStateDto = {
    runId,
    requests,
    counter:
      type === 'out_of_order'
        ? null
        : { aggregateId: 'counter-demo', value: effects.length, updatedAt: iso(4200) },
    order:
      type === 'out_of_order'
        ? {
            aggregateId: 'order-1001',
            sequence: 3,
            state: { orderId: 'order-1001', status: 'shipped', totalCents: 4500 },
            updatedAt: iso(4200),
          }
        : null,
    effects,
    summary: {
      ...metrics.receiver,
      businessEffects: effects.length,
    },
  };

  return { run, metrics, events, receiver };
}

function ensureInitialized() {
  if (store.size > 0) return;
  const initialScenarios: Array<{ type: ScenarioType; seed: number; offsetMs: number }> = [
    { type: 'invalid_signature', seed: 107, offsetMs: 360_000 },
    { type: 'out_of_order', seed: 105, offsetMs: 300_000 },
    { type: 'timeout_after_commit', seed: 104, offsetMs: 240_000 },
    { type: 'duplicate_storm', seed: 103, offsetMs: 180_000 },
    { type: 'exhaust_and_replay', seed: 106, offsetMs: 120_000 },
    { type: 'healthy', seed: 101, offsetMs: 60_000 },
    { type: 'fail_twice', seed: 102, offsetMs: 10_000 },
  ];
  for (const item of initialScenarios) {
    const sim = buildSimulatedRun(item.type, item.seed, undefined, item.offsetMs);
    store.set(sim.run.id, sim);
  }
}

export const demoApi = {
  runs: async (): Promise<RunListItem[]> => {
    ensureInitialized();
    return Array.from(store.values())
      .map(({ run }) => ({
        id: run.id,
        type: run.type,
        status: run.status,
        seed: run.seed,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
      }))
      .reverse();
  },

  run: async (id: string): Promise<RunDto> => {
    ensureInitialized();
    const found = store.get(id) ?? Array.from(store.values()).pop()!;
    return found.run;
  },

  metrics: async (id: string): Promise<RunMetrics> => {
    ensureInitialized();
    const found = store.get(id) ?? Array.from(store.values()).pop()!;
    return found.metrics;
  },

  scenarios: async (): Promise<{ defaultConfig: RunConfig; scenarios: ScenarioCatalogEntry[] }> => {
    return {
      defaultConfig: DEFAULT_RUN_CONFIG,
      scenarios: SCENARIO_CATALOG,
    };
  },

  createRun: async (
    type: string,
    body: { seed?: number; config?: Record<string, number> },
  ): Promise<{ runId: string; seed: number }> => {
    ensureInitialized();
    const seed = body.seed ?? Math.floor(100 + Math.random() * 900);
    const sim = buildSimulatedRun(type as ScenarioType, seed, body.config, 0);
    store.set(sim.run.id, sim);
    return { runId: sim.run.id, seed };
  },

  events: async (q: EventsQuery): Promise<Paginated<EventSummary>> => {
    ensureInitialized();
    const runData = q.runId ? store.get(q.runId) : Array.from(store.values()).pop();
    let list: EventSummary[] = runData ? runData.events : [];
    if (q.state) {
      list = list.filter((e) => (e.deliveryStates[q.state as keyof typeof e.deliveryStates] ?? 0) > 0);
    }
    if (q.q) {
      const search = q.q.toLowerCase();
      list = list.filter(
        (e) => e.id.toLowerCase().includes(search) || e.aggregateId.toLowerCase().includes(search),
      );
    }
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 50;
    return {
      items: list.slice(offset, offset + limit),
      total: list.length,
      limit,
      offset,
    };
  },

  event: async (id: string): Promise<EventDetail> => {
    ensureInitialized();
    for (const sim of store.values()) {
      const ev = sim.events.find((e) => e.id === id);
      if (ev) return ev;
    }
    return Array.from(store.values()).pop()!.events[0];
  },

  deadLetters: async (q: {
    runId?: string;
    limit?: number;
    offset?: number;
  }): Promise<Paginated<DeadLetterItem>> => {
    ensureInitialized();
    const sims = q.runId
      ? [store.get(q.runId)].filter(Boolean)
      : Array.from(store.values()).reverse();
    const items: DeadLetterItem[] = [];
    for (const sim of sims) {
      if (!sim) continue;
      for (const ev of sim.events) {
        const deadList = ev.deliveries.filter((d) => d.state === 'dead');
        for (const d of deadList) {
          const replays = ev.deliveries.filter((child) => child.replayOfDeliveryId === d.id);
          items.push({
            ...d,
            eventType: ev.type,
            aggregateId: ev.aggregateId,
            replayCount: replays.length,
            activeReplays: 0,
            attempts: d.attempts,
          });
        }
      }
    }
    const offset = q.offset ?? 0;
    const limit = q.limit ?? 50;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
    };
  },

  replay: async (
    deliveryId: string,
  ): Promise<{ deliveryId: string; replayOfDeliveryId: string; eventId: string }> => {
    ensureInitialized();
    for (const sim of store.values()) {
      for (const ev of sim.events) {
        const orig = ev.deliveries.find((d) => d.id === deliveryId);
        if (orig) {
          const newDelId = `${orig.id}-replay-${ev.deliveries.length}`;
          const nowIso = new Date().toISOString();
          ev.deliveries.push({
            id: newDelId,
            eventId: ev.id,
            runId: sim.run.id,
            endpointId: orig.endpointId,
            consumerId: orig.consumerId,
            replayOfDeliveryId: orig.id,
            ordinal: ev.deliveries.length + 1,
            state: 'succeeded',
            attemptCount: 1,
            maxAttempts: orig.maxAttempts,
            nextAttemptAt: null,
            leaseUntil: null,
            generation: 1,
            terminalReason: null,
            lastErrorCode: null,
            createdAt: nowIso,
            finishedAt: nowIso,
            attempts: [
              {
                id: `${newDelId}-att-1`,
                deliveryId: newDelId,
                attemptNo: 1,
                generation: 1,
                startedAt: nowIso,
                finishedAt: nowIso,
                outcome: 'success',
                unknownAtSender: false,
                httpStatus: 200,
                errorCode: null,
                durationMs: 31,
                responsePreview: '{"status":"processed","manualReplay":true}',
                retryAfterApplied: false,
                scheduledRetryAt: null,
                lateResult: null,
              },
            ],
          });
          ev.deliveryCount = ev.deliveries.length;
          ev.deliveryStates.succeeded = (ev.deliveryStates.succeeded ?? 0) + 1;
          sim.metrics.deliveries.total += 1;
          sim.metrics.deliveries.succeeded += 1;
          sim.metrics.lineage.replayDeliveries += 1;
          return { deliveryId: newDelId, replayOfDeliveryId: orig.id, eventId: ev.id };
        }
      }
    }
    return { deliveryId: `${deliveryId}-replay`, replayOfDeliveryId: deliveryId, eventId: 'ev-1' };
  },

  receiverState: async (runId: string): Promise<ReceiverStateDto> => {
    ensureInitialized();
    const found = store.get(runId) ?? Array.from(store.values()).pop()!;
    return found.receiver;
  },
};
