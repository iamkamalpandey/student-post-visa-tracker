# Production go-live checklist

Sign off every box before pointing real DNS at the stack. Run the items
under **Repeat monthly** on a calendar invite — they decay otherwise.

## Before first deploy

### Secrets + keys

- [ ] `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` generated with `openssl genpkey` (2048-bit RSA). Private key stored in KMS/Vault, **never** committed.
- [ ] `JWT_KID` set to a date-stamped identifier (e.g. `prod-2026-05`). Bump on every rotation.
- [ ] `KMS_KEK_BASE64` is 32 random bytes (`openssl rand -base64 32`). Stored in KMS/Vault, **never** in `.env` on a shared host.
- [ ] `SEED_ADMIN_PASSWORD` is ≥ 16 chars, randomly generated, rotated immediately after first login.
- [ ] All `_PASSWORD`/`_KEY`/`_SECRET` env vars sourced from secrets manager, not `.env` files on disk.
- [ ] `gitleaks` CI job is green on the deployment commit.

### Database

- [ ] Managed Postgres (Neon/Supabase/RDS) chosen — or self-hosted with daily `pg_dump` + WAL-G to S3/R2.
- [ ] PITR window ≥ 7 days. Restore drill performed (and *succeeded*) within last 30 days.
- [ ] Two DB roles: `spv` (owner; runs migrations) and `spv_app` (runtime; no DDL).
- [ ] Connection string uses `spv_app`; `DATABASE_MIGRATE_URL` uses `spv` (owner).
- [ ] RLS verified: `SET ROLE spv_app; SELECT count(*) FROM students;` returns 0 without `app.tenant_id` set.
- [ ] All custom Postgres functions (`audit_logs_verify`, FK indexes) present.

### TLS + network

- [ ] HTTPS terminator (Caddy/Traefik/nginx) in front of the stack.
- [ ] Cert auto-renews (Let's Encrypt or ACME with managed CA).
- [ ] Backend + frontend bound to `127.0.0.1` only (compose.prod handles this).
- [ ] Postgres + Redis NOT exposed beyond `127.0.0.1`.
- [ ] HSTS active in browser (visit `/`; check response headers).
- [ ] CSP headers present and tight (`script-src 'self' 'nonce-…'`).

### Storage + AV

- [ ] Document upload volume mirrored to object storage (rclone cron).
- [ ] ClamAV container running and reachable from backend (`/api/v1/health/readyz` returns 200).
- [ ] Per-document `retention_until` policy applied — verify a sample row.

### Auth

- [ ] Seed admin logged in once; default password rotated; MFA enabled.
- [ ] Refresh-token rotation tested (reuse should revoke family + emit audit row).
- [ ] Account lockout fires after 5 fails in 15 min (manual test).
- [ ] JWKS endpoint reachable: `GET /.well-known/jwks.json` returns the active `kid`.

### Audit + integrity

- [ ] `GET /api/v1/audit-logs/verify` returns `broken_count: 0`.
- [ ] Daily cron wired to call the verify endpoint and alert on `broken_count > 0`.
- [ ] Audit log triggers in place: `INSERT INTO audit_logs (…)` succeeds; `UPDATE`/`DELETE` rejected by trigger.

### Observability

- [ ] Pino logs shipped to durable sink (Better Stack / Loki / Logtail); retention ≥ 90 days.
- [ ] Sentry (or equivalent) wired to backend + frontend; deploy markers fire.
- [ ] `/api/v1/health/livez` + `/readyz` polled by uptime monitor (UptimeRobot / BetterStack).
- [ ] Dashboard or alert: backend p95 latency, error rate, comms outbox queue depth.

### Compliance

- [ ] DPA template signed with hosting provider + every sub-processor.
- [ ] `SubProcessor` table populated with the actual sub-processors.
- [ ] `BreachIncident` workflow tested end-to-end (synthetic incident).
- [ ] DSAR workflow tested end-to-end (synthetic ACCESS request → ZIP export).
- [ ] Privacy policy + cookie banner live on the public marketing site.

### CI/CD

- [ ] `backend-ci.yml` green on the deploy commit.
- [ ] `frontend-ci.yml` green on the deploy commit.
- [ ] `security.yml` (OSV + SBOM + gitleaks) green within last 24h.
- [ ] CodeQL green on the deploy commit.
- [ ] Production deploy is a *manual promotion* of the staging image (no auto-deploy to prod).

## Smoke after every deploy

```bash
# 1. Health
curl -fsS "$API/api/v1/health/livez"   # 200
curl -fsS "$API/api/v1/health/readyz"  # 200
curl -fsS "$API/api/v1/version"        # JSON with build id

# 2. Auth round-trip
TOKEN=$(curl -fsS -X POST "$API/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"…"}' | jq -r .access_token)

# 3. Admin dashboards
curl -fsS "$API/api/v1/dashboard/summary"                  -H "Authorization: Bearer $TOKEN" | jq '.data | keys'
curl -fsS "$API/api/v1/dashboard/sla-breaches"             -H "Authorization: Bearer $TOKEN" | jq '.page.total'
curl -fsS "$API/api/v1/breach-incidents/dashboard-summary" -H "Authorization: Bearer $TOKEN" | jq .data
curl -fsS "$API/api/v1/dsar/dashboard-summary"             -H "Authorization: Bearer $TOKEN" | jq .data
curl -fsS "$API/api/v1/audit-logs/verify"                  -H "Authorization: Bearer $TOKEN" | jq .data
```

## Repeat monthly

- [ ] Backup restore drill (full PITR to a throwaway DB).
- [ ] Rotate `SEED_ADMIN_PASSWORD` if still in use; better, retire the seed account.
- [ ] Review `_prisma_migrations` for failed/rolled-back rows: `SELECT migration_name, rolled_back_at FROM _prisma_migrations WHERE rolled_back_at IS NOT NULL;`
- [ ] Review `gitleaks` history for secrets accidentally committed and rotate any leaked credential.
- [ ] Read the Pino error logs for the past 30 days; triage the top 5 by count.
- [ ] Pen-test the auth + upload + DSAR flows with the latest OWASP Top 10 in mind.

## Repeat quarterly

- [ ] Rotate `JWT_KID` + key pair (publish new in JWKS, retire old after access-token TTL).
- [ ] Rotate the per-tenant DEK (re-wrap with current KEK; old ciphertext stays valid).
- [ ] Rotate any service-account credentials (DB owner role, S3 access keys).
- [ ] Review + re-sign DPA with every sub-processor.
- [ ] Re-run the OWASP ASVS L2 checklist against the live deployment.

## Repeat annually

- [ ] Rotate `KMS_KEK_BASE64` (re-wrap every per-tenant DEK).
- [ ] Tabletop a breach scenario end-to-end (detection → containment → notification → post-mortem).
- [ ] Refresh the threat model (`infra/docs/THREAT_MODEL.md`) with new attack surface.
