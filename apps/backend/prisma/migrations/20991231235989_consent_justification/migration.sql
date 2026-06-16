-- SVT-PRIV-2026-06 — GDPR Art. 6(1)(f) legitimate-interests assessment.
-- A consent/lawful-basis record relying on LEGITIMATE_INTEREST must carry the
-- documented balancing test. Nullable column (other bases don't need it; the
-- API enforces presence when the basis is LEGITIMATE_INTEREST). Idempotent.

ALTER TABLE "consent_records" ADD COLUMN IF NOT EXISTS "justification" TEXT;
