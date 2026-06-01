# Security Policy

## Reporting a vulnerability

Please email security disclosures to `security@example.com` (replace with your security contact before going to production). Do **not** open a public GitHub issue for suspected vulnerabilities.

We aim to acknowledge new reports within 2 business days and provide a remediation timeline within 10 business days. Critical issues that affect production data are escalated immediately.

## Scope

The Student Post-Visa Tracker stores deeply sensitive PII (passport / visa / financial sponsor / health-insurance data) for international students. The following are explicitly in-scope for our threat model:

- Cross-tenant data disclosure (RLS bypass, IDOR).
- Authentication / session bypass (JWT alg confusion, refresh-token theft, MFA bypass).
- Data exfiltration via export, import error reports, or audit log endpoints.
- Privilege escalation between `VIEWER` → `COUNSELLOR` → `ADMIN` roles.
- File-upload abuse (malware, SSRF, XXE, path traversal, server-side request smuggling).
- Audit-log tampering or hash-chain forgery.
- Field-level decryption oracle attacks.

## Defences in place

- **Network / Transport** — TLS at the proxy; HSTS in production.
- **AuthN** — Argon2id password hashing (m=64 MB, t=3); RS256 JWT with pinned `algorithms: ['RS256']`; JWKS endpoint with `kid` rotation; refresh-token rotation with reuse detection; account lockout (5 fails / 15 min, exponential backoff).
- **AuthZ** — RBAC plus Postgres Row-Level Security policies on every tenant-scoped table; per-request `SET LOCAL app.tenant_id`; the runtime app role has no `BYPASSRLS`.
- **Input** — Zod `.strict()` validation on every body / query / params; JSON body capped at 256 KB; multer file uploads capped at 10 MB; magic-byte sniff against an allow-list; ClamAV scan; EXIF strip on images; PDF JavaScript stripped.
- **Output** — RFC 7807 problem details; React default escaping; no rich-text rendering without DOMPurify; CSP `default-src 'none'` plus an explicit allow-list; `X-Content-Type-Options: nosniff`.
- **Secrets** — Envelope encryption (AES-256-GCM with KMS-managed KEK and per-record DEKs) for: passport / national-ID numbers, visa numbers, insurance policy numbers, sponsor income, MFA secrets, and the `before_enc` / `after_enc` JSON snapshots inside `audit_logs`.
- **Audit** — `audit_logs` is enforced as append-only via DB triggers; SHA-256 hash chain across rows (`prev_hash`, `entry_hash`); a verification function `audit_logs_verify(tenant_uuid)` recomputes the chain on demand. The plan covers daily Merkle-root anchoring to a WORM bucket.
- **Logging** — Structured Pino with redaction for credentials, tokens, and known PII fields; HMAC-hashed IP and User-Agent for correlation without raw PII retention.
- **Dependencies** — Pinned with pnpm; CI runs `osv-scanner` on every PR plus a nightly job; SBOM (CycloneDX) produced per build; `gitleaks` blocks pushes containing secrets.

## Out of scope (current release)

- Fully managed SOC 2 / ISO 27001 evidence collection — the controls are in place, the evidence-pipeline tooling is on the roadmap.
- HSM-backed KMS (the production plan is AWS KMS or HashiCorp Vault; the codebase ships with a KMS abstraction so swapping is one factory change).
- Distributed denial-of-service mitigation beyond per-IP rate limiting (deploy behind Cloudflare / AWS WAF in production).

## Production checklist

Operators **must** complete the following before exposing the service to real subject data:

1. Replace dev RSA keys (`infra/scripts/gen-jwt-keys.sh`) with production keys stored in KMS.
2. Replace `KMS_KEK_BASE64` with a real KMS provider (AWS KMS / GCP KMS / Vault).
3. Configure `CORS_ORIGIN` to the production frontend origin only.
4. Move the access-token denylist and rate limiter to a Redis backend.
5. Enable Postgres point-in-time recovery (PITR) ≥ 7 days; schedule monthly restore drills.
6. Set up Sentry, log shipping with retention lock, and Grafana dashboards for SLOs.
7. Configure ClamAV signature updates and monitor `av_status='ERROR'` events.
8. Document Sub-Processors in the `sub_processors` table and publish them via `/api/v1/admin/sub-processors`.
9. Train the team on the DSAR workflow (`POST /api/v1/dsar`) and the 30-day response SLA.
10. Read `infra/docs/runbooks/` and rehearse the incident-response playbook.
