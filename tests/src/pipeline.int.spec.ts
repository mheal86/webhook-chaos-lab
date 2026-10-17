import { randomUUID } from 'node:crypto';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import type { AppConfig, RunDto } from '@lab/shared';
import {
  ReceiverHandle,
  TestRedis,
  count,
  createTestDatabase,
  freePort,
  makeConfig,
  startApi,
  startWorker,
  waitFor,
  type TestDatabase,
} from './harness';

const FAST = { baseDelayMs: 50, capDelayMs: 200, jitter: 0.2 };

describe('full pipeline: API -> outbox -> BullMQ -> worker -> HTTP receiver (PostgreSQL + Redis + real HTTP)', () => {
  let t: TestDatabase;
  let redis: TestRedis;
  let config: AppConfig;
  let receiver: ReceiverHandle;
  let api: INestApplication;
  let worker: INestApplicationContext;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const port = await freePort();
    redis = await TestRedis.create();
    t = await createTestDatabase(`http://127.0.0.1:${port}/webhooks/receiver-fixture`);
    config = await makeConfig({ databaseUrl: t.url, redisUrl: redis.url, receiverPort: port });
    receiver = new ReceiverHandle(config);
    await receiver.start();
    api = await startApi(config);
    worker = await startWorker(config);
    http = request(api.getHttpServer());
  });

  afterAll(async () => {
    await worker?.close();
    await api?.close();
    await receiver?.stop();
    await redis?.stop();
    await t?.drop();
  });

  async function runScenario(type: string, body: Record<string, unknown> = {}): Promise<RunDto> {
    const created = await http.post(`/api/scenarios/${type}/runs`).send({ seed: 42, ...body });
    expect(created.status).toBe(202);
    const runId = created.body.runId as string;
    return waitFor(
      async () => {
        const r = await http.get(`/api/runs/${runId}`);
        return r.body.status !== 'running' ? (r.body as RunDto) : null;
      },
      { timeoutMs: 60_000, intervalMs: 100, what: `${type} run to finish` },
    );
  }

  const summarize = (run: RunDto) =>
    run.assertions
      .map((a) => `${a.status} ${a.key}: actual=${a.actual} expected=${a.expectedValue}`)
      .join('\n');

  it.each([
    ['healthy', {}],
    ['fail_twice', { config: FAST }],
    ['duplicate_storm', {}],
    ['timeout_after_commit', { config: { ...FAST, httpTimeoutMs: 400 } }],
    ['out_of_order', {}],
    ['invalid_signature', {}],
    ['exhaust_and_replay', { config: { ...FAST, maxAttempts: 3 } }],
  ])('scenario %s passes all expected-vs-actual assertions', async (type, body) => {
    const run = await runScenario(type, body as Record<string, unknown>);
    expect({ status: run.status, reason: run.failureReason, assertions: summarize(run) }).toEqual({
      status: 'passed',
      reason: null,
      assertions: expect.not.stringContaining('failed'),
    });
    expect(run.finishedAt).not.toBeNull();
    expect(run.assertions.length).toBeGreaterThan(3);
  });

  it('is reproducible: same seed and config yield the same fault plan and expectations', async () => {
    const a = await runScenario('fail_twice', { seed: 99, config: FAST });
    const b = await runScenario('fail_twice', { seed: 99, config: FAST });
    expect(a.id).not.toBe(b.id);
    expect(a.faultPlan).toEqual(b.faultPlan);
    expect(a.config).toEqual(b.config);
    expect(a.assertions.map((x) => [x.key, x.actual])).toEqual(
      b.assertions.map((x) => [x.key, x.actual]),
    );
  });

  it('duplicate storm: 20 deliveries of one eventId, 20 requests, 1 effect, 19 duplicates', async () => {
    const run = await runScenario('duplicate_storm');
    const metrics = (await http.get(`/api/runs/${run.id}/metrics`)).body;
    expect(metrics.deliveries).toMatchObject({ total: 20, succeeded: 20 });
    expect(metrics.receiver.requests).toBe(20);
    expect(metrics.receiver.byResult).toMatchObject({ processed: 1, duplicate: 19 });
    expect(metrics.businessEffects).toBe(1);
    expect(await count(t, 'events', 'run_id = $1', [run.id])).toBe(1);
  });

  it('timeout after commit: attempt 1 is a timeout (unknown at sender), retry succeeds, one effect', async () => {
    const run = await runScenario('timeout_after_commit', {
      config: { ...FAST, httpTimeoutMs: 400 },
    });
    expect(run.status).toBe('passed');
    const events = (await http.get(`/api/events?runId=${run.id}`)).body;
    const detail = (await http.get(`/api/events/${events.items[0].id}`)).body;
    const attempts = detail.deliveries[0].attempts;
    expect(attempts.map((a: any) => a.outcome)).toEqual(['timeout', 'success']);
    expect(attempts[0]).toMatchObject({
      unknownAtSender: true,
      httpStatus: null,
      errorCode: 'timeout',
    });
    expect(attempts[0].scheduledRetryAt).toBeTruthy();
    expect(attempts[1]).toMatchObject({ unknownAtSender: false, httpStatus: 200 });
  });

  it('out of order: the receiver really received 3,1,2 and the projection stayed at 3', async () => {
    const run = await runScenario('out_of_order');
    const state = (await http.get(`/api/receiver/state?runId=${run.id}`)).body;
    expect(state.summary.receiveOrder).toBe('3,1,2');
    expect(state.order.sequence).toBe(3);
    expect(state.effects).toHaveLength(1);
    const results = [...state.requests]
      .sort((a: any, b: any) => a.seq - b.seq)
      .map((r: any) => r.result);
    expect(results).toEqual(['processed', 'stale', 'stale']);
  });

  it('exhaust and replay: original stays dead with full history, replay succeeds with the same event', async () => {
    const run = await runScenario('exhaust_and_replay', { config: { ...FAST, maxAttempts: 3 } });
    expect(run.status).toBe('passed');
    const [event] = (await http.get(`/api/events?runId=${run.id}`)).body.items;
    const detail = (await http.get(`/api/events/${event.id}`)).body;
    expect(detail.deliveries).toHaveLength(2);
    const [original, replay] = detail.deliveries;
    expect(original).toMatchObject({
      state: 'dead',
      attemptCount: 3,
      terminalReason: 'attempts_exhausted',
    });
    expect(original.attempts.map((a: any) => a.httpStatus)).toEqual([500, 500, 500]);
    expect(replay).toMatchObject({
      state: 'succeeded',
      replayOfDeliveryId: original.id,
      attemptCount: 1,
    });
    expect(replay.eventId).toBe(original.eventId);
  });

  it('invalid signature: rejected by the receiver, permanent failure, no effect', async () => {
    const run = await runScenario('invalid_signature');
    const metrics = (await http.get(`/api/runs/${run.id}/metrics`)).body;
    expect(metrics.deliveries.deadByReason).toEqual({ permanent_failure: 1 });
    expect(metrics.receiver.byResult.rejected_signature).toBe(1);
    expect(metrics.businessEffects).toBe(0);
    const dead = (await http.get(`/api/dead-letters?runId=${run.id}`)).body;
    expect(dead.total).toBe(1);
    expect(dead.items[0].attempts[0]).toMatchObject({
      httpStatus: 401,
      outcome: 'http_permanent',
      unknownAtSender: false,
    });
  });

  describe('one active run at a time', () => {
    it('answers 409 while a run is active and accepts a new one afterwards', async () => {
      const first = await http
        .post('/api/scenarios/exhaust_and_replay/runs')
        .send({ config: { maxAttempts: 2, baseDelayMs: 700, capDelayMs: 700, jitter: 0 } });
      expect(first.status).toBe(202);
      const second = await http.post('/api/scenarios/healthy/runs').send({});
      expect(second.status).toBe(409);
      expect(second.body.error).toBe('run_already_active');
      await waitFor(
        async () => (await http.get(`/api/runs/${first.body.runId}`)).body.status !== 'running',
        { timeoutMs: 30_000, intervalMs: 100 },
      );
      const third = await http.post('/api/scenarios/healthy/runs').send({});
      expect(third.status).toBe(202);
      await waitFor(
        async () => (await http.get(`/api/runs/${third.body.runId}`)).body.status !== 'running',
        { timeoutMs: 30_000, intervalMs: 100 },
      );
    });
  });

  describe('input validation', () => {
    it.each([
      ['eventCount above the 100 limit', { config: { eventCount: 101 } }],
      ['duplicateCount above the 20 limit', { config: { duplicateCount: 21 } }],
      ['timeout above the hard cap', { config: { httpTimeoutMs: 60_000 } }],
      ['unknown config key', { config: { url: 'http://evil.example' } }],
    ])('rejects %s with 422', async (_, body) => {
      const res = await http.post('/api/scenarios/healthy/runs').send(body);
      expect(res.status).toBe(422);
    });

    it('rejects unknown scenarios with 404 and unknown body fields with 400', async () => {
      expect((await http.post('/api/scenarios/nope/runs').send({})).status).toBe(404);
      expect(
        (
          await http
            .post('/api/scenarios/healthy/runs')
            .send({ endpointUrl: 'http://evil.example' })
        ).status,
      ).toBe(400);
    });
  });

  describe('manual events', () => {
    const post = (body: Record<string, unknown>) => http.post('/api/events').send(body);

    it('202 after the PostgreSQL commit, then delivered; event/delivery/attempt endpoints agree', async () => {
      const eventId = randomUUID();
      const res = await post({
        type: 'demo.counter.increment',
        aggregateId: 'manual-1',
        sequence: 1,
        data: { delta: 3 },
        eventId,
      });
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ eventId });
      expect(res.headers['x-correlation-id']).toBeTruthy();
      // the accepted event is durable before anything is delivered
      expect(await count(t, 'events', 'id = $1', [eventId])).toBe(1);

      const deliveryId = res.body.deliveryIds[0] as string;
      const delivery = await waitFor(
        async () => {
          const d = (await http.get(`/api/deliveries/${deliveryId}`)).body;
          return d.state === 'succeeded' ? d : null;
        },
        { timeoutMs: 20_000, what: 'manual delivery' },
      );
      expect(delivery).toMatchObject({ eventId, attemptCount: 1, consumerId: 'receiver-fixture' });
      const attempts = (await http.get(`/api/deliveries/${deliveryId}/attempts`)).body;
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ attemptNo: 1, outcome: 'success', httpStatus: 200 });
      expect(attempts[0].responsePreview).toContain('processed');
      const detail = (await http.get(`/api/events/${eventId}`)).body;
      expect(JSON.parse(detail.rawPayload)).toMatchObject({ id: eventId, data: { delta: 3 } });
      expect(detail.deliveries[0].attempts).toHaveLength(1);
    });

    it('validates the body (400), the data per type (422) and rejects a reused eventId (409)', async () => {
      expect((await post({ type: 'nope', aggregateId: 'a', sequence: 1, data: {} })).status).toBe(
        400,
      );
      expect(
        (
          await post({
            type: 'demo.counter.increment',
            aggregateId: 'a',
            sequence: -1,
            data: { delta: 1 },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post({
            type: 'demo.counter.increment',
            aggregateId: 'a',
            sequence: 1,
            data: { delta: 1 },
            url: 'http://evil.example',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post({
            type: 'demo.counter.increment',
            aggregateId: 'a',
            sequence: 1,
            data: { delta: 'x' },
          })
        ).status,
      ).toBe(422);
      const eventId = randomUUID();
      expect(
        (
          await post({
            type: 'demo.counter.increment',
            aggregateId: 'a',
            sequence: 1,
            data: { delta: 1 },
            eventId,
          })
        ).status,
      ).toBe(202);
      expect(
        (
          await post({
            type: 'demo.counter.increment',
            aggregateId: 'a',
            sequence: 1,
            data: { delta: 1 },
            eventId,
          })
        ).status,
      ).toBe(409);
    });

    it('refuses manual events for runs that are not open', async () => {
      const run = await runScenario('healthy');
      const res = await post({
        type: 'demo.counter.increment',
        aggregateId: 'a',
        sequence: 1,
        data: { delta: 1 },
        runId: run.id,
      });
      expect(res.status).toBe(409);
    });
  });

  describe('listing, filters, replay API', () => {
    it('filters and paginates events', async () => {
      const run = await runScenario('healthy', { config: { eventCount: 5 } });
      const page1 = (await http.get(`/api/events?runId=${run.id}&limit=2&offset=0`)).body;
      const page2 = (await http.get(`/api/events?runId=${run.id}&limit=2&offset=2`)).body;
      expect(page1.total).toBe(5);
      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(2);
      expect(page1.items[0].id).not.toBe(page2.items[0].id);
      expect(
        (await http.get(`/api/events?runId=${run.id}&type=demo.order.snapshot`)).body.total,
      ).toBe(0);
      expect((await http.get(`/api/events?runId=${run.id}&state=succeeded`)).body.total).toBe(5);
      expect((await http.get(`/api/events?runId=${run.id}&state=dead`)).body.total).toBe(0);
      expect((await http.get(`/api/events?q=${page1.items[0].id}`)).body.total).toBe(1);
      expect((await http.get('/api/events?limit=1000')).status).toBe(400);
    });

    it('replaying a succeeded delivery succeeds again without a second business effect', async () => {
      const run = await runScenario('healthy');
      const [event] = (await http.get(`/api/events?runId=${run.id}`)).body.items;
      const deliveryId = (await http.get(`/api/events/${event.id}`)).body.deliveries[0]
        .id as string;
      const replay = await http.post(`/api/deliveries/${deliveryId}/replay`);
      expect(replay.status).toBe(202);
      expect(replay.body).toMatchObject({ replayOfDeliveryId: deliveryId, eventId: event.id });
      await waitFor(
        async () =>
          (await http.get(`/api/deliveries/${replay.body.deliveryId}`)).body.state === 'succeeded',
        { timeoutMs: 20_000 },
      );
      const metrics = (await http.get(`/api/runs/${run.id}/metrics`)).body;
      expect(metrics.businessEffects).toBe(1);
      expect(metrics.receiver.byResult).toMatchObject({ processed: 1, duplicate: 1 });
      expect(metrics.lineage.replayDeliveries).toBe(1);
      const original = (await http.get(`/api/deliveries/${deliveryId}`)).body;
      expect(original.replays).toHaveLength(1);
    });

    it('replay is refused for unknown deliveries (404) and bad ids (400)', async () => {
      expect((await http.post(`/api/deliveries/${randomUUID()}/replay`)).status).toBe(404);
      expect((await http.post('/api/deliveries/not-a-uuid/replay')).status).toBe(400);
    });
  });

  describe('metrics, receiver state, health, docs', () => {
    it('documents metric definitions: p95 carries sample size, unit and window', async () => {
      const run = await runScenario('healthy', { config: { eventCount: 10 } });
      const m = (await http.get(`/api/runs/${run.id}/metrics`)).body;
      expect(m.attempts.latency).toMatchObject({ unit: 'ms', sampleCount: 10 });
      expect(typeof m.attempts.latency.p95).toBe('number');
      expect(m.attempts.latency.window).toContain('run lifetime');
      // delivery success, attempt success and business effects are three different numbers
      expect(m.deliveries.succeeded).toBe(10);
      expect(m.attempts.byOutcome.success).toBe(10);
      expect(m.businessEffects).toBe(10);
      expect(m.projections.counterValue).toBe(10);
    });

    it('serves health, scenarios, endpoints and OpenAPI', async () => {
      expect((await http.get('/api/health/live')).body.status).toBe('ok');
      const ready = await http.get('/api/health/ready');
      expect(ready.body).toMatchObject({ status: 'ok', checks: { postgres: true, redis: true } });
      const scenarios = (await http.get('/api/scenarios')).body;
      expect(scenarios.scenarios.map((s: any) => s.type)).toHaveLength(7);
      const endpoints = (await http.get('/api/endpoints')).body;
      expect(endpoints).toHaveLength(1);
      expect(endpoints[0].url).toContain('/webhooks/receiver-fixture');
      const doc = (await http.get('/api/openapi.json')).body;
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining([
          '/api/events',
          '/api/deliveries/{id}/replay',
          '/api/dead-letters',
          '/api/runs/{id}/metrics',
          '/api/receiver/state',
        ]),
      );
    });

    it('returns 404 for unknown runs', async () => {
      expect((await http.get(`/api/runs/${randomUUID()}`)).status).toBe(404);
      expect((await http.get(`/api/runs/${randomUUID()}/metrics`)).status).toBe(404);
    });
  });

  it('never calls anything outside the allowlisted receiver (endpoint URL tampering is blocked at send time)', async () => {
    const [endpoint] = await t.query<{ id: string; url: string }>('SELECT id, url FROM endpoints');
    await t.query("UPDATE endpoints SET url = 'http://127.0.0.1:9/elsewhere' WHERE id = $1", [
      endpoint!.id,
    ]);
    try {
      const res = await http.post('/api/events').send({
        type: 'demo.counter.increment',
        aggregateId: 'ssrf',
        sequence: 1,
        data: { delta: 1 },
      });
      const deliveryId = res.body.deliveryIds[0] as string;
      const d = await waitFor(
        async () => {
          const x = (await http.get(`/api/deliveries/${deliveryId}`)).body;
          return x.state === 'dead' ? x : null;
        },
        { timeoutMs: 20_000 },
      );
      expect(d.lastErrorCode).toBe('endpoint_not_allowlisted');
      expect(d.attemptCount).toBe(1);
    } finally {
      await t.query('UPDATE endpoints SET url = $2 WHERE id = $1', [endpoint!.id, endpoint!.url]);
    }
  });
});
