import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { currentRequestContext } from '../common/request-context.js';
import { newId } from '../common/ids.js';
import {
  JOB_QUOTES_PURGE,
  QUEUE_MAINTENANCE,
  type QuotesPurgeJobPayload,
} from '../queue/queue.constants.js';

interface AuthenticatedRequest extends Request {
  user?: {
    userId?: string;
    tenantId?: string;
    role?: string;
    deviceId?: string;
    deviceRole?: string;
  };
}

export interface PurgeQuotesDto {
  olderThanDays?: number;
}

@Controller('quotes')
@UseGuards(TenantGuard)
export class QuotesController {
  constructor(
    @InjectQueue(QUEUE_MAINTENANCE) private readonly maintenanceQueue: Queue,
  ) {}

  @Post('purge')
  @HttpCode(HttpStatus.ACCEPTED)
  async purgeQuotes(@Req() req: AuthenticatedRequest, @Body() dto: PurgeQuotesDto) {
    const role = req.user?.role;
    if (role !== 'manager' && role !== 'owner') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Manager role required',
      });
    }

    const { tenantId } = currentRequestContext();
    const olderThanDays = Math.max(1, Number(dto?.olderThanDays ?? 90));
    const correlationId = newId('quote_');

    const job = await this.maintenanceQueue.add(
      JOB_QUOTES_PURGE,
      {
        tenantId,
        correlationId,
        olderThanDays,
      } satisfies QuotesPurgeJobPayload,
      {
        jobId: `quotes-purge:${tenantId}:${Date.now()}`,
      },
    );

    return {
      queued: true,
      jobId: job.id,
      olderThanDays,
    };
  }
}
