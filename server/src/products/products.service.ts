import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { currentRequestContext } from '../common/request-context.js';
import { REDIS_CACHE } from '../infra/redis.module.js';

export interface Product {
  id: string;
  partNo: string;
  name: string;
  nameTH: string;
  category: string;
  brand: string;
  price: number;
  cost: number;
  stock: number;
  minStock: number;
  compat: string | null;
  updatedAt: string;
  deletedAt: string | null;
}

interface ProductRow {
  id: string;
  part_no: string;
  name: string;
  name_th: string;
  category: string;
  brand: string;
  price: string | number;
  cost: string | number;
  stock: number;
  min_stock: number;
  compat: string | null;
  updated_at: Date;
  deleted_at: Date | null;
}

const COLUMNS = `id, part_no, name, name_th, category, brand, price, cost, stock,
                 min_stock, compat, updated_at, deleted_at`;

const PRODUCTS_CACHE_TTL_SEC = 60;

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    partNo: row.part_no,
    name: row.name,
    nameTH: row.name_th,
    category: row.category,
    brand: row.brand,
    price: typeof row.price === 'number' ? row.price : parseFloat(row.price),
    cost: typeof row.cost === 'number' ? row.cost : parseFloat(row.cost),
    stock: row.stock,
    minStock: row.min_stock,
    compat: row.compat,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    deletedAt: row.deleted_at ? (row.deleted_at instanceof Date ? row.deleted_at.toISOString() : String(row.deleted_at)) : null,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

@Injectable()
export class ProductsService {
  constructor(@Inject(REDIS_CACHE) private readonly redis: Redis) {}

  private cacheKey(
    tenantId: string,
    query: {
      search?: string;
      category?: string;
      updatedSince?: string;
      page: number;
      limit: number;
    },
  ): string {
    const s = query.search ? `s:${query.search}:` : '';
    const c = query.category ? `c:${query.category}:` : '';
    const u = query.updatedSince ? `u:${query.updatedSince}:` : '';
    return `t:${tenantId}:products:list:${s}${c}${u}${query.page}:${query.limit}`;
  }

  async list(query: {
    search?: string;
    category?: string;
    updatedSince?: string;
    page: number;
    limit: number;
  }): Promise<{ items: Product[]; total: number; fromCache: boolean }> {
    const { tenantId, manager } = currentRequestContext();
    const key = this.cacheKey(tenantId, query);

    try {
      const cached = await this.redis.get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as { items: Product[]; total: number };
        return { items: parsed.items, total: parsed.total, fromCache: true };
      }
    } catch {
      // Redis fail-open: if cache fails, proceed to database
    }

    const params: unknown[] = [tenantId];
    const where = [
      'tenant_id = $1::uuid',
      query.updatedSince ? 'TRUE' : 'deleted_at IS NULL',
    ];

    if (query.search) {
      params.push(`%${escapeLike(query.search)}%`);
      where.push(
        `(part_no ILIKE $${params.length} ESCAPE '\\' OR name ILIKE $${params.length} ESCAPE '\\' OR name_th ILIKE $${params.length} ESCAPE '\\')`,
      );
    }

    if (query.category) {
      params.push(query.category);
      where.push(`category = $${params.length}`);
    }

    if (query.updatedSince) {
      params.push(query.updatedSince);
      where.push(`updated_at > $${params.length}::timestamptz`);
    }

    const clause = where.join(' AND ');
    const totals = (await manager.query(
      `SELECT count(*)::int AS n FROM products WHERE ${clause}`,
      params,
    )) as { n: number }[];

    params.push(query.limit, (query.page - 1) * query.limit);
    const rows = (await manager.query(
      `SELECT ${COLUMNS} FROM products
        WHERE ${clause}
        ORDER BY id ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )) as ProductRow[];

    const items = rows.map(toProduct);
    const total = totals[0]?.n ?? 0;

    try {
      await this.redis.set(
        key,
        JSON.stringify({ items, total }),
        'EX',
        PRODUCTS_CACHE_TTL_SEC,
      );
    } catch {
      // Redis fail-open
    }

    return { items, total, fromCache: false };
  }

  async byId(id: string): Promise<{ product: Product; fromCache: boolean }> {
    const { tenantId, manager } = currentRequestContext();
    const key = `t:${tenantId}:products:item:${id}`;

    try {
      const cached = await this.redis.get(key);
      if (cached) {
        return { product: JSON.parse(cached) as Product, fromCache: true };
      }
    } catch {
      // Fail-open
    }

    const rows = (await manager.query(
      `SELECT ${COLUMNS} FROM products
        WHERE tenant_id = $1::uuid AND id = $2 AND deleted_at IS NULL`,
      [tenantId, id],
    )) as ProductRow[];

    if (!rows || rows.length === 0) {
      throw new NotFoundException(`Product ${id} not found`);
    }

    const product = toProduct(rows[0]);
    try {
      await this.redis.set(
        key,
        JSON.stringify(product),
        'EX',
        PRODUCTS_CACHE_TTL_SEC,
      );
    } catch {
      // Fail-open
    }

    return { product, fromCache: false };
  }

  async invalidateCache(tenantId: string): Promise<void> {
    try {
      const keys = await this.redis.keys(`t:${tenantId}:products:*`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch {
      // Fail-open
    }
  }
}
