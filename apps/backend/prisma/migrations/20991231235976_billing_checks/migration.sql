-- SVT-SEC-2026-05 — DB-level invariants on the billing tables.
--
-- Defence-in-depth for the cached arithmetic in payment.service.ts and
-- billingDaily.ts. Service-layer recompute could drift under a future bug;
-- these CHECKs make corrupt state impossible at INSERT/UPDATE time.
--
-- Added per DB audit findings (Wave-4 review):
--   1. fee_installments.paid_minor must never exceed net_minor.
--   2. fee_installments.balance_minor must always = net_minor - paid_minor.
--   3. fee_installments.sequence_no must be positive.
--   4. fee_adjustments.amount_minor sign must match its kind
--      (LATE_FEE positive; everything else ≤ 0).
--
-- Migrations are forward-only. If a constraint is too strict, drop and
-- re-add in a follow-up — never edit historic migrations.

-- ---------------------------------------------------------------------------
-- 1. fee_installments invariants
-- ---------------------------------------------------------------------------
-- Add as NOT VALID first to avoid full-table validation lock; the cron
-- runs nightly and will surface any pre-existing drift via the eventual
-- VALIDATE step (left to a follow-up migration so production rollout can
-- separate "stop new corruption" from "fix existing corruption").

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fee_installments_paid_le_net'
  ) THEN
    ALTER TABLE fee_installments
      ADD CONSTRAINT fee_installments_paid_le_net
      CHECK (paid_minor <= net_minor) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fee_installments_balance_eq'
  ) THEN
    ALTER TABLE fee_installments
      ADD CONSTRAINT fee_installments_balance_eq
      CHECK (balance_minor = net_minor - paid_minor) NOT VALID;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fee_installments_seq_positive'
  ) THEN
    ALTER TABLE fee_installments
      ADD CONSTRAINT fee_installments_seq_positive
      CHECK (sequence_no > 0) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. fee_adjustments — sign matches kind
-- ---------------------------------------------------------------------------
-- LATE_FEE: positive (adds to net).
-- DISCOUNT / SCHOLARSHIP / WAIVER / WRITE_OFF: non-positive (reduces net).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fee_adjustments_sign_by_kind'
  ) THEN
    ALTER TABLE fee_adjustments
      ADD CONSTRAINT fee_adjustments_sign_by_kind
      CHECK (
        (kind = 'LATE_FEE'   AND amount_minor >  0) OR
        (kind = 'DISCOUNT'   AND amount_minor <= 0) OR
        (kind = 'SCHOLARSHIP' AND amount_minor <= 0) OR
        (kind = 'WAIVER'     AND amount_minor <= 0) OR
        (kind = 'WRITE_OFF'  AND amount_minor <= 0)
      ) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. reminders.fire_count ≥ 0 (defence-in-depth per data-integrity audit)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reminders_fire_count_nonneg'
  ) THEN
    ALTER TABLE reminders
      ADD CONSTRAINT reminders_fire_count_nonneg
      CHECK (fire_count >= 0) NOT VALID;
  END IF;
END $$;

-- VALIDATE step deliberately deferred to a follow-up migration. Operators
-- should run the validation manually:
--   ALTER TABLE fee_installments VALIDATE CONSTRAINT fee_installments_paid_le_net;
--   ALTER TABLE fee_installments VALIDATE CONSTRAINT fee_installments_balance_eq;
--   ALTER TABLE fee_installments VALIDATE CONSTRAINT fee_installments_seq_positive;
--   ALTER TABLE fee_adjustments  VALIDATE CONSTRAINT fee_adjustments_sign_by_kind;
--   ALTER TABLE reminders        VALIDATE CONSTRAINT reminders_fire_count_nonneg;
-- after confirming via a SELECT that no existing rows violate.
