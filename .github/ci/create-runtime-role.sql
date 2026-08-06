-- SVT-CI-2026-08 — create the runtime role that the migration chain GRANTs to.
--
-- 20991231235959_init_rls_and_triggers issues its GRANTs to `spv_app` without
-- an IF EXISTS guard (later migrations wrap theirs). The backend-ci postgres
-- service only creates `spv`, so `prisma migrate deploy` aborted on migration
-- #2 with 42704 "role spv_app does not exist".
--
-- This is CI scaffolding only. It is deliberately NOT a migration: production
-- provisions spv_app out of band with a real password and narrower grants, and
-- a migration that CREATE ROLEs would fight that.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spv_app') THEN
    CREATE ROLE spv_app LOGIN PASSWORD 'spv_app_ci_password';
  END IF;
END $$;
