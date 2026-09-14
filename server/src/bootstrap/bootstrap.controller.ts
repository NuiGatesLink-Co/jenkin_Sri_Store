import { Controller, Get, Headers, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { BootstrapService } from './bootstrap.service.js';

@Controller('bootstrap')
@UseGuards(TenantGuard)
export class BootstrapController {
  constructor(private readonly bootstrapService: BootstrapService) {}

  @Get()
  async getBootstrap(
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const { payload, etag } = await this.bootstrapService.getBootstrapPayload();

    res.setHeader('ETag', etag);

    if (ifNoneMatch) {
      const clientHash = ifNoneMatch.replace(/^W\//, '').replace(/"/g, '').trim();
      const serverHash = etag.replace(/^W\//, '').replace(/"/g, '').trim();
      if (clientHash === serverHash) {
        res.status(304).send();
        return;
      }
    }

    res.status(200).json(payload);
  }
}
