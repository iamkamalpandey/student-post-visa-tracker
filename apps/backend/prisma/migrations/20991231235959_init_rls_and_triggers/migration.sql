-- Post-Prisma migration: enable RLS, install audit-log triggers + hash chain.
-- Prisma generates the table DDL; this file is appended after `prisma migrate dev` records the
-- main migration. To apply manually: `psql -f migration.sql` against the dev DB after
-- `pnpm prisma:migrate`. CI runs both: prisma migrate deploy then this file via the migrate script.

-- ============================================================================
-- 1. Helper to read tenant id from session settings
-- ============================================================================
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

-- ============================================================================
-- 2. Enable RLS + tenant-isolation policy on every tenant-scoped table
-- ============================================================================
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
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
    'users', 'refresh_tokens'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
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

-- Tenants table itself: any authenticated session in that tenant can read its own row.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self_read ON tenants;
CREATE POLICY tenant_self_read ON tenants
  USING (id = app_current_tenant() OR app_current_tenant() IS NULL)
  WITH CHECK (id = app_current_tenant() OR app_current_tenant() IS NULL);

-- ============================================================================
-- 3. Audit-log: append-only enforcement + hash chain
-- ============================================================================

-- Block UPDATE/DELETE on audit_logs to make the chain meaningful.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END $$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- Compute prev_hash + entry_hash atomically on insert (defence in depth — the app also computes them).
-- Hash inputs are sorted-key canonical JSON; here we approximate with explicit field concatenation.
CREATE OR REPLACE FUNCTION audit_logs_hash_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev text;
  payload text;
BEGIN
  SELECT entry_hash INTO prev
    FROM audit_logs
    WHERE tenant_id IS NOT DISTINCT FROM NEW.tenant_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

  NEW.prev_hash := prev;

  payload := COALESCE(prev, '') || '|'
    || NEW.id::text || '|'
    || COALESCE(NEW.tenant_id::text, '') || '|'
    || COALESCE(NEW.actor_id::text, '') || '|'
    || COALESCE(NEW.action, '') || '|'
    || COALESCE(NEW.entity_type, '') || '|'
    || COALESCE(NEW.entity_id::text, '') || '|'
    || COALESCE(NEW.entity_version::text, '') || '|'
    || COALESCE(encode(NEW.before_enc, 'hex'), '') || '|'
    || COALESCE(encode(NEW.after_enc, 'hex'), '') || '|'
    || COALESCE(NEW.request_id, '') || '|'
    || NEW.created_at::text;

  NEW.entry_hash := encode(digest(payload, 'sha256'), 'hex');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audit_logs_chain ON audit_logs;
CREATE TRIGGER audit_logs_chain
  BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_hash_chain();

-- StudentLifecycleEvent is also append-only.
CREATE OR REPLACE FUNCTION lifecycle_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'student_lifecycle_events is append-only';
END $$;

DROP TRIGGER IF EXISTS lifecycle_no_update ON student_lifecycle_events;
CREATE TRIGGER lifecycle_no_update
  BEFORE UPDATE ON student_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION lifecycle_events_immutable();

DROP TRIGGER IF EXISTS lifecycle_no_delete ON student_lifecycle_events;
CREATE TRIGGER lifecycle_no_delete
  BEFORE DELETE ON student_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION lifecycle_events_immutable();

-- ============================================================================
-- 4. Verification helper — recompute the chain for a tenant; returns first break or NULL.
-- ============================================================================
CREATE OR REPLACE FUNCTION audit_logs_verify(p_tenant uuid) RETURNS TABLE (broken_id uuid)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  prev text := NULL;
  rec RECORD;
  recomputed text;
  payload text;
BEGIN
  FOR rec IN
    SELECT * FROM audit_logs
      WHERE tenant_id IS NOT DISTINCT FROM p_tenant
      ORDER BY created_at, id
  LOOP
    payload := COALESCE(prev, '') || '|'
      || rec.id::text || '|'
      || COALESCE(rec.tenant_id::text, '') || '|'
      || COALESCE(rec.actor_id::text, '') || '|'
      || COALESCE(rec.action, '') || '|'
      || COALESCE(rec.entity_type, '') || '|'
      || COALESCE(rec.entity_id::text, '') || '|'
      || COALESCE(rec.entity_version::text, '') || '|'
      || COALESCE(encode(rec.before_enc, 'hex'), '') || '|'
      || COALESCE(encode(rec.after_enc, 'hex'), '') || '|'
      || COALESCE(rec.request_id, '') || '|'
      || rec.created_at::text;
    recomputed := encode(digest(payload, 'sha256'), 'hex');
    IF recomputed <> rec.entry_hash OR COALESCE(rec.prev_hash, '') <> COALESCE(prev, '') THEN
      broken_id := rec.id;
      RETURN NEXT;
      RETURN;
    END IF;
    prev := rec.entry_hash;
  END LOOP;
  RETURN;
END $$;

-- ============================================================================
-- 5. Grant DML to spv_app on all current tables; future tables inherit via default privileges.
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO spv_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO spv_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO spv_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO spv_app;
