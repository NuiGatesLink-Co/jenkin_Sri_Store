import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import {
  accessToken,
  createTestApp,
  resetTenant,
  type TenantFixture,
} from './support/fixture.js';

const TENANT = '18181818-1818-4818-8818-181818181818';

describe('bootstrap and settings (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  let cache: import('ioredis').Redis;
  let fixture: TenantFixture;
  let managerToken: string;
  let cashierToken: string;
  let key = 0;

  const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });
  const idempotency = () => `bootstrap-${++key}-${Date.now()}`;

  beforeAll(async () => {
    ({ app, admin, cache } = await createTestApp());
  });

  beforeEach(async () => {
    fixture = await resetTenant(admin, TENANT, { cache });
    managerToken = accessToken({
      tenantId: TENANT,
      userId: fixture.userId,
      role: 'manager',
      deviceId: fixture.backofficeDeviceId,
      deviceRole: 'backoffice',
    });
    cashierToken = accessToken({
      tenantId: TENANT,
      userId: fixture.userId,
      role: 'cashier',
      deviceId: fixture.backofficeDeviceId,
      deviceRole: 'backoffice',
    });
  });

  afterAll(async () => {
    await resetTenant(admin, TENANT);
    await admin.query(`DELETE FROM tenants WHERE id = $1::uuid`, [TENANT]);
    await app.close();
  });

  it('GET /settings returns default or current tenant settings', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/settings')
      .set(auth(cashierToken));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      shopName: expect.any(String),
      shopNameEn: expect.any(String),
      taxRate: expect.any(Number),
      quoteValidDays: expect.any(Number),
    });
  });

  it('PATCH /settings updates settings for manager and refuses non-managers with 403', async () => {
    // Cashier patch -> 403 FORBIDDEN
    const cashierRes = await request(app.getHttpServer())
      .patch('/api/v1/settings')
      .set(auth(cashierToken))
      .set('Idempotency-Key', idempotency())
      .send({ shopName: 'Cashier Shop' });

    expect(cashierRes.status).toBe(403);
    expect(cashierRes.body.error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Manager role required',
    });

    // Manager patch -> 200 OK
    const managerRes = await request(app.getHttpServer())
      .patch('/api/v1/settings')
      .set(auth(managerToken))
      .set('Idempotency-Key', idempotency())
      .send({
        shopName: 'ร้านศรีสุราษฎร์ (สาขาใหญ่)',
        shopNameEn: 'Srisurart Main Branch',
        taxRate: 7,
        quoteValidDays: 15,
        address: '123 ถนนตลาดใหม่',
        phone: '077-123456',
        taxId: '0845555000123',
        branchNo: '00000',
      });

    expect(managerRes.status).toBe(200);
    expect(managerRes.body.data).toMatchObject({
      shopName: 'ร้านศรีสุราษฎร์ (สาขาใหญ่)',
      shopNameEn: 'Srisurart Main Branch',
      taxRate: 7,
      quoteValidDays: 15,
      address: '123 ถนนตลาดใหม่',
      phone: '077-123456',
      taxId: '0845555000123',
      branchNo: '00000',
    });
  });

  it('GET /bootstrap returns aggregated lists and supports ETag / If-None-Match 304', async () => {
    // 1. Seed active and tombstoned products, customers, mechanics
    await admin.query(
      `INSERT INTO products (tenant_id, id, part_no, name, name_th, category, brand, price, cost, stock, min_stock)
       VALUES ($1::uuid, 'p-active', 'P-001', 'Spark Plug', 'หัวเทียน', 'ไฟฟ้า', 'NGK', 100, 50, 10, 2),
              ($1::uuid, 'p-deleted', 'P-002', 'Old Part', 'อะไหล่เก่า', 'ไฟฟ้า', 'NGK', 100, 50, 0, 0)`,
      [TENANT],
    );
    await admin.query(
      `UPDATE products SET deleted_at = NOW() WHERE id = 'p-deleted' AND tenant_id = $1::uuid`,
      [TENANT],
    );

    await admin.query(
      `INSERT INTO customers (tenant_id, id, code, name, name_th)
       VALUES ($1::uuid, 'c-active', 'CUS001', 'Active Customer', 'ลูกค้าปกติ'),
              ($1::uuid, 'c-deleted', 'CUS002', 'Deleted Customer', 'ลูกค้าที่ลบ')`,
      [TENANT],
    );
    await admin.query(
      `UPDATE customers SET deleted_at = NOW() WHERE id = 'c-deleted' AND tenant_id = $1::uuid`,
      [TENANT],
    );

    await admin.query(
      `INSERT INTO mechanics (tenant_id, id, code, name, name_th)
       VALUES ($1::uuid, 'm-active', 'M001', 'Active Mechanic', 'ช่างปกติ'),
              ($1::uuid, 'm-deleted', 'M002', 'Deleted Mechanic', 'ช่างที่ลบ')`,
      [TENANT],
    );
    await admin.query(
      `UPDATE mechanics SET deleted_at = NOW() WHERE id = 'm-deleted' AND tenant_id = $1::uuid`,
      [TENANT],
    );

    // 2. Cold GET /bootstrap -> 200 OK
    const coldRes = await request(app.getHttpServer())
      .get('/api/v1/bootstrap')
      .set(auth(cashierToken));

    expect(coldRes.status).toBe(200);
    expect(coldRes.headers.etag).toBeDefined();

    const data = coldRes.body.data;
    expect(Array.isArray(data.products)).toBe(true);
    expect(Array.isArray(data.categories)).toBe(true);
    expect(Array.isArray(data.customers)).toBe(true);
    expect(Array.isArray(data.mechanics)).toBe(true);
    expect(data.settings).toBeDefined();

    // Verify tombstoned entities are absent
    expect(data.products.some((p: { id: string }) => p.id === 'p-deleted')).toBe(false);
    expect(data.customers.some((c: { id: string }) => c.id === 'c-deleted')).toBe(false);
    expect(data.mechanics.some((m: { id: string }) => m.id === 'm-deleted')).toBe(false);

    // Verify active entities are present
    expect(data.products.some((p: { id: string }) => p.id === 'p-active')).toBe(true);
    expect(data.customers.some((c: { id: string }) => c.id === 'c-active')).toBe(true);
    expect(data.mechanics.some((m: { id: string }) => m.id === 'm-active')).toBe(true);

    const etag = coldRes.headers.etag;

    // 3. Repeat GET /bootstrap with If-None-Match matching ETag -> 304 Not Modified & no body
    const matchRes = await request(app.getHttpServer())
      .get('/api/v1/bootstrap')
      .set(auth(cashierToken))
      .set('If-None-Match', etag);

    expect(matchRes.status).toBe(304);
    expect(matchRes.text).toBe('');

    // 4. Update an entity (e.g. settings) -> ETag changes and 304 becomes 200
    await request(app.getHttpServer())
      .patch('/api/v1/settings')
      .set(auth(managerToken))
      .set('Idempotency-Key', idempotency())
      .send({ shopName: 'Updated Name for ETag Test' });

    const changedRes = await request(app.getHttpServer())
      .get('/api/v1/bootstrap')
      .set(auth(cashierToken))
      .set('If-None-Match', etag);

    expect(changedRes.status).toBe(200);
    expect(changedRes.headers.etag).not.toBe(etag);
    expect(changedRes.body.data.settings.shopName).toBe('Updated Name for ETag Test');
  });
});
