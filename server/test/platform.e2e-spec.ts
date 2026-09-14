import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { signJwt } from '../src/common/jwt.js';
import { hashPassword } from '../src/common/password.js';
import { APP_CONFIG, type AppConfig } from '../src/config/config.js';
import { createTestApp } from './support/fixture.js';

describe('Platform Realm E2E & Atomic Audit Invariants (#123)', () => {
  let app: INestApplication;
  let adminDs: DataSource;
  let cache: Redis;
  let config: AppConfig;
  let adminId: string;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, admin: adminDs, cache } = await createTestApp());
    config = app.get<AppConfig>(APP_CONFIG);
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    adminId = randomUUID();
    const passHash = await hashPassword('platform-secret-123');

    // Seed platform admin into platform_admins
    await adminDs.query(
      `INSERT INTO platform_admins (id, username, password_hash, display_name, is_active)
       VALUES ($1, $2, $3, $4, true)`,
      [adminId, `admin-${adminId.slice(0, 8)}`, passHash, 'Super Admin'],
    );

    adminToken = signJwt(
      {
        iss: 'srisurart-pos',
        aud: 'platform',
        sub: adminId,
        username: `admin-${adminId.slice(0, 8)}`,
      },
      config.jwtPlatformSecret,
    );
  });

  afterEach(async () => {
    // Clean up cached keys and admin
    await cache.del(`pa:${adminId}:exists`);
    await adminDs.query(`DELETE FROM audit_log WHERE platform_admin_id = $1`, [adminId]);
    await adminDs.query(`DELETE FROM platform_admins WHERE id = $1`, [adminId]);
  });

  describe('PlatformAuthGuard DB validation & Redis caching (AC3)', () => {
    it('allows requests when platform admin exists and caches result in Redis with 60s TTL', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/platform/tenants')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);

      // Verify cached in Redis
      const cached = await cache.get(`pa:${adminId}:exists`);
      expect(cached).toBe('1');
      const ttl = await cache.ttl(`pa:${adminId}:exists`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);
    });

    it('rejects with 401 when platform admin does not exist in platform_admins', async () => {
      const nonExistentAdminId = randomUUID();
      const orphanToken = signJwt(
        {
          iss: 'srisurart-pos',
          aud: 'platform',
          sub: nonExistentAdminId,
          username: 'ghost-admin',
        },
        config.jwtPlatformSecret,
      );

      const res = await request(app.getHttpServer())
        .get('/api/v1/platform/tenants')
        .set('Authorization', `Bearer ${orphanToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('Platform admin does not exist or is inactive');

      // Redis should have cached '0'
      const cached = await cache.get(`pa:${nonExistentAdminId}:exists`);
      expect(cached).toBe('0');
      await cache.del(`pa:${nonExistentAdminId}:exists`);
    });

    it('rejects a tenant create with 401 once the admin is deleted, and writes no tenant', async () => {
      await adminDs.query(`DELETE FROM platform_admins WHERE id = $1`, [adminId]);
      await cache.del(`pa:${adminId}:exists`);
      const code = `gone-${randomUUID().slice(0, 8)}`;

      const res = await request(app.getHttpServer())
        .post('/api/v1/platform/tenants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ code, shopName: 'ร้านทดสอบ', ownerUsername: `owner_${code}`, ownerPassword: 'password123' });

      expect(res.status).toBe(401);
      const tenantRows = await adminDs.query(`SELECT id FROM tenants WHERE code = $1`, [code]);
      expect(tenantRows.length).toBe(0);
    });

    it('rejects with 401 when platform admin is marked inactive', async () => {
      await adminDs.query(`UPDATE platform_admins SET is_active = false WHERE id = $1`, [adminId]);
      await cache.del(`pa:${adminId}:exists`);

      const res = await request(app.getHttpServer())
        .get('/api/v1/platform/tenants')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain('Platform admin does not exist or is inactive');
    });
  });

  describe('Atomic Audit Logging in createTenant (AC2)', () => {
    it('creates tenant and writes audit log atomically inside the same transaction', async () => {
      const code = `t-${randomUUID().slice(0, 8)}`;
      const res = await request(app.getHttpServer())
        .post('/api/v1/platform/tenants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code,
          shopName: 'ร้านทดสอบ อะตอมมิก',
          ownerUsername: `owner_${code}`,
          ownerPassword: 'password123',
          ownerDisplayName: 'เจ้าของร้าน',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.tenantId).toBeDefined();
      const tenantId = res.body.data.tenantId;

      // Verify audit_log entry was written
      const auditRows = await adminDs.query(
        `SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'platform.tenant.create'`,
        [tenantId],
      );
      expect(auditRows.length).toBe(1);
      expect(auditRows[0].platform_admin_id).toBe(adminId);

      // Clean up tenant
      await adminDs.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenantId]);
      await adminDs.query(`DELETE FROM devices WHERE tenant_id = $1`, [tenantId]);
      await adminDs.query(`DELETE FROM categories WHERE tenant_id = $1`, [tenantId]);
      await adminDs.query(`DELETE FROM settings WHERE tenant_id = $1`, [tenantId]);
      await adminDs.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
      await adminDs.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    });

    it('rolls back tenant creation completely when audit log fails (e.g. FK violation on platform_admin_id)', async () => {
      // In this test, we verify that if the audit log query fails inside the transaction,
      // the entire transaction rolls back and no tenant or user remains.
      const code = `rollback-${randomUUID().slice(0, 8)}`;

      // Use a token with a deleted platform admin, but bypass the guard check by pre-populating the Redis cache with '1'
      const deletedAdminId = randomUUID();
      await cache.setex(`pa:${deletedAdminId}:exists`, 60, '1');

      const deletedAdminToken = signJwt(
        {
          iss: 'srisurart-pos',
          aud: 'platform',
          sub: deletedAdminId,
          username: 'deleted-admin',
        },
        config.jwtPlatformSecret,
      );

      const res = await request(app.getHttpServer())
        .post('/api/v1/platform/tenants')
        .set('Authorization', `Bearer ${deletedAdminToken}`)
        .send({
          code,
          shopName: 'ร้านทดสอบ โรลแบ็ค',
          ownerUsername: `owner_${code}`,
          ownerPassword: 'password123',
          ownerDisplayName: 'เจ้าของร้าน',
        });

      // Audit insertion must fail on foreign key constraint `audit_log_platform_admin_id_fkey`
      expect(res.status).toBe(500);

      // Ground-truth check: Ensure NO tenant was created and the code is NOT reserved
      const tenantRows = await adminDs.query(`SELECT id FROM tenants WHERE code = $1`, [code]);
      expect(tenantRows.length).toBe(0);

      const userRows = await adminDs.query(`SELECT id FROM users WHERE username = $1`, [`owner_${code}`]);
      expect(userRows.length).toBe(0);

      await cache.del(`pa:${deletedAdminId}:exists`);
    });
  });

  describe('Atomic updateStatus and cache purge (AC3)', () => {
    it('updates status and purges cache atomically', async () => {
      // Create a tenant first
      const code = `status-${randomUUID().slice(0, 8)}`;
      const createRes = await request(app.getHttpServer())
        .post('/api/v1/platform/tenants')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code,
          shopName: 'ร้านทดสอบ สเตตัส',
          ownerUsername: `owner_${code}`,
          ownerPassword: 'password123',
        });
      const tenantId = createRes.body.data.tenantId;

      // Prime tenant status cache
      await cache.setex(`t:${tenantId}:status`, 300, 'active');

      const patchRes = await request(app.getHttpServer())
        .patch(`/api/v1/platform/tenants/${tenantId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'suspended' });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.status).toBe('suspended');

      // Redis cache must be purged
      const cached = await cache.get(`t:${tenantId}:status`);
      expect(cached).toBeNull();

      // Audit log entry must exist
      const auditRows = await adminDs.query(
        `SELECT * FROM audit_log WHERE tenant_id = $1 AND action = 'platform.tenant.update_status'`,
        [tenantId],
      );
      expect(auditRows.length).toBe(1);

      // Clean up
      await adminDs.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [tenantId]);
      await adminDs.query(`DELETE FROM devices WHERE tenant_id = $1`, [tenantId]);
      await adminDs.query(`DELETE FROM categories WHERE tenant_id = $1`, [tenantId]);
      await adminDs.query(`DELETE FROM settings WHERE tenant_id = $1`, [tenantId]);
      await adminDs.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
      await adminDs.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    });
  });
});
