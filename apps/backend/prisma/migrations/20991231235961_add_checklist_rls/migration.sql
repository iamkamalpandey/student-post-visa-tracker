-- ============================================================================
-- RLS for per-stage checklist tables.
--
-- Tables (created via prisma db push from the Aug-2026 schema bump):
--   * lifecycle_stage_checklist_items     — per-stage task definitions
--   * student_stage_checklist_progress    — per-student completion state
--
-- Both are tenant-scoped and must follow the same tenant_isolation pattern
-- already used by the init migration: tenant_id = app_current_tenant() OR NULL
-- (NULL means no session context — used by jobs/scripts).
--
-- Idempotent: ALTER TABLE … ENABLE RLS is a no-op when already enabled, and
-- the policy DROPs precede the CREATEs. Safe to re-run.
-- ============================================================================

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'lifecycle_stage_checklist_items',
    'student_stage_checklist_progress'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Skip silently if the table doesn't exist yet (db push order races).
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

-- spv_app inherits DML grants from the default-privileges set in the init migration,
-- but a fresh re-grant is cheap insurance for envs that pre-existed the default.
GRANT SELECT, INSERT, UPDATE, DELETE ON lifecycle_stage_checklist_items TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON student_stage_checklist_progress TO spv_app;
