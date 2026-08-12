// SVT-FIN-2026-08 (T1-6) — the late-fee recompute must hold a row lock.
//
// It used to be four naked statements with no transaction and no lock:
//
//   feeAdjustment.create → feeAdjustment.aggregate
//     → feeInstallment.findFirst → feeInstallment.updateMany
//
// unlike applyAdjustment, which holds FOR UPDATE throughout. Two failures fell
// out of that:
//
//   * A payment landing between the findFirst and the updateMany meant
//     `paid_minor` was written from a stale snapshot — producing a PAID
//     installment carrying a balance, excluded from every collection path and
//     never rescanned.
//   * Crashing mid-sequence orphaned the adjustment permanently, because the
//     same-day idempotency guard then skipped the recompute forever.
//
// The scan that feeds this loop is also capped at 5,000 rows, so by the time a
// given installment is reached it may have been paid, waived or cancelled.
// Charging a late fee on money already received is its own customer-facing
// error, so the status is re-checked under the lock too.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = '11111111-1111-7111-8111-111111111111';
const INST = '22222222-2222-7222-8222-222222222222';

type LockedRow = {
  id: string;
  gross_minor: bigint;
  paid_minor: bigint;
  status: string;
};

const state = {
  /** What the FOR UPDATE re-read returns. */
  locked: [] as LockedRow[],
  /** Whether a LATE_FEE already exists for today. */
  existingToday: null as { id: string } | null,
  adjustmentsCreated: [] as Record<string, unknown>[],
  installmentUpdates: [] as Record<string, unknown>[],
  /** Statements issued inside the transaction, in order. */
  sql: [] as string[],
};

const auditMock = vi.fn(async () => undefined);
vi.mock('../src/shared/audit.js', () => ({ writeAudit: auditMock }));
vi.mock('../src/config/sentry.js', () => ({
  withTenantScope: async (_t: string, _n: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../src/config/db.js', () => {
  const prisma = {
    tenant: {
      findMany: vi.fn(async () => [{ id: TENANT }]),
      findFirst: vi.fn(async () => ({ id: TENANT, billing_enabled: true })),
    },
    feeInstallment: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // Only the OVERDUE late-fee scan should return anything; the earlier
        // status-transition steps must find no work.
        if (where['status'] !== 'OVERDUE') return [];
        return [
          {
            id: INST,
            currency: 'USD',
            fee_plan: { late_fee_policy: { enabled: true, amount_minor: 500 } },
            adjustments: [],
            _count: { adjustments: 0 },
          },
        ];
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.installmentUpdates.push(data);
        return {};
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    feePlan: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    feeAdjustment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.adjustmentsCreated.push(data);
        return {};
      }),
      aggregate: vi.fn(async () => ({ _sum: { amount_minor: 500n } })),
      findFirst: vi.fn(async () => state.existingToday),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => {
      state.sql.push('set_config');
      return 1;
    }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FOR UPDATE')) {
        state.sql.push('FOR UPDATE');
        return state.locked;
      }
      return [];
    }),
  };
  return { prisma, prismaAdmin: prisma, disconnectDb: async () => undefined };
});

const { runBillingDaily } = await import('../src/jobs/billingDaily.js');

beforeEach(() => {
  state.locked = [
    { id: INST, gross_minor: 10_000n, paid_minor: 0n, status: 'OVERDUE' },
  ];
  state.existingToday = null;
  state.adjustmentsCreated.length = 0;
  state.installmentUpdates.length = 0;
  state.sql.length = 0;
  auditMock.mockClear();
});

describe('billingDaily late fee — T1-6 locking', () => {
  it('re-reads the installment FOR UPDATE before writing', async () => {
    await runBillingDaily();
    expect(state.sql).toContain('FOR UPDATE');
    expect(state.adjustmentsCreated).toHaveLength(1);
  });

  it('sets the tenant GUC before the lock, so the read is not filtered away', async () => {
    // T0-7: without set_config the whole scan matches zero rows under RLS.
    await runBillingDaily();
    expect(state.sql[0]).toBe('set_config');
  });

  it('computes the new balance from the LOCKED paid_minor, not a stale read', async () => {
    // The row was paid in full between the scan and the lock.
    state.locked = [
      { id: INST, gross_minor: 10_000n, paid_minor: 10_000n, status: 'OVERDUE' },
    ];
    await runBillingDaily();
    const update = state.installmentUpdates[0]!;
    // gross 10,000 + late fee 500 = net 10,500; paid 10,000 → balance 500.
    // The stale-read bug produced balance 10,500 on a row that had been paid.
    expect(update['net_minor']).toBe(10_500n);
    expect(update['balance_minor']).toBe(500n);
  });

  it('does not charge an installment that stopped being OVERDUE after the scan', async () => {
    state.locked = [
      { id: INST, gross_minor: 10_000n, paid_minor: 10_000n, status: 'PAID' },
    ];
    const out = await runBillingDaily();
    expect(state.adjustmentsCreated).toHaveLength(0);
    expect(state.installmentUpdates).toHaveLength(0);
    // A skip is not an error — someone simply paid it.
    expect(out.rowsFailed).toBe(0);
    expect((out.metadata as { late_fees_applied: number }).late_fees_applied).toBe(0);
  });

  it('does not charge twice when a LATE_FEE already exists for today', async () => {
    // The advisory job lock is session-scoped and Prisma does not pin
    // connections (T0-6), so two overlapping runs are possible. This predicate
    // is what makes a duplicate impossible rather than merely unlikely.
    state.existingToday = { id: 'adj-1' };
    await runBillingDaily();
    expect(state.adjustmentsCreated).toHaveLength(0);
  });

  it('does not charge an installment that vanished between the scan and the lock', async () => {
    state.locked = [];
    await runBillingDaily();
    expect(state.adjustmentsCreated).toHaveLength(0);
  });
});
