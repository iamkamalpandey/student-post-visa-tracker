-- ============================================================================
-- Super-Agents PHASE 2: type lookup, contacts, commission rules, status enum,
-- soft-delete on link table, sub-processor link, commission_claims FK.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DO
-- guards. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. SuperAgentStatus enum + super_agents.status column.
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SuperAgentStatus') THEN
    CREATE TYPE "SuperAgentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'TERMINATED');
  END IF;
END $$;

ALTER TABLE super_agents
  ADD COLUMN IF NOT EXISTS status "SuperAgentStatus" NOT NULL DEFAULT 'ACTIVE';

-- Backfill: any super_agents.is_active=false → PAUSED. Keeps backwards compat
-- because we keep the is_active column (FE migration is incremental).
UPDATE super_agents SET status = 'PAUSED' WHERE is_active = false AND status = 'ACTIVE';

-- Sub-processor link (optional; nullable).
ALTER TABLE super_agents
  ADD COLUMN IF NOT EXISTS sub_processor_id uuid REFERENCES sub_processors(id) ON DELETE SET NULL;

-- Type FK (added BEFORE the table exists is fine because nullable).
ALTER TABLE super_agents
  ADD COLUMN IF NOT EXISTS type_id uuid;

-- Legal_name + logo_url + payment_terms_days + default_currency
ALTER TABLE super_agents ADD COLUMN IF NOT EXISTS legal_name text;
ALTER TABLE super_agents ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE super_agents ADD COLUMN IF NOT EXISTS payment_terms_days integer;
ALTER TABLE super_agents ADD COLUMN IF NOT EXISTS default_currency char(3);

CREATE INDEX IF NOT EXISTS super_agents_tenant_id_status_idx ON super_agents(tenant_id, status);
CREATE INDEX IF NOT EXISTS super_agents_tenant_id_type_id_idx ON super_agents(tenant_id, type_id);

-- ----------------------------------------------------------------------------
-- 2. super_agent_types — admin-configurable category lookup.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS super_agent_types (
  id          uuid                     NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   uuid                     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         text                     NOT NULL,
  label       text                     NOT NULL,
  description text,
  is_active   boolean                  NOT NULL DEFAULT true,
  created_at  timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS super_agent_types_tenant_key_uq ON super_agent_types(tenant_id, key);

-- Add the type_id FK to super_agents now that the parent table exists.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'super_agents_type_id_fkey'
  ) THEN
    ALTER TABLE super_agents
      ADD CONSTRAINT super_agents_type_id_fkey
      FOREIGN KEY (type_id) REFERENCES super_agent_types(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3. super_agent_contacts.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS super_agent_contacts (
  id             uuid                     NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      uuid                     NOT NULL,
  super_agent_id uuid                     NOT NULL REFERENCES super_agents(id) ON DELETE CASCADE,
  name           text                     NOT NULL,
  role           text,
  email          text,
  phone_e164     text,
  is_primary     boolean                  NOT NULL DEFAULT false,
  notes          text,
  created_at     timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at     timestamp with time zone
);

CREATE INDEX IF NOT EXISTS super_agent_contacts_super_agent_idx ON super_agent_contacts(super_agent_id);

-- ----------------------------------------------------------------------------
-- 4. super_agent_commission_rules.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS super_agent_commission_rules (
  id             uuid                     NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      uuid                     NOT NULL,
  super_agent_id uuid                     NOT NULL REFERENCES super_agents(id) ON DELETE CASCADE,
  institution_id uuid                              REFERENCES institutions(id) ON DELETE SET NULL,
  program_level  text,
  commission_pct numeric(5,2)             NOT NULL,
  currency       char(3)                  NOT NULL,
  effective_from date                     NOT NULL,
  effective_to   date,
  notes          text,
  created_at     timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_id  uuid
);

CREATE INDEX IF NOT EXISTS sacr_tenant_sa_eff_idx
  ON super_agent_commission_rules(tenant_id, super_agent_id, effective_from);
CREATE INDEX IF NOT EXISTS sacr_tenant_inst_eff_idx
  ON super_agent_commission_rules(tenant_id, institution_id, effective_from);

-- ----------------------------------------------------------------------------
-- 5. institution_super_agents: add deleted_at for soft-delete (matches new schema).
-- ----------------------------------------------------------------------------
ALTER TABLE institution_super_agents
  ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone;

-- ----------------------------------------------------------------------------
-- 6. commission_claims: add super_agent_id (nullable, SetNull).
-- ----------------------------------------------------------------------------
ALTER TABLE commission_claims
  ADD COLUMN IF NOT EXISTS super_agent_id uuid REFERENCES super_agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS commission_claims_super_agent_idx ON commission_claims(super_agent_id);

-- ----------------------------------------------------------------------------
-- 7. RLS on the 3 new tables — mirror existing pattern.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'super_agent_types',
    'super_agent_contacts',
    'super_agent_commission_rules'
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

GRANT SELECT, INSERT, UPDATE, DELETE ON super_agent_types TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON super_agent_contacts TO spv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON super_agent_commission_rules TO spv_app;
