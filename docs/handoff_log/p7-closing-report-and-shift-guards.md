# Handoff: closing report, gross profit, and the drawer guards (2026-09-13)

**Owner:** NuimanLP (`team/1`). **State:** everything below is merged to `main` (HEAD `99932c3` before this doc).
Every slice followed the same sequence:
1. One implementer (Opus) built the slice.
2. `/scrutinize` (Opus) and `/code-review` (Sonnet) reviewed it in parallel.
3. Fixes were applied.
4. The PR was opened, CI went green, and it was merged.

| Issue | PR | What it did |
|---|---|---|
| #30 `p7.2` | #96 | `GET /reports/closing?shiftId=`: expected cash, variance and gross profit, keyed by `shift_id` only |
| #95 `p7.3` | #98 | `GET /reports/summary`: every figure uses one set of bills, and `grossProfit` is added |
| #97 `p7.4` | #99 | top-products / by-category / product-sales use the same set of bills |
| #94 (decision → A) | #101 | `POST /sales/:id/void` works only on a bill from the caller's open shift |
| #100 (decision → A, cash) | #102 | a cash refund needs an open drawer; every refund reads the drawer `FOR SHARE` |
| #7 | – | Lane A parent closed (all children done) |

The project owner settled both decisions in this session. Each decision is recorded as a comment on its issue.

## The one idea behind all five

**A closed shift's report must never change afterwards, and cash that moves must land in a shift.**
Reports are live SQL; nothing is snapshotted at close. That leaves two ways to break the rule:

1. **A write that removes a row from a closed shift.** A manual void did this. The fix is #94.
2. **A write that lands on a closed shift, or on no shift at all.** A cash refund with no drawer did this, and so did a non-cash refund racing a close. The fix is #100.

Every money write now takes the drawer `FOR SHARE` after its replay path:
- sales and credit payments since #24
- void since #94
- returns since #100

A write refused here is refused before anything is written.

## Report semantics (read before touching `server/src/reports/`)

- **`COUNTED_SALE`** decides which bills count. A *manual* void (voided, no credit note) is excluded. A bill *auto*-voided by a full return is counted, and its credit note subtracts. Excluding it would take the refund off twice. The two kinds are told apart by `SALE_HAS_RETURNS` / `SALE_VOIDED`, which make "voided and has a return" mean auto-void.
  - Every report uses it: closing, summary, top-products, by-category, product-sales.
  - `stock-value` / `low-stock` read only `products` and don't need it.
- **Gross profit** is `(Σ sales.total − Σ refund_total) ÷ (1 + tax_rate/100) − Σ line qty × cost`.
  - Line cost is `cost_at_sale`, then `products.cost` (soft-deleted rows included), then 0.
  - `estimatedCostRows` / `unknownCostRows` disclose the fallbacks (ADR-0008).
  - Credit notes net out, using `return_items.cost_at_sale`.
  - `grossProfitCtes(saleScope, returnScope)` is shared by closing (shift filter) and summary (date filter). The scope arguments are string literals, never request input.
- **Cash terms** filter on the method string `'เงินสด'` of each document. Non-cash refunds don't move expected cash, but they *do* net into the shift's `grossProfit`.
- **AC5 caveat:** profit on a line whose `cost_at_sale` is null moves with today's `products.cost`. The line is flagged, not frozen, as ADR-0008 allows.
- Migration `1788652800006` added `idx_returns_shift`.

## Drawer rules now in force

| Write | No open drawer | Bill/shift mismatch |
|---|---|---|
| `POST /sales`, credit payments (#24) | `409 NO_OPEN_SHIFT` | – |
| `POST /sales/:id/void` (#94) | `409 NO_OPEN_SHIFT` | `409 SALE_NOT_IN_OPEN_SHIFT` (closed shift, another device, null `shift_id`) |
| `POST /returns`, `'เงินสด'` (#100) | `409 NO_OPEN_SHIFT` | – (a refund lands in the *current* drawer) |
| `POST /returns`, `โอน` / `หักจากเครดิต` | accepted, `shift_id` null | – |

- **Order on void and returns:** sale lock → bill guards → drawer (`FOR SHARE`) → mechanic → products → `doc_counters` → customer.
  - No deadlock is possible: the drawer's exclusive lockers (open, close, drawer entries, retirement) take no other money-path lock.
  - Key replays are answered by the interceptor, so a write committed while the drawer was open still replays after close.
  - A refused write rolls back its idempotency claim and uses no document number.
- **After today's close, a cash refund waits for tomorrow's open.** `POST /shifts/open` hands back today's closed row.
- **A shift that is never closed or archived still counts as open.** Old bills inside it can still be voided.

## Open / not done

- **Thai wording for `SALE_NOT_IN_OPEN_SHIFT`** is for the shop to write (§8.1). No client calls `/void` yet, and #83 owns the resolver mapping.
- **No concurrency test** pins "a close waits for a void / cash refund in flight". #24 has the same gap. #100 *does* pin the non-cash race: a separate connection holds the drawer lock.
- **The offline Drift build** still takes cash refunds and sales without a drawer. This is the phase-1 divergence #24 accepted.
- **The `CASH` string constant** is duplicated across modules. The pattern predates this work.
- **`200 concurrent bills`** still fails locally. It is the known pool limit, and CI is green.
- **A flake:** `sale-reads › reports per-line refunded quantities` failed once locally, then passed on every rerun. It is unrelated to these diffs, and its cause is unproven.

## Traps hit this session

- **`pnpm test:e2e -- <files>` runs the whole suite.** Use `pnpm exec vitest run --config ./vitest.config.e2e.ts <files>`.
- **A stale scratchpad backup overwrote a reviewed file during a falsification step.** `git diff` caught it. After falsifying, restore from `git`, never from a copy.
- **`01_DATABASE.md` is CRLF.** A naive edit rewrote all 2,263 lines. Preserve line endings.
- **Deleting merged local branches with `git branch --merged | xargs git branch -d`** also deleted local `POC_sample_offline_first`. It was restored from origin. Exclude it.
- **CI integration once died in `pnpm install`** (an undici `assert(!this.paused)`) before any test ran. Rerunning the failed job fixed it.
- **`gh pr checks --watch` returns immediately** if only CodeRabbit has registered. Wait for the Server CI run (`gh run watch`).
