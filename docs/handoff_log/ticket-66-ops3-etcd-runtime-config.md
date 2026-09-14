# Handoff: Runtime Config Service via etcd v3 (Ticket #66, `ops.3`)

**วันที่:** 2026-09-14 · **ผู้บันทึก:** PattaraponKitcharoen (`team/3` / Lane C — security, platform, infra, queue, load test, CD)  
**สถานะ:** เสร็จสมบูรณ์พร้อม Merge (Branch `feat/66-runtime-config-etcd`)  
**ขอบเขตงาน:** สร้าง `RuntimeConfigService` ใน NestJS ที่ดึงและ watch ค่า configuration แบบ dynamic จาก etcd v3 ผ่าน gRPC-gateway HTTP API โดยเฉพาะ `/pos/config/log_level` เพื่อเปลี่ยน log level ของ Pino logger ในหน่วยความจำได้ทันทีโดยไม่ต้อง restart app พร้อมคุณสมบัติ Fail-Open ตาม [07_CICD_DEPLOY.md §8](file:///Users/peternus/Desktop/srisurart-pos-flutter/docs/Backend_design/07_CICD_DEPLOY.md#L309-L334) และ [ADR-0013](file:///Users/peternus/Desktop/srisurart-pos-flutter/docs/Backend_design/adr/0013-cicd-toolchain.md)  
**ต่อจาก:** Ticket #65 (`cd.1`) และ Ticket #67 (`cd.2`)

---

## 1. ตอนนี้อยู่ตรงไหน

- ตัว service `RuntimeConfigService` สร้างเสร็จสมบูรณ์ใน `server/src/config/runtime-config.service.ts`
- ลงทะเบียนใน `AppModule` (`CoreModule.forRoot()`) ให้เป็น provider & export เรียบร้อย
- Unit test ทั้ง 7 ข้อใน `server/src/config/runtime-config.service.spec.ts` ผ่าน 100%
- Typecheck & Lint (`oxlint` + `tsc --noEmit`) ผ่าน 0 warnings, 0 errors
- ชุด Unit tests ทั้งหมดของ server (`pnpm test`) 21/21 suite, 143/143 tests ผ่านฉลุย
- Branch: `feat/66-runtime-config-etcd`

---

## 2. รอบนี้ทำอะไรไป ได้ผลอะไร

### 1. Zero-Dependency etcd v3 HTTP Client (`RuntimeConfigService`)
- **ไฟล์:** [`server/src/config/runtime-config.service.ts`](file:///Users/peternus/Desktop/srisurart-pos-flutter/server/src/config/runtime-config.service.ts)
- **ไม่ใช้ library `etcd3`:** ใช้ Node.js native `fetch` ติดต่อกับ etcd v3 gRPC-gateway HTTP endpoints ตามสเปก [07_CICD_DEPLOY.md §8](file:///Users/peternus/Desktop/srisurart-pos-flutter/docs/Backend_design/07_CICD_DEPLOY.md#L309-L334) เพื่อตัดปัญหา ESM/CJS compatibility และ binary dependencies:
  - `POST /v3/auth/authenticate`: ยืนยันตัวตน root + password (ถ้ามี config ไว้) เพื่อนำ token ไปแนบ header
  - `POST /v3/kv/range`: อ่านค่าเริ่มต้นของ key `/pos/config/log_level` (base64 encoded) ตอน app boot
  - `POST /v3/watch`: เปิด streaming connection ดักจับ `PUT` event เมื่อมีการเปลี่ยนค่า log_level ใน etcd แบบ real-time
- **Dynamic Pino Log Level:** Pino อนุญาตให้ set `logger.level = newLevel` ได้ทันทีใน runtime ทำให้ทั้งระบบสลับ log level เช่นจาก `info` ไป `debug` หรือ `warn` ได้ทันทีโดยไม่ต้อง restart process
- **Log Level Validation:** ตรวจสอบ whitelist (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) หากค่าที่ส่งมาไม่ใช่ จะ log warn และปฏิเสธไม่เปลี่ยนแปลง
- **Fail-Open Invariant:** หากไม่ได้ตั้ง `ETCD_URL` หรือ etcd unreachable/down หรือ timeout:
  - App จะไม่ crash (`onModuleInit` ไม่ throw)
  - พ่น log warn 1 บรรทัด (`etcd unavailable, using environment configuration`)
  - ใช้ค่า `LOG_LEVEL` จาก `.env` ทำงานต่อไปตามปกติ

### 2. Config & App Registration
- **[`server/src/config/config.ts`](file:///Users/peternus/Desktop/srisurart-pos-flutter/server/src/config/config.ts):**
  - เพิ่ม `etcdUrl?: string;` (`ETCD_URL`)
  - เพิ่ม `etcdPassword?: string;` (`ETCD_PASSWORD`)
- **[`server/src/app.module.ts`](file:///Users/peternus/Desktop/srisurart-pos-flutter/server/src/app.module.ts):**
  - นำเข้าและลงทะเบียน `RuntimeConfigService` ใน `CoreModule.forRoot()` providers และ exports

### 3. Comprehensive Unit Tests
- **ไฟล์:** [`server/src/config/runtime-config.service.spec.ts`](file:///Users/peternus/Desktop/srisurart-pos-flutter/server/src/config/runtime-config.service.spec.ts) (7 tests, 5ms):
  1. `does nothing when etcdUrl is not defined`: ไม่ยิง network เมื่อไม่ได้ config etcd
  2. `fails open and logs warning once when etcd is unreachable`: ไม่ crash เมื่อ connect ไม่ติด พร้อม log warn
  3. `fetches initial log_level from etcd and updates logger.level`: อ่านค่า range สำเร็จและแก้ logger.level
  4. `authenticates with etcd when etcdPassword is configured`: ยิง authenticate และส่ง token
  5. `updates logger.level dynamically on watch event`: อัปเดต logger.level เมื่อได้รับ watch event PUT
  6. `ignores invalid log levels and logs a warning`: ปฏิเสธค่าที่ไม่ถูกต้อง
  7. `aborts watch controller onModuleDestroy`: สั่ง abort stream cleanly เมื่อโมดูลถูกทำลาย

---

## 3. ตัดสินใจอะไรไปบ้าง เพราะอะไร

1. **ใช้ native `fetch` แทน `etcd3` npm package:**
   - *เหตุผล:* สเปก [07_CICD_DEPLOY.md §8](file:///Users/peternus/Desktop/srisurart-pos-flutter/docs/Backend_design/07_CICD_DEPLOY.md#L309-L334) ระบุชัดเจนว่า "ไม่ลง etcd3 npm package — ใช้ fetch ยิง etcd v3 HTTP gateway ตรง เพื่อเลี่ยง CJS/ESM และ grpc-js issues ใน Node 24"
2. **รันลูป Watch ใน background (void promise):**
   - *เหตุผล:* `onModuleInit` ต้องไม่บล็อกกระบวนการบูตของ NestJS ดังนั้นการรอ initial fetch จะทำแบบ synchronous เพื่อรับค่าคอนฟิกล่าสุดทันที แต่ลูป watch จะปล่อยให้รัน background ใน event loop
3. **ตัดการ reconnect แบบ exponential backoff สั้น ๆ เมื่อ watch stream หลุด:**
   - *เหตุผล:* ป้องกันไม่ให้ stream หลุดแล้ว app นิ่งเงียบ โดยมี delay 3 วินาทีก่อนลองต่อใหม่ พร้อมเช็ค flag `isStopped` เพื่อให้ clean teardown ตอน shutdown ได้

---

## 4. ลองแล้วไม่เวิร์ก (ทางตัน)

- ไม่มี (การยิงผ่าน HTTP gRPC-gateway JSON API ของ etcd v3 ตรงตามมาตรฐาน official specification ทุกประการ)

---

## 5. ยังไม่ชัวร์ / สมมติฐานที่ยังไม่พิสูจน์

- **ยืนยันแล้ว:** Service ทำงานได้สมบูรณ์ทั้งแบบมี etcd (mocked) และไม่มี etcd (fail-open)
- **รอเพื่อน (Ticket #64 โดย Team 2):** เมื่อ Team 2 เพิ่ม etcd container ใน `server/docker-compose.yml` และรัน `etcdctl put /pos/config/log_level debug` service ตัวนี้จะเชื่อมต่ออัตโนมัติผ่าน `ETCD_URL=http://etcd:2379` ใน compose network

---

## 6. ก้าวถัดไป (เรียงลำดับ)

1. เพิ่ม entry ใน `docs/handoff_log/INDEX.md`
2. Commit การเปลี่ยนแปลงทั้งหมดและ push ขึ้น remote branch `feat/66-runtime-config-etcd`
3. สรุปผลให้ผู้ใช้งานทราบ

---

## 7. ข้อควรระวัง

- etcd v3 gRPC-gateway คาดหวัง body key/value เป็น **base64 encoded string** เสมอ (ไม่ใช่ plain text) ในโค้ดจัดการ `Buffer.from(val).toString('base64')` และ decode ฝั่ง response เรียบร้อยแล้ว
- Pino logger อนุญาตให้ mutate `.level` ได้เฉพาะค่าที่เป็น valid level strings เท่านั้น การใส่ค่าสุ่มสี่สุ่มห้าจะทำให้ Pino throw ดังนั้น whitelist validation จึงจำเป็นอย่างยิ่ง

---

## 8. อ้างอิง

- [docs/Backend_design/07_CICD_DEPLOY.md §8](file:///Users/peternus/Desktop/srisurart-pos-flutter/docs/Backend_design/07_CICD_DEPLOY.md#L309-L334) (Runtime configuration & log level)
- [docs/Backend_design/adr/0013-cicd-toolchain.md](file:///Users/peternus/Desktop/srisurart-pos-flutter/docs/Backend_design/adr/0013-cicd-toolchain.md) (CI/CD and deployment toolchain)
