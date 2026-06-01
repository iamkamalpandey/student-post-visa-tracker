# 2026-05-19 — Rip Stripe

## Decision

The Stripe Checkout integration, webhook handler, per-tenant `stripe_enabled`
toggle, and `payments.stripe_*` correlation columns are removed in full.

## Context

This product is positioned as **information-management / CRM** for student
post-visa tracking. The `Payment`, `PaymentAllocation`, `Refund`, `FeePlan`,
and `FeeInstallment` models are a **manual ledger** — operators record money
that has already moved through cash, bank transfer, card terminal, cheque, or
"other" out-of-band rails. The `PaymentMethod` enum values
(`CASH | BANK_TRANSFER | CARD | CHEQUE | OTHER`) are **recording categories**,
not gateway integrations.

Carrying the Stripe Checkout surface forward implied:

- A real payment-processing posture (PCI scope conversation with auditors,
  Stripe API key custody, webhook signature rotation, refund disbursement race
  surface) that we do not actually offer.
- Two `Tenant` and four `Payment` columns that no shipping feature reads.
- ~600 lines of route + service code + four spec files keeping a fake
  Checkout URL path alive.
- Confusing UX where "Pay online (Stripe)" appeared next to "Record payment"
  even though the manual ledger was the only intended workflow.

## What stays

- `Payment` + `PaymentAllocation` + `Refund` + `FeePlan` + `FeeInstallment`
  models and the manual `recordPayment` / `voidPayment` / `createRefund` /
  `completeRefund` / `applyAdjustment` flows.
- `Tenant.billing_enabled` gate (the whole billing module remains opt-in).
- Refund FSM and step-up MFA on void/refund/cancel — still real money
  movement at the bookkeeping layer.

## What goes

- `apps/backend/src/modules/billing/stripe.service.ts`
- `apps/backend/src/modules/billing/stripe.routes.ts`
- `apps/backend/tests/stripe-{routes,webhooks,webhook-sdk,tenant-gate}.spec.ts`
- `apps/frontend/app/(app)/settings/sections/StripeIntegrationSection.tsx`
- `useStripeCheckout` + `useStripeEnabled` hooks
- "Pay online (Stripe)" button in `RecordPaymentDialog`
- `confirmCheckout()` in `payment.service.ts`
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` env vars
- `stripe` npm dependency
- `Tenant.stripe_enabled` column (migration drops it)
- `Payment.stripe_session_id` / `_payment_intent_id` / `_confirmed_at` /
  `_event_id` columns (migration drops them)
- OpenAPI paths for `POST /billing/payments/{id}/checkout` and
  `POST /webhooks/stripe`

## Re-add criteria

Bring Stripe (or any real-money-movement gateway) back **only** when a
school/college tenant explicitly needs us to collect payments online on their
behalf. At that point the conversation is also about PCI scope, refund
liability, and dispute handling — not just a button.
