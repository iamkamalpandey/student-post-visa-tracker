-- RENAMED 2026-05-19: directory was `20991231235980_stripe_payment_columns`
--   (prefix collided with mfa_recovery_hashes — filesystem-sort dependent
--   apply order). Operators with an existing dev DB MUST run:
--     UPDATE _prisma_migrations
--        SET migration_name = '20991231235980b_stripe_payment_columns'
--      WHERE migration_name = '20991231235980_stripe_payment_columns';
--   See infra/docs/runbooks/migration-rename-2026-05-19.md.
--
-- Stripe correlation columns on payments.
--
-- Adds dedicated columns so the webhook handler stops polluting user-facing
-- `reference` / `notes` fields with stripe session/event ids (v1 hack).
--
-- Idempotency model used by payment.service.confirmCheckout:
--   1. Primary key: stripe_event_id   — exact-event replay protection.
--   2. Fallback key: stripe_session_id — guards against Stripe dashboard
--      re-send (same session, brand-new event.id).
--
-- The unique index on stripe_session_id is PARTIAL (WHERE NOT NULL) because
-- pre-existing rows are NULL and the @unique constraint on a nullable column
-- in Prisma would otherwise allow only one NULL on some PG configs and is
-- generally awkward; the partial form is explicit + safe.

ALTER TABLE payments
  ADD COLUMN stripe_session_id text,
  ADD COLUMN stripe_payment_intent_id text,
  ADD COLUMN stripe_confirmed_at timestamptz,
  ADD COLUMN stripe_event_id text;

CREATE UNIQUE INDEX payments_stripe_session_id_key
  ON payments (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
