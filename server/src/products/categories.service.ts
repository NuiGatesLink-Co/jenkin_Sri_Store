import { Injectable } from '@nestjs/common';
import { currentRequestContext } from '../common/request-context.js';
import { SEED_CATEGORIES } from '../db/seed.js';
import { TenantCache } from '../infra/tenant-cache.service.js';
import { TenantService } from '../common/database/tenant.service.js';

export interface Category {
  name: string;
  color: string;
}

/** `CAT_PALETTE` from db.js, as `products_repository.dart` carries it. Order is identity. */
export const CAT_PALETTE = [
  '#1E4A80',
  '#C04E10',
  '#3B6D11',
  '#6B2DA8',
  '#1A6B5C',
  '#8B4513',
  '#1A5C8B',
  '#8B2840',
  '#4A6B1A',
  '#6B4A1A',
] as const;

/**
 * `db.js getCatColor`: the palette entry at the category's index in the ordered
 * list; for a name that is not in the list — a product whose category was deleted,
 * which is orphaned by design (01_DATABASE.md §10) — a deterministic hash of the name.
 *
 * The hash is JS's `(h * 31 + charCode) & 0xffffffff` then `Math.abs`: a SIGNED 32-bit
 * wrap over UTF-16 code units, which `| 0` reproduces exactly (`toSigned(32)` in Dart).
 */
export function catColor(name: string, ordered: readonly string[]): string {
  const index = ordered.indexOf(name);
  if (index >= 0) return CAT_PALETTE[index % CAT_PALETTE.length];
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  }
  return CAT_PALETTE[Math.abs(h) % CAT_PALETTE.length];
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly cache: TenantCache,
    private readonly tenants: TenantService,
  ) {}

  /**
   * `GET /categories` through `t:{tid}:categories:g:{token}:list` (§5, 3600 s). `list()`
   * stays a plain read: `create()` calls it inside its write transaction and
   * `/bootstrap` hashes a fresh body, and neither may touch the cache.
   */
  listCached(): Promise<{ categories: Category[]; fromCache: boolean }> {
    return this.tenants.runTx(() => this.listCachedIn());
  }

  private async listCachedIn(): Promise<{ categories: Category[]; fromCache: boolean }> {
    const { tenantId } = currentRequestContext();
    const prefix = await this.cache.prefix(tenantId, 'categories');
    const key = prefix === null ? null : `${prefix}list`;
    if (key !== null) {
      const cached = await this.cache.get<Category[]>(key);
      if (cached) return { categories: cached, fromCache: true };
    }
    const categories = await this.list();
    if (key !== null) await this.cache.set(key, categories, 'categories');
    return { categories, fromCache: false };
  }

  /**
   * `[{ name, color }]` in ONE query (02_API_SCREENS.md §3.1): the client used to call
   * `catColor()` once per category, which becomes 1 + N requests over HTTP.
   *
   * `db.js getCategories`: ordered by `position`; when the table is empty the five seed
   * categories stand in, exactly as the Dart repository answers.
   */
  list(): Promise<Category[]> {
    return this.tenants.runTx(() => this.listIn());
  }

  private async listIn(): Promise<Category[]> {
    const { tenantId, manager } = currentRequestContext();
    const rows = (await manager.query(
      `SELECT name FROM categories WHERE tenant_id = $1::uuid ORDER BY position ASC, name ASC`,
      [tenantId],
    )) as { name: string }[];
    const names =
      rows.length === 0 ? [...SEED_CATEGORIES] : rows.map((r) => r.name);
    return names.map((name) => ({ name, color: catColor(name, names) }));
  }

  /**
   * `db.js addCategory`: appended after the last position; a name that already exists
   * is left alone rather than refused, as the Dart repository ignores it.
   */
  create(name: string): Promise<Category> {
    return this.tenants.runTx(() => this.createIn(name));
  }

  private async createIn(name: string): Promise<Category> {
    const { tenantId, manager } = currentRequestContext();
    // Two concurrent adds would otherwise both read the same MAX(position) and give
    // two categories one palette slot.
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${tenantId}:categories:position`],
    );
    await manager.query(
      `INSERT INTO categories (tenant_id, name, position)
       SELECT $1::uuid, $2, COALESCE(MAX(position) + 1, 0)
         FROM categories WHERE tenant_id = $1::uuid
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [tenantId, name],
    );
    this.cache.invalidateAfterCommit(tenantId, 'categories');
    const all = await this.list();
    return all.find((c) => c.name === name) as Category;
  }

  /**
   * `db.js deleteCategory`: a hard delete of the row, and nothing else — no foreign key
   * points at it, and `products.category` keeps the name (01_DATABASE.md §10).
   */
  delete(name: string): Promise<{ name: string; deleted: true }> {
    return this.tenants.runTx(() => this.deleteIn(name));
  }

  private async deleteIn(name: string): Promise<{ name: string; deleted: true }> {
    const { tenantId, manager } = currentRequestContext();
    await manager.query(
      `DELETE FROM categories WHERE tenant_id = $1::uuid AND name = $2`,
      [tenantId, name],
    );
    this.cache.invalidateAfterCommit(tenantId, 'categories');
    return { name, deleted: true };
  }
}
