import { Global, Module } from '@nestjs/common';
import { TenantCache } from './tenant-cache.service.js';

/**
 * #32: the cache-aside helper every cached read and every invalidating write shares.
 * Global, like the Redis client it wraps, so a write module never has to import the
 * module that owns a read just to invalidate it.
 */
@Global()
@Module({ providers: [TenantCache], exports: [TenantCache] })
export class TenantCacheModule {}
