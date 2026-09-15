import type { JobsOptions } from 'bullmq';

export const QUEUE_SALE_POST = 'sale-post';
export const QUEUE_INVENTORY = 'inventory';
export const QUEUE_MAINTENANCE = 'maintenance';
export const QUEUE_BACKUP = 'backup';
export const QUEUE_DLQ = 'dlq';

export const ALL_QUEUES = [
  QUEUE_SALE_POST,
  QUEUE_INVENTORY,
  QUEUE_MAINTENANCE,
  QUEUE_BACKUP,
  QUEUE_DLQ,
] as const;

export type QueueName = (typeof ALL_QUEUES)[number];

export interface BaseJobPayload {
  tenantId: string;
  correlationId: string;
  [key: string]: unknown;
}

export const JOB_SALE_CREATED = 'sale.created';
export const JOB_RETURN_CREATED = 'return.created';
export const JOB_INVENTORY_CHECK = 'inventory.check';
export const JOB_IDEM_CLEANUP = 'idem.cleanup';
export const JOB_QUOTES_PURGE = 'quotes.purge';
export const JOB_TENANT_EXPORT = 'tenant.export';

export interface TenantExportJobPayload extends BaseJobPayload {
  requestedByUserId: string;
  ip?: string;
}

export interface SaleCreatedJobPayload extends BaseJobPayload {
  saleId: string;
  receiptNo: string;
  productIds: string[];
}

export interface ReturnCreatedJobPayload extends BaseJobPayload {
  returnId: string;
  cnNo: string;
  productIds: string[];
}

export interface InventoryCheckJobPayload extends BaseJobPayload {
  productIds?: string[];
}

export interface QuotesPurgeJobPayload extends BaseJobPayload {
  olderThanDays: number;
}

export interface IdemCleanupJobPayload extends BaseJobPayload {
  olderThanSeconds?: number;
}

// #201: `jitter: 1` is BullMQ's own full-jitter backoff — `exponential(delay, jitter)` in
// bullmq's classes/backoffs.js computes `minDelay = maxDelay * (1 - jitter)`, so `jitter: 1`
// gives `minDelay = 0` and a result of `floor(random() * 2^(attemptsMade-1) * delay)`, exactly
// the full-jitter formula the course deck omits (without jitter, retries collide). A prior
// version registered a custom `'exponential-jitter'` type via `settings.backoffStrategy` on
// each worker to get the same formula; that type isn't one of BullMQ's builtins, and leaving it
// unregistered on any worker (as all four were) makes `Backoffs.calculate` throw and leaves the
// job stuck `active` instead of retrying or failing (#201). Using the builtin removes the whole
// bug class: nothing is registered per-Worker, so a future processor has nothing to forget.
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000,
    jitter: 1,
  },
  removeOnComplete: {
    age: 3600, // keep for 1 hour
    count: 1000, // keep max 1000 jobs
  },
  removeOnFail: false, // keep failed jobs as evidence (Backend05 reliability)
};

// #182: the repeatable, tenant-less `idem.cleanup` job. `upsertJobScheduler` keys on this id,
// so re-registering it (every worker boot) updates the same schedule instead of adding a
// second one.
export const IDEM_CLEANUP_SCHEDULER_ID = 'idem-cleanup-global';
export const IDEM_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly
