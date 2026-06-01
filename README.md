# Student Post-Visa Tracker (SVT)

Multi-tenant SaaS for tracking international students after visa approval.
Express + Prisma + PostgreSQL backend, Next.js 14 + MUI v5 frontend.
Postgres RLS + RS256 JWT + audit hash-chain for tenant isolation, authn/z, and tamper-evident history.

## Quick start

```bash
# Clone + install
git clone <repo-url> svt && cd svt
pnpm install

# Bring up Postgres + Redis (and ClamAV) via docker compose (compose file is at repo root)
docker compose -f docker-compose.yml up -d

# Copy env templates and generate a dev JWT keypair
cp apps/backend/.env.example apps/backend/.env
cp apps/frontend/.env.example apps/frontend/.env.local
bash infra/scripts/gen-jwt-keys.sh   # or: pwsh infra/scripts/gen-jwt-keys.ps1

# Apply schema + seed default tenant + admin
pnpm --filter backend prisma db push
pnpm --filter backend prisma:seed

# Run dev servers (in two shells, or use turbo `pnpm dev` from root)
pnpm --filter backend dev          # backend on http://localhost:4000
pnpm --filter frontend dev         # frontend on http://localhost:3001
```

### Default credentials

| Field    | Value                  |
| -------- | ---------------------- |
| Email    | `admin@example.com`    |
| Password | `ChangeMeNow!2026`     |

**CHANGE THIS BEFORE PROD.** Rotate `SEED_ADMIN_PASSWORD` in `.env` and re-seed,
or change the password from the UI immediately after first login.

### URLs

| Service        | URL                                              |
| -------------- | ------------------------------------------------ |
| Frontend (Next)| http://localhost:3001                            |
| Backend (API)  | http://localhost:4000                            |
| OpenAPI / docs | http://localhost:4000/api/v1/docs                |
| Health (live)  | http://localhost:4000/api/v1/health/livez        |
| Health (ready) | http://localhost:4000/api/v1/health/readyz       |
| JWKS           | http://localhost:4000/.well-known/jwks.json      |

## Architecture

pnpm + Turborepo monorepo. Two apps (`apps/backend`, `apps/frontend`) share
five workspace packages (`api-types`, `zod-schemas`, `utils`, `tsconfig`,
`eslint-config`). Every tenant-scoped row in Postgres carries `tenant_id` and
is protected by Row-Level Security policies that the runtime DB role
(`spv_app`) cannot bypass; the per-request `app.tenant_id` is set via
`set_config()` inside a transaction. The audit log is append-only with a
per-tenant SHA-256 hash chain so any post-hoc tampering is detectable.

```
.
|-- apps/
|   |-- backend/        # Express + Prisma API (Node 20)
|   `-- frontend/       # Next.js 14 App Router + MUI v5
|-- packages/
|   |-- api-types/      # Shared HTTP DTO types
|   |-- zod-schemas/    # Shared Zod runtime validators
|   |-- utils/          # Money, phone, ids, time, result
|   |-- tsconfig/       # Base / node / next tsconfig presets
|   `-- eslint-config/  # Shared ESLint rules
|-- infra/
|   |-- docker/         # Compose stack + Postgres init
|   |-- docs/runbooks/  # Operational runbooks
|   `-- scripts/        # gen-jwt-keys, helpers
`-- .github/workflows/  # CI: backend, frontend, security
```

## Testing

```bash
# Backend unit + integration tests (Vitest)
cd apps/backend && pnpm vitest run

# Typecheck everything
pnpm typecheck

# Lint everything
pnpm lint
```

CI runs the same commands on every PR plus a security workflow
(`pnpm audit`, dependency review, gitleaks). The audit step is
**hard-fail on HIGH** — reproduce locally with `pnpm audit` (alias
for `pnpm audit --prod --audit-level=high`).

## Deployment

Configuration is **100% environment-variable driven** — see
[`apps/backend/.env.example`](./apps/backend/.env.example) and
[`apps/frontend/.env.example`](./apps/frontend/.env.example) for the full
list. The backend boot fails fast on missing/invalid keys via a Zod schema in
`apps/backend/src/config/env.ts`; in `NODE_ENV=production` `KMS_KEK_BASE64` is
also required.

### Docker

```bash
# Backend image (multi-stage, non-root, includes HEALTHCHECK on /health/livez)
docker build -f apps/backend/Dockerfile  -t svt-backend  .

# Frontend image (Next.js standalone output, non-root, HEALTHCHECK on /)
docker build -f apps/frontend/Dockerfile -t svt-frontend \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.example.com/api/v1.
```

Backend exposes `4000`, frontend exposes `3000` inside the container (remap at
the load balancer or `docker run -p`). Backend runs `prisma migrate deploy`
on container start, then `node dist/server.js`.

### Recommended hosts

| Layer       | Recommended                            |
| ----------- | -------------------------------------- |
| Backend     | Fly.io (Machines), Hetzner + Coolify, Railway, Render |
| Frontend    | Vercel, Fly.io, Cloudflare Pages       |
| Postgres    | Neon, Supabase, AWS RDS, managed Hetzner |
| Redis       | Upstash, Fly Redis, ElastiCache        |
| Object store| S3, R2, Backblaze B2                   |
| KMS         | AWS KMS, GCP KMS, HashiCorp Vault      |

## Security model

Tenant data is isolated at the database layer with Postgres RLS — even a SQL
injection in the app cannot cross tenants. Authentication is **RS256 JWT**
(short-lived access + rotating refresh, JWKS-published `kid`); authorisation is
**RBAC + ABAC** with row-level scopes. PII columns (passport, visa numbers,
contact identifiers) use **envelope encryption** (cloud-managed KEK + per-record
DEK). All deletes are **soft** with `deleted_at`; the audit log is **append-only
hash-chained** (SHA-256, per-tenant) and verified by a daily job. File uploads
go through ClamAV; CORS is allow-listed; HSTS + strict CSP at the edge.

## Project status

Shipped modules (REST surface under `/api/v1`):

- **auth** — login, refresh, logout, password reset, MFA hooks
- **users** + **RBAC** — roles, permissions, scope grants
- **students** — full student record, encrypted PII fields
- **stages** — per-tenant configurable lifecycle stages + transitions
- **programs** + **institutions** — academic catalogue
- **enrollments** — student to program with status history
- **commissions** — institution payouts and reconciliation
- **reminders** — time-based and event-based notifications
- **checklist** — per-stage required-task tracking
- **visa-types** + **visas** — visa issuance and renewals
- **audit-logs** — append-only hash-chained activity log
- **DSAR** — GDPR subject-access export and erasure workflow
- **breach** incidents — incident register and notification timelines
- **sub-processors** — third-party processor inventory (Art. 28)
- Plus: accommodation, addresses, attributes, comms, compliance, consent,
  contacts, dashboard, dependents, documents, employment, engagement,
  exports, finance, identifications, imports, insurance, language-tests,
  lookups, notes, qualifications, regulator-ids, saved-views,
  sponsorships, tags, travel, health, version, openapi, wellknown.

## Production deployment

### Quickstart (self-hosted, single host)

```bash
# 1. Generate JWT keys
openssl genpkey -algorithm RSA -out jwt_private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in jwt_private.pem -pubout -out jwt_public.pem

# 2. Generate the KMS data-encryption key (32 random bytes → base64)
openssl rand -base64 32

# 3. Create .env at repo root with the required vars (see below).
# 4. Build + start
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# 5. Tail logs / verify health
docker compose logs -f backend
curl http://127.0.0.1:4000/api/v1/health/readyz
```

### Required environment

Every variable below is **required**; `docker-compose.prod.yml` fails to start
when any are missing (the `:?` substitution short-circuits compose).

| Variable | Notes |
| --- | --- |
| `PG_OWNER` / `PG_OWNER_PASSWORD` / `PG_DB` | Postgres bootstrap. Prefer managed Postgres (Neon/Supabase/RDS) over the bundled container for real workloads — it gives you PITR and snapshot backups. |
| `DATABASE_URL` | Runtime app role; respects RLS. Use the `spv_app` role, not the owner. |
| `DATABASE_MIGRATE_URL` | Owner role; required for `prisma migrate deploy`. |
| `REDIS_URL` | Rate-limit + outbox dispatcher state. |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | RS256 PEM, single line with literal `\n`. Rotate at least annually. |
| `JWT_KID` | Identifies the active key in JWKS; bump on rotation. |
| `KMS_KEK_BASE64` | 32-byte key-encryption key, base64. **Lose this and every envelope-encrypted column (passport numbers, sponsor income, MFA secrets) is unrecoverable.** Store in a real KMS (AWS/GCP/Vault) in serious deployments. |
| `CORS_ORIGIN` | Comma-separated FE origins. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | Bootstrap admin on first run. Change the password immediately. |
| `EMAIL_PROVIDER` / `RESEND_API_KEY` / `EMAIL_FROM` | `log` for dev; `resend` for prod with a verified sender domain. |
| `NEXT_PUBLIC_API_BASE_URL` | Frontend build-time arg (baked into the bundle). |

### Front the stack with TLS

The compose file binds backend (`:4000`) and frontend (`:3000`) to
`127.0.0.1` only. Put a TLS terminator (Caddy / Traefik / nginx) in front
and proxy:

- `https://app.example.com` → frontend `:3000`
- `https://api.example.com` → backend `:4000`

Caddy snippet (the simplest sane default):

```caddy
api.example.com {
  reverse_proxy 127.0.0.1:4000
}
app.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

HSTS is gated behind TLS in the backend (`apps/backend/src/middlewares/security.ts`),
so it activates automatically once requests arrive with `X-Forwarded-Proto: https`.

### Backups (mandatory before going live)

- **Postgres**: managed PG with PITR ≥ 7 days, OR `pg_dump` + WAL-G nightly to
  S3/R2. Monthly restore drill is non-optional — it's the only way to know
  the backups work. **Full procedure, retention, encryption, and the drill
  checklist live in [`infra/docs/runbooks/db-backup-restore.md`](./infra/docs/runbooks/db-backup-restore.md).**
- **Storage volume**: `spv_backend_storage` holds uploaded documents. Mirror
  to object storage (rclone to S3/R2) on a cron.
- **Audit hash chain**: nightly cron should run
  `GET /api/v1/audit-logs/verify` (admin token) and alert if `broken_count > 0`.

### Smoke checklist

1. `/api/v1/health/livez` → 200 (process up)
2. `/api/v1/health/readyz` → 200 (DB + Redis reachable)
3. `/api/v1/version` → JSON with build id
4. POST `/api/v1/auth/login` with seed admin → returns access + refresh tokens
5. Bell badge: shows in-app notifications after a stage transition
6. Audit chain: admin sees `Chain intact` chip on `/audit`

### Common gotchas

- **Migration permission errors** (`must be owner of table tenants`): the
  app role can't run DDL. Use `DATABASE_MIGRATE_URL` (owner) for
  `prisma migrate deploy`; the runtime continues to use `DATABASE_URL` (app role).
- **Stale Prisma client** after schema edits: stop the backend dev server
  before `pnpm prisma generate` — the Windows query-engine binary holds an
  exclusive lock while the process is up.
- **EMAIL_PROVIDER=resend without RESEND_API_KEY**: env validation refuses
  to boot. Either set the key or downgrade to `log` for staging.

## Operations

All recurring ops procedures live as runbooks under
[`infra/docs/runbooks/`](./infra/docs/runbooks/). The ones that block
production sign-off:

| Runbook | What it covers |
| --- | --- |
| [`db-backup-restore.md`](./infra/docs/runbooks/db-backup-restore.md) | Daily encrypted snapshots + PITR + monthly restore drill. **P0 — required before shipping.** |
| [`db-restore.md`](./infra/docs/runbooks/db-restore.md) | Per-provider PITR cheat-sheet for an active incident. |
| [`hash-chain-verify.md`](./infra/docs/runbooks/hash-chain-verify.md) | Audit-log tamper detection workflow. |
| [`kms-rotation.md`](./infra/docs/runbooks/kms-rotation.md) | KEK rotation without downtime. |
| [`env-rotation.md`](./infra/docs/runbooks/env-rotation.md) | JWT keypair + secret rotation (legacy dual-key sketch — see jwt-key-rotation.md for the supported v1 procedure). |
| [`webhook-secret-rotation.md`](./infra/docs/runbooks/webhook-secret-rotation.md) | Rotate `RESEND_WEBHOOK_SECRET` (scheduled, leak, or provider-side change). |
| [`jwt-key-rotation.md`](./infra/docs/runbooks/jwt-key-rotation.md) | **P0** — JWT key rotation, v1 stop-the-world procedure. All users forced to re-login. |
| [`jwt-key-rotation-graceful-v1-1.md`](./infra/docs/runbooks/jwt-key-rotation-graceful-v1-1.md) | Roadmap — multi-`kid` overlap design to eliminate the re-login impact. |
| [`incident-response.md`](./infra/docs/runbooks/incident-response.md) | Pager, comms, postmortem template. |
| [`provider-degrade.md`](./infra/docs/runbooks/provider-degrade.md) | Enter / exit degraded mode when an upstream is down. |
| [`bulk-import-stuck.md`](./infra/docs/runbooks/bulk-import-stuck.md) | Drain / unstick the bulk-import worker queue. |
| [`dsar.md`](./infra/docs/runbooks/dsar.md) | Subject access request workflow. |

Backup tooling: `infra/scripts/backup-snapshot.sh`,
`infra/scripts/restore-from-snapshot.sh`, `infra/scripts/verify-restore.ts`.
The daily backup workflow is `.github/workflows/db-backup.yml` (cron, gated
on the `production` environment — see PR description before enabling).

## Contributing

Conventional Commits. Trunk-based with short-lived feature branches off
`main`; squash-merge via PR; CI must be green; security-touching changes
(auth, RLS, encryption, audit, upload) require a second reviewer. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`SECURITY.md`](./SECURITY.md).

## License

See [`LICENSE`](./LICENSE).
