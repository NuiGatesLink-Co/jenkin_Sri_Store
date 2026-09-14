import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityManager } from 'typeorm';

/**
 * The per-request tenant and transaction that every tenant-scoped module reads.
 *
 * ADR-0003 makes `TenantGuard` the ONE component that checks `tenants.status`
 * and does `SET LOCAL app.tenant_id` — a separate tenant interceptor was considered
 * and rejected, because a route that forgot the guard would still get the GUC set
 * and read a suspended tenant's rows. Nothing else may set `app.tenant_id`.
 *
 * A guard cannot be the whole story, though: `canActivate` returns before the
 * handler runs, so it can neither hold this scope open across the handler nor commit
 * afterwards. The wiring is therefore a split, and ADR-0003 is untouched by it
 * because only the guard still touches the tenant:
 *
 *   RequestContextMiddleware  opens the transaction and this scope for the whole request
 *   TenantGuard               checks `tenants.status` and `SET LOCAL app.tenant_id` on
 *                             that manager — the one component allowed to, per ADR-0003
 *   TransactionInterceptor    commits on success, rolls back on error, before the
 *                             response is sent
 *
 * `currentRequestContext()` fails closed twice over: outside the scope, and inside it
 * before the guard has named a tenant. A route that forgot the guard therefore cannot
 * reach tenant data — it gets an exception, not someone else's rows.
 */
export interface RequestContext {
  /**
   * The tenant this request acts as. Already applied to `manager`'s connection as
   * `app.tenant_id`, so RLS is what actually enforces it; this copy is for writes
   * that must name the tenant in a column.
   */
  tenantId: string;
  /**
   * The request's transactional EntityManager. Every tenant-scoped read and write
   * goes through it, or it lands outside the transaction the middleware opened — and
   * outside `SET LOCAL`, which is transaction-scoped, RLS sees no tenant at all.
   */
  manager: EntityManager;
}

/**
 * What a scope holds before it is complete. The middleware opens a transaction with no
 * tenant named on it yet; `runInTenantScope()` (the shape `tx.4` switches to) opens a
 * scope with neither, and `TenantService.runTx` publishes the manager later.
 */
interface MutableRequestContext {
  tenantId: string | null;
  manager: EntityManager | null;
  postCommitHooks?: Array<() => Promise<void> | void>;
}

const storage = new AsyncLocalStorage<MutableRequestContext>();

/**
 * Runs `fn` with a fresh request scope carrying `manager`'s transaction.
 * `RequestContextMiddleware` calls this; the tenant is named later, by the guard.
 */
export function runInRequestContext<T>(
  ctx: { tenantId?: string; manager: EntityManager },
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(
    { tenantId: ctx.tenantId ?? null, manager: ctx.manager },
    fn,
  );
}

/**
 * Opens a request scope with no tenant and no transaction (ADR-0003 addendum *"ใครตัดสิน
 * กับ ใครลงมือ"*). The guard names the tenant later and `TenantService.runTx` publishes
 * the manager later still. Nothing calls it until `tx.4` replaces the middleware.
 */
export function runInTenantScope<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ tenantId: null, manager: null }, fn);
}

/**
 * Publishes `manager` under `tenantId` for the duration of `fn`, in a child scope, so
 * post-commit hooks registered inside belong to this transaction and the outer scope is
 * restored when it returns. `TenantService.runTx` only — it opened the transaction and
 * will end it; a manager published by anything else would outlive its own transaction.
 */
export function runInTransaction<T>(
  ctx: { tenantId: string; manager: EntityManager },
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ tenantId: ctx.tenantId, manager: ctx.manager }, fn);
}

/** The current request's context, or throws — never a silent default tenant. */
export function currentRequestContext(): RequestContext {
  const ctx = requireScope();
  if (ctx.tenantId === null) {
    throw new Error(
      'Request context has no tenant. TenantGuard names it; this route ran without the guard.',
    );
  }
  if (ctx.manager === null) {
    throw new Error(
      'Request context has no transaction. TenantService.runTx opens one; this code reached ' +
        'for the database outside it, where RLS would see no tenant at all.',
    );
  }
  return { tenantId: ctx.tenantId, manager: ctx.manager };
}

/**
 * The tenant the guard authorised, for `TenantService.runTx`, which is about to
 * `set_config` it on a transaction. Throws when no guard has named one, so no
 * tenant-scoped transaction can open on an unauthorised request.
 *
 * 🔴 There is deliberately no way to pass a tenant in: `runTx(tid, fn)` would let a call
 * site name another shop's uuid and read its rows with no error (ADR-0003).
 */
export function authorisedTenantId(): string {
  const ctx = requireScope();
  if (ctx.tenantId === null) {
    throw new Error(
      'No tenant on this request. TenantGuard names it (ADR-0003); this route ran without the guard.',
    );
  }
  return ctx.tenantId;
}

/**
 * The transaction already open in this scope, or null. `TenantService.runTx` only: it
 * joins this rather than take a second pooled connection while the first is still held.
 * The guard, the interceptor and `RateLimitService` use `currentRequestTransaction()`.
 */
export function currentTransaction(): EntityManager | null {
  return storage.getStore()?.manager ?? null;
}

/**
 * The request's transaction before a tenant is known — for the two components that
 * run either side of the guard: the guard itself (which needs the manager to do
 * `SET LOCAL`) and the interceptor that commits it. Nothing else may use it except
 * `RateLimitService` below and `TenantService.runTx`, which reads the same store through
 * `currentTransaction()` — because a query through it before the guard runs sees no
 * tenant at all under RLS.
 *
 * The rate-limit exception, for the same reason the guard reads `tenants.status` here:
 * `RateLimitService` reads `tenants.plan` (no RLS) on it, because any global guard that
 * reaches for a second pool connection while the request holds this one deadlocks the
 * pool under a burst (#162).
 */
export function currentRequestTransaction(): EntityManager | undefined {
  return storage.getStore()?.manager ?? undefined;
}

/** Whether a request scope exists — so `onTransactionCommit` would actually wait for a commit. */
export function hasRequestContext(): boolean {
  return storage.getStore() !== undefined;
}

/** Names the tenant on the current request. `TenantGuard` only (ADR-0003). */
export function setRequestTenant(tenantId: string): void {
  requireScope().tenantId = tenantId;
}

function requireScope(): MutableRequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      'No request context. Tenant-scoped work must run inside runInRequestContext() ' +
        '(RequestContextMiddleware) or runInTenantScope(); this route ran without either.',
    );
  }
  return ctx;
}

/**
 * Registers an action to run strictly AFTER the current request transaction has
 * successfully committed (e.g. enqueuing post-processing jobs to BullMQ).
 * If the transaction rolls back or fails, these hooks are discarded.
 * If called outside an active request context, runs immediately.
 */
export function onTransactionCommit(hook: () => Promise<void> | void): void {
  const store = storage.getStore();
  if (!store) {
    void hook();
    return;
  }
  if (!store.postCommitHooks) {
    store.postCommitHooks = [];
  }
  store.postCommitHooks.push(hook);
}

/**
 * Removes and returns the hooks registered on the current scope. `TenantService.runTx`
 * takes them inside its transaction's child scope so it can run them outside it, where
 * the released manager is no longer visible.
 */
export function takePostCommitHooks(): Array<() => Promise<void> | void> {
  const store = storage.getStore();
  const hooks = store?.postCommitHooks ?? [];
  if (store) store.postCommitHooks = [];
  return hooks;
}

/**
 * Executes post-commit hooks safely — the current scope's, or `hooks` if given. Called
 * ONLY by `TransactionInterceptor` and `TenantService.runTx`, after their commit.
 */
export async function executePostCommitHooks(
  onError?: (err: unknown) => void,
  hooks: Array<() => Promise<void> | void> = takePostCommitHooks(),
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (err) {
      // Post-commit failures should never throw to disrupt response of committed transactions
      onError?.(err);
    }
  }
}

