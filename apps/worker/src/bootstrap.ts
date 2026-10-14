import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Db } from '@lab/db';
import type { AppConfig, Logger } from '@lab/shared';
import { WorkerModule } from './app.module';

/** Builds the worker (no HTTP server except the tiny health endpoint). Exported for in-process tests. */
export async function createWorkerApp(
  config: AppConfig,
  overrides: { db?: Db; logger?: Logger } = {},
): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(WorkerModule.register(config, overrides), {
    logger: ['error', 'warn'],
  });
  app.enableShutdownHooks();
  return app;
}
