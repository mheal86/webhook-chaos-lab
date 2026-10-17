import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Db } from '@lab/db';
import { createLogger, type AppConfig, type Logger } from '@lab/shared';
import { AppModule } from './app.module';
import { AllExceptionsFilter, correlationMiddleware } from './http';

export async function createApiApp(
  config: AppConfig,
  overrides: { db?: Db; logger?: Logger } = {},
): Promise<NestExpressApplication & INestApplication> {
  const log = overrides.logger ?? createLogger('api', config.LOG_LEVEL);
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, { ...overrides, logger: log }),
    {
      logger: ['error', 'warn'],
    },
  );
  app.setGlobalPrefix('api');
  app.useBodyParser('json', { limit: '128kb' });
  app.use(correlationMiddleware(log));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter(log));

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Webhook Chaos Lab API')
      .setDescription(
        'Create events, run fault scenarios, inspect deliveries/attempts, replay dead letters.',
      )
      .setVersion('0.1.0')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, doc, { jsonDocumentUrl: 'api/openapi.json' });
  app.enableShutdownHooks();
  return app;
}
