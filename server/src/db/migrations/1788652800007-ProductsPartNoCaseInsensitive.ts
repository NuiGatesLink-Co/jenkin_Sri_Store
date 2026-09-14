import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #16 — a part number is unique per tenant **case-insensitively** among live products.
 *
 * `db.js addProduct` / `updateProduct` compare part numbers with `toLowerCase()`, while
 * `uq_products_partno` is case-sensitive, so `BP-1` and `bp-1` could both be live. An
 * application-side check cannot close that: the platform import writes products without
 * it, and JS `toLowerCase` and Postgres `lower()` disagree outside ASCII. The database
 * decides instead; the API maps the violation to `409 DUPLICATE_PART_NO`.
 *
 * Partial on `deleted_at IS NULL` for the same reason as `uq_products_partno`: a
 * tombstone must not block reusing its number. It also serves `?partNo=`, which compares
 * `lower(part_no)`. `uq_products_partno` stays — it is implied by this one, and dropping
 * it is not this ticket's change to make.
 */
export class ProductsPartNoCaseInsensitive1788652800007 implements MigrationInterface {
  name = 'ProductsPartNoCaseInsensitive1788652800007';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE UNIQUE INDEX uq_products_partno_ci ON products (tenant_id, lower(part_no))
         WHERE deleted_at IS NULL`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX uq_products_partno_ci`);
  }
}
