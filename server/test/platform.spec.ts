import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { signJwt } from '../src/common/jwt.js';
import { hashPassword } from '../src/common/password.js';
import { PlatformAuthGuard } from '../src/platform/platform-auth.guard.js';
import { PlatformAuthService } from '../src/platform/platform-auth.service.js';
import { PlatformTenantsService, SEED_CATEGORIES } from '../src/platform/platform-tenants.service.js';
import { TenantImportService } from '../src/platform/tenant-import.service.js';
import { AuditService } from '../src/platform/audit.service.js';

const mockConfig = {
  port: 3000,
  instanceId: 'test',
  logLevel: 'info',
  databaseUrl: 'postgres://localhost:5432/test',
  adminDatabaseUrl: 'postgres://localhost:5432/test',
  dbPoolSize: 5,
  redisCacheUrl: 'redis://localhost:6379',
  redisQueueUrl: 'redis://localhost:6379',
  jwtPlatformSecret: 'test-platform-secret',
  jwtTenantSecret: 'test-tenant-secret',
};

describe('Platform Realm & Tenant Provisioning (#5, #123)', () => {
  let auditService: AuditService;
  let mockAdminDs: any;
  let mockRedisCache: any;
  let tenantCache: { invalidate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockAdminDs = {
      query: vi.fn(),
      transaction: vi.fn(async (cb) => cb(mockAdminDs)),
    };
    mockRedisCache = {
      get: vi.fn().mockResolvedValue(null),
      setex: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
    };
    auditService = new AuditService();
    tenantCache = { invalidate: vi.fn() };
  });

  describe('AuditService', () => {
    it('executes the insert on the runner it is given', async () => {
      const managerMock = { query: vi.fn().mockResolvedValue([]) };
      await auditService.log(managerMock as any, {
        tenantId: 't1',
        platformAdminId: 'adm1',
        action: 'test.action',
        ip: '192.168.1.1',
      });

      expect(managerMock.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_log'),
        expect.arrayContaining(['t1', 'adm1', null, null, 'test.action', null, null, null, null, '192.168.1.1']),
      );
      expect(mockAdminDs.query).not.toHaveBeenCalled();
    });

    it('cleans proxy IP chain before inserting', async () => {
      const managerMock = { query: vi.fn().mockResolvedValue([]) };
      await auditService.log(managerMock as any, {
        tenantId: 't1',
        platformAdminId: 'adm1',
        action: 'test.action',
        ip: '203.0.113.195, 70.41.3.18',
      });

      expect(managerMock.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_log'),
        expect.arrayContaining(['203.0.113.195']),
      );
    });

    it('drops an IPv6 zone id that Postgres inet would reject', async () => {
      const managerMock = { query: vi.fn().mockResolvedValue([]) };
      await auditService.log(managerMock as any, {
        tenantId: 't1',
        platformAdminId: 'adm1',
        action: 'test.action',
        ip: 'fe80::1%eth0',
      });

      const params = managerMock.query.mock.calls[0][1] as unknown[];
      expect(params[9]).toBeNull();
    });
  });

  describe('PlatformAuthGuard', () => {
    let guard: PlatformAuthGuard;

    beforeEach(() => {
      guard = new PlatformAuthGuard(mockConfig, mockAdminDs, mockRedisCache);
    });

    it('rejects missing Authorization header', async () => {
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: {} }),
        }),
      } as any;

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects tenant JWT token with aud != platform', async () => {
      const tenantToken = signJwt(
        { aud: 'tenant', tid: 't1', sub: 'u1' },
        mockConfig.jwtPlatformSecret,
      );
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: `Bearer ${tenantToken}` },
          }),
        }),
      } as any;

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('allows valid platform JWT when admin exists in Redis cache', async () => {
      mockRedisCache.get.mockResolvedValueOnce('1');
      const platformToken = signJwt(
        { aud: 'platform', sub: 'adm1', username: 'admin' },
        mockConfig.jwtPlatformSecret,
      );
      const req = {
        headers: { authorization: `Bearer ${platformToken}` },
      } as any;
      const context = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as any;

      expect(await guard.canActivate(context)).toBe(true);
      expect(req.platformAdmin).toEqual({ id: 'adm1', username: 'admin' });
      expect(mockAdminDs.query).not.toHaveBeenCalled();
    });

    it('verifies against DB and populates Redis cache (60s TTL) when Redis misses', async () => {
      mockRedisCache.get.mockResolvedValueOnce(null);
      mockAdminDs.query.mockResolvedValueOnce([{ id: 'adm1' }]);

      const platformToken = signJwt(
        { aud: 'platform', sub: 'adm1', username: 'admin' },
        mockConfig.jwtPlatformSecret,
      );
      const req = {
        headers: { authorization: `Bearer ${platformToken}` },
      } as any;
      const context = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as any;

      expect(await guard.canActivate(context)).toBe(true);
      expect(mockRedisCache.setex).toHaveBeenCalledWith('pa:adm1:exists', 60, '1');
    });

    it('rejects with UnauthorizedException when admin is cached as inactive or deleted (0)', async () => {
      mockRedisCache.get.mockResolvedValueOnce('0');
      const platformToken = signJwt(
        { aud: 'platform', sub: 'adm1', username: 'admin' },
        mockConfig.jwtPlatformSecret,
      );
      const req = {
        headers: { authorization: `Bearer ${platformToken}` },
      } as any;
      const context = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as any;

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects with UnauthorizedException and caches 0 when admin not in DB', async () => {
      mockRedisCache.get.mockResolvedValueOnce(null);
      mockAdminDs.query.mockResolvedValueOnce([]);

      const platformToken = signJwt(
        { aud: 'platform', sub: 'adm1', username: 'admin' },
        mockConfig.jwtPlatformSecret,
      );
      const req = {
        headers: { authorization: `Bearer ${platformToken}` },
      } as any;
      const context = {
        switchToHttp: () => ({ getRequest: () => req }),
      } as any;

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      expect(mockRedisCache.setex).toHaveBeenCalledWith('pa:adm1:exists', 60, '0');
    });
  });

  describe('PlatformAuthService', () => {
    it('authenticates admin, returns token, and writes audit log', async () => {
      const passHash = await hashPassword('secret123');
      mockAdminDs.query.mockResolvedValueOnce([
        { id: 'adm1', username: 'superadmin', password_hash: passHash, display_name: 'Admin', is_active: true },
      ]);

      const authService = new PlatformAuthService(mockAdminDs, mockConfig, auditService);
      const result = await authService.login('superadmin', 'secret123', '127.0.0.1');

      expect(result.token).toBeDefined();
      expect(result.admin.username).toBe('superadmin');
      expect(mockAdminDs.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO audit_log'),
        expect.arrayContaining(['00000000-0000-0000-0000-000000000000', 'adm1', null, null, 'platform.auth.login']),
      );
    });

    it('rejects invalid password', async () => {
      const passHash = await hashPassword('secret123');
      mockAdminDs.query.mockResolvedValueOnce([
        { id: 'adm1', username: 'superadmin', password_hash: passHash, display_name: 'Admin', is_active: true },
      ]);

      const authService = new PlatformAuthService(mockAdminDs, mockConfig, auditService);
      await expect(authService.login('superadmin', 'wrongpass')).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('PlatformTenantsService', () => {
    it('creates tenant in 1 transaction including audit log with 5 seed categories and initial POS device', async () => {
      mockAdminDs.query
        .mockResolvedValueOnce([{ id: 'tenant-123' }]) // INSERT INTO tenants
        .mockResolvedValueOnce([]) // INSERT INTO users
        .mockResolvedValueOnce([]) // INSERT INTO settings
        .mockResolvedValue([]) // INSERT INTO categories (5x)
        .mockResolvedValueOnce([]) // INSERT INTO devices
        .mockResolvedValueOnce([]); // INSERT INTO audit_log

      const service = new PlatformTenantsService(mockAdminDs, mockRedisCache, auditService);
      const result = await service.createTenant(
        {
          code: 'shop01',
          shopName: 'ร้านอะไหล่ 1',
          ownerUsername: 'owner1',
          ownerPassword: 'pass123',
          ownerDisplayName: 'เจ้าของร้าน',
        },
        'adm1',
      );

      expect(result.tenantId).toBe('tenant-123');
      expect(result.enrolCode).toBeDefined();
      expect(mockAdminDs.transaction).toHaveBeenCalled();

      // Verify seed categories were inserted
      const categoryCalls = mockAdminDs.query.mock.calls.filter((c: any) =>
        c[0].includes('INSERT INTO categories'),
      );
      expect(categoryCalls).toHaveLength(5);
      expect(categoryCalls.map((c: any) => c[1][1])).toEqual([...SEED_CATEGORIES]);

      // Verify audit log was executed inside transaction on manager
      const auditCalls = mockAdminDs.query.mock.calls.filter((c: any) =>
        c[0].includes('INSERT INTO audit_log'),
      );
      expect(auditCalls).toHaveLength(1);
      expect(auditCalls[0][1]).toEqual(
        expect.arrayContaining(['tenant-123', 'adm1', null, null, 'platform.tenant.create']),
      );
    });

    it('rolls back and propagates error if audit logging fails during tenant creation', async () => {
      mockAdminDs.query
        .mockResolvedValueOnce([{ id: 'tenant-123' }]) // INSERT INTO tenants
        .mockResolvedValueOnce([]) // INSERT INTO users
        .mockResolvedValueOnce([]) // INSERT INTO settings
        .mockResolvedValue([]) // INSERT INTO categories
        .mockResolvedValueOnce([]); // INSERT INTO devices

      // Simulate FK violation or DB error during audit logging inside transaction
      vi.spyOn(auditService, 'log').mockRejectedValueOnce(new Error('FK constraint violation on platform_admin_id'));

      const service = new PlatformTenantsService(mockAdminDs, mockRedisCache, auditService);
      await expect(
        service.createTenant(
          {
            code: 'shop02',
            shopName: 'ร้านอะไหล่ 2',
            ownerUsername: 'owner2',
            ownerPassword: 'pass123',
            ownerDisplayName: 'เจ้าของร้าน 2',
          },
          'deleted-adm',
        ),
      ).rejects.toThrow('FK constraint violation');
    });

    it('updates tenant status inside transaction and immediately purges Redis cache key', async () => {
      mockAdminDs.query.mockResolvedValueOnce([{ id: 't1', status: 'suspended' }]);

      const service = new PlatformTenantsService(mockAdminDs, mockRedisCache, auditService);
      const res = await service.updateStatus('t1', 'suspended', 'adm1');

      expect(res).toEqual({ tenantId: 't1', status: 'suspended' });
      expect(mockAdminDs.transaction).toHaveBeenCalled();
      expect(mockRedisCache.del).toHaveBeenCalledWith('t:t1:status');
    });

    it('does not purge Redis status cache if updateStatus transaction fails', async () => {
      mockAdminDs.transaction.mockRejectedValueOnce(new Error('Transaction rolled back'));

      const service = new PlatformTenantsService(mockAdminDs, mockRedisCache, auditService);
      await expect(service.updateStatus('t1', 'suspended', 'adm1')).rejects.toThrow('Transaction rolled back');
      expect(mockRedisCache.del).not.toHaveBeenCalled();
    });

    it('listTenants returns list even if audit logging fails (AC4)', async () => {
      mockAdminDs.query.mockResolvedValueOnce([
        { id: 't1', code: 'shop1', shop_name: 'Shop 1' },
      ]);
      vi.spyOn(auditService, 'log').mockRejectedValueOnce(new Error('Audit DB write error'));

      const service = new PlatformTenantsService(mockAdminDs, mockRedisCache, auditService);
      const res = await service.listTenants('adm1');

      expect(res).toEqual([{ id: 't1', code: 'shop1', shop_name: 'Shop 1' }]);
    });
  });

  describe('TenantImportService', () => {
    it('rejects import if tenant already has sales or transactional data', async () => {
      mockAdminDs.query.mockResolvedValueOnce([{ n: 1 }]);

      const importService = new TenantImportService(mockAdminDs, auditService, tenantCache as any);
      await expect(
        importService.importSnapshot(
          't1',
          { __meta: { version: 2 }, sa_products: [] },
          'adm1',
        ),
      ).rejects.toThrow(ConflictException);
      expect(tenantCache.invalidate).not.toHaveBeenCalled();
    });

    it('pre-flight scan rejects negative product stock', async () => {
      mockAdminDs.query.mockResolvedValue([{ n: 0 }]);

      const importService = new TenantImportService(mockAdminDs, auditService, tenantCache as any);
      await expect(
        importService.importSnapshot(
          't1',
          {
            __meta: { version: 2 },
            sa_products: [{ id: 'p1', stock: -5, name: 'Negative Stock Product' }],
          },
          'adm1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('pre-flight scan rejects part numbers that differ only by case', async () => {
      mockAdminDs.query.mockResolvedValue([{ n: 0 }]);

      const importService = new TenantImportService(mockAdminDs, auditService, tenantCache as any);
      await expect(
        importService.importSnapshot(
          't1',
          {
            __meta: { version: 2 },
            sa_products: [
              { id: 'p1', partNo: 'BP-1', stock: 1 },
              { id: 'p2', partNo: 'bp-1', stock: 1 },
            ],
          },
          'adm1',
        ),
      ).rejects.toThrow("products 'p1', 'p2' share part number 'bp-1'");
      expect(mockAdminDs.transaction).not.toHaveBeenCalled();
    });

    it('imports snapshot cleanly and executes audit log inside transaction', async () => {
      mockAdminDs.query.mockResolvedValue([{ n: 0 }]);

      const importService = new TenantImportService(mockAdminDs, auditService, tenantCache as any);
      const res = await importService.importSnapshot(
        't1',
        {
          __meta: { version: 2 },
          sa_products: [{ id: 'p1', name: 'Brake Pad', stock: 10, price: 500 }],
          sa_categories: [{ name: 'เบรก', position: 0 }],
          sa_customers: [{ id: 'c1', name: 'Customer A' }],
        },
        'adm1',
      );

      expect(res.status).toBe('success');
      expect(mockAdminDs.transaction).toHaveBeenCalled();
      // Audit log was called on transaction manager
      const auditCalls = mockAdminDs.query.mock.calls.filter((c: any) =>
        c[0].includes('INSERT INTO audit_log'),
      );
      expect(auditCalls.length).toBeGreaterThanOrEqual(1);
      // Cache invalidated only after transaction commits
      expect(tenantCache.invalidate).toHaveBeenCalledWith('t1', 'products');
    });

    it('rolls back and does not invalidate cache if audit log fails during import', async () => {
      mockAdminDs.query.mockResolvedValue([{ n: 0 }]);
      vi.spyOn(auditService, 'log').mockRejectedValueOnce(new Error('Audit write failed'));

      const importService = new TenantImportService(mockAdminDs, auditService, tenantCache as any);
      await expect(
        importService.importSnapshot(
          't1',
          {
            __meta: { version: 2 },
            sa_products: [{ id: 'p1', name: 'Brake Pad', stock: 10, price: 500 }],
          },
          'adm1',
        ),
      ).rejects.toThrow('Audit write failed');

      expect(tenantCache.invalidate).not.toHaveBeenCalled();
    });
  });
});
