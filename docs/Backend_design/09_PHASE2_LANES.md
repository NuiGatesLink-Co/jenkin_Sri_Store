# 09 — Phase 2: การแบ่ง lane และรายการ ticket

**สถานะ:** เจ้าของเคาะ 2026-09-16 · **ทาง C** (ผ่าฮับตามฝั่ง client/server) + ปรับตามความถนัดของทีม
**ต้นทาง:** [`08_PHASE2_SPEC.md`](08_PHASE2_SPEC.md) §16 · [`handoff_log/phase2-wayfinder-spec-2026-09-15.md`](../handoff_log/phase2-wayfinder-spec-2026-09-15.md) §5 · map [#243](https://github.com/NuimanLP/srisurart-pos-flutter/issues/243) · decisions [#240](https://github.com/NuimanLP/srisurart-pos-flutter/issues/240)

> ไฟล์นี้บอก **ใครทำอะไร ลำดับไหน และเส้นแบ่งอยู่ตรงไหน** · *อะไร* อยู่ที่ `08`
> **08 ชนะไฟล์นี้** ถ้าเนื้องานขัดกัน · ADR ชนะ 08

---

## 1. หลักการแบ่ง

| ข้อ | |
|---|---|
| **ไม่มีlaneรอlaneอื่น** | blocked-by ทุกเส้นอยู่ **ภายในlaneเดียวกัน** · ของข้ามlaneเป็น *contract* ไม่ใช่ *คิว* |
| **ผ่าฮับตามฝั่ง** | slice 8 (#228) เป็นศูนย์กลาง — ผ่าเป็น `8-client` / `8-server` แต่ละฝั่งสร้างของตัวเองเทียบ contract พร้อม fake ของอีกฝั่ง |
| **B = เครื่องยนต์ · C = server + หน้าจอ** | Lomer ถนัด code → outbox / SyncService / SW / เลข / PIN · Pattarapon ถนัด UI → server + **หน้าจอใหม่ทั้งหน้า** (เจ้าของระบุ 2026-09-16) |
| **ไม่แก้ไฟล์เดียวกัน** | §6 กำหนดเจ้าของไฟล์ · หน้าใหม่ทั้งหน้า = C · ปุ่ม/สถานะในหน้าเดิมที่ผูกกับ engine = B |
| **กติกาคอร์ส** | ทุกคนต้องแตะ frontend + backend + CI/CD → §2 คอลัมน์สุดท้าย |
| **integration ไม่ใช่ ticket ของใคร** | เกิดเองบน `main` เมื่อสองครึ่ง merge · พัง → เปิด bug ให้ฝั่งที่ผิด contract |

---

## 2. สรุป lane

| lane | คน | ถืออะไร | FE | BE | CI | ใบ |
|---|---|---|---|---|---|---|
| **A** `team/1` | NuimanLP | งานเบา ไม่มีใครรอ + **contract seam** + ข้อความไทย | 18, 0d | 24 | 18, 24 | **4** |
| **B** `team/2` | LomerAlloys | **ฝั่งเครื่อง (engine)** — PWA/SW, outbox, SyncService, เลข RC/CN, PIN, pull | ส่วนใหญ่ | 13a | 0a, 20-c | **14** |
| **C** `team/3` | PattaraponKitcharoen | **server + หน้าจอใหม่ + ops** | 16, 19, 21 | ส่วนใหญ่ | 20-s, 22, 23, 25 | **17** |

A เบาโดยตั้งใจ (เจ้าของสั่ง) · B/C หนักใกล้กัน

---

## 3. ตาราง ticket

`NEW` = ยังไม่มี issue · `แก้ AC` = issue เดิมมีเนื้อหา**ก่อน** spec ต้องเขียนใหม่ก่อนลงมือ
`บล็อกโดย` = **ในlaneเดียวกันเท่านั้น**

### lane A — `team/1` NuimanLP

| slice | ticket | เนื้อใน | บล็อกโดย |
|---|---|---|---|
| 0d | **NEW** `sync.seam` | สร้าง `frontend/lib/data/sync/sync_facade.dart` ตาม §4.2 — **abstract class + โมเดล + `FakeSyncFacade` ใน `frontend/test/support/`** ไม่มี logic · B กับ C เขียนโค้ดทาบตัวนี้ | – |
| 0c | **NEW** `copy.phase2` (F10) | ร่างข้อความไทย 2–3 แบบต่อข้อ (รายการใน `08 §18 Q1`) → เจ้าของเลือก → ลง `02 §8.1` · **ห้ามคิดคำเอง ต้องให้เจ้าของเลือก** | – |
| 18 | **NEW** `fe.drop-offlineok` | ลบ `Products.offlineOk` (`tables.dart:33`) → Drift **schema v7** + `onUpgrade` · แก้ `api_products_repository.dart:37,55`, `bootstrap_service.dart:188` · Postgres ไม่มีคอลัมน์นี้ (X1) · CI `build_runner` no-diff คือตัวตรวจ | – |
| 24 | **NEW** `sec.platform-allowlist` | `nginx.conf`: `/api/v1/platform/` เหลือ loopback + IP admin · เช็ค IP ซ้ำใน `PlatformAuthGuard` (กันคนที่ข้าม nginx) · `nginx -t` + e2e ใน `server.yml` | – |

### lane B — `team/2` LomerAlloys · ฝั่งเครื่อง

| slice | ticket | เนื้อใน | บล็อกโดย |
|---|---|---|---|
| 0a | #245 | asset skew: `sqlite3.wasm` 3.3.3 → 3.4.0, `drift_worker.js` 2.34.0 → 2.34.1 ให้ตรง `pubspec.lock` + assertion ใน `flutter.yml` | – |
| 0b | **NEW** `fe.fonts` | bundle Sarabun/Barlow เป็น asset · `GoogleFonts.config.allowRuntimeFetching = false` (flutter#163554) | – |
| 3 | **NEW** `pwa.1` | SW เขียนเอง (Workbox) · precache shell + `sqlite3.wasm` + `drift_worker.js` + CanvasKit ในเครื่อง · build `--no-web-resources-cdn` · cache = `github.sha` ลบของเก่าตอน activate · **ถามก่อนโหลดรุ่นใหม่ ห้าม `skipWaiting` อัตโนมัติ** · `storage.persist()` + บันทึก `persisted()` · Web Locks แท็บเดียว + หน้า "เปิดอยู่แล้ว" · `no-cache` ที่ `/sw.js` (`08 §4`) | 0a, 0b |
| 8-c | #228 **แก้ AC** (ครึ่ง client) | ตาราง `outbox_ops` (`08 §7`) · **แถวธุรกิจ + แถว outbox ใน local transaction เดียว** ห้ามเรียก transactional service ของ Drift · `SyncService` single-flight ส่งทีละคำขอ ≤50 op · state machine `08 §5` · นับ `attempts` เฉพาะผลที่ไม่ใช่คำตัดสิน → 3 = `stuck` · โซ่ `aggregates` ว่าใครรอใครไปต่อ (`08 §8.4`) · `outboxRemaining` ทุกคำขอ + push ว่างเมื่อค่าเปลี่ยน (C12) · **implements `SyncFacade`** | 3, 0d(soft) |
| 4-c | **NEW** `num.1-client` | เครื่อง `pos` ออก RC/CN จาก `DocCounters` (key `deviceId`, #188) · period = **นาฬิกาเครื่องเท่านั้น** · ขึ้นเดือนใหม่ออฟไลน์ = `0001` · `9999` → `DOC_NUMBER_EXHAUSTED` ไม่วนกลับ · เลขถูกใช้เมื่อ 2xx หรือเข้าคิว (C8) · migration ล้าง `doc_counter_seeds` ตอนอัปเกรด (C16) | – |
| 5 | #189 **แก้ AC** | ไม่มี seed marker (เพิ่ง enrol หรือเพิ่งอัปเกรด) → **ห้ามออกเลขออฟไลน์** ปฏิเสธก่อนเขียน/ก่อนพิมพ์ | 4-c |
| 9 | **NEW** `q2.cp` | ย้าย `pending_credit_payments` (#24) เข้า `outbox_ops` — ไม่มีแถวหาย, ธนาคารเดิมของ #24 ยังทำงาน | 8-c |
| 10 | #211 **แก้ AC** | PIN ออฟไลน์ 1 อันต่อเครื่อง `pos` · hash ช้าผูกเครื่องใน Drift **ไม่ส่งขึ้น server** · อายุ **3 วัน** นับจาก `iat` ของ `/auth/token` ครั้งล่าสุด (refresh ไม่นับ) **ตรวจที่เครื่องเท่านั้น** · Degraded เท่านั้น · ผิด 5 ครั้งล็อกในแอป · หน้าตั้ง PIN พิมพ์รหัสผ่านซ้ำ เทียบในหน่วยความจำแล้วล้าง (C4) · ⚠️ ticket เดิมเขียน 7 วัน + `cashier` — ผิด | 8-c |
| 11-c | **NEW** `q2.void-client` | ปุ่ม void ออฟไลน์ขึ้น**เฉพาะบิล `soldOffline`** + ช่องเหตุผลบังคับ → op `sale.void_offline` · Drift `Sales.soldOffline` | 8-c |
| 12 | #229 **แก้ AC** | `customer.create` / `customer.update` เข้าคิว · ปุ่มของ `08 §6.2` ปิดตอน Degraded · พักบิลอยู่ในเครื่องไม่ sync · **ลบ fallback `super.<write>()` ทั้ง 16 จุดใน `api_*.dart`** | 8-c |
| 13a | #212 (ส่วน A) **แก้ AC** | **BE:** keyset + `meta.nextCursor` ให้ `customers` / `mechanics` (วันนี้ `updated_at > $x` + OFFSET, `customers.service.ts:93`) — แบบเดียวกับ products #16 | – |
| 13b | #212 (ส่วน B) **แก้ AC** | `sync_cursors` ต่อ entity เก็บ cursor **ของ server** (ห้ามคำนวณจาก `MAX(updatedAt)` ในเครื่อง) · หน้าแรกของรอบถอย **30 วินาที** และ **ไม่ส่ง `afterId`** · pull ไม่เขียนทับ stock ของสินค้าที่ยังมี op ค้าง · tombstone รวม `import-tombstone` ห้ามโผล่ในรายการเลือก · ⚠️ ticket เดิมเขียน 5 วินาที — ผิด | 8-c, 13a |
| 14-c | #194 (ครึ่ง client) **แก้ AC** | override วงเงินตอนออฟไลน์ = `overrideCreditLimit` ใน payload ของ `sale.create` (ไม่มี dialog ใหม่, ไม่เดาความยินยอม — กติกา #84) | 8-c |
| 20-c | #193 (ครึ่ง client) **แก้ AC** | contract test ใน `flutter.yml`: รัน `SyncService` กับ **fake server ที่อ่าน fixture §4.1** ครบทุกผล (`applied` / `rejected` / `retry` / หัวคิวติด → `stuck`) | 8-c |

### lane C — `team/3` PattaraponKitcharoen · server + หน้าจอ + ops

| slice | ticket | เนื้อใน | บล็อกโดย |
|---|---|---|---|
| 1 | **NEW** `role.1` | migration ทุกแถว → `owner` + CHECK · `uq_users_one_active` (เก็บ owner แถวเก่าสุด active) · ลบ `requireManager` 21 จุด (`products` 4, `catalogue` 5, `mechanics` 3, `purchase-orders` 4, `purchasing` 3, `settings` 1, `quotes` 1) · void = **เหตุผลบังคับ ไม่มี PIN** (ลบ `authorise` + argon2 + `consumeAttempt` ใน `void.service.ts`) · ลบ `users.pin_hash` · แก้ fixture ~46 ไฟล์ (`08 §3`) | – |
| 2 | **NEW** `sec.device-gate` | retire / enrol / export ต้องมี `did` ใน JWT → ไม่มี = `403 DEVICE_ROLE_FORBIDDEN` (`devices.controller.ts:116`, `backup.controller.ts:54,91`) | 1 |
| 4-s | **NEW** `num.1-server` | รับเลขจาก client · ตรวจ prefix ตรง type + `device_no` ตรง `did` + ช่วง 0001–9999 → `400 DOC_NUMBER_INVALID` · **ไม่ตรวจ period** · upsert high-water `GREATEST` · flag `DOC_NUMBER_FALLBACK` + header `X-Client-Version` (C16) · ปิด fallback = body ไม่มีเลข → `400 DOC_NUMBER_REQUIRED` | – |
| 6 | **NEW** `review.1` | ตาราง `owner_review_items` (`kind`, `ref_id`, `details`, `reviewed_at`) · `GET /review-items?status=pending` · `POST /review-items/:id/reviewed` (idempotent, เขียน `audit_log`, **ไม่แตะเงิน/สต็อก**) · 5 kind: `void_offline` `credit_override` `shift_uncounted` `date_flag` `device_force_retired` | – |
| 7 | **NEW** `shift.multi` | หลายกะต่อวัน · `POST /shifts/open` รับ `{id, startingCash, openedAt}` · id เดิม = คืนกะเดิมไม่ archive · มี active อื่น → archive (`auto_archived`) + `shift_uncounted` · `date_str` จาก `opened_at` ตาม `tenants.timezone` · **ลบ "active วันเดียวกัน → คืนกะเดิม" + `today()`** (`shifts.service.ts:160-176`) · กะ import ไม่สร้างรายการตรวจ | 6 |
| 8-s | #228 **แก้ AC** (ครึ่ง server) | `POST /sync/push` (`08 §8`): `X-Device-Token` (`drole=pos`) เป็น endpoint เดียวที่รับ device token · **ผู้กระทำ = user `is_active` คนเดียวของ tenant** ไม่เจอ = 403 ทั้งคำขอ · ขั้น replay key → replay client id → `CLIENT_ID_REUSED` → service ตัวเดิม · **`runTx` ทีละ op ห้าม `Promise.all` (#162) ห้ามรวมทั้ง batch** · หยุดที่ผลแรกที่ไม่ใช่คำตัดสิน (B3) · lock order เดิม บิล → `shifts FOR SHARE` → ช่าง → สินค้า → `doc_counters` → ลูกค้า · `sold_offline` (C3) + วันที่ `08 §10` + `date_flag` · `devices.unsynced_ops` + `unsynced_reported_at` · **เพิ่ม client id ให้ `shifts` / `returns` / `drawer_entries` / `customers`** · log redact `X-Device-Token` | 4-s, 6, 7 |
| 11-s | **NEW** `q2.void-server` | `sales.void_reason TEXT` + `sales.sold_offline BOOLEAN NOT NULL DEFAULT false` · op `sale.void_offline` (บิลในกะที่เปิดอยู่ ณ ลำดับนั้น) · บิลออนไลน์ → `rejected VOID_NEEDS_ONLINE` · void สำเร็จ → รายการตรวจ | 1, 8-s |
| 14-s | #194 (ครึ่ง server) **แก้ AC** | override มาทาง push → รายการตรวจ `credit_override` + `audit_log` **แถวเดียว** | 6, 8-s |
| 15 | #190 **แก้ AC** | เลขชน UNIQUE บน push → `rejected RECEIPT_NO_CONFLICT` **ห้ามขยับเลข** (ทางออนไลน์ที่ยังไม่พิมพ์ยังขยับได้) · ตรวจ **หลัง** replay (B1/B2) | 4-s, 8-s |
| 17 | **NEW** `dev.retire-guard` | `devices.unsynced_ops > 0` → `409 DEVICE_HAS_UNSYNCED_OPS` `details {unsyncedOps, reportedAt}` · `{force:true, note}` → retire + รายการตรวจ `device_force_retired` · ไม่มี note = 400 | 2, 6, 8-s |
| 16 | #230 **แก้ AC** (FE) | **หน้า "รอ owner" ทั้งหน้า** 2 แท็บ (`08 §14`) — แท็บ "ถูกปฏิเสธ/ค้าง" อ่านผ่าน **`SyncFacade` (§4.2) ไม่แตะ `outbox_ops` ตรง ๆ** · แท็บ "รอตรวจ" อ่าน `GET /review-items` ของตัวเอง · ปุ่มส่งใหม่ (key เดิม **ห้ามเปลี่ยนเลข**) · ทิ้ง = ออนไลน์ + หมายเหตุบังคับ → `POST /sync/discards` + `serverHasRow` · ป้ายนับใน `app_shell.dart` · **ทดสอบกับ `FakeSyncFacade`** | 6, 8-s |
| 19 | #195 **แก้ AC** (FE) | แถบสถานะ Online / Degraded / Syncing (อ่านจาก `SyncFacade`) + ป้าย "มีรายการรอ owner" · คู่มือร้าน รวมวิธีคีย์บิลใหม่มือเมื่อ storage หาย — **ได้เลขใหม่ ไม่ใช่เลขบนใบเดิม เขียนเลขเดิมในหมายเหตุ** (X7) · ⚠️ ticket เดิมเขียน "ป้ายเทาขายออฟไลน์ไม่ได้" — **ตัดทิ้ง** (ไม่มี `offlineOk` แล้ว) | 16, **0c ของ lane A (soft)** |
| 21 | #192 **แก้ AC** (FE) | หน้าจัดการเครื่อง (รายการ, enrol, retire, สถานะ op ค้าง) · **re-enrol = `device_no` ใหม่เสมอ** · ⚠️ ticket เดิมเสนอ "ออกโค้ดใหม่คงเลขเดิม" ขัด F8 — ตัดทิ้ง · แก้ป้ายชื่อเครื่อง = เฟสถัดไป | 2, 4-s |
| 20-s | #193 (ครึ่ง server) **แก้ AC** | e2e `/sync/push` จาก fixture §4.1 ใน `server.yml`: B1 (บิล commit แล้วตอบหาย → `applied` + `audit_log` แถวเดียว) · B2 (ลบ `idempotency_keys` แล้ว push ทุก type → `applied` เงิน/สต็อกไม่ขยับซ้ำ) · B3 (op N ติด → N+1 `retry` ไม่ประมวลผล) · ไม่มี user active = 403 · `idempotency-routes.spec.ts` ครอบ `/sync/push` | 8-s |
| 22 | #184 | deploy `mob04` + วัด RSS ต่อ container **ขณะมีโหลด** (เพดาน 6 GB) · k6 หลายเครื่อง `SHARD=i/N` ตาม #257 | – |
| 23 | **NEW** `ops.backup` | `pg_dump --create` รายวันส่งออกนอก VM + ซ้อม restore 1 ครั้ง · `--create` พา `ALTER ROLE pos_app IN DATABASE … SET` (#213) มาด้วย — `pg_dumpall --roles-only` ไม่พา · หลัง restore `DbModule` ต้องไม่เตือน | 22 |
| 25 | #67 (ใบใหม่ `cd.2-run`) | ติดตั้ง self-hosted runner + job-started hook + `pos-deploy` wrapper บน `mob04` ตาม `07 §6.2` แล้ว**พิสูจน์ AC ด้วย run จริง** (push `main` → `.current_sha` ใหม่ · job จาก branch อื่น/fork ถูกปฏิเสธ · playbook fail → rollback อัตโนมัติ run ยังแดง) | 22 |

---

## 4. Contract ระหว่าง lane

มี **2 เส้น** เท่านั้น ที่เหลือคือไฟล์ของใครของมัน

### 4.1 เส้น B ↔ C — wire ของ `/sync/push`

- **ข้อกำหนด:** `08 §6` (op catalogue), `§7` (outbox), `§8` (รูปคำขอ/คำตอบ), `§9` (เลข), `§10` (วันที่)
- **fixture:** `docs/Backend_design/fixtures/sync-push/` — ไฟล์ละ op type + ทุกผลลัพธ์

| ไฟล์ | มีอะไร |
|---|---|
| `sale-create.applied.json` · `sale-create.rejected-stock.json` · `sale-create.replay-by-key.json` · `sale-create.replay-by-id.json` · `sale-create.client-id-reused.json` | `sale.create` |
| `return-create.applied.json` · `return-create.rejected-price.json` | `return.create` |
| `drawer-entry.applied.json` · `shift-open.applied.json` · `shift-open.archived-previous.json` | ลิ้นชัก + กะ |
| `credit-payment.applied.json` · `credit-payment.rejected-overpayment.json` | ชำระเครดิต |
| `customer-create.applied.json` · `customer-update.applied.json` | ลูกค้า |
| `sale-void-offline.applied.json` · `sale-void-offline.rejected-online-bill.json` | void ออฟไลน์ |
| `batch.stop-at-retry.json` · `batch.no-active-user-403.json` | ระดับ batch (B3, C13) |

- **เจ้าของ:** lane C เขียนใน PR แรกของ `8-s` · **soft** — lane B เริ่มจากตัวอย่างใน `08 §8.2` ได้เลย แล้วสลับมาอ่าน fixture เมื่อมี
- 🔴 **ใครแก้ fixture ต้องแก้ `08` ใน PR เดียวกัน** · ทั้งสองฝั่งต้องมี contract test ที่อ่าน fixture ชุดนี้ (20-c / 20-s)

### 4.2 เส้น B ↔ C — `SyncFacade` (ในเครื่อง)

lane C เขียนหน้าจอ **ห้ามแตะ `outbox_ops` หรือ `SyncService` ตรง ๆ** — คุยผ่าน interface นี้เท่านั้น
ไฟล์ `frontend/lib/data/sync/sync_facade.dart` · lane A ส่งใน slice `0d` (abstract + fake, ไม่มี logic) · lane B `implements` ใน `8-c`

```dart
enum SyncStatus { online, degraded, syncing }

enum OutboxOpStatus { pending, stuck, rejected }

class OutboxOpView {
  final String opId;
  final String type;          // 'sale.create' …
  final OutboxOpStatus status;
  final int attempts;
  final String? lastCode;     // เช่น 'INSUFFICIENT_STOCK'
  final String? lastMessage;  // ข้อความไทยที่ผ่าน ServerErrorResolver แล้ว
  final Map<String, dynamic>? lastDetails;
  final String? docNo;        // เลขที่พิมพ์ไปแล้ว (ถ้ามี)
  final DateTime createdAt;
}

class DiscardResult {
  final bool serverHasRow;    // true = client ไม่ลบแถว ดึงของ server มาทับ (C15)
}

abstract class SyncFacade {
  Stream<SyncStatus> get status;
  Stream<List<OutboxOpView>> get needsOwner;   // rejected + stuck
  Stream<int> get outboxRemaining;
  Future<void> resend(String opId);            // attempts = 0, key เดิม, ห้ามเปลี่ยนเลข
  Future<DiscardResult> discard(String opId, String note);
}
```

- ⏳ **soft:** ถ้า `0d` ยังไม่ merge ให้ copy จาก block นี้ไว้ในlaneตัวเองก่อน แล้วลบทิ้งตอน `0d` ลง
- 🔴 เพิ่ม/แก้ method = แก้ไฟล์นี้ใน PR เดียวกัน

---

## 5. slice ที่ถูกผ่า — เส้นแบ่ง

| slice | ครึ่ง client (B) | ครึ่ง server (C) | ทดสอบกับอะไร |
|---|---|---|---|
| 4 `num.1` | ออกเลข, period จากนาฬิกาเครื่อง, marker, `9999` | ตรวจรูปเลข + `device_no`, upsert high-water, `DOC_NUMBER_FALLBACK` | B: unit + fake server · C: e2e ยิงเลขที่ client จะส่ง |
| 8 `#228` | `outbox_ops`, `SyncService`, สถานะ, `stuck`, `outboxRemaining` | `/sync/push`, replay, ผู้กระทำ, วันที่, `sold_offline`, `unsynced_ops` | B: fake server จาก fixture · C: e2e จาก fixture |
| 11 `q2.void` | ปุ่ม + เหตุผล + op | คอลัมน์, `VOID_NEEDS_ONLINE`, รายการตรวจ | เหมือนกัน |
| 14 `#194` | `overrideCreditLimit` ใน payload | `credit_override` + `audit_log` | เหมือนกัน |
| 20 `#193` | contract test ใน `flutter.yml` | e2e push ใน `server.yml` | fixture ชุดเดียวกัน |

🔴 **AC ของทุกใบทดสอบกับ fake/fixture เท่านั้น** — ห้ามเขียน AC ว่า "ใช้ได้กับของจริง" เพราะอีกครึ่งยังไม่ merge

---

## 6. เจ้าของไฟล์ (กันตีกัน)

| lane | แตะได้ |
|---|---|
| **A** | `frontend/lib/data/db/tables.dart` (ลบ `offlineOk`) · `frontend/lib/data/sync/sync_facade.dart` (0d) · `frontend/test/support/fake_sync_facade.dart` · `server/docker/nginx/nginx.conf` · `server/src/platform/*guard*` · `docs/Backend_design/02_API_SCREENS.md §8.1` |
| **B** | `frontend/lib/data/sync/**` (impl) · `frontend/lib/data/db/**` (ตาราง outbox, cursor, schema) · `frontend/lib/data/repositories/**` · `frontend/lib/data/services/**` · `frontend/lib/core/**` · `frontend/web/**` (SW, ฟอนต์, asset) · หน้าจอ**เดิม**ที่ผูก engine: `checkout_` `returns_` `cash_drawer_` `mechanics_` `login_screen.dart` · `server/src/customers`, `server/src/mechanics` (13a เท่านั้น) |
| **C** | `server/src/**` (ยกเว้นของ A/B ข้างบน) · `server/test/**` · `frontend/lib/presentation/screens/` **หน้าใหม่** (`owner_review_screen.dart`, `devices_screen.dart`) · `frontend/lib/presentation/widgets/app_shell.dart` (แถบสถานะ + ป้าย) · `deploy/**` · `.github/workflows/deploy.yml` · `docs/Backend_design/fixtures/**` |

ทับกันจริง ๆ มีจุดเดียว: `frontend/lib/core/router/app_router.dart` (C เพิ่ม 2 route ใหม่) — เพิ่มบรรทัด ไม่แก้ของเดิม

---

## 7. ลำดับที่แนะนำ (เส้นทางวิกฤต)

```
A:  0d ──► 0c ──► 18 ──► 24                    (0d ก่อน เพราะ B/C รอใช้แบบ soft)

B:  0a,0b ──► 3 ──► 8-c ──┬─► 9
                          ├─► 10
                          ├─► 11-c
                          ├─► 12
                          ├─► 14-c
                          ├─► 20-c
                          └─► 13b   (13a เดินขนานได้ตั้งแต่วันแรก)
    4-c ──► 5                                   (ขนานกับทั้งเส้น)

C:  1 ──► 2 ──┐
    4-s ──────┼─► 8-s ──┬─► 11-s ─► 14-s ─► 15 ─► 17
    6 ──► 7 ──┘         ├─► 16 ──► 19
                        └─► 20-s
    21 (หลัง 2, 4-s)
    22 ──► 23, 25                                (ops เดินขนานได้ตั้งแต่วันแรก)
```

**เริ่มพร้อมกันได้วันแรก:** A `0d` · B `0a`+`0b`+`4-c`+`13a` · C `1`+`4-s`+`6`+`22`

---

## 8. พิมพ์ `/to-tickets` ยังไง

`/to-tickets` เป็น skill ที่ **เจ้าของต้องพิมพ์เอง** (ตั้ง `disable-model-invocation`) ข้อความที่แนะนำ:

```
/to-tickets  ใช้ docs/Backend_design/09_PHASE2_LANES.md §3 เป็นรายการ ticket
  - ticket NEW: เปิดใหม่ตามชื่อใน §3
  - ticket เดิมที่ทำเครื่องหมาย "แก้ AC": #189 #190 #192 #193 #194 #195 #211 #212 #228 #229 #230 #245
    เขียน AC ใหม่ให้ตรง 08 ก่อน (ของเดิมเป็นเนื้อหาก่อน spec)
  - #212 และ #228 ผ่าเป็นสองใบ (-client / -server) คนละ lane
  - ทุกใบเป็น sub-issue ของ #243 · blocked-by เฉพาะภายใน lane ตาม §3
  - ป้าย team/1 = lane A, team/2 = lane B, team/3 = lane C
  - #67 เปิดใบใหม่ (ของเดิมปิดไปแล้วตอน merge PR #237)
```

**ticket เดิมที่ต้องเขียน AC ใหม่ก่อนลงมือ** (เนื้อหาก่อน spec — ผิดจริง ไม่ใช่แค่เก่า):

| # | ของเดิมผิดตรงไหน |
|---|---|
| #211 | PIN 7 วัน + role `cashier` + server ตรวจซ้ำ → 3 วัน, บัญชีร้าน, **เครื่องตรวจเท่านั้น** |
| #212 | rewind 5 วินาที + `offlineOk` → **30 วินาที** + ไม่มี `offlineOk` + ผ่าเป็น 13a/13b |
| #195 | ป้ายเทา "ขายออฟไลน์ไม่ได้" → ตัดทิ้ง เหลือแถบสถานะ + คู่มือ |
| #192 | "ออกโค้ดใหม่คงเลข `device_no` เดิม" → **`device_no` ใหม่เสมอ** |
| #228 | ไม่มี F2/F3/C12/C13 → เพิ่ม stuck head, ผู้กระทำ, `outboxRemaining` |
| #229 #230 #189 #190 #193 #194 | ตรวจคำต่อคำกับ `08` ก่อนลงมือ |

---

## 9. ความเสี่ยงที่ยอมรับ

| | |
|---|---|
| contract drift ระหว่างสองครึ่ง | กันด้วย fixture ชุดเดียว (§4.1) + `SyncFacade` (§4.2) + contract test ทั้งสองฝั่ง (20-c / 20-s) |
| A เบากว่า B/C มาก | เจ้าของตั้งใจ · A ยังครบ FE+BE+CI ตามกติกาคอร์ส |
| C หนักสุด (17 ใบ) | ~6 ใบเป็น ops/CI ที่เดินขนานได้ และ 3 ใบเป็น UI ที่ถนัด |
| 19 รอ 0c ข้ามlane | **soft** — เขียนหน้าด้วย placeholder ได้ เปลี่ยนข้อความทีหลัง |

---

**ก่อนหน้า:** [`08_PHASE2_SPEC.md`](08_PHASE2_SPEC.md) · **map:** [#243](https://github.com/NuimanLP/srisurart-pos-flutter/issues/243)
