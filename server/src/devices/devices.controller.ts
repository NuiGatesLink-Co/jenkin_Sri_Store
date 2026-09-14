import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { clientIp } from '../common/client-ip.js';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { toSatang } from '../common/money.js';
import { idempotencyParamsOf } from '../idempotency/idempotency.runner.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import {
  DevicesService,
  type Device,
  type DeviceActor,
  type DeviceRole,
} from './devices.service.js';

interface AuthenticatedRequest extends Request {
  user: { userId: string; role?: string; deviceId?: string };
}

const LABEL_MAX_LENGTH = 100;

/**
 * `/devices` (ADR-0004 "การผูกเครื่อง", 02_API_SCREENS.md §4.2). **`owner` only** — ADR-0004
 * sets it there "until the shop answers" whether a manager may move the till too. Both device
 * roles, and a session with no device token, may call it: the owner does this from Settings on
 * whatever machine is at hand, and a broken `pos` is the usual reason to be here at all.
 */
@Controller('devices')
@UseGuards(TenantGuard)
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  list(@Req() req: AuthenticatedRequest): Promise<Device[]> {
    requireOwner(req);
    return this.devices.list();
  }

  /**
   * `{label, role}` → `{device, enrolCode}`. The code is shown once to the owner and typed
   * into the new browser, which calls `POST /auth/device`. There is no `id` or `deviceNo` in
   * the body, ever — `did` comes from the server (ADR-0004).
   */
  @Post()
  create(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ device: Device; enrolCode: string }> {
    return this.idempotency.runIdempotent(
      idempotencyParamsOf(req, 201),
      res,
      () => {
        requireOwner(req);
        const b = asObject(body);
        if (typeof b.label !== 'string' || b.label.trim() === '') {
          throw new BadRequestException('label is required');
        }
        const label = b.label.trim();
        if (label.length > LABEL_MAX_LENGTH) {
          throw new BadRequestException(`label must be at most ${LABEL_MAX_LENGTH} characters`);
        }
        if (b.role !== 'pos' && b.role !== 'backoffice') {
          throw new BadRequestException(`role must be 'pos' or 'backoffice'`);
        }
        return this.devices.create(actorOf(req), { label, role: b.role as DeviceRole });
      },
    );
  }

  /**
   * `{physicalCash?}` — required only when the device still has an open drawer
   * (`409 PHYSICAL_CASH_REQUIRED` otherwise, answered from inside the transaction, since only
   * the locked shift row can say whether it is open).
   */
  @Post(':id/retire')
  @HttpCode(200)
  retire(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.idempotency.runIdempotent(
      idempotencyParamsOf(req, 200),
      res,
      () => {
        requireOwner(req);
        const b = body === undefined || body === null ? {} : asObject(body);
        let physicalCash: number | null = null;
        if (b.physicalCash !== undefined && b.physicalCash !== null && b.physicalCash !== '') {
          physicalCash = toSatang(b.physicalCash, 'physicalCash');
          if (physicalCash < 0) throw new BadRequestException('physicalCash must not be negative');
        }
        return this.devices.retire(actorOf(req), id, physicalCash);
      },
    );
  }
}

function requireOwner(req: AuthenticatedRequest): void {
  if (req.user?.role !== 'owner') {
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Owner role required' });
  }
}

function actorOf(req: AuthenticatedRequest): DeviceActor {
  return {
    userId: req.user.userId,
    deviceId: req.user.deviceId,
    ip: clientIp(req) ?? undefined,
  };
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('body must be an object');
  }
  return body as Record<string, unknown>;
}
