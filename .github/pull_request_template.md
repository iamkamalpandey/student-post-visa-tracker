<!--
SVT-AUDIT-OPS-2026-05 — PR template. Trim what doesn't apply.

Reviewer SLA: <24h for non-security; <4h for security/encryption/auth/billing.
-->

## What
<!-- 1–2 sentence summary of the change. -->

## Why
<!-- Link to issue / ticket / regulator request / audit finding. -->

## Test plan
- [ ] `pnpm --filter backend test` — green
- [ ] `pnpm --filter frontend exec tsc --noEmit` — green
- [ ] Manual smoke (paste URL + steps if UI affected)
- [ ] Migration: idempotent on second `prisma migrate deploy` (if applicable)

## Security checklist (delete if not security-touching)
- [ ] No new endpoint without `requireRole` + ownership gate where applicable
- [ ] No new mutation without `writeAudit`
- [ ] No new POST without `runIdempotent` when it costs money / sends comms
- [ ] No new env var without `.env.example` + Zod validator in `env.ts`
- [ ] No new RLS-scoped table without `tenant_isolation` policy
- [ ] No new raw `$queryRaw` with user-input interpolation
- [ ] No new external URL fetch without `SafeWebhookUrl` or allowlist
- [ ] No new field-level PII without `*_enc` envelope encryption
- [ ] No new logger statement that prints secrets (Pino redaction list updated if needed)

## Migration / deploy notes
<!-- If this PR needs a non-default deploy step (e.g., schema migration before code, env var added), spell it out. -->

## Rollback
<!-- One-line rollback path. "Revert this PR" is fine if no migration. -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
