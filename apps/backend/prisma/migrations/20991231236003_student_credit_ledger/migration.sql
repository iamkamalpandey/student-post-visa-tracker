-- SVT-FIN-2026-08 — student credit ledger (FIN-P0-2).
--
-- WHY THIS EXISTS
-- ---------------
-- `student_credits` shipped as a WRITE-ONLY table. Rows were minted in two
-- places (payment overflow in receivePayment, refund surplus in completeRefund)
-- and then nothing in the entire codebase ever read them, drew them down, or
-- reversed them:
--
--   * `consumed_minor` was never incremented by any code path, despite the
--     model comment promising "Consumed by future PaymentAllocation rows".
--   * No route, service reader, export, or UI surfaced a credit, so an
--     overpayment became an invisible liability. Staff could not see that the
--     business owed the student money, and the student could not see it either.
--   * Voiding a payment reversed its allocations but left the overpayment
--     credit it had created alive — a void is supposed to mean "this payment
--     never happened", yet the phantom credit survived it.
--
-- This migration adds the two things the ledger was missing: a place to record
-- each draw-down, and a way to retire a credit without deleting the row.
--
-- WHY NOT REUSE payment_allocations
-- ---------------------------------
-- A credit application is not a payment allocation. `payment_allocations.
-- payment_id` is NOT NULL and the system relies on
-- `sum(allocations) == payment.gross_minor` per payment. Applying a credit
-- through a synthetic Payment row would count the same cash twice in every
-- revenue aggregate. A separate ledger keeps both invariants intact:
--
--   installment.paid_minor == sum(payment_allocations) + sum(credit_applications)
--
-- WHY reversed_at INSTEAD OF DELETE
-- ---------------------------------
-- Money rows are never hard-deleted. Reversing a credit records who did it,
-- when, and why, and leaves the original amount legible for reconciliation.

-- ---------------------------------------------------------------------------
-- 1. Reversal columns on student_credits
-- ---------------------------------------------------------------------------
ALTER TABLE student_credits
  ADD COLUMN IF NOT EXISTS reversed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_reason text,
  ADD COLUMN IF NOT EXISTS reversed_by_id  uuid;

-- A reversed credit must carry its reason: an unexplained retirement of a
-- liability is exactly the kind of entry an auditor asks about.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'student_credits_reversal_reason_ck'
  ) THEN
    ALTER TABLE student_credits
      ADD CONSTRAINT student_credits_reversal_reason_ck
      CHECK (reversed_at IS NULL OR reversed_reason IS NOT NULL);
  END IF;
END $$;

-- Lookup path for void-payment reversal: "find the credit this payment minted".
CREATE INDEX IF NOT EXISTS student_credits_tenant_source_ref_idx
  ON student_credits (tenant_id, source_ref_id)
  WHERE source_ref_id IS NOT NULL;

-- Lookup path for the "what do we owe this student" reader. Partial: a fully
-- consumed or reversed credit is history, not an open liability.
CREATE INDEX IF NOT EXISTS student_credits_open_idx
  ON student_credits (tenant_id, student_id, currency)
  WHERE reversed_at IS NULL AND consumed_minor < amount_minor;

-- ---------------------------------------------------------------------------
-- 2. student_credit_applications — one row per draw-down
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_credit_applications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  student_credit_id   uuid NOT NULL,
  fee_installment_id  uuid NOT NULL,
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by_id       uuid,
  CONSTRAINT sca_tenant_fk      FOREIGN KEY (tenant_id)          REFERENCES tenants(id)          ON DELETE CASCADE,
  CONSTRAINT sca_credit_fk      FOREIGN KEY (student_credit_id)  REFERENCES student_credits(id)  ON DELETE CASCADE,
  CONSTRAINT sca_installment_fk FOREIGN KEY (fee_installment_id) REFERENCES fee_installments(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS sca_tenant_credit_idx      ON student_credit_applications (tenant_id, student_credit_id);
CREATE INDEX IF NOT EXISTS sca_tenant_installment_idx ON student_credit_applications (tenant_id, fee_installment_id);

-- ---------------------------------------------------------------------------
-- 3. RLS — same tenant_isolation pattern as every other billing table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY['student_credit_applications'];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', tbl);
    -- SVT-SEC-2026-08 — NO `OR app_current_tenant() IS NULL` ESCAPE CLAUSE.
    --
    -- The surrounding billing migrations predate
    -- 20991231235983_rls_remove_escape_hatch, which exists specifically to
    -- strip that clause from every tenant_isolation policy. Copying the older
    -- shape into a NEW migration silently re-opens the hole for this table,
    -- because this migration sorts last and therefore wins.
    --
    -- With the escape clause, any connection where `app.tenant_id` is unset —
    -- a cron job, a script, or an app-path bug that forgets the tenant-scoped
    -- client — reads and writes EVERY tenant's rows. Without it, a missing GUC
    -- returns zero rows, which fails safe and is loudly debuggable.
    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON %I; '
      'CREATE POLICY tenant_isolation ON %I '
      'USING (tenant_id = app_current_tenant()) '
      'WITH CHECK (tenant_id = app_current_tenant());',
      tbl, tbl
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Grants — spv_app is the runtime DML role.
-- No DELETE: a ledger line is never removed, only offset by a reversal.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spv_app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON student_credit_applications TO spv_app';
  END IF;
END $$;
