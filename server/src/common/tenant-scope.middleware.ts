import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runInTenantScope } from './request-context.js';

/**
 * Opens the request scope every tenant-scoped component reads (ADR-0003 addendum *"ใครตัดสิน
 * กับ ใครลงมือ"*, tx.4 #153): no tenant and no transaction yet. `TenantGuard` names the
 * tenant on it, `TenantService.runTx` opens a transaction under that tenant inside the
 * handler, and post-commit hooks live on the transaction's own child scope.
 *
 * Bound to every route, so a new controller needs no config entry — the old per-controller
 * `TENANT_ROUTES` list is gone. 🔴 It never touches the database: a scope on `/health/*`
 * or a 401 costs no connection.
 */
@Injectable()
export class TenantScopeMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    void runInTenantScope(async () => {
      next();
    });
  }
}
