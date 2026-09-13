# Handoff: Auto-Deploy & Rollback Workflow (Ticket #67, `cd.2`)

**วันที่:** 2026-09-14 · **ผู้บันทึก:** PattaraponKitcharoen (`team/3` / Lane C — security, platform, infra, queue, load test, CD)  
**สถานะ:** เสร็จสมบูรณ์พร้อม Merge (Branch `feat/67-auto-deploy`)  
**ขอบเขตงาน:** สร้าง GitHub Actions workflow สำหรับสั่งรัน Continuous Deployment ขึ้น VM คณะแบบอัตโนมัติเมื่อ CI สำเร็จบน `main` พร้อมรองรับ Rollback release ผ่าน `workflow_dispatch` ตาม [07_CICD_DEPLOY.md §6.1](file:///Users/peternus/Desktop/srisurart-pos-flutter/docs/Backend_design/07_CICD_DEPLOY.md#L163-L182) และ [ADR-0013](file:///Users/peternus/Desktop/srisurart-pos-flutter/docs/Backend_design/adr/0013-cicd-toolchain.md)  
**ต่อจาก:** Ticket #65 (`cd.1`) (Ansible provision & deploy playbooks)

---

## 1. สิ่งที่สร้างและพฤติกรรมของระบบ (Deliverables)

### 1. GitHub Actions Continuous Deployment Workflow
- **ไฟล์:** `.github/workflows/deploy.yml`
  - **Triggers:**
    1. `workflow_run`: ดักจับเมื่อทั้ง `Server CI` หรือ `Flutter CI` ทำงานเสร็จสิ้นบน branch `main` (`types: [completed]`)
    2. `workflow_dispatch`: สำหรับสั่ง Deploy ด้วยมือ หรือทำการ **Rollback** ไปยัง release SHA ก่อนหน้า โดยรับ input `image_tag`
  - **เงื่อนไขการทำงาน (`if:`):**
    - ทำงานเมื่อเป็น `workflow_dispatch` หรือเมื่อ `workflow_run` มีสถานะ `conclusion == 'success'` บน branch `main` จากเหตุการณ์ `push`
  - **Concurrency Protection:**
    - `group: deploy-demo`, `cancel-in-progress: false`: **ห้ามยกเลิกกลางคันเด็ดขาด** เพื่อป้องกันไม่ให้กระบวนการ rolling restart หรือ migration ขาดตอน
  - **การรับมือ Dual-Trigger Race Condition:**
    - เมื่อ commit ขึ้น `main` ทั้ง `Server CI` และ `Flutter CI` จะเริ่มทำงานแยกกัน เมื่อตัวใดตัวหนึ่งเสร็จก่อน มันจะเรียก `deploy.yml`
    - `deploy.yml` จะรัน `verify-ghcr-tags.sh` เพื่อเช็คว่า GHCR มี image ครบทั้ง 2 ตัวหรือยัง (`srisurart-pos-server` และ `srisurart-pos-web`)
    - หากตัวหนึ่งยังสร้างไม่เสร็จ มันจะ exit 0 ออกไปอย่างสงบ (neutral) และเมื่อ CI อีกตัวทำงานเสร็จสิ้น มันจะ trigger `deploy.yml` อีกรอบและพบว่า image ทั้งคู่พร้อม deploy ทันที
  - **การทำงานร่วมกับ Environment `demo`:**
    - ผูกกับ Environment `demo` และดึง secret (`DEMO_SSH_HOST`, `DEMO_SSH_USER`, `DEMO_SSH_KEY`, `DEMO_ENV_FILE`)
    - ติดตั้ง `ansible-core` บน runner และรัน `ansible-playbook -i deploy/ansible/inventory/hosts.ini deploy/ansible/deploy.yml -e image_tag=<sha>`

### 2. GHCR Image Tag Verification Helper Script
- **ไฟล์:** `deploy/scripts/verify-ghcr-tags.sh`
  - ขอ anonymous bearer token จาก `https://ghcr.io/token?scope=repository:...:pull`
  - ยิงตรวจสอบ manifest header `Accept: application/vnd.docker.distribution.manifest.v2+json` ไปยัง `nuimanlp/srisurart-pos-server` และ `nuimanlp/srisurart-pos-web`
  - คืนค่า exit code `0` เมื่อพบทั้งคู่ และ `1` เมื่อตัวใดตัวหนึ่งยังไม่พร้อม

---

## 2. การตรวจสอบและการทดสอบ (Verification)

1. **GHCR Tag Query Script Test:**
   - ทดสอบ tag `main` ที่มีอยู่จริงบน GHCR:
     ```bash
     ./deploy/scripts/verify-ghcr-tags.sh main
     ```
     -> **ผลลัพธ์:** พบทั้ง Server (HTTP 200) และ Web (HTTP 200) ผ่าน exit code 0
   - ทดสอบ tag ที่ไม่มีอยู่จริง:
     ```bash
     ./deploy/scripts/verify-ghcr-tags.sh non-existent-tag
     ```
     -> **ผลลัพธ์:** คืนค่า failure exit code 1 ตามสเปก
2. **Deploy Substrate & Playbooks:**
   - `./deploy/scripts/validate.sh` ผ่าน 100%
3. **Workflow Syntax Integrity:**
   - ตรวจสอบโครงสร้าง YAML ของ `.github/workflows/deploy.yml` ถูกต้องตามมาตรฐาน GitHub Actions schema
4. **Regression Checks:**
   - Server unit tests (`pnpm test`): 20/20 passed (136 tests)
   - Flutter tests (`flutter test`): 264/264 passed
