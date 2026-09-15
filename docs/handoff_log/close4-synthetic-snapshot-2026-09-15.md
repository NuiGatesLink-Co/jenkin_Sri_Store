# #185 `close.4` — the §9 import path, run on a synthetic shop snapshot (2026-09-15)

**Owner decision (2026-09-15):** the shop's real snapshot is not available yet. We generate synthetic demo data first and push it through the whole #185 path. The real import is a later re-run of the same commands.
**#185 stays open.** Its AC needs the *real* file and the DoD tick in `03 §8`.
Branch `feat/185-synthetic-snapshot`. Local compose Postgres/Redis only; the demo VM was not touched.

## What was built

| File | What it is |
|---|---|
| `server/test/fixtures/synthetic-snapshot.ts` | A deterministic generator (mulberry32, seed 185). It **simulates the shop day by day** using the Drift repositories' own rules (`saveSale`, `createReturn`, `receivePO`, `adjustStock`, `addCreditPayment`, `openShift`/`addDrawerEntry`/`closeShift`, `parkSale`, quotes), then exports in `exportSnapshot()`'s shape and order. The double arithmetic is kept, so float artefacts such as `11719.95379250218` appear the way they do in a real backup. CLI: `corepack pnpm exec tsx test/fixtures/synthetic-snapshot.ts --scale small\|full --profile clean\|realistic --out f.json`. |
| `server/test/support/snapshot-checks.ts` | Two functions. `checkSnapshotInvariants(json)` checks the ledgers from the JSON alone; it is also the pre-flight report for the real file. `reconcileImport(db, tenantId, json)` runs §9 step 5. |
| `server/test/synthetic-snapshot.spec.ts` | Unit tests: the generator is deterministic, both profiles keep every invariant, the §9 cases are covered, and the committed sample equals the generator's output. |
| `server/test/import-snapshot.e2e-spec.ts` | The checklist end to end: provision → pre-flight → HTTP import → six checks → closing report → first bill after import. Also a rollback case and a second-import 409 case. The env vars `SNAPSHOT_FILE`, `KEEP_TENANT=1` and `RECONCILE_OUT=file.json` are for the real re-run. |
| `frontend/test/synthetic_snapshot_import_test.dart` + `frontend/test/fixtures/synthetic_snapshot_small.json` | Proves the client accepts the file: `importLegacyBackup()` loads the committed sample (`small/realistic`, 142 KiB), and the test asserts counts, money, zone migration, null-as-absent, `costAtSale`, and a round-trip of `recordCounts`. `SNAPSHOT_FILE=…` points it at any other file. |

**Why commit only the small sample.**
- The full file is 1.9–2.2 MiB of generated JSON. It would bloat every clone and its diffs are unreadable.
- The Flutter test needs a file on disk (Dart cannot run the TS generator), so the small sample is committed.
- A unit test pins the sample to the generator, so the two cannot drift apart.
- The server e2e generates the full file in memory on every run.

**Profiles.**
- `clean`: only what the import is designed to accept.
- `realistic`: adds what the Drift build really leaves behind. That is hard-deleted products, customers and mechanics that history still references (Drift has no FKs and every delete is hard), plus a deleted category that products still name.

### Data volumes (seed 185)

| | small / realistic (committed) | full / clean (e2e) | full / realistic |
|---|---|---|---|
| days of trading | 21 | 120 (May–Aug 2026) | 120 |
| products / customers / mechanics | 38 / 11 / 4 | 320 / 90 / 14 | 318 / 89 / 13 |
| sales (items) / voided by full return | 140 (322) / 5 | 2,043 (5,176) / 55 | 2,012 (5,091) / 54 |
| credit sales `เครดิตช่าง` | 21 | 279 | 274 |
| returns / refunded `หักจากเครดิต` | 14 / 3 | 120 (241 items) / 23 | 121 / 19 |
| POs: statuses | 7: received, cancelled | 40 (295 items): received, cancelled, open | 40: received, cancelled |
| quotes open / converted | 7 / 3 | 27 / 19 | 28 / 12 |
| credit payments | 8 | 165 | 163 |
| movements | 72 | 610 | 612 |
| shifts (1 active + history) / auto-archived / drawer entries | 21 / 0 / 11 | 120 / 5 / 109 | 120 / 6 / 88 |
| parked bills | 2 | 3 | 3 |
| legacy `zone` products / explicit `compat: null` | 1 / 5 | 24 / 34 | 24 / 34 |
| JSON size | 142 KiB | 1,962 KiB | 1,934 KiB |

**Invariants held (from the JSON):**
- ids, part numbers (case-insensitive) and every document series are unique
- `recordCounts` = the store lengths
- subtotal = Σ lines; total = subtotal − discount; `pointsGranted = floor(total/10)`
- refunds ≤ sold, refund discount pro-rated, voided ⇔ fully returned
- **stock = Σ movements − Σ sold + Σ returned** (opening stock is logged as `adjustment-in`, because Drift's `saveSale` writes no movement)
- customer points/spend = bills − credit notes
- **mechanic credit = credit bills − payments − `หักจากเครดิต`**, with Drift's clamp never firing
- drawer entries are `in`/`out` with amount > 0

No real personal data: `ลูกค้าทดสอบ …`, `Test Customer 001`, `099-000-xxxx`, tax id `0000000000000`.

## Client: `importLegacyBackup()`

- `flutter test test/synthetic_snapshot_import_test.dart` → **4/4 pass** on the committed sample.
- The same test with `SNAPSHOT_FILE=` pointed at `full/realistic` also passes 4/4.
- `dart analyze` → clean.
- The client accepts the orphans (it has no FKs), as expected.

## Server: the `01 §9` checklist, step by step

Evidence comes from the `full/clean` file, via `RECONCILE_OUT` + `KEEP_TENANT=1`. The kept demo tenant on the local dev DB is `55f05672-ffde-473c-b947-b39abcaca01c` (`import-a21ef5d4`). It holds one extra bill from the post-import check.

### Before the fixes (baseline on `main`)

| Step | Result |
|---|---|
| 1 provision via `POST /platform/tenants` | ✅ |
| 3/4 `POST …/import` | ❌ **500 for any file over 100 KiB.** Nest's JSON parser limit; `PayloadTooLargeError` surfaced as `INTERNAL_ERROR`. |
| same, with the limit lifted | 201, but the import **silently lost data** (next rows) |
| COUNT(purchase_orders / po_items) | 40 / 295 expected → **0 / 0** |
| COUNT(shifts / drawer_entries) | 120 / 109 → **0 / 0** |
| COUNT(parked_sales) | 3 → **0** |
| categories | named `Cat-0 … Cat-6`; 2 real ones missing |
| check 6 latest drawer | → **no shift** |
| rollback case | vacuous: the poisoned drawer entry was never read |

Root cause: `TenantImportService` was written against invented keys (`sa_purchase_orders`, `sa_shifts`, `sa_drawer_entries`, `sa_parked_sales`, `{name, position}` categories). No real file has them. `exportSnapshot()`, db.js and the server's own `BackupProcessor` all write `sa_pos`, `sa_cash_drawer` + `sa_shift_history`, `sa_parked`, and a string array of categories. Two more mismatches: `zone` was stored raw (`'Electrical'`, not `ไฟฟ้า`), and a sale line's `cost` (the cost at sale) was dropped.

### After the fixes (this PR)

| §9 step | Result | Evidence |
|---|---|---|
| 1 tenant + owner + device via provisioning | ✅ | `POST /platform/tenants` 201 (device `pos1`) |
| 2 pre-flight on the JSON | ✅ clean: 0 violations, 0 orphans | `checkSnapshotInvariants` |
| 3 import in dependency order | ✅ **201 in 6.3 s** (2.0 MiB body) | |
| 4 one transaction per tenant | ✅ a refused drawer entry (amount 0) near the end → error, 0 rows in products/sales/customers/mechanics/shifts/drawer_entries/movements | e2e *rolls the whole shop back* |
| 5.1 `SUM(sales.total)` | ✅ 9,006,624.00 = 9,006,624.00 | |
| 5.2 `SUM(products.stock)` | ✅ 7,155 = 7,155 | |
| 5.3 `COUNT(*)` every table | ✅ all 18 equal: products 320, suppliers 153, customers 90, mechanics 14, sales 2,043, sale_items 5,176, returns 120, return_items 241, credit_payments 165, purchase_orders 40, po_items 295, quotes 46, quote_items 115, movements 610, shifts 120, drawer_entries 109, parked_sales 3, settings 1; categories: none missing, none extra | |
| 5.4 points / total spend of every customer | ✅ 0 of 90 differ | |
| 5.5 `credit_balance` of every mechanic + `SUM(credit_payments.amount)` | ✅ 0 of 14 differ; 886,984.00 = 886,984.00 | |
| 5.6 latest shift drawer (starting cash + in − out) | ✅ 905.00 = 905.00 (`sh_2026-08-28_1`) | |
| 6 keep the snapshot ≥ 90 days | n/a (synthetic, regenerable) | for the real file: the owner keeps it outside git |
| a second import into the same tenant | ✅ 409 | e2e |

**Beyond the six checks**
- **Closing report** `GET /reports/closing?shiftId=sh_2026-08-28_1` → startingCash 1000.00, drawerOut 95.00, **expectedCash 905.00**, cashSales 0.00. The file does not link bills to shifts, so imported bills carry no `shift_id`.
- **Document counters:** `doc_counters` has 0 rows after import. No imported number matches the server format `RC01-2569-09-0001` (legacy numbers look like `RC########XXXX`). The first bill after import got **`RC01-2569-09-0001`** and moved imported stock from 11 to 10.

### `full/realistic` (what a real Drift file will look like)

❌ **500 after 2.4 s, whole import rolled back** — `sales_tenant_id_mechanic_id_fkey`. The pre-flight counted these orphans:

| orphan | rows |
|---|---|
| movements → missing product | 3 |
| sales → missing customer | 3 |
| sales → missing mechanic | 32 |
| credit payments → missing mechanic | 8 |
| products → category not in the list | 41 (now auto-created per §9) |

What an orphan should become is the owner's decision → **#238**.

## Bugs fixed in this PR (root cause + test)

1. **Import body capped at 100 KiB** (`server/src/app.setup.ts`). A 10 MiB JSON parser (matching nginx `client_max_body_size`) now covers `POST /api/v1/platform/tenants/:id/import` only.
   🔴 The first cut passed `json()` bare. Nest skips its own parser when it finds a middleware *named* `jsonParser` anywhere in the stack, so every other route lost its body. `POST /platform/tenants` then 500'd on `dto.code`. It is wrapped now, and the e2e's provisioning call covers it.
2. **The import read invented store keys** (`server/src/platform/tenant-import.service.ts`):
   - it now reads `sa_pos`, `sa_cash_drawer` (active) + `sa_shift_history`, `sa_parked`, and string categories (objects are still tolerated)
   - shift ids are issued as `sh_{date}_{n}`, or kept when a server export carries one
   - `auto_archived`/`archived_at` are carried
   - `zone` → category uses the db.js map (`importLegacyBackup()`'s rule, default `เครื่องยนต์`)
   - categories products name but the list lost are created (§9 trap)
   - a sale line's `cost` → `cost_at_sale`
   - tests: `platform.spec.ts` *reads the store keys exportSnapshot() writes (#185)*, and the e2e above

## Filed, not fixed

- **#238:** hard-deleted products, customers and mechanics referenced by history → FK 500. Very likely blocks the real file. Options: tombstones / null the reference / refuse in pre-flight (owner).
- **#239:** the rest of the §9 pre-flight and the error surface:
  - duplicate document numbers → 500
  - unparseable dates silently become import time
  - negative balances clamped, not refused
  - `deletedAt` ignored
  - body-parser 413 → 500
  - a synchronous 6.3 s per 2 MiB against nginx `proxy_read_timeout 30s` (504 while it commits)
  - observations: imported bills have no `shift_id`; the imported active drawer has `device_id NULL` and can never be closed

## Checks run

- Server:
  - `corepack pnpm typecheck` ✅
  - `lint` ✅ (0)
  - `vitest run test/platform.spec.ts test/synthetic-snapshot.spec.ts src/app.setup.spec.ts` ✅ 31/31
  - full `pnpm test`: 318/319. The one failure is **pre-existing and Windows-only**: `src/queue/tenant-job-runner.spec.ts` › *only the tenant export opts out* compares a `relative()` path with `/` and gets `\`. Not touched.
  - e2e: **only** `test/import-snapshot.e2e-spec.ts` ✅ 3/3 (never the full suite: it refuses a concurrent runner)
- Client: `flutter test test/synthetic_snapshot_import_test.dart` ✅ 4/4 · `dart analyze` ✅
- Node here is 24.15.0 (#160 warning); the e2e ran clean anyway.

## What remains for the real snapshot (#185)

1. The owner obtains the shop's `exportSnapshot()` JSON. **Never commit it (PDPA).** Keep it at least 90 days.
2. Settle **#238** first (the real file almost certainly has orphans), and ideally #239 items 1–2.
3. Client check: `cd frontend && SNAPSHOT_FILE=/path/backup.json flutter test test/synthetic_snapshot_import_test.dart`
4. Pre-flight + import + six checks + closing report + counter check, into a kept demo tenant:
   `cd server && SNAPSHOT_FILE=/path/backup.json KEEP_TENANT=1 RECONCILE_OUT=/tmp/evidence.json corepack pnpm test:e2e test/import-snapshot.e2e-spec.ts`
   This targets the local dev stack. The real-file run never rings a bill into the shop's data.
   Importing into the demo VM's tenant is a separate, deliberate step: `POST /api/v1/platform/tenants/{id}/import` with a platform-admin token, then `reconcileImport` against that DB.
5. Record the numbers from `evidence.json` in a handoff. Rows are counts and totals only — no customer data.
6. Tick the DoD box in `03 §8` and close #185.
