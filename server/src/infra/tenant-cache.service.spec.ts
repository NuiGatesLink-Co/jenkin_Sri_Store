import { describe, expect, it, vi } from 'vitest';
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
