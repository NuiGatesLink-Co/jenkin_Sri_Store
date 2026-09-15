# ADR-0013 — toolchain ของ CI/CD และการ deploy: GitHub Actions + GHCR + Ansible + etcd + Monitoring (Prometheus + Grafana + Node Exporter)

* **สถานะ:** Accepted — 2026-09-10 (พิจารณาปฏิเสธ Wazuh/ELK จากข้อจำกัด RAM: 2026-09-15)
* **ผู้ตัดสิน:** เจ้าของโปรเจกต์ (grill 2 รอบ, 19 ข้อ) — บันทึกการสัมภาษณ์อยู่ใน `docs/handoff_log/`
* **เอกสารเจ้าของเรื่องนี้:** [`07_CICD_DEPLOY.md`](../07_CICD_DEPLOY.md)

## บริบท

ตั้งแต่ `ec24f79` เรื่อง deployment/hosting **ไม่มีเอกสารเจ้าของ** และ CI ที่มีอยู่ (`flutter.yml`,
`server.yml`) หยุดที่ "artefact บน main สีเขียว ไม่ deploy" โดยตั้งใจ เพราะยังไม่เลือก production host

คอร์สกำหนด **ตารางบล็อกกระบวนการ DevOps** ที่ต้องแมปเครื่องมือให้ครบ 7 บล็อก (Code & SCM ·
Build & Test · Security Scan · Package/Storage · Config & Deploy · KV Storage · Monitoring) และให้
ทุกคนในทีมแตะ CI/CD · เอกสารประกอบคอร์สที่มี (`docs/boat_CI_CD.md`) เป็นเรื่อง **Jenkins** ของ
อีกโปรเจกต์หนึ่ง

## การตัดสินใจ

| บล็อก | เลือก | ทำไม |
|---|---|---|
| Code & SCM | Git / GitHub | มีอยู่แล้ว |
| Build & Test | **GitHub Actions** (vitest ฝั่ง server, `flutter test` ฝั่ง client) | workflow 2 ไฟล์ทำงานอยู่แล้ว · **ไม่เพิ่ม Jenkins** — เครื่องยนต์ที่สองสำหรับงานเดียวกัน และต้องมีเครื่องรัน Jenkins เพิ่มบน VM 6 GB |
| Security Scan | **Trivy** (fs + **image**) + `pnpm audit` + OSV | Trivy สแกน image **บล็อก** การ push ขึ้น registry · ทำให้ผ่านได้ด้วยการ **ถอด npm ออกจาก runtime stage** + pin base ด้วย digest + `apk upgrade` เฉพาะแพ็กเกจ OS (reproducibility มาจาก digest pin) · **ไม่มี `.trivyignore`** (gate ปลอม) |
| Package / Storage | **Docker + GHCR** (package public) | repo เป็น public อยู่แล้ว · VM ดึงได้โดยไม่ต้องจัดการ token · **ยกเลิก tarball artefact** ให้เหลือทางปล่อยทางเดียว · ทั้ง server และ **web** เป็น image (web = ไฟล์ static ล้วน copy ลง volume ให้ Nginx เดิมอ่าน — **ไม่** bake nginx.conf ลง image ฝั่ง client) จะได้ใช้กลไก pull เดียวกันและ rollback ด้วย SHA เดียว |
| Config & Deploy | **Ansible** → SSH เข้า VM คณะ (environment `demo`) **อัตโนมัติทุก main สีเขียว** | playbook ตั้งเครื่องเปล่าได้ = "เลือก production host ทีหลัง" เป็นจริง (แค่เพิ่ม inventory + เปิดอนุมัติ) · ไม่ใช้ Kubernetes — 1 VM, 4 vCPU |
| KV Storage | **etcd** — เก็บเฉพาะ **dynamic config ที่ไม่ใช่ความลับ** | ให้ etcd มีงานจริง (แอปอ่านตอน boot + watch) โดย**ไม่แตะ data model** · **ห้ามเก็บข้อมูลธุรกิจ** — PostgreSQL ยังเป็น source of truth · แอปต้อง boot ได้แม้ไม่มี etcd (fallback ไป env) |
| Monitoring | **Node Exporter + Prometheus + Grafana (Monitoring)** บน VM เดียวกัน ผูก loopback | dashboard เดียว provision จาก JSON ใน repo · **ไม่มี Alertmanager** · **ปฏิเสธ Wazuh และ ELK stack** — สแต็กความปลอดภัย/Log หนักเหล่านี้ต้องการ RAM 4–5 GB (OpenSearch/Elasticsearch heap) ซึ่งจะทำให้ VM คณะ 6 GB เกิด Out-Of-Memory (OOM) ชนกับ POS stack (~3.4 GB) ทันที · เลือกชุดเล็กที่คุมงบ RAM รวมได้ ~832 MB · เข้าถึงผ่าน SSH tunnel แบบเดียวกับ Bull-Board — ไม่เปิดของใหม่ออกอินเทอร์เน็ตบนเครื่องที่มีข้อมูลลูกค้า |

**ข้อที่ตั้งใจให้ต่างจากที่คนมักคาดหวัง:**

* **deploy อัตโนมัติ ไม่มีคนกดอนุมัติ** บน `demo` — เพื่อสาธิต CD ของจริง · production จะเปิดอนุมัติ
* **branch protection ใช้ `status` job ที่รันเสมอ** ต่อ workflow แทน `paths:` ระดับ workflow —
  เพราะ PR ที่แตะแค่ `server/` จะไม่รัน workflow ฝั่ง Flutter เลย ทำให้ required check ค้างตลอดกาล (#39) ·
  ผลพลอยได้: ทุก push ขึ้น `main` ได้ image ครบทั้งสองฝั่งสำหรับ SHA เดียว (ปิด AC4 ของ #40)
* **job integration รันทุก PR ไม่ดู path** — เป็น job ที่ถือ test อ่านข้ามร้าน (กติกา multi-tenant ข้อ 6)
* **TLS self-signed ต่อไป** — ไม่มี DNS name ชี้ VM, Let's Encrypt ไม่ออก cert ให้ IP
* **rollback = deploy SHA ก่อนหน้า ไม่มี down-migration**

## ผลที่ตามมา

* `server/Dockerfile` runtime stage ไม่มี npm/npx, base pin ด้วย digest · `docker-compose.yml` คง `nginx:1.29-alpine` +
  mount conf แต่เพิ่ม volume `web` (เติมโดย one-shot `web-sync` แบบ `certgen`) · เพิ่ม service `etcd` · overlay monitoring แยกไฟล์
* ระหว่าง scrutinize พบบั๊กเดิม: `location /platform/` ใน Nginx ไม่มีทางถูกเรียกถึงเพราะ global prefix `api/v1` — ต้องแก้เป็น `/api/v1/platform/` พร้อม allowlist (07 §9)
* โฟลเดอร์ใหม่ `deploy/` ที่ root (Ansible, overlay, web Dockerfile) — ADR-0011 ยังใช้: repo เดียว
* GitHub Environment `demo` ถือ secret ทั้งหมด (SSH + ค่าใน `server/.env`) · เปิด secret scanning + push protection
* งบ RAM บน VM (6 GB): ต้องใส่ `mem_limit` ให้ etcd (256m) / Prometheus (512m) / Grafana (256m) / node-exporter (64m) ทุกตัว รวม monitoring overlay ~832m อยู่ในงบรวม ~4.2 GB / 6 GB อย่างปลอดภัย ไม่เพิ่ม Wazuh/ELK ที่กิน RAM 4–5 GB จนเสี่ยง OOM คิล Postgres/API

## ยังไม่เคาะ

* **key ใน etcd มีตัวเดียว (`log_level`)** — ค่า rate limit ถูกตัดออกเพราะไม่มีผู้ใช้ (ADR-0006 เก็บโควตาใน `tenants.plan`)
* **maintenance mode ใน etcd** — ต้องมีข้อความไทยหน้าเคาน์เตอร์ใหม่ ซึ่ง `CLAUDE.md` ห้ามแต่งเอง รอร้าน
* **production host** — ยังไม่เลือก (ครบกำหนดก่อน `q4`) · เมื่อเลือก: inventory ที่สอง + required reviewer
* **ชื่อโดเมน** — ถ้ามีเมื่อไร ค่อยเปลี่ยน self-signed เป็น certbot
* **retention ของ image บน GHCR** — ยังไม่ตั้งนโยบายลบ tag เก่า

## Addendum 2026-09-15 — owner round 2 on #240 (E11) + #242

| # | ตัดสิน | ผลกับ ADR นี้ |
|---|---|---|
| #242 | host = VM ของภาค **`mob04`** · **สภาพแวดล้อมเดียว และเป็น production** · ไม่มี demo แยก · cutover ร้านจริงจากนอกมหาวิทยาลัย = เฟสถัดไป | environment ที่ ADR นี้และ `07_CICD_DEPLOY.md` เรียก `demo` คือ production ตัวเดียว (ชื่อ environment ใน GitHub แก้ใน #67) |
| E11 | deploy ด้วย **self-hosted GitHub Actions runner บน `mob04`** · รันเฉพาะ job `deploy` บน `main` ผ่าน protected environment · **ห้ามรัน workflow ของ PR** (repo public) | แทน "Actions → SSH → Ansible" จาก GitHub-hosted runner ซึ่งเข้า VM ในเครือข่ายมหาวิทยาลัยไม่ได้ · Ansible playbook ยังใช้ แต่รันจาก runner บนเครื่องเอง |

รายละเอียด: [`08_PHASE2_SPEC.md §17`](../08_PHASE2_SPEC.md) · ticket #67
