import { Inject, Injectable } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import type { Logger } from 'pino';
import { LOGGER } from '../../infra/logger.provider.js';
import { IDEMPOTENCY_TTL_SECONDS } from '../../idempotency/idempotency.service.js';
import {
  JOB_IDEM_CLEANUP,
  JOB_QUOTES_PURGE,
  QUEUE_MAINTENANCE,
  type IdemCleanupJobPayload,
  type QuotesPurgeJobPayload,
} from '../queue.constants.js';
import { TenantJobRunner } from '../tenant-job-runner.js';

@Injectable()
@Processor(QUEUE_MAINTENANCE)
export class MaintenanceProcessor extends WorkerHost {
  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantJobRunner: TenantJobRunner,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    super();
  }

  async process(job: Job<QuotesPurgeJobPayload | IdemCleanupJobPayload>): Promise<unknown> {
    const { name, data } = job;
    this.logger.info(
      { jobId: job.id, jobName: name, tenantId: data.tenantId, correlationId: data.correlationId },
      'Processing maintenance job',
    );

    if (name === JOB_IDEM_CLEANUP) {
      return this.handleIdemCleanup(job as Job<IdemCleanupJobPayload>);
    }

    if (name === JOB_QUOTES_PURGE) {
      return this.handleQuotesPurge(job as Job<QuotesPurgeJobPayload>);
    }

    this.logger.warn({ jobName: name }, 'Unknown job name in maintenance queue');
    return { skipped: true, reason: 'UNKNOWN_JOB_NAME' };
  }

  private async handleIdemCleanup(job: Job<IdemCleanupJobPayload>): Promise<unknown> {
    const ttlSeconds = job.data?.olderThanSeconds ?? IDEMPOTENCY_TTL_SECONDS;
    const tenantId = job.data?.tenantId;

    if (tenantId) {
      // Scoped cleanup for a specific tenant via TenantJobRunner
      return this.tenantJobRunner.runWithTenantContext(job, async (em) => {
        const result = await em.query(
          `DELETE FROM idempotency_keys
            WHERE tenant_id = $1::uuid
              AND created_at < now() - ($2::int * interval '1 second')
            RETURNING key`,
          [tenantId, ttlSeconds],
        );
        const deletedCount = extractDeletedCount(result);
        this.logger.info(
          { tenantId, ttlSeconds, deletedCount },
          'Expired idempotency keys cleaned up for tenant',
        );
        return { cleaned: true, deletedCount };
      });
    }

    // System-wide cleanup across all tenants
    const result = await this.dataSource.query(
      `DELETE FROM idempotency_keys
        WHERE created_at < now() - ($1::int * interval '1 second')
        RETURNING key`,
      [ttlSeconds],
    );
    const deletedCount = extractDeletedCount(result);
    this.logger.info({ ttlSeconds, deletedCount }, 'Global expired idempotency keys cleaned up');
    return { cleaned: true, deletedCount };
  }

  private async handleQuotesPurge(job: Job<QuotesPurgeJobPayload>): Promise<unknown> {
    const olderThanDays = Math.max(1, job.data?.olderThanDays ?? 90);

    return this.tenantJobRunner.runWithTenantContext(job, async (em) => {
      const result = await em.query(
        `DELETE FROM quotes
          WHERE tenant_id = $1::uuid
            AND date < now() - ($2::int * interval '1 day')
          RETURNING id`,
        [job.data.tenantId, olderThanDays],
      );

      const deletedCount = extractDeletedCount(result);
      this.logger.info(
        { tenantId: job.data.tenantId, olderThanDays, deletedCount },
        'Old quotes purged successfully',
      );

      return { purged: true, deletedCount, olderThanDays };
    });
  }
}

/**
 * Normalizes deleted row count across TypeORM query result shapes:
 * - In TypeORM with Postgres: queryRunner.query returns `[ rows, count ]`.
 * - In raw pg or mocks: query returns `rows` array.
 */
function extractDeletedCount(result: unknown): number {
  if (Array.isArray(result)) {
    if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
      return result[1];
    }
    if (result.length > 0 && typeof result[0] === 'object' && !Array.isArray(result[0])) {
      return result.length;
    }
    if (result.length === 0) return 0;
  }
  return 0;
}
