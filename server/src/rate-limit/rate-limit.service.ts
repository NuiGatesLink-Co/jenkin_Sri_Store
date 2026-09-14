import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { currentRequestTransaction } from '../common/request-context.js';
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

// Gives back one attempt, but never creates the key: a refund that lands after the window rolled
// over must not start the new window at -1.
const REFUND_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

/**
 * The Redis key for a caller-chosen key in the current window (#138). Hashed rather than
 * character-replaced: replacing every non-ASCII character with `_` made two Thai usernames of the
 * same length (and `a.b` / `a_b`) share one bucket and lock each other out.
 */
function windowKey(key: string, windowSec: number): string {
  const windowSlice = Math.floor(Math.floor(Date.now() / 1000) / windowSec);
  const digest = createHash('sha256').update(key).digest('hex');
  return `rl:${digest}:${windowSlice}`;
}

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
      const redisKey = windowKey(key, windowSec);

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
      const redisKey = windowKey(key, windowSec);

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
      const redisKey = windowKey(key, windowSec);

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
   * Counts one attempt and answers whether it is within `limit`, in a single atomic step (#138).
   * `getFailureStatus` followed by `recordFailure` is check-then-increment: N concurrent attempts
   * all read the same count and all pass. Every attempt counts here; a caller that succeeds gives
   * its own attempt back with `refundAttempt`. Fails open like the rest of this service.
   */
  async consumeAttempt(
    key: string,
    limit: number,
    windowSec: number,
  ): Promise<RateLimitCheckResult> {
    try {
      const [count, ttl] = (await this.redis.eval(
        RATE_LIMIT_LUA,
        1,
        windowKey(key, windowSec),
        windowSec,
      )) as [number, number];
      if (count > limit) {
        return { allowed: false, retryAfter: ttl > 0 ? ttl : windowSec };
      }
      return { allowed: true };
    } catch (err) {
      this.logger.warn(`RateLimitService fail-open for ${key}: ${err}`);
      return { allowed: true };
    }
  }

  /**
   * Returns the one attempt a successful caller consumed. Unlike `clearKey` it leaves every other
   * attempt counted, so a success cannot wipe failures made by anyone else.
   */
  async refundAttempt(key: string, windowSec: number): Promise<void> {
    try {
      await this.redis.eval(REFUND_LUA, 1, windowKey(key, windowSec));
    } catch {
      // Non-critical: the attempt simply stays counted for the rest of the window
    }
  }

  /**
   * Clears failed attempt counter upon success.
   */
  async clearKey(key: string, windowSec = 60): Promise<void> {
    try {
      const redisKey = windowKey(key, windowSec);
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
      const rows = await this.readPlan(tenantId);

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

  /**
   * 🔴 **Never a second pool connection while a request holds one (#162).** This guard runs
   * after `RequestContextMiddleware` has already taken the request's connection, so
   * `this.ds.query` here was a nested acquisition: with the plan cache cold (a reset tenant,
   * or every `PLAN_CACHE_TTL_SEC`), `DB_POOL_SIZE` simultaneous requests each held one
   * connection and waited for another, the pool had none to give, and every one of them sat
   * out `connectionTimeoutMillis` (10 s) — the requests queued behind them for a FIRST
   * connection 500'd in the middleware, and this lookup silently failed open to `'basic'`.
   * Measured on `ten simultaneous opens` at `DB_POOL_SIZE=8`: eight plan lookups all failing
   * after 10 000 ms, two 500s. A bigger pool only raises the burst size that triggers it.
   *
   * So inside a request the plan is read on the request's own transaction — the fix
   * `TenantGuard` already applies to `tenants.status`, and safe for the same reason: `tenants`
   * has no RLS, so the read is well defined before `app.tenant_id` is set. It runs inside a
   * savepoint so a failed lookup can still fail open without leaving the request transaction
   * aborted. Outside a request scope (no connection held) the pool is fine.
   */
  private async readPlan(tenantId: string): Promise<{ plan: string }[]> {
    const sql = `SELECT plan FROM tenants WHERE id = $1`;
    const manager = currentRequestTransaction();
    if (!manager) {
      return (await this.ds.query(sql, [tenantId])) as { plan: string }[];
    }
    await manager.query('SAVEPOINT rate_limit_plan');
    try {
      const rows = (await manager.query(sql, [tenantId])) as { plan: string }[];
      await manager.query('RELEASE SAVEPOINT rate_limit_plan');
      return rows;
    } catch (err) {
      await manager.query('ROLLBACK TO SAVEPOINT rate_limit_plan');
      throw err;
    }
  }
}
