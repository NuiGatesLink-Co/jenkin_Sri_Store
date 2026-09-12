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

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential-jitter',
    delay: 1000,
  },
  removeOnComplete: {
    age: 3600, // keep for 1 hour
    count: 1000, // keep max 1000 jobs
  },
  removeOnFail: false, // keep failed jobs as evidence (Backend05 reliability)
};
