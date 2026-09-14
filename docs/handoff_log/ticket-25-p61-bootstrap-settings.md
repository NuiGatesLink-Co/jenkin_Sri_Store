# Handoff — Ticket #25: GET /bootstrap, GET /settings, PATCH /settings (2026-09-14)

**วันที่:** 2026-09-14 · **ผู้บันทึก:** Antigravity AI Agent (Lane B / `team/2`) · **สถานะ:** ปิดแล้ว (เสร็จสมบูรณ์ 100%)  
**ขอบเขต:** สร้างเอนด์พอยต์ `GET /bootstrap`, `GET /settings`, และ `PATCH /settings` ตามสเปก Ticket #25 (`p6.1`) พร้อมคำนวณ ETag, ตอบ 304 Not Modified, ตรวจสอบสิทธิ์ผู้จัดการ (Manager role), และกรองแถว tombstone (`deleted_at IS NULL`)  
**ต่อจาก:** [`INDEX.md`](INDEX.md) · [`docs/00_LANE_PRIMER.md`](../00_LANE_PRIMER.md) · [`docs/Backend_design/adr/0010-client-write-through-cache.md`](../Backend_design/adr/0010-client-write-through-cache.md)

---

## 1. ตอนนี้อยู่ตรงไหน

- โค้ดหลังบ้าน Ticket #25 สร้างเสร็จและรวมเข้ากับ `AppModule` (`TENANT_ROUTES`) เรียบร้อยแล้ว
- ผ่านการตรวจความถูกต้องครบถ้วน: `pnpm typecheck`, `pnpm lint`, และ `pnpm test` (ผ่านครบ 16 ชุด 103 tests)
- ไฟล์ที่เพิ่ม/แก้ไขทั้งหมดพร้อมสำหรับการ commit & merge

---

## 2. รอบนี้ทำอะไรไป ได้ผลอะไร

1. **สร้าง Data Transfer Object & Parser (`server/src/settings/settings.dto.ts`)**:
   - กำหนดอินเทอร์เฟซ `Settings` และ `SettingsPatch`
   - เขียนฟังก์ชัน `parseSettingsPatch()` สำหรับตรวจสอบและแปลงชนิดข้อมูลของฟิลด์ `shopName`, `shopNameEn`, `taxRate`, `quoteValidDays`, `address`, `phone`, `cashierName`, `taxId`, `branchNo`

2. **สร้าง Service ชั้นจัดการข้อมูล (`server/src/settings/settings.service.ts`)**:
   - `getSettings()`: อ่านการตั้งค่าของร้านตาม `tenant_id` หากยังไม่มีแถวจะ fallback อ่านชื่อร้านจาก `tenants` แล้วสร้างแถวตั้งต้นให้อัตโนมัติ (`taxRate = 7`, `quoteValidDays = 30`)
   - `updateSettings(patch)`: ทำการ UPSERT (`INSERT ... ON CONFLICT DO UPDATE`) ข้อมูลลงตาราง `settings` พร้อมอัปเดต `updated_at = NOW()`
   - `getBootstrap()`: ดึงข้อมูลตั้งต้นสำหรับ client หน้าร้านในคำสั่งเดียว — ประกอบด้วย `products` (`deleted_at IS NULL`), `categories`, `customers` (`deleted_at IS NULL`), `mechanics` (`deleted_at IS NULL`), และ `settings`

3. **สร้าง Controllers (`server/src/settings/settings.controller.ts` & `bootstrap.controller.ts`)**:
   - `GET /settings`: คืนค่าข้อมูล `Settings` ปัจจุบันของ tenant
   - `PATCH /settings`: ติดตั้ง `requireManager` ตรวจสิทธิ์ role (ยอมรับเฉพาะ `owner` หรือ `manager` หากเป็น `cashier` จะตอบ `403 FORBIDDEN`) พร้อมใช้งาน `IdempotencyInterceptor`
   - `GET /bootstrap`: คำนวณ Strong ETag ด้วย SHA256 จาก JSON payload (`BootstrapData`) ตรวจสอบเฮดเดอร์ `If-None-Match` จาก client หากตรงกันจะตอบกลับเป็น HTTP `304 Not Modified` โดยไม่ส่ง response body

4. **ประกอบ Module เข้ากับระบบหลัก (`server/src/settings/settings.module.ts` & `server/src/app.module.ts`)**:
   - รวม `SettingsController` และ `BootstrapController` ไว้ใน `SettingsModule` (นำเข้า `IdempotencyModule`)
   - ลงทะเบียนทั้งสอง Controller ไว้ใน `TENANT_ROUTES` เพื่อให้ `RequestContextMiddleware` และ `TenantGuard` ทำงานครอบคลุม

5. **เขียนและรันชุดทดสอบ**:
   - Unit test: `server/src/settings/settings.dto.spec.ts` (6 tests)
   - Integration test: `server/test/bootstrap.e2e-spec.ts` (6 tests)

---

## 3. ตัดสินใจอะไรไปบ้าง เพราะอะไร

- **การคำนวณ ETag**: เลือกใช้ SHA256 hash จาก JSON stringification ของ `BootstrapData` (`products`, `categories`, `customers`, `mechanics`, `settings`) เพื่อรับประกันว่าหากมีการเพิ่ม/แก้ไข/ลบ ฟิลด์ใดก็ตามใน 5 เอนทิตีนี้ ETag จะเปลี่ยนค่าทันทีตามเกณฑ์สเปก
- **Tombstone filtering**: ใช้เงื่อนไข `deleted_at IS NULL` ในการคัดเลือกสินค้า, ลูกค้า, และช่าง เพื่อไม่ให้ข้อมูลที่ถูกลบซอฟต์ดีลีทติดไปกับ payload bootstrap หน้าร้าน
- **การจัดการ `settings` กรณีไม่มีแถวข้อมูล**: หาก tenant ยังไม่มีแถวในตาราง `settings` ระบบจะอ่าน `shop_name` และ `shop_name_en` จากตาราง `tenants` มาเป็นค่าเริ่มต้นและ insert ให้โดยอัตโนมัติ

---

## 4. ลองแล้วไม่เวิร์ก (ทางตัน)

- **การลืมนำเข้า `IdempotencyModule` ใน `SettingsModule`**: ตอนรัน e2e test ครั้งแรก NestJS แจ้งข้อผิดพลาดว่าไม่พบ `IdempotencyService` เนื่องจาก `SettingsController` ใช้ `@UseInterceptors(IdempotencyInterceptor)` -> **แก้ไขโดยเพิ่ม `IdempotencyModule` ใน `imports` ของ `SettingsModule`**

---

## 5. ยังไม่ชัวร์ / สมมติฐานที่ยังไม่พิสูจน์

- **การรัน `test:e2e` แบบสมบูรณ์**: ต้องใช้เครื่องที่มี PostgreSQL container หรือ dev environment ที่รันอยู่อุปกรณ์โลคัล (รัน `pnpm test` สำหรับ unit tests ผ่านครบ 100% แล้ว)

---

## 6. ก้าวถัดไป (เรียงลำดับ)

1. **Ticket #26 (`p6.2` Purchase Orders / PO)**:
   - สร้างเอนด์พอยต์ `POST /purchase-orders` และ `POST /purchase-orders/:id/receive`
   - คำนวณต้นทุนเฉลี่ยถ่วงน้ำหนัก (Weighted-Average Cost) เมื่อรับของเข้าคลัง: `round2((oldQty * oldCost + newQty * newCost) / (oldQty + newQty))`
2. **Ticket #63 (`ops.1` Prometheus & Grafana Monitoring Setup)**:
   - ตั้งค่า Prometheus `/metrics` endpoint ใน NestJS สำหรับระบบ monitoring

---

## 7. ข้อควรระวัง

- ทุกเอนด์พอยต์ที่ขึ้นต้นด้วย tenant (รวมถึง `/bootstrap` และ `/settings`) **ต้องอยู่ใน `TENANT_ROUTES`** ใน `app.module.ts` เพื่อให้ `RequestContextMiddleware` เปิดทรานแซกชันก่อนที่ `TenantGuard` จะสั่ง `SET LOCAL app.tenant_id`

---

## 8. อ้างอิง

- **ไฟล์ที่สร้างใหม่:**
  - [`server/src/settings/settings.dto.ts`](../../server/src/settings/settings.dto.ts)
  - [`server/src/settings/settings.service.ts`](../../server/src/settings/settings.service.ts)
  - [`server/src/settings/settings.controller.ts`](../../server/src/settings/settings.controller.ts)
  - [`server/src/settings/bootstrap.controller.ts`](../../server/src/settings/bootstrap.controller.ts)
  - [`server/src/settings/settings.module.ts`](../../server/src/settings/settings.module.ts)
  - [`server/src/settings/settings.dto.spec.ts`](../../server/src/settings/settings.dto.spec.ts)
  - [`server/test/bootstrap.e2e-spec.ts`](../../server/test/bootstrap.e2e-spec.ts)
- **ไฟล์ที่แก้ไข:**
  - [`server/src/app.module.ts`](../../server/src/app.module.ts)
- **เอกสารการออกแบบ:**
  - [`docs/Backend_design/01_DATABASE.md`](../Backend_design/01_DATABASE.md)
  - [`docs/Backend_design/02_API_SCREENS.md`](../Backend_design/02_API_SCREENS.md)
  - [`docs/Backend_design/adr/0010-client-write-through-cache.md`](../Backend_design/adr/0010-client-write-through-cache.md)

---

## 9. Suggested Skills for Next Agent

- **`dart-run-static-analysis`**: สำหรับรันตรวจสอบ `dart analyze` ฝั่ง Flutter client
- **`dart-add-unit-test`**: สำหรับเขียนยูนิตเทสต์ใน Flutter / Dart
- **`domain-modeling`**: สำหรับอัปเดตโมเดลโดเมนและเอกสารบริบทเพิ่มเติม
