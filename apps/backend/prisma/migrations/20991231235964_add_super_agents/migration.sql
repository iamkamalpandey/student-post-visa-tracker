-- ============================================================================
-- Super-Agents (aggregator/intermediary platforms): tables + RLS + FK on
-- enrollments.super_agent_id.
--
-- A super-agent is an aggregator the consultancy uses to access institutions
-- (Adventus, Edvoy, IDP, Apply Board, BUSY). One institution can be reachable
-- through multiple super-agents (m:n via institution_super_agents). Per
-- enrollment we capture WHICH super-agent — if any — was used (commission
-- attribution).
--
-- Also adds tenant_isolation RLS on both new tables — mirrors
-- 20991231235961_add_checklist_rls.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / ADD
-- COLUMN IF NOT EXISTS / DROP POLICY IF EXISTS … CREATE POLICY. Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS super_agents (
  id                     uuid                        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id              uuid                        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                   text                        NOT NULL,
  short_name             text,
  country_code           char(2),
  website                text,
  contact_email          text,
  contact_phone_e164     text,
  default_commission_pct numeric(5,2),
  is_active              boolean                     NOT NULL DEFAULT true,
  notes                  text,
  version                integer                     NOT NULL DEFAULT 1,
  created_at             timestamp with time zone    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_id          uuid,
  updated_at             timestamp with time zone    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by_id          uuid,
  deleted_at             timestamp with time zone
);

-- Unique within a tenant (case-sensitive by name; UI normalises trim).
CREATE UNIQUE INDEX IF NOT EXISTS super_agents_tenant_id_name_key ON super_agents(tenant_id, name);
CREATE INDEX IF NOT EXISTS super_agents_tenant_id_is_active_idx ON super_agents(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS institution_super_agents (
  id              uuid                        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       uuid                        NOT NULL,
  institution_id  uuid                        NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  super_agent_id  uuid                        NOT NULL REFERENCES super_agents(id) ON DELETE CASCADE,
  commission_pct  numeric(5,2),
  is_preferred    boolean                     NOT NULL DEFAULT false,
  notes           text,
  created_at      timestamp with time zone    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_id   uuid
);

CREATE UNIQUE INDEX IF NOT EXISTS institution_super_agents_inst_sa_key
  ON institution_super_agents(institution_id, super_agent_id);
CREATE INDEX IF NOT EXISTS institution_super_agents_tenant_inst_idx
  ON institution_super_agents(tenant_id, institution_id);
CREATE INDEX IF NOT EXISTS institution_super_agents_super_agent_idx
  ON institution_super_agents(super_agent_id);

-- Enrollment: nullable FK; SetNull if the super-agent gets deleted so
-- historical enrollments don't break.
ALTER TABLE enrollments
  ADD COLUMN IF NOT EXISTS super_agent_id uuid REFERENCES super_agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS enrollments_super_agent_id_idx ON enrollments(super_agent_id);

-- ----------------------------------------------------------------------------
-- RLS — mirror existing pattern (see 20991231235961_add_checklist_rls).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'super_agents',
    'institution_super_agents'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
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

-- spv_app inherits DML grants from default-privileges set in the init migration,
-- but a fresh re-grant is cheap insurance for envs that pre-existed the default.
GRANT SELECT, INSERT, UPDATE, DELETE ON super_agents TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON institution_super_agents TO spv_app;
