import { Global, Inject, Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { LOGGER } from './logger.provider.js';

/** `redis-cache` (allkeys-lru): cache, rate-limit counters, tenant status. */
export const REDIS_CACHE = Symbol('REDIS_CACHE');
/**
 * `redis-queue` (noeviction + AOF). This client only answers `/health/ready`'s PING: BullMQ
 * builds its own connections from `QueueModule`'s options and never receives this one. Never
 * cache here.
 */
export const REDIS_QUEUE = Symbol('REDIS_QUEUE');

/**
 * One app-side ioredis client. Every command rejects after `commandTimeoutMs` (#140) — the same
 * rejection a dropped connection gives, so each caller's existing fail-open path handles it.
 *
 * `enableOfflineQueue: false` alone only fails fast while ioredis *knows* it is disconnected; a
 * Redis that stops answering on an open socket stalled every command without a timeout.
 *
 * 🔴 Never hand these options to BullMQ. ioredis applies `commandTimeout` to blocking commands
 * too, so a worker's `BZPOPMIN` (blocks up to `drainDelay`, 5 s) and QueueEvents' `XREAD BLOCK`
 * (10 s) would reject on every idle poll. BullMQ bounds those with its own watchdog instead.
 */
export function createRedisClient(
  url: string,
  name: string,
  logger: Logger,
  commandTimeoutMs: number,
): Redis {
  const client = new Redis(url, {
    // Fail fast while disconnected instead of queueing commands: a cache or
    // readiness call must not hang behind a dead Redis.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: commandTimeoutMs,
  });
  // ioredis throws on an unhandled error event; log and keep reconnecting.
  client.on('error', (err) =>
    logger.warn({ redis: name, err: err.message }, 'redis error'),
  );
  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CACHE,
      inject: [APP_CONFIG, LOGGER],
      useFactory: (cfg: AppConfig, logger: Logger) =>
        createRedisClient(cfg.redisCacheUrl, 'cache', logger, cfg.redisCommandTimeoutMs),
    },
    {
      provide: REDIS_QUEUE,
      inject: [APP_CONFIG, LOGGER],
      useFactory: (cfg: AppConfig, logger: Logger) =>
        createRedisClient(cfg.redisQueueUrl, 'queue', logger, cfg.redisCommandTimeoutMs),
    },
  ],
  exports: [REDIS_CACHE, REDIS_QUEUE],
})
export class RedisModule {
  constructor(
    @Inject(REDIS_CACHE) private readonly cache: Redis,
    @Inject(REDIS_QUEUE) private readonly queue: Redis,
  ) {}
  async onModuleDestroy() {
    await Promise.allSettled([this.cache.quit(), this.queue.quit()]);
  }
}
