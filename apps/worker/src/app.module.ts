import { Module, type DynamicModule } from '@nestjs/common';
import { createDb, type Db } from '@lab/db';
import { createLogger, type AppConfig, type Logger } from '@lab/shared';
import { DeliveryProcessor } from './delivery-processor';
import { QueueWorkerService } from './queue-worker.service';
import { APP_CONFIG, DB, LOGGER } from './tokens';

@Module({})
export class WorkerModule {
  static register(config: AppConfig, overrides: { db?: Db; logger?: Logger } = {}): DynamicModule {
    return {
      module: WorkerModule,
      providers: [
        DeliveryProcessor,
        QueueWorkerService,
        { provide: APP_CONFIG, useValue: config },
        {
          provide: DB,
          useValue:
            overrides.db ?? createDb(config.DATABASE_URL, { max: config.WORKER_CONCURRENCY + 4 }),
        },
        { provide: LOGGER, useValue: overrides.logger ?? createLogger('worker', config.LOG_LEVEL) },
      ],
    };
  }
}
