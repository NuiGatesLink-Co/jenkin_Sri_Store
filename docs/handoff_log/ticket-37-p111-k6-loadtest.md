# Handoff — #37 `p11.1` k6 Load Test & Performance Proof (2026-09-13)

**วันที่:** 2026-09-13 · **ผู้บันทึก:** PattaraponKitcharoen (`team/3` / Lane C — security, platform, infra, queue, load test) · **สถานะ:** เสร็จสมบูรณ์พร้อม Merge (Branch `feat/p11.1-k6-loadtest`)
**ขอบเขต:** ปิด Ticket #37 (`p11.1`) — จัดทำ harness, k6 scripts ทั้ง 4 สถานการณ์ตามเกณฑ์คอร์สใน `docs/Backend_design/02_API_SCREENS.md §9`, ทำ Redis Caching สำหรับ Read Path `GET /products`, และพิสูจน์ SQL Data Integrity
**ต่อจาก:** Ticket #35 (`p10.3` Database Backup) ที่ merge ไปก่อนหน้า

---

## 1. ผลลัพธ์การทดสอบ k6 ตามเกณฑ์คอร์ส (`02_API_SCREENS.md §9`)

ทุกสถานการณ์ผ่านเกณฑ์ (Thresholds) ของ assignment และ rubric 100%:

| สถานการณ์ | โหลด (VUs) | เกณฑ์ผ่านที่กำหนด | ผลลัพธ์จริงที่วัดได้ (Actual) | สถานะ |
|---|---|---|---|---|
| **1. `GET /products`** (Read-heavy) | **1,000 VUs** | p95 < 200ms, Cache Hit > 90%, Error < 0.1% | **p95 = 123.50ms**, **Cache Hit = 99.99%**, **Error = 0.00%** (88,076 reqs, 0 failed) | ✅ **PASS** |
| **2. `POST /sales`** (Write Contention) | **200 VUs** ชนสินค้า `p12` ตัวเดียวกัน (สต็อก 50) | สต็อกห้ามติดลบ, ไม่มีบิลซ้ำ, p95 < 500ms | **p95 = 349.41ms**, สำเร็จพอดี 50 บิล (201), ปฏิเสธ 150 บิล (409 INSUFFICIENT_STOCK), Server Error = 0.00% | ✅ **PASS** |
| **3. Idempotency Replay** | **100 VUs** ส่ง `Idempotency-Key` เดิมซ้ำ 5 ครั้ง | สร้างบิลเดียว, ตัดสต็อกครั้งเดียว, replay ได้ผลลัพธ์เดิม | **p95 = 302.68ms**, สร้างใหม่รอบแรก 100 บิล, Replay ตรงกันเป๊ะ 400 ครั้ง, Error = 0.00% | ✅ **PASS** |
| **4. Mixed Workload** (80% Read / 20% Write) | **500 VUs** (30s peak) | ไม่มี connection pool หมด, error < 0.1%, p95 < 500ms | **p95 = 14.80ms**, 37,160 reqs (29,680 reads, 7,480 writes), **Pool Exhaustion = 0.00%**, **Error = 0.00%** | ✅ **PASS** |

---

## 2. หลักฐาน Data Integrity Proof (SQL Verification)

ผลลัพธ์จากการรัน `pnpm k6:verify` (รันคำสั่ง SQL จริงบน PostgreSQL):

```
================================================================
🔍 DATA INTEGRITY PROOF (Assignment & Rubric Verification)
================================================================
Tenant ID:     00000000-0000-4000-8000-000000000001
Target Product: p12
Initial Stock:  50
Timestamp:      2026-09-13T09:01:24.862Z
----------------------------------------------------------------
Current Stock in DB:              0
Total Units Sold (sale_items):   50 (across 50 bills)
Expected Stock (initial - sold):  0
Stock Movements Balance (delta):  -50
Total Sales / Unique Receipts:    50 / 50
----------------------------------------------------------------
RESULTS & INVARIANT VERIFICATION:
1. Stock Invariant (stock == initial - sold): ✅ PASS
2. Stock Non-Negative (stock >= 0):           ✅ PASS
3. Receipt Uniqueness (no duplicates):        ✅ PASS
================================================================
🎉 ALL INTEGRITY CHECKS PASSED PERFECTLY!
```

---

## 3. สิ่งที่สร้างและเปลี่ยนแปลงในรอบนี้

1. **Read Path & Redis Caching (`server/src/products/`):**
   - `ProductsService`: ค้นหาแคชใน Redis key pattern `t:${tenantId}:products:list:...` (TTL 60s) ถ้า Miss จะ query จาก Postgres ภายใต้ RLS tenant isolation แล้ว cache ลง Redis
   - ส่ง Header `X-Cache: HIT` หรือ `X-Cache: MISS` กลับไปให้ client/k6
   - `ProductsController`: ป้องกันด้วย `TenantGuard` (รองรับบทบาท `cashier`, `manager`, `admin`)
   - ต่อเข้า `AppModule` และลงทะเบียนใน `TENANT_ROUTES`
2. **k6 Harness & Scripts (`server/test/k6/`):**
   - `setup.ts`: สคริปต์ seed tenant สำหรับการทดสอบ (ตั้ง `plan = 'loadtest'` ตาม ADR-0006 เพื่อวัดความสามารถระบบแทน rate limiter), seed users, devices, open shift, สินค้า contention `p12` (สต็อก 50) และสินค้า catalogue 50 รายการ พร้อม sign RS256 JWT
   - `verify-integrity.ts`: ตรวจสอบ SQL invariants (stock = initial - sold, stock >= 0, ไม่มีบิลซ้ำ)
   - `01-read-products.js`: Scenario 1 (1,000 VUs read heavy)
   - `02-write-sales-contention.js`: Scenario 2 (200 VUs contention on `p12`)
   - `03-idempotent-replay.js`: Scenario 3 (100 VUs idempotency replay 5x)
   - `04-mixed-workload.js`: Scenario 4 (500 VUs 80/20 mixed read/write)
   - `server/test/k6.e2e-spec.ts`: e2e suite ทดสอบ harness และ read path (5/5 tests passed)
3. **Infrastructure & Resilience:**
   - ปรับ `connectionTimeoutMillis` ใน `server/src/infra/db.module.ts` ให้อ่านจาก `process.env.DB_CONNECTION_TIMEOUT_MS ?? 10000` เพื่อรองรับ burst connection ภายใต้โหลดหนัก
   - รองรับ ESM import สำหรับ `jsonwebtoken` ใน Node 24 runtime (`jwt-keys.service.ts` และ `setup.ts`)
   - รองรับ parsing public key JSON ใน `config.ts`

---

## 4. ข้อค้นพบและข้อควรระวังสำคัญ (Lessons Learned)

1. **Invariant: 1 Active POS Device per Tenant (ADR-0004):**
   - ฐานข้อมูลมี Partial Unique Index `one_pos_per_tenant ON devices (tenant_id) WHERE role = 'pos' AND retired_at IS NULL`
   - ใน 1 tenant จะมีเครื่อง POS ที่เปิดกะขายได้เพียง 1 เครื่องเท่านั้น เครื่องอื่นในร้านต้องเป็น `backoffice`
2. **Invariant: Document Counter Cap at 9,999 per Month (ADR-0007):**
   - ตาราง `doc_counters` มี constraint `CHECK (last_no <= 9999)` เพื่อป้องกันเลขบิลซ้ำบนกระดาษใบเสร็จที่ลูกค้าถือ
   - ดังนั้น ในการทดสอบโหลด Mixed Workload 500 VUs ต้องตั้ง sleep/think time ที่สมจริง (`sleep(0.35)`) เพื่อไม่ให้ยิงทะลุ 10,000 บิลในเดือนเดียวกัน
3. **Migration Sync บนเครื่อง Dev:**
   - หากรัน e2e แล้วพบ 500 เช่น `column "payment_method" does not exist` ใน `credit_payments` ให้รัน migration ด้วยสิทธิ์ postgres admin: `DATABASE_URL="postgres://postgres:dev-only-postgres@127.0.0.1:5432/pos" node dist/db/migrate.js up`

---

## 5. คำสั่งสำหรับรันการทดสอบ

```bash
cd server
pnpm k6:setup     # เตรียม tenant, shift, products, tokens
pnpm k6:read      # Scenario 1 (1,000 VUs Read)
pnpm k6:write     # Scenario 2 (200 VUs Contention)
pnpm k6:verify    # ตรวจสอบ Data Integrity หลัง Scenario 2
pnpm k6:idem      # Scenario 3 (100 VUs Idempotency Replay)
pnpm k6:mixed     # Scenario 4 (500 VUs Mixed Workload)
pnpm k6:verify    # ตรวจสอบ Data Integrity หลัง Scenario 4
pnpm k6:all       # รันทุก Scenario อัตโนมัติเรียงลำดับ
```
