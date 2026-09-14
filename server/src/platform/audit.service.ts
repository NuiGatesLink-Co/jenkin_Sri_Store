import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import * as net from 'node:net';

export interface AuditLogInput {
  tenantId: string;
  platformAdminId?: string;
  userId?: string;
  deviceId?: string;
  action: string;
  entity?: string;
  entityId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string;
}

@Injectable()
export class AuditService {
  /** Pass the business transaction's manager so a failed audit rolls the write back (#123). */
  async log(runner: EntityManager | DataSource, input: AuditLogInput): Promise<void> {
    let cleanIp: string | null = null;
    if (input.ip) {
      const candidate = input.ip.split(',')[0].trim();
      // Node accepts an IPv6 zone id (`fe80::1%eth0`); Postgres `inet` does not, and a
      // failed insert here rolls the whole platform write back.
      if (candidate && !candidate.includes('%') && net.isIP(candidate) !== 0) {
        cleanIp = candidate;
      }
    }

    await runner.query(
      `INSERT INTO audit_log (tenant_id, platform_admin_id, user_id, device_id, action, entity, entity_id, before, after, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.tenantId,
        input.platformAdminId ?? null,
        input.userId ?? null,
        input.deviceId ?? null,
        input.action,
        input.entity ?? null,
        input.entityId ?? null,
        input.before ? JSON.stringify(input.before) : null,
        input.after ? JSON.stringify(input.after) : null,
        cleanIp,
      ],
    );
  }
}
