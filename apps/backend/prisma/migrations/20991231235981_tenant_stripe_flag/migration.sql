-- SVT-STRIPE-TOGGLE-2026-05 — per-tenant Stripe integration gate.
--
-- Independent from `billing_enabled`: a tenant can run the billing module
-- on cash + bank transfer only (the beta-school case) without exposing the
-- "Pay online (Stripe)" button or the /billing/payments/:id/checkout route.
--
-- Default `false` keeps every existing tenant off Stripe until an admin
-- explicitly opts in from /settings. The toggle is additive — Stripe still
-- requires `billing_enabled = true` AND `stripe_enabled = true` to surface.

ALTER TABLE tenants
  ADD COLUMN stripe_enabled BOOLEAN NOT NULL DEFAULT false;
