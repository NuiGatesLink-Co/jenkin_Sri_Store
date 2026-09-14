#!/usr/bin/env bash
# Validation script for deploy/ substrate (ADR-0013, 07_CICD_DEPLOY.md §6).
# Verifies:
# 1. Compose configuration and override merging
# 2. Ansible inventory and playbooks structure
# 3. Playbook syntax check (if ansible-playbook is installed)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "=== 1. Validating Docker Compose Override Merging ==="
IMAGE_TAG="test-sha-validation" \
POS_APP_PASSWORD="dummy_pos_app_password" \
REDIS_PASSWORD="dummy_redis_password" \
POSTGRES_PASSWORD="dummy_postgres_password" \
JWT_PRIVATE_KEY="dummy_private_key" \
JWT_PUBLIC_KEYS='{"dummy":"dummy"}' \
BULL_BOARD_PASSWORD="dummy_bull_board_password" \
ETCD_ROOT_PASSWORD="dummy_etcd_password" \
docker compose -f server/docker-compose.yml -f deploy/compose/vm.override.yml config --quiet

echo "  -> Compose override merges successfully with zero errors."

echo "=== 2. Checking File Existence & Basic Structure ==="
REQUIRED_FILES=(
  "deploy/compose/vm.override.yml"
  "deploy/ansible/ansible.cfg"
  "deploy/ansible/inventory/hosts.ini"
  "deploy/ansible/provision.yml"
  "deploy/ansible/deploy.yml"
)

for file in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: Missing required deploy file: $file" >&2
    exit 1
  fi
  echo "  -> Found $file"
done

echo "=== 3. Ansible Playbook Syntax Check ==="
if command -v ansible-playbook >/dev/null 2>&1; then
  echo "Running ansible-playbook --syntax-check on host..."
  ansible-playbook -i deploy/ansible/inventory/hosts.ini --syntax-check deploy/ansible/provision.yml
  ansible-playbook -i deploy/ansible/inventory/hosts.ini --syntax-check deploy/ansible/deploy.yml
  echo "  -> Ansible syntax check passed."
elif command -v docker >/dev/null 2>&1; then
  echo "ansible-playbook not found on host. Running syntax check in Docker container..."
  docker run --rm -v "$REPO_ROOT:/repo" -w /repo alpine sh -c "
    apk add --no-cache ansible >/dev/null 2>&1 && \
    ansible-playbook -i deploy/ansible/inventory/hosts.ini --syntax-check deploy/ansible/provision.yml deploy/ansible/deploy.yml
  "
  echo "  -> Containerized Ansible syntax check passed."
else
  echo "  -> ansible-playbook and docker not found in PATH (skipping CLI syntax check)."
fi

echo "=== All deploy validations passed successfully! ==="
