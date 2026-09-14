import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  authorisedTenantId,
  currentTransaction,
  executePostCommitHooks,
  runInTransaction,
} from '../request-context.js';

/**
 * The tenant door: the one way code obtains an `EntityManager` that RLS answers for, under
 * the tenant `TenantGuard` authorised (ADR-0003 addendum *"ใครตัดสิน กับ ใครลงมือ"* — the
 * guard decides, this executes).
 */
@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);

  constructor(private readonly ds: DataSource) {}

  /**
   * Runs `fn` in a transaction scoped to the request's authorised tenant.
   *
   * 🔴 **The tenant is not a parameter, and never will be.** It comes from the request
   * scope, where only `TenantGuard` puts it. A `runTx(tid, fn)` would let any call site
   * pass another shop's uuid and get its rows back with no error. With no tenant on the
   * scope this throws before touching the pool.
   *
   * 🔴 **Joins, never nests.** If this scope already has a transaction open — the one
   * `RequestContextMiddleware` opens until `tx.4`, or an outer `runTx` — `fn` runs on that
   * same manager: no second connection (holding one while waiting for another is the pool
   * deadlock of #162), no savepoint, and the outer owner commits. That scope already names
   * the tenant, so `currentRequestContext()` works inside, and post-commit hooks land on the
   * owner's list.
   *
   * Otherwise it opens one: `set_config('app.tenant_id', …, true)` (the transaction-local
   * form; `SET LOCAL app.tenant_id = $1` is a 42601 — see `tenant-scope.spec.ts`), runs `fn`
   * with the manager published, commits or rolls back, returns the connection, and only
   * then runs the hooks registered inside — the order `TransactionInterceptor` uses.
   */
  async runTx<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    const tenantId = authorisedTenantId();
    const open = currentTransaction();
    if (open) return fn(open);

    const qr = this.ds.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      return await runInTransaction(
        { tenantId, manager: qr.manager },
        async () => {
          await qr.query(`SELECT set_config('app.tenant_id', $1, true)`, [
            tenantId,
          ]);
          const value = await fn(qr.manager);
          await qr.commitTransaction();
          await qr.release();
          await executePostCommitHooks((err) =>
            this.logger.warn(`post-commit hook failed: ${String(err)}`),
          );
          return value;
        },
      );
    } catch (err) {
      try {
        if (qr.isTransactionActive) await qr.rollbackTransaction();
      } catch {
        /* the original error is the one worth reporting */
      }
      throw err;
    } finally {
      if (!qr.isReleased) await qr.release();
    }
  }
}
