# Deployment readiness — Student Post-Visa Tracker (audit 2026-06-08)

Result of a deep pre-launch audit (nav/links, action wiring, documents, dead code, build, deploy config). **The application is functionally complete and builds clean.** Remaining items are mostly **operator/infra config**, not broken features.

## ✅ Verified healthy
- **Navigation:** all 17 sidebar items → real routes; 0 broken links; 0 placeholder/stub pages; role-gating consistent (nav + API).
- **Actions:** 50+ buttons/forms across students, leads, imports, admin, billing, settings, inbox — all wired to real endpoints + handlers. No dead/no-op actions.
- **Documents:** end-to-end (upload → MIME-sniff → ClamAV → encrypt-at-rest → list → signed download → verify → soft-delete). *Caveat: storage + AV infra below.*
- **Builds:** backend `tsc → dist` clean; frontend `next build` **compiles + generates all 41 pages**. Both apps typecheck clean.
- **Tests:** 130+ backend specs (billing/auth/audit/docs/finance strong). RLS, append-only hash-chained audit, OCC, idempotency, float-free money all present.
- **Reliability:** scheduler no longer crashes on a DB blip (Phase 1, verified).

## 🔴 P0 — must do before production (operator / infra)
1. **Rotate `doadmin` + create a read-only V2 role.** The dev `.env` holds a DO **superuser** (gitignored + untracked — *not* in git, but still). Run the `spv_ro_ingest` SQL in `apps/backend/.env.example`, point `V2_MIS_DATABASE_URL` at it, rotate `doadmin`.
2. **Set every `type: SECRET` in `.do/app.yaml`** in the DO dashboard: `JWT_*`, `REFRESH_TOKEN_PEPPER` (`openssl rand -hex 32`), `LOG_HMAC_KEY_BASE64` (`openssl rand -base64 32`), `KMS_KEK_BASE64`, `V2_*`, `SENTRY_DSN`. *(All required prod vars are now in `.do/app.yaml` — the backend fails-fast without them; this was the main config blocker, now fixed.)*
3. **Document storage on App Platform.** Container fs is **ephemeral** → `STORAGE_DRIVER=local` loses uploads on redeploy. Either (a) implement the S3 driver (`documents/storage.ts` — currently a fail-loud stub) + use **DO Spaces** (S3-compatible) + verify in staging, or (b) deploy on a host with a **persistent volume** and keep local. *Don't ship untested S3 to prod — verify with a real bucket in staging first.*
4. **ClamAV for document AV.** Uploads scan via clamd (default `127.0.0.1:3310`); on App Platform there's no clamd → every upload lands `av_status=ERROR` and won't serve. Run clamav as a worker/service, or accept docs disabled until wired. Failure is fail-closed (safe), but docs won't work without it.

## 🟡 P1 — before/at launch
- **Managed KMS** (finance-grade): `.do/app.yaml` defaults to `KMS_PROVIDER=local` + `KMS_LOCAL_OK=true` (deploy-now). Switch to `aws|gcp|vault` + `KMS_KEY_ID` for real key management.
- **Multi-replica stores:** the document download **nonce store** + some rate-limits are in-memory → move to Redis before running >1 backend replica (else cross-replica misses). Keep `instance_count: 1` until then.
- **Co-location decision:** mirror (current, works) vs shared-DB/live-federation (designs in `infra/shared-db/` + tasks #17). Needs V2 + SPVT on one instance for shared-DB; otherwise keep the mirror.
- **Tests:** no frontend e2e for the CRM/students happy-paths; no unit tests on `money`/ingest/convert. Add before heavy reliance (the finance paths).

## 🟢 Notes / non-blockers
- Dev DB is built via `prisma db push` (no RLS); **prod uses `prisma migrate deploy`** (the `migrate` PRE_DEPLOY job in `.do/app.yaml` ✓) — RLS applies in prod.
- Frontend `output: standalone` build step needs symlink perms → **fails on Windows locally** (EPERM), **fine on the Linux deploy target**. The run command is `next start` (doesn't require standalone).
- `eslint-plugin-import` was missing (lint errored during build, non-fatal) — **added**.
- Nav label "Leads" = visa-accepted applications (minor IA; page heading already says "Applications").
- `spv_lead_overlay` / `spv_lead_fees` tables + `SPV_READ_MODE` flag are **reserved for federation (task #17)** — present but not yet wired.

## Fixed in this audit
- `.do/app.yaml`: added all prod-required env vars (`CORS_ORIGIN`, `REFRESH_TOKEN_PEPPER`, `LOG_HMAC_KEY_BASE64`, KMS provider+local-ok, email, storage) — backend now boots in prod.
- Added `eslint-plugin-import`.
- Confirmed `.env` gitignored + untracked.
