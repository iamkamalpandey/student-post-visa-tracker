// SVT-WAVE-BILLING-2026-05 — pure pricing helpers (no I/O).
//
// Kept I/O-free so the math can be unit-tested without database stubs and so
// the service layer can compose them inside transactions without surprise
// side-effects.

import type {
  BillingCadenceValue,
  FeePlanLineInput,
} from '@spv/zod-schemas';

const DAY_MS = 86_400_000;

/**
 * Generate installment lines for cron-cadence plans.
 *
 *   MONTHLY    → 1-month stride
 *   QUARTERLY  → 3-month stride
 *   TRIMESTER  → 4-month stride
 *   SEMESTER   → 6-month stride
 *   TERM       → treat as quarterly (admin can override with CUSTOM)
 *   ANNUAL     → 12-month stride
 *
 * Returns N lines summing to `total_minor` (rounding remainder lands on the
 * final installment so the schedule is byte-accurate against the contract).
 */
export function generateInstallmentLines(opts: {
  cadence: BillingCadenceValue;
  total_minor: bigint;
  installment_count: number;
  starts_on: string; // ISO date
  labelPrefix?: string;
}): FeePlanLineInput[] {
  const { cadence, total_minor, installment_count, starts_on, labelPrefix } = opts;
  // BUG-FIX-SEC-2026-05: throw shaped errors so they reach the user as
  // 400/422 (not generic 500). Service.resolveLines + Zod validation should
  // already reject these inputs but defence-in-depth still matters.
  if (installment_count <= 0) {
    const e = new Error('installment_count must be > 0') as Error & { status: number };
    e.status = 400;
    throw e;
  }
  if (total_minor < 0n) {
    const e = new Error('total_minor must be >= 0') as Error & { status: number };
    e.status = 400;
    throw e;
  }
  if (cadence === 'CUSTOM') {
    const e = new Error('Use lines[] directly for CUSTOM cadence') as Error & { status: number };
    e.status = 400;
    throw e;
  }
  const monthsPerStride: Record<Exclude<BillingCadenceValue, 'CUSTOM'>, number> = {
    MONTHLY: 1,
    QUARTERLY: 3,
    TRIMESTER: 4,
    SEMESTER: 6,
    TERM: 3,
    ANNUAL: 12,
  };
  const stride = monthsPerStride[cadence];
  const start = new Date(`${starts_on}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) {
    const e = new Error(`Invalid starts_on: ${starts_on}`) as Error & { status: number };
    e.status = 400;
    throw e;
  }
  // Distribute remainder onto the last installment so the sum is exact.
  const perInstall = total_minor / BigInt(installment_count);
  const remainder = total_minor - perInstall * BigInt(installment_count);
  const lines: FeePlanLineInput[] = [];
  const originalDay = start.getUTCDate();
  for (let i = 0; i < installment_count; i += 1) {
    // BUG-FIX-SEC-2026-05: setUTCMonth on a date with day=31 spills into
    // the following month when the target month is shorter (Feb, etc.).
    // Clamp to the last valid day of the target month so MONTHLY plans
    // starting on 2026-01-31 land on 2026-02-28 / 2026-03-31 / 2026-04-30
    // (not 2026-03-02 / 2026-03-31 / 2026-05-01).
    const due = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + stride * i, 1));
    const lastDayOfTargetMonth = new Date(
      Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0),
    ).getUTCDate();
    due.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
    const due_on = due.toISOString().slice(0, 10);
    const isLast = i === installment_count - 1;
    const gross_minor = isLast ? perInstall + remainder : perInstall;
    lines.push({
      label: `${labelPrefix ?? 'Installment'} ${i + 1} of ${installment_count}`,
      due_on,
      gross_minor,
    });
  }
  return lines;
}

/**
 * Compute net_minor + balance_minor + new status from gross + adjustments + paid.
 * Adjustment-sign convention (see schema.prisma FeeAdjustment block):
 *   LATE_FEE  → positive (adds to net)
 *   DISCOUNT  → negative (reduces net)
 *   SCHOLARSHIP / WAIVER / WRITE_OFF → negative
 */
export function recomputeInstallmentAmounts(opts: {
  gross_minor: bigint;
  adjustments_sum_minor: bigint;
  paid_minor: bigint;
}): { net_minor: bigint; balance_minor: bigint } {
  const net = opts.gross_minor + opts.adjustments_sum_minor;
  const netClamped = net < 0n ? 0n : net;
  const balance = netClamped - opts.paid_minor;
  return { net_minor: netClamped, balance_minor: balance < 0n ? 0n : balance };
}

/**
 * Distribute a payment across multiple installments using First-In-First-Out
 * over their due_on date. Returns the per-installment allocation list and any
 * overflow (suitable for StudentCredit carry-forward).
 *
 * Pure: caller supplies installments in due_on-asc order. Idempotent: same
 * input → same output.
 */
export function allocateFifo(opts: {
  gross_minor: bigint;
  installments: Array<{ id: string; balance_minor: bigint }>;
}): {
  allocations: Array<{ fee_installment_id: string; amount_minor: bigint }>;
  overflow_minor: bigint;
} {
  let remaining = opts.gross_minor;
  const allocations: Array<{ fee_installment_id: string; amount_minor: bigint }> = [];
  for (const inst of opts.installments) {
    if (remaining <= 0n) break;
    if (inst.balance_minor <= 0n) continue;
    const apply = remaining < inst.balance_minor ? remaining : inst.balance_minor;
    allocations.push({ fee_installment_id: inst.id, amount_minor: apply });
    remaining -= apply;
  }
  return { allocations, overflow_minor: remaining };
}

/**
 * Derive a FeePlanStatus from the bag of installment statuses.
 *   any SUSPENDED   → keep PAUSED
 *   any active      → ACTIVE
 *   all terminal    → COMPLETED
 *
 * Terminal = PAID | WAIVED | CANCELLED | REFUNDED.
 * CANCELLED+REFUNDED on every row → still COMPLETED (the plan is done, no
 * money is owed). CANCELLED plan-level status is set explicitly by the
 * service, not derived here.
 */
const TERMINAL_INSTALLMENT_STATUSES = new Set([
  'PAID',
  'WAIVED',
  'CANCELLED',
  'REFUNDED',
]);

export function derivePlanStatusFromInstallments(
  statuses: readonly string[],
): 'ACTIVE' | 'PAUSED' | 'COMPLETED' {
  if (statuses.length === 0) return 'ACTIVE';
  if (statuses.some((s) => s === 'SUSPENDED')) return 'PAUSED';
  if (statuses.every((s) => TERMINAL_INSTALLMENT_STATUSES.has(s))) return 'COMPLETED';
  return 'ACTIVE';
}

/**
 * Convenience: shift a date forward by N days, returning ISO YYYY-MM-DD.
 * Used by resumePlan to push remaining due dates by the leave window.
 */
export function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const __HELPERS_FOR_TEST__ = { DAY_MS };
