# Threat Model — Student Post-Visa Tracker

Lightweight STRIDE pass per OWASP ASVS L2. Update as new attack surface lands.

## Assets

- **Subject PII**: passport / national-ID / visa numbers, dates of birth, contact details, addresses, financial-sponsor income, health-insurance policies, biometric appointment data.
- **Operator credentials**: admin / counsellor login material, MFA secrets, refresh tokens.
- **Audit log integrity**: tamper-evident chain that auditors and regulators rely on.
- **Documents**: passport scans, offer letters, CAS / I-20 / COE letters, financial proofs.
- **Bulk data**: import sources, export artefacts (downloadable links, optionally PII-redacted).

## Trust boundaries

1. Browser ↔ Frontend (Next.js).
2. Frontend ↔ Backend API (HTTPS + JWT).
3. Backend ↔ Postgres (RLS-scoped role).
4. Backend ↔ KMS (envelope encryption).
5. Backend ↔ Object storage (signed URLs).
6. Backend ↔ ClamAV.
7. Backend ↔ External providers (email / SMS / WhatsApp).

## STRIDE summary

| Threat | Examples | Mitigation |
|---|---|---|
| **Spoofing** | Stolen access token, MFA bypass | RS256 + algorithm pinning; refresh-token reuse detection; account lockout; optional MFA TOTP. |
| **Tampering** | Audit log rewrite, schema-level data manipulation | Append-only triggers + SHA-256 hash chain on `audit_logs`; WORM Merkle anchor; non-superuser app role; CI schema diff gate. |
| **Repudiation** | "I didn't do that" | Every mutation writes AuditLog with `actor_id`, `request_id`, `before_enc`/`after_enc`. Hash chain proves continuity. |
| **Information disclosure** | Cross-tenant leak, PII export, export-link guessing | RLS in DB; field-level encryption; signed single-use download URLs; PII-redacted exports by default; admin step-up for full PII. |
| **Denial of service** | Rate-limit bypass, oversized payloads, mass export | Per-IP and per-user rate limits (Redis-backed in prod); 256 KB JSON cap; 10 MB upload cap; export rate limiter; request timeouts. |
| **Elevation of privilege** | Counsellor escalates to admin via mass-assignment | Strict Zod validation; explicit `requireRole('ADMIN')` on admin routes; no role assignment from user-controlled fields. |

## Specific scenarios

- **Refresh-token theft via XSS** → token reuse triggers chain revocation; session forced to re-login.
- **Stolen DB snapshot** → field-level encryption with KMS-managed KEK means dump is unreadable without KMS access.
- **Forged export download link** → URLs require signed single-use nonces with 5-minute TTL bound to the issuing user.
- **Malicious upload** → magic-byte sniff + ClamAV fail-closed; EXIF strip on images; storage key is server-derived (no path traversal).
- **CSRF** → JWT in `Authorization` header (not cookie) for mutations; refresh cookie is `SameSite=Lax` + restricted path; CSP `frame-ancestors 'none'`.
- **SSRF via institution logo URL** → frontend fetches logos client-side; backend never fetches external URLs.

## Out of scope (current release)

- HSM-backed KMS (planned via AWS KMS / Vault).
- Distributed denial-of-service mitigation beyond per-IP limits — deploy behind Cloudflare or AWS WAF.
- Hardware-backed MFA (WebAuthn) — TOTP only in v1.

## Review cadence

- Every PR that touches authn, authz, encryption, file uploads, or data export requires this document to be re-read and noted in the PR description.
- Quarterly full STRIDE review by the security on-call.
