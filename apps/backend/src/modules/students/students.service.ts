import type { Prisma } from '@prisma/client';
import type {
  AdvanceStageRequest,
  CreateStudentRequest,
  StudentListQuery,
  UpdateStudentRequest,
  Role,
} from '@spv/zod-schemas';

import { prisma as rawPrisma } from '../../config/db.js';
import { encryptField } from '../../shared/encryption.js';
import { Conflict, Forbidden, NotFound, PreconditionFailed, UnprocessableEntity } from '../../shared/errors.js';
// v6: outcome side-effects (commission recalc on success, reminder on failure).
import { upsertClaimForEnrollment } from '../commissions/recalculator.js';
import { writeAudit as writeAuditDirect, type AuditEventLoose } from '../../shared/audit.js';
import { notifyStatusTransition } from '../../shared/transitionNotify.js';
import { logger as outcomeLogger } from '../../config/logger.js';
import { assertOrThrow, dynamicAssertTransition } from '../../shared/fsm.js';
import { studentFsm, type StudentStatusValue } from './fsm-def.js';
import type { UserRole } from '@prisma/client';
import {
  decodeCursor,
  encodeCursor,
  parseSort,
  type CompletenessResult,
  type Db,
  type SortDirective,
} from './students.types.js';

// All service functions take an explicit Db so the handler can pass the RLS-scoped
// req.db (preferred) or fall back to the singleton (background jobs, scripts).
type Ctx = { db: Db; tenantId: string; actorId: string };

// SVT-FSM-2026-05: student status state-machine moved to fsm-def.ts. The
// shared framework enforces:
//   - same -> same: no-op
//   - terminal -> non-listed-target: 409 Conflict
//   - explicit rule with role too weak: 403 Forbidden
//   - explicit rule with require_reason but missing: 422 Unprocessable Entity
//   - non-terminal but no rule: 422 Unprocessable Entity
//
// Critical: when status === ON_HOLD, advanceStage() refuses with 409 — the
// student must be resumed first.

// -----------------------------------------------------------------------------
// list
// -----------------------------------------------------------------------------

/**
 * Build the student-list WHERE clause from the caller's filters.
 *
 * SVT-EXPORT-FILTER-2026-08 — extracted from `list()` so the CSV export runs
 * the SAME predicate the screen ran.
 *
 * Why this exists: the export pipeline used to whitelist a single scalar
 * (`status`) and silently drop everything else. A counsellor who filtered the
 * students list to twelve SLA-breached records and clicked "Export CSV"
 * received a CSV of EVERY student in the tenant — a far larger disclosure than
 * they asked for, with no error and no warning. The frontend comment even
 * claimed the export was "an exact representation of what the user sees on
 * screen".
 *
 * Keeping one builder means the list and the export cannot drift apart again;
 * a new filter is honoured by both the moment it is added here.
 */
export async function buildStudentListWhere(
  db: Db,
  tenantId: string,
  q: Pick<StudentListQuery, 'stage_id' | 'status' | 'assigned_to_id' | 'sla_breached' | 'search'> & {
    ids?: string[];
  },
): Promise<Prisma.StudentWhereInput> {
  // Base WHERE: tenant + soft-delete filter.
  const where: Prisma.StudentWhereInput = {
    tenant_id: tenantId,
    deleted_at: null,
  };
  if (q.stage_id) where.current_stage_id = q.stage_id;
  if (q.status) where.status = q.status;
  if (q.assigned_to_id) where.assigned_to_id = q.assigned_to_id;
  // Explicit id set — used by "export selected" so a ticked selection exports
  // exactly those rows rather than the whole tenant.
  if (q.ids && q.ids.length > 0) where.id = { in: q.ids };

  const andClauses: Prisma.StudentWhereInput[] = [];

  if (q.sla_breached) {
    const stagesWithSla = await db.lifecycleStage.findMany({
      where: { tenant_id: tenantId, sla_hours: { not: null }, show_on_dashboard: true },
      select: { id: true, sla_hours: true },
    });
    if (stagesWithSla.length === 0) {
      // Force an empty set without clobbering an `ids` filter above.
      andClauses.push({ id: '00000000-0000-0000-0000-000000000000' });
    } else {
      const now = Date.now();
      const HOUR_MS = 60 * 60 * 1000;
      andClauses.push({
        OR: stagesWithSla.map((s) => ({
          current_stage_id: s.id,
          stage_entered_at: { lt: new Date(now - (s.sla_hours ?? 0) * HOUR_MS) },
        })),
      });
      if (!q.status) where.status = 'ACTIVE';
    }
  }
  if (q.search) {
    const needle = q.search.trim();
    andClauses.push({
      OR: [
        { family_name: { contains: needle, mode: 'insensitive' } },
        { given_name: { contains: needle, mode: 'insensitive' } },
        { student_code: { contains: needle, mode: 'insensitive' } },
      ],
    });
  }
  if (andClauses.length > 0) where.AND = andClauses;
  return where;
}

export async function list(
  ctx: { db: Db; tenantId: string },
  q: StudentListQuery,
): Promise<{ data: unknown[]; nextCursor: string | null; hasMore: boolean; total: number }> {
  const { db, tenantId } = ctx;
  const limit = q.limit;

  // Base WHERE: tenant + soft-delete filter.
  const where: Prisma.StudentWhereInput = {
    tenant_id: tenantId,
    deleted_at: null,
  };
  if (q.stage_id) where.current_stage_id = q.stage_id;
  if (q.status) where.status = q.status;
  if (q.assigned_to_id) where.assigned_to_id = q.assigned_to_id;

  // Collect OR-typed conditions in `andClauses` so multiple OR-bearing
  // filters compose correctly. Prisma's where.OR is a single slot; when
  // multiple filters need an OR each (e.g. SLA breach + search), the last
  // one wins. Wrapping each in its own AND entry preserves intersection.
  const andClauses: Prisma.StudentWhereInput[] = [];

  // SVT-WAVE39-STUDENT-SLA-FILTER-2026-05 — translate the boolean flag into
  // a set of per-stage thresholds. We compute (now - sla_hours) for every
  // stage that has an SLA and is dashboard-visible, then OR-join. Only ACTIVE
  // students count — ON_HOLD/ON_LEAVE/DEFERRED are intentional pauses (stopped
  // clock) and WITHDRAWN/COMPLETED are terminal, so none are real SLA breaches.
  if (q.sla_breached) {
    const stagesWithSla = await db.lifecycleStage.findMany({
      where: { tenant_id: tenantId, sla_hours: { not: null }, show_on_dashboard: true },
      select: { id: true, sla_hours: true },
    });
    if (stagesWithSla.length === 0) {
      // Force empty set without breaking pagination invariants downstream.
      where.id = '00000000-0000-0000-0000-000000000000';
    } else {
      const now = Date.now();
      const HOUR_MS = 60 * 60 * 1000;
      andClauses.push({
        OR: stagesWithSla.map((s) => ({
          current_stage_id: s.id,
          stage_entered_at: { lt: new Date(now - (s.sla_hours ?? 0) * HOUR_MS) },
        })),
      });
      // Only override status when caller didn't pin one. Default to ACTIVE-only
      // (the only status with a running SLA clock); an explicit q.status still
      // wins so "ON_HOLD students in stage X" stays an honest deliberate query.
      if (!q.status) where.status = 'ACTIVE';
    }
  }
  if (q.search) {
    const needle = q.search.trim();
    andClauses.push({
      OR: [
        { family_name: { contains: needle, mode: 'insensitive' } },
        { given_name: { contains: needle, mode: 'insensitive' } },
        { student_code: { contains: needle, mode: 'insensitive' } },
      ],
    });
  }
  if (andClauses.length > 0) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      ...andClauses,
    ];
  }

  // Cursor: opaque base64 of {created_at, id}. We seek with (created_at, id) tuple
  // so duplicates on created_at don't break paging.
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (cursor) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      {
        OR: [
          { created_at: { lt: new Date(cursor.created_at) } },
          { created_at: new Date(cursor.created_at), id: { lt: cursor.id } },
        ],
      },
    ];
  }

  const orderBy = buildOrderBy(parseSort(q.sort));

  // Fetch one extra row to determine hasMore without a second round-trip.
  const rowsP = db.student.findMany({
    where,
    orderBy,
    take: limit + 1,
    include: {
      current_stage: { select: { id: true, key: true, label: true, sequence: true, category: true } },
      assigned_to: { select: { id: true, given_name: true, family_name: true } },
    },
  });
  const totalP = db.student.count({ where });
  const [rowsPlusOne, total] = await Promise.all([rowsP, totalP]);

  const hasMore = rowsPlusOne.length > limit;
  const rows = hasMore ? rowsPlusOne.slice(0, limit) : rowsPlusOne;
  const last = rows[rows.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ created_at: last.created_at.toISOString(), id: last.id }) : null;

  return { data: rows.map(redactSensitive), nextCursor, hasMore, total };
}

function buildOrderBy(sort: SortDirective[]): Prisma.StudentOrderByWithRelationInput[] {
  // Always tie-break on (created_at desc, id desc) — must match the cursor seek above.
  const tail: Prisma.StudentOrderByWithRelationInput[] = [{ created_at: 'desc' }, { id: 'desc' }];
  if (sort.length === 0) return tail;
  return [...sort.map((s) => ({ [s.column]: s.dir }) as Prisma.StudentOrderByWithRelationInput), ...tail];
}

// -----------------------------------------------------------------------------
// getById
// -----------------------------------------------------------------------------

export async function getById(
  ctx: { db: Db; tenantId: string },
  id: string,
): Promise<unknown> {
  const row = await ctx.db.student.findFirst({
    where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    include: {
      current_stage: { select: { id: true, key: true, label: true, sequence: true, category: true } },
      assigned_to: { select: { id: true, given_name: true, family_name: true } },
    },
  });
  if (!row) throw NotFound('Student not found');
  return redactSensitive(row);
}

// -----------------------------------------------------------------------------
// create
// -----------------------------------------------------------------------------

export async function create(ctx: Ctx, input: CreateStudentRequest): Promise<unknown> {
  const { db, tenantId, actorId } = ctx;
  const year = new Date().getUTCFullYear();

  // Resolve the initial stage if the caller didn't supply one. Done OUTSIDE
  // the code-allocation tx because it's tenant-scoped read-only metadata that
  // can be safely cached; holding the advisory lock across it would serialise
  // unrelated reads.
  let currentStageId = input.current_stage_id ?? null;
  if (!currentStageId) {
    const initial = await db.lifecycleStage.findFirst({
      where: { tenant_id: tenantId, is_initial: true, is_active: true },
      orderBy: { sequence: 'asc' },
      select: { id: true },
    });
    if (!initial) {
      throw Conflict('No initial lifecycle stage configured for tenant');
    }
    currentStageId = initial.id;
  }

  const nameInPassportEnc = await encryptField(input.name_in_passport);

  // student_code: SPV-<year>-<seq>. seq is allocated under a per-tenant
  // Postgres advisory transaction lock so two concurrent POSTs cannot read the
  // same COUNT(*) and race to the same code (unique constraint would 500 the
  // loser). hashtextextended(...) maps the tenant key into the int8 namespace
  // accepted by pg_advisory_xact_lock(bigint). Lock auto-releases on commit.
  //
  // IMPORTANT: we MUST use the raw prisma client here, not the tenant-scoped
  // `db`. The tenantContext extension wraps every operation in its own inner
  // $transaction (so set_config('app.tenant_id', tenantId, true) only sticks
  // within that op's tx). When we open an interactive tx via the extended db,
  // each `tx.<op>` call still triggers the extension → opens a nested savepoint
  // for that op → commits → releases the advisory lock immediately. Result:
  // the lock never spans count+create, and the race re-emerges. Using the raw
  // prisma client with manual `set_config` keeps the lock held for the full tx.
  const created = await rawPrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`student_code_seq:${tenantId}`}, 0))`;
    const existingCount = await tx.student.count({ where: { tenant_id: tenantId } });
    const seq = existingCount + 1;
    const studentCode = `SPV-${year}-${String(seq).padStart(6, '0')}`;
    return tx.student.create({
    data: {
      tenant_id: tenantId,
      student_code: studentCode,
      given_name: input.given_name,
      middle_name: input.middle_name ?? null,
      family_name: input.family_name,
      preferred_name: input.preferred_name ?? null,
      name_in_passport_enc: nameInPassportEnc,
      date_of_birth: new Date(input.date_of_birth),
      gender: input.gender,
      gender_self_described: input.gender_self_described ?? null,
      nationality_code: input.nationality_code,
      marital_status: input.marital_status ?? null,
      primary_language: input.primary_language,
      religion: input.religion ?? null,
      ethnicity: input.ethnicity ?? null,
      email_primary: input.email_primary ?? null,
      email_secondary: input.email_secondary ?? null,
      phone_primary_e164: input.phone_primary_e164 ?? null,
      phone_secondary_e164: input.phone_secondary_e164 ?? null,
      current_stage_id: currentStageId,
      assigned_to_id: input.assigned_to_id ?? null,
      status: input.status ?? 'ACTIVE',
      notes: input.notes ?? null,
      completeness_pct: 0,
      created_by_id: actorId,
      updated_by_id: actorId,
    },
    include: {
      current_stage: { select: { id: true, key: true, label: true, sequence: true, category: true } },
      assigned_to: { select: { id: true, given_name: true, family_name: true } },
    },
    });
  });

  // First completeness pass — best-effort; failures are not fatal to creation.
  try {
    const { score } = await completeness({ db, tenantId }, created.id);
    if (score !== created.completeness_pct) {
      // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
      await db.student.updateMany({
        where: { id: created.id, tenant_id: tenantId },
        data: { completeness_pct: score },
      });
      created.completeness_pct = score;
    }
  } catch {
    // swallow — the next read will recompute.
  }

  return redactSensitive(created);
}

// -----------------------------------------------------------------------------
// update (optimistic concurrency via version + If-Match)
// -----------------------------------------------------------------------------

export async function update(
  ctx: Ctx & { actorRole?: Role },
  id: string,
  input: UpdateStudentRequest,
  ifMatch: string | undefined,
): Promise<unknown> {
  const { db, tenantId, actorId } = ctx;
  if (!ifMatch) throw PreconditionFailed('If-Match header is required for updates');
  const expected = parseInt(ifMatch.replace(/^"|"$/g, ''), 10);
  if (!Number.isFinite(expected) || expected < 1) {
    throw PreconditionFailed('If-Match must be a numeric version');
  }

  const current = await db.student.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    select: { id: true, version: true, status: true, assigned_to_id: true },
  });
  if (!current) throw NotFound('Student not found');
  if (current.version !== expected) {
    throw PreconditionFailed(`Version mismatch (have ${current.version}, expected ${expected})`);
  }

  // SVT-AUDIT-SEC-2026-05 — block a COUNSELLOR from reassigning a student to
  // themselves (or anyone else). Only ADMIN can change `assigned_to_id`.
  // `requireStudentOwnership` already proved the COUNSELLOR currently owns
  // this row, but without this guard they could grab the row off another
  // counsellor's caseload by sending `assigned_to_id: <their-own-id>`.
  if (
    input.assigned_to_id !== undefined &&
    input.assigned_to_id !== current.assigned_to_id &&
    (ctx.actorRole ?? 'ADMIN') !== 'ADMIN'
  ) {
    throw Forbidden('Only ADMIN can reassign students');
  }

  // SVT-FSM-2026-05: enforce the status state-machine when this PATCH wants
  // to flip the status column. `notes` doubles as the reason field (already
  // on the wire schema) so we don't change the request shape.
  if (input.status !== undefined && input.status !== current.status) {
    assertOrThrow(
      studentFsm,
      current.status as StudentStatusValue,
      input.status as StudentStatusValue,
      (ctx.actorRole ?? 'ADMIN') as UserRole,
      input.notes ?? undefined,
    );
  }

  // Build a partial update payload. Only fields that were sent are included so PATCH
  // semantics are honoured. We use the Unchecked variant so scalar FK columns
  // (nationality_code, assigned_to_id) are settable directly — the checked
  // variant requires relation `connect`/`disconnect`, which `updateMany` can't
  // accept anyway. The cast at the call site lifts this to the
  // `StudentUpdateManyMutationInput` updateMany expects.
  const data: Prisma.StudentUncheckedUpdateInput = {
    updated_by_id: actorId,
    version: { increment: 1 },
  };
  if (input.given_name !== undefined) data.given_name = input.given_name;
  if (input.middle_name !== undefined) data.middle_name = input.middle_name ?? null;
  if (input.family_name !== undefined) data.family_name = input.family_name;
  if (input.preferred_name !== undefined) data.preferred_name = input.preferred_name ?? null;
  if (input.name_in_passport !== undefined) {
    data.name_in_passport_enc = await encryptField(input.name_in_passport);
  }
  if (input.date_of_birth !== undefined) data.date_of_birth = new Date(input.date_of_birth);
  if (input.gender !== undefined) data.gender = input.gender;
  if (input.gender_self_described !== undefined) data.gender_self_described = input.gender_self_described ?? null;
  // SVT-RLS-2026-05: updateMany only accepts scalar fields, not relation `connect`/`disconnect`.
  // Set FK columns directly.
  if (input.nationality_code !== undefined) data.nationality_code = input.nationality_code;
  if (input.marital_status !== undefined) data.marital_status = input.marital_status ?? null;
  if (input.primary_language !== undefined) data.primary_language = input.primary_language;
  if (input.religion !== undefined) data.religion = input.religion ?? null;
  if (input.ethnicity !== undefined) data.ethnicity = input.ethnicity ?? null;
  if (input.email_primary !== undefined) data.email_primary = input.email_primary ?? null;
  if (input.email_secondary !== undefined) data.email_secondary = input.email_secondary ?? null;
  if (input.phone_primary_e164 !== undefined) data.phone_primary_e164 = input.phone_primary_e164 ?? null;
  if (input.phone_secondary_e164 !== undefined) data.phone_secondary_e164 = input.phone_secondary_e164 ?? null;
  if (input.notes !== undefined) data.notes = input.notes ?? null;
  if (input.status !== undefined) data.status = input.status;
  if (input.assigned_to_id !== undefined) data.assigned_to_id = input.assigned_to_id ?? null;

  // Conditional UPDATE: WHERE id = ? AND version = ? — if zero rows return, someone
  // else moved the cheese between SELECT and UPDATE. updateMany returns the count.
  const result = await db.student.updateMany({
    where: { id, tenant_id: tenantId, deleted_at: null, version: expected },
    data: data as unknown as Prisma.StudentUpdateManyMutationInput,
  });
  if (result.count === 0) throw Conflict('Concurrent update detected; retry with the latest version');

  // SVT-SYNC-2026-06: a student status change (ACTIVE→ON_HOLD/WITHDRAWN/COMPLETED/…)
  // now pings the assigned counsellor's bell — matching the enrollment-status
  // notification, so a student-level state change isn't silently invisible.
  // Best-effort (never throws). Prefer the (possibly just-changed) assignee.
  if (input.status !== undefined && input.status !== current.status) {
    void notifyStatusTransition({
      tenantId,
      entityId: id,
      title: `Student ${current.status} → ${input.status}`,
      body: input.notes ? `Reason: ${input.notes}` : undefined,
      href: `/students/${id}`,
      preferUserId: input.assigned_to_id ?? current.assigned_to_id ?? null,
      actorId,
      source: 'student',
    });
  }

  // SVT-SYNC-2026-06 — A6: recompute completeness when student-level completeness
  // keys changed (name_in_passport, date_of_birth, nationality_code, contact fields).
  const completenessRelevant =
    input.name_in_passport !== undefined ||
    input.date_of_birth !== undefined ||
    input.nationality_code !== undefined ||
    input.email_primary !== undefined ||
    input.phone_primary_e164 !== undefined;
  if (completenessRelevant) {
    try {
      await completeness({ db, tenantId }, id);
    } catch (err) {
      outcomeLogger.warn({ err, studentId: id }, 'student.update: completeness recompute best-effort failed');
    }
  }

  return getById({ db, tenantId }, id);
}

// -----------------------------------------------------------------------------
// softDelete
//
// Cascading soft-delete: the parent Student row gets `deleted_at` set and so
// do every child table that participates in soft-delete. Without this, child
// rows continue to surface in list/detail/dashboard queries (which all filter
// on `deleted_at IS NULL`) even after the student is "removed", breaking
// privacy expectations and inflating dashboards.
//
// Only models that actually carry a `deleted_at` column are touched here —
// the rest cascade via Prisma `onDelete: Cascade` if the parent is ever hard-
// deleted (not on this code path), or stay as orphans (e.g. lookup-style
// junction tables like StudentAddress that don't have a soft-delete column).
//
// Models with student_id + deleted_at:
//   - Enrollment       (1366)  : deleted_at, no deleted_by_id
//   - Document         (1575)  : deleted_at, no deleted_by_id
//   - Reminder         (2007)  : deleted_at, no deleted_by_id (student_id nullable)
//   - CommissionClaim  (2060)  : deleted_at, no deleted_by_id (cascade via enrollment_id too)
//   - Note             (1732)  : deleted_at via polymorphic (entity_type='Student', entity_id=id)
//
// Models WITHOUT deleted_at (skipped here — they cascade via FK or are intentionally
// kept for audit history): StudentVisa, StudentIdentification,
// StudentRegulatorIdentifier, ComplianceCheck, EngagementCheck, StudentEmployment,
// StudentDependent, AcademicQualification, LanguageTestResult, StudentContact,
// StudentSponsorship, TravelRecord, Accommodation, InsuranceRecord, FinanceItem,
// StudentAddress, StudentStageChecklistProgress, StudentLifecycleEvent (audit).
// These either:
//   (a) cascade automatically via Prisma `onDelete: Cascade` if the row is ever
//       hard-deleted, or
//   (b) intentionally lack soft-delete because they are append-only audit
//       records (StudentLifecycleEvent), or
//   (c) are simple junction tables (StudentAddress) where unlinking is the
//       primary delete semantics, not soft-delete.
// -----------------------------------------------------------------------------

export async function softDelete(ctx: Ctx, id: string): Promise<void> {
  const { db, tenantId, actorId } = ctx;
  const now = new Date();

  // Run the parent + children inside a single transaction so we don't end up
  // with a "soft-deleted student but live enrollments" state if something goes
  // wrong mid-cascade. The audit-log writes happen AFTER the tx commits so a
  // single audit hiccup can't roll back the whole cascade.
  const cascadeCounts = await db.$transaction(async (tx) => {
    // Parent row first — surfaces NotFound before we do any child work.
    const parent = await tx.student.updateMany({
      where: { id, tenant_id: tenantId, deleted_at: null },
      data: { deleted_at: now, deleted_by_id: actorId },
    });
    if (parent.count === 0) {
      throw NotFound('Student not found');
    }

    // Child tables that carry their own `deleted_at`. None of these models
    // expose a `deleted_by_id` column (only Student does), so the cascade
    // identity is recorded via the audit log entries fired after commit.
    const enrollments = await tx.enrollment.updateMany({
      where: { student_id: id, tenant_id: tenantId, deleted_at: null },
      data: { deleted_at: now, updated_by_id: actorId },
    });

    const documents = await tx.document.updateMany({
      where: { student_id: id, tenant_id: tenantId, deleted_at: null },
      data: { deleted_at: now },
    });

    // Reminders.student_id is nullable; this only matches student-scoped
    // reminders (admin-wide reminders with student_id=null are unaffected).
    const reminders = await tx.reminder.updateMany({
      where: { student_id: id, tenant_id: tenantId, deleted_at: null },
      data: { deleted_at: now },
    });

    // CommissionClaim has both student_id (denormalised) and enrollment_id;
    // filtering on student_id is safe and defends against drift if
    // denormalisation ever breaks. Defence-in-depth: the enrollment cascade
    // above would have also marked the parent enrollment soft-deleted, but
    // claims don't auto-soft-delete with their enrollment.
    const commissions = await tx.commissionClaim.updateMany({
      where: { student_id: id, tenant_id: tenantId, deleted_at: null },
      data: { updated_by_id: actorId, deleted_at: now },
    });

    // Notes are polymorphic on (entity_type, entity_id) — there's no
    // student_id FK column. Match on the polymorphic discriminator.
    const notes = await tx.note.updateMany({
      where: {
        tenant_id: tenantId,
        entity_type: 'Student',
        entity_id: id,
        deleted_at: null,
      },
      data: { deleted_at: now, updated_by_id: actorId },
    });

    return {
      Enrollment: enrollments.count,
      Document: documents.count,
      Reminder: reminders.count,
      CommissionClaim: commissions.count,
      Note: notes.count,
    } as Record<string, number>;
  });

  // Audit one row per child-table that actually had work to do. The parent
  // student.delete event is emitted by the controller; here we only record the
  // cascade fan-out so verifiers can replay the chain.
  for (const [child_table, count] of Object.entries(cascadeCounts)) {
    if (count <= 0) continue;
    await writeAuditSafe({
      tenantId,
      actorId,
      action: 'student.cascade_soft_delete',
      entityType: 'Student',
      entityId: id,
      after: { child_table, count },
    });
  }
}

// -----------------------------------------------------------------------------
// timeline
// -----------------------------------------------------------------------------

export async function timeline(
  ctx: { db: Db; tenantId: string },
  id: string,
): Promise<unknown[]> {
  // Confirm the student exists in this tenant first to avoid leaking event existence.
  const exists = await ctx.db.student.findFirst({
    where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!exists) throw NotFound('Student not found');

  return ctx.db.studentLifecycleEvent.findMany({
    where: { student_id: id, tenant_id: ctx.tenantId },
    orderBy: { occurred_at: 'asc' },
    include: {
      from_stage: { select: { id: true, key: true, label: true } },
      to_stage: { select: { id: true, key: true, label: true } },
    },
  });
}

// -----------------------------------------------------------------------------
// advanceStage (transactional)
// -----------------------------------------------------------------------------

export async function advanceStage(
  ctx: Ctx & { actorRole: Role },
  id: string,
  input: AdvanceStageRequest,
): Promise<unknown> {
  const { db, tenantId, actorId, actorRole } = ctx;
  const effectiveAt = input.effective_at ? new Date(input.effective_at) : new Date();

  // We deliberately use the request-scoped db so the transaction inherits the RLS
  // SET LOCAL applied by tenantContext. If a fallback singleton is used (jobs),
  // RLS still filters via WHERE tenant_id below.
  const result = await db.$transaction(async (tx) => {
    const student = await tx.student.findFirst({
      where: { id, tenant_id: tenantId, deleted_at: null },
      select: {
        id: true,
        current_stage_id: true,
        version: true,
        // SVT-FSM-2026-05: surface status so we can refuse advancement when
        // the student is currently ON_HOLD.
        status: true,
        // v6: needed for the failure-side reminder + assignee fallback.
        given_name: true,
        family_name: true,
        assigned_to_id: true,
      },
    });
    if (!student) throw NotFound('Student not found');

    // SVT-FSM-2026-05: stage advancement is blocked while the student is on
    // hold. The caller must flip status back to ACTIVE first via PATCH.
    if (student.status === 'ON_HOLD') {
      throw Conflict('Cannot advance stage for a student on hold; resume student first.');
    }

    const fromStageId = student.current_stage_id;
    const toStageId = input.to_stage_id;

    // Sanity-check the destination exists in this tenant. v6: also pull the
    // outcome flags + prompt-date settings for downstream side-effects.
    // SVT-LIFECYCLE-2026-05: also load `sequence` + `label` so the new
    // forward/backward guard can reason about direction and produce a
    // human-readable error detail.
    const toStage = await tx.lifecycleStage.findFirst({
      where: { id: toStageId, tenant_id: tenantId, is_active: true },
      select: {
        id: true,
        label: true,
        sequence: true,
        is_outcome_success: true,
        is_outcome_failure: true,
        prompt_date_label: true,
      },
    });
    if (!toStage) throw NotFound('Destination stage not found');

    // Pull the current stage so we can compare sequences. The current stage
    // *should* always exist (FK on student.current_stage_id), but be defensive
    // in case of soft-delete drift.
    const fromStage = fromStageId
      ? await tx.lifecycleStage.findFirst({
          where: { id: fromStageId, tenant_id: tenantId },
          select: { id: true, label: true, sequence: true },
        })
      : null;

    // Same-stage no-op: short-circuit so audit + UI stay quiet. We log a
    // dedicated `stage.transition.noop` event AFTER the transaction so it
    // doesn't pollute the lifecycle event timeline. Return the existing
    // hydrated row so the response shape is identical to a real transition.
    if (fromStageId === toStageId) {
      const fresh = await tx.student.findUniqueOrThrow({
        where: { id },
        include: {
          current_stage: { select: { id: true, key: true, label: true, sequence: true, category: true } },
          assigned_to: { select: { id: true, given_name: true, family_name: true } },
        },
      });
      return { fresh, student, toStage, noop: true, ruleApplied: 'noop', direction: 'same' as const };
    }

    // Default-open transition matrix: if any rows exist for from_stage, the matrix is
    // closed and we must find a matching row. Otherwise we fall back to the
    // sequence-direction rule below.
    const matrix = await tx.lifecycleStageTransition.findMany({
      where: { tenant_id: tenantId, from_stage_id: fromStageId },
      select: { from_stage_id: true, to_stage_id: true, requires_role: true },
    });

    // Compute direction now so error messages + audit metadata can use it.
    const direction: 'forward' | 'backward' | 'same' =
      fromStage && toStage.sequence > fromStage.sequence
        ? 'forward'
        : fromStage && toStage.sequence < fromStage.sequence
          ? 'backward'
          : 'same';

    let ruleApplied: 'matrix' | 'sequence-fallback' = 'sequence-fallback';

    // SVT-WAVE-BILLING-SEC-P0-F2 — extras land on the lifecycle event metadata
    // when an admin uses `force: true` to skip stages. Forensic-replay-friendly.
    const eventMetadataExtras: Record<string, unknown> = {};

    if (matrix.length > 0) {
      ruleApplied = 'matrix';
      const allowed = matrix.find((m) => m.to_stage_id === toStageId);
      if (!allowed) {
        // Build a short list of permitted target labels for the error detail
        // — a counsellor needs to know what IS allowed, not just what isn't.
        const allowedTargetIds = matrix.map((m) => m.to_stage_id);
        const allowedTargets = await tx.lifecycleStage.findMany({
          where: { tenant_id: tenantId, id: { in: allowedTargetIds }, is_active: true },
          select: { label: true },
          orderBy: { sequence: 'asc' },
        });
        const allowedLabels = allowedTargets.map((s) => s.label);
        throw UnprocessableEntity(
          `Cannot move from "${fromStage?.label ?? '(unknown)'}" to "${toStage.label}". ` +
            `Configured transitions only allow: ${allowedLabels.join(', ') || '(none)'}.`,
        );
      }
      // SVT-FSM-2026-05: data-driven role check via the shared helper.
      const guard = dynamicAssertTransition(
        matrix.map((m) => ({
          from_stage_id: m.from_stage_id,
          to_stage_id: m.to_stage_id,
          requires_role: (m.requires_role ?? null) as UserRole | null,
        })),
        fromStageId,
        toStageId,
        actorRole as UserRole,
      );
      if (!guard.ok && guard.status === 403) {
        throw Forbidden(guard.detail);
      }
    } else {
      // SVT-LIFECYCLE-2026-05: matrix is empty (default state).
      // SVT-WAVE-BILLING-SEC-P0-F2: previously the empty-matrix fallback
      // accepted ANY forward move — a counsellor could skip from "Lead"
      // straight to "Visa Approved", bypassing every gate. The hardened rule:
      //   - forward+1 (toStage.sequence === fromStage.sequence + 1) → allowed.
      //   - forward+N (N > 1) → blocked unless ADMIN passes `force: true`.
      //     ADMIN + force is audited via metadata.forced=true so the long-skip
      //     leaves a forensic trace.
      //   - backward → ADMIN-only, requires non-empty reason_code (>=3 chars).
      //   - same-stage already short-circuited above.
      if (direction === 'forward') {
        const fromSeq = fromStage?.sequence ?? 0;
        const toSeq = toStage.sequence;
        const isAdjacent = toSeq === fromSeq + 1;
        if (!isAdjacent) {
          if (actorRole !== 'ADMIN') {
            throw Forbidden(
              `Counsellors may only advance one stage at a time (attempted ${toSeq - fromSeq} stages). Contact an admin to skip multiple stages.`,
            );
          }
          if (input.force !== true) {
            throw UnprocessableEntity(
              `Skipping ${toSeq - fromSeq} stages requires force=true (admin override).`,
            );
          }
          eventMetadataExtras['forced'] = true;
          eventMetadataExtras['skipped_stages'] = toSeq - fromSeq;
        }
      } else if (direction === 'backward') {
        if (actorRole !== 'ADMIN') {
          throw Forbidden(
            'Counsellors cannot move students backward. Contact an admin to perform a corrective transition.',
          );
        }
        const reason = (input.reason_code ?? '').trim();
        if (reason.length < 3) {
          throw UnprocessableEntity(
            'Backward transitions require a reason_code (minimum 3 characters).',
          );
        }
      }
    }

    // v6: when the destination stage prompts for an extra date, persist the
    // captured value on the lifecycle event metadata so reports can read it.
    // SVT-LIFECYCLE-2026-05: also record direction + the rule that allowed
    // the move so the audit trail makes the workflow legible without
    // re-deriving from sequences.
    const eventMetadata: Record<string, unknown> = {
      direction,
      rule_applied: ruleApplied,
      ...eventMetadataExtras,
    };
    if (input.prompt_date_value) {
      eventMetadata['prompt_date'] = input.prompt_date_value;
      eventMetadata['prompt_date_label'] = toStage.prompt_date_label ?? null;
    }

    await tx.studentLifecycleEvent.create({
      data: {
        tenant_id: tenantId,
        student_id: id,
        from_stage_id: fromStageId,
        to_stage_id: toStageId,
        occurred_at: new Date(),
        effective_at: effectiveAt,
        reason_code: input.reason_code ?? null,
        notes: input.notes ?? null,
        actor_id: actorId,
        actor_role: actorRole,
        metadata: eventMetadata as Prisma.InputJsonValue,
      },
    });

    // Optimistic concurrency: only update if the version we read at the start of this
    // transaction is still current. Two concurrent advances both INSERT lifecycle events
    // but only one UPDATE wins; the loser sees count=0 and we abort the whole tx.
    const updated = await tx.student.updateMany({
      where: { id, tenant_id: tenantId, version: student.version },
      data: {
        current_stage_id: toStageId,
        stage_entered_at: effectiveAt,
        version: { increment: 1 },
        updated_by_id: actorId,
      },
    });
    if (updated.count === 0) {
      throw Conflict('Student was modified concurrently; retry the transition');
    }

    const fresh = await tx.student.findUniqueOrThrow({
      where: { id },
      include: {
        current_stage: { select: { id: true, key: true, label: true, sequence: true, category: true } },
        assigned_to: { select: { id: true, given_name: true, family_name: true } },
      },
    });

    return {
      fresh,
      student,
      toStage,
      noop: false as const,
      ruleApplied,
      direction,
    };
  });

  // SVT-LIFECYCLE-2026-05: same-stage no-op short-circuit. Emit a dedicated
  // audit event so the chain still records the attempt without inserting a
  // lifecycle row.
  if ('noop' in result && result.noop) {
    await writeAuditSafe({
      tenantId,
      actorId,
      action: 'stage.transition.noop',
      entityType: 'Student',
      entityId: id,
      after: { to_stage_id: input.to_stage_id, reason: 'same_stage' },
    });
    return redactSensitive(result.fresh);
  }

  // v6 -----------------------------------------------------------------
  // Outcome side-effects fire AFTER the transition transaction commits.
  // They MUST NOT throw — a recalc / reminder hiccup must not roll back the
  // student's stage advance. All work is wrapped in try/catch + logger.error.
  if (result.toStage.is_outcome_success) {
    await fireOutcomeSuccessSideEffects(ctx, id);
  }
  if (result.toStage.is_outcome_failure) {
    await fireOutcomeFailureSideEffects(ctx, {
      studentId: id,
      givenName: result.student.given_name,
      familyName: result.student.family_name,
      assignedToId: result.student.assigned_to_id,
    });
  }

  return redactSensitive(result.fresh);
}

// SVT-FSM-2026-05: role hierarchy helper now lives in `shared/fsm.ts`
// (`roleAtLeast`) and is consumed via dynamicAssertTransition above.

// -----------------------------------------------------------------------------
// v6: Outcome side-effects.
//
// Fired after the stage-advance tx commits. Each routine logs failures via
// pino but never throws — the underlying student.advance_stage is the source
// of truth and we do not want a downstream hiccup (commission recalc, reminder
// insert) to roll it back.
//
// Audit chain: each side-effect emits one `stage.outcome_side_effect.fired`
// event so the verifier can replay the chain end-to-end.
// -----------------------------------------------------------------------------

async function fireOutcomeSuccessSideEffects(
  ctx: Ctx & { actorRole: Role },
  studentId: string,
): Promise<void> {
  const { db, tenantId, actorId } = ctx;
  try {
    // Find ACCEPTED / ENROLLED enrollments and recalculate their commission claims.
    const enrollments = await db.enrollment.findMany({
      where: {
        tenant_id: tenantId,
        student_id: studentId,
        status: { in: ['ACCEPTED', 'ENROLLED'] },
        deleted_at: null,
      },
      select: { id: true },
    });

    for (const enr of enrollments) {
      try {
        await upsertClaimForEnrollment(
          { db, user: { tid: tenantId, sub: actorId } },
          enr.id,
        );
      } catch (innerErr) {
        // upsertClaimForEnrollment already swallows internally, but defend in
        // depth in case a future contributor changes that contract.
        outcomeLogger.error(
          { err: innerErr, studentId, enrollmentId: enr.id },
          'commission recalc on outcome_success failed',
        );
      }
    }

    await writeAuditSafe({
      tenantId,
      actorId,
      action: 'stage.outcome_side_effect.fired',
      entityType: 'Student',
      entityId: studentId,
      after: { kind: 'success', enrollments_recalculated: enrollments.length },
    });
  } catch (err) {
    outcomeLogger.error(
      { err, studentId },
      'outcome_success side-effect handler failed',
    );
  }
}

async function fireOutcomeFailureSideEffects(
  ctx: Ctx & { actorRole: Role },
  args: {
    studentId: string;
    givenName: string;
    familyName: string;
    assignedToId: string | null;
  },
): Promise<void> {
  const { db, tenantId, actorId } = ctx;
  try {
    // Schedule a reminder for the assignee (or the actor if unassigned). Due
    // today, scheduled an hour out so the notification scanner picks it up
    // without firing inline.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const scheduledFor = new Date(Date.now() + 60 * 60 * 1000);
    const recipientId = args.assignedToId ?? actorId;

    await db.reminder.create({
      data: {
        tenant_id: tenantId,
        student_id: args.studentId,
        type: 'CUSTOM',
        title: `Visa workflow concluded as failure for ${args.givenName} ${args.familyName}`,
        due_on: today,
        scheduled_for: scheduledFor,
        assigned_to_id: recipientId,
        created_by_id: actorId,
      },
    });

    await writeAuditSafe({
      tenantId,
      actorId,
      action: 'stage.outcome_side_effect.fired',
      entityType: 'Student',
      entityId: args.studentId,
      after: { kind: 'failure', recipient_id: recipientId },
    });
  } catch (err) {
    outcomeLogger.error(
      { err, studentId: args.studentId },
      'outcome_failure side-effect handler failed',
    );
  }
}

// Use the loose 1-arg form of writeAudit. `Parameters<typeof writeAuditDirect>[0]`
// would resolve to the LAST overload's first param (ReqLike) under TS overload
// resolution, which is the wrong shape — callers here pass `tenantId`/`action`
// etc. directly.
async function writeAuditSafe(event: AuditEventLoose): Promise<void> {
  try {
    await writeAuditDirect(event);
  } catch (err) {
    outcomeLogger.error({ err, action: event.action }, 'audit write failed for outcome side-effect');
  }
}

// -----------------------------------------------------------------------------
// completeness
// -----------------------------------------------------------------------------

// Fixed checklist (v1). 9 weighted-equally items. Score = round(present / total * 100).
const COMPLETENESS_KEYS = [
  'name_in_passport',
  'date_of_birth',
  'nationality_code',
  'contact', // email_primary OR phone_primary_e164
  'visa', // >=1 visa
  'passport_identification', // >=1 IdType.PASSPORT
  'emergency_contact', // >=1 contact with is_emergency_contact
  'enrollment', // >=1 enrollment
  'travel', // >=1 travel record
] as const;

export async function completeness(
  ctx: { db: Db; tenantId: string },
  id: string,
): Promise<CompletenessResult> {
  const { db, tenantId } = ctx;
  const s = await db.student.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    select: {
      name_in_passport_enc: true,
      date_of_birth: true,
      nationality_code: true,
      email_primary: true,
      phone_primary_e164: true,
    },
  });
  if (!s) throw NotFound('Student not found');

  const [visasN, passportN, emergN, enrolN, travelN] = await Promise.all([
    db.studentVisa.count({ where: { student_id: id, tenant_id: tenantId } }),
    db.studentIdentification.count({ where: { student_id: id, tenant_id: tenantId, type: 'PASSPORT' } }),
    db.studentContact.count({ where: { student_id: id, tenant_id: tenantId, is_emergency_contact: true } }),
    db.enrollment.count({ where: { student_id: id, tenant_id: tenantId, deleted_at: null } }),
    db.travelRecord.count({ where: { student_id: id, tenant_id: tenantId } }),
  ]);

  const have: Record<(typeof COMPLETENESS_KEYS)[number], boolean> = {
    name_in_passport: !!s.name_in_passport_enc && s.name_in_passport_enc.length > 0,
    date_of_birth: !!s.date_of_birth,
    nationality_code: !!s.nationality_code,
    contact: !!(s.email_primary || s.phone_primary_e164),
    visa: visasN > 0,
    passport_identification: passportN > 0,
    emergency_contact: emergN > 0,
    enrollment: enrolN > 0,
    travel: travelN > 0,
  };

  const present = COMPLETENESS_KEYS.filter((k) => have[k]).length;
  const score = Math.round((present / COMPLETENESS_KEYS.length) * 100);
  const missing = COMPLETENESS_KEYS.filter((k) => !have[k]);

  // Best-effort write-back so list views stay accurate.
  await db.student
    .updateMany({ where: { id, tenant_id: tenantId }, data: { completeness_pct: score } })
    .catch(() => undefined);

  return { score, missing: [...missing] };
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// Strip ciphertext columns from API responses. Plaintext name_in_passport is never
// returned by the list/detail endpoints (that's a separate "reveal" endpoint).
//
// Exported for unit-testability. Strips any property whose key ends with `_enc`,
// recursively walking plain objects and arrays so nested includes are also cleansed.
// Buffers, Dates, and other class instances are passed through untouched.
export function redactSensitive<T>(row: T): T {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) {
    return row.map((item) => redactSensitive(item)) as unknown as T;
  }
  if (typeof row !== 'object') return row;
  // Preserve Buffer/Date/etc. — only walk plain objects.
  const proto = Object.getPrototypeOf(row);
  if (proto !== Object.prototype && proto !== null) {
    return row;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (k.endsWith('_enc')) continue;
    out[k] = redactSensitive(v);
  }
  return out as unknown as T;
}

