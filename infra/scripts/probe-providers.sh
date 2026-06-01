#!/usr/bin/env bash
# Quick connectivity probe for the providers the backend depends on.
# Usage: bash infra/scripts/probe-providers.sh
#
# Reads the same env vars the application uses. Exits 0 if all probes pass,
# non-zero otherwise. Output is a small table for humans + machine-grep.

set -u
RC=0

probe() {
  local label="$1" cmd="$2"
  if eval "$cmd" >/dev/null 2>&1; then
    printf "%-12s OK\n" "$label"
  else
    printf "%-12s FAIL\n" "$label"
    RC=1
  fi
}

# Postgres
if [[ -n "${DATABASE_URL:-}" ]]; then
  probe "postgres" "psql '$DATABASE_URL' -c 'SELECT 1'"
else
  probe "postgres" "false"
fi

# Redis (optional)
if [[ -n "${REDIS_URL:-}" ]]; then
  if command -v redis-cli >/dev/null; then
    probe "redis" "redis-cli -u '$REDIS_URL' PING"
  else
    probe "redis" "false"
  fi
fi

# ClamAV
probe "clamav" "(echo PING > /dev/tcp/${CLAMAV_HOST:-localhost}/${CLAMAV_PORT:-3310})"

# Object storage
case "${STORAGE_DRIVER:-local}" in
  local) probe "storage" "test -d ${STORAGE_LOCAL_ROOT:-./storage}" ;;
  s3)    probe "storage" "aws s3 ls s3://${S3_BUCKET:-} --max-items 1" ;;
  *)     probe "storage" "false" ;;
esac

exit $RC
