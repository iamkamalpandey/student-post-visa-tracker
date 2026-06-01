# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project follows [Semantic Versioning](https://semver.org/) per app (`backend-vX.Y.Z`, `frontend-vX.Y.Z`).

## [Unreleased]

### Added (initial scaffold — Phase 1)

- pnpm + Turborepo monorepo with `apps/{backend,frontend}` and `packages/{api-types,zod-schemas,utils,tsconfig,eslint-config}`.
- Express + Prisma + Postgres 16 backend with structured Pino logging, Helmet, CORS allow-list, RFC 9239 rate limit, RFC 7807 error responses.
- Full Prisma schema — Tenants, Users with Argon2id passwords, RefreshToken with device binding, AccessTokenDenylist, ConsentRecord, DSARRequest, BreachIncident, SubProcessor; Students with envelope-encrypted PII; Lifecycle Stages (dynamic, per-tenant, with transition matrix); Institutions / Campuses / Schools / Departments / Programs / Intakes / Fees / Modules / Requirements; Enrollments; Travel / Accommodation / Insurance; Finance ledger; Documents with AV + verification + retention; Comms (templates / threads / messages); Tags / Notes / Generic Attributes / Saved Views; immutable Audit Log with hash chain; Bulk Import / Export jobs; Reference data (Country / Currency / IscedField / AirportIATA / AirlineIATA / VisaCategory).
- RLS policies on every tenant-scoped table; per-request `SET LOCAL app.tenant_id`; non-superuser `spv_app` role for the runtime.
- Tamper-evident audit log via append-only triggers + SHA-256 hash chain + verification function.
- Envelope encryption helpers (AES-256-GCM, per-record DEK, KMS-managed KEK) with `LocalKms` for dev and a documented swap point for AWS / GCP / Vault.
- Auth module: login, refresh-token rotation with reuse detection, logout with JTI denylist, MFA-ready (TOTP), change-password, JWKS endpoint at `/.well-known/jwks.json`.
- Modules: students, lifecycle stages, lookups (countries / currencies / ISCED / visa categories / etc.), dashboard, well-known.
- Background jobs: upcoming-expiry scan, retention-erasure (crypto-shred), hash-chain anchor.
- Seed data: ~250 ISO countries, 52 currencies, 91 ISCED-F fields, 50 airlines, 121 airports, 21 visa categories, 8 default lifecycle stages, country templates for UK / US / AU / CA, default tenant + admin user.
- Frontend: Next.js 14 App Router, MUI v5 with MD3 token layer, dark/light/system theme, TanStack Query, React Hook Form + Zod, axios with single-flight refresh, login screen, protected app shell with role-aware navigation, dashboard placeholder, students list placeholder.
- CI: backend-ci, frontend-ci, security (osv-scanner, gitleaks, CycloneDX SBOM).
- Docs: README, SECURITY, CONTRIBUTING, ARCHITECTURE DECISIONS, runbooks (DB restore, hash-chain verify, KMS rotation, DSAR, bulk-import-stuck, provider-degrade, incident response).

### Deferred to follow-up phases

- Real provider integrations for email / SMS / WhatsApp.
- Distributed JTI denylist + idempotency cache via Redis.
- BullMQ-backed import / export workers.
- XLSX import / export (requires sheetjs / exceljs install).
- Daily Merkle-root anchoring to S3 Object Lock.
- AG-Grid / TanStack Table integration with full saved-views.
- Calendar route, reports route, comms inbox, audit viewer screens.
- Student self-service portal.
