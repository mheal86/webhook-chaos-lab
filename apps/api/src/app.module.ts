import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type Db } from '@lab/db';
import { createLogger, type AppConfig, type Logger } from '@lab/shared';
import { BackgroundJobsService } from './background-jobs.service';
import { CommandsService } from './commands.service';
import {
  DeliveriesController,
  EndpointsController,
  EventsController,
  HealthController,
  ScenariosController,
} from './controllers';
import { QueueService } from './queue.service';
import { ReadModelsService } from './read-models.service';
import { APP_CONFIG, DB, LOGGER } from './tokens';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  static register(config: AppConfig, overrides: { db?: Db; logger?: Logger } = {}): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        EndpointsController,
        EventsController,
        DeliveriesController,
        ScenariosController,
        HealthController,
      ],
      providers: [
        CommandsService,
        ReadModelsService,
        QueueService,
        BackgroundJobsService,
        { provide: APP_CONFIG, useValue: config },
        { provide: DB, useValue: overrides.db ?? createDb(config.DATABASE_URL, { max: 15 }) },
        { provide: LOGGER, useValue: overrides.logger ?? createLogger('api', config.LOG_LEVEL) },
      ],
      exports: [BackgroundJobsService],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.$disconnect();
  }
}
