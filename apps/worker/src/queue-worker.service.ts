import { createServer, type Server } from 'node:http';
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import type { Db } from '@lab/db';
import { errorFields, parseRedisUrl, type AppConfig, type Logger } from '@lab/shared';
import { DeliveryProcessor, type DeliveryJob } from './delivery-processor';
import { APP_CONFIG, DB, LOGGER } from './tokens';

/**
 * BullMQ worker. BullMQ only transports "please look at delivery X (generation g)"; every job goes
 * through the database claim, so duplicate, stalled or re-run jobs cannot cause a second send.
 * Retries are owned by PostgreSQL (`next_attempt_at`), not by BullMQ (`attempts: 1`).
 */
@Injectable()
export class QueueWorkerService implements OnModuleInit, OnApplicationShutdown {
  private worker: Worker<DeliveryJob> | null = null;
  private health: Server | null = null;

  constructor(
    private readonly processor: DeliveryProcessor,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    this.worker = new Worker<DeliveryJob>(
      this.config.QUEUE_NAME,
      async (job: Job<DeliveryJob>) => this.processor.process(job.data),
      {
        connection: { ...parseRedisUrl(this.config.REDIS_URL), maxRetriesPerRequest: null },
        prefix: this.config.QUEUE_PREFIX,
        concurrency: this.config.WORKER_CONCURRENCY,
        stalledInterval: this.config.STALLED_INTERVAL_MS,
        maxStalledCount: 1,
        lockDuration: 30_000,
      },
    );
    this.worker.on('error', (err) => this.log.error('queue worker error', errorFields(err)));
    this.worker.on('failed', (job, err) =>
      this.log.warn('job failed', {
        jobId: job?.id,
        deliveryId: job?.data.deliveryId,
        ...errorFields(err),
      }),
    );
    this.worker.on('stalled', (jobId) =>
      this.log.warn('job stalled (will be re-checked against the DB claim)', { jobId }),
    );
    await this.worker.waitUntilReady();
    this.log.info('worker ready', {
      queue: this.config.QUEUE_NAME,
      concurrency: this.config.WORKER_CONCURRENCY,
    });
    this.startHealthServer();
  }

  private startHealthServer(): void {
    this.health = createServer((req, res) => {
      void (async () => {
        const url = req.url ?? '';
        res.setHeader('content-type', 'application/json');
        if (url.startsWith('/health/live')) {
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }
        if (url.startsWith('/health/ready')) {
          try {
            await this.db.$queryRaw`SELECT 1`;
            const ready = this.worker?.isRunning() ?? false;
            res.statusCode = ready ? 200 : 503;
            res.end(
              JSON.stringify({ status: ready ? 'ok' : 'unavailable', db: 'up', queue: ready }),
            );
          } catch {
            res.statusCode = 503;
            res.end(JSON.stringify({ status: 'unavailable', db: 'down' }));
          }
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      })();
    });
    this.health.listen(this.config.WORKER_HEALTH_PORT, this.config.API_HOST);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await new Promise<void>((resolve) =>
      this.health ? this.health.close(() => resolve()) : resolve(),
    );
    await this.db.$disconnect();
  }
}
