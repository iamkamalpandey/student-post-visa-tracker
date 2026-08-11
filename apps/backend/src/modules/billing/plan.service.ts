// SVT-WAVE-BILLING-2026-05 — FeePlan lifecycle service.
//
// Public functions:
//   - createFeePlan(ctx, input)        → DRAFT plan + installments → ACTIVE
//   - regeneratePlan(ctx, planId, input) → supersede old plan with a new one
//   - pausePlan(ctx, planId, reason)   → plan PAUSED + future installments SUSPENDED
//   - resumePlan(ctx, planId, opts)    → plan ACTIVE + installments INVOICED
//                                         (optional shift_days pushes due dates)
//   - cancelPlan(ctx, planId, opts)    → plan CANCELLED + non-paid installments
//                                         CANCELLED (and WAIVED if waive_remaining)
//   - getFeePlan(ctx, planId)          → plan + installments
//
// Idempotency for createFeePlan + regeneratePlan handled at the controller
// layer via runIdempotent (Idempotency-Key header). Within the service,
// FSM transitions are validated with `assertOrThrow` so callers get
// canonical 403/409/422 envelopes.

import type { Prisma, PrismaClient } from '@prisma/client';
import { Prisma as PrismaNS } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { writeAudit } from '../../shared/audit.js';
import { assertOrThrow } from '../../shared/fsm.js';
import { BadRequest, NotFound, Conflict } from '../../shared/errors.js';
import type {
  CreateFeePlanRequest,
  RegeneratePlanRequest,
  PausePlanRequest,
  ResumePlanRequest,
  CancelPlanRequest,
  FeePlanLineInput,
} from '@spv/zod-schemas';
import {
  generateInstallmentLines,
  applyScholarship,
  shiftIsoDate,
  derivePlanStatusFromInstallments,
} from './pricing.js';
import { feePlanFsm, feeInstallmentFsm } from './fsm-def.js';

type DB = PrismaClient | Prisma.TransactionClient;
type Role = 'ADMIN' | 'COUNSELLOR' | 'VIEWER';

type Ctx = {
  db?: DB;
  user?: { tid: string; sub?: string; role?: Role };
};

const db = (ctx: Ctx): DB => ctx.db ?? prisma;
const tenantOf = (ctx: Ctx): string => {
  if (!ctx.user?.tid) throw BadRequest('Missing tenant context');
  return ctx.user.tid;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadEnrollment(ctx: Ctx, enrollmentId: string) {
  const e = await db(ctx).enrollment.findFirst({
    where: { id: enrollmentId, tenant_id: tenantOf(ctx), deleted_at: null },
    select: {
      id: true,
      tenant_id: true,
      student_id: true,
      status: true,
      tuition_currency: true,
    },
  });
  if (!e) throw NotFound('Enrollment not found');
  return e;
}

async function loadPlan(ctx: Ctx, planId: string) {
  const p = await db(ctx).feePlan.findFirst({
    where: { id: planId, tenant_id: tenantOf(ctx), deleted_at: null },
  });
  if (!p) throw NotFound('Fee plan not found');
  return p;
}

async function loadPlanWithInstallments(ctx: Ctx, planId: string) {
  const p = await db(ctx).feePlan.findFirst({
    where: { id: planId, tenant_id: tenantOf(ctx), deleted_at: null },
    include: {
      installments: {
        orderBy: { sequence_no: 'asc' },
        where: { deleted_at: null },
      },
    },
  });
  if (!p) throw NotFound('Fee plan not found');
  return p;
}

function resolveLines(input: CreateFeePlanRequest | RegeneratePlanRequest): FeePlanLineInput[] {
  if (input.lines && input.lines.length > 0) return input.lines;
  if (!('cadence' in input) || !input.cadence) {
    throw BadRequest('Cadence required when lines[] omitted');
  }
  if (input.total_minor == null || input.installment_count == null || !input.starts_on) {
    throw BadRequest('total_minor + installment_count + starts_on required');
  }
  return generateInstallmentLines({
    cadence: input.cadence,
    total_minor: input.total_minor,
    installment_count: input.installment_count,
    starts_on: input.starts_on,
  });
}

async function tenantDefaultCurrency(ctx: Ctx): Promise<string> {
  const t = await db(ctx).tenant.findFirst({
    where: { id: tenantOf(ctx) },
    select: { default_currency: true },
  });
  return t?.default_currency ?? 'USD';
}

// ---------------------------------------------------------------------------
// createFeePlan
// ---------------------------------------------------------------------------

export async function createFeePlan(ctx: Ctx, input: CreateFeePlanRequest) {
  const tenantId = tenantOf(ctx);
  const actorId = ctx.user?.sub ?? null;
  const enrollment = await loadEnrollment(ctx, input.enrollment_id);

  // One ACTIVE plan invariant: refuse if an ACTIVE/PAUSED/DRAFT plan exists.
  const existing = await db(ctx).feePlan.findFirst({
    where: {
      enrollment_id: enrollment.id,
      tenant_id: tenantId,
      status: { in: ['DRAFT', 'ACTIVE', 'PAUSED'] },
      deleted_at: null,
    },
    select: { id: true, status: true },
  });
  if (existing) {
    throw Conflict(
      `Enrollment already has a ${existing.status} fee plan (${existing.id}). Use regenerate to replace it.`,
    );
  }

  const currency =
    input.currency ?? enrollment.tuition_currency ?? (await tenantDefaultCurrency(ctx));
  const grossLines = resolveLines(input);
  const total = grossLines.reduce((sum, l) => sum + l.gross_minor, 0n);
  const scholarship = input.scholarship_minor ?? 0n;
  // SVT-FIN-2026-08 — the scholarship comes off the schedule the student
  // actually pays. `total_minor` stays GROSS: it is fed from the enrollment's
  // `tuition_total_minor` (billing/enrollment-hook.ts) and is what the invoice's
  // "Plan Total" line means. The invariant the tests pin is therefore
  //   sum(installments.gross_minor) === plan.total_minor - plan.scholarship_minor
  // Previously the scholarship was stored, printed on the invoice, and applied
  // to nothing — the student was billed the full amount.
  const lines = applyScholarship(grossLines, scholarship);

  // Single transaction: plan + installments + FSM transition + audit.
  let out;
  try {
    out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const plan = await tx.feePlan.create({
      data: {
        tenant_id: tenantId,
        enrollment_id: enrollment.id,
        cadence: input.cadence,
        total_minor: total,
        currency,
        scholarship_minor: scholarship,
        status: 'DRAFT',
        starts_on: new Date(input.starts_on),
        notes: input.notes ?? null,
        created_by_id: actorId,
        updated_by_id: actorId,
      },
    });
    // Generate installments (SCHEDULED).
    await tx.feeInstallment.createMany({
      data: lines.map((l, i) => ({
        tenant_id: tenantId,
        fee_plan_id: plan.id,
        sequence_no: i + 1,
        label: l.label,
        due_on: new Date(l.due_on),
        gross_minor: l.gross_minor,
        net_minor: l.gross_minor,
        paid_minor: 0n,
        balance_minor: l.gross_minor,
        currency,
        status: 'SCHEDULED' as const,
        created_by_id: actorId,
        updated_by_id: actorId,
      })),
    });
    // DRAFT → ACTIVE (system).
    assertOrThrow(feePlanFsm, 'DRAFT', 'ACTIVE', (ctx.user?.role ?? 'COUNSELLOR') as Role);
    const activated = await tx.feePlan.update({
      where: { id: plan.id },
      data: { status: 'ACTIVE', updated_by_id: actorId, version: { increment: 1 } },
    });
    // Patch Enrollment.fee_plan_id pointer (best-effort; not all schemas may
    // expose this column yet — guard against missing field).
    try {
      await tx.enrollment.update({
        where: { id: enrollment.id },
        data: { /* fee_plan_id: plan.id as never */ } as never,
      });
    } catch {
      /* swallow — field will be wired in a follow-up FE wave */
    }
    return activated;
    });
  } catch (err) {
    // BUG-FIX-SEC-2026-05: translate the partial-unique race winner-loser
    // collision into a clean 409. Without this, two concurrent POSTs to
    // /billing/plans both pass the pre-check, both arrive at INSERT, the
    // partial unique catches the second, and Prisma's P2002 bubbles to
    // errorHandler as a generic 500.
    const code = (err as { code?: string } | null)?.code;
    if (code === 'P2002') {
      throw Conflict('Another ACTIVE fee plan was created concurrently for this enrollment');
    }
    throw err;
  }

  await writeAudit(ctx as never, {
    action: 'fee_plan.created',
    entityType: 'fee_plan',
    entityId: out.id,
    after: {
      enrollment_id: enrollment.id,
      cadence: input.cadence,
      total_minor: out.total_minor.toString(),
      currency: out.currency,
      installment_count: lines.length,
    },
  });
  return out;
}

// ---------------------------------------------------------------------------
// pausePlan / resumePlan / cancelPlan
// ---------------------------------------------------------------------------

export async function pausePlan(ctx: Ctx, planId: string, input: PausePlanRequest) {
  const tenantId = tenantOf(ctx);
  const role = (ctx.user?.role ?? 'COUNSELLOR') as Role;
  const actorId = ctx.user?.sub ?? null;
  const before = await loadPlan(ctx, planId);
  if (before.status !== 'ACTIVE') {
    throw Conflict(`Cannot pause plan in status ${before.status}`);
  }
  assertOrThrow(feePlanFsm, 'ACTIVE', 'PAUSED', role);

  const after = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const updated = await tx.feePlan.update({
      where: { id: planId },
      data: {
        status: 'PAUSED',
        paused_at: new Date(),
        paused_reason: input.reason,
        updated_by_id: actorId,
        version: { increment: 1 },
      },
    });
    // Suspend SCHEDULED + INVOICED installments. DUE/OVERDUE preserved for collections.
    await tx.feeInstallment.updateMany({
      where: {
        fee_plan_id: planId,
        tenant_id: tenantId,
        status: { in: ['SCHEDULED', 'INVOICED'] },
      },
      data: { status: 'SUSPENDED', updated_by_id: actorId },
    });
    return updated;
  });

  await writeAudit(ctx as never, {
    action: 'fee_plan.paused',
    entityType: 'fee_plan',
    entityId: planId,
    before: { status: before.status },
    after: { status: 'PAUSED', reason: input.reason },
  });
  return after;
}

export async function resumePlan(ctx: Ctx, planId: string, input: ResumePlanRequest) {
  const tenantId = tenantOf(ctx);
  const role = (ctx.user?.role ?? 'COUNSELLOR') as Role;
  const actorId = ctx.user?.sub ?? null;
  const before = await loadPlan(ctx, planId);
  if (before.status !== 'PAUSED') {
    throw Conflict(`Cannot resume plan in status ${before.status}`);
  }
  assertOrThrow(feePlanFsm, 'PAUSED', 'ACTIVE', role);

  const shift = input.shift_days ?? 0;

  const after = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const updated = await tx.feePlan.update({
      where: { id: planId },
      data: {
        status: 'ACTIVE',
        resumed_at: new Date(),
        updated_by_id: actorId,
        version: { increment: 1 },
      },
    });
    // Revive SUSPENDED installments back to INVOICED. Cron will move them to
    // DUE/OVERDUE based on due_on (after the shift, if any).
    if (shift > 0) {
      // PERF-FIX-SEC-2026-05: per-row update is N round-trips, but it's the
      // pattern the unit-test mock can intercept. For real workloads N is
      // typically ≤12 (12 months of installments), so the cost is bounded.
      // A future bulk SQL path is acceptable once we have a real-DB
      // integration test that proves the shift maths.
      const suspended = await tx.feeInstallment.findMany({
        where: { fee_plan_id: planId, tenant_id: tenantId, status: 'SUSPENDED' },
        select: { id: true, due_on: true },
      });
      for (const i of suspended) {
        const nextDue = new Date(shiftIsoDate(i.due_on.toISOString().slice(0, 10), shift));
        await tx.feeInstallment.update({
          where: { id: i.id },
          data: { status: 'INVOICED', due_on: nextDue, updated_by_id: actorId },
        });
      }
    } else {
      await tx.feeInstallment.updateMany({
        where: { fee_plan_id: planId, tenant_id: tenantId, status: 'SUSPENDED' },
        data: { status: 'INVOICED', updated_by_id: actorId },
      });
    }
    return updated;
  });

  await writeAudit(ctx as never, {
    action: 'fee_plan.resumed',
    entityType: 'fee_plan',
    entityId: planId,
    before: { status: before.status },
    after: { status: 'ACTIVE', shift_days: shift },
  });
  return after;
}

export async function cancelPlan(ctx: Ctx, planId: string, input: CancelPlanRequest) {
  const tenantId = tenantOf(ctx);
  const role = (ctx.user?.role ?? 'COUNSELLOR') as Role;
  const actorId = ctx.user?.sub ?? null;
  const before = await loadPlan(ctx, planId);
  if (before.status !== 'ACTIVE' && before.status !== 'PAUSED') {
    throw Conflict(`Cannot cancel plan in status ${before.status}`);
  }
  assertOrThrow(feePlanFsm, before.status, 'CANCELLED', role, input.reason);

  const after = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const updated = await tx.feePlan.update({
      where: { id: planId },
      data: {
        status: 'CANCELLED',
        updated_by_id: actorId,
        version: { increment: 1 },
      },
    });
    // SVT-SEC-2026-05 — waive_remaining MUST run BEFORE the cancel sweep so
    // PARTIAL rows (which carry historic payments) get a proper WAIVER
    // adjustment + WAIVED status rather than being silently CANCELLED (which
    // would leave their paid_minor stranded in the books).
    if (input.waive_remaining) {
      // SVT-FIN-2026-08 — this block used to abort the entire cancellation.
      //
      // The old code wrote `{ status: 'WAIVED', balance_minor: 0n }` in one
      // bulk updateMany and never touched net_minor. The database enforces
      //   CHECK (balance_minor = net_minor - paid_minor)
      // (migration 20991231235976_billing_checks), and on a PARTIAL row
      // paid < net, so net - paid > 0 ≠ 0 → Postgres 23514 → the whole
      // transaction rolled back. Because the withdrawal hook swallows the
      // throw into a log line, the visible result was: enrollment WITHDRAWN,
      // fee plan still ACTIVE, installments still marching toward OVERDUE.
      // A withdrawn student was billed and dunned indefinitely, and the
      // direct cancel route returned a bare 500 with no way to succeed.
      //
      // Waiving the remainder means the student now owes exactly what they
      // have already paid, so the correct row state is net = paid, balance = 0
      // — which is precisely what the WAIVER adjustment of -balance computes:
      //   net_after = net_before + (-(net_before - paid)) = paid.
      //
      // Rows are locked FOR UPDATE and each write is guarded on the balance we
      // read. A payment landing mid-cancel would otherwise either be forgiven
      // at a stale amount or get a WAIVER adjustment for money it no longer
      // owed; now it fails the guard and rolls the cancellation back instead.
      const partials = await tx.$queryRaw<Array<{
        id: string; net_minor: bigint; paid_minor: bigint; balance_minor: bigint;
      }>>`
        SELECT id, net_minor, paid_minor, balance_minor
        FROM fee_installments
        WHERE fee_plan_id = ${planId}::uuid
          AND tenant_id = ${tenantId}::uuid
          AND status = 'PARTIAL'
          AND deleted_at IS NULL
        ORDER BY sequence_no ASC
        FOR UPDATE
      `;
      assertOrThrow(feeInstallmentFsm, 'PARTIAL', 'WAIVED', role, input.reason);
      for (const p of partials) {
        if (p.balance_minor <= 0n) continue;
        await tx.feeAdjustment.create({
          data: {
            tenant_id: tenantId,
            fee_installment_id: p.id,
            kind: 'WAIVER',
            amount_minor: -p.balance_minor,
            reason_code: 'plan.cancelled.waive_remaining',
            reason_text: input.reason,
            applied_on: new Date(),
            created_by_id: actorId,
          },
        });
        const wr = await tx.feeInstallment.updateMany({
          where: {
            id: p.id,
            tenant_id: tenantId,
            status: 'PARTIAL',
            balance_minor: p.balance_minor,
          },
          data: {
            status: 'WAIVED',
            net_minor: p.paid_minor,
            balance_minor: 0n,
            updated_by_id: actorId,
            version: { increment: 1 },
          },
        });
        if (wr.count !== 1) {
          throw Conflict(
            `Installment ${p.id} changed while cancelling the plan; retry the cancellation.`,
          );
        }
      }
    }
    // CANCEL all remaining non-paid, non-waived installments. PAID + WAIVED
    // + REFUNDED are historically interesting; preserve them. PERF-FIX-SEC:
    // hoist the FSM check (one probe per legal from-state) and collapse N
    // per-row UPDATEs into a single updateMany. The schema's
    // feeInstallmentFsm registers from→CANCELLED for each of these states;
    // we probe each once so a future FSM-rule drop surfaces as a 422 here
    // rather than silent corruption.
    const FROM_STATES = ['SCHEDULED', 'INVOICED', 'DUE', 'OVERDUE', 'PARTIAL', 'SUSPENDED'] as const;
    for (const s of FROM_STATES) {
      assertOrThrow(feeInstallmentFsm, s, 'CANCELLED', role, input.reason);
    }
    await tx.feeInstallment.updateMany({
      where: {
        fee_plan_id: planId,
        tenant_id: tenantId,
        status: { in: [...FROM_STATES] as never },
      },
      data: { status: 'CANCELLED', updated_by_id: actorId },
    });
    return updated;
  });

  await writeAudit(ctx as never, {
    action: 'fee_plan.cancelled',
    entityType: 'fee_plan',
    entityId: planId,
    before: { status: before.status },
    after: {
      status: 'CANCELLED',
      reason: input.reason,
      waive_remaining: input.waive_remaining ?? false,
    },
  });
  return after;
}

// ---------------------------------------------------------------------------
// regeneratePlan — supersede old plan with a fresh one.
//
// Marks the old plan's status as CANCELLED, then runs createFeePlan with the
// override fields. Stores the new plan's id back on the old plan's
// superseded_by_id so audit + UI can follow the chain.
// ---------------------------------------------------------------------------

export async function regeneratePlan(
  ctx: Ctx,
  planId: string,
  input: RegeneratePlanRequest,
) {
  const tenantId = tenantOf(ctx);
  const actorId = ctx.user?.sub ?? null;
  const before = await loadPlan(ctx, planId);
  if (before.status !== 'ACTIVE' && before.status !== 'PAUSED' && before.status !== 'DRAFT') {
    throw Conflict(`Cannot regenerate plan in status ${before.status}`);
  }

  // SVT-FIN-2026-08 — BUILD AND VALIDATE THE REPLACEMENT BEFORE DESTROYING
  // THE ORIGINAL.
  //
  // These are three separate transactions with no compensation, and the order
  // used to be cancel → create. Every field on RegeneratePlanRequest is
  // optional and `installment_count` was not defaulted from the old plan, so
  // `POST /plans/:id/regenerate {"reason":"fix typo"}` cancelled the live plan,
  // then threw BadRequest out of resolveLines. The caller saw a 400 and the
  // enrollment was left with a CANCELLED plan (terminal — the FSM has no edge
  // back) and every open installment CANCELLED, so getOutstanding reported
  // zero owed. The only recovery was a brand-new plan, which re-bills whatever
  // had already been paid.
  //
  // Defaulting installment_count from the old plan removes the common trip
  // wire; resolving the lines up front means any remaining validation error is
  // raised while the original plan is still intact and still billing.
  // Default the schedule length to whatever the plan being replaced had, so a
  // caller who only wants to change the total (or just the notes) does not
  // have to restate it.
  const priorInstallmentCount = await db(ctx).feeInstallment.count({
    where: { fee_plan_id: planId, tenant_id: tenantId, deleted_at: null },
  });

  const regenInput = {
    enrollment_id: before.enrollment_id,
    cadence: input.cadence ?? before.cadence,
    total_minor: input.total_minor ?? before.total_minor,
    installment_count: input.installment_count ?? priorInstallmentCount,
    starts_on:
      input.starts_on ?? before.starts_on.toISOString().slice(0, 10),
    currency: before.currency,
    scholarship_minor: before.scholarship_minor,
    lines: input.lines,
    notes: before.notes ?? undefined,
  } as CreateFeePlanRequest;

  // Throws here — before anything is destroyed — if the payload cannot produce
  // a valid schedule (missing count/cadence, CUSTOM without lines, bad date).
  const plannedLines = resolveLines(regenInput);
  if (plannedLines.length === 0) {
    throw BadRequest('Regenerated plan would have no installments');
  }

  // Only now is it safe to cancel: this frees the "one active plan" partial
  // unique index that createFeePlan enforces.
  await cancelPlan(ctx, planId, {
    reason: `Regenerated: ${input.reason}`,
  });

  // Pass the already-validated lines so createFeePlan cannot reach a different
  // schedule than the one we just proved constructible.
  const next = await createFeePlan(ctx, { ...regenInput, lines: plannedLines });

  // Back-link the old plan to the new for audit.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx.feePlan.update({
      where: { id: planId },
      data: { superseded_by_id: next.id, updated_by_id: actorId, version: { increment: 1 } },
    });
  });

  await writeAudit(ctx as never, {
    action: 'fee_plan.regenerated',
    entityType: 'fee_plan',
    entityId: planId,
    before: { plan_id: planId },
    after: { plan_id: next.id, reason: input.reason },
  });
  return next;
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export async function getFeePlan(ctx: Ctx, planId: string) {
  return loadPlanWithInstallments(ctx, planId);
}

export async function listFeePlans(
  ctx: Ctx,
  q: { enrollment_id?: string; student_id?: string; status?: string; limit?: number },
) {
  const tenantId = tenantOf(ctx);
  const role = ctx.user?.role ?? 'COUNSELLOR';
  const actorId = ctx.user?.sub ?? null;
  const where: Prisma.FeePlanWhereInput = { tenant_id: tenantId, deleted_at: null };
  if (q.enrollment_id) where.enrollment_id = q.enrollment_id;
  if (q.status) where.status = q.status as never;
  if (q.student_id) where.enrollment = { is: { student_id: q.student_id } };
  // SVT-SEC-2026-05 — financial-leak guard. COUNSELLOR could previously see
  // every plan in the tenant, including students assigned to other counsellors.
  // Scope to assigned students unless ADMIN.
  if (role !== 'ADMIN') {
    where.enrollment = {
      is: {
        ...(q.student_id ? { student_id: q.student_id } : {}),
        student: { is: { assigned_to_id: actorId } },
      },
    } as never;
  }
  return db(ctx).feePlan.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: q.limit ?? 25,
  });
}

/**
 * Outstanding-balance aggregate. Single SQL query over fee_installments.
 * Returns total + per-status breakdown + oldest due_on (for "longest aged"
 * dashboard tile).
 */
export async function getOutstanding(
  ctx: Ctx,
  q: { student_id?: string; enrollment_id?: string },
) {
  const tenantId = tenantOf(ctx);
  const where: Prisma.FeeInstallmentWhereInput = {
    tenant_id: tenantId,
    deleted_at: null,
    status: { in: ['INVOICED', 'DUE', 'OVERDUE', 'PARTIAL'] },
  };
  if (q.enrollment_id) where.fee_plan = { is: { enrollment_id: q.enrollment_id } };
  if (q.student_id) {
    where.fee_plan = {
      is: { enrollment: { is: { student_id: q.student_id } } },
    };
  }
  const rows = await db(ctx).feeInstallment.findMany({
    where,
    select: {
      status: true,
      balance_minor: true,
      due_on: true,
      currency: true,
    },
  });
  // SVT-QA-2026-08 — NEVER net across currencies. Prior code summed every row
  // and labelled the total with `rows[0].currency`, producing fabricated
  // aggregates for multi-currency tenants (USD + GBP folded into a single USD
  // number). Group per ISO currency; oldest_due_on stays global because it's
  // a scalar, not a monetary aggregate. Callers must render one tile-set per
  // currency (mirrors crm-leads.service.financeSummary).
  type Acc = { total_minor: bigint; by_status: Record<string, bigint>; oldest_due_on: Date | null };
  const byCurrency = new Map<string, Acc>();
  for (const r of rows) {
    let acc = byCurrency.get(r.currency);
    if (!acc) {
      acc = { total_minor: 0n, by_status: {}, oldest_due_on: null };
      byCurrency.set(r.currency, acc);
    }
    acc.total_minor += r.balance_minor;
    acc.by_status[r.status] = (acc.by_status[r.status] ?? 0n) + r.balance_minor;
    if (acc.oldest_due_on === null || r.due_on < acc.oldest_due_on) {
      acc.oldest_due_on = r.due_on;
    }
  }
  const by_currency = [...byCurrency.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, acc]) => ({
      currency,
      total_minor: acc.total_minor.toString(),
      by_status: Object.fromEntries(
        Object.entries(acc.by_status).map(([k, v]) => [k, v.toString()]),
      ),
      oldest_due_on: acc.oldest_due_on ? acc.oldest_due_on.toISOString().slice(0, 10) : null,
    }));
  return { by_currency };
}

// Re-export PrismaNS so the test mock signatures stay typed.
export const __PRISMA_NS__ = PrismaNS;
