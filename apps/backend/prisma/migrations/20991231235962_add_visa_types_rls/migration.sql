-- ============================================================================
-- v6: RLS for visa_types.
--
-- The table is created via `prisma db push` from the v6 schema bump (see
-- VisaType model). This migration only enables RLS so production parity with
-- the other tenant-scoped tables (lifecycle_stages, students, ...) is
-- preserved.
--
-- Idempotent: ALTER TABLE … ENABLE RLS is a no-op when already enabled, and
-- the policy DROP precedes the CREATE. Safe to re-run.
-- ============================================================================

DO $$
BEGIN
  -- Skip silently if the table doesn't exist yet (db push order races).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'visa_types'
  ) THEN
    RAISE NOTICE 'visa_types table not yet present, skipping RLS enable';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE visa_types ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE visa_types FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON visa_types';
  EXECUTE
    'CREATE POLICY tenant_isolation ON visa_types '
    'USING (tenant_id = app_current_tenant() OR app_current_tenant() IS NULL) '
    'WITH CHECK (tenant_id = app_current_tenant() OR app_current_tenant() IS NULL)';
END $$;

-- spv_app inherits DML grants from the default-privileges set in the init
-- migration; an explicit re-grant is cheap insurance for envs that pre-existed
-- the default.
GRANT SELECT, INSERT, UPDATE, DELETE ON visa_types TO spv_app;
