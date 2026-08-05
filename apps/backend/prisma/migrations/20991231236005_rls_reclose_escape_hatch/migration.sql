-- ============================================================================
-- SVT-SEC-2026-08 — RE-CLOSE the RLS escape hatch on 21 tables.
--
-- WHAT HAPPENED
-- -------------
-- 20991231235983_rls_remove_escape_hatch stripped the
--
--     OR app_current_tenant() IS NULL
--
-- clause from every tenant_isolation policy, because that clause defeats RLS
-- entirely for any connection where `app.tenant_id` is unset. Its header spells
-- this out: "A single missing `req.db` lets a query read every tenant's rows."
--
-- Three migrations that sort AFTER …983 then re-created policies using the old
-- shape, so for their tables the hole is open again — the last writer wins:
--
--   20991231235986b_crm_v2_mirror   → 17 crm_* tables (the full V2 CRM mirror:
--                                     lead identity, guardians, payments,
--                                     remarks, call history — high-sensitivity PII)
--   20991231235986d_spv_overlay     → spv_lead_overlay, spv_lead_fees
--   20991231235987_v2_tracker_tables→ tracked_students, tracked_student_fees
--
-- (A fourth, 20991231236003_student_credit_ledger, was corrected in place
-- before it ever ran anywhere.)
--
-- WHY IT MATTERS HERE SPECIFICALLY
-- --------------------------------
-- Several code paths legitimately query without the GUC set — background jobs
-- and cleanup crons among them. On these tables that is not "returns nothing",
-- it is "returns and mutates every tenant's rows". Tenant isolation is the
-- single control that makes this system safe to run multi-tenant, and for the
-- CRM estate it has been off.
--
-- WHY THIS IS SAFE TO APPLY
-- -------------------------
--   * Prisma migrations run as the owner/BYPASSRLS role, so this migration is
--     itself unaffected by the tightened policy.
--   * The app runtime always sets app.tenant_id via middlewares/tenantContext.ts.
--   * Any job that legitimately needs cross-tenant reach must use the admin
--     client explicitly, or wrap per tenant via shared/tenantTx.ts — which is
--     the intended design and is now the ONLY way, rather than something a
--     forgotten `req.db` silently grants.
--   * A connection that forgets the GUC now sees zero rows. That fails safe
--     and is loudly debuggable, instead of failing open and silent.
--
-- Idempotent: DROP POLICY IF EXISTS … CREATE POLICY. Safe to re-run.
-- ============================================================================

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    -- 20991231235986b_crm_v2_mirror
    'crm_countries',
    'crm_institutions',
    'crm_courses',
    'crm_leads',
    'crm_applications',
    'crm_lead_courses',
    'crm_lead_course_history',
    'crm_payments',
    'crm_remarks',
    'crm_follow_ups',
    'crm_call_history',
    'crm_visits',
    'crm_assignments',
    'crm_qualifications',
    'crm_language_tests',
    'crm_guardians',
    'crm_lead_fees',
    -- 20991231235986d_spv_overlay
    'spv_lead_overlay',
    'spv_lead_fees',
    -- 20991231235987_v2_tracker_tables
    'tracked_students',
    'tracked_student_fees'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      CONTINUE;
    END IF;

    -- FORCE so the table owner is subject to the policy too. The three source
    -- migrations set this, but assert it here so the guarantee does not depend
    -- on their having run in the expected order.
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', tbl);
    EXECUTE format(
      'DROP POLICY IF EXISTS tenant_isolation ON %I; '
      'CREATE POLICY tenant_isolation ON %I '
      'USING (tenant_id = app_current_tenant()) '
      'WITH CHECK (tenant_id = app_current_tenant());',
      tbl, tbl
    );
  END LOOP;
END $$;
