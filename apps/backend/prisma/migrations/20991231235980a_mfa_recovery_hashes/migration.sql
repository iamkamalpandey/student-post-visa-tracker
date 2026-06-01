-- RENAMED 2026-05-19: directory was `20991231235980_mfa_recovery_hashes`
--   (prefix collided with stripe_payment_columns — filesystem-sort
--   dependent apply order). Operators with an existing dev DB MUST run:
--     UPDATE _prisma_migrations
--        SET migration_name = '20991231235980a_mfa_recovery_hashes'
--      WHERE migration_name = '20991231235980_mfa_recovery_hashes';
--   See infra/docs/runbooks/migration-rename-2026-05-19.md.
--
-- SVT-SEC-MFA-RECOVERY-2026-05 — recovery code persistence.
--
-- Adds users.mfa_recovery_hashes: a comma-joined string of sha256 hex hashes
-- (64 chars each) for the 10 single-use recovery codes minted at MFA enrol.
-- 10 hashes × 64 chars + 9 commas = 649 chars — well within an unsized text
-- column. We store hashes only; raw codes are shown to the user exactly once
-- at enrolment.
--
-- Why a single text column rather than a side table:
--   - The hash list is owned 1:1 by the user; no FKs reference it.
--   - Consume = "find a matching hash, drop it, write back" — a single
--     UPDATE with the new joined string is simpler than per-row UPDATE+WHERE.
--   - No need for tenant_id RLS on a child table.
--   - v2 may split into mfa_recovery_codes(id, user_id, hash, consumed_at)
--     if we want audit forensics on individual code lifecycle. Migration is
--     trivial: split-on-comma into rows.
--
-- Nullable: NULL = user never enrolled MFA or has disabled it. Empty string
-- and "all 10 consumed" are distinct states (the latter still has commas).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_recovery_hashes text;
