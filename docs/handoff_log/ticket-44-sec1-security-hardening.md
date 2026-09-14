# Handoff: Backend Security Gate & Hardening (Ticket #44, `sec.1`)

**วันที่:** 2026-09-13 · **ผู้บันทึก:** PattaraponKitcharoen (`team/3` / Lane C — security, platform, infra, queue, load test) · **สถานะ:** เสร็จสมบูรณ์พร้อม Merge (Branch `feat/44-security-hardening`)

---

## 1. วัตถุประสงค์และขอบเขตงาน

ตั๋ว **#44 (`sec.1`)** เป็นตั๋วหลักด้านความปลอดภัยของ Backend ตามข้อกำหนดของหลักสูตรและเกณฑ์การให้คะแนน (OWASP Top 10 2021) ตามที่บันทึกไว้ใน `docs/Backend_design/04_QA_SCRUTINY.md §รอบ 4`, `docs/handoff_log/security-review-jwt-audit-cve.md` และ `CLAUDE.md:546`:

1. **Helmet & Security Headers (OWASP A05 - Security Misconfiguration):**
   - ติดตั้ง `helmet` (`^8.3.0`)
   - เปิดใช้งาน Security Headers ใน `server/src/app.setup.ts`:
     - `X-Content-Type-Options: nosniff`
     - `X-Frame-Options: SAMEORIGIN`
     - `X-Download-Options: noopen`
     - `X-XSS-Protection: 0`
     - ลบ `X-Powered-By`
     - ตั้งค่า `contentSecurityPolicy: false` และ `crossOriginResourcePolicy: { policy: 'cross-origin' }` สำหรับ JSON API / SPA compatibility
2. **Dynamic CORS Configuration (OWASP A05):**
   - รองรับ `CORS_ORIGINS` จาก Environment ใน `server/src/config/config.ts`
   - ตั้งค่า `enableCors` พร้อม credentials, allowed methods (`GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS`), allowed headers (`Content-Type, Authorization, Idempotency-Key, X-Device-Id, X-Client-Version, X-Correlation-ID`) และ exposed headers (`Idempotency-Key, Retry-After, X-Correlation-ID`)
3. **Brute-Force Rate Limiting (OWASP A07 - Identification & Authentication Failures):**
   - เพิ่ม Key-based rate limit helpers ใน `RateLimitService`: `checkKeyLimit`, `getFailureStatus`, `recordFailure`, `clearKey`
   - **Login Brute-force Defense (`POST /auth/token`):**
     - จำกัดการล็อกอินล้มเหลวไม่เกิน 5 ครั้ง/นาที ต่อ user และ 10 ครั้ง/นาที ต่อ IP
     - เมื่อเกินโควตา ตอบกลับด้วย `429 RATE_LIMITED` พร้อม Header `Retry-After`
     - เมื่อล็อกอินสำเร็จ รีเซ็ต failure counter
   - **Manager PIN Brute-force Defense (`POST /sales/:id/void`):**
     - แก้ปัญหา PIN 4 หลักไม่มี rate limit (`void.service.ts:342`)
     - จำกัดการกรอก PIN ผู้จัดการผิดไม่เกิน 5 ครั้ง ภายใน 5 นาที (300s) ต่อ user
     - เมื่อเกินโควตา ตอบกลับด้วย `429 RATE_LIMITED` พร้อม Header `Retry-After`
     - เมื่อกรอก PIN ถูกต้อง รีเซ็ต failure counter
4. **Negative-Path Security E2E Test Suite (`server/test/security.e2e-spec.ts`):**
   - **A01 Broken Access Control & Claim Spoofing:**
     - ส่ง `tenantId` ปลอมใน Request body -> ระบบยึดตาม Claim `tid` เท่านั้น (ตรวจสอบ DB ยืนยัน)
     - ส่ง `deviceId` ปลอมใน Request body -> ระบบยึดตาม Claim `did` เท่านั้น
     - ข้าม Tenant: Tenant A ไม่สามารถอ่านหรือ void บิลของ Tenant B (ตอบ 404)
     - Role escalation: แคชเชียร์ไม่สามารถ void บิลได้ (ตอบ 403 `FORBIDDEN`)
     - Device role restriction: เครื่อง `backoffice` ไม่สามารถเปิดบิลขายได้ (ตอบ 403 `DEVICE_ROLE_FORBIDDEN`)
     - Retired device: เครื่องที่ถูก retire ไม่สามารถขอ refresh token (ตอบ 401) และไม่สามารถออกเอกสารการขายได้ (ตอบ 403 `DEVICE_ROLE_FORBIDDEN`)
   - **A02 & A07 Cryptographic & JWT Security:**
     - Token โจมตีแบบ `alg: none` -> ปฏิเสธ (401)
     - Token ปลอมแปลง signature / ใช้ untrusted key -> ปฏิเสธ (401)
     - Token หมดอายุ (expired) -> ปฏิเสธ (401)
     - Token ที่มี `kid` ไม่รู้จัก -> ปฏิเสธ (401)
     - Token type confusion: นำ refresh token มาเรียก API หรือนำ access token ไป refresh -> ปฏิเสธ (401)
     - Audience mismatch: นำ token ของ platform admin มาเรียก tenant API -> ปฏิเสธ (401)
   - **A03 Injection & Parameter Tampering:**
     - SQL Injection payloads (`' OR '1'='1`, `'; DROP TABLE customers; --`) ใน string fields ถูกบันทึกและ query เป็น literal text โดยสมบูรณ์ ไม่กระทบโครงสร้าง DB
     - Non-UUID route parameters ได้รับ 400/404 ไม่ทำให้ database pool แตกหรือเกิด 500 error
   - **A05 Security Misconfiguration:**
     - ตรวจสอบ Helmet headers ครบถ้วน
     - ตรวจสอบ CORS headers และ preflight `OPTIONS` (ตอบ 204 พร้อม headers)
     - ตรวจสอบ Nginx configuration: `/api/v1/platform/` ป้องกันด้วย private IP allowlist และ `deny all` อย่างเคร่งครัด
   - **A07 Brute-Force Rate Limiting:**
     - ยิงรหัสผ่านผิดติดต่อกัน 6 ครั้ง -> โดนบล็อกด้วย 429 `RATE_LIMITED` พร้อม `Retry-After`
     - ยิง PIN ผู้จัดการผิดติดต่อกัน 6 ครั้ง -> โดนบล็อกด้วย 429 `RATE_LIMITED` พร้อม `Retry-After`
5. **Supply Chain & Pipeline Security (OWASP A08 - Software & Data Integrity):**
   - Pin third-party GitHub Actions ใน `.github/workflows/server.yml` และ `.github/workflows/flutter.yml` ด้วย full 40-character commit SHAs
   - เพิ่ม `.github/workflows/codeql.yml` สำหรับทำ Automated GitHub CodeQL SAST Analysis

---

## 2. ผลการทดสอบ (Verification)

1. **Server Unit Tests:**
   ```bash
   pnpm test
   # Result: 20 passed (136 tests passed)
   ```
2. **Server E2E Tests (Security Suite):**
   ```bash
   pnpm vitest run --config ./vitest.config.e2e.ts test/security.e2e-spec.ts test/rate-limit.e2e-spec.ts
   # Result: 2 passed (26 tests passed - security: 20 tests, rate-limit: 6 tests)
   ```
3. **Server Quality & Security Gates:**
   ```bash
   pnpm lint        # 0 warnings, 0 errors
   pnpm typecheck   # 0 errors
   pnpm audit --audit-level=high # No known vulnerabilities found
   ```
4. **Frontend Regressions:**
   ```bash
   dart analyze     # No issues found!
   flutter test     # All 264 tests passed!
   ```

---

## 3. ไฟล์ที่มีการเปลี่ยนแปลง

- `server/package.json` & `server/pnpm-lock.yaml`: ติดตั้ง `helmet`
- `server/src/app.setup.ts`: เพิ่ม Helmet middleware และ Dynamic CORS configuration
- `server/src/config/config.ts`: เพิ่ม `corsOrigins` ใน AppConfig & loadConfig
- `server/src/common/http-exception.filter.ts`: รองรับการส่ง `Retry-After` header อัตโนมัติเมื่อเกิด 429
- `server/src/rate-limit/rate-limit.service.ts`: เพิ่มฟังก์ชันป้องกัน brute-force (`checkKeyLimit`, `getFailureStatus`, `recordFailure`, `clearKey`)
- `server/src/auth/auth.service.ts` & `auth.controller.ts`: เพิ่มการตรวจจับและจำกัดความถี่การพยายามล็อกอินผิด
- `server/src/auth/auth.service.spec.ts` & `auth.controller.spec.ts`: อัปเดต unit tests ให้รองรับ RateLimitService mock
- `server/src/sales/void.service.ts`: เพิ่มการตรวจจับและจำกัดความถี่การกรอก Manager PIN ผิด
- `server/test/security.e2e-spec.ts`: สร้างชุดทดสอบ Negative-Path Security E2E ทั้งหมด 20 เคส
- `.github/workflows/server.yml`: Pin Actions commit SHA
- `.github/workflows/flutter.yml`: Pin Actions commit SHA
- `.github/workflows/codeql.yml`: เพิ่ม CodeQL SAST Analysis workflow
