# Ticket #36 `p10.1` — Tenant Export Job (Data Portability)

**Date:** 2026-09-13  
**Author:** PattaraponKitcharoen (`team/3` / Lane C)  
**Branch:** `feat/p10.1-tenant-export`  
**Status:** Ready for Review / PR  
**PR:** Against `main`  
**Closes:** Issue #36  

---

## 1. Context & Scope
Per **Issue #36**, **[ADR-0005](file:///Users/peternus/Desktop/srisurart-pos-flutter/docs/Backend_design/adr/0005-data-portability.md)**, **`02_API_SCREENS.md §3.10` & `§508`**, and **`01_DATABASE.md §10`**:
- Implements asynchronous tenant export job on BullMQ queue `backup` (`QUEUE_BACKUP`):
  - `POST /backup/export` strictly requires `role === 'owner'`. Cashiers and managers are refused with `403 Forbidden` (`FORBIDDEN`).
  - Returns `202 Accepted` with `{ jobId, status: 'queued' }`.
  - Enqueues `JOB_TENANT_EXPORT = 'tenant.export'` with `{ tenantId, correlationId, requestedByUserId, ip }`.
- Implements job status and result retrieval:
  - `GET /backup/jobs/:id` strictly requires `role === 'owner'`.
  - Rejects unauthorized access across tenants (`job.data.tenantId !== tenantId`) with `404 Not Found`.
  - Returns job state (`waiting`, `active`, `completed`, `failed`) and the exported snapshot data upon completion.
- Implements `BackupProcessor`:
  - Runs under `TenantJobRunner.runWithTenantContext` with `SET LOCAL app.tenant_id = <tenantId>`.
  - Extracts and formats all tenant data matching the canonical `sa_*` structure + `__meta` (version 2, schemaVersion 2, exportedAt, shopName, recordCounts) compatible with `SnapshotRepository.exportSnapshot()` and `TenantImportService`.
  - Nests child lines inside parent documents (`sales.items`, `returns.items`, `purchase_orders.items`, `quotes.items`, `shifts.entries`).
  - Correctly segments shifts into `sa_cash_drawer` (active) and `sa_shift_history` (inactive).
  - Preserves forward-compatibility by carrying forward unknown stores found in `tenant_meta` (`unknownstore:*`).
  - Records an `audit_log` event with `action: 'backup.exported'`, `entity: 'tenants'`, `entityId: tenantId`, `userId: requestedByUserId`, and summary metadata (PDPA compliance).

---

## 2. Changes Made

### A. Queue Constants & Payloads
1. **`server/src/queue/queue.constants.ts`**:
   - Added `JOB_TENANT_EXPORT = 'tenant.export'`.
   - Defined `TenantExportJobPayload`:
     ```ts
     export interface TenantExportJobPayload extends BaseJobPayload {
       requestedByUserId: string;
       ip?: string;
     }
     ```

### B. Worker Backup Processor
1. **`server/src/queue/processors/backup.processor.ts`**:
   - Created `@Processor(QUEUE_BACKUP) BackupProcessor` extending `WorkerHost`.
   - Queries `settings`, `categories`, `products`, `customers`, `mechanics`, `sales` & `sale_items`, `returns` & `return_items`, `purchase_orders` & `po_items`, `quotes` & `quote_items`, `movements`, `suppliers`, `credit_payments`, `shifts` & `drawer_entries`, `parked_sales`, and `tenant_meta`.
   - Assembles exact legacy/Drift snapshot format `sa_*` + `__meta`.
   - Writes tenant `audit_log` record via `AuditService.log(...)`.
2. **`server/src/queue/queue.module.ts`**:
   - Registered `BackupProcessor` in `QueueProcessorsModule` providers and exports.
   - Imported `AuditModule` in `QueueProcessorsModule`.

### C. Backup Controller & Module
1. **`server/src/backup/backup.controller.ts`**:
   - Route `POST /backup/export` (`202 Accepted`): validates `role === 'owner'`, enqueues to `backupQueue`, answers `{ jobId, status: 'queued' }`.
   - Route `GET /backup/jobs/:id`: validates `role === 'owner'`, retrieves job, protects against cross-tenant disclosure (`404`), answers `{ id, status, data, result, error }`.
2. **`server/src/backup/backup.module.ts`**:
   - Encapsulates `BackupController`, imports `QueueModule` and `AuditModule`.
3. **`server/src/app.module.ts`**:
   - Imported `BackupModule`.
   - Added `BackupController` to `TENANT_ROUTES` so `RequestContextMiddleware` opens the request transaction for `TenantGuard`.

### D. Test Suites
1. **`server/test/backup.spec.ts`**:
   - Unit tests covering `BackupProcessor` (skips non-export jobs, queries all stores, formats nested lines, builds `__meta`, writes audit log).
   - Unit tests covering `BackupController` (owner role check, 202 enqueue, cross-tenant 404, status reporting).
2. **`server/test/backup.e2e-spec.ts`**:
   - End-to-end integration tests with real PostgreSQL and Redis:
     - AC1: Cashier and manager rejected with 403 Forbidden.
     - AC2: Owner receives 202 Accepted with `{ jobId, status: 'queued' }`.
     - AC3: Audit log row created with `action = 'backup.exported'`, `entity = 'tenants'`.
     - AC4: Complete snapshot JSON structure verified against seeded data.
     - AC5: Status polling and result retrieval; cross-tenant job access returns 404.

---

## 3. Verification Results

### Acceptance Criteria Matrix

| AC | Requirement | Verification Method | Status |
|---|---|---|---|
| **AC1** | **Role Authorization** | Cashier and manager receive 403 Forbidden; owner allowed (`test/backup.e2e-spec.ts`) | ✅ **Passed** |
| **AC2** | **Asynchronous Enqueue (202)** | `POST /backup/export` enqueues job into `QUEUE_BACKUP` and returns 202 Accepted (`test/backup.e2e-spec.ts`) | ✅ **Passed** |
| **AC3** | **Audit Log Recording** | `audit_log` row recorded with `action = 'backup.exported'` and `actor_id` (`test/backup.e2e-spec.ts`) | ✅ **Passed** |
| **AC4** | **Standard Snapshot JSON Structure** | Exported data matches `sa_*` format with nested items and `__meta` (`test/backup.e2e-spec.ts`, `test/backup.spec.ts`) | ✅ **Passed** |
| **AC5** | **Job Status & Result Retrieval** | Polling `GET /backup/jobs/:id` yields status and snapshot; cross-tenant lookup returns 404 (`test/backup.e2e-spec.ts`) | ✅ **Passed** |

### Automated Quality Checks

| Check | Command | Result |
|---|---|---|
| **Linter** | `pnpm lint` | **0 errors, 0 warnings** (132 files) |
| **Typecheck** | `pnpm typecheck` | **Clean (0 errors)** |
| **Build** | `pnpm build` | **Clean (0 errors)** |
| **Unit Tests** | `pnpm test test/backup.spec.ts` | **9 passed (0 failed)** |
| **Full Unit Tests** | `pnpm test` | **18 suites passed (123 tests)** |
| **E2E Tests** | `pnpm test:e2e test/backup.e2e-spec.ts` | **7 passed (0 failed)** |
| **Client Analyze** | `dart analyze` | **No issues found!** |
