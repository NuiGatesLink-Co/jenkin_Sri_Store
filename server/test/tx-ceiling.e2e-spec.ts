import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { DocNumberService } from '../src/documents/doc-number.service.js';
import { AUDIT_DATA_SOURCE } from '../src/infra/db.module.js';
import {
  accessToken,
  createTestApp,
  resetTenant,
  seedOpenShift,
  seedProduct,
} from './support/fixture.js';

// #213: ADR-0010's phase-2 pull rewinds `?updatedSince=` by 30 s, which is safe only while
// a write transaction commits within 30 s of stamping `updated_at = now()`. Migration
// `1788652802130` caps every `pos_app` connection at `statement_timeout = 5s` and
// `idle_in_transaction_session_timeout = 5s` (Postgres 16 has no `transaction_timeout`).
//
// Each case proves the cap fires on a real request and leaves nothing behind: the request
// answers an error instead of hanging, nothing is written, and a pool of TWO — both of
// whose connections the stall case kills — serves the next burst. A pool that handed a
// dead client back out would 500 the burst; one that leaked a checked-out client would
// wait out `connectionTimeoutMillis` (the #162 signature), hence the short connect timeout.
describe('pos_app transactions cannot outlive the 30 s cursor rewind (e2e, #213)', () => {
  const TENANT = '21321321-3333-4333-8333-213213213213';

  let app: INestApplication;
  let ds: DataSource;
  let admin: DataSource;
  let cache: Redis;
  let token: string;
  let seq = 0;

  beforeAll(async () => {
    const before = {
      pool: process.env.DB_POOL_SIZE,
      timeout: process.env.DB_CONNECTION_TIMEOUT_MS,
    };
    process.env.DB_POOL_SIZE = '2';
    process.env.DB_CONNECTION_TIMEOUT_MS = '5000';
    try {
      ({ app, ds, admin, cache } = await createTestApp());
    } finally {
      if (before.pool === undefined) delete process.env.DB_POOL_SIZE;
      else process.env.DB_POOL_SIZE = before.pool;
      if (before.timeout === undefined) delete process.env.DB_CONNECTION_TIMEOUT_MS;
      else process.env.DB_CONNECTION_TIMEOUT_MS = before.timeout;
    }
    const t = await resetTenant(admin, TENANT, { posDeviceNo: 13, cache });
    token = accessToken({
      tenantId: TENANT,
      userId: t.userId,
      role: 'manager',
      deviceId: t.posDeviceId,
      deviceRole: 'pos',
    });
    await seedProduct(admin, TENANT, {
      id: 'p1',
      partNo: 'OF-1',
      name: 'Oil Filter',
      price: 85,
      cost: 50,
      stock: 100,
    });
    // A second part, so the two stalled bills below do not queue on each other's row lock.
    await seedProduct(admin, TENANT, {
      id: 'p2',
      partNo: 'OF-2',
      name: 'Oil Filter 2',
      price: 85,
      cost: 50,
      stock: 100,
    });
    await seedOpenShift(admin, TENANT, t.posDeviceId, { userId: t.userId });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await resetTenant(admin, TENANT, { cache });
    await admin.query(`DELETE FROM tenants WHERE id = $1::uuid`, [TENANT]);
    await app.close();
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const sell = (key: string, id: string, productId = 'p1') =>
    request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({
        id,
        subtotal: '85.00',
        discount: '0.00',
        total: '85.00',
        paymentMethod: 'เงินสด',
        items: [
          {
            lineNo: 1,
            productId,
            partNo: productId === 'p1' ? 'OF-1' : 'OF-2',
            name: 'Oil Filter',
            nameTH: 'Oil Filter',
            qty: 1,
            price: '85.00',
          },
        ],
      });

  const current = () =>
    request(app.getHttpServer())
      .get('/api/v1/shifts/current')
      .set('Authorization', `Bearer ${token}`);

  const saleCount = async (id: string) =>
    (
      (await admin.query(
        `SELECT count(*)::int AS n FROM sales WHERE tenant_id = $1::uuid AND id = $2`,
        [TENANT, id],
      )) as { n: number }[]
    )[0].n;

  it('every pos_app pool carries the ceiling; the owner connection does not', async () => {
    const show = async (on: DataSource) => {
      const [s] = await on.query(`SHOW statement_timeout`);
      const [i] = await on.query(`SHOW idle_in_transaction_session_timeout`);
      return [s.statement_timeout, i.idle_in_transaction_session_timeout];
    };
    expect(await show(ds)).toEqual(['5s', '5s']);
    expect(await show(app.get<DataSource>(AUDIT_DATA_SOURCE))).toEqual(['5s', '5s']);
    // Migrations and platform provisioning/import run as the owner, uncapped.
    expect(await show(admin)).toEqual(['0', '0']);
  });

  it('a bill blocked on a row lock past the ceiling answers an error, writes nothing, and a retry goes through', async () => {
    const key = `k-213-lock-${++seq}-${Date.now()}`;
    const id = `s-213-lock-${seq}-${Date.now()}`;
    // The owner connection is uncapped, so it can hold the product row for as long as the
    // test needs — longer than any pos_app statement may wait for it.
    const holder = admin.createQueryRunner();
    await holder.connect();
    let res: request.Response;
    let elapsed: number;
    try {
      await holder.startTransaction();
      await holder.query(
        `SELECT id FROM products WHERE tenant_id = $1::uuid AND id = 'p1' FOR UPDATE`,
        [TENANT],
      );
      const started = Date.now();
      // Bounded, so a missing ceiling fails as a timeout here and the holder is released,
      // instead of hanging the suite on a lock nothing will ever let go of.
      res = await sell(key, id).timeout(15_000);
      elapsed = Date.now() - started;
    } finally {
      if (holder.isTransactionActive) await holder.commitTransaction();
      await holder.release();
    }
    console.log(`PROBE lock-wait bill: ${res.status} after ${elapsed} ms`);

    // A 5xx, not a 4xx: the client reads it as "fate unknown" and resends the same key.
    expect(res.status).toBe(500);
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(8000);
    expect(await saleCount(id)).toBe(0);

    // The idempotency claim rolled back with the transaction, so the resend is a first try.
    const retry = await sell(key, id);
    expect(retry.status).toBe(201);
    expect(await saleCount(id)).toBe(1);
  });

  it('a transaction the app stalls past the ceiling is ended by Postgres, and the pool recovers', async () => {
    // Stall the sale path between two statements of its open transaction — the shape an
    // event-loop stall, a slow Redis call or a debugger breakpoint inside `runTx` takes.
    const docs = app.get(DocNumberService);
    const issue = docs.issue.bind(docs);
    vi.spyOn(docs, 'issue').mockImplementation(async (...args) => {
      await sleep(5500);
      return issue(...args);
    });

    // pg-pool emits `remove` when it drops a client instead of reusing it. A statement
    // timeout keeps its connection; only a session Postgres ended is dropped.
    const pool = (ds.driver as unknown as { master: import('events').EventEmitter }).master;
    let removed = 0;
    const onRemove = () => removed++;
    pool.on('remove', onRemove);

    // Two at once, so BOTH pooled connections are the ones Postgres terminates.
    const stamp = Date.now();
    const ids = [0, 1].map((i) => `s-213-idle-${++seq}-${i}-${stamp}`);
    const started = Date.now();
    const stalled = await Promise.all(
      ids.map((id, i) => sell(`k-213-idle-${seq}-${i}-${stamp}`, id, `p${i + 1}`)),
    );
    const elapsed = Date.now() - started;
    console.log(
      `PROBE stalled bills: ${stalled.map((r) => r.status).join(',')} after ${elapsed} ms`,
    );
    expect(stalled.map((r) => r.status)).toEqual([500, 500]);
    expect(elapsed).toBeLessThan(8000);
    for (const id of ids) expect(await saleCount(id)).toBe(0);
    pool.off('remove', onRemove);
    expect(removed).toBe(2);

    vi.restoreAllMocks();

    const burstStarted = Date.now();
    const [bills, reads] = await Promise.all([
      Promise.all(
        [0, 1, 2].map((i) =>
          sell(`k-213-after-${++seq}-${i}-${stamp}`, `s-213-after-${seq}-${i}-${stamp}`),
        ),
      ),
      Promise.all([0, 1, 2].map(current)),
    ]);
    const burst = Date.now() - burstStarted;
    console.log(
      `PROBE burst after termination at pool 2: ${bills.map((r) => r.status).join(',')} | ` +
        `${reads.map((r) => r.status).join(',')}  ${burst} ms`,
    );
    expect(bills.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(reads.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(burst).toBeLessThan(3000);
  });
});
