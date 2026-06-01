-- SVT-SEC-2026-05 — Self-service password reset tokens.
--
-- Per NIST 800-63B + OWASP ASVS L2:
--   - Token is a random 32-byte value, sha256-hashed at rest (we never
--     persist the raw token; lookup is by hash).
--   - 30-minute TTL.
--   - Single-use: consumed_at column flipped on first successful redeem.
--   - Per-user rate limit: max 3 outstanding tokens per user; older are
--     auto-invalidated on a new request to defeat reset-link enumeration.
--
-- The /auth/password/reset-request endpoint always responds 200 to defeat
-- account enumeration; whether the email actually fires is logged but not
-- surfaced.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  user_id         uuid NOT NULL,
  token_hash      char(64) NOT NULL,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  invalidated_at  timestamptz,
  ip_hash         text,
  ua_hash         text,
  CONSTRAINT password_reset_tokens_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT password_reset_tokens_user_fk   FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE,
  CONSTRAINT password_reset_tokens_hash_uq   UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_active_idx
  ON password_reset_tokens (user_id, expires_at)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS password_reset_tokens_tenant_idx
  ON password_reset_tokens (tenant_id);

-- RLS: tenant-scoped reads (auth.service uses superuser so RLS is bypassed
-- via spv role; the policy still applies as defence-in-depth for any future
-- caller running as spv_app).
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'password_reset_tokens'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON password_reset_tokens
      USING (tenant_id::text = current_setting('app.tenant_id', true))
      WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spv_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO spv_app';
  END IF;
END $$;
