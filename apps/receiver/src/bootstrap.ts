import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { LIMITS, type AppConfig, type Logger } from '@lab/shared';
import type { Db } from '@lab/db';
import { AppModule } from './app.module';

/** Builds the receiver app. Exported separately so integration tests can host it in-process. */
export async function createReceiverApp(
  config: AppConfig,
  overrides: { db?: Db; logger?: Logger } = {},
): Promise<NestExpressApplication & INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, overrides), {
    bodyParser: false,
    logger: ['error', 'warn'],
  });
  // Raw bytes for every content type: signature verification must see exactly what was sent.
  app.useBodyParser('raw', { type: () => true, limit: LIMITS.maxPayloadBytes });
  app.enableShutdownHooks();
  return app;
}
