// SVT-FIN-2026-08 — the arithmetic contract of the money paths.
//
// These are deliberately NOT happy-path tests. Each one pins a property that,
// if it silently changed, would move money without anyone noticing:
//
//   * remainder distribution   — parts must sum to the whole, exactly
//   * balance identity         — balance == net - paid, with clamps surfaced
//   * FIFO conservation        — allocations never exceed the payment
//   * percentage scaling       — no float anywhere between Decimal and BigInt
//   * currency exponent        — JPY has no minor units; /100 is not universal
//
// A regression in any of these is a financial loss, not a failing assertion.

import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const {
  generateInstallmentLines,
  recomputeInstallmentAmounts,
  allocateFifo,
} = await import('../src/modules/billing/pricing.js');
const { computeCommission } = await import('../src/modules/commissions/calculator.js');
const { currencyMinorDigits, decimalToMinor } = await import('../src/shared/money.js');

// ---------------------------------------------------------------------------
// Remainder distribution — the "parts sum to the whole" invariant
// ---------------------------------------------------------------------------

describe('generateInstallmentLines — conservation of the total', () => {
  const cases: Array<[bigint, number]> = [
    [100_000n, 3],   // 33333.33 → remainder 1
    [100n, 7],       // 14.28... → remainder 2
    [1n, 12],        // less than one minor unit per installment
    [999_999_999n, 7],
    [12_345_678_901_234_567_890n, 13], // far beyond Number.MAX_SAFE_INTEGER
    [0n, 4],
  ];

  for (const [total, count] of cases) {
    it(`splits ${total} across ${count} with zero drift`, () => {
      const lines = generateInstallmentLines({
        cadence: 'MONTHLY',
        total_minor: total,
        installment_count: count,
        starts_on: '2026-01-15',
      });
      expect(lines).toHaveLength(count);
      const sum = lines.reduce((s, l) => s + l.gross_minor, 0n);
      // The whole point: not "approximately", exactly.
      expect(sum).toBe(total);
    });
  }

  it('puts the remainder on the LAST installment, deterministically', () => {
    const lines = generateInstallmentLines({
      cadence: 'MONTHLY',
      total_minor: 100_000n,
      installment_count: 3,
      starts_on: '2026-01-15',
    });
    expect(lines.map((l) => l.gross_minor)).toEqual([33_333n, 33_333n, 33_334n]);
  });

  it('never emits a negative line', () => {
    const lines = generateInstallmentLines({
      cadence: 'QUARTERLY',
      total_minor: 5n,
      installment_count: 4,
      starts_on: '2026-02-29',
    });
    expect(lines.every((l) => l.gross_minor >= 0n)).toBe(true);
    expect(lines.reduce((s, l) => s + l.gross_minor, 0n)).toBe(5n);
  });

  it('clamps month-end dates instead of spilling into the next month', () => {
    // 2026-01-31 + 1 month must be 2026-02-28, not 2026-03-03.
    const lines = generateInstallmentLines({
      cadence: 'MONTHLY',
      total_minor: 300n,
      installment_count: 3,
      starts_on: '2026-01-31',
    });
    expect(lines.map((l) => l.due_on)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('rejects a zero or negative installment count rather than dividing by zero', () => {
    expect(() =>
      generateInstallmentLines({
        cadence: 'MONTHLY', total_minor: 100n, installment_count: 0, starts_on: '2026-01-01',
      }),
    ).toThrow(/installment_count/);
  });
});

// ---------------------------------------------------------------------------
// Balance identity — and the clamps that used to hide money
// ---------------------------------------------------------------------------

describe('recomputeInstallmentAmounts — balance == net - paid', () => {
  it('holds for the ordinary case', () => {
    const r = recomputeInstallmentAmounts({
      gross_minor: 100_000n, adjustments_sum_minor: 0n, paid_minor: 40_000n,
    });
    expect(r.net_minor).toBe(100_000n);
    expect(r.balance_minor).toBe(60_000n);
    expect(r.overpaid_minor).toBe(0n);
    expect(r.over_adjusted_minor).toBe(0n);
  });

  it('applies adjustments to net before computing balance', () => {
    // net == gross + adjustments (LATE_FEE positive, DISCOUNT negative)
    const late = recomputeInstallmentAmounts({
      gross_minor: 100_000n, adjustments_sum_minor: 5_000n, paid_minor: 0n,
    });
    expect(late.net_minor).toBe(105_000n);
    expect(late.balance_minor).toBe(105_000n);

    const disc = recomputeInstallmentAmounts({
      gross_minor: 100_000n, adjustments_sum_minor: -25_000n, paid_minor: 0n,
    });
    expect(disc.net_minor).toBe(75_000n);
    expect(disc.balance_minor).toBe(75_000n);
  });

  it('SURFACES an overpayment instead of silently clamping it to zero', () => {
    // A discount applied after the installment was paid in full leaves the
    // business owing the student money. The old signature returned
    // balance_minor: 0n and nothing else — the excess simply vanished, with no
    // credit row and no error. Callers must now see it.
    const r = recomputeInstallmentAmounts({
      gross_minor: 100_000n, adjustments_sum_minor: -20_000n, paid_minor: 100_000n,
    });
    expect(r.net_minor).toBe(80_000n);
    expect(r.balance_minor).toBe(0n);      // column stays non-negative
    expect(r.overpaid_minor).toBe(20_000n); // ...but the 20,000 is reported
  });

  it('SURFACES an over-adjustment that would drive net below zero', () => {
    const r = recomputeInstallmentAmounts({
      gross_minor: 10_000n, adjustments_sum_minor: -15_000n, paid_minor: 0n,
    });
    expect(r.net_minor).toBe(0n);
    expect(r.over_adjusted_minor).toBe(5_000n);
  });

  it('keeps the identity exact at magnitudes beyond double precision', () => {
    const gross = 9_007_199_254_740_993n; // 2^53 + 1
    const r = recomputeInstallmentAmounts({
      gross_minor: gross, adjustments_sum_minor: 0n, paid_minor: 1n,
    });
    expect(r.balance_minor).toBe(gross - 1n);
    expect(r.net_minor - 1n).toBe(r.balance_minor);
  });
});

// ---------------------------------------------------------------------------
// FIFO allocation — conservation of the payment
// ---------------------------------------------------------------------------

describe('allocateFifo — sum(allocations) + overflow == gross', () => {
  const installments = [
    { id: 'a', balance_minor: 10_000n },
    { id: 'b', balance_minor: 10_000n },
    { id: 'c', balance_minor: 10_000n },
  ];

  it('conserves value on a partial payment', () => {
    const r = allocateFifo({ gross_minor: 15_000n, installments });
    const allocated = r.allocations.reduce((s, a) => s + a.amount_minor, 0n);
    expect(allocated + r.overflow_minor).toBe(15_000n);
    expect(r.overflow_minor).toBe(0n);
  });

  it('conserves value on an overpayment, routing the excess to overflow', () => {
    const r = allocateFifo({ gross_minor: 45_000n, installments });
    const allocated = r.allocations.reduce((s, a) => s + a.amount_minor, 0n);
    expect(allocated).toBe(30_000n);
    expect(r.overflow_minor).toBe(15_000n);
    expect(allocated + r.overflow_minor).toBe(45_000n);
  });

  it('never allocates more than an installment owes', () => {
    const r = allocateFifo({ gross_minor: 45_000n, installments });
    for (const a of r.allocations) {
      const target = installments.find((i) => i.id === a.fee_installment_id)!;
      expect(a.amount_minor <= target.balance_minor).toBe(true);
    }
  });

  it('skips already-settled installments rather than allocating zero to them', () => {
    const r = allocateFifo({
      gross_minor: 5_000n,
      installments: [{ id: 'paid', balance_minor: 0n }, { id: 'open', balance_minor: 8_000n }],
    });
    expect(r.allocations).toEqual([{ fee_installment_id: 'open', amount_minor: 5_000n }]);
  });

  it('allocates nothing when there is nothing owed, and reports the whole payment as overflow', () => {
    const r = allocateFifo({
      gross_minor: 5_000n,
      installments: [{ id: 'paid', balance_minor: 0n }],
    });
    expect(r.allocations).toHaveLength(0);
    expect(r.overflow_minor).toBe(5_000n);
  });
});

// ---------------------------------------------------------------------------
// Percentage scaling — no float between the Decimal column and the BigInt
// ---------------------------------------------------------------------------

describe('computeCommission — percentage arithmetic', () => {
  const calc = (basis: bigint, pct: string) =>
    computeCommission({
      basis_minor: basis,
      commission_pct: new Prisma.Decimal(pct),
      currency: 'NPR',
    })?.amount_minor;

  it('handles every decimal shape the Decimal(5,2) column can hold', () => {
    // 1_000_000 minor units of basis.
    expect(calc(1_000_000n, '7')).toBe(70_000n);
    expect(calc(1_000_000n, '7.0')).toBe(70_000n);
    expect(calc(1_000_000n, '0.50')).toBe(5_000n);
    expect(calc(1_000_000n, '0.5')).toBe(5_000n);
    expect(calc(1_000_000n, '12.5')).toBe(125_000n);
    expect(calc(1_000_000n, '12.50')).toBe(125_000n);
    expect(calc(1_000_000n, '100.00')).toBe(1_000_000n);
    expect(calc(1_000_000n, '0')).toBe(0n);
  });

  it('does NOT drift on values that are inexact in binary floating point', () => {
    // 19.99% of 100.00 is exactly 19.99 minor units before truncation.
    // Number('19.99') * 10000 / 10000 would not be exact; Decimal is.
    expect(calc(10_000n, '19.99')).toBe(1_999n);
    expect(calc(100_000n, '0.07')).toBe(70n);
    // The classic float trap: a 1.005 half-boundary. Decimal.js toFixed uses
    // ROUND_HALF_UP, so the rate scales to 1.01 — matching what Postgres would
    // have stored in the Decimal(5,2) column in the first place. In IEEE-754,
    // 1.005 * 100 is 100.49999999999999 and would have rounded DOWN to 1.00,
    // silently under-claiming. Pinned so nobody "optimises" the Decimal away.
    expect(calc(100_000n, '1.005')).toBe(1_010n);
    expect(calc(100_000n, '1.004')).toBe(1_000n);
  });

  it('truncates toward zero — and stays symmetric under negation', () => {
    // Documented contract. Truncation (not floor) is what makes a charge and
    // its exact reversal net to zero.
    expect(calc(999n, '12.50')).toBe(124n);
    expect(calc(-999n, '12.50')).toBe(-124n);
    expect(calc(999n, '12.50')! + calc(-999n, '12.50')!).toBe(0n);
  });

  it('is exact for a basis far above Number.MAX_SAFE_INTEGER', () => {
    // 10% of 10^19 minor units. A Number() anywhere in this path loses digits.
    expect(calc(10_000_000_000_000_000_000n, '10')).toBe(1_000_000_000_000_000_000n);
  });

  it('returns null rather than guessing when an input is missing', () => {
    expect(
      computeCommission({ basis_minor: null, commission_pct: new Prisma.Decimal('10'), currency: 'NPR' }),
    ).toBeNull();
    expect(
      computeCommission({ basis_minor: 100n, commission_pct: null, currency: 'NPR' }),
    ).toBeNull();
    expect(
      computeCommission({ basis_minor: 100n, commission_pct: new Prisma.Decimal('10'), currency: null }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Currency exponent — /100 is not universal
// ---------------------------------------------------------------------------

describe('currency exponent', () => {
  it('knows the zero-decimal currencies that are actually seeded', () => {
    // Both are in prisma/data/iso-currencies.json with minor_unit: 0.
    expect(currencyMinorDigits('JPY')).toBe(0);
    expect(currencyMinorDigits('KRW')).toBe(0);
    expect(currencyMinorDigits('USD')).toBe(2);
    expect(currencyMinorDigits('GBP')).toBe(2);
    expect(currencyMinorDigits('NPR')).toBe(2);
  });

  it('round-trips major→minor without float drift at the half boundary', () => {
    // Math.round(1.005 * 100) is 100 in IEEE-754. Half-up says 101.
    expect(decimalToMinor('1.005', 'USD')).toBe(101n);
    expect(decimalToMinor('0.145', 'USD')).toBe(15n);
    expect(decimalToMinor('19.99', 'USD')).toBe(1_999n);
    // Zero-decimal currency: the major unit IS the minor unit.
    expect(decimalToMinor('50000', 'JPY')).toBe(50_000n);
  });
});
