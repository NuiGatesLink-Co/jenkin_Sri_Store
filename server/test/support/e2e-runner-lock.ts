import { hostname } from 'node:os';
import { Client } from 'pg';

/**
 * #141: one `pnpm test:e2e` per Postgres at a time.
 *
 * Every e2e file shares one database (`pos`), one Redis pair and the scratch database
 * `test/schema.e2e-spec.ts` drops `WITH (FORCE)` and re-migrates. Two concurrent runs
 * do not fail cleanly — one run's `DROP DATABASE … WITH (FORCE)` kills the other's
 * migration ("terminating connection due to administrator command"), `resetTenant`
 * wipes rows under the other run's assertions, and document numbers start
 * mid-series. So the run takes a session-level advisory lock before any file starts
 * and refuses to start, naming the holder, if another run already has it.
 *
 * Why a session advisory lock on a dedicated connection:
 * - it is released by Postgres itself when the connection goes away, so a crashed
 *   or Ctrl+C'd run never leaves a stale lock behind (a lock file or a row would);
 * - advisory locks are scoped to one database, so it is taken in the maintenance
 *   database of `DATABASE_ADMIN_URL` (`postgres` by default) — never in
 *   `pos_schema_test`, whose `DROP … WITH (FORCE)` would terminate this connection
 *   and silently release the lock mid-run, and never in a database a suite drops.
 */

// Arbitrary but fixed: ('S'<<8 | 'R', issue number). Two-key form, so pg_locks shows
// it as classid/objid with objsubid = 2.
const LOCK_CLASS = 0x5352;
const LOCK_OBJ = 141;

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ??
  'postgres://postgres:dev-only-postgres@127.0.0.1:5432/postgres';

// Postgres truncates application_name to 63 bytes; keep the useful part first.
const APP_NAME = `e2e-lock pid=${process.pid} host=${hostname()}`.slice(0, 63);

interface Holder {
  pid: number;
  application_name: string;
  client_addr: string | null;
  backend_start: Date;
}

async function describeHolder(c: Client): Promise<string> {
  const r = await c.query<Holder>(
    `SELECT a.pid, a.application_name, a.client_addr, a.backend_start
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND l.classid = $1 AND l.objid = $2 AND l.objsubid = 2`,
    [LOCK_CLASS, LOCK_OBJ],
  );
  const h = r.rows[0];
  if (!h) return 'another run (it released the lock just now; retry)';
  return (
    `"${h.application_name}" (backend pid ${h.pid}` +
    `${h.client_addr ? `, from ${h.client_addr}` : ''}` +
    `, running since ${h.backend_start.toISOString()})`
  );
}

export default async function setup(): Promise<() => Promise<void>> {
  const client = new Client({
    connectionString: ADMIN_URL,
    application_name: APP_NAME,
    keepAlive: true,
  });
  try {
    await client.connect();
  } catch (e) {
    throw new Error(
      `e2e runner lock: cannot reach Postgres at ${ADMIN_URL.replace(/\/\/[^@]*@/, '//***@')} ` +
        `(is the compose dev stack up?): ${(e as Error).message}`,
    );
  }

  // If this connection dies mid-run (someone ran pg_terminate_backend, Postgres
  // restarted) the lock is gone and a second run could start. Do not crash the
  // runner from an 'error' event; remember it and fail the run at teardown.
  let lost: Error | undefined;
  client.on('error', (e) => {
    if (lost) return; // pg emits a second 'Connection terminated' for the same death
    lost = e;
    console.error(
      `\ne2e runner lock: the lock connection died mid-run (${e.message}); ` +
        'another run may now be sharing this database. This run will be failed.\n',
    );
  });

  const got = await client.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock($1, $2) AS ok',
    [LOCK_CLASS, LOCK_OBJ],
  );
  if (!got.rows[0].ok) {
    const holder = await describeHolder(client);
    await client.end();
    throw new Error(
      `e2e runner lock: another \`pnpm test:e2e\` is already running against this ` +
        `Postgres; held by ${holder}. Two runs share the \`pos\` database, both Redis ` +
        `and the scratch database the schema suite drops, so a second run would ` +
        `corrupt the first (#141). Wait for it to finish, then run again.`,
    );
  }

  return async () => {
    if (lost) {
      throw new Error(
        `e2e runner lock: lost the lock connection during the run (${lost.message}); ` +
          'results may have been corrupted by a concurrent run.',
      );
    }
    // Ending the session releases the lock; the explicit unlock only documents it.
    await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_CLASS, LOCK_OBJ]);
    await client.end();
  };
}
