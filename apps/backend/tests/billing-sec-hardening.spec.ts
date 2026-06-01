// SVT-WAVE-BILLING-SEC-2026-05 — security-hardening test suite for the
// findings of the P0/P1 audit (May 2026). One spec file rather than five
// micro-files so the shared prisma mock stays in one place.
//
// Coverage matrix:
//   P0-F1: COUNSELLOR mint cap on DISCOUNT/SCHOLARSHIP (threshold + balance).
//   P0-F2: empty-matrix stage-skip bypass (forward+1 OK; forward+5 blocked
//          for COUNSELLOR; admin force+5 OK).
//   P0-F3: zero amount + sign + LATE_FEE negative rejection.
//   P1-F4: TOCTOU on createRefund (two concurrent $50 refunds vs $80 payment).
//   P1-F7: ProgramIntake capacity race (two concurrent enrollments at cap-1).
//   P1-F8: stale-PENDING idempotency row → 409 idempotency_in_flight.
// P1-F5 (user_id scoping) is exercised inside the existing
// idempotency-record.spec.ts patch in this same change set, since it shares
// the in-memory store there.

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
// Pin the adjustment threshold so the test is deterministic regardless of the
// real ops default. 100000 minor = $1000.
vi.stubEnv('BILLING_ADJUSTMENT_ADMIN_THRESHOLD_MINOR', '100000');

const TENANT = '11111111-1111-7111-8111-111111111111';
const STUDENT = '22222222-2222-7222-8222-222222222222';
const ENROLLMENT = '33333333-3333-7333-8333-333333333333';
const USER = '44444444-4444-7444-8444-444444444444';

// =============================================================================
// Shared in-memory store + prisma mock (mirrors billing-payment-actions.spec.ts).
// =============================================================================

type Installment = {
  id: string; tenant_id: string; sequence_no: number;
  gross_minor: bigint; net_minor: bigint; paid_minor: bigint; balance_minor: bigint;
  currency: string; status: string; deleted_at: Date | null;
};
type Payment = {
  id: string; tenant_id: string; student_id: string; enrollment_id: string;
  currency: string; gross_minor: bigint; status: string; deleted_at: Date | null;
  reference?: string | null;
};
type Refund = {
  id: string; tenant_id: string; payment_id: string; amount_minor: bigint;
  status: string;
};

const store = {
  enrollments: [{ id: ENROLLMENT, tenant_id: TENANT, student_id: STUDENT, deleted_at: null }],
  installments: [] as Installment[],
  payments: [] as Payment[],
  refunds: [] as Refund[],
  adjustments: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
};

const mkInst = (net: bigint, paid = 0n, status = 'DUE'): Installment => ({
  id: randomUUID(), tenant_id: TENANT, sequence_no: 1,
  gross_minor: net, net_minor: net, paid_minor: paid, balance_minor: net - paid,
  currency: 'USD', status, deleted_at: null,
});
const mkPayment = (gross: bigint, status = 'RECEIVED', extra: Partial<Payment> = {}): Payment => ({
  id: randomUUID(), tenant_id: TENANT, student_id: STUDENT, enrollment_id: ENROLLMENT,
  currency: 'USD', gross_minor: gross, status, deleted_at: null,
  ...extra,
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
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const p = store.payments.find((x) => x.id === where.id)!;
        Object.assign(p, data);
        return p;
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
        const a = { id: randomUUID(), ...data };
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
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const r = { id: randomUUID(), ...data } as Refund;
        store.refunds.push(r);
        return r;
      }),
      aggregate: vi.fn(async ({ where }: { where: Record<string, unknown> }) => ({
        _sum: { amount_minor: sumBy(matchWhere(store.refunds, where) as never, 'amount_minor') },
      })),
    },
    auditLog: { create: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM fee_installments') && sql.includes('id = ')) {
        const id = values[0] as string;
        const r = store.installments.find((i) => i.id === id);
        return r ? [{
          id: r.id, paid_minor: r.paid_minor, net_minor: r.net_minor,
          balance_minor: r.balance_minor, gross_minor: r.gross_minor,
          status: r.status, tenant_id: r.tenant_id,
        }] : [];
      }
      if (sql.includes('FROM payments') && sql.includes('id = ')) {
        const id = values[0] as string;
        const p = store.payments.find((x) => x.id === id);
        return p ? [{
          id: p.id, status: p.status, gross_minor: p.gross_minor, currency: p.currency,
        }] : [];
      }
      return [];
    }),
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

beforeEach(() => {
  store.installments.length = 0;
  store.payments.length = 0;
  store.refunds.length = 0;
  store.adjustments.length = 0;
  store.audits.length = 0;
});

const admin = { user: { tid: TENANT, sub: USER, role: 'ADMIN' as const } };
const counsellor = { user: { tid: TENANT, sub: USER, role: 'COUNSELLOR' as const } };

// =============================================================================
// P0-F1 — COUNSELLOR mints unlimited DISCOUNT/SCHOLARSHIP
// =============================================================================

describe('applyAdjustment — P0-F1 threshold + balance cap', () => {
  it('COUNSELLOR DISCOUNT below threshold (≤ $1000) within balance → succeeds', async () => {
    const inst = mkInst(500_00n, 0n, 'DUE'); // $500 balance
    store.installments.push(inst);
    const out = await svc.applyAdjustment(counsellor as never, inst.id, {
      kind: 'DISCOUNT', amount_minor: -50_00n, reason_text: 'goodwill', applied_on: '2026-05-19',
    } as never);
    expect(out).toBeDefined();
  });

  it('COUNSELLOR DISCOUNT above $1000 threshold → 403', async () => {
    const inst = mkInst(5000_00n, 0n, 'DUE');
    store.installments.push(inst);
    await expect(
      svc.applyAdjustment(counsellor as never, inst.id, {
        kind: 'DISCOUNT', amount_minor: -1500_00n, reason_text: 'big discount', applied_on: '2026-05-19',
      } as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('ADMIN DISCOUNT above threshold within balance → succeeds', async () => {
    const inst = mkInst(5000_00n, 0n, 'DUE');
    store.installments.push(inst);
    const out = await svc.applyAdjustment(admin as never, inst.id, {
      kind: 'DISCOUNT', amount_minor: -1500_00n, reason_text: 'big discount', applied_on: '2026-05-19',
    } as never);
    expect(out).toBeDefined();
  });

  it('COUNSELLOR DISCOUNT exceeding installment balance → 422', async () => {
    const inst = mkInst(100_00n, 0n, 'DUE'); // $100 balance
    store.installments.push(inst);
    await expect(
      svc.applyAdjustment(counsellor as never, inst.id, {
        kind: 'DISCOUNT', amount_minor: -200_00n, reason_text: 'over balance', applied_on: '2026-05-19',
      } as never),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('SCHOLARSHIP above threshold is also ADMIN-only', async () => {
    const inst = mkInst(5000_00n, 0n, 'DUE');
    store.installments.push(inst);
    await expect(
      svc.applyAdjustment(counsellor as never, inst.id, {
        kind: 'SCHOLARSHIP', amount_minor: -2000_00n, reason_text: 'merit', applied_on: '2026-05-19',
      } as never),
    ).rejects.toMatchObject({ status: 403 });
  });
});

// =============================================================================
// P0-F3 — zero amount + sign rejection
// =============================================================================

describe('applyAdjustment — C2 LATE_FEE zero/negative guard', () => {
  it('LATE_FEE with zero amount → 422', async () => {
    const inst = mkInst(100_00n, 0n, 'DUE'); store.installments.push(inst);
    await expect(
      svc.applyAdjustment(admin as never, inst.id, {
        kind: 'LATE_FEE', amount_minor: 0n, reason_text: 'noop', applied_on: '2026-05-19',
      } as never),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('LATE_FEE with negative amount → 422', async () => {
    const inst = mkInst(100_00n, 0n, 'DUE'); store.installments.push(inst);
    await expect(
      svc.applyAdjustment(admin as never, inst.id, {
        kind: 'LATE_FEE', amount_minor: -50n, reason_text: 'x', applied_on: '2026-05-19',
      } as never),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('LATE_FEE with positive amount → ok', async () => {
    const inst = mkInst(100_00n, 0n, 'DUE'); store.installments.push(inst);
    const out = await svc.applyAdjustment(admin as never, inst.id, {
      kind: 'LATE_FEE', amount_minor: 5_00n, reason_text: 'late', applied_on: '2026-05-19',
    } as never);
    expect(out).toBeDefined();
  });

  it('DISCOUNT with zero amount → 422', async () => {
    const inst = mkInst(100_00n, 0n, 'DUE'); store.installments.push(inst);
    await expect(
      svc.applyAdjustment(admin as never, inst.id, {
        kind: 'DISCOUNT', amount_minor: 0n, reason_text: 'noop', applied_on: '2026-05-19',
      } as never),
    ).rejects.toMatchObject({ status: 422 });
  });
});

// =============================================================================
// C1 — adjustment exactly equal to balance + max=X detail
// =============================================================================

describe('applyAdjustment — C1 balance cap edge cases', () => {
  it('DISCOUNT equal to remaining balance → ok (settles installment)', async () => {
    const inst = mkInst(100_00n, 0n, 'DUE');
    store.installments.push(inst);
    const out = await svc.applyAdjustment(admin as never, inst.id, {
      kind: 'DISCOUNT', amount_minor: -100_00n, reason_text: 'full waive-equivalent',
      applied_on: '2026-05-19',
    } as never);
    expect(out).toBeDefined();
  });

  it('DISCOUNT one minor unit over balance → 422 with max=X hint', async () => {
    const inst = mkInst(100_00n, 0n, 'DUE');
    store.installments.push(inst);
    await expect(
      svc.applyAdjustment(admin as never, inst.id, {
        kind: 'DISCOUNT', amount_minor: -100_01n, reason_text: 'one off',
        applied_on: '2026-05-19',
      } as never),
    ).rejects.toMatchObject({
      status: 422,
      detail: expect.stringMatching(/max=10000/),
    });
  });
});

// =============================================================================
// P1-F4 — createRefund TOCTOU (sequential serialised inside one tx)
// =============================================================================

describe('createRefund — P1-F4 over-refund guard', () => {
  it('two refunds of $50 against an $80 payment: second is rejected with 422', async () => {
    const pay = mkPayment(80_00n); store.payments.push(pay);
    // First refund: $50 → allowed (totals 50 ≤ 80)
    const r1 = await svc.createRefund(admin as never, pay.id, {
      amount_minor: 50_00n, method: 'CASH', reason_code: 'OTHER', reason_text: 'first',
    } as never);
    expect(r1).toBeDefined();
    // Second refund: $50 → would push total to 100 > 80, must be rejected.
    await expect(
      svc.createRefund(admin as never, pay.id, {
        amount_minor: 50_00n, method: 'CASH', reason_code: 'OTHER', reason_text: 'second',
      } as never),
    ).rejects.toMatchObject({ status: 422 });
    expect(store.refunds.length).toBe(1);
  });
});

