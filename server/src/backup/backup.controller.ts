import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
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
import { clientIp } from '../common/client-ip.js';
import {
  DEFAULT_JOB_OPTIONS,
  JOB_TENANT_EXPORT,
  QUEUE_BACKUP,
  type TenantExportJobPayload,
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

@Controller('backup')
@UseGuards(TenantGuard)
export class BackupController {
  constructor(
    @InjectQueue(QUEUE_BACKUP) private readonly backupQueue: Queue,
  ) {}

  @Post('export')
  @HttpCode(HttpStatus.ACCEPTED)
  async exportTenantData(@Req() req: AuthenticatedRequest) {
    const role = req.user?.role;
    if (role !== 'owner') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Owner role required',
      });
    }

    const { tenantId } = currentRequestContext();
    const correlationId = newId('export_');
    const ip = clientIp(req) ?? undefined;

    const payload: TenantExportJobPayload = {
      tenantId,
      correlationId,
      requestedByUserId: req.user?.userId ?? '',
      ip,
    };

    const job = await this.backupQueue.add(
      JOB_TENANT_EXPORT,
      payload,
      DEFAULT_JOB_OPTIONS,
    );

    return {
      jobId: job.id,
      status: 'queued',
    };
  }

  @Get('jobs/:id')
  async getJobStatus(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const role = req.user?.role;
    if (role !== 'owner') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Owner role required',
      });
    }

    const { tenantId } = currentRequestContext();
    const job = await this.backupQueue.getJob(id);

    if (!job || job.data?.tenantId !== tenantId) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Job not found',
      });
    }

    const state = await job.getState();
    const rawResult = job.returnvalue;
    const resultData =
      rawResult && typeof rawResult === 'object' && 'result' in rawResult
        ? (rawResult as { result: unknown }).result
        : rawResult ?? null;

    return {
      id: job.id,
      status: state,
      state,
      progress: job.progress,
      data: resultData,
      result: resultData,
      error: job.failedReason ?? null,
    };
  }
}
