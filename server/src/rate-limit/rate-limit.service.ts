import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CACHE } from '../infra/redis.module.js';

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfter?: number;
}

const DEFAULT_LIMIT = 300;
const DEFAULT_WINDOW_SEC = 60;
const PLAN_CACHE_TTL_SEC = 300;

// Lua script to atomically increment and set expire if key is new
const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { current, ttl }
`;

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(
    @Inject(REDIS_CACHE) private readonly redis: Redis,
    private readonly ds: DataSource,
  ) {}

  /**
   * Checks whether a request for a specific tenant and route is within quota.
   * ADR-0006: Fails open if Redis or DB is unavailable (POS cannot stop selling).
   */
  async checkRateLimit(
    tenantId: string,
    routeKey: string,
    options?: { limit?: number; windowSec?: number },
  ): Promise<RateLimitCheckResult> {
    if (!tenantId) {
      return { allowed: true };
    }

    try {
      // 1. Resolve tenant plan (cached in Redis t:{tid}:plan)
      const plan = await this.getTenantPlan(tenantId);

      // ADR-0006: 'loadtest' plan is unlimited so k6 measures the system rather than limiter
      if (plan === 'loadtest') {
        return { allowed: true };
      }

      const limit = options?.limit ?? DEFAULT_LIMIT;
      const windowSec = options?.windowSec ?? DEFAULT_WINDOW_SEC;
      const nowSec = Math.floor(Date.now() / 1000);
      const windowSlice = Math.floor(nowSec / windowSec);

      // ADR-0006 key: t:{tid}:rl:{route}:{window}
      const sanitizedRoute = routeKey.replace(/[^a-zA-Z0-9_-]/g, '_');
      const key = `t:${tenantId}:rl:${sanitizedRoute}:${windowSlice}`;

      // Atomic INCR + EXPIRE
      const result = (await this.redis.eval(
        RATE_LIMIT_LUA,
        1,
        key,
        windowSec,
      )) as [number, number];

      const count = result[0];
      const ttl = result[1];

      if (count > limit) {
        const retryAfter = ttl > 0 ? ttl : windowSec;
        return {
          allowed: false,
          retryAfter,
        };
      }

      return { allowed: true };
    } catch (err) {
      // ADR-0006: Fail-open rule: if Redis fails, let traffic through
      this.logger.warn(
        `RateLimitService fail-open for tenant ${tenantId} on route ${routeKey}: ${err}`,
      );
      return { allowed: true };
    }
  }

  /**
   * Checks key-based rate limit (e.g. per-IP requests).
   */
  async checkKeyLimit(
    key: string,
    limit: number,
    windowSec: number,
  ): Promise<RateLimitCheckResult> {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const windowSlice = Math.floor(nowSec / windowSec);
      const sanitizedKey = key.replace(/[^a-zA-Z0-9_:-]/g, '_');
      const redisKey = `rl:${sanitizedKey}:${windowSlice}`;

      const result = (await this.redis.eval(
        RATE_LIMIT_LUA,
        1,
        redisKey,
        windowSec,
      )) as [number, number];

      const count = result[0];
      const ttl = result[1];

      if (count > limit) {
        const retryAfter = ttl > 0 ? ttl : windowSec;
        return { allowed: false, retryAfter };
      }
      return { allowed: true };
    } catch (err) {
      this.logger.warn(`RateLimitService fail-open on key ${key}: ${err}`);
      return { allowed: true };
    }
  }

  /**
   * Checks whether failed attempts have exceeded threshold.
   */
  async getFailureStatus(
    key: string,
    limit: number,
    windowSec: number,
  ): Promise<RateLimitCheckResult> {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const windowSlice = Math.floor(nowSec / windowSec);
      const sanitizedKey = key.replace(/[^a-zA-Z0-9_:-]/g, '_');
      const redisKey = `rl:${sanitizedKey}:${windowSlice}`;

      const countStr = await this.redis.get(redisKey);
      const count = countStr ? parseInt(countStr, 10) : 0;

      if (count >= limit) {
        const ttl = await this.redis.ttl(redisKey);
        const retryAfter = ttl > 0 ? ttl : windowSec;
        return { allowed: false, retryAfter };
      }
      return { allowed: true };
    } catch (err) {
      this.logger.warn(`RateLimitService fail-open for ${key}: ${err}`);
      return { allowed: true };
    }
  }

  /**
   * Records a failed attempt (increments failure counter with TTL).
   */
  async recordFailure(key: string, windowSec: number): Promise<number> {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const windowSlice = Math.floor(nowSec / windowSec);
      const sanitizedKey = key.replace(/[^a-zA-Z0-9_:-]/g, '_');
      const redisKey = `rl:${sanitizedKey}:${windowSlice}`;

      const result = (await this.redis.eval(
        RATE_LIMIT_LUA,
        1,
        redisKey,
        windowSec,
      )) as [number, number];

      return result[0];
    } catch (err) {
      this.logger.warn(`RateLimitService failed to record failure for key ${key}: ${err}`);
      return 0;
    }
  }

  /**
   * Clears failed attempt counter upon success.
   */
  async clearKey(key: string, windowSec = 60): Promise<void> {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const windowSlice = Math.floor(nowSec / windowSec);
      const sanitizedKey = key.replace(/[^a-zA-Z0-9_:-]/g, '_');
      const redisKey = `rl:${sanitizedKey}:${windowSlice}`;
      await this.redis.del(redisKey);
    } catch {
      // Non-critical
    }
  }

  private async getTenantPlan(tenantId: string): Promise<string> {
    const cacheKey = `t:${tenantId}:plan`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return cached;
      }
    } catch {
      // Redis error reading plan -> proceed to DB lookup
    }

    try {
      const rows = await this.ds.query(
        `SELECT plan FROM tenants WHERE id = $1`,
        [tenantId],
      );

      if (rows.length === 0) {
        return 'basic';
      }

      const plan = (rows[0].plan as string) || 'basic';

      try {
        await this.redis.set(cacheKey, plan, 'EX', PLAN_CACHE_TTL_SEC);
      } catch {
        // Non-critical if caching fails
      }

      return plan;
    } catch {
      return 'basic';
    }
  }
}
