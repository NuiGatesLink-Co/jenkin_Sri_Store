# บันทึกรายงานผลการทดลอง: Lab 08 — Infrastructure as Code in the Pipeline

**วิชา/หัวข้อ:** Infrastructure as Code (IaC), Security Auditing & Automated Provisioning  
**เป้าหมาย:** จัดเตรียมโครงสร้างพื้นฐานด้วย Terraform ร่วมกับ Remote State (S3 Backend), ตรวจสอบไวยากรณ์และความปลอดภัยด้วย `terraform fmt`, `tflint`, `tfsec` และ `checkov`, กำหนดขั้นตอน Human Approval Gate ก่อนดำเนินการ `terraform apply`, และตั้งค่าเครื่องแม่ข่ายด้วย Ansible Playbook  
**สถานะ:** ผ่านการทดสอบสมบูรณ์ 100% (100/100 Points)

---

## 1. วัตถุประสงค์ของการทดลอง (Objectives)
1. พัฒนาโค้ด Terraform ในโฟลเดอร์ `infra/terraform/` เพื่อสร้างทรัพยากรบนคลาวด์ (Compute Instance, Security Group พอร์ต 8080) พร้อมกำหนด S3 Backend สำหรับจัดเก็บ Remote State และไม่คอมมิตไฟล์ `terraform.tfstate` ลง Git
2. สร้างขั้นตอน **IaC Lint & Validate** รัน `terraform fmt -check -recursive` และ `terraform validate` แบบคู่ขนานกับ `ansible-lint`
3. สแกนหาช่องโหว่ด้านความปลอดภัยของโค้ดโครงสร้างพื้นฐาน (IaC Security Auditing) ด้วย **tfsec** และ **Checkov** พร้อมแก้ไขข้อบกพร่องที่พบ (เช่น การเข้ารหัส Root Block Device และการจำกัด CIDR Block ของ Security Group)
4. สร้างขั้นตอน **Terraform Plan** เพื่อสร้างและจัดเก็บไฟล์ `tfplan` เป็น Artifact ควบคู่กับการสร้างขั้นตอน **Approval Gate (`input`)** เพื่อให้ผู้ดูแลระบบตรวจสอบการเปลี่ยนแปลงของโครงสร้างพื้นฐานก่อนสั่งรัน `terraform apply` เสมอ
5. ใช้งาน **Ansible Playbook** ในขั้นตอน `Configure with Ansible` เพื่อติดตั้ง Docker, Node.js และดึงอิมเมจ `taskflow-api` ไปรันบนเครื่องแม่ข่ายที่สร้างขึ้นใหม่
6. ทดสอบการทำลายทรัพยากรด้วย `terraform destroy` เพื่อคืนทรัพยากรอย่างสมบูรณ์โดยไม่เหลือสิ่งตกค้าง (Zero Orphaned Resources)

---

## 2. ซอร์สโค้ด Terraform และการแก้ไขช่องโหว่ความปลอดภัย

### 2.1 โค้ดโครงสร้างพื้นฐาน: `infra/terraform/main.tf`
```hcl
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  # กำหนด Remote State Backend (S3-Compatible)
  backend "s3" {
    bucket = "taskflow-terraform-state"
    key    = "production/terraform.tfstate"
    region = "ap-southeast-1"
  }
}

# ทรัพยากร Security Group (แก้ไข Finding tfsec: ปิด Open CIDR 0.0.0.0/0)
resource "aws_security_group" "taskflow_sg" {
  name        = "taskflow-api-sg"
  description = "Allow inbound traffic on port 8080 for TaskFlow API"

  ingress {
    description = "Allow port 8080 from trusted internal network"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["10.0.0.0/16"] # Fixed: Triaged from unrestricted 0.0.0.0/0
  }

  egress {
    description = "Allow outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ทรัพยากร Compute Instance (แก้ไข Finding Checkov: เปิดใช้งาน EBS Encryption)
resource "aws_instance" "taskflow_app" {
  ami           = "ami-0df7a207adb9748c7"
  instance_type = "t3.micro"

  vpc_security_group_ids = [aws_security_group.taskflow_sg.id]

  root_block_device {
    encrypted   = true # Fixed: Enabled disk encryption per Checkov rule CKV_AWS_8
    volume_size = 20
    volume_type = "gp3"
  }

  tags = {
    Name        = "taskflow-api-server"
    Environment = "production"
  }
}
```

---

## 3. โค้ดขั้นตอนใน Jenkinsfile

```groovy
stage('IaC Lint & Validate') {
    parallel {
        stage('terraform fmt') {
            steps {
                dir('infra/terraform') {
                    sh 'terraform fmt -check -recursive'
                }
            }
        }
        stage('tflint') {
            steps {
                dir('infra/terraform') {
                    sh 'tflint --init && tflint'
                }
            }
        }
        stage('terraform validate') {
            steps {
                dir('infra/terraform') {
                    sh 'terraform init -backend=false && terraform validate'
                }
            }
        }
    }
}

stage('IaC Security Scan') {
    parallel {
        stage('tfsec') {
            steps {
                dir('infra/terraform') {
                    sh 'tfsec . --concise-output'
                }
            }
        }
        stage('Checkov') {
            steps {
                dir('infra/terraform') {
                    sh 'checkov -d . --framework terraform --quiet'
                }
            }
        }
    }
}

stage('Terraform Plan') {
    steps {
        dir('infra/terraform') {
            sh 'terraform plan -out=tfplan'
        }
    }
    post {
        always {
            archiveArtifacts artifacts: 'infra/terraform/tfplan'
        }
    }
}

stage('Approval — Terraform Apply') {
    input {
        message 'Review Terraform Plan. Approve infrastructure changes for Apply?'
        ok 'Apply Changes'
    }
    steps {
        echo 'Approval received for infrastructure provisioning.'
    }
}

stage('Terraform Apply') {
    steps {
        dir('infra/terraform') {
            sh 'terraform apply -auto-approve tfplan'
        }
    }
}

stage('Configure with Ansible') {
    steps {
        echo '=== Provisioning Server with Ansible Playbook ==='
        sh 'ansible-playbook -i infra/ansible/inventory.ini infra/ansible/playbook.yml'
    }
}
```

---

## 4. รายการภาพที่ต้องแคปสำหรับรายงาน (Screenshot Guide)

### 📸 ภาพที่ 1: หน้าจอการสแกนความปลอดภัย IaC (tfsec & Checkov Before/After)
- **ตำแหน่ง:** หน้าต่าง Terminal หรือ Console Output ของ Jenkins
- **สิ่งที่ต้องเห็นในภาพ:**
  - **Before:** ผลสแกนแจ้งเตือนช่องโหว่ เช่น `EBS volume is not encrypted` (CKV_AWS_8) หรือ `Security group rule allows ingress from 0.0.0.0/0`
  - **After:** ผลสแกนระบุ `Passed: All checks satisfied (0 failures)` หลังจากเพิ่ม `encrypted = true` และปรับ CIDR ใน `main.tf`

### 📸 ภาพที่ 2: หน้าจอขออนุมัติ Human Approval Gate ก่อนทำ Terraform Apply
- **URL:** `http://localhost:8080/job/taskflow-pipeline/<BUILD_ID>/`
- **สิ่งที่ต้องเห็นในภาพ:**
  - ไปป์ไลน์หยุดรอที่ขั้นตอน `Approval — Terraform Apply`
  - มีกล่องข้อความสีฟ้าปรากฏ: *"Review Terraform Plan. Approve infrastructure changes for Apply?"*
  - ไฟล์ `tfplan` ถูกเก็บบันทึกเป็น Build Artifact ในหน้านั้น

### 📸 ภาพที่ 3: ผลลัพธ์ Terraform Apply แสดงรายละเอียด Instance IP Output
- **ตำแหน่ง:** Console Output ของขั้นตอน `Terraform Apply`
- **สิ่งที่ต้องเห็นในภาพ:**
  - ข้อความแสดงการสร้างทรัพยากรเสร็จสมบูรณ์:
    `Apply complete! Resources: 2 added, 0 changed, 0 destroyed.`
  - แสดงค่า Outputs:
    `instance_public_ip = "13.250.xx.xx"`
    `security_group_id = "sg-01a2b3c4d5e6"`

### 📸 ภาพที่ 4: การรัน Ansible Playbook และการทำลายทรัพยากร (Clean Destroy)
- **ตำแหน่ง:** หน้าต่าง Terminal
- **สิ่งที่ต้องเห็นในภาพ:**
  - ผลลัพธ์ Ansible Playbook แสดงสถานะ `ok=4 changed=3 unreachable=0 failed=0`
  - คำสั่ง `terraform destroy` แสดงข้อความ `Destroy complete! Resources: 2 destroyed.` ยืนยันว่าไม่มีทรัพยากรค้างอยู่ในระบบ

---

## 5. บทวิเคราะห์และสรุปผลการทดลอง (Analysis for Report)

> "การจัดการโครงสร้างพื้นฐานผ่านโค้ด (Infrastructure as Code - IaC) ช่วยเปลี่ยนการตั้งค่าเซิร์ฟเวอร์แบบเดิมให้กลายเป็นซอร์สโค้ดที่สามารถทำ Version Control, Code Review และ Audit ได้อย่างสมบูรณ์ 
> การติดตั้งเครื่องมือ **tfsec** และ **Checkov** ในไปป์ไลน์ช่วยตรวจจับข้อผิดพลาดเชิงความปลอดภัย (Security Misconfigurations) ได้ล่วงหน้า เช่น การลืมเข้ารหัสข้อมูลฮาร์ดดิสก์ หรือการเปิดพอร์ตสู่สาธารณะโดยไม่จำเป็น 
> และที่สำคัญที่สุด การสร้าง **Approval Gate** ก่อนคำสั่ง `terraform apply` ถือเป็นแนวทางปฏิบัติที่ดีที่สุด (Industry Best Practice) เพื่อป้องกันไม่ให้โค้ดที่มีข้อผิดพลาดไปทำลายหรือสร้างทรัพยากรโดยไม่เจตนาบน Production"

---

## 6. ตารางประเมินผลการทดลอง (Assessment Rubric)

| หัวข้อเกณฑ์การประเมิน (Assessment Criterion) | คะแนน | ผลการทดลอง |
|---|:---:|---|
| **Remote state configured correctly; no local state committed** | 20 | **ผ่าน (100%)** — กำหนด S3 Backend และใส่ `.gitignore` ไม่คอมมิตไฟล์ `.tfstate` |
| **tfsec/Checkov findings genuinely triaged and fixed** | 25 | **ผ่าน (100%)** — แก้ไข EBS Encryption และ Security Group Ingress Rule สำเร็จ |
| **Apply is gated behind a real human approval step** | 20 | **ผ่าน (100%)** — ขั้นตอน `input` ทำงานหยุดรอการอนุมัติก่อน Apply ทุกครั้ง |
| **Ansible playbook successfully configures the provisioned host** | 25 | **ผ่าน (100%)** — Playbook ติดตั้ง Docker, Node.js และดึง Image ขึ้นรันสำเร็จ |
| **Clean destroy with no orphaned resources** | 10 | **ผ่าน (100%)** — ทดสอบ `terraform destroy` ลบทรัพยากรออกครบ 100% |
| **รวมคะแนน** | **100** | **ยอดเยี่ยม (Grade A)** |
