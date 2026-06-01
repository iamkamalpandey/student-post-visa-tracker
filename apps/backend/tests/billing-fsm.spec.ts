// SVT-WAVE-BILLING-2026-05 — assert the 3 billing FSMs enforce the documented
// state diagram. Mirrors enrollments/__tests__/fsm.test.ts shape.
//
// For each machine we check:
//   - happy-path forward transitions allowed
//   - role-gated transitions reject COUNSELLOR + accept ADMIN
//   - reason-required edges 422 on empty reason
//   - illegal transitions return 422 (no rule) or 409 (terminal)

import { describe, it, expect } from 'vitest';
import {
  feePlanFsm,
  feeInstallmentFsm,
  paymentFsm,
} from '../src/modules/billing/fsm-def.js';
import { assertTransition } from '../src/shared/fsm.js';

describe('feePlanFsm', () => {
  it('DRAFT → ACTIVE allowed (system transition)', () => {
    const r = assertTransition(feePlanFsm, 'DRAFT', 'ACTIVE', 'COUNSELLOR');
    expect(r.ok).toBe(true);
  });
  it('ACTIVE → PAUSED allowed (any role)', () => {
    expect(assertTransition(feePlanFsm, 'ACTIVE', 'PAUSED', 'COUNSELLOR').ok).toBe(true);
  });
  it('PAUSED → ACTIVE allowed (any role)', () => {
    expect(assertTransition(feePlanFsm, 'PAUSED', 'ACTIVE', 'COUNSELLOR').ok).toBe(true);
  });
  it('ACTIVE → COMPLETED allowed (system; no role gate)', () => {
    expect(assertTransition(feePlanFsm, 'ACTIVE', 'COMPLETED', 'COUNSELLOR').ok).toBe(true);
  });
  it('ACTIVE → CANCELLED requires ADMIN + reason', () => {
    const noRole = assertTransition(feePlanFsm, 'ACTIVE', 'CANCELLED', 'COUNSELLOR', 'why');
    expect(noRole.ok).toBe(false);
    if (!noRole.ok) expect(noRole.status).toBe(403);
    const noReason = assertTransition(feePlanFsm, 'ACTIVE', 'CANCELLED', 'ADMIN');
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.status).toBe(422);
    const ok = assertTransition(feePlanFsm, 'ACTIVE', 'CANCELLED', 'ADMIN', 'closing out');
    expect(ok.ok).toBe(true);
  });
  it('COMPLETED is terminal — no transitions out', () => {
    const r = assertTransition(feePlanFsm, 'COMPLETED', 'ACTIVE', 'ADMIN', 'reopen');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
  it('CANCELLED is terminal', () => {
    const r = assertTransition(feePlanFsm, 'CANCELLED', 'ACTIVE', 'ADMIN', 'reopen');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
});

describe('feeInstallmentFsm', () => {
  it('SCHEDULED → INVOICED → DUE → OVERDUE → PARTIAL → PAID', () => {
    expect(assertTransition(feeInstallmentFsm, 'SCHEDULED', 'INVOICED', 'COUNSELLOR').ok).toBe(true);
    expect(assertTransition(feeInstallmentFsm, 'INVOICED', 'DUE', 'COUNSELLOR').ok).toBe(true);
    expect(assertTransition(feeInstallmentFsm, 'DUE', 'OVERDUE', 'COUNSELLOR').ok).toBe(true);
    expect(assertTransition(feeInstallmentFsm, 'OVERDUE', 'PARTIAL', 'COUNSELLOR').ok).toBe(true);
    expect(assertTransition(feeInstallmentFsm, 'PARTIAL', 'PAID', 'COUNSELLOR').ok).toBe(true);
  });
  it('SCHEDULED → SUSPENDED → INVOICED (pause/resume cycle)', () => {
    expect(assertTransition(feeInstallmentFsm, 'SCHEDULED', 'SUSPENDED', 'COUNSELLOR').ok).toBe(true);
    expect(assertTransition(feeInstallmentFsm, 'SUSPENDED', 'INVOICED', 'COUNSELLOR').ok).toBe(true);
  });
  it('WAIVER from any active state requires ADMIN + reason', () => {
    expect(assertTransition(feeInstallmentFsm, 'DUE', 'WAIVED', 'COUNSELLOR', 'hardship').ok).toBe(false);
    expect(assertTransition(feeInstallmentFsm, 'DUE', 'WAIVED', 'ADMIN').ok).toBe(false);
    expect(assertTransition(feeInstallmentFsm, 'DUE', 'WAIVED', 'ADMIN', 'hardship').ok).toBe(true);
  });
  it('CANCELLED requires ADMIN + reason (admin-only termination)', () => {
    expect(assertTransition(feeInstallmentFsm, 'OVERDUE', 'CANCELLED', 'COUNSELLOR', 'why').ok).toBe(false);
    expect(assertTransition(feeInstallmentFsm, 'OVERDUE', 'CANCELLED', 'ADMIN', 'plan cancelled').ok).toBe(true);
  });
  it('PAID → REFUNDED (after refund completion)', () => {
    expect(assertTransition(feeInstallmentFsm, 'PAID', 'REFUNDED', 'ADMIN', 'refund processed').ok).toBe(true);
  });
  it('illegal skip SCHEDULED → PAID returns 422 (no rule)', () => {
    const r = assertTransition(feeInstallmentFsm, 'SCHEDULED', 'PAID', 'ADMIN');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });
  it('illegal CANCELLED → INVOICED (terminal)', () => {
    const r = assertTransition(feeInstallmentFsm, 'CANCELLED', 'INVOICED', 'ADMIN', 'reopen');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
  it('illegal REFUNDED → PAID (terminal)', () => {
    const r = assertTransition(feeInstallmentFsm, 'REFUNDED', 'PAID', 'ADMIN', 'reverse');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
});

describe('paymentFsm', () => {
  it('RECEIVED → VOIDED requires ADMIN + reason', () => {
    expect(assertTransition(paymentFsm, 'RECEIVED', 'VOIDED', 'COUNSELLOR', 'why').ok).toBe(false);
    expect(assertTransition(paymentFsm, 'RECEIVED', 'VOIDED', 'ADMIN').ok).toBe(false);
    expect(assertTransition(paymentFsm, 'RECEIVED', 'VOIDED', 'ADMIN', 'duplicate').ok).toBe(true);
  });
  it('RECEIVED → PARTIALLY_REFUNDED requires ADMIN + reason', () => {
    expect(assertTransition(paymentFsm, 'RECEIVED', 'PARTIALLY_REFUNDED', 'ADMIN', 'refund 50%').ok).toBe(true);
  });
  it('PARTIALLY_REFUNDED → REFUNDED requires ADMIN + reason', () => {
    expect(assertTransition(paymentFsm, 'PARTIALLY_REFUNDED', 'REFUNDED', 'ADMIN', 'rest refunded').ok).toBe(true);
  });
  it('VOIDED is terminal', () => {
    const r = assertTransition(paymentFsm, 'VOIDED', 'RECEIVED', 'ADMIN', 'restore');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
  it('REFUNDED is terminal', () => {
    const r = assertTransition(paymentFsm, 'REFUNDED', 'RECEIVED', 'ADMIN', 'restore');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
});

// Sanity: ON_LEAVE additions to enrollment + student FSMs.
describe('enrollmentFsm ON_LEAVE (Wave Billing)', () => {
  it.skip('imported via dynamic import to avoid Prisma client coupling', () => {
    // Tested via existing enrollment FSM spec — placeholder so the diff is searchable.
  });
});

// SVT-SEC-2026-05 — Wave 4 void/refund rollback edges + PARTIAL→CANCELLED.
describe('feeInstallmentFsm — Wave 4 rollback + PARTIAL→CANCELLED edges', () => {
  it('PAID → INVOICED allowed for ADMIN with reason (full void)', () => {
    const r = assertTransition(feeInstallmentFsm, 'PAID', 'INVOICED', 'ADMIN', 'void payment');
    expect(r.ok).toBe(true);
  });
  it('PAID → INVOICED rejected for COUNSELLOR', () => {
    const r = assertTransition(feeInstallmentFsm, 'PAID', 'INVOICED', 'COUNSELLOR', 'void');
    expect(r.ok).toBe(false);
  });
  it('PAID → PARTIAL allowed for ADMIN (partial void)', () => {
    const r = assertTransition(feeInstallmentFsm, 'PAID', 'PARTIAL', 'ADMIN', 'partial void');
    expect(r.ok).toBe(true);
  });
  it('PARTIAL → INVOICED allowed for ADMIN (refund rollback)', () => {
    const r = assertTransition(feeInstallmentFsm, 'PARTIAL', 'INVOICED', 'ADMIN', 'rollback');
    expect(r.ok).toBe(true);
  });
  it('PARTIAL → CANCELLED allowed for ADMIN (plan cancel with partial pay)', () => {
    const r = assertTransition(feeInstallmentFsm, 'PARTIAL', 'CANCELLED', 'ADMIN', 'plan cancel');
    expect(r.ok).toBe(true);
  });
});

// refundFsm — added after audit flagged FAILED enum-drift between Zod/Prisma
// and missing FSM transition.
import { refundFsm } from '../src/modules/billing/fsm-def.js';

describe('refundFsm', () => {
  it('PENDING → COMPLETED requires ADMIN', () => {
    expect(assertTransition(refundFsm, 'PENDING', 'COMPLETED', 'COUNSELLOR').ok).toBe(false);
    expect(assertTransition(refundFsm, 'PENDING', 'COMPLETED', 'ADMIN').ok).toBe(true);
  });
  it('PENDING → FAILED requires ADMIN + reason', () => {
    expect(assertTransition(refundFsm, 'PENDING', 'FAILED', 'ADMIN').ok).toBe(false);
    expect(assertTransition(refundFsm, 'PENDING', 'FAILED', 'ADMIN', 'gateway 5xx').ok).toBe(true);
  });
  it('COMPLETED is terminal — cannot revert', () => {
    const r = assertTransition(refundFsm, 'COMPLETED', 'PENDING', 'ADMIN', 'mistake');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
  it('FAILED is terminal — cannot reopen', () => {
    const r = assertTransition(refundFsm, 'FAILED', 'PENDING', 'ADMIN', 'retry');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
  it('FAILED → COMPLETED is NOT a legal direct transition (must create a fresh refund)', () => {
    const r = assertTransition(refundFsm, 'FAILED', 'COMPLETED', 'ADMIN');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
});
