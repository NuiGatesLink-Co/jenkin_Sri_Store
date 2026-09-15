/**
 * #238 — tombstones for rows the shop hard-deleted but history still references.
 *
 * The Drift build has no foreign keys, and every delete is a hard delete. So a real backup
 * holds movements and suppliers naming a product that is gone, bills naming a customer or
 * mechanic that is gone, and credit payments naming a mechanic that is gone. Postgres has a
 * foreign key on each of those references.
 *
 * Owner decision 2026-09-15, option (a): for every such id the import creates **one
 * soft-deleted row**. The row carries `deleted_at` = import time, the name history already
 * carries (`movements.name/part_no`, `sale_items.name/part_no`, `sales.customer_name`,
 * `sales.mechanic_name`, …) and zero totals. It is marked `import-tombstone` so it can be
 * told apart from a row the shop deleted on the server.
 *
 * A reference with no usable name anywhere in the file cannot become an honest tombstone,
 * and the pre-flight refuses it with the ids listed. A credit note whose bill is missing is
 * refused too: inventing a bill would invent money.
 *
 * Pure: reads only the snapshot, so the import and the reconcile checks share one plan.
 */

/** The marker: `products.brand`, and the prefix of `customers.code` / `mechanics.code`. */
export const TOMBSTONE_MARK = 'import-tombstone';

export interface ProductTombstone {
  id: string;
  partNo: string;
  name: string;
  nameTh: string;
}

export interface PersonTombstone {
  id: string;
  code: string;
  name: string;
}

export interface TombstonePlan {
  products: ProductTombstone[];
  customers: PersonTombstone[];
  mechanics: PersonTombstone[];
  /** `table:id` references with no usable name anywhere in the file. */
  unnamed: string[];
  /** Credit notes whose bill is not in the file (`returns.sale_id` → `sales`). */
  returnsWithoutSale: string[];
}

type Row = Record<string, unknown>;

const rows = (v: unknown): Row[] =>
  Array.isArray(v) ? (v as unknown[]).filter((x): x is Row => !!x && typeof x === 'object') : [];

const text = (v: unknown): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** Every id referenced through a foreign key the file does not contain, in first-seen order. */
function missing(ids: Iterable<unknown>, present: Set<string>): string[] {
  const out = new Set<string>();
  for (const id of ids) {
    const s = text(id);
    if (s != null && !present.has(s)) out.add(s);
  }
  return [...out];
}

export function planTombstones(snapshot: Row): TombstonePlan {
  const products = rows(snapshot.sa_products);
  const customers = rows(snapshot.sa_customers);
  const mechanics = rows(snapshot.sa_mechanics);
  const sales = rows(snapshot.sa_sales);
  const returns = rows(snapshot.sa_returns);
  const movements = rows(snapshot.sa_movements);
  const suppliers = rows(snapshot.sa_suppliers);
  const payments = rows(snapshot.sa_credit_payments);
  const quotes = rows(snapshot.sa_quotes);

  const unnamed: string[] = [];

  // Products: referenced by movements and suppliers (the two FKs). Names come from every place
  // a product's name was copied: movements and sale lines carry part_no too.
  const productIds = new Set(products.map((p) => String(p.id)));
  const productNames = new Map<string, { partNo: string | null; name: string | null; nameTh: string | null }>();
  const learnProduct = (id: unknown, partNo: unknown, name: unknown, nameTh: unknown) => {
    const key = text(id);
    if (key == null || productIds.has(key)) return;
    const known = productNames.get(key) ?? { partNo: null, name: null, nameTh: null };
    productNames.set(key, {
      partNo: known.partNo ?? text(partNo),
      name: known.name ?? text(name),
      nameTh: known.nameTh ?? text(nameTh),
    });
  };
  for (const m of movements) learnProduct(m.productId, m.partNo, m.name, null);
  for (const s of sales) for (const i of rows(s.items)) learnProduct(i.productId, i.partNo, i.name, i.nameTH);
  for (const r of returns) for (const i of rows(r.items)) learnProduct(i.productId, null, i.name, null);
  for (const q of quotes) for (const i of rows(q.items)) learnProduct(i.productId, null, i.name, null);

  const productTombstones: ProductTombstone[] = [];
  for (const id of missing([...movements.map((m) => m.productId), ...suppliers.map((s) => s.productId)], productIds)) {
    const n = productNames.get(id);
    if (!n?.name) {
      unnamed.push(`products:${id}`);
      continue;
    }
    // A tombstone is soft-deleted, so the partial unique part-number indexes never see it.
    productTombstones.push({ id, partNo: n.partNo ?? id, name: n.name, nameTh: n.nameTh ?? n.name });
  }

  const people = (
    table: 'customers' | 'mechanics',
    present: Row[],
    refs: unknown[],
    names: Array<[unknown, unknown]>,
  ): PersonTombstone[] => {
    const ids = new Set(present.map((x) => String(x.id)));
    const nameOf = new Map<string, string>();
    for (const [id, name] of names) {
      const key = text(id);
      const value = text(name);
      if (key != null && value != null && !nameOf.has(key)) nameOf.set(key, value);
    }
    const out: PersonTombstone[] = [];
    for (const id of missing(refs, ids)) {
      const name = nameOf.get(id);
      if (!name) {
        unnamed.push(`${table}:${id}`);
        continue;
      }
      out.push({ id, code: `${TOMBSTONE_MARK}:${id}`, name });
    }
    return out;
  };

  const customerTombstones = people(
    'customers',
    customers,
    sales.map((s) => s.customerId),
    sales.map((s) => [s.customerId, s.customerName]),
  );
  const mechanicTombstones = people(
    'mechanics',
    mechanics,
    [...sales.map((s) => s.mechanicId), ...payments.map((p) => p.mechanicId)],
    [...sales.map((s): [unknown, unknown] => [s.mechanicId, s.mechanicName]), ...returns.map((r): [unknown, unknown] => [r.mechanicId, r.mechanicName])],
  );

  const saleIds = new Set(sales.map((s) => String(s.id)));
  const returnsWithoutSale = returns.filter((r) => !saleIds.has(String(r.saleId))).map((r) => String(r.id));

  return {
    products: productTombstones,
    customers: customerTombstones,
    mechanics: mechanicTombstones,
    unnamed,
    returnsWithoutSale,
  };
}
