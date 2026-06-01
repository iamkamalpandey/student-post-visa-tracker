#!/usr/bin/env bash
# Hit every public + nav frontend route + every documented backend endpoint.
# Reports HTTP status table for human eyeballing. Re-runnable.
set -u

FE=${FE:-http://localhost:3001}
BE=${BE:-http://localhost:4000/api/v1}
TOKEN_FILE=/tmp/spv_token

login() {
  local body
  body=$(curl -sS -X POST "$BE/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"admin@example.com","password":"ChangeMeNow!2026"}')
  echo "$body" | node -e 'let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{ try { console.log(JSON.parse(d).access_token||"") } catch(e){} })' > "$TOKEN_FILE"
  [ -s "$TOKEN_FILE" ] || { echo "LOGIN_FAILED"; exit 1; }
}

p() {
  local label="$1" url="$2" auth="${3:-}"
  local code
  if [ -n "$auth" ]; then
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$url" -H "Authorization: Bearer $auth")
  else
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$url")
  fi
  printf '  %-44s  %s\n' "$label" "$code"
}

login
TOKEN=$(cat "$TOKEN_FILE")

echo
echo "==== Frontend pages (no auth — Next.js renders the shell) ===="
for route in / login students students/new stages calendar institutions programs imports imports/new exports reports inbox users audit settings reminders commissions breach-incidents dsar; do
  p "/$route" "$FE/$route"
done

echo
echo "==== Backend public endpoints ===="
p "/health/livez"             "$BE/health/livez"
p "/health/readyz"            "$BE/health/readyz"
p "/version"                  "$BE/version"
p "/.well-known/jwks.json"    "http://localhost:4000/.well-known/jwks.json"

echo
echo "==== Backend authed (admin) ===="
for ep in \
  /auth/me \
  /lookups/countries \
  /lookups/currencies \
  /lookups/document-types \
  /lookups/relationship-types \
  /lookups/isced-fields \
  /stages \
  /stages/transitions \
  /students \
  /users \
  /institutions \
  /programs \
  /enrollments \
  /imports/students/template.csv \
  /dashboard/summary \
  /dashboard/expiries \
  /dashboard/sla-breaches \
  /tenants/me \
  /comms/threads \
  /inbox/messages \
  /dsar/dashboard-summary \
  /breach-incidents/dashboard-summary \
  /message-templates \
  /sub-processors \
  /breach-incidents \
  /addresses \
  /sponsors \
  /tags \
  /notes \
  /attribute-definitions \
  /entity-attributes \
  /saved-views \
  ; do
  p "$ep" "$BE$ep" "$TOKEN"
done
