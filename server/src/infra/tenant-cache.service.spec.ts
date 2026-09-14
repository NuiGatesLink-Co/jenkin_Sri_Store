import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInRequestContext } from '../common/request-context.js';
import { generationKey, TenantCache } from './tenant-cache.service.js';

const TID = '00000000-0000-4000-8000-000000000032';

function cacheWith(redis: Record<string, unknown>) {
  const logger = { warn: vi.fn() };
  return { cache: new TenantCache(redis as any, logger as any), logger };
}

describe('TenantCache (#32)', () => {
  it('invalidateAfterCommit throws outside a request context instead of invalidating before a commit', () => {
    const redis = { set: vi.fn() };
    const { cache } = cacheWith(redis);
    expect(() => cache.invalidateAfterCommit(TID, 'products')).toThrow(
      /TenantCache\.invalidate\(\)/,
    );
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('inside a request context it registers the hook and does not invalidate yet', () => {
    const redis = { set: vi.fn() };
    const { cache } = cacheWith(redis);
    return runInRequestContext({ tenantId: TID, manager: {} as any }, async () => {
      cache.invalidateAfterCommit(TID, 'products');
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  it('a failed invalidation is logged, not thrown', async () => {
    const err = new Error('redis down');
    const redis = { set: vi.fn().mockRejectedValue(err) };
    const { cache, logger } = cacheWith(redis);
    await expect(cache.invalidate(TID, 'mechanics')).resolves.toBeUndefined();
    expect(redis.set.mock.calls[0][0]).toBe(generationKey(TID, 'mechanics'));
    expect(logger.warn).toHaveBeenCalledWith(
      { tenantId: TID, ns: 'mechanics', err },
      'cache invalidation failed',
    );
  });
});

/** An in-memory Redis with what `singleFlight` uses: GET, SET … PX … NX, and the release script. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    }),
    eval: vi.fn(async (_script: string, _n: number, k: string, token: string) => {
      if (store.get(k) !== token) return 0;
      store.delete(k);
      return 1;
    }),
  };
}

type Release = { release: () => Promise<void> };

describe('TenantCache.singleFlight (#124)', () => {
  const KEY = `t:${TID}:products:g:abc:list:1:50`;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the first miss takes the lock with SET NX PX 5000 and releases only its own token', async () => {
    const redis = fakeRedis();
    const { cache } = cacheWith(redis);
    const flight = await cache.singleFlight(KEY);
    expect('release' in flight).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(`${KEY}:lock`, expect.any(String), 'PX', 5000, 'NX');

    // The lock expired and another loader took it: a late release must not free theirs.
    redis.store.set(`${KEY}:lock`, 'someone-else');
    await (flight as Release).release();
    expect(redis.store.get(`${KEY}:lock`)).toBe('someone-else');
  });

  it('a waiter answers the value the loader stored, and never becomes a loader', async () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    const { cache } = cacheWith(redis);
    const loader = await cache.singleFlight(KEY);

    const waiter = cache.singleFlight<{ total: number }>(KEY);
    await vi.advanceTimersByTimeAsync(60);
    // The loader stores its value, then releases — the order `ProductsService.list` uses.
    redis.store.set(KEY, JSON.stringify({ total: 7 }));
    await (loader as Release).release();
    await vi.advanceTimersByTimeAsync(20);

    await expect(waiter).resolves.toEqual({ value: { total: 7 } });
    expect(redis.store.has(`${KEY}:lock`)).toBe(false);
  });

  it('a waiter answers a value that is already stored without sleeping first', async () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    const { cache } = cacheWith(redis);
    await cache.singleFlight(KEY);
    // The loader stored its value but has not released yet.
    redis.store.set(KEY, JSON.stringify({ total: 3 }));

    // No timer is advanced: a sleep before the first read would never resolve.
    await expect(cache.singleFlight<{ total: number }>(KEY)).resolves.toEqual({
      value: { total: 3 },
    });
  });

  it('a waiter whose loader never stores a value reads Postgres itself after a bounded wait', async () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    redis.store.set(`${KEY}:lock`, 'dead-loader');
    const { cache } = cacheWith(redis);

    let settled = false;
    const waiter = cache.singleFlight(KEY).then((f) => {
      settled = true;
      return f;
    });
    await vi.advanceTimersByTimeAsync(900);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);

    const flight = await waiter;
    expect('release' in flight).toBe(true);
    // A no-op release: the dead loader's lock is not this request's to free.
    await (flight as Release).release();
    expect(redis.store.get(`${KEY}:lock`)).toBe('dead-loader');
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('a waiter takes over when the loader released without storing a value', async () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    const { cache } = cacheWith(redis);
    const loader = await cache.singleFlight(KEY);

    const waiter = cache.singleFlight(KEY);
    await vi.advanceTimersByTimeAsync(40);
    await (loader as Release).release();
    await vi.advanceTimersByTimeAsync(20);

    const flight = await waiter;
    expect('release' in flight).toBe(true);
    expect(redis.store.has(`${KEY}:lock`)).toBe(true);
  });

  it('a Redis error never fails the request: the caller loads without a lock', async () => {
    const redis = fakeRedis();
    redis.set.mockRejectedValue(new Error('redis down'));
    const { cache } = cacheWith(redis);
    const flight = await cache.singleFlight(KEY);
    expect('release' in flight).toBe(true);
    await expect((flight as Release).release()).resolves.toBeUndefined();
  });
});
