import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequireDeviceRole } from '../common/decorators/device-role.decorator.js';
import { DeviceRoleForbiddenException } from '../common/device-role-forbidden.exception.js';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor.js';
import {
  ParkedSalesService,
  parseParkBody,
  type ParkedSale,
} from './parked-sales.service.js';

interface AuthenticatedRequest extends Request {
  user: { userId: string; deviceId?: string };
}

/**
 * `pos` only, reads included (02_API_SCREENS.md §4; ADR-0004, settled 2026-09-04:
 * "อะไรก็ตามที่เกี่ยวกับบิล ทำที่เครื่องขาย").
 */
@Controller('parked-sales')
@UseGuards(TenantGuard)
@RequireDeviceRole('pos')
export class ParkedSalesController {
  constructor(private readonly parked: ParkedSalesService) {}

  @Get()
  list(): Promise<ParkedSale[]> {
    return this.parked.list();
  }

  @Post()
  @UseInterceptors(IdempotencyInterceptor)
  park(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<ParkedSale> {
    if (!req.user.deviceId) throw new DeviceRoleForbiddenException();
    return this.parked.park(parseParkBody(body), req.user.deviceId);
  }

  @Delete(':id')
  @HttpCode(200)
  @UseInterceptors(IdempotencyInterceptor)
  remove(@Param('id') id: string): Promise<ParkedSale> {
    return this.parked.remove(id);
  }
}
