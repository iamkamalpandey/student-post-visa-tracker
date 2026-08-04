-- SVT-QA-2026-08 — session-wide access-token revoke.
--
-- The AccessTokenDenylist table (per-JTI) only covers explicit /auth/logout.
-- Password change, self-disable MFA, admin reset, admin force-disable MFA,
-- and admin revoke-all-sessions all revoke the refresh token family but
-- LEAVE live 15-minute-TTL access tokens valid. That's a SOC2 control gap.
--
-- Fix: add User.sessions_valid_from. Every session-revoking flow stamps it.
-- authenticate middleware rejects a token when its iat is older than the
-- user's sessions_valid_from — a session-wide invalidation that costs one
-- cheap indexed lookup per authenticated request (in-process cached for 30s).
--
-- Additive migration. Existing rows get NULL which the middleware treats as
-- "no revocation on record" (accept). New writes set to now().

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sessions_valid_from TIMESTAMPTZ;
