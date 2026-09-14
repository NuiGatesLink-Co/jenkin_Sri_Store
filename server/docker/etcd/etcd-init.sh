#!/bin/sh
# Bootstraps etcd's root user + enables RBAC auth, then asserts the ACs directly: root
# authenticates, and an anonymous request is refused (#64, 07_CICD_DEPLOY.md §8).
#
# gcr.io/etcd-development/etcd ships no shell — just the etcd/etcdctl/etcdutl binaries — and
# etcd has no docker-entrypoint-initdb.d-style hook the way ../postgres/init/ has for Postgres,
# so this runs as its own one-shot container with a shell (curlimages/curl), matching the
# `certgen` pattern already used in docker-compose.yml. It drives etcd's v3 gRPC-gateway HTTP
# API directly — the same API RuntimeConfigService (#66) talks to with `fetch`.
#
# Idempotent: re-run against a data volume that is already bootstrapped (a restart, not a
# fresh volume) short-circuits at the first authenticate call and only re-runs the assertion.
set -eu

ENDPOINT="${ETCD_ENDPOINT:-http://etcd:2379}"
AUTH_JSON="{\"name\":\"root\",\"password\":\"$ETCD_ROOT_PASSWORD\"}"

# POST "$1" (path) "$2" (JSON body); prints the HTTP status, leaves the body in $RESP_FILE.
RESP_FILE=/tmp/etcd-init-resp.json
post() {
  curl -sS -o "$RESP_FILE" -w '%{http_code}' -X POST "$ENDPOINT$1" -d "$2"
}

status=$(post /v3/auth/authenticate "$AUTH_JSON")
if [ "$status" != "200" ]; then
  echo "etcd-init: bootstrapping root user + auth (authenticate got HTTP $status)"
  # Each call tolerates "already exists"/"already enabled" (a previous, partially-completed
  # boot) — the closing assertion below is what actually proves the end state, not these.
  post /v3/auth/user/add "{\"name\":\"root\",\"password\":\"$ETCD_ROOT_PASSWORD\"}" >/dev/null || true
  post /v3/auth/role/add '{"name":"root"}' >/dev/null || true
  post /v3/auth/user/grant '{"user":"root","role":"root"}' >/dev/null || true
  post /v3/auth/enable '{}' >/dev/null || true
fi

echo "etcd-init: asserting root authenticates"
status=$(post /v3/auth/authenticate "$AUTH_JSON")
if [ "$status" != "200" ]; then
  echo "etcd-init: FAILED — root cannot authenticate (HTTP $status): $(cat "$RESP_FILE")" >&2
  exit 1
fi

echo "etcd-init: asserting anonymous access is refused"
status=$(post /v3/kv/range '{"key":"Lw=="}') # base64("/") — any key, this is a policy check
if [ "$status" = "200" ]; then
  echo "etcd-init: FAILED — anonymous kv/range succeeded; auth is not enforced" >&2
  exit 1
fi

echo "etcd-init: done — root authenticates, anonymous access refused (HTTP $status)"
