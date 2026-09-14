# Handoff: close-out — #138 login limits, deploy.yml prune fix, open work ticketed

**Date:** 2026-09-14 · **Follows:** `docs/handoff_log/ops-auth-cache-monitoring-etcd.md`

## 1. Where things are

- `main` has no open PRs. The only branches (local and on GitHub) are `main` and `POC_sample_offline_first`.
- Merged this round: **PR #146** (#138) and **PR #147** (deploy.yml fix). Both reviewed by a separate agent;
  CI green (`server-ci-status`, `flutter-ci-status`, `integration`). CI does not run the Ansible playbook.
- Every open item now has an issue — see §4.

## 2. #138 → PR #146: login brute-force limits

All five items in #138 were real:

| Item | Before | After |
|---|---|---|
| Success reset the IP bucket | one valid account could reset the limit and spray usernames | `refundAttempt` gives back only its own attempt, never creates a key; the username bucket is still cleared |
| Check-then-increment race | 15 concurrent bad logins from one IP → 15×401 | `consumeAttempt` = one Lua `INCR` + expiry → 10×401 + 5×429 |
| Key collisions | non-`[A-Za-z0-9_:-]` → `_`, so equal-length Thai usernames shared a bucket | `rl:<sha256>:<window>` |
| Uncounted refusals | ambiguous / inactive / suspended not counted | counted up front; responses unchanged |
| Two IP sources | `AuthController` read `req.ip` | `clientIp(req)`; wiring tests for auth + all three platform tenant routes |

Tests: unit 256/256; security/auth/platform e2e 36/36; full local e2e 422/423 (the known `200 concurrent bills`
pool limit). The two new concurrency e2e tests fail on the pre-fix code.

Review (no defects), notes worth keeping:
- A login counted in one minute that succeeds in the next refunds the *new* minute's bucket. Still ≤10 failures
  per minute on average; fix if wanted by returning the counted key from `consumeAttempt`.
- `Retry-After` can overstate the wait by up to ~59 s (pre-existing).
- Carrier-grade NAT puts unrelated shops behind one IP bucket; a success no longer clears it. Design trade-off.
- Still open in `server/README.md` *Login brute-force limits*: the void manager-PIN path is check-then-increment;
  "user is inactive" / `TENANT_SUSPENDED` answer before the password check (username enumeration).

## 3. PR #147: deploy.yml after a second review of #135's fixes

A re-review of three merged review-fix commits found `57ed350` (cache) and `55539e5` (auth) clean, and two
problems in `91ebe98` (deploy):

1. **Prune wiped the VM config** when the playbook ran through a symlinked path (macOS `/tmp` → `/private/tmp`):
   `realpath` on one side, unresolved `find` paths on the other, so every file looked stale. Compose then made
   `prometheus.yml/` a directory and the next release's copy task failed the whole deploy. Reproduced on
   localhost; fixed by comparing `relpath` on both sides.
2. **"Monitoring never fails a deploy" was not true:** `monitoring.yml` was in the POS pull, web-sync, migrate
   and rollout, so a Docker Hub outage for `prom/*`/`grafana/*` or a missing `GRAFANA_ADMIN_PASSWORD` blocked a
   POS release. POS steps now use `pos_compose_files` (base + VM override only); copy, prune, pull, `up` and
   recreate of the overlay run inside the `block`/`rescue`.
3. The disabled-path `rm -sf` sets a placeholder `GRAFANA_ADMIN_PASSWORD` so interpolation cannot silently fail.
4. The rescue message shows stderr and explains that re-running the same SHA exits early.

The #147 reviewer ran `docker compose config --hash='*'` on both file sets: the 14 POS service hashes and the
network are identical, so POS commands without `monitoring.yml` recreate nothing; monitoring containers are
orphans only `--remove-orphans` would delete (never passed). Low-severity leftovers → **#148**.

**Not run on the VM.**

## 4. Open work (all ticketed)

| Issue | What | Who |
|---|---|---|
| #67 (reopened) | `.github/workflows/deploy.yml` never existed — #67 was closed COMPLETED with no workflow | needs owner go-ahead (see below) |
| #140 | ioredis `commandTimeout` | `team/3` |
| #141 | e2e runners sharing one database corrupt each other | — |
| #142 | ADR-0003 handler-scoped transaction slices `tx.0`–`tx.5` | `team/1` |
| #143 | Flutter login screen + router redirect (#54 AC3/AC5) | — |
| #144 | `src/devices` + a production caller of `closeForRetirement` | `team/3` |
| #145 | Thai counter wording for `SALE_NOT_IN_OPEN_SHIFT` | shop owner (`question`) |
| #148 | monitoring recovery gaps (stale Prometheus config after a swallowed failure, silent `rm`, no `ip_range`) | `team/3` |

Parent #8 (Lane B) is closed — every child was closed. #2, #10 and #60 stay open (phase 1 items above, #67).

**#67 and the permission classifier:** an agent asked to write the deploy workflow was stopped by Claude Code's
auto-mode classifier as "Production Deploy". It was not worked around. Writing the workflow as a PR is code, not
a deploy, but it needs the owner to allow it explicitly.

## 5. For a person, before the next deploy

1. Add `ETCD_ROOT_PASSWORD` and `GRAFANA_ADMIN_PASSWORD` (e.g. `openssl rand -base64 32`, each different, never
   the `.env.example` values) to `DEMO_ENV_FILE`; re-run `provision.yml`. Missing etcd password = deploy fails;
   missing Grafana password = monitoring stays down. Don't `export DEMO_ENV_FILE` into shell history.
2. Set branch protection on `main` (07 §4 command; still 404 today).
3. Run one real deploy to the demo VM — etcd (#113), monitoring (#135, #147) have never run there.

## 6. Branch clean-up done

- All agent worktrees removed. Local branches: `main` only.
- Four local branches with unpushed commits were deleted on the owner's say-so. Recover within git's reflog
  window if ever needed: `integration/lane-b 1434ee7`, `feat/25-p4.3-bootstrap d80f269`,
  `feat/32-p8.2-cache-invalidation.bak 3bc368e`, `tmp/merge-check 11b6317`.
- GitHub: 20 merged branches deleted (checked `origin/main..<branch>` = 0 for each); `POC_sample_offline_first`
  kept on purpose.
- Trap: in zsh, `git push origin --delete $list` passes the whole list as one argument (no word splitting) and
  deletes nothing — use a bash array.
