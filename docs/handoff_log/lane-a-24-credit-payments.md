# Handoff — #24 `p5.7` mechanic credit payments + สาย client (2026-09-13)

**วันที่:** 2026-09-12 → 13 · **ผู้บันทึก:** NuimanLP (`team/1`) · **สถานะ:** โค้ดเสร็จบน branch `feat/p5.7-credit-payments` — ยังไม่ push / ยังไม่เปิด PR
**ต่อจาก:** [`review-merge-fe3-84.md`](review-merge-fe3-84.md) ข้อ 6.1

## 1. ตอนนี้อยู่ตรงไหน

- Server: `POST /mechanics/:id/credit-payments` · migration `1788652800005` (`credit_payments.payment_method`, `.shift_id`, `idx_creditpay_shift`) · e2e **20/20** · unit 112 · lint/typecheck clean
- Client: `ApiMechanicsRepository.addCreditPayment` เขียนใหม่ · หน้าจอช่างรับ 409 ได้ · `dart analyze` clean · **243 tests**
- e2e ทั้งชุดบนเครื่องนี้แดง 2 เคสที่ **แดงที่ `main` อยู่แล้ว** (ยืนยันด้วย `git stash`): `sales` "200 concurrent bills" และ `shifts` "ten simultaneous opens" — ทั้งคู่คือ `pg-pool` *timeout exceeded when trying to connect* ใน `request-context.middleware.ts` (`DB_POOL_SIZE=8`) ของเดิมที่ `tx.*` ของ ADR-0003 จะแก้

## 2. ทำอะไรไป

1. Endpoint: lock ช่าง → (replay ด้วย client `id`) → เช็คจ่ายเกิน → เลข CP → `shift_id` → insert → `GREATEST(0, …)` → audit เมื่อยืนยันจ่ายเกิน
2. ตรวจ 3 แกนขนาน (Standards = Sonnet · Spec / Scrutinize = Opus) แล้วแก้ตามผล (ข้อ 3)
3. สาย client (ผู้ใช้สั่ง "แก้ client ในใบนี้เลย"): ส่ง `paymentMethod` + `id` + `Idempotency-Key` ผ่าน `PendingWrites('cp')`, parse ยอดคงเหลือแบบ string, patch นอก `try` (parse พังไม่ตกไป fallback), dialog ช่างมี try/catch + ถามซ้ำด้วยตัวเลขของ server เมื่อได้ `409 CREDIT_PAYMENT_EXCEEDS_BALANCE`

## 3. ตัดสินใจอะไร เพราะอะไร

| เรื่อง | เลือก | เหตุผล |
|---|---|---|
| จ่ายเกินยอดค้าง | **409 เว้นแต่ `allowOverpayment: true`** + audit row | AC สั่ง clamp — clamp บนยอดที่ไม่ได้ตรวจคือรูปเดียวกับบั๊กเงิน #22 · หน้าจอเดิมมี dialog ยืนยันอยู่แล้ว server แค่รับความยินยอมที่ถูก *ส่งมา* |
| `paymentMethod` | **บังคับ** whitelist `เงินสด` / `โอน/QR` | เดาวิธีจ่าย = รายงานปิดร้านผิดทุกวัน |
| คอลัมน์ใหม่ | nullable ไม่มี default | แถว import ไม่อยู่กะไหน และไม่รู้ว่าเป็นเงินสดไหม · import อ่าน `cp.method` ถ้ามี (snapshot ของ Drift ไม่มี → NULL — ทิศที่ปลอดภัยคือลิ้นชัก *เกิน*) |
| client `id` | **รับ (optional)** เป็นด่านกันซ้ำที่สอง | Scrutinize 🟠: key หายหลังแอปรีสตาร์ต = จ่ายบางส่วนซ้ำ ซึ่ง 409 จับไม่ได้ · เช็ค replay **ก่อน** เช็คจ่ายเกิน ไม่งั้นการ replay การจ่ายเต็มจะเจอยอด 0 แล้วโดนปฏิเสธ |
| Lock order | คงไว้ mechanic → `doc_counters` แต่ **เอา 🔴 ออก** | Scrutinize พิสูจน์ว่า deadlock ที่คอมเมนต์เดิมอ้างเกิดไม่ได้ (`doc_counters` แยกแถวตาม `doc_type`) — 🔴 ที่กลไกเป็นไปไม่ได้ทำให้คนเลิกอ่าน 🔴 |
| CP ของ `backoffice` | ทำตาม AC5 (403) · บันทึกที่ **#13** | ADR-0007 จัด CP ไว้ "ทุกเครื่อง" ขัดกับ AC5/§4.2 — เป็นคำถามของ #13 ไม่ใช่ของ PR |
| AC3 | **ไม่ติ๊ก** จนกว่า #30 | ยังไม่มีโค้ดใดอ่าน `payment_method`/`shift_id` · เทสต์เปลี่ยนชื่อให้พูดตรง ๆ ว่าพิสูจน์แค่ว่า "ข้อมูลแยกได้" |

## 4. ทางตัน / กับดักเครื่องมือ

- **เขียนไฟล์ด้วย Python แบบ text mode ทำ CRLF → LF ทั้งไฟล์** (`01_DATABASE.md` diff 2,254 บรรทัดสำหรับของจริง 8 บรรทัด) — อ่าน/เขียนแบบ bytes แล้วคงชนิดบรรทัดเดิม
- **backslash ใน bash heredoc ถูกยุบ** (ซ้ำกับ handoff ก่อน) — script ที่มี `\n` ในสตริง Dart ให้เขียนเป็นไฟล์ด้วย Write tool แล้วรัน
- **`dart format` ทั้งไฟล์ reformat โค้ดเดิม** → เกิด lint `curly_braces_in_flow_control_structures` ในส่วนที่ไม่ใช่ของเรา — ต่อเฉพาะส่วนที่แก้เข้า `HEAD` แทน
- `api_repository_contract_test` ตรวจ guard แบบ **ตามบรรทัด**: บรรทัดก่อน `catch (_)` ต้องเป็น `rethrowServerRefusal(` และก่อนนั้นต้องเป็น `on ApiException catch` — ใส่คำสั่งอื่นคั่นไม่ได้ จึงมี helper `_settle()` ที่ปิด attempt แล้วคืน exception
- Docker Desktop ปิดข้ามคืน → e2e แดงทั้งไฟล์ด้วย `ECONNREFUSED 5432` ไม่ใช่โค้ด

## 5. ยังไม่พิสูจน์ / ค้าง

- **AC3** — ปิดได้เมื่อ #30 รวม `credit_payments WHERE shift_id = … AND payment_method = 'เงินสด'` เข้า expected cash (README *The cash drawer* มีบันทึกไว้แล้ว)
- **transport failure หลังส่งคำขอไปแล้ว** ยังตกไป Drift ตามกติกาของ #55 → ถ้า server commit แต่ reply หาย เครื่องจะมีแถวชำระ local ซ้ำหนึ่งแถว (ยอดคงเหลือกลับมาถูกเมื่ออ่านรายชื่อช่างรอบถัดไป) — รับไว้ตามการตัดสินใจเฟส 1 ไม่ได้แก้
- **ไม่มี widget test ของ dialog ช่าง** — ทาง 409 → ถามซ้ำ → ส่งซ้ำ พิสูจน์ที่ repository (MockClient) + server e2e เท่านั้น
- `CREDIT_PAYMENT_EXCEEDS_BALANCE` / `CREDIT_PAYMENT_ID_REUSED` ยังไม่มี mapping ใน `ServerErrorResolver` (หน้าจอจับ code เองก่อนแสดง) — เกี่ยวกับ #83
- ถ้า client เคยได้ 409 ID_REUSED ข้อความอังกฤษจะขึ้นหน้าร้าน — `newId` ทำให้แทบเกิดไม่ได้

## 6. ก้าวถัดไป

1. push + เปิด PR (ปิด #24 ยกเว้น AC3 → ใส่คอมเมนต์ใน issue)
2. **#30 `p7.2`** — expected cash ต้องมีพจน์ credit payment
3. #13 — รอเจ้าของโปรเจกต์: CP เป็น pos-only จริงไหม

## 7. อ้างอิง

- `server/src/mechanics/credit-payments.{service,dto}.ts` · `server/test/credit-payments.e2e-spec.ts` · `server/README.md` *Mechanic credit payments (#24)*
- `frontend/lib/data/repositories/api_mechanics_repository.dart` · `frontend/lib/presentation/screens/mechanics_screen.dart` `_PayCreditDialogState._submit`
- `02_API_SCREENS.md` §3.6 §8 §8.1 · `01_DATABASE.md` §5.3 · `CONTRACT.md` §4
