-- ============================================================================
-- Missing FK + chain-tail indexes (DB audit P1 finding).
--
-- Postgres doesn't auto-create indexes for foreign-key columns. Without them:
--  * cascade deletes seq-scan the child table to find rows to fix up
--  * parent-side joins (e.g. "list students assigned to user X") seq-scan
--  * RLS subquery policies (if/when we add them) re-scan per row
--
-- This migration also adds the chain-tail index audit_logs needs: the trigger
-- that fills prev_hash / entry_hash does an `ORDER BY created_at DESC LIMIT 1`
-- on every INSERT. With ~10k rows per tenant that becomes a sort node on every
-- audit write — a hot path. Composite (tenant_id, created_at DESC, id DESC)
-- lets the planner use a backwards index scan, O(log n) instead of O(n log n).
--
-- And soft-delete partial indexes for the tables that still rely on residual
-- filtering: every `WHERE tenant_id = X AND deleted_at IS NULL` scan touches
-- the soft-deleted rows otherwise.
--
-- Prod note: this migration uses plain `CREATE INDEX IF NOT EXISTS` so it
-- runs inside the migration tx. On dev volumes (< 10k rows / table) every
-- statement is sub-second. When applying to prod with millions of rows,
-- convert each statement to `CREATE INDEX CONCURRENTLY` and apply outside the
-- migration runner (psql), then baseline via `prisma migrate resolve --applied`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Token-table sweeper hot paths.
--    Both the refresh-token expiry sweeper and the access-token denylist
--    cleanup do `WHERE expires_at < now()` on every cron tick. No index =
--    full table scan. RefreshToken also reads by user_id for revocation
--    chains, but that already has an index.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx
  ON refresh_tokens (expires_at);

CREATE INDEX IF NOT EXISTS refresh_tokens_replaced_by_id_idx
  ON refresh_tokens (replaced_by_id)
  WHERE replaced_by_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS access_token_denylist_expires_at_idx
  ON access_token_denylist (expires_at);

CREATE INDEX IF NOT EXISTS access_token_denylist_user_id_idx
  ON access_token_denylist (user_id);

CREATE INDEX IF NOT EXISTS access_token_denylist_tenant_id_idx
  ON access_token_denylist (tenant_id);

-- ---------------------------------------------------------------------------
-- 2. Foreign-key columns missing standalone indexes.
--    Reverse joins (parent.children navigations in Prisma) seq-scan otherwise.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS student_visas_visa_category_id_idx
  ON student_visas (visa_category_id);

CREATE INDEX IF NOT EXISTS student_dependents_relationship_id_idx
  ON student_dependents (relationship_id);

CREATE INDEX IF NOT EXISTS student_contacts_relationship_id_idx
  ON student_contacts (relationship_id);

CREATE INDEX IF NOT EXISTS student_contacts_address_id_idx
  ON student_contacts (address_id)
  WHERE address_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS student_employment_employer_address_id_idx
  ON student_employment (employer_address_id)
  WHERE employer_address_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS programs_school_id_idx
  ON programs (school_id)
  WHERE school_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS programs_department_id_idx
  ON programs (department_id)
  WHERE department_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS accommodations_address_id_idx
  ON accommodations (address_id)
  WHERE address_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sponsors_address_id_idx
  ON sponsors (address_id)
  WHERE address_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS campuses_address_id_idx
  ON campuses (address_id)
  WHERE address_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS institutions_primary_address_id_idx
  ON institutions (primary_address_id)
  WHERE primary_address_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS enrollments_campus_id_idx
  ON enrollments (campus_id)
  WHERE campus_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS message_templates_stage_id_idx
  ON message_templates (stage_id)
  WHERE stage_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS comms_messages_template_id_idx
  ON comms_messages (template_id)
  WHERE template_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Audit chain tail index.
--    The hash-chain trigger reads the most recent row per tenant on every
--    INSERT to compute prev_hash. Composite supports backwards index scan.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS audit_logs_tenant_created_desc_idx
  ON audit_logs (tenant_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- 4. Soft-delete partial indexes for list-query hot paths.
--    Models with deleted_at that don't yet have a partial covering it pay
--    residual-filter cost on every list query.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS programs_tenant_active_idx
  ON programs (institution_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS super_agents_tenant_active_idx
  ON super_agents (tenant_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS reminders_tenant_active_idx
  ON reminders (tenant_id, status, scheduled_for)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS commission_claims_tenant_active_idx
  ON commission_claims (tenant_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS notes_tenant_active_idx
  ON notes (tenant_id, entity_type, entity_id, created_at DESC)
  WHERE deleted_at IS NULL;
