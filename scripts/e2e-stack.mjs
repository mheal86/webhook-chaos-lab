// Boots a complete, isolated stack for Playwright: fresh database, API, worker, receiver and the
// built dashboard (vite preview). Needs a reachable PostgreSQL and Redis (see `pnpm infra:local`
// or the CI service containers) and a prior `pnpm build`.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages', 'db', 'package.json'));
const { Client } = require('pg');

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgresql://lab:lab@127.0.0.1:5440/postgres';
const redisUrl = process.env.E2E_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6390';
const dbName = 'lab_e2e';
const dbUrl = adminUrl.replace(/\/[^/]*$/, `/${dbName}`);
const ports = { api: 3401, receiver: 3402, worker: 3403, web: 4173 };

const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${dbName} ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
await admin.end();

const env = {
  ...process.env,
  DATABASE_URL: dbUrl,
  REDIS_URL: redisUrl,
  QUEUE_PREFIX: 'lab-e2e',
  QUEUE_NAME: `e2e-${Date.now()}`,
  API_PORT: String(ports.api),
  RECEIVER_PORT: String(ports.receiver),
  WORKER_HEALTH_PORT: String(ports.worker),
  RECEIVER_URL: `http://127.0.0.1:${ports.receiver}/webhooks/receiver-fixture`,
  ALLOWED_RECEIVER_URLS: `http://127.0.0.1:${ports.receiver}/webhooks/`,
  DISPATCH_POLL_MS: '50',
  SUPERVISOR_POLL_MS: '100',
  RECOVERY_POLL_MS: '200',
  LOG_LEVEL: 'warn',
  VITE_API_TARGET: `http://127.0.0.1:${ports.api}`,
};

const shell = process.platform === 'win32';
const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
};
run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], join(root, 'packages', 'db'));
run('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], join(root, 'packages', 'db'));

const children = [
  spawn(process.execPath, [join(root, 'apps/receiver/dist/main.js')], { env, stdio: 'inherit' }),
  spawn(process.execPath, [join(root, 'apps/worker/dist/main.js')], { env, stdio: 'inherit' }),
  spawn(process.execPath, [join(root, 'apps/api/dist/main.js')], { env, stdio: 'inherit' }),
  spawn('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(ports.web), '--strictPort'], {
    cwd: join(root, 'apps/web'),
    env,
    stdio: 'inherit',
    shell,
  }),
];

const stop = () => {
  for (const c of children) {
    if (process.platform === 'win32' && c.pid) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', () => children.forEach((c) => c.kill()));

// Ready when the dashboard proxies a healthy API.
for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${ports.web}/api/health/ready`);
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`e2e stack ready: http://127.0.0.1:${ports.web}`);
setInterval(() => {}, 1 << 30);
