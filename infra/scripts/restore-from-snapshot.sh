#!/usr/bin/env bash
# SVT-AUDIT-OPS-2026-05 — Restore a pg_dump snapshot produced by backup-snapshot.sh.
#
# Downloads the snapshot, decrypts if `.age`, and runs pg_restore against
# $DATABASE_URL (in restore-clean mode: -c -Fc --no-owner --no-acl).
#
# See infra/docs/runbooks/db-backup-restore.md for the wider procedure.
#
# Usage:
#   restore-from-snapshot.sh <snapshot-url>
#
#   <snapshot-url> may be:
#     - s3://bucket/key   (downloaded via `aws s3 cp` or `rclone copyto`)
#     - https://...       (downloaded via curl)
#     - /local/path       (used as-is)
#
# Required env:
#   DATABASE_URL              Target Postgres. MUST point at a throwaway / empty
#                             database — `pg_restore -c` drops objects.
#
# Optional env:
#   BACKUP_S3_TOOL            'aws' (default) or 'rclone'.
#   BACKUP_RCLONE_REMOTE      rclone remote name (default 's3').
#   BACKUP_AGE_IDENTITY       Path to age identity file (for .age snapshots).
#                             If unset and snapshot is .age, the script errors.
#   PGRESTORE_EXTRA_ARGS      Extra args appended to pg_restore.
#   KEEP_DOWNLOAD             If set, the temp download is not deleted on exit.
#
# Exit codes:
#   0 success.
#   non-zero on any failure.
#
# CAUTION: never run this against the production DATABASE_URL. The script
# refuses if DATABASE_URL contains literal substring 'prod' unless
# ALLOW_PROD_RESTORE=1 is set (a deliberate, audited override).

set -euo pipefail

log() { printf '[restore-from-snapshot %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { printf '[restore-from-snapshot %s] ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

# ----- Args / env ------------------------------------------------------------
SOURCE="${1:-}"
[ -n "$SOURCE" ] || die "Usage: $0 <snapshot-url>  (s3://… | https://… | /local/path)"

: "${DATABASE_URL:?DATABASE_URL is required (point at THROWAWAY/EMPTY DB)}"

if [[ "$DATABASE_URL" == *prod* ]] && [ "${ALLOW_PROD_RESTORE:-0}" != "1" ]; then
  die "Refusing: DATABASE_URL looks like production ('prod' in URL). Set ALLOW_PROD_RESTORE=1 to override."
fi

TOOL="${BACKUP_S3_TOOL:-aws}"
RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-s3}"

command -v pg_restore >/dev/null 2>&1 || die "pg_restore not on PATH"

# ----- Download to a temp file ----------------------------------------------
TMPDIR_LOCAL=$(mktemp -d -t svt-restore-XXXXXX)
trap 'if [ -z "${KEEP_DOWNLOAD:-}" ]; then rm -rf "$TMPDIR_LOCAL"; else log "KEEP_DOWNLOAD=1 — retaining $TMPDIR_LOCAL"; fi' EXIT

case "$SOURCE" in
  s3://*)
    BUCKET=${SOURCE#s3://}
    KEY=${BUCKET#*/}
    BUCKET=${BUCKET%%/*}
    BASENAME=$(basename "$KEY")
    LOCAL="$TMPDIR_LOCAL/$BASENAME"
    log "Downloading $SOURCE -> $LOCAL via $TOOL"
    case "$TOOL" in
      aws)    aws s3 cp "$SOURCE" "$LOCAL" ;;
      rclone) rclone copyto "${RCLONE_REMOTE}:${BUCKET}/${KEY}" "$LOCAL" ;;
      *)      die "Unknown BACKUP_S3_TOOL='$TOOL'" ;;
    esac
    ;;
  http://*|https://*)
    BASENAME=$(basename "$SOURCE")
    LOCAL="$TMPDIR_LOCAL/$BASENAME"
    log "Downloading $SOURCE -> $LOCAL via curl"
    command -v curl >/dev/null 2>&1 || die "curl not on PATH"
    curl --fail --location --silent --show-error --output "$LOCAL" "$SOURCE"
    ;;
  /*|./*|../*)
    [ -f "$SOURCE" ] || die "Local snapshot not found: $SOURCE"
    LOCAL="$SOURCE"
    log "Using local snapshot: $LOCAL"
    ;;
  *)
    die "Unrecognised snapshot scheme: $SOURCE"
    ;;
esac

# ----- Decrypt if .age -------------------------------------------------------
RESTORE_INPUT="$LOCAL"
case "$LOCAL" in
  *.age)
    : "${BACKUP_AGE_IDENTITY:?BACKUP_AGE_IDENTITY (path to age identity) required for .age snapshots}"
    command -v age >/dev/null 2>&1 || die "'age' not on PATH but snapshot is .age"
    [ -f "$BACKUP_AGE_IDENTITY" ] || die "BACKUP_AGE_IDENTITY file not found: $BACKUP_AGE_IDENTITY"
    DECRYPTED="$TMPDIR_LOCAL/$(basename "${LOCAL%.age}")"
    log "Decrypting $LOCAL -> $DECRYPTED"
    age -d -i "$BACKUP_AGE_IDENTITY" -o "$DECRYPTED" "$LOCAL"
    RESTORE_INPUT="$DECRYPTED"
    ;;
esac

# ----- Restore --------------------------------------------------------------
PGRESTORE_EXTRA_ARGS_VALUE="${PGRESTORE_EXTRA_ARGS:-}"
log "Running pg_restore -c -Fc --no-owner --no-acl -d <db> ${RESTORE_INPUT}"
# shellcheck disable=SC2086
pg_restore \
  --clean \
  --if-exists \
  --format=custom \
  --no-owner \
  --no-acl \
  --exit-on-error \
  ${PGRESTORE_EXTRA_ARGS_VALUE} \
  --dbname="$DATABASE_URL" \
  "$RESTORE_INPUT"

log "Restore complete. Next: run infra/scripts/verify-restore.ts to sanity-check."
