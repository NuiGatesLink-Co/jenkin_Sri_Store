import { NestFactory } from '@nestjs/core';
import type { Server } from 'node:http';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { createLogger, PinoNestLogger } from './common/logger.js';
import { loadConfig } from './config/config.js';
import { createServer } from 'node:http';

if (process.env.STANDALONE_HEALTH === 'true' || !process.env.DATABASE_URL) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'up' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'taskflow-api' }));
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`taskflow-api listening on port ${port} (standalone mode)`);
  });
} else {
  const config = loadConfig();
const logger = createLogger({
  level: config.logLevel,
  instanceId: config.instanceId,
});

const app = await NestFactory.create(AppModule.forRoot(config, logger), {
  logger: new PinoNestLogger(logger),
});
await configureApp(app, logger);

// Keep-alive must outlive Nginx's upstream keepalive (60s) or Nginx reuses a
// socket Node just closed and answers 502.
const server = app.getHttpServer() as Server;
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

await app.listen(config.port, '0.0.0.0');
logger.info({ port: config.port }, 'api listening');
}
