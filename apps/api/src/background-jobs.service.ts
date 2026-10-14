import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import {
  advanceRun,
  dispatchOutboxBatch,
  listRunningRunIds,
  runRecoveryTick,
  type Db,
} from '@lab/db';
import { errorFields, type AppConfig, type Logger } from '@lab/shared';
import { QueueService } from './queue.service';
import { APP_CONFIG, DB, LOGGER } from './tokens';

interface Loop {
  name: string;
  stop(): Promise<void>;
}

/**
 * In-process background loops of the API:
 *  - dispatcher: outbox -> BullMQ (batched, row locked, marked published only after the queue ack)
 *  - recovery scheduler: expired leases + lost jobs -> new generation
 *  - run supervisor: advances scenario runs (steps, assertions)
 * Each loop is safe to run in several API replicas (SKIP LOCKED / row locks).
 */
@Injectable()
export class BackgroundJobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private loops: Loop[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly log: Logger,
    private readonly queue: QueueService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.LAB_DISABLE_BACKGROUND_JOBS === '1') return;
    this.startAll();
  }

  startAll(): void {
    if (this.loops.length > 0) return;
    this.loops.push(
      this.loop('dispatcher', this.config.DISPATCH_POLL_MS, async () => {
        const n = await dispatchOutboxBatch(
          this.db,
          (jobs) => this.queue.publish(jobs),
          this.config.DISPATCH_BATCH_SIZE,
        );
        if (n > 0) this.log.debug('outbox dispatched', { count: n });
        return n >= this.config.DISPATCH_BATCH_SIZE; // more work likely: run again immediately
      }),
      this.loop('recovery', this.config.RECOVERY_POLL_MS, async () => {
        const report = await runRecoveryTick(this.db, this.config.DISPATCH_GRACE_MS);
        if (report.leaseExpired || report.redispatched || report.missingOutbox) {
          this.log.warn('recovery acted', { ...report });
        }
        return false;
      }),
      this.loop('run-supervisor', this.config.SUPERVISOR_POLL_MS, async () => {
        for (const runId of await listRunningRunIds(this.db)) {
          const { status } = await advanceRun(this.db, runId, { runTimeoutMs: this.config.RUN_TIMEOUT_MS });
          if (status !== 'running') this.log.info('run finished', { runId, status });
        }
        return false;
      }),
    );
  }

  private loop(name: string, intervalMs: number, tick: () => Promise<boolean>): Loop {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let inFlight: Promise<void> = Promise.resolve();
    let consecutiveErrors = 0;

    const schedule = (delay: number) => {
      if (stopped) return;
      timer = setTimeout(() => {
        inFlight = (async () => {
          let again = false;
          try {
            again = await tick();
            consecutiveErrors = 0;
          } catch (err) {
            consecutiveErrors++;
            // Log the first failure and then every 20th to keep an outage readable.
            if (consecutiveErrors === 1 || consecutiveErrors % 20 === 0) {
              this.log.error(`${name} tick failed`, { consecutiveErrors, ...errorFields(err) });
            }
          }
          schedule(again ? 0 : Math.min(intervalMs * (1 + Math.min(consecutiveErrors, 8)), 5000));
        })();
      }, delay);
    };
    schedule(0);
    return {
      name,
      stop: async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        await inFlight;
      },
    };
  }

  async stopAll(): Promise<void> {
    const loops = this.loops;
    this.loops = [];
    await Promise.all(loops.map((l) => l.stop()));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stopAll();
  }
}
