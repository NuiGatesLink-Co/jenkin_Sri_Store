# Handoff: owner's answers to #145 and #163

**Date:** 2026-09-15 · **Follows:** `docs/handoff_log/tx-migration-2026-09-15.md` · **PR:** #176 (closes #145, #163)

The project owner answered both open `question` issues in one session. The agent drafted each option; the owner
picked. No server behaviour changed; the only code change is the client's `ServerErrorResolver` mapping.

## 1. Decisions

### #145 — `SALE_NOT_IN_OPEN_SHIFT` wording

`บิลนี้ไม่ได้อยู่ในกะที่เปิดอยู่ ยกเลิกบิลไม่ได้ กรุณาทำรายการคืนสินค้า (ใบลดหนี้) แทน`

It is counter-facing, so it joins the 02 §8.1 list that still needs the shop staff's own read-through before real
use (with `DEVICE_ROLE_FORBIDDEN`, `TENANT_SUSPENDED`, `OFFLINE_NOT_ALLOWED`).

### #163 — device management

| # | Question | Decision |
|---|---|---|
| 1 | Who may enrol / retire | **`owner` only** — as shipped in #159; manager not added. ADR-0004 unchanged. |
| 2 | Enrolment code lifetime | **15 minutes, single use** — kept. The window runs from the owner pressing "add device" to typing the code in that browser; daily login never uses it. |
| 3 | Plaintext code in `idempotency_keys` | **Accepted.** Reading it needs DB access (Postgres is not published off the VM) or the owner's own `Idempotency-Key`; RolesGuard refuses anyone else before the replay. The code is dead after one use or 15 min. Replay keeps returning it, so a retry after a lost reply does not burn a `device_no`. |
| 4 | Thai wording | `POS_DEVICE_EXISTS` `ร้านมีเครื่องขายอยู่แล้ว 1 เครื่อง กรุณาปลดเครื่องขายเดิมก่อนเพิ่มเครื่องใหม่` · `DEVICE_NO_EXHAUSTED` `เพิ่มเครื่องไม่ได้ ร้านใช้เลขเครื่องครบ 99 เครื่องแล้ว` · `DEVICE_ALREADY_RETIRED` `เครื่องนี้ถูกปลดไปแล้ว` · `PHYSICAL_CASH_REQUIRED` `เครื่องนี้ยังมีกะเปิดอยู่ กรุณานับเงินในลิ้นชักและกรอกยอดก่อนปลดเครื่อง` — all owner-facing. Login **keeps one `เข้าสู่ระบบไม่สำเร็จ`** for every 401 (no username enumeration); `TENANT_SUSPENDED` / `RATE_LIMITED` keep their own messages. No code change — `AuthCubit.loginRefusalMessage` already does this. |
| 5 | Unbuilt device features | **Phase 2:** re-issuing a code for an existing device, editing a label, a client device-management screen. Until then a lost token = retire + enrol a new device. |

## 2. What changed

- `docs/Backend_design/02_API_SCREENS.md` — §8 and §8.1 rows for the five codes; the devices note no longer says
  "15 minutes awaiting the owner"; the counter-facing list and a dated note above the §8.1 table.
- `docs/Backend_design/adr/0004-device-roles.md` — *ยังไม่เคาะ*: owner-only, code lifetime, plaintext code and the
  phase-2 deferral ticked.
- `frontend/lib/core/network/server_error_resolver.dart` + `frontend/test/server_error_resolver_test.dart`.
  The previous `SALE_NOT_IN_OPEN_SHIFT` string (added by #83 without an owner decision) was replaced.
- `CLAUDE.md` — status lines.

## 3. Still open (not asked this round)

- ADR-0004: which device at the counter is the `pos` (shop's answer); does a device token expire; cap on
  `backoffice` devices.
- Every agent-drafted counter string in §8.1 still needs the shop staff to read it.
- No client screen calls the device endpoints yet, so the four device strings are unseen until phase 2.

## 4. Phase 1 leftovers before phase 2

- Owner: #67 (automatic deploy, needs go-ahead), branch protection on `main` (07 §4).
- Bugs: #169 (`idem.cleanup` deletes 0 rows under RLS — also means the enrolment codes above outlive 24 h),
  #173, #175.
- DoD in `03_ARCHITECTURE.md §8` is unticked: k6 against §9, import of a real shop snapshot through the
  §9 checklist, a first real deploy to the demo VM.
