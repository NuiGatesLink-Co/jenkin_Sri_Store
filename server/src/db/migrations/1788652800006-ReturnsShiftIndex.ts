import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #30 — `idx_returns_shift`.
 *
 * `GET /reports/closing?shiftId=` sums one shift's cash refunds, and the closing report
 * is computed **by `shift_id`**, never by a timestamp window. `sales` has had
 * `idx_sales_shift` since the initial schema and `credit_payments` got
 * `idx_creditpay_shift` in #24; `returns` carried the column with no index, so that
 * one term would scan every credit note the shop ever wrote. This is the third twin.
 */
export class ReturnsShiftIndex1788652800006 implements MigrationInterface {
  name = 'ReturnsShiftIndex1788652800006';

  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE INDEX idx_returns_shift ON returns (tenant_id, shift_id)`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX idx_returns_shift`);
  }
}
