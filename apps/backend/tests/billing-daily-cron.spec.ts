// SVT-WAVE-BILLING-2026-05 — billingDaily cron in-memory smoke.
//
// Drives runBillingDaily() against a stubbed Prisma store so we can assert the
// four state transitions (INVOICED→DUE, DUE→OVERDUE, ACTIVE→COMPLETED) plus
// per-tenant isolation + billing_enabled gating without a real database.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TENANT_OFF = '33333333-3333-7333-8333-333333333333';

type Inst = { id: string; tenant_id: string; fee_plan_id: string; status: string; due_on: Date; deleted_at: Date | null };
type Plan = { id: string; tenant_id: string; status: string; deleted_at: Date | null };
type Tenant = { id: string; is_active: boolean; billing_enabled: boolean };

const store = {
  tenants: [] as Tenant[],
  plans: [] as Plan[],
  installments: [] as Inst[],
  audits: [] as Array<{ tenantId: string; action: string; entityId: string }>,
  failTenant: null as string | null,
};

const auditMock = vi.fn(async (ev: { tenantId: string; action: string; entityId: string }) => {
  store.audits.push({ tenantId: ev.tenantId, action: ev.action, entityId: ev.entityId });
});

vi.mock('../src/shared/audit.js', () => ({ writeAudit: (ev: unknown) => auditMock(ev as never) }));
vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/config/db.js', () => {
  const matchInst = (where: Record<string, unknown>): Inst[] => {
    return store.installments.filter((i) => {
      if (i.deleted_at != null) return false;
      if (where['tenant_id'] && i.tenant_id !== where['tenant_id']) return false;
      if (where['id'] && i.id !== where['id']) return false;
      if (where['status'] && i.status !== where['status']) return false;
      const d = where['due_on'] as { lte?: Date; lt?: Date } | undefined;
      if (d?.lte && i.due_on > d.lte) return false;
      if (d?.lt && i.due_on >= d.lt) return false;
      return true;
    });
  };
  const prisma = {
    tenant: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.tenants.filter(
          (t) =>
            (where['is_active'] === undefined || t.is_active === where['is_active']) &&
            (where['billing_enabled'] === undefined || t.billing_enabled === where['billing_enabled']),
        );
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (store.failTenant && where['id'] === store.failTenant) {
          throw new Error('boom: tenant lookup failed');
        }
        return store.tenants.find((t) => t.id === where['id'] && t.is_active) ?? null;
      }),
    },
    feeInstallment: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => matchInst(where)),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => matchInst(where)[0] ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = matchInst(where);
        for (const r of rows) {
          for (const [k, v] of Object.entries(data)) {
            if (k === 'version') continue;
            (r as Record<string, unknown>)[k] = v;
          }
        }
        return { count: rows.length };
      }),
    },
    feePlan: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const rows = store.plans.filter(
          (p) =>
            p.deleted_at == null &&
            p.tenant_id === where['tenant_id'] &&
            p.status === where['status'],
        );
        return rows.map((p) => ({
          id: p.id,
          status: p.status,
          installments: store.installments
            .filter((i) => i.fee_plan_id === p.id && i.deleted_at == null)
            .map((i) => ({ status: i.status })),
        }));
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = store.plans.filter((p) => p.id === where['id'] && p.tenant_id === where['tenant_id']);
        for (const r of rows) {
          for (const [k, v] of Object.entries(data)) {
            if (k === 'version' || k === 'ends_on' || k === 'updated_by_id') continue;
            (r as Record<string, unknown>)[k] = v;
          }
        }
        return { count: rows.length };
      }),
    },
    feeAdjustment: {
      create: vi.fn(async () => ({})),
      aggregate: vi.fn(async () => ({ _sum: { amount_minor: 0n } })),
    },
  };
  return { prisma, disconnectDb: async () => undefined };
});

const { runBillingDaily } = await import('../src/jobs/billingDaily.ts');

const daysAgo = (n: number): Date => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
};

beforeEach(() => {
  store.tenants.length = 0;
  store.plans.length = 0;
  store.installments.length = 0;
  store.audits.length = 0;
  store.failTenant = null;
  auditMock.mockClear();
});

describe('billingDaily cron', () => {
  it('flips INVOICED → DUE when due_on <= today', async () => {
    store.tenants.push({ id: TENANT_A, is_active: true, billing_enabled: true });
    store.plans.push({ id: 'p1', tenant_id: TENANT_A, status: 'ACTIVE', deleted_at: null });
    store.installments.push({ id: 'i1', tenant_id: TENANT_A, fee_plan_id: 'p1', status: 'INVOICED', due_on: daysAgo(0), deleted_at: null });
    const out = await runBillingDaily();
    expect(store.installments.find((i) => i.id === 'i1')?.status).toBe('DUE');
    expect((out.metadata as { invoiced_to_due: number }).invoiced_to_due).toBe(1);
  });

  it('flips DUE → OVERDUE when due_on < today - grace_days(7)', async () => {
    store.tenants.push({ id: TENANT_A, is_active: true, billing_enabled: true });
    store.plans.push({ id: 'p1', tenant_id: TENANT_A, status: 'ACTIVE', deleted_at: null });
    store.installments.push({ id: 'late', tenant_id: TENANT_A, fee_plan_id: 'p1', status: 'DUE', due_on: daysAgo(30), deleted_at: null });
    store.installments.push({ id: 'fresh', tenant_id: TENANT_A, fee_plan_id: 'p1', status: 'DUE', due_on: daysAgo(2), deleted_at: null });
    const out = await runBillingDaily();
    expect(store.installments.find((i) => i.id === 'late')?.status).toBe('OVERDUE');
    expect(store.installments.find((i) => i.id === 'fresh')?.status).toBe('DUE');
    expect((out.metadata as { due_to_overdue: number }).due_to_overdue).toBe(1);
  });

  it('flips ACTIVE plan → COMPLETED + writes audit when all installments PAID', async () => {
    store.tenants.push({ id: TENANT_A, is_active: true, billing_enabled: true });
    store.plans.push({ id: 'pall', tenant_id: TENANT_A, status: 'ACTIVE', deleted_at: null });
    store.installments.push(
      { id: 'a', tenant_id: TENANT_A, fee_plan_id: 'pall', status: 'PAID', due_on: daysAgo(60), deleted_at: null },
      { id: 'b', tenant_id: TENANT_A, fee_plan_id: 'pall', status: 'PAID', due_on: daysAgo(30), deleted_at: null },
    );
    await runBillingDaily();
    expect(store.plans.find((p) => p.id === 'pall')?.status).toBe('COMPLETED');
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]).toMatchObject({ tenantId: TENANT_A, action: 'fee_plan.completed', entityId: 'pall' });
  });

  it('billing_enabled=false tenant is a no-op (zero writes)', async () => {
    store.tenants.push({ id: TENANT_OFF, is_active: true, billing_enabled: false });
    // Even if the cron *did* scan, this would flip — but the prefilter must skip it.
    store.plans.push({ id: 'pX', tenant_id: TENANT_OFF, status: 'ACTIVE', deleted_at: null });
    store.installments.push({ id: 'iX', tenant_id: TENANT_OFF, fee_plan_id: 'pX', status: 'INVOICED', due_on: daysAgo(5), deleted_at: null });
    const out = await runBillingDaily();
    expect(store.installments[0]?.status).toBe('INVOICED');
    expect(store.plans[0]?.status).toBe('ACTIVE');
    expect(store.audits).toHaveLength(0);
    expect(out.rowsProcessed).toBe(0);
    expect((out.metadata as { tenants: number }).tenants).toBe(0);
  });

  it('per-tenant isolation: tenant A crash does not block tenant B', async () => {
    store.tenants.push(
      { id: TENANT_A, is_active: true, billing_enabled: true },
      { id: TENANT_B, is_active: true, billing_enabled: true },
    );
    store.failTenant = TENANT_A; // tenant.findFirst will throw for A.
    store.plans.push({ id: 'pB', tenant_id: TENANT_B, status: 'ACTIVE', deleted_at: null });
    store.installments.push({ id: 'iB', tenant_id: TENANT_B, fee_plan_id: 'pB', status: 'INVOICED', due_on: daysAgo(1), deleted_at: null });
    const out = await runBillingDaily();
    // B still processed despite A blowing up.
    expect(store.installments.find((i) => i.id === 'iB')?.status).toBe('DUE');
    expect((out.metadata as { invoiced_to_due: number; errors: number }).invoiced_to_due).toBe(1);
    expect((out.metadata as { errors: number }).errors).toBeGreaterThanOrEqual(1);
  });
});
