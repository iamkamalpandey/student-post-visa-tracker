-- =============================================================================
-- SHARED-DB — V2 contract views (core_pub) + SPVT overlay (spv). SVT-SHARED-DB-2026-06.
-- Run AFTER 01-roles-schemas-grants.sql. Views run as core_owner; overlay as spv_app.
-- =============================================================================

-- ── PART A: V2 publishes a STABLE contract (run as core_owner) ───────────────
-- Views map V2's RAW columns → stable names SPVT depends on. V2 can then refactor
-- its real tables freely as long as these view shapes hold. Expose ONLY what SPVT
-- needs (least surface). VERIFY each source column against V2's live schema — the
-- names below are taken from the working ingest reads (apps/backend/src/integrations/
-- v2-mis/queries.ts), which is the source of truth for V2's real column names.

CREATE OR REPLACE VIEW core_pub.lead AS
  SELECT id, first_name, last_name, phone_number, secondary_number, email,
         dob, gender, city, address, source, "createdAt" AS created_at, "updatedAt" AS updated_at
  FROM core."Lead"
  WHERE COALESCE("isArchived", false) = false;

CREATE OR REPLACE VIEW core_pub.lead_course AS
  SELECT "leadId" AS lead_id, "courseId" AS course_id, state, "stateV2" AS state_v2,
         "subState" AS sub_state, "startDate" AS start_date, "endDate" AS end_date
  FROM core."LeadCourses"
  WHERE COALESCE("isDeleted", false) = false;

CREATE OR REPLACE VIEW core_pub.application AS
  SELECT id, "leadId" AS lead_id, "courseId" AS course_id, "intakeKey" AS intake_key,
         state, notes, "createdAt" AS created_at, "updatedAt" AS updated_at
  FROM core."Application"
  WHERE "deletedAt" IS NULL;

CREATE OR REPLACE VIEW core_pub.course AS
  SELECT id, name, "feeAmount" AS fee_amount, "feeCurrency" AS fee_currency, "institutionId" AS institution_id
  FROM core."Course";

CREATE OR REPLACE VIEW core_pub.institution AS
  SELECT id, name, "countryId" AS country_id FROM core."Institution";

CREATE OR REPLACE VIEW core_pub.country AS
  SELECT id, name FROM core."Country";

-- Payments link to a lead via Student.leadId (same join the mirror used).
CREATE OR REPLACE VIEW core_pub.payment AS
  SELECT p.id, s."leadId" AS lead_id, p.amount, p.currency, p.method,
         p."receivedAt" AS received_at, p."receiptNo" AS receipt_no
  FROM core."Payment" p JOIN core."Student" s ON s.id = p."studentId";

-- Grants already covered by 01's ALTER DEFAULT PRIVILEGES; explicit for existing views:
GRANT SELECT ON ALL TABLES IN SCHEMA core_pub TO spv_app;


-- ── PART B: SPVT overlay (run as spv_app — owns the spv schema) ──────────────
-- Replaces the crm_* MIRROR. SPVT no longer copies V2 identity/funnel/payments —
-- it reads those live from core_pub and stores ONLY its own data here, referencing
-- V2's lead by id (soft reference: integer, no cross-schema FK so V2 stays free to
-- evolve; integrity validated in app. Switch to a real FK to core."Lead"(id) if you
-- accept the coupling — same instance makes it possible).

-- Tenant GUC helper (fail-CLOSED variant — see below). Guarded for idempotency.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='spv_lead_status') THEN
    CREATE TYPE spv.spv_lead_status AS ENUM ('ACTIVE','COMPLETED','WITHDRAWN','ON_HOLD');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='spv_fee_status') THEN
    CREATE TYPE spv.spv_fee_status AS ENUM ('SCHEDULED','DUE','PAID','WAIVED','OVERDUE');
  END IF;
END $$;

-- SPVT-owned lead overlay (the spv_status/assigned/notes/student-link that used to
-- live on crm_leads). One row per lead SPVT manages, keyed by V2's lead id.
CREATE TABLE IF NOT EXISTS spv.lead_overlay (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  core_lead_id    integer NOT NULL,                 -- V2 "Lead".id
  spv_status      spv.spv_lead_status NOT NULL DEFAULT 'ACTIVE',
  assigned_to_id  uuid,
  spv_notes       text,
  student_id      uuid,                             -- managed-Student link (1:1)
  converted_at    timestamptz,
  converted_by_id uuid,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by_id   uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by_id   uuid,
  deleted_at      timestamptz,
  deleted_by_id   uuid,
  UNIQUE (tenant_id, core_lead_id),
  UNIQUE (tenant_id, student_id)
);

-- SPVT-owned post-visa fee schedule (replaces crm_lead_fees).
CREATE TABLE IF NOT EXISTS spv.lead_fee (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  core_lead_id      integer NOT NULL,
  session_label     text NOT NULL,
  amount_minor      bigint NOT NULL CHECK (amount_minor >= 0),
  currency          char(3) NOT NULL,
  due_on            date NOT NULL,
  status            spv.spv_fee_status NOT NULL DEFAULT 'SCHEDULED',
  paid_at           timestamptz,
  paid_amount_minor bigint CHECK (paid_amount_minor IS NULL OR paid_amount_minor >= 0),
  notes             text,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by_id     uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by_id     uuid,
  deleted_at        timestamptz,
  deleted_by_id     uuid
);
CREATE INDEX IF NOT EXISTS lead_fee_tenant_status_due ON spv.lead_fee (tenant_id, status, due_on);
CREATE INDEX IF NOT EXISTS lead_overlay_assignee ON spv.lead_overlay (tenant_id, assigned_to_id);

-- ── RLS: FAIL-CLOSED (the hardening from the middleware review) ──────────────
-- No `OR app_current_tenant() IS NULL` escape: GUC unset → ZERO rows. A raw-client
-- slip leaks nothing. System/cron jobs use a BYPASSRLS role, NOT this hole.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_overlay','lead_fee'] LOOP
    EXECUTE format('ALTER TABLE spv.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE spv.%I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON spv.%I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON spv.%I '
      'USING (tenant_id = app_current_tenant()) '
      'WITH CHECK (tenant_id = app_current_tenant());', t);
  END LOOP;
END $$;
