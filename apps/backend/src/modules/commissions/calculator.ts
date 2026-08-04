// Pure-ish commission calculation. Reads the enrollment + its institution and
// returns the canonical { amount_minor, currency, commission_pct, basis_minor }
// tuple — or `null` if the commission cannot be determined yet (no partner pct
// configured, or the enrollment has no tuition_total_minor / tuition_currency).
//
// Math: amount_minor = trunc(basis_minor * commission_pct / 100). All inputs
// stay in BigInt / Decimal throughout; the truncation is integer division on a
// BigInt scaled by 10000 to honour the (5,2) precision of
// `Institution.commission_pct`. There is no floating-point value anywhere in
// this file — see computeCommission for the rounding contract.

import { Prisma, type PrismaClient } from '@prisma/client';

export type Db = PrismaClient | Prisma.TransactionClient;

export type CalcResult = {
  amount_minor: bigint;
  currency: string;
  commission_pct: Prisma.Decimal;
  basis_minor: bigint;
};

/**
 * Compute the commission for an enrollment, or return null if it can't be
 * determined yet. Caller is responsible for tenant scoping (we use the passed
 * `tx`, which is typically the RLS-scoped client from req.db).
 */
export async function calculateForEnrollment(
  tx: Db,
  enrollmentId: string,
): Promise<CalcResult | null> {
  const enrollment = await tx.enrollment.findFirst({
    where: { id: enrollmentId, deleted_at: null },
    select: {
      id: true,
      tuition_total_minor: true,
      tuition_currency: true,
      institution: {
        select: {
          id: true,
          commission_pct: true,
        },
      },
    },
  });
  if (!enrollment) return null;

  const pct = enrollment.institution?.commission_pct;
  const basis = enrollment.tuition_total_minor;
  const currency = enrollment.tuition_currency;

  return computeCommission({ basis_minor: basis, commission_pct: pct, currency });
}

/**
 * The commission arithmetic, with no I/O.
 *
 * SVT-FIN-2026-08 — extracted so the money math is testable on its own. It was
 * previously inlined in calculateForEnrollment, which needs a database, so the
 * single most consequential calculation in the module had no direct unit test
 * at all; every assertion about it had to go through a Prisma mock.
 *
 * ROUNDING CONTRACT: amount = trunc(basis × pct_scaled / 10000).
 *
 * The comment here used to say "floor", which is only the same thing for
 * non-negative operands. BigInt division truncates toward ZERO, so a negative
 * basis (reachable via the CSV importer, which accepts a leading '-' on
 * tuition_total_minor) gives -124 for -999 at 12.50%, not the floor of -125.
 * Truncation is the behaviour we want — it is symmetric, so a charge and its
 * exact reversal always net to zero, which floor would not guarantee. The
 * behaviour was right and the word was wrong, and a wrong word in a rounding
 * contract is how a drift gets introduced by someone later "fixing" it.
 *
 * Truncating also means commission is rounded in the payer's favour by at most
 * one minor unit per claim. Deliberate and conservative — we never over-claim —
 * but a choice. Do not switch to half-up without restating historical claims.
 */
export function computeCommission(input: {
  basis_minor: bigint | null | undefined;
  commission_pct: Prisma.Decimal | null | undefined;
  currency: string | null | undefined;
}): CalcResult | null {
  const { basis_minor: basis, commission_pct: pct, currency } = input;
  // No partner pct OR no tuition_total OR no currency -> nothing to claim yet.
  if (pct == null) return null;
  if (basis == null) return null;
  if (!currency) return null;

  const pctScaled = scaledPctToBigInt(pct);
  const amount = (basis * pctScaled) / 10000n;

  return {
    amount_minor: amount,
    currency,
    commission_pct: pct,
    basis_minor: basis,
  };
}

/**
 * Convert a Prisma.Decimal commission_pct (e.g. "12.50", "7", "0.5") into
 * an integer BigInt scaled by 100. Accepts at most 2 decimal places, which is
 * enforced upstream by the Decimal(5,2) column and the wire-format regex.
 */
function scaledPctToBigInt(pct: Prisma.Decimal): bigint {
  // toFixed(2) gives us a string like "12.50"; we drop the decimal point and
  // parse as BigInt to avoid Number precision issues.
  const fixed = pct.toFixed(2); // e.g. "12.50"
  const [whole, frac = '00'] = fixed.split('.');
  return BigInt((whole ?? '0') + frac.padEnd(2, '0').slice(0, 2));
}
