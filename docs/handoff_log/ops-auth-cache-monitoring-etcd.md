# Handoff: client IP, login rate limit, stampede lock, monitoring deploy, etcd service

**Date:** 2026-09-14 · **Lane:** `team/3` (platform / ops) · **Follows:**
`docs/handoff_log/ops-123-120-platform-audit-etcd-watch.md`

## 1. Where things are

All five PRs are merged into `main` (last: `697b1ba`), each with green `server-ci-status` / `flutter-ci-status`
including `integration` (real Postgres + both Redis).

| Issue | PR | What |
|---|---|---|
| #132 | #133 | audit IP = rightmost `X-Forwarded-For` entry (the one nginx appended) |
| #134 | #136 | login rate limit behind nginx; tenant-scoped username bucket; IP on login audit |
| #124 | #137 | stampede lock on `GET /products` only |
| #121 | #135 | monitoring overlay wired into the Ansible deploy |
| #64 | #113 | etcd compose service + auth (brought up to `main` twice this round) |

**How it ran:** an orchestrator session sent one implementer agent per ticket (each in its own git worktree),
then one review agent per PR, then one fix agent per review. Only one agent at a time was allowed to run e2e
against the shared local database. **The review-fix commits were not reviewed a second time** — they are
covered by CI and by new tests that failed on the pre-fix head.

## 2. Before the next deploy (a person must do this)

Add to the `DEMO_ENV_FILE` GitHub secret, then re-run `provision.yml` so the VM `.env` is rewritten:
- `ETCD_ROOT_PASSWORD` — required by `docker-compose.yml` (`${ETCD_ROOT_PASSWORD:?}`) for the app, `etcd` and
  `etcd-init`. Only used at etcd's first bootstrap; changing it later needs 07 §8's procedure.
- `GRAFANA_ADMIN_PASSWORD` — required by `monitoring.yml`.

Use strong random values, not the `.env.example` dev values. Without them every `docker compose` step in
`deploy.yml` fails at interpolation, before anything changes. CI copies `.env.example`, so CI stays green.

## 3. What shipped and the rules it set

### Client IP (#133)
- `server/src/common/client-ip.ts`: `clientIp(req)` = rightmost `X-Forwarded-For` entry (string or `string[]`),
  falling back to `req.ip`; `toInet()` stores null for zone ids / invalid values.
- Used by both audit services and every controller that audits an IP (platform login/tenants/import, backup
  export, sale void — void used to store nginx's container address).
- Review found no defect. Gap: no controller-wiring test would catch a revert to leftmost.

### Login rate limit (#136)
- **The bug:** no `trust proxy`, so `req.ip` was nginx's address for every client — 10 bad logins a minute from
  anyone 429'd `POST /auth/token` for every shop; `auth:user:<username>` locked a name across all tenants.
- `app.setup.ts` sets `trust proxy` = 1 (**never** `true`). `07_CICD_DEPLOY.md` §9 records the one-hop
  assumption.
- Username bucket `auth:user:<tenant>:<username>`, tenant from the device token (tokenless backoffice logins use
  `-`, which is legitimate under ADR-0004 §3).
- `auth.login` / `auth.login_failed` rows carry `ip`.
- **Review fix:** the first cut moved the IP check after `createQueryRunner()/connect()` and the device lookup,
  so a locked-out IP still took a pool connection and an invalid token 401'd before any bucket. The IP check is
  back before `connect()`, and an invalid/retired token records an IP failure. A unit test pins the order.
- **#138 (open):** success resets the IP bucket (username spraying), check-then-increment is not atomic,
  `rate-limit.service.ts` key sanitisation makes equal-length Thai usernames collide, some failure reasons are
  not counted, and `auth.controller` should use `clientIp()`.

### Stampede lock (#137)
- Measured as `pos_app` on 5,000 products: guard status 0.008 ms, `byId` 0.026 ms, list count 1.0 ms,
  search count 6.9 ms. Lock only on `ProductsService.list` via `TenantCache.singleFlight`.
- `SET NX PX 5000` on `{key}:lock` (key includes the cache generation), compare-and-delete Lua release, waiters
  read immediately then poll every 5 ms up to 1 s, then query Postgres; any Redis error = no lock.
- **Review fixes:** release now in `finally` (a throwing loader used to hold the lock 5 s while waiters held
  pooled connections); first read before sleeping. README no longer claims an untested "six MISS" result.
- **Known limit:** no ioredis `commandTimeout`, so a hung-but-connected Redis stalls each extra command.

### Monitoring in the deploy (#135)
- `deploy.yml` adds `-f monitoring.yml` when `enable_monitoring` (default on), copies the overlay to
  `/opt/pos/`, sets `MONITORING_CONFIG_DIR=./deploy` (bind mounts used to resolve to `/opt/deploy/…`).
- **Review fixes:**
  1. `/health/ready` and `.current_sha` now run **before** monitoring; monitoring is in `block`/`rescue` and
     only warns — a slow Grafana used to fail a good API deploy (07 §6 step 9).
  2. Changed copied config → `up -d --force-recreate prometheus grafana` (an atomic-rename copy gives a new
     inode that a single-file bind mount never sees).
  3. Stale dashboards pruned (the fixer's first draft deleted and re-copied everything every run because `find`
     paths were resolved and `repo_root` was not — fixed with `realpath`).
  4. `enable_monitoring=false` runs `rm -sf node-exporter prometheus grafana`.
- Toggling the flag on a VM already on that SHA waits for the next release (the same-SHA early exit).
- **Not verified on the VM.** Checked with `ansible-playbook --syntax-check`, `ansible-lint` (9 warnings,
  unchanged), `docker compose config` in the repo and a simulated `/opt/pos` layout, and a localhost run of the
  prune/recreate tasks.

### etcd service (#113)
- Merged `main` into `feat/64-ops2-etcd` twice (no rebase, no force-push): once for #120's
  `runtime-config.service.ts` (main's version kept) and once after #135 for the 07 §1 table (etcd row from #113,
  monitoring row from `main`). `deploy.yml` auto-merged: the `etcd etcd-init` start step and the monitoring
  `compose_files` coexist.
- Verified after the second merge: `docker compose config -q` for base+dev and base+VM override+monitoring.
- #113 itself was not re-reviewed this round.

## 4. Traps met this round

- Rebuilding a branch that another agent worktree has checked out: branch locally under another name and
  `git push origin HEAD:<branch>`.
- `gh pr edit` fails on the deprecated Projects (classic) field — edit bodies with
  `gh api -X PATCH repos/NuimanLP/srisurart-pos-flutter/pulls/<n> -f body=…`.
- Merging several PRs that touch `07_CICD_DEPLOY.md` in sequence makes the last one conflict; re-check
  `mergeable` after each merge.
- `docker compose config` for the VM files needs `IMAGE_TAG` and `GRAFANA_ADMIN_PASSWORD` set.
- Running the whole stack from a second worktree fails: `docker-compose.yml` pins subnet `172.30.0.0/24`, which
  the shared dev stack already holds.
- Branch protection is still **not set** (`GET …/branches/main/protection` → 404). The owner runs 07 §4.
- Clean up `.claude/worktrees/agent-*` — this round left several.
