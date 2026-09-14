import { BadRequestException } from '@nestjs/common';

export interface Settings {
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

export function parseSettingsPatch(body: unknown): SettingsPatch {
  const value = asObject(body);
  const patch: SettingsPatch = {};

  if (present(value, 'shopName')) {
    patch.shopName = requiredString(value.shopName, 'shopName');
  }
  if (present(value, 'shopNameEn')) {
    patch.shopNameEn = optionalString(value.shopNameEn, 'shopNameEn') ?? '';
  }
  if (present(value, 'taxRate')) {
    patch.taxRate = requiredNumber(value.taxRate, 'taxRate', 0);
  }
  if (present(value, 'quoteValidDays')) {
    patch.quoteValidDays = requiredInteger(value.quoteValidDays, 'quoteValidDays', 1);
  }
  if (present(value, 'address')) {
    patch.address = optionalString(value.address, 'address');
  }
  if (present(value, 'phone')) {
    patch.phone = optionalString(value.phone, 'phone');
  }
  if (present(value, 'cashierName')) {
    patch.cashierName = optionalString(value.cashierName, 'cashierName');
  }
  if (present(value, 'taxId')) {
    patch.taxId = optionalString(value.taxId, 'taxId');
  }
  if (present(value, 'branchNo')) {
    patch.branchNo = optionalString(value.branchNo, 'branchNo');
  }

  return patch;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function present(obj: Record<string, unknown>, key: string): boolean {
  return key in obj && obj[key] !== undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`Field '${name}' must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException(`Field '${name}' must be a string or null`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requiredNumber(value: unknown, name: string, min = 0): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'boolean' || isNaN(num) || num < min) {
    throw new BadRequestException(`Field '${name}' must be a number >= ${min}`);
  }
  return num;
}

function requiredInteger(value: unknown, name: string, min = 1): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'boolean' || !Number.isInteger(num) || num < min) {
    throw new BadRequestException(`Field '${name}' must be an integer >= ${min}`);
  }
  return num;
}
