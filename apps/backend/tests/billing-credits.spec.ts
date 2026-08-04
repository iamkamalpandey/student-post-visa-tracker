// SVT-FIN-2026-08 — student credit ledger.
//
// student_credits shipped WRITE-ONLY: rows were minted on payment overflow and
// refund surplus, and then nothing read them, drew them down, or reversed them.
// consumed_minor was never incremented by any code path. An overpayment became
// an invisible liability — the business could not see it, so it could never be
// returned or applied.
//
// These tests pin the half that was missing, plus the conservation rules that
// make a drawn-down credit safe.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '22222222-2222-7222-8222-222222222222';
const STUDENT = '33333333-3333-7333-8333-333333333333';
const CREDIT = '44444444-4444-7444-8444-444444444444';

type Installment = {
  id: string; balance_minor: bigint; net_minor: bigint; paid_minor: bigint;
  currency: string; status: string; sequence_no: number;
};

const store: {
  credit: {
    id: string; student_id: string; enrollment_id: string | null;
    amount_minor: bigint; consumed_minor: bigint; currency: string;
    expires_on: Date | null; reversed_at: Date | null;
    reversed_reason?: string | null; source?: string; source_ref_id?: string | null;
    notes?: string | null; created_at?: Date;
  };
  installments: Installment[];
  applications: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
} = {
  credit: {
    id: CREDIT, student_id: STUDENT, enrollment_id: null,
    amount_minor: 50_000n, consumed_minor: 0n, currency: 'GBP',
    expires_on: null, reversed_at: null, reversed_reason: null,
    source: 'overpayment', source_ref_id: null, notes: null,
    created_at: new Date('2026-08-01T00:00:00Z'),
  },
  installments: [],
  applications: [],
  audits: [],
};

vi.mock('../src/config/db.js', () => {
  const prisma = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM student_credits')) {
        return store.credit.id === CREDIT ? [{ ...store.credit }] : [];
      }
      if (sql.includes('FROM fee_installments')) {
        // Explicit-application mode binds the id list as the first parameter.
        const ids = sql.includes('i.id = ANY') ? (values[0] as string[]) : null;
        return store.installments
          .filter((i) => (ids ? ids.includes(i.id) : true))
          .filter((i) => ['SCHEDULED', 'INVOICED', 'DUE', 'OVERDUE', 'PARTIAL'].includes(i.status))
          .filter((i) => (sql.includes('i.currency =') ? i.currency === store.credit.currency : true))
          .filter((i) => (sql.includes('i.balance_minor > 0') ? i.balance_minor > 0n : true))
          .sort((a, b) => a.sequence_no - b.sequence_no)
          .map((i) => ({ ...i }));
      }
      return [];
    }),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    studentCreditApplication: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        store.applications.push(args.data);
        return args.data;
      }),
    },
    studentCredit: {
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const w = args.where;
        if (w['consumed_minor'] !== undefined && w['consumed_minor'] !== store.credit.consumed_minor) {
          return { count: 0 };
        }
        if (w['reversed_at'] === null && store.credit.reversed_at !== null) return { count: 0 };
        Object.assign(store.credit, args.data);
        return { count: 1 };
      }),
      findMany: vi.fn(async () => [{ ...store.credit }]),
      findFirst: vi.fn(async () => ({ ...store.credit })),
    },
    feeInstallment: {
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const i = store.installments.find((x) => x.id === args.where.id)!;
        Object.assign(i, args.data);
        return i;
      }),
    },
    auditLog: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        store.audits.push(args.data);
        return args.data;
      }),
      findFirst: vi.fn(async () => null),
    },
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (_ctx: unknown, entry: Record<string, unknown>) => {
    store.audits.push(entry);
  }),
}));

const { applyCredit, reverseCredit, reverseCreditsForSource, listCredits } =
  await import('../src/modules/billing/credit.service.js');

const ctx = { user: { tid: TENANT, sub: ACTOR, role: 'ADMIN' as const } };

function resetStore(over?: Partial<typeof store.credit>) {
  store.credit = {
    id: CREDIT, student_id: STUDENT, enrollment_id: null,
    amount_minor: 50_000n, consumed_minor: 0n, currency: 'GBP',
    expires_on: null, reversed_at: null, reversed_reason: null,
    source: 'overpayment', source_ref_id: null, notes: null,
    created_at: new Date('2026-08-01T00:00:00Z'), ...over,
  };
  store.installments = [
    { id: 'i1', balance_minor: 30_000n, net_minor: 30_000n, paid_minor: 0n, currency: 'GBP', status: 'DUE', sequence_no: 1 },
    { id: 'i2', balance_minor: 30_000n, net_minor: 30_000n, paid_minor: 0n, currency: 'GBP', status: 'INVOICED', sequence_no: 2 },
  ];
  store.applications = [];
  store.audits = [];
}

beforeEach(() => resetStore());

describe('applyCredit — the draw-down that never existed', () => {
  it('applies FIFO across open installments and increments consumed_minor', () => {
    return applyCredit(ctx, CREDIT, { reason_text: 'apply overpayment' }).then((out) => {
      // 50,000 credit over a 30,000 then a 30,000 installment.
      expect(out.spent).toBe(50_000n);
      expect(store.credit.consumed_minor).toBe(50_000n);
      expect(store.installments[0]!.balance_minor).toBe(0n);
      expect(store.installments[0]!.status).toBe('PAID');
      expect(store.installments[1]!.balance_minor).toBe(10_000n);
      expect(store.installments[1]!.status).toBe('PARTIAL');
    });
  });

  it('keeps sum(applications) == consumed_minor', async () => {
    await applyCredit(ctx, CREDIT, { reason_text: 'apply' });
    const sum = store.applications.reduce((s, a) => s + (a['amount_minor'] as bigint), 0n);
    expect(sum).toBe(store.credit.consumed_minor);
  });

  it('never draws more than the credit holds', async () => {
    store.installments[0]!.balance_minor = 999_999n;
    store.installments[0]!.net_minor = 999_999n;
    const out = await applyCredit(ctx, CREDIT, { reason_text: 'apply' });
    expect(out.spent).toBe(50_000n);
    expect(store.credit.consumed_minor).toBeLessThanOrEqual(store.credit.amount_minor);
  });

  it('honours max_amount_minor as a ceiling on a FIFO draw', async () => {
    const out = await applyCredit(ctx, CREDIT, { reason_text: 'partial', max_amount_minor: 5_000n });
    expect(out.spent).toBe(5_000n);
    expect(store.installments[0]!.balance_minor).toBe(25_000n);
  });

  it('rejects explicit applications that exceed the remaining credit', async () => {
    await expect(
      applyCredit(ctx, CREDIT, {
        reason_text: 'too much',
        applications: [
          { fee_installment_id: 'i1', amount_minor: 30_000n },
          { fee_installment_id: 'i2', amount_minor: 30_000n },
        ],
      }),
    ).rejects.toThrow(/only 50000 remains/i);
    expect(store.credit.consumed_minor).toBe(0n);
  });

  it('rejects an application larger than the installment balance', async () => {
    await expect(
      applyCredit(ctx, CREDIT, {
        reason_text: 'overpay one row',
        applications: [{ fee_installment_id: 'i1', amount_minor: 40_000n }],
      }),
    ).rejects.toThrow(/exceeds installment balance/i);
  });

  it('rejects duplicate installment ids instead of double-applying', async () => {
    await expect(
      applyCredit(ctx, CREDIT, {
        reason_text: 'dupe',
        applications: [
          { fee_installment_id: 'i1', amount_minor: 1_000n },
          { fee_installment_id: 'i1', amount_minor: 1_000n },
        ],
      }),
    ).rejects.toThrow(/duplicate/i);
  });

  it('REFUSES to cross currencies — no implicit FX, ever', async () => {
    store.installments = [
      { id: 'usd', balance_minor: 30_000n, net_minor: 30_000n, paid_minor: 0n, currency: 'USD', status: 'DUE', sequence_no: 1 },
    ];
    await expect(
      applyCredit(ctx, CREDIT, {
        reason_text: 'cross currency',
        applications: [{ fee_installment_id: 'usd', amount_minor: 1_000n }],
      }),
    ).rejects.toThrow(/currency mismatch/i);
    expect(store.credit.consumed_minor).toBe(0n);
  });

  it('refuses a fully consumed credit', async () => {
    resetStore({ consumed_minor: 50_000n });
    await expect(applyCredit(ctx, CREDIT, { reason_text: 'again' })).rejects.toThrow(/fully consumed/i);
  });

  it('refuses a reversed credit', async () => {
    resetStore({ reversed_at: new Date('2026-01-01') });
    await expect(applyCredit(ctx, CREDIT, { reason_text: 'zombie' })).rejects.toThrow(/reversed/i);
  });

  it('refuses an expired credit', async () => {
    resetStore({ expires_on: new Date('2020-01-01') });
    await expect(applyCredit(ctx, CREDIT, { reason_text: 'stale' })).rejects.toThrow(/expired/i);
  });

  it('rolls back when the credit was drawn down concurrently', async () => {
    // Simulate: our guarded updateMany matches 0 rows because consumed_minor moved.
    const { prisma } = (await import('../src/config/db.js')) as unknown as {
      prisma: { studentCredit: { updateMany: ReturnType<typeof vi.fn> } };
    };
    prisma.studentCredit.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(applyCredit(ctx, CREDIT, { reason_text: 'race' })).rejects.toThrow(/concurrently/i);
  });

  it('writes an audit row naming the amount applied', async () => {
    await applyCredit(ctx, CREDIT, { reason_text: 'apply' });
    const entry = store.audits.find((a) => a['action'] === 'credit.applied');
    expect(entry).toBeDefined();
    expect((entry!['after'] as Record<string, unknown>)['applied_minor']).toBe('50000');
  });
});

describe('reverseCredit — retire without deleting', () => {
  it('marks the credit reversed with a mandatory reason', async () => {
    await reverseCredit(ctx, CREDIT, { reason_text: 'created in error' });
    expect(store.credit.reversed_at).not.toBeNull();
    expect(store.credit.reversed_reason).toBe('created in error');
  });

  it('REFUSES to reverse a credit that has already been spent', async () => {
    resetStore({ consumed_minor: 10_000n });
    await expect(
      reverseCredit(ctx, CREDIT, { reason_text: 'oops' }),
    ).rejects.toThrow(/already applied/i);
    expect(store.credit.reversed_at).toBeNull();
  });

  it('refuses a double reversal', async () => {
    resetStore({ reversed_at: new Date('2026-01-01') });
    await expect(reverseCredit(ctx, CREDIT, { reason_text: 'again' })).rejects.toThrow(/already reversed/i);
  });
});

describe('reverseCreditsForSource — voiding a payment takes its credit with it', () => {
  it('reverses an unspent credit minted by the voided payment', async () => {
    const { prisma } = (await import('../src/config/db.js')) as unknown as { prisma: never };
    const reversed = await reverseCreditsForSource(prisma as never, {
      tenantId: TENANT, sourceRefId: CREDIT, actorId: ACTOR, reason: 'Payment voided: duplicate',
    });
    expect(reversed).toHaveLength(1);
    expect(store.credit.reversed_at).not.toBeNull();
  });

  it('BLOCKS the void when the credit has already been spent elsewhere', async () => {
    resetStore({ consumed_minor: 5_000n });
    const { prisma } = (await import('../src/config/db.js')) as unknown as { prisma: never };
    await expect(
      reverseCreditsForSource(prisma as never, {
        tenantId: TENANT, sourceRefId: CREDIT, actorId: ACTOR, reason: 'void',
      }),
    ).rejects.toThrow(/already been applied/i);
  });
});

describe('listCredits — the liability is visible', () => {
  it('reports available = amount - consumed, grouped per currency', async () => {
    resetStore({ consumed_minor: 20_000n });
    const out = await listCredits(ctx, {});
    expect(out.credits[0]!.available_minor).toBe(30_000n);
    expect(out.summary.by_currency).toEqual([
      { currency: 'GBP', available_minor: 30_000n, credit_count: 1 },
    ]);
  });

  it('treats a reversed credit as zero spending power', async () => {
    resetStore({ reversed_at: new Date('2026-01-01') });
    const out = await listCredits(ctx, { include_closed: true });
    expect(out.credits[0]!.available_minor).toBe(0n);
    expect(out.summary.by_currency).toEqual([]);
  });
});
