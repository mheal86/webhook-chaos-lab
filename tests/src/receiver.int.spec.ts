import { randomUUID } from 'node:crypto';
import {
  ReceiverHandle,
  count,
  counterEnvelope,
  createCustomRun,
  createTestDatabase,
  freePort,
  makeConfig,
  orderEnvelope,
  postWebhook,
  type TestDatabase,
} from './harness';
import type { AppConfig } from '@lab/shared';
import { SEED } from '@lab/shared';

describe('receiver: idempotency, signatures, ordering (real PostgreSQL)', () => {
  let t: TestDatabase;
  let config: AppConfig;
  let receiver: ReceiverHandle;
  const runId: string = randomUUID();

  beforeAll(async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/webhooks/receiver-fixture`;
    t = await createTestDatabase(url);
    config = await makeConfig({
      databaseUrl: t.url,
      redisUrl: 'redis://127.0.0.1:1',
      receiverPort: port,
    });
    receiver = new ReceiverHandle(config);
    await receiver.start();
  });

  afterAll(async () => {
    await receiver.stop();
    await t.drop();
  });

  const effects = (run = runId) => count(t, 'business_effects', 'run_id = $1', [run]);
  const markers = (run = runId) => count(t, 'processed_events', 'run_id = $1', [run]);
  const byResult = async (result: string, run = runId) =>
    count(t, 'receiver_requests', 'run_id = $1 AND result = $2::"ReceiverResult"', [run, result]);

  it('processes a valid signed event exactly once and records evidence', async () => {
    const run = randomUUID();
    const env = counterEnvelope({ runId: run, delta: 5 });
    const res = await postWebhook(config, env);
    expect(res.status).toBe(200);
    expect(res.json.result).toBe('processed');
    expect(await effects(run)).toBe(1);
    const [counter] = await t.query<{ value: number }>(
      'SELECT value FROM counter_projections WHERE run_id = $1',
      [run],
    );
    expect(counter!.value).toBe(5);
    const [row] = await t.query<{ signature_valid: boolean; result: string; http_status: number }>(
      'SELECT signature_valid, result::text AS result, http_status FROM receiver_requests WHERE run_id = $1',
      [run],
    );
    expect(row).toMatchObject({ signature_valid: true, result: 'processed', http_status: 200 });
  });

  it('20 concurrent requests with the same eventId produce exactly one effect', async () => {
    const run = randomUUID();
    const env = counterEnvelope({ runId: run });
    const results = await Promise.all(Array.from({ length: 20 }, () => postWebhook(config, env)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.json.result === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r.json.result === 'duplicate')).toHaveLength(19);
    expect(await effects(run)).toBe(1);
    expect(await markers(run)).toBe(1);
    expect(await count(t, 'receiver_requests', 'run_id = $1', [run])).toBe(20);
    const [counter] = await t.query<{ value: number }>(
      'SELECT value FROM counter_projections WHERE run_id = $1',
      [run],
    );
    expect(counter!.value).toBe(1);
  });

  it('same eventId with a different payload is a 409 conflict and adds no effect', async () => {
    const run = randomUUID();
    const first = counterEnvelope({ runId: run, delta: 1 });
    expect((await postWebhook(config, first)).status).toBe(200);
    const second = { ...first, data: { delta: 999 } };
    const res = await postWebhook(config, second);
    expect(res.status).toBe(409);
    expect(await effects(run)).toBe(1);
    expect(await byResult('conflict', run)).toBe(1);
    const [counter] = await t.query<{ value: number }>(
      'SELECT value FROM counter_projections WHERE run_id = $1',
      [run],
    );
    expect(counter!.value).toBe(1);
  });

  describe('signature verification on raw bytes', () => {
    it('wrong secret -> 401, no marker, no effect', async () => {
      const run = randomUUID();
      const res = await postWebhook(config, counterEnvelope({ runId: run }), {
        secret: 'not-the-secret',
      });
      expect(res.status).toBe(401);
      expect(await markers(run)).toBe(0);
      expect(await effects(run)).toBe(0);
      expect(
        await count(
          t,
          'receiver_requests',
          "result = 'rejected_signature' AND detail = 'signature_mismatch'",
        ),
      ).toBeGreaterThan(0);
    });

    it('expired timestamp (older than 5 minutes) -> 401', async () => {
      const run = randomUUID();
      const res = await postWebhook(config, counterEnvelope({ runId: run }), {
        timestampSec: Math.floor(Date.now() / 1000) - 301,
      });
      expect(res.status).toBe(401);
      expect(res.json.code).toBe('timestamp_out_of_window');
      expect(await markers(run)).toBe(0);
      expect(await effects(run)).toBe(0);
    });

    it('body changed after signing -> 401', async () => {
      const run = randomUUID();
      const res = await postWebhook(config, counterEnvelope({ runId: run }), {
        tamperBody: (raw) => raw.replace('"delta":1', '"delta":2'),
      });
      expect(res.status).toBe(401);
      expect(await effects(run)).toBe(0);
    });

    it('missing signature -> 401', async () => {
      const res = await postWebhook(config, counterEnvelope({ runId: randomUUID() }), {
        omitSignature: true,
      });
      expect(res.status).toBe(401);
      expect(res.json.code).toBe('missing_signature');
    });

    it('signature is checked on bytes: re-serialised JSON with different whitespace fails', async () => {
      const run = randomUUID();
      const env = counterEnvelope({ runId: run });
      const res = await postWebhook(config, env, {
        tamperBody: (raw) => JSON.stringify(JSON.parse(raw), null, 1),
      });
      expect(res.status).toBe(401);
      expect(await effects(run)).toBe(0);
    });

    it('X-Lab-Event-Id header that does not match the body -> 400, no effect', async () => {
      const run = randomUUID();
      const res = await postWebhook(config, counterEnvelope({ runId: run }), {
        eventIdHeader: randomUUID(),
      });
      expect(res.status).toBe(400);
      expect(await markers(run)).toBe(0);
      expect(await effects(run)).toBe(0);
    });
  });

  describe('demo.order.snapshot ordering', () => {
    it('received sequence 3, 1, 2 keeps the projection at 3 and reports stale snapshots', async () => {
      const run = randomUUID();
      const r3 = await postWebhook(config, orderEnvelope({ runId: run, sequence: 3 }));
      const r1 = await postWebhook(config, orderEnvelope({ runId: run, sequence: 1 }));
      const r2 = await postWebhook(config, orderEnvelope({ runId: run, sequence: 2 }));
      expect([r3.json.result, r1.json.result, r2.json.result]).toEqual([
        'processed',
        'stale',
        'stale',
      ]);
      expect([r3.status, r1.status, r2.status]).toEqual([200, 200, 200]);
      const [proj] = await t.query<{ sequence: number }>(
        'SELECT sequence FROM order_projections WHERE run_id = $1',
        [run],
      );
      expect(proj!.sequence).toBe(3);
      expect(await effects(run)).toBe(1);
      expect(await byResult('stale', run)).toBe(2);
    });

    it('concurrent snapshots never move the projection backwards', async () => {
      const run = randomUUID();
      const seqs = [4, 9, 1, 7, 2, 10, 5, 3, 8, 6];
      await Promise.all(
        seqs.map((s) => postWebhook(config, orderEnvelope({ runId: run, sequence: s }))),
      );
      const [proj] = await t.query<{ sequence: number }>(
        'SELECT sequence FROM order_projections WHERE run_id = $1',
        [run],
      );
      expect(proj!.sequence).toBe(10);
    });

    it('the stale rule does not apply to counter increments (additive events)', async () => {
      const run = randomUUID();
      await postWebhook(config, counterEnvelope({ runId: run, sequence: 5, delta: 2 }));
      const res = await postWebhook(config, counterEnvelope({ runId: run, sequence: 1, delta: 3 }));
      expect(res.json.result).toBe('processed');
      const [counter] = await t.query<{ value: number }>(
        'SELECT value FROM counter_projections WHERE run_id = $1',
        [run],
      );
      expect(counter!.value).toBe(5);
      expect(await effects(run)).toBe(2);
    });
  });

  it('a stale snapshot replayed again is a duplicate, not a second stale effect', async () => {
    const run = randomUUID();
    await postWebhook(config, orderEnvelope({ runId: run, sequence: 5 }));
    const old = orderEnvelope({ runId: run, sequence: 2 });
    expect((await postWebhook(config, old)).json.result).toBe('stale');
    expect((await postWebhook(config, old)).json.result).toBe('duplicate');
  });

  describe('transaction atomicity (fail after the idempotency marker insert)', () => {
    it('rolls back marker + effect, and the next valid request is processed', async () => {
      const { runId: faultRun } = await createCustomRun(t.db, {
        plan: { seed: 1, rules: [{ attemptNo: 1, action: { kind: 'fail_after_marker' } }] },
      });
      const [event] = await t.query<{ id: string; raw_payload: string }>(
        'SELECT id, raw_payload FROM events WHERE run_id = $1',
        [faultRun],
      );
      const [delivery] = await t.query<{ id: string }>(
        'SELECT id FROM deliveries WHERE run_id = $1',
        [faultRun],
      );
      const envelope = JSON.parse(event!.raw_payload) as { id: string };

      const first = await postWebhook(config, envelope, { deliveryId: delivery!.id, attemptNo: 1 });
      expect(first.status).toBe(500);
      expect(await markers(faultRun)).toBe(0);
      expect(await effects(faultRun)).toBe(0);
      expect(await byResult('injected_failure', faultRun)).toBe(1);

      const second = await postWebhook(config, envelope, {
        deliveryId: delivery!.id,
        attemptNo: 2,
      });
      expect(second.status).toBe(200);
      expect(second.json.result).toBe('processed');
      expect(await markers(faultRun)).toBe(1);
      expect(await effects(faultRun)).toBe(1);
    });
  });

  it('rejects an unknown consumer and invalid JSON without side effects', async () => {
    const res = await fetch(`http://127.0.0.1:${config.RECEIVER_PORT}/webhooks/someone-else`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
    const before = await count(t, 'processed_events');
    const bad = await postWebhook(config, { id: randomUUID(), nope: true } as never);
    expect(bad.status).toBe(400);
    expect(await count(t, 'processed_events')).toBe(before);
  });

  it('oversized bodies (> 64 KiB) are refused', async () => {
    const res = await fetch(`http://127.0.0.1:${config.RECEIVER_PORT}/webhooks/receiver-fixture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(70 * 1024),
    });
    expect(res.status).toBe(413);
  });

  it('exposes health and a token protected diagnostics route', async () => {
    const live = await fetch(`http://127.0.0.1:${config.RECEIVER_PORT}/health/ready`);
    expect(live.status).toBe(200);
    const denied = await fetch(`http://127.0.0.1:${config.RECEIVER_PORT}/internal/diagnostics`);
    expect(denied.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${config.RECEIVER_PORT}/internal/diagnostics`, {
      headers: { 'x-lab-control-token': config.LAB_CONTROL_TOKEN },
    });
    expect(ok.status).toBe(200);
    expect(SEED.consumerId).toBe('receiver-fixture');
  });
});
