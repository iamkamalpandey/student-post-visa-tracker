#!/usr/bin/env bash
# One-shot helper to bring the local dev stack up. Idempotent.
# Usage: bash infra/scripts/start-dev.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "==> Checking prerequisites"
command -v pnpm >/dev/null || { echo "pnpm not found. Install pnpm 9+ first." >&2; exit 1; }
command -v docker >/dev/null || { echo "docker not found. Install Docker Desktop." >&2; exit 1; }

echo "==> Bootstrapping env files"
[ -f apps/backend/.env ] || cp apps/backend/.env.example apps/backend/.env
[ -f apps/frontend/.env.local ] || cp apps/frontend/.env.example apps/frontend/.env.local

echo "==> Generating dev JWT keys (only if absent)"
if ! grep -q "BEGIN PRIVATE KEY" apps/backend/.env; then
  bash infra/scripts/gen-jwt-keys.sh >> apps/backend/.env
  echo "Generated dev JWT keys."
fi

echo "==> Starting Postgres + Redis + ClamAV"
docker compose up -d postgres redis clamav

echo "==> Waiting for Postgres"
until docker exec spv-postgres pg_isready -U spv -d spv_dev >/dev/null 2>&1; do
  sleep 1
done

echo "==> Installing workspace dependencies"
pnpm install

echo "==> Generating Prisma client"
pnpm --filter backend prisma:generate

echo "==> Running migrations"
pnpm --filter backend prisma:migrate -- --name init || true

echo "==> Seeding"
pnpm --filter backend prisma:seed

echo "==> Done. Start the apps with: pnpm dev"
