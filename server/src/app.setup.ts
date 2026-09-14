import {
  NotFoundException,
  RequestMethod,
  type INestApplication,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import helmet from 'helmet';
import { EnvelopeInterceptor } from './common/envelope.interceptor.js';
import {
  HttpExceptionFilter,
  toErrorEnvelope,
} from './common/http-exception.filter.js';
import { requestLogger } from './common/logger.js';
import { TransactionInterceptor } from './common/transaction.interceptor.js';
import { APP_CONFIG, type AppConfig } from './config/config.js';

/** Everything main.ts and the e2e tests must configure identically. */
export async function configureApp(
  app: INestApplication,
  logger: Logger,
): Promise<void> {
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  // Exactly one trusted hop: nginx, which appends $remote_addr to X-Forwarded-For. Without
  // this `req.ip` is nginx's container address for every client, so the per-IP login
  // limit was one bucket for everyone. Never `true` — that trusts the leftmost entry,
  // which the client writes.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Security headers via Helmet (OWASP A05)
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Dynamic CORS configuration (OWASP A05)
  let allowedOrigins: string[] = ['*'];
  try {
    const cfg = app.get<AppConfig>(APP_CONFIG, { strict: false });
    if (cfg?.corsOrigins && cfg.corsOrigins.length > 0) {
      allowedOrigins = cfg.corsOrigins;
    }
  } catch {
    // fallback if APP_CONFIG not bound
  }

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Allow requests with no origin (mobile apps, server-to-server, curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'If-None-Match',
      'X-Device-Id',
      'X-Client-Version',
      'X-Correlation-ID',
    ],
    exposedHeaders: ['Idempotency-Key', 'Retry-After', 'X-Correlation-ID', 'ETag'],
  });

  app.use(requestLogger(logger));
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  // Order matters: the envelope wraps whatever comes back, the transaction ends
  // inside it, and every route-scoped interceptor (IdempotencyInterceptor above all)
  // runs inside the transaction — its record must commit with the work it describes.
  app.useGlobalInterceptors(new EnvelopeInterceptor(), new TransactionInterceptor(logger));
  app.useGlobalFilters(new HttpExceptionFilter(logger));
  app.enableShutdownHooks();
  await app.init();

  // Nest mounts its own 404 handler only under the global prefix; anything
  // else would fall through to the Express HTML page. Keep the envelope everywhere.
  app
    .getHttpAdapter()
    .getInstance()
    .use((req: Request, res: Response) => {
      const { status, body } = toErrorEnvelope(
        new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`),
      );
      res.status(status).json(body);
    });
}
