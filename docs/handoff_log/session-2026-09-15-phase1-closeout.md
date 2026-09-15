# Handoff: phase-1 close-out session (2026-09-15)

**Owner:** NuimanLP (`team/1`) · **Parent:** #196 · continued on another machine.

Read this before picking up #184, #67, #185 or any phase-2 ticket.

---

## 1. Decided today (owner)

| Topic | Decision | Recorded in |
|---|---|---|
| #220 sale outcome unknown (timeout / 5xx) | **Outbox, not a cart lock.** Unanswered sales / returns / drawer entries go into a local queue and are sent on reconnect. Safe because a tenant has exactly **one `pos` device** (ADR-0004), so local stock and credit checks are valid. | `02_API_SCREENS.md §8.1` (PR #227) |
| Queued-bill text | `บันทึกการขายแล้ว รอส่งเข้าระบบ` | `02 §8.1`, #228 |
| Op rejected at push | persistent **red banner on Checkout** (banner text not chosen yet) | `02 §8.1`, #230 |
| #217 import cursor | option (a): stamp `clock_timestamp()` at import | PR #224 |
| #186 branch protection | set on `main`: PR required (0 approvals), `flutter-ci-status` + `server-ci-status` required, no force push / delete, admins not enforced | `07 §4` (PR #227) |
| #67 ownership | moved from PattaraponKitcharoen to NuimanLP | issue assignee |

#226 (cart lock) was filed and then closed as superseded by #228.

## 2. Merged today

PR #223 (#219) · #224 (#217) · #225 (#221) · #227 (#220 docs + protection) · #232 (CI image push fix + provision fixes).

## 3. Tickets filed today

- **#228 `q2.push`** — outbox for sales / returns / drawer + `POST /sync/push`
- **#229 `q2.catalogue`** — 18 offline write fallbacks in `frontend/lib/data/repositories/api_*.dart` create local-only rows that are **never uploaded** (products, categories, customers, mechanics, quotes, purchase orders; `receivePO` is the worst). Owner must decide per group: queue or refuse offline.
- **#230 `q3.reconcile`** — red banner + reconciliation screen (owner: banner text, who may discard)
- **#231 `q4.cutover`** — owner: production host, cutover day, rollback trigger

#196's checklist is current; "not ticketed yet" is empty.

## 4. 🔴 Findings

- **No release image was pushed to GHCR from #39 until PR #232.** `build-image` / `build-web` used a bare
  `if: github.ref == 'refs/heads/main'`; the implicit `success()` also requires every *ancestor* to have
  succeeded, and `changes` is skipped on push, so both jobs were skipped on every `main` push (checked 40
  runs back). The status jobs counted `skipped` as a pass, so CI stayed green. The GHCR `main` tag was stale.
  Fixed by checking each need's result explicitly, and the status job now fails if the image job did not
  succeed on a `main` push. The first `main` push after the merge is the proof.
- `provision.yml` wrote `arch=x86_64` into the Docker apt source (apt wants `amd64`) → `No package matching 'docker-ce'`. Fixed in #232.
- `ansible.cfg` `stdout_callback = yaml` was removed from community.general 12 → `default` + `callback_result_format = yaml`. Fixed in #232.
- Ansible from a non-interactive shell needs `</dev/null 2>&1 | cat` (it refuses non-blocking stdio).

## 5. #184 — first real demo deploy (in progress)

**VM:** `mob04` · `172.30.58.20` (campus-internal) · Ubuntu 26.04 · 4 vCPU / 6 GB / 48 GB · egress NAT `202.29.144.75`.
SSH alias `mob04` (user `cloud`, sudo) is in `~/.ssh/config` on the original Mac.

**Done:** `provision.yml` run (ok=14 failed=0): Docker 29.8 + compose v5.5.1, user `deploy`, ufw 22/80/443, `/opt/pos/.env` (0600).

**Secrets — on the original Mac only, never committed:**
- `~/.config/srisurart/demo.env` (0600) — strong random passwords + fresh RS256 JWT keypair
- `~/.config/srisurart/deploy_ed25519` — SSH key of the VM's `deploy` user

Copy both to the other machine securely (e.g. `scp` / a password manager), **not** through git or chat.
The VM already holds the env file at `/opt/pos/.env`, so a deploy only needs the deploy key.

**Deploy command** (from `deploy/ansible/`):
```bash
DEMO_SSH_HOST=172.30.58.20 DEMO_SSH_USER=deploy DEMO_SSH_KEY_PATH=~/.config/srisurart/deploy_ed25519 \
IMAGE_TAG=<full sha with both images on GHCR> ansible-playbook deploy.yml </dev/null 2>&1 | cat
```
Only reachable from the campus network (or a VPN into it).

**State when this was written (snapshot, a background agent was still working):**
- PR #232 merged; the first deploy attempt reached the VM: postgres, both redis and etcd are healthy, but
  `api-1` is in a **restart loop** and `.current_sha` is not written (deploy not finished, `/health/ready` not 200).
- **PR #233 (open)** — `fix(server): app containers get POSTGRES_PASSWORD + required JWT_PLATFORM_SECRET`.
  Likely cause of the restart loop: the app containers need env the compose file did not pass, and
  `JWT_PLATFORM_SECRET` is **not in `demo.env`** yet. Check #233's diff, add the variable to
  `~/.config/srisurart/demo.env` **and** `/opt/pos/.env` on the VM (strong random value, e.g.
  `openssl rand -hex 32`), get #233 green + merged, then deploy the new SHA.
- Then: rollback once (deploy the previous SHA, then the newest again), k6 per `02 §9` incl. 200 concurrent
  `POST /sales` on a 50-stock product, write the #184 handoff, tick `03 §8`, close #184.
- Diagnose with `ssh -i ~/.config/srisurart/deploy_ed25519 deploy@172.30.58.20 'cd /opt/pos && docker compose logs --tail 50 api-1'`.

## 6. #67 auto-deploy — blocked on network reachability

`.github/workflows/deploy.yml` still does not exist on `main` (`deploy/scripts/verify-ghcr-tags.sh` does).
**Blocker:** GitHub-hosted runners cannot reach `172.30.58.20`; it is a campus-internal address. `07 §5` says
the faculty confirmed inbound from outside, but no public address/port is recorded. The owner has to pick one:

1. a public IP/port forwarded to the VM's SSH (keeps ADR-0013's design: Actions → SSH → Ansible)
2. a **self-hosted runner on the VM** (outbound only, no open port) restricted to the `deploy` job and the
   `demo` environment — public repo, so it must never run PR workflows
3. Tailscale on the VM + runner (needs an account + auth key secret)

Option 2 or 3 changes ADR-0013's toolchain, so it needs an ADR-0013 addendum.

**Also still owner-side:** create the `demo` GitHub Environment (deployment branch = `main`) and its secrets.
The agent's secret-store write was blocked by the permission classifier, so run these yourself:
```bash
gh api -X PUT repos/NuimanLP/srisurart-pos-flutter/environments/demo
gh secret set DEMO_SSH_HOST --env demo --body <reachable address>
gh secret set DEMO_SSH_USER --env demo --body deploy
gh secret set DEMO_SSH_KEY  --env demo < ~/.config/srisurart/deploy_ed25519
gh secret set DEMO_ENV_FILE --env demo < ~/.config/srisurart/demo.env
```

## 7. Next steps, in order

1. Finish #184 (section 5).
2. Decide how Actions reaches the VM, then build #67 (section 6).
3. #185 once the shop provides a snapshot.
4. Phase 2: #228 → #229 → #212 / #211 / #189 → #230 → #190 → #231.
