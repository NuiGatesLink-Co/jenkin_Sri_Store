pipeline {
    agent {
        node {
            label 'linux-build'
        }
    }

    environment {
        APP_NAME = 'taskflow-api'
        NODE_ENV = 'test'
    }

    options {
        // A hung npm install or test run must not hold the executor forever
        timeout(time: 10, unit: 'MINUTES')
    }

    stages {
        stage('Secrets Detection') {
            steps {
                echo '=== Running Secrets Detection (Gitleaks) ==='
                sh 'gitleaks detect --source=. --log-opts="HEAD" --verbose --report-path=gitleaks-report.json --exit-code 1'
            }
            post {
                always {
                    archiveArtifacts artifacts: 'gitleaks-report.json', allowEmptyArchive: true
                }
            }
        }

        stage('SAST — Semgrep') {
            steps {
                echo '=== Running SAST Analysis (Semgrep) ==='
                sh 'semgrep scan --config=p/owasp-top-ten --config=p/nodejs --sarif --output=semgrep.sarif || true'
            }
            post {
                always {
                    archiveArtifacts artifacts: 'semgrep.sarif', allowEmptyArchive: true
                }
            }
        }

        stage('SCA — npm audit') {
            steps {
                dir('server') {
                    echo '=== Running SCA (npm audit) ==='
                    script {
                        sh 'npm audit --audit-level=high --json > audit.json || true'
                        def critical = sh(
                            script: "jq '.metadata.vulnerabilities.critical // 0' audit.json",
                            returnStdout: true
                        ).trim().toInteger()
                        echo "SCA completed with ${critical} critical vulnerabilities (policy enforcement evaluated in Policy Gate stage)"
                    }
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: 'server/audit.json', allowEmptyArchive: true
                }
            }
        }

        stage('Generate & Sign SBOM') {
            steps {
                echo '=== Generating and Signing CycloneDX SBOM ==='
                sh '''
                    # Generate CycloneDX SBOM for taskflow-api using Syft
                    syft scan dir:server -o cyclonedx-json=taskflow-api.cdx.json

                    # Generate local keypair if not exists
                    if [ ! -f cosign.key ]; then
                        COSIGN_PASSWORD="" cosign generate-key-pair
                    fi

                    # Sign the SBOM using Cosign
                    COSIGN_PASSWORD="" cosign sign-blob --key cosign.key --output-signature taskflow-api.cdx.json.sig --tlog-upload=false taskflow-api.cdx.json
                '''
            }
            post {
                always {
                    archiveArtifacts artifacts: 'taskflow-api.cdx.json, taskflow-api.cdx.json.sig', allowEmptyArchive: true
                }
            }
        }

        stage('Policy Gate — OPA') {
            steps {
                echo '=== Evaluating Security Policy with OPA ==='
                sh '''
                    opa eval --data policy/security.rego --input server/audit.json "data.security.allow" --format pretty > opa-decision.txt
                    cat opa-decision.txt
                    if grep -q "false" opa-decision.txt; then
                        echo "❌ Build denied by OPA security policy!"
                        opa eval --data policy/security.rego --input server/audit.json "data.security.deny" --format pretty
                        exit 1
                    fi
                    echo "✅ OPA security policy passed: Build allowed"
                '''
            }
            post {
                always {
                    archiveArtifacts artifacts: 'opa-decision.txt, policy/security.rego', allowEmptyArchive: true
                }
            }
        }

        stage('Install') {
            steps {
                dir('server') {
                    echo "=== Installing Dependencies for ${APP_NAME} (${NODE_ENV}) ==="
                    sh 'npm install --package-lock-only --legacy-peer-deps --no-audit'
                    sh 'npm ci --legacy-peer-deps'
                }
            }
        }

        stage('Lint') {
            steps {
                dir('server') {
                    echo "=== Running Linter for ${APP_NAME} ==="
                    sh 'npm run lint || true'
                }
            }
        }

        stage('Unit Test') {
            steps {
                dir('server') {
                    echo "=== Running Unit Tests ==="
                    sh 'npm test'
                }
            }
        }

        stage('SonarQube Analysis') {
            steps {
                withSonarQubeEnv('SonarQube') {
                    sh 'sonar-scanner -Dsonar.projectKey=taskflow-api'
                }
            }
        }

        stage('Quality Gate') {
            steps {
                timeout(time: 5, unit: 'MINUTES') {
                    waitForQualityGate abortPipeline: true
                }
            }
        }

        stage('Playwright E2E Tests') {
            steps {
                dir('server') {
                    echo "=== Running Playwright E2E Tests (list, create, mark done) ==="
                    sh 'npx -y playwright test'
                }
            }
            post {
                always {
                    publishHTML target: [
                        allowMissing: false,
                        alwaysLinkToLastBuild: true,
                        keepAll: true,
                        reportDir: 'server/playwright-report',
                        reportFiles: 'index.html',
                        reportName: 'Playwright E2E Report'
                    ]
                }
            }
        }

        stage('Build Image') {
            steps {
                echo '=== Building and Pushing Docker Image ==='
                script {
                    def commitHash = env.GIT_COMMIT ? env.GIT_COMMIT.take(7) : sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    def imageName = "${env.APP_NAME}:${commitHash}"
                    def registryImage = "localhost:5001/${imageName}"

                    echo "Building Docker image: ${imageName} (never latest)"
                    sh "docker build -t ${imageName} -t ${registryImage} server/"

                    echo "Pushing image to local registry: ${registryImage}"
                    sh "docker push ${registryImage}"
                }
            }
        }

        stage('Container Scan — Trivy') {
            steps {
                echo '=== Scanning Docker Image with Trivy ==='
                script {
                    def commitHash = env.GIT_COMMIT ? env.GIT_COMMIT.take(7) : sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    def imageName = "${env.APP_NAME}:${commitHash}"

                    echo "Scanning image: ${imageName} for HIGH and CRITICAL vulnerabilities"
                    sh "trivy image --exit-code 1 --severity HIGH,CRITICAL --format sarif --output trivy-report.sarif ${imageName}"
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: 'trivy-report.sarif', allowEmptyArchive: true
                }
            }
        }

        stage('Deploy — Staging') {
            when {
                branch 'develop'
            }
            steps {
                echo '=== Deploying to Staging Server ==='
                sh 'echo deploying to staging...'
            }
        }

        stage('Deploy — Production (Blue/Green)') {
            when {
                beforeInput true
                branch 'main'
            }
            input {
                message 'Deploy to production (Blue/Green)?'
            }
            steps {
                echo '=== Running Blue/Green Deployment on Kubernetes ==='
                script {
                    def current = sh(
                        script: "kubectl get svc taskflow -o jsonpath='{.spec.selector.color}'",
                        returnStdout: true
                    ).trim()
                    def next = current == 'blue' ? 'green' : 'blue'
                    echo "Current active color: ${current} -> Deploying to: ${next}"

                    def commitHash = env.GIT_COMMIT ? env.GIT_COMMIT.take(7) : sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    def nextImage = "localhost:5001/${env.APP_NAME}:${commitHash}"

                    echo "Updating deployment/taskflow-${next} with image: ${nextImage}"
                    sh "kubectl set image deployment/taskflow-${next} app=${nextImage}"
                    sh "kubectl rollout status deployment/taskflow-${next} --timeout=120s"

                    // smoke test the new pods directly, bypassing the Service
                    echo "Smoke testing taskflow-${next} directly before switching traffic..."
                    sh "kubectl run smoke-${BUILD_NUMBER} --rm -i --restart=Never --image=curlimages/curl -- curl -sf http://taskflow-${next}:8080/health"

                    echo "Smoke test passed! Switching service traffic to ${next}"
                    sh "kubectl patch svc taskflow -p '{\"spec\":{\"selector\":{\"color\":\"${next}\"}}}'"
                    echo "✅ Successfully switched traffic from ${current} to ${next}"
                }
            }
            post {
                failure {
                    script {
                        echo "❌ Deployment/Smoke test failed! Performing automated rollback..."
                        def activeColor = sh(
                            script: "kubectl get svc taskflow -o jsonpath='{.spec.selector.color}'",
                            returnStdout: true
                        ).trim()
                        echo "Automated rollback: Restoring/Keeping traffic on ${activeColor}"
                        sh "kubectl patch svc taskflow -p '{\"spec\":{\"selector\":{\"color\":\"${activeColor}\"}}}'"
                    }
                }
            }
        }

    }

    post {
        success {
            echo "✅ ${env.APP_NAME} passed on ${env.NODE_ENV}"
        }
        failure {
            echo "❌ Failed at stage: ${env.STAGE_NAME}"
        }
        always {
            dir('server') {
                junit testResults: 'reports/*.xml', allowEmptyResults: true
                publishCoverage adapters: [coberturaReportAdapter('coverage/cobertura-coverage.xml')]
            }
            archiveArtifacts artifacts: 'server/playwright-report/**, npm-debug.log*', allowEmptyArchive: true
        }
    }
}
