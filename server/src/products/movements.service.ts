import { Injectable } from '@nestjs/common';
import { currentRequestContext } from '../common/request-context.js';
import {
  MOVEMENT_COLUMNS,
  movementOut,
  type MovementOut,
  type MovementRow,
} from '../sales/sales.service.js';

/**
 * `GET /movements?productId=&from=&to=` (02_API_SCREENS.md §3.2) — the stock ledger,
 * newest first as `movements_repository.dart` returns it. A deleted product's history
 * stays readable: the ledger is never deleted (01_DATABASE.md §10).
 */
@Injectable()
export class MovementsService {
  async list(query: {
    productId?: string;
    from?: string;
    to?: string;
    page: number;
    limit: number;
  }): Promise<{ items: MovementOut[]; total: number }> {
    const { tenantId, manager } = currentRequestContext();
    const params: unknown[] = [tenantId];
    const where = ['tenant_id = $1::uuid'];
    if (query.productId) {
      params.push(query.productId);
      where.push(`product_id = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      where.push(`date >= $${params.length}::timestamptz`);
    }
    if (query.to) {
      params.push(query.to);
      where.push(`date <= $${params.length}::timestamptz`);
    }
    const clause = where.join(' AND ');
    const totals = (await manager.query(
      `SELECT count(*)::int AS n FROM movements WHERE ${clause}`,
      params,
    )) as { n: number }[];
    params.push(query.limit, (query.page - 1) * query.limit);
    const rows = (await manager.query(
      `SELECT ${MOVEMENT_COLUMNS} FROM movements
        WHERE ${clause}
        ORDER BY date DESC, id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )) as MovementRow[];
    return { items: rows.map(movementOut), total: totals[0].n };
  }
}
