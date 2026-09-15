import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #213 — a ceiling on how long a `pos_app` transaction can stay open, because the phase-2
 * pull rewinds its `?updatedSince=` cursor by 30 s (#191, ADR-0010). A row stamped
 * `updated_at = now()` (transaction start) that commits more than 30 s later can land
 * behind a cursor that already passed it, and is never pulled.
 *
 * Postgres 16 (`docker-compose.yml`) has no `transaction_timeout` (17+), so this bounds
 * the two things a transaction can wait on, not their sum:
 * - `statement_timeout = 5s` — one statement, lock waits included (57014: the statement is
 *   cancelled, the transaction can only roll back, the connection survives);
 * - `idle_in_transaction_session_timeout = 5s` — the application stalling between
 *   statements with the transaction open (Postgres ends the session, the transaction rolls
 *   back, pg-pool drops the client).
 * One slow statement plus one stall is ≤ 10 s, leaving 20 s of the 30 s rewind for commit
 * latency. The longest transaction measured is ~14–22 ms (`tx-hold-measure.e2e-spec.ts`),
 * so 5 s is ~250× that; it also cuts a lock-stuck request well inside nginx's and the
 * client's write timeouts, so the counter sees a 500 (fate unknown, resend the same key)
 * rather than a 504.
 *
 * Set on the role **in this database**, so every `pos_app` connection gets it at session
 * start — request pool, audit pool, BullMQ worker, psql — and nothing per query. The owner
 * (`postgres`: migrations, `ADMIN_DATA_SOURCE`, platform provisioning and import) is
 * untouched. Scoped `IN DATABASE` so `schema.e2e-spec.ts` applying and reverting migrations
 * in `pos_schema_test` never clears the setting on `pos`. A connection opened before this
 * migration keeps its old settings until it reconnects.
 */
export class AppRoleTransactionCeiling1788652802130 implements MigrationInterface {
  name = 'AppRoleTransactionCeiling1788652802130';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        EXECUTE format('ALTER ROLE pos_app IN DATABASE %I SET statement_timeout = %L',
                       current_database(), '5s');
        EXECUTE format('ALTER ROLE pos_app IN DATABASE %I SET idle_in_transaction_session_timeout = %L',
                       current_database(), '5s');
      END $$`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      DO $$
      BEGIN
        EXECUTE format('ALTER ROLE pos_app IN DATABASE %I RESET statement_timeout',
                       current_database());
        EXECUTE format('ALTER ROLE pos_app IN DATABASE %I RESET idle_in_transaction_session_timeout',
                       current_database());
      END $$`);
  }
}
