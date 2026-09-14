# Handoff — #83 Error Resolver Heuristic & Missing Error Codes (2026-09-13)

**วันที่:** 2026-09-13 · **ผู้บันทึก:** PattaraponKitcharoen (`team/3` / Lane C) · **สถานะ:** เสร็จสมบูรณ์พร้อม Merge (Branch `feat/83-server-error-resolver`)
**ขอบเขต:** ปิด Ticket #83 — ปรับปรุง heuristic การตรวจจับข้อความภาษาไทยใน `ServerErrorResolver` ให้กระชับขึ้นด้วย `_startsWithThai` และเพิ่ม mapping สำหรับรหัสข้อผิดพลาดใหม่จาก idempotency, credit payments, voids และ shifts
**ต่อจาก:** [`ticket-37-p111-k6-loadtest.md`](ticket-37-p111-k6-loadtest.md) · [`fe3-api-writes.md`](fe3-api-writes.md) (ข้อ "Opened along the way")

---

## 1. ปัญหาเดิมและวิธีแก้ไข

1. **ปัญหา Heuristic `_containsThai` เดิม:**
   - เดิม `ServerErrorResolver.resolve` ตรวจว่าหาก `serverMessage` มีตัวอักษรภาษาไทยปนอยู่แม้แต่ตัวเดียว (`_containsThai`) จะคืนค่านั้นทันที
   - ส่งผลให้ error ภาษาอังกฤษของเซิร์ฟเวอร์ที่ยกคำไทยมาอ้างอิง เช่น `Refund method 'หักจากเครดิต' needs a bill with a mechanic.` (`returns.service.ts:209`) ถูกส่งต่อไปยังหน้าจอเคาน์เตอร์เป็นภาษาอังกฤษ แทนที่จะได้ข้อความไทยมาตรฐาน `วิธีคืนเงินไม่ถูกต้องสำหรับบิลนี้`
   - **การแก้ไข:** ปรับเป็น `_startsWithThai` (ตรวจว่าอักขระตัวแรกที่ไม่ใช่ whitespace/เครื่องหมายวรรคตอนอยู่ในช่วง Unicode ภาษาไทย `0x0E00..0x0E7F`) ทำให้ข้อความรายละเอียดภาษาไทยแท้ ๆ (`สต็อกไม่พอ:\n...`, `คืนเกินจำนวนที่ขาย:\n...`) ยังคงแสดงผลได้ครบถ้วน ขณะที่ข้อความอังกฤษที่มีการอ้างอิงคำไทยจะสลับไปใช้ `_canonicalMessages` อย่างถูกต้อง
2. **เพิ่ม Error Codes ที่ยังไม่ได้แมป (`_canonicalMessages`):**
   - Idempotency (#18):
     - `IDEMPOTENCY_KEY_REUSED`: `'คีย์การทำรายการซ้ำกับคำขออื่น'`
     - `IDEMPOTENCY_KEY_IN_FLIGHT`: `'คำขอก่อนหน้ากำลังดำเนินการ กรุณารอสักครู่'`
     - `IDEMPOTENCY_KEY_INVALID`: `'คีย์การทำรายการไม่ถูกต้อง'`
   - Document Numbers (#19):
     - `RECEIPT_NO_CONFLICT`: `'เลขที่ใบเสร็จซ้ำ กรุณาทำรายการใหม่'`
   - Credit Payments (#24):
     - `CREDIT_PAYMENT_EXCEEDS_BALANCE`: `'จำนวนเงินเกินยอดค้างชำระของช่าง'`
     - `CREDIT_PAYMENT_ID_REUSED`: `'รหัสการรับชำระเงินซ้ำ'`
   - Shifts & Voids (#94, #30):
     - `SALE_NOT_IN_OPEN_SHIFT`: `'บิลนี้ไม่ได้อยู่ในกะที่เปิดอยู่ ไม่สามารถยกเลิกได้ กรุณาออกใบลดหนี้แทน'`
     - `SHIFT_NOT_FOUND`: `'ไม่พบข้อมูลกะ'`

---

## 2. ผลการตรวจสอบและทดสอบ (Verification)

1. **`api_returns_repository_test.dart` (Line 462–476):**
   - ข้อความที่หน้าจอเคาน์เตอร์ได้รับจากการปฏิเสธวิธีคืนเงินเปลี่ยนจากอังกฤษเป็นข้อความไทย canonical:
     `expect(msg, 'วิธีคืนเงินไม่ถูกต้องสำหรับบิลนี้');` ผ่าน 100%
2. **`server_error_resolver_test.dart`:**
   - เพิ่มเคสทดสอบยืนยันว่า English message ที่มีคำไทยอ้างอิงจะไม่หลุดออกไป
   - ทดสอบ canonical error codes ใหม่ทั้งหมด ผ่าน 100%
3. **Full Flutter Test Suite:**
   - `flutter test`: ผ่านครบทั้ง **264 tests** (0 failed)
4. **Static Analysis:**
   - `dart analyze`: Clean (No issues found!)
5. **Web Build:**
   - `flutter build web --no-tree-shake-icons`: Build สำเร็จ (27.4s)
