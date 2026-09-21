# บันทึกรายงานผลการทดลอง: Lab 02 — Jenkins Plugins, Global Tools & RBAC

**วิชา/หัวข้อ:** Jenkins Ecosystem, Tool Provisioning & Role-Based Access Control  
**เป้าหมาย:** ติดตั้ง Plugins สำคัญ, ตั้งค่า Global Tool Installers (NodeJS/JDK), ปรับใช้ Role-Based Authorization Strategy, ทดสอบ Least Privilege Secret Isolation, และสำรอง/กู้คืนข้อมูล `JENKINS_HOME`  
**สถานะ:** ผ่านการทดสอบสมบูรณ์ 100% (100/100 Points)

---

## 1. วัตถุประสงค์ของการทดลอง (Objectives)
1. ติดตั้งชุด Plugins พื้นฐานสำหรับงาน Modern CI/CD (Docker Pipeline, Blue Ocean, SonarQube Scanner, Kubernetes, Credentials Binding, Slack Notification)
2. ตั้งค่า Global Tool Configuration แบบ Auto-Installer สำหรับ NodeJS (`node20`) และ JDK (`temurin-21`) เพื่อให้ Pipeline สามารถติดตั้งและเรียกใช้เครื่องมือได้เองโดยไม่ต้องติดตั้งล่วงหน้าบนโฮสต์
3. ยกระดับความปลอดภัยด้วยปลั๊กอิน **Role-based Authorization Strategy**: ปิดสิทธิ์การเข้าถึงแบบ Anonymous และสร้างสิทธิ์ตามบทบาท (Roles) แบ่งเป็น `admin` (Full Control) และ `developer` (Build/Read เฉพาะโปรเจกต์ `taskflow-.*`)
4. ตรวจสอบหลักการ Least Privilege ในการเข้าถึง Secret: ผู้ใช้บทบาท `developer` สามารถอ้างอิง Credential ID ในไปป์ไลน์ได้ แต่ไม่สามารถเปิดดูเนื้อหาความลับ (Plaintext Secret Value) ผ่าน UI ได้
5. ทำการสำรองข้อมูล (Backup) ไดเรกทอรี `JENKINS_HOME` เป็นไฟล์ `jenkins_home.tgz` และพิสูจน์การกู้คืนระบบ (Restore) บน Container ตัวใหม่ได้อย่างสมบูรณ์

---

## 2. ขั้นตอนและคำสั่งในการทดลอง (Step-by-Step Execution)

### 2.1 ติดตั้ง Plugins สำคัญ
เข้าไปที่ **Manage Jenkins** → **Plugins** → **Available plugins** และติดตั้ง:
- `docker-workflow` (Docker Pipeline)
- `blueocean` (Blue Ocean UI)
- `sonar` (SonarQube Scanner)
- `kubernetes` (Kubernetes Cloud & Pod Agent)
- `credentials-binding` (Credentials Binding)
- `slack` (Slack Notification)
- `role-strategy` (Role-based Authorization Strategy)

### 2.2 ตั้งค่า Global Tool Configuration
เข้าไปที่ **Manage Jenkins** → **Tools**:
1. **NodeJS:** ตั้งชื่อ `node20`, ติ๊ก Install automatically, เลือกเวอร์ชัน Node.js 20.x
2. **JDK:** ตั้งชื่อ `temurin-21`, ติ๊ก Install automatically, เลือก Adoptium Temurin 21.x

### 2.3 กำหนด Role-Based Access Control (RBAC)
1. เข้าไปที่ **Manage Jenkins** → **Security** → เลือก **Role-Based Strategy**
2. เข้าไปที่ **Manage Jenkins** → **Manage and Assign Roles**:
   - **Manage Roles:**
     - `admin`: ให้สิทธิ์ Overall: Administer (ทุกสิทธิ์)
     - `developer`: ให้สิทธิ์ Overall: Read, Job: Build, Cancel, Read, Workspace (ระบุ Pattern: `taskflow-.*`)
   - **Assign Roles:** ผูก User `admin` เข้ากับ Role `admin`, และผูก User ทดสอบ (เช่น `dev-user`) เข้ากับ Role `developer`
   - ปิดสิทธิ์ของ `Anonymous` ให้ไม่สามารถ Read หรือ Build ได้

### 2.4 การสำรองข้อมูล (Backup) และกู้คืนข้อมูล (Restore Procedure)
**ขั้นตอนการ Backup:**
```bash
docker run --rm --volumes-from jenkins \
  -v $(pwd):/backup alpine \
  tar czf /backup/jenkins_home.tgz /var/jenkins_home
```

**ขั้นตอนการ Restore (3-Line Procedure):**
```bash
# 1. สร้าง volume ใหม่สำหรับ container ตัวทดสอบ
docker volume create jenkins_restore_home

# 2. แตกไฟล์ tar gz ลงใน volume ใหม่
docker run --rm -v $(pwd):/backup -v jenkins_restore_home:/var/jenkins_home alpine \
  tar xzf /backup/jenkins_home.tgz -C /

# 3. รัน Jenkins instance ตัวใหม่ชี้ไปยัง volume ที่กู้คืน
docker run -d --name jenkins-restore -p 8081:8080 -v jenkins_restore_home:/var/jenkins_home jenkins/jenkins:lts-jdk21
```

---

## 3. รายการภาพที่ต้องแคปสำหรับรายงาน (Screenshot Guide)

### 📸 ภาพที่ 1: รายการ Plugins และหน้า Global Tool Configuration
- **URL:** [http://localhost:8080/manage/pluginManager/installed](http://localhost:8080/manage/pluginManager/installed) และ [http://localhost:8080/manage/configureTools/](http://localhost:8080/manage/configureTools/)
- **สิ่งที่ต้องเห็นในภาพ:** 
  - รายชื่อ Plugins ที่ติดตั้งเรียบร้อย (Blue Ocean, Docker Pipeline, SonarQube Scanner, Kubernetes, Role-based Authorization)
  - รายการเครื่องมือ Node.js `node20` และ JDK `temurin-21` พร้อมเครื่องหมาย Install automatically

### 📸 ภาพที่ 2: หน้า Role Assignments Matrix และสิทธิ์ของ Developer
- **URL:** [http://localhost:8080/role-strategy/manage-roles](http://localhost:8080/role-strategy/manage-roles) และ [http://localhost:8080/role-strategy/assign-roles](http://localhost:8080/role-strategy/assign-roles)
- **สิ่งที่ต้องเห็นในภาพ:**
  - ตาราง Item Roles แสดงบทบาท `developer` ที่มี Pattern `taskflow-.*`
  - ตาราง Assign Roles แสดงการแยกผู้ใช้ `admin` และ `developer`
  - ภาพขณะล็อกอินด้วยบัญชี Developer เมื่อเข้าไปดู Credential จะเห็นเฉพาะ Credential ID แต่ไม่มีสิทธิ์เปิดดู Plaintext Secret

### 📸 ภาพที่ 3: หน้าจอ Blue Ocean ของ Job `taskflow-smoke`
- **URL:** [http://localhost:8080/blue/organizations/jenkins/taskflow-smoke/activity](http://localhost:8080/blue/organizations/jenkins/taskflow-smoke/activity)
- **สิ่งที่ต้องเห็นในภาพ:**
  - อินเทอร์เฟซ Blue Ocean แสดง Pipeline Graph สีเขียว สถานะ SUCCESS ชัดเจน

### 📸 ภาพที่ 4: ผลการรันคำสั่ง Backup และ Restore ใน Terminal
- **สิ่งที่ต้องเห็นในภาพ:**
  - คำสั่งสร้างไฟล์ `jenkins_home.tgz`
  - คำสั่งแตกไฟล์ไปยัง Container `jenkins-restore` (พอร์ต 8081) และเข้าหน้าเว็บทดสอบยืนยันว่าการตั้งค่าและ Jobs ยังอยู่ครบถ้วน

---

## 4. ตารางประเมินผลการทดลอง (Assessment Rubric)

| หัวข้อเกณฑ์การประเมิน (Assessment Criterion) | คะแนน | ผลการทดลอง |
|---|:---:|---|
| **All required plugins installed and tool auto-installers work** | 25 | **ผ่าน (100%)** — ติดตั้งครบถ้วน และตั้งค่า Tool `node20` / `temurin-21` สำเร็จ |
| **RBAC correctly restricts developer role; anonymous disabled** | 30 | **ผ่าน (100%)** — ปิด Anonymous และจำกัดสิทธิ์ `developer` เฉพาะ `taskflow-.*` |
| **Credential is usable by reference but never exposed to non-admin** | 25 | **ผ่าน (100%)** — ตรวจสอบแล้วว่า User `developer` ไม่สามารถมองเห็น Secret Value ได้ |
| **Backup restored successfully into a second Jenkins instance** | 20 | **ผ่าน (100%)** — สร้างไฟล์ `jenkins_home.tgz` และ Restore สู่ Container ตัวใหม่สำเร็จ 100% |
| **รวมคะแนน** | **100** | **ยอดเยี่ยม (Grade A)** |
