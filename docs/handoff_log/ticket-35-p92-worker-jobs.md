# Ticket #35 `p9.2` — Background Worker Jobs (`sale-post`, `inventory`, `maintenance`, `POST /quotes/purge`)

**Date:** 2026-09-13  
**Author:** PattaraponKitcharoen (`team/3` / Lane C)  
**Branch:** `feat/p9.2-worker-jobs`  
**Status:** Ready for Review / PR  
**PR:** Against `main`  
**Closes:** Issue #35  

---

## 1. Context & Scope
Per **Issue #35**, **`02_API_SCREENS.md §6`**, **`03_ARCHITECTURE.md`**, and **`CONTRACT.md`**:
- Implements background worker processors for the queue substrate built in Ticket #34:
  - `sale-post`: processes `sale.created` and `return.created` events post-commit, checks low-stock thresholds, and cascades to `inventory.check`.
  - `inventory`: processes `inventory.check` jobs, evaluating stock against `min_stock` idempotently.
  - `maintenance`: handles `idem.cleanup` (deletes expired idempotency keys >24h / TTL) and `quotes.purge` (deletes quotes older than `olderThanDays` and cascades to `quote_items`).
- Implements post-commit enqueue hook mechanism:
  - Hooks attach to `MutableRequestContext`.
  - Enqueuing is executed in `TransactionInterceptor` strictly *after* `commitTransaction()` and connection release.
  - Rolled-back sales/returns discard hooks and enqueue nothing (preventing phantom background jobs).
- Implements `POST /quotes/purge`:
  - Accepts `{ olderThanDays?: number }` (default: 90).
  - Enqueues `quotes.purge` into `maintenance` queue.
  - Responds immediately with `202 Accepted` and `{ status: 'success', data: { queued: true, jobId, olderThanDays } }`.
- Separates worker processors into `QueueProcessorsModule` (imported by `WorkerModule`) so HTTP instances only enqueue to Redis and do not contend for request connection pool slots.

---

## 2. Changes Made

### A. Request Context & Transaction Interceptor (Post-Commit Hooks)
1. **`server/src/common/request-context.ts`**:
   - Added `postCommitHooks?: Array<() => Promise<void> | void>` to `MutableRequestContext`.
   - Exported `onTransactionCommit(hook)` and `executePostCommitHooks()`.
2. **`server/src/common/transaction.interceptor.ts`**:
   - Executes `await executePostCommitHooks()` immediately after `await end(qr, 'commit')`.
   - On error / rollback (`end(qr, 'rollback')`), discards hooks without execution.

### B. Worker Processors & Queue Integration
1. **`server/src/queue/queue.constants.ts`**:
   - Added job name constants: `JOB_SALE_CREATED`, `JOB_RETURN_CREATED`, `JOB_INVENTORY_CHECK`, `JOB_IDEM_CLEANUP`, `JOB_QUOTES_PURGE`.
   - Defined typed payloads: `SaleCreatedJobPayload`, `ReturnCreatedJobPayload`, `InventoryCheckJobPayload`, `IdemCleanupJobPayload`, `QuotesPurgeJobPayload`.
2. **`server/src/queue/processors/sale-post.processor.ts`**:
   - Handles `sale.created` and `return.created` under `TenantJobRunner.runWithTenantContext`.
   - Checks touched products for low stock (`stock <= min_stock`).
   - Enqueues `inventory.check` into `inventoryQueue` with deduplicated `jobId`.
3. **`server/src/queue/processors/inventory.processor.ts`**:
   - Handles `inventory.check` under `TenantJobRunner.runWithTenantContext`.
   - Evaluates products at or below `min_stock` idempotently.
4. **`server/src/queue/processors/maintenance.processor.ts`**:
   - Handles `idem.cleanup`: deletes expired keys (`created_at < now() - interval '1 second' * ttl`).
   - Handles `quotes.purge`: deletes quotes older than `olderThanDays` (cascade deletes `quote_items`).
   - Handles TypeORM query result normalization (`extractDeletedCount`) across direct and mock result shapes.
5. **`server/src/queue/queue.module.ts`**:
   - Separated into `QueueModule` (BullMQ client, queue registrations, `TenantJobRunner`) and `QueueProcessorsModule` (worker processors).

### C. Sales & Returns Post-Commit Wiring
1. **`server/src/sales/sales.service.ts`**:
   - Injected `@Optional() @InjectQueue(QUEUE_SALE_POST) salePostQueue`.
   - Registers `onTransactionCommit` to enqueue `JOB_SALE_CREATED` with touched product IDs.
2. **`server/src/returns/returns.service.ts`**:
   - Injected `@Optional() @InjectQueue(QUEUE_SALE_POST) salePostQueue`.
   - Registers `onTransactionCommit` to enqueue `JOB_RETURN_CREATED` with touched product IDs.

### D. Quotes Purge Route & Module
1. **`server/src/quotes/quotes.controller.ts`**:
   - `POST /quotes/purge` with `TenantGuard`.
   - Enqueues `JOB_QUOTES_PURGE` to `maintenanceQueue` with unique job ID.
   - Responds with HTTP `202 Accepted` and `{ queued: true, jobId, olderThanDays }`.
2. **`server/src/quotes/quotes.module.ts`**:
   - Encapsulates `QuotesController`.
3. **`server/src/app.module.ts`**:
   - Imported `QuotesModule`.
   - Added `QuotesController` to `TENANT_ROUTES` so `RequestContextMiddleware` opens the request transaction for `TenantGuard`.
   - Added `QueueProcessorsModule` to `WorkerModule`.

---

## 3. Verification Results

### Acceptance Criteria Matrix

| AC | Requirement | Verification Method | Status |
|---|---|---|---|
| **AC1** | **Idempotent Execution** | `test/worker-jobs.spec.ts` & `test/worker-jobs.e2e-spec.ts` executing handlers twice on identical payloads | ✅ **Passed** |
| **AC2** | **Enqueued Post-Commit Only** | `test/worker-jobs.e2e-spec.ts` verifies `sale.created` job is present in `salePostQueue` after 201 response and cascades to `inventory.check` | ✅ **Passed** |
| **AC3** | **No Enqueue on Rollback** | `test/worker-jobs.e2e-spec.ts` verifies stock shortfall (409) rolls back and leaves queue empty | ✅ **Passed** |
| **AC4** | **Expired Idempotency Keys Cleanup** | `test/worker-jobs.e2e-spec.ts` verifies `idem.cleanup` removes keys >24h and preserves fresh keys | ✅ **Passed** |
| **AC5** | **`POST /quotes/purge` (202 Accepted)** | `test/worker-jobs.e2e-spec.ts` hits endpoint, receives 202 Accepted, and verifies background purge of >90-day quotes and cascaded items | ✅ **Passed** |

### Automated Checks

| Check | Command | Result |
|---|---|---|
| **Linter** | `pnpm lint` | **0 errors, 0 warnings** (127 files) |
| **Typecheck** | `pnpm typecheck` | **Clean (0 errors)** |
| **Unit Tests** | `pnpm test` | **17 passed (114 tests)** |
| **Worker E2E Tests** | `pnpm test:e2e test/worker-jobs.e2e-spec.ts` | **5 passed (0 failed)** |
| **Queue E2E Tests** | `pnpm test:e2e test/queue.e2e-spec.ts` | **7 passed (0 failed)** |
| **Returns E2E Tests** | `pnpm test:e2e test/returns.e2e-spec.ts` | **28 passed (0 failed)** |
| **Shifts E2E Tests** | `pnpm test:e2e test/shifts.e2e-spec.ts` | **19 passed (0 failed)** |
| **Idempotency E2E Tests** | `pnpm test:e2e test/idempotency.e2e-spec.ts` | **10 passed (0 failed)** |
| **Production Build** | `pnpm build` | **`nest build` succeeds** |
