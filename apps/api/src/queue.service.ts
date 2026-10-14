import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { DispatchJob } from '@lab/db';
import { parseRedisUrl, type AppConfig } from '@lab/shared';
import { APP_CONFIG } from './tokens';

const PUBLISH_TIMEOUT_MS = 5000;

/** Producer side of BullMQ. Jobs only say "look at delivery X, generation g"; PostgreSQL owns the state. */
@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly queue: Queue;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.queue = new Queue(config.QUEUE_NAME, {
      connection: { ...parseRedisUrl(config.REDIS_URL), enableOfflineQueue: false },
      prefix: config.QUEUE_PREFIX,
      defaultJobOptions: {
        // PostgreSQL (next_attempt_at) is the single retry owner: BullMQ must not retry on its own.
        attempts: 1,
        removeOnComplete: { age: 3600, count: 5000 },
        removeOnFail: { age: 86_400, count: 5000 },
      },
    });
    // Redis being down must not crash the process; the dispatcher simply fails the batch and retries.
    this.queue.on('error', () => undefined);
  }

  async publish(jobs: DispatchJob[]): Promise<void> {
    const add = this.queue.addBulk(
      jobs.map((j) => ({
        name: 'deliver',
        data: { deliveryId: j.deliveryId, generation: j.generation, outboxId: j.outboxId },
        opts: { jobId: j.jobId },
      })),
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('queue publish timed out')), PUBLISH_TIMEOUT_MS);
    });
    try {
      await Promise.race([add, timeout]);
    } finally {
      clearTimeout(timer);
      add.catch(() => undefined); // a late rejection after the timeout must not be unhandled
    }
  }

  /** Reachability check: a cheap command round trip, bounded to 1.5 s. */
  async ping(): Promise<boolean> {
    try {
      await Promise.race([
        this.queue.getJobCounts('waiting'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('redis ping timed out')), 1500)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close().catch(() => undefined);
  }
}
