import { BadRequestException } from '@nestjs/common';
import {
  asObject,
  integer,
  nonNegativeMoney,
  requiredString,
  stringOrEmpty,
} from '../products/catalogue.dto.js';

/**
 * Hand-validated bodies for `POST /purchase-orders` (#26), in the style of
 * `catalogue.dto.ts`. The server owns `id`, `poNo`, `status` and the timestamps; a
 * client that sends them is ignored, as `savePO` in the Dart repository mints them.
 */

export interface PoLineCreate {
  partNo: string;
  name: string;
  qty: number;
  /** Money as the wire string, `"160.00"`. */
  cost: string;
}

export interface PoCreate {
  supplier: string;
  items: PoLineCreate[];
}

export const PO_STATUSES = ['open', 'received', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

/**
 * `{ supplier, items: [{ partNo, name, qty, cost }] }`.
 *
 * Validated here rather than left to the schema's `CHECK (qty > 0)` and
 * `CHECK (cost >= 0)`, which would surface as a 500. A PO with no lines is refused:
 * the create dialog will not submit one (`purchase_orders_screen.dart` `_submit`),
 * and receiving it would mark it received having moved nothing.
 */
export function parsePoCreate(body: unknown): PoCreate {
  const b = asObject(body);
  const supplier = requiredString(b.supplier, 'supplier');
  if (!Array.isArray(b.items) || b.items.length === 0) {
    throw new BadRequestException('items must be a non-empty array');
  }
  const items = b.items.map((raw, i) => {
    const line = asObject(raw);
    return {
      // Trimmed as `products.part_no` is (`catalogue.dto.ts`), so a stray space
      // cannot turn a real part into an "unmatched" line at receiving.
      partNo: requiredString(line.partNo, `items[${i}].partNo`).trim(),
      name: stringOrEmpty(line.name, `items[${i}].name`),
      qty: integer(line.qty, `items[${i}].qty`, 1),
      cost: nonNegativeMoney(line.cost, `items[${i}].cost`),
    };
  });
  return { supplier, items };
}

/** `?status=` — one of the three the schema allows, or absent for all. */
export function parsePoStatus(raw: string | undefined): PoStatus | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!(PO_STATUSES as readonly string[]).includes(raw)) {
    throw new BadRequestException(
      `status must be one of ${PO_STATUSES.join(', ')}`,
    );
  }
  return raw as PoStatus;
}
