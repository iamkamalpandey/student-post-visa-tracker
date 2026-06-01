#!/usr/bin/env bash
# Generate an RSA 2048 keypair and emit env-ready single-line PEM strings
# (literal newlines escaped as \n) suitable for pasting into apps/backend/.env.
#
# On Windows we cannot chmod from this script's contents, but the file should be
# committed with the executable bit set. If you cloned on Windows and the bit
# was lost, run:
#     git update-index --chmod=+x infra/scripts/gen-jwt-keys.sh
#
# Usage:
#     bash infra/scripts/gen-jwt-keys.sh
#     bash infra/scripts/gen-jwt-keys.sh > /tmp/jwt.env   # capture to file

set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "Error: openssl is required but not installed." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PRIV="$TMP_DIR/jwt_private.pem"
PUB="$TMP_DIR/jwt_public.pem"

openssl genpkey -algorithm RSA -out "$PRIV" -pkeyopt rsa_keygen_bits:2048 2>/dev/null
openssl rsa -in "$PRIV" -pubout -out "$PUB" 2>/dev/null

# Replace literal newlines with the two-character sequence \n so the value
# fits on a single env line. Use awk to avoid platform-specific sed quirks.
escape_pem() {
  awk 'BEGIN{ORS=""} {print (NR>1 ? "\\n" : "") $0}' "$1"
}

PRIV_ESCAPED="$(escape_pem "$PRIV")"
PUB_ESCAPED="$(escape_pem "$PUB")"

KID="dev-key-$(date -u +%Y-%m)"

cat <<EOF
# --- Paste the lines below into apps/backend/.env ---
JWT_PRIVATE_KEY="${PRIV_ESCAPED}"
JWT_PUBLIC_KEY="${PUB_ESCAPED}"
JWT_KID=${KID}
EOF
