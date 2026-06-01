-- SVT-SEC-2026-05 — RefreshToken.last_used_at for idle-session enforcement.
-- Backfill live tokens to NOW() so deploying this migration doesn't mass-
-- invalidate every active session.

ALTER TABLE "refresh_tokens"
  ADD COLUMN IF NOT EXISTS "last_used_at" TIMESTAMPTZ;

UPDATE "refresh_tokens"
  SET "last_used_at" = COALESCE("issued_at", NOW())
  WHERE "revoked_at" IS NULL AND "last_used_at" IS NULL;

CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_last_used_at_idx"
  ON "refresh_tokens" ("user_id", "last_used_at");
