# Handoff: ADR-0003 handler-scoped transaction migration (tx.0–tx.5)

**Date:** 2026-09-14 → 2026-09-15 · **Follows:** `docs/handoff_log/orchestrated-round-2026-09-14.md`

One orchestrator session ran the six slices of #142 strictly in order. Each slice went through the same steps:

1. An Opus implementer worked in its own worktree.
2. Two independent reviewers ran in parallel: `/scrutinize` (adversarial, allowed to run e2e and temporary probes) and `/code-review` (high effort, read-only).
3. The implementer fixed the review findings.
4. CI went green, the PR was merged, and CI on `main` went green before the next slice started.

Every implementer followed `karpathy-guidelines`. Each PR body holds its own evidence (run counts, falsification output, measurements). This file keeps the conclusions and the traps.

## 1. Where things are

- **No open PRs** from this round. #142 and #149–#154 are closed. The ADR-0003 addendum is **Accepted**.
- **CI on `main`** was green after every merge (`f009e39`, `83a3d4a`, `faaa899`, `7ce100c`, `ac4a748`, `89be2a7`).
- **Leftover worktree folders** under `.claude/worktrees/agent-*` could not be deleted: `node_modules` is held open. Git no longer tracks them. Delete them by hand. The prototype worktree `agent-a1756ff02f223b4eb` (`0feaf94`) is still kept on purpose; never merge it.

| Slice | Issue | PR | What landed |
|---|---|---|---|
| tx.0 | #149 | #167 | `server/README.md` seam section rewritten as target plus in-force; CLAUDE/AGENTS/plan status |
| tx.1 | #150 | #168 | `runTx(fn)` joins an open transaction; `run(tid, fn)`/`runTx(tid, fn)` deleted; `tenant-door.spec.ts` (pool injection + who may name a tenant); hooks run outside the released scope |
| tx.2 | #151 | #170 | 80 public context readers wrapped as `runTx(() => this.xIn(...))` (codemod, bodies unchanged); `tenant-wrapper.spec.ts`; `runtx-join.e2e-spec.ts` |
| tx.3 | #152 | #171 | `IdempotencyInterceptor` deleted; `IdempotencyService.runIdempotent(params, res, work)` does claim → work → complete in one `runTx`; 38 routes; `idempotency-routes.spec.ts`; `idempotency-money.e2e-spec.ts` counts table rows |
| tx.4 | #153 | #172 | `RequestContextMiddleware`, `TransactionInterceptor`, `TENANT_ROUTES`, `currentRequestTransaction` deleted; `TenantScopeMiddleware` (no DB); guard status probe is a pool read; `onTransactionCommit` throws outside a transaction; `tx-hold-measure.e2e-spec.ts` (opt-in) |
| tx.5 | #154 | #174 | `voidSale`: key check → `VoidService.authorise` (short `runTx` read, argon2 with no connection held) → `runIdempotent`; atomic `consumeAttempt` PIN lockout; `AuthorisedVoid` bound to bill and tenant |

**Measured** (4 concurrent voids, `DB_POOL_SIZE=2`, longest transaction in `pg_stat_activity`):

| State | Longest transaction | Latency | Notes |
|---|---|---|---|
| before | 101–131 ms | staircase ~102/108/199/205 ms | |
| after tx.4 | unchanged, ~110 ms | | argon2 still inside; `POST /sales` 19 → 16.5 ms |
| after tx.5 | 13–24 ms | flat ~115/121/127/133 ms | |

The ≲30 ms AC moved from #153 to #154 by comment, not silently.

## 2. Traps and findings (the reviews earned their cost)

1. 🔴 **tx.5 as first written removed the manager-PIN lockout** (scrutinize probe, blocker).
   - The limit was check-then-increment, and only the pool bounded it while argon2 held a connection.
   - Out of the transaction, 60 concurrent wrong PINs all reached argon2 (`main`: 6).
   - Fixed with the atomic `consumeAttempt` that login uses. A no-PIN refusal refunds its attempt.
   - Pinned by `test/void-pin-burst.e2e-spec.ts` (5 verifies + 35×429; red without the fix).
   - **General lesson:** moving work out of a transaction can remove an accidental concurrency bound that a security check depended on.
2. 🔴 **The door scan had four bypasses** (tx.1 review): property `@Inject(DataSource)`, `get<DataSource>()`, an import alias, `manager.connection`. There were also exported scope-forging functions (`runInTransaction`, `setRequestTenant`, `TenantJobRunner.runWithTenantContext`). All are now policed by `tenant-door.spec.ts`.
3. **Joined `runTx` never rolls back on its own**: catching its error does not undo its writes, and a Postgres error aborts the outer transaction (25P02). Two parallel `runTx` calls take two connections, which is the #162 shape after tx.4. Both are documented on `runTx`.
4. **Replay status reaches the wire.** The reviewers disagreed on whether Nest overwrites `res.status()` on a replay. An HTTP probe settled it: it does not (Nest 12 `router-execution-context.js:76` passes no status). `idempotency.e2e-spec.ts` now has a discriminating case.
5. **A replayed void now checks the PIN first.** A done key with the same body after the PIN changed gets 403 plus a denial row instead of the stored 200. A wrong PIN on a done key was already 409 (the PIN is in the body hash). The full precedence table is in PR #174.
6. **Stacked PRs close when their base branch is deleted outside a merge.** Deleting `docs/149…` by hand closed #168; it was restored and reopened. Retarget the child PR to `main` **before** merging its base with `--delete-branch`. A worktree holding the local branch makes `gh pr merge --delete-branch` fail before it deletes the remote branch.
7. **Portable Node 24.21.0** in the session scratchpad served every agent, because this machine's system Node is still 24.15.0 (#160). Upgrade the system Node.
8. `PurchasingController` (`purchasing.controller.ts`) is registered in no module, so it is dead code, but its routes are pinned in `idempotency-routes.spec.ts`. Delete both together.

## 3. Follow-ups filed

| Issue | What |
|---|---|
| #169 (`team/3`) | `idem.cleanup` with no `tenantId` runs as `pos_app` under forced RLS and deletes 0 rows while reporting success. Latent: nothing enqueues it without a tenant |
| #173 (`team/1`) | cached reads (`products` list, categories, settings) open a transaction before checking Redis; a `singleFlight` waiter sits idle-in-transaction on a pooled connection |
| #175 (`team/1`) | role and no-PIN void denials are unbounded; the 2-connection `AUDIT_DATA_SOURCE` can time out and drop a `sale.void.denied` row (now logged at error level) |

Known, not ticketed:
- Backup and `purgeQuotes` role checks open a transaction before a 403.
- `purgeQuotes` enqueues inside the transaction on purpose (deterministic job id, idempotent purge).
- `RateLimitService.getFailureStatus`/`recordFailure` have no production caller left.
- A new write route with **no** claim is invisible to `idempotency-routes.spec.ts`, as it was to the interceptor.

## 4. Decisions still waiting on a human

Unchanged from the previous handoff:
- #67: permission to write `deploy.yml`
- #145: Thai wording for `SALE_NOT_IN_OPEN_SHIFT`
- #163: device management
- branch protection on `main`
- `DEMO_ENV_FILE` secrets, then `provision.yml`
- upgrade Node on this machine
- `ApiClient` has no request timeout

The project board ("Mobile Srisurat-POS") has only Todo / In progress / Done, so there is no "In review" column.
