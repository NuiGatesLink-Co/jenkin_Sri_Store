import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import request from 'supertest';
import { accessToken, createTestApp, resetTenant } from './support/fixture.js';

// #175. A void denial writes its `sale.void.denied` row on `AUDIT_DATA_SOURCE` (pool 2).
// Wrong-PIN guesses are capped at 5 per user by `consumeAttempt` (#154), but the **role**
// branch is not a guess and is not counted: a cashier token can fire as many as the
// per-tenant route limit lets through (ADR-0006, 300/min on a `demo` plan). Since tx.5 the
// caller holds no request connection while it waits for an audit connection, so a burst
// queues on the audit pool alone — and a denial that waited past that pool's
// `connectionTimeoutMillis` answered 403 with no row (the pool's timeout is now 10 s).
//
// This fires the whole per-minute allowance of role denials at once and counts rows. It
// passed before the timeout change too — the one lost row seen in #154's review came from
// wrong-PIN denials with argon2 on the event loop, which `consumeAttempt` now caps — so it is
// a regression pin, not a reproduction. Probe knobs (opt-in, not for CI):
// `PROBE_PLAN=loadtest PROBE_BURST=1000` lifts the route limit; measured 1000 rows / 6.2 s.
describe('a burst of void role denials keeps every audit row (#175, e2e)', () => {
  const TENANT = '17517517-5175-4175-8175-175175175175';
  // The `demo` plan's per-route allowance: all of it reaches auditDenial.
  const BURST = Number(process.env.PROBE_BURST ?? 300);

  let app: INestApplication;
  let admin: DataSource;
  let cache: Redis;
  let cashierToken: string;

  beforeAll(async () => {
    const before = process.env.DB_POOL_SIZE;
    process.env.DB_POOL_SIZE = '2';
    try {
      ({ app, admin, cache } = await createTestApp());
    } finally {
      if (before === undefined) delete process.env.DB_POOL_SIZE;
      else process.env.DB_POOL_SIZE = before;
    }
    const t = await resetTenant(admin, TENANT, { cache });
    if (process.env.PROBE_PLAN) {
      await admin.query(`UPDATE tenants SET plan = $2 WHERE id = $1::uuid`, [
        TENANT,
        process.env.PROBE_PLAN,
      ]);
    }
    cashierToken = accessToken({
      tenantId: TENANT,
      userId: t.userId,
      role: 'cashier',
      deviceId: t.posDeviceId,
      deviceRole: 'pos',
    });
  });

  afterAll(async () => {
    await resetTenant(admin, TENANT, { cache });
    await admin.query(`DELETE FROM tenants WHERE id = $1::uuid`, [TENANT]);
    await app.close();
  });

  it(`answers ${BURST} concurrent role denials with ${BURST} rows`, async () => {
    const server = app.getHttpServer();
    const started = Date.now();
    const responses = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        request(server)
          .post(`/api/v1/sales/${randomUUID()}/void`)
          .set('Authorization', `Bearer ${cashierToken}`)
          .set('Idempotency-Key', `k-burst-${i}-${started}`)
          .send({ pin: '0000' }),
      ),
    );
    const elapsed = Date.now() - started;

    const codes = new Map<number, number>();
    for (const r of responses) codes.set(r.status, (codes.get(r.status) ?? 0) + 1);
    const forbidden = codes.get(403) ?? 0;

    const [{ n }] = (await admin.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE tenant_id = $1::uuid AND action = 'sale.void.denied'`,
      [TENANT],
    )) as { n: number }[];
    process.stderr.write(
      `PROBE ${BURST} role denials: ${JSON.stringify(Object.fromEntries(codes))} rows=${n} ${elapsed} ms\n`,
    );

    // Every refusal is a 403 (none rate limited, none a 500), and every 403 left its row.
    expect(forbidden).toBe(BURST);
    expect(n).toBe(forbidden);
  }, 60_000);
});
