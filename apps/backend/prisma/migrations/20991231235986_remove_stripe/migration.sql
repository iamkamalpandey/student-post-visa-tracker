-- SVT-RIP-STRIPE-2026-05-19 — drop all Stripe integration columns.
--
-- Product is positioned as information-management / CRM. Payments are a
-- manual ledger only (CASH / BANK_TRANSFER / CARD / CHEQUE / OTHER as
-- recording methods, not real payment processing). The Stripe Checkout
-- and webhook surface is being removed entirely; these columns are no
-- longer read or written by any code path.
--
-- See infra/docs/decisions/2026-05-19-rip-stripe.md for context.

-- Payment correlation columns added by 20991231235980b_stripe_payment_columns.
DROP INDEX IF EXISTS payments_stripe_session_id_key;
ALTER TABLE payments DROP COLUMN IF EXISTS stripe_session_id;
ALTER TABLE payments DROP COLUMN IF EXISTS stripe_payment_intent_id;
ALTER TABLE payments DROP COLUMN IF EXISTS stripe_confirmed_at;
ALTER TABLE payments DROP COLUMN IF EXISTS stripe_event_id;

-- Per-tenant Stripe gate added by 20991231235981_tenant_stripe_flag.
ALTER TABLE tenants DROP COLUMN IF EXISTS stripe_enabled;
