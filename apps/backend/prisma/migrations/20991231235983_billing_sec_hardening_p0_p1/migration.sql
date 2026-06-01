-- SVT-WAVE-BILLING-SEC-2026-05 — security hardening (P0 + P1 audit findings).
--
-- This migration is ADDITIVE (no destructive drops on existing data):
--   1. Adds idempotency_records.user_id (NULLABLE — legacy rows pre-date
--      per-user scoping and get NULL, which the application maps to the
--      "no-user / webhook / cron" bucket).
--   2. Replaces the (tenant_id, scope, key) UNIQUE with a functional
--      (tenant_id, COALESCE(user_id, sentinel), scope, key) UNIQUE so the
--      database refuses cross-user collisions while still treating
--      user_id=NULL as a single deterministic bucket (Postgres treats real
--      NULLs as distinct in regular UNIQUE indexes — that would silently
--      let two webhook calls with the same key both succeed).
--
-- Findings addressed:
--   P1-F5 — idempotency key not scoped by user (cross-user replay).
--
-- Rollback notes:
--   The new UNIQUE is functionally equivalent to the old one for any caller
--   that previously omitted user_id (the COALESCE collapses NULLs to a
--   single sentinel). Dropping the new index + restoring the old @@unique
--   restores legacy behaviour without data loss.

-- 1. Add the new column. NULLABLE so the migration is non-blocking on a
--    populated table; the application defaults user_id to NULL for callers
--    that don't supply one (webhooks, cron, internal services).
ALTER TABLE "idempotency_records"
  ADD COLUMN IF NOT EXISTS "user_id" UUID;

-- 2. Drop the legacy (tenant_id, scope, key) UNIQUE. We pin the exact
--    Prisma-generated name; if a manual rebuild renamed it, the IF EXISTS
--    keeps this idempotent.
DROP INDEX IF EXISTS "idempotency_records_tenant_id_scope_key_key";

-- 3. Recreate as a functional UNIQUE that treats NULL user_id as a single
--    deterministic bucket. The sentinel UUID is all-zeros — reserved per
--    RFC 4122 §4.1.7 (Nil UUID) and not generatable by any UUID v4/v7 routine.
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_records_tenant_user_scope_key_key"
  ON "idempotency_records" (
    "tenant_id",
    COALESCE("user_id", '00000000-0000-0000-0000-000000000000'::uuid),
    "scope",
    "key"
  );
