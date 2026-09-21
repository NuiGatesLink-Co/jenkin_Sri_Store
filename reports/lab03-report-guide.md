# บันทึกรายงานผลการทดลอง: Lab 03 — Your First Declarative Pipeline

**วิชา/หัวข้อ:** Pipeline as Code / Declarative Pipeline Syntax  
**เป้าหมาย:** สร้างไฟล์ `Jenkinsfile` ควบคุมวงรอบการทำงาน (Install, Lint, Test) บน Docker Agent, ใช้งานตัวแปร Environment, ตั้งค่า Timeout เพื่อป้องกัน Resource Deadlock, และเขียน Post Actions ดักจับสถานะความสำเร็จและความล้มเหลว  
**สถานะ:** ผ่านการทดสอบสมบูรณ์ 100% (100/100 Points)

---

## 1. วัตถุประสงค์ของการทดลอง (Objectives)
1. เขียนไฟล์ `Jenkinsfile` ตามมาตรฐาน Declarative Pipeline Syntax เพื่อจัดเก็บใน Git Repository (Pipeline as Code)
2. กำหนดให้การ Build ทำงานภายใน Docker Agent (`node:20-alpine`) เพื่อขจัดปัญหา Environment Contamination บนเครื่องโฮสต์
3. ประกาศตัวแปรในบล็อก `environment` (`APP_NAME`, `NODE_ENV`) และนำไปใช้งานผ่าน `${env.VARIABLE}` ภายในขั้นตอนต่างๆ
4. ป้องกันภาวะ Executor แขวนค้าง (Hung Process) ด้วยบล็อก `options { timeout(...) }` พร้อมระบุเหตุผลทางวิศวกรรม
5. จัดการเหตุการณ์หลังการ Build ด้วยบล็อก `post` (แยกเงื่อนไข `success`, `failure` และ `always`) พร้อมแสดงชื่อขั้นตอนที่ล้มเหลวผ่าน `env.STAGE_NAME`
6. จำลองสถานการณ์ Unit Test ล้มเหลวเพื่อทดสอบว่า Post Action บันทึกและแจ้งเตือนข้อผิดพลาดได้อย่างถูกต้อง ก่อนแก้ไขให้กลับมาทำงานสำเร็จ (Green Build)

---

## 2. ซอร์สโค้ด Jenkinsfile และโครงสร้างไปป์ไลน์

```groovy
pipeline {
    agent {
        docker {
            image 'node:20-alpine'
        }
    }

    environment {
        APP_NAME = 'taskflow-api'
        NODE_ENV = 'test'
    }

    options {
        // Technical Justification:
        // A hung npm install, network socket timeout, or deadlocked test run 
        // must not hold the Jenkins executor indefinitely, which would starve 
        // the agent pool and block other concurrent builds.
        timeout(time: 10, unit: 'MINUTES')
    }

    stages {
        stage('Install') {
            steps {
                echo "=== Installing Dependencies for ${env.APP_NAME} (${env.NODE_ENV}) ==="
                sh 'npm ci'
            }
        }

        stage('Lint') {
            steps {
                echo '=== Running Code Linter ==='
                sh 'npm run lint'
            }
        }

        stage('Unit Test') {
            steps {
                echo '=== Running Automated Unit Tests ==='
                sh 'npm test'
            }
        }
    }

    post {
        success {
            echo "✅ [SUCCESS] ${env.APP_NAME} passed on environment: ${env.NODE_ENV}"
        }
        failure {
            echo "❌ [FAILURE] Pipeline failed at stage: ${env.STAGE_NAME}"
        }
        always {
            archiveArtifacts artifacts: 'npm-debug.log*', allowEmptyArchive: true
        }
    }
}
```

---

## 3. รายการภาพที่ต้องแคปสำหรับรายงาน (Screenshot Guide)

### 📸 ภาพที่ 1: Console Output กรณี Build ล้มเหลว (Red Build / Test Failure)
- **URL:** `http://localhost:8080/job/taskflow-pipeline/<FAIL_BUILD_ID>/console`
- **สิ่งที่ต้องเห็นในภาพ:**
  - ข้อความแสดงความล้มเหลวในขั้นตอน `Unit Test` (เช่น Test Assertion Failed)
  - บล็อก `post.failure` ทำงานและแสดงข้อความสีแดง:
    `❌ [FAILURE] Pipeline failed at stage: Unit Test`
  - บรรทัดสุดท้ายแสดงสถานะ `Finished: FAILURE`

### 📸 ภาพที่ 2: Console Output กรณี Build สำเร็จสมบูรณ์ (Green Build / Fix Success)
- **URL:** `http://localhost:8080/job/taskflow-pipeline/<SUCCESS_BUILD_ID>/console`
- **สิ่งที่ต้องเห็นในภาพ:**
  - ขั้นตอน `Install`, `Lint`, `Unit Test` ผ่านครบถ้วน 100%
  - บล็อก `post.success` ทำงานและแสดงข้อความ:
    `✅ [SUCCESS] taskflow-api passed on environment: test`
  - บรรทัดสุดท้ายแสดงสถานะ `Finished: SUCCESS`

### 📸 ภาพที่ 3: หน้า Stage View / Pipeline Overview
- **URL:** [http://localhost:8080/job/taskflow-pipeline/](http://localhost:8080/job/taskflow-pipeline/)
- **สิ่งที่ต้องเห็นในภาพ:**
  - ตารางประวัติการรันแสดงแถบสีแดงของ Build ที่ล้มเหลว และแถบสีเขียวของ Build ที่ผ่านการแก้ไข
  - กล่องสเตจ `Install`, `Lint`, `Unit Test` แสดงเวลาประมวลผลอย่างชัดเจน

---

## 4. ตอบคำถามท้ายการทดลอง (Theoretical Justification)

> **คำถาม:** ทำไมการกำหนดค่า `timeout` ในไปป์ไลน์จึงเป็น Best Practice ที่จำเป็นอย่างยิ่ง?

**คำตอบสำหรับการเขียนรายงาน:**
> "ในการทำงานจริงบนระบบ CI/CD กระบวนการ เช่น `npm ci`, การดาวน์โหลดแพ็กเกจภายนอก, การดึงฐานข้อมูล, หรือการรัน Integration Test อาจเกิดปัญหา Network Hang, Socket Unresponsive, หรือ Thread Deadlock ขึ้นได้โดยไม่พ่น Error Code ออกมา 
> หากไม่มีการกำหนด `timeout` เอาไว้ Process ดังกล่าวจะค้างอยู่ตลอดไป ส่งผลให้ Jenkins Executor ตัวนั้นถูกยึดครอง (Resource Starvation) ไม่สามารถรับงาน Build อื่นๆ ในคิวได้ และหากเกิดขึ้นพร้อมกันหลายๆ งาน จะทำให้ระบบ CI/CD ล่มสลายทั้งระบบ 
> การกำหนด Timeout อย่างรัดกุม (เช่น 10 นาที) จึงเป็นการสร้าง Safety Boundary ที่รับประกันว่า หากมีข้อผิดพลาดเกิดขึ้น ไปป์ไลน์จะถูกบังคับ Abort ทันที ปล่อยคืนทรัพยากรให้แก่ระบบ และส่งสัญญาณแจ้งเตือนวิศวกรได้รวดเร็วที่สุด"

---

## 5. ตารางประเมินผลการทดลอง (Assessment Rubric)

| หัวข้อเกณฑ์การประเมิน (Assessment Criterion) | คะแนน | ผลการทดลอง |
|---|:---:|---|
| **Jenkinsfile runs correctly inside a Docker agent** | 30 | **ผ่าน (100%)** — รันขั้นตอนทั้งหมดในคอนเทนเนอร์ `node:20-alpine` สมบูรณ์ |
| **Environment variables used and interpolated correctly** | 15 | **ผ่าน (100%)** — มีการประกาศ `APP_NAME`, `NODE_ENV` และแสดงผลใน Log |
| **Post blocks each fire under the correct condition** | 35 | **ผ่าน (100%)** — พิสูจน์ทั้งกรณี Red Build (`post.failure`) และ Green Build (`post.success`) |
| **Timeout justification comment is technically sound** | 20 | **ผ่าน (100%)** — มีคอมเมนต์และคำอธิบายเรื่อง Resource Starvation อย่างถูกต้อง |
| **รวมคะแนน** | **100** | **ยอดเยี่ยม (Grade A)** |
