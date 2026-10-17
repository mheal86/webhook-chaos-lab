import { randomUUID } from 'node:crypto';
import {
  DomainError,
  claimDelivery,
  completeAttempt,
  dispatchOutboxBatch,
  insertEventWithDeliveries,
  recoverExpiredLeases,
  reissueLostDispatches,
  replayDelivery,
  type DispatchJob,
} from '@lab/db';
import { SEED, type AttemptDecision } from '@lab/shared';
import {
  count,
  createCustomRun,
  createTestDatabase,
  deliveryRows,
  type TestDatabase,
} from './harness';

const OK: AttemptDecision = { kind: 'succeeded', outcome: 'success', errorCode: null };
const retry = (delayMs: number): AttemptDecision => ({
  kind: 'retry',
  outcome: 'http_retryable',
  errorCode: 'http_500',
  delayMs,
  nextAttemptAtMs: Date.now() + delayMs,
  retryAfterApplied: false,
});
const dead = (
  reason: 'permanent_failure' | 'attempts_exhausted' = 'permanent_failure',
): AttemptDecision => ({
  kind: 'dead',
  outcome: 'http_permanent',
  errorCode: 'http_400',
  reason,
});
const OBS = { httpStatus: 200, errorCode: null, durationMs: 5, responsePreview: 'ok' };

describe('delivery engine on real PostgreSQL', () => {
  let t: TestDatabase;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDatabase('http://127.0.0.1:1/webhooks/receiver-fixture');
  });
  afterAll(async () => {
    await t.drop();
  });

  /** Creates one event with `copies` deliveries in the open manual run (nothing is dispatched). */
  async function makeDeliveries(copies = 1, maxAttempts = 5) {
    const [endpoint] = await t.query<{ id: string }>('SELECT id FROM endpoints LIMIT 1');
    const accepted = await t.db.$transaction((tx) =>
      insertEventWithDeliveries(tx, {
        runId: SEED.manualRunId,
        type: 'demo.counter.increment',
        aggregateId: 'engine',
        sequence: ++seq,
        logicalIndex: seq,
        data: { delta: 1 },
        endpointIds: [endpoint!.id],
        copies,
        maxAttempts,
      }),
    );
    return accepted;
  }

  const claim = (deliveryId: string, generation = 1, leaseMs = 60_000) =>
    claimDelivery(t.db, { deliveryId, generation, leaseMs });
  const row = async (id: string) =>
    (await t.query<Record<string, any>>('SELECT * FROM deliveries WHERE id = $1', [id]))[0]!;

  describe('accepting events', () => {
    it('writes event, deliveries and outbox rows atomically with the raw payload and hash', async () => {
      const a = await makeDeliveries(3);
      expect(a.deliveryIds).toHaveLength(3);
      const [ev] = await t.query<{ raw_payload: string; payload_hash: string }>(
        'SELECT raw_payload, payload_hash FROM events WHERE id = $1',
        [a.eventId],
      );
      expect(ev!.raw_payload).toBe(a.rawPayload);
      expect(ev!.payload_hash).toBe(a.payloadHash);
      expect(
        await count(t, 'outbox', "delivery_id = ANY($1::text[]) AND status = 'pending'", [
          a.deliveryIds,
        ]),
      ).toBe(3);
      // several deliveries of the same event + endpoint are allowed (no unique(event, endpoint))
      const ordinals = await t.query<{ ordinal: number }>(
        'SELECT ordinal FROM deliveries WHERE event_id = $1 ORDER BY ordinal',
        [a.eventId],
      );
      expect(ordinals.map((o) => o.ordinal)).toEqual([1, 2, 3]);
    });

    it('rolls everything back when the transaction fails', async () => {
      const before = await count(t, 'events');
      const beforeOutbox = await count(t, 'outbox');
      const [endpoint] = await t.query<{ id: string }>('SELECT id FROM endpoints LIMIT 1');
      await expect(
        t.db.$transaction(async (tx) => {
          await insertEventWithDeliveries(tx, {
            runId: SEED.manualRunId,
            type: 'demo.counter.increment',
            aggregateId: 'rollback',
            sequence: 1,
            logicalIndex: 99,
            data: { delta: 1 },
            endpointIds: [endpoint!.id],
            copies: 2,
            maxAttempts: 5,
          });
          throw new Error('boom after inserts');
        }),
      ).rejects.toThrow('boom');
      expect(await count(t, 'events')).toBe(before);
      expect(await count(t, 'outbox')).toBe(beforeOutbox);
    });

    it('validates the envelope', async () => {
      const [endpoint] = await t.query<{ id: string }>('SELECT id FROM endpoints LIMIT 1');
      await expect(
        t.db.$transaction((tx) =>
          insertEventWithDeliveries(tx, {
            runId: SEED.manualRunId,
            type: 'demo.counter.increment',
            aggregateId: 'x',
            sequence: 1,
            logicalIndex: 0,
            data: { delta: 'many' },
            endpointIds: [endpoint!.id],
            copies: 1,
            maxAttempts: 5,
          }),
        ),
      ).rejects.toBeInstanceOf(DomainError);
    });
  });

  describe('claim: atomic, fenced, idempotent for re-run jobs', () => {
    it('10 concurrent claims of one delivery: exactly one wins, one attempt row, one budget unit', async () => {
      const { deliveryIds } = await makeDeliveries();
      const id = deliveryIds[0]!;
      const results = await Promise.all(Array.from({ length: 10 }, () => claim(id)));
      expect(results.filter((r) => r.claimed)).toHaveLength(1);
      expect(
        results.filter((r) => !r.claimed && r.reason === 'held_by_other').length,
      ).toBeGreaterThanOrEqual(1);
      expect(await count(t, 'delivery_attempts', 'delivery_id = $1', [id])).toBe(1);
      const d = await row(id);
      expect(d.state).toBe('in_flight');
      expect(d.attempt_count).toBe(1);
      expect(d.claim_token).toBeTruthy();
      expect(d.lease_until).toBeTruthy();
    });

    it('rejects a job with a stale generation', async () => {
      const { deliveryIds } = await makeDeliveries();
      const r = await claim(deliveryIds[0]!, 7);
      expect(r).toEqual({ claimed: false, reason: 'stale_generation' });
      expect((await row(deliveryIds[0]!)).state).toBe('queued');
    });

    it('a job re-run after the delivery is terminal does nothing (no attempt, no budget)', async () => {
      const { deliveryIds } = await makeDeliveries();
      const id = deliveryIds[0]!;
      const c = await claim(id);
      if (!c.claimed) throw new Error('expected claim');
      expect(
        (
          await completeAttempt(t.db, {
            deliveryId: id,
            attemptNo: 1,
            claimToken: c.claim.claimToken,
            decision: OK,
            observation: OBS,
          })
        ).applied,
      ).toBe(true);
      const again = await claim(id);
      expect(again).toEqual({ claimed: false, reason: 'terminal' });
      expect(await count(t, 'delivery_attempts', 'delivery_id = $1', [id])).toBe(1);
      expect((await row(id)).attempt_count).toBe(1);
    });

    it('records success: state succeeded, claim cleared, attempt finished with evidence', async () => {
      const { deliveryIds } = await makeDeliveries();
      const id = deliveryIds[0]!;
      const c = await claim(id);
      if (!c.claimed) throw new Error('expected claim');
      await completeAttempt(t.db, {
        deliveryId: id,
        attemptNo: 1,
        claimToken: c.claim.claimToken,
        decision: OK,
        observation: OBS,
      });
      const d = await row(id);
      expect(d).toMatchObject({
        state: 'succeeded',
        claim_token: null,
        lease_until: null,
        next_attempt_at: null,
      });
      expect(d.finished_at).toBeTruthy();
      const [a] = await t.query<Record<string, any>>(
        'SELECT * FROM delivery_attempts WHERE delivery_id = $1',
        [id],
      );
      expect(a).toMatchObject({
        outcome: 'success',
        http_status: 200,
        duration_ms: 5,
        response_preview: 'ok',
      });
      expect(a!.finished_at).toBeTruthy();
    });

    it('a retry moves to retry_wait with a new generation and a future outbox row; old/early jobs are rejected', async () => {
      const { deliveryIds } = await makeDeliveries();
      const id = deliveryIds[0]!;
      const c = await claim(id);
      if (!c.claimed) throw new Error('expected claim');
      await completeAttempt(t.db, {
        deliveryId: id,
        attemptNo: 1,
        claimToken: c.claim.claimToken,
        decision: retry(60_000),
        observation: { ...OBS, httpStatus: 500, errorCode: 'http_500' },
      });
      const d = await row(id);
      expect(d).toMatchObject({
        state: 'retry_wait',
        generation: 2,
        attempt_count: 1,
        last_error_code: 'http_500',
      });
      const [ob] = await t.query<Record<string, any>>(
        'SELECT * FROM outbox WHERE delivery_id = $1 AND generation = 2',
        [id],
      );
      expect(ob).toMatchObject({ status: 'pending' });
      expect(new Date(ob!.available_at).getTime()).toBeGreaterThan(Date.now() + 30_000);
      expect(await claim(id, 1)).toEqual({ claimed: false, reason: 'stale_generation' });
      expect(await claim(id, 2)).toEqual({ claimed: false, reason: 'not_due' });
    });

    it('goes dead with history preserved when the decision says so', async () => {
      const { deliveryIds } = await makeDeliveries();
      const id = deliveryIds[0]!;
      const c = await claim(id);
      if (!c.claimed) throw new Error('expected claim');
      await completeAttempt(t.db, {
        deliveryId: id,
        attemptNo: 1,
        claimToken: c.claim.claimToken,
        decision: dead('attempts_exhausted'),
        observation: { ...OBS, httpStatus: 400 },
      });
      expect(await row(id)).toMatchObject({ state: 'dead', terminal_reason: 'attempts_exhausted' });
      expect(await count(t, 'delivery_attempts', 'delivery_id = $1', [id])).toBe(1);
    });

    it('never claims beyond max_attempts', async () => {
      const { deliveryIds } = await makeDeliveries(1, 1);
      const id = deliveryIds[0]!;
      await t.query('UPDATE deliveries SET attempt_count = 1 WHERE id = $1', [id]);
      expect(await claim(id)).toEqual({ claimed: false, reason: 'budget_exhausted' });
    });
  });

  describe('lease expiry: worker crash recovery with fencing', () => {
    it('marks the attempt worker_lost, issues a new generation, and ignores the late result of the old worker', async () => {
      const { deliveryIds } = await makeDeliveries();
      const id = deliveryIds[0]!;
      const c = await claim(id);
      if (!c.claimed) throw new Error('expected claim');
      // the worker "dies": its lease runs out
      await t.query(
        "UPDATE deliveries SET lease_until = now() - interval '1 second' WHERE id = $1",
        [id],
      );

      const rec = await recoverExpiredLeases(t.db);
      expect(rec.recovered).toBeGreaterThanOrEqual(1);
      const d = await row(id);
      expect(d).toMatchObject({
        state: 'retry_wait',
        generation: 2,
        attempt_count: 1,
        claim_token: null,
      });
      const [a] = await t.query<Record<string, any>>(
        'SELECT * FROM delivery_attempts WHERE delivery_id = $1',
        [id],
      );
      expect(a).toMatchObject({ outcome: 'worker_lost', error_code: 'worker_lost' });
      expect(await count(t, 'outbox', 'delivery_id = $1 AND generation = 2', [id])).toBe(1);

      // the old worker comes back from the dead and reports success: it must not win
      const late = await completeAttempt(t.db, {
        deliveryId: id,
        attemptNo: 1,
        claimToken: c.claim.claimToken,
        decision: OK,
        observation: OBS,
      });
      expect(late.applied).toBe(false);
      expect(await row(id)).toMatchObject({ state: 'retry_wait', generation: 2 });
      const [after] = await t.query<Record<string, any>>(
        'SELECT outcome::text AS outcome, late_result FROM delivery_attempts WHERE delivery_id = $1',
        [id],
      );
      expect(after!.outcome).toBe('worker_lost');
      expect(after!.late_result).toMatchObject({ httpStatus: 200 });
    });

    it('a lost attempt that exhausts the budget goes dead (unknown attempts consume budget)', async () => {
      const { deliveryIds } = await makeDeliveries(1, 1);
      const id = deliveryIds[0]!;
      const c = await claim(id);
      if (!c.claimed) throw new Error('expected claim');
      await t.query(
        "UPDATE deliveries SET lease_until = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      const rec = await recoverExpiredLeases(t.db);
      expect(rec.dead).toBeGreaterThanOrEqual(1);
      expect(await row(id)).toMatchObject({ state: 'dead', terminal_reason: 'attempts_exhausted' });
    });

    it('does not touch deliveries whose lease is still valid', async () => {
      const { deliveryIds } = await makeDeliveries();
      const id = deliveryIds[0]!;
      await claim(id, 1, 60_000);
      await recoverExpiredLeases(t.db);
      expect((await row(id)).state).toBe('in_flight');
    });

    it('concurrent recovery ticks recover a delivery exactly once', async () => {
      const { deliveryIds } = await makeDeliveries();
      const id = deliveryIds[0]!;
      await claim(id);
      await t.query(
        "UPDATE deliveries SET lease_until = now() - interval '1 second' WHERE id = $1",
        [id],
      );
      await Promise.all(Array.from({ length: 5 }, () => recoverExpiredLeases(t.db)));
      expect((await row(id)).generation).toBe(2);
      expect(await count(t, 'outbox', 'delivery_id = $1 AND generation = 2', [id])).toBe(1);
    });
  });

  describe('outbox dispatcher', () => {
    async function drain() {
      // publish everything currently due so each test starts clean
      await dispatchOutboxBatch(t.db, async () => undefined, 10_000);
    }

    it('leaves rows pending when the queue publish fails (Redis down) and publishes them later', async () => {
      await drain();
      const { deliveryIds } = await makeDeliveries(3);
      await expect(
        dispatchOutboxBatch(
          t.db,
          async () => {
            throw new Error('redis unavailable');
          },
          50,
        ),
      ).rejects.toThrow('redis unavailable');
      expect(
        await count(t, 'outbox', "delivery_id = ANY($1::text[]) AND status = 'pending'", [
          deliveryIds,
        ]),
      ).toBe(3);

      const seen: DispatchJob[] = [];
      const n = await dispatchOutboxBatch(
        t.db,
        async (jobs) => {
          seen.push(...jobs);
        },
        50,
      );
      expect(n).toBe(3);
      expect(seen.map((j) => j.deliveryId).sort()).toEqual([...deliveryIds].sort());
      expect(seen.every((j) => j.jobId === `${j.deliveryId}_g1` && j.generation === 1)).toBe(true);
      expect(
        await count(
          t,
          'outbox',
          "delivery_id = ANY($1::text[]) AND status = 'published' AND published_at IS NOT NULL",
          [deliveryIds],
        ),
      ).toBe(3);
    });

    it('a crash after enqueue but before the commit re-publishes under the same job id', async () => {
      await drain();
      const { deliveryIds } = await makeDeliveries();
      const first: DispatchJob[] = [];
      // publish succeeded, then the process "crashes" before the row is marked published
      await expect(
        dispatchOutboxBatch(
          t.db,
          async (jobs) => {
            first.push(...jobs);
            throw new Error('crash after enqueue');
          },
          10,
        ),
      ).rejects.toThrow();
      const second: DispatchJob[] = [];
      await dispatchOutboxBatch(
        t.db,
        async (jobs) => {
          second.push(...jobs);
        },
        10,
      );
      expect(second.map((j) => j.jobId)).toEqual(first.map((j) => j.jobId));
      expect(second[0]!.deliveryId).toBe(deliveryIds[0]);
    });

    it('concurrent dispatchers publish disjoint batches (SKIP LOCKED)', async () => {
      await drain();
      const { deliveryIds } = await makeDeliveries(20);
      const published: string[][] = [[], [], [], []];
      await Promise.all(
        published.map((bucket) =>
          dispatchOutboxBatch(
            t.db,
            async (jobs) => {
              await new Promise((r) => setTimeout(r, 30));
              bucket.push(...jobs.map((j) => j.deliveryId));
            },
            5,
          ),
        ),
      );
      const all = published.flat();
      expect(new Set(all).size).toBe(all.length); // nothing published twice
      expect(all.every((d) => deliveryIds.includes(d))).toBe(true);
      expect(all).toHaveLength(20);
    });

    it('does not publish rows that are not due yet', async () => {
      await drain();
      const { deliveryIds } = await makeDeliveries();
      await t.query(
        "UPDATE outbox SET available_at = now() + interval '1 hour' WHERE delivery_id = $1",
        [deliveryIds[0]],
      );
      const seen: DispatchJob[] = [];
      await dispatchOutboxBatch(
        t.db,
        async (jobs) => {
          seen.push(...jobs);
        },
        50,
      );
      expect(seen.find((j) => j.deliveryId === deliveryIds[0])).toBeUndefined();
    });
  });

  describe('reconciler: lost jobs (Redis state gone)', () => {
    it('re-issues a published-but-unclaimed delivery with a new generation; the old job is rejected', async () => {
      const { deliveryIds } = await makeDeliveries();
      const id = deliveryIds[0]!;
      await dispatchOutboxBatch(t.db, async () => undefined, 1000);
      // too fresh: nothing happens
      expect((await reissueLostDispatches(t.db, 60_000)).redispatched).toBe(0);
      await t.query(
        "UPDATE outbox SET published_at = now() - interval '5 minutes' WHERE delivery_id = $1",
        [id],
      );
      const rep = await reissueLostDispatches(t.db, 1000);
      expect(rep.redispatched).toBeGreaterThanOrEqual(1);
      expect((await row(id)).generation).toBe(2);
      expect(
        await count(t, 'outbox', "delivery_id = $1 AND generation = 2 AND status = 'pending'", [
          id,
        ]),
      ).toBe(1);
      expect(await claim(id, 1)).toEqual({ claimed: false, reason: 'stale_generation' });
      const ok = await claim(id, 2);
      expect(ok.claimed).toBe(true);
    });

    it('creates the missing outbox row for a waiting delivery that has none', async () => {
      const { deliveryIds } = await makeDeliveries();
      const id = deliveryIds[0]!;
      await t.query('DELETE FROM outbox WHERE delivery_id = $1', [id]);
      await t.query(
        "UPDATE deliveries SET updated_at = now() - interval '5 minutes' WHERE id = $1",
        [id],
      );
      const rep = await reissueLostDispatches(t.db, 1000);
      expect(rep.missingOutbox).toBeGreaterThanOrEqual(1);
      expect(await count(t, 'outbox', "delivery_id = $1 AND status = 'pending'", [id])).toBe(1);
    });
  });

  describe('replay', () => {
    async function terminalDelivery(kind: 'dead' | 'succeeded') {
      const { deliveryIds, eventId, rawPayload } = await makeDeliveries();
      const id = deliveryIds[0]!;
      const c = await claim(id);
      if (!c.claimed) throw new Error('expected claim');
      await completeAttempt(t.db, {
        deliveryId: id,
        attemptNo: 1,
        claimToken: c.claim.claimToken,
        decision: kind === 'dead' ? dead() : OK,
        observation: OBS,
      });
      return { id, eventId, rawPayload };
    }

    it('creates a new delivery for the same event with a fresh budget; the original keeps its history', async () => {
      const { id, eventId, rawPayload } = await terminalDelivery('dead');
      const r = await replayDelivery(t.db, id);
      expect(r).toMatchObject({ replayOfDeliveryId: id, eventId });
      expect(r.deliveryId).not.toBe(id);
      const orig = await row(id);
      expect(orig).toMatchObject({ state: 'dead', attempt_count: 1 });
      expect(await count(t, 'delivery_attempts', 'delivery_id = $1', [id])).toBe(1);
      const created = await row(r.deliveryId);
      expect(created).toMatchObject({
        state: 'queued',
        attempt_count: 0,
        event_id: eventId,
        replay_of_delivery_id: id,
        ordinal: 2,
      });
      expect(
        await count(t, 'outbox', "delivery_id = $1 AND status = 'pending'", [r.deliveryId]),
      ).toBe(1);
      const [ev] = await t.query<{ raw_payload: string }>(
        'SELECT raw_payload FROM events WHERE id = $1',
        [eventId],
      );
      expect(ev!.raw_payload).toBe(rawPayload);
      expect(await count(t, 'events', 'id = $1', [eventId])).toBe(1);
    });

    it('rejects replay of a non-terminal delivery and of unknown ids', async () => {
      const { deliveryIds } = await makeDeliveries();
      await expect(replayDelivery(t.db, deliveryIds[0]!)).rejects.toMatchObject({
        code: 'not_terminal',
      });
      await expect(replayDelivery(t.db, randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    });

    it('concurrent replay requests create exactly one replay', async () => {
      const { id } = await terminalDelivery('dead');
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => replayDelivery(t.db, id)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        results.filter(
          (r) => r.status === 'rejected' && (r.reason as DomainError).code === 'replay_in_progress',
        ),
      ).toHaveLength(5);
      expect(await count(t, 'deliveries', 'replay_of_delivery_id = $1', [id])).toBe(1);
    });
  });

  describe('runs', () => {
    it('allows only one active run at a time (409 semantics)', async () => {
      const first = await createCustomRun(t.db, {});
      await expect(createCustomRun(t.db, {})).rejects.toMatchObject({ code: 'run_already_active' });
      expect((await deliveryRows(t, first.runId)).length).toBe(1);
      await t.query("UPDATE scenario_runs SET status = 'passed' WHERE id = $1", [first.runId]);
      await expect(createCustomRun(t.db, {})).resolves.toBeDefined();
    });
  });
});
