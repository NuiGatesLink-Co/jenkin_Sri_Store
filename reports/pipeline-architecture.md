# End-to-End Pipeline Architecture: taskflow-api & taskflow-mobile

**Capstone Project:** Unified Monorepo CI/CD with Kubernetes Dynamic Agents  
**Target Architecture:** Multi-Tier Security, Automated Compliance, and Blue/Green Zero-Downtime Deployment

---

## 1. Unified Architecture Overview

```mermaid
flowchart TD
    subgraph Developer_Workspace [Developer & SCM Layer]
        DEV([Engineer]) -->|git push| GITHUB[(GitHub: main / feature/*)]
    end

    subgraph Jenkins_Master [Jenkins Controller :8080]
        WEBHOOK[SCM Webhook / Polling]
        K8S_CLOUD[Kubernetes Cloud Provider]
        CRED[Jenkins Credentials Store<br/>Secret Text / File]
    end

    subgraph K8s_Build_Farm [Kubernetes Ephemeral Build Farm]
        POD_API[Pod: k8s-node<br/>node:20-alpine + jnlp]
        POD_MOB[Pod: k8s-flutter<br/>flutter:stable + jnlp]
    end

    subgraph API_Pipeline [taskflow-api Execution Stages]
        direction TB
        subgraph P1 [1. Parallel Fast Checks]
            LINT_API[Lint]
            TEST_API[Unit Tests]
            GITLEAKS[Gitleaks Secret Scan]
            SEMGREP[Semgrep SAST]
            NPM_AUDIT[npm audit SCA]
        end
        SBOM_GEN[2. SBOM Generation & Cosign Signing]
        OPA_EVAL[3. OPA Security Policy Gate]
        DOCKER_BLD[4. Build & Push Image commit SHA]
        TRIVY_SCAN[5. Trivy Container Vulnerability Scan]
        IAC_SCAN[6. IaC Lint & Security tfsec/checkov]
        HEALTH_GATE{7. Pipeline Health Gate<br/>Prometheus >= 90%}
        BLUE_GREEN[8. Production Blue/Green Deploy]
    end

    subgraph Mobile_Pipeline [taskflow-mobile Execution Stages]
        direction TB
        FL_LINT[1. Flutter Analyze]
        FL_TEST[2. Flutter Unit & Coverage]
        FL_SCA[3. OSV-Scanner SCA]
        FL_APK[4. Build Debug APK]
        FL_AAB[5. Build & Sign Release AAB via Keystore]
    end

    subgraph Observability_Cluster [Monitoring & Observability]
        PROM[Prometheus :9090]
        GRAF[Grafana :3000]
        SLO_ALERT[SLO Alert: JenkinsQueueBacklog]
    end

    GITHUB --> WEBHOOK
    WEBHOOK --> K8S_CLOUD
    K8S_CLOUD -->|Spawn| POD_API
    K8S_CLOUD -->|Spawn| POD_MOB

    POD_API --> P1 --> SBOM_GEN --> OPA_EVAL --> DOCKER_BLD --> TRIVY_SCAN --> IAC_SCAN --> HEALTH_GATE
    HEALTH_GATE -->|Success Rate >= 90%| BLUE_GREEN
    HEALTH_GATE -.->|Failed < 90%| ABORT([Abort Deploy])

    POD_MOB --> FL_LINT --> FL_TEST --> FL_SCA --> FL_APK --> FL_AAB

    Jenkins_Master -->|Metrics /prometheus| PROM
    PROM --> GRAF
    PROM --> SLO_ALERT
```

---

## 2. Security & Verification Gates Matrix

| Order | Stage / Gate | Tool | Action on Failure |
|:---:|---|---|---|
| **1** | Secrets Detection | Gitleaks | Abort (Fail-Fast) |
| **2** | Static Application Security (SAST) | Semgrep | Archive SARIF, Fail on Critical |
| **3** | Software Composition Analysis (SCA) | npm audit / OSV | Evaluate in Policy Gate |
| **4** | Supply Chain Security & Attestation | Syft & Cosign | Abort if unsigned |
| **5** | Governance Policy Gate | Open Policy Agent (OPA) | Abort if OPA denies |
| **6** | Container Image Vulnerability | Trivy | Block deployment if CRITICAL CVEs |
| **7** | Infrastructure as Code (IaC) | Terraform & tfsec & Checkov | Abort plan if high severity misconfig |
| **8** | Pipeline Health Gate | Prometheus SRE Query | Abort deploy if success rate < 90% |
| **9** | Production Deployment | Kubernetes Blue/Green | Automated rollback to active color on smoke failure |
