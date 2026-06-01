import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import { calculateForEnrollment } from '../src/modules/commissions/calculator.js';

// ============================================================================
// Calculator unit tests. We pass a hand-rolled mock `tx` (only `enrollment.findFirst`
// is consulted) so we can drive every branch deterministically.
// ============================================================================

type MockEnrollmentRow = {
  id: string;
  tuition_total_minor: bigint | null;
  tuition_currency: string | null;
  institution: { id: string; commission_pct: Prisma.Decimal | null } | null;
} | null;

function mockTx(row: MockEnrollmentRow) {
  return {
    enrollment: {
      findFirst: vi.fn(async () => row),
    },
  } as unknown as Parameters<typeof calculateForEnrollment>[0];
}

describe('calculateForEnrollment', () => {
  it('returns null when the enrollment does not exist', async () => {
    const tx = mockTx(null);
    const out = await calculateForEnrollment(tx, '00000000-0000-0000-0000-000000000000');
    expect(out).toBeNull();
  });

  it('returns null when the institution has no commission_pct', async () => {
    const tx = mockTx({
      id: 'e1',
      tuition_total_minor: 1_000_000n,
      tuition_currency: 'GBP',
      institution: { id: 'i1', commission_pct: null },
    });
    const out = await calculateForEnrollment(tx, 'e1');
    expect(out).toBeNull();
  });

  it('returns null when the enrollment has no tuition_total_minor', async () => {
    const tx = mockTx({
      id: 'e2',
      tuition_total_minor: null,
      tuition_currency: 'GBP',
      institution: { id: 'i1', commission_pct: new Prisma.Decimal('12.5') },
    });
    const out = await calculateForEnrollment(tx, 'e2');
    expect(out).toBeNull();
  });

  it('returns null when the enrollment has no tuition_currency', async () => {
    const tx = mockTx({
      id: 'e3',
      tuition_total_minor: 1_000_000n,
      tuition_currency: null,
      institution: { id: 'i1', commission_pct: new Prisma.Decimal('12.5') },
    });
    const out = await calculateForEnrollment(tx, 'e3');
    expect(out).toBeNull();
  });

  it('returns null when the institution relation is missing', async () => {
    const tx = mockTx({
      id: 'e4',
      tuition_total_minor: 1_000_000n,
      tuition_currency: 'GBP',
      institution: null,
    });
    const out = await calculateForEnrollment(tx, 'e4');
    expect(out).toBeNull();
  });

  it('computes the commission amount for a clean 10% case', async () => {
    const tx = mockTx({
      id: 'e5',
      tuition_total_minor: 2_000_000n, // £20,000.00 in pence
      tuition_currency: 'GBP',
      institution: { id: 'i1', commission_pct: new Prisma.Decimal('10') },
    });
    const out = await calculateForEnrollment(tx, 'e5');
    expect(out).not.toBeNull();
    expect(out!.amount_minor).toBe(200_000n); // £2,000.00
    expect(out!.currency).toBe('GBP');
    expect(out!.basis_minor).toBe(2_000_000n);
    expect(out!.commission_pct.toString()).toBe('10');
  });

  it('floors fractional results (truncates toward zero)', async () => {
    // 999 * 12.50 / 100 = 124.875 -> floor = 124
    const tx = mockTx({
      id: 'e6',
      tuition_total_minor: 999n,
      tuition_currency: 'USD',
      institution: { id: 'i1', commission_pct: new Prisma.Decimal('12.50') },
    });
    const out = await calculateForEnrollment(tx, 'e6');
    expect(out).not.toBeNull();
    expect(out!.amount_minor).toBe(124n);
  });

  it('handles a sub-1% commission_pct without losing precision', async () => {
    // 1_000_000 * 0.50 / 100 = 5_000  (no rounding needed)
    const tx = mockTx({
      id: 'e7',
      tuition_total_minor: 1_000_000n,
      tuition_currency: 'EUR',
      institution: { id: 'i1', commission_pct: new Prisma.Decimal('0.50') },
    });
    const out = await calculateForEnrollment(tx, 'e7');
    expect(out).not.toBeNull();
    expect(out!.amount_minor).toBe(5_000n);
    expect(out!.currency).toBe('EUR');
  });

  it('handles a 0% commission_pct (returns 0 amount, not null)', async () => {
    const tx = mockTx({
      id: 'e8',
      tuition_total_minor: 1_000_000n,
      tuition_currency: 'GBP',
      institution: { id: 'i1', commission_pct: new Prisma.Decimal('0') },
    });
    const out = await calculateForEnrollment(tx, 'e8');
    expect(out).not.toBeNull();
    expect(out!.amount_minor).toBe(0n);
  });

  it('handles a 100% commission_pct correctly (rare but supported)', async () => {
    const tx = mockTx({
      id: 'e9',
      tuition_total_minor: 12_345n,
      tuition_currency: 'AUD',
      institution: { id: 'i1', commission_pct: new Prisma.Decimal('100') },
    });
    const out = await calculateForEnrollment(tx, 'e9');
    expect(out).not.toBeNull();
    expect(out!.amount_minor).toBe(12_345n);
  });
});
