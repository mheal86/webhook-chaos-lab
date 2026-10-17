// Fault-injection run on a real, isolated stack: starts its own Redis, receiver, worker and API
// against a fresh database, drives a bounded load (scripts/load-test.mjs), kills one component
// mid-load, brings it back, and then checks PostgreSQL: every event delivered, exactly one business
// effect per event.
//
//   node scripts/chaos.mjs <worker|receiver|redis|redis-loss> [--events 300] [--kill-after 1000] [--down-for 5000]
//
//   worker      SIGKILL the worker; its in-flight attempt is recovered through lease expiry
//   receiver    SIGKILL the receiver; deliveries go to retry_wait and finish when it is back
//   redis       SIGKILL Redis and restart it on the same AOF data
//   redis-loss  SIGKILL Redis and restart it EMPTY (queue state lost); the reconciler re-issues work
//
// Needs PostgreSQL (TEST_DATABASE_ADMIN_URL, default: pnpm infra:local), a redis-server binary
// (REDIS_SERVER_BIN, .tools/redis, or PATH) and a prior `pnpm build`.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages', 'db', 'package.json'));
const { Client } = require('pg');

const TARGETS = ['worker', 'receiver', 'redis', 'redis-loss'];
const target = process.argv[2];
if (!TARGETS.includes(target)) {
  console.error(
    `usage: node scripts/chaos.mjs <${TARGETS.join('|')}> [--events N] [--kill-after ms] [--down-for ms]`,
  );
  process.exit(2);
}
const opt = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const events = Math.min(opt('events', 300), 2000);
const killAfter = opt('kill-after', 1000);
const downFor = opt('down-for', 5000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

function redisBinary() {
  if (process.env.REDIS_SERVER_BIN) return process.env.REDIS_SERVER_BIN;
  const base = join(root, '.tools', 'redis');
  if (existsSync(base)) {
    const dir = readdirSync(base).find((d) => d.startsWith('Redis-'));
    if (dir)
      return join(base, dir, process.platform === 'win32' ? 'redis-server.exe' : 'redis-server');
  }
  return 'redis-server';
}

function redisPing(port) {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.setTimeout(500);
    s.once('connect', () => s.write('PING\r\n'));
    s.once('data', (d) => {
      s.destroy();
      resolve(d.toString().startsWith('+PONG'));
    });
    s.once('error', () => resolve(false));
    s.once('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function until(fn, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Hard kill, like a crash: no shutdown hooks run. */
function hardKill(proc) {
  if (!proc?.pid || proc.exitCode !== null) return Promise.resolve();
  const exited = new Promise((r) => proc.once('exit', r));
  if (process.platform === 'win32')
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  else proc.kill('SIGKILL');
  return exited;
}

// ---- isolated stack -------------------------------------------------------------------------
const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://lab:lab@127.0.0.1:5440/postgres';
const dbName = 'lab_chaos';
const dbUrl = adminUrl.replace(/\/[^/]*$/, `/${dbName}`);
const ports = { api: 3501, receiver: 3502, worker: 3503, redis: 6501 };
const redisDir = join(root, '.tools', 'redis-chaos');

const env = {
  ...process.env,
  DATABASE_URL: dbUrl,
  REDIS_URL: `redis://127.0.0.1:${ports.redis}`,
  QUEUE_PREFIX: 'lab-chaos',
  QUEUE_NAME: 'chaos',
  API_PORT: String(ports.api),
  RECEIVER_PORT: String(ports.receiver),
  WORKER_HEALTH_PORT: String(ports.worker),
  RECEIVER_URL: `http://127.0.0.1:${ports.receiver}/webhooks/receiver-fixture`,
  ALLOWED_RECEIVER_URLS: `http://127.0.0.1:${ports.receiver}/webhooks/`,
  // Shorter recovery windows than the defaults so a run takes seconds, not minutes.
  HTTP_TIMEOUT_HARD_CAP_MS: '3000',
  LEASE_MS: '6000',
  DISPATCH_GRACE_MS: '5000',
  STALLED_INTERVAL_MS: '5000',
  LOG_LEVEL: 'warn',
};

const procs = {};
function startRedis(fresh) {
  if (fresh) rmSync(redisDir, { recursive: true, force: true });
  mkdirSync(redisDir, { recursive: true });
  procs.redis = spawn(
    redisBinary(),
    ['--port', String(ports.redis), '--appendonly', 'yes', '--dir', redisDir],
    {
      stdio: 'ignore',
    },
  );
  return until(() => redisPing(ports.redis), 'redis');
}
function startApp(name) {
  procs[name] = spawn(process.execPath, [join(root, 'apps', name, 'dist', 'main.js')], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const health = {
    api: `http://127.0.0.1:${ports.api}/api/health/live`,
    receiver: `http://127.0.0.1:${ports.receiver}/health/live`,
    worker: `http://127.0.0.1:${ports.worker}/health/live`,
  }[name];
  return until(async () => (await fetch(health)).ok, name);
}
async function stopAll() {
  // Apps first, so they do not log connection errors for a Redis we are tearing down.
  await Promise.all(['api', 'worker', 'receiver'].map((n) => hardKill(procs[n])));
  await hardKill(procs.redis);
}
process.on('SIGINT', async () => {
  await stopAll();
  process.exit(130);
});

for (const app of ['api', 'worker', 'receiver']) {
  if (!existsSync(join(root, 'apps', app, 'dist', 'main.js'))) {
    console.error(`apps/${app}/dist/main.js is missing - run "pnpm build" first`);
    process.exit(2);
  }
}

const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.query(
  `CREATE DATABASE ${dbName} ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`,
);
await admin.end();
const shell = process.platform === 'win32';
for (const args of [
  ['exec', 'prisma', 'migrate', 'deploy'],
  ['exec', 'tsx', 'prisma/seed.ts'],
]) {
  const r = spawnSync('pnpm', args, {
    cwd: join(root, 'packages', 'db'),
    env,
    stdio: 'ignore',
    shell,
  });
  if (r.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`);
}

let exitCode = 1;
try {
  await startRedis(true);
  await Promise.all([startApp('receiver'), startApp('worker'), startApp('api')]);
  log(`stack up (api :${ports.api}, db ${dbName}); target = ${target}`);

  log(`load: ${events} events`);
  const load = spawn(
    process.execPath,
    [
      join(root, 'scripts', 'load-test.mjs'),
      '--api',
      `http://127.0.0.1:${ports.api}`,
      '--events',
      String(events),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let loadOut = '';
  load.stdout.on('data', (d) => (loadOut += d));
  const loadDone = new Promise((r) => load.once('exit', r));

  await sleep(killAfter);
  const victim = target.startsWith('redis') ? 'redis' : target;
  await hardKill(procs[victim]);
  log(`killed ${victim}`);
  await sleep(downFor);
  if (victim === 'redis') await startRedis(target === 'redis-loss');
  else await startApp(victim);
  log(`restarted ${victim}${target === 'redis-loss' ? ' with EMPTY data' : ''}`);

  const loadCode = await loadDone;
  log(`load finished (exit ${loadCode})`);
  const report = JSON.parse(loadOut.slice(loadOut.indexOf('{')) || '{}');

  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const one = async (sql) => (await db.query(sql)).rows[0];
  const counts = await one(`
    SELECT (SELECT count(*)::int FROM events WHERE aggregate_id LIKE 'load-%') AS events,
           (SELECT count(*)::int FROM deliveries) AS deliveries,
           (SELECT count(*)::int FROM deliveries WHERE state = 'succeeded') AS succeeded,
           (SELECT count(*)::int FROM business_effects) AS effects,
           (SELECT count(*)::int FROM receiver_requests) AS receiver_requests`);
  const outcomes = (
    await db.query(
      `SELECT outcome::text AS outcome, count(*)::int AS n FROM delivery_attempts GROUP BY 1 ORDER BY 1`,
    )
  ).rows;
  await db.end();

  console.log('\nresult');
  console.log(
    `  events=${counts.events} deliveries=${counts.deliveries} succeeded=${counts.succeeded}`,
  );
  console.log(`  business_effects=${counts.effects} receiver_requests=${counts.receiver_requests}`);
  console.log(`  attempts by outcome: ${outcomes.map((o) => `${o.outcome}=${o.n}`).join(' ')}`);
  console.log(
    `  end-to-end ms p50/p95/max: ${report.endToEndMs?.p50}/${report.endToEndMs?.p95}/${report.endToEndMs?.max}`,
  );

  const ok =
    loadCode === 0 &&
    counts.events === events &&
    counts.succeeded === counts.deliveries &&
    counts.effects === counts.events;
  console.log(ok ? '\nPASS: nothing lost, nothing applied twice' : '\nFAIL: see counts above');
  exitCode = ok ? 0 : 1;
} finally {
  await stopAll();
}
process.exit(exitCode);
