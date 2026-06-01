-- Postgres extensions required by the schema (RLS policies, UUID generation, encryption helpers).
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Application roles. Migrations run as the owner; the runtime app uses spv_app which respects RLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spv_app') THEN
    CREATE ROLE spv_app LOGIN PASSWORD 'spv_app_dev_password';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spv_admin') THEN
    CREATE ROLE spv_admin LOGIN PASSWORD 'spv_admin_dev_password' BYPASSRLS;
  END IF;
END $$;

GRANT CONNECT ON DATABASE spv_dev TO spv_app, spv_admin;
GRANT USAGE ON SCHEMA public TO spv_app, spv_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO spv_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO spv_app;
