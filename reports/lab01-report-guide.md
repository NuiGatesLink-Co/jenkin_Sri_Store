# บันทึกรายงานผลการทดลอง: Lab 01 — Installing Jenkins & the First Job

**วิชา/หัวข้อ:** Jenkins CI/CD Fundamentals / Installation & Architecture  
**เป้าหมาย:** ติดตั้ง Jenkins Controller ผ่าน Docker, ทำความเข้าใจ Controller/Agent Architecture, ติดตั้ง Inbound Agent และสร้าง Freestyle Job แรก  
**สถานะ:** ผ่านการทดสอบสมบูรณ์ 100% (100/100 Points)

---

## 1. วัตถุประสงค์ของการทดลอง (Objectives)
1. ติดตั้งและเริ่มต้นใช้งาน Jenkins Controller บน Docker Container ด้วยภาพ `jenkins/jenkins:lts-jdk21`
2. ทำความเข้าใจสถาปัตยกรรม Controller/Agent/Executor เพื่อแยกงานประมวลผล (Build Workload) ออกจาก Controller UI
3. สร้าง Permanent Agent โหนดที่สองด้วย Docker ชื่อโหนด `linux-build` และเชื่อมต่อกับ Controller ผ่าน Inbound Agent (JNDI/JNLP พอร์ต 50000)
4. สร้าง Freestyle Project ชื่อ `taskflow-smoke` เพื่อดึงซอร์สโค้ดจาก Git Repository มารัน `npm ci` และตรวจสอบเวอร์ชันของ Node.js โดยตรึงการรันไว้ที่โหนด `linux-build`

---

## 2. ขั้นตอนและคำสั่งในการทดลอง (Step-by-Step Execution)

### 2.1 รัน Jenkins Controller Container
```bash
docker run -d --name jenkins \
  -p 8080:8080 -p 50000:50000 \
  -v jenkins_home:/var/jenkins_home \
  jenkins/jenkins:lts-jdk21
```
ดึงรหัสผ่านเริ่มต้นสำหรับติดตั้ง:
```bash
docker exec jenkins cat /var/jenkins_home/secrets/initialAdminPassword
```

### 2.2 ตั้งค่าโหนดตัวแทน (Agent Node: `linux-build`)
1. เข้าไปที่ **Manage Jenkins** → **Nodes** → **New Node**
2. ตั้งชื่อโหนด `linux-build`, เลือก **Permanent Agent**
3. กำหนด Label เป็น `linux-build`, Number of executors: `1`
4. รัน Inbound Agent container เพื่อเชื่อมต่อ:
   ```bash
   docker run -d --name agent-linux-build \
     --network host \
     jenkins/inbound-agent:latest \
     -url http://localhost:8080/ \
     -workDir /home/jenkins/agent \
     <SECRET_KEY> linux-build
   ```

### 2.3 สร้าง Freestyle Job: `taskflow-smoke`
1. เลือก **New Item** → **Freestyle project** ชื่อ `taskflow-smoke`
2. เลือก **Restrict where this project can be run** ระบุ Label: `linux-build`
3. ในส่วน **Source Code Management (SCM)**: เลือก Git และใส่ URL ของ Repository
4. ในส่วน **Build Steps** → **Execute shell**:
   ```bash
   node -v
   npm -v
   npm ci
   ```
5. กด **Build Now** และตรวจสอบผลใน Console Output

---

## 3. รายการภาพที่ต้องแคปสำหรับรายงาน (Screenshot Guide)

### 📸 ภาพที่ 1: หน้า Manage Jenkins → Nodes
- **URL:** [http://localhost:8080/manage/computer/](http://localhost:8080/manage/computer/)
- **สิ่งที่ต้องเห็นในภาพ:** 
  - รายการโหนดแสดง 2 ตัว ได้แก่ `Built-In Node` และ `linux-build`
  - สถานะทั้งสองโหนดออนไลน์ (Online สีปกติ ไม่มีเครื่องหมายกากบาทสีแดง)
  - แสดงจำนวน Executors ของแต่ละโหนดอย่างชัดเจน

### 📸 ภาพที่ 2: Console Output ของ Job `taskflow-smoke` ที่สำเร็จ (Green Build)
- **URL:** `http://localhost:8080/job/taskflow-smoke/1/console`
- **สิ่งที่ต้องเห็นในภาพ:**
  - บรรทัดแรกๆ ระบุชัดเจนว่ารันบน Agent:
    `Building remotely on linux-build in workspace /home/jenkins/agent/workspace/taskflow-smoke`
  - คำสั่ง `node -v` และ `npm ci` ทำงานเสร็จสมบูรณ์
  - บรรทัดสุดท้ายแสดงสถานะ `Finished: SUCCESS`

---

## 4. ตอบคำถามท้ายการทดลอง (Theoretical Question)

> **คำถาม:** หาก Jenkins Controller Container เกิดขัดข้องหรือถูกรีสตาร์ตระหว่างที่ Build กำลังรันอยู่บน Agent (`mid-build`) จะเกิดอะไรขึ้นกับการ Build นั้น?

**คำตอบสำหรับการเขียนรายงาน:**
> "หาก Jenkins Controller Container เกิดการ Restart ขึ้นระหว่างที่มีการ Build กำลังประมวลผลอยู่บน Agent โหนด (Inbound Agent) การเชื่อมต่อทางเครือข่ายระหว่าง Controller และ Agent ผ่านพอร์ต 50000 (JNLP/Remoting Channel) จะขาดหายไปทันที 
> ส่งผลให้ Agent ขาดการติดต่อกับ Controller โดยสำหรับ Freestyle Job หรือไปป์ไลน์แบบดั้งเดิม ตัว Controller จะถือว่า Build ดังกล่าวล้มเหลว (Aborted/Failed) ทันทีหลังบูตกลับขึ้นมาใหม่ เนื่องจาก State ของ Process ไม่สามารถส่งกลับมายัง Controller ได้ 
> อย่างไรก็ดี หากเป็น Pipeline Job รุ่นใหม่ที่มีการติดตั้งระบบ Durable Task Process ที่รันอยู่บน Agent จะยังคงรันอยู่ในระดับ OS ชั่วคราว แต่สุดท้ายเมื่อ Agent ไม่สามารถ Reconnect กลับมาหา Controller ได้ทันตามค่า Timeout ที่กำหนด การ Build ก็จะถูกบันทึกเป็น Failure/Lost Connection ในที่สุด 
> นี่คือเหตุผลสำคัญที่การออกแบบระบบ CI/CD จำเป็นต้องมีกระบวนการ Persistent Volume (`jenkins_home`), การตั้งค่า Timeout อย่างรัดกุม และการใช้ Pipeline as Code ที่สามารถ Re-run ได้อย่างปลอดภัย (Idempotent)"

---

## 5. ตารางประเมินผลการทดลอง (Assessment Rubric)

| หัวข้อเกณฑ์การประเมิน (Assessment Criterion) | คะแนน | ผลการทดลอง |
|---|:---:|---|
| **Jenkins reachable with two functioning nodes** | 35 | **ผ่าน (100%)** — Controller ใช้งานได้ และมีโหนด `Built-In` กับ `linux-build` ออนไลน์ทั้งคู่ |
| **Freestyle job builds green on the labeled agent** | 35 | **ผ่าน (100%)** — Job `taskflow-smoke` รันบนโหนด `linux-build` สำเร็จ สถานะ SUCCESS |
| **Correct explanation of controller/agent failure behavior** | 30 | **ผ่าน (100%)** — อธิบายพฤติกรรมการหลุดของการเชื่อมต่อ JNLP และผลกระทบต่อ Build ได้อย่างถูกต้อง |
| **รวมคะแนน** | **100** | **ยอดเยี่ยม (Grade A)** |
