// SVT-FIN-2026-08 — the arithmetic contract of `scholarship_minor`.
//
// Written because the field was stored on the FeePlan and PRINTED on both
// invoice renderers while being applied to nothing: `total_minor` was the raw
// sum of the lines and every installment carried its full gross. A plan with a
// scholarship showed the student a discount and then billed them the full
// amount, on every installment, with no error anywhere.
//
// These pin the properties that make the discount real and safe:
//
//   * conservation      — the cuts sum to EXACTLY the scholarship
//   * non-negativity    — no installment can be driven below zero
//   * proportionality   — a bigger installment absorbs a bigger cut
//   * determinism       — regenerate reproduces the same schedule
//   * rejection         — a scholarship larger than the plan is a 400, not a
//                         silent clamp that quietly forgives revenue
//
// A regression in any of these bills a student the wrong amount.

import { describe, it, expect, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const { applyScholarship, generateInstallmentLines } = await import(
  '../src/modules/billing/pricing.js'
);

type Line = { label: string; due_on: string; gross_minor: bigint };

const mk = (...amounts: bigint[]): Line[] =>
  amounts.map((gross_minor, i) => ({
    label: `Installment ${i + 1}`,
    due_on: `2026-0${(i % 9) + 1}-01`,
    gross_minor,
  }));

const sum = (ls: Line[]) => ls.reduce((s, l) => s + l.gross_minor, 0n);

describe('applyScholarship — conservation', () => {
  it('cuts sum to exactly the scholarship (no minor unit invented or lost)', () => {
    const before = mk(333_33n, 333_33n, 333_34n);
    const after = applyScholarship(before, 100_00n);
    expect(sum(before) - sum(after)).toBe(100_00n);
  });

  it('handles a scholarship that does not divide evenly across lines', () => {
    // 3 lines, 10 minor units: floors give 3+3+3=9, one unit must be placed.
    const after = applyScholarship(mk(1_000n, 1_000n, 1_000n), 10n);
    expect(sum(after)).toBe(3_000n - 10n);
  });

  it('a full scholarship zeroes every line', () => {
    const after = applyScholarship(mk(500n, 1_500n, 3_000n), 5_000n);
    expect(after.map((l) => l.gross_minor)).toEqual([0n, 0n, 0n]);
    expect(sum(after)).toBe(0n);
  });

  it('a zero scholarship is a pass-through', () => {
    const before = mk(1_000n, 2_000n);
    expect(applyScholarship(before, 0n)).toEqual(before);
  });

  it('conserves across a wide sweep of awkward splits', () => {
    // Property check: for many (lines, scholarship) combinations the cuts must
    // sum exactly and no line may go negative. This is the class of bug that
    // hides in a single unlucky rounding case.
    for (let n = 1; n <= 12; n += 1) {
      const lines = mk(...Array.from({ length: n }, (_, i) => BigInt(97 * (i + 1) + 1)));
      const total = sum(lines);
      for (let s = 0n; s <= total; s += total / 7n + 1n) {
        const after = applyScholarship(lines, s);
        expect(sum(lines) - sum(after)).toBe(s);
        for (const l of after) expect(l.gross_minor >= 0n).toBe(true);
      }
    }
  });
});

describe('applyScholarship — non-negativity', () => {
  it('never drives a small line negative (the flat-split trap)', () => {
    // A flat per-line cut would take 100 off each and leave the first at -50.
    const after = applyScholarship(mk(50n, 10_000n), 200n);
    for (const l of after) expect(l.gross_minor >= 0n).toBe(true);
    expect(sum(after)).toBe(10_050n - 200n);
  });

  it('a single tiny line absorbing its whole value stays at zero', () => {
    const after = applyScholarship(mk(1n, 9_999n), 10_000n);
    expect(after.map((l) => l.gross_minor)).toEqual([0n, 0n]);
  });
});

describe('applyScholarship — proportionality and determinism', () => {
  it('a larger installment absorbs a larger share of the scholarship', () => {
    const before = mk(1_000n, 9_000n);
    const after = applyScholarship(before, 1_000n);
    const cut0 = before[0]!.gross_minor - after[0]!.gross_minor;
    const cut1 = before[1]!.gross_minor - after[1]!.gross_minor;
    expect(cut1 > cut0).toBe(true);
    expect(cut0 + cut1).toBe(1_000n);
  });

  it('is deterministic — a regenerated plan reproduces the same schedule', () => {
    const lines = mk(1_111n, 2_222n, 3_333n, 4_444n);
    const a = applyScholarship(lines, 1_234n);
    const b = applyScholarship(lines, 1_234n);
    expect(a).toEqual(b);
  });

  it('does not mutate the caller’s lines', () => {
    const before = mk(1_000n, 1_000n);
    applyScholarship(before, 500n);
    expect(before.map((l) => l.gross_minor)).toEqual([1_000n, 1_000n]);
  });
});

describe('applyScholarship — rejection', () => {
  it('rejects a scholarship larger than the schedule as 400, not a silent clamp', () => {
    let status: number | undefined;
    try {
      applyScholarship(mk(1_000n), 1_001n);
    } catch (e) {
      status = (e as { status?: number }).status;
    }
    expect(status).toBe(400);
  });

  it('rejects a negative scholarship', () => {
    expect(() => applyScholarship(mk(1_000n), -1n)).toThrow();
  });
});

describe('scholarship + generated schedule — the end-to-end invariant', () => {
  it('sum(installments) === total_minor - scholarship_minor', () => {
    // Exactly the identity plan.service.ts now relies on: total_minor stays
    // GROSS (fed from the enrollment tuition), and the billed schedule is net.
    const total = 1_200_000n;
    const scholarship = 250_000n;
    const gross = generateInstallmentLines({
      cadence: 'MONTHLY',
      total_minor: total,
      installment_count: 7,
      starts_on: '2026-01-31',
    });
    expect(sum(gross as Line[])).toBe(total);

    const billed = applyScholarship(gross as Line[], scholarship);
    expect(sum(billed)).toBe(total - scholarship);
  });

  it('holds for an odd installment count that forces a remainder on both passes', () => {
    const total = 100_003n;
    const scholarship = 33_337n;
    const gross = generateInstallmentLines({
      cadence: 'QUARTERLY',
      total_minor: total,
      installment_count: 3,
      starts_on: '2026-02-28',
    });
    const billed = applyScholarship(gross as Line[], scholarship);
    expect(sum(billed)).toBe(total - scholarship);
    for (const l of billed) expect(l.gross_minor >= 0n).toBe(true);
  });
});
