-- SVT-FIN-2026-06 — record what the institution actually paid against a
-- commission claim, so claimed-vs-received variance (short-payments / partial
-- clawbacks) is visible instead of every paid claim looking fully settled.
-- Nullable (set at mark-paid, defaults to amount_minor). Idempotent.

ALTER TABLE "commission_claims" ADD COLUMN IF NOT EXISTS "received_minor" BIGINT;
