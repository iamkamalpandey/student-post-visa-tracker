#!/usr/bin/env bash
# SVT-AUDIT-OPS-2026-05 — Daily encrypted Postgres logical snapshot to object storage.
#
# Reads DATABASE_URL, takes pg_dump -Fc -Z 9, optionally pipes through `age`,
# and uploads to s3://$BACKUP_BUCKET/db/YYYY/MM/DD/svt-<env>-<ts>.pgdump[.age].
#
# See infra/docs/runbooks/db-backup-restore.md for cadence, retention,
# encryption, and restore drill.
#
# Required env:
#   DATABASE_URL        Postgres connection string (read-only role is fine).
#   BACKUP_BUCKET       Bucket name *without* the s3:// prefix (e.g. svt-prod-backups).
#
# Optional env:
#   BACKUP_LABEL        Label injected into the object name (default: "svt").
#   BACKUP_PUBKEY       `age` recipient (e.g. age1...). If set, dump is encrypted.
#                       Multiple recipients can be comma-separated.
#   BACKUP_S3_TOOL      `aws` (default) or `rclone`. `rclone` uses remote
#                       "$BACKUP_RCLONE_REMOTE" (default: "s3").
#   BACKUP_RCLONE_REMOTE   rclone remote name (default: "s3").
#   PGDUMP_EXTRA_ARGS   Extra args appended to pg_dump (e.g. --schema=public).
#
# Exit codes:
#   0 success.
#   non-zero on ANY failure (pg_dump, age, upload). CI treats this as a page.
#
# Run locally:
#   DATABASE_URL='postgres://…' BACKUP_BUCKET=svt-backups \
#     bash infra/scripts/backup-snapshot.sh

set -euo pipefail

# ----- Logging helpers -------------------------------------------------------
log()  { printf '[backup-snapshot %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die()  { printf '[backup-snapshot %s] ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

# ----- Input validation ------------------------------------------------------
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required (bucket name, no s3:// prefix)}"

LABEL="${BACKUP_LABEL:-svt}"
TOOL="${BACKUP_S3_TOOL:-aws}"
RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-s3}"

command -v pg_dump >/dev/null 2>&1 || die "pg_dump not on PATH"

if [ -n "${BACKUP_PUBKEY:-}" ]; then
  command -v age >/dev/null 2>&1 || die "BACKUP_PUBKEY set but 'age' is not on PATH"
  ENCRYPT=1
  SUFFIX=".pgdump.age"
else
  ENCRYPT=0
  SUFFIX=".pgdump"
  log "WARN: BACKUP_PUBKEY not set — uploading UNENCRYPTED dump. Relies entirely on bucket-side SSE."
fi

case "$TOOL" in
  aws)    command -v aws    >/dev/null 2>&1 || die "BACKUP_S3_TOOL=aws but 'aws' is not on PATH" ;;
  rclone) command -v rclone >/dev/null 2>&1 || die "BACKUP_S3_TOOL=rclone but 'rclone' is not on PATH" ;;
  *)      die "Unknown BACKUP_S3_TOOL='$TOOL' (expected 'aws' or 'rclone')" ;;
esac

# ----- Object key ------------------------------------------------------------
TS=$(date -u +%Y%m%dT%H%M%SZ)
DAY_PREFIX=$(date -u +%Y/%m/%d)
OBJECT_KEY="db/${DAY_PREFIX}/${LABEL}-${TS}${SUFFIX}"
S3_URL="s3://${BACKUP_BUCKET}/${OBJECT_KEY}"

log "label=${LABEL} encrypted=${ENCRYPT} tool=${TOOL} target=${S3_URL}"

# ----- Backup pipeline -------------------------------------------------------
# pg_dump -> [age] -> upload, with set -o pipefail so any stage failure kills
# the whole pipe.
PGDUMP_EXTRA_ARGS_VALUE="${PGDUMP_EXTRA_ARGS:-}"
# shellcheck disable=SC2086  # we deliberately word-split PGDUMP_EXTRA_ARGS
build_dump_stream() {
  pg_dump \
    --format=custom \
    --compress=9 \
    --no-owner \
    --no-acl \
    ${PGDUMP_EXTRA_ARGS_VALUE} \
    "$DATABASE_URL"
}

encrypt_stream() {
  if [ "$ENCRYPT" -eq 1 ]; then
    # `age` accepts -r repeated for multiple recipients; we accept a comma list.
    AGE_ARGS=()
    IFS=',' read -r -a RCPTS <<<"$BACKUP_PUBKEY"
    for r in "${RCPTS[@]}"; do
      [ -n "$r" ] && AGE_ARGS+=("-r" "$r")
    done
    age "${AGE_ARGS[@]}"
  else
    cat
  fi
}

upload_stream() {
  case "$TOOL" in
    aws)
      # `aws s3 cp - <s3url>` streams stdin to the bucket. SSE flags are
      # bucket-policy enforced in production; we set sse=AES256 as a defence in
      # depth and rely on the bucket to upgrade to SSE-KMS via default
      # encryption if a CMK is configured.
      aws s3 cp - "$S3_URL" \
        --expected-size 1073741824 \
        --sse AES256
      ;;
    rclone)
      # rclone path style: <remote>:<bucket>/<key>
      rclone rcat "${RCLONE_REMOTE}:${BACKUP_BUCKET}/${OBJECT_KEY}"
      ;;
  esac
}

log "Starting pg_dump -> $( [ "$ENCRYPT" -eq 1 ] && echo "age -> " )upload"

START_EPOCH=$(date -u +%s)
# Pipeline. set -o pipefail (from set -e) propagates the first non-zero status.
build_dump_stream | encrypt_stream | upload_stream
END_EPOCH=$(date -u +%s)

DURATION=$((END_EPOCH - START_EPOCH))
log "Upload complete in ${DURATION}s: ${S3_URL}"

# ----- Verify the object exists & report its size ---------------------------
case "$TOOL" in
  aws)
    if SIZE=$(aws s3api head-object --bucket "$BACKUP_BUCKET" --key "$OBJECT_KEY" --query 'ContentLength' --output text 2>/dev/null); then
      log "Verified s3 object size=${SIZE} bytes"
    else
      die "head-object failed for ${S3_URL} — upload reported success but object is not visible"
    fi
    ;;
  rclone)
    if rclone size "${RCLONE_REMOTE}:${BACKUP_BUCKET}/${OBJECT_KEY}" >/dev/null 2>&1; then
      log "Verified rclone object exists"
    else
      die "rclone size check failed for ${S3_URL}"
    fi
    ;;
esac

log "OK"
