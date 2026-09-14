import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/** Comments are where the reasons for holding a pool are written down. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * ADR-0003 addendum *"ใครตัดสิน กับ ใครลงมือ"* makes this scan a condition of the
 * handler-scoped design, not a suggestion. There are two ways for tenant work to land on a
 * connection with no `app.tenant_id`, and they fail very differently:
 *
 *   - forgetting `TenantService.runTx` but asking `currentRequestContext()` for the manager
 *     throws — a loud 500;
 *   - holding a `DataSource` and querying it directly answers **200 with zero rows** under
 *     RLS, and an UPDATE reports success having changed nothing. No endpoint test sees it.
 *
 * So a file may reach a raw pool only if it is on the allowlist below, with its reason.
 * `tenant-scope.spec.ts` is the precedent: a bug a mocked unit test cannot see gets a source
 * scan instead.
 */

/** Every constructor's parameter list — the text between `constructor(` and its matching `)`. */
function constructorParams(source: string): string[] {
  const lists: string[] = [];
  for (
    let i = source.indexOf('constructor(');
    i !== -1;
    i = source.indexOf('constructor(', i + 1)
  ) {
    const start = i + 'constructor('.length;
    let depth = 1;
    let j = start;
    for (; j < source.length && depth > 0; j++) {
      if (source[j] === '(') depth++;
      else if (source[j] === ')') depth--;
    }
    lists.push(source.slice(start, j - 1));
  }
  return lists;
}

/** Names a pool: the `DataSource` type, or one of `db.module.ts`'s named pool tokens. */
const POOL = /\bDataSource\b|\b[A-Z_]*_DATA_SOURCE\b/;

/** How a file gets hold of a pool: injected, resolved from the container, or built. */
function reachesForPool(source: string): boolean {
  const code = stripComments(source);
  return (
    constructorParams(code).some((params) => POOL.test(params)) ||
    /@InjectDataSource\b/.test(code) ||
    /\.(?:get|resolve)\(\s*(?:DataSource\b|[A-Z_]*_DATA_SOURCE\b)/.test(code) ||
    /\bnew\s+DataSource\s*\(/.test(code)
  );
}

/**
 * Files allowed to hold a pool of their own, and why (`src/`-relative, production code).
 * Built from the tree on 2026-09-14, not from the migration plan's 12-file count. A new
 * entry needs a reason a reviewer can check, not just a line.
 */
const ALLOWED: Record<string, string> = {
  'common/database/tenant.service.ts':
    'It IS the door: the one place a pool becomes a transaction scoped to the tenant TenantGuard authorised.',
  'common/request-context.middleware.ts':
    'Opens the request-wide transaction TenantGuard names the tenant on — the split in force until tx.4 (#153) deletes this file.',
  'infra/db.module.ts':
    'Builds and destroys the three pools (default pos_app, ADMIN_DATA_SOURCE, AUDIT_DATA_SOURCE).',
  'db/data-source.ts':
    'The migration DataSource (#15): connects as the table owner, runs outside the app and any request.',
  'health/health.controller.ts':
    '/health/ready probes Postgres with SELECT 1: no tenant, no table, deliberately outside any transaction.',
  'auth/auth.service.ts':
    'ADR-0009: a failed login must leave its audit_log row, which a rolled-back request transaction would erase; /auth/* is outside TENANT_ROUTES and sets app.tenant_id on its own runners.',
  'sales/void.service.ts':
    'auditDenial only, via AUDIT_DATA_SOURCE: a refused void rolls its request back and the refusal record must survive that; never the request pool (void-denial-pool.e2e-spec.ts).',
  'rate-limit/rate-limit.service.ts':
    'readPlan reads tenants.plan (no RLS) on the pool only when no request transaction exists; inside a request it uses that transaction (#162).',
  'queue/tenant-job-runner.ts':
    'BullMQ jobs have no request: checks tenants.status (ADR-0003 consequence 4), then opens its own transaction with set_config per job.',
  'queue/processors/maintenance.processor.ts':
    'System-wide idempotency_keys cleanup job with no tenant — note it runs as pos_app with no app.tenant_id, so under forced RLS it deletes nothing (pre-existing; reported on #150).',
  'platform/platform-auth.guard.ts':
    'Admin plane (ADR-0002): ADMIN_DATA_SOURCE, checks platform_admins, never a tenant request.',
  'platform/platform-auth.service.ts':
    'Admin plane (ADR-0002): ADMIN_DATA_SOURCE for platform login.',
  'platform/platform-tenants.service.ts':
    'Admin plane (ADR-0002): ADMIN_DATA_SOURCE creates tenants and changes their status across tenants.',
  'platform/tenant-import.service.ts':
    'Admin plane (ADR-0002/0005): ADMIN_DATA_SOURCE imports a whole tenant in one owner transaction.',
};

function rel(path: string): string {
  return relative(SRC, path).split(sep).join('/');
}

const productionFiles = () =>
  tsFiles(SRC).filter((path) => !path.endsWith('.spec.ts'));

describe('the tenant door (ADR-0003, tx.1 #150)', () => {
  // The scan is only worth its line count if it still recognises every way in, and still
  // ignores the shapes that hold no pool.
  it('recognises each way of reaching a pool and ignores a passed-in runner', () => {
    expect(
      reachesForPool('constructor(private readonly ds: DataSource) {}'),
    ).toBe(true);
    expect(
      reachesForPool(
        'constructor(\n  @Inject(LOGGER) l: Logger,\n  @Inject(AUDIT_DATA_SOURCE) a: X,\n) {}',
      ),
    ).toBe(true);
    expect(reachesForPool('constructor(@InjectDataSource() ds) {}')).toBe(true);
    expect(reachesForPool('const ds = moduleRef.get(DataSource);')).toBe(true);
    expect(
      reachesForPool('const ds = new DataSource({ type: "postgres" });'),
    ).toBe(true);

    expect(
      reachesForPool(
        'async log(runner: EntityManager | DataSource, input: X) {}',
      ),
    ).toBe(false);
    expect(
      reachesForPool('constructor(private readonly tenants: TenantService) {}'),
    ).toBe(false);
    expect(
      reachesForPool('// constructor(private readonly ds: DataSource)'),
    ).toBe(false);
  });

  it('only allowlisted files reach for a DataSource of their own', () => {
    const offenders = productionFiles()
      .filter((path) => reachesForPool(readFileSync(path, 'utf8')))
      .map(rel)
      .filter((file) => !(file in ALLOWED));

    expect(offenders).toEqual([]);
  });

  it('every allowlist entry still reaches for a pool, so the list cannot rot into permission', () => {
    const reaching = new Set(
      productionFiles()
        .filter((path) => reachesForPool(readFileSync(path, 'utf8')))
        .map(rel),
    );
    expect(Object.keys(ALLOWED).filter((file) => !reaching.has(file))).toEqual(
      [],
    );
  });
});
