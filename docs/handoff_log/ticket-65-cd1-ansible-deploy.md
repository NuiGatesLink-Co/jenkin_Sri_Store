# Handoff: Ansible Provision & Deploy Base (Ticket #65, `cd.1`)

**วันที่:** 2026-09-13 · **ผู้บันทึก:** PattaraponKitcharoen (`team/3` / Lane C — security, platform, infra, queue, load test, CD)  
**สถานะ:** เสร็จสมบูรณ์พร้อม Merge (Branch `feat/65-ansible-deploy`)  
**ขอบเขตงาน:** สร้างโครงสร้างพื้นฐานสำหรับ Continuous Deployment (CD) บน VM คณะด้วย Ansible ตาม [07_CICD_DEPLOY.md §6](file:///Users/peternus/Desktop/srisurart-pos-flutter/docs/Backend_design/07_CICD_DEPLOY.md#L129-L150) และ [ADR-0013](file:///Users/peternus/Desktop/srisurart-pos-flutter/docs/Backend_design/adr/0013-cicd-toolchain.md)  
**ต่อจาก:** Ticket #61 (`ci.4`) & Ticket #62 (`ci.5`) (GHCR images) / Ticket #44 (`sec.1`)

---

## 1. สิ่งที่สร้างและพฤติกรรมของระบบ (Deliverables)

### 1. Docker Compose Override สำหรับ Production VM
- **ไฟล์:** `deploy/compose/vm.override.yml`
  - ชี้ service ทั้งหมด (`migrate`, `api-1`, `api-2`, `api-3`, `worker`, `bull-board`) ไปยัง GHCR image `ghcr.io/nuimanlp/srisurart-pos-server:${IMAGE_TAG}`
  - ลบ directive `build:` ออกจาก `api-1` ด้วย `build: !reset []` เพื่อไม่ให้ Docker Compose พยายามเรียก build source code บน VM ที่ไม่มี source files
  - Mount named volume `web:/usr/share/nginx/html:ro` เข้ากับ `nginx`
  - ประกาศ one-shot service `web-sync` ที่ใช้ image `ghcr.io/nuimanlp/srisurart-pos-web:${IMAGE_TAG}`
  - **การแก้ปัญหา Volume Pre-seeding Trap:** สต็อกอิมเมจของ `nginx:1.29-alpine` จะ copy ไฟล์ default `index.html` ของ nginx ลงใน fresh volume อัตโนมัติ `web-sync` จึงรันคำสั่ง `sh -c "rm -rf /target/* && cp -a /web/. /target/"` เพื่อลบ default index.html และวาง Flutter web bundle ลงไปใหม่อย่างหมดจด

### 2. Ansible Playbook: `provision.yml` (เตรียม VM เปล่า)
- **ไฟล์:** `deploy/ansible/provision.yml`
  - ติดตั้ง package พื้นฐาน: `curl`, `gnupg`, `ufw`, `openssl`, `ca-certificates`
  - ติดตั้ง Docker Engine + Docker Compose plugin อย่างเป็นทางการผ่าน keyring `/etc/apt/keyrings/docker.asc` และ `/etc/apt/sources.list.d/docker.list`
  - ตั้งค่า UFW Firewall อย่างรัดกุม: อนุญาตเฉพาะพอร์ต 22 (SSH), 80 (HTTP), 443 (HTTPS) เท่านั้น พร้อมบล็อก inbound connection อื่นทั้งหมด (Postgres, Redis, Bull-Board, etcd ปลอดภัยอยู่หลัง firewall)
  - สร้าง system user `deploy` อยู่ในกลุ่ม `docker` เพื่อให้สามารถรัน compose commands ได้โดยไม่ต้องใช้ sudo
  - ติดตั้ง SSH Authorized Key สำหรับ CI/CD runner
  - สร้างโครงสร้างไดเรกทอรี `/opt/pos/` (สิทธิ์ `0755` เจ้าของ `deploy:deploy`)
  - วางไฟล์ `/opt/pos/.env` (สิทธิ์ `0600`) จาก secret `DEMO_ENV_FILE`

### 3. Ansible Playbook: `deploy.yml` (Deploy Release Idempotently)
- **ไฟล์:** `deploy/ansible/deploy.yml`
  - รับ parameter `image_tag=<sha>` (หรือผ่าน env `IMAGE_TAG`)
  - **Idempotency Check:** อ่าน `/opt/pos/.current_sha` หาก release ปัจจุบันตรงกับ `image_tag` ที่ส่งมา จะ debug แจ้งเตือนและจบ play ทันที (`meta: end_play`) ป้องกันกรณีที่ CI 2 ตัว (`Server CI` และ `Flutter CI`) จบพร้อมกันแล้วสั่ง deploy ซ้ำ
  - คัดลอก Compose files, `vm.override.yml`, `nginx.conf`, และ `docker/postgres/init/` ลง `/opt/pos/`
  - รัน `docker compose pull` เพื่อดึง container images ล่าสุดจาก GHCR
  - รัน `docker compose run --rm web-sync` ซิงก์ไฟล์เว็บลงใน volume
  - รัน `docker compose run --rm migrate` (Schema ก่อนโค้ด — migration สำเร็จก่อน restart service)
  - สตาร์ทฐานข้อมูลและ datastores (`postgres`, `redis-cache`, `redis-queue`, `certgen`)
  - **Rolling Restart:** รีสตาร์ท `api-1` → รอ healthcheck ผ่าน (`healthy`) → รีสตาร์ท `api-2` → รอ healthy → รีสตาร์ท `api-3` → รอ healthy (รับประกัน zero-downtime และ Nginx ไม่เตะทุก node พร้อมกัน)
  - รีสตาร์ท `worker`, `bull-board`, และ `nginx`
  - ตรวจสอบความพร้อมของทั้งคลัสเตอร์ผ่าน Nginx ด้วย `GET https://127.0.0.1/health/ready` (ต้องได้ HTTP 200)
  - บันทึก `image_tag` ลงใน `/opt/pos/.current_sha`

### 4. Configuration & Inventory
- `deploy/ansible/ansible.cfg`: ตั้งค่า inventory path, ปิด host_key_checking, เปิด yaml callback, ปิด deprecation warnings
- `deploy/ansible/inventory/hosts.ini`: รองรับตัวแปร `DEMO_SSH_HOST`, `DEMO_SSH_USER`, `DEMO_SSH_KEY_PATH` พร้อม fallback ที่ปลอดภัย

### 5. Automated Validation Script
- `deploy/scripts/validate.sh`:
  - ตรวจสอบ `docker compose config` รวมกับ `vm.override.yml` ว่าไม่มี syntax/schema error และ `build:` ถูกลบออกจริง
  - ตรวจสอบความมีอยู่ของไฟล์ที่จำเป็นทั้งหมด
  - รัน `ansible-playbook --syntax-check` บนเครื่อง หรือ fallback รันใน Docker container หากเครื่องไม่มี ansible ติดตั้ง

---

## 2. การตรวจสอบและการทดสอบ (Verification)

1. **Docker Compose Override Merging:**
   ```bash
   IMAGE_TAG=test-sha POS_APP_PASSWORD=x REDIS_PASSWORD=x POSTGRES_PASSWORD=x JWT_PRIVATE_KEY=x JWT_PUBLIC_KEYS=x BULL_BOARD_PASSWORD=x \
   docker compose -f server/docker-compose.yml -f deploy/compose/vm.override.yml config --quiet
   ```
   - **ผลลัพธ์:** ผ่าน 100% (0 errors, 0 warnings, `build:` ถูก reset ออกจาก `api-1`)
2. **Ansible Playbook Syntax Check:**
   - `ansible-playbook -i deploy/ansible/inventory/hosts.ini --syntax-check deploy/ansible/provision.yml` -> **Passed**
   - `ansible-playbook -i deploy/ansible/inventory/hosts.ini --syntax-check deploy/ansible/deploy.yml` -> **Passed**
3. **Automated Validation Script:**
   - `./deploy/scripts/validate.sh` -> **All deploy validations passed successfully!**
4. **Server Suite Regression Test:**
   - `pnpm test` -> 20/20 suites passed (136 unit tests)
5. **Flutter Client Regression Test:**
   - `flutter test` -> 264/264 tests passed
