import {
  Controller,
  Get,
  Module,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { TenantService } from '../src/common/database/tenant.service.js';
import { TenantGuard } from '../src/common/guards/tenant.guard.js';
import {
  accessToken,
  createTestApp,
  resetTenant,
  type TenantFixture,
} from './support/fixture.js';

/**
 * A controller no config file knows about: mounted from this test only, guarded like any
 * production controller, reading through `runTx`. Before tx.4 (#153) it would have needed an
 * entry in `app.module.ts`'s `TENANT_ROUTES`, or the guard found no transaction and 500'd.
 */
@Controller('tx4-probe')
@UseGuards(TenantGuard)
class Tx4ProbeController {
  constructor(private readonly tenants: TenantService) {}

  @Get()
  probe(): Promise<{ tenantId: string; users: number }> {
    return this.tenants.runTx(async (manager) => {
      const [row] = (await manager.query(
        `SELECT current_setting('app.tenant_id', true) AS "tenantId",
                (SELECT count(*)::int FROM users) AS users`,
      )) as { tenantId: string; users: number }[];
      return row;
    });
  }
}

/** The same read with no guard: `runTx` has no tenant to name, so it must refuse. */
@Controller('tx4-probe-unguarded')
class UnguardedProbeController {
  constructor(private readonly tenants: TenantService) {}

  @Get()
  probe(): Promise<unknown> {
    return this.tenants.runTx((manager) =>
      manager.query(`SELECT count(*)::int AS n FROM users`),
    );
  }
}

@Module({ controllers: [Tx4ProbeController, UnguardedProbeController] })
class Tx4ProbeModule {}

describe('the tenant scope without a request transaction (e2e, tx.4 #153)', () => {
  const TENANT = '15315315-5555-4555-8555-153153153153';

  let app: INestApplication;
  let ds: DataSource;
  let admin: DataSource;
  let cache: Redis;
  let fixture: TenantFixture;
  let token: string;

  beforeAll(async () => {
    ({ app, ds, admin, cache } = await createTestApp([Tx4ProbeModule]));
  });

  beforeEach(async () => {
    fixture = await resetTenant(admin, TENANT, { cache });
    token = accessToken({
      tenantId: TENANT,
      userId: fixture.userId,
      role: 'manager',
      deviceId: fixture.posDeviceId,
      deviceRole: 'pos',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await resetTenant(admin, TENANT, { cache });
    await admin.query(`DELETE FROM tenants WHERE id = $1::uuid`, [TENANT]);
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('a new TenantGuard controller works with no config entry: the guard names the tenant, runTx applies it', async () => {
    const res = await http()
      .get('/api/v1/tx4-probe')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.tenantId).toBe(TENANT);
    // RLS answered for this tenant: the fixture's manager is visible.
    expect(res.body.data.users).toBeGreaterThan(0);
  });

  it('the same read with no guard is refused, not answered for nobody', async () => {
    // Warm the rate limiter's plan cache, so the only runner that could appear is runTx's.
    await http()
      .get('/api/v1/tx4-probe')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const runners = vi.spyOn(ds, 'createQueryRunner');
    const res = await http()
      .get('/api/v1/tx4-probe-unguarded')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(runners).not.toHaveBeenCalled();
  });

  it('a request the guard refuses takes no connection; a suspended shop is never named', async () => {
    const runners = vi.spyOn(ds, 'createQueryRunner');

    expect((await http().get('/api/v1/tx4-probe')).status).toBe(401);
    expect(
      (
        await http()
          .get('/api/v1/tx4-probe')
          .set('Authorization', 'Bearer not-a-token')
      ).status,
    ).toBe(401);
    expect(runners).not.toHaveBeenCalled();

    await admin.query(
      `UPDATE tenants SET status = 'suspended' WHERE id = $1::uuid`,
      [TENANT],
    );
    await cache.del(`t:${TENANT}:status`);
    const res = await http()
      .get('/api/v1/tx4-probe')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_SUSPENDED');
    // Cold status and plan caches: one pool read each (`SELECT status`, `SELECT plan`), and
    // nothing that opens a transaction for the shop.
    expect(runners.mock.calls.length).toBeLessThanOrEqual(2);
    await admin.query(
      `UPDATE tenants SET status = 'active' WHERE id = $1::uuid`,
      [TENANT],
    );
  });

  it('/health/live touches no Postgres connection and /health/ready exactly one', async () => {
    const runners = vi.spyOn(ds, 'createQueryRunner');

    expect((await http().get('/health/live')).status).toBe(200);
    expect(runners).toHaveBeenCalledTimes(0);

    expect((await http().get('/health/ready')).status).toBe(200);
    // `SELECT 1` through `DataSource.query`, which takes one runner — as on main, where the
    // request-wide transaction was never bound to `/health/*` either.
    expect(runners).toHaveBeenCalledTimes(1);
  });
});
