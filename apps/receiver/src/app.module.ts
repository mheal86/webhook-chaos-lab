import { Module, type DynamicModule, type OnApplicationShutdown, Inject } from '@nestjs/common';
import { createDb, type Db } from '@lab/db';
import { createLogger, type AppConfig, type Logger } from '@lab/shared';
import { ReceiverController } from './receiver.controller';
import { ReceiverService } from './receiver.service';
import { APP_CONFIG, DB, LOGGER } from './tokens';

@Module({})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  static register(config: AppConfig, overrides: { db?: Db; logger?: Logger } = {}): DynamicModule {
    return {
      module: AppModule,
      controllers: [ReceiverController],
      providers: [
        ReceiverService,
        { provide: APP_CONFIG, useValue: config },
        { provide: DB, useValue: overrides.db ?? createDb(config.DATABASE_URL, { max: 10 }) },
        { provide: LOGGER, useValue: overrides.logger ?? createLogger('receiver', config.LOG_LEVEL) },
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db.$disconnect();
  }
}
