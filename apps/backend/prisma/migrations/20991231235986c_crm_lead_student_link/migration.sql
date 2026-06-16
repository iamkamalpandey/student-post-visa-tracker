-- SVT-INTEGRATION-2026-06 — link a CRM lead to a managed Student (the manual
-- "Convert to Student" bridge). Idempotent: safe to re-run.

ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "student_id" uuid;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "converted_at" timestamptz;
ALTER TABLE "crm_leads" ADD COLUMN IF NOT EXISTS "converted_by_id" uuid;

-- FK to students: SET NULL on student delete (keep the lead, drop the link).
-- Constraint name matches Prisma's default so introspection stays aligned.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_leads_student_id_fkey') THEN
    ALTER TABLE "crm_leads"
      ADD CONSTRAINT "crm_leads_student_id_fkey"
      FOREIGN KEY ("student_id") REFERENCES "students"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- One student ↔ one lead (single-field unique, required by Prisma's 1:1).
-- Postgres treats NULLs as distinct, so many unconverted leads coexist fine.
-- Index name matches Prisma's default for a field-level @unique.
DROP INDEX IF EXISTS "crm_lead_student_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "crm_leads_student_id_key"
  ON "crm_leads" ("student_id");
