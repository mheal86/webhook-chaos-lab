import type { Db } from '../client';
import { TX_OPTIONS } from '../client';

export interface DispatchJob {
  outboxId: string;
  deliveryId: string;
  generation: number;
  jobId: string;
}

interface OutboxRow {
  id: string;
  delivery_id: string;
  generation: number;
  job_id: string;
}

/**
 * Publishes due outbox rows in one batch.
 *
 * The rows are locked (`FOR UPDATE SKIP LOCKED`) for the duration of the publish call and only
 * marked `published` after the queue acknowledged the whole batch. A crash between the enqueue and
 * the commit leaves the rows `pending`; the next tick re-publishes them under the same job id
 * (BullMQ de-duplicates by id, and even if it did not, worker claims are fenced by generation).
 * Returns the number of rows published; throws (leaving rows pending) if `publish` fails.
 */
export async function dispatchOutboxBatch(
  db: Db,
  publish: (jobs: DispatchJob[]) => Promise<void>,
  batchSize: number,
): Promise<number> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<OutboxRow[]>`
      SELECT id, delivery_id, generation, job_id
      FROM outbox
      WHERE status = 'pending' AND available_at <= now()
      ORDER BY available_at, id
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return 0;

    await publish(
      rows.map((r) => ({
        outboxId: r.id,
        deliveryId: r.delivery_id,
        generation: r.generation,
        jobId: r.job_id,
      })),
    );

    const ids = rows.map((r) => r.id);
    await tx.$executeRaw`
      UPDATE outbox SET status = 'published', published_at = now()
      WHERE id = ANY(${ids}::text[])`;
    return rows.length;
  }, TX_OPTIONS);
}
