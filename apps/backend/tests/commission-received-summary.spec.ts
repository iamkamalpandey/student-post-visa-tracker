// SVT-FIN-2026-08 — commission collections must count every PAID claim.
//
// `summary()` intended a row-level COALESCE(received_minor, amount_minor) and
// wrote a group-level one:
//
//     row.paid_total_minor = _sum.received_minor ?? _sum.amount_minor ?? 0n
//
// `received_minor` was added by migration …235993 with NO backfill, so claims
// settled before it are NULL. SQL SUM skips NULLs, which means those rows are
// omitted from `_sum.received_minor` entirely — and the `??` fallback only
// fires when EVERY row in the group is NULL. So a group holding one legacy
// claim plus any modern one silently dropped the legacy amount, understating
// collections by exactly that figure with no error anywhere.
//
// The fix sums the legacy remainder separately and adds it back, which
// reproduces the row-level COALESCE using two grouped sums.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

type Claim = {
  institution_id: string;
  currency: string;
  status: string;
  amount_minor: bigint;
  received_minor: bigint | null;
};

let claims: Claim[];

/**
 * Prisma-faithful groupBy: honours `where` (status + received_minor: null) and
 * skips NULLs when summing, which is the behaviour the bug depended on.
 */
function groupBy(args: {
  by: string[];
  where: { status?: string; received_minor?: null };
  _sum: Record<string, boolean>;
  _count?: unknown;
}) {
  const rows = claims.filter((c) => {
    if (args.where.status !== undefined && c.status !== args.where.status) return false;
    if ('received_minor' in args.where && args.where.received_minor === null) {
      return c.received_minor === null;
    }
    return true;
  });
  const groups = new Map<string, { key: Record<string, string>; items: Claim[] }>();
  for (const c of rows) {
    const key: Record<string, string> = {};
    for (const f of args.by) key[f] = String((c as unknown as Record<string, unknown>)[f]);
    const k = args.by.map((f) => key[f]).join('::');
    const g = groups.get(k) ?? { key, items: [] };
    g.items.push(c);
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => ({
    ...g.key,
    _count: { _all: g.items.length },
    _sum: Object.fromEntries(
      Object.keys(args._sum).map((f) => [
        f,
        // SUM skips NULLs; a group of only NULLs sums to NULL.
        g.items.some((i) => (i as unknown as Record<string, unknown>)[f] !== null)
          ? g.items.reduce(
              (acc, i) => acc + ((i as unknown as Record<string, bigint | null>)[f] ?? 0n),
              0n,
            )
          : null,
      ]),
    ),
  }));
}

const req = {
  user: { tid: 't1', sub: 'u1', role: 'ADMIN' },
  db: { commissionClaim: { groupBy: vi.fn(groupBy) } },
} as unknown as Parameters<typeof summary>[0];

vi.mock('../src/config/db.js', () => ({
  prisma: {},
  prismaAdmin: {},
}));

const { summary } = await import('../src/modules/commissions/service.js');

const paidFor = async (inst: string, cur: string) => {
  const { data } = (await summary(req)) as unknown as {
    data: Array<{
      institution_id: string;
      currency: string;
      paid_total_minor: string;
      paid_claimed_total_minor: string;
    }>;
  };
  return data.find((r) => r.institution_id === inst && r.currency === cur);
};

beforeEach(() => {
  claims = [];
  vi.clearAllMocks();
});

describe('summary() — legacy PAID claims are not dropped', () => {
  it('counts a legacy NULL-received claim alongside modern ones', async () => {
    claims = [
      { institution_id: 'i1', currency: 'USD', status: 'PAID', amount_minor: 100_000n, received_minor: null },
      { institution_id: 'i1', currency: 'USD', status: 'PAID', amount_minor: 60_000n, received_minor: 50_000n },
      { institution_id: 'i1', currency: 'USD', status: 'PAID', amount_minor: 60_000n, received_minor: 50_000n },
    ];
    const row = await paidFor('i1', 'USD');
    // Pre-fix this returned 100,000 — the legacy row vanished entirely.
    expect(row?.paid_total_minor).toBe('200000');
    expect(row?.paid_claimed_total_minor).toBe('220000');
  });

  it('still treats an all-legacy group as settled in full', async () => {
    claims = [
      { institution_id: 'i1', currency: 'USD', status: 'PAID', amount_minor: 70_000n, received_minor: null },
      { institution_id: 'i1', currency: 'USD', status: 'PAID', amount_minor: 30_000n, received_minor: null },
    ];
    const row = await paidFor('i1', 'USD');
    expect(row?.paid_total_minor).toBe('100000');
  });

  it('reports the short-payment variance when nothing is legacy', async () => {
    claims = [
      { institution_id: 'i1', currency: 'GBP', status: 'PAID', amount_minor: 2_000_000n, received_minor: 1_840_000n },
    ];
    const row = await paidFor('i1', 'GBP');
    expect(row?.paid_total_minor).toBe('1840000');
    expect(row?.paid_claimed_total_minor).toBe('2000000');
    const variance = BigInt(row!.paid_claimed_total_minor) - BigInt(row!.paid_total_minor);
    expect(variance).toBe(160_000n);
  });
});

describe('summary() — scoping stays correct', () => {
  it('does not leak a legacy amount across currencies', async () => {
    claims = [
      { institution_id: 'i1', currency: 'USD', status: 'PAID', amount_minor: 100_000n, received_minor: null },
      { institution_id: 'i1', currency: 'GBP', status: 'PAID', amount_minor: 5_000n, received_minor: 5_000n },
    ];
    expect((await paidFor('i1', 'USD'))?.paid_total_minor).toBe('100000');
    expect((await paidFor('i1', 'GBP'))?.paid_total_minor).toBe('5000');
  });

  it('does not leak a legacy amount across institutions', async () => {
    claims = [
      { institution_id: 'i1', currency: 'USD', status: 'PAID', amount_minor: 100_000n, received_minor: null },
      { institution_id: 'i2', currency: 'USD', status: 'PAID', amount_minor: 7_000n, received_minor: 7_000n },
    ];
    expect((await paidFor('i1', 'USD'))?.paid_total_minor).toBe('100000');
    expect((await paidFor('i2', 'USD'))?.paid_total_minor).toBe('7000');
  });

  it('ignores non-PAID claims when totalling collections', async () => {
    claims = [
      { institution_id: 'i1', currency: 'USD', status: 'CLAIMED', amount_minor: 900_000n, received_minor: null },
      { institution_id: 'i1', currency: 'USD', status: 'PAID', amount_minor: 100_000n, received_minor: null },
    ];
    const row = await paidFor('i1', 'USD');
    expect(row?.paid_total_minor).toBe('100000');
  });
});
