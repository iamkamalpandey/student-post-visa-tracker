// SVT-WAVE-BILLING-2026-05 — School/College-style billing finite-state machines.
//
// Three machines:
//   1. FeePlan  — DRAFT → ACTIVE → PAUSED → ACTIVE → COMPLETED | CANCELLED
//   2. FeeInstallment — SCHEDULED → INVOICED → DUE → OVERDUE → PARTIAL → PAID
//                       (plus WAIVED / SUSPENDED / CANCELLED / REFUNDED exits)
//   3. Payment  — RECEIVED → VOIDED | PARTIALLY_REFUNDED | REFUNDED
//
// Most installment transitions fire from the daily billing cron (system role)
// rather than a human action. We still enforce role gates so an admin-driven
// PATCH cannot skip steps (e.g. SCHEDULED → PAID without an allocation).
//
// Reuses the shared FSM framework in apps/backend/src/shared/fsm.ts.

import { defineMachine } from '../../shared/fsm.js';
import type {
  FeePlanStatus,
  FeeInstallmentStatus,
  PaymentStatus,
  RefundStatus,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// FeePlan FSM
// ---------------------------------------------------------------------------
//
// State diagram:
//   DRAFT ──(create)──▶ ACTIVE
//   ACTIVE ──(pause: enrollment ON_LEAVE)──▶ PAUSED
//   PAUSED ──(resume)──▶ ACTIVE
//   ACTIVE ──(all installments terminal)──▶ COMPLETED
//   ACTIVE/PAUSED ──(admin cancel)──▶ CANCELLED
//
// COMPLETED + CANCELLED are terminal — no ADMIN rollback (regenerate a new
// plan + supersede the old via FeePlan.superseded_by_id).
export const feePlanFsm = defineMachine<FeePlanStatus>({
  name: 'fee_plan',
  states: ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'],
  initial: 'DRAFT',
  terminal: ['COMPLETED', 'CANCELLED'],
  transitions: [
    // System: plan creation finalises the schedule.
    { from: 'DRAFT', to: 'ACTIVE' },
    // System: enrollment ON_LEAVE / RESUMED.
    { from: 'ACTIVE', to: 'PAUSED' },
    { from: 'PAUSED', to: 'ACTIVE' },
    // System: all installments PAID/WAIVED.
    { from: 'ACTIVE', to: 'COMPLETED' },
    // Admin: explicit cancellation (e.g. withdrawal).
    { from: 'ACTIVE', to: 'CANCELLED', requires_role: 'ADMIN', require_reason: true },
    { from: 'PAUSED', to: 'CANCELLED', requires_role: 'ADMIN', require_reason: true },
    // Admin: roll a DRAFT back to nothing? Cancel instead. (No DRAFT → CANCELLED;
    // service deletes the row instead because a never-activated plan has no
    // history to preserve.)
  ],
});

// ---------------------------------------------------------------------------
// FeeInstallment FSM
// ---------------------------------------------------------------------------
//
// Daily cron (billingDaily.ts) drives most transitions; payment + waiver
// flows account for the rest.
//
//   SCHEDULED ──(invoice generated)──▶ INVOICED
//   INVOICED ──(cron: due_on reached)──▶ DUE
//   DUE ──(cron: + grace_days)──▶ OVERDUE
//   INVOICED/DUE/OVERDUE ──(allocation < balance)──▶ PARTIAL
//   PARTIAL ──(allocation closes balance)──▶ PAID
//   *active* ──(admin waiver)──▶ WAIVED
//   SCHEDULED/INVOICED ──(plan paused)──▶ SUSPENDED
//   SUSPENDED ──(plan resumed)──▶ INVOICED  (cron then re-evaluates DUE)
//   *active* ──(plan cancelled)──▶ CANCELLED
//   PAID ──(refund clears allocation)──▶ REFUNDED
//
// Terminal: PAID, WAIVED, CANCELLED, REFUNDED.
export const feeInstallmentFsm = defineMachine<FeeInstallmentStatus>({
  name: 'fee_installment',
  states: [
    'SCHEDULED', 'INVOICED', 'DUE', 'OVERDUE',
    'PARTIAL', 'PAID',
    'WAIVED', 'SUSPENDED', 'CANCELLED', 'REFUNDED',
  ],
  initial: 'SCHEDULED',
  // CANCELLED + REFUNDED are terminal. PAID + WAIVED are terminal *unless*
  // a refund reverses them — modelled as explicit transitions below; the
  // framework's terminal short-circuit only fires when no rule is found.
  terminal: ['CANCELLED', 'REFUNDED'],
  transitions: [
    // Lifecycle forward (system-driven by cron / payment service).
    { from: 'SCHEDULED', to: 'INVOICED' },
    { from: 'INVOICED',  to: 'DUE' },
    { from: 'DUE',       to: 'OVERDUE' },

    // Partial-payment matrix.
    { from: 'INVOICED', to: 'PARTIAL' },
    { from: 'DUE',      to: 'PARTIAL' },
    { from: 'OVERDUE',  to: 'PARTIAL' },

    // Fully paid.
    { from: 'INVOICED', to: 'PAID' },
    { from: 'DUE',      to: 'PAID' },
    { from: 'OVERDUE',  to: 'PAID' },
    { from: 'PARTIAL',  to: 'PAID' },

    // Admin waiver (any non-terminal state, requires reason).
    { from: 'SCHEDULED', to: 'WAIVED', requires_role: 'ADMIN', require_reason: true },
    { from: 'INVOICED',  to: 'WAIVED', requires_role: 'ADMIN', require_reason: true },
    { from: 'DUE',       to: 'WAIVED', requires_role: 'ADMIN', require_reason: true },
    { from: 'OVERDUE',   to: 'WAIVED', requires_role: 'ADMIN', require_reason: true },
    { from: 'PARTIAL',   to: 'WAIVED', requires_role: 'ADMIN', require_reason: true },

    // Plan paused → SCHEDULED/INVOICED installments suspend.
    { from: 'SCHEDULED', to: 'SUSPENDED' },
    { from: 'INVOICED',  to: 'SUSPENDED' },
    // Plan resumed → SUSPENDED returns to INVOICED (cron re-evaluates DUE/OVERDUE).
    { from: 'SUSPENDED', to: 'INVOICED' },

    // Plan cancelled → terminal CANCELLED on any non-paid row.
    { from: 'SCHEDULED', to: 'CANCELLED', requires_role: 'ADMIN', require_reason: true },
    { from: 'INVOICED',  to: 'CANCELLED', requires_role: 'ADMIN', require_reason: true },
    { from: 'DUE',       to: 'CANCELLED', requires_role: 'ADMIN', require_reason: true },
    { from: 'OVERDUE',   to: 'CANCELLED', requires_role: 'ADMIN', require_reason: true },
    { from: 'PARTIAL',   to: 'CANCELLED', requires_role: 'ADMIN', require_reason: true },
    { from: 'SUSPENDED', to: 'CANCELLED', requires_role: 'ADMIN', require_reason: true },

    // Refund of a PAID installment (post-refund-completion).
    { from: 'PAID',    to: 'REFUNDED', requires_role: 'ADMIN', require_reason: true },
    { from: 'PARTIAL', to: 'REFUNDED', requires_role: 'ADMIN', require_reason: true },

    // Void / refund rollback edges (ADMIN only; reason required).
    // Triggered by voidPayment + completeRefund when a payment reversal
    // pushes paid_minor back below net_minor without fully clearing it.
    { from: 'PAID',    to: 'PARTIAL',  requires_role: 'ADMIN', require_reason: true },
    { from: 'PAID',    to: 'INVOICED', requires_role: 'ADMIN', require_reason: true },
    { from: 'PARTIAL', to: 'INVOICED', requires_role: 'ADMIN', require_reason: true },
  ],
});

// ---------------------------------------------------------------------------
// Payment FSM
// ---------------------------------------------------------------------------
//
//   RECEIVED ──(admin void)──▶ VOIDED
//   RECEIVED ──(refund < gross)──▶ PARTIALLY_REFUNDED
//   RECEIVED/PARTIALLY_REFUNDED ──(refund balance)──▶ REFUNDED
//
// VOIDED, REFUNDED are terminal.
export const paymentFsm = defineMachine<PaymentStatus>({
  name: 'payment',
  states: ['RECEIVED', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
  initial: 'RECEIVED',
  terminal: ['VOIDED', 'REFUNDED'],
  transitions: [
    { from: 'RECEIVED', to: 'VOIDED',             requires_role: 'ADMIN', require_reason: true },
    { from: 'RECEIVED', to: 'PARTIALLY_REFUNDED', requires_role: 'ADMIN', require_reason: true },
    { from: 'RECEIVED', to: 'REFUNDED',           requires_role: 'ADMIN', require_reason: true },
    { from: 'PARTIALLY_REFUNDED', to: 'REFUNDED', requires_role: 'ADMIN', require_reason: true },
  ],
});

// ---------------------------------------------------------------------------
// Refund FSM
// ---------------------------------------------------------------------------
// SVT-SEC-2026-05 — close the FAILED enum-drift gap: Prisma + Zod declare
// 'FAILED' as a status but the service had no transition modelled. Operators
// could not record a payment-gateway failure cleanly. PENDING is the entry
// state; admin completion routes flip to COMPLETED. Gateway / bank-rail
// failures move PENDING → FAILED so the row stays auditable.
export const refundFsm = defineMachine<RefundStatus>({
  name: 'refund',
  states: ['PENDING', 'COMPLETED', 'FAILED'],
  initial: 'PENDING',
  terminal: ['COMPLETED', 'FAILED'],
  transitions: [
    { from: 'PENDING', to: 'COMPLETED', requires_role: 'ADMIN' },
    { from: 'PENDING', to: 'FAILED',    requires_role: 'ADMIN', require_reason: true },
  ],
});
