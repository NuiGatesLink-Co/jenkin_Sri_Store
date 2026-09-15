import { Global, Module, Inject } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import type { Logger } from 'pino';
import { TenantService } from '../common/database/tenant.service.js';
import { APP_ROLE_TIMEOUTS } from '../common/database/commit-ceiling.js';
import { LOGGER } from './logger.provider.js';

export const ADMIN_DATA_SOURCE = Symbol('ADMIN_DATA_SOURCE');
export const AUDIT_DATA_SOURCE = Symbol('AUDIT_DATA_SOURCE');

/**
 * Three TypeORM DataSources per process:
 * 1. Default `DataSource` connects as the non-superuser `pos_app` role (RLS enabled/forced).
 * 2. `ADMIN_DATA_SOURCE` connects as admin/owner (`postgres`) for platform operations (bypasses RLS).
 * 3. `AUDIT_DATA_SOURCE` connects as `pos_app` too, on a tiny pool of its own, for the
 *    audit rows that have to outlive the rollback of the request that produced them.
 * `synchronize` is never true — schema comes only from migrations (#15).
 */
@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      inject: [APP_CONFIG, LOGGER],
      useFactory: async (cfg: AppConfig, logger: Logger) => {
        const ds = new DataSource({
          type: 'postgres',
          url: cfg.databaseUrl,
          synchronize: false,
          migrationsRun: false,
          entities: [],
          poolSize: cfg.dbPoolSize,
          extra: {
            connectionTimeoutMillis: Number(
              process.env.DB_CONNECTION_TIMEOUT_MS ?? 10000,
            ),
            idleTimeoutMillis: 30000,
          },
        });
        await ds.initialize();
        await warnIfRoleTimeoutsDiffer(ds, logger);
        return ds;
      },
    },
    {
      provide: ADMIN_DATA_SOURCE,
      inject: [APP_CONFIG],
      useFactory: async (cfg: AppConfig) => {
        const ds = new DataSource({
          type: 'postgres',
          url: cfg.adminDatabaseUrl,
          synchronize: false,
          migrationsRun: false,
          entities: [],
          poolSize: cfg.dbPoolSize,
          extra: { connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 },
        });
        return ds.initialize();
      },
    },
    {
      provide: AUDIT_DATA_SOURCE,
      inject: [APP_CONFIG],
      useFactory: async (cfg: AppConfig) => {
        const ds = new DataSource({
          type: 'postgres',
          // `pos_app`, NOT the admin URL. An audit row is tenant data: written as the
          // owner it would be a row RLS never checked, and a wrong `tenant_id` would
          // land silently in another shop's log instead of being refused.
          url: cfg.databaseUrl,
          synchronize: false,
          migrationsRun: false,
          entities: [],
          // Two, not `cfg.dbPoolSize`. Nothing here is on the path a request follows —
          // it exists so a refusal audit never queues for a connection the request pool
          // owns. The writes are single INSERTs, and the pool opens nothing until the
          // first one, so a process that never refuses a void never connects at all.
          poolSize: 2,
          // The request pool's default, not less (#175). The 2 s this used to be assumed the
          // caller held its request connection while waiting here; since tx.5 (#154) a void
          // denial holds none, so waiting longer pins nothing — and giving up drops the row.
          // Bursts are bounded upstream: wrong PINs by `consumeAttempt` (5/user/300 s), role and
          // no-PIN denials by the per-tenant route limit (ADR-0006). Measured at pool 2 with no
          // route limit (`loadtest` plan): 1000 concurrent role denials, 1000 rows, 6.2 s.
          extra: { connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 },
        });
        return ds.initialize();
      },
    },
    TenantService,
  ],
  exports: [DataSource, ADMIN_DATA_SOURCE, AUDIT_DATA_SOURCE, TenantService],
})
export class DbModule {
  constructor(
    private readonly ds: DataSource,
    @Inject(ADMIN_DATA_SOURCE) private readonly adminDs: DataSource,
    @Inject(AUDIT_DATA_SOURCE) private readonly auditDs: DataSource,
  ) {}

  async onModuleDestroy() {
    if (this.ds.isInitialized) await this.ds.destroy();
    if (this.adminDs.isInitialized) await this.adminDs.destroy();
    if (this.auditDs.isInitialized) await this.auditDs.destroy();
  }
}

/**
 * #213: the `pos_app` timeouts come from migration `1788652802130` as role-in-database
 * settings, which a plain `pg_dump`/restore drops and which a pooled connection only picks
 * up when it reconnects. Loud, but never fatal — readiness does not depend on it.
 */
async function warnIfRoleTimeoutsDiffer(ds: DataSource, logger: Logger): Promise<void> {
  try {
    for (const [name, expected] of Object.entries(APP_ROLE_TIMEOUTS)) {
      const [row] = (await ds.query(`SHOW ${name}`)) as Record<string, string>[];
      if (row?.[name] !== expected) {
        logger.warn(
          { setting: name, actual: row?.[name], expected },
          'pos_app transaction ceiling is not in force (#213): re-run migrations or restore role settings, then restart',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'could not read the pos_app transaction ceiling (#213)');
  }
}
