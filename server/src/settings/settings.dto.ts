import { BadRequestException } from '@nestjs/common';

export interface SettingsPatch {
  shopName?: string;
  shopNameEn?: string;
  taxRate?: number;
  quoteValidDays?: number;
  address?: string | null;
  phone?: string | null;
  cashierName?: string | null;
  taxId?: string | null;
  branchNo?: string | null;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function present(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string or null`);
  }
  return value.trim();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${field} is required and cannot be empty`);
  }
  return value.trim();
}

function optionalNumber(value: unknown, field: string, min = 0, max = 100): number | undefined {
  if (value === null || value === undefined) return undefined;
  const num = Number(value);
  if (Number.isNaN(num) || num < min || num > max) {
    throw new BadRequestException(`${field} must be a valid number between ${min} and ${max}`);
  }
  return num;
}

function optionalInt(value: unknown, field: string, min = 1): number | undefined {
  if (value === null || value === undefined) return undefined;
  const num = Number(value);
  if (!Number.isInteger(num) || num < min) {
    throw new BadRequestException(`${field} must be an integer >= ${min}`);
  }
  return num;
}

function compact<T extends object>(obj: T): T {
  const result = { ...obj };
  for (const key of Object.keys(result) as Array<keyof T>) {
    if (result[key] === undefined) {
      delete result[key];
    }
  }
  return result;
}

export function parseSettingsPatch(body: unknown): SettingsPatch {
  const val = asObject(body);
  const shopNameVal = present(val, 'shopName') ? val.shopName : val.shop_name;
  const shopNameEnVal = present(val, 'shopNameEn')
    ? val.shopNameEn
    : (present(val, 'shopNameEN') ? val.shopNameEN : val.shop_name_en);
  const taxRateVal = present(val, 'taxRate') ? val.taxRate : val.tax_rate;
  const quoteValidDaysVal = present(val, 'quoteValidDays')
    ? val.quoteValidDays
    : val.quote_valid_days;
  const cashierNameVal = present(val, 'cashierName')
    ? val.cashierName
    : val.cashier_name;
  const taxIdVal = present(val, 'taxId') ? val.taxId : val.tax_id;
  const branchNoVal = present(val, 'branchNo') ? val.branchNo : val.branch_no;

  return compact({
    shopName: shopNameVal !== undefined ? requiredString(shopNameVal, 'shopName') : undefined,
    shopNameEn: shopNameEnVal !== undefined ? requiredString(shopNameEnVal, 'shopNameEn') : undefined,
    taxRate: taxRateVal !== undefined ? optionalNumber(taxRateVal, 'taxRate', 0, 100) : undefined,
    quoteValidDays: quoteValidDaysVal !== undefined ? optionalInt(quoteValidDaysVal, 'quoteValidDays', 1) : undefined,
    address: present(val, 'address') ? optionalString(val.address, 'address') : undefined,
    phone: present(val, 'phone') ? optionalString(val.phone, 'phone') : undefined,
    cashierName: cashierNameVal !== undefined ? optionalString(cashierNameVal, 'cashierName') : undefined,
    taxId: taxIdVal !== undefined ? optionalString(taxIdVal, 'taxId') : undefined,
    branchNo: branchNoVal !== undefined ? optionalString(branchNoVal, 'branchNo') : undefined,
  });
}
