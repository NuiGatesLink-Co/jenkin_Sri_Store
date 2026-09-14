import { randomBytes, randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  hasRequestContext,
  onTransactionCommit,
} from '../common/request-context.js';
import { LOGGER } from './logger.provider.js';
import { REDIS_CACHE } from './redis.module.js';

/**
 * A group of cached keys that one write invalidates together (#32), one generation
 * each. `02_API_SCREENS.md §4.2/§5` name the reads: `GET /products` (+ `/:id`),
 * `GET /settings`, `GET /customers`, `GET /mechanics`.
 */
export type CacheNamespace = 'products' | 'settings' | 'customers' | 'mechanics';

/**
 * TTL per namespace: §5 for products (300 s ± 60 s) and settings (3600 s), §4.2 for
 * customers and mechanics (1 m). §5 requires jitter on every key but gives an amount
 * only for products, so the others get ±10 %.
 */
export const CACHE_TTL: Record<CacheNamespace, { base: number; jitter: number }> = {
  products: { base: 300, jitter: 60 },
  settings: { base: 3600, jitter: 360 },
  customers: { base: 60, jitter: 6 },
  mechanics: { base: 60, jitter: 6 },
};

/** How long a generation lives. Its expiry only costs one miss per key, never staleness. */
const GENERATION_TTL_SEC = 3600;
const GENERATION_JITTER_SEC = 300;

/** `base ± jitter` seconds (02_API_SCREENS.md §5: every key gets TTL + jitter). */
export function ttlWithJitter(baseSec: number, jitterSec: number): number {
  return baseSec - jitterSec + randomInt(2 * jitterSec + 1);
}

export function generationKey(tenantId: string, ns: CacheNamespace): string {
  return `t:${tenantId}:${ns}:gen`;
}

/**
 * Cache-aside with a per-tenant, per-namespace **generation** baked into every key:
 *
 *   t:{tid}:products:gen             → an opaque random token
 *   t:{tid}:products:g:{token}:…     → the cached values
 *
 * Invalidating is one `SET` of a fresh token (02_API_SCREENS.md §5: no `KEYS`, and no
 * scan). The old keys become unreachable and age out on their own TTL.
 *
 * Chosen over §5's tag set (`SADD t:{tid}:tags:products <key>`) for two reasons:
 *
 * 1. `redis-cache` runs `allkeys-lru`. An evicted tag set silently orphans every key it
 *    listed — they stay readable and nothing can find them to delete. An evicted
 *    generation is replaced by a new random token, which is itself an invalidation.
 *    (That is also why the token is random and not an `INCR` counter: a counter that
 *    restarts at 1 after eviction resurrects the keys written under 1.)
 * 2. The read-populate race. A reader that misses, reads the rows *before* a writer
 *    commits, and writes them to the cache *after* the writer invalidated would leave
 *    stale data for a whole TTL. The reader takes the generation before it queries, so
 *    its late write lands under a token the writer has already replaced.
 */
@Injectable()
export class TenantCache {
  constructor(
    @Inject(REDIS_CACHE) private readonly redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * The key prefix for `ns` at its current generation. `null` when Redis cannot answer:
   * the caller then neither reads nor writes the cache (fail-open, like every other
   * Redis use except the tenant status check).
   *
   * 🔴 Call this BEFORE the database read whose result will be cached — that ordering is
   * the whole defence against the read-populate race described above.
   */
  async prefix(tenantId: string, ns: CacheNamespace): Promise<string | null> {
    const key = generationKey(tenantId, ns);
    try {
      let gen = await this.redis.get(key);
      if (gen === null) {
        // NX: two readers creating the first generation at once agree on one token.
        await this.redis.set(
          key,
          newToken(),
          'EX',
          ttlWithJitter(GENERATION_TTL_SEC, GENERATION_JITTER_SEC),
          'NX',
        );
        gen = await this.redis.get(key);
      }
      return gen === null ? null : `t:${tenantId}:${ns}:g:${gen}:`;
    } catch {
      return null;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.redis.get(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  }

  /** Stores `value` under `key` with `ns`'s TTL and jitter. */
  async set(key: string, value: unknown, ns: CacheNamespace): Promise<void> {
    const { base, jitter } = CACHE_TTL[ns];
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlWithJitter(base, jitter));
    } catch {
      // Fail-open.
    }
  }

  /**
   * Invalidates `ns` for this tenant strictly after the request transaction commits,
   * through the same hook the BullMQ enqueues use. A rollback — a thrown error, a 409 —
   * discards the hook, so a refused write neither invalidates nor exposes anything.
   *
   * 🔴 Throws outside a request context. There `onTransactionCommit` runs the hook at
   * once, so a worker or admin-data-source write would invalidate BEFORE its own
   * commit, and a reader in between would cache the old rows under the new generation.
   */
  invalidateAfterCommit(tenantId: string, ns: CacheNamespace): void {
    if (!hasRequestContext()) {
      throw new Error(
        'TenantCache.invalidateAfterCommit needs a request transaction. Outside a request, ' +
          'await your own transaction and then call TenantCache.invalidate().',
      );
    }
    onTransactionCommit(() => this.invalidate(tenantId, ns));
  }

  /**
   * Replaces the generation now. Only for a caller whose own transaction has already
   * committed and is not the request's (the platform import runs on the admin data
   * source); everything in a request uses `invalidateAfterCommit`.
   *
   * If Redis is down this is a no-op and a cached value can outlive the write by up to
   * its TTL — the price of failing open, accepted everywhere else in this cache too.
   */
  async invalidate(tenantId: string, ns: CacheNamespace): Promise<void> {
    try {
      await this.redis.set(
        generationKey(tenantId, ns),
        newToken(),
        'EX',
        ttlWithJitter(GENERATION_TTL_SEC, GENERATION_JITTER_SEC),
      );
    } catch (err) {
      // Fail-open, but loudly: a cached value can now outlive this write by its TTL.
      this.logger.warn({ tenantId, ns, err }, 'cache invalidation failed');
    }
  }
}

function newToken(): string {
  return randomBytes(8).toString('hex');
}
