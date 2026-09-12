import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #24 — `credit_payments.payment_method` and `credit_payments.shift_id`.
 *
 * A mechanic paying down his tab hands over cash or transfers it, and the closing
 * report has to tell the two apart: count a transfer as cash and the drawer shows a
 * shortfall the size of the transfer every single day, which is how staff stop
 * believing the report. The legacy JS app stored the method on the payment
 * (`p.method === 'เงินสด'` is what its drawer summed); the Drift port dropped the
 * column and `cash_drawer_screen.dart:121` says so in as many words — it treats every
 * settlement as cash because it has nothing better. This column is what the server
 * needs to not repeat that.
 *
 * `shift_id` is the same stamp `sales` and `returns` carry (#28): the closing report
 * is computed **by shift**, never by a timestamp window — a window breaks across
 * midnight and cannot separate two machines.
 *
 * Both are nullable, and neither has a default:
 *
 * - A row imported from the old app (`tenant-import.service.ts`) was written before
 *   this server existed and belongs to no shift of ours. `DEFAULT 'เงินสด'` would
 *   quietly declare every one of them cash.
 * - A payment taken with no drawer open has no shift, exactly as a sale taken that
 *   way does — the old app lets staff work without opening one, and refusing the
 *   money would be a new rule rather than a ported one.
 *
 * `NOT NULL` on `payment_method` is therefore wrong for the table but right for the
 * endpoint, so `parseCreditPayment` requires it there instead: what the server writes
 * always carries a method, what history handed us may not.
 *
 * Nothing else changes: RLS and the `pos_app` grants are per table, not per column,
 * so added columns inherit both.
 */
export class CreditPaymentsMethodAndShift1788652800005 implements MigrationInterface {
  name = 'CreditPaymentsMethodAndShift1788652800005';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE credit_payments ADD COLUMN payment_method TEXT`);
    await q.query(`ALTER TABLE credit_payments ADD COLUMN shift_id TEXT`);
    // The closing report reads one shift's payments; the twin of `idx_sales_shift`.
    // No foreign key, for the same reason `sales.shift_id` has none: the stamp is a
    // report key, and a payment must not become unwritable because the drawer row
    // was archived out from under it.
    await q.query(
      `CREATE INDEX idx_creditpay_shift ON credit_payments (tenant_id, shift_id)`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX idx_creditpay_shift`);
    await q.query(`ALTER TABLE credit_payments DROP COLUMN shift_id`);
    await q.query(`ALTER TABLE credit_payments DROP COLUMN payment_method`);
  }
}
