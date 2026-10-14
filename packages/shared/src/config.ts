import { z } from 'zod';

const intFromEnv = (def: number) =>
  z.preprocess((v) => (v === undefined || v === '' ? def : Number(v)), z.number().int().positive());

const configSchema = z.object({
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  QUEUE_NAME: z.string().default('webhook-deliveries'),
  QUEUE_PREFIX: z.string().default('lab'),

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: intFromEnv(3000),
  RECEIVER_HOST: z.string().default('127.0.0.1'),
  RECEIVER_PORT: intFromEnv(3100),
  WORKER_HEALTH_PORT: intFromEnv(3200),

  /** Comma separated list of allowlisted receiver URLs (exact scheme/host/port, path prefix). */
  ALLOWED_RECEIVER_URLS: z.string().default('http://127.0.0.1:3100/webhooks/'),
  /** URL stored on the seeded endpoint. Must match the allowlist. */
  RECEIVER_URL: z.string().default('http://127.0.0.1:3100/webhooks/receiver-fixture'),
  /** Local-only sample secrets. Endpoints reference the variable *name* via secret_ref. */
  RECEIVER_SECRET: z.string().default('local-dev-secret-change-me'),
  LAB_CONTROL_TOKEN: z.string().default('local-dev-control-token'),

  WORKER_CONCURRENCY: intFromEnv(4),
  /** Lease must comfortably exceed the HTTP hard cap. */
  LEASE_MS: intFromEnv(15_000),
  HTTP_TIMEOUT_HARD_CAP_MS: intFromEnv(10_000),
  DISPATCH_POLL_MS: intFromEnv(250),
  DISPATCH_BATCH_SIZE: intFromEnv(50),
  /** A published job that produced no claim after this long is re-issued with a new generation. */
  DISPATCH_GRACE_MS: intFromEnv(30_000),
  RECOVERY_POLL_MS: intFromEnv(1000),
  SUPERVISOR_POLL_MS: intFromEnv(500),
  RUN_TIMEOUT_MS: intFromEnv(300_000),
  /** BullMQ stalled-job check interval. */
  STALLED_INTERVAL_MS: intFromEnv(30_000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}

export interface ParsedRedisUrl {
  host: string;
  port: number;
  password?: string;
  username?: string;
  db?: number;
  tls?: Record<string, never>;
}

/** BullMQ takes connection options rather than a client instance (keeps ioredis versions independent). */
export function parseRedisUrl(url: string): ParsedRedisUrl {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.pathname && u.pathname !== '/' ? { db: Number(u.pathname.slice(1)) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

export interface AllowedTarget {
  origin: string;
  pathPrefix: string;
}

export function parseAllowlist(raw: string): AllowedTarget[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const u = new URL(entry);
      return { origin: u.origin, pathPrefix: u.pathname };
    });
}

/** Exact scheme/host/port match plus path-prefix match; credentials and fragments are rejected. */
export function isUrlAllowed(url: string, allowlist: AllowedTarget[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.pathname.includes('..')) return false;
  return allowlist.some((t) => t.origin === u.origin && u.pathname.startsWith(t.pathPrefix));
}
