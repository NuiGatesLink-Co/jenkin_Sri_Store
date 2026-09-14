import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service.js';
import type { Logger } from 'pino';
import { AUDIT_DATA_SOURCE } from '../infra/db.module.js';
import { LOGGER } from '../infra/logger.provider.js';
import { TenantCache } from '../infra/tenant-cache.service.js';
import { newId } from '../common/ids.js';
import { fromSatang, satangOf } from '../common/money.js';
import { verifyPassword } from '../common/password.js';
import {
  currentRequestContext,
  hasOpenTransaction,
} from '../common/request-context.js';
import { TenantService } from '../common/database/tenant.service.js';
import { returning } from '../common/sql.js';
import { ShiftsService } from '../shifts/shifts.service.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import {
  SaleReadsService,
  saleNotFound,
  type SaleWithItems,
} from './sale-reads.service.js';
import { MECHANIC_CREDIT } from './sales.service.js';

/** The bill under its own row lock — everything the void has to undo. */
interface LockedSale {
  voided: boolean;
  shift_id: string | null;
  customer_id: string | null;
  mechanic_id: string | null;
  mechanic_delta: string | null;
  payment_method: string;
  total: string;
  points_granted: number;
}

/** Who is voiding, from the token — plus the PIN they typed, which is not. */
export interface VoidActor {
  userId: string;
  role: string | undefined;
  deviceId: string;
  pin: string;
  ip?: string;
}

/**
 * Only these may void a bill: the counter staff must fetch someone (§4.2 says
 * `manager`; `owner` is included because nothing in this shop's role model puts an
 * owner below a manager — recorded in §4.2 rather than left implicit here).
 */
const ROLES_THAT_MAY_VOID = new Set(['manager', 'owner']);

function mayVoid(role: string | undefined): boolean {
  return role !== undefined && ROLES_THAT_MAY_VOID.has(role);
}

/**
 * Proof that `VoidService.authorise` passed for this actor, this bill and this tenant.
 * Exported as a type only, and the private member makes it nominal, so nothing outside this
 * file can build one. The type cannot tie it to a bill, so `voidIn` checks `saleId` and
 * `tenantId` at run time: a proof for bill A cannot void bill B.
 */
class AuthorisedVoid {
  // nominal brand: a structural look-alike object literal does not type-check
  private readonly pinChecked = true;
  constructor(
    readonly actor: VoidActor,
    readonly saleId: string,
    readonly tenantId: string,
  ) {}
}
export type { AuthorisedVoid };

/**
 * The manual void.
 *
 * 🔴 **This endpoint has no equivalent in the old app** — there, a bill is voided only
 * as the automatic consequence of returning every line (`02_API_SCREENS.md §2` lists
 * it under "new, not a port"). #23 asks for it explicitly, so it is built here, but
 * the shop has never had a "void" button and should see one before it ships.
 */
@Injectable()
export class VoidService {
  constructor(
    private readonly reads: SaleReadsService,
    private readonly audit: AuditService,
    private readonly shifts: ShiftsService,
    @Inject(AUDIT_DATA_SOURCE) private readonly auditDs: DataSource,
    private readonly rateLimit: RateLimitService,
    private readonly cache: TenantCache,
    private readonly tenants: TenantService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * The void itself. It takes what `authorise` returns, not a bare actor: since tx.5 (#154)
   * the PIN is checked before this transaction opens, so a caller that skipped the check
   * must not compile.
   */
  void(saleId: string, authorised: AuthorisedVoid): Promise<SaleWithItems> {
    return this.tenants.runTx(() => this.voidIn(saleId, authorised));
  }

  private async voidIn(
    saleId: string,
    authorised: AuthorisedVoid,
  ): Promise<SaleWithItems> {
    const { tenantId, manager } = currentRequestContext();
    if (authorised.saleId !== saleId || authorised.tenantId !== tenantId) {
      // A programming error, not a client one: the PIN was checked for another bill or shop.
      throw new Error('AuthorisedVoid does not match the bill and tenant being voided');
    }
    const { actor } = authorised;

    // Locked, because two clerks voiding the same bill would otherwise both restore
    // its stock and the shop would gain inventory it never had. The ledger columns
    // ride along on that lock: the reversal has to subtract the figures this bill
    // actually wrote, and it reads them under the same lock that makes it exclusive.
    const rows = (await manager.query(
      `SELECT voided, shift_id, customer_id, mechanic_id, mechanic_delta,
              payment_method, total, points_granted
         FROM sales WHERE tenant_id = $1::uuid AND id = $2 FOR UPDATE`,
      [tenantId, saleId],
    )) as LockedSale[];
    if (rows.length === 0) throw saleNotFound();
    if (rows[0].voided) {
      throw new HttpException(
        { code: 'SALE_VOIDED', message: 'Bill already voided' },
        HttpStatus.CONFLICT,
      );
    }

    const returned = (await manager.query(
      `SELECT count(*)::int AS n FROM returns WHERE tenant_id = $1::uuid AND sale_id = $2`,
      [tenantId, saleId],
    )) as { n: number }[];
    if (returned[0].n > 0) {
      // Part of this bill has already been credited back; voiding the whole thing
      // would restore that stock twice. The credit note is the record that stands.
      throw new HttpException(
        {
          code: 'SALE_HAS_RETURNS',
          message:
            'This bill already has a credit note against it and cannot be voided.',
        },
        HttpStatus.CONFLICT,
      );
    }

    const sale = rows[0];
    // Only a bill from this device's open drawer (owner's decision on #94, 2026-09-13).
    // The closing report is computed by `shift_id` and leaves voided bills out, so
    // voiding a bill from a closed shift would rewrite a drawer already counted, while
    // the drawer the money actually left shows no outflow. An older bill — another
    // shift, another device's, or an imported one with no shift — is undone by a credit
    // note, which lands in the current drawer. After `SALE_VOIDED`/`SALE_HAS_RETURNS`,
    // so a retry of a void that already committed still says so once the drawer has
    // closed; an `Idempotency-Key` replay never reaches this method at all. `FOR SHARE`
    // (see `requireOpenShiftIdFor`) so a close waits for a void in flight instead of
    // counting a bill this transaction is about to take out of it. Not audited like the
    // PIN denial: the caller has already proved the PIN, and this is a business rule.
    const openShiftId = await this.shifts.requireOpenShiftIdFor(
      manager,
      tenantId,
      actor.deviceId,
    );
    if (sale.shift_id !== openShiftId) {
      throw new HttpException(
        {
          code: 'SALE_NOT_IN_OPEN_SHIFT',
          message:
            'This bill is not from the open shift and cannot be voided. Issue a credit note instead.',
        },
        HttpStatus.CONFLICT,
      );
    }

    // 🔴 The mechanic's row lock is taken here, before the first product row.
    // `sales.service.ts` locks mechanic → products → doc_counters; a void that
    // reached the mechanic after the products would close the cycle and deadlock
    // against a concurrent bill for the same mechanic sharing one product. The
    // customer is deliberately left to `reverseLedger`, after the stock, because
    // that is where the sale path takes it too.
    await this.lockMechanic(manager, tenantId, sale.mechanic_id);

    await this.restoreStock(manager, tenantId, saleId);
    await this.reverseLedger(manager, tenantId, sale);
    // #32: stock put back and the ledger reversed — drop those cached pages after commit.
    this.cache.invalidateAfterCommit(tenantId, 'products');
    if (sale.customer_id !== null) this.cache.invalidateAfterCommit(tenantId, 'customers');
    if (sale.mechanic_id !== null) this.cache.invalidateAfterCommit(tenantId, 'mechanics');

    const voided = returning<{ voided_at: Date }>(
      await manager.query(
        `UPDATE sales SET voided = TRUE, voided_at = now()
          WHERE tenant_id = $1::uuid AND id = $2
      RETURNING voided_at`,
        [tenantId, saleId],
      ),
    );

    await this.audit.log(manager, {
      tenantId,
      userId: actor.userId,
      deviceId: actor.deviceId,
      action: 'sale.void',
      entity: 'sales',
      entityId: saleId,
      after: { voidedAt: voided[0].voided_at.toISOString() },
      ip: actor.ip,
    });

    return this.reads.byId(saleId);
  }

  /**
   * Takes the mechanic's row lock, in the sale path's lock order, so the ledger
   * reversal below can run after the stock without inverting it.
   *
   * No row is not an error: a mechanic deleted since the bill has nothing to lock
   * and nothing to reverse, and the void still stands.
   */
  private async lockMechanic(
    manager: EntityManager,
    tenantId: string,
    mechanicId: string | null,
  ): Promise<void> {
    if (mechanicId === null) return;
    await manager.query(
      `SELECT id FROM mechanics WHERE tenant_id = $1::uuid AND id = $2 FOR UPDATE`,
      [tenantId, mechanicId],
    );
  }

  /**
   * Undoes what `POST /sales` applied to the customer and the mechanic — the same two
   * statements as `applyCustomer`/`applyMechanic`, with every sign flipped.
   *
   * In **full, never in proportion**: a bill with a credit note against it was already
   * refused above (`SALE_HAS_RETURNS`), so there is no partial refund to share out the
   * way `POST /returns` has to. What the sale added is exactly what comes off.
   *
   * `GREATEST(0, …)` on every running total. `points` and `credit_balance` have a
   * `>= 0` CHECK that would at least raise if this were wrong, but `total_spend`,
   * `total_sales`, `total_discount` and `total_markup` have none — an unclamped
   * subtraction against a figure imported short from the old app goes negative in
   * silence.
   *
   * 🔴 `total_credit` is never written (decision #11): it is the JS app's legacy alias
   * of `total_discount`, the sale path deliberately does not write it, and a void that
   * did would move a column no sale ever moved.
   */
  private async reverseLedger(
    manager: EntityManager,
    tenantId: string,
    sale: LockedSale,
  ): Promise<void> {
    if (sale.customer_id !== null) {
      await manager.query(
        `UPDATE customers
            SET points = GREATEST(0, points - $3),
                total_spend = GREATEST(0, total_spend - $4),
                updated_at = now()
          WHERE tenant_id = $1::uuid AND id = $2`,
        [tenantId, sale.customer_id, sale.points_granted, sale.total],
      );
    }

    if (sale.mechanic_id === null) return;
    // A negative delta was a discount given to the mechanic, a positive one a markup.
    const delta =
      sale.mechanic_delta === null ? 0 : satangOf(sale.mechanic_delta);
    await manager.query(
      `UPDATE mechanics
          SET total_sales = GREATEST(0, total_sales - $3),
              total_discount = GREATEST(0, total_discount - $4),
              total_markup = GREATEST(0, total_markup - $5),
              credit_balance = GREATEST(0, credit_balance - $6),
              updated_at = now()
        WHERE tenant_id = $1::uuid AND id = $2`,
      [
        tenantId,
        sale.mechanic_id,
        sale.total,
        fromSatang(delta < 0 ? -delta : 0),
        fromSatang(delta > 0 ? delta : 0),
        // Only a bill that went on the tab put anything on it.
        sale.payment_method === MECHANIC_CREDIT ? sale.total : '0.00',
      ],
    );
  }

  /**
   * Puts every line back and writes the ledger rows that say so.
   *
   * The customer and mechanic ledger is handled by `reverseLedger`, which runs after
   * this — the sale path updates the customer after the products too, and the void
   * must not invert that order.
   */
  private async restoreStock(
    manager: EntityManager,
    tenantId: string,
    saleId: string,
  ): Promise<void> {
    const items = (await manager.query(
      `SELECT product_id, sum(qty)::int AS qty
         FROM sale_items
        WHERE tenant_id = $1::uuid AND sale_id = $2
        GROUP BY product_id
        ORDER BY product_id`,
      [tenantId, saleId],
    )) as { product_id: string; qty: number }[];

    for (const item of items) {
      const updated = returning<{
        stock: number;
        part_no: string;
        name: string;
      }>(
        await manager.query(
          `UPDATE products
              SET stock = stock + $3, updated_at = now()
            WHERE tenant_id = $1::uuid AND id = $2
        RETURNING stock, part_no, name`,
          [tenantId, item.product_id, item.qty],
        ),
      );
      // A soft-deleted product is restored like any other — the goods physically
      // exist again — and `POST /returns` does the same. Only a product with no row
      // at all is skipped, which a sold one cannot be: `movements` has a foreign key
      // to `products` with no cascade and every sale writes a row per product, so
      // deleting one that has ever sold can only ever set `deleted_at`.
      if (updated.length === 0) continue;

      await manager.query(
        `INSERT INTO movements (
           tenant_id, id, product_id, part_no, name, delta, type, stock_after, ref_id)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, 'void', $7, $8)`,
        [
          tenantId,
          newId('mv'),
          item.product_id,
          updated[0].part_no,
          updated[0].name,
          item.qty,
          updated[0].stock,
          // The bare sale id. `uq_movements_ref` is unique on
          // `(tenant_id, type, ref_id, product_id)`, so a credit note against this
          // bill keeps its own slot under type 'return'.
          saleId,
        ],
      );
    }
  }

  /**
   * `manager` (or `owner`, who outranks one) plus the PIN. The role comes from the
   * token and the PIN from the body: a stolen unlocked terminal is the threat here,
   * so the second factor has to be something the thief has to know, not something the
   * session already carries.
   *
   * 🔴 **The controller calls this before `runIdempotent`, with no transaction open**
   * (tx.5, #154). One argon2 verify takes ~75 ms; inside the claim's transaction it held a
   * pooled connection for all of it, and at `DB_POOL_SIZE=2` four voids queued into a
   * staircase. So, strictly in sequence:
   *   1. one short `runTx` reads the tenant and `pin_hash` (`users` is under RLS, so the
   *      read needs the tenant scope), commits, and gives its connection back;
   *   2. the role check, the per-user PIN rate limit (an atomic Redis `consumeAttempt`,
   *      counted before the verify), the missing-PIN check — the same three refusals in the
   *      same order they had inside the transaction;
   *   3. `verifyPassword`, with no transaction and no connection held.
   *
   * Safe because the PIN is an **authorisation, not an invariant**: nothing about the bill
   * is read or written here, and a PIN changed between this read and the void still
   * authorised it with the PIN that was actually typed.
   *
   * The consequence: an `Idempotency-Key` that is already done no longer skips this check.
   * A replay with a wrong or missing PIN answers 403 and writes a denial row instead of the
   * stored 200 — and a replay with the right PIN spends one argon2 verify before replaying.
   */
  async authorise(saleId: string, actor: VoidActor): Promise<AuthorisedVoid> {
    // Called inside a transaction, argon2 below would silently hold its connection again —
    // exactly what this method exists to avoid, and a nested `runTx` here would only join.
    if (hasOpenTransaction()) {
      throw new Error(
        'VoidService.authorise must run with no transaction open: argon2 would hold its connection',
      );
    }
    const { tenantId, pinHash } = await this.tenants.runTx(() =>
      this.readTenantAndPinHash(actor),
    );
    const deny = async (reason: string): Promise<HttpException> => {
      await this.auditDenial(tenantId, actor, saleId, reason);
      return forbidden();
    };

    if (!mayVoid(actor.role)) throw await deny('role');

    // Per-user PIN brute-force defense (#44, OWASP A07). 🔴 Counted BEFORE the verify, in one
    // atomic step (#154 review, B1): check-then-increment was bounded only by the pool while
    // argon2 ran inside the claim's transaction; out of it, 60 concurrent guesses all passed the
    // check and all reached argon2. Now the sixth concurrent guess is a 429 whatever the pool.
    const pinKey = `void:pin:${tenantId}:${actor.userId}`;
    const pinStatus = await this.rateLimit.consumeAttempt(pinKey, 5, 300);
    if (!pinStatus.allowed) {
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Too many incorrect PIN attempts. Please try again later.',
          retryAfter: pinStatus.retryAfter ?? 300,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (!pinHash) {
      // A user with no PIN set is not guessing: give the attempt back, so they keep getting
      // the 403 that says so rather than a lockout after five tries.
      await this.rateLimit.refundAttempt(pinKey, 300);
      throw await deny('no-pin');
    }
    if (!actor.pin || !(await verifyPassword(actor.pin, pinHash))) {
      throw await deny('pin');
    }

    // Clear failed PIN counter on success
    await this.rateLimit.clearKey(pinKey, 300);
    return new AuthorisedVoid(actor, saleId, tenantId);
  }

  /**
   * The tenant `authorise` names in its rate-limit key and denial row, and the actor's
   * `pin_hash` — the only row it reads. A role that may not void is refused before the
   * hash matters, so none is read for one.
   */
  private async readTenantAndPinHash(
    actor: VoidActor,
  ): Promise<{ tenantId: string; pinHash: string | null }> {
    const { tenantId, manager } = currentRequestContext();
    if (!mayVoid(actor.role)) return { tenantId, pinHash: null };
    const rows = (await manager.query(
      `SELECT pin_hash FROM users
        WHERE tenant_id = $1::uuid AND id = $2::uuid AND is_active`,
      [tenantId, actor.userId],
    )) as { pin_hash: string | null }[];
    return { tenantId, pinHash: rows[0]?.pin_hash ?? null };
  }

  /**
   * Records a refused void.
   *
   * On its **own** connection. Since tx.5 (#154) a refusal happens before `runIdempotent`
   * opens any transaction, so there is none to roll back today; the separate connection
   * keeps the row durable regardless of where the check runs, the same reason `AuthService`
   * keeps its own. This is a four-digit PIN; brute-forcing it must not be invisible.
   *
   * 🔴 That connection comes from `AUDIT_DATA_SOURCE`, **not** from the request pool.
   * Taken from the request pool this is a request holding one connection while queuing
   * for a second: measured at `DB_POOL_SIZE=2`, four concurrent denials answered
   * `403,403,500,500` in 5112 ms, the two 500s being unrelated requests whose middleware
   * timed out waiting for a connection these were sitting on. The first denial branch is
   * the role check, so any authenticated cashier can reach it without knowing a PIN.
   *
   * Failing to log must not turn a 403 into a 500, so the write is best-effort — and the
   * connection is only taken on the refusal path, never on the one every request follows.
   */
  private async auditDenial(
    tenantId: string,
    actor: VoidActor,
    saleId: string,
    reason: string,
  ): Promise<void> {
    const qr = this.auditDs.createQueryRunner();
    try {
      await qr.connect();
      await qr.startTransaction();
      // Its own `SET LOCAL`: RLS is forced, and a connection that has not named a
      // tenant cannot insert a tenant-scoped row at all.
      await qr.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await qr.query(
        `INSERT INTO audit_log (tenant_id, user_id, device_id, action, entity, entity_id, after)
              VALUES ($1::uuid, $2::uuid, $3, 'sale.void.denied', 'sales', $4, $5::jsonb)`,
        [tenantId, actor.userId, actor.deviceId, saleId, JSON.stringify({ reason })],
      );
      await qr.commitTransaction();
    } catch (err) {
      // The refusal itself is what matters; the log is best-effort. Failing to write
      // it must not turn a 403 into a 500 — but a lost row must not be silent either
      // (#154 review: one of 150 went missing when this 2-connection pool timed out).
      this.logger.error(
        { err, tenantId, saleId, reason },
        'sale.void.denied audit row was not written',
      );
      if (qr.isTransactionActive) await qr.rollbackTransaction().catch(() => {});
    } finally {
      if (!qr.isReleased) await qr.release().catch(() => {});
    }
  }
}

function forbidden(): HttpException {
  return new HttpException(
    { code: 'FORBIDDEN', message: 'Manager PIN required' },
    HttpStatus.FORBIDDEN,
  );
}
