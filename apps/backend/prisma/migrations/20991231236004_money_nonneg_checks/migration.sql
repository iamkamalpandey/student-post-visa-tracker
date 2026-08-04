-- SVT-FIN-2026-08 — non-negative CHECK constraints on the money columns that
-- were missing them.
--
-- WHY
-- ---
-- The billing tables have carried `CHECK (amount_minor > 0)` since
-- 20991231235975_billing_v1, and the CRM mirror tables got theirs in
-- 20991231235986b. Three money columns never got one:
--
--   enrollments.tuition_total_minor
--   commission_claims.amount_minor
--   commission_claims.basis_minor
--
-- That gap was reachable. The API schemas do enforce `.nonnegative()`
-- (packages/zod-schemas/src/enrollments.ts, commissions.ts), but the CSV
-- importer writes tuition straight to Prisma without re-running the API schema,
-- and its own regex accepted a leading minus:
--
--   if (!/^-?\d+$/.test(minorRaw)) { ... }   // imports/mappers/enrollments-mapper.ts
--
-- So an enrollment imported with tuition_total_minor = -100000000 auto-created
-- a commission claim of amount_minor = -10000000, which summary() then summed
-- into outstanding_total_minor — a fabricated credit netting against real
-- receivables for that institution and currency. Nothing rejected it at any
-- layer. The mapper regex is fixed in the same change; this constraint is the
-- backstop, because a validation rule that lives only in application code is a
-- rule that some future import path will bypass again.
--
-- Also adds the paid-vs-billed cap on CRM lead fees. The billing side has
-- `fee_installments_paid_le_net`; the CRM side had nothing bounding
-- paid_amount_minor by amount_minor, so a settlement could exceed what was
-- billed and overstate `collected` in financeSummary.
--
-- NOT VALID
-- ---------
-- Every constraint is added NOT VALID: it applies to all future INSERTs and
-- UPDATEs immediately, but does not scan existing rows, so this migration takes
-- no long table lock and cannot fail on historical data that predates it.
-- Any such rows are a data-quality question to answer separately — deliberately
-- NOT silently rewritten here, because quietly changing a stored money figure
-- is exactly the class of action this audit exists to prevent.
--
-- To validate later, once the existing rows are known clean:
--   ALTER TABLE enrollments VALIDATE CONSTRAINT enrollments_tuition_nonneg;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'enrollments_tuition_nonneg') THEN
    ALTER TABLE enrollments
      ADD CONSTRAINT enrollments_tuition_nonneg
      CHECK (tuition_total_minor IS NULL OR tuition_total_minor >= 0) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_claims_amount_nonneg') THEN
    ALTER TABLE commission_claims
      ADD CONSTRAINT commission_claims_amount_nonneg
      CHECK (amount_minor >= 0) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_claims_basis_nonneg') THEN
    ALTER TABLE commission_claims
      ADD CONSTRAINT commission_claims_basis_nonneg
      CHECK (basis_minor IS NULL OR basis_minor >= 0) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_claims_received_nonneg') THEN
    ALTER TABLE commission_claims
      ADD CONSTRAINT commission_claims_received_nonneg
      CHECK (received_minor IS NULL OR received_minor >= 0) NOT VALID;
  END IF;
END $$;

-- Settled amount may not exceed the amount billed. Mirrors
-- fee_installments_paid_le_net on the billing side.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_lead_fees_paid_le_amount') THEN
    ALTER TABLE crm_lead_fees
      ADD CONSTRAINT crm_lead_fees_paid_le_amount
      CHECK (paid_amount_minor IS NULL OR paid_amount_minor <= amount_minor) NOT VALID;
  END IF;
END $$;
