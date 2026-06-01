-- ============================================================================
-- SVT-SEC-RLS-ESCAPE-HATCH-2026-05 — Remove the `OR app_current_tenant() IS
-- NULL` escape clause from every tenant_isolation policy.
--
-- Background
-- ----------
-- The init migration (20991231235959_init_rls_and_triggers) and every
-- subsequent RLS migration created tenant_isolation policies of the shape:
--
--   USING (tenant_id = app_current_tenant() OR app_current_tenant() IS NULL)
--   WITH CHECK (tenant_id = app_current_tenant() OR app_current_tenant() IS NULL)
--
-- The `OR ... IS NULL` clause was originally added so background jobs / one-off
-- scripts running without a session GUC could still touch rows. In practice
-- this clause defeats RLS for ANY connection on which `app.tenant_id` is unset
-- (or set to empty string) — including any app-path bug that forgets to wrap
-- a query in the tenant-scoped client. A single missing `req.db` lets a query
-- read every tenant's rows.
--
-- This migration drops every existing tenant_isolation policy on the affected
-- tables and recreates them WITHOUT the `OR ... IS NULL` clause, so the only
-- way to read/write a row is to have the matching tenant id set on the
-- session GUC.
--
-- Why this is safe
-- ----------------
--   * Prisma migrations run as the spv_admin role (BYPASSRLS), so this
--     migration itself is unaffected by the tightened policy.
--   * The app runtime always goes through middlewares/tenantContext.ts, which
--     wraps every operation in a transaction that runs
--     `SELECT set_config('app.tenant_id', <tenant>, true)` BEFORE the query.
--     Any code path that reads/writes rows MUST go through this client; the
--     few callsites that legitimately need cross-tenant access (auth.service
--     login lookup, password reset request, refresh-token lookup, logout) all
--     query the singleton prisma client which runs as spv_admin / a session
--     that effectively bypasses RLS — see those services for the rationale.
--
-- The audit_logs / breach_incidents / access_token_denylist /
-- student_lifecycle_events policies created in
-- 20991231235966_critical_rls_coverage additionally have a `tenant_id IS NULL`
-- branch (system rows with no tenant ownership — global audit entries). That
-- branch stays — it is intentional and not the escape hatch under attack.
--
-- The audit_anchors policy (20991231235979) already uses
-- `current_setting(..., true)` directly (no helper function) and includes
-- `tenant_id IS NULL` for global anchors; it is functionally equivalent and
-- left alone.
--
-- The password_reset_tokens policy (20991231235977) uses a stricter shape
-- already (`current_setting(..., true)` equality only — no NULL escape).
-- Left alone.
--
-- Idempotent: DROP POLICY IF EXISTS … CREATE POLICY. Safe to re-run.
-- ============================================================================

DO $$
DECLARE
  tbl text;
  -- Every table that received a tenant_isolation policy with the
  -- `OR app_current_tenant() IS NULL` escape clause. Lists are sourced from
  -- the migrations enumerated in the header of this file.
  tables text[] := ARRAY[
    -- init migration
    'students', 'student_addresses', 'student_identifications', 'student_visas',
    'student_regulator_identifiers', 'compliance_checks', 'engagement_checks',
    'student_employment', 'student_dependents', 'academic_qualifications',
    'language_test_results', 'student_contacts', 'student_sponsorships',
    'sponsors', 'institutions', 'programs', 'enrollments', 'travel_records',
    'accommodations', 'insurance_records', 'finance_items', 'documents',
    'comms_threads', 'comms_messages', 'addresses', 'tags', 'entity_tags', 'notes',
    'attribute_definitions', 'entity_attributes', 'saved_views',
    'student_lifecycle_events', 'lifecycle_stages', 'lifecycle_stage_transitions',
    'message_templates', 'relationship_types', 'document_types',
    'sub_processors', 'consent_records', 'dsar_requests',
    'import_jobs', 'import_mapping_templates', 'export_jobs', 'external_ids',
    'idempotency_records',
    'reminders', 'commission_claims',
    'users', 'refresh_tokens',
    -- checklist RLS migration
    'lifecycle_stage_checklist_items', 'student_stage_checklist_progress',
    -- visa types RLS migration
    'visa_types',
    -- super agents migrations
    'super_agents', 'institution_super_agents',
    'super_agent_types', 'super_agent_contacts', 'super_agent_commission_rules',
    -- billing v1
    'fee_plans', 'fee_installments', 'payments', 'payment_allocations',
    'fee_adjustments', 'refunds', 'student_credits'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      RAISE NOTICE 'Skipping %: table does not exist', tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', tbl);
    -- Drop the escape-hatched policy and recreate it WITHOUT the
    -- `OR app_current_tenant() IS NULL` branch.
    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON %I; '
      'CREATE POLICY tenant_isolation ON %I '
      'USING (tenant_id = app_current_tenant()) '
      'WITH CHECK (tenant_id = app_current_tenant());',
      tbl, tbl
    );
  END LOOP;
END $$;

-- Tenants table self-read policy gets the same treatment.
DROP POLICY IF EXISTS tenant_self_read ON tenants;
CREATE POLICY tenant_self_read ON tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

-- ----------------------------------------------------------------------------
-- The four "critical coverage" tables (audit_logs, access_token_denylist,
-- breach_incidents, student_lifecycle_events from
-- 20991231235966_critical_rls_coverage) originally had a THREE-WAY policy:
--
--   USING (tenant_id = app_current_tenant()
--          OR app_current_tenant() IS NULL
--          OR tenant_id IS NULL)
--
-- We keep the `tenant_id IS NULL` branch (system-actor rows that belong to no
-- tenant — global audit and global breach incidents must remain visible across
-- the system administration surface), but drop the `app_current_tenant() IS
-- NULL` escape clause for the same reason as above.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'audit_logs',
    'access_token_denylist',
    'breach_incidents'
    -- NB: student_lifecycle_events is in the main array above; it does NOT
    -- carry the `tenant_id IS NULL` branch in production data.
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      RAISE NOTICE 'Skipping %: table does not exist', tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', tbl);
    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON %I; '
      'CREATE POLICY tenant_isolation ON %I '
      '  USING (tenant_id = app_current_tenant() OR tenant_id IS NULL) '
      '  WITH CHECK (tenant_id = app_current_tenant() OR tenant_id IS NULL);',
      tbl, tbl
    );
  END LOOP;
END $$;
