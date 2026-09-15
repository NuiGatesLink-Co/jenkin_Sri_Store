import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job, Queue } from 'bullmq';
import type { Logger } from 'pino';
import { LOGGER } from '../../infra/logger.provider.js';
import { TenantImportService } from '../../platform/tenant-import.service.js';
import { JOB_TENANT_IMPORT, QUEUE_DLQ, QUEUE_TENANT_IMPORT, type TenantImportJobPayload } from '../queue.constants.js';

/**
 * #239: the worker side of the tenant import. `TenantImportService` does all the database
 * work on `ADMIN_DATA_SOURCE` (platform plane, ADR-0002/0005 — see that file's own
 * `tenant-door.spec.ts` allowlist entry); this processor owns only the BullMQ shape: mark
 * running, run it, mark succeeded/failed, and — on the last attempt only — route to the DLQ,
 * the same rule `TenantJobRunner.routeToDlq` follows for every other job. It does not use
 * `TenantJobRunner` itself: that helper opens a `pos_app`/RLS transaction scoped to one
 * tenant (`SET LOCAL app.tenant_id`), and the import's whole point is writing historical rows
 * as the owner role, exactly as the synchronous endpoint always has.
 *
 * On its own queue (`QUEUE_TENANT_IMPORT`), not `QUEUE_BACKUP` — see that constant's comment:
 * two `@Processor` classes on one queue name would race for every job.
 */
@Injectable()
@Processor(QUEUE_TENANT_IMPORT)
export class TenantImportProcessor extends WorkerHost {
  constructor(
    private readonly importService: TenantImportService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Optional() @InjectQueue(QUEUE_DLQ) private readonly dlqQueue?: Queue,
  ) {
    super();
  }

  async process(job: Job<TenantImportJobPayload>): Promise<unknown> {
    const { name, data } = job;
    if (name !== JOB_TENANT_IMPORT) {
      // `BackupProcessor` shares this queue and handles its own job name; anything else here
      // is a bug, not this processor's job to skip silently.
      return undefined;
    }

    this.logger.info(
      { jobId: job.id, importJobId: data.importJobId, tenantId: data.tenantId, correlationId: data.correlationId },
      'Processing tenant import job',
    );

    await this.importService.markRunning(data.importJobId);
    try {
      const result = await this.importService.processJob(data.importJobId);
      await this.importService.markSucceeded(data.importJobId, result);
      this.logger.info({ importJobId: data.importJobId, tenantId: data.tenantId, result }, 'Tenant import completed successfully');
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const maxAttempts = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;
      await this.importService.markFailed(data.importJobId, message, isFinalAttempt);
      if (isFinalAttempt) {
        await this.routeToDlq(job, err);
      }
      throw err;
    }
  }

  /** Mirrors `TenantJobRunner.routeToDlq` — kept local rather than shared because that
   * helper's `runWithTenantContext` is the one door BullMQ processors normally go through
   * (`tenant-door.spec.ts`'s `SCOPE_DOORS`), and this processor deliberately does not. */
  private async routeToDlq(job: Job<TenantImportJobPayload>, err: unknown): Promise<void> {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;

    this.logger.error(
      {
        alert: 'DLQ_JOB_FAILED',
        jobId: job.id,
        queue: job.queueName,
        jobName: job.name,
        tenantId: job.data.tenantId,
        correlationId: job.data.correlationId,
        attemptsMade: job.attemptsMade + 1,
        error: errorMessage,
      },
      'BullMQ tenant import job exhausted all attempts; routing to DLQ and raising alert',
    );

    if (this.dlqQueue) {
      try {
        await this.dlqQueue.add(
          'dead-letter',
          {
            originalJobId: job.id,
            originalQueue: job.queueName,
            originalName: job.name,
            payload: job.data,
            failedReason: errorMessage,
            stacktrace: errorStack,
            failedAt: new Date().toISOString(),
            attemptsMade: job.attemptsMade + 1,
          },
          { removeOnComplete: false, removeOnFail: false },
        );
      } catch (dlqErr) {
        this.logger.error(
          { dlqError: dlqErr instanceof Error ? dlqErr.message : String(dlqErr) },
          'Failed to write to DLQ queue',
        );
      }
    }
  }
}
