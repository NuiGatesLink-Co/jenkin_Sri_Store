#!/usr/bin/env bash
# Helper script to verify that both server and web release images exist in GHCR (ADR-0013, 07_CICD_DEPLOY.md §6.1).
# Usage: ./deploy/scripts/verify-ghcr-tags.sh <image_tag>
# Returns exit code 0 if both images exist, exit code 1 otherwise.
set -euo pipefail

TAG="${1:-}"

if [[ -z "$TAG" ]]; then
  echo "Usage: $0 <image_tag>" >&2
  exit 1
fi

check_ghcr_tag() {
  local repo="$1"
  local tag="$2"

  echo "Checking GHCR for ${repo}:${tag}..."
  
  # Request anonymous bearer token for the public repository
  local token_resp
  token_resp=$(curl -fsSL --max-time 10 "https://ghcr.io/token?scope=repository:${repo}:pull" 2>/dev/null || echo "")
  
  if [[ -z "$token_resp" ]]; then
    echo "  -> Failed to acquire anonymous token for ${repo}" >&2
    return 1
  fi

  local token
  token=$(echo "$token_resp" | grep -o '"token":"[^"]*' | cut -d'"' -f4)

  if [[ -z "$token" ]]; then
    echo "  -> Extracted empty token for ${repo}" >&2
    return 1
  fi

  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
    -H "Accept: application/vnd.oci.image.index.v1+json" \
    -H "Accept: application/vnd.oci.image.manifest.v1+json" \
    "https://ghcr.io/v2/${repo}/manifests/${tag}" 2>/dev/null || echo "000")

  if [[ "$http_code" == "200" ]]; then
    echo "  -> Found ${repo}:${tag} (HTTP 200)"
    return 0
  else
    echo "  -> Missing ${repo}:${tag} (HTTP ${http_code})"
    return 1
  fi
}

SERVER_REPO="nuimanlp/srisurart-pos-server"
WEB_REPO="nuimanlp/srisurart-pos-web"

if ! check_ghcr_tag "$SERVER_REPO" "$TAG"; then
  echo "Server image ${SERVER_REPO}:${TAG} is not ready on GHCR." >&2
  exit 1
fi

if ! check_ghcr_tag "$WEB_REPO" "$TAG"; then
  echo "Web image ${WEB_REPO}:${TAG} is not ready on GHCR." >&2
  exit 1
fi

echo "Both server and web images for tag '${TAG}' are verified on GHCR."
exit 0
