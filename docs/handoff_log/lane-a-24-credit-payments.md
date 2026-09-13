# Handoff — #24 `p5.7` mechanic credit payments + สาย client (2026-09-13)

**วันที่:** 2026-09-12 → 13 · **ผู้บันทึก:** NuimanLP (`team/1`) · **สถานะ:** review รอบ 3 แก้ครบ (B1/M1/M2 + รับชำระออฟไลน์) · merge `origin/main` (#90 #91) เข้า branch แล้ว push + PR + merge
**ต่อจาก:** [`review-merge-fe3-84.md`](review-merge-fe3-84.md) ข้อ 6.1

## 1. ตอนนี้อยู่ตรงไหน

- Server: `POST /mechanics/:id/credit-payments` · migration `1788652800005` (`credit_payments.payment_method`, `.shift_id`, `idx_creditpay_shift`) · e2e **20/20** · unit 112 · lint/typecheck clean
- Client: `ApiMechanicsRepository.addCreditPayment` เป็น **outbox** (Drift schema **v5** `pending_credit_payments`) · หน้าจอช่างรับ 409 ได้ + banner รายการรอส่ง/ถูกปฏิเสธ · `dart analyze` clean · **247 tests**
- e2e ทั้งชุดบนเครื่องนี้แดง 2 เคสที่ **แดงที่ `main` อยู่แล้ว** (ยืนยันด้วย `git stash`): `sales` "200 concurrent bills" และ `shifts` "ten simultaneous opens" — ทั้งคู่คือ `pg-pool` *timeout exceeded when trying to connect* ใน `request-context.middleware.ts` (`DB_POOL_SIZE=8`) ของเดิมที่ `tx.*` ของ ADR-0003 จะแก้

## 2. ทำอะไรไป

1. Endpoint: lock ช่าง → (replay ด้วย client `id`) → เช็คจ่ายเกิน → เลข CP → `shift_id` → insert → `GREATEST(0, …)` → audit เมื่อยืนยันจ่ายเกิน
2. ตรวจ 3 แกนขนาน (Standards = Sonnet · Spec / Scrutinize = Opus) แล้วแก้ตามผล (ข้อ 3)
3. สาย client (ผู้ใช้สั่ง "แก้ client ในใบนี้เลย"): ส่ง `paymentMethod` + `id` + `Idempotency-Key`, parse ยอดคงเหลือแบบ string, dialog ช่างมี try/catch + ถามซ้ำด้วยตัวเลขของ server เมื่อได้ `409 CREDIT_PAYMENT_EXCEEDS_BALANCE`
4. Review รอบ 3 (Scrutinize/Spec = Opus · Standards = Sonnet) เจอ B1/M1/M2 → ผู้ใช้สั่งแก้ทั้งหมด **และให้รับชำระตอนออฟไลน์ได้** → เปลี่ยน `PendingWrites('cp')` (หน่วยความจำ) เป็น outbox ใน Drift:
   - กดรับชำระ → เขียนแถว (id + key + body) **ก่อน** ส่ง → server ตอบสำเร็จ: patch `credit_payments` + ยอด + ลบแถว ใน transaction เดียว
   - 4xx ขณะ dialog เปิด → ลบแถว แสดงข้อผิดพลาด (เหมือนเดิม) · ไม่มีเน็ต / 5xx / 429 / 401 / parse พัง → แถวค้าง + `CreditPaymentQueued` → dialog ปิดและบอกว่า "บันทึกไว้แล้ว ไม่ต้องกดซ้ำ"
   - flush เมื่อ `getMechanics` (เปิด/refresh หน้าช่าง) และปุ่ม "ส่งตอนนี้" · ส่งตามลำดับ หยุดที่ความล้มเหลวแรกที่ไม่ใช่ verdict
   - 4xx ขณะ flush → แถวเก็บไว้พร้อม `rejectedCode`/`rejectedMessage` ไม่ส่งซ้ำเอง · banner สีแดง → "ส่งอีกครั้ง (ยืนยันจ่ายเกิน)" (id เดิม key ใหม่) หรือ "ลบรายการ" (ลบได้เฉพาะแถวที่ถูกปฏิเสธ)

## 3. ตัดสินใจอะไร เพราะอะไร

| เรื่อง | เลือก | เหตุผล |
|---|---|---|
| จ่ายเกินยอดค้าง | **409 เว้นแต่ `allowOverpayment: true`** + audit row | AC สั่ง clamp — clamp บนยอดที่ไม่ได้ตรวจคือรูปเดียวกับบั๊กเงิน #22 · หน้าจอเดิมมี dialog ยืนยันอยู่แล้ว server แค่รับความยินยอมที่ถูก *ส่งมา* |
| `paymentMethod` | **บังคับ** whitelist `เงินสด` / `โอน/QR` | เดาวิธีจ่าย = รายงานปิดร้านผิดทุกวัน |
| คอลัมน์ใหม่ | nullable ไม่มี default | แถว import ไม่อยู่กะไหน และไม่รู้ว่าเป็นเงินสดไหม · import อ่าน `cp.method` ถ้ามี (snapshot ของ Drift ไม่มี → NULL — ทิศที่ปลอดภัยคือลิ้นชัก *เกิน*) |
| client `id` | **รับ (optional)** เป็นด่านกันซ้ำที่สอง | เหตุผลเดิม ("key หายหลังรีสตาร์ต แต่ id ไม่หาย") **ผิด** ในรอบแรก — ทั้งคู่อยู่ในหน่วยความจำ (M1) · ตอนนี้จริงแล้วเพราะ outbox เก็บทั้งคู่ลง Drift และ id คือด่านเดียวที่เหลือเมื่อ key หมดอายุ 24 ชม. (ออฟไลน์นาน) หรือเมื่อส่งใหม่ด้วย key ใหม่หลังยืนยันจ่ายเกิน · เช็ค replay **ก่อน** เช็คจ่ายเกิน ไม่งั้นการ replay การจ่ายเต็มจะเจอยอด 0 แล้วโดนปฏิเสธ |
| รับชำระตอนออฟไลน์ | **outbox ใน Drift** ไม่ใช่ fallback | fallback เดิมออกเลข CP เอง + ลดยอดเอง → ถ้าคำขอไม่ถึง server `syncFromServer` เขียนหนี้เต็มกลับทับ (เงินหาย) · ถ้า reply หาย แถวซ้ำที่ไม่มีใครลบ (B1) |
| แถวที่รอส่ง | **ไม่ลดยอดค้าง ไม่สร้างแถว `credit_payments`** จนกว่า server ตอบ | ADR-0010: ไม่ทำบัญชีสองชุด · ยอดที่หน้าจอยังสูงอยู่ แต่มี banner บอกยอดรอส่ง |
| 401 | **ไม่ใช่ verdict** (ต่างจาก `isVerdict`) | 401 = ไม่มีคน login ไม่ใช่คำตัดสินเรื่องการชำระ — ถ้านับเป็น verdict รายการที่รับเงินแล้วจะถูกทิ้ง |
| Lock order | คงไว้ mechanic → `doc_counters` แต่ **เอา 🔴 ออก** | Scrutinize พิสูจน์ว่า deadlock ที่คอมเมนต์เดิมอ้างเกิดไม่ได้ (`doc_counters` แยกแถวตาม `doc_type`) — 🔴 ที่กลไกเป็นไปไม่ได้ทำให้คนเลิกอ่าน 🔴 |
| CP ของ `backoffice` | ทำตาม AC5 (403) · บันทึกที่ **#13** | ADR-0007 จัด CP ไว้ "ทุกเครื่อง" ขัดกับ AC5/§4.2 — เป็นคำถามของ #13 ไม่ใช่ของ PR |
| AC3 | **ไม่ติ๊ก** จนกว่า #30 | ยังไม่มีโค้ดใดอ่าน `payment_method`/`shift_id` · เทสต์เปลี่ยนชื่อให้พูดตรง ๆ ว่าพิสูจน์แค่ว่า "ข้อมูลแยกได้" |

## 4. ทางตัน / กับดักเครื่องมือ

- **เขียนไฟล์ด้วย Python แบบ text mode ทำ CRLF → LF ทั้งไฟล์** (`01_DATABASE.md` diff 2,254 บรรทัดสำหรับของจริง 8 บรรทัด) — อ่าน/เขียนแบบ bytes แล้วคงชนิดบรรทัดเดิม
- **backslash ใน bash heredoc ถูกยุบ** (ซ้ำกับ handoff ก่อน) — script ที่มี `\n` ในสตริง Dart ให้เขียนเป็นไฟล์ด้วย Write tool แล้วรัน
- **`dart format` ทั้งไฟล์ reformat โค้ดเดิม** → เกิด lint `curly_braces_in_flow_control_structures` ในส่วนที่ไม่ใช่ของเรา — ต่อเฉพาะส่วนที่แก้เข้า `HEAD` แทน
- `api_repository_contract_test` ตรวจ guard แบบ **ตามบรรทัด**: บรรทัดก่อน `catch (_)` ต้องเป็น `rethrowServerRefusal(` และก่อนนั้นต้องเป็น `on ApiException catch` — ใส่คำสั่งอื่นคั่นไม่ได้ (เคยมี helper `_settle()` ไว้หลบกติกานี้ ถูกลบพร้อม fallback ในรอบแก้ B1 เพราะไม่มี `catch (_)` ให้ตรวจแล้ว)
- Docker Desktop ปิดข้ามคืน → e2e แดงทั้งไฟล์ด้วย `ECONNREFUSED 5432` ไม่ใช่โค้ด

## 5. ยังไม่พิสูจน์ / ค้าง

- **AC3** — ปิดได้เมื่อ #30 รวม `credit_payments WHERE shift_id = … AND payment_method = 'เงินสด'` เข้า expected cash (README *The cash drawer* มีบันทึกไว้แล้ว)
- ~~B1 transport failure ตกไป Drift · M1 id/key หายเมื่อรีสตาร์ต · M2 resend ไม่พก `allowOverpayment`~~ **แก้แล้วด้วย outbox (review รอบ 3)** — เทสต์ใน `api_mechanics_repository_test.dart`: `offline: … after a restart the flush sends the same id and key` (M1 + B1) · `a queued confirmed overpayment is replayed WITH allowOverpayment (M2)` · `a refusal during a flush is kept for a person…` · `a 401 during a flush is not a verdict…` · `schema_v4_migration_test` เพิ่มเคสไฟล์เก่าได้ตาราง v5 · mutation check: ลบบรรทัด `allowOverpayment` ใน `_send` → แดง 3 เคส
- ⚠️ **`shift_id` ของแถวที่ส่งช้า = กะที่เปิดอยู่ตอน server รับ** ไม่ใช่ตอนรับเงิน → ออฟไลน์ข้ามปิดกะ เงินสดไปโผล่กะถัดไป (#30 ต้องรู้ · server รับ `date`/กะจาก client ไม่ได้โดยตั้งใจ #28)
- ⚠️ **ลิ้นชักในเครื่อง (`cash_drawer_screen`) ไม่นับแถวที่รอส่ง** → ระหว่างออฟไลน์ ลิ้นชักจะดู *เกิน* เท่ายอดรอส่ง (ทิศที่ปลอดภัย) จนกว่าจะส่งสำเร็จ
- flush เกิดเฉพาะตอนเปิด/refresh หน้าช่างหรือกด "ส่งตอนนี้" — ไม่มี timer / connectivity listener · หลายเครื่องไม่ชนกันเพราะแต่ละเครื่องมี outbox ของตัวเอง
- snapshot export/restore ไม่แตะ `pending_credit_payments` (คิวของเครื่อง ไม่ใช่ข้อมูลร้าน)
- ถ้า reply สำเร็จแต่ parse พัง (บั๊กโค้ด) แถวจะค้างส่งซ้ำตลอด — server ตอบซ้ำด้วย id เดิม ไม่จ่ายซ้ำ แต่ banner จะค้าง
- **ไม่มี widget test ของ dialog ช่าง และของ banner/dialog รายการรอส่ง** — ทาง 409 → ถามซ้ำ → ส่งซ้ำ และ `CreditPaymentQueued` → ปิด dialog พิสูจน์ที่ repository (MockClient) + server e2e เท่านั้น
- `CREDIT_PAYMENT_EXCEEDS_BALANCE` / `CREDIT_PAYMENT_ID_REUSED` ยังไม่มี mapping ใน `ServerErrorResolver` (หน้าจอจับ code เองก่อนแสดง) — เกี่ยวกับ #83
- ถ้า client เคยได้ 409 ID_REUSED ข้อความอังกฤษจะขึ้นหน้าร้าน — `newId` ทำให้แทบเกิดไม่ได้

## 6. ก้าวถัดไป

1. ~~push + เปิด PR~~ → #24 เปิดไว้ด้วย AC3 (คอมเมนต์ใน issue ว่ารอ #30)
2. **#30 `p7.2`** — expected cash ต้องมีพจน์ credit payment · 🔴 รู้ว่าแถวที่ส่งช้าอาจตกกะถัดไป (ข้อ 5)
3. #13 — รอเจ้าของโปรเจกต์: CP เป็น pos-only จริงไหม (Spec review ชี้ว่า ADR-0007 พูดเรื่องใครออกเลข ไม่ใช่ role เครื่อง — อาจไม่ขัด AC5 เลย)
4. เจ้าของโปรเจกต์ยืนยันสองการตัดสินใจของ outbox: แถวรอส่งไม่ลดยอดค้าง · 401 ไม่ใช่ verdict
5. widget test ของ dialog รับชำระ + banner รายการรอส่ง
6. `sales`/`returns`/`shifts` ยังใช้ `PendingWrites` ในหน่วยความจำ — รีสตาร์ตหลัง 5xx = บิลซ้ำได้แบบเดียวกับ M1 (ยังไม่มี ticket)

## 7. อ้างอิง

- `server/src/mechanics/credit-payments.{service,dto}.ts` · `server/test/credit-payments.e2e-spec.ts` · `server/README.md` *Mechanic credit payments (#24)*
- `frontend/lib/data/repositories/api_mechanics_repository.dart` · `frontend/lib/presentation/screens/mechanics_screen.dart` `_PayCreditDialogState._submit`
- `02_API_SCREENS.md` §3.6 §8 §8.1 · `01_DATABASE.md` §5.3 · `CONTRACT.md` §4
