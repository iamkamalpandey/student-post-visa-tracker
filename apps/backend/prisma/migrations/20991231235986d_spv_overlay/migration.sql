-- SVT-FEDERATION-2026-06 — SPVT overlay tables (v2-id keyed), independent of the
-- crm_* mirror. Home for SPVT-owned data when reading V2 LIVE. Idempotent.

CREATE TABLE IF NOT EXISTS "spv_lead_overlay" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"       uuid NOT NULL,
  "v2_lead_id"      integer NOT NULL,
  "spv_status"      "CrmLeadStatus" NOT NULL DEFAULT 'ACTIVE',
  "assigned_to_id"  uuid,
  "spv_notes"       text,
  "student_id"      uuid,
  "converted_at"    timestamptz,
  "converted_by_id" uuid,
  "version"         integer NOT NULL DEFAULT 1,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "created_by_id"   uuid,
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_by_id"   uuid,
  "deleted_at"      timestamptz,
  "deleted_by_id"   uuid
);

CREATE TABLE IF NOT EXISTS "spv_lead_fees" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"         uuid NOT NULL,
  "v2_lead_id"        integer NOT NULL,
  "v2_application_id" integer,
  "session_label"     text NOT NULL,
  "amount_minor"      bigint NOT NULL CHECK ("amount_minor" >= 0),
  "currency"          char(3) NOT NULL,
  "due_on"            date NOT NULL,
  "status"            "CrmFeeStatus" NOT NULL DEFAULT 'SCHEDULED',
  "paid_at"           timestamptz,
  "paid_amount_minor" bigint CHECK ("paid_amount_minor" IS NULL OR "paid_amount_minor" >= 0),
  "notes"             text,
  "seeded_from_v2"    boolean NOT NULL DEFAULT false,
  "version"           integer NOT NULL DEFAULT 1,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "created_by_id"     uuid,
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_by_id"     uuid,
  "deleted_at"        timestamptz,
  "deleted_by_id"     uuid
);

-- Uniques (upsert-by-v2-id + 1:1 student link) + indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "spv_lead_overlay_v2_uq" ON "spv_lead_overlay" ("tenant_id", "v2_lead_id");
CREATE UNIQUE INDEX IF NOT EXISTS "spv_lead_overlay_student_id_key" ON "spv_lead_overlay" ("student_id");
CREATE INDEX IF NOT EXISTS "spv_lead_overlay_assignee_idx" ON "spv_lead_overlay" ("tenant_id", "assigned_to_id");
CREATE INDEX IF NOT EXISTS "spv_lead_overlay_deleted_idx" ON "spv_lead_overlay" ("deleted_at");
CREATE INDEX IF NOT EXISTS "spv_lead_fees_status_due_idx" ON "spv_lead_fees" ("tenant_id", "status", "due_on");
CREATE INDEX IF NOT EXISTS "spv_lead_fees_lead_idx" ON "spv_lead_fees" ("tenant_id", "v2_lead_id");
CREATE INDEX IF NOT EXISTS "spv_lead_fees_deleted_idx" ON "spv_lead_fees" ("deleted_at");

-- FKs (all same-DB SPVT tables). Tenant CASCADE; assignee/student SET NULL.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='spv_lead_overlay_tenant_fk') THEN
    ALTER TABLE "spv_lead_overlay" ADD CONSTRAINT "spv_lead_overlay_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='spv_lead_overlay_student_fk') THEN
    ALTER TABLE "spv_lead_overlay" ADD CONSTRAINT "spv_lead_overlay_student_fk"
      FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='spv_lead_overlay_assignee_fk') THEN
    ALTER TABLE "spv_lead_overlay" ADD CONSTRAINT "spv_lead_overlay_assignee_fk"
      FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='spv_lead_fees_tenant_fk') THEN
    ALTER TABLE "spv_lead_fees" ADD CONSTRAINT "spv_lead_fees_tenant_fk"
      FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- RLS — guarded so it applies in prod (RLS on) + skips cleanly in dev (db-push,
-- no app_current_tenant). Matches the crm_* mirror policy for uniform behaviour.
DO $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname='app_current_tenant') THEN
    RAISE NOTICE 'app_current_tenant() absent — skipping RLS (dev db-push)';
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['spv_lead_overlay','spv_lead_fees'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I '
      'USING (tenant_id = app_current_tenant() OR app_current_tenant() IS NULL) '
      'WITH CHECK (tenant_id = app_current_tenant() OR app_current_tenant() IS NULL);', t, t);
  END LOOP;
END $$;

-- Grants to the app role (guarded).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='spv_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "spv_lead_overlay" TO spv_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "spv_lead_fees" TO spv_app;
  END IF;
END $$;
