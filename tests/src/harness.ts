import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { join, resolve } from 'node:path';
import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Client } from 'pg';
import { createApiApp } from '@lab/api';
import { createReceiverApp } from '@lab/receiver';
import { createWorkerApp } from '@lab/worker';
import { createRun, createDb, seedDatabase, type Db } from '@lab/db';
import {
  HEADERS,
  buildBlueprint,
  deterministicUuid,
  loadConfig,
  signPayload,
  type AppConfig,
  type Blueprint,
  type FaultPlan,
  type RunConfigInput,
  type ScenarioStep,
} from '@lab/shared';

export const REPO_ROOT = resolve(__dirname, '..', '..');
const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://lab:lab@127.0.0.1:5440/postgres';

export function redisBinary(): string {
  if (process.env.REDIS_SERVER_BIN) return process.env.REDIS_SERVER_BIN;
  const base = join(REPO_ROOT, '.tools', 'redis');
  if (existsSync(base)) {
    const dir = readdirSync(base).find((d) => d.startsWith('Redis-'));
    if (dir)
      return join(base, dir, process.platform === 'win32' ? 'redis-server.exe' : 'redis-server');
  }
  return 'redis-server';
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Deadline based polling - no fixed long sleeps. */
export async function waitFor<T>(
  fn: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  opts: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (err) {
      last = err;
    }
    await sleep(opts.intervalMs ?? 50);
  }
  throw new Error(
    `timed out waiting for ${opts.what ?? 'condition'}${last ? `: ${String(last)}` : ''}`,
  );
}

// ---------------------------------------------------------------------------------------------
// PostgreSQL: one throw-away database per test file, created from the real migrations.
// ---------------------------------------------------------------------------------------------

export interface TestDatabase {
  url: string;
  name: string;
  db: Db;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  drop(): Promise<void>;
}

export async function createTestDatabase(receiverUrl: string): Promise<TestDatabase> {
  const name = `lab_test_${randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(
    `CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`,
  );
  await admin.end();

  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const migrations = join(REPO_ROOT, 'packages', 'db', 'prisma', 'migrations');
  const c = new Client({ connectionString: url });
  await c.connect();
  for (const dir of readdirSync(migrations)
    .filter((d) => /^\d/.test(d))
    .sort()) {
    await c.query(readFileSync(join(migrations, dir, 'migration.sql'), 'utf8'));
  }
  await c.end();

  const db = createDb(url, { max: 20 });
  await seedDatabase(db, { receiverUrl });

  const pool = new Client({ connectionString: url, options: '-c timezone=UTC' } as never);
  await pool.connect();
  return {
    url,
    name,
    db,
    query: async (sql, params) => (await pool.query(sql, params as never[])).rows as never,
    drop: async () => {
      await pool.end().catch(() => undefined);
      await db.$disconnect().catch(() => undefined);
      const a = new Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Redis: a real redis-server process the tests can stop and start.
// ---------------------------------------------------------------------------------------------

async function redisPing(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ port, host: '127.0.0.1' });
    const done = (ok: boolean) => {
      s.destroy();
      res(ok);
    };
    s.setTimeout(500, () => done(false));
    s.on('error', () => done(false));
    s.on('data', (d) => done(d.toString().startsWith('+PONG')));
    s.on('connect', () => s.write('PING\r\n'));
  });
}

export class TestRedis {
  private proc: ChildProcess | null = null;
  constructor(public readonly port: number) {}
  get url() {
    return `redis://127.0.0.1:${this.port}`;
  }
  static async create(): Promise<TestRedis> {
    const r = new TestRedis(await freePort());
    await r.start();
    return r;
  }
  async start(): Promise<void> {
    if (this.proc) return;
    const dir = join(REPO_ROOT, '.tools', 'redis-test', String(this.port));
    mkdirSync(dir, { recursive: true });
    this.proc = spawn(
      redisBinary(),
      ['--port', String(this.port), '--save', '', '--appendonly', 'no', '--dir', dir],
      {
        stdio: 'ignore',
      },
    );
    await waitFor(() => redisPing(this.port), {
      timeoutMs: 10_000,
      what: 'redis to accept connections',
    });
  }
  /** Hard stop: the in-memory queue state is gone after the next start (no persistence). */
  async stop(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    const exited = new Promise<void>((r) => p.once('exit', () => r()));
    p.kill('SIGKILL');
    await exited;
  }
}

// ---------------------------------------------------------------------------------------------
// Config + process helpers
// ---------------------------------------------------------------------------------------------

export const SECRET = 'integration-test-secret';

export interface StackConfigOptions {
  databaseUrl: string;
  redisUrl: string;
  receiverPort: number;
  overrides?: Record<string, string | number>;
}

export async function makeConfig(o: StackConfigOptions): Promise<AppConfig> {
  const env: Record<string, string> = {
    DATABASE_URL: o.databaseUrl,
    REDIS_URL: o.redisUrl,
    QUEUE_NAME: `q-${randomBytes(4).toString('hex')}`,
    QUEUE_PREFIX: 'labtest',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'error',
    RECEIVER_PORT: String(o.receiverPort),
    RECEIVER_URL: `http://127.0.0.1:${o.receiverPort}/webhooks/receiver-fixture`,
    ALLOWED_RECEIVER_URLS: `http://127.0.0.1:${o.receiverPort}/webhooks/`,
    RECEIVER_SECRET: SECRET,
    WORKER_HEALTH_PORT: String(await freePort()),
    API_PORT: String(await freePort()),
    WORKER_CONCURRENCY: '4',
    LEASE_MS: '2500',
    DISPATCH_POLL_MS: '40',
    RECOVERY_POLL_MS: '150',
    SUPERVISOR_POLL_MS: '80',
    DISPATCH_GRACE_MS: '1500',
    STALLED_INTERVAL_MS: '1000',
    RUN_TIMEOUT_MS: '120000',
  };
  for (const [k, v] of Object.entries(o.overrides ?? {})) env[k] = String(v);
  return loadConfig(env as NodeJS.ProcessEnv);
}

export function configToEnv(config: AppConfig): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) env[k] = String(v);
  return { ...process.env, ...env };
}

export interface ChildHandle {
  proc: ChildProcess;
  output(): string;
  kill(): Promise<void>;
}

/** Runs a compiled app in its own OS process so it can be SIGKILLed like a crashing worker. */
export function spawnApp(app: 'worker' | 'api' | 'receiver', config: AppConfig): ChildHandle {
  const main = join(REPO_ROOT, 'apps', app, 'dist', 'main.js');
  if (!existsSync(main)) throw new Error(`${main} is missing - run "pnpm build" first`);
  const proc = spawn(process.execPath, [main], {
    env: configToEnv(config),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout?.on('data', (d) => (out += d.toString()));
  proc.stderr?.on('data', (d) => (out += d.toString()));
  return {
    proc,
    output: () => out,
    kill: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise<void>((r) => proc.once('exit', () => r()));
      proc.kill('SIGKILL');
      await exited;
    },
  };
}

export async function waitForWorkerReady(config: AppConfig): Promise<void> {
  await waitFor(
    async () => {
      const res = await fetch(`http://127.0.0.1:${config.WORKER_HEALTH_PORT}/health/ready`).catch(
        () => null,
      );
      return res?.ok;
    },
    { timeoutMs: 20_000, what: 'worker health' },
  );
}

// ---------------------------------------------------------------------------------------------
// In-process services
// ---------------------------------------------------------------------------------------------

export class ReceiverHandle {
  app: INestApplication | null = null;
  constructor(public config: AppConfig) {}
  async start(): Promise<void> {
    if (this.app) return;
    this.app = await createReceiverApp(this.config);
    await this.app.listen(this.config.RECEIVER_PORT, '127.0.0.1');
  }
  async stop(): Promise<void> {
    const app = this.app;
    this.app = null;
    if (app) await app.close();
  }
}

export async function startApi(
  config: AppConfig,
  opts: { backgroundJobs?: boolean } = {},
): Promise<INestApplication> {
  if (opts.backgroundJobs === false) process.env.LAB_DISABLE_BACKGROUND_JOBS = '1';
  else delete process.env.LAB_DISABLE_BACKGROUND_JOBS;
  const app = await createApiApp(config);
  await app.init();
  delete process.env.LAB_DISABLE_BACKGROUND_JOBS;
  return app;
}

export async function startWorker(config: AppConfig): Promise<INestApplicationContext> {
  const app = await createWorkerApp(config);
  return app;
}

// ---------------------------------------------------------------------------------------------
// Signed requests straight at the receiver
// ---------------------------------------------------------------------------------------------

export function counterEnvelope(opts: {
  id?: string;
  runId: string;
  sequence?: number;
  delta?: number;
  aggregateId?: string;
}) {
  return {
    id: opts.id ?? randomUUID(),
    type: 'demo.counter.increment' as const,
    runId: opts.runId,
    aggregateId: opts.aggregateId ?? 'counter-demo',
    sequence: opts.sequence ?? 1,
    occurredAt: new Date().toISOString(),
    data: { delta: opts.delta ?? 1 },
  };
}

export function orderEnvelope(opts: { runId: string; sequence: number; id?: string }) {
  return {
    id: opts.id ?? randomUUID(),
    type: 'demo.order.snapshot' as const,
    runId: opts.runId,
    aggregateId: 'order-1',
    sequence: opts.sequence,
    occurredAt: new Date().toISOString(),
    data: {
      orderId: 'order-1',
      status: 'paid' as const,
      items: [{ sku: 'S', qty: opts.sequence }],
      totalCents: 100 * opts.sequence,
    },
  };
}

export interface PostOptions {
  secret?: string;
  timestampSec?: number;
  eventIdHeader?: string;
  deliveryId?: string;
  attemptNo?: number;
  tamperBody?: (raw: string) => string;
  omitSignature?: boolean;
}

export async function postWebhook(
  config: AppConfig,
  envelope: object & { id: string },
  o: PostOptions = {},
): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
  const raw = JSON.stringify(envelope);
  const ts = o.timestampSec ?? Math.floor(Date.now() / 1000);
  const signature = signPayload(o.secret ?? SECRET, ts, raw);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [HEADERS.eventId]: o.eventIdHeader ?? envelope.id,
    [HEADERS.timestamp]: String(ts),
    [HEADERS.attemptNo]: String(o.attemptNo ?? 1),
  };
  if (!o.omitSignature) headers[HEADERS.signature] = signature;
  if (o.deliveryId) headers[HEADERS.deliveryId] = o.deliveryId;
  const res = await fetch(`http://127.0.0.1:${config.RECEIVER_PORT}/webhooks/receiver-fixture`, {
    method: 'POST',
    headers,
    body: o.tamperBody ? o.tamperBody(raw) : raw,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, raw: text };
}

// ---------------------------------------------------------------------------------------------
// Runs with hand-written fault plans (internal tooling only; not exposed over HTTP)
// ---------------------------------------------------------------------------------------------

export async function createCustomRun(
  db: Db,
  p: {
    plan?: FaultPlan;
    config?: RunConfigInput;
    events?: number;
    deliveriesPerEvent?: number;
    steps?: ScenarioStep[];
    runId?: string;
  } = {},
): Promise<{ runId: string; blueprint: Blueprint }> {
  const base = buildBlueprint('healthy', 1, { eventCount: p.events ?? 1, ...(p.config ?? {}) });
  const blueprint: Blueprint = {
    ...base,
    faultPlan: p.plan ?? { seed: 1, rules: [] },
    assertions: [],
  };
  if (p.steps) blueprint.steps = p.steps;
  else if (p.deliveriesPerEvent) {
    blueprint.steps = [
      {
        kind: 'emit',
        events: [
          {
            type: 'demo.counter.increment',
            aggregateId: 'counter-demo',
            sequence: 1,
            data: { delta: 1 },
            deliveries: p.deliveriesPerEvent,
          },
        ],
      },
      { kind: 'await_terminal' },
    ];
  }
  const { runId } = await createRun(db, { blueprint, runType: 'custom', runId: p.runId });
  return { runId, blueprint };
}

export async function deliveryRows(t: TestDatabase, runId: string) {
  return t.query<{
    id: string;
    event_id: string;
    state: string;
    attempt_count: number;
    generation: number;
    terminal_reason: string | null;
    replay_of_delivery_id: string | null;
  }>(
    `SELECT id, event_id, state::text AS state, attempt_count, generation, terminal_reason, replay_of_delivery_id
     FROM deliveries WHERE run_id = $1 ORDER BY created_at, ordinal`,
    [runId],
  );
}

export async function count(
  t: TestDatabase,
  table: string,
  where = 'TRUE',
  params: unknown[] = [],
): Promise<number> {
  const [row] = await t.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return row!.n;
}

export { deterministicUuid };
