# Srisurart POS — server (phase 1)

> **2026-09-08 — CouchDB was proposed and rejected the same day**
> (`../docs/Backend_design/adr/0012-couchdb-replaces-postgres.md`). PostgreSQL stays; the
> #15 migrations and `test/schema.e2e-spec.ts` are current; #4 `p3` is next.

NestJS multi-tenant backend. Design lives in `../docs/Backend_design/` (ADRs win over
prose); work items live in GitHub issues (#2 is the brief). Landed so far: **#14 `p1`**
(compose stack, Nginx, health probes) and **#15 `p2`** (the 27-table schema as migrations,
RLS, grants, category seed). No auth or business endpoints yet — #4 is next.

## Run

```
cd server
cp .env.example .env     # required: compose enforces that secrets are present
docker compose up -d --build
curl -k https://localhost/health/live     # → {"status":"success","data":{"status":"up"}}
curl -k https://localhost/health/ready    # checks Postgres + both Redis
```

That is the whole stack: Nginx (TLS, self-signed) → `api-1..3` → PostgreSQL, `redis-cache`,
`redis-queue`, plus the BullMQ `worker` and `bull-board` (http://127.0.0.1:3100, basic auth).
The one-shot `migrate` job applies the schema as the owner role before any `api-*` starts.
Secrets are required via `server/.env` (see `.env.example`); `docker-compose.yml` fails fast
if `POSTGRES_PASSWORD`, `POS_APP_PASSWORD`, `REDIS_PASSWORD` or `BULL_BOARD_PASSWORD` is unset.

**Only Nginx (80/443) and Bull-Board (loopback 3100) are reachable from the host.** Postgres
and both Redis publish no port at all in `docker-compose.yml` — they are reachable only over
the compose network, and both Redis require `AUTH` (`--requirepass`, password carried in
`REDIS_*_URL`). Tools that run outside Docker need the dev overlay, which publishes
5432 / 6379 / 6380 on `127.0.0.1`:

```
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait postgres redis-cache redis-queue
```

🔴 The overlay is for a laptop or a CI runner. **Never use it on the faculty VM or any shared
host** — a second user or an SSRF bug on that host would then reach the datastores directly.

Local development without Docker for the app itself:

```
corepack pnpm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait postgres redis-cache redis-queue
corepack pnpm build
DATABASE_URL=postgres://postgres:dev-only-postgres@127.0.0.1:5432/pos corepack pnpm db:migrate
DATABASE_URL=postgres://pos_app:dev-only-pos-app@127.0.0.1:5432/pos \
REDIS_CACHE_URL=redis://:dev-only-redis@127.0.0.1:6379 \
REDIS_QUEUE_URL=redis://:dev-only-redis@127.0.0.1:6380 \
corepack pnpm start:dev
```

## Checks

```
corepack pnpm typecheck && corepack pnpm lint && corepack pnpm test   # pure unit tests
corepack pnpm test:e2e      # against the compose Postgres/Redis — no mocks; the schema
                            # suite re-runs the real migrations on a scratch database
```

`.github/workflows/server.yml` (#38) runs the same three as separate jobs — lint, unit,
integration — on every push/PR touching `server/**`, starting the compose Postgres + both
Redis (with the dev overlay, so the runner can reach them) and applying the migrations first.

## Schema and migrations (#15)

- Schema exists **only** through `src/db/migrations/*` — `synchronize` is never true, in any
  environment including tests. `node dist/db/migrate.js up|down|status` (`pnpm db:migrate*`)
  runs them; the compose `migrate` service runs `up` once, as `postgres`, before `api-*` start.
- 27 tables (01_DATABASE §5). `change_log` is phase 2 and does not exist. Every tenant-scoped
  table has `tenant_id` in its primary key, composite FKs, and indexes that start with `tenant_id`.
- **RLS is enabled and forced** on all 25 tenant-scoped tables with one fail-closed policy:
  `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`. With the GUC unset
  `pos_app` reads zero rows (no error) and cannot insert. `SET LOCAL app.tenant_id` inside the
  request transaction is the only way in (TenantGuard, #4). `pos_app` cannot `SET row_security = off`.
- Grants: `pos_app` has `SELECT/INSERT/UPDATE/DELETE` on every table except `movements`
  (`SELECT/INSERT` — it is a ledger) and nothing on `migrations`.
- Product search is `pg_trgm` + `ILIKE '%…%'` over `lower(part_no||' '||name||' '||name_th||' '||compat)`
  (`idx_products_search`). `to_tsvector` cannot find "เบรก" inside "ผ้าเบรกหน้า".
- `src/db/seed.ts` — `seedCategories(db, tenantId)` inserts the five categories (ADR-0001) and
  nothing else; provisioning (#5) calls it inside its transaction.

**Adding a migration:** create `src/db/migrations/<epoch-ms>-Name.ts` implementing `up` and
`down`, append the class to `MIGRATIONS` in `src/db/data-source.ts`, and if it adds a table put
the name in `TENANT_SCOPED_TABLES` (RLS + grants are asserted per table by `test/schema.e2e-spec.ts`,
so a missing entry fails the suite). Run `pnpm build && pnpm db:migrate`, then rebuild the image.

## Layout

```
src/main.ts              api entrypoint (HTTP)          → node dist/main.js
src/worker.ts            BullMQ worker (no HTTP)        → node dist/worker.js
src/bull-board.ts        Bull-Board behind basic auth   → node dist/bull-board.js
src/app.module.ts        CoreModule (config, logger, Postgres, Redis) / AppModule / WorkerModule
src/app.setup.ts         global prefix /api/v1 (health excluded), envelope, filter, JSON 404
src/common/              response envelope, error envelope, pino logger + correlation id,
                         request-context.ts (the per-request tenant + transaction seam)
src/infra/               DataSource (pos_app role, synchronize=false), ADMIN_DATA_SOURCE (owner),
                         AUDIT_DATA_SOURCE (pos_app, pool of 2, off the request pool),
                         REDIS_CACHE / REDIS_QUEUE
src/idempotency/         Idempotency-Key: claim, replay, 409 on a changed request (#18)
src/documents/           document numbers: RC01-2569-08-0042, per device per month (#19)
src/sales/               POST /sales — the sale transaction (#20)
src/returns/             POST /returns — the credit note (#22)
src/shifts/              the cash drawer: shifts, entries, the shift_id stamp (#28)
src/db/migrations/       the schema (27 tables, indexes, pg_trgm) + RLS/grants — the only source of DDL
src/db/data-source.ts    owner-role DataSource with the static MIGRATIONS list
src/db/migrate.ts        up | down | status                → node dist/db/migrate.js (compose `migrate` job)
src/db/seed.ts           SEED_CATEGORIES + seedCategories(db, tenantId) for provisioning (#5)
src/health/              /health/live (touches nothing) · /health/ready (Postgres + both Redis)
docker/nginx/nginx.conf  least_conn, TLS, per-IP limit_req, timeouts, /platform/ allowlist
docker/postgres/init/    creates the non-superuser pos_app role on first boot
```

## Idempotency (#18)

Every write that touches money or stock carries `Idempotency-Key`
(`02_API_SCREENS.md §1.4`). Apply `IdempotencyInterceptor` to those routes — never
globally: it must run inside the request transaction, and a global copy would wrap
routes that have no tenant and no key at all.

- **Postgres is the authority.** `idempotency_keys`'s primary key `(tenant_id, key)` is
  the whole concurrency mechanism: a second request carrying a live key blocks on the
  first transaction's row lock, then finds its `ON CONFLICT DO NOTHING` inserted nothing
  and replays the committed row. No advisory lock, no application-level mutex. The wait
  is bounded by `SET LOCAL lock_timeout = '5s'`, so a wedged original cannot pin a pool
  connection indefinitely; past that the retry gets `503 IDEMPOTENCY_KEY_IN_FLIGHT`.
- **The record is written in the same transaction as the work.** A crash anywhere before
  COMMIT leaves neither, and the retry does the work; a crash after COMMIT leaves both,
  and the retry replays. There is no window that bills twice. `complete()` fails the
  request if it updated no row, because committing work with no record is that window.
- **Key + body + endpoint must all match** to replay. `request_hash` covers the body
  (that is what `01_DATABASE.md` defines it as), and the `endpoint` column is compared
  alongside it — the same key and body against `POST /sales` and then `POST /returns`
  must not replay the sale and quietly perform no return. Any mismatch is
  `409 IDEMPOTENCY_KEY_REUSED`; a missing or over-long key is `400
  IDEMPOTENCY_KEY_INVALID`.
- **A replay equals the original as JSON, not byte for byte.** `response_body` is
  `jsonb`, which does not preserve object key order, and a handler returning nothing
  comes back as `null`. Clients may compare values; nothing may compare bytes or hash
  the response.
- **Redis (`t:{tid}:idem:{key}`) is an accelerator, never an authority.** It is read only
  once the primary key has already shown the request to be a repeat, so a first request
  never waits on it; it is written only after Postgres has committed the row, and only
  for that row's remaining life, so it can neither invent a success nor outlive a key
  Lane C has deleted. Every call is bounded at 200 ms and falls through on failure.
- Keys live 24h; deleting them is Lane C's `idem.cleanup` job, not this module's.

Three decisions the design docs do not cover, made here and recorded in
`02_API_SCREENS.md §8`: `IDEMPOTENCY_KEY_INVALID`, `IDEMPOTENCY_KEY_IN_FLIGHT`, and the
200-character key bound (`(tenant_id, key)` is a btree index; an unbounded key is a 500).

### The request-context seam

`src/common/request-context.ts` holds the request's `{ tenantId, manager }`. **ADR-0003
makes `TenantGuard` (#4) the one component allowed to check tenant status and
`SET LOCAL app.tenant_id`** — but a guard cannot be the whole story, because
`canActivate` returns before the handler runs, so it can neither hold that scope open
across the handler nor commit afterwards. The wiring #4 has to build is a split, and
ADR-0003 survives it intact because only the guard still touches the tenant:

| stage | does |
|---|---|
| middleware | `runInRequestContext({ tenantId, manager }, next)` — opens the transaction and the scope |
| `TenantGuard` | checks `tenants.status` and `SET LOCAL app.tenant_id` on that manager |
| interceptor | commits on success, rolls back on error, before the response is sent |

This shape is scheduled for replacement: the 2026-09-10 addendum to ADR-0003
(*"ใครตัดสิน กับ ใครลงมือ"*) moves the transaction inside the handler, and
`docs/Backend_design/adr/0003-handler-scoped-migration-plan.md` sequences that as
`tx.0`–`tx.5` — the split above is what runs until `tx.4` lands.

**How the tenant is named: `SELECT set_config('app.tenant_id', $1, true)`, never
`SET LOCAL app.tenant_id = $1`.** `SET` is a utility statement — Postgres does not plan
it, so it takes no bind parameter and that second spelling is a flat `42601` syntax
error that also aborts the enclosing transaction. It is invisible to unit tests, because
a mocked `query` accepts any string, and it reached `main` three separate times: the
login audit write, `refreshTokenPayload` (where it 500'd every `POST /auth/refresh`
until it was covered by `test/auth-refresh.e2e-spec.ts`) and `TenantService.runTx`. The
`SET LOCAL` wording elsewhere in this file and in ADR-0003 means *transaction-scoped*,
which `set_config(..., true)` is; `src/common/tenant-scope.spec.ts` scans `src/` so the
literal form cannot come back.

Nothing in `src/` populates it yet, and `currentRequestContext()` throws rather than
defaulting — a route without the guard fails closed instead of reading someone's data.
Built in #19's branch, because every write slice needs it: `RequestContextMiddleware`
opens the transaction per controller listed in `TENANT_ROUTES` (not globally — a
transaction per liveness probe is a pool slot spent on nothing), `TenantGuard` names the
tenant on it *after* the status check, and the globally-bound `TransactionInterceptor`
commits or rolls back before the response is sent. `currentRequestContext()` fails closed
twice: outside the scope, and inside it before the guard has named a tenant.

A guard that throws never reaches an interceptor, so the response's own `close` event is
the backstop that rolls back and returns the connection to the pool. `TransactionInterceptor`
claims the transaction (`qr.data`) as soon as it runs, and the backstop then stands aside:
Nest does not cancel a handler when the client disconnects, so on a mid-sale abort an
unclaimed backstop would roll back and release **underneath statements still in flight**,
handing a live query queue to whichever request took that connection next.

🔴 **Two rules for anything that runs inside a request:**

1. **Never take a second connection from the request pool — there is no exception.** The
   request already holds one. Under load every in-flight request holding one and waiting
   for another is a pool deadlock — they all sit there until `connectionTimeoutMillis`
   fires and all return 500, and the 500s are *other people's requests*, not the one that
   misbehaved. Read through `currentRequestContext().manager`. (`tenants` and
   `platform_admins` are the two tables with no RLS, so even a status probe can go
   through it.)

   Work that genuinely cannot run in the request transaction — today that is exactly one
   call site, `VoidService`'s refusal audit, which must survive the rollback the 403
   causes — takes its connection from **`AUDIT_DATA_SOURCE`** (`src/infra/db.module.ts`):
   a separate pool of 2, same `pos_app` role, so RLS still applies and the write still has
   to name its tenant with `set_config('app.tenant_id', …)` of its own. Never
   `ADMIN_DATA_SOURCE` — that connects as the owner, and an audit row written as the owner
   is tenant data that RLS never checked.

   🔴 This *was* written as a deliberate exception taking a second request-pool
   connection, and it was measured as an availability bug. Same app, same tenant,
   `DB_POOL_SIZE=2`, four concurrent denials plus four unrelated reads:

   | | before | after |
   |---|---|---|
   | four concurrent denials | `403,403,500,500` in 5013 ms | `403,403,403,403` in 44 ms |
   | four unrelated reads | `500,500,500,500` | `200,200,200,200` |

   Production runs `DB_POOL_SIZE ?? 5` and the first denial branch is the **role** check,
   so any authenticated cashier could stall every sale in flight for five seconds without
   knowing a PIN. `test/void-denial-pool.e2e-spec.ts` holds the measurement. The next
   denial path to be written follows that shape: its own pool, its own `set_config`, and
   a `catch` that keeps a failed audit from turning a 403 into a 500.
2. **An async Express middleware must never reject.** Express does not await it, so a
   rejection is an unhandled rejection, which Node answers by killing the worker. Both
   `RequestContextMiddleware` failure paths write a response instead.

## Document numbers (#19)

`RC01-2569-08-0042` — type, two-digit `device_no`, Buddhist year-month, four-digit running
number (ADR-0007). `DocNumberService.issue(manager, …)` allocates from `doc_counters` with
`ON CONFLICT DO UPDATE … RETURNING` inside **the caller's** transaction, so a rolled-back
sale gives its number back and the printed series has no visible hole.

- The series is per `(device_id, doc_type, period)` and resets monthly. `period` is the
  Buddhist year and month **in `tenants.timezone`** — a sale rung up at 00:30 in Bangkok
  belongs to that day's month, not to UTC's.
- `device_no` is resolved here from the token's `did`. It is never read from a request
  body: a client that could choose it could print into another machine's series (ADR-0004).
- `device_no` is zero-padded to two digits without exception — unpadded, machine 1 and
  machine 12 differ only by a separator and parse back wrong.
- The 10,000th document in one month on one device is `409 DOC_NUMBER_EXHAUSTED`, not a
  wrap to `0001` that would re-issue a number already printed on paper. The message is
  English on purpose: inventing a Thai string is the shop owner's call, and the code is
  filed in `02_API_SCREENS.md §8.1` waiting for it.
- Imported legacy documents keep their original `RC12345678ABCD` numbers. The two formats
  cannot collide, so the counter neither reads them nor reconciles against them.
- Phase 2 (the `pos` device issuing RC/CN from its own Drift counter, and
  `GET /doc-counters` to seed it) is **not** built here — in phase 1 the server issues
  every series.

🔴 **Lock order: the mechanic's row, then products, then `doc_counters`.** `POST /sales`
locks the mechanic named on the bill (any bill naming one, not just credit sales — a cash
bill locking products first and the mechanic later would deadlock against a credit bill
for the same mechanic sharing one product), then takes `FOR UPDATE` on every product on
the bill, and only then bumps the counter. Any later path that writes
stock **and** issues a number must take them in that same order. `POST /returns` (#22)
does, with the parent bill's own `FOR UPDATE` ahead of all three: **sale → mechanic →
products → `doc_counters`**. `POST /purchase-orders/:id/receive` (#26) takes the PO row `FOR UPDATE`, then every matched product in id order, and issues no number (the PO number was issued at create) — no other path locks a PO row, so it cannot close a cycle;
`POST /sales/:id/void` (#23) does, taking the mechanic's row before the first product
because it now reverses the tab. The drawer row that `POST /sales` and
`POST /mechanics/:id/credit-payments` read first (before the mechanic on a sale, after it
on a credit payment) is outside this order on purpose: the money path only ever takes it
`FOR SHARE`, shared locks never wait on each other, and the drawer's own exclusive
writers (open, close, entries, retirement) take no other money-path lock. A path that
ever takes the shift row `FOR UPDATE` *and* a mechanic or product must fix an order first. Issuing the number first inverts the order and
the two deadlock under concurrent load, which is the kind of failure that only shows up on
a busy Saturday.

## The sale transaction (#20)

`POST /api/v1/sales` — `pos` device only, `Idempotency-Key` mandatory. Everything runs
inside the request transaction, in this order, and the order is the design:

1. the idempotency claim (interceptor, before the handler), then the client-`id` replay
   (`existingSale`), then **the device's open drawer, read `FOR SHARE`** — none open is
   `409 NO_OPEN_SHIFT` on every payment method (see *The cash drawer* below). After both
   replay paths, so a bill committed while the drawer was open still answers once it has
   closed; before every other lock, so a refused bill holds no mechanic or product row
2. lock the mechanic's row if the bill names one; for `'เครดิตช่าง'`, refuse
   `credit_balance + total > credit_limit` with `409 CREDIT_LIMIT_EXCEEDED` unless the
   body carries `overrideCreditLimit: true` (#21). Before the products on purpose: a
   refused bill holds no product locks, and the check and the balance update in step 9
   sit under one lock
3. `SELECT … WHERE id = ANY($ids) ORDER BY id FOR UPDATE` — **the ordering is the
   deadlock guard.** Two bills sharing two products, each locking in its own arrival
   order, deadlock; one order everywhere makes the second wait instead
4. the **complete** Thai error, built from that locked read and thrown once for the
   whole bill. `UPDATE … WHERE stock >= qty` cannot do this — a row count of zero
   cannot tell "not enough" from "no such product" — and fail-fast reports only the
   first bad line, so staff re-submit the bill once per missing item to find out what
   is short
5. deduct, `stock >= qty` kept in the predicate as an assertion against our own bugs.
   A sale never clamps at zero; `adjustStock` is the only path that may
6. issue the receipt number (#19) from the `device_no` of the token's `did`
7. insert the header and the lines, `cost_at_sale` from **the same locked read**
   (ADR-0008) — never re-read outside the transaction, never taken from the client
8. insert `movements` — one row per product, because `uq_movements_ref` is unique on
   `(tenant_id, type, ref_id, product_id)`
9. the ledger, rule for rule from `sales_repository.dart`: customer `points +=
   floor(total/10)`, `total_spend += total`; mechanic `total_sales += total`, a negative
   `mechanic_delta` into `total_discount`, a positive one into `total_markup`,
   `credit_balance += total` only for `'เครดิตช่าง'`. 🔴 `mechanics.total_credit` is
   **never written** — a legacy alias of `total_discount` from the JS app (#11). A bill
   that went past the limit on the flag writes one `audit_log` row
   (`sale.credit_limit_override`); the flag on a bill under the limit writes none
10. commit. Only after commit may anything external happen: no cache call and no
   enqueue inside a transaction that holds locks and can still roll back

**This closes a real race.** `sales_repository.dart` pre-checks stock *outside* its
transaction and then opens one to deduct; it has never bitten only because the shop
has one machine. The suite proves the fix: 200 concurrent bills against 50 units
produce exactly 50 bills, stock exactly zero, 50 distinct receipt numbers.

**Money.** The client owns the numbers — the receipt is printed before the request is
sent — and the server checks the arithmetic: more than `0.01` apart is
`409 TOTAL_MISMATCH`, within tolerance the client's values are stored. A line price is
**never** compared against the catalogue price: haggling is an ordinary day at this
counter. `pointsGranted` is `floor(total/10)`, computed from the persisted total.
Everything in between is integer satang (`src/common/money.ts`), never a float.

**The client's `id` is a natural idempotency key** (§3.1). A retry that lost its
`Idempotency-Key` — a page reload, an app restart — finds the bill already written and is
answered with it, before anything is locked or deducted. It used to be a 500 on the
primary key, which is worse than an error: staff read it as "that did not go through" and
ring the bill up a second time. A repeat carrying a *different* total is
`409 SALE_ID_REUSED`, because silently answering with the old bill would lose the new
one's money.

**The 201 carries back everything the client cannot compute** (§3.1, ADR-0010 §3), so it
patches its cache without waiting for the next `/bootstrap`: `customerAfter
{ id, points, totalSpend }`, `mechanicCreditBalanceAfter`, and — added by #82 — `shiftId`,
`items[] { lineNo, productId, costAtSale }`, `movements[]`, and `mechanicAfter` with all
four running totals. The response carries no `offlineOk`: it has no storage in phase 1.

🔴 **`mechanicAfter` has no `totalCredit`, on either endpoint.** `mechanics.total_credit`
is the JS app's legacy alias of `total_discount` (decision #11); the server never writes
it, and a field on the wire is a field the client will eventually patch.

🔴 **A widened response is a widened *replay*.** Both replay paths have to answer the same
body, field for field and in the same array order: the `Idempotency-Key` path does it for
free (the stored `response_body`), but `existingSale` rebuilds the answer from the rows,
so every new field needs a matching `SELECT` there — `shiftId` came back null for a bill
that really had a shift until that read learned about `shift_id`. `items[]` is ordered by
`line_no` on both paths, and `products[]` / `movements[]` by the order the products appear
on the bill; a replay that agrees on the values but not on their order is still a different
body. `test/sales.e2e-spec.ts` *the write-through fields (#82)* compares the two bodies
whole rather than field by field, which is the only assertion that stays true as the shape
grows. A replayed bill reports the rows as they stand now and moves nothing.

🔴 **`returning()` (`src/common/sql.ts`) is not optional.** TypeORM's Postgres driver
returns rows directly for `SELECT`/`INSERT` but `[rows, affected]` for `UPDATE`/`DELETE`,
so `result[0].stock` reads a number on one and `undefined` on the other — which reaches
Postgres as a NULL several statements later, where nothing points back at the cause.
Every `UPDATE … RETURNING` goes through it.

## The credit note (#22)

`POST /api/v1/returns` — `pos` device only, `Idempotency-Key` mandatory, a port of
`returns_repository.dart` (itself the port of `db.js` `createReturn`). One transaction,
in this order:

1. the idempotency claim (interceptor, before the handler)
2. `SELECT … FROM sales … FOR UPDATE` — `404 SALE_NOT_FOUND` / `409 SALE_VOIDED` come off
   this row, and both messages stay English, as they are in the Dart source
3. the guards, from the locked bill: **`409 RETURN_PRICE_MISMATCH`** for a line priced
   at anything this bill did not charge, then the over-refund guard — per product
   **and price**, `qty ≤ sold − already refunded`, summed across every prior credit
   note. The latter is built whole and thrown once as `409 OVER_REFUND`, whose message
   is `'คืนเกินจำนวนที่ขาย:'` and one line per bad product, so staff see every bad line
   at once instead of one resubmission at a time
4. the money, in integer satang: `refundDiscount = round2(refundSubtotal × discount /
   subtotal)`, `refundTotal = refundSubtotal − refundDiscount`
5. the drawer (#100), read `FOR SHARE` either way: a `'เงินสด'` refund takes
   `ShiftsService.requireOpenShiftIdFor` — `409 NO_OPEN_SHIFT` with no open drawer;
   `'โอน'` and `'หักจากเครดิต'` take `currentShiftIdFor`, null with no drawer
6. lock the mechanic's row, if the bill named one
7. `SELECT … FROM products … ORDER BY id FOR UPDATE`
8. issue the CN number (`CN07-2569-09-0001`)
9. insert the header and the lines — `cost_at_sale` copied from the **parent sale line**,
   never re-read from `products.cost`, which a weighted-average PO receive rewrites
10. stock back, one `movements` row per product, `type='return'`, `ref_id` = the **return**
   id (`uq_movements_ref` is `(tenant_id, type, ref_id, product_id)`, so keying on the bill
   would make the second credit note against it a 500). #82 answers those rows in
   `movements[]`; a **void** writes `type='void'` (migration `1788652800003`) against the
   same goods and the two must never be collapsed — every report groups by that column
11. the ledger, in proportion to `refundTotal / sale.total`: customer `points` and
   `total_spend`; mechanic `total_sales`, `total_discount`, `total_markup`, and
   `credit_balance` **only** for `refundMethod === 'หักจากเครดิต'`. Every accumulator
   clamps with `GREATEST(0, …)` — `total_spend`, `total_sales`, `total_discount` and
   `total_markup` have no CHECK at all, so a missing clamp there fails silently. All four
   come back as `mechanicAfter` (#82), alongside the unchanged `mechanicCreditBalanceAfter`
12. auto-void the parent bill once the cumulative returned quantity reaches what it sold

🔴 **The `FOR UPDATE` on the sale in step 2 is the whole endpoint's serialisation point.**
Without it two concurrent partial returns of one bill both read the same already-refunded
total, both pass step 3, and the shop refunds more than it sold. The Dart reference is
single-process and structurally cannot expose that race.

🔴 **The server decides what a refund is worth, not the client.** The body names a
product and a quantity; the amount comes off `sale_items`. Summing the client's own
`price` let a `pos` token credit 999,999 baht against a bill that sold the part for 85,
and the `GREATEST(0, …)` clamps then absorbed it in silence — `total_spend` and a
mechanic's `credit_balance` floor at 0, so one bogus credit note zeroed a tab and raised
nothing. The Dart reference has the same hole because there the client *is* the
authority. One bill may carry the same product on two lines at two prices, so "the price
of that product on the bill" is a set: a line is matched against that set and **refused**
if it is not in it, never silently corrected, and the quantity is bounded per
product-and-price so `[p1×1@85, p1×1@70]` cannot be credited back as `p1×2@85`.

The money is therefore **arithmetically more exact than the reference, not a verbatim
port of it**: `refundDiscount` is integer satang with half-up rounding where
`returns_repository.dart` does `round2()` on doubles, so the two differ by one satang on
an exact tie (subtotal 200.00, discount 3.00, one 85.00 line refunded: exact 1.275 →
server 1.28, Dart 1.27). The Thai strings are verbatim; the arithmetic is not.

A soft-deleted product is put back on the shelf like any other — the goods physically
exist again, and `POST /sales/:id/void` does the same. It used to be skipped here, with
no `movements` row to say the goods had come back at all. A product that has ever sold
cannot be hard-deleted: `movements` references `products` with no cascade.

`refundMethod = 'หักจากเครดิต'` on a bill with no mechanic is `409
REFUND_METHOD_NOT_ALLOWED`. The DTO whitelists the three methods but cannot see the
bill; without the check the credit note records a deduction from a tab that does not
exist, and the closing report does not count it as cash either.

🔴 **`mechanics.total_credit` is read and never written** (#11): the discount base is
`total_discount` unless it is zero, in which case it is the legacy `total_credit` — the
old app's own `(totalDiscount || totalCredit)` fallback, kept so a mechanic imported from
it reverses against the figure his screen actually shows.

A cash refund on a credit sale deliberately leaves `credit_balance` alone — the shop hands
over cash and the mechanic still owes what he owed. That is why the Returns screen warns
before it lets staff choose cash on a credit bill.

`returns.shift_id` is stamped from the device's own open drawer, never from the body.
🔴 **A cash refund needs an open drawer** (owner's decision on #100, 2026-09-13): with no
shift `closed_at IS NULL` on the calling device, `refundMethod = 'เงินสด'` is `409
NO_OPEN_SHIFT` and nothing is written — no stock, no CN number, no auto-void, no
idempotency claim. ⚠️ `POST /shifts/open` on the same day hands back today's closed
row, so **after today's close a cash refund waits for tomorrow's open** (the owner accepted
this with option A); a transfer refund is still possible. Until #100 it was
stamped null and the cash that left the drawer appeared in no closing report — the route
#94's `SALE_NOT_IN_OPEN_SHIFT` sends the counter down after today's close. The check
follows the bill's guards (a bad body is told so, drawer or not) and a key replay never
reaches it. It reads `FOR SHARE`, so the lock order is **sale → shift (shared) → mechanic
→ products → `doc_counters` → customer**, as on the void; the drawer's exclusive holders
(open, close, entries, retirement) take no other money-path lock, so no cycle. `'โอน'` and
`'หักจากเครดิต'` do not move expected cash, so they are still taken with no drawer and
stamped null — but they net into that shift's `grossProfit`, so they read the drawer
`FOR SHARE` too (`currentShiftIdFor`): a close cannot commit under a refund in flight and
leave it stamped onto an already-counted shift.

`GET /returns?saleId=&from=&to=&page=&limit=` is
newest-first and readable from both device roles; `from`/`to` are the filters
`02_API_SCREENS.md §3.7` defines for the refund history and behave exactly as
`GET /sales` does, with `saleId` the extra one a single bill's notes need.

## Sale reads and the void (#23)

`GET /sales` (filters `search`, `receiptNo`, `from`, `to`, plus `page`/`limit` — never
the whole table), `GET /sales/:id`, `GET /sales/:id/refunded-qty`, all readable from
both device roles. `refunded-qty` sums `return_items` across every credit note against
the bill: it is what makes the over-refund guard visible to staff *before* they submit.

`?receiptNo=` is an exact match, separate from `?search=`, for the same reason the
barcode lookup is separate from product search — what is printed on the paper a
customer brings back is one number, and a LIKE would offer several bills. `%` and `_`
in a search are escaped: they are characters staff typed, not wildcards.

**`POST /sales/:id/void`** — `manager` (or `owner`) plus the PIN, `pos` device only,
idempotent. Restores stock, writes a `movements` row per product (`type='void'`, no
`note` — the ledger row carries the type and the bare sale id as `ref_id`, and nothing
writes a Thai note on this path), reverses the customer and mechanic ledger in full,
marks the bill void and writes an `audit_log` row. Refused when the bill is already void
(`409 SALE_VOIDED`) or already has a credit note against it (`409 SALE_HAS_RETURNS` —
voiding then would restore that stock twice). **#94:** also refused unless the bill's
`shift_id` is the calling device's open drawer — `409 NO_OPEN_SHIFT` with no drawer,
`409 SALE_NOT_IN_OPEN_SHIFT` for a bill from a closed shift, another device's shift, or
with a null `shift_id` — so a closed shift's report never changes afterwards; an older
bill is undone by a credit note. The check runs after `SALE_VOIDED`/`SALE_HAS_RETURNS`
(a key replay is answered by the interceptor first) and reads the drawer `FOR SHARE`
between the sale lock and the mechanic lock, so a close waits for a void in flight.
Not audited: the PIN is already proven, like the other business-rule refusals.

Refusals are audited too (`sale.void.denied`, with the reason). This is a four-digit PIN
with no per-user rate limit until #44; brute-forcing it must not be invisible. That row is
written on its own connection because the 403 rolls the request transaction back — an
audit row written on it would vanish along with the attempt it was recording. The
connection comes from `AUDIT_DATA_SOURCE`, a two-connection pool of its own; taking it
from the request pool made a denial a request queuing for a second connection, which
timed out unrelated requests (see *Two rules* above, and
`test/void-denial-pool.e2e-spec.ts`).

🔴 **One thing to know before this ships:** the old app has no void button at all — a
bill is voided only as the automatic consequence of returning every line
(`02_API_SCREENS.md §2` lists the endpoint under "new, not a port", and asks for a
conversation first). #23 specifies it, so it is built — but the shop has never seen
this button.

**The ledger is reversed in full, never in proportion.** #21 made `POST /sales` apply
the customer's points and spend and the mechanic's tab, and `VoidService.reverseLedger`
takes exactly those figures back off, every accumulator clamped with `GREATEST(0, …)`.
In full is safe only because a bill with a credit note against it is already refused
above (`SALE_HAS_RETURNS`), so there is no partial refund to share out the way
`POST /returns` has to. `total_credit` is not written (#11).

## The cash drawer (#28)

`GET /shifts/current` and `/shifts/history` are readable from **both** device roles —
looking at the drawer does not touch it (ADR-0004) — while `POST /shifts/open`,
`/close` and `/current/entries` are `pos` only.

⚠️ **`is_active` does not mean "open."** Closing leaves it true: the shift stays *this
device's current drawer* until the next open archives it, exactly as
`shifts_repository.dart` does, and `uq_shift_active` (unique on
`(tenant_id, device_id) WHERE is_active`) depends on that meaning. "Open" is
`closed_at IS NULL`. Do not repurpose the flag.

- Re-opening on the same day returns the existing shift untouched, starting cash and
  all: staff press the button twice. A new day archives the previous shift **first**,
  flagged `auto_archived` when it was never closed, so a day's takings are never lost.
- A drawer entry after close is `409 DRAWER_CLOSED` with the message verbatim from
  `db.js`; no drawer at all is `409 NO_OPEN_SHIFT`.
- Reads are tenant-wide, writes are per device. In this shop those coincide
  (`one_pos_per_tenant`), but a read filtered by the caller's device would show a
  `backoffice` machine nothing, which is not what "readable from both" means.
- **`shift_id` is stamped on a sale at write time**, from the device's own *open*
  drawer — never from the request body. The closing report is computed by `shift_id`,
  never by a timestamp window: a window breaks across midnight and cannot separate two
  machines.
- 🔴 **No open drawer, no money** (owner's decision, 2026-09-13: "ต้องเปิดกะก่อนรับเงิน
  ทุกกรณี"). `POST /sales` and `POST /mechanics/:id/credit-payments` answer
  `409 NO_OPEN_SHIFT` when the calling device has no shift with `closed_at IS NULL` —
  never opened, or already closed — for every payment method, and write nothing (no
  stock, no ledger, no RC/CP number, no idempotency claim). Until then both stamped null
  and took the money, ported from the old app; that cash appeared in no closing report.
  Replays are not refused: the check runs after both replay paths. The helper is
  `ShiftsService.requireOpenShiftIdFor`, and it reads the row **`FOR SHARE`** so a close
  waits for bills in flight and a bill behind a committed close is refused, rather than
  landing on a shift whose cash was already counted. `POST /returns` is covered for
  `'เงินสด'` only (#100); a transfer or tab-deduction credit note still stamps null with
  no drawer open (`currentShiftIdFor`). `shift_id`
  stays nullable in the schema: imported rows are legitimately null.
- `closeForRetirement()` is the operation `POST /devices/:id/retire` (#6) calls to
  close a machine's drawer in the same transaction that stamps `retired_at`. The
  endpoint does not exist yet, so `test/shifts.e2e-spec.ts` mounts the call on a probe
  route rather than shipping it untested. **It archives as well as closes**: normally the
  device's *next* open archives its drawer, but a retired device never opens again, so an
  active row would be stranded — `history()` (`NOT is_active`) would hide that day's
  takings forever while `current()` showed a drawer nothing could close.
- 🔴 **Rows written before 2026-09-13 (and imported ones) can still carry no
  `shift_id`.** The shipped app's closing report counts by date key
  (`closing_report.dart`), not by shift. New sales and credit payments can no longer be
  taken without a drawer, so #30 only has to decide what to do with those older rows and
  with non-cash credit notes (`POST /returns` still stamps those null with no drawer open;
  cash refunds need one since #100).
- 🔴 **Expected cash also has a credit-payment term** (#24, #30's first AC): a mechanic
  settling his tab in cash is money in the drawer that no sale accounts for. Sum
  `credit_payments WHERE shift_id = … AND payment_method = 'เงินสด'`; the transfers must
  not be counted, which is what that column exists for.

## Mechanic credit payments (#24)

`POST /mechanics/:id/credit-payments` — the mechanic comes in and pays down his tab.
`pos` only (it takes cash over the counter and prints a receipt), idempotent, and one
transaction: `mechanics FOR UPDATE` → the open drawer (`409 NO_OPEN_SHIFT` without one) →
the CP number → the row → the reduced balance.

- **Lock order is mechanic → `doc_counters`,** the money path's relative order. It
  cannot deadlock against a sale or a credit note today — `doc_counters` is keyed by
  `doc_type`, so the CP row is never the RC or CN row and the mechanic is the only
  resource they share — but the order costs nothing and stays right if that changes.
- 🔴 **An overpayment is refused, not clamped.** `credit_balance` is written with
  `GREATEST(0, …)` as the ticket asks, but a clamp on an amount nobody checked turns
  100,000 keyed for 1,000 into a wiped debt and a receipt for cash never handed over —
  the same shape as the #22 money bug. More than the tab without
  `allowOverpayment: true` is `409 CREDIT_PAYMENT_EXCEEDS_BALANCE` (English message; the
  client owns the Thai dialog, which the shipped app already shows —
  `mechanics_screen.dart:1331`). With the flag it goes through and writes one
  `audit_log` row, exactly as #21's credit-limit override does.
- **`paymentMethod` is required and whitelisted** to the two the intake dialog offers,
  `'เงินสด'` and `'โอน/QR'`. A method the server guessed is a closing report that is
  wrong in one direction or the other: count a transfer as cash and the drawer shows a
  shortfall the size of the transfer every single day, which is how staff stop believing
  the report at all. The column is new (`payment_method`, migration `…005`) because the
  Drift port dropped the JS app's `p.method`; `cash_drawer_screen.dart:121` says so.
- **`shift_id` is stamped like a sale's** — the device's own open drawer, never the body.
  That column is what #30 sums cash settlements by.
- 🔴 **No open drawer is `409 NO_OPEN_SHIFT`, cash and transfer alike** (owner's
  decision, 2026-09-13 — this replaces the old "null when none is open; refusing it here
  would be a new rule" behaviour). Order: mechanic `FOR UPDATE` → client-`id` replay →
  drawer `FOR SHARE` → overpayment check → CP number. After the replay, so a payment
  committed while the drawer was open still answers once it has closed; before the
  overpayment check and the counter, so a refusal leaves no hole in the CP series.
- **Two defences against a duplicate, as on `POST /sales`:** the `Idempotency-Key`, and
  an optional client `id`. The same id with a different mechanic, amount or method is
  `409 CREDIT_PAYMENT_ID_REUSED`. The id matters because the client's outbox
  (`pending_credit_payments`, Drift schema v5) can resend a payment long after the key's
  24 h have run out — a device offline over a weekend — or under a fresh key after a
  person confirms a refused overpayment; both replay the stored payment by id alone.
  The replay is checked **before** the overpayment check, or a replayed full settlement
  would meet the zero tab it created and be refused.
- ⚠️ **`shift_id` is the shift open when the server receives the payment,** not when the
  cash was taken. A payment queued offline and sent after the drawer closed is now
  refused with `409 NO_OPEN_SHIFT` (the outbox keeps it for a person) unless a drawer is
  open by then, in which case it lands in that shift — #30 has to know that.
- The mechanic's `deleted_at` is **not** filtered, exactly as `POST /sales` does not
  filter it: he owes the money either way, and refusing it loses the shop both the cash
  and the record of it. An id that never existed is `404 MECHANIC_NOT_FOUND`, thrown off
  the locked read rather than left to the insert's foreign key (a `23503` surfaces as a
  500).
- The response carries the payment plus `mechanicCreditBalanceAfter` — every *value*
  the transaction moved (#82) and nothing it did not. There is no `mechanicAfter` here:
  the three running totals are untouched, and handing them back invites the client to
  patch them from a stale read. `mechanics.updated_at` also moves and is not returned;
  the client stamps its own, as it does after every write.

## The catalogue (#16)

`src/products/` — products, categories, suppliers, `movements`, ported from
`products_repository.dart` / `suppliers_repository.dart` / `movements_repository.dart`.
Reads are open to any tenant token; every write is `manager`/`owner`, both device roles,
`Idempotency-Key` mandatory (`02_API_SCREENS.md §4`). `test/catalogue.e2e-spec.ts` replays
every case of `frontend/test/products_repository_test.dart` at the HTTP seam.

- **Products are soft-deleted** (`01_DATABASE.md §10`); every read hides tombstones except
  `?updatedSince=`, which is the sync read and must carry them.
- 🔴 **`?updatedSince=` is keyset-paged on `(updated_at, id)`.** Many rows share one
  `updated_at` (a sale stamps every line with the transaction's `now()`; the platform import
  stamps a catalogue at once), and `updatedAt` on the wire is millisecond-truncated, so a
  reader that paged with `updated_at > max(updatedAt)` skipped the rest of a tie cut by a page
  boundary — or, with a tie larger than a page, was served the same page forever. The response
  carries `meta.nextCursor: { updatedSince, afterId }` (microsecond precision, or `null` on an
  empty page); the reader sends both back and always asks for the first page after it
  (`page>1` with `updatedSince` is a 400; `afterId` without it is a 400). `updatedSince` alone
  still answers `updated_at > $ts`, as specified. A pass is done when a page is shorter than
  `limit`; its last `nextCursor` is where the next refresh starts. Proved by *a keyset sync pass
  over a tie larger than a page* (nine rows, one microsecond, limit 3).
- 🔴 **Not solved here — late commits.** A write stamped with its transaction's start time
  (`now()`) can commit after a reader has already moved its cursor past that time, and is then
  never read. Recorded as #55's read-back-window question under ADR-0010 *ยังไม่เคาะ*. **Until
  #55 decides that window, a client must start each refresh a safety margin before its stored
  cursor** (an `updatedSince` some seconds earlier, no `afterId`), otherwise the protocol above
  loses late-committing writes; the rows it reads again are upserts by id, so re-reading is harmless.
- **`?partNo=` is one product, trimmed and case-insensitive** (`lower(part_no) = lower($n)`,
  served by `uq_products_partno_ci`) — the same comparison uniqueness uses. A `partNo` that is
  present but blank answers an empty page, never catalogue page 1.
- **The platform import pre-flights case-duplicate part numbers** (`tenant-import.service.ts`):
  a snapshot whose products share a part number ignoring case is a 400 naming the ids, before
  the transaction, like the negative-stock pre-flight. It compares with JS `toLowerCase()`; a
  non-ASCII pair that JS and Postgres `lower()` fold differently would still reach the index as a 500.
- **`?search=`** puts the predicate on `SEARCH_EXPRESSION` — the exact expression
  `idx_products_search` is built on — then rechecks `part_no`/`name`/`name_th` so matching stays
  what the screens do (no `compat`). 🔴 **Under RLS the trigram index is not used:** as
  `pos_app`, `LIKE` (`textlike`) is not LEAKPROOF, so the planner will not run it inside the index
  ahead of the tenant policy and the search is a tenant index scan plus a filter. The e2e pins
  both plans (owner: the index; `pos_app`: not the index). Open design question
  (`01_DATABASE.md §5.2`) — do not "fix" it by marking functions LEAKPROOF or bypassing RLS.
- **A part number is unique case-insensitively among live products**, enforced by the database:
  `uq_products_partno_ci (tenant_id, lower(part_no)) WHERE deleted_at IS NULL` (migration
  `1788652800007`), so the platform import cannot bypass it. A `23505` on it maps to
  `409 DUPLICATE_PART_NO` / `รหัสอะไหล่นี้มีอยู่แล้ว`; two concurrent `BP-1`/`bp-1` creates give
  exactly one 201. A tombstone's number is free to reuse.
- **`adjust-stock` clamps at zero** (`01_DATABASE.md §7.6`) **after** validating the body: an
  integer `delta`, a `type` of `adjustment-in`/`adjustment-out` whose direction matches the sign,
  and a result that fits `INT`. The `movements` row keeps the requested `delta` beside the clamped
  `stock_after`, as the Dart repository does. One `stock.adjust` audit row (#43). It locks one
  product row and nothing else, so it cannot join the sale path's lock order.
- **Categories are hard-deleted with no foreign key** from `products.category`; the product
  keeps the name. `GET /categories` answers `[{name, color}]` for listed names from one query,
  and stands the five seed names in when the table is empty, as the Dart repository. **The
  colour of an orphaned name is the client's** — its hash fallback (`catColor` in
  `products_repository.dart` / `AppColors.catColor`); the API adds no colour to products.
- `PATCH /products/:id` never reads `stock` — stock moves only through writes that log a movement.
- Product money is now a string on the wire (`price`/`cost`, §1.1); it was a number before #16.

## Quotes and parked sales (#27)

`src/quotes/` and `src/parked-sales/`, ported from `quotes_repository.dart` /
`parked_repository.dart`. 🔴 **Neither writes `products` or `movements`.** The one exception
is `POST /quotes/:id/convert`, which sells through `SalesService.create` — it never writes
stock itself. `test/quotes-parked.e2e-spec.ts` asserts every product's stock and the
ledger's row count across the whole lifecycle.

- **Quotes: any role, both device roles; convert is `pos` only.** Every write takes an
  `Idempotency-Key`. A QT number comes from `DocNumberService` in the token's device series, so a
  session with no device token is `403 DEVICE_ROLE_FORBIDDEN`.
- **`validUntil = now + (validDays ?? 30) × 24h`.** This is the Dart data layer's literal. The
  server never reads `settings.quote_valid_days`, and neither does the Flutter client:
  `_handleSaveQuote` (`checkout_screen.dart:515`) passes no `validDays`, so every quote gets 30
  days whatever the setting says. The JS screen used to pass `quoteValidDays`; that is a
  pre-existing JS→Flutter gap, not something this server closes.
- **`isExpired` is `valid_until < now()`, evaluated at read time on every quote whatever its
  status. `isConverted` is `status = 'converted'`** — `QuoteRowStatus`. The stored status is never
  rewritten to `'expired'`. `?status=open|expired|converted` is `quotes_screen.dart`'s
  `_applyFilter`: `expired` excludes converted quotes.
- **A quote is held to the sale's arithmetic when it is saved** (`assertSaleTotals`,
  `409 TOTAL_MISMATCH`), so a quote that saves is a quote that converts.
- **`PATCH` takes header text only** (`customerName`, `customerPhone`, `notes`). It refuses
  `status`, lines and money with a 400, and refuses any change to a converted quote with
  `409 QUOTE_ALREADY_CONVERTED`. The screen's old convert, `updateQuote(status: 'converted')` followed
  by `POST /sales`, is the half-finished state `02_API_SCREENS.md §3.8` calls out, so it is not
  reachable here. `DELETE` works on any quote, as the screen allows.
- **Convert is offered on `!converted && !expired`** (`quotes_screen.dart:559`), not on
  `status = 'open'`, so an imported row stored as e.g. `'cancelled'` but still valid converts.
- **Convert body = `POST /sales` minus lines and money** (`id`, `paymentMethod`, customer,
  mechanic, `mechanicDelta`, `overrideCreditLimit`). The lines, prices, discount and total are
  the saved quote's. Sending any of them is a 400: an edited cart is a different bill, and a
  different bill goes through `POST /sales`. A quote line with no product goes to the sale path with
  an empty id, as Checkout does, and comes back as `สต็อกไม่พอ … ไม่พบในสต็อก`.
- 🔴 **Lock order on convert: quote `FOR UPDATE` → the sale path's own order.** Nothing else
  locks a quote after a shift, a mechanic, a product or a counter, so this cannot form a cycle.
  Converting twice cannot produce two bills:
  - A second request waits on the quote row, then finds it converted.
  - The same bill `id` replays the original. The sale is replayed through `existingSale`, and the
    quote is re-read. The e2e compares the whole body.
  - Any other `id` gets `409 QUOTE_ALREADY_CONVERTED`, with `details.convertedSaleId`.
  - The replay check runs before the expiry check, so a quote converted on its last day still
    replays the next morning.
  - 🔴 **A convert retry must reuse its `Idempotency-Key`.** A retry with a fresh key on a quote
    that has since been deleted (DELETE works on converted quotes, as in Dart) or purged answers
    `404 QUOTE_NOT_FOUND`, and a client that reads every 4xx as a verdict would ring the bill
    up again. The key replay does not read the quote, so it still answers the original.
  - A replay through the bill `id` re-reads the quote, so `quote.isExpired` is recomputed at
    read time: a replay the next day can differ from the original in that one field. A key
    replay returns the stored body unchanged.
  - An open quote whose bill `id` is already taken is `409 SALE_ID_REUSED`. Otherwise
    `existingSale` would replay an unrelated bill, and the quote would be marked converted into it.
- 🔴 **Divergence from Dart, open for the owner (02 §3.8):** Checkout drops short or
  non-catalogue lines from a loaded quote and lets staff edit the cart. Convert here is
  all-or-nothing. A quote that cannot convert is therefore rung up with `POST /sales`, stays
  `open`, and can later be converted into a second bill.
- **Parked sales: `pos` only, reads included** (ADR-0004). The body is `{ payload: {...} }`, stored
  verbatim as JSONB. The list is tenant-wide, newest first, and not filtered by device.
  Whether a till may see another device's cart is an open question for the owner. **`DELETE` returns the deleted row, so the delete is the
  recall.** When two tills recall the same bill, one `DELETE … RETURNING` finds it and the other
  gets `404 PARKED_SALE_NOT_FOUND`.

## Conventions these slices set

- **Pagination lives in `meta`, not in `data`** (§1.2). A handler returns
  `new Paginated(items, { total, page, limit })` and `EnvelopeInterceptor` lifts it into
  `{ status, data, meta: { total, page, limit, totalPages } }`. `GET /sales` and
  `GET /shifts/history` are the first two; #55 will read them.
- **Money is integer satang in the server** (`src/common/money.ts`) and a string on the
  wire. `toSatang` holds a JSON number to the same two decimals as the string form and
  bounds every amount to what `NUMERIC(12,2)` can hold — past that Postgres raises `22003`
  several statements later, which surfaces as a 500 for what was plainly a bad request.
- **A list read needs a tiebreaker.** `sales.date` defaults to the transaction timestamp,
  so bills written in the same instant tie; `LIMIT`/`OFFSET` over a tie shows one row
  twice and misses another. Every paged query orders by `<sort key> DESC, id DESC`.
- 🔴 **`returning()` (`src/common/sql.ts`) is not optional.** TypeORM's Postgres driver
  returns rows directly for `SELECT`/`INSERT` but `[rows, affected]` for `UPDATE`/`DELETE`,
  so `result[0].stock` reads a number on one and `undefined` on the other — which reaches
  Postgres as a NULL several statements later, where nothing points back at the cause.

## The e2e suite

`test/support/fixture.ts` boots the real application against the compose Postgres and
Redis, mints access tokens from a per-run RSA key pair, and resets one tenant per suite.

- **`resetTenant` clears Redis as well as Postgres.** `TenantGuard` caches
  `t:{tid}:status` for five minutes and the idempotency service caches responses under
  `t:{tid}:idem:*` for a day — both outlive a run. A suite that wipes only the tables is
  testing a half-reset tenant: a suspended shop still reads `active`, and a re-used key
  replays a bill that no longer exists.
- **`fileParallelism: false`.** Each file boots the whole application, so parallel files
  multiply the connection pools past `max_connections=100` and the run dies as "worker
  exited unexpectedly" rather than as a failed assertion.
- `TEST_LOG_LEVEL=error pnpm test:e2e` is how you find out why a suite is getting a 500.

## Invariants this stack enforces (from #14 / #2)

- `redis-cache` = `allkeys-lru`, no persistence. `redis-queue` = `noeviction` + AOF. Two processes.
- Both Redis run with `--requirepass`; an unauthenticated client cannot read a cache entry or
  `FLUSHALL` the queue even from inside the compose network.
- Postgres and both Redis publish **no** host port; only `docker-compose.dev.yml` (dev/CI) does.
- Bull-Board requires basic auth and is bound to host loopback only (Nginx does not proxy it —
  on the VM reach it over an SSH tunnel); `/platform/*` is refused by Nginx from any non-private
  source address.
- `/health/live` does no I/O. `/health/ready` returns `503 NOT_READY` naming the failed
  dependency. Nginx fails over only on connection errors, never on the app's own 5xx.
- `SIGTERM` drains: Nest closes the listener, in-flight requests finish, then pools close.
  Nginx retries idempotent requests on the next instance (`proxy_next_upstream error timeout`).
- Every request carries `X-Correlation-ID` (client's, else Nginx `$request_id`) into the JSON
  log line and back out in the response. Request bodies are never logged.
- `mem_limit` per container totals ≈ 3.0 GB; `max_connections=100`, pools 3×15 + 5 = 50.
- The app connects as `pos_app` (`NOSUPERUSER NOBYPASSRLS`, not the table owner) so RLS
  cannot be bypassed by accident. Migrations run as `postgres`, once, before the app starts.

## The image CI builds (#61)

A green push to `main` pushes the server image to GHCR, tagged with the commit SHA and with
`main`. There is still no deploy step until a production host is picked
(`03_ARCHITECTURE.md §8`), so a human pulls it:

```
docker pull ghcr.io/nuimanlp/srisurart-pos-server:<sha>          # or :main
docker tag ghcr.io/nuimanlp/srisurart-pos-server:<sha> srisurart-pos/server:local
```

`srisurart-pos/server:local` is the tag compose expects. The same image runs api, worker and
bull-board; compose overrides `command`.

The push is gated: Trivy scans the built image for **fixable** HIGH/CRITICAL and the job exits
non-zero before the push, so a vulnerable image never reaches the registry. The image is kept
clean by `Dockerfile` (base pinned by digest, `apk upgrade`, npm/npx deleted from the runtime
stage), never by an ignore file — there is no `.trivyignore` in this repo and adding one is
forbidden (ADR-0013).

**Visibility.** The package is pushed by `GITHUB_TOKEN` from this public repository, so it is
linked to the repo and **public from the first push** — verified 2026-09-10 by an anonymous
`docker pull` of both images minutes after the first run. No manual step. If the repository is
ever made private the package follows and the VM would need a pull token (07 §7).

**Bumping the base image.** The base is pinned by digest and Dependabot here is restricted to
security updates, so nothing bumps it on a schedule. A CVE published *after* the pin turns this
gate red on the next push to `main` — usually a push that has nothing to do with the image, so
whoever meets the red build did not cause it. The fix is to bump the digest
(`docker buildx imagetools inspect node:22-alpine`, paste the index digest into both `FROM`
lines in `Dockerfile`), never a suppression file.

## Deploying a new image without a full outage

`docker compose up -d --build` recreates all three instances at once. For a rolling restart:

```
docker compose build api-1
for s in api-1 api-2 api-3; do docker compose up -d --no-deps $s; sleep 5; done
```

Each instance keeps its static address (`172.30.0.11–13`), so Nginx needs no reload.
