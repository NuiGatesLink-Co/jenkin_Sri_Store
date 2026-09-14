import { BadRequestException } from '@nestjs/common';
import { toSatang } from '../common/money.js';

export interface CreatePOItem {
  lineNo: number;
  partNo: string;
  name: string;
  qty: number;
  costSatang: number;
  cost: string;
}

export interface CreatePOBody {
  id?: string;
  supplier: string;
  items: CreatePOItem[];
}

export interface POItemOut {
  lineNo: number;
  partNo: string;
  name: string;
  qty: number;
  cost: string;
}

export interface PurchaseOrderOut {
  id: string;
  poNo: string;
  supplier: string;
  status: 'open' | 'received' | 'cancelled';
  createdAt: string;
  receivedAt: string | null;
  cancelledAt: string | null;
  items: POItemOut[];
}

export interface UpdatedProductItem {
  productId: string;
  partNo: string;
  stockAfter: number;
  costAfter: string;
}

export interface MovementOut {
  id: string;
  productId: string;
  partNo: string;
  name: string;
  delta: number;
  type: string;
  note: string | null;
  stockAfter: number;
  date: string;
}

export interface ReceivePOResult {
  poId: string;
  status: string;
  receivedAt: string;
  updated: UpdatedProductItem[];
  unmatched: string[];
  movements: MovementOut[];
}

const MAX_LINES = 200;

function asObject(val: unknown, name: string): Record<string, unknown> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) {
    throw new BadRequestException(`${name} must be an object`);
  }
  return val as Record<string, unknown>;
}

export function parseCreatePO(body: unknown): CreatePOBody {
  const b = asObject(body, 'body');

  const supplier = typeof b.supplier === 'string' ? b.supplier.trim() : '';
  if (!supplier) {
    throw new BadRequestException('supplier must not be empty');
  }

  const itemsArr = Array.isArray(b.items) ? b.items : [];
  if (itemsArr.length === 0) {
    throw new BadRequestException('items must not be empty');
  }
  if (itemsArr.length > MAX_LINES) {
    throw new BadRequestException(`items must not exceed ${MAX_LINES} lines`);
  }

  const id = typeof b.id === 'string' && b.id.trim() ? b.id.trim() : undefined;

  const items: CreatePOItem[] = itemsArr.map((raw, idx) => {
    const obj = asObject(raw, `items[${idx}]`);
    const partNo = typeof obj.partNo === 'string' ? obj.partNo.trim() : '';
    if (!partNo) {
      throw new BadRequestException(`items[${idx}].partNo must not be empty`);
    }

    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name) {
      throw new BadRequestException(`items[${idx}].name must not be empty`);
    }

    const qty = typeof obj.qty === 'number' ? obj.qty : parseInt(String(obj.qty), 10);
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new BadRequestException(`items[${idx}].qty must be a positive integer`);
    }

    const costVal = obj.cost ?? '0.00';
    const costSatang = toSatang(costVal, `items[${idx}].cost`);
    if (costSatang < 0) {
      throw new BadRequestException(`items[${idx}].cost must be non-negative`);
    }

    const lineNo = typeof obj.lineNo === 'number' && obj.lineNo > 0 ? obj.lineNo : idx + 1;

    return {
      lineNo,
      partNo,
      name,
      qty,
      costSatang,
      cost: (costSatang / 100).toFixed(2),
    };
  });

  return { id, supplier, items };
}
