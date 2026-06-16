-- ============================================================================
-- SVT-V2-CRM-MIRROR-2026-06 — SPVT mirror of the V2 MIS CRM relational model.
--
-- 17 crm_* tables (catalog → person/funnel → finance → activity → profile +
-- SPVT-owned fee schedule) under SPVT governance (uuid PK, tenant_id, RLS,
-- audit, soft-delete). Replaces tracked_students / tracked_student_fees.
--
-- Idempotent: guarded CREATE TYPE, CREATE TABLE IF NOT EXISTS, guarded RLS +
-- grants. FK-dependency create order. Real Postgres FKs (SPVT foreignKeys mode).
-- Pattern from 20991231235987_v2_tracker_tables + 20991231235975_billing_v1.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Enums (mirror V2 1:1, Crm-prefixed)
-- ---------------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE "CrmLeadCourseState" AS ENUM ('documents_collection','application_form','offer_received_unconditional','offer_received_conditional','offer_accepted','offer_rejected','visa_lodgement','visa_accepted','visa_refused'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CrmLeadProfileStatus" AS ENUM ('complete','incomplete'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CrmLeadPriority" AS ENUM ('LOW','NORMAL','HIGH','VIP'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CrmPaymentMethodKind" AS ENUM ('CASH','ONLINE','BANK','SPLIT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CrmVisitOutcome" AS ENUM ('REGISTERED','COUNSELLED','FOLLOW_UP_NEEDED','NO_SHOW','LOST'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CrmQualificationLevel" AS ENUM ('SLC','HIGHSCHOOL','BACHELORS','MASTERS','PHD','DIPLOMA','CERTIFICATE','PROFESSIONAL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CrmGradeScale" AS ENUM ('PERCENT','CGPA_4','CGPA_10','DIVISION','LETTER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CrmQualificationDivision" AS ENUM ('FIRST','SECOND','THIRD','PASS'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CrmLanguageTestType" AS ENUM ('IELTS','PTE','TOEFL','SAT','DUOLINGO','OET','CAMBRIDGE','GRE','GMAT','OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CrmGuardianRelationshipType" AS ENUM ('FATHER','MOTHER','SPOUSE','SIBLING','GUARDIAN','SPONSOR','EMERGENCY_CONTACT','OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CrmAssignmentKind" AS ENUM ('ASSIGNEE','FOLLOWER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CrmLeadStatus" AS ENUM ('ACTIVE','COMPLETED','WITHDRAWN','ON_HOLD'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "CrmFeeStatus" AS ENUM ('SCHEDULED','DUE','PAID','WAIVED','OVERDUE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Shared audit tail appended to each CREATE TABLE below:
--   version int NOT NULL DEFAULT 1, created_at/by, updated_at/by, deleted_at/by.

-- ---------------------------------------------------------------------------
-- 2. Catalog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_countries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL, signature text NOT NULL, currency_code text,
  v2_country_id integer NOT NULL, source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_countries_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_country_v2_dedup UNIQUE (tenant_id, v2_country_id)
);
CREATE INDEX IF NOT EXISTS crm_countries_tenant_name_idx ON crm_countries (tenant_id, name);
CREATE INDEX IF NOT EXISTS crm_countries_deleted_at_idx ON crm_countries (deleted_at);

CREATE TABLE IF NOT EXISTS crm_institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL, email text, phone text, street text, city text, state text, post_code text,
  currency_code text, category text, logo text, is_active boolean DEFAULT true,
  v2_institution_id integer NOT NULL, v2_country_id integer NOT NULL,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  country_id uuid,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_institutions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_institutions_country_fk FOREIGN KEY (country_id) REFERENCES crm_countries(id) ON DELETE SET NULL,
  CONSTRAINT crm_institution_v2_dedup UNIQUE (tenant_id, v2_institution_id)
);
CREATE INDEX IF NOT EXISTS crm_institutions_tenant_name_idx ON crm_institutions (tenant_id, name);
CREATE INDEX IF NOT EXISTS crm_institutions_country_idx ON crm_institutions (country_id);
CREATE INDEX IF NOT EXISTS crm_institutions_deleted_at_idx ON crm_institutions (deleted_at);

CREATE TABLE IF NOT EXISTS crm_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL, description text, type text, category text, start_date text, end_date text,
  fee_legacy text, fee_amount_minor bigint, fee_currency char(3),
  v2_course_id integer NOT NULL, v2_institution_id integer,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  institution_id uuid,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_courses_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_courses_institution_fk FOREIGN KEY (institution_id) REFERENCES crm_institutions(id) ON DELETE SET NULL,
  CONSTRAINT crm_course_v2_dedup UNIQUE (tenant_id, v2_course_id),
  CONSTRAINT crm_courses_fee_nonneg CHECK (fee_amount_minor IS NULL OR fee_amount_minor >= 0)
);
CREATE INDEX IF NOT EXISTS crm_courses_tenant_name_idx ON crm_courses (tenant_id, name);
CREATE INDEX IF NOT EXISTS crm_courses_institution_idx ON crm_courses (institution_id);
CREATE INDEX IF NOT EXISTS crm_courses_deleted_at_idx ON crm_courses (deleted_at);

-- ---------------------------------------------------------------------------
-- 3. Person + funnel
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  first_name text NOT NULL, last_name text NOT NULL, phone_number text NOT NULL,
  secondary_number text, gender text, address text, dob text, email text, city text,
  source text, type text, interested_course text, field_of_study text, intake_month varchar(7),
  application_status text, profile_status text, profile_state "CrmLeadProfileStatus",
  counsellor_status boolean DEFAULT false, is_archived boolean NOT NULL DEFAULT false, dropout boolean DEFAULT false,
  priority "CrmLeadPriority" NOT NULL DEFAULT 'NORMAL', tags text[] NOT NULL DEFAULT '{}',
  slc_institution_name text, slc_grade text, slc_year text,
  highschool_institution_name text, highschool_grade text, highschool_year text,
  bachelors_institution_name text, bachelors_grade text, bachelors_year text,
  masters_institution_name text, masters_grade text, masters_year text,
  ielts_overall_score text, ielts_listening_score text, ielts_reading_score text, ielts_writing_score text, ielts_speaking_score text, ielts_date text,
  pte_overall_score text, pte_listening_score text, pte_reading_score text, pte_writing_score text, pte_speaking_score text, pte_date text,
  sat_overall_score text, sat_math_score text, sat_reading_score text, sat_writing_and_language_score text, sat_date text,
  utm_source text, utm_medium text, utm_campaign text, utm_term text, utm_content text,
  landing_page text, referrer text, first_touched_at timestamptz,
  v2_created_at timestamptz, v2_updated_at timestamptz,
  v2_lead_id integer NOT NULL, source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  assigned_to_id uuid, spv_status "CrmLeadStatus" NOT NULL DEFAULT 'ACTIVE', spv_notes text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_leads_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_leads_assignee_fk FOREIGN KEY (assigned_to_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT crm_lead_v2_dedup UNIQUE (tenant_id, v2_lead_id),
  CONSTRAINT crm_lead_phone_uq UNIQUE (tenant_id, phone_number)
);
CREATE INDEX IF NOT EXISTS crm_leads_tenant_archived_idx ON crm_leads (tenant_id, is_archived);
CREATE INDEX IF NOT EXISTS crm_leads_tenant_assignee_idx ON crm_leads (tenant_id, assigned_to_id);
CREATE INDEX IF NOT EXISTS crm_leads_tenant_name_idx ON crm_leads (tenant_id, last_name, first_name);
CREATE INDEX IF NOT EXISTS crm_leads_phone_idx ON crm_leads (phone_number);
CREATE INDEX IF NOT EXISTS crm_leads_email_idx ON crm_leads (email);
CREATE INDEX IF NOT EXISTS crm_leads_deleted_at_idx ON crm_leads (deleted_at);

CREATE TABLE IF NOT EXISTS crm_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  intake_key text NOT NULL, state text NOT NULL DEFAULT 'draft', notes text,
  started_at timestamptz, completed_at timestamptz, v2_created_at timestamptz, v2_updated_at timestamptz, v2_deleted_at timestamptz,
  v2_application_id integer NOT NULL, v2_lead_id integer NOT NULL, v2_course_id integer NOT NULL,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid NOT NULL, course_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_applications_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_applications_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_applications_course_fk FOREIGN KEY (course_id) REFERENCES crm_courses(id) ON DELETE RESTRICT,
  CONSTRAINT crm_application_v2_dedup UNIQUE (tenant_id, v2_application_id),
  CONSTRAINT crm_application_business_uq UNIQUE (tenant_id, lead_id, course_id, intake_key)
);
CREATE INDEX IF NOT EXISTS crm_applications_lead_idx ON crm_applications (lead_id);
CREATE INDEX IF NOT EXISTS crm_applications_course_idx ON crm_applications (course_id);
CREATE INDEX IF NOT EXISTS crm_applications_state_idx ON crm_applications (state);
CREATE INDEX IF NOT EXISTS crm_applications_deleted_at_idx ON crm_applications (deleted_at);

CREATE TABLE IF NOT EXISTS crm_lead_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  state text, state_v2 "CrmLeadCourseState", sub_state text,
  start_date timestamptz, end_date timestamptz, is_deleted boolean NOT NULL DEFAULT false,
  v2_created_at timestamptz, v2_updated_at timestamptz,
  v2_lead_id integer NOT NULL, v2_course_id integer NOT NULL,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid NOT NULL, course_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_lead_courses_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_lead_courses_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_lead_courses_course_fk FOREIGN KEY (course_id) REFERENCES crm_courses(id) ON DELETE RESTRICT,
  CONSTRAINT crm_lead_course_v2_dedup UNIQUE (tenant_id, v2_lead_id, v2_course_id)
);
CREATE INDEX IF NOT EXISTS crm_lead_courses_lead_idx ON crm_lead_courses (lead_id);
CREATE INDEX IF NOT EXISTS crm_lead_courses_course_idx ON crm_lead_courses (course_id);
CREATE INDEX IF NOT EXISTS crm_lead_courses_state_idx ON crm_lead_courses (state_v2);
CREATE INDEX IF NOT EXISTS crm_lead_courses_deleted_at_idx ON crm_lead_courses (deleted_at);

CREATE TABLE IF NOT EXISTS crm_lead_course_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  from_state text, to_state text NOT NULL, changed_by text, changed_at timestamptz NOT NULL,
  v2_history_id integer NOT NULL, v2_lead_id integer NOT NULL, v2_course_id integer NOT NULL,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid NOT NULL, course_id uuid,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  CONSTRAINT crm_lch_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_lch_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_lead_course_history_v2_dedup UNIQUE (tenant_id, v2_history_id)
);
CREATE INDEX IF NOT EXISTS crm_lch_lead_course_idx ON crm_lead_course_history (lead_id, course_id);
CREATE INDEX IF NOT EXISTS crm_lch_state_changed_idx ON crm_lead_course_history (to_state, changed_at);

-- ---------------------------------------------------------------------------
-- 4. Finance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'NPR',
  method "CrmPaymentMethodKind" NOT NULL,
  cash_amount_minor bigint CHECK (cash_amount_minor IS NULL OR cash_amount_minor >= 0),
  online_amount_minor bigint CHECK (online_amount_minor IS NULL OR online_amount_minor >= 0),
  bank_ref text, voucher_no text, receipt_no text, received_by text, received_at timestamptz NOT NULL, notes text,
  v2_payment_id integer NOT NULL, v2_student_id integer NOT NULL, v2_lead_id integer NOT NULL, v2_class_id integer,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_payments_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_payments_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_payment_v2_dedup UNIQUE (tenant_id, v2_payment_id)
);
CREATE INDEX IF NOT EXISTS crm_payments_lead_idx ON crm_payments (lead_id);
CREATE INDEX IF NOT EXISTS crm_payments_tenant_received_idx ON crm_payments (tenant_id, received_at);
CREATE INDEX IF NOT EXISTS crm_payments_deleted_at_idx ON crm_payments (deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS crm_payment_receipt_uq ON crm_payments (tenant_id, receipt_no) WHERE receipt_no IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Activity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_remarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  content text NOT NULL, v2_user_id text, v2_created_at timestamptz, v2_updated_at timestamptz,
  v2_remark_id integer NOT NULL, v2_lead_id integer NOT NULL,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_remarks_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_remarks_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_remark_v2_dedup UNIQUE (tenant_id, v2_remark_id)
);
CREATE INDEX IF NOT EXISTS crm_remarks_lead_idx ON crm_remarks (lead_id, v2_created_at);
CREATE INDEX IF NOT EXISTS crm_remarks_deleted_at_idx ON crm_remarks (deleted_at);

CREATE TABLE IF NOT EXISTS crm_follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  date timestamptz NOT NULL, status text DEFAULT 'incomplete', v2_user_id text, v2_created_at timestamptz,
  v2_follow_up_id integer NOT NULL, v2_lead_id integer NOT NULL,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_follow_ups_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_follow_ups_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_follow_up_v2_dedup UNIQUE (tenant_id, v2_follow_up_id)
);
CREATE INDEX IF NOT EXISTS crm_follow_ups_lead_date_idx ON crm_follow_ups (lead_id, date);
CREATE INDEX IF NOT EXISTS crm_follow_ups_status_idx ON crm_follow_ups (status);
CREATE INDEX IF NOT EXISTS crm_follow_ups_deleted_at_idx ON crm_follow_ups (deleted_at);

CREATE TABLE IF NOT EXISTS crm_call_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  status text NOT NULL, notes text, v2_user_id text, v2_created_at timestamptz,
  v2_call_id integer NOT NULL, v2_lead_id integer NOT NULL,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_call_history_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_call_history_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_call_v2_dedup UNIQUE (tenant_id, v2_call_id)
);
CREATE INDEX IF NOT EXISTS crm_call_history_lead_idx ON crm_call_history (lead_id, v2_created_at);
CREATE INDEX IF NOT EXISTS crm_call_history_status_idx ON crm_call_history (status);
CREATE INDEX IF NOT EXISTS crm_call_history_deleted_at_idx ON crm_call_history (deleted_at);

CREATE TABLE IF NOT EXISTS crm_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  date text NOT NULL, purpose text NOT NULL, outcome "CrmVisitOutcome",
  v2_user_id text, v2_actor_id text, v2_branch_id integer, v2_campaign_id integer,
  v2_created_at timestamptz, v2_updated_at timestamptz,
  v2_visit_id integer NOT NULL, v2_lead_id integer NOT NULL,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_visits_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_visits_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_visit_v2_dedup UNIQUE (tenant_id, v2_visit_id)
);
CREATE INDEX IF NOT EXISTS crm_visits_lead_idx ON crm_visits (lead_id, v2_created_at);
CREATE INDEX IF NOT EXISTS crm_visits_outcome_idx ON crm_visits (outcome);
CREATE INDEX IF NOT EXISTS crm_visits_deleted_at_idx ON crm_visits (deleted_at);

CREATE TABLE IF NOT EXISTS crm_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  kind "CrmAssignmentKind" NOT NULL, v2_user_id text NOT NULL, is_active boolean NOT NULL DEFAULT false,
  v2_created_at timestamptz, v2_updated_at timestamptz,
  v2_assignment_id integer NOT NULL, v2_lead_id integer NOT NULL,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_assignments_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_assignments_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_assignment_v2_dedup UNIQUE (tenant_id, kind, v2_assignment_id)
);
CREATE INDEX IF NOT EXISTS crm_assignments_lead_idx ON crm_assignments (lead_id, kind, is_active);
CREATE INDEX IF NOT EXISTS crm_assignments_deleted_at_idx ON crm_assignments (deleted_at);

-- ---------------------------------------------------------------------------
-- 6. Applicant profile
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_qualifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  level "CrmQualificationLevel" NOT NULL, institution_name text, board_or_university text, stream_or_major text,
  grade text, grade_scale "CrmGradeScale", start_year integer, end_year integer, is_ongoing boolean NOT NULL DEFAULT false,
  division "CrmQualificationDivision", notes text, v2_created_at timestamptz, v2_updated_at timestamptz,
  v2_qualification_id integer NOT NULL, v2_lead_id integer NOT NULL,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_qualifications_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_qualifications_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_qualification_v2_dedup UNIQUE (tenant_id, v2_qualification_id)
);
CREATE INDEX IF NOT EXISTS crm_qualifications_lead_idx ON crm_qualifications (lead_id, level);
CREATE INDEX IF NOT EXISTS crm_qualifications_deleted_at_idx ON crm_qualifications (deleted_at);

CREATE TABLE IF NOT EXISTS crm_language_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  test_type "CrmLanguageTestType" NOT NULL, custom_test_name text, test_date timestamptz,
  overall_score numeric(7,2), listening_score numeric(7,2), reading_score numeric(7,2), writing_score numeric(7,2), speaking_score numeric(7,2),
  extra_scores jsonb, test_center text, reference_no text, is_official boolean NOT NULL DEFAULT true, notes text,
  v2_created_at timestamptz, v2_updated_at timestamptz,
  v2_language_test_id integer NOT NULL, v2_lead_id integer NOT NULL,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_language_tests_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_language_tests_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_language_test_v2_dedup UNIQUE (tenant_id, v2_language_test_id)
);
CREATE INDEX IF NOT EXISTS crm_language_tests_lead_idx ON crm_language_tests (lead_id, test_type);
CREATE INDEX IF NOT EXISTS crm_language_tests_deleted_at_idx ON crm_language_tests (deleted_at);

CREATE TABLE IF NOT EXISTS crm_guardians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  full_name text NOT NULL, relationship_type "CrmGuardianRelationshipType" NOT NULL, custom_relationship_label text,
  phone text, secondary_phone text, email text, address text, occupation text, notes text,
  v2_created_at timestamptz, v2_updated_at timestamptz,
  v2_guardian_id integer NOT NULL, v2_lead_id integer NOT NULL,
  source_system text NOT NULL DEFAULT 'v2_mis', synced_at timestamptz NOT NULL DEFAULT now(),
  lead_id uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_guardians_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_guardians_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_guardian_v2_dedup UNIQUE (tenant_id, v2_guardian_id)
);
CREATE INDEX IF NOT EXISTS crm_guardians_lead_idx ON crm_guardians (lead_id, relationship_type);
CREATE INDEX IF NOT EXISTS crm_guardians_deleted_at_idx ON crm_guardians (deleted_at);

-- ---------------------------------------------------------------------------
-- 7. SPVT-owned fee schedule (replaces tracked_student_fees)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_lead_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  lead_id uuid NOT NULL, application_id uuid,
  session_label text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL, due_on date NOT NULL,
  status "CrmFeeStatus" NOT NULL DEFAULT 'SCHEDULED',
  paid_at timestamptz, paid_amount_minor bigint CHECK (paid_amount_minor IS NULL OR paid_amount_minor >= 0),
  notes text, seeded_from_v2 boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), created_by_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by_id uuid,
  deleted_at timestamptz, deleted_by_id uuid,
  CONSTRAINT crm_lead_fees_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT crm_lead_fees_lead_fk FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE CASCADE,
  CONSTRAINT crm_lead_fees_application_fk FOREIGN KEY (application_id) REFERENCES crm_applications(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS crm_lead_fees_tenant_status_due_idx ON crm_lead_fees (tenant_id, status, due_on);
CREATE INDEX IF NOT EXISTS crm_lead_fees_tenant_lead_idx ON crm_lead_fees (tenant_id, lead_id);
CREATE INDEX IF NOT EXISTS crm_lead_fees_deleted_at_idx ON crm_lead_fees (deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS crm_lead_fees_seed_uq ON crm_lead_fees (lead_id, session_label) WHERE seeded_from_v2 = true AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 8. RLS — tenant isolation (guarded: dev db-push DBs lack app_current_tenant)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'crm_countries','crm_institutions','crm_courses','crm_leads','crm_applications',
    'crm_lead_courses','crm_lead_course_history','crm_payments','crm_remarks','crm_follow_ups',
    'crm_call_history','crm_visits','crm_assignments','crm_qualifications','crm_language_tests',
    'crm_guardians','crm_lead_fees'
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_current_tenant') THEN
    RAISE NOTICE 'app_current_tenant() missing — skipping RLS for crm_* tables';
    RETURN;
  END IF;
  FOREACH tbl IN ARRAY tables LOOP
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
-- 9. Grants — spv_app runtime role
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'crm_countries','crm_institutions','crm_courses','crm_leads','crm_applications',
    'crm_lead_courses','crm_lead_course_history','crm_payments','crm_remarks','crm_follow_ups',
    'crm_call_history','crm_visits','crm_assignments','crm_qualifications','crm_language_tests',
    'crm_guardians','crm_lead_fees'
  ];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spv_app') THEN
    FOREACH tbl IN ARRAY tables LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO spv_app;', tbl);
    END LOOP;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 10. Retire the lightweight tracker (replaced by the crm_* mirror).
--     Code must be repointed off prisma.trackedStudent* before this runs.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS tracked_student_fees;
DROP TABLE IF EXISTS tracked_students;
DROP TYPE IF EXISTS "TrackedFeeStatus";
DROP TYPE IF EXISTS "TrackedStudentStatus";
