import { Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ADMIN_DATA_SOURCE } from '../infra/db.module.js';

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
  constructor(
    @Inject(ADMIN_DATA_SOURCE) private readonly adminDs: DataSource,
  ) {}

  /** `manager`: write on the caller's transaction, so the row commits or rolls back with the work. */
  async log(input: AuditLogInput, manager?: EntityManager): Promise<void> {
    await (manager ?? this.adminDs).query(
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
        input.ip ?? null,
      ],
    );
  }
}
