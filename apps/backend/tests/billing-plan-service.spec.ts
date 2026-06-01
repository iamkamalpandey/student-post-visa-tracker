// SVT-WAVE-BILLING-2026-05 — plan.service.ts integration smoke.
//
// Stubs Prisma in-memory so we can drive the create → pause → resume → cancel
// lifecycle without spinning the real database. The pricing math + FSM gates
// are exercised; the per-tenant unique invariant is asserted.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');

const TENANT = '11111111-1111-7111-8111-111111111111';
const STUDENT = '22222222-2222-7222-8222-222222222222';
const ENROLLMENT = '33333333-3333-7333-8333-333333333333';
const USER = '44444444-4444-7444-8444-444444444444';

type Plan = {
  id: string;
  tenant_id: string;
  enrollment_id: string;
  status: string;
  cadence: string;
  total_minor: bigint;
  currency: string;
  scholarship_minor: bigint;
  starts_on: Date;
  ends_on: Date | null;
  paused_at: Date | null;
  paused_reason: string | null;
  resumed_at: Date | null;
  superseded_by_id: string | null;
  notes: string | null;
  version: number;
  deleted_at: Date | null;
};
type Installment = {
  id: string;
  tenant_id: string;
  fee_plan_id: string;
  sequence_no: number;
  label: string;
  due_on: Date;
  gross_minor: bigint;
  net_minor: bigint;
  paid_minor: bigint;
  balance_minor: bigint;
  currency: string;
  status: string;
  deleted_at: Date | null;
};

const store = {
  enrollments: [
    {
      id: ENROLLMENT,
      tenant_id: TENANT,
      student_id: STUDENT,
      status: 'ENROLLED',
      tuition_currency: 'USD',
      deleted_at: null,
    },
  ],
  tenants: [{ id: TENANT, default_currency: 'USD' }],
  plans: [] as Plan[],
  installments: [] as Installment[],
};

vi.mock('../src/config/db.js', () => {
  const matchWhere = <T extends Record<string, unknown>>(rows: T[], where: Record<string, unknown>): T[] => {
    return rows.filter((r) => {
      for (const [k, v] of Object.entries(where)) {
        if (v === undefined) continue;
        if (v === null) { if (r[k] !== null) return false; continue; }
        if (typeof v === 'object' && v !== null && 'in' in (v as object)) {
          const arr = (v as { in: unknown[] }).in;
          if (!arr.includes(r[k])) return false;
          continue;
        }
        if (r[k] !== v) return false;
      }
      return true;
    });
  };
  const prisma = {
    tenant: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.tenants.find((t) => t.id === where['id']) ?? null;
      }),
    },
    enrollment: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return matchWhere(store.enrollments, where)[0] ?? null;
      }),
      update: vi.fn(async () => ({})),
    },
    feePlan: {
      findFirst: vi.fn(async ({ where, include }: { where: Record<string, unknown>; include?: Record<string, unknown> }) => {
        const hit = matchWhere(store.plans, where)[0] ?? null;
        if (!hit) return null;
        if (include?.['installments']) {
          const installments = store.installments
            .filter((i) => i.fee_plan_id === hit.id && i.deleted_at == null)
            .sort((a, b) => a.sequence_no - b.sequence_no);
          return { ...hit, installments };
        }
        return hit;
      }),
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        const rows = matchWhere(store.plans, where);
        return take ? rows.slice(0, take) : rows;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const p: Plan = {
          id: randomUUID(),
          ends_on: null,
          paused_at: null,
          paused_reason: null,
          resumed_at: null,
          superseded_by_id: null,
          notes: null,
          version: 1,
          deleted_at: null,
          ...(data as unknown as Plan),
        };
        store.plans.push(p);
        return p;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const p = store.plans.find((x) => x.id === where.id);
        if (!p) throw new Error('plan not found');
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'object' && v !== null && 'increment' in (v as object)) {
            (p as Record<string, unknown>)[k] = ((p as Record<string, unknown>)[k] as number) + (v as { increment: number }).increment;
          } else {
            (p as Record<string, unknown>)[k] = v;
          }
        }
        return p;
      }),
    },
    feeInstallment: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const d of data) {
          store.installments.push({ id: randomUUID(), deleted_at: null, ...(d as unknown as Installment) });
        }
        return { count: data.length };
      }),
      findMany: vi.fn(async ({ where, select: _select }: { where: Record<string, unknown>; select?: unknown }) => {
        // Resolve nested fee_plan.is.enrollment_id + fee_plan.is.enrollment.is.student_id.
        const fp = where['fee_plan'] as { is?: Record<string, unknown> } | undefined;
        const innerEnrollmentId = fp?.is?.['enrollment_id'] as string | undefined;
        const studentNest = fp?.is?.['enrollment'] as { is?: Record<string, unknown> } | undefined;
        const innerStudentId = studentNest?.is?.['student_id'] as string | undefined;
        const baseWhere: Record<string, unknown> = { ...where };
        delete baseWhere['fee_plan'];
        let rows = matchWhere(store.installments, baseWhere);
        if (innerEnrollmentId) {
          rows = rows.filter((i) => {
            const p = store.plans.find((x) => x.id === i.fee_plan_id);
            return p?.enrollment_id === innerEnrollmentId;
          });
        }
        if (innerStudentId) {
          rows = rows.filter((i) => {
            const p = store.plans.find((x) => x.id === i.fee_plan_id);
            const e = store.enrollments.find((x) => x.id === p?.enrollment_id);
            return e?.student_id === innerStudentId;
          });
        }
        return rows;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = matchWhere(store.installments, where);
        for (const r of rows) {
          for (const [k, v] of Object.entries(data)) {
            (r as Record<string, unknown>)[k] = v;
          }
        }
        return { count: rows.length };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = store.installments.find((x) => x.id === where.id);
        if (!r) throw new Error('installment not found');
        for (const [k, v] of Object.entries(data)) (r as Record<string, unknown>)[k] = v;
        return r;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ entry_hash: null }]),
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/encryption.js', () => ({
  encryptJson: vi.fn(async () => Buffer.from('stub')),
  encryptField: vi.fn(async (s: string | Buffer) => Buffer.from(typeof s === 'string' ? s : '')),
  decryptField: vi.fn(async (b: Buffer) => b.toString('utf8')),
  decryptJson: vi.fn(async () => null),
  isCiphertext: vi.fn(() => true),
}));

const {
  createFeePlan,
  pausePlan,
  resumePlan,
  cancelPlan,
  getOutstanding,
} = await import('../src/modules/billing/plan.service.js');

beforeEach(() => {
  store.plans.length = 0;
  store.installments.length = 0;
});

const ctx = { user: { tid: TENANT, sub: USER, role: 'ADMIN' as const } };

describe('plan.service createFeePlan', () => {
  it('creates a 12-month MONTHLY plan + 12 SCHEDULED installments → ACTIVE', async () => {
    const p = await createFeePlan(ctx, {
      enrollment_id: ENROLLMENT,
      cadence: 'MONTHLY',
      total_minor: 12000n,
      installment_count: 12,
      starts_on: '2026-09-01',
    });
    expect(p.status).toBe('ACTIVE');
    expect(p.total_minor).toBe(12000n);
    expect(store.installments.filter((i) => i.fee_plan_id === p.id)).toHaveLength(12);
    expect(store.installments.every((i) => i.status === 'SCHEDULED')).toBe(true);
  });

  it('refuses second active plan per enrollment', async () => {
    await createFeePlan(ctx, {
      enrollment_id: ENROLLMENT,
      cadence: 'QUARTERLY',
      total_minor: 4000n,
      installment_count: 4,
      starts_on: '2026-09-01',
    });
    await expect(
      createFeePlan(ctx, {
        enrollment_id: ENROLLMENT,
        cadence: 'MONTHLY',
        total_minor: 12000n,
        installment_count: 12,
        starts_on: '2026-09-01',
      }),
    ).rejects.toThrow(/already has/);
  });

  it('CUSTOM cadence requires lines[]', async () => {
    await expect(
      createFeePlan(ctx, {
        enrollment_id: ENROLLMENT,
        cadence: 'CUSTOM',
        starts_on: '2026-09-01',
      } as never),
    ).rejects.toThrow();
  });

  it('CUSTOM with lines[] sums to total_minor automatically', async () => {
    const p = await createFeePlan(ctx, {
      enrollment_id: ENROLLMENT,
      cadence: 'CUSTOM',
      starts_on: '2026-09-01',
      lines: [
        { label: 'Term 1', due_on: '2026-09-01', gross_minor: 5000n },
        { label: 'Term 2', due_on: '2027-02-01', gross_minor: 7500n },
      ],
    });
    expect(p.total_minor).toBe(12500n);
    expect(store.installments).toHaveLength(2);
  });
});

describe('plan.service pause/resume', () => {
  it('pause flips ACTIVE → PAUSED + SCHEDULED installments → SUSPENDED', async () => {
    const p = await createFeePlan(ctx, {
      enrollment_id: ENROLLMENT,
      cadence: 'MONTHLY',
      total_minor: 3000n,
      installment_count: 3,
      starts_on: '2026-09-01',
    });
    const paused = await pausePlan(ctx, p.id, { reason: 'leave of absence' });
    expect(paused.status).toBe('PAUSED');
    const insts = store.installments.filter((i) => i.fee_plan_id === p.id);
    expect(insts.every((i) => i.status === 'SUSPENDED')).toBe(true);
  });

  it('resume flips PAUSED → ACTIVE + SUSPENDED → INVOICED + shifts due dates by N', async () => {
    const p = await createFeePlan(ctx, {
      enrollment_id: ENROLLMENT,
      cadence: 'MONTHLY',
      total_minor: 3000n,
      installment_count: 3,
      starts_on: '2026-09-01',
    });
    await pausePlan(ctx, p.id, { reason: 'leave' });
    const dueBefore = store.installments
      .filter((i) => i.fee_plan_id === p.id)
      .map((i) => i.due_on.toISOString().slice(0, 10))
      .sort();
    await resumePlan(ctx, p.id, { shift_days: 14 });
    const dueAfter = store.installments
      .filter((i) => i.fee_plan_id === p.id)
      .map((i) => i.due_on.toISOString().slice(0, 10))
      .sort();
    expect(dueAfter).not.toEqual(dueBefore);
    expect(
      store.installments.filter((i) => i.fee_plan_id === p.id).every((i) => i.status === 'INVOICED'),
    ).toBe(true);
  });

  it('cancelPlan terminates non-paid installments + plan → CANCELLED', async () => {
    const p = await createFeePlan(ctx, {
      enrollment_id: ENROLLMENT,
      cadence: 'MONTHLY',
      total_minor: 3000n,
      installment_count: 3,
      starts_on: '2026-09-01',
    });
    const cancelled = await cancelPlan(ctx, p.id, { reason: 'withdrew from program' });
    expect(cancelled.status).toBe('CANCELLED');
    expect(
      store.installments.filter((i) => i.fee_plan_id === p.id).every((i) => i.status === 'CANCELLED'),
    ).toBe(true);
  });
});

describe('plan.service getOutstanding', () => {
  it('sums INVOICED/DUE/OVERDUE/PARTIAL balances for a student', async () => {
    const p = await createFeePlan(ctx, {
      enrollment_id: ENROLLMENT,
      cadence: 'MONTHLY',
      total_minor: 3000n,
      installment_count: 3,
      starts_on: '2026-09-01',
    });
    // Move all to INVOICED so they count.
    for (const i of store.installments.filter((x) => x.fee_plan_id === p.id)) {
      i.status = 'INVOICED';
    }
    const o = await getOutstanding(ctx, { enrollment_id: ENROLLMENT });
    expect(BigInt(o.total_minor)).toBe(3000n);
    expect(o.by_status['INVOICED']).toBe('3000');
    expect(o.oldest_due_on).toBe('2026-09-01');
    expect(o.currency).toBe('USD');
  });

  it('returns zero when no open installments', async () => {
    const o = await getOutstanding(ctx, { enrollment_id: ENROLLMENT });
    expect(BigInt(o.total_minor)).toBe(0n);
    expect(o.oldest_due_on).toBeNull();
  });
});
