import type { Prisma, EnrollmentStatus, UserRole } from '@prisma/client';
import type {
  CreateEnrollmentRequest,
  EnrollmentListQuery,
  UpdateEnrollmentRequest,
} from '@spv/zod-schemas';

import { Conflict, Forbidden, HttpError, NotFound, PreconditionFailed, UnprocessableEntity } from '../../shared/errors.js';
import { isLinkedToInstitution } from '../super-agents/service.js';
import { logger } from '../../config/logger.js';
import { writeAudit } from '../../shared/audit.js';
import { notifyStatusTransition } from '../../shared/transitionNotify.js';
import { upsertClaimForEnrollment } from '../commissions/recalculator.js';
import { maybeSeedFeePlan, maybePauseOnLeave, maybeResumeFromLeave, maybeCancelOnWithdraw } from '../billing/enrollment-hook.js';
import { assertTransitionAllowed } from './fsm.js';
import type { Db } from './enrollments.types.js';

type Ctx = { db: Db; tenantId: string; actorId: string };
type WriteCtx = Ctx & { actorRole?: UserRole };
type ReadCtx = { db: Db; tenantId: string };

// Tuition fields are economically locked once the linked CommissionClaim
// has been billed or paid — editing them after the fact would silently
// invalidate an invoice / receipt. Admins may override with
// allow_locked_field_edit=true on the PATCH body.
const COMMISSION_LOCK_STATUSES = new Set<string>(['INVOICED', 'PAID']);
const TUITION_LOCKED_FIELDS = [
  'tuition_total_minor',
  'tuition_currency',
  'scholarship_minor',
  'agent_commission_minor',
] as const;

// Status transitions on which the institution → consultancy commission
// claim should be (re)computed. Deliberately narrow: we only fire when the
// enrollment just *became* claimable. Previously we recomputed on every
// ACCEPTED/ENROLLED PATCH — even a notes edit triggered a recalc, which
// papered over the FSM bug by rewriting the claim after illegal flips.
const COMMISSION_TRIGGER_TRANSITIONS = new Set<string>([
  'OFFERED->ACCEPTED',
  'ACCEPTED->ENROLLED',
]);

/**
 * Fire-and-forget hook: after a *gated* status transition, recompute /
 * upsert the linked CommissionClaim. Errors are swallowed (recalculator
 * already logs) so a flaky commission calculation never rolls back the
 * enrollment write. Pass `prevStatus` so the gate sees the actual edge.
 */
async function maybeRecomputeCommission(
  ctx: Ctx,
  enrollmentId: string,
  prevStatus: string | null | undefined,
  nextStatus: string | null | undefined,
): Promise<void> {
  if (!prevStatus || !nextStatus || prevStatus === nextStatus) return;
  if (!COMMISSION_TRIGGER_TRANSITIONS.has(`${prevStatus}->${nextStatus}`)) return;
  try {
    await upsertClaimForEnrollment(
      { db: ctx.db, user: { tid: ctx.tenantId, sub: ctx.actorId } },
      enrollmentId,
    );
  } catch (err) {
    logger.error({ err, enrollmentId }, 'commission recalculation hook failed');
  }
}

/**
 * Same hook, but used on the create path where there is no `prevStatus`.
 * Fires on whichever creation status would trigger a claim (ACCEPTED /
 * ENROLLED) — preserves the original behaviour for newly-created rows.
 */
async function maybeRecomputeCommissionOnCreate(
  ctx: Ctx,
  enrollmentId: string,
  status: string | null | undefined,
): Promise<void> {
  if (status !== 'ACCEPTED' && status !== 'ENROLLED') return;
  try {
    await upsertClaimForEnrollment(
      { db: ctx.db, user: { tid: ctx.tenantId, sub: ctx.actorId } },
      enrollmentId,
    );
  } catch (err) {
    logger.error({ err, enrollmentId }, 'commission recalculation hook failed');
  }
}

// -----------------------------------------------------------------------------
// Consistency: program_id must belong to institution_id, intake (if any) must
// belong to that program, campus (if any) must belong to that institution.
// We surface these as 422 since the request is well-formed but semantically
// inconsistent.
// -----------------------------------------------------------------------------
async function assertConsistency(
  db: Db,
  tenantId: string,
  input: {
    institution_id: string;
    program_id: string;
    program_intake_id?: string | null;
    campus_id?: string | null;
    super_agent_id?: string | null;
  },
): Promise<void> {
  const program = await db.program.findFirst({
    where: { id: input.program_id, tenant_id: tenantId, deleted_at: null },
    select: { id: true, institution_id: true },
  });
  if (!program) throw NotFound('Program not found');
  if (program.institution_id !== input.institution_id) {
    throw UnprocessableEntity(
      'program does not belong to institution',
      [
        {
          path: 'program_id',
          message: 'program_id and institution_id are inconsistent',
          code: 'cross_reference_mismatch',
        },
      ],
    );
  }

  if (input.program_intake_id) {
    const intake = await db.programIntake.findFirst({
      where: { id: input.program_intake_id, program_id: input.program_id },
      select: { id: true, campus_id: true, capacity: true },
    });
    if (!intake) {
      throw UnprocessableEntity(
        'program_intake does not belong to program',
        [
          {
            path: 'program_intake_id',
            message: 'program_intake_id is not an intake of program_id',
            code: 'cross_reference_mismatch',
          },
        ],
      );
    }
    // If intake binds to a campus, an explicit campus_id must agree (or be omitted).
    if (intake.campus_id && input.campus_id && intake.campus_id !== input.campus_id) {
      throw UnprocessableEntity(
        'campus does not match intake campus',
        [
          {
            path: 'campus_id',
            message: 'campus_id contradicts the campus already on the intake',
            code: 'cross_reference_mismatch',
          },
        ],
      );
    }
    // SVT-SEC-2026-05 — enforce ProgramIntake.capacity if set. Counts only
    // enrollments that haven't been withdrawn/cancelled (a withdrawn seat
    // frees up capacity). Race-window is small in practice; for high-volume
    // intakes this should escalate to a row-locked counter (post-v1).
    if (intake.capacity != null && intake.capacity > 0) {
      const seated = await db.enrollment.count({
        where: {
          program_intake_id: input.program_intake_id,
          tenant_id: tenantId,
          deleted_at: null,
          status: { notIn: ['WITHDRAWN', 'CANCELLED'] as never },
        },
      });
      if (seated >= intake.capacity) {
        throw Conflict(
          `Intake at capacity (${intake.capacity}). Cannot enrol another student.`,
        );
      }
    }
  }

  if (input.campus_id) {
    const campus = await db.campus.findFirst({
      where: { id: input.campus_id, institution_id: input.institution_id },
      select: { id: true },
    });
    if (!campus) {
      throw UnprocessableEntity(
        'campus does not belong to institution',
        [
          {
            path: 'campus_id',
            message: 'campus_id is not a campus of institution_id',
            code: 'cross_reference_mismatch',
          },
        ],
      );
    }
  }

  // Super-agent: must be linked to this institution. Null/undefined skips the
  // check (= direct enrollment, no super-agent involved).
  if (input.super_agent_id) {
    const linked = await isLinkedToInstitution(
      db,
      tenantId,
      input.institution_id,
      input.super_agent_id,
    );
    if (!linked) {
      throw UnprocessableEntity(
        'Super-agent not linked to this institution',
        [
          {
            path: 'super_agent_id',
            message: 'Super-agent not linked to this institution',
            code: 'cross_reference_mismatch',
          },
        ],
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Per-student create
// -----------------------------------------------------------------------------

export async function createForStudent(
  ctx: Ctx,
  studentId: string,
  input: CreateEnrollmentRequest,
): Promise<unknown> {
  const { db, tenantId, actorId } = ctx;

  const student = await db.student.findFirst({
    where: { id: studentId, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!student) throw NotFound('Student not found');

  // SVT-WAVE-BILLING-SEC-P1-F7 — ProgramIntake.capacity race fix. The count +
  // create live in a single transaction with `SELECT … FOR UPDATE` on the
  // ProgramIntake row, so two concurrent enrollments at capacity-1 cannot both
  // succeed. The intake row acts as a per-intake serialisation token; other
  // intakes are unaffected.
  const created = await db.$transaction(async (tx) => {
    // Re-run consistency inside the tx so the campus/super-agent/program checks
    // see the same snapshot that the row-locked capacity check operates on.
    await assertConsistency(tx as unknown as Db, tenantId, input);

    if (input.program_intake_id) {
      const lockedIntakes = await tx.$queryRaw<Array<{ id: string; capacity: number | null }>>`
        SELECT id, capacity
        FROM program_intakes
        WHERE id = ${input.program_intake_id}::uuid
        FOR UPDATE
      `;
      const lockedIntake = lockedIntakes[0];
      if (lockedIntake && lockedIntake.capacity != null && lockedIntake.capacity > 0) {
        const seated = await tx.enrollment.count({
          where: {
            program_intake_id: input.program_intake_id,
            tenant_id: tenantId,
            deleted_at: null,
            status: { notIn: ['WITHDRAWN', 'CANCELLED'] as never },
          },
        });
        if (seated >= lockedIntake.capacity) {
          throw Conflict(
            `Intake at capacity (${lockedIntake.capacity}). Cannot enrol another student.`,
          );
        }
      }
    }

    return tx.enrollment.create({
      data: {
        tenant_id: tenantId,
        student_id: studentId,
        institution_id: input.institution_id,
        program_id: input.program_id,
        program_intake_id: input.program_intake_id ?? null,
        campus_id: input.campus_id ?? null,
        super_agent_id: input.super_agent_id ?? null,
        enrollment_no: input.enrollment_no ?? null,
        start_date: input.start_date ? new Date(input.start_date) : null,
        expected_end_date: input.expected_end_date ? new Date(input.expected_end_date) : null,
        actual_end_date: input.actual_end_date ? new Date(input.actual_end_date) : null,
        status: input.status,
        tuition_total_minor: input.tuition_total_minor ?? null,
        tuition_currency: input.tuition_currency ?? null,
        scholarship_minor: input.scholarship_minor,
        scholarship_name: input.scholarship_name ?? null,
        agent_commission_minor: input.agent_commission_minor ?? null,
        notes: input.notes ?? null,
        created_by_id: actorId,
        updated_by_id: actorId,
      },
      include: defaultInclude(),
    });
  });
  // SVT-AUDIT-2026-05: every enrollment write must leave a chain entry. The
  // existing transition writer only fires on status change; bare creation
  // would otherwise be invisible to forensic replay.
  await writeAudit({
    tenantId,
    actorId,
    action: 'enrollment.created',
    entityType: 'Enrollment',
    entityId: created.id,
    after: {
      student_id: studentId,
      institution_id: created.institution_id,
      program_id: created.program_id,
      status: created.status,
      super_agent_id: created.super_agent_id,
    },
  });
  // Commission hook: any failure is logged + swallowed, never propagated.
  await maybeRecomputeCommissionOnCreate(ctx, created.id, created.status);
  return created;
}

// -----------------------------------------------------------------------------
// Per-student list
// -----------------------------------------------------------------------------

export async function listForStudent(
  ctx: ReadCtx,
  studentId: string,
): Promise<unknown[]> {
  const { db, tenantId } = ctx;
  const student = await db.student.findFirst({
    where: { id: studentId, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!student) throw NotFound('Student not found');

  return db.enrollment.findMany({
    where: { student_id: studentId, tenant_id: tenantId, deleted_at: null },
    orderBy: [{ created_at: 'desc' }],
    include: defaultInclude(),
  });
}

// -----------------------------------------------------------------------------
// Cross-tenant admin list
// -----------------------------------------------------------------------------

export async function list(
  ctx: ReadCtx,
  q: EnrollmentListQuery,
): Promise<{ data: unknown[]; total: number }> {
  const { db, tenantId } = ctx;
  const where: Prisma.EnrollmentWhereInput = {
    tenant_id: tenantId,
    deleted_at: null,
  };
  if (q.student_id) where.student_id = q.student_id;
  if (q.institution_id) where.institution_id = q.institution_id;
  if (q.program_id) where.program_id = q.program_id;
  if (q.status) where.status = q.status;

  const [rows, total] = await Promise.all([
    db.enrollment.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: q.limit,
      include: defaultInclude(),
    }),
    db.enrollment.count({ where }),
  ]);
  return { data: rows, total };
}

// -----------------------------------------------------------------------------
// Get / Update / Soft-delete
// -----------------------------------------------------------------------------

export async function getById(ctx: ReadCtx, id: string): Promise<unknown> {
  const row = await ctx.db.enrollment.findFirst({
    where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    include: {
      ...defaultInclude(),
      student: {
        select: {
          id: true,
          student_code: true,
          given_name: true,
          family_name: true,
          email_primary: true,
        },
      },
    },
  });
  if (!row) throw NotFound('Enrollment not found');
  return row;
}

export async function update(
  ctx: WriteCtx,
  id: string,
  input: UpdateEnrollmentRequest,
  expected?: number,
): Promise<unknown> {
  const { db, tenantId, actorId, actorRole } = ctx;

  // Pull the current row + its commission claim (if any) up front so the FSM
  // gate, tuition lock and consistency check share one read. Also pull the
  // current `version` so we can run an optional optimistic-concurrency check
  // when an If-Match header was supplied.
  const current = await db.enrollment.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    select: {
      id: true,
      version: true,
      institution_id: true,
      program_id: true,
      program_intake_id: true,
      campus_id: true,
      super_agent_id: true,
      status: true,
      student_id: true,
      // Pulled so the post-transition in-app notification can route to the
      // assigned counsellor without a second query.
      student: { select: { assigned_to_id: true } },
      commission_claim: { select: { id: true, status: true } },
    },
  });
  if (!current) throw NotFound('Enrollment not found');

  // Optional If-Match: only enforced when the controller passed an `expected`
  // version (parsed from the request header). Clients that omit If-Match
  // continue to work for backwards compatibility — the protection only fires
  // when the caller opts in.
  if (expected !== undefined && current.version !== expected) {
    throw PreconditionFailed('Record was modified by another request; reload and retry.');
  }

  // ---- FSM gate: status changes go through the transition table -----------
  // VIEWER would already have been bounced by the auth middleware; default to
  // COUNSELLOR if for any reason actorRole is missing so we never silently
  // grant ADMIN.
  const role: UserRole = (actorRole ?? 'COUNSELLOR') as UserRole;
  if (input.status !== undefined && input.status !== current.status) {
    const check = assertTransitionAllowed(
      current.status as EnrollmentStatus,
      input.status as EnrollmentStatus,
      role,
      input.reason_code,
    );
    if (!check.ok) {
      throw new HttpError({
        status: check.status,
        title: 'Invalid status transition',
        detail: check.detail,
      });
    }
  }

  // ---- Tuition lock: edits while a claim is INVOICED/PAID need an admin ---
  // override (allow_locked_field_edit=true). This protects already-issued
  // invoices from silent reprice.
  const claimStatus = current.commission_claim?.status;
  if (claimStatus && COMMISSION_LOCK_STATUSES.has(claimStatus)) {
    const editingLocked = TUITION_LOCKED_FIELDS.some(
      (f) => (input as Record<string, unknown>)[f] !== undefined,
    );
    if (editingLocked) {
      const overridden = role === 'ADMIN' && input.allow_locked_field_edit === true;
      if (!overridden) {
        throw Conflict(
          'Tuition fields locked while linked commission claim is INVOICED/PAID. Resolve commission first or use admin override.',
        );
      }
    }
  } else if (input.allow_locked_field_edit) {
    // Belt-and-braces: only ADMIN may even *send* the override flag, so a
    // counsellor probing the API can't trickle through.
    if (role !== 'ADMIN') {
      throw Forbidden('allow_locked_field_edit requires ADMIN role');
    }
  }

  // SVT-SEC-2026-05 — re-routing commission to a different super-agent
  // changes who gets paid; ADMIN-only. Mirrors the assigned_to_id guard
  // in students.service.update.
  if (
    input.super_agent_id !== undefined &&
    input.super_agent_id !== current.super_agent_id &&
    role !== 'ADMIN'
  ) {
    throw Forbidden('Only ADMIN can change super_agent_id on an enrollment');
  }

  // If any reference field is changing, re-run consistency against the merged shape.
  const next = {
    institution_id: input.institution_id ?? current.institution_id,
    program_id: input.program_id ?? current.program_id,
    program_intake_id:
      input.program_intake_id !== undefined ? input.program_intake_id : current.program_intake_id,
    campus_id: input.campus_id !== undefined ? input.campus_id : current.campus_id,
    super_agent_id:
      input.super_agent_id !== undefined ? input.super_agent_id : current.super_agent_id,
  };
  if (
    input.institution_id !== undefined ||
    input.program_id !== undefined ||
    input.program_intake_id !== undefined ||
    input.campus_id !== undefined ||
    input.super_agent_id !== undefined
  ) {
    await assertConsistency(db, tenantId, next);
  }

  const data: Prisma.EnrollmentUncheckedUpdateInput = {
    updated_by_id: actorId,
    version: { increment: 1 },
  };
  if (input.institution_id !== undefined) data.institution_id = input.institution_id;
  if (input.program_id !== undefined) data.program_id = input.program_id;
  if (input.program_intake_id !== undefined) data.program_intake_id = input.program_intake_id ?? null;
  if (input.campus_id !== undefined) data.campus_id = input.campus_id ?? null;
  if (input.super_agent_id !== undefined) data.super_agent_id = input.super_agent_id ?? null;
  if (input.enrollment_no !== undefined) data.enrollment_no = input.enrollment_no ?? null;
  if (input.start_date !== undefined) {
    data.start_date = input.start_date ? new Date(input.start_date) : null;
  }
  if (input.expected_end_date !== undefined) {
    data.expected_end_date = input.expected_end_date ? new Date(input.expected_end_date) : null;
  }
  if (input.actual_end_date !== undefined) {
    data.actual_end_date = input.actual_end_date ? new Date(input.actual_end_date) : null;
  }
  if (input.status !== undefined) data.status = input.status;
  if (input.tuition_total_minor !== undefined) {
    data.tuition_total_minor = input.tuition_total_minor ?? null;
  }
  if (input.tuition_currency !== undefined) data.tuition_currency = input.tuition_currency ?? null;
  if (input.scholarship_minor !== undefined) data.scholarship_minor = input.scholarship_minor;
  if (input.scholarship_name !== undefined) data.scholarship_name = input.scholarship_name ?? null;
  if (input.agent_commission_minor !== undefined) {
    data.agent_commission_minor = input.agent_commission_minor ?? null;
  }
  if (input.notes !== undefined) data.notes = input.notes ?? null;

  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  // When an `expected` version was supplied, fold it into the WHERE so the
  // UPDATE is atomic against a concurrent writer that bumped the version
  // between the SELECT above and now (TOCTOU window).
  const where: Prisma.EnrollmentWhereInput = {
    id,
    tenant_id: tenantId,
    deleted_at: null,
  };
  if (expected !== undefined) where.version = expected;
  const wr = await db.enrollment.updateMany({ where, data });
  if (wr.count !== 1) {
    if (expected !== undefined) {
      // Re-read to differentiate "version moved" (412) from "row gone" (404).
      const stillThere = await db.enrollment.findFirst({
        where: { id, tenant_id: tenantId, deleted_at: null },
        select: { id: true },
      });
      if (stillThere) {
        throw PreconditionFailed('Record was modified by another request; reload and retry.');
      }
    }
    throw NotFound('Enrollment not found');
  }
  const updated = await db.enrollment.findFirstOrThrow({
    where: { id, tenant_id: tenantId },
    select: { id: true, status: true },
  });

  // Audit the FSM transition. We log it even on no-op same-status PATCHes is
  // unhelpful, so only fire when the status actually changed.
  const fromStatus = current.status as EnrollmentStatus;
  const toStatus = updated.status as EnrollmentStatus;
  if (input.status !== undefined && fromStatus !== toStatus) {
    await writeAudit({
      tenantId,
      actorId,
      action: 'enrollment.status_transition',
      entityType: 'Enrollment',
      entityId: id,
      after: {
        from_status: fromStatus,
        to_status: toStatus,
        reason_code: input.reason_code ?? null,
      },
    });
    // SVT-WAVE5-TXN-NOTIFY: in-app bell badge for assigned counsellor (or
    // fallback admin) when an enrollment changes status. Lets stakeholders
    // react without polling. Reuses `current.student` already loaded above.
    void notifyStatusTransition({
      tenantId,
      entityId: id,
      title: `Enrollment ${fromStatus} → ${toStatus}`,
      body: input.reason_code ? `Reason: ${input.reason_code}` : undefined,
      href: `/students/${current.student_id}?tab=studies`,
      preferUserId: current.student?.assigned_to_id ?? null,
      actorId,
      source: 'enrollment',
    });
  }

  // Commission hook: only fire on the two transitions that mint or re-mint
  // a claim — OFFERED→ACCEPTED and ACCEPTED→ENROLLED. Tuition-only edits and
  // illegal flips no longer touch commissions.
  await maybeRecomputeCommission(ctx, updated.id, fromStatus, toStatus);

  // Billing hooks (Wave 5): only fire when tenant.billing_enabled and the
  // FSM edge is one of the lifecycle moments. Fire-and-forget — billing
  // failures must never roll back the enrollment write.
  if (fromStatus !== toStatus && fromStatus && toStatus) {
    const bctx = { db: ctx.db, user: { tid: ctx.tenantId, sub: ctx.actorId, role: ctx.actorRole ?? 'COUNSELLOR' } };
    if (fromStatus === 'ACCEPTED' && toStatus === 'ENROLLED') {
      await maybeSeedFeePlan(bctx as never, updated.id);
    } else if (toStatus === 'ON_LEAVE') {
      await maybePauseOnLeave(bctx as never, updated.id);
    } else if (fromStatus === 'ON_LEAVE' && toStatus === 'ENROLLED') {
      await maybeResumeFromLeave(bctx as never, updated.id);
    } else if (toStatus === 'WITHDRAWN' || toStatus === 'CANCELLED') {
      await maybeCancelOnWithdraw(bctx as never, updated.id, toStatus);
    }
  }

  // SVT-AUDIT-SEC-2026-05 — always audit the field-level PATCH so non-status
  // edits (tuition_total_minor, agent_commission_minor, scholarship, notes,
  // super_agent_id, etc.) leave a trail. Emitted AFTER the FSM transition
  // audit so existing tests still see status_transition at auditCalls[0].
  await writeAudit({
    tenantId,
    actorId,
    action: 'enrollment.updated',
    entityType: 'Enrollment',
    entityId: id,
    before: {
      status: current.status,
      institution_id: current.institution_id,
      program_id: current.program_id,
      program_intake_id: current.program_intake_id,
      super_agent_id: current.super_agent_id,
    },
    after: { ...input },
  });

  return getById({ db, tenantId }, id);
}

export async function softDelete(ctx: Ctx, id: string): Promise<void> {
  const { db, tenantId, actorId } = ctx;
  const before = await db.enrollment.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    select: { id: true, student_id: true, institution_id: true, program_id: true, status: true },
  });
  if (!before) throw NotFound('Enrollment not found');
  const result = await db.enrollment.updateMany({
    where: { id, tenant_id: tenantId, deleted_at: null },
    data: { deleted_at: new Date(), updated_by_id: actorId },
  });
  if (result.count === 0) throw NotFound('Enrollment not found');
  // SVT-AUDIT-2026-05: soft-delete must leave a chain entry so forensic replay
  // can reconstruct who removed which enrollment + when. Status snapshot lets
  // an investigator reason about commission claim state at the time of delete.
  await writeAudit({
    tenantId,
    actorId,
    action: 'enrollment.deleted',
    entityType: 'Enrollment',
    entityId: id,
    before,
  });
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function defaultInclude(): Prisma.EnrollmentInclude {
  return {
    institution: { select: { id: true, display_name: true, country_code: true } },
    program: { select: { id: true, name: true, level: true } },
    program_intake: {
      select: { id: true, intake_year: true, intake_month: true, intake_label: true },
    },
    campus: { select: { id: true, name: true } },
    // Lightweight super-agent summary so UIs can render the brokered channel
    // without a second fetch. Null when this enrollment is direct.
    super_agent: { select: { id: true, name: true, short_name: true } },
  };
}
