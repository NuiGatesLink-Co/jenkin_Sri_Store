import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runInRequestContext } from '../common/request-context.js';
import { RateLimitService } from './rate-limit.service.js';

describe('RateLimitService (ADR-0006)', () => {
  let service: RateLimitService;
  let redisMock: any;
  let dsMock: any;

  beforeEach(() => {
    redisMock = {
      get: vi.fn(),
      set: vi.fn(),
      eval: vi.fn(),
    };
    dsMock = {
      query: vi.fn(),
    };
    service = new RateLimitService(redisMock, dsMock);
  });

  it('allows request when within quota', async () => {
    // Plan is basic
    redisMock.get.mockResolvedValue('basic');
    // Lua returns [currentCount, ttl]
    redisMock.eval.mockResolvedValue([5, 55]);

    const res = await service.checkRateLimit('tenant-1', 'GET:/products', {
      limit: 10,
      windowSec: 60,
    });

    expect(res.allowed).toBe(true);
    expect(res.retryAfter).toBeUndefined();
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringContaining('t:tenant-1:rl:GET__products:'),
      60,
    );
  });

  it('rejects request with retryAfter when quota is exceeded', async () => {
    redisMock.get.mockResolvedValue('basic');
    // Count is 11, over limit of 10. TTL is 42 seconds remaining
    redisMock.eval.mockResolvedValue([11, 42]);

    const res = await service.checkRateLimit('tenant-1', 'POST:/sales', {
      limit: 10,
      windowSec: 60,
    });

    expect(res.allowed).toBe(false);
    expect(res.retryAfter).toBe(42);
  });

  it('bypasses rate limit if tenant plan is loadtest (ADR-0006)', async () => {
    redisMock.get.mockResolvedValue('loadtest');

    const res = await service.checkRateLimit('tenant-loadtest', 'POST:/sales', {
      limit: 10,
      windowSec: 60,
    });

    expect(res).toEqual({ allowed: true });
    // Should not even call redis.eval to increment counter
    expect(redisMock.eval).not.toHaveBeenCalled();
  });

  it('queries database for plan on cache miss and caches it in Redis', async () => {
    redisMock.get.mockResolvedValue(null); // cache miss
    dsMock.query.mockResolvedValue([{ plan: 'demo' }]);
    redisMock.eval.mockResolvedValue([1, 60]);

    const res = await service.checkRateLimit('tenant-demo', 'GET:/products', {
      limit: 10,
      windowSec: 60,
    });

    expect(res.allowed).toBe(true);
    expect(dsMock.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT plan FROM tenants WHERE id = $1'),
      ['tenant-demo'],
    );
    expect(redisMock.set).toHaveBeenCalledWith(
      't:tenant-demo:plan',
      'demo',
      'EX',
      300,
    );
  });

  // #162: inside a request the middleware already holds a pool connection, so a second one
  // from `ds` deadlocks the pool under a burst. The plan is read on the request's own
  // transaction instead, inside a savepoint.
  it('reads the plan on the request transaction, never the pool, inside a request (#162)', async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.eval.mockResolvedValue([1, 60]);
    const manager = {
      query: vi.fn(async (sql: string) => (sql.startsWith('SELECT') ? [{ plan: 'demo' }] : [])),
    };

    const res = await runInRequestContext({ manager: manager as any }, () =>
      service.checkRateLimit('tenant-demo', 'GET:/products'),
    );

    expect(res.allowed).toBe(true);
    expect(dsMock.query).not.toHaveBeenCalled();
    expect(manager.query.mock.calls.map((c) => c[0])).toEqual([
      'SAVEPOINT rate_limit_plan',
      'SELECT plan FROM tenants WHERE id = $1',
      'RELEASE SAVEPOINT rate_limit_plan',
    ]);
    expect(redisMock.set).toHaveBeenCalledWith('t:tenant-demo:plan', 'demo', 'EX', 300);
  });

  it('rolls back to the savepoint when the in-request plan read fails, and fails open (#162)', async () => {
    redisMock.get.mockResolvedValue(null);
    redisMock.eval.mockResolvedValue([1, 60]);
    const manager = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('SELECT')) throw new Error('invalid input syntax for type uuid');
        return [];
      }),
    };

    const res = await runInRequestContext({ manager: manager as any }, () =>
      service.checkRateLimit('not-a-uuid', 'GET:/products'),
    );

    expect(res.allowed).toBe(true);
    // Without the rollback the request transaction would be aborted, and every later
    // statement in it — the guard's `SET LOCAL` included — would fail.
    expect(manager.query).toHaveBeenLastCalledWith('ROLLBACK TO SAVEPOINT rate_limit_plan');
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('fails open when Redis throws an error (ADR-0006 fail-open rule)', async () => {
    redisMock.get.mockRejectedValue(new Error('Redis connection refused'));
    dsMock.query.mockResolvedValue([{ plan: 'basic' }]);
    redisMock.eval.mockRejectedValue(new Error('Redis connection refused'));

    const res = await service.checkRateLimit('tenant-1', 'POST:/sales', {
      limit: 10,
      windowSec: 60,
    });

    // Must allow request through so POS does not stop selling!
    expect(res.allowed).toBe(true);
  });

  it('isolates tenants: keys contain tenant ID prefix', async () => {
    redisMock.get.mockResolvedValue('basic');
    redisMock.eval.mockResolvedValue([1, 60]);

    await service.checkRateLimit('tenant-A', 'POST:/sales');
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringContaining('t:tenant-A:rl:'),
      expect.any(Number),
    );

    await service.checkRateLimit('tenant-B', 'POST:/sales');
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringContaining('t:tenant-B:rl:'),
      expect.any(Number),
    );
  });
});

// #138: brute-force counters keyed by caller-chosen strings.
describe('RateLimitService attempt counters (#138)', () => {
  // A Redis stand-in with the INCR/EXPIRE and EXISTS/DECR semantics the Lua scripts implement.
  const fakeRedis = () => {
    const store = new Map<string, number>();
    return {
      store,
      get: vi.fn(async (k: string) => (store.has(k) ? String(store.get(k)) : null)),
      ttl: vi.fn(async () => 60),
      del: vi.fn(async (k: string) => store.delete(k)),
      eval: vi.fn(async (script: string, _n: number, key: string) => {
        if (script.includes('INCR')) {
          store.set(key, (store.get(key) ?? 0) + 1);
          return [store.get(key), 60];
        }
        if (store.has(key)) {
          store.set(key, store.get(key)! - 1);
          return store.get(key);
        }
        return 0;
      }),
    };
  };

  it('gives equal-length Thai usernames separate buckets', async () => {
    const redis = fakeRedis();
    const service = new RateLimitService(redis as any, {} as any);

    await service.recordFailure('auth:user:t1:สมชาย', 60);
    await service.recordFailure('auth:user:t1:สมศรี', 60);

    expect(redis.store.size).toBe(2);
  });

  it('does not collide a.b with a_b', async () => {
    const redis = fakeRedis();
    const service = new RateLimitService(redis as any, {} as any);

    await service.recordFailure('auth:user:t1:a.b', 60);
    await service.recordFailure('auth:user:t1:a_b', 60);

    expect(redis.store.size).toBe(2);
  });

  it('allows exactly `limit` concurrent attempts', async () => {
    const redis = fakeRedis();
    const service = new RateLimitService(redis as any, {} as any);

    const results = await Promise.all(
      Array.from({ length: 15 }, () => service.consumeAttempt('auth:ip:10.0.0.1', 10, 60)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(5);
  });

  it('refunds one attempt without clearing the others', async () => {
    const redis = fakeRedis();
    const service = new RateLimitService(redis as any, {} as any);
    for (let i = 0; i < 3; i++) await service.consumeAttempt('auth:ip:10.0.0.2', 10, 60);

    await service.refundAttempt('auth:ip:10.0.0.2', 60);

    expect([...redis.store.values()]).toEqual([2]);
  });

  it('never creates a key when refunding into an empty window', async () => {
    const redis = fakeRedis();
    const service = new RateLimitService(redis as any, {} as any);

    await service.refundAttempt('auth:ip:10.0.0.3', 60);

    expect(redis.store.size).toBe(0);
  });

  it('fails open when Redis errors', async () => {
    const service = new RateLimitService(
      { eval: vi.fn().mockRejectedValue(new Error('down')) } as any,
      {} as any,
    );
    await expect(service.consumeAttempt('auth:ip:10.0.0.4', 1, 60)).resolves.toEqual({
      allowed: true,
    });
    await expect(service.refundAttempt('auth:ip:10.0.0.4', 60)).resolves.toBeUndefined();
  });
});
