-- SVT-QA-2026-08 — close the RLS gap on institution + program child tables.
--
-- Migration 20991231235966_critical_rls_coverage explicitly deferred these
-- 10 tables because they do not carry tenant_id directly — tenancy is
-- inherited via a parent FK (Institution / Program / School). At the time
-- the reasoning was "the parent-table RLS on Institution and Program
-- already prevents cross-tenant access via the Prisma query paths (every
-- nested-relation read traverses the tenant-scoped parent)".
--
-- The QA audit (docs/SPVT-QA-AUDIT.md §Security §2 CRITICAL) flagged that
-- as a single-code-path guarantee: a future maintainer's direct
--   req.db.campus.findMany({ where: { name: 'X' } })
-- (or a raw SQL join, or a raw $queryRaw shortcut) would silently return
-- rows for every tenant because Postgres itself is not enforcing tenancy
-- on these tables. Defense-in-depth is exactly the property RLS is meant
-- to provide, and skipping it here made the whole isolation posture only
-- as strong as the weakest future caller.
--
-- Fix: subquery policies that assert the parent's tenant matches
-- `app_current_tenant()`. The cost is real (an EXISTS on every row read
-- from these tables) but a single-row PK/FK index lookup per row, which
-- is cheap under Postgres' query planner. Every hot join path already
-- goes through the parent's PK so no additional index is required — the
-- (institution_id) / (program_id) / (school_id) FK indexes created in
-- previous migrations already back the subquery.
--
-- FORCE ROW LEVEL SECURITY on all 10 so even the table owner can't bypass
-- (matches the pattern established in migration 20991231235959).
--
-- Grants: refresh SELECT/INSERT/UPDATE/DELETE for spv_app so the policy
-- applies cleanly regardless of when the role was created relative to
-- these tables.

-- ---------------------------------------------------------------------------
-- Institution children — tenant lives on institutions.tenant_id
-- ---------------------------------------------------------------------------

ALTER TABLE campuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE campuses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON campuses;
CREATE POLICY tenant_isolation ON campuses
  USING (
    EXISTS (
      SELECT 1 FROM institutions i
      WHERE i.id = campuses.institution_id
        AND i.tenant_id = app_current_tenant()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM institutions i
      WHERE i.id = campuses.institution_id
        AND i.tenant_id = app_current_tenant()
    )
  );

ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON schools;
CREATE POLICY tenant_isolation ON schools
  USING (
    EXISTS (
      SELECT 1 FROM institutions i
      WHERE i.id = schools.institution_id
        AND i.tenant_id = app_current_tenant()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM institutions i
      WHERE i.id = schools.institution_id
        AND i.tenant_id = app_current_tenant()
    )
  );

ALTER TABLE institution_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution_identifiers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON institution_identifiers;
CREATE POLICY tenant_isolation ON institution_identifiers
  USING (
    EXISTS (
      SELECT 1 FROM institutions i
      WHERE i.id = institution_identifiers.institution_id
        AND i.tenant_id = app_current_tenant()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM institutions i
      WHERE i.id = institution_identifiers.institution_id
        AND i.tenant_id = app_current_tenant()
    )
  );

ALTER TABLE institution_accreditations ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution_accreditations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON institution_accreditations;
CREATE POLICY tenant_isolation ON institution_accreditations
  USING (
    EXISTS (
      SELECT 1 FROM institutions i
      WHERE i.id = institution_accreditations.institution_id
        AND i.tenant_id = app_current_tenant()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM institutions i
      WHERE i.id = institution_accreditations.institution_id
        AND i.tenant_id = app_current_tenant()
    )
  );

ALTER TABLE institution_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE institution_contacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON institution_contacts;
CREATE POLICY tenant_isolation ON institution_contacts
  USING (
    EXISTS (
      SELECT 1 FROM institutions i
      WHERE i.id = institution_contacts.institution_id
        AND i.tenant_id = app_current_tenant()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM institutions i
      WHERE i.id = institution_contacts.institution_id
        AND i.tenant_id = app_current_tenant()
    )
  );

-- ---------------------------------------------------------------------------
-- School children — tenant lives on the school's parent institution
-- ---------------------------------------------------------------------------

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON departments;
CREATE POLICY tenant_isolation ON departments
  USING (
    EXISTS (
      SELECT 1
      FROM schools s
      JOIN institutions i ON i.id = s.institution_id
      WHERE s.id = departments.school_id
        AND i.tenant_id = app_current_tenant()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM schools s
      JOIN institutions i ON i.id = s.institution_id
      WHERE s.id = departments.school_id
        AND i.tenant_id = app_current_tenant()
    )
  );

-- ---------------------------------------------------------------------------
-- Program children — tenant lives on programs.tenant_id
-- ---------------------------------------------------------------------------

ALTER TABLE program_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE program_intakes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON program_intakes;
CREATE POLICY tenant_isolation ON program_intakes
  USING (
    EXISTS (
      SELECT 1 FROM programs p
      WHERE p.id = program_intakes.program_id
        AND p.tenant_id = app_current_tenant()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM programs p
      WHERE p.id = program_intakes.program_id
        AND p.tenant_id = app_current_tenant()
    )
  );

ALTER TABLE program_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE program_requirements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON program_requirements;
CREATE POLICY tenant_isolation ON program_requirements
  USING (
    EXISTS (
      SELECT 1 FROM programs p
      WHERE p.id = program_requirements.program_id
        AND p.tenant_id = app_current_tenant()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM programs p
      WHERE p.id = program_requirements.program_id
        AND p.tenant_id = app_current_tenant()
    )
  );

ALTER TABLE program_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE program_modules FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON program_modules;
CREATE POLICY tenant_isolation ON program_modules
  USING (
    EXISTS (
      SELECT 1 FROM programs p
      WHERE p.id = program_modules.program_id
        AND p.tenant_id = app_current_tenant()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM programs p
      WHERE p.id = program_modules.program_id
        AND p.tenant_id = app_current_tenant()
    )
  );

ALTER TABLE program_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE program_fees FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON program_fees;
-- SVT-SEC-2026-08 — join through program_intakes.
--
-- This policy referenced `program_fees.program_id`, a column that has never
-- existed in any migration: program_fees links to a program only indirectly,
-- via program_intake_id. Postgres therefore aborted the statement with 42703
-- every time, which had two consequences nobody saw because
-- `prisma migrate deploy` had never actually run in CI:
--
--   1. The whole migration chain became unreplayable from scratch — you could
--      not rebuild the database from its own migrations, which breaks disaster
--      recovery and any new environment.
--   2. program_fees ended up with NO tenant_isolation policy anywhere. Since
--      ProgramFee has no tenant_id column of its own, RLS was the only
--      isolation it could ever have had.
--
-- Safe to correct in place: a statement that always errors is never recorded
-- as applied, so no environment has a checksum for the broken version.
CREATE POLICY tenant_isolation ON program_fees
  USING (
    EXISTS (
      SELECT 1 FROM program_intakes pi
      JOIN programs p ON p.id = pi.program_id
      WHERE pi.id = program_fees.program_intake_id
        AND p.tenant_id = app_current_tenant()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM program_intakes pi
      JOIN programs p ON p.id = pi.program_id
      WHERE pi.id = program_fees.program_intake_id
        AND p.tenant_id = app_current_tenant()
    )
  );

-- ---------------------------------------------------------------------------
-- Refresh grants for spv_app so the policies apply cleanly in environments
-- that pre-existed the default-privileges grant.
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON campuses TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON schools TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON departments TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON institution_identifiers TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON institution_accreditations TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON institution_contacts TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON program_intakes TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON program_requirements TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON program_modules TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON program_fees TO spv_app;
