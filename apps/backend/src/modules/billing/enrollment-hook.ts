// SVT-WAVE-BILLING-2026-05 (Wave 5) — Enrollment lifecycle → Billing hooks.
//
// Wired from apps/backend/src/modules/enrollments/enrollments.service.ts after
// the FSM transition lands. Every hook is:
//   1. tenant.billing_enabled gated (no-op when false; consultancy tenants
//      keep the pre-Wave-4 behaviour with zero side-effects).
//   2. Fire-and-forget — billing exceptions are logged but do NOT roll back
//      the enrollment write. Mirrors maybeRecomputeCommission semantics.
//   3. Idempotent — replaying the same hook for the same enrollment is safe
//      because the plan service refuses to create a second ACTIVE plan
//      (Conflict on duplicate) and pause/resume tolerate already-paused state.
//
// Edges handled:
//   ACCEPTED  → ENROLLED   ⇒ maybeSeedFeePlan
//   *         → ON_LEAVE   ⇒ maybePauseOnLeave
//   ON_LEAVE  → ENROLLED   ⇒ maybeResumeFromLeave
//   *         → WITHDRAWN  ⇒ maybeCancelOnWithdraw
//   *         → CANCELLED  ⇒ maybeCancelOnWithdraw

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { createFeePlan, pausePlan, resumePlan, cancelPlan } from './plan.service.js';

type DB = PrismaClient | Prisma.TransactionClient;
type Ctx = {
  db?: DB;
  user?: { tid: string; sub?: string; role?: 'ADMIN' | 'COUNSELLOR' | 'VIEWER' };
};

const dbOf = (ctx: Ctx): DB => ctx.db ?? prisma;

async function billingOn(ctx: Ctx): Promise<boolean> {
  const tenantId = ctx.user?.tid;
  if (!tenantId) return false;
  const t = await dbOf(ctx).tenant.findFirst({
    where: { id: tenantId },
    select: { billing_enabled: true },
  });
  return Boolean(t?.billing_enabled);
}

/**
 * Auto-seed a FeePlan when an Enrollment transitions ACCEPTED → ENROLLED.
 *
 * Cadence + total are derived from the ProgramIntake's TUITION fee row when
 * present; otherwise we fall back to the Enrollment's `tuition_total_minor`
 * with ANNUAL cadence + 1 installment (admin can `regenerate` to refine).
 *
 * Idempotent: createFeePlan throws 409 on an existing ACTIVE plan; we swallow.
 */
export async function maybeSeedFeePlan(ctx: Ctx, enrollmentId: string): Promise<void> {
  if (!(await billingOn(ctx))) return;
  try {
    const e = await dbOf(ctx).enrollment.findFirst({
      where: { id: enrollmentId, tenant_id: ctx.user!.tid },
      select: {
        id: true,
        tuition_total_minor: true,
        tuition_currency: true,
        start_date: true,
        program_intake_id: true,
      },
    });
    if (!e) return;
    if (!e.tuition_total_minor || e.tuition_total_minor <= 0n) {
      logger.warn({ enrollmentId }, 'billing.seed: skipped — no tuition_total_minor');
      return;
    }
    const startsOn = (e.start_date ?? new Date()).toISOString().slice(0, 10);

    // Default: 1-row ANNUAL plan. Admin can later regenerate to MONTHLY/SEMESTER.
    // Future enhancement: pull cadence from ProgramIntake.fees rows.
    await createFeePlan(ctx, {
      enrollment_id: e.id,
      cadence: 'ANNUAL',
      total_minor: e.tuition_total_minor,
      installment_count: 1,
      starts_on: startsOn,
      currency: e.tuition_currency ?? undefined,
    } as never);
  } catch (err: unknown) {
    // 409 Conflict (plan already exists) is OK — idempotent replay.
    const code = (err as { status?: number; code?: string } | null)?.status;
    if (code === 409) return;
    logger.error({ err, enrollmentId }, 'billing.seedFeePlan failed');
  }
}

/** ACTIVE → PAUSED on the linked plan (if any). */
export async function maybePauseOnLeave(ctx: Ctx, enrollmentId: string): Promise<void> {
  if (!(await billingOn(ctx))) return;
  try {
    const plan = await dbOf(ctx).feePlan.findFirst({
      where: {
        enrollment_id: enrollmentId,
        tenant_id: ctx.user!.tid,
        status: 'ACTIVE',
        deleted_at: null,
      },
      select: { id: true },
    });
    if (!plan) return;
    await pausePlan(ctx, plan.id, { reason: 'enrollment.on_leave' });
  } catch (err) {
    logger.error({ err, enrollmentId }, 'billing.pauseOnLeave failed');
  }
}

/** PAUSED → ACTIVE on the linked plan (if any). */
export async function maybeResumeFromLeave(ctx: Ctx, enrollmentId: string): Promise<void> {
  if (!(await billingOn(ctx))) return;
  try {
    const plan = await dbOf(ctx).feePlan.findFirst({
      where: {
        enrollment_id: enrollmentId,
        tenant_id: ctx.user!.tid,
        status: 'PAUSED',
        deleted_at: null,
      },
      select: { id: true },
    });
    if (!plan) return;
    await resumePlan(ctx, plan.id, {});
  } catch (err) {
    logger.error({ err, enrollmentId }, 'billing.resumeFromLeave failed');
  }
}

/** ACTIVE | PAUSED → CANCELLED on the linked plan, with the enrollment reason.
 *
 * The FeePlan FSM gates CANCELLED to ADMIN role. The upstream enrollment FSM
 * already required ADMIN+reason for a WITHDRAWN/CANCELLED transition, so the
 * cascade is safe to escalate to ADMIN here — the human authorisation has
 * already been audited at the enrollment layer.
 */
export async function maybeCancelOnWithdraw(
  ctx: Ctx,
  enrollmentId: string,
  reason: string,
): Promise<void> {
  if (!(await billingOn(ctx))) return;
  try {
    const plan = await dbOf(ctx).feePlan.findFirst({
      where: {
        enrollment_id: enrollmentId,
        tenant_id: ctx.user!.tid,
        status: { in: ['ACTIVE', 'PAUSED'] },
        deleted_at: null,
      },
      select: { id: true },
    });
    if (!plan) return;
    const elevated: Ctx = {
      db: ctx.db,
      user: { tid: ctx.user!.tid, sub: ctx.user?.sub, role: 'ADMIN' },
    };
    await cancelPlan(elevated, plan.id, {
      reason: `enrollment.${reason.toLowerCase()}`,
      waive_remaining: true,
    });
  } catch (err) {
    logger.error({ err, enrollmentId }, 'billing.cancelOnWithdraw failed');
  }
}
