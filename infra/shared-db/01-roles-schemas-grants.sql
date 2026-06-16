-- =============================================================================
-- SHARED-DB (single instance) — roles, schemas, grants, blast-radius limits.
-- SVT-SHARED-DB-2026-06.
--
-- Model: ONE Postgres instance hosts BOTH apps.
--   * schema `core`      — owned by V2 (the CRM). SPVT NEVER writes it.
--   * schema `core_pub`  — V2-owned VIEWS = the stable contract SPVT reads.
--   * schema `spv`       — owned by SPVT for its overlay (fees, status, links).
--
-- SPVT's role gets SELECT on core_pub ONLY (not raw `core` tables) + full on
-- `spv`. Read-only on V2 is DB-ENFORCED by privilege — stronger than the mirror's
-- app-level `BEGIN READ ONLY` + superuser creds.
--
-- PREREQUISITE: both apps must live on the SAME instance. You cannot cross-schema
-- join/FK across two servers — co-locate first (see README.md). Run as a superuser
-- / instance admin.
-- =============================================================================

-- ── Roles ────────────────────────────────────────────────────────────────────
-- V2's owning role (already exists as V2's app/owner — shown for completeness).
-- DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='core_owner')
--   THEN CREATE ROLE core_owner WITH LOGIN PASSWORD '<set-in-secrets>'; END IF; END $$;

-- SPVT application role: reads the V2 contract, owns the overlay. NOT a superuser.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='spv_app') THEN
    CREATE ROLE spv_app WITH LOGIN PASSWORD '<set-in-secrets>';
  END IF;
END $$;

-- Blast-radius controls: a runaway SPVT query must not hog the shared instance.
ALTER ROLE spv_app SET statement_timeout = '15s';
ALTER ROLE spv_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE spv_app CONNECTION LIMIT 20;   -- SPVT's own pool cap; V2 keeps its own.

-- ── Schemas ──────────────────────────────────────────────────────────────────
-- core      : V2's schema (created/owned by V2's migrations — do NOT manage here).
-- core_pub  : the published contract (V2 owns the views; SPVT only reads them).
-- spv       : SPVT's overlay (SPVT owns + migrates this).
CREATE SCHEMA IF NOT EXISTS core_pub AUTHORIZATION core_owner;
CREATE SCHEMA IF NOT EXISTS spv      AUTHORIZATION spv_app;

-- ── Grants: SPVT reads the CONTRACT, never raw core tables ───────────────────
-- Deliberately NO `GRANT ... ON SCHEMA core` to spv_app — coupling to raw tables
-- is the trap. SPVT sees core only through core_pub views.
GRANT USAGE ON SCHEMA core_pub TO spv_app;
GRANT SELECT ON ALL TABLES IN SCHEMA core_pub TO spv_app;   -- views are "tables" here

-- Future views added to the contract by V2 are auto-granted. `FOR ROLE core_owner`
-- is REQUIRED — default privileges apply to objects created by THAT role, not
-- whoever runs this statement (the gotcha in the naive version).
ALTER DEFAULT PRIVILEGES FOR ROLE core_owner IN SCHEMA core_pub
  GRANT SELECT ON TABLES TO spv_app;

-- SPVT fully owns its overlay schema.
GRANT USAGE, CREATE ON SCHEMA spv TO spv_app;
-- (spv_app is the schema owner via AUTHORIZATION above, so it has full DML/DDL on
--  objects it creates. No extra grant needed for its own tables.)

-- ── Hard guarantee: SPVT can NEVER write core ───────────────────────────────
-- Explicitly revoke any inherited write paths. SELECT-on-views is the only door.
REVOKE ALL ON SCHEMA core FROM spv_app;
-- (If spv_app somehow has table grants in core from a prior setup:)
-- REVOKE ALL ON ALL TABLES IN SCHEMA core FROM spv_app;
