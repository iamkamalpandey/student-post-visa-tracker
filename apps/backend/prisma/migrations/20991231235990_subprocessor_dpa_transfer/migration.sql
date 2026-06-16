-- SVT-PRIV-2026-06 — GDPR Art. 28 + Chapter V sub-processor register fields.
-- dpa_signed_at proves the Data Processing Agreement is in place; transfer_mechanism
-- records the international-transfer safeguard (ADEQUACY/SCC/BCR/DEROGATION/NONE)
-- relied on for any cross-border flow to the processor. Both nullable + idempotent.

ALTER TABLE "sub_processors" ADD COLUMN IF NOT EXISTS "dpa_signed_at" TIMESTAMPTZ;
ALTER TABLE "sub_processors" ADD COLUMN IF NOT EXISTS "transfer_mechanism" TEXT;
