// Starts a real local PostgreSQL (embedded-postgres binaries) and Redis (portable build under .tools)
// for machines without Docker. Not used by docker compose / CI.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PG_PORT = Number(process.env.LOCAL_PG_PORT ?? 5440);
const REDIS_PORT = Number(process.env.LOCAL_REDIS_PORT ?? 6390);

function findRedisBin() {
  const base = join(root, '.tools', 'redis');
  if (!existsSync(base)) return null;
  const dir = readdirSync(base).find((d) => d.startsWith('Redis-'));
  return dir ? join(base, dir, process.platform === 'win32' ? 'redis-server.exe' : 'redis-server') : null;
}

const { default: EmbeddedPostgres } = await import('embedded-postgres');
const dataDir = join(root, '.tools', 'pgdata');
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'lab',
  password: 'lab',
  port: PG_PORT,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-c', 'timezone=UTC', '-c', 'shared_buffers=64MB', '-c', 'max_connections=60'],
});
if (!existsSync(join(dataDir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase('lab');
} catch {
  /* already exists */
}

let redis = null;
const redisBin = process.env.REDIS_SERVER_BIN ?? findRedisBin();
if (redisBin) {
  const redisDir = join(root, '.tools', 'redis-data');
  mkdirSync(redisDir, { recursive: true });
  redis = spawn(redisBin, ['--port', String(REDIS_PORT), '--appendonly', 'yes', '--dir', redisDir], {
    stdio: 'ignore',
  });
}

console.log('Local infrastructure is up:');
console.log(`  DATABASE_URL=postgresql://lab:lab@127.0.0.1:${PG_PORT}/lab`);
console.log(`  TEST_DATABASE_ADMIN_URL=postgresql://lab:lab@127.0.0.1:${PG_PORT}/postgres`);
console.log(`  REDIS_URL=redis://127.0.0.1:${REDIS_PORT}${redis ? '' : '  (redis binary not found)'}`);
if (redisBin) console.log(`  REDIS_SERVER_BIN=${redisBin}`);
console.log('Press Ctrl+C to stop.');

const shutdown = async () => {
  redis?.kill();
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30);
