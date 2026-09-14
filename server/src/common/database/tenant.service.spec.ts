import { describe, expect, it, vi } from 'vitest';
import {
  currentRequestContext,
  onTransactionCommit,
  runInRequestContext,
  runInTenantScope,
  setRequestTenant,
} from '../request-context.js';
import { TenantService } from './tenant.service.js';

const TID = '00000000-0000-4000-8000-000000000150';

/** A pool whose query runners record what happened to them, in order. */
function fakePool() {
  const events: string[] = [];
  const runners: Array<Record<string, any>> = [];
  const ds = {
    createQueryRunner: vi.fn(() => {
      const qr: Record<string, any> = {
        isTransactionActive: false,
        isReleased: false,
        connect: vi.fn(async () => events.push('connect')),
        startTransaction: vi.fn(async () => {
          qr.isTransactionActive = true;
          events.push('begin');
        }),
        query: vi.fn(async (sql: string, params: unknown[]) => {
          events.push(`query ${sql} ${JSON.stringify(params)}`);
          return [];
        }),
        commitTransaction: vi.fn(async () => {
          qr.isTransactionActive = false;
          events.push('commit');
        }),
        rollbackTransaction: vi.fn(async () => {
          qr.isTransactionActive = false;
          events.push('rollback');
        }),
        release: vi.fn(async () => {
          qr.isReleased = true;
          events.push('release');
        }),
      };
      qr.manager = { queryRunner: qr, name: `manager-${runners.length}` };
      runners.push(qr);
      return qr;
    }),
  };
  return { tenants: new TenantService(ds as any), ds, runners, events };
}

/** A scope the way TenantGuard leaves it in `tx.4`: tenant named, no transaction open. */
function authorised<T>(fn: () => Promise<T>): Promise<T> {
  return runInTenantScope(async () => {
    setRequestTenant(TID);
    return fn();
  });
}

describe('TenantService.runTx (tx.1, #150)', () => {
  it('throws when the scope has no tenant, before touching the pool', async () => {
    const { tenants, ds } = fakePool();
    const work = vi.fn();

    // No scope at all.
    await expect(tenants.runTx(work)).rejects.toThrow(/No request context/);
    // A scope the guard never named a tenant on.
    await expect(runInTenantScope(() => tenants.runTx(work))).rejects.toThrow(
      /No tenant on this request/,
    );
    // The middleware's transaction before the guard ran: still no tenant, still no join.
    await expect(
      runInRequestContext({ manager: {} as any }, () => tenants.runTx(work)),
    ).rejects.toThrow(/No tenant on this request/);

    expect(work).not.toHaveBeenCalled();
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
  });

  it('nested runTx joins: the same manager, one query runner, one BEGIN and one COMMIT', async () => {
    const { tenants, ds, runners, events } = fakePool();
    let outer: unknown;
    let inner: unknown;

    await authorised(() =>
      tenants.runTx(async (m1) => {
        outer = m1;
        await tenants.runTx(async (m2) => {
          inner = m2;
        });
      }),
    );

    expect(inner).toBe(outer);
    expect(ds.createQueryRunner).toHaveBeenCalledTimes(1);
    expect(outer).toBe(runners[0].manager);
    expect(events).toEqual([
      'connect',
      'begin',
      `query SELECT set_config('app.tenant_id', $1, true) ${JSON.stringify([TID])}`,
      'commit',
      'release',
    ]);
  });

  it('joins the transaction RequestContextMiddleware opened instead of taking a connection', async () => {
    const { tenants, ds } = fakePool();
    const requestManager = { name: 'request-manager' } as any;
    let seen: unknown;
    let ctx: unknown;

    await runInRequestContext({ manager: requestManager }, async () => {
      setRequestTenant(TID); // what TenantGuard does today
      await tenants.runTx(async (m) => {
        seen = m;
        ctx = currentRequestContext();
      });
    });

    expect(seen).toBe(requestManager);
    expect(ctx).toEqual({ tenantId: TID, manager: requestManager });
    expect(ds.createQueryRunner).not.toHaveBeenCalled();
  });

  it('publishes the tenant and manager, so currentRequestContext() works inside a joined runTx', async () => {
    const { tenants, runners } = fakePool();
    const seen: unknown[] = [];

    await authorised(() =>
      tenants.runTx(async () => {
        seen.push(currentRequestContext());
        await tenants.runTx(async () => {
          seen.push(currentRequestContext());
        });
      }),
    );

    const expected = { tenantId: TID, manager: runners[0].manager };
    expect(seen).toEqual([expected, expected]);
  });

  it('rolls back, releases and rethrows when the work throws — and drops its post-commit hooks', async () => {
    const { tenants, runners, events } = fakePool();
    const hook = vi.fn();
    const boom = new Error('boom');

    await expect(
      authorised(() =>
        tenants.runTx(async () => {
          onTransactionCommit(hook);
          await tenants.runTx(async () => {
            throw boom;
          });
        }),
      ),
    ).rejects.toBe(boom);

    expect(runners).toHaveLength(1);
    expect(events.slice(-2)).toEqual(['rollback', 'release']);
    expect(runners[0].commitTransaction).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it('runs post-commit hooks registered inside (joined calls included) only after commit and release', async () => {
    const { tenants, events } = fakePool();

    await authorised(() =>
      tenants.runTx(async () => {
        onTransactionCommit(() => {
          events.push('outer hook');
        });
        await tenants.runTx(async () => {
          onTransactionCommit(() => {
            events.push('inner hook');
          });
        });
        expect(events).not.toContain('outer hook');
      }),
    );

    expect(events.slice(-4)).toEqual([
      'commit',
      'release',
      'outer hook',
      'inner hook',
    ]);
  });

  it("a joined runTx leaves the owner's hooks to the owner", async () => {
    const { tenants } = fakePool();
    const hook = vi.fn();

    await runInRequestContext({ manager: {} as any }, async () => {
      setRequestTenant(TID);
      await tenants.runTx(async () => {
        onTransactionCommit(hook);
      });
      // TransactionInterceptor commits the request transaction and runs this, not runTx.
      expect(hook).not.toHaveBeenCalled();
    });
  });
});
