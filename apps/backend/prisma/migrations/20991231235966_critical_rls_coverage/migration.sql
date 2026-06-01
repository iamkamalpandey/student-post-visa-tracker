-- ============================================================================
-- Critical RLS coverage gap.
--
-- The init migration enumerates a fixed list of tenant-scoped tables for RLS,
-- but four tables that carry tenant_id were never added:
--
--   * audit_logs              — tamper-evident audit chain (nullable tenant_id)
--   * access_token_denylist   — revoked JWT JTIs (non-null tenant_id)
--   * breach_incidents        — GDPR Art. 33 records (nullable tenant_id)
--   * student_lifecycle_events — append-only stage transition log (non-null)
--
-- Without RLS any session that authenticates as spv_app (the application role)
-- can read every tenant's rows in these tables. The cross-tenant leak is
-- particularly severe for audit_logs and breach_incidents, where forensic and
-- regulator-facing data sits.
--
-- Pattern matches the init migration's tenant_isolation: rows match the active
-- app.tenant_id (set via set_config in tenantContext middleware) OR when no
-- tenant is active (jobs / scripts) all rows are visible. NULL tenant_id rows
-- (system actors in audit_logs, global breach incidents) are always visible
-- because the policy treats NULL as "shared/global".
--
-- Idempotent: re-running is a no-op (ENABLE RLS / DROP POLICY IF EXISTS / CREATE).
-- ============================================================================

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'audit_logs',
    'access_token_denylist',
    'breach_incidents',
    'student_lifecycle_events'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Tables created via the init migration; this guard only matters if the
    -- migration runs before the table exists (shouldn't happen in our linear
    -- migration order, but cheap insurance).
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      RAISE NOTICE 'Skipping RLS for %: table does not exist', tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', tbl);
    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON %I; '
      'CREATE POLICY tenant_isolation ON %I '
      '  USING (tenant_id = app_current_tenant() OR app_current_tenant() IS NULL OR tenant_id IS NULL) '
      '  WITH CHECK (tenant_id = app_current_tenant() OR app_current_tenant() IS NULL OR tenant_id IS NULL);',
      tbl, tbl
    );
  END LOOP;
END $$;

-- Refresh grants so the policy applies cleanly to spv_app sessions even in
-- environments that pre-existed the default-privileges grant in init.
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_logs TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON access_token_denylist TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON breach_incidents TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON student_lifecycle_events TO spv_app;

-- ============================================================================
-- Deferred (intentionally not in this migration):
--
-- The following tables also lack RLS but do NOT carry tenant_id directly —
-- they inherit tenancy through their parent FK (Institution/Program). Adding
-- RLS would require a subquery policy that joins to the parent on every row:
--
--   USING (EXISTS (SELECT 1 FROM institutions i
--                  WHERE i.id = campuses.institution_id
--                    AND i.tenant_id = app_current_tenant()))
--
-- That cost is non-trivial on hot reads. The parent-table RLS on Institution
-- and Program already prevents cross-tenant access via the Prisma query paths
-- (every nested-relation read traverses the tenant-scoped parent). A dedicated
-- migration can layer the subquery policy onto these tables later if a real
-- bypass is demonstrated:
--
--   campuses, schools, departments,
--   institution_identifiers, institution_accreditations, institution_contacts,
--   program_intakes, program_requirements, program_modules, program_fees
-- ============================================================================
