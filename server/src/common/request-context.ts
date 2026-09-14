import { AsyncLocalStorage } from 'node:async_hooks';
import type { EntityManager } from 'typeorm';

/**
 * The per-request tenant and transaction that every tenant-scoped module reads.
 *
 * ADR-0003 (addendum *"ใครตัดสิน กับ ใครลงมือ"*, in force since tx.4 #153) separates who
 * DECIDES the tenant from who EXECUTES it:
 *
 *   TenantScopeMiddleware  opens this scope for every request — no tenant, no transaction;
 *                          it never touches the database
 *   TenantGuard            checks `tenants.status`, then names the tenant on the scope
 *                          (`setRequestTenant`) — the ONE component allowed to; a shop that
 *                          is not `active` is never named
 *   TenantService.runTx    opens a transaction inside the handler, `set_config`s the scope's
 *                          tenant on it, publishes the manager, commits and releases
 *
 * `currentRequestContext()` fails closed three times over: outside the scope, before the
 * guard has named a tenant, and outside `runTx`. A route that forgot the guard or the
 * `runTx` therefore cannot reach tenant data — it gets an exception, not someone else's rows.
 */
export interface RequestContext {
  /**
   * The tenant this request acts as. Already applied to `manager`'s connection as
   * `app.tenant_id`, so RLS is what actually enforces it; this copy is for writes
   * that must name the tenant in a column.
   */
  tenantId: string;
  /**
   * The transactional EntityManager `TenantService.runTx` opened. Every tenant-scoped read
   * and write goes through it, or it lands outside that transaction — and outside the
   * transaction-local `app.tenant_id`, RLS sees no tenant at all.
   */
  manager: EntityManager;
}

/**
 * What a scope holds before it is complete. `runInTenantScope()` opens a scope with
 * neither; the guard names the tenant and `TenantService.runTx` publishes the manager.
 */
interface MutableRequestContext {
  tenantId: string | null;
  manager: EntityManager | null;
  postCommitHooks?: Array<() => Promise<void> | void>;
}

const storage = new AsyncLocalStorage<MutableRequestContext>();

/**
 * Runs `fn` with a scope that already carries `manager` (and optionally a tenant). No
 * production code calls it since tx.4 (#153) deleted the request-wide transaction: it is
 * the unit-test seam for publishing a stand-in manager. Production scopes come from
 * `runInTenantScope()` and `TenantService.runTx`.
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
 * กับ ใครลงมือ"*). `TenantScopeMiddleware` calls it for every request; the guard names the
 * tenant later and `TenantService.runTx` publishes the manager later still.
 */
export function runInTenantScope<T>(fn: () => T): T {
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
 */
export function currentTransaction(): EntityManager | null {
  return storage.getStore()?.manager ?? null;
}

/**
 * Whether this scope has a transaction open — so `onTransactionCommit` has a commit to
 * wait for. False outside any scope, and (since tx.4 #153) false in a request scope outside
 * `TenantService.runTx`.
 */
export function hasOpenTransaction(): boolean {
  return (storage.getStore()?.manager ?? null) !== null;
}

/** Names the tenant on the current request. `TenantGuard` only (ADR-0003). */
export function setRequestTenant(tenantId: string): void {
  requireScope().tenantId = tenantId;
}

function requireScope(): MutableRequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      'No request context. Tenant-scoped work must run inside runInTenantScope() ' +
        '(TenantScopeMiddleware); this code ran without it.',
    );
  }
  return ctx;
}

/**
 * Registers an action to run strictly AFTER the open transaction has committed (e.g.
 * enqueuing post-processing jobs to BullMQ). A rollback discards it.
 *
 * 🔴 Throws when no transaction is open — outside any scope, or in a request scope outside
 * `TenantService.runTx`. There is no commit to wait for there: running the hook at once
 * could run it before the caller's own commit, and parking it on a scope no transaction
 * owns would drop it silently (since tx.4 #153 nothing ends a request-wide transaction).
 */
export function onTransactionCommit(hook: () => Promise<void> | void): void {
  const store = storage.getStore();
  if (!store || store.manager === null) {
    throw new Error(
      'onTransactionCommit needs an open transaction. Register it inside TenantService.runTx, ' +
        'or await your own commit and run the action directly.',
    );
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
 * ONLY by `TenantService.runTx`, after its commit.
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

