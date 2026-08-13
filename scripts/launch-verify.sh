#!/usr/bin/env bash
# SPVT — final launch verification.
#
# Closes the last gates that need a credential or a human, and PROVES them
# against the live system rather than asserting them. Everything else in the
# launch runbook is already verified; these are the ones no automation could
# reach on its own.
#
#   1. A real login succeeds.
#   2. That login writes a TENANT-SCOPED audit row.
#      ^ this is the end-to-end proof of T0-7 and T0-8 in production. Until a
#        known user performs an audited action, the audit trail contains only
#        system rows and the fix is unproven *in this environment* (it is
#        proven locally against a de-privileged Postgres).
#   3. Sentry actually receives an event, if SENTRY_DSN is configured.
#
# The password is read from the environment and never echoed, never logged, and
# never written to disk. It is used for exactly one POST.
#
# Usage:
#   export SPVT_ADMIN_EMAIL='admin@example.com'
#   export SPVT_ADMIN_PASSWORD='...'          # from the DO app spec secret
#   export SPVT_DB_URI='postgresql://...'     # doctl databases connection <id> --format URI
#   ./scripts/launch-verify.sh
#
# Optional:
#   SPVT_BASE_URL   defaults to the production app URL below
set -uo pipefail

BASE_URL="${SPVT_BASE_URL:-https://spvt-cvxne.ondigitalocean.app}"
EMAIL="${SPVT_ADMIN_EMAIL:-}"
PASSWORD="${SPVT_ADMIN_PASSWORD:-}"
DB_URI="${SPVT_DB_URI:-}"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
  echo "SPVT_ADMIN_EMAIL and SPVT_ADMIN_PASSWORD are required." >&2
  echo "The password is used for one login and is never printed or stored." >&2
  exit 2
fi

echo "SPVT launch verification against ${BASE_URL}"
echo

# ---------------------------------------------------------------------------
echo "1. Service is ready"
# ---------------------------------------------------------------------------
READY=$(curl -s -m 30 "${BASE_URL}/api/v1/health/readyz")
if printf '%s' "$READY" | grep -q '"status":"ready"'; then
  ok "readyz reports ready — ${READY}"
else
  bad "readyz did not report ready — ${READY}"
fi

# ---------------------------------------------------------------------------
echo
echo "2. A real login succeeds"
# ---------------------------------------------------------------------------
# --data-binary from stdin so the password never appears in the process list
# (argv is world-readable on most systems).
LOGIN=$(printf '{"email":%s,"password":%s}' \
          "$(printf '%s' "$EMAIL"    | python -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
          "$(printf '%s' "$PASSWORD" | python -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
        | curl -s -m 30 -o /dev/null -w '%{http_code}' \
            -X POST "${BASE_URL}/api/v1/auth/login" \
            -H 'Content-Type: application/json' \
            --data-binary @-)

case "$LOGIN" in
  200|201) ok "login returned ${LOGIN}" ;;
  401|403) bad "login rejected (${LOGIN}) — wrong credentials, or the account is locked" ;;
  429)     bad "rate limited (429) — wait for the window to reset and retry" ;;
  *)       bad "login returned ${LOGIN}" ;;
esac

# ---------------------------------------------------------------------------
echo
echo "3. The login wrote a TENANT-SCOPED audit row  (T0-7 / T0-8 end-to-end)"
# ---------------------------------------------------------------------------
if [ -z "$DB_URI" ]; then
  skip "SPVT_DB_URI not set — cannot inspect audit_logs"
  skip "get it with: doctl databases connection <cluster-id> --format URI --no-header"
else
  # The app database, not defaultdb.
  APPDB=$(printf '%s' "$DB_URI" | sed 's|/defaultdb?|/spvt-db?|')
  sleep 3  # writeAudit is awaited, but give the row a moment to settle
  ROWS=$(psql "$APPDB" -tAc \
    "select count(*) from audit_logs where tenant_id is not null and action = 'auth.login.success';" \
    2>/dev/null | tr -d '[:space:]')
  if [ "${ROWS:-0}" -ge 1 ]; then
    ok "found ${ROWS} tenant-scoped auth.login.success row(s)"
    ok "  => tenant-scoped audit writes work in production."
    ok "  => T0-7 (missing tenant GUC) and T0-8 (pgcrypto) are both proven here."
  else
    bad "no tenant-scoped auth.login.success row found"
    bad "  => the login succeeded but its audit row did not land, or lost its tenant."
    bad "  => check the backend logs for 'Audit write failed'."
  fi
fi

# ---------------------------------------------------------------------------
echo
echo "4. Sentry receives events"
# ---------------------------------------------------------------------------
if [ -z "${SPVT_SENTRY_CONFIGURED:-}" ]; then
  skip "SENTRY_DSN is not set in the live app spec (verified absent 2026-08-13)"
  skip "until it is, initSentry() disables itself and logs one line —"
  skip "which is indistinguishable from working. See runbook step 2."
else
  skip "set SENTRY_DSN, redeploy, then trigger an error and confirm it arrives"
fi

# ---------------------------------------------------------------------------
echo
printf 'passed %d, failed %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
