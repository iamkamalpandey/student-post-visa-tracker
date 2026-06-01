// SVT-WAVE-BILLING-2026-05 — pricing.ts unit tests.

import { describe, it, expect } from 'vitest';
import {
  generateInstallmentLines,
  recomputeInstallmentAmounts,
  allocateFifo,
  derivePlanStatusFromInstallments,
  shiftIsoDate,
} from '../src/modules/billing/pricing.js';

describe('generateInstallmentLines', () => {
  it('MONTHLY 12 × 1000 cents = 12 lines summing 12000', () => {
    const lines = generateInstallmentLines({
      cadence: 'MONTHLY',
      total_minor: 12000n,
      installment_count: 12,
      starts_on: '2026-09-01',
    });
    expect(lines).toHaveLength(12);
    expect(lines.reduce((s, l) => s + l.gross_minor, 0n)).toBe(12000n);
    expect(lines[0]!.due_on).toBe('2026-09-01');
    expect(lines[11]!.due_on).toBe('2027-08-01');
  });

  it('QUARTERLY 4 × 5000 = 4 lines, 3-month stride', () => {
    const lines = generateInstallmentLines({
      cadence: 'QUARTERLY',
      total_minor: 20000n,
      installment_count: 4,
      starts_on: '2026-01-15',
    });
    expect(lines).toHaveLength(4);
    expect(lines.map((l) => l.due_on)).toEqual([
      '2026-01-15',
      '2026-04-15',
      '2026-07-15',
      '2026-10-15',
    ]);
  });

  it('SEMESTER 2 × 50000 = 6-month stride', () => {
    const lines = generateInstallmentLines({
      cadence: 'SEMESTER',
      total_minor: 100000n,
      installment_count: 2,
      starts_on: '2026-09-01',
    });
    expect(lines.map((l) => l.due_on)).toEqual(['2026-09-01', '2027-03-01']);
  });

  it('puts rounding remainder on the LAST installment (exact sum invariant)', () => {
    // 10000 / 3 = 3333 + 3333 + 3334
    const lines = generateInstallmentLines({
      cadence: 'MONTHLY',
      total_minor: 10000n,
      installment_count: 3,
      starts_on: '2026-01-01',
    });
    expect(lines.map((l) => l.gross_minor)).toEqual([3333n, 3333n, 3334n]);
    expect(lines.reduce((s, l) => s + l.gross_minor, 0n)).toBe(10000n);
  });

  it('throws on CUSTOM cadence (caller must supply lines[])', () => {
    expect(() =>
      generateInstallmentLines({
        cadence: 'CUSTOM',
        total_minor: 1000n,
        installment_count: 1,
        starts_on: '2026-01-01',
      }),
    ).toThrow(/CUSTOM/);
  });

  it('throws on installment_count <= 0', () => {
    expect(() =>
      generateInstallmentLines({
        cadence: 'MONTHLY',
        total_minor: 1000n,
        installment_count: 0,
        starts_on: '2026-01-01',
      }),
    ).toThrow();
  });

  it('throws on invalid starts_on', () => {
    expect(() =>
      generateInstallmentLines({
        cadence: 'MONTHLY',
        total_minor: 1000n,
        installment_count: 3,
        starts_on: 'not-a-date',
      }),
    ).toThrow();
  });
});

describe('recomputeInstallmentAmounts', () => {
  it('gross + adjustments + paid → net + balance', () => {
    const r = recomputeInstallmentAmounts({
      gross_minor: 10000n,
      adjustments_sum_minor: 500n - 2000n, // 500 late fee, 2000 discount → net 8500
      paid_minor: 5000n,
    });
    expect(r.net_minor).toBe(8500n);
    expect(r.balance_minor).toBe(3500n);
  });

  it('clamps net at 0 (waivers > gross don\'t make net negative)', () => {
    const r = recomputeInstallmentAmounts({
      gross_minor: 1000n,
      adjustments_sum_minor: -5000n,
      paid_minor: 0n,
    });
    expect(r.net_minor).toBe(0n);
    expect(r.balance_minor).toBe(0n);
  });

  it('clamps balance at 0 (overpayment doesn\'t go negative)', () => {
    const r = recomputeInstallmentAmounts({
      gross_minor: 1000n,
      adjustments_sum_minor: 0n,
      paid_minor: 1500n,
    });
    expect(r.net_minor).toBe(1000n);
    expect(r.balance_minor).toBe(0n);
  });
});

describe('allocateFifo', () => {
  it('distributes a payment across due installments in order', () => {
    const r = allocateFifo({
      gross_minor: 1500n,
      installments: [
        { id: 'a', balance_minor: 500n },
        { id: 'b', balance_minor: 700n },
        { id: 'c', balance_minor: 600n },
      ],
    });
    expect(r.allocations).toEqual([
      { fee_installment_id: 'a', amount_minor: 500n },
      { fee_installment_id: 'b', amount_minor: 700n },
      { fee_installment_id: 'c', amount_minor: 300n },
    ]);
    expect(r.overflow_minor).toBe(0n);
  });

  it('returns overflow when payment exceeds total balance', () => {
    const r = allocateFifo({
      gross_minor: 2000n,
      installments: [{ id: 'a', balance_minor: 500n }],
    });
    expect(r.allocations).toEqual([{ fee_installment_id: 'a', amount_minor: 500n }]);
    expect(r.overflow_minor).toBe(1500n);
  });

  it('skips installments with zero balance', () => {
    const r = allocateFifo({
      gross_minor: 100n,
      installments: [
        { id: 'paid', balance_minor: 0n },
        { id: 'open', balance_minor: 100n },
      ],
    });
    expect(r.allocations).toEqual([{ fee_installment_id: 'open', amount_minor: 100n }]);
    expect(r.overflow_minor).toBe(0n);
  });

  it('handles zero gross (no allocations, no overflow)', () => {
    const r = allocateFifo({
      gross_minor: 0n,
      installments: [{ id: 'a', balance_minor: 500n }],
    });
    expect(r.allocations).toEqual([]);
    expect(r.overflow_minor).toBe(0n);
  });
});

describe('derivePlanStatusFromInstallments', () => {
  it('empty → ACTIVE (draft plan with no rows yet)', () => {
    expect(derivePlanStatusFromInstallments([])).toBe('ACTIVE');
  });
  it('any SUSPENDED → PAUSED', () => {
    expect(derivePlanStatusFromInstallments(['DUE', 'SUSPENDED', 'PAID'])).toBe('PAUSED');
  });
  it('all terminal → COMPLETED', () => {
    expect(derivePlanStatusFromInstallments(['PAID', 'PAID', 'WAIVED'])).toBe('COMPLETED');
  });
  it('all terminal incl REFUNDED + CANCELLED → COMPLETED', () => {
    expect(derivePlanStatusFromInstallments(['PAID', 'REFUNDED', 'CANCELLED'])).toBe('COMPLETED');
  });
  it('mixed active + terminal → ACTIVE', () => {
    expect(derivePlanStatusFromInstallments(['PAID', 'DUE'])).toBe('ACTIVE');
  });
});

describe('shiftIsoDate', () => {
  it('shifts 14 days forward', () => {
    expect(shiftIsoDate('2026-01-01', 14)).toBe('2026-01-15');
  });
  it('wraps across month boundaries', () => {
    expect(shiftIsoDate('2026-01-25', 10)).toBe('2026-02-04');
  });
  it('0 days = no-op', () => {
    expect(shiftIsoDate('2026-09-01', 0)).toBe('2026-09-01');
  });
});

// SVT-SEC-2026-05 — month-end clamp regression test for the pricing fix.
describe('generateInstallmentLines — month-end clamp', () => {
  it('MONTHLY starting 2026-01-31 clamps to 2026-02-28 / 2026-03-31 (not Mar-02 spillover)', () => {
    const lines = generateInstallmentLines({
      cadence: 'MONTHLY',
      total_minor: 300n,
      installment_count: 3,
      starts_on: '2026-01-31',
    });
    expect(lines.map((l) => l.due_on)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
    ]);
  });

  it('MONTHLY 2027 leap-aware: Feb of non-leap year clamps to 28 not 29', () => {
    const lines = generateInstallmentLines({
      cadence: 'MONTHLY',
      total_minor: 200n,
      installment_count: 2,
      starts_on: '2027-01-30',
    });
    expect(lines.map((l) => l.due_on)).toEqual(['2027-01-30', '2027-02-28']);
  });

  it('throws shaped 400 BadRequest on installment_count <= 0', () => {
    try {
      generateInstallmentLines({
        cadence: 'MONTHLY',
        total_minor: 1000n,
        installment_count: 0,
        starts_on: '2026-09-01',
      });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as { status?: number; message: string };
      expect(err.status).toBe(400);
      expect(err.message).toMatch(/installment_count/);
    }
  });

  it('throws shaped 400 BadRequest on negative total_minor', () => {
    try {
      generateInstallmentLines({
        cadence: 'MONTHLY',
        total_minor: -1n,
        installment_count: 1,
        starts_on: '2026-09-01',
      });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as { status?: number; message: string };
      expect(err.status).toBe(400);
    }
  });

  it('throws shaped 400 BadRequest when cadence=CUSTOM (must use lines[])', () => {
    try {
      generateInstallmentLines({
        cadence: 'CUSTOM',
        total_minor: 1000n,
        installment_count: 2,
        starts_on: '2026-09-01',
      });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as { status?: number; message: string };
      expect(err.status).toBe(400);
    }
  });

  it('throws shaped 400 BadRequest on malformed starts_on', () => {
    try {
      generateInstallmentLines({
        cadence: 'MONTHLY',
        total_minor: 1000n,
        installment_count: 1,
        starts_on: 'not-a-date',
      });
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as { status?: number; message: string };
      expect(err.status).toBe(400);
    }
  });
});
