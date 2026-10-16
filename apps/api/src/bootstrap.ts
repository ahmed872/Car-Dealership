import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { getEnv } from './config/env';
import { GlobalErrorFilter } from './common/error.filter';
import { requestInfoMiddleware } from './common/request-info';
import { DbService } from './db/db.service';

export async function createApp(opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const env = getEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  if (opts.logger !== false) app.useLogger(app.get(Logger));
  app.set('trust proxy', env.TRUST_PROXY ? 1 : false);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: false, limit: '256kb' }));
  app.use(cookieParser());
  app.use(requestInfoMiddleware);
  app.enableCors({
    origin: env.origins,
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Idempotent-Replayed', 'Content-Disposition'],
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new GlobalErrorFilter());

  if (env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('AutoHub Pro API')
      .setDescription(
        'Dealership management platform — REST API v1. Cookie session + X-CSRF-Token for mutations.',
      )
      .setVersion('1.0')
      .addCookieAuth('ah_sid')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, cleanupOpenApiDoc(document));
  }

  await app.get(DbService).assertSafeRole();
  app.enableShutdownHooks();
  return app;
}
