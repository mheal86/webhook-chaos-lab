import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Queue } from 'bullmq';
import request from 'supertest';
import { parseRedisUrl, type AppConfig } from '@lab/shared';
import {
  ReceiverHandle,
  TestRedis,
  count,
  createCustomRun,
  createTestDatabase,
  freePort,
  makeConfig,
  spawnApp,
  startApi,
  startWorker,
  waitFor,
  waitForWorkerReady,
  type ChildHandle,
  type TestDatabase,
} from './harness';

/**
 * Failure windows of the delivery pipeline, exercised against real PostgreSQL, a real redis-server
 * process and (for the worker crash) a real OS process that is SIGKILLed.
 */
describe('recovery and failure windows', () => {
  let t: TestDatabase;
  let redis: TestRedis;
  let config: AppConfig;
  let receiver: ReceiverHandle;
  const cleanup: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    const port = await freePort();
    redis = await TestRedis.create();
    t = await createTestDatabase(`http://127.0.0.1:${port}/webhooks/receiver-fixture`);
    config = await makeConfig({
      databaseUrl: t.url,
      redisUrl: redis.url,
      receiverPort: port,
      overrides: { LEASE_MS: 2000, DISPATCH_GRACE_MS: 1500 },
    });
    receiver = new ReceiverHandle(config);
    await receiver.start();
  });

  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!().catch(() => undefined);
    await redis.start(); // every test starts with Redis up
    await receiver.start();
  });

  afterAll(async () => {
    await receiver.stop();
    await redis.stop();
    await t.drop();
  });

  async function api(opts: { backgroundJobs?: boolean } = {}): Promise<INestApplication> {
    const app = await startApi(config, opts);
    cleanup.push(() => app.close());
    return app;
  }
  async function worker(): Promise<INestApplicationContext> {
    const app = await startWorker(config);
    cleanup.push(() => app.close());
    return app;
  }
  async function postEvent(app: INestApplication, delta = 1) {
    const res = await request(app.getHttpServer())
      .post('/api/events')
      .send({ type: 'demo.counter.increment', aggregateId: 'recovery', sequence: 1, data: { delta } });
    expect(res.status).toBe(202);
    return { eventId: res.body.eventId as string, deliveryId: res.body.deliveryIds[0] as string };
  }
  const delivery = async (id: string) =>
    (await t.query<Record<string, any>>('SELECT * FROM deliveries WHERE id = $1', [id]))[0]!;
  const attempts = (id: string) =>
    t.query<Record<string, any>>(
      'SELECT attempt_no, outcome::text AS outcome, http_status, error_code FROM delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_no',
      [id],
    );
  const effectsFor = (eventId: string) => count(t, 'business_effects', 'event_id = $1', [eventId]);
  const succeeded = (id: string, timeoutMs = 30_000) =>
    waitFor(async () => (await delivery(id)).state === 'succeeded', { timeoutMs, what: `delivery ${id} to succeed` });

  it('crash after the DB commit but before the enqueue: a restarted dispatcher still delivers the accepted event', async () => {
    const crashed = await api({ backgroundJobs: false }); // dispatcher never runs: "crash" before enqueue
    const { eventId, deliveryId } = await postEvent(crashed);
    expect(await count(t, 'outbox', "delivery_id = $1 AND status = 'pending'", [deliveryId])).toBe(1);
    await crashed.close();
    cleanup.length = 0;

    const d = await delivery(deliveryId);
    expect(d).toMatchObject({ state: 'queued', attempt_count: 0 }); // accepted and durable, not yet sent

    await worker();
    await api(); // "restart": dispatcher picks the pending outbox row up
    await succeeded(deliveryId);
    expect(await effectsFor(eventId)).toBe(1);
    expect((await attempts(deliveryId)).map((a) => a.outcome)).toEqual(['success']);
  });

  it('Redis down: the event is still accepted (202) and durable; it is dispatched after Redis returns', async () => {
    const app = await api();
    await worker();
    await redis.stop();
    const { eventId, deliveryId } = await postEvent(app);
    expect(await count(t, 'events', 'id = $1', [eventId])).toBe(1);

    const ready = await request(app.getHttpServer()).get('/api/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: 'degraded', checks: { postgres: true, redis: false } });

    await new Promise((r) => setTimeout(r, 1200)); // several dispatcher ticks while Redis is down
    expect(await delivery(deliveryId)).toMatchObject({ state: 'queued', attempt_count: 0 });
    expect(await count(t, 'outbox', "delivery_id = $1 AND status = 'pending'", [deliveryId])).toBe(1);

    await redis.start();
    await succeeded(deliveryId, 40_000);
    expect(await effectsFor(eventId)).toBe(1);
  });

  it('Redis queue state lost: the reconciler finds the unfinished delivery in PostgreSQL and re-issues it', async () => {
    const app = await api(); // dispatcher + recovery run, but no worker yet
    const { eventId, deliveryId } = await postEvent(app);
    await waitFor(async () => (await count(t, 'outbox', "delivery_id = $1 AND status = 'published'", [deliveryId])) === 1, { what: 'job to be published' });

    await redis.stop();
    await redis.start(); // no persistence: the published job is gone
    const lostJobs = new Queue(config.QUEUE_NAME, { connection: parseRedisUrl(config.REDIS_URL), prefix: config.QUEUE_PREFIX });
    cleanup.push(() => lostJobs.close());
    expect(await lostJobs.getJobCounts('waiting', 'active', 'delayed')).toMatchObject({ waiting: 0, active: 0, delayed: 0 });

    await worker();
    await succeeded(deliveryId, 40_000);
    const d = await delivery(deliveryId);
    expect(d.generation).toBeGreaterThanOrEqual(2); // a new generation was issued by the reconciler
    expect(await effectsFor(eventId)).toBe(1);
    expect(await count(t, 'delivery_attempts', 'delivery_id = $1', [deliveryId])).toBe(1);
  });

  it('receiver process stopped, then started again within the retry budget: the delivery continues and succeeds', async () => {
    const app = await api();
    await worker();
    await receiver.stop(); // a really absent process: connection refused, not an HTTP 500
    const { eventId, deliveryId } = await postEvent(app);
    await waitFor(async () => (await attempts(deliveryId)).length >= 1 && (await delivery(deliveryId)).state === 'retry_wait', { what: 'first attempt to fail' });
    const first = (await attempts(deliveryId))[0]!;
    expect(first).toMatchObject({ outcome: 'network_error', http_status: null });
    expect(first.error_code).toMatch(/^network_/);

    await receiver.start();
    await succeeded(deliveryId, 40_000);
    const all = await attempts(deliveryId);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[all.length - 1]!.outcome).toBe('success');
    expect(await effectsFor(eventId)).toBe(1);
  });

  it('worker SIGKILLed after the receiver committed but before the sender recorded success: lease recovery, still one effect', async () => {
    const app = await api();
    const workerCfg = { ...config };
    let w: ChildHandle = spawnApp('worker', workerCfg);
    cleanup.push(() => w.kill());
    await waitForWorkerReady(workerCfg);

    const { runId } = await createCustomRun(t.db, {
      config: { httpTimeoutMs: 9000, baseDelayMs: 50, capDelayMs: 100, jitter: 0 },
      plan: { seed: 1, rules: [{ attemptNo: 1, action: { kind: 'commit_then_delay', delayMs: 7000 } }] },
    });
    const [{ id: eventId }] = await t.query<{ id: string }>('SELECT id FROM events WHERE run_id = $1', [runId]);
    const [{ id: deliveryId }] = await t.query<{ id: string }>('SELECT id FROM deliveries WHERE run_id = $1', [runId]);

    // receiver has committed the business effect (and is now sitting on the response)...
    await waitFor(async () => (await effectsFor(eventId!)) === 1, { timeoutMs: 20_000, what: 'receiver commit' });
    expect((await delivery(deliveryId!)).state).toBe('in_flight');
    // ...and the worker dies before it can record anything.
    await w.kill();

    await new Promise((r) => setTimeout(r, 100));
    w = spawnApp('worker', workerCfg); // a replacement worker
    cleanup.push(() => w.kill());

    await succeeded(deliveryId!, 40_000); // not stuck forever
    const all = await attempts(deliveryId!);
    expect(all.map((a) => a.outcome)).toEqual(['worker_lost', 'success']);
    expect(await effectsFor(eventId!)).toBe(1); // sum of effects is still one
    expect(await count(t, 'receiver_requests', "event_id = $1 AND result = 'duplicate'", [eventId])).toBeGreaterThanOrEqual(1);
    // the supervisor closes the run too
    await waitFor(async () => (await t.query<{ status: string }>('SELECT status::text AS status FROM scenario_runs WHERE id = $1', [runId]))[0]!.status === 'passed', { what: 'run to finish' });
    await app.close();
  });

  it('a job re-run after the delivery is terminal causes no HTTP send and no effect', async () => {
    const app = await api();
    await worker();
    const { eventId, deliveryId } = await postEvent(app);
    await succeeded(deliveryId);
    const requestsBefore = await count(t, 'receiver_requests', 'event_id = $1', [eventId]);

    const queue = new Queue(config.QUEUE_NAME, { connection: parseRedisUrl(config.REDIS_URL), prefix: config.QUEUE_PREFIX });
    cleanup.push(() => queue.close());
    const job = await queue.add('deliver', { deliveryId, generation: 1 }, { jobId: `rerun_${deliveryId}`, attempts: 1 });
    await waitFor(async () => (await job.getState()) === 'completed', { timeoutMs: 20_000, what: 'duplicate job to be processed' });

    expect(await count(t, 'receiver_requests', 'event_id = $1', [eventId])).toBe(requestsBefore);
    expect(await count(t, 'delivery_attempts', 'delivery_id = $1', [deliveryId])).toBe(1);
    expect(await effectsFor(eventId)).toBe(1);
    expect(await delivery(deliveryId)).toMatchObject({ state: 'succeeded', attempt_count: 1 });
  });

  it('a job that arrives while another worker holds a valid claim is rejected (no concurrent second send)', async () => {
    const app = await api();
    await worker();
    const { runId } = await createCustomRun(t.db, {
      config: { httpTimeoutMs: 3000 },
      plan: { seed: 1, rules: [{ attemptNo: 1, action: { kind: 'commit_then_delay', delayMs: 1500 } }] },
    });
    const [{ id: deliveryId }] = await t.query<{ id: string }>('SELECT id FROM deliveries WHERE run_id = $1', [runId]);
    await waitFor(async () => (await delivery(deliveryId!)).state === 'in_flight', { what: 'attempt in flight' });

    const queue = new Queue(config.QUEUE_NAME, { connection: parseRedisUrl(config.REDIS_URL), prefix: config.QUEUE_PREFIX });
    cleanup.push(() => queue.close());
    const job = await queue.add('deliver', { deliveryId, generation: 1 }, { jobId: `dup_${deliveryId}`, attempts: 1 });
    await waitFor(async () => (await job.getState()) === 'completed', { timeoutMs: 10_000 });
    expect(await count(t, 'delivery_attempts', 'delivery_id = $1', [deliveryId])).toBe(1);

    await succeeded(deliveryId!, 30_000);
    await waitFor(async () => (await t.query<{ status: string }>('SELECT status::text AS status FROM scenario_runs WHERE id = $1', [runId]))[0]!.status === 'passed');
    await app.close();
  });
});
