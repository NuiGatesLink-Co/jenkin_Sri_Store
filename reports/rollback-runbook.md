# SRE Incident & Rollback Runbook: taskflow-api & taskflow-mobile

**Document Version:** 1.0.0 (Lab 10 Capstone)  
**Target Environment:** Production Kubernetes Cluster (`taskflow`)  
**Scope:** Immediate Incident Response & Rollback Procedures for Deployments

---

## 1. Trigger Conditions for Immediate Rollback

An on-call engineer must initiate an immediate rollback if ANY of the following occurs post-deploy:
- **HTTP 5xx Error Rate > 1%** for 3 consecutive minutes.
- **P95 Latency > 800ms** on critical endpoints (`/health`, `/api/tasks`).
- **Smoke test failure:** Pod CrashLoopBackOff or health check failure on newly deployed pods.
- **Data corruption or schema mismatch** between API and database.

---

## 2. Emergency Rollback Procedures (Step-by-Step)

### Procedure A: Instant Blue/Green Traffic Flip (< 5 seconds)
The production service `taskflow` routes traffic using the `color` selector (`blue` or `green`).

1. **Check Current Active Service Target:**
   ```bash
   kubectl get svc taskflow -o jsonpath='{.spec.selector.color}'
   # Output: green (or blue)
   ```

2. **Flip Traffic Back to Previous Known-Good Color:**
   If current is `green`, switch back to `blue`:
   ```bash
   kubectl patch svc taskflow -p '{"spec":{"selector":{"color":"blue"}}}'
   ```
   If current is `blue`, switch back to `green`:
   ```bash
   kubectl patch svc taskflow -p '{"spec":{"selector":{"color":"green"}}}'
   ```

3. **Verify Traffic Redirection:**
   ```bash
   curl -sf http://taskflow:3000/health
   kubectl get endpoints taskflow
   ```

---

### Procedure B: Kubernetes Deployment Rollback (Standard Rolling Update)
If both color deployments require restoration to the previous revision:

1. **Check Rollout History:**
   ```bash
   kubectl rollout history deployment/taskflow-blue
   kubectl rollout history deployment/taskflow-green
   ```

2. **Undo Deployment to Last Known-Good Replica:**
   ```bash
   kubectl rollout undo deployment/taskflow-blue
   kubectl rollout undo deployment/taskflow-green
   ```

3. **Monitor Rollback Status:**
   ```bash
   kubectl rollout status deployment/taskflow-blue --timeout=60s
   kubectl rollout status deployment/taskflow-green --timeout=60s
   ```

---

### Procedure C: Mobile Client Incident Mitigation (`taskflow-mobile`)
If a faulty mobile release bundle was deployed to app stores:
1. **Feature Flag Kill-Switch:** Disable faulty feature flags via remote config endpoint.
2. **Minimum Supported App Version:** Increase minimum required version on API server (`/api/version`) to prompt users to update.
3. **Emergency Hotfix Release:** Trigger Jenkins Job `taskflow-mobile` on `hotfix/*` branch with incremented patch version.

---

## 3. Post-Incident Verification & Escalation
1. Confirm Prometheus metrics show `jenkins_build_duration_milliseconds` and application errors returned to baseline:
   - Check Grafana dashboard: `http://localhost:3000/d/jenkins-slo-dashboard/`
2. Notify engineering team on Slack channel `#devops-incidents`.
3. File a Post-Mortem issue within 24 hours detailing root cause, time to restore, and preventive action items.
