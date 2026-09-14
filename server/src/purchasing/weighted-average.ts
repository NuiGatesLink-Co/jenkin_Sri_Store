/**
 * The receiving cost rule (01_DATABASE.md §7.4, `purchase_orders_repository.dart`
 * `receivePO`), in integer satang:
 *
 *   effective_new_cost = line_cost > 0 ? line_cost : old_cost
 *   total_qty          = old_stock + new_qty
 *   new_cost           = total_qty > 0
 *                        ? round2((old_stock*old_cost + new_qty*effective_new_cost) / total_qty)
 *                        : effective_new_cost
 *
 * **Both fallbacks are mandatory.** Without the first, a line entered at cost zero
 * (freebies, unknown prices) drags the average toward zero for good and every later
 * profit report is inflated. The second cannot fire against this schema —
 * `products.stock` is `CHECK (stock >= 0)` and `po_items.qty` is `CHECK (qty > 0)` —
 * and is kept because the rule is written that way and the Dart one is too.
 *
 * `round2` is Dart's `(v * 100).round() / 100`: half away from zero, which for these
 * non-negative amounts is half up. The product is computed in `BigInt` because
 * `stock × cost` in satang passes 2^53 long before either column overflows, and in
 * exact integers because the Dart version's float rounding at a half-satang boundary
 * (`1.005 * 100 = 100.4999…`) is an artefact, not a rule.
 */
export function weightedAverageCostSatang(
  oldStock: number,
  oldCostSatang: number,
  newQty: number,
  lineCostSatang: number,
): number {
  const effective = lineCostSatang > 0 ? lineCostSatang : oldCostSatang;
  const totalQty = oldStock + newQty;
  if (totalQty <= 0) return effective;
  const numerator =
    BigInt(oldStock) * BigInt(oldCostSatang) +
    BigInt(newQty) * BigInt(effective);
  const total = BigInt(totalQty);
  return Number((numerator * 2n + total) / (2n * total));
}

/**
 * A satang amount the way `db.js` interpolates a number into a template literal —
 * `120`, `133.33`, `120.5` — which is what the Dart repository reproduces with
 * `_jsNum` for the movement note (its test pins `ทุนใหม่ ฿120`, no `.00`).
 */
export function jsNumber(satang: number): string {
  return String(satang / 100);
}
