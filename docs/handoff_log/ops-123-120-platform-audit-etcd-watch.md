# Handoff: platform audit in the transaction (#123) + etcd watch (#120)

**Date:** 2026-09-14 · **Branches:** `fix/123-platform-audit-in-tx` → PR #130,
`fix/120-runtime-config-watch` → PR #129 · **Lane:** `team/3` (platform / ops)

## 1. Where things are

- Both PRs merged into `main` with CI fully green (lint, typecheck, unit, audit, integration with real
  Postgres + both Redis).
- An orchestrator session ran them: one implementer agent per ticket, then one review agent per PR, then one
  fix agent per review. #120 ran in its own git worktree with unit tests only, so it never touched the
  shared e2e database.
- Still open: #121 (monitoring overlay in Ansible), #124 (cache stampede lock), PR #113 (#64, conflicts
  with `main`).

## 2. #123 — platform audit inside the business transaction

**The bug:** `createTenant`, `updateStatus` and the tenant import committed, *then* inserted `audit_log`
on a separate connection. A token for a deleted admin committed the tenant and then answered 500 on
`audit_log_platform_admin_id_fkey`, leaving a tenant whose `code` could not be retried.

**What shipped:**
| File | Change |
|---|---|
| `server/src/platform/audit.service.ts` | `log(runner: EntityManager \| DataSource, input)`; no default connection; IP value containing `%` stored as null |
| `platform-tenants.service.ts` | create + status audit via the transaction `manager`; `listTenants` catches and warns |
| `tenant-import.service.ts` | import audit via the transaction `manager`; cache invalidation still after commit |
| `platform-auth.guard.ts` | checks `platform_admins` `id` + `is_active`, cached `pa:<id>:exists` 60s in `REDIS_CACHE`, DB fallback on Redis error |
| `platform-auth.service.ts` | login passes `adminDs` explicitly |
| `test/platform.spec.ts`, `test/platform.e2e-spec.ts` (new) | unit 211/211; platform e2e 9/9 |

**Removed from the earlier (non-Claude-Code) session's draft:** a `log()` that accepted its arguments in
either order and sniffed which one had `.query` at runtime, with a fallback to its own connection. That
fallback is exactly how an audit silently escapes a transaction, so it is gone.

**How rollback is proven:** the e2e pre-seeds `pa:<id>:exists='1'` for an admin id that has no row. The
guard trusts the cache, the service runs, and the audit insert fails its FK inside the transaction. The
test then checks the database: no tenant/user (create), `tenants.status` still `active` (status), no
imported category (import).

**Review findings (PR #130):**
1. CONFIRMED, fixed — `net.isIP('fe80::1%eth0')` returns 6 but Postgres `inet` rejects it. Once the audit
   is inside the transaction, a client-sent `X-Forwarded-For` like that rolled back the write and also
   500'd platform login.
2. CONFIRMED, fixed — only create had a real rollback test; status and import were mocked.
3. PLAUSIBLE, not fixed — a cached `'1'` outlives deactivation by up to 60s. Nothing deactivates admins in
   code today. **A future deactivate path must `DEL pa:<id>:exists`.**

**Still open:** the stored IP is the leftmost `X-Forwarded-For` entry. nginx's
`$proxy_add_x_forwarded_for` appends to the client's header, so that entry is client-controlled; the
rightmost is the one nginx wrote. The tenant-plane `src/audit/audit.service.ts` has the same parsing.

## 3. #120 — `RuntimeConfigService` watch

**The bugs:** the watch dropped updates between the initial range and the watch start, an initial connect
failure disabled the watch forever, and `header.revision` was ignored.

**What shipped** (`server/src/config/runtime-config.service.ts` + spec):
- `latestRevision` from the range header and each event's `mod_revision`; every watch starts at `+1`.
- Boot failure still fails open with one warning, then the loop keeps retrying and re-reads before watching.
- Compaction → full re-read, then watch from the new revision.
- Exponential backoff 1s → 30s with jitter.

**Review findings (PR #129), all fixed in `5c498d1`:**
1. The attempt counter reset on HTTP 200, so accept-then-cancel (e.g. an etcd role change) retried every
   1s forever. It now resets only after a delivered event.
2. A cleanly closed stream (`done`) returned without throwing and reconnected with no delay — a probe
   opened 2,001 watches in 50 ms and ran vitest out of heap. It now throws `etcd watch stream ended`.
3. Each backoff wait left an abort listener on the shared signal (~2,880/day at the cap). Removed when the
   timer fires.
4. 07 §8's "warn once" was broken — every retry warned. Now warn once per outage, debug after.

The five review-fix tests use fake timers; each failed (or crashed/hung) on the previous head. Unit
211/211. E2e was left to CI's `integration` job.

Nothing sets `ETCD_URL` until PR #113 lands, so none of this is exercised in a deployed stack yet.

## 4. Traps met this round

- `gh pr edit` fails on GitHub's deprecated Projects (classic) GraphQL field. Update a PR body with
  `gh api -X PATCH repos/NuimanLP/srisurart-pos-flutter/pulls/<n> -f body=…`.
- A branch checked out in an agent worktree cannot be checked out again elsewhere; push from another local
  branch name (`git push origin local:remote`). Clean `.claude/worktrees/agent-*` after merge.
- The full local e2e still shows only the known `200 concurrent bills` failure (8 instead of 50) — pool
  timeout before routing, recorded in `CLAUDE.md`.
