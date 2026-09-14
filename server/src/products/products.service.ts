import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AuditService } from '../audit/audit.service.js';
import { newId } from '../common/ids.js';
import { fromSatang, satangOf } from '../common/money.js';
import {
  currentRequestContext,
  onTransactionCommit,
} from '../common/request-context.js';
import { returning } from '../common/sql.js';
import { REDIS_CACHE } from '../infra/redis.module.js';
import {
  MOVEMENT_COLUMNS,
  movementOut,
  type MovementOut,
  type MovementRow,
} from '../sales/sales.service.js';
import type {
  ProductCreate,
  ProductPatch,
  StockAdjustment,
} from './catalogue.dto.js';

export interface Product {
  id: string;
  partNo: string;
  name: string;
  nameTH: string;
  category: string;
  brand: string;
  /** Money is a string on the wire (02_API_SCREENS.md §1.1). */
  price: string;
  cost: string;
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
  price: string;
  cost: string;
  stock: number;
  min_stock: number;
  compat: string | null;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ListQuery {
  search?: string;
  partNo?: string;
  category?: string;
  updatedSince?: string;
  page: number;
  limit: number;
}

/** What `POST /products/:id/adjust-stock` answers. */
export interface StockAdjustmentResult {
  /** The stock after the clamp — top level because that is where the client reads it. */
  stockAfter: number;
  product: Product;
  movement: MovementOut;
}

const COLUMNS = `id, part_no, name, name_th, category, brand, price, cost, stock,
                 min_stock, compat, updated_at, deleted_at`;

/**
 * Exactly the expression `idx_products_search` is built on (migration
 * `1788652800000`). The planner only uses a GIN expression index for a predicate on
 * the identical expression, so this string must not be "tidied".
 */
export const SEARCH_EXPRESSION = `lower(part_no || ' ' || name || ' ' || name_th || ' ' || COALESCE(compat, ''))`;

const INT4_MAX = 2_147_483_647;

const PRODUCTS_CACHE_TTL_SEC = 60;

@Injectable()
export class ProductsService {
  constructor(
    @Inject(REDIS_CACHE) private readonly redis: Redis,
    private readonly audit: AuditService,
  ) {}

  private cacheKey(tenantId: string, query: ListQuery): string {
    // Every filter is part of the key: a `?partNo=` lookup sharing a key with the
    // unfiltered page would answer a barcode scan with the whole first page.
    const part = (tag: string, value: string | undefined) =>
      value ? `${tag}:${encodeURIComponent(value)}:` : '';
    return (
      `t:${tenantId}:products:list:` +
      part('s', query.search) +
      part('n', query.partNo) +
      part('c', query.category) +
      part('u', query.updatedSince) +
      `${query.page}:${query.limit}`
    );
  }

  async list(
    query: ListQuery,
  ): Promise<{ items: Product[]; total: number; fromCache: boolean }> {
    const { tenantId, manager } = currentRequestContext();
    const key = this.cacheKey(tenantId, query);

    try {
      const cached = await this.redis.get(key);
      if (cached) {
        const parsed = JSON.parse(cached) as {
          items: Product[];
          total: number;
        };
        return { items: parsed.items, total: parsed.total, fromCache: true };
      }
    } catch {
      // Redis fail-open: if cache fails, proceed to database
    }

    const params: unknown[] = [tenantId];
    // `updatedSince` is the sync read (01_DATABASE.md §10): it must see tombstones,
    // or a product deleted on one device lives forever in every other device's cache.
    const where = [
      'tenant_id = $1::uuid',
      query.updatedSince ? 'TRUE' : 'deleted_at IS NULL',
    ];

    if (query.search) {
      params.push(`%${escapeLike(query.search)}%`);
      const p = `$${params.length}`;
      // The first test is the trigram index's own expression, so Postgres can answer
      // it from `idx_products_search` — Thai substring, "เบรก" inside "ผ้าเบรกหน้า".
      // The second keeps today's matching exact: the screens search name, nameTH and
      // partNo only (`products_screen.dart`), and the indexed expression also holds
      // `compat` and the spaces joining the fields.
      where.push(
        `${SEARCH_EXPRESSION} LIKE lower(${p}) ESCAPE '\\'`,
        `(part_no ILIKE ${p} ESCAPE '\\' OR name ILIKE ${p} ESCAPE '\\' OR name_th ILIKE ${p} ESCAPE '\\')`,
      );
    }

    if (query.partNo) {
      // A barcode scan: exact, never ranked (02_API_SCREENS.md §3.1).
      params.push(query.partNo);
      where.push(`part_no = $${params.length}`);
    }

    if (query.category) {
      params.push(query.category);
      where.push(`category = $${params.length}`);
    }

    if (query.updatedSince) {
      params.push(query.updatedSince);
      where.push(`updated_at > $${params.length}::timestamptz`);
    }

    // A sync reader pages forward by `updatedAt`, so it gets the oldest change first:
    // the last row of a page is then a cursor that skips nothing still unread.
    const order = query.updatedSince ? 'updated_at ASC, id ASC' : 'id ASC';

    const clause = where.join(' AND ');
    const totals = (await manager.query(
      `SELECT count(*)::int AS n FROM products WHERE ${clause}`,
      params,
    )) as { n: number }[];

    params.push(query.limit, (query.page - 1) * query.limit);
    const rows = (await manager.query(
      `SELECT ${COLUMNS} FROM products
        WHERE ${clause}
        ORDER BY ${order}
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

    if (!rows || rows.length === 0) throw productNotFound();

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

  /** `db.js addProduct`: a fresh `p` id, and no second live product with this part number. */
  async create(input: ProductCreate): Promise<Product> {
    const { tenantId, manager } = currentRequestContext();
    await this.assertPartNoFree(input.partNo, null);
    const rows = (await manager.query(
      `INSERT INTO products (tenant_id, id, part_no, name, name_th, category, brand,
                             price, cost, stock, min_stock, compat, updated_at)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, clock_timestamp())
         RETURNING ${COLUMNS}`,
      [
        tenantId,
        newId('p'),
        input.partNo,
        input.name,
        input.nameTH,
        input.category,
        input.brand,
        input.price,
        input.cost,
        input.stock,
        input.minStock,
        input.compat,
      ],
    )) as ProductRow[];
    this.invalidateAfterCommit(tenantId);
    return toProduct(rows[0]);
  }

  /** `db.js updateProduct`: refused when the new part number belongs to ANOTHER product. */
  async update(id: string, patch: ProductPatch): Promise<Product> {
    const { tenantId, manager } = currentRequestContext();
    if (patch.partNo !== undefined)
      await this.assertPartNoFree(patch.partNo, id);

    const columns: Record<keyof ProductPatch, string> = {
      partNo: 'part_no',
      name: 'name',
      nameTH: 'name_th',
      category: 'category',
      brand: 'brand',
      price: 'price',
      cost: 'cost',
      minStock: 'min_stock',
      compat: 'compat',
    };
    const values: unknown[] = [tenantId, id];
    const sets: string[] = [];
    for (const [field, value] of Object.entries(patch)) {
      values.push(value);
      sets.push(`${columns[field as keyof ProductPatch]} = $${values.length}`);
    }
    sets.push('updated_at = clock_timestamp()');

    const rows = returning<ProductRow>(
      await manager.query(
        `UPDATE products SET ${sets.join(', ')}
          WHERE tenant_id = $1::uuid AND id = $2 AND deleted_at IS NULL
      RETURNING ${COLUMNS}`,
        values,
      ),
    );
    if (rows.length === 0) throw productNotFound();
    this.invalidateAfterCommit(tenantId);
    return toProduct(rows[0]);
  }

  /**
   * Soft delete (01_DATABASE.md §10): `sale_items` and `movements` reference the row
   * through composite foreign keys, so a hard `DELETE` fails for any product that was
   * ever sold. `200` for an id that is absent or already deleted, as the hard delete
   * the client was written against answered.
   */
  async delete(id: string): Promise<{ id: string; deleted: true }> {
    const { tenantId, manager } = currentRequestContext();
    await manager.query(
      `UPDATE products
          SET deleted_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE tenant_id = $1::uuid AND id = $2 AND deleted_at IS NULL`,
      [tenantId, id],
    );
    this.invalidateAfterCommit(tenantId);
    return { id, deleted: true };
  }

  /**
   * `db.js adjustStock`: a manual correction CLAMPS at zero — deliberately unlike a
   * sale, which refuses (01_DATABASE.md §7.6) — and writes one `movements` row.
   *
   * The row's `delta` is the delta that was asked for and `stock_after` the clamped
   * result, exactly as the Dart repository writes them (its test pins `delta -10`
   * beside `stockAfter 0`), so a clamped row is visible in the ledger as one whose
   * delta and stock do not add up.
   *
   * Locks the one product row and nothing else, so it cannot take part in the sale
   * path's lock order (sale → mechanic → products → doc_counters → customer).
   */
  async adjustStock(
    id: string,
    input: StockAdjustment,
    actor: { userId: string; deviceId?: string },
  ): Promise<StockAdjustmentResult> {
    const { tenantId, manager } = currentRequestContext();
    const locked = (await manager.query(
      `SELECT stock FROM products
        WHERE tenant_id = $1::uuid AND id = $2 AND deleted_at IS NULL
          FOR UPDATE`,
      [tenantId, id],
    )) as { stock: number }[];
    if (locked.length === 0) throw productNotFound();

    const before = locked[0].stock;
    const requested = before + input.delta;
    // The clamp covers the floor only. Past the top of `INT` there is nothing sane
    // to clamp to, and letting Postgres raise `22003` would be a 500.
    if (requested > INT4_MAX) {
      throw new BadRequestException(`delta would take stock past ${INT4_MAX}`);
    }
    const stockAfter = Math.max(0, requested);

    const rows = returning<ProductRow>(
      await manager.query(
        `UPDATE products SET stock = $3, updated_at = clock_timestamp()
          WHERE tenant_id = $1::uuid AND id = $2
      RETURNING ${COLUMNS}`,
        [tenantId, id, stockAfter],
      ),
    );
    const product = toProduct(rows[0]);

    const movement = (await manager.query(
      `INSERT INTO movements (tenant_id, id, product_id, part_no, name, delta, type, note, stock_after)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${MOVEMENT_COLUMNS}`,
      [
        tenantId,
        newId('mv'),
        id,
        product.partNo,
        product.name,
        input.delta,
        input.type,
        input.note,
        stockAfter,
      ],
    )) as MovementRow[];

    // #43: `stock.adjust` is this ticket's audit action — who changed the count on a
    // shared counter PC, in the same transaction as the change.
    await this.audit.log(manager, {
      tenantId,
      userId: actor.userId,
      deviceId: actor.deviceId,
      action: 'stock.adjust',
      entity: 'product',
      entityId: id,
      before: { stock: before },
      after: {
        stock: stockAfter,
        delta: input.delta,
        type: input.type,
        note: input.note,
        movementId: movement[0].id,
      },
    });

    this.invalidateAfterCommit(tenantId);
    return { stockAfter, product, movement: movementOut(movement[0]) };
  }

  /**
   * `db.js` compares part numbers case-insensitively; `uq_products_partno` does not.
   * The advisory lock on the lower-cased number serialises two requests racing for
   * the same one, which the unique index alone would let through as `BP-1` and `bp-1`.
   */
  private async assertPartNoFree(
    partNo: string,
    exceptId: string | null,
  ): Promise<void> {
    const { tenantId, manager } = currentRequestContext();
    await manager.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${tenantId}:products:part_no:${partNo.toLowerCase()}`],
    );
    const clash = (await manager.query(
      `SELECT 1 FROM products
        WHERE tenant_id = $1::uuid AND lower(part_no) = lower($2)
          AND deleted_at IS NULL AND ($3::text IS NULL OR id <> $3)
        LIMIT 1`,
      [tenantId, partNo, exceptId],
    )) as unknown[];
    if (clash.length > 0) {
      throw new HttpException(
        { code: 'DUPLICATE_PART_NO', message: 'รหัสอะไหล่นี้มีอยู่แล้ว' },
        HttpStatus.CONFLICT,
      );
    }
  }

  /** 02_API_SCREENS.md §5: invalidate only after COMMIT, or a rollback leaves stale cache. */
  private invalidateAfterCommit(tenantId: string): void {
    onTransactionCommit(() => this.invalidateCache(tenantId));
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

export function productNotFound(): HttpException {
  return new HttpException(
    { code: 'PRODUCT_NOT_FOUND', message: 'Product not found' },
    HttpStatus.NOT_FOUND,
  );
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    partNo: row.part_no,
    name: row.name,
    nameTH: row.name_th,
    category: row.category,
    brand: row.brand,
    price: fromSatang(satangOf(String(row.price))),
    cost: fromSatang(satangOf(String(row.cost))),
    stock: row.stock,
    minStock: row.min_stock,
    compat: row.compat,
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
