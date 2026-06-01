-- SVT-SEC-MFA-ADMIN-POLICY-2026-05 (P1-A6) — per-tenant opt-in policy that
-- forces every ADMIN role user to have MFA enrolled before they can hit
-- requireMfa-gated routes. Default false preserves existing behaviour; the
-- toggle is surfaced under /settings → Security → "Require MFA for admins".
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS require_mfa_for_admins BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tenants.require_mfa_for_admins IS
  'SVT-SEC-MFA-ADMIN-POLICY-2026-05 — when TRUE, requireMfa middleware blocks ADMIN role requests with 403 mfa_required_for_admin until the user has enrolled MFA.';
