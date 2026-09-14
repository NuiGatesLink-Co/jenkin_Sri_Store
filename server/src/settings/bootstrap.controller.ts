import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { SettingsService, type BootstrapData } from './settings.service.js';

@Controller('bootstrap')
@UseGuards(TenantGuard)
export class BootstrapController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async getBootstrap(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BootstrapData | void> {
    const data = await this.settingsService.getBootstrap();
    const bodyStr = JSON.stringify(data);
    const hash = createHash('sha256').update(bodyStr).digest('hex');
    const etag = `"${hash}"`;

    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);

    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch) {
      const rawMatch = Array.isArray(ifNoneMatch) ? ifNoneMatch[0] : ifNoneMatch;
      const normalized = rawMatch.replace(/^W\//, '').trim();
      if (normalized === etag || normalized === hash || normalized === `"${hash}"` || normalized === '*') {
        res.status(304);
        return;
      }
    }

    return data;
  }
}
