-- SVT-PERF-2026-06 — composite indexes for the CRM applications list hot path.
--
-- listApplications resolves the visa-accepted (v2_lead_id, v2_course_id) pairs
-- then filters crm_applications by an OR-of-pairs; with no index on those
-- columns the planner seq-scans the table (twice — the list + its count) on
-- every page load. The vaPairs resolver itself filters crm_lead_courses by
-- (tenant_id, state_v2, deleted_at) but only had a low-cardinality single-column
-- state_v2 index. Idempotent (CREATE INDEX IF NOT EXISTS) so it is safe to run
-- against the db-push dev DB and re-run on prod migrate deploy.

CREATE INDEX IF NOT EXISTS "crm_applications_tenant_id_v2_lead_id_v2_course_id_idx"
  ON "crm_applications" ("tenant_id", "v2_lead_id", "v2_course_id");

CREATE INDEX IF NOT EXISTS "crm_lead_courses_tenant_id_state_v2_deleted_at_idx"
  ON "crm_lead_courses" ("tenant_id", "state_v2", "deleted_at");
