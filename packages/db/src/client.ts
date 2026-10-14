import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from './generated/client';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
export type DbOrTx = Db | Tx;

export interface CreateDbOptions {
  /** Max pooled connections for this process. */
  max?: number;
}

export function createDb(connectionString: string, options: CreateDbOptions = {}): Db {
  // Force UTC for the session: Prisma sends Dates without an offset, so a non-UTC server timezone would
  // silently shift every timestamp. All times are stored and compared in UTC.
  const adapter = new PrismaPg({ connectionString, max: options.max ?? 10, options: '-c timezone=UTC' });
  return new PrismaClient({ adapter });
}

/** Interactive transaction options used by the engine (short, bounded). */
export const TX_OPTIONS = { maxWait: 5_000, timeout: 20_000 } as const;

export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: unknown; message?: string; cause?: unknown };
  if (e.code === 'P2002') return true;
  let blob = '';
  try {
    blob = JSON.stringify(e.meta ?? {}) + JSON.stringify(e.cause ?? {});
  } catch {
    /* circular; ignore */
  }
  return /23505|duplicate key value/i.test(`${e.message ?? ''} ${blob}`);
}

export { Prisma, PrismaClient };
