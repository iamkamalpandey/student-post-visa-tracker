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
import { Conflict, HttpError, NotFound, PreconditionFailed, UnprocessableEntity } from '../../shared/errors.js';
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
  // SVT-QA-2026-08 — terminal-state guard. Editing a PAID/WAIVED fee via
  // generic PATCH would bump version + write a bogus `updated` audit without
  // touching the actual money state. Force callers to use dedicated flows
  // (or first unpay/unwaive via admin path — currently not exposed).
  if (current.status === 'PAID' || current.status === 'WAIVED') {
    throw Conflict(`Cannot edit a ${current.status} fee`);
  }
  const data: Prisma.CrmLeadFeeUncheckedUpdateInput = { updated_by_id: actorId, version: { increment: 1 } };
  if (input.session_label !== undefined) data.session_label = input.session_label;
  if (input.amount_minor !== undefined) data.amount_minor = input.amount_minor;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.due_on !== undefined) data.due_on = new Date(input.due_on);
  // status intentionally dropped from PATCH — see UpdateCrmLeadFeeRequest.
  if (input.notes !== undefined) data.notes = input.notes ?? null;
  // SVT-QA-2026-08 — atomic If-Match. The prior read-then-write pattern let
  // two concurrent PATCHes with the same If-Match: "3" both pass the version
  // check (both saw version=3), both write, both bump version — silent
  // last-writer-wins on every field including money-shape (`amount_minor`).
  // updateMany with the expected version in the where forces exactly one to
  // win; the loser gets 412 like the initial guard intends.
  const result = await db.crmLeadFee.updateMany({
    where: { id: feeId, lead_id: leadId, tenant_id: tenantId, deleted_at: null, version: expected },
    data,
  });
  if (result.count !== 1) throw Conflict(`Version mismatch — row was modified concurrently`);
  const updated = await getFee(db, tenantId, leadId, feeId);
  await writeAudit({ action: 'crm_lead.fee.updated', entityType: 'crm_lead_fee', entityId: feeId, actorId, tenantId, after: { status: (updated as FeeRow).status, amount_minor: (updated as FeeRow).amount_minor } } as never);
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
  // SVT-QA-2026-08 — also block re-pay of WAIVED (was only blocking PAID).
  if (current.status === 'PAID' || current.status === 'WAIVED') {
    throw Conflict(`Fee is already in terminal state (${current.status})`);
  }
  // SVT-FIN-2026-06: atomic status guard closes the TOCTOU between the read
  // above and the write — two concurrent "pay" calls can't both record a
  // payment on the same money row (the WHERE status != PAID lets exactly one win).
  // SVT-FIN-2026-08 — three defects in this one statement:
  //
  // 1. `status: { not: 'PAID' }` omitted WAIVED, so the pre-check above was
  //    defeated by ordering: pay reads SCHEDULED → a concurrent waive commits
  //    → this write still matches (WAIVED != PAID) → a written-off fee
  //    silently became PAID and re-entered financeSummary as revenue
  //    collected. The sibling waiveFee got this right with `notIn`.
  //
  // 2. `current.amount_minor` came from a read with no version guard, so a
  //    concurrent PATCH that legally lowered the fee (allowed while the row is
  //    non-terminal) left this write settling the OLD, higher amount —
  //    over-reporting collections by the difference.
  //
  // 3. Nothing bounded the settled amount by what was actually billed. The
  //    zod schema only requires nonnegative() and the DB CHECK only enforces
  //    >= 0; there is no paid_amount_minor <= amount_minor constraint like the
  //    billing side's fee_installments_paid_le_net.
  //
  // Folding the version into the WHERE fixes (2) the same way updateFee does.
  const settledMinor = input.paid_amount_minor ?? current.amount_minor;
  if (settledMinor > current.amount_minor) {
    throw UnprocessableEntity(
      `Settled amount ${settledMinor} exceeds the billed amount ${current.amount_minor}. Adjust the fee first, or record the surplus separately.`,
    );
  }
  const result = await db.crmLeadFee.updateMany({
    where: {
      id: feeId,
      lead_id: leadId,
      tenant_id: tenantId,
      deleted_at: null,
      status: { notIn: ['PAID', 'WAIVED'] },
      version: current.version,
    },
    data: { status: 'PAID', paid_at: new Date(input.paid_on), paid_amount_minor: settledMinor, updated_by_id: actorId, version: { increment: 1 } },
  });
  if (result.count === 0) {
    throw Conflict('Fee changed while being settled (paid, waived, or amended); reload and retry');
  }
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
  // SVT-QA-2026-08 — block PAID + WAIVED (was only PAID). A repeat waive on
  // an already-WAIVED row silently bumped version and wrote a bogus
  // .waived audit; version churn on a terminal row poisoned the audit trail.
  if (current.status === 'PAID' || current.status === 'WAIVED') {
    throw Conflict(`Fee is already in terminal state (${current.status})`);
  }
  // SVT-FIN-2026-06: atomic guard — never waive a fee that was concurrently
  // paid or already waived. `notIn` closes both TOCTOUs in one predicate.
  const result = await db.crmLeadFee.updateMany({
    where: { id: feeId, lead_id: leadId, tenant_id: tenantId, deleted_at: null, status: { notIn: ['PAID', 'WAIVED'] } },
    data: { status: 'WAIVED', updated_by_id: actorId, version: { increment: 1 } },
  });
  if (result.count === 0) throw Conflict('Fee reached a terminal state concurrently');
  const updated = await getFee(db, tenantId, leadId, feeId);
  // SVT-SYNC-2026-06 — A7: waived fee → no more payment-due notifications.
  await dismissRemindersForEntity(db, tenantId, 'crm_lead_fee', feeId);
  await writeAudit({ action: 'crm_lead.fee.waived', entityType: 'crm_lead_fee', entityId: feeId, actorId, tenantId } as never);
  return toFee(updated);
}

export async function deleteFee(ctx: Ctx, leadId: string, feeId: string): Promise<void> {
  const { db, tenantId, actorId } = ctx;
  await getFee(db, tenantId, leadId, feeId);
  // SVT-QA-2026-08 — atomic soft-delete. Two admins deleting the same fee
  // concurrently would both pass getFee, both write, both bump version,
  // both fanout audit + reminder-dismiss. `updateMany where deleted_at IS
  // NULL` lets exactly one win; the loser's audit + fanout are skipped.
  // SVT-FIN-2026-08 — settled money cannot be deleted out of the books.
  // updateFee refuses to touch a PAID/WAIVED fee and markFeePaid/waiveFee both
  // refuse terminal transitions, but DELETE had no status predicate at all —
  // and the route allows COUNSELLOR. Since every financeSummary aggregate
  // filters `deleted_at: null`, one call made collected revenue vanish from
  // every report. An audit row was written, but the number was gone.
  const currentStatus = (await getFee(db, tenantId, leadId, feeId)).status;
  if (currentStatus === 'PAID' || currentStatus === 'WAIVED') {
    throw Conflict(
      `Cannot delete a ${currentStatus} fee — it is part of the financial record. Reverse the settlement first if it was recorded in error.`,
    );
  }
  const result = await db.crmLeadFee.updateMany({
    where: {
      id: feeId,
      lead_id: leadId,
      tenant_id: tenantId,
      deleted_at: null,
      status: { notIn: ['PAID', 'WAIVED'] },
    },
    data: { deleted_at: new Date(), deleted_by_id: actorId },
  });
  if (result.count === 0) return; // already deleted by concurrent request
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

  // SVT-QA-2026-08 — join to student so a soft-deleted target no longer
  // permanently locks the lead. Previously `if (lead.student_id) throw` fired
  // on any non-null student_id regardless of `student.deleted_at`; a mis-
  // converted lead that was later cleaned up became un-re-convertible with
  // no API path to reset. Now: block only if the linked student is LIVE.
  const lead = await db.crmLead.findFirst({
    where: { id: leadId, tenant_id: tenantId, deleted_at: null },
    select: {
      id: true,
      student_id: true,
      student: { select: { deleted_at: true } },
    },
  });
  if (!lead) throw NotFound('Lead not found');
  if (lead.student_id && lead.student && lead.student.deleted_at === null) {
    throw Conflict('Lead is already linked to a live managed student');
  }

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
  // SVT-QA-2026-08 (LEAD-C1) — compensating cleanup for the just-created
  // Student. `createStudent` runs OUTSIDE this transaction because it holds an
  // advisory lock to allocate the SPV-YYYY-NNNNNN code and wraps that in its
  // own tx; nesting it here would serialise unrelated creates. The consequence
  // was an orphan: if THIS tx then failed (concurrent linker won the
  // updateMany race, a FinanceItem insert violated a constraint, connection
  // dropped mid-commit) the Student row was already durable, unlinked, and
  // unreachable through any UI. Worse, the dedup guard then matched that
  // orphan on retry, forcing `acknowledge_duplicate: true`, which minted a
  // SECOND orphan — one more per attempt, each consuming a student code.
  //
  // Fix: on any failure of the linking tx, soft-delete the student we just
  // created before rethrowing. The cleanup is best-effort and never masks the
  // original error — a failure to clean up is logged loudly with the orphan's
  // id so an operator can reconcile.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      // Link lead → student, guarded against a concurrent double-convert: only link
      // if still unlinked. If another request won the race, the 409 rolls the tx back.
      const linked = await tx.crmLead.updateMany({
        where: { id: leadId, tenant_id: tenantId, student_id: null },
        data: {
          student_id: student.id,
          converted_at: new Date(),
          converted_by_id: actorId,
          // SVT-QA-2026-08 (LEAD-M1) — a converted lead is done; leaving it
          // ACTIVE kept it in the open work queue and in financeSummary's
          // lead_count even though its fees had moved to the student ledger.
          spv_status: 'COMPLETED',
        },
      });
      if (linked.count === 0) {
        throw Conflict('Lead was just linked to a student by another request');
      }
      const leadFees = await tx.crmLeadFee.findMany({
        where: { lead_id: leadId, tenant_id: tenantId, deleted_at: null },
        select: {
          id: true, session_label: true, amount_minor: true, currency: true,
          due_on: true, status: true, paid_at: true, paid_amount_minor: true,
        },
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
            // SVT-QA-2026-08 (LEAD-H5) — carry the partial-payment amount.
            // Without this a fee marked PAID for 2,500 of 10,000 migrated as
            // a fully-settled 10,000 item and the 7,500 shortfall silently
            // left the books.
            paid_amount_minor: lf.paid_amount_minor,
            status: feeStatusMap[lf.status] ?? 'PENDING',
          },
        });
        await tx.crmLeadFee.update({
          where: { id: lf.id },
          data: { deleted_at: new Date(), deleted_by_id: actorId },
        });
        feesMigrated += 1;
      }
      // SVT-QA-2026-08 (LEAD-M1) — the lead's open follow-ups are obsolete
      // once it is converted; leaving them PENDING kept the reminder
      // staircase firing against a lead nobody works anymore.
      await tx.crmFollowUp.updateMany({
        where: { lead_id: leadId, tenant_id: tenantId, deleted_at: null },
        data: { deleted_at: new Date() },
      });
    });
  } catch (err) {
    try {
      await db.student.updateMany({
        where: { id: student.id, tenant_id: tenantId, deleted_at: null },
        data: { deleted_at: new Date() },
      });
      logger.warn(
        { leadId, studentId: student.id, studentCode: student.student_code },
        'convertLeadToStudent: link tx failed — rolled back the orphaned student',
      );
    } catch (cleanupErr) {
      // Loud: an operator must reconcile this student code by hand.
      logger.error(
        { err: cleanupErr, leadId, studentId: student.id, studentCode: student.student_code },
        'convertLeadToStudent: ORPHAN STUDENT — link tx failed AND cleanup failed; manual reconciliation required',
      );
    }
    throw err;
  }

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
  //
  // SVT-V2-APP-LIST-2026-08-02 — v2 permits >1 application per (lead, course)
  // via distinct intake_keys (uniqueness is tenant_id+lead_id+course_id+intake_key).
  // We enrich with a DETERMINISTIC winner:
  //  - if the caller filtered by q.intake_key, re-apply that filter so the
  //    displayed intake matches the filter;
  //  - otherwise pick the most recent application (created_at desc, id desc).
  // First-write-wins on `appMap.set` combined with orderBy DESC yields the
  // newest matching app, stable across renders.
  const pairs = rows.map((r) => ({ v2_lead_id: r.v2_lead_id, v2_course_id: r.v2_course_id }));
  const appMap = new Map<string, { id: string; intake_key: string | null; state: string; fees: FeeRow[] }>();
  if (pairs.length) {
    const enrichWhere: Prisma.CrmApplicationWhereInput = {
      tenant_id: tenantId, deleted_at: null, OR: pairs,
    };
    if (q.intake_key) enrichWhere.intake_key = { contains: q.intake_key, mode: 'insensitive' };
    const apps = await db.crmApplication.findMany({
      where: enrichWhere,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: {
        id: true, intake_key: true, state: true, v2_lead_id: true, v2_course_id: true,
        fees: { where: { deleted_at: null, status: { in: [...OPEN_FEE_STATUSES] } }, orderBy: { due_on: 'asc' }, take: 1 },
      },
    });
    for (const a of apps) {
      const app = a as typeof a & { fees: FeeRow[] };
      const key = `${a.v2_lead_id}|${a.v2_course_id}`;
      if (appMap.has(key)) continue; // first-write-wins: newest app (see comment above)
      appMap.set(key, {
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
