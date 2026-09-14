import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import request from 'supertest';
import { accessToken, createTestApp, resetTenant } from './support/fixture.js';

// The manager-PIN lockout under a concurrent burst (#154 review, B1).
//
// Before tx.5 the lockout was check-then-increment (`getFailureStatus` → argon2 →
// `recordFailure`), and what kept it honest was the pool: the check and the verify ran inside
// the claim's transaction, so at most `DB_POOL_SIZE` guesses were ever between check and count.
// tx.5 moved argon2 out of the transaction, which removed that bound — the review's probe got
// 60 verifies out of 60 concurrent wrong PINs at pool 2 (and 150 of 150 at pool 15). The lockout
// is now `consumeAttempt`, one atomic Redis INCR per guess before any verify, so the bound is
// the limit itself, whatever the pool.
describe('the void manager-PIN lockout holds under a concurrent burst (e2e, #154)', () => {
  const TENANT = '15415415-5555-4555-8555-154154154154';
  const PIN = '4242';
  const BURST = 40;
  const LIMIT = 5;

  let app: INestApplication;
  let admin: DataSource;
  let cache: Redis;
  let managerToken: string;

  beforeAll(async () => {
    // A small pool, where main's bound was two guesses at a time — so a regression cannot hide
    // behind a pool that happens to be small enough.
    const before = process.env.DB_POOL_SIZE;
    process.env.DB_POOL_SIZE = '2';
    try {
      ({ app, admin, cache } = await createTestApp());
    } finally {
      if (before === undefined) delete process.env.DB_POOL_SIZE;
      else process.env.DB_POOL_SIZE = before;
    }
    const t = await resetTenant(admin, TENANT, { pin: PIN, cache });
    managerToken = accessToken({
      tenantId: TENANT,
      userId: t.userId,
      role: 'manager',
      deviceId: t.posDeviceId,
      deviceRole: 'pos',
    });
  });

  afterAll(async () => {
    await resetTenant(admin, TENANT, { cache });
    await admin.query(`DELETE FROM tenants WHERE id = $1::uuid`, [TENANT]);
    await app.close();
  });

  // Runs first, on the same user as the burst below: a no-PIN refusal gives its attempt back,
  // so it is never a lockout — and the burst's exact count proves the counter came back to 0.
  it('a user with no PIN set is refused 403 no-pin every time, never locked out', async () => {
    const [{ pin_hash: saved }] = (await admin.query(
      `SELECT pin_hash FROM users WHERE tenant_id = $1::uuid`,
      [TENANT],
    )) as { pin_hash: string }[];
    await admin.query(
      `UPDATE users SET pin_hash = NULL WHERE tenant_id = $1::uuid`,
      [TENANT],
    );
    try {
      const statuses: number[] = [];
      for (let i = 0; i < LIMIT + 3; i++) {
        const r = await request(app.getHttpServer())
          .post(`/api/v1/sales/${randomUUID()}/void`)
          .set('Authorization', `Bearer ${managerToken}`)
          .set('Idempotency-Key', `k-no-pin-${i}-${Date.now()}`)
          .send({ pin: PIN });
        statuses.push(r.status);
      }
      expect(statuses).toEqual(Array(LIMIT + 3).fill(403));
      const [{ n }] = (await admin.query(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE tenant_id = $1::uuid AND action = 'sale.void.denied' AND after->>'reason' = 'no-pin'`,
        [TENANT],
      )) as { n: number }[];
      expect(n).toBe(LIMIT + 3);
    } finally {
      await admin.query(
        `UPDATE users SET pin_hash = $2 WHERE tenant_id = $1::uuid`,
        [TENANT, saved],
      );
    }
  });

  it(`${BURST} concurrent wrong-PIN voids: exactly ${LIMIT} reach argon2, the rest are 429`, async () => {
    let seq = 0;
    const server = app.getHttpServer();
    const res = await Promise.all(
      Array.from({ length: BURST }, () =>
        request(server)
          .post(`/api/v1/sales/${randomUUID()}/void`)
          .set('Authorization', `Bearer ${managerToken}`)
          .set('Idempotency-Key', `k-pin-burst-${++seq}-${Date.now()}`)
          .send({ pin: String(1000 + seq) }),
      ),
    );
    const statuses: Record<number, number> = {};
    for (const r of res) statuses[r.status] = (statuses[r.status] ?? 0) + 1;

    // Every `pin` denial row is one argon2 verify that ran.
    const [{ n }] = (await admin.query(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE tenant_id = $1::uuid AND action = 'sale.void.denied' AND after->>'reason' = 'pin'`,
      [TENANT],
    )) as { n: number }[];
    console.log(
      `BURST pool=2 N=${BURST}: statuses ${JSON.stringify(statuses)}, pin verifies ${n}`,
    );

    expect(statuses).toEqual({ 403: LIMIT, 429: BURST - LIMIT });
    expect(n).toBe(LIMIT);
  });
});
