import { describe, it, expect, vi } from 'vitest';
import { AuditService } from './audit.service.js';

describe('AuditService', () => {
  it('writes structured log with valid IPv4', async () => {
    const managerMock = {
      query: vi.fn().mockResolvedValue([]),
    };
    const auditService = new AuditService();

    await auditService.log(managerMock as any, {
      tenantId: 't1',
      userId: 'u1',
      action: 'auth.login',
      ip: '192.168.1.50',
    });

    expect(managerMock.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_log'),
      expect.arrayContaining(['t1', 'u1', null, null, 'auth.login', null, null, null, null, '192.168.1.50']),
    );
  });

  it('stores null for a raw proxy chain (controllers resolve it with clientIp, #132)', async () => {
    const managerMock = {
      query: vi.fn().mockResolvedValue([]),
    };
    const auditService = new AuditService();

    await auditService.log(managerMock as any, {
      tenantId: 't1',
      userId: 'u1',
      action: 'auth.login',
      ip: '203.0.113.195, 70.41.3.18',
    });

    const params = managerMock.query.mock.calls[0][1] as unknown[];
    expect(params[9]).toBeNull();
  });

  it('sets cleanIp to null when IP string is invalid or malformed', async () => {
    const managerMock = {
      query: vi.fn().mockResolvedValue([]),
    };
    const auditService = new AuditService();

    await auditService.log(managerMock as any, {
      tenantId: 't1',
      userId: 'u1',
      action: 'auth.login',
      ip: 'invalid-ip-string',
    });

    expect(managerMock.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO audit_log'),
      expect.arrayContaining(['t1', 'u1', null, null, 'auth.login', null, null, null, null, null]),
    );
  });
});
