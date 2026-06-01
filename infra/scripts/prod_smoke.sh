#!/usr/bin/env bash
# Production smoke test — runs against any environment via API base URL.
# Exits non-zero on the first failure with a clear "what to look at" message.
# Use after every deploy; wire to a deploy-success gate.
#
# Usage:
#   API=https://api.example.com EMAIL=admin@example.com PASSWORD=… ./prod_smoke.sh
#
# Requires: curl, jq.

set -uo pipefail

API=${API:-http://localhost:4000}
EMAIL=${EMAIL:-admin@example.com}
PASSWORD=${PASSWORD:-}

if [ -z "$PASSWORD" ]; then
  echo "[FAIL] PASSWORD not set. Pass it via env: PASSWORD=… $0" >&2
  exit 1
fi

PASS=0
FAIL=0

check() {
  local label="$1" code="$2" want="$3"
  if [ "$code" = "$want" ]; then
    printf '  \033[32m✓\033[0m %-50s %s\n' "$label" "$code"
    PASS=$((PASS + 1))
  else
    printf '  \033[31m✗\033[0m %-50s got=%s want=%s\n' "$label" "$code" "$want"
    FAIL=$((FAIL + 1))
  fi
}

probe() {
  local label="$1" url="$2" auth="${3:-}" want="${4:-200}"
  local code
  if [ -n "$auth" ]; then
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$url" -H "Authorization: Bearer $auth")
  else
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$url")
  fi
  check "$label" "$code" "$want"
}

probe_field() {
  local label="$1" url="$2" auth="$3" jq_filter="$4"
  local body
  body=$(curl -sS "$url" -H "Authorization: Bearer $auth")
  local value
  value=$(echo "$body" | jq -r "$jq_filter")
  if [ "$value" = "null" ] || [ -z "$value" ]; then
    printf '  \033[31m✗\033[0m %-50s missing field %s\n' "$label" "$jq_filter"
    FAIL=$((FAIL + 1))
  else
    printf '  \033[32m✓\033[0m %-50s %s=%s\n' "$label" "$jq_filter" "$value"
    PASS=$((PASS + 1))
  fi
}

echo
echo "==== Public health ===="
probe "/health/livez"             "$API/api/v1/health/livez"
probe "/health/readyz"            "$API/api/v1/health/readyz"
probe "/version"                  "$API/api/v1/version"
probe "/.well-known/jwks.json"    "$API/.well-known/jwks.json"

echo
echo "==== Auth ===="
TOKEN=$(curl -sS -X POST "$API/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | jq -r '.access_token // empty')

if [ -z "$TOKEN" ]; then
  echo "  \033[31m✗\033[0m login failed — bad credentials or server unreachable" >&2
  FAIL=$((FAIL + 1))
  echo
  echo "==== Result ===="
  printf '  Passed: %d   Failed: %d\n' "$PASS" "$FAIL"
  exit 1
fi
printf '  \033[32m✓\033[0m login succeeded (token len=%d)\n' "${#TOKEN}"
PASS=$((PASS + 1))

probe "/auth/me"                  "$API/api/v1/auth/me" "$TOKEN"

echo
echo "==== Lookups (cheap reads) ===="
probe "/lookups/countries"        "$API/api/v1/lookups/countries"        "$TOKEN"
probe "/lookups/currencies"       "$API/api/v1/lookups/currencies"       "$TOKEN"
probe "/stages"                   "$API/api/v1/stages"                   "$TOKEN"
probe "/tenants/me"               "$API/api/v1/tenants/me"               "$TOKEN"

echo
echo "==== Dashboards (admin) ===="
probe "/dashboard/summary"                  "$API/api/v1/dashboard/summary"                  "$TOKEN"
probe "/dashboard/expiries"                 "$API/api/v1/dashboard/expiries"                 "$TOKEN"
probe "/dashboard/sla-breaches"             "$API/api/v1/dashboard/sla-breaches"             "$TOKEN"
probe "/breach-incidents/dashboard-summary" "$API/api/v1/breach-incidents/dashboard-summary" "$TOKEN"
probe "/dsar/dashboard-summary"             "$API/api/v1/dsar/dashboard-summary"             "$TOKEN"

echo
echo "==== Comms + inbox ===="
probe "/comms/threads"            "$API/api/v1/comms/threads"          "$TOKEN"
probe "/inbox/messages"           "$API/api/v1/inbox/messages"         "$TOKEN"

echo
echo "==== Audit ===="
probe       "/audit-logs"          "$API/api/v1/audit-logs"            "$TOKEN"
probe_field "/audit-logs/verify"   "$API/api/v1/audit-logs/verify"     "$TOKEN" '.data.broken_count'

echo
echo "==== Result ===="
printf '  Passed: %d   Failed: %d\n' "$PASS" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo "  Smoke FAILED — block the deploy or roll back." >&2
  exit 1
fi
echo "  All smoke checks passed."
