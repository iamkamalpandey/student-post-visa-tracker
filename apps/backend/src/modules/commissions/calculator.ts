// Pure-ish commission calculation. Reads the enrollment + its institution and
// returns the canonical { amount_minor, currency, commission_pct, basis_minor }
// tuple — or `null` if the commission cannot be determined yet (no partner pct
// configured, or the enrollment has no tuition_total_minor / tuition_currency).
//
// Math: amount_minor = floor(basis_minor * commission_pct / 100). All inputs
// stay in BigInt / Decimal until the very last `Math.floor`-style truncation,
// which we implement as integer division on BigInt scaled by 10000 to honour
// the (5,2) precision of `Institution.commission_pct`.

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

  // No partner pct OR no tuition_total OR no currency -> nothing to claim yet.
  if (pct == null) return null;
  if (basis == null) return null;
  if (!currency) return null;

  // pct is a Prisma.Decimal with up to 5,2 precision. Convert to a scaled
  // BigInt (×100) so we can do integer math without floating-point drift.
  // amount = floor(basis * pct_scaled / 10000)
  const pctScaled = scaledPctToBigInt(pct);
  const amount = (basis * pctScaled) / 10000n; // BigInt division truncates toward zero — equivalent to floor for non-negative inputs.

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
