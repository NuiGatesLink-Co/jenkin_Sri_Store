import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor.js';
import { parseSettingsPatch } from './settings.dto.js';
import { SettingsService, type ShopSettings } from './settings.service.js';

interface AuthenticatedRequest extends Request {
  user?: {
    userId?: string;
    role?: string;
  };
}

@Controller('settings')
@UseGuards(TenantGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  getSettings(): Promise<ShopSettings> {
    return this.settingsService.getSettings();
  }

  @Patch()
  @UseInterceptors(IdempotencyInterceptor)
  updateSettings(
    @Req() req: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<ShopSettings> {
    const role = req.user?.role;
    if (role !== 'manager' && role !== 'owner') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Manager role required',
      });
    }

    const dto = parseSettingsPatch(body);
    return this.settingsService.updateSettings(dto);
  }
}
