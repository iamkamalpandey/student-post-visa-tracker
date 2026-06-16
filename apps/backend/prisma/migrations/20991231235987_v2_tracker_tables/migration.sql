-- ============================================================================
-- SVT-V2-TRACKER-2026-06 — Post-Visa Tracker tables.
--
-- Lightweight, read-only mirror of visa-accepted leads ingested from the
-- external "V2 MIS" (TheNextMis) Postgres, plus a per-session fee schedule that
-- feeds the existing Reminder + comms pipeline (source_entity_type =
-- 'tracked_student_fee'). Deliberately NOT the heavy Student/Enrollment/FeePlan
-- pipeline — V2 Lead carries only name/phone/email.
--
-- Idempotent: guarded CREATE TYPE, CREATE TABLE IF NOT EXISTS, DROP POLICY
-- IF EXISTS before CREATE POLICY. Tables BEFORE indexes/RLS. RLS + grants LAST.
-- Pattern lifted from 20991231235975_billing_v1.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "TrackedStudentStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'WITHDRAWN', 'ON_HOLD');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "TrackedFeeStatus" AS ENUM ('SCHEDULED', 'DUE', 'PAID', 'WAIVED', 'OVERDUE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. tracked_students
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracked_students (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  v2_lead_id         integer NOT NULL,
  v2_course_id       integer NOT NULL,
  source_system      text NOT NULL DEFAULT 'v2_mis',
  given_name         text NOT NULL,
  family_name        text NOT NULL,
  email              text,
  phone_e164         text,
  gender             text,
  course_name        text NOT NULL,
  v2_institution_id  integer,
  institution_name   text,
  country_code       char(2),
  visa_state         text NOT NULL DEFAULT 'visa_accepted',
  visa_accepted_at   timestamptz,
  intake_key         text,
  session_start_date date,
  status             "TrackedStudentStatus" NOT NULL DEFAULT 'ACTIVE',
  assigned_to_id     uuid,
  notes              text,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  version            int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by_id      uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by_id      uuid,
  deleted_at         timestamptz,
  deleted_by_id      uuid,
  CONSTRAINT tracked_students_tenant_fk   FOREIGN KEY (tenant_id)      REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT tracked_students_assignee_fk FOREIGN KEY (assigned_to_id) REFERENCES users(id)   ON DELETE SET NULL,
  CONSTRAINT tracked_student_v2_dedup     UNIQUE (tenant_id, v2_lead_id, v2_course_id)
);

CREATE INDEX IF NOT EXISTS tracked_students_tenant_status_idx   ON tracked_students (tenant_id, status);
CREATE INDEX IF NOT EXISTS tracked_students_tenant_assignee_idx ON tracked_students (tenant_id, assigned_to_id);
CREATE INDEX IF NOT EXISTS tracked_students_tenant_session_idx  ON tracked_students (tenant_id, session_start_date);
CREATE INDEX IF NOT EXISTS tracked_students_deleted_at_idx      ON tracked_students (deleted_at);

-- ---------------------------------------------------------------------------
-- 3. tracked_student_fees
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracked_student_fees (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  tracked_student_id uuid NOT NULL,
  session_label      text NOT NULL,
  amount_minor       bigint NOT NULL CHECK (amount_minor >= 0),
  currency           char(3) NOT NULL,
  due_on             date NOT NULL,
  status             "TrackedFeeStatus" NOT NULL DEFAULT 'SCHEDULED',
  paid_at            timestamptz,
  paid_amount_minor  bigint CHECK (paid_amount_minor IS NULL OR paid_amount_minor >= 0),
  notes              text,
  seeded_from_v2     boolean NOT NULL DEFAULT false,
  version            int NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by_id      uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by_id      uuid,
  deleted_at         timestamptz,
  deleted_by_id      uuid,
  CONSTRAINT tracked_student_fees_tenant_fk  FOREIGN KEY (tenant_id)          REFERENCES tenants(id)          ON DELETE CASCADE,
  CONSTRAINT tracked_student_fees_student_fk FOREIGN KEY (tracked_student_id) REFERENCES tracked_students(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tracked_student_fees_tenant_status_due_idx ON tracked_student_fees (tenant_id, status, due_on);
CREATE INDEX IF NOT EXISTS tracked_student_fees_tenant_student_idx    ON tracked_student_fees (tenant_id, tracked_student_id);
CREATE INDEX IF NOT EXISTS tracked_student_fees_deleted_at_idx        ON tracked_student_fees (deleted_at);

-- Partial unique → idempotent V2 fee seeding (one seeded fee per session label).
-- Lets the ingest job createMany({ skipDuplicates: true }) re-run safely and
-- never overwrite a human-edited fee. Mirrors fee_plans_one_active_per_enrollment.
CREATE UNIQUE INDEX IF NOT EXISTS tracked_student_fees_seed_uq
  ON tracked_student_fees (tracked_student_id, session_label)
  WHERE seeded_from_v2 = true AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. RLS — tenant-scoped via app_current_tenant() (defined in init migration).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY['tracked_students', 'tracked_student_fees'];
BEGIN
  -- The tenant helper is created by the init RLS migration. Production has it;
  -- a `prisma db push` dev DB may not. Skip RLS wiring when absent so this
  -- migration applies cleanly in both — dev then matches its (unpoliced) peers.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_current_tenant') THEN
    RAISE NOTICE 'app_current_tenant() missing — skipping RLS for tracker tables';
    RETURN;
  END IF;
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
-- 5. Grants — spv_app is the runtime DML role.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spv_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON tracked_students     TO spv_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON tracked_student_fees TO spv_app';
  END IF;
END $$;
