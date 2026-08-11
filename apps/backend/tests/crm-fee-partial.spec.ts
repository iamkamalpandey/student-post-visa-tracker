// SVT-FIN-2026-08 — a short payment on a CRM lead fee must stay owed.
//
// markFeePaid() bounded the settlement from ABOVE (paying more than billed is a
// 422) but wrote `status: 'PAID'` unconditionally. A lead billed 10,000 who
// paid 2,500 was recorded PAID with paid_amount_minor = 2,500. The 7,500
// shortfall then left OPEN_FEE_STATUSES, dropped out of the receivables
// rollup, had its chase reminders dismissed, and was never invoiced again.
// Nothing errored. The money was simply forgiven.
//
// These pin the whole chain: status, settlement date, reminder dismissal,
// audit trail, and the guard against a "payment" that lowers what was already
// recorded.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const audits: Array<{ action: string; after?: Record<string, unknown> }> = [];
vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (e: { action: string; after?: Record<string, unknown> }) => {
    audits.push(e);
  }),
}));

type Fee = {
  id: string;
  lead_id: string;
  tenant_id: string;
  amount_minor: bigint;
  paid_amount_minor: bigint | null;
  paid_at: Date | null;
  status: string;
  version: number;
  currency: string;
  session_label: string;
  due_on: Date;
  notes: string | null;
  deleted_at: Date | null;
};

const BILLED = 10_000n;

let fee: Fee;
let lastUpdateData: Record<string, unknown> | null;
let dismissed: string[];

function makeFee(over: Partial<Fee> = {}): Fee {
  return {
    id: 'fee-1',
    lead_id: 'lead-1',
    tenant_id: 'tenant-1',
    amount_minor: BILLED,
    paid_amount_minor: null,
    paid_at: null,
    status: 'DUE',
    version: 1,
    currency: 'NPR',
    session_label: 'Fall 2026',
    due_on: new Date('2026-09-01'),
    notes: null,
    deleted_at: null,
    ...over,
  };
}

const db = {
  crmLeadFee: {
    findFirst: vi.fn(async () => fee),
    updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      lastUpdateData = data;
      // Reflect the write so the post-update re-read returns the new state.
      fee = {
        ...fee,
        status: data.status as string,
        paid_at: (data.paid_at as Date | null) ?? null,
        paid_amount_minor: data.paid_amount_minor as bigint,
        version: fee.version + 1,
      };
      return { count: 1 };
    }),
  },
  // dismissRemindersForEntity's target — recording the call is the assertion.
  reminder: {
    updateMany: vi.fn(async () => {
      dismissed.push('crm_lead_fee');
      return { count: 0 };
    }),
  },
} as unknown as Parameters<typeof markFeePaid>[0]['db'];

const { markFeePaid } = await import('../src/modules/crm-leads/crm-leads.service.js');

const ctx = () => ({ db, tenantId: 'tenant-1', actorId: 'user-1' }) as Parameters<
  typeof markFeePaid
>[0];

beforeEach(() => {
  fee = makeFee();
  lastUpdateData = null;
  dismissed = [];
  audits.length = 0;
  vi.clearAllMocks();
});

describe('markFeePaid — a short payment stays owed', () => {
  it('books PARTIAL, not PAID, when less than the billed amount is settled', async () => {
    await markFeePaid(ctx(), 'lead-1', 'fee-1', {
      paid_on: '2026-09-05',
      paid_amount_minor: 2_500n,
    } as never);

    expect(lastUpdateData?.status).toBe('PARTIAL');
    expect(lastUpdateData?.paid_amount_minor).toBe(2_500n);
  });

  it('leaves paid_at null on a partial — the fee is not settled yet', async () => {
    await markFeePaid(ctx(), 'lead-1', 'fee-1', {
      paid_on: '2026-09-05',
      paid_amount_minor: 2_500n,
    } as never);
    expect(lastUpdateData?.paid_at).toBeNull();
  });

  it('does NOT dismiss the chase reminders on a partial', async () => {
    await markFeePaid(ctx(), 'lead-1', 'fee-1', {
      paid_on: '2026-09-05',
      paid_amount_minor: 2_500n,
    } as never);
    expect(dismissed).toEqual([]);
  });

  it('records the balance still owed in the audit trail', async () => {
    await markFeePaid(ctx(), 'lead-1', 'fee-1', {
      paid_on: '2026-09-05',
      paid_amount_minor: 2_500n,
    } as never);
    const entry = audits.find((a) => a.action === 'crm_lead.fee.part_paid');
    expect(entry).toBeTruthy();
    expect(entry?.after?.balance_minor).toBe('7500');
    expect(entry?.after?.settled_minor).toBe('2500');
  });
});

describe('markFeePaid — full settlement still behaves as before', () => {
  it('books PAID with a settlement date when the full amount is paid', async () => {
    await markFeePaid(ctx(), 'lead-1', 'fee-1', {
      paid_on: '2026-09-05',
      paid_amount_minor: BILLED,
    } as never);
    expect(lastUpdateData?.status).toBe('PAID');
    expect(lastUpdateData?.paid_at).toBeInstanceOf(Date);
    expect(dismissed).toEqual(['crm_lead_fee']);
    expect(audits.some((a) => a.action === 'crm_lead.fee.paid')).toBe(true);
  });

  it('an omitted amount still means "settled in full"', async () => {
    await markFeePaid(ctx(), 'lead-1', 'fee-1', { paid_on: '2026-09-05' } as never);
    expect(lastUpdateData?.status).toBe('PAID');
    expect(lastUpdateData?.paid_amount_minor).toBe(BILLED);
  });
});

describe('markFeePaid — topping up a PARTIAL fee', () => {
  it('a cumulative top-up that clears the balance closes the fee', async () => {
    fee = makeFee({ status: 'PARTIAL', paid_amount_minor: 2_500n, version: 2 });
    await markFeePaid(ctx(), 'lead-1', 'fee-1', {
      paid_on: '2026-10-01',
      paid_amount_minor: BILLED,
    } as never);
    expect(lastUpdateData?.status).toBe('PAID');
    expect(dismissed).toEqual(['crm_lead_fee']);
  });

  it('a top-up that still falls short stays PARTIAL', async () => {
    fee = makeFee({ status: 'PARTIAL', paid_amount_minor: 2_500n, version: 2 });
    await markFeePaid(ctx(), 'lead-1', 'fee-1', {
      paid_on: '2026-10-01',
      paid_amount_minor: 6_000n,
    } as never);
    expect(lastUpdateData?.status).toBe('PARTIAL');
    expect(lastUpdateData?.paid_amount_minor).toBe(6_000n);
  });

  it('rejects a figure below what is already recorded (that would be a refund)', async () => {
    fee = makeFee({ status: 'PARTIAL', paid_amount_minor: 6_000n, version: 2 });
    await expect(
      markFeePaid(ctx(), 'lead-1', 'fee-1', {
        paid_on: '2026-10-01',
        paid_amount_minor: 1_000n,
      } as never),
    ).rejects.toThrow(/cumulative/i);
  });
});

describe('markFeePaid — existing guards survive', () => {
  it('still refuses a settlement larger than the billed amount', async () => {
    await expect(
      markFeePaid(ctx(), 'lead-1', 'fee-1', {
        paid_on: '2026-09-05',
        paid_amount_minor: BILLED + 1n,
      } as never),
    ).rejects.toThrow(/exceeds the billed amount/i);
  });

  it('still refuses to re-settle a terminal fee', async () => {
    fee = makeFee({ status: 'PAID', paid_amount_minor: BILLED });
    await expect(
      markFeePaid(ctx(), 'lead-1', 'fee-1', { paid_on: '2026-09-05' } as never),
    ).rejects.toThrow(/terminal state/i);
  });
});
