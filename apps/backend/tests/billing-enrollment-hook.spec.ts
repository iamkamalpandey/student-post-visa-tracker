// SVT-WAVE-BILLING-2026-05 (Wave 5) — enrollment-hook.ts unit coverage.
//
// Verifies the four billing hooks wired off the Enrollment FSM:
//   • billing_enabled=false short-circuits every hook (zero plan calls)
//   • ACCEPTED → ENROLLED seeds a FeePlan from tuition_total_minor
//   • Replay (409 Conflict on duplicate plan) is swallowed silently
//   • ON_LEAVE pauses an ACTIVE plan
//   • WITHDRAWN cancels with waive_remaining + enrollment.<reason>

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');

const TENANT = '11111111-1111-7111-8111-111111111111';
const ENROLLMENT = '33333333-3333-7333-8333-333333333333';
const PLAN = '55555555-5555-7555-8555-555555555555';
const USER = '44444444-4444-7444-8444-444444444444';

type EnrollmentRow = {
  id: string;
  tenant_id: string;
  tuition_total_minor: bigint | null;
  tuition_currency: string | null;
  start_date: Date | null;
  program_intake_id: string | null;
};
type PlanRow = { id: string; status: string };
type ClaimRow = { id: string; status: string };

const commissionUpdateMany = vi.fn(async () => ({ count: 1 }));

const store: {
  billingEnabled: boolean;
  enrollment: EnrollmentRow | null;
  plan: PlanRow | null;
  claim: ClaimRow | null;
} = {
  billingEnabled: true,
  enrollment: null,
  plan: null,
  claim: null,
};

vi.mock('../src/config/db.js', () => {
  const prisma = {
    tenant: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id !== TENANT) return null;
        return { billing_enabled: store.billingEnabled };
      }),
    },
    enrollment: {
      findFirst: vi.fn(async () => store.enrollment),
    },
    feePlan: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (!store.plan) return null;
        const status = where['status'];
        if (typeof status === 'string' && store.plan.status !== status) return null;
        if (status && typeof status === 'object' && 'in' in status) {
          const arr = (status as { in: string[] }).in;
          if (!arr.includes(store.plan.status)) return null;
        }
        return store.plan;
      }),
    },
    commissionClaim: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (!store.claim) return null;
        const status = where['status'] as { in?: string[] } | undefined;
        if (status?.in && !status.in.includes(store.claim.status)) return null;
        return { id: store.claim.id, status: store.claim.status };
      }),
      updateMany: commissionUpdateMany,
    },
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/config/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

const createFeePlan = vi.fn(async () => ({ id: PLAN, status: 'ACTIVE' }));
const pausePlan = vi.fn(async () => ({ id: PLAN, status: 'PAUSED' }));
const resumePlan = vi.fn(async () => ({ id: PLAN, status: 'ACTIVE' }));
const cancelPlan = vi.fn(async () => ({ id: PLAN, status: 'CANCELLED' }));

vi.mock('../src/modules/billing/plan.service.js', () => ({
  createFeePlan: (...a: unknown[]) => createFeePlan(...(a as [])),
  pausePlan: (...a: unknown[]) => pausePlan(...(a as [])),
  resumePlan: (...a: unknown[]) => resumePlan(...(a as [])),
  cancelPlan: (...a: unknown[]) => cancelPlan(...(a as [])),
}));

const {
  maybeSeedFeePlan,
  maybePauseOnLeave,
  maybeResumeFromLeave,
  maybeCancelOnWithdraw,
} = await import('../src/modules/billing/enrollment-hook.js');

const ctx = { user: { tid: TENANT, sub: USER, role: 'ADMIN' as const } };

beforeEach(() => {
  createFeePlan.mockClear();
  pausePlan.mockClear();
  resumePlan.mockClear();
  cancelPlan.mockClear();
  commissionUpdateMany.mockClear();
  store.claim = { id: 'claim-1', status: 'PENDING' };
  store.billingEnabled = true;
  store.enrollment = {
    id: ENROLLMENT,
    tenant_id: TENANT,
    tuition_total_minor: 120000n,
    tuition_currency: 'USD',
    start_date: new Date('2026-09-01T00:00:00Z'),
    program_intake_id: null,
  };
  store.plan = { id: PLAN, status: 'ACTIVE' };
});

describe('enrollment-hook: billing_enabled=false short-circuit', () => {
  it('all four hooks no-op when tenant.billing_enabled is false', async () => {
    store.billingEnabled = false;
    await maybeSeedFeePlan(ctx, ENROLLMENT);
    await maybePauseOnLeave(ctx, ENROLLMENT);
    await maybeResumeFromLeave(ctx, ENROLLMENT);
    await maybeCancelOnWithdraw(ctx, ENROLLMENT, 'WITHDRAWN');
    expect(createFeePlan).not.toHaveBeenCalled();
    expect(pausePlan).not.toHaveBeenCalled();
    expect(resumePlan).not.toHaveBeenCalled();
    expect(cancelPlan).not.toHaveBeenCalled();
  });
});

describe('enrollment-hook: maybeSeedFeePlan', () => {
  it('ACCEPTED → ENROLLED with tuition_total_minor>0 invokes createFeePlan', async () => {
    await maybeSeedFeePlan(ctx, ENROLLMENT);
    expect(createFeePlan).toHaveBeenCalledTimes(1);
    const [, payload] = createFeePlan.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(payload.enrollment_id).toBe(ENROLLMENT);
    expect(payload.cadence).toBe('ANNUAL');
    expect(payload.total_minor).toBe(120000n);
    expect(payload.installment_count).toBe(1);
    expect(payload.starts_on).toBe('2026-09-01');
    expect(payload.currency).toBe('USD');
  });

  it('skips when tuition_total_minor is missing or zero', async () => {
    store.enrollment!.tuition_total_minor = 0n;
    await maybeSeedFeePlan(ctx, ENROLLMENT);
    expect(createFeePlan).not.toHaveBeenCalled();
  });

  it('replay swallows 409 Conflict from createFeePlan silently', async () => {
    createFeePlan.mockImplementationOnce(async () => {
      const err = Object.assign(new Error('plan exists'), { status: 409 });
      throw err;
    });
    await expect(maybeSeedFeePlan(ctx, ENROLLMENT)).resolves.toBeUndefined();
    expect(createFeePlan).toHaveBeenCalledTimes(1);
  });
});

describe('enrollment-hook: maybePauseOnLeave', () => {
  it('ON_LEAVE with an ACTIVE plan calls pausePlan with enrollment.on_leave reason', async () => {
    store.plan = { id: PLAN, status: 'ACTIVE' };
    await maybePauseOnLeave(ctx, ENROLLMENT);
    expect(pausePlan).toHaveBeenCalledTimes(1);
    const [, planId, payload] = pausePlan.mock.calls[0] as [unknown, string, { reason: string }];
    expect(planId).toBe(PLAN);
    expect(payload.reason).toBe('enrollment.on_leave');
  });

  it('no-op when no ACTIVE plan exists', async () => {
    store.plan = null;
    await maybePauseOnLeave(ctx, ENROLLMENT);
    expect(pausePlan).not.toHaveBeenCalled();
  });
});

describe('enrollment-hook: maybeCancelOnWithdraw', () => {
  it('WITHDRAWN cancels with waive_remaining=true + reason starts with enrollment.', async () => {
    store.plan = { id: PLAN, status: 'ACTIVE' };
    await maybeCancelOnWithdraw(ctx, ENROLLMENT, 'WITHDRAWN');
    expect(cancelPlan).toHaveBeenCalledTimes(1);
    const [elevatedCtx, planId, payload] = cancelPlan.mock.calls[0] as [
      { user: { role: string; tid: string } },
      string,
      { reason: string; waive_remaining: boolean },
    ];
    expect(elevatedCtx.user.role).toBe('ADMIN');
    expect(elevatedCtx.user.tid).toBe(TENANT);
    expect(planId).toBe(PLAN);
    expect(payload.waive_remaining).toBe(true);
    expect(payload.reason.startsWith('enrollment.')).toBe(true);
    expect(payload.reason).toBe('enrollment.withdrawn');
  });

  it('no-op when no cancellable plan exists', async () => {
    store.plan = null;
    await maybeCancelOnWithdraw(ctx, ENROLLMENT, 'CANCELLED');
    expect(cancelPlan).not.toHaveBeenCalled();
  });

  it('flags a not-yet-paid commission claim as DISPUTED on withdrawal', async () => {
    store.claim = { id: 'claim-1', status: 'PENDING' };
    await maybeCancelOnWithdraw(ctx, ENROLLMENT, 'WITHDRAWN');
    expect(commissionUpdateMany).toHaveBeenCalledTimes(1);
    expect(commissionUpdateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: 'claim-1', tenant_id: TENANT, status: { in: ['PENDING', 'CLAIMED', 'INVOICED'] } },
      data: { status: 'DISPUTED' },
    });
  });

  it('leaves a PAID commission claim untouched on withdrawal', async () => {
    store.claim = { id: 'claim-1', status: 'PAID' };
    await maybeCancelOnWithdraw(ctx, ENROLLMENT, 'WITHDRAWN');
    expect(commissionUpdateMany).not.toHaveBeenCalled();
  });
});
