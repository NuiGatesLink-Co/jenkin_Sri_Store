import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { currentRequestContext } from '../common/request-context.js';
import { SettingsService, type ShopSettings } from '../settings/settings.service.js';

export interface BootstrapProduct {
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
  offlineOk: boolean;
  updatedAt: string;
  deletedAt: string | null;
}

export interface BootstrapCategory {
  name: string;
  position: number;
  color: string;
}

export interface BootstrapCustomer {
  id: string;
  code: string;
  name: string;
  nameTH: string;
  phone: string | null;
  address: string | null;
  points: number;
  totalSpend: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface BootstrapMechanic {
  id: string;
  code: string;
  name: string;
  nameTH: string | null;
  nickname: string | null;
  shopName: string | null;
  phone: string | null;
  note: string | null;
  creditLimit: number;
  creditBalance: number;
  totalSales: number;
  totalDiscount: number;
  totalMarkup: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface BootstrapPayload {
  products: BootstrapProduct[];
  categories: BootstrapCategory[];
  customers: BootstrapCustomer[];
  mechanics: BootstrapMechanic[];
  settings: ShopSettings;
}

const CATEGORY_PALETTE = ['#1E4A80', '#C04E10', '#3B6D11', '#6B2DA8', '#1A6B5C'];

export function computeEtag(payload: unknown): string {
  const json = JSON.stringify(payload);
  const hash = createHash('md5').update(json).digest('hex');
  return `"${hash}"`;
}

@Injectable()
export class BootstrapService {
  constructor(private readonly settingsService: SettingsService) {}

  async getBootstrapPayload(): Promise<{ payload: BootstrapPayload; etag: string }> {
    const { tenantId, manager } = currentRequestContext();

    const [productsRows, categoriesRows, customersRows, mechanicsRows, settings] =
      await Promise.all([
        manager.query<Array<Record<string, unknown>>>(
          `SELECT id, part_no, name, name_th, category, brand, price, cost, stock, min_stock, compat, offline_ok, updated_at
             FROM products
            WHERE tenant_id = $1::uuid AND deleted_at IS NULL
            ORDER BY name`,
          [tenantId],
        ),
        manager.query<Array<{ name: string; position: number }>>(
          `SELECT name, position
             FROM categories
            WHERE tenant_id = $1::uuid
            ORDER BY position, name`,
          [tenantId],
        ),
        manager.query<Array<Record<string, unknown>>>(
          `SELECT id, code, name, name_th, phone, address, points, total_spend, created_at, updated_at
             FROM customers
            WHERE tenant_id = $1::uuid AND deleted_at IS NULL
            ORDER BY code`,
          [tenantId],
        ),
        manager.query<Array<Record<string, unknown>>>(
          `SELECT id, code, name, name_th, nickname, shop_name, phone, note, credit_limit, credit_balance, total_sales, total_discount, total_markup, created_at, updated_at
             FROM mechanics
            WHERE tenant_id = $1::uuid AND deleted_at IS NULL
            ORDER BY code`,
          [tenantId],
        ),
        this.settingsService.getSettings(),
      ]);

    const products: BootstrapProduct[] = productsRows.map((row) => ({
      id: String(row.id),
      partNo: String(row.part_no ?? ''),
      name: String(row.name ?? ''),
      nameTH: String(row.name_th ?? ''),
      category: String(row.category ?? ''),
      brand: String(row.brand ?? ''),
      price: typeof row.price === 'number' ? row.price : parseFloat(String(row.price ?? 0)),
      cost: typeof row.cost === 'number' ? row.cost : parseFloat(String(row.cost ?? 0)),
      stock: Number(row.stock ?? 0),
      minStock: Number(row.min_stock ?? 0),
      compat: row.compat ? String(row.compat) : null,
      offlineOk: Boolean(row.offline_ok),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      deletedAt: null,
    }));

    const categories: BootstrapCategory[] = categoriesRows.map((cat, idx) => ({
      name: cat.name,
      position: cat.position,
      color: CATEGORY_PALETTE[cat.position % CATEGORY_PALETTE.length] || CATEGORY_PALETTE[idx % CATEGORY_PALETTE.length],
    }));

    const customers: BootstrapCustomer[] = customersRows.map((row) => ({
      id: String(row.id),
      code: String(row.code ?? ''),
      name: String(row.name ?? ''),
      nameTH: String(row.name_th ?? ''),
      phone: row.phone ? String(row.phone) : null,
      address: row.address ? String(row.address) : null,
      points: Number(row.points ?? 0),
      totalSpend: typeof row.total_spend === 'number' ? row.total_spend : parseFloat(String(row.total_spend ?? 0)),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      deletedAt: null,
    }));

    const mechanics: BootstrapMechanic[] = mechanicsRows.map((row) => ({
      id: String(row.id),
      code: String(row.code ?? ''),
      name: String(row.name ?? ''),
      nameTH: row.name_th ? String(row.name_th) : null,
      nickname: row.nickname ? String(row.nickname) : null,
      shopName: row.shop_name ? String(row.shop_name) : null,
      phone: row.phone ? String(row.phone) : null,
      note: row.note ? String(row.note) : null,
      creditLimit: typeof row.credit_limit === 'number' ? row.credit_limit : parseFloat(String(row.credit_limit ?? 0)),
      creditBalance: typeof row.credit_balance === 'number' ? row.credit_balance : parseFloat(String(row.credit_balance ?? 0)),
      totalSales: typeof row.total_sales === 'number' ? row.total_sales : parseFloat(String(row.total_sales ?? 0)),
      totalDiscount: typeof row.total_discount === 'number' ? row.total_discount : parseFloat(String(row.total_discount ?? 0)),
      totalMarkup: typeof row.total_markup === 'number' ? row.total_markup : parseFloat(String(row.total_markup ?? 0)),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      deletedAt: null,
    }));

    const payload: BootstrapPayload = {
      products,
      categories,
      customers,
      mechanics,
      settings,
    };

    const etag = computeEtag(payload);
    return { payload, etag };
  }
}
