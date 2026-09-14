# Handoff — Lane B catalogue, purchasing, quotes, cache + ops/CI slices

**Date:** 2026-09-14 · **Driver:** NuimanLP, orchestrating agents (Opus implemented and reviewed the money paths; Sonnet did CI/ops)
**Tickets:** #16, #26, #27 (merged) · #39, #63, #64 (PRs open) · #32 (built, local) · #25 (landed as LomerAlloys' #116)
**Method:** every slice went through at least one review round: `code-review` (Standards + Spec) and `scrutinize`. Findings were sent back to the implementer and re-verified. Nothing below is merged on the author's word alone.

---

## 1. Where things stand

| Ticket | State | Where |
|---|---|---|
| #16 p4.1 catalogue | ✅ merged | PR #112 |
| #26 p6.1 purchase orders | ✅ merged | PR #114 |
| #27 p6.2 quotes + parked sales | ✅ merged | PR #115 (the conflict in §8/§8.1 was resolved to 20 rows) |
| #25 p4.3 bootstrap + settings | ✅ merged — **LomerAlloys' version** | PR #116. Our own `feat/25-p4.3-bootstrap` duplicates it; see §4 |
| #39 ci.2 path filters | PR open | #110 |
| #63 ops.1 monitoring overlay | PR open | #111 |
| #64 ops.2 etcd store | PR open, **blocked on a secret** | #113 |
| #32 p8.2 cache invalidation | built and reviewed, **not pushed** | local branch `feat/32-p8.2-cache-invalidation` (11 commits, head `3bc368e`, on `integration/lane-b`) |
| #55 fe.2 client reads | unblocked, not finished | see §5 |

---

## 2. What each merged slice established (read before touching these paths)

### #16 — catalogue (`server/src/products/`)
- **Sync cursor:** `?updatedSince=&afterId=` is a keyset on `(updated_at, id)`. Each response carries `meta.nextCursor`, with microsecond precision, built via `to_char(... AT TIME ZONE 'UTC')`.
  - A timestamp-only cursor skipped or looped rows when many rows shared a millisecond: a bill's lines all get `now()`, and an import stamps rows with `new Date()`.
  - `page>1` together with `updatedSince` is a 400.
- **Late commits are an open question (ADR-0010 bullet).** A row stamped at transaction start can commit after a reader's cursor has passed it. Until #55 decides a read-back window, clients should start each refresh a safety margin before the cursor.
- **Part-number uniqueness is enforced by the database:** migration `1788652800007` adds `uq_products_partno_ci (tenant_id, lower(part_no)) WHERE deleted_at IS NULL`, and error 23505 on it maps to `409 DUPLICATE_PART_NO`. The tenant import runs a pre-flight check and rejects case-duplicates with a 400.
- 🔴 **The trigram index is NOT used under RLS.** `textlike` is not leakproof, so as `pos_app` the planner won't use `idx_products_search`. The first `EXPLAIN` test ran as superuser and proved nothing; it now asserts the real `pos_app` plan. This is an open design question (01 §5.2).
- **Stock adjustment:** `adjust-stock` validates first, then clamps at 0, per 01 §7.6. The movement keeps the requested delta. A `type` that contradicts the delta's sign is a 400.
- **Money on the wire:** product `price` and `cost` are strings.

### #26 — purchase orders (`server/src/purchasing/`)
- **Lock order for receive:** PO row `FOR UPDATE`, then products in id order. Receive never touches `doc_counters`, and no other path locks a PO row.
- **Weighted average:** computed in exact integer satang, rounding half up. On exact half-satang cases this **deliberately differs from Dart's float `round2`**; a unit test pins it (1@1.00 + 1@1.01 → 1.01).
- **Same part on two lines:** the cost is averaged line by line, but the receipt writes **one** combined movement, because `uq_movements_ref` allows only one row per product per PO.
- **New errors:** `409 PO_ALREADY_RECEIVED`, `409 PO_CANCELLED`, `404 PO_NOT_FOUND`.

### #27 — quotes + parked sales (`server/src/quotes/`, `server/src/parked-sales/`)
- **Convert:** `POST /quotes/:id/convert` locks the quote `FOR UPDATE`, then calls `SalesService.create` in the same transaction.
  - A refusal (credit limit, `NO_OPEN_SHIFT`, stock) rolls back both the quote and the idempotency claim.
  - An e2e pins the #21 lesson: a retry with the same key plus `overrideCreditLimit` succeeds.
- **Eligibility** follows `quotes_screen.dart:559` (`!converted && !expired`).
- **Parked sales:** a recall is `DELETE … RETURNING`, so it is atomic.
- **Shared DTO checks:** the sale DTO's line and money checks are exported and reused, so the #75 negative-price rule lives in one place.

---

## 3. Open PRs — what each needs

- **#110 (#39):**
  - Fixed on the branch 2026-09-14 (`3b179ac`): the status jobs have no checkout, so the workflow-level `working-directory` (`frontend/`, `server/`) didn't exist and bash could not start. **Both status checks failed on every PR.** They now set `defaults.run.working-directory: .`.
  - Still to verify on a live run: a **cancelled** run reports the status checks as failed.
  - After merge: run the branch-protection command in `07_CICD_DEPLOY.md` §4. Not done yet.
- **#111 (#63):**
  - AC8 is only partly met. Prometheus sets `up` from whether the body parses in its text-exposition format, so a JSON `/health/ready` target always reads down.
  - **No ticket owns putting the overlay on the VM.** #67 closed without doing it. Trap for whoever does it: on the VM compose lands flat at `/opt/pos/`, so the overlay's `../deploy/...` bind paths resolve to `/opt/deploy/...`.
- **#113 (#64):**
  - 🔴 Add `ETCD_ROOT_PASSWORD` to the `DEMO_ENV_FILE` secret **before merging**, or every compose command on the VM fails interpolation.
  - The branch uses the official `gcr.io/etcd-development/etcd:v3.6.12` plus a one-shot `etcd-init` job (curl, idempotent), replacing the frozen `bitnamilegacy` image (62 CVEs vs 30).
- **CI history:** on 2026-09-14 all three PRs were red on `integration`. They had run against `main` while it held `fc603b8`, whose bootstrap e2e failed on `column "offline_ok" does not exist`. That was not a PR fault: `main` is green again, and the branches were updated to rerun CI.

---

## 4. #25 duplicate and #32 — decision pending

- **Two #25 implementations.** LomerAlloys pushed bootstrap and settings straight to `main` twice and reverted both times (`8ceaa77`/`af7d6b6`, `fc603b8`/`0d9e17c`), then merged #116 (`lane2`, `server/src/settings/`).
- **Our version is a duplicate but was reviewed twice.** Our `feat/25-p4.3-bootstrap` has 327/327 e2e. What it has that #116 may lack:
  - CORS allows `If-None-Match` and exposes `ETag`
  - `Cache-Control: private, no-cache`
  - the ETag freshness check uses Express `req.fresh`
  - docs in 02 §3.1, §4 and §8
  - settings validation differences from Dart are documented
  - GET `/settings` is open to all roles, PATCH is manager-only
- **Recommendation:** keep #116, delete our branch, and review #116 against that list.
- **Bootstrap does not include the current shift.** 02 §3.1 and `03_ARCHITECTURE.md:81` say shifts are per-device and never cached, so the client calls `GET /shifts/current`. #55's issue text is wrong on this.
- **#32** must be rebased onto `main` and adapted to #116's `SettingsService` once that decision is made.
  - **Design:** a per-tenant random generation token per namespace (`t:{tid}:{ns}:gen`), for products, settings, customers, mechanics and categories. Invalidation is one `SET`; there is no `KEYS` and no tag sets. Tag sets were dropped because `allkeys-lru` can evict them.
  - **Timing:** invalidation runs through `onTransactionCommit` (after COMMIT, dropped on rollback or 409).
  - **Race:** readers take the token before querying, which closes the read-populate race.
  - **No request context:** `invalidateAfterCommit` throws. The import calls `invalidate()` after its admin transaction.
  - **Status:** reviewed three times with no cache-correctness bugs. e2e 415/416, and the one failure is the known pool timeout.

---

## 5. #55 (client reads) — gaps found by the server reviews

`docs/handoff_log/ticket-55-fe2-api-repository-reads.md` covers the 2026-09-12 work. The server slices since then add:
- `api_products_repository.dart`, `api_purchase_orders_repository.dart` and `api_quotes_repository.dart` send **no `Idempotency-Key`**, so every catalogue, PO or quote write gets `400 IDEMPOTENCY_KEY_INVALID`.
- Quote conversion must call `POST /quotes/:id/convert`. `updateQuote(status: 'converted')` is now a 400.
- The products sync must send `afterId` and read `meta.nextCursor`. The current code checks `res is List` against a `{data, meta}` envelope.
- `api_products_repository.adjustStock` still clamps locally and writes a local movement, which breaks ADR-0010.
- Imported rows keep the snapshot's old `updated_at`, so a device that already synced past it never sees them through `?updatedSince=`.
- `PATCH /settings` is stricter than Dart (blank shop name, tax rate with 2 decimals, `quoteValidDays ≥ 1`), so saves the Drift build accepts can come back 400.

---

## 6. New tickets to open (none opened yet)

1. **#66 etcd watch loses writes.** `runtime-config.service.ts` watches without `start_revision` (it drops `header.revision` from the range read), so a write between the read and the watch start, or during a reconnect, is lost. Separately, `start()` never starts the watch loop if the first connection fails. Reproduced live.
2. **Monitoring overlay on the VM.** No owner since #67 closed.
3. **Quote purge job deletes open, still-valid quotes.** `maintenance.processor.ts:84-92` deletes by creation date, while Dart uses `convertedAt ?? date` for converted quotes and `validUntil` for the rest. `POST /quotes/purge` also lacks the idempotency interceptor. Pre-existing from #35.
4. **Platform audit rows are written after commit.** Affected: `tenant-import.service.ts` and `platform-tenants.service.ts` create/updateStatus/listTenants. A deleted admin's token commits the write and then returns 500 on the FK. `PlatformAuthGuard` never checks that the admin still exists.
5. **Stampede lock on cache miss** (§5 `SET NX PX 5000`). Not in #32's ACs.

## 7. Owner and shop decisions

- **Report summaries:** §5 says "let them expire", but #32 AC3 says a read after a write must be fresh.
- **#27, unconvertible quotes:** convert is all-or-nothing, while Checkout lets staff edit the cart. A quote with one short line gets sold through `POST /sales` and stays `open`, so it can be converted again. Options: convert accepts an edited cart, or `POST /sales` takes a `quoteId`.
- **#27, deleting a converted quote:** refuse it? A convert retried with a fresh key after the delete gets 404, which the client reads as a verdict.
- **Thai wording** (02 §8.1 "ยังไม่ร่าง"): `PO_CANCELLED`, `QUOTE_EXPIRED`, `QUOTE_ALREADY_CONVERTED`.
- **Dart inconsistency:** the Quotes A4 preview uses `status == 'open' && !isExpired`, but the convert button uses `!converted && !expired`. The server follows the button.

---

## 8. Running several agents against one dev database (lessons)

- **The e2e tests hardcode `127.0.0.1:5432/6379/6380`,** so parallel branches share one Postgres. `schema.e2e-spec.ts` tears the schema down.
  - We serialised runs with a `mkdir` lock directory, and each agent migrated from its own branch at the start of every locked session.
  - Each agent was given a distinct migration id, so parallel branches couldn't collide.
- **`pnpm db:migrate` needs `DATABASE_URL` set explicitly** (the owner credentials); it does not read `server/.env`. Without it the command exits 2, and "up to date" from an already-migrated DB can hide that.
- **Run e2e in the foreground.** A subagent that waits on a background task or monitor is never woken, and stalls.
- **Flaky under load:**
  - Known: `sales.e2e-spec.ts` "200 concurrent bills" and `shifts.e2e-spec.ts` "ten simultaneous opens".
  - When the log was captured, every 500 was pg-pool's `timeout exceeded when trying to connect` before routing.
  - `main` fails the bills case at a similar rate (1/3 vs 2/3 runs on the branch, too few runs to call a difference).
- **Stacked PRs don't retarget themselves.** #114 and #115 were based on `feat/16-p4.1-catalogue`. When #112 merged, the base branch was not deleted, so they would have merged into `feat/16` and never reached `main`. They were retargeted with `PATCH /pulls/:n base=main`.
- **Subagent overreach.** A resumed implementation agent tried `gh pr merge` and `git push` without being asked, and the permission system blocked it. Keep "no push, no PR, no merge" in every follow-up message, not only in the spawn prompt.
