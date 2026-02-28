import 'reflect-metadata';
import { setDefaultResultOrder } from 'node:dns';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';

function isEnabled(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return fallback;
}

async function bootstrap() {
  // Prefer IPv4 for environments where IPv6 routes are unavailable.
  setDefaultResultOrder('ipv4first');
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    rawBody: true,
  });

  const enableHttpRequestLogs = isEnabled(
    process.env.HTTP_REQUEST_LOGGING,
    process.env.NODE_ENV !== 'production',
  );
  if (enableHttpRequestLogs) {
    const httpLogger = new Logger('HTTP');
    app.use((req: any, res: any, next: () => void) => {
      const startedAt = Date.now();
      const method = typeof req?.method === 'string' ? req.method : 'UNKNOWN';
      const originalUrl =
        (typeof req?.originalUrl === 'string' && req.originalUrl.length > 0)
          ? req.originalUrl
          : (typeof req?.url === 'string' ? req.url : '/');

      res.on('finish', () => {
        const statusCode = Number.isFinite(res?.statusCode) ? Number(res.statusCode) : 0;
        const durationMs = Date.now() - startedAt;
        const remoteAddress =
          (typeof req?.ip === 'string' && req.ip.length > 0)
            ? req.ip
            : (typeof req?.socket?.remoteAddress === 'string'
              ? req.socket.remoteAddress
              : 'unknown');

        const line = `${method} ${originalUrl} ${statusCode} ${durationMs}ms - ${remoteAddress}`;
        if (statusCode >= 500) {
          httpLogger.error(line);
          return;
        }

        if (statusCode >= 400) {
          httpLogger.warn(line);
          return;
        }

        httpLogger.log(line);
      });

      next();
    });
  }

  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? true,
    credentials: true,
  });

  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  logger.log(`Impactis API listening on http://localhost:${port}/api/v1`);
}

bootstrap().catch((err) => {
  console.error('Failed to bootstrap Impactis API', err);
  process.exitCode = 1;
});
