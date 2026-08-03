import type { Prisma } from '@prisma/client';
import type {
  ConvertLeadToStudentRequest,
  CreateCrmLeadFeeRequest,
  CrmApplicationListQuery,
  CrmLeadListQuery,
  MarkCrmFeePaidRequest,
  UpdateCrmLeadFeeRequest,
  UpdateCrmLeadRequest,
} from '@spv/zod-schemas';

import { prisma } from '../../config/db.js';
import { Conflict, HttpError, NotFound, PreconditionFailed } from '../../shared/errors.js';
import { logger } from '../../config/logger.js';
import { writeAudit } from '../../shared/audit.js';
import { runJob } from '../../jobs/runner.js';
import { ingestForTenant, type IngestResult } from '../../jobs/v2Ingest.js';
import { create as createStudent } from '../students/students.service.js';
import { createForStudent as createEnrollmentForStudent } from '../enrollments/enrollments.service.js';
import { decodeCursor, encodeCursor, type Db } from './crm-leads.types.js';

type Ctx = { db: Db; tenantId: string; actorId: string };
type ReadCtx = { db: Db; tenantId: string };

const OPEN_FEE_STATUSES = ['SCHEDULED', 'DUE', 'OVERDUE'] as const;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function parseIfMatch(ifMatch: string | undefined): number {
  if (!ifMatch) throw PreconditionFailed('If-Match header is required for updates');
  const expected = parseInt(ifMatch.replace(/^"|"$/g, ''), 10);
  if (!Number.isFinite(expected) || expected < 1) throw PreconditionFailed('If-Match must be a numeric version');
  return expected;
}

// -----------------------------------------------------------------------------
// Leads
// -----------------------------------------------------------------------------

export async function list(
  ctx: ReadCtx,
  q: CrmLeadListQuery,
): Promise<{ data: unknown[]; nextCursor: string | null; hasMore: boolean; total: number }> {
  const { db, tenantId } = ctx;
  const limit = q.limit;

  const where: Prisma.CrmLeadWhereInput = { tenant_id: tenantId, deleted_at: null };
  if (q.status) where.spv_status = q.status;
  if (q.assigned_to_id) where.assigned_to_id = q.assigned_to_id;
  if (q.intake_key) where.intake_month = { contains: q.intake_key, mode: 'insensitive' };
  if (q.search) {
    const needle = q.search.trim();
    where.OR = [
      { first_name: { contains: needle, mode: 'insensitive' } },
      { last_name: { contains: needle, mode: 'insensitive' } },
      { email: { contains: needle, mode: 'insensitive' } },
      { phone_number: { contains: needle, mode: 'insensitive' } },
    ];
  }
  if (q.has_upcoming_fee) {
    where.fees = { some: { deleted_at: null, status: { in: [...OPEN_FEE_STATUSES] } } };
  }

  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (cursor) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      { OR: [{ created_at: { lt: new Date(cursor.created_at) } }, { created_at: new Date(cursor.created_at), id: { lt: cursor.id } }] },
    ];
  }

  const [rowsPlusOne, total] = await Promise.all([
    db.crmLead.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        lead_courses: {
          where: { deleted_at: null },
          orderBy: { updated_at: 'desc' },
          take: 1,
          include: { course: { select: { name: true, institution: { select: { name: true } } } } },
        },
        course_history: {
          where: { to_state: { contains: 'accept', mode: 'insensitive' } },
          orderBy: { changed_at: 'desc' },
          take: 1,
          select: { changed_at: true },
        },
        fees: {
          where: { deleted_at: null, status: { in: [...OPEN_FEE_STATUSES] } },
          orderBy: { due_on: 'asc' },
          take: 1,
        },
      },
    }),
    db.crmLead.count({ where }),
  ]);

  const hasMore = rowsPlusOne.length > limit;
  const rows = hasMore ? rowsPlusOne.slice(0, limit) : rowsPlusOne;
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ created_at: last.created_at.toISOString(), id: last.id }) : null;

  const data = rows.map((r) => {
    const lc = r.lead_courses[0];
    const fee = r.fees[0];
    return {
      id: r.id,
      v2_lead_id: r.v2_lead_id,
      full_name: `${r.first_name} ${r.last_name}`.trim(),
      email: r.email,
      phone_number: r.phone_number,
      course_name: lc?.course?.name ?? null,
      institution_name: lc?.course?.institution?.name ?? null,
      funnel_state: lc?.state_v2 ?? null,
      intake_key: r.intake_month,
      visa_accepted_at: iso(r.course_history[0]?.changed_at ?? null),
      spv_status: r.spv_status,
      assigned_to_id: r.assigned_to_id,
      next_fee_due: fee
        ? { fee_id: fee.id, session_label: fee.session_label, due_on: iso(fee.due_on), amount_minor: fee.amount_minor, currency: fee.currency, status: fee.status }
        : null,
    };
  });

  return { data, nextCursor, hasMore, total };
}

export async function getById(ctx: ReadCtx, id: string): Promise<unknown> {
  const row = await ctx.db.crmLead.findFirst({
    where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    include: {
      applications: {
        where: { deleted_at: null },
        orderBy: { intake_key: 'asc' },
        include: { course: { select: { id: true, name: true, institution: { select: { name: true } } } } },
      },
      lead_courses: {
        where: { deleted_at: null },
        include: { course: { select: { id: true, name: true, institution: { select: { name: true } } } } },
      },
      course_history: { orderBy: { changed_at: 'desc' } },
      payments: { where: { deleted_at: null }, orderBy: { received_at: 'desc' } },
      remarks: { where: { deleted_at: null }, orderBy: { v2_created_at: 'desc' } },
      follow_ups: { where: { deleted_at: null }, orderBy: { date: 'desc' } },
      calls: { where: { deleted_at: null }, orderBy: { v2_created_at: 'desc' } },
      visits: { where: { deleted_at: null }, orderBy: { v2_created_at: 'desc' } },
      assignments: { where: { deleted_at: null } },
      qualifications: { where: { deleted_at: null } },
      language_tests: { where: { deleted_at: null } },
      guardians: { where: { deleted_at: null } },
      fees: { where: { deleted_at: null }, orderBy: { due_on: 'asc' } },
      student: { select: { id: true, student_code: true, given_name: true, family_name: true } },
    },
  });
  if (!row) throw NotFound('Lead not found');
  return { ...row, full_name: `${row.first_name} ${row.last_name}`.trim() };
}

export async function update(ctx: Ctx, id: string, input: UpdateCrmLeadRequest, ifMatch: string | undefined): Promise<unknown> {
  const { db, tenantId, actorId } = ctx;
  const expected = parseIfMatch(ifMatch);
  const current = await db.crmLead.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    select: { id: true, version: true, spv_status: true, assigned_to_id: true },
  });
  if (!current) throw NotFound('Lead not found');
  if (current.version !== expected) throw Conflict(`Version mismatch (have ${current.version}, expected ${expected})`);

  const data: Prisma.CrmLeadUncheckedUpdateInput = { updated_by_id: actorId, version: { increment: 1 } };
  if (input.spv_status !== undefined) data.spv_status = input.spv_status;
  if (input.assigned_to_id !== undefined) data.assigned_to_id = input.assigned_to_id;
  if (input.spv_notes !== undefined) data.spv_notes = input.spv_notes ?? null;

  const updated = await db.crmLead.update({ where: { id }, data });
  await writeAudit({
    action: 'crm_lead.updated', entityType: 'crm_lead', entityId: id, actorId, tenantId,
    before: { spv_status: current.spv_status, assigned_to_id: current.assigned_to_id },
    after: { spv_status: updated.spv_status, assigned_to_id: updated.assigned_to_id },
  } as never);
  return { ...updated, full_name: `${updated.first_name} ${updated.last_name}`.trim() };
}

// -----------------------------------------------------------------------------
// Fees
// -----------------------------------------------------------------------------

async function assertOwnsLead(db: Db, tenantId: string, leadId: string): Promise<void> {
  const exists = await db.crmLead.findFirst({ where: { id: leadId, tenant_id: tenantId, deleted_at: null }, select: { id: true } });
  if (!exists) throw NotFound('Lead not found');
}

type FeeRow = {
  id: string; lead_id: string; application_id: string | null; session_label: string;
  amount_minor: bigint; currency: string; due_on: Date; status: string;
  paid_at: Date | null; paid_amount_minor: bigint | null; notes: string | null;
  seeded_from_v2: boolean; version: number; created_at: Date;
};

function toFee(f: FeeRow) {
  return {
    id: f.id, lead_id: f.lead_id, application_id: f.application_id, session_label: f.session_label,
    amount_minor: f.amount_minor, currency: f.currency, due_on: iso(f.due_on), status: f.status,
    paid_at: iso(f.paid_at), paid_amount_minor: f.paid_amount_minor, notes: f.notes,
    seeded_from_v2: f.seeded_from_v2, version: f.version, created_at: iso(f.created_at),
  };
}

async function getFee(db: Db, tenantId: string, leadId: string, feeId: string): Promise<FeeRow> {
  const fee = await db.crmLeadFee.findFirst({ where: { id: feeId, lead_id: leadId, tenant_id: tenantId, deleted_at: null } });
  if (!fee) throw NotFound('Fee not found');
  return fee as FeeRow;
}

export async function createFee(ctx: Ctx, leadId: string, input: CreateCrmLeadFeeRequest): Promise<unknown> {
  const { db, tenantId, actorId } = ctx;
  await assertOwnsLead(db, tenantId, leadId);
  const created = await db.crmLeadFee.create({
    data: {
      tenant_id: tenantId, lead_id: leadId, application_id: input.application_id ?? null,
      session_label: input.session_label, amount_minor: input.amount_minor, currency: input.currency,
      due_on: new Date(input.due_on), status: 'SCHEDULED', notes: input.notes ?? null,
      seeded_from_v2: false, created_by_id: actorId, updated_by_id: actorId,
    },
  });
  await writeAudit({ action: 'crm_lead.fee.created', entityType: 'crm_lead_fee', entityId: created.id, actorId, tenantId, after: { lead_id: leadId, amount_minor: created.amount_minor, due_on: input.due_on } } as never);
  return toFee(created as FeeRow);
}

export async function updateFee(ctx: Ctx, leadId: string, feeId: string, input: UpdateCrmLeadFeeRequest, ifMatch: string | undefined): Promise<unknown> {
  const { db, tenantId, actorId } = ctx;
  const expected = parseIfMatch(ifMatch);
  const current = await getFee(db, tenantId, leadId, feeId);
  if (current.version !== expected) throw Conflict(`Version mismatch (have ${current.version}, expected ${expected})`);
  const data: Prisma.CrmLeadFeeUncheckedUpdateInput = { updated_by_id: actorId, version: { increment: 1 } };
  if (input.session_label !== undefined) data.session_label = input.session_label;
  if (input.amount_minor !== undefined) data.amount_minor = input.amount_minor;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.due_on !== undefined) data.due_on = new Date(input.due_on);
  if (input.status !== undefined) data.status = input.status;
  if (input.notes !== undefined) data.notes = input.notes ?? null;
  const updated = await db.crmLeadFee.update({ where: { id: feeId }, data });
  await writeAudit({ action: 'crm_lead.fee.updated', entityType: 'crm_lead_fee', entityId: feeId, actorId, tenantId, after: { status: updated.status, amount_minor: updated.amount_minor } } as never);
  return toFee(updated as FeeRow);
}

// SVT-SYNC-2026-06 — A7: dismiss all non-terminal reminders pointing at a given
// source entity. Called when a fee is paid/waived/deleted so the "payment due"
// reminder staircase stops firing. Only touches PENDING/SENT/SNOOZED (the
// non-terminal states allowed to transition to DISMISSED by the FSM).
async function dismissRemindersForEntity(db: Db, tenantId: string, entityType: string, entityId: string): Promise<number> {
  const result = await db.reminder.updateMany({
    where: {
      tenant_id: tenantId,
      source_entity_type: entityType,
      source_entity_id: entityId,
      status: { in: ['PENDING', 'SENT', 'SNOOZED'] },
    },
    data: { status: 'DISMISSED' },
  });
  if (result.count > 0) {
    logger.info({ tenantId, entityType, entityId, dismissed: result.count }, 'dismissRemindersForEntity: auto-dismissed stale reminders');
  }
  return result.count;
}

export async function markFeePaid(ctx: Ctx, leadId: string, feeId: string, input: MarkCrmFeePaidRequest): Promise<unknown> {
  const { db, tenantId, actorId } = ctx;
  const current = await getFee(db, tenantId, leadId, feeId);
  if (current.status === 'PAID') throw Conflict('Fee is already paid');
  // SVT-FIN-2026-06: atomic status guard closes the TOCTOU between the read
  // above and the write — two concurrent "pay" calls can't both record a
  // payment on the same money row (the WHERE status != PAID lets exactly one win).
  const result = await db.crmLeadFee.updateMany({
    where: { id: feeId, lead_id: leadId, tenant_id: tenantId, deleted_at: null, status: { not: 'PAID' } },
    data: { status: 'PAID', paid_at: new Date(input.paid_on), paid_amount_minor: input.paid_amount_minor ?? current.amount_minor, updated_by_id: actorId, version: { increment: 1 } },
  });
  if (result.count === 0) throw Conflict('Fee is already paid');
  const updated = await getFee(db, tenantId, leadId, feeId);
  // SVT-SYNC-2026-06 — A7: dismiss PENDING/SENT reminders that reference this fee.
  // Without this, "payment due in 7 days" notifications keep firing for a paid fee.
  await dismissRemindersForEntity(db, tenantId, 'crm_lead_fee', feeId);
  await writeAudit({ action: 'crm_lead.fee.paid', entityType: 'crm_lead_fee', entityId: feeId, actorId, tenantId, after: { paid_on: input.paid_on } } as never);
  return toFee(updated);
}

export async function waiveFee(ctx: Ctx, leadId: string, feeId: string): Promise<unknown> {
  const { db, tenantId, actorId } = ctx;
  const current = await getFee(db, tenantId, leadId, feeId);
  if (current.status === 'PAID') throw Conflict('Cannot waive a paid fee');
  // SVT-FIN-2026-06: atomic guard — never waive a fee that was concurrently paid.
  const result = await db.crmLeadFee.updateMany({
    where: { id: feeId, lead_id: leadId, tenant_id: tenantId, deleted_at: null, status: { not: 'PAID' } },
    data: { status: 'WAIVED', updated_by_id: actorId, version: { increment: 1 } },
  });
  if (result.count === 0) throw Conflict('Cannot waive a paid fee');
  const updated = await getFee(db, tenantId, leadId, feeId);
  // SVT-SYNC-2026-06 — A7: waived fee → no more payment-due notifications.
  await dismissRemindersForEntity(db, tenantId, 'crm_lead_fee', feeId);
  await writeAudit({ action: 'crm_lead.fee.waived', entityType: 'crm_lead_fee', entityId: feeId, actorId, tenantId } as never);
  return toFee(updated);
}

export async function deleteFee(ctx: Ctx, leadId: string, feeId: string): Promise<void> {
  const { db, tenantId, actorId } = ctx;
  await getFee(db, tenantId, leadId, feeId);
  await db.crmLeadFee.update({ where: { id: feeId }, data: { deleted_at: new Date(), deleted_by_id: actorId } });
  // SVT-SYNC-2026-06 — A7: deleted fee → dismiss its reminders.
  await dismissRemindersForEntity(db, tenantId, 'crm_lead_fee', feeId);
  await writeAudit({ action: 'crm_lead.fee.deleted', entityType: 'crm_lead_fee', entityId: feeId, actorId, tenantId } as never);
}

// -----------------------------------------------------------------------------
// On-demand V2 sync
// -----------------------------------------------------------------------------

export async function triggerSync(
  ctx: Ctx,
): Promise<{ job_run_id: string | null; status: string; rows_processed: number; fees_seeded: number }> {
  const { tenantId, actorId } = ctx;
  let rowsProcessed = 0;
  let feesSeeded = 0;
  let ran = false;

  const jobRunId = await runJob('v2.ingest', { ttlSec: 30 * 60 }, async () => {
    const r: IngestResult = await ingestForTenant(tenantId);
    rowsProcessed = r.rowsProcessed;
    feesSeeded = r.feesSeeded;
    ran = true;
    return { rowsProcessed: r.rowsProcessed, rowsFailed: r.rowsFailed, metadata: { studentsUpserted: r.studentsUpserted, feesSeeded: r.feesSeeded, tenant: tenantId } };
  });

  // Distinguish the no-run outcomes so the UI can say "already running" vs
  // "failed" instead of a misleading generic failure. When our pass didn't run,
  // read the recorded JobRun status (another sync may hold the advisory lock →
  // SKIPPED_LOCKED). JobRun has no tenant_id/RLS so the scoped client reads fine.
  let status: string;
  if (ran) {
    status = 'SUCCEEDED';
  } else if (jobRunId) {
    const jr = await ctx.db.jobRun
      .findUnique({ where: { id: jobRunId }, select: { status: true } })
      .catch(() => null);
    status = jr?.status === 'SKIPPED_LOCKED' ? 'ALREADY_RUNNING' : (jr?.status ?? 'FAILED');
  } else {
    status = 'FAILED';
  }
  await writeAudit({ action: 'crm_lead.sync.triggered', entityType: 'JobRun', entityId: jobRunId, actorId, tenantId, after: { status, rows_processed: rowsProcessed, fees_seeded: feesSeeded } } as never);
  return { job_run_id: jobRunId, status, rows_processed: rowsProcessed, fees_seeded: feesSeeded };
}

// -----------------------------------------------------------------------------
// Convert a CRM lead → a managed Student (the integration bridge). Reuses the
// students service so encryption, student_code allocation, initial-stage
// assignment + audit all match a normally-created student; then links
// crm_lead.student_id (1:1). The admin confirms a payload pre-filled from the
// lead on the client (required Student fields like nationality aren't in V2).
// -----------------------------------------------------------------------------

export async function convertLeadToStudent(
  ctx: Ctx,
  leadId: string,
  input: ConvertLeadToStudentRequest,
): Promise<{ student_id: string; student_code: string; lead_id: string; fees_migrated: number; enrollment_created: boolean }> {
  const { db, tenantId, actorId } = ctx;
  // program_id is the optional reconciliation pick (app-catalog Program to enrol
  // into); acknowledge_duplicate is the dedup-guard override. Strip both before
  // handing the rest to the students-create path.
  const { program_id, acknowledge_duplicate, ...studentInput } = input;

  const lead = await db.crmLead.findFirst({
    where: { id: leadId, tenant_id: tenantId, deleted_at: null },
    select: { id: true, student_id: true },
  });
  if (!lead) throw NotFound('Lead not found');
  if (lead.student_id) throw Conflict('Lead is already linked to a student');

  // SVT-DEDUP-2026-06 — guard against silently creating a SECOND managed student
  // for someone who already exists (CRM-converted vs manually-added duplicate →
  // double fee schedules, split history). Match on the strong (family + given
  // name, DOB) key — all plain, indexed columns (students_tenant_family_given
  // idx). On a hit we 409 with the candidate matches so the admin can link to
  // the existing record instead; acknowledge_duplicate bypasses it for the rare
  // genuine namesake-with-same-birthday case.
  if (!acknowledge_duplicate) {
    const candidates = await db.student.findMany({
      where: {
        tenant_id: tenantId,
        deleted_at: null,
        given_name: { equals: studentInput.given_name, mode: 'insensitive' },
        family_name: { equals: studentInput.family_name, mode: 'insensitive' },
        date_of_birth: new Date(studentInput.date_of_birth),
      },
      select: { id: true, student_code: true, given_name: true, family_name: true },
      take: 5,
    });
    if (candidates.length > 0) {
      throw new HttpError({
        status: 409,
        title: 'Conflict',
        code: 'duplicate_student_candidates',
        detail: `A managed student with this name and date of birth already exists (${candidates
          .map((c) => c.student_code)
          .join(', ')}). Link to the existing record, or re-submit acknowledging the duplicate to convert anyway.`,
        errors: candidates.map((c) => ({
          path: c.id,
          message: `${c.student_code} — ${c.given_name} ${c.family_name}`,
          code: 'existing_student',
        })),
      });
    }
  }

  // Create the Student through the students service — identical path to a manual
  // create (passport-name encryption, SPV-code allocation, initial stage, audit).
  const student = (await createStudent({ db, tenantId, actorId }, studentInput)) as {
    id: string;
    student_code: string;
  };

  // SVT-REL-2026-06 — link the lead AND migrate its fee schedule onto the
  // student ATOMICALLY. Previously the link, then each CrmLeadFee→FinanceItem
  // move (+ source soft-delete), ran as independent statements with a per-fee
  // try/catch, so a crash mid-loop left the lead linked but only SOME fees moved
  // — and because the lead was now linked, the convert could never be retried to
  // finish (unrecoverable, money-touching). All-or-nothing here: a failure rolls
  // back the link + every fee, so a fresh retry (new idempotency key) re-runs
  // cleanly (the just-created student surfaces via the dup guard). Raw prisma tx
  // + manual set_config — the tenant-scoped client wraps each op in its own inner
  // tx which would break atomicity (see students.service.create).
  // (Enrollment is intentionally NOT auto-created — a curated Program/Institution
  // is required; fabricating catalog rows from CRM free-text would corrupt it.)
  const feeStatusMap: Record<string, 'PENDING' | 'PAID' | 'OVERDUE' | 'WAIVED'> = {
    SCHEDULED: 'PENDING', DUE: 'PENDING', OVERDUE: 'OVERDUE', PAID: 'PAID', WAIVED: 'WAIVED',
  };
  let feesMigrated = 0;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    // Link lead → student, guarded against a concurrent double-convert: only link
    // if still unlinked. If another request won the race, the 409 rolls the tx back.
    const linked = await tx.crmLead.updateMany({
      where: { id: leadId, tenant_id: tenantId, student_id: null },
      data: { student_id: student.id, converted_at: new Date(), converted_by_id: actorId },
    });
    if (linked.count === 0) {
      throw Conflict('Lead was just linked to a student by another request');
    }
    const leadFees = await tx.crmLeadFee.findMany({
      where: { lead_id: leadId, tenant_id: tenantId, deleted_at: null },
      select: { id: true, session_label: true, amount_minor: true, currency: true, due_on: true, status: true, paid_at: true },
    });
    for (const lf of leadFees) {
      await tx.financeItem.create({
        data: {
          tenant_id: tenantId,
          student_id: student.id,
          category: 'TUITION',
          description: lf.session_label,
          amount_minor: lf.amount_minor,
          currency: lf.currency,
          due_on: lf.due_on,
          paid_on: lf.paid_at,
          status: feeStatusMap[lf.status] ?? 'PENDING',
        },
      });
      await tx.crmLeadFee.update({
        where: { id: lf.id },
        data: { deleted_at: new Date(), deleted_by_id: actorId },
      });
      feesMigrated += 1;
    }
  });

  // Reconciliation: if the admin matched/picked an app-catalog Program, enrol the
  // new student into it (institution derived from the Program; createForStudent
  // handles capacity + program/institution consistency). We never fabricate a
  // Program — only enrol into one that already exists in the curated catalog.
  let enrollmentCreated = false;
  if (program_id) {
    try {
      const program = await db.program.findFirst({
        where: { id: program_id, tenant_id: tenantId, deleted_at: null },
        select: { id: true, institution_id: true },
      });
      if (program) {
        await createEnrollmentForStudent({ db, tenantId, actorId }, student.id, {
          institution_id: program.institution_id,
          program_id: program.id,
          status: 'ACCEPTED',
          scholarship_minor: 0n,
        } as Parameters<typeof createEnrollmentForStudent>[2]);
        enrollmentCreated = true;
      } else {
        logger.warn({ leadId, program_id }, 'convertLeadToStudent: picked program not found — student created without enrollment');
      }
    } catch (err) {
      // Enrollment is best-effort — the student + link + fees already succeeded;
      // a capacity/consistency failure must not roll those back. Admin can enrol
      // manually from the Studies tab.
      logger.warn({ err, leadId, program_id }, 'convertLeadToStudent: enrollment creation failed (student still created)');
    }
  }

  await writeAudit({
    action: 'crm_lead.converted_to_student',
    entityType: 'CrmLead',
    entityId: leadId,
    actorId,
    tenantId,
    after: { student_id: student.id, student_code: student.student_code, fees_migrated: feesMigrated, enrollment_created: enrollmentCreated },
  } as never);

  return { student_id: student.id, student_code: student.student_code, lead_id: leadId, fees_migrated: feesMigrated, enrollment_created: enrollmentCreated };
}

// -----------------------------------------------------------------------------
// Finance summary (reconcile + report) — all amounts grouped PER CURRENCY and
// summed as BigInt in the DB. Outstanding/collected come from SPVT fees only;
// V2 payments are reported SEPARATELY (historical record, never netted).
// -----------------------------------------------------------------------------

type CurrencyAmount = { currency: string; amount_minor: string };

function toCurrencyAmounts(
  rows: Array<{ currency: string; _sum: { amount_minor?: bigint | null; paid_amount_minor?: bigint | null } }>,
  field: 'amount_minor' | 'paid_amount_minor',
): CurrencyAmount[] {
  return rows
    .map((r) => ({ currency: r.currency, amount_minor: (r._sum[field] ?? 0n).toString() }))
    .filter((r) => r.amount_minor !== '0')
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export async function financeSummary(
  ctx: ReadCtx,
): Promise<{ outstanding: CurrencyAmount[]; collected: CurrencyAmount[]; payments: CurrencyAmount[]; lead_count: number }> {
  const { db, tenantId } = ctx;
  const [outstandingRows, collectedRows, paymentRows, leadCount] = await Promise.all([
    db.crmLeadFee.groupBy({
      by: ['currency'],
      where: { tenant_id: tenantId, deleted_at: null, status: { in: [...OPEN_FEE_STATUSES] } },
      _sum: { amount_minor: true },
    }),
    db.crmLeadFee.groupBy({
      by: ['currency'],
      where: { tenant_id: tenantId, deleted_at: null, status: 'PAID' },
      _sum: { paid_amount_minor: true },
    }),
    db.crmPayment.groupBy({
      by: ['currency'],
      where: { tenant_id: tenantId, deleted_at: null },
      _sum: { amount_minor: true },
    }),
    db.crmLead.count({ where: { tenant_id: tenantId, deleted_at: null } }),
  ]);
  return {
    outstanding: toCurrencyAmounts(outstandingRows, 'amount_minor'),
    collected: toCurrencyAmounts(collectedRows, 'paid_amount_minor'),
    payments: toCurrencyAmounts(paymentRows, 'amount_minor'),
    lead_count: leadCount,
  };
}

// -----------------------------------------------------------------------------
// Institutions report — read-only aggregate of the CRM institutions the
// visa-accepted leads applied to (mirrored from V2). One row per institution
// with its visa-accepted application count + distinct lead count.
// -----------------------------------------------------------------------------

export async function institutionsReport(ctx: ReadCtx): Promise<{ data: unknown[] }> {
  const { db, tenantId } = ctx;
  const rows = await db.crmLeadCourse.findMany({
    where: { tenant_id: tenantId, state_v2: 'visa_accepted', deleted_at: null },
    select: {
      v2_lead_id: true,
      course: { select: { institution: { select: { id: true, name: true, country: { select: { name: true } } } } } },
    },
  });
  type InstSel = { course: { institution: { id: string; name: string; country: { name: string } | null } | null } | null };
  const map = new Map<string, { institution_id: string | null; name: string; country_name: string | null; visa_accepted: number; leads: Set<number> }>();
  for (const r of rows) {
    const inst = (r as typeof r & InstSel).course?.institution;
    const key = inst?.id ?? 'unknown';
    let e = map.get(key);
    if (!e) {
      e = { institution_id: inst?.id ?? null, name: inst?.name ?? 'Unknown institution', country_name: inst?.country?.name ?? null, visa_accepted: 0, leads: new Set() };
      map.set(key, e);
    }
    e.visa_accepted += 1;
    e.leads.add(r.v2_lead_id);
  }
  const data = [...map.values()]
    .map((e) => ({ institution_id: e.institution_id, name: e.name, country_name: e.country_name, visa_accepted: e.visa_accepted, leads: e.leads.size }))
    .sort((a, b) => b.visa_accepted - a.visa_accepted);
  return { data };
}

// Courses report — read-only CRM aggregate of the courses visa-accepted leads
// got onto, one row per course with its visa-accepted count + distinct leads.
export async function coursesReport(ctx: ReadCtx): Promise<{ data: unknown[] }> {
  const { db, tenantId } = ctx;
  const rows = await db.crmLeadCourse.findMany({
    where: { tenant_id: tenantId, state_v2: 'visa_accepted', deleted_at: null },
    select: {
      v2_lead_id: true,
      v2_course_id: true,
      course: { select: { name: true, institution: { select: { name: true, country: { select: { name: true } } } } } },
    },
  });
  type Sel = { course: { name: string; institution: { name: string; country: { name: string } | null } | null } | null };
  const map = new Map<number, { course_name: string; institution_name: string | null; country_name: string | null; visa_accepted: number; leads: Set<number> }>();
  for (const r of rows) {
    const c = (r as typeof r & Sel).course;
    const key = r.v2_course_id;
    let e = map.get(key);
    if (!e) {
      e = { course_name: c?.name ?? 'Unknown course', institution_name: c?.institution?.name ?? null, country_name: c?.institution?.country?.name ?? null, visa_accepted: 0, leads: new Set() };
      map.set(key, e);
    }
    e.visa_accepted += 1;
    e.leads.add(r.v2_lead_id);
  }
  const data = [...map.values()]
    .map((e) => ({ course_name: e.course_name, institution_name: e.institution_name, country_name: e.country_name, visa_accepted: e.visa_accepted, leads: e.leads.size }))
    .sort((a, b) => b.visa_accepted - a.visa_accepted);
  return { data };
}

// -----------------------------------------------------------------------------
// Applications pipeline — ONE row per application (the real unit of work). A
// lead with N applications appears N times, each with its OWN funnel stage.
// -----------------------------------------------------------------------------

export async function listApplications(
  ctx: ReadCtx,
  q: CrmApplicationListQuery,
): Promise<{ data: unknown[]; nextCursor: string | null; hasMore: boolean; total: number }> {
  const { db, tenantId } = ctx;
  const limit = q.limit;
  const offset = q.offset ?? 0;

  // SVT-V2-APP-LIST-2026-08 — drive the post-visa work queue off lead_courses
  // rather than the crm_application mirror. Rationale: V2's operational
  // reality is that the visa_accepted funnel state lives on LeadCourses (335
  // rows for this tenant), while formal Application entities are sparse
  // (9 rows) and their (v2_lead_id, v2_course_id) rarely aligns with the
  // visa-accepted lead-course. Keying off applications hid ~333 leads that
  // reached the queue. The lead_course IS the funnel — applications enrich
  // it (intake_key, fees) when present but must not gate visibility.
  const where: Prisma.CrmLeadCourseWhereInput = {
    tenant_id: tenantId,
    state_v2: 'visa_accepted',
    deleted_at: null,
  };
  const leadFilter: Prisma.CrmLeadWhereInput = {};
  if (q.assigned_to_id) leadFilter.assigned_to_id = q.assigned_to_id;
  if (q.search) {
    const n = q.search.trim();
    leadFilter.OR = [
      { first_name: { contains: n, mode: 'insensitive' } },
      { last_name: { contains: n, mode: 'insensitive' } },
      { phone_number: { contains: n, mode: 'insensitive' } },
      { email: { contains: n, mode: 'insensitive' } },
    ];
  }
  if (Object.keys(leadFilter).length) where.lead = leadFilter;

  // intake_key + has_upcoming_fee live on the crm_application row. Constrain
  // via the composite v2 key by pre-resolving the matching pairs — Prisma has
  // no direct FK between lead_course and application. Only applied when the
  // client explicitly filters on those fields, so the base "show me everyone
  // visa-accepted" query stays a single indexed scan of lead_courses.
  if (q.intake_key || q.has_upcoming_fee) {
    const appWhere: Prisma.CrmApplicationWhereInput = { tenant_id: tenantId, deleted_at: null };
    if (q.intake_key) appWhere.intake_key = { contains: q.intake_key, mode: 'insensitive' };
    if (q.has_upcoming_fee) appWhere.fees = { some: { deleted_at: null, status: { in: [...OPEN_FEE_STATUSES] } } };
    const gating = await db.crmApplication.findMany({
      where: appWhere,
      select: { v2_lead_id: true, v2_course_id: true },
    });
    if (gating.length === 0) return { data: [], nextCursor: null, hasMore: false, total: 0 };
    where.AND = [{ OR: gating.map((a) => ({ v2_lead_id: a.v2_lead_id, v2_course_id: a.v2_course_id })) }];
  }

  const [rows, total] = await Promise.all([
    db.crmLeadCourse.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
      include: {
        lead: { select: { first_name: true, last_name: true, phone_number: true, spv_status: true, assigned_to_id: true } },
        course: { select: { name: true, institution: { select: { name: true, country: { select: { name: true } } } } } },
      },
    }),
    db.crmLeadCourse.count({ where }),
  ]);

  const hasMore = offset + rows.length < total;
  const nextCursor: string | null = null;

  // Enrich with the matching crm_application (intake_key, application_state)
  // and the first open fee. Both are optional — leads with no formal V2
  // Application still appear in the queue with those fields as null.
  const pairs = rows.map((r) => ({ v2_lead_id: r.v2_lead_id, v2_course_id: r.v2_course_id }));
  const appMap = new Map<string, { id: string; intake_key: string | null; state: string; fees: FeeRow[] }>();
  if (pairs.length) {
    const apps = await db.crmApplication.findMany({
      where: { tenant_id: tenantId, deleted_at: null, OR: pairs },
      select: {
        id: true, intake_key: true, state: true, v2_lead_id: true, v2_course_id: true,
        fees: { where: { deleted_at: null, status: { in: [...OPEN_FEE_STATUSES] } }, orderBy: { due_on: 'asc' }, take: 1 },
      },
    });
    for (const a of apps) {
      const app = a as typeof a & { fees: FeeRow[] };
      appMap.set(`${a.v2_lead_id}|${a.v2_course_id}`, {
        id: app.id, intake_key: app.intake_key, state: app.state, fees: app.fees,
      });
    }
  }

  const data = rows.map((r) => {
    const row = r as typeof r & {
      lead: { first_name: string; last_name: string; phone_number: string; spv_status: string; assigned_to_id: string | null };
      course: { name: string; institution: { name: string; country: { name: string } | null } | null } | null;
    };
    const app = appMap.get(`${row.v2_lead_id}|${row.v2_course_id}`);
    const fee = app?.fees[0];
    return {
      id: app?.id ?? row.id,
      lead_id: row.lead_id,
      applicant_name: `${row.lead.first_name} ${row.lead.last_name}`.trim(),
      phone_number: row.lead.phone_number,
      country_name: row.course?.institution?.country?.name ?? null,
      course_name: row.course?.name ?? null,
      institution_name: row.course?.institution?.name ?? null,
      intake_key: app?.intake_key ?? null,
      stage: row.state_v2 ?? null,
      stage_raw: row.state ?? null,
      application_state: app?.state ?? null,
      spv_status: row.lead.spv_status,
      assigned_to_id: row.lead.assigned_to_id,
      created_at: iso(row.created_at),
      next_fee_due: fee
        ? { fee_id: fee.id, session_label: fee.session_label, due_on: iso(fee.due_on), amount_minor: fee.amount_minor, currency: fee.currency, status: fee.status }
        : null,
    };
  });

  return { data, nextCursor, hasMore, total };
}
