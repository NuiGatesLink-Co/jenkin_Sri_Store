import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import {
  accessToken,
  createTestApp,
  resetTenant,
  seedMechanic,
  type TenantFixture,
} from './support/fixture.js';

// #24 acceptance suite. `mechanics_repository.dart` `addCreditPayment` reproduced at
// the HTTP seam, plus the four rules the Dart version has no concept of: device roles,
// server-issued CP numbers, the `shift_id` stamp, and idempotency.
const TENANT = 'dddddddd-2424-4242-8242-dddddddddddd';
const MECHANIC = 'm-credit-1';

describe('POST /mechanics/:id/credit-payments (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  let cache: import('ioredis').Redis;
  let fixture: TenantFixture;
  let posToken: string;
  let backofficeToken: string;
  let keySeq = 0;

  const pay = (
    body: unknown,
    opts: { key?: string; token?: string; mechanicId?: string } = {},
  ) =>
    request(app.getHttpServer())
      .post(`/api/v1/mechanics/${opts.mechanicId ?? MECHANIC}/credit-payments`)
      .set('Authorization', `Bearer ${opts.token ?? posToken}`)
      .set('Idempotency-Key', opts.key ?? `k-${++keySeq}-${Date.now()}`)
      .send(body as object);

  const openDrawer = () =>
    request(app.getHttpServer())
      .post('/api/v1/shifts/open')
      .set('Authorization', `Bearer ${posToken}`)
      .set('Idempotency-Key', `k-shift-${++keySeq}-${Date.now()}`)
      .send({ startingCash: '1000.00' });

  const balanceOf = async (): Promise<string> => {
    const rows = await admin.query(
      `SELECT credit_balance FROM mechanics WHERE tenant_id = $1::uuid AND id = $2`,
      [TENANT, MECHANIC],
    );
    return rows[0].credit_balance;
  };

  const paymentRows = async () =>
    (await admin.query(
      `SELECT id, receipt_no, amount, payment_method, note, shift_id
         FROM credit_payments WHERE tenant_id = $1::uuid ORDER BY receipt_no`,
      [TENANT],
    )) as {
      id: string;
      receipt_no: string;
      amount: string;
      payment_method: string | null;
      note: string | null;
      shift_id: string | null;
    }[];

  beforeAll(async () => {
    ({ app, admin, cache } = await createTestApp());
  });

  beforeEach(async () => {
    fixture = await resetTenant(admin, TENANT, { posDeviceNo: 7, cache });
    await seedMechanic(admin, TENANT, {
      id: MECHANIC,
      code: 'M001',
      name: 'ช่างสมชาย',
      creditLimit: 20000,
      creditBalance: 3000,
    });
    posToken = accessToken({
      tenantId: TENANT,
      userId: fixture.userId,
      role: 'cashier',
      deviceId: fixture.posDeviceId,
      deviceRole: 'pos',
    });
    backofficeToken = accessToken({
      tenantId: TENANT,
      userId: fixture.userId,
      role: 'manager',
      deviceId: fixture.backofficeDeviceId,
      deviceRole: 'backoffice',
    });
  });

  afterAll(async () => {
    await resetTenant(admin, TENANT);
    await admin.query(`DELETE FROM tenants WHERE id = $1::uuid`, [TENANT]);
    await app.close();
  });

  // ── AC1 + AC3 ────────────────────────────────────────────────────────────────
  it('reduces the tab and stamps the drawer the money went into', async () => {
    const shift = await openDrawer();

    const res = await pay({
      amount: '1200.50',
      paymentMethod: 'เงินสด',
      note: 'จ่ายงวดแรก',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe('1200.50');
    expect(res.body.data.paymentMethod).toBe('เงินสด');
    expect(res.body.data.note).toBe('จ่ายงวดแรก');
    expect(res.body.data.mechanicCreditBalanceAfter).toBe('1799.50');
    // The stamp #30 computes the closing report from — never a timestamp window.
    expect(res.body.data.shiftId).toBe(shift.body.data.id);

    expect(await balanceOf()).toBe('1799.50');
    const rows = await paymentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe('1200.50');
    expect(rows[0].payment_method).toBe('เงินสด');
    expect(rows[0].shift_id).toBe(shift.body.data.id);
  });

  it('a payment taken with no drawer open carries no shift, and is still taken', async () => {
    // Parity with the sale and the credit note: the old app lets staff work without
    // opening the drawer, and refusing the money would be a new rule, not a ported one.
    const res = await pay({ amount: '100.00', paymentMethod: 'เงินสด' });

    expect(res.status).toBe(201);
    expect(res.body.data.shiftId).toBeNull();
    expect(await balanceOf()).toBe('2900.00');
  });

  // ── AC1 (the clamp) ──────────────────────────────────────────────────────────
  it('refuses a payment larger than the tab, and leaves the tab alone', async () => {
    // 🔴 Validate before clamping. Without this, 100,000 keyed for 1,000 wipes the
    // debt and prints a receipt for cash nobody handed over, and the data cannot say
    // which of the two happened.
    const res = await pay({ amount: '5000.00', paymentMethod: 'เงินสด' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CREDIT_PAYMENT_EXCEEDS_BALANCE');
    expect(res.body.error.details).toEqual({
      creditBalance: '3000.00',
      amount: '5000.00',
      overpayBy: '2000.00',
    });
    expect(await balanceOf()).toBe('3000.00');
    expect(await paymentRows()).toHaveLength(0);
    // Refused before the counter is touched: the CP series has no hole in it.
    const counters = await admin.query(
      `SELECT count(*)::int AS n FROM doc_counters WHERE tenant_id = $1::uuid`,
      [TENANT],
    );
    expect(counters[0].n).toBe(0);
  });

  it('a confirmed overpayment clamps the tab at zero and records who confirmed it', async () => {
    const res = await pay({
      amount: '5000.00',
      paymentMethod: 'เงินสด',
      allowOverpayment: true,
    });

    expect(res.status).toBe(201);
    // The full amount is recorded; only the tab is clamped.
    expect(res.body.data.amount).toBe('5000.00');
    expect(res.body.data.mechanicCreditBalanceAfter).toBe('0.00');
    expect(await balanceOf()).toBe('0.00');

    const audit = await admin.query(
      `SELECT action, entity_id, after FROM audit_log
        WHERE tenant_id = $1::uuid AND action = 'mechanic.credit_payment_overpayment'`,
      [TENANT],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].entity_id).toBe(MECHANIC);
    expect(audit[0].after).toMatchObject({
      amount: '5000.00',
      creditBalanceBefore: '3000.00',
      creditBalanceAfter: '0.00',
    });
  });

  it('a payment that exactly settles the tab is not an overpayment', async () => {
    const res = await pay({ amount: '3000.00', paymentMethod: 'โอน/QR' });

    expect(res.status).toBe(201);
    expect(res.body.data.mechanicCreditBalanceAfter).toBe('0.00');
    const audit = await admin.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1::uuid`,
      [TENANT],
    );
    expect(audit[0].n).toBe(0);
  });

  it('two tills settling the same tab at once cannot both overpay it', async () => {
    // The `FOR UPDATE` is what makes the check mean anything: unserialised, both read
    // 3000, both pass, and the shop takes 4000 in cash against a 3000 debt.
    const [a, b] = await Promise.all([
      pay({ amount: '2000.00', paymentMethod: 'เงินสด' }),
      pay({ amount: '2000.00', paymentMethod: 'เงินสด' }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const refused = a.status === 409 ? a : b;
    expect(refused.body.error.code).toBe('CREDIT_PAYMENT_EXCEEDS_BALANCE');
    // The second one saw the balance the first one left behind, not the one it read.
    expect(refused.body.error.details.creditBalance).toBe('1000.00');
    expect(await balanceOf()).toBe('1000.00');
    expect(await paymentRows()).toHaveLength(1);
  });

  // ── AC2 ──────────────────────────────────────────────────────────────────────
  it('issues a CP number per device per month, in sequence', async () => {
    const first = await pay({ amount: '100.00', paymentMethod: 'เงินสด' });
    const second = await pay({ amount: '200.00', paymentMethod: 'โอน/QR' });

    // `CP07-2569-09-0001` — the series letters, the zero-padded device number
    // (ADR-0007: unpadded, machine 1 and machine 12 parse back wrong), the Buddhist
    // period, four digits.
    expect(first.body.data.receiptNo).toMatch(/^CP07-25\d\d-\d\d-0001$/);
    expect(second.body.data.receiptNo).toBe(
      first.body.data.receiptNo.replace(/0001$/, '0002'),
    );

    const counter = await admin.query(
      `SELECT doc_type, last_no FROM doc_counters WHERE tenant_id = $1::uuid`,
      [TENANT],
    );
    expect(counter).toEqual([{ doc_type: 'cp', last_no: 2 }]);
  });

  // ── AC3 ──────────────────────────────────────────────────────────────────────
  it('records the method, so a shift’s cash can be told from its transfers', async () => {
    // #30 owns the closing report itself; what #24 owes it is data it can compute
    // from. This is that computation: expected cash must count the 800 handed over
    // and ignore the 500 that went into the bank.
    const shift = await openDrawer();
    await pay({ amount: '800.00', paymentMethod: 'เงินสด' });
    await pay({ amount: '500.00', paymentMethod: 'โอน/QR' });

    const cash = await admin.query(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
         FROM credit_payments
        WHERE tenant_id = $1::uuid AND shift_id = $2 AND payment_method = 'เงินสด'`,
      [TENANT, shift.body.data.id],
    );
    expect(cash[0].total).toBe('800.00');

    const rows = await paymentRows();
    expect(rows.map((r) => r.payment_method)).toEqual(['เงินสด', 'โอน/QR']);
    expect(rows.every((r) => r.shift_id === shift.body.data.id)).toBe(true);
    // Both came off the tab; only one of them came out of a customer's pocket in cash.
    expect(await balanceOf()).toBe('1700.00');
  });

  it('refuses a payment whose method the server would have to guess', async () => {
    for (const body of [
      { amount: '100.00' },
      { amount: '100.00', paymentMethod: 'โอน' },
      { amount: '100.00', paymentMethod: 'เครดิตช่าง' },
      { amount: '100.00', paymentMethod: 'เงินสด ' },
    ]) {
      const res = await pay(body);
      expect(res.status).toBe(400);
    }
    expect(await balanceOf()).toBe('3000.00');
    expect(await paymentRows()).toHaveLength(0);
  });

  // ── AC4 ──────────────────────────────────────────────────────────────────────
  it('repeating one Idempotency-Key records one payment', async () => {
    const key = `cp-retry-${Date.now()}`;
    const body = {
      amount: '750.00',
      paymentMethod: 'เงินสด',
      note: 'งวดที่ 2',
    };

    const first = await pay(body, { key });
    const replay = await pay(body, { key });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    // The whole body, not a field of it: a replay that answers a different receipt
    // number is a second document the shop cannot account for.
    expect(replay.body).toEqual(first.body);
    expect(await paymentRows()).toHaveLength(1);
    // Reduced once. A second reduction here is a debt the mechanic never paid off.
    expect(await balanceOf()).toBe('2250.00');
  });

  it('the same amount under a new key is a second payment, not a duplicate', async () => {
    // A mechanic may hand over 500 twice in one day, and the key is what tells the
    // two apart — never the amount.
    await pay({ amount: '500.00', paymentMethod: 'เงินสด' });
    await pay({ amount: '500.00', paymentMethod: 'เงินสด' });

    expect(await paymentRows()).toHaveLength(2);
    expect(await balanceOf()).toBe('2000.00');
  });

  // ── AC5 ──────────────────────────────────────────────────────────────────────
  it('a backoffice device is refused', async () => {
    const res = await pay(
      { amount: '100.00', paymentMethod: 'เงินสด' },
      { token: backofficeToken },
    );

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEVICE_ROLE_FORBIDDEN');
    expect(await balanceOf()).toBe('3000.00');
    expect(await paymentRows()).toHaveLength(0);
  });

  // ── the edges the money path always has ──────────────────────────────────────
  it('an unknown mechanic is a 404, not a foreign-key 500', async () => {
    const res = await pay(
      { amount: '100.00', paymentMethod: 'เงินสด' },
      { mechanicId: 'm-does-not-exist' },
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MECHANIC_NOT_FOUND');
  });

  it('still takes the money a mechanic who has been removed came in to pay', async () => {
    // He owes it either way, and refusing loses the shop both the cash and the record
    // of it. `POST /sales` does not filter `deleted_at` on the mechanic either.
    await admin.query(
      `UPDATE mechanics SET deleted_at = now() WHERE tenant_id = $1::uuid AND id = $2`,
      [TENANT, MECHANIC],
    );

    const res = await pay({ amount: '3000.00', paymentMethod: 'เงินสด' });

    expect(res.status).toBe(201);
    expect(await balanceOf()).toBe('0.00');
  });
});
