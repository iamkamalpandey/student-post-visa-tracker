// SVT-FIN-2026-08 — the CRM finance rollup must agree with the fee rows.
//
// This pins a regression I introduced myself. Adding PARTIAL to
// OPEN_FEE_STATUSES made a part-paid fee "open" — correct — but financeSummary
// still summed `amount_minor` for the open set and counted `paid_amount_minor`
// only for status PAID. So a fee of 100,000 settled for 40,000 reported
// outstanding 100,000 (should be 60,000) and collected 0 (should be 40,000):
// the same 40,000 simultaneously overstated as receivable and invisible as
// revenue, an 80,000 swing on one row — in exactly the money PARTIAL was
// introduced to stop losing.
//
// The aggregation runs in the database, so these tests drive the real function
// against a groupBy stub that behaves like Prisma: `_sum` over the rows each
// `where` selects.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

type Fee = {
  currency: string;
  status: string;
  amount_minor: bigint;
  paid_amount_minor: bigint | null;
};

let fees: Fee[];

/** Minimal Prisma groupBy: filter by `where.status`, then _sum the asked fields. */
function groupBy({
  where,
  _sum,
}: {
  where: { status?: string | { in: string[] } };
  _sum: Record<string, boolean>;
}) {
  const wanted = where.status;
  const match = (f: Fee) =>
    wanted === undefined
      ? true
      : typeof wanted === 'string'
        ? f.status === wanted
        : wanted.in.includes(f.status);
  const byCurrency = new Map<string, { amount_minor: bigint; paid_amount_minor: bigint }>();
  for (const f of fees.filter(match)) {
    const acc = byCurrency.get(f.currency) ?? { amount_minor: 0n, paid_amount_minor: 0n };
    acc.amount_minor += f.amount_minor;
    acc.paid_amount_minor += f.paid_amount_minor ?? 0n;
    byCurrency.set(f.currency, acc);
  }
  return [...byCurrency.entries()].map(([currency, sums]) => ({
    currency,
    _sum: Object.fromEntries(
      Object.keys(_sum).map((k) => [k, sums[k as keyof typeof sums] ?? 0n]),
    ),
  }));
}

const db = {
  crmLeadFee: { groupBy: vi.fn(groupBy) },
  crmPayment: { groupBy: vi.fn(async () => []) },
  crmLead: { count: vi.fn(async () => 3) },
} as unknown as Parameters<typeof financeSummary>[0]['db'];

const { financeSummary } = await import('../src/modules/crm-leads/crm-leads.service.js');

const ctx = () => ({ db, tenantId: 't1' }) as Parameters<typeof financeSummary>[0];
const amountFor = (rows: Array<{ currency: string; amount_minor: string }>, cur: string) =>
  rows.find((r) => r.currency === cur)?.amount_minor ?? '0';

beforeEach(() => {
  fees = [];
  vi.clearAllMocks();
});

describe('financeSummary — a part-paid fee is owed for its BALANCE', () => {
  it('reports the remaining balance as outstanding, not the billed amount', async () => {
    fees = [{ currency: 'NPR', status: 'PARTIAL', amount_minor: 100_000n, paid_amount_minor: 40_000n }];
    const out = await financeSummary(ctx());
    expect(amountFor(out.outstanding, 'NPR')).toBe('60000');
  });

  it('counts the cash received on a PARTIAL fee as collected', async () => {
    fees = [{ currency: 'NPR', status: 'PARTIAL', amount_minor: 100_000n, paid_amount_minor: 40_000n }];
    const out = await financeSummary(ctx());
    expect(amountFor(out.collected, 'NPR')).toBe('40000');
  });

  it('outstanding + collected reconciles to the amount billed', async () => {
    fees = [{ currency: 'NPR', status: 'PARTIAL', amount_minor: 100_000n, paid_amount_minor: 40_000n }];
    const out = await financeSummary(ctx());
    const owed = BigInt(amountFor(out.outstanding, 'NPR'));
    const got = BigInt(amountFor(out.collected, 'NPR'));
    expect(owed + got).toBe(100_000n);
  });
});

describe('financeSummary — the other statuses are unchanged', () => {
  it('an untouched open fee is outstanding in full', async () => {
    fees = [{ currency: 'NPR', status: 'DUE', amount_minor: 50_000n, paid_amount_minor: null }];
    const out = await financeSummary(ctx());
    expect(amountFor(out.outstanding, 'NPR')).toBe('50000');
    expect(amountFor(out.collected, 'NPR')).toBe('0');
  });

  it('a settled fee is collected and no longer outstanding', async () => {
    fees = [{ currency: 'NPR', status: 'PAID', amount_minor: 50_000n, paid_amount_minor: 50_000n }];
    const out = await financeSummary(ctx());
    expect(amountFor(out.outstanding, 'NPR')).toBe('0');
    expect(amountFor(out.collected, 'NPR')).toBe('50000');
  });

  it('a waived fee is neither owed nor collected', async () => {
    fees = [{ currency: 'NPR', status: 'WAIVED', amount_minor: 50_000n, paid_amount_minor: null }];
    const out = await financeSummary(ctx());
    expect(amountFor(out.outstanding, 'NPR')).toBe('0');
    expect(amountFor(out.collected, 'NPR')).toBe('0');
  });
});

describe('financeSummary — currencies never mix', () => {
  it('keeps each currency on its own line', async () => {
    fees = [
      { currency: 'NPR', status: 'PARTIAL', amount_minor: 100_000n, paid_amount_minor: 40_000n },
      { currency: 'AUD', status: 'DUE', amount_minor: 7_000n, paid_amount_minor: null },
    ];
    const out = await financeSummary(ctx());
    expect(amountFor(out.outstanding, 'NPR')).toBe('60000');
    expect(amountFor(out.outstanding, 'AUD')).toBe('7000');
  });
});

describe('financeSummary — anomalies do not produce negative receivables', () => {
  it('an over-settled fee clamps to zero rather than reporting a negative', async () => {
    // Should be impossible (markFeePaid caps at the billed amount) but a
    // negative receivable would silently offset real debt in the same currency.
    fees = [{ currency: 'NPR', status: 'PARTIAL', amount_minor: 10_000n, paid_amount_minor: 12_000n }];
    const out = await financeSummary(ctx());
    expect(amountFor(out.outstanding, 'NPR')).toBe('0');
  });
});
