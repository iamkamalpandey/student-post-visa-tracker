# Runbooks

Operational runbooks for the SPV platform. Each entry is a separate Markdown
file in this directory. Stubs are filled in over time as procedures stabilise.

Last index audit: **2026-05-19**.

## Database

- **db-backup-restore.md** — Backup cadence, retention, encryption, and the monthly restore drill. P0 production prerequisite. Last drill 2026-05-19 (DRY-RUN); next wet drill due 2026-06-19. See `drill-logs/` for evidence.
- **db-restore.md** — Restore Postgres from a base backup + WAL up to a chosen PITR target.
- **restore-staging-from-prod.md** — Refresh the staging DB from a scrubbed prod snapshot.

## Security and identity

- **hash-chain-verify.md** — Run the audit-log hash-chain verification job and triage mismatches.
- **kms-rotation.md** — Rotate the KMS KEK and re-wrap per-record DEKs without downtime.
- **jwt-key-rotation.md** — Rotate the RS256 JWT signing keypair using the v1.1 graceful-overlap procedure (primary).
- **jwt-key-rotation-graceful-v1-1.md** — Design record for the v1.1 graceful-overlap rotation. Implemented — preserved as historical context.
- **env-rotation.md** — Coordinated zero-downtime rotation of `KMS_KEK_BASE64`, JWT keypair, and the `spv_app` Postgres password.
- **webhook-secret-rotation.md** — Rotate `RESEND_WEBHOOK_SECRET` (scheduled annually, on suspected leak, or on provider-side change). Covers the Resend / Svix straight cutover, rollback path, and the manual audit row.
- **locked-out-admin.md** — Customer admin lost their TOTP device AND every recovery code. Primary path is the "Force disable MFA" row-menu action on the Users page; curl fallback documented for FE-outage scenarios. Includes identity-verification triage.
- **incident-response.md** — Security / privacy incident response process and roles.

## Tenant lifecycle

- **founder-onboard-tenant.md** — Founder / DBA / platform-ops procedure to provision a new tenant with database access.
- **dsar.md** — Run a Data Subject Access Request (export, rectification, erasure) end-to-end.

## Operational hygiene

- **bulk-import-stuck.md** — Diagnose and unstick the bulk-import worker queue (drain, pause, resume).
- **provider-degrade.md** — Enter and exit degraded mode when an upstream provider (KMS, AV, mail, SMS) is down.

## Reference

- **deep-audit-findings.md** — Snapshot of the 2026-05-14 deep audit. Reference document, not a runbook — kept here for traceability between findings and the runbooks that close them.
- **drill-logs/** — Append-only evidence directory for restore-drill runs.
