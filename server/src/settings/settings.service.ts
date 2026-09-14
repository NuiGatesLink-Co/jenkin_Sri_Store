import { Injectable } from '@nestjs/common';
import { currentRequestContext } from '../common/request-context.js';
import type { SettingsPatch } from './settings.dto.js';

export interface ShopSettings {
  shopName: string;
  shopNameEn: string;
  taxRate: number;
  quoteValidDays: number;
  address: string | null;
  phone: string | null;
  cashierName: string | null;
  taxId: string | null;
  branchNo: string | null;
  updatedAt: string;
}

export interface SettingsRow {
  tenant_id: string;
  shop_name: string;
  shop_name_en: string;
  tax_rate: string | number;
  quote_valid_days: number;
  address: string | null;
  phone: string | null;
  cashier_name: string | null;
  tax_id: string | null;
  branch_no: string | null;
  updated_at: Date | string;
}

export function toShopSettings(row: SettingsRow): ShopSettings {
  return {
    shopName: row.shop_name,
    shopNameEn: row.shop_name_en,
    taxRate: typeof row.tax_rate === 'number' ? row.tax_rate : parseFloat(row.tax_rate),
    quoteValidDays: row.quote_valid_days,
    address: row.address,
    phone: row.phone,
    cashierName: row.cashier_name,
    taxId: row.tax_id,
    branchNo: row.branch_no,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export const DEFAULT_SETTINGS: ShopSettings = {
  shopName: 'ร้านศรีสุราษฎร์การช่าง',
  shopNameEn: 'Srisurart Autopart',
  taxRate: 7,
  quoteValidDays: 30,
  address: null,
  phone: null,
  cashierName: null,
  taxId: null,
  branchNo: null,
  updatedAt: new Date(0).toISOString(),
};

@Injectable()
export class SettingsService {
  async getSettings(): Promise<ShopSettings> {
    const { tenantId, manager } = currentRequestContext();
    const rows = await manager.query<SettingsRow[]>(
      `SELECT tenant_id, shop_name, shop_name_en, tax_rate, quote_valid_days,
              address, phone, cashier_name, tax_id, branch_no, updated_at
         FROM settings
        WHERE tenant_id = $1::uuid`,
      [tenantId],
    );

    if (rows.length === 0) {
      return DEFAULT_SETTINGS;
    }
    return toShopSettings(rows[0]);
  }

  async updateSettings(patch: SettingsPatch): Promise<ShopSettings> {
    const { tenantId, manager } = currentRequestContext();
    const current = await this.getSettings();

    const updated = {
      shopName: patch.shopName ?? current.shopName,
      shopNameEn: patch.shopNameEn ?? current.shopNameEn,
      taxRate: patch.taxRate ?? current.taxRate,
      quoteValidDays: patch.quoteValidDays ?? current.quoteValidDays,
      address: patch.address !== undefined ? patch.address : current.address,
      phone: patch.phone !== undefined ? patch.phone : current.phone,
      cashierName: patch.cashierName !== undefined ? patch.cashierName : current.cashierName,
      taxId: patch.taxId !== undefined ? patch.taxId : current.taxId,
      branchNo: patch.branchNo !== undefined ? patch.branchNo : current.branchNo,
    };

    const rows = await manager.query<SettingsRow[]>(
      `INSERT INTO settings (
         tenant_id, shop_name, shop_name_en, tax_rate, quote_valid_days,
         address, phone, cashier_name, tax_id, branch_no, updated_at
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         shop_name = EXCLUDED.shop_name,
         shop_name_en = EXCLUDED.shop_name_en,
         tax_rate = EXCLUDED.tax_rate,
         quote_valid_days = EXCLUDED.quote_valid_days,
         address = EXCLUDED.address,
         phone = EXCLUDED.phone,
         cashier_name = EXCLUDED.cashier_name,
         tax_id = EXCLUDED.tax_id,
         branch_no = EXCLUDED.branch_no,
         updated_at = NOW()
       RETURNING tenant_id, shop_name, shop_name_en, tax_rate, quote_valid_days,
                 address, phone, cashier_name, tax_id, branch_no, updated_at`,
      [
        tenantId,
        updated.shopName,
        updated.shopNameEn,
        updated.taxRate,
        updated.quoteValidDays,
        updated.address,
        updated.phone,
        updated.cashierName,
        updated.taxId,
        updated.branchNo,
      ],
    );

    return toShopSettings(rows[0]);
  }
}
