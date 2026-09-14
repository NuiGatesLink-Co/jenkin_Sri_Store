import { randomBytes, randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { onTransactionCommit } from '../common/request-context.js';
import { REDIS_CACHE } from './redis.module.js';

/**
 * A group of cached keys that one write invalidates together (#32). Only `products`
 * exists today: it is the one read path the server caches.
 */
export type CacheNamespace = 'products';

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
  constructor(@Inject(REDIS_CACHE) private readonly redis: Redis) {}

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

  async set(key: string, value: unknown, ttlSec: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSec);
    } catch {
      // Fail-open.
    }
  }

  /**
   * Invalidates `ns` for this tenant strictly after the request transaction commits,
   * through the same hook the BullMQ enqueues use. A rollback — a thrown error, a 409 —
   * discards the hook, so a refused write neither invalidates nor exposes anything.
   */
  invalidateAfterCommit(tenantId: string, ns: CacheNamespace): void {
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
    } catch {
      // Fail-open.
    }
  }
}

function newToken(): string {
  return randomBytes(8).toString('hex');
}
