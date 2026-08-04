// SVT-WAVE-BILLING-2026-05 — payment.service.ts integration smoke.
//
// Stubs Prisma in-memory and mocks $queryRaw for the SELECT … FOR UPDATE locks
// so we can drive recordPayment end-to-end: FIFO splits, currency invariant,
// overflow credit, manual allocation guards, and the audit emission.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = '11111111-1111-7111-8111-111111111111';
const STUDENT = '22222222-2222-7222-8222-222222222222';
const ENROLLMENT = '33333333-3333-7333-8333-333333333333';
const PLAN = '55555555-5555-7555-8555-555555555555';
const USER = '44444444-4444-7444-8444-444444444444';

type Installment = {
  id: string;
  tenant_id: string;
  fee_plan_id: string;
  sequence_no: number;
  due_on: Date;
  net_minor: bigint;
  paid_minor: bigint;
  balance_minor: bigint;
  currency: string;
  status: string;
  deleted_at: Date | null;
};

const store = {
  enrollments: [
    { id: ENROLLMENT, tenant_id: TENANT, student_id: STUDENT, tuition_currency: 'USD', deleted_at: null },
  ],
  installments: [] as Installment[],
  payments: [] as Array<Record<string, unknown>>,
  allocations: [] as Array<Record<string, unknown>>,
  credits: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
};

const mkInst = (seq: number, net: bigint, currency = 'USD', status = 'DUE'): Installment => ({
  id: randomUUID(),
  tenant_id: TENANT,
  fee_plan_id: PLAN,
  sequence_no: seq,
  due_on: new Date(Date.UTC(2026, 0, seq)),
  net_minor: net,
  paid_minor: 0n,
  balance_minor: net,
  currency,
  status,
  deleted_at: null,
});

vi.mock('../src/config/db.js', () => {
  const matchWhere = <T extends Record<string, unknown>>(rows: T[], where: Record<string, unknown>): T[] =>
    rows.filter((r) => {
      for (const [k, v] of Object.entries(where)) {
        if (v === undefined) continue;
        if (v === null) { if (r[k] !== null) return false; continue; }
        if (r[k] !== v) return false;
      }
      return true;
    });
  const prisma: Record<string, unknown> = {
    enrollment: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchWhere(store.enrollments, where)[0] ?? null),
    },
    payment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const p = { id: randomUUID(), receipt_no: 'R-0001', ...data };
        store.payments.push(p);
        return p;
      }),
    },
    paymentAllocation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.allocations.push(data);
        return data;
      }),
    },
    feeInstallment: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = store.installments.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'object' && v !== null && 'increment' in (v as object)) {
            (r as Record<string, unknown>)[k] = ((r as Record<string, unknown>)[k] as number) + (v as { increment: number }).increment;
          } else {
            (r as Record<string, unknown>)[k] = v;
          }
        }
        return r;
      }),
    },
    studentCredit: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.credits.push(data);
        return data;
      }),
    },
    auditLog: { create: vi.fn(async (args: { data: Record<string, unknown> }) => { store.audits.push(args.data); return args.data; }), findFirst: vi.fn(async () => null) },
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('billing_next_receipt_no')) return [{ next_no: 'R-0001' }];
      if (sql.includes('FROM fee_installments') && sql.includes('id = ANY')) {
        const ids = values[0] as string[];
        return store.installments
          .filter((i) => ids.includes(i.id) && !['WAIVED', 'CANCELLED', 'REFUNDED'].includes(i.status))
          .map((i) => ({ id: i.id, balance_minor: i.balance_minor, net_minor: i.net_minor, paid_minor: i.paid_minor, currency: i.currency, status: i.status }));
      }
      if (sql.includes('JOIN fee_plans')) {
        return [...store.installments]
          .filter((i) => ['SCHEDULED', 'INVOICED', 'DUE', 'OVERDUE', 'PARTIAL'].includes(i.status))
          .sort((a, b) => a.sequence_no - b.sequence_no)
          .map((i) => ({ id: i.id, balance_minor: i.balance_minor, net_minor: i.net_minor, paid_minor: i.paid_minor, currency: i.currency, status: i.status }));
      }
      return [];
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
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

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (...args: unknown[]) => {
    const e = (args.length === 1 ? args[0] : args[1]) as Record<string, unknown>;
    store.audits.push(e);
  }),
}));

const { recordPayment } = await import('../src/modules/billing/payment.service.js');

beforeEach(() => {
  store.installments.length = 0;
  store.payments.length = 0;
  store.allocations.length = 0;
  store.credits.length = 0;
  store.audits.length = 0;
});

const ctx = { user: { tid: TENANT, sub: USER, role: 'ADMIN' as const } };
const baseInput = {
  enrollment_id: ENROLLMENT,
  received_on: '2026-05-19',
  method: 'CASH' as const,
  currency: 'USD',
};

describe('payment.service recordPayment', () => {
  it('FIFO splits 250 across [100,100,100] → [100,100,50]', async () => {
    store.installments.push(mkInst(1, 100n), mkInst(2, 100n), mkInst(3, 100n));
    await recordPayment(ctx as never, { ...baseInput, gross_minor: 250n });
    const sorted = [...store.installments].sort((a, b) => a.sequence_no - b.sequence_no);
    expect(sorted.map((i) => i.status)).toEqual(['PAID', 'PAID', 'PARTIAL']);
    expect(sorted.map((i) => i.balance_minor.toString())).toEqual(['0', '0', '50']);
    expect(store.allocations).toHaveLength(3);
  });

  it('rejects currency mismatch with BadRequest', async () => {
    store.installments.push(mkInst(1, 100n, 'EUR'));
    await expect(
      recordPayment(ctx as never, { ...baseInput, gross_minor: 100n }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('overflow → StudentCredit row created', async () => {
    store.installments.push(mkInst(1, 100n));
    await recordPayment(ctx as never, { ...baseInput, gross_minor: 175n });
    expect(store.credits).toHaveLength(1);
    expect(store.credits[0]).toMatchObject({
      amount_minor: 75n,
      currency: 'USD',
      source: 'overpayment',
      student_id: STUDENT,
    });
  });

  it('manual allocation sum > gross is rejected', async () => {
    const i1 = mkInst(1, 100n);
    store.installments.push(i1);
    await expect(
      recordPayment(ctx as never, {
        ...baseInput,
        gross_minor: 50n,
        allocations: [{ fee_installment_id: i1.id, amount_minor: 100n }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('manual allocation against WAIVED installment is rejected', async () => {
    const waived = mkInst(1, 100n, 'USD', 'WAIVED');
    store.installments.push(waived);
    await expect(
      recordPayment(ctx as never, {
        ...baseInput,
        gross_minor: 100n,
        allocations: [{ fee_installment_id: waived.id, amount_minor: 100n }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('writes payment.received audit row with allocation_count', async () => {
    store.installments.push(mkInst(1, 100n), mkInst(2, 100n));
    await recordPayment(ctx as never, { ...baseInput, gross_minor: 150n });
    const audit = store.audits.find((a) => a.action === 'payment.received');
    expect(audit).toBeDefined();
    const after = audit!['after'] as Record<string, unknown>;
    expect(after['allocation_count']).toBe(2);
    expect(after['overflow_minor']).toBe('0');
  });
});
