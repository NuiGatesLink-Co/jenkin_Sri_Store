import { BadRequestException } from '@nestjs/common';
import { toSatang } from '../common/money.js';
import { parseSaleParty, type SaleParty } from '../sales/sales.dto.js';

/**
 * Hand-validated quote bodies (#27), in the style of `sales.dto.ts`. Ported from
 * `quotes_repository.dart` `saveQuote`, which is what the Checkout screen's
 * "บันทึกเป็นใบเสนอราคา" calls.
 *
 * The server owns `id` (`newId('q')`), `quoteNo` (QT, ADR-0007), `date`,
 * `validUntil`, `status`, `convertedAt` and `convertedSaleId`; none of them is read
 * from a body.
 */

export interface QuoteLine {
  lineNo: number;
  /** Nullable in the schema — `quote_items.product_id` allows a part not in the catalogue. */
  productId: string | null;
  name: string;
  qty: number;
  priceSatang: number;
}

export interface QuoteCreate {
  subtotalSatang: number;
  discountSatang: number;
  totalSatang: number;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  /** Stored as sent; `validUntil` uses `validDays ?? 30`, as the Dart data layer does. */
  validDays: number | null;
  items: QuoteLine[];
}

export interface QuotePatch {
  customerName?: string | null;
  customerPhone?: string | null;
  notes?: string | null;
}

/** The three filters `quotes_screen.dart` `_applyFilter` offers besides "all". */
export const QUOTE_FILTERS = ['open', 'expired', 'converted'] as const;
export type QuoteFilter = (typeof QUOTE_FILTERS)[number];

/** The same line cap as a bill: a quote is converted into one. */
const MAX_LINES = 200;
/** A hundred years — past this the interval arithmetic is nonsense, not a quote. */
const MAX_VALID_DAYS = 36_500;

export function parseQuoteCreate(body: unknown): QuoteCreate {
  const b = asObject(body, 'body');
  // `QuoteInput.status` exists in Dart, but every caller passes `'open'` or nothing,
  // and a quote saved as `'converted'` would be one with no bill behind it.
  if (b.status !== undefined && b.status !== null && b.status !== 'open') {
    throw new BadRequestException("status must be 'open' or absent");
  }
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length === 0)
    throw new BadRequestException('items must not be empty');
  if (items.length > MAX_LINES) {
    throw new BadRequestException(`items must hold at most ${MAX_LINES} lines`);
  }
  const quote: QuoteCreate = {
    subtotalSatang: toSatang(b.subtotal, 'subtotal'),
    discountSatang: toSatang(b.discount ?? 0, 'discount'),
    totalSatang: toSatang(b.total, 'total'),
    customerName: optionalString(b.customerName, 'customerName'),
    customerPhone: optionalString(b.customerPhone, 'customerPhone'),
    notes: optionalString(b.notes, 'notes'),
    validDays: parseValidDays(b.validDays),
    items: items.map((raw, i) => parseLine(raw, i)),
  };
  if (quote.discountSatang < 0)
    throw new BadRequestException('discount must not be negative');
  if (quote.subtotalSatang < 0)
    throw new BadRequestException('subtotal must not be negative');
  if (quote.totalSatang < 0)
    throw new BadRequestException('total must not be negative');
  if (quote.discountSatang > quote.subtotalSatang) {
    throw new BadRequestException('discount must not exceed subtotal');
  }
  return quote;
}

/**
 * Header text only. `status` is refused: the Quotes screen used to mark a quote
 * converted with `updateQuote(status: 'converted')` and then hand the cart to
 * Checkout, which is the half-finished state `02_API_SCREENS.md §3.8` calls out —
 * conversion is `POST /quotes/:id/convert`, which writes the bill and the mark in
 * one transaction. Lines and money are not editable either: the screen's edit is
 * delete-and-save-again (`_handleEdit`), never a patch.
 */
export function parseQuotePatch(body: unknown): QuotePatch {
  const b = asObject(body, 'body');
  for (const field of [
    'status',
    'convertedAt',
    'convertedSaleId',
    'items',
    'subtotal',
    'discount',
    'total',
  ]) {
    if (has(b, field)) {
      throw new BadRequestException(
        field === 'status' ||
          field === 'convertedAt' ||
          field === 'convertedSaleId'
          ? `${field} cannot be patched; convert a quote with POST /quotes/:id/convert`
          : `${field} cannot be patched; delete the quote and save a new one`,
      );
    }
  }
  const out: QuotePatch = {};
  if (has(b, 'customerName'))
    out.customerName = optionalString(b.customerName, 'customerName');
  if (has(b, 'customerPhone'))
    out.customerPhone = optionalString(b.customerPhone, 'customerPhone');
  if (has(b, 'notes')) out.notes = optionalString(b.notes, 'notes');
  return out;
}

/**
 * `POST /quotes/:id/convert`: the bill's own id, payment method, customer and
 * mechanic, exactly as `POST /sales` reads them. The lines and the money are the
 * saved quote's, so a body carrying them is refused rather than silently ignored — a
 * client that edited the cart meant a different bill, and that is `POST /sales`.
 */
export function parseQuoteConvert(body: unknown): SaleParty {
  const b = asObject(body, 'body');
  for (const field of ['items', 'subtotal', 'discount', 'total']) {
    if (has(b, field)) {
      throw new BadRequestException(
        `${field} comes from the saved quote and must not be sent to convert`,
      );
    }
  }
  return parseSaleParty(b);
}

export function parseQuoteFilter(
  raw: string | undefined,
): QuoteFilter | undefined {
  if (raw === undefined || raw === '' || raw === 'all') return undefined;
  if (!(QUOTE_FILTERS as readonly string[]).includes(raw)) {
    throw new BadRequestException(
      `status must be one of all, ${QUOTE_FILTERS.join(', ')}`,
    );
  }
  return raw as QuoteFilter;
}

function parseLine(raw: unknown, index: number): QuoteLine {
  const l = asObject(raw, `items[${index}]`);
  const qty = l.qty;
  if (
    typeof qty !== 'number' ||
    !Number.isInteger(qty) ||
    qty <= 0 ||
    qty > 1_000_000
  ) {
    throw new BadRequestException(
      `items[${index}].qty must be a positive integer`,
    );
  }
  const priceSatang = toSatang(l.price, `items[${index}].price`);
  if (priceSatang < 0) {
    throw new BadRequestException(`items[${index}].price must not be negative`);
  }
  return {
    lineNo: index + 1,
    productId: optionalString(l.productId, `items[${index}].productId`) || null,
    name: requiredString(l.name, `items[${index}].name`),
    qty,
    priceSatang,
  };
}

function parseValidDays(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_VALID_DAYS
  ) {
    throw new BadRequestException(
      `validDays must be an integer between 1 and ${MAX_VALID_DAYS}`,
    );
  }
  return value;
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(`${field} is required`);
  }
  return value;
}

/** `''` is kept: Checkout saves a quote with no customer as `customerName: ''`. */
function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string`);
  }
  return value;
}
