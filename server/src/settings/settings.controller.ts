import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Patch,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor.js';
import { parseSettingsPatch, type Settings } from './settings.dto.js';
import { SettingsService } from './settings.service.js';

interface AuthenticatedRequest extends Request {
  user?: { role?: string };
}

@Controller('settings')
@UseGuards(TenantGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async getSettings(@Res({ passthrough: true }) res: Response): Promise<Settings> {
    const result = await this.settingsService.getSettingsCached();
    res.setHeader('X-Cache', result.fromCache ? 'HIT' : 'MISS');
    return result.settings;
  }

  @Patch()
  @UseInterceptors(IdempotencyInterceptor)
  updateSettings(
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<Settings> {
    requireManager(req);
    return this.settingsService.updateSettings(parseSettingsPatch(body));
  }
}

function requireManager(req: AuthenticatedRequest): void {
  if (req.user?.role !== 'manager' && req.user?.role !== 'owner') {
    throw new ForbiddenException({
      code: 'FORBIDDEN',
      message: 'Manager role required',
    });
  }
}
