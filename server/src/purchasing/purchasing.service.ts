import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { newId } from '../common/ids.js';
import { fromSatang, satangOf, toSatang } from '../common/money.js';
import { currentRequestContext } from '../common/request-context.js';
import { TenantService } from '../common/database/tenant.service.js';
import { DocNumberService } from '../documents/doc-number.service.js';
import { TenantCache } from '../infra/tenant-cache.service.js';
import { ProductsService } from '../products/products.service.js';
import {
  parseCreatePO,
  MovementOut,
  POItemOut,
  PurchaseOrderOut,
  ReceivePOResult,
  UpdatedProductItem,
} from './purchasing.dto.js';

interface PORow {
  id: string;
  po_no: string;
  supplier: string;
  status: 'open' | 'received' | 'cancelled';
  created_at: Date;
  received_at: Date | null;
  cancelled_at: Date | null;
}

interface POItemRow {
  po_id: string;
  line_no: number;
  part_no: string;
  name: string;
  qty: number;
  cost: string | number;
}

interface ProductRow {
  id: string;
  part_no: string;
  name: string;
  name_th: string;
  cost: string | number;
  stock: number;
}

const MAX_STOCK_INT = 2147483647;

@Injectable()
export class PurchasingService {
  constructor(
    private readonly docNumberService: DocNumberService,
    private readonly audit: AuditService,
    private readonly productsService: ProductsService,
    private readonly cache: TenantCache,
    private readonly tenants: TenantService,
  ) {}

  create(
    bodyRaw: unknown,
    actor: { userId: string; deviceId: string },
  ): Promise<PurchaseOrderOut> {
    return this.tenants.runTx(() => this.createIn(bodyRaw, actor));
  }

  private async createIn(
    bodyRaw: unknown,
    actor: { userId: string; deviceId: string },
  ): Promise<PurchaseOrderOut> {
    const { tenantId, manager } = currentRequestContext();
    const body = parseCreatePO(bodyRaw);

    const poNo = await this.docNumberService.issue(manager, {
      tenantId,
      deviceId: actor.deviceId,
      docType: 'po',
    });

    const id = body.id || newId('po');

    const poRows = (await manager.query(
      `INSERT INTO purchase_orders (tenant_id, id, po_no, supplier, status, created_at)
       VALUES ($1::uuid, $2, $3, $4, 'open', now())
       RETURNING id, po_no, supplier, status, created_at, received_at, cancelled_at`,
      [tenantId, id, poNo, body.supplier],
    )) as PORow[];

    const po = poRows[0];

    const itemOuts: POItemOut[] = [];
    for (const item of body.items) {
      const costStr = (item.costSatang / 100).toFixed(2);
      await manager.query(
        `INSERT INTO po_items (tenant_id, po_id, line_no, part_no, name, qty, cost)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::numeric)`,
        [tenantId, id, item.lineNo, item.partNo, item.name, item.qty, costStr],
      );

      itemOuts.push({
        lineNo: item.lineNo,
        partNo: item.partNo,
        name: item.name,
        qty: item.qty,
        cost: costStr,
      });
    }

    await this.audit.log(manager, {
      tenantId,
      userId: actor.userId,
      deviceId: actor.deviceId,
      action: 'po.create',
      entity: 'purchase_orders',
      entityId: id,
      after: { id, poNo, supplier: body.supplier, status: 'open' },
    });

    return {
      id: po.id,
      poNo: po.po_no,
      supplier: po.supplier,
      status: po.status,
      createdAt: po.created_at.toISOString(),
      receivedAt: po.received_at ? po.received_at.toISOString() : null,
      cancelledAt: po.cancelled_at ? po.cancelled_at.toISOString() : null,
      items: itemOuts,
    };
  }

  list(
    status?: string,
    page = 1,
    limit = 50,
  ): Promise<{ items: PurchaseOrderOut[]; total: number }> {
    return this.tenants.runTx(() => this.listIn(status, page, limit));
  }

  private async listIn(
    status: string | undefined,
    page: number,
    limit: number,
  ): Promise<{ items: PurchaseOrderOut[]; total: number }> {
    const { tenantId, manager } = currentRequestContext();

    const where = ['tenant_id = $1::uuid'];
    const params: unknown[] = [tenantId];

    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    const whereClause = where.join(' AND ');

    const countRows = (await manager.query(
      `SELECT count(*)::int AS n FROM purchase_orders WHERE ${whereClause}`,
      params,
    )) as { n: number }[];

    const total = countRows[0]?.n ?? 0;

    params.push(limit, (page - 1) * limit);
    const poRows = (await manager.query(
      `SELECT id, po_no, supplier, status, created_at, received_at, cancelled_at
         FROM purchase_orders
        WHERE ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    )) as PORow[];

    if (poRows.length === 0) {
      return { items: [], total };
    }

    const poIds = poRows.map((r) => r.id);
    const itemRows = (await manager.query(
      `SELECT po_id, line_no, part_no, name, qty, cost
         FROM po_items
        WHERE tenant_id = $1::uuid AND po_id = ANY($2::text[])
        ORDER BY po_id, line_no ASC`,
      [tenantId, poIds],
    )) as POItemRow[];

    const itemsByPo = new Map<string, POItemOut[]>();
    for (const item of itemRows) {
      const list = itemsByPo.get(item.po_id) || [];
      const costStr =
        typeof item.cost === 'number'
          ? item.cost.toFixed(2)
          : parseFloat(String(item.cost)).toFixed(2);
      list.push({
        lineNo: item.line_no,
        partNo: item.part_no,
        name: item.name,
        qty: item.qty,
        cost: costStr,
      });
      itemsByPo.set(item.po_id, list);
    }

    const items: PurchaseOrderOut[] = poRows.map((po) => ({
      id: po.id,
      poNo: po.po_no,
      supplier: po.supplier,
      status: po.status,
      createdAt: po.created_at.toISOString(),
      receivedAt: po.received_at ? po.received_at.toISOString() : null,
      cancelledAt: po.cancelled_at ? po.cancelled_at.toISOString() : null,
      items: itemsByPo.get(po.id) || [],
    }));

    return { items, total };
  }

  byId(id: string): Promise<PurchaseOrderOut> {
    return this.tenants.runTx(() => this.byIdIn(id));
  }

  private async byIdIn(id: string): Promise<PurchaseOrderOut> {
    const { tenantId, manager } = currentRequestContext();

    const poRows = (await manager.query(
      `SELECT id, po_no, supplier, status, created_at, received_at, cancelled_at
         FROM purchase_orders
        WHERE tenant_id = $1::uuid AND id = $2`,
      [tenantId, id],
    )) as PORow[];

    if (!poRows || poRows.length === 0) {
      throw new HttpException(
        { code: 'PO_NOT_FOUND', message: `Purchase order ${id} not found` },
        HttpStatus.NOT_FOUND,
      );
    }

    const po = poRows[0];

    const itemRows = (await manager.query(
      `SELECT line_no, part_no, name, qty, cost
         FROM po_items
        WHERE tenant_id = $1::uuid AND po_id = $2
        ORDER BY line_no ASC`,
      [tenantId, id],
    )) as POItemRow[];

    const items: POItemOut[] = itemRows.map((item) => {
      const costStr =
        typeof item.cost === 'number'
          ? item.cost.toFixed(2)
          : parseFloat(String(item.cost)).toFixed(2);
      return {
        lineNo: item.line_no,
        partNo: item.part_no,
        name: item.name,
        qty: item.qty,
        cost: costStr,
      };
    });

    return {
      id: po.id,
      poNo: po.po_no,
      supplier: po.supplier,
      status: po.status,
      createdAt: po.created_at.toISOString(),
      receivedAt: po.received_at ? po.received_at.toISOString() : null,
      cancelledAt: po.cancelled_at ? po.cancelled_at.toISOString() : null,
      items,
    };
  }

  cancel(
    id: string,
    actor: { userId: string; deviceId: string },
  ): Promise<PurchaseOrderOut> {
    return this.tenants.runTx(() => this.cancelIn(id, actor));
  }

  private async cancelIn(
    id: string,
    actor: { userId: string; deviceId: string },
  ): Promise<PurchaseOrderOut> {
    const { tenantId, manager } = currentRequestContext();

    const poRows = (await manager.query(
      `SELECT id, po_no, supplier, status, created_at, received_at, cancelled_at
         FROM purchase_orders
        WHERE tenant_id = $1::uuid AND id = $2
        FOR UPDATE`,
      [tenantId, id],
    )) as PORow[];

    if (!poRows || poRows.length === 0) {
      throw new HttpException(
        { code: 'PO_NOT_FOUND', message: `Purchase order ${id} not found` },
        HttpStatus.NOT_FOUND,
      );
    }

    const po = poRows[0];

    if (po.status === 'received') {
      throw new HttpException(
        { code: 'PO_ALREADY_RECEIVED', message: 'Purchase order has already been received' },
        HttpStatus.CONFLICT,
      );
    }

    if (po.status === 'cancelled') {
      throw new HttpException(
        { code: 'PO_CANCELLED', message: 'Purchase order has been cancelled' },
        HttpStatus.CONFLICT,
      );
    }

    const updatedRows = (await manager.query(
      `UPDATE purchase_orders SET status = 'cancelled', cancelled_at = now()
        WHERE tenant_id = $1::uuid AND id = $2
        RETURNING id, po_no, supplier, status, created_at, received_at, cancelled_at`,
      [tenantId, id],
    )) as PORow[];

    const updatedPo = updatedRows[0];

    await this.audit.log(manager, {
      tenantId,
      userId: actor.userId,
      deviceId: actor.deviceId,
      action: 'po.cancel',
      entity: 'purchase_orders',
      entityId: id,
      after: { id, status: 'cancelled' },
    });

    const itemRows = (await manager.query(
      `SELECT line_no, part_no, name, qty, cost
         FROM po_items
        WHERE tenant_id = $1::uuid AND po_id = $2
        ORDER BY line_no ASC`,
      [tenantId, id],
    )) as POItemRow[];

    const items: POItemOut[] = itemRows.map((item) => ({
      lineNo: item.line_no,
      partNo: item.part_no,
      name: item.name,
      qty: item.qty,
      cost:
        typeof item.cost === 'number'
          ? item.cost.toFixed(2)
          : parseFloat(String(item.cost)).toFixed(2),
    }));

    return {
      id: updatedPo.id,
      poNo: updatedPo.po_no,
      supplier: updatedPo.supplier,
      status: updatedPo.status,
      createdAt: updatedPo.created_at.toISOString(),
      receivedAt: updatedPo.received_at ? updatedPo.received_at.toISOString() : null,
      cancelledAt: updatedPo.cancelled_at ? updatedPo.cancelled_at.toISOString() : null,
      items,
    };
  }

  delete(
    id: string,
    actor?: { userId: string; deviceId: string },
  ): Promise<{ id: string; deleted: boolean }> {
    return this.tenants.runTx(() => this.deleteIn(id, actor));
  }

  private async deleteIn(
    id: string,
    actor?: { userId: string; deviceId: string },
  ): Promise<{ id: string; deleted: boolean }> {
    const { tenantId, manager } = currentRequestContext();

    const poRows = (await manager.query(
      `SELECT id, status FROM purchase_orders
        WHERE tenant_id = $1::uuid AND id = $2
        FOR UPDATE`,
      [tenantId, id],
    )) as { id: string; status: string }[];

    if (!poRows || poRows.length === 0) {
      throw new HttpException(
        { code: 'PO_NOT_FOUND', message: `Purchase order ${id} not found` },
        HttpStatus.NOT_FOUND,
      );
    }

    const po = poRows[0];
    if (po.status === 'received') {
      throw new HttpException(
        { code: 'PO_ALREADY_RECEIVED', message: 'Purchase order has already been received' },
        HttpStatus.CONFLICT,
      );
    }

    await manager.query(
      `DELETE FROM po_items WHERE tenant_id = $1::uuid AND po_id = $2`,
      [tenantId, id],
    );

    await manager.query(
      `DELETE FROM purchase_orders WHERE tenant_id = $1::uuid AND id = $2`,
      [tenantId, id],
    );

    if (actor) {
      await this.audit.log(manager, {
        tenantId,
        userId: actor.userId,
        deviceId: actor.deviceId,
        action: 'po.delete',
        entity: 'purchase_orders',
        entityId: id,
      });
    }

    return { id, deleted: true };
  }

  receive(
    id: string,
    actor: { userId: string; deviceId: string },
  ): Promise<ReceivePOResult> {
    return this.tenants.runTx(() => this.receiveIn(id, actor));
  }

  private async receiveIn(
    id: string,
    actor: { userId: string; deviceId: string },
  ): Promise<ReceivePOResult> {
    const { tenantId, manager } = currentRequestContext();

    const poRows = (await manager.query(
      `SELECT id, po_no, supplier, status, created_at, received_at, cancelled_at
         FROM purchase_orders
        WHERE tenant_id = $1::uuid AND id = $2
        FOR UPDATE`,
      [tenantId, id],
    )) as PORow[];

    if (!poRows || poRows.length === 0) {
      throw new HttpException(
        { code: 'PO_NOT_FOUND', message: `Purchase order ${id} not found` },
        HttpStatus.NOT_FOUND,
      );
    }

    const po = poRows[0];

    if (po.status === 'received') {
      throw new HttpException(
        { code: 'PO_ALREADY_RECEIVED', message: 'Purchase order has already been received' },
        HttpStatus.CONFLICT,
      );
    }

    if (po.status === 'cancelled') {
      throw new HttpException(
        { code: 'PO_CANCELLED', message: 'Purchase order has been cancelled' },
        HttpStatus.CONFLICT,
      );
    }

    const poItems = (await manager.query(
      `SELECT line_no, part_no, name, qty, cost
         FROM po_items
        WHERE tenant_id = $1::uuid AND po_id = $2
        ORDER BY line_no ASC`,
      [tenantId, id],
    )) as POItemRow[];

    const unmatchedPartNosSet = new Set<string>();
    const matchedItems: { poItem: POItemRow; productId: string }[] = [];

    for (const item of poItems) {
      const liveProducts = (await manager.query(
        `SELECT id, part_no, name, cost, stock
           FROM products
          WHERE tenant_id = $1::uuid AND deleted_at IS NULL AND lower(part_no) = lower($2)`,
        [tenantId, item.part_no],
      )) as ProductRow[];

      if (liveProducts.length > 0) {
        matchedItems.push({ poItem: item, productId: liveProducts[0].id });
      } else {
        unmatchedPartNosSet.add(item.part_no);
      }
    }

    const matchedProductIds = Array.from(new Set(matchedItems.map((m) => m.productId))).sort();

    const productMap = new Map<
      string,
      {
        id: string;
        partNo: string;
        name: string;
        initialStock: number;
        currentStock: number;
        currentCostSatang: number;
        totalQtyReceived: number;
      }
    >();

    if (matchedProductIds.length > 0) {
      const lockedProducts = (await manager.query(
        `SELECT id, part_no, name, cost, stock
           FROM products
          WHERE tenant_id = $1::uuid AND id = ANY($2::text[]) AND deleted_at IS NULL
          ORDER BY id ASC
          FOR UPDATE`,
        [tenantId, matchedProductIds],
      )) as ProductRow[];

      for (const p of lockedProducts) {
        const costSatang = satangOf(typeof p.cost === 'number' ? p.cost.toFixed(2) : String(p.cost));
        productMap.set(p.id, {
          id: p.id,
          partNo: p.part_no,
          name: p.name,
          initialStock: p.stock,
          currentStock: p.stock,
          currentCostSatang: costSatang,
          totalQtyReceived: 0,
        });
      }
    }

    for (const match of matchedItems) {
      const prod = productMap.get(match.productId);
      if (!prod) continue;

      const itemCostSatang = toSatang(match.poItem.cost, 'item.cost');
      const effectiveNewCostSatang =
        itemCostSatang > 0 ? itemCostSatang : prod.currentCostSatang;

      const oldQty = prod.currentStock;
      const newQty = match.poItem.qty;
      const totalQty = oldQty + newQty;

      let newCostSatang: number;
      if (totalQty <= 0) {
        newCostSatang = effectiveNewCostSatang;
      } else {
        const rawNewCost =
          (oldQty * prod.currentCostSatang + newQty * effectiveNewCostSatang) / totalQty;
        newCostSatang = Math.round(rawNewCost);
      }

      prod.currentStock = totalQty;
      prod.currentCostSatang = newCostSatang;
      prod.totalQtyReceived += newQty;
    }

    for (const prod of productMap.values()) {
      if (prod.currentStock > MAX_STOCK_INT || prod.currentStock < 0) {
        throw new BadRequestException('Stock quantity overflow');
      }
    }

    const updatedProductsList: UpdatedProductItem[] = [];
    const movementsList: MovementOut[] = [];

    const now = new Date();
    const nowIso = now.toISOString();

    for (const productId of matchedProductIds) {
      const prod = productMap.get(productId)!;
      const costAfterStr = fromSatang(prod.currentCostSatang);

      await manager.query(
        `UPDATE products SET stock = $3, cost = $4::numeric, updated_at = now()
          WHERE tenant_id = $1::uuid AND id = $2`,
        [tenantId, prod.id, prod.currentStock, costAfterStr],
      );

      updatedProductsList.push({
        productId: prod.id,
        partNo: prod.partNo,
        stockAfter: prod.currentStock,
        costAfter: costAfterStr,
      });

      const movementId = newId('mv');
      const note = `PO ${po.po_no}`;

      await manager.query(
        `INSERT INTO movements (id, tenant_id, product_id, part_no, name, delta, type, note, stock_after, date, ref_id)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, 'receive', $7, $8, now(), $9)`,
        [
          movementId,
          tenantId,
          prod.id,
          prod.partNo,
          prod.name,
          prod.totalQtyReceived,
          note,
          prod.currentStock,
          po.id,
        ],
      );

      movementsList.push({
        id: movementId,
        productId: prod.id,
        partNo: prod.partNo,
        name: prod.name,
        delta: prod.totalQtyReceived,
        type: 'receive',
        note,
        stockAfter: prod.currentStock,
        date: nowIso,
      });
    }

    const updatedPoRows = (await manager.query(
      `UPDATE purchase_orders SET status = 'received', received_at = now()
        WHERE tenant_id = $1::uuid AND id = $2
        RETURNING id, po_no, supplier, status, created_at, received_at, cancelled_at`,
      [tenantId, id],
    )) as PORow[];

    const updatedPo = updatedPoRows[0];
    const receivedAtIso = updatedPo.received_at
      ? updatedPo.received_at.toISOString()
      : nowIso;

    await this.audit.log(manager, {
      tenantId,
      userId: actor.userId,
      deviceId: actor.deviceId,
      action: 'po.receive',
      entity: 'purchase_orders',
      entityId: po.id,
      after: { id: po.id, poNo: po.po_no, status: 'received' },
    });

    this.cache.invalidateAfterCommit(tenantId, 'products');

    return {
      poId: po.id,
      status: 'received',
      receivedAt: receivedAtIso,
      updated: updatedProductsList,
      unmatched: Array.from(unmatchedPartNosSet),
      movements: movementsList,
    };
  }
}
