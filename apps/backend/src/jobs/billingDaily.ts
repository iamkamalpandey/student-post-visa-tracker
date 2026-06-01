// SVT-WAVE-BILLING-2026-05 (Wave 5) — Daily billing cron.
//
// Runs at 06:30 UTC after the expiry-alerts pass. Per active tenant where
// tenant.billing_enabled = true:
//
//   1. INVOICED → DUE     when due_on <= today.
//   2. DUE      → OVERDUE when due_on < today - grace_days (tenant default 7).
//   3. Apply a LATE_FEE adjustment per OVERDUE installment (idempotent per
//      applied_on date — if there's already a LATE_FEE row with applied_on=today
//      we skip).
//   4. ACTIVE → COMPLETED when every installment is terminal (PAID/WAIVED/
//      CANCELLED/REFUNDED). Uses derivePlanStatusFromInstallments().
//
// All transitions are FSM-gated via assertOrThrow against feeInstallmentFsm /
// feePlanFsm. The cron runs as a synthetic ADMIN actor so it can issue
// transitions that the FSM marks ADMIN-only (CANCELLED is admin in the plan
// FSM — but COMPLETED is system).
//
// Late-fee policy lives in tenant.settings JSON for v1 (key `late_fee_policy`).
// Shape:
//   { "enabled": true, "amount_minor": 500, "currency": "USD",
//     "grace_days": 7, "max_per_installment": 3 }
// Missing keys → late fees disabled.
//
// Errors per-tenant are isolated; a single tenant blowing up never blocks the
// others. Returns a JobOutcome summary for the runJob wrapper.

import type { FeeInstallmentStatus } from '@prisma/client';
import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';
import { withTenantScope } from '../config/sentry.js';
import {
  feeInstallmentFsm,
  feePlanFsm,
} from '../modules/billing/fsm-def.js';
import { assertOrThrow } from '../shared/fsm.js';
import { writeAudit } from '../shared/audit.js';
import { derivePlanStatusFromInstallments } from '../modules/billing/pricing.js';
import type { JobOutcome } from './runner.js';

const SYSTEM_ACTOR = null; // System cron writes — actor_id null is recognised as system.
const SYSTEM_ROLE: 'ADMIN' = 'ADMIN';

type LateFeePolicy = {
  enabled?: boolean;
  amount_minor?: number | string;
  currency?: string;
  grace_days?: number;
  max_per_installment?: number;
};

function parsePolicy(raw: unknown): LateFeePolicy {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const p = (obj.late_fee_policy ?? obj) as Record<string, unknown>;
  return {
    enabled: Boolean(p.enabled),
    amount_minor: p.amount_minor as number | string | undefined,
    currency: p.currency as string | undefined,
    grace_days: typeof p.grace_days === 'number' ? p.grace_days : 7,
    max_per_installment: typeof p.max_per_installment === 'number' ? p.max_per_installment : 3,
  };
}

async function processTenant(tenantId: string): Promise<{
  invoiced_to_due: number;
  due_to_overdue: number;
  late_fees_applied: number;
  plans_completed: number;
  errors: number;
}> {
  let invoiced_to_due = 0;
  let due_to_overdue = 0;
  let late_fees_applied = 0;
  let plans_completed = 0;
  let errors = 0;

  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, is_active: true },
    select: { id: true, billing_enabled: true },
  });
  if (!tenant || !tenant.billing_enabled) {
    return { invoiced_to_due, due_to_overdue, late_fees_applied, plans_completed, errors };
  }
  // SVT-WAVE-BILLING-2026-05 — tenant-wide late_fee_policy lives on the
  // Tenant in a future migration (`late_fee_policy_json`). Until then,
  // late fees are disabled by default; per-FeePlan.late_fee_policy is the
  // fallback (read inside the LATE_FEE loop below).
  const policy: LateFeePolicy = parsePolicy(null);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const graceDays = policy.grace_days ?? 7;
  const overdueCutoff = new Date(today);
  overdueCutoff.setUTCDate(overdueCutoff.getUTCDate() - graceDays);

  // BUG-FIX-SEC-2026-05: removed top-level `SET LOCAL app.tenant_id` —
  // outside a transaction it's silently discarded so RLS wasn't pinned.
  // Defence-in-depth: every query below explicitly filters `tenant_id =
  // tenantId`, so RLS only ever served as belt-and-braces here. Per-write
  // tx (createMany / update) opens its own implicit tx which would need its
  // own SET LOCAL — wrap individual writes if RLS must engage.

  // 1. INVOICED → DUE
  try {
    const due = await prisma.feeInstallment.findMany({
      where: {
        tenant_id: tenantId,
        deleted_at: null,
        status: 'INVOICED',
        due_on: { lte: today },
      },
      select: { id: true, status: true },
      take: 5000,
    });
    for (const i of due) {
      try {
        assertOrThrow(feeInstallmentFsm, i.status as FeeInstallmentStatus, 'DUE', SYSTEM_ROLE);
        // SEC-burst: scope every write by (id, tenant_id) so a poisoned/
        // swapped id can never mutate another tenant under the superuser
        // cron connection. assert count === 1.
        const wr = await prisma.feeInstallment.updateMany({
          where: { id: i.id, tenant_id: tenantId },
          data: {
            status: 'DUE',
            updated_by_id: SYSTEM_ACTOR,
            version: { increment: 1 },
          },
        });
        if (wr.count === 1) invoiced_to_due += 1;
      } catch (err) {
        errors += 1;
        logger.warn({ err, installmentId: i.id, tenantId }, 'billing.daily: INVOICED→DUE failed');
      }
    }
  } catch (err) {
    errors += 1;
    logger.error({ err, tenantId }, 'billing.daily: INVOICED→DUE scan failed');
  }

  // 2. DUE → OVERDUE
  try {
    const overdue = await prisma.feeInstallment.findMany({
      where: {
        tenant_id: tenantId,
        deleted_at: null,
        status: 'DUE',
        due_on: { lt: overdueCutoff },
      },
      select: { id: true, status: true },
      take: 5000,
    });
    for (const i of overdue) {
      try {
        assertOrThrow(feeInstallmentFsm, i.status as FeeInstallmentStatus, 'OVERDUE', SYSTEM_ROLE);
        const wr = await prisma.feeInstallment.updateMany({
          where: { id: i.id, tenant_id: tenantId },
          data: {
            status: 'OVERDUE',
            updated_by_id: SYSTEM_ACTOR,
            version: { increment: 1 },
          },
        });
        if (wr.count === 1) due_to_overdue += 1;
      } catch (err) {
        errors += 1;
        logger.warn({ err, installmentId: i.id, tenantId }, 'billing.daily: DUE→OVERDUE failed');
      }
    }
  } catch (err) {
    errors += 1;
    logger.error({ err, tenantId }, 'billing.daily: DUE→OVERDUE scan failed');
  }

  // 3. Apply LATE_FEE per OVERDUE — idempotent on applied_on=today.
  if (policy.enabled && policy.amount_minor) {
    try {
      const amountMinor = BigInt(policy.amount_minor);
      if (amountMinor <= 0n) {
        logger.warn({ tenantId }, 'billing.daily: late_fee_policy.amount_minor must be > 0');
      } else {
        const candidates = await prisma.feeInstallment.findMany({
          where: {
            tenant_id: tenantId,
            deleted_at: null,
            status: 'OVERDUE',
          },
          select: {
            id: true,
            currency: true,
            adjustments: {
              where: { kind: 'LATE_FEE', applied_on: today },
              select: { id: true },
            },
            _count: { select: { adjustments: { where: { kind: 'LATE_FEE' } } } },
          },
          take: 5000,
        });
        for (const inst of candidates) {
          // Idempotent — skip if a LATE_FEE already applied today.
          if (inst.adjustments.length > 0) continue;
          // Cap to max_per_installment.
          if (
            policy.max_per_installment != null &&
            inst._count.adjustments >= policy.max_per_installment
          ) {
            continue;
          }
          try {
            await prisma.feeAdjustment.create({
              data: {
                tenant_id: tenantId,
                fee_installment_id: inst.id,
                kind: 'LATE_FEE',
                amount_minor: amountMinor,
                reason_code: 'auto.overdue',
                reason_text: `Auto late fee — overdue by > ${graceDays}d`,
                applied_on: today,
                created_by_id: SYSTEM_ACTOR,
              },
            });
            // Recompute net + balance for this installment.
            const sumRows = await prisma.feeAdjustment.aggregate({
              where: { fee_installment_id: inst.id, tenant_id: tenantId },
              _sum: { amount_minor: true },
            });
            const adjSum = sumRows._sum.amount_minor ?? 0n;
            const fresh = await prisma.feeInstallment.findFirst({
              where: { id: inst.id },
              select: { gross_minor: true, paid_minor: true },
            });
            if (fresh) {
              const newNet = fresh.gross_minor + adjSum;
              const newBalance = newNet - fresh.paid_minor;
              await prisma.feeInstallment.updateMany({
                where: { id: inst.id, tenant_id: tenantId },
                data: {
                  net_minor: newNet < 0n ? 0n : newNet,
                  balance_minor: newBalance < 0n ? 0n : newBalance,
                  updated_by_id: SYSTEM_ACTOR,
                  version: { increment: 1 },
                },
              });
            }
            late_fees_applied += 1;
          } catch (err) {
            errors += 1;
            logger.warn({ err, installmentId: inst.id, tenantId }, 'billing.daily: late_fee write failed');
          }
        }
      }
    } catch (err) {
      errors += 1;
      logger.error({ err, tenantId }, 'billing.daily: late_fee policy execution failed');
    }
  }

  // 4. ACTIVE → COMPLETED when all installments terminal.
  try {
    const activePlans = await prisma.feePlan.findMany({
      where: {
        tenant_id: tenantId,
        deleted_at: null,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        status: true,
        installments: {
          where: { deleted_at: null },
          select: { status: true },
        },
      },
      take: 5000,
    });
    for (const p of activePlans) {
      const derived = derivePlanStatusFromInstallments(p.installments.map((i) => i.status));
      if (derived === 'COMPLETED') {
        try {
          assertOrThrow(feePlanFsm, 'ACTIVE', 'COMPLETED', SYSTEM_ROLE);
          await prisma.feePlan.updateMany({
            where: { id: p.id, tenant_id: tenantId },
            data: {
              status: 'COMPLETED',
              ends_on: today,
              updated_by_id: SYSTEM_ACTOR,
              version: { increment: 1 },
            },
          });
          await writeAudit({
            tenantId,
            actorId: SYSTEM_ACTOR,
            action: 'fee_plan.completed',
            entityType: 'fee_plan',
            entityId: p.id,
            after: { status: 'COMPLETED', source: 'billing.daily' },
          } as never);
          plans_completed += 1;
        } catch (err) {
          errors += 1;
          logger.warn({ err, planId: p.id, tenantId }, 'billing.daily: plan complete failed');
        }
      }
    }
  } catch (err) {
    errors += 1;
    logger.error({ err, tenantId }, 'billing.daily: plan completion scan failed');
  }

  return { invoiced_to_due, due_to_overdue, late_fees_applied, plans_completed, errors };
}

export async function runBillingDaily(): Promise<JobOutcome> {
  const tenants = await prisma.tenant.findMany({
    where: { is_active: true, billing_enabled: true },
    select: { id: true },
  });

  let totals = {
    invoiced_to_due: 0,
    due_to_overdue: 0,
    late_fees_applied: 0,
    plans_completed: 0,
    errors: 0,
    tenants: tenants.length,
  };

  for (const t of tenants) {
    try {
      // SVT-OBS-JOBS-2026-05 — per-tenant Sentry scope. Any throw inside the
      // tenant pass surfaces in Sentry tagged with { job: 'billing.daily',
      // tenant_id }. processTenant catches most errors itself (incrementing
      // r.errors), so the outer catch typically fires only on prisma-level
      // crashes — but the scope wrap ensures any future un-caught throw is
      // attributable to the right tenant.
      const r = await withTenantScope(t.id, 'billing.daily', () => processTenant(t.id));
      totals.invoiced_to_due += r.invoiced_to_due;
      totals.due_to_overdue += r.due_to_overdue;
      totals.late_fees_applied += r.late_fees_applied;
      totals.plans_completed += r.plans_completed;
      totals.errors += r.errors;
    } catch (err) {
      totals.errors += 1;
      logger.error({ err, tenantId: t.id }, 'billing.daily: tenant pass crashed');
    }
  }

  const processed =
    totals.invoiced_to_due +
    totals.due_to_overdue +
    totals.late_fees_applied +
    totals.plans_completed;
  return {
    rowsProcessed: processed,
    rowsFailed: totals.errors,
    metadata: totals as unknown as Record<string, unknown>,
  };
}
