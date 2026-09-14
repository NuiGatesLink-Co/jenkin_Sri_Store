# Handoff: orchestrated round — #140 #141 #142 #143 #144 #148, then #160 #161 #162

**Date:** 2026-09-14 · **Follows:** `docs/handoff_log/ops-closeout-138-deploy-tickets.md`

One orchestrator session ran parallel Opus sub-agents, one worktree and one PR per ticket. Each PR was
merged after its own CI went green (`flutter-ci-status`, `server-ci-status`, `integration`). CI on `main`
at `173224c` is green for both workflows. The agents' own evidence (run counts, dumps, measurements) is in
each PR body — this file keeps the conclusions and the traps.

## 1. Where things are

- **No open PRs.** Long-lived branches only: `main`, `POC_sample_offline_first`. The prototype worktree
  `agent-a1756ff02f223b4eb` (`0feaf94`, ADR-0003) is kept on purpose — never merge it.
- **Merged:** PRs #155 #156 #157 #158 #159 (round 1) and #164 #165 #166 (round 2).
- **Issues created:** #149–#154 (tx.0–tx.5, from #142), #160 #161 #162 (closed by round 2), #163 (question).

| Ticket | PR | What landed |
|---|---|---|
| #141 | #157 | e2e `globalSetup` takes a session advisory lock in the `postgres` DB; a second concurrent run refuses to start and names the holder |
| #140 | #158 | ioredis `commandTimeout` via `REDIS_COMMAND_TIMEOUT_MS` (default 1000 ms) on the cache/queue ioredis clients, **not** on BullMQ's own connections (blocking `BZPOPMIN`/`XREAD`) |
| #144 | #159 | `server/src/devices/` — `POST /devices`, `GET /devices`, `POST /devices/:id/retire`, owner only; retire calls `closeForRetirement` in the same transaction |
| #143 | #155 | `/login` route + go_router redirect with `?from=`, only with `USE_API_WRITES`; shared `LoginForm` |
| #148 | #156 | deploy.yml: always force-recreate prometheus+grafana, warn on failed monitoring removal, base network `ip_range 172.30.0.128/25` + `gateway .1` |
| #142 | — | split into #149 → #150 → #151 → #152 → #153 → #154 (linear blocked-by); comment + first AC ticked on #142 |
| #161 | #164 | only 401/403 from `/auth/refresh` ends a session; the refresh reply is read inside the envelope's `data` |
| #162 | #165 | pool deadlock in `RateLimitService.getTenantPlan` fixed (request transaction + savepoint) |
| #160 | #166 | root cause is Node 24.15.0's libuv on Windows; e2e setup warns on affected Node |

## 2. Traps found (all also in `CLAUDE.md`)

1. 🔴 **Every successful token refresh against the real server signed the cashier out** (#164). The client
   read `accessToken` at the top level; the server's `EnvelopeInterceptor` puts it under `data`. The unit test
   mocked an unwrapped reply, so it never showed. A lost refresh reply is safe to retry: ADR-0009 keeps no
   denylist/reuse detection — if that is ever added, the client needs a grace window.
2. 🔴 **Guards are inside the request** (#165). The middleware holds a pool connection; a global guard that
   calls `this.ds.query` takes a second one. At `DB_POOL_SIZE` concurrent requests with a cold plan cache
   every holder waits for a second connection → 10 s stall, queued requests 500. Production hits it whenever
   the 5-minute plan cache expires under a burst. `200 concurrent bills` and `ten simultaneous opens` were this
   deadlock, **not** a machine limit (successes equalled pool size exactly). Pinned by
   `test/rate-limit-pool.e2e-spec.ts` (pool 2, 12 requests, < 3 s). This weakens — does not remove — the
   performance case for the tx.* slices.
3. 🔴 **Node 24.15.0 on Windows** (#166): `uv__tcp_try_connect` calls `RtlGetVersion` with an uninitialised
   size field; when stack garbage equals `0x11C` Windows writes 8 bytes over the GS cookie → `0xC0000409`.
   9 runs/5 crashes on 24.15.0 vs 8/0 on 24.21.0. Fixed upstream (libuv#5107) in Node ≥ 24.16.0 / ≥ 26.1.0.
   **This machine is still on 24.15.0.** Older notes blaming "Worker exited unexpectedly" on pool pressure were
   never backed by a dump.
4. 🔴 **pnpm hard-links `node_modules` from one store** (`D:\.pnpm-store\v10`). A debug edit to a vitest chunk
   in one worktree appeared in another agent's runs. Instrument repo files, never `node_modules`.
5. 🔴 **#156's network change is not in-place.** On a host whose `srisurart-pos_default` predates it, `run --rm`
   swaps the network under running containers (api loses `.11–.13`) and partial `up -d` fails with "active
   endpoints". `deploy.yml` now stops at a pre-flight check. One-time step (07 §7):
   `IMAGE_TAG=$(cat .current_sha) docker compose -f docker-compose.yml -f vm.override.yml down --remove-orphans`
   (never `-v`), then deploy a **new** SHA. **The VM has not had this yet.** This dev machine has (data intact).
6. **`server/.env` on this machine lacks `ETCD_ROOT_PASSWORD`**, so any `docker compose` against the base file
   fails at interpolation. The network recreate above passed it inline for that one command; `.env` is
   unchanged.
7. **Retire lock order is devices (`FOR NO KEY UPDATE`) → shifts (`FOR UPDATE`)**; `ShiftsService.open` reads
   the device `FOR SHARE` first so a retired device (token still valid ≤ 15 min) cannot open a new drawer.
   Nothing on the money path locks `devices`. `closeForRetirement` also archives a closed-but-unarchived drawer.
8. **tx.* plan is stale** (dated 2026-09-10): ~20 files read `currentRequestContext()` today vs the 4 services
   the plan converts in tx.2, and `IdempotencyInterceptor` also guards non-money writes (tx.3). Unconverted
   callers 500 after tx.4. Recorded as questions in #151/#152.

## 3. Decisions waiting on a human

| Where | Decision |
|---|---|
| #67 | allow an agent to write `.github/workflows/deploy.yml` (permission classifier blocked it as "Production Deploy"); merge only after one manual VM deploy works |
| #151 / #152 | tx.2/tx.3 scope — convert every request-context user / every interceptor-guarded write, or split further |
| #163 | owner-only vs manager for device enrol/retire; 15-min code lifetime; plaintext enrol code kept in the idempotency store's saved response; re-issue code / rename / client screen in phase 1? |
| #145, #163, #155 | Thai wording: `SALE_NOT_IN_OPEN_SHIFT`; `POS_DEVICE_EXISTS`, `DEVICE_NO_EXHAUSTED`, `DEVICE_ALREADY_RETIRED`, `PHYSICAL_CASH_REQUIRED`; single `เข้าสู่ระบบไม่สำเร็จ` for every login refusal; "clearing browser data needs re-enrolment" hint |
| owner | `DEMO_ENV_FILE` += `ETCD_ROOT_PASSWORD`, `GRAFANA_ADMIN_PASSWORD` → `provision.yml`; branch protection on `main` (07 §4); one real VM deploy incl. the §2.5 network step |
| this machine | upgrade Node to ≥ 24.16.0 |

## 4. Known gaps, not ticketed

- `ApiClient` sets no request timeout — a hung refresh holds every request queued behind it (#164 notes).
- #155: an enrolled machine shows the "โหมด Backoffice" badge until sign-in; logout from Settings returns to
  Settings after the next login.
- #158: on a hung cache Redis `TenantGuard` can wait read + write-back = 2× the timeout; BullMQ enqueues after
  commit can still stall on a hung queue Redis; `PlatformTenantsService.getTenantStatus` doesn't catch Redis
  errors (same as a dropped connection before).
- #159: the manager-PIN void path is still check-then-increment (pre-existing, from #138).
- One leftover folder `.claude/worktrees/agent-afb6f6999daf5ac30` could not be deleted (held open); git no
  longer tracks it — delete by hand.

## 5. Next for Lane A (`team/1`)

1. #149 tx.0 (docs only, `ready-for-agent`).
2. Settle #151/#152 scope before tx.2 starts.
3. tx.3 (#152) is the slice that fails silently and as money — keep the same-`Idempotency-Key` resend after
   `409 CREDIT_LIMIT_EXCEEDED` working (existing counter-path e2e in `sales-ledger`, `credit-payments`,
   `quotes-parked`).
