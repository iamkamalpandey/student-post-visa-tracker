// SVT-WAVE-BILLING-2026-05 (Wave 5) — Daily billing cron.
//
// Runs at 06:30 UTC after the expiry-alerts pass. Per active tenant where
// tenant.billing_enabled = true:
//
//   0. SCHEDULED → INVOICED when due_on <= today + INVOICE_LEAD_DAYS and the
//      plan is ACTIVE. Without this the whole pipeline below is unreachable.
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

// How far ahead of its due date an installment is invoiced. Seven days gives
// the student notice before the amount is actually due, and means a plan whose
// first installment is due today becomes a visible receivable immediately
// rather than only on the due date itself.
const INVOICE_LEAD_DAYS = 7;
// How long past its due date an installment sits before it flips to OVERDUE.
// A system constant, deliberately NOT a policy lookup — it used to be read off
// a policy object that was always empty, which made it look configurable while
// it never was.
const OVERDUE_GRACE_DAYS = 7;
const SYSTEM_ROLE = 'ADMIN' as const;

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
    // SVT-FIN-2026-08 — accept `fee_minor` as an alias. schema.prisma documents
    // the FeePlan.late_fee_policy shape as `{ grace_days, fee_minor | fee_pct,
    // max_per_installment }` while this parser only ever read `amount_minor`,
    // so a policy authored from the schema comment parsed to `undefined` and
    // the plan silently never charged. Reading both removes a configuration
    // trap whose only symptom was nothing happening.
    amount_minor: (p.amount_minor ?? p.fee_minor) as number | string | undefined,
    currency: p.currency as string | undefined,
    grace_days: typeof p.grace_days === 'number' ? p.grace_days : 7,
    max_per_installment: typeof p.max_per_installment === 'number' ? p.max_per_installment : 3,
  };
}

async function processTenant(tenantId: string): Promise<{
  scheduled_to_invoiced: number;
  invoiced_to_due: number;
  due_to_overdue: number;
  late_fees_applied: number;
  plans_completed: number;
  errors: number;
}> {
  let scheduled_to_invoiced = 0;
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
    return { scheduled_to_invoiced, invoiced_to_due, due_to_overdue, late_fees_applied, plans_completed, errors };
  }
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const graceDays = OVERDUE_GRACE_DAYS;
  const overdueCutoff = new Date(today);
  overdueCutoff.setUTCDate(overdueCutoff.getUTCDate() - graceDays);

  // BUG-FIX-SEC-2026-05: removed top-level `SET LOCAL app.tenant_id` —
  // outside a transaction it's silently discarded so RLS wasn't pinned.
  // Defence-in-depth: every query below explicitly filters `tenant_id =
  // tenantId`, so RLS only ever served as belt-and-braces here. Per-write
  // tx (createMany / update) opens its own implicit tx which would need its
  // own SET LOCAL — wrap individual writes if RLS must engage.

  // 0. SCHEDULED → INVOICED  (SVT-FIN-2026-08)
  //
  // THE RECEIVABLES LEDGER WAS INERT. createFeePlan writes every installment
  // as SCHEDULED (plan.service.ts), and until this step existed NOTHING in the
  // codebase ever moved one to INVOICED — the only writes of that status were
  // the SUSPENDED→INVOICED hop on plan resume. Step 1 below *filters* on
  // INVOICED; it never produced it.
  //
  // Consequences, all silent:
  //   * getOutstanding and the finance dashboard both filter
  //     status IN (INVOICED, DUE, OVERDUE, PARTIAL), so every plan reported
  //     ZERO outstanding forever. The business could not see what it was owed.
  //   * No installment ever went DUE or OVERDUE, so dunning never fired and
  //     no late fee could ever accrue.
  //   * The only way to invoice a schedule was to pause the plan and resume
  //     it, which is not a documented or discoverable workflow.
  //
  // Invoicing is what turns a planned amount into a receivable, so it runs
  // FIRST: a row can now go SCHEDULED → INVOICED → DUE within a single pass
  // when its due date has already arrived (e.g. a back-dated plan).
  //
  // Only ACTIVE plans are invoiced. A DRAFT plan is not yet a commitment and a
  // PAUSED/CANCELLED one must not start billing.
  try {
    const invoiceHorizon = new Date(today);
    invoiceHorizon.setUTCDate(invoiceHorizon.getUTCDate() + INVOICE_LEAD_DAYS);
    const toInvoice = await prisma.feeInstallment.findMany({
      where: {
        tenant_id: tenantId,
        deleted_at: null,
        status: 'SCHEDULED',
        due_on: { lte: invoiceHorizon },
        fee_plan: { status: 'ACTIVE', deleted_at: null },
      },
      select: { id: true, status: true },
      take: 5000,
    });
    for (const i of toInvoice) {
      try {
        assertOrThrow(feeInstallmentFsm, i.status as FeeInstallmentStatus, 'INVOICED', SYSTEM_ROLE);
        const wr = await prisma.feeInstallment.updateMany({
          // Status folded into the WHERE for the same stale-snapshot reason as
          // every other transition in this job.
          where: { id: i.id, tenant_id: tenantId, status: 'SCHEDULED' },
          data: {
            status: 'INVOICED',
            updated_by_id: SYSTEM_ACTOR,
            version: { increment: 1 },
          },
        });
        if (wr.count === 1) scheduled_to_invoiced += 1;
      } catch (err) {
        errors += 1;
        logger.warn({ err, installmentId: i.id, tenantId }, 'billing.daily: SCHEDULED→INVOICED failed');
      }
    }
  } catch (err) {
    errors += 1;
    logger.error({ err, tenantId }, 'billing.daily: SCHEDULED→INVOICED scan failed');
  }

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
        // cron connection.
        // SVT-FIN-2026-08 — `status` in the WHERE. The scan above can return
        // 5000 rows and the loop then makes 5000 sequential round-trips, so
        // `i.status` is a snapshot that goes stale the moment a student pays.
        // Without this predicate the cron overwrote a freshly PAID installment
        // back to DUE: a settled row re-entered the dunning pipeline, the plan
        // could never reach COMPLETED, and once late fees are enabled step 3
        // would charge a late fee on money already received. The FSM assert
        // does not catch it — it is asked about the stale status, not the
        // current one. A 0-row result now means "someone else moved it", which
        // is a no-op, not an error.
        const wr = await prisma.feeInstallment.updateMany({
          where: { id: i.id, tenant_id: tenantId, status: 'INVOICED' },
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
        // SVT-FIN-2026-08 — same stale-snapshot guard as step 1.
        const wr = await prisma.feeInstallment.updateMany({
          where: { id: i.id, tenant_id: tenantId, status: 'DUE' },
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
  //
  // SVT-FIN-2026-08 — this entire block was unreachable. The gate was
  // `policy.enabled`, and `policy` came from `parsePolicy(null)`, so `enabled`
  // was `Boolean(undefined)` — false, always, for every tenant. Roughly eighty
  // lines of careful, correct late-fee machinery had never executed once, while
  // reading to any auditor (or any competitor reading the repo) as a shipped
  // feature. The comment above it blamed a `tenant.settings` JSON column that
  // does not exist on Tenant in any migration.
  //
  // `FeePlan.late_fee_policy Json?` DOES exist, so the policy is now read per
  // plan. That is also the safer default: a plan whose policy is null stays
  // disabled, so no late fee can ever land on a bill unless that specific plan
  // opted in. Nothing starts charging as a side effect of this fix.
  try {
    const candidates = await prisma.feeInstallment.findMany({
      where: {
        tenant_id: tenantId,
        deleted_at: null,
        status: 'OVERDUE',
      },
      select: {
        id: true,
        currency: true,
        fee_plan: { select: { late_fee_policy: true } },
        adjustments: {
          where: { kind: 'LATE_FEE', applied_on: today },
          select: { id: true },
        },
        _count: { select: { adjustments: { where: { kind: 'LATE_FEE' } } } },
      },
      take: 5000,
    });
    for (const inst of candidates) {
      const policy = parsePolicy(inst.fee_plan?.late_fee_policy);
      if (!policy.enabled || policy.amount_minor == null) continue;
      // The amount arrives from a JSON column, so it is untrusted input:
      // BigInt() throws on anything non-integral.
      let amountMinor: bigint;
      try {
        amountMinor = BigInt(policy.amount_minor);
      } catch {
        errors += 1;
        logger.warn(
          { tenantId, installmentId: inst.id, amount: policy.amount_minor },
          'billing.daily: late_fee_policy.amount_minor is not an integer',
        );
        continue;
      }
      if (amountMinor <= 0n) {
        logger.warn(
          { tenantId, installmentId: inst.id },
          'billing.daily: late_fee_policy.amount_minor must be > 0',
        );
        continue;
      }
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
  } catch (err) {
    errors += 1;
    logger.error({ err, tenantId }, 'billing.daily: late_fee policy execution failed');
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
          // SVT-FIN-2026-08 — assert the from-state we actually read, and fold
          // it into the WHERE. This was hardcoded 'ACTIVE' with no status
          // predicate, so a plan an admin CANCELLED between the scan and this
          // write was flipped to COMPLETED — one terminal state overwriting
          // another, with no edge between them in the machine.
          assertOrThrow(feePlanFsm, p.status, 'COMPLETED', SYSTEM_ROLE);
          const pwr = await prisma.feePlan.updateMany({
            where: { id: p.id, tenant_id: tenantId, status: p.status },
            data: {
              status: 'COMPLETED',
              ends_on: today,
              updated_by_id: SYSTEM_ACTOR,
              version: { increment: 1 },
            },
          });
          if (pwr.count !== 1) {
            // Lost the race; the plan moved on. Not an error, just not ours.
            continue;
          }
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

  return { scheduled_to_invoiced, invoiced_to_due, due_to_overdue, late_fees_applied, plans_completed, errors };
}

export async function runBillingDaily(): Promise<JobOutcome> {
  const tenants = await prisma.tenant.findMany({
    where: { is_active: true, billing_enabled: true },
    select: { id: true },
  });

  let totals = {
    scheduled_to_invoiced: 0,
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
      totals.scheduled_to_invoiced += r.scheduled_to_invoiced;
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
