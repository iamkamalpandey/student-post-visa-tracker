-- ============================================================================
-- Wave Billing v1 — School/College-style fee management.
--
-- Adds a bounded billing context (FeePlan → FeeInstallment, Payment →
-- PaymentAllocation, FeeAdjustment, Refund, StudentCredit) gated by
-- Tenant.billing_enabled. Existing consultancy tenants see no change until
-- they flip the flag.
--
-- Idempotent where possible:
--   * IF NOT EXISTS on enum value additions
--   * DROP POLICY IF EXISTS before CREATE POLICY
--   * CREATE TABLE IF NOT EXISTS for new tables
--   * CREATE SEQUENCE / FUNCTION OR REPLACE for the receipt-no helper
--
-- Order matters:
--   1. Enum extensions BEFORE column adds that reference new values.
--   2. Tables BEFORE indexes, FKs, RLS policies.
--   3. RLS policies + grants LAST so they catch every table.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tenant flag — opt-in gate for the entire billing surface.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS billing_enabled boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Enum extensions — ON_LEAVE on StudentStatus + EnrollmentStatus.
-- ---------------------------------------------------------------------------
ALTER TYPE "StudentStatus" ADD VALUE IF NOT EXISTS 'ON_LEAVE';
ALTER TYPE "EnrollmentStatus" ADD VALUE IF NOT EXISTS 'ON_LEAVE';

-- ---------------------------------------------------------------------------
-- 3. New enums (Prisma maps these to PostgreSQL enum types).
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "FeePlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "FeeInstallmentStatus" AS ENUM (
    'SCHEDULED', 'INVOICED', 'DUE', 'OVERDUE',
    'PARTIAL', 'PAID', 'WAIVED', 'SUSPENDED', 'CANCELLED', 'REFUNDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentStatus" AS ENUM ('RECEIVED', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "FeeAdjustmentKind" AS ENUM ('LATE_FEE', 'DISCOUNT', 'SCHOLARSHIP', 'WAIVER', 'WRITE_OFF');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BillingCadence" AS ENUM (
    'MONTHLY', 'QUARTERLY', 'TRIMESTER', 'SEMESTER', 'TERM', 'ANNUAL', 'CUSTOM'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 4. Enrollment additions — pause-window caches for fast filtering.
-- ---------------------------------------------------------------------------
ALTER TABLE enrollments
  ADD COLUMN IF NOT EXISTS paused_at  timestamptz,
  ADD COLUMN IF NOT EXISTS resumed_at timestamptz;

-- ---------------------------------------------------------------------------
-- 5. fee_plans
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_plans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  enrollment_id        uuid NOT NULL,
  cadence              "BillingCadence" NOT NULL,
  total_minor          bigint NOT NULL,
  currency             char(3) NOT NULL,
  scholarship_minor    bigint NOT NULL DEFAULT 0,
  status               "FeePlanStatus" NOT NULL DEFAULT 'DRAFT',
  starts_on            date NOT NULL,
  ends_on              date,
  paused_at            timestamptz,
  paused_reason        text,
  resumed_at           timestamptz,
  superseded_by_id     uuid,
  late_fee_policy      jsonb,
  notes                text,
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_id        uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_id        uuid,
  deleted_at           timestamptz,
  CONSTRAINT fee_plans_tenant_fk      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fee_plans_enrollment_fk  FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE CASCADE,
  CONSTRAINT fee_plans_supersede_fk   FOREIGN KEY (superseded_by_id) REFERENCES fee_plans(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS fee_plans_tenant_status_idx     ON fee_plans (tenant_id, status);
CREATE INDEX IF NOT EXISTS fee_plans_tenant_enrollment_idx ON fee_plans (tenant_id, enrollment_id);

-- Partial unique: at most one ACTIVE plan per enrollment (a paused plan still
-- counts as ACTIVE-not-CANCELLED; CANCELLED/COMPLETED don't gate regeneration).
CREATE UNIQUE INDEX IF NOT EXISTS fee_plans_one_active_per_enrollment
  ON fee_plans (enrollment_id)
  WHERE status IN ('DRAFT', 'ACTIVE', 'PAUSED') AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 6. fee_installments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_installments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  fee_plan_id          uuid NOT NULL,
  sequence_no          int NOT NULL,
  label                text NOT NULL,
  due_on               date NOT NULL,
  gross_minor          bigint NOT NULL,
  net_minor            bigint NOT NULL,
  paid_minor           bigint NOT NULL DEFAULT 0,
  balance_minor        bigint NOT NULL,
  currency             char(3) NOT NULL,
  status               "FeeInstallmentStatus" NOT NULL DEFAULT 'SCHEDULED',
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_id        uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_id        uuid,
  deleted_at           timestamptz,
  CONSTRAINT fee_installments_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fee_installments_plan_fk   FOREIGN KEY (fee_plan_id) REFERENCES fee_plans(id) ON DELETE CASCADE,
  CONSTRAINT fee_installments_seq_uq    UNIQUE (fee_plan_id, sequence_no),
  CONSTRAINT fee_installments_amounts_nonneg CHECK (
    gross_minor >= 0 AND net_minor >= 0 AND paid_minor >= 0
  )
);

CREATE INDEX IF NOT EXISTS fee_installments_tenant_status_due_idx ON fee_installments (tenant_id, status, due_on);
CREATE INDEX IF NOT EXISTS fee_installments_tenant_due_idx        ON fee_installments (tenant_id, due_on);

-- ---------------------------------------------------------------------------
-- 7. payments + receipt-number sequence helper
--
-- One sequence per tenant via a SECURITY DEFINER function that lazily creates
-- the sequence on first call. Format: "R-<YYYY>-<6-digit-zero-padded>".
-- The sequence advances atomically — no race vs MAX+1.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION billing_next_receipt_no(p_tenant uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  seq_name text;
  next_val bigint;
BEGIN
  seq_name := format('billing_receipt_seq_%s', replace(p_tenant::text, '-', '_'));
  -- Create on first use; per-tenant so sequences never share a counter.
  EXECUTE format(
    'CREATE SEQUENCE IF NOT EXISTS %I MINVALUE 1 START WITH 1',
    seq_name
  );
  EXECUTE format('SELECT nextval(%L)', seq_name) INTO next_val;
  RETURN format('R-%s-%s', to_char(now() AT TIME ZONE 'UTC', 'YYYY'), lpad(next_val::text, 6, '0'));
END;
$$;

-- spv_app needs to call the function (which runs as definer/owner internally).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spv_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION billing_next_receipt_no(uuid) TO spv_app';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  student_id           uuid NOT NULL,
  enrollment_id        uuid NOT NULL,
  received_on          date NOT NULL,
  method               "PaymentMethod" NOT NULL,
  reference            text,
  receipt_no           text NOT NULL,
  currency             char(3) NOT NULL,
  gross_minor          bigint NOT NULL CHECK (gross_minor > 0),
  status               "PaymentStatus" NOT NULL DEFAULT 'RECEIVED',
  notes                text,
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_id        uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_id        uuid,
  deleted_at           timestamptz,
  CONSTRAINT payments_tenant_fk     FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT payments_student_fk    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT payments_enrollment_fk FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE CASCADE,
  CONSTRAINT payments_receipt_uq    UNIQUE (tenant_id, receipt_no)
);

CREATE INDEX IF NOT EXISTS payments_tenant_student_received_idx ON payments (tenant_id, student_id, received_on DESC);
CREATE INDEX IF NOT EXISTS payments_tenant_enrollment_status_idx ON payments (tenant_id, enrollment_id, status);

-- ---------------------------------------------------------------------------
-- 8. payment_allocations — many allocations per payment, sum ≤ payment.gross.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_allocations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  payment_id           uuid NOT NULL,
  fee_installment_id   uuid NOT NULL,
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_id        uuid,
  CONSTRAINT payment_allocations_tenant_fk      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT payment_allocations_payment_fk     FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
  CONSTRAINT payment_allocations_installment_fk FOREIGN KEY (fee_installment_id) REFERENCES fee_installments(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS payment_allocations_tenant_payment_idx     ON payment_allocations (tenant_id, payment_id);
CREATE INDEX IF NOT EXISTS payment_allocations_tenant_installment_idx ON payment_allocations (tenant_id, fee_installment_id);

-- Invariant: per-payment allocated total ≤ payment.gross_minor.
-- Enforced by trigger because Postgres can't express cross-row CHECKs.
CREATE OR REPLACE FUNCTION payment_allocations_check_sum()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  alloc_sum bigint;
  pay_gross bigint;
BEGIN
  SELECT COALESCE(SUM(amount_minor), 0) INTO alloc_sum
    FROM payment_allocations
    WHERE payment_id = NEW.payment_id;
  SELECT gross_minor INTO pay_gross
    FROM payments
    WHERE id = NEW.payment_id;
  IF alloc_sum > pay_gross THEN
    RAISE EXCEPTION 'payment_allocations sum (%s) exceeds payment.gross_minor (%s) for payment %', alloc_sum, pay_gross, NEW.payment_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_allocations_check_sum_trg ON payment_allocations;
CREATE CONSTRAINT TRIGGER payment_allocations_check_sum_trg
  AFTER INSERT OR UPDATE ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_allocations_check_sum();

-- ---------------------------------------------------------------------------
-- 9. fee_adjustments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fee_adjustments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  fee_installment_id   uuid NOT NULL,
  kind                 "FeeAdjustmentKind" NOT NULL,
  amount_minor         bigint NOT NULL,
  reason_code          text,
  reason_text          text NOT NULL,
  applied_on           date NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_id        uuid,
  CONSTRAINT fee_adjustments_tenant_fk      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fee_adjustments_installment_fk FOREIGN KEY (fee_installment_id) REFERENCES fee_installments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fee_adjustments_tenant_installment_idx ON fee_adjustments (tenant_id, fee_installment_id);
CREATE INDEX IF NOT EXISTS fee_adjustments_tenant_kind_applied_idx ON fee_adjustments (tenant_id, kind, applied_on);

-- ---------------------------------------------------------------------------
-- 10. refunds
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refunds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  payment_id           uuid NOT NULL,
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  refunded_on          date,
  method               "PaymentMethod" NOT NULL,
  reference            text,
  reason_code          text NOT NULL,
  reason_text          text NOT NULL,
  status               "RefundStatus" NOT NULL DEFAULT 'PENDING',
  notes                text,
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_id        uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_id        uuid,
  CONSTRAINT refunds_tenant_fk  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT refunds_payment_fk FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS refunds_tenant_payment_idx ON refunds (tenant_id, payment_id);
CREATE INDEX IF NOT EXISTS refunds_tenant_status_idx  ON refunds (tenant_id, status);

-- ---------------------------------------------------------------------------
-- 11. student_credits
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_credits (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  student_id           uuid NOT NULL,
  enrollment_id        uuid,
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  currency             char(3) NOT NULL,
  source               text NOT NULL,
  source_ref_id        uuid,
  consumed_minor       bigint NOT NULL DEFAULT 0 CHECK (consumed_minor >= 0),
  expires_on           date,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by_id        uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_credits_tenant_fk     FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT student_credits_student_fk    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
  CONSTRAINT student_credits_enrollment_fk FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE SET NULL,
  CONSTRAINT student_credits_consumed_le_amount CHECK (consumed_minor <= amount_minor)
);

CREATE INDEX IF NOT EXISTS student_credits_tenant_student_idx    ON student_credits (tenant_id, student_id);
CREATE INDEX IF NOT EXISTS student_credits_tenant_enrollment_idx ON student_credits (tenant_id, enrollment_id);

-- ---------------------------------------------------------------------------
-- 12. RLS — every billing table is tenant-scoped via app_current_tenant().
-- Pattern lifted from migrations/20991231235961_add_checklist_rls.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'fee_plans',
    'fee_installments',
    'payments',
    'payment_allocations',
    'fee_adjustments',
    'refunds',
    'student_credits'
  ];
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
    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON %I; '
      'CREATE POLICY tenant_isolation ON %I '
      'USING (tenant_id = app_current_tenant() OR app_current_tenant() IS NULL) '
      'WITH CHECK (tenant_id = app_current_tenant() OR app_current_tenant() IS NULL);',
      tbl, tbl
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 13. Grants — spv_app is the runtime DML role; mirror existing privilege model.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spv_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON fee_plans           TO spv_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON fee_installments    TO spv_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON payments            TO spv_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON payment_allocations TO spv_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON fee_adjustments     TO spv_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON refunds             TO spv_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON student_credits     TO spv_app';
  END IF;
END $$;
