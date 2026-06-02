// SVT-WAVE-BILLING-2026-05 — payment.service.ts void/refund/adjustment paths.
//
// Sibling to billing-payment-service.spec.ts. Re-uses the same in-memory Prisma
// mock pattern (object stores + matchWhere helper) but exercises the
// non-recordPayment exports: voidPayment, createRefund, completeRefund,
// markRefundFailed, applyAdjustment.

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
const USER = '44444444-4444-7444-8444-444444444444';

type Installment = {
  id: string; tenant_id: string; sequence_no: number;
  gross_minor: bigint; net_minor: bigint; paid_minor: bigint; balance_minor: bigint;
  currency: string; status: string; deleted_at: Date | null;
};
type Payment = {
  id: string; tenant_id: string; student_id: string; enrollment_id: string;
  currency: string; gross_minor: bigint; status: string; deleted_at: Date | null;
};
type Allocation = {
  id: string; tenant_id: string; payment_id: string; fee_installment_id: string;
  amount_minor: bigint; created_at: Date;
};
type Refund = {
  id: string; tenant_id: string; payment_id: string; amount_minor: bigint;
  status: string;
};
type Adjustment = {
  id: string; tenant_id: string; fee_installment_id: string;
  kind: string; amount_minor: bigint;
};

const store = {
  enrollments: [{ id: ENROLLMENT, tenant_id: TENANT, student_id: STUDENT, deleted_at: null }],
  installments: [] as Installment[],
  payments: [] as Payment[],
  allocations: [] as Allocation[],
  refunds: [] as Refund[],
  adjustments: [] as Adjustment[],
  credits: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
};

const mkInst = (seq: number, net: bigint, paid = 0n, status = 'DUE'): Installment => ({
  id: randomUUID(), tenant_id: TENANT, sequence_no: seq,
  gross_minor: net, net_minor: net, paid_minor: paid, balance_minor: net - paid,
  currency: 'USD', status, deleted_at: null,
});
const mkPayment = (gross: bigint, status = 'RECEIVED'): Payment => ({
  id: randomUUID(), tenant_id: TENANT, student_id: STUDENT, enrollment_id: ENROLLMENT,
  currency: 'USD', gross_minor: gross, status, deleted_at: null,
});

vi.mock('../src/config/db.js', () => {
  const matchWhere = <T extends Record<string, unknown>>(rows: T[], where: Record<string, unknown>): T[] =>
    rows.filter((r) => {
      for (const [k, v] of Object.entries(where)) {
        if (v === undefined) continue;
        if (v === null) { if (r[k] !== null) return false; continue; }
        if (typeof v === 'object' && v !== null && 'in' in (v as object)) {
          if (!(v as { in: unknown[] }).in.includes(r[k])) return false; continue;
        }
        if (r[k] !== v) return false;
      }
      return true;
    });
  const sumBy = (rows: Array<Record<string, unknown>>, field: string): bigint =>
    rows.reduce((s, r) => s + (r[field] as bigint ?? 0n), 0n);

  const prisma: Record<string, unknown> = {
    enrollment: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchWhere(store.enrollments, where)[0] ?? null),
    },
    payment: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchWhere(store.payments, where)[0] ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const p = store.payments.find((x) => x.id === where.id);
        if (!p) throw new Error('payment not found');
        return p;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const p = store.payments.find((x) => x.id === where.id)!;
        Object.assign(p, data);
        return p;
      }),
      // Status-guarded updateMany (SVT-AUDIT-SEC-2026-06). Matches by where
      // (id + status), applies non-increment fields, returns the matched count.
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = matchWhere(store.payments, where);
        for (const p of rows) for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'object' && v !== null && 'increment' in (v as object)) continue;
          (p as Record<string, unknown>)[k] = v;
        }
        return { count: rows.length };
      }),
    },
    paymentAllocation: {
      findMany: vi.fn(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: { created_at?: string } }) => {
        let rows = matchWhere(store.allocations, where);
        if (orderBy?.created_at === 'desc') {
          rows = [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        }
        return rows;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const idx = store.allocations.findIndex((a) => a.id === where.id);
        if (idx >= 0) store.allocations.splice(idx, 1);
        return { id: where.id };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = store.allocations.length;
        const keep = store.allocations.filter((a) => {
          for (const [k, v] of Object.entries(where)) if ((a as Record<string, unknown>)[k] !== v) return true;
          return false;
        });
        store.allocations.length = 0;
        store.allocations.push(...keep);
        return { count: before - keep.length };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const a = store.allocations.find((x) => x.id === where.id)!;
        Object.assign(a, data);
        return a;
      }),
    },
    feeInstallment: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = store.installments.find((x) => x.id === where.id)!;
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'object' && v !== null && 'increment' in (v as object)) continue;
          (r as Record<string, unknown>)[k] = v;
        }
        return r;
      }),
    },
    feeAdjustment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const a = { id: randomUUID(), ...data } as Adjustment;
        store.adjustments.push(a);
        return a;
      }),
      aggregate: vi.fn(async ({ where }: { where: Record<string, unknown> }) => ({
        _sum: { amount_minor: sumBy(matchWhere(store.adjustments, where) as never, 'amount_minor') },
      })),
    },
    refund: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchWhere(store.refunds, where)[0] ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = store.refunds.find((x) => x.id === where.id);
        if (!r) throw new Error('refund not found');
        return r;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const r = { id: randomUUID(), ...data } as Refund;
        store.refunds.push(r);
        return r;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = store.refunds.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      }),
      // Status-guarded updateMany (SVT-AUDIT-SEC-2026-06).
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = matchWhere(store.refunds, where);
        for (const r of rows) for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'object' && v !== null && 'increment' in (v as object)) continue;
          (r as Record<string, unknown>)[k] = v;
        }
        return { count: rows.length };
      }),
      aggregate: vi.fn(async ({ where }: { where: Record<string, unknown> }) => ({
        _sum: { amount_minor: sumBy(matchWhere(store.refunds, where) as never, 'amount_minor') },
      })),
    },
    studentCredit: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.credits.push(data); return data;
      }),
    },
    auditLog: { create: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM fee_installments') && sql.includes('id = ')) {
        const id = values[0] as string;
        const r = store.installments.find((i) => i.id === id);
        return r ? [{ id: r.id, paid_minor: r.paid_minor, net_minor: r.net_minor, balance_minor: r.balance_minor, gross_minor: r.gross_minor, status: r.status, tenant_id: r.tenant_id }] : [];
      }
      // SVT-WAVE-BILLING-SEC-P1-F4 — createRefund issues a row-locked
      // `SELECT … FROM payments … FOR UPDATE`. The in-memory store stands in
      // for the actual lock (single-threaded JS gives us serial execution).
      if (sql.includes('FROM payments') && sql.includes('id = ')) {
        const id = values[0] as string;
        const p = store.payments.find((x) => x.id === id);
        return p ? [{ id: p.id, status: p.status, gross_minor: p.gross_minor, currency: p.currency }] : [];
      }
      return [];
    }),
    // SVT-WAVE-BILLING-SEC-P1-F4 — createRefund now passes an options object
    // (`{ isolationLevel: 'Serializable' }`) to $transaction; signature accepts
    // either (fn) or (fn, opts).
    $transaction: vi.fn(async (...args: unknown[]) => {
      const fn = args[0] as (tx: unknown) => Promise<unknown>;
      return fn(prisma);
    }),
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

const svc = await import('../src/modules/billing/payment.service.js');
// Handle to the mocked prisma so the concurrency-guard tests can force a
// status-guarded updateMany to match 0 rows (simulating a racing writer that
// flipped the row between the outside-tx read and the in-tx write).
const { prisma: mockDb } = (await import('../src/config/db.js')) as unknown as {
  prisma: { payment: { updateMany: ReturnType<typeof vi.fn> }; refund: { updateMany: ReturnType<typeof vi.fn> } };
};

beforeEach(() => {
  store.installments.length = 0; store.payments.length = 0;
  store.allocations.length = 0; store.refunds.length = 0;
  store.adjustments.length = 0; store.credits.length = 0;
  store.audits.length = 0;
});

const admin = { user: { tid: TENANT, sub: USER, role: 'ADMIN' as const } };
const counsellor = { user: { tid: TENANT, sub: USER, role: 'COUNSELLOR' as const } };

const seedPaidInst = (net: bigint, paid: bigint, status = 'PAID') => {
  const inst = mkInst(1, net, paid, status); store.installments.push(inst); return inst;
};
const seedAlloc = (paymentId: string, instId: string, amt: bigint, t = new Date()) => {
  const a: Allocation = { id: randomUUID(), tenant_id: TENANT, payment_id: paymentId, fee_installment_id: instId, amount_minor: amt, created_at: t };
  store.allocations.push(a); return a;
};

describe('voidPayment', () => {
  it('full void reverses paid_minor to 0 and moves PAID→INVOICED via FSM', async () => {
    const inst = seedPaidInst(100n, 100n, 'PAID');
    const pay = mkPayment(100n); store.payments.push(pay);
    seedAlloc(pay.id, inst.id, 100n);
    await svc.voidPayment(admin as never, pay.id, { reason: 'duplicate entry' } as never);
    expect(inst.paid_minor).toBe(0n);
    expect(inst.balance_minor).toBe(100n);
    expect(inst.status).toBe('INVOICED');
    expect(pay.status).toBe('VOIDED');
    expect(store.allocations).toHaveLength(0);
  });

  it('partial void (other alloc remains) flips PAID→PARTIAL', async () => {
    const inst = seedPaidInst(100n, 100n, 'PAID');
    const pay = mkPayment(40n); store.payments.push(pay);
    seedAlloc(pay.id, inst.id, 40n); // other 60 lives on a different (untouched) payment
    inst.paid_minor = 100n; // total paid from both payments
    await svc.voidPayment(admin as never, pay.id, { reason: 'reversed' } as never);
    expect(inst.paid_minor).toBe(60n);
    expect(inst.status).toBe('PARTIAL');
    expect(pay.status).toBe('VOIDED');
  });
});

describe('createRefund', () => {
  it('rejects with 409 when payment is VOIDED', async () => {
    const pay = mkPayment(100n, 'VOIDED'); store.payments.push(pay);
    await expect(
      svc.createRefund(admin as never, pay.id, { amount_minor: 50n, method: 'CASH', reason_code: 'OTHER', reason_text: 'x' } as never),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects when already-refunded + new > gross (P1-F4: 422)', async () => {
    const pay = mkPayment(100n); store.payments.push(pay);
    store.refunds.push({ id: randomUUID(), tenant_id: TENANT, payment_id: pay.id, amount_minor: 70n, status: 'COMPLETED' });
    await expect(
      svc.createRefund(admin as never, pay.id, { amount_minor: 40n, method: 'CASH', reason_code: 'OTHER', reason_text: 'x' } as never),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('completeRefund', () => {
  it('LIFO: reverses newest allocation first; partial unwind → PARTIAL, payment PARTIALLY_REFUNDED', async () => {
    const i1 = seedPaidInst(100n, 100n, 'PAID');
    const i2 = seedPaidInst(100n, 100n, 'PAID'); i2.sequence_no = 2;
    const pay = mkPayment(200n); store.payments.push(pay);
    seedAlloc(pay.id, i1.id, 100n, new Date(2026, 0, 1));
    seedAlloc(pay.id, i2.id, 100n, new Date(2026, 0, 2)); // newest
    const refund: Refund = { id: randomUUID(), tenant_id: TENANT, payment_id: pay.id, amount_minor: 60n, status: 'PENDING' };
    store.refunds.push(refund);
    await svc.completeRefund(admin as never, refund.id, { refunded_on: '2026-05-19' } as never);
    expect(i2.paid_minor).toBe(40n);
    expect(i2.status).toBe('PARTIAL'); // newPaid < net_minor → PARTIAL via FSM PAID→PARTIAL
    expect(i1.paid_minor).toBe(100n);  // untouched (LIFO consumed only newest)
    expect(pay.status).toBe('PARTIALLY_REFUNDED');
  });

  it('full unwind drops newPaid to 0 → REFUNDED; payment fully REFUNDED', async () => {
    const i1 = seedPaidInst(100n, 100n, 'PAID');
    const pay = mkPayment(100n); store.payments.push(pay);
    seedAlloc(pay.id, i1.id, 100n);
    const refund: Refund = { id: randomUUID(), tenant_id: TENANT, payment_id: pay.id, amount_minor: 100n, status: 'PENDING' };
    store.refunds.push(refund);
    await svc.completeRefund(admin as never, refund.id, { refunded_on: '2026-05-19' } as never);
    expect(i1.paid_minor).toBe(0n);
    expect(i1.status).toBe('REFUNDED');
    expect(pay.status).toBe('REFUNDED');
  });

  it('surplus without credit_carryforward=true throws Conflict', async () => {
    const i1 = seedPaidInst(100n, 50n, 'PARTIAL');
    const pay = mkPayment(100n); store.payments.push(pay);
    seedAlloc(pay.id, i1.id, 50n);
    const refund: Refund = { id: randomUUID(), tenant_id: TENANT, payment_id: pay.id, amount_minor: 80n, status: 'PENDING' };
    store.refunds.push(refund);
    await expect(
      svc.completeRefund(admin as never, refund.id, { refunded_on: '2026-05-19' } as never),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('surplus with credit_carryforward=true mints StudentCredit', async () => {
    const i1 = seedPaidInst(100n, 50n, 'PARTIAL');
    const pay = mkPayment(100n); store.payments.push(pay);
    seedAlloc(pay.id, i1.id, 50n);
    const refund: Refund = { id: randomUUID(), tenant_id: TENANT, payment_id: pay.id, amount_minor: 80n, status: 'PENDING' };
    store.refunds.push(refund);
    await svc.completeRefund(admin as never, refund.id, { refunded_on: '2026-05-19', credit_carryforward: true } as never);
    expect(store.credits).toHaveLength(1);
    expect(store.credits[0]).toMatchObject({ amount_minor: 30n, source: 'refund_carryforward' });
  });
});

describe('markRefundFailed', () => {
  it('ADMIN moves PENDING → FAILED', async () => {
    const refund: Refund = { id: randomUUID(), tenant_id: TENANT, payment_id: randomUUID(), amount_minor: 50n, status: 'PENDING' };
    store.refunds.push(refund);
    await svc.markRefundFailed(admin as never, refund.id, { reason: 'bank rejected', provider_error: 'E_FRAUD' });
    expect(refund.status).toBe('FAILED');
  });

  it('non-ADMIN is forbidden (403)', async () => {
    const refund: Refund = { id: randomUUID(), tenant_id: TENANT, payment_id: randomUUID(), amount_minor: 50n, status: 'PENDING' };
    store.refunds.push(refund);
    await expect(
      svc.markRefundFailed(counsellor as never, refund.id, { reason: 'no' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('applyAdjustment', () => {
  // SVT-WAVE-BILLING-SEC-P0-F3 — sign-violation surfaces as 422
  // UnprocessableEntity (the body shape is well-formed; the per-kind sign
  // rule is the business invariant that's violated). Pre-hardening these
  // returned 400 BadRequest.
  it('LATE_FEE requires positive amount; negative rejected (422)', async () => {
    const inst = seedPaidInst(100n, 0n, 'DUE');
    await expect(
      svc.applyAdjustment(admin as never, inst.id, {
        kind: 'LATE_FEE', amount_minor: -25n, reason_text: 'x', applied_on: '2026-05-19',
      } as never),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('DISCOUNT requires negative amount; positive rejected (422)', async () => {
    const inst = seedPaidInst(100n, 0n, 'DUE');
    await expect(
      svc.applyAdjustment(admin as never, inst.id, {
        kind: 'DISCOUNT', amount_minor: 25n, reason_text: 'x', applied_on: '2026-05-19',
      } as never),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('WAIVER by non-ADMIN is forbidden (403)', async () => {
    const inst = seedPaidInst(100n, 0n, 'DUE');
    await expect(
      svc.applyAdjustment(counsellor as never, inst.id, {
        kind: 'WAIVER', amount_minor: -100n, reason_text: 'hardship', applied_on: '2026-05-19',
      } as never),
    ).rejects.toMatchObject({ status: 403 });
  });
});

// SVT-AUDIT-SEC-2026-06 (backlog rank 6) — in-tx status-guard concurrency
// coverage. The outside-tx status check can be passed by two racing writers;
// the in-tx status-guarded updateMany is the hard backstop. We simulate the
// loser (a concurrent writer flipped the row first) by forcing the guarded
// updateMany to match 0 rows, and assert the operation aborts with 409 so its
// balance reversal rolls back rather than double-applying.
describe('in-tx status guards reject the concurrent loser (409)', () => {
  it('completeRefund: guarded refund flip matching 0 rows → 409', async () => {
    const i1 = seedPaidInst(100n, 100n, 'PAID');
    const pay = mkPayment(100n); store.payments.push(pay);
    seedAlloc(pay.id, i1.id, 100n);
    const refund: Refund = { id: randomUUID(), tenant_id: TENANT, payment_id: pay.id, amount_minor: 100n, status: 'PENDING' };
    store.refunds.push(refund);
    mockDb.refund.updateMany.mockResolvedValueOnce({ count: 0 }); // racing writer won
    await expect(
      svc.completeRefund(admin as never, refund.id, { refunded_on: '2026-05-19' } as never),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('voidPayment: guarded payment flip matching 0 rows → 409', async () => {
    const inst = seedPaidInst(100n, 100n, 'PAID');
    const pay = mkPayment(100n); store.payments.push(pay);
    seedAlloc(pay.id, inst.id, 100n);
    mockDb.payment.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      svc.voidPayment(admin as never, pay.id, { reason: 'dup' } as never),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('markRefundFailed: guarded refund flip matching 0 rows → 409', async () => {
    const refund: Refund = { id: randomUUID(), tenant_id: TENANT, payment_id: randomUUID(), amount_minor: 50n, status: 'PENDING' };
    store.refunds.push(refund);
    mockDb.refund.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      svc.markRefundFailed(admin as never, refund.id, { reason: 'bank rejected' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
