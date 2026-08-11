-- ============================================================================
-- SVT-SEC-2026-08 — tenant isolation for the interview estate.
--
-- WHAT WAS WRONG
-- --------------
-- `interview_questions` and `interview_attempts` both carry a `tenant_id`
-- column and had NO row-level security at all — not a weak policy, none.
-- `interview_answers` inherits tenancy through its parent attempt and was
-- likewise unprotected.
--
-- Found by auditing the live schema rather than the migration files:
--
--   SELECT c.relname FROM pg_class c
--     JOIN information_schema.columns col
--       ON col.table_name = c.relname AND col.column_name = 'tenant_id'
--    WHERE c.relkind = 'r' AND NOT c.relrowsecurity;
--
-- WHY IT MATTERS
-- --------------
-- `interview_attempts` stores `candidate_name` and `candidate_email` — direct
-- personal data, and it is indexed on (tenant_id, candidate_email), so it is
-- explicitly a per-tenant record. Every other tenant-owned table in this
-- database enforces isolation in Postgres itself precisely so that a missing
-- `req.db`, a raw `$queryRaw` shortcut, or a background job that forgets to
-- scope cannot read across tenants. These three tables were the exception, and
-- the exception is where a breach comes from.
--
-- The policies use the TIGHTENED shape established by
-- 20991231236005_rls_reclose_escape_hatch — no `OR app_current_tenant() IS NULL`
-- clause. With the escape hatch, a connection that never set the GUC sees
-- everything; without it, such a connection sees nothing, which is the correct
-- failure direction.
--
-- FORCE ROW LEVEL SECURITY so the table owner is bound by the policy too,
-- matching every other tenant table (100 of them at the time of writing).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- interview_questions — tenant_id is on the row
-- ---------------------------------------------------------------------------
ALTER TABLE interview_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_questions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON interview_questions;
CREATE POLICY tenant_isolation ON interview_questions
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ---------------------------------------------------------------------------
-- interview_attempts — tenant_id is on the row; holds candidate PII
-- ---------------------------------------------------------------------------
ALTER TABLE interview_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON interview_attempts;
CREATE POLICY tenant_isolation ON interview_attempts
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ---------------------------------------------------------------------------
-- interview_answers — no tenant_id of its own; tenancy comes from the attempt.
-- Same subquery shape as the institution/program children in …235995. The
-- (attempt_id) FK index already backs this lookup, so no new index is needed.
-- ---------------------------------------------------------------------------
ALTER TABLE interview_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_answers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON interview_answers;
CREATE POLICY tenant_isolation ON interview_answers
  USING (
    EXISTS (
      SELECT 1 FROM interview_attempts a
      WHERE a.id = interview_answers.attempt_id
        AND a.tenant_id = app_current_tenant()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM interview_attempts a
      WHERE a.id = interview_answers.attempt_id
        AND a.tenant_id = app_current_tenant()
    )
  );

-- ---------------------------------------------------------------------------
-- password_reset_tokens — RLS was enabled but never FORCEd, so the table owner
-- was exempt from its own tenant_isolation policy. Every write to this table
-- goes through `adminDb` (a BYPASSRLS role, see auth/password-reset.service.ts),
-- and BYPASSRLS is unaffected by FORCE, so this tightens the owner path without
-- touching the working code path.
--
-- Deliberately NOT doing the same to `audit_anchors`: jobs/hashAnchor.ts writes
-- anchors for EVERY tenant from one unscoped connection with no GUC set, which
-- is correct for a system-wide integrity job. FORCEing it would make that
-- insert fail its own WITH CHECK and silently kill nightly tamper-evidence.
-- The residual exposure is limited to the owner role, which already holds DDL.
-- ---------------------------------------------------------------------------
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Grants — spv_app is the runtime DML role. Guarded, because the role is
-- provisioned out of band and may not exist in every environment.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spv_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON interview_questions TO spv_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON interview_attempts TO spv_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON interview_answers TO spv_app';
  END IF;
END $$;
