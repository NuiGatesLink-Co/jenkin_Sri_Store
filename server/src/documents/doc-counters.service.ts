import { Injectable } from '@nestjs/common';
import { DeviceRoleForbiddenException } from '../common/device-role-forbidden.exception.js';
import { currentRequestContext } from '../common/request-context.js';
import { TenantService } from '../common/database/tenant.service.js';
import type { DocType } from './doc-number.service.js';

export interface DocCounter {
  docType: DocType;
  period: string;
  lastNo: number;
}

/**
 * `GET /doc-counters` — what the `pos` device seeds its Drift counter from (ADR-0007
 * *"ช่องพังที่ต้องปิดก่อนเฟส 2"* item 1, #188).
 *
 * - `deviceNo` — the series the device prints into; the client keys its counter on it.
 * - `period` — the tenant's current Buddhist year-month, computed exactly as
 *   `DocNumberService.issue` does, so the client records *this* as the seeded period
 *   instead of guessing the month from its own clock and timezone.
 * - `counters` — every period's high-water mark for this device, not only the current
 *   one: a month boundary between the server's `now()` and the client's must not drop
 *   the row the client is still numbering in, and one device writes at most five rows a
 *   month, so there is nothing to page.
 */
export interface DocCounters {
  deviceNo: number;
  period: string;
  counters: DocCounter[];
}

@Injectable()
export class DocCountersService {
  constructor(private readonly tenants: TenantService) {}

  /** The calling device's counters. `deviceId` is the token's `did` — never a parameter. */
  forDevice(deviceId: string): Promise<DocCounters> {
    return this.tenants.runTx(() => this.forDeviceIn(deviceId));
  }

  private async forDeviceIn(deviceId: string): Promise<DocCounters> {
    const { tenantId, manager } = currentRequestContext();
    // `doc_counters.device_id` holds `devices.id` (the token's `did`), which is what
    // `DocNumberService.issue` writes; `device_no` lives only on `devices`.
    const heads = (await manager.query(
      `SELECT d.device_no,
              (EXTRACT(YEAR FROM now() AT TIME ZONE t.timezone)::int + 543)
              || '-' || to_char(now() AT TIME ZONE t.timezone, 'MM') AS period
         FROM devices d
         JOIN tenants t ON t.id = d.tenant_id
        WHERE d.tenant_id = $1::uuid AND d.id = $2`,
      [tenantId, deviceId],
    )) as { device_no: number; period: string }[];
    if (heads.length === 0) throw new DeviceRoleForbiddenException();

    const rows = (await manager.query(
      `SELECT doc_type, period, last_no
         FROM doc_counters
        WHERE tenant_id = $1::uuid AND device_id = $2
        ORDER BY period, doc_type`,
      [tenantId, deviceId],
    )) as { doc_type: DocType; period: string; last_no: number }[];

    return {
      deviceNo: heads[0].device_no,
      period: heads[0].period,
      counters: rows.map((r) => ({
        docType: r.doc_type,
        period: r.period,
        lastNo: r.last_no,
      })),
    };
  }
}
