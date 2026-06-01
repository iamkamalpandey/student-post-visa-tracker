#!/usr/bin/env bash
# SVT-AUDIT-OPS-2026-05 — DB restore-drill.
#
# Spins up a throwaway PostgreSQL DB, loads a pg_dump from staging/prod,
# runs `prisma migrate deploy` against it, then runs `audit_logs_verify`
# to prove the chain restored cleanly. Drops the throwaway DB at the end.
#
# Required envs (see infra/docs/runbooks/db-restore.md):
#   DUMP_SRC                  Path to a *.sql.gz produced by pg_dump.
#   PG_OWNER_URL              postgres://owner:pw@host:port/postgres   (owner role; creates DB)
#   THROWAWAY_DB_NAME         e.g. spv_restore_drill_2026_05_18
#
# Usage:
#   DUMP_SRC=./backups/spv_prod_2026_05_18.sql.gz \
#   PG_OWNER_URL='postgres://spv:secret@localhost:7654/postgres' \
#   THROWAWAY_DB_NAME=spv_restore_drill \
#   bash infra/scripts/restore_drill.sh

set -uo pipefail

DUMP_SRC=${DUMP_SRC:-}
PG_OWNER_URL=${PG_OWNER_URL:-}
THROWAWAY_DB_NAME=${THROWAWAY_DB_NAME:-spv_restore_drill}

if [ -z "$DUMP_SRC" ] || [ -z "$PG_OWNER_URL" ]; then
  echo "ERROR: DUMP_SRC and PG_OWNER_URL are required." >&2
  exit 1
fi
if [ ! -f "$DUMP_SRC" ]; then
  echo "ERROR: dump file not found: $DUMP_SRC" >&2
  exit 1
fi

# Parse the URL host/port — used by pg_isready + psql client.
HOST=$(echo "$PG_OWNER_URL" | sed -E 's|.*@([^:/]+).*|\1|')
PORT=$(echo "$PG_OWNER_URL" | sed -E 's|.*:([0-9]+)/.*|\1|')

PASS=0
FAIL=0

step() {
  local label="$1"; shift
  printf '\n==> %s\n' "$label"
  if "$@"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  ✗ step failed: $label" >&2
  fi
}

cleanup() {
  echo
  echo "==> Dropping throwaway DB $THROWAWAY_DB_NAME (best-effort)"
  psql "$PG_OWNER_URL" -v ON_ERROR_STOP=1 -c \
    "DROP DATABASE IF EXISTS \"$THROWAWAY_DB_NAME\" WITH (FORCE);" >/dev/null 2>&1 || true
}
trap cleanup EXIT

create_db() {
  psql "$PG_OWNER_URL" -v ON_ERROR_STOP=1 -c \
    "CREATE DATABASE \"$THROWAWAY_DB_NAME\";"
}

load_dump() {
  local target_url
  target_url=$(echo "$PG_OWNER_URL" | sed -E "s|/[^/?]+(\?|$)|/$THROWAWAY_DB_NAME\1|")
  if [[ "$DUMP_SRC" == *.gz ]]; then
    gunzip -c "$DUMP_SRC" | psql "$target_url" -v ON_ERROR_STOP=1 >/dev/null
  else
    psql "$target_url" -v ON_ERROR_STOP=1 -f "$DUMP_SRC" >/dev/null
  fi
}

run_migrations() {
  local target_url
  target_url=$(echo "$PG_OWNER_URL" | sed -E "s|/[^/?]+(\?|$)|/$THROWAWAY_DB_NAME\1|")
  pushd "$(dirname "$0")/../../apps/backend" >/dev/null
  DATABASE_URL="$target_url" DATABASE_MIGRATE_URL="$target_url" \
    pnpm exec prisma migrate deploy
  popd >/dev/null
}

verify_row_counts() {
  local target_url
  target_url=$(echo "$PG_OWNER_URL" | sed -E "s|/[^/?]+(\?|$)|/$THROWAWAY_DB_NAME\1|")
  psql "$target_url" -At -c "
    SELECT 'tenants=' || count(*) FROM tenants;
    SELECT 'students=' || count(*) FROM students;
    SELECT 'audit_logs=' || count(*) FROM audit_logs;
    SELECT 'enrollments=' || count(*) FROM enrollments;
  "
}

verify_audit_chain() {
  local target_url
  target_url=$(echo "$PG_OWNER_URL" | sed -E "s|/[^/?]+(\?|$)|/$THROWAWAY_DB_NAME\1|")
  local broken_total=0
  while IFS= read -r tenant_id; do
    [ -z "$tenant_id" ] && continue
    local broken
    broken=$(psql "$target_url" -At -c \
      "SELECT count(*) FROM audit_logs_verify('${tenant_id}'::uuid);" || echo "ERROR")
    if [ "$broken" = "ERROR" ]; then
      echo "  audit_logs_verify failed for tenant $tenant_id" >&2
      return 1
    fi
    broken_total=$((broken_total + broken))
    if [ "$broken" -gt 0 ]; then
      echo "  ✗ tenant $tenant_id has $broken broken audit rows" >&2
    fi
  done < <(psql "$target_url" -At -c "SELECT id FROM tenants;")
  if [ "$broken_total" -ne 0 ]; then
    echo "  ✗ total broken audit rows across tenants: $broken_total" >&2
    return 1
  fi
  echo "  ✓ audit chain intact across all tenants (0 broken)"
  return 0
}

step "Postgres reachable ($HOST:$PORT)"   pg_isready -h "$HOST" -p "$PORT" -t 5 -q
step "Create throwaway DB"                 create_db
step "Load dump"                           load_dump
step "Run prisma migrate deploy"           run_migrations
step "Verify row counts"                   verify_row_counts
step "Verify audit hash chain"             verify_audit_chain

echo
printf 'Result: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "Restore drill FAILED."
  exit 1
fi
echo "Restore drill OK."
