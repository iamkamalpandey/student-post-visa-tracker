-- ============================================================================
-- Wave 15 — per-tenant FROM address for outbound EMAIL.
--
-- Defaults to NULL; commsDispatcher falls back to env.EMAIL_FROM when null.
-- Must be a Resend-verified sender domain — operators set this at tenant
-- onboarding. No DB-side validation (would need MX lookup at write time);
-- the service layer validates email shape via zod.
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS email_from text;
