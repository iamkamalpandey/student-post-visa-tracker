// Reminder service. Handles manual reminder CRUD + admin lifecycle actions
// (acknowledge, snooze, dismiss). Auto-generated reminders go through the
// scanner job (jobs/reminderScanner.ts) which talks to Prisma directly.
//
// All operations rely on `req.db` — the tenant-scoped Prisma client created by
// the tenantContext middleware — so RLS catches anything a controller might
// have missed. We still pass tenant_id explicitly into where clauses for
// defence in depth and clearer query plans.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { Conflict, Forbidden, NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateReminderRequest,
  ReminderListQuery,
  SnoozeReminderRequest,
  UpdateReminderRequest,
} from '@spv/zod-schemas';

// ---------------------------------------------------------------------------
// SVT-FSM-2026-05: Reminder lifecycle state-machine guard.
// Now backed by the shared FSM framework (`shared/fsm.ts`) via fsm-def.ts.
// We still preserve the action-keyed error message ("Cannot acknowledge a
// DISMISSED reminder") because the test pins it via regex, so we wrap the
// framework's assert and translate failures into the legacy detail string.
// ---------------------------------------------------------------------------
import { assertTransition } from '../../shared/fsm.js';
import {
  reminderActionToStatus,
  reminderFsm,
  type ReminderAction,
  type ReminderFsmStatus as ReminderStatus,
} from './fsm-def.js';

function assertTransitionAllowed(action: ReminderAction, current: ReminderStatus): void {
  const next = reminderActionToStatus[action];
  // Role/reason aren't gated for reminder actions — the route layer enforces
  // RBAC via requireRole(). Pass ADMIN so the framework's role check is a
  // no-op; we only care about the from/to legality.
  const r = assertTransition(reminderFsm, current, next, 'ADMIN');
  if (r.ok) return;
  throw Conflict(`Cannot ${action} a ${current} reminder`);
}

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

type ReqCtx = { db?: DB; user?: { tid: string; sub: string; role: string } };

// Default scheduled_for for manual reminders: 09:00 UTC on the due date.
// Keeps a deterministic firing window so admins know when to expect alerts.
function defaultScheduledFor(dueOn: string): Date {
  // dueOn is YYYY-MM-DD validated by Iso8601Date.
  return new Date(`${dueOn}T09:00:00.000Z`);
}

// Translate the validated request into Prisma create input. We also surface
// `due_on` as a Date so Prisma accepts it for the @db.Date column.
function toCreateData(body: CreateReminderRequest, tenantId: string, actorId: string) {
  const scheduled = body.scheduled_for ? new Date(body.scheduled_for) : defaultScheduledFor(body.due_on);
  return {
    tenant_id: tenantId,
    student_id: body.student_id ?? null,
    enrollment_id: body.enrollment_id ?? null,
    type: body.type,
    title: body.title,
    description: body.description ?? null,
    due_on: new Date(`${body.due_on}T00:00:00.000Z`),
    scheduled_for: scheduled,
    assigned_to_id: body.assigned_to_id ?? null,
    // Manual rows don't carry a source link; the scanner sets these.
    source_entity_type: null,
    source_entity_id: null,
    status: 'PENDING' as const,
    created_by_id: actorId,
  };
}

function toUpdateData(body: UpdateReminderRequest, actorRole: string) {
  const out: Record<string, unknown> = {};
  if (body.student_id !== undefined) out['student_id'] = body.student_id;
  if (body.enrollment_id !== undefined) out['enrollment_id'] = body.enrollment_id;
  if (body.type !== undefined) out['type'] = body.type;
  if (body.title !== undefined) out['title'] = body.title;
  if (body.description !== undefined) out['description'] = body.description;
  if (body.due_on !== undefined) out['due_on'] = new Date(`${body.due_on}T00:00:00.000Z`);
  if (body.scheduled_for !== undefined) out['scheduled_for'] = new Date(body.scheduled_for);
  // SVT-SEC-2026-05 — assignment is privileged. A COUNSELLOR PATCHing
  // `assigned_to_id` could steal a peer's reminder or hand it to a victim.
  // Only ADMIN may reassign; non-admin requests silently drop the field.
  if (body.assigned_to_id !== undefined && actorRole === 'ADMIN') {
    out['assigned_to_id'] = body.assigned_to_id;
  }
  return out;
}

// SVT-SEC-2026-05 — ownership gate for reminder mutations.
//   ADMIN                                  → always bypasses.
//   Student-bound reminder                 → defer to student.assigned_to_id.
//   Tenant-wide + assigned to specific user → only that user.
//   Tenant-wide + unassigned (broadcast)   → any tenant user (back-compat
//                                            with auto-created reminders).
//   Creator override                       → the row's created_by_id may
//                                            always mutate its own reminder
//                                            (operator UX — don't lock out
//                                            the person who made it).
// Reads (`get`, `list`) intentionally permissive within the tenant; only
// writes flow through this guard.
async function assertReminderWriteAllowed(
  req: ReqCtx,
  row: { student_id: string | null; assigned_to_id: string | null; created_by_id?: string | null },
): Promise<void> {
  const user = req.user;
  if (!user) throw Forbidden();
  if (user.role === 'ADMIN') return;
  // Creator always retains write access to their own row.
  if (row.created_by_id && row.created_by_id === user.sub) return;
  if (row.student_id) {
    const s = await db(req).student.findFirst({
      where: { id: row.student_id, tenant_id: user.tid, deleted_at: null },
      select: { assigned_to_id: true },
    });
    if (!s) throw Forbidden('Not authorised for this reminder');
    if (s.assigned_to_id !== user.sub) throw Forbidden('Not authorised for this reminder');
    return;
  }
  // Tenant-wide. If a specific user is assigned, only they may mutate.
  // Unassigned broadcast reminders stay open to any tenant user (parity with
  // auto-created cron reminders that have no specific recipient).
  if (row.assigned_to_id && row.assigned_to_id !== user.sub) {
    throw Forbidden('Not authorised for this reminder');
  }
}

export const reminderService = {
  async create(req: ReqCtx, body: CreateReminderRequest) {
    const data = toCreateData(body, req.user!.tid, req.user!.sub);
    const created = await db(req).reminder.create({ data: data as never });
    await writeAudit(req as never, {
      action: 'reminder.created',
      entityType: 'reminder',
      entityId: created.id,
      after: created,
    });
    return created;
  },

  async list(req: ReqCtx, q: ReminderListQuery) {
    const tenantId = req.user!.tid;
    const where: Prisma.ReminderWhereInput = {
      tenant_id: tenantId,
      deleted_at: null,
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.assigned_to_id ? { assigned_to_id: q.assigned_to_id } : {}),
      ...(q.student_id ? { student_id: q.student_id } : {}),
      ...(q.due_from || q.due_to
        ? {
            due_on: {
              ...(q.due_from ? { gte: new Date(`${q.due_from}T00:00:00.000Z`) } : {}),
              ...(q.due_to ? { lte: new Date(`${q.due_to}T00:00:00.000Z`) } : {}),
            },
          }
        : {}),
      ...(q.scheduled_from || q.scheduled_to
        ? {
            scheduled_for: {
              ...(q.scheduled_from ? { gte: new Date(q.scheduled_from) } : {}),
              ...(q.scheduled_to ? { lte: new Date(q.scheduled_to) } : {}),
            },
          }
        : {}),
    };
    return db(req).reminder.findMany({
      where,
      // Stable cursor pagination: scheduled_for is the natural ordering for
      // dashboards; tie-break with id so the cursor never skips a row.
      orderBy: [{ scheduled_for: 'asc' }, { id: 'asc' }],
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },

  async get(req: ReqCtx, id: string) {
    const found = await db(req).reminder.findFirst({
      where: { id, tenant_id: req.user!.tid, deleted_at: null },
    });
    if (!found) throw NotFound('Reminder not found');
    return found;
  },

  // SVT-IFMATCH-2026-05 — Reminder has no `version` column, so the optional
  // `_opts.expected` (parsed by the controller from If-Match) is accepted for
  // API parity but ignored. Wire OCC here once the column is added.
  async update(req: ReqCtx, id: string, body: UpdateReminderRequest, _opts?: { expected?: number }) {
    const before = await this.get(req, id);
    await assertReminderWriteAllowed(req, before as never);
    const data = toUpdateData(body, req.user!.role ?? 'COUNSELLOR');
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).reminder.updateMany({
      where: { id, tenant_id: req.user!.tid, deleted_at: null },
      data: data as never,
    });
    if (r.count !== 1) throw NotFound('Reminder not found');
    const after = await db(req).reminder.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'reminder.updated',
      entityType: 'reminder',
      entityId: id,
      before,
      after,
    });
    return after;
  },

  async acknowledge(req: ReqCtx, id: string) {
    const before = await this.get(req, id);
    await assertReminderWriteAllowed(req, before as never);
    // SVT-FSM-2026-05: reject 409 when current state is terminal.
    assertTransitionAllowed('acknowledge', (before as { status: ReminderStatus }).status);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).reminder.updateMany({
      where: { id, tenant_id: req.user!.tid, deleted_at: null },
      data: { status: 'ACKNOWLEDGED', acknowledged_at: new Date() },
    });
    if (r.count !== 1) throw NotFound('Reminder not found');
    const after = await db(req).reminder.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'reminder.acknowledged',
      entityType: 'reminder',
      entityId: id,
      before,
      after,
    });
    return after;
  },

  async snooze(req: ReqCtx, id: string, body: SnoozeReminderRequest) {
    const before = await this.get(req, id);
    await assertReminderWriteAllowed(req, before as never);
    // SVT-FSM-2026-05: reject 409 when current state is terminal.
    assertTransitionAllowed('snooze', (before as { status: ReminderStatus }).status);
    const until = new Date(body.snooze_until);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).reminder.updateMany({
      where: { id, tenant_id: req.user!.tid, deleted_at: null },
      data: {
        status: 'SNOOZED',
        snooze_until: until,
        // Re-arm the dispatcher: pushing scheduled_for to the snooze deadline
        // means the next dispatcher pass won't pick the row up early.
        scheduled_for: until,
      },
    });
    if (r.count !== 1) throw NotFound('Reminder not found');
    const after = await db(req).reminder.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'reminder.snoozed',
      entityType: 'reminder',
      entityId: id,
      before,
      after,
    });
    return after;
  },

  async dismiss(req: ReqCtx, id: string) {
    const before = await this.get(req, id);
    await assertReminderWriteAllowed(req, before as never);
    // SVT-FSM-2026-05: reject 409 when current state is DISMISSED already.
    assertTransitionAllowed('dismiss', (before as { status: ReminderStatus }).status);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).reminder.updateMany({
      where: { id, tenant_id: req.user!.tid, deleted_at: null },
      data: { status: 'DISMISSED' },
    });
    if (r.count !== 1) throw NotFound('Reminder not found');
    const after = await db(req).reminder.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'reminder.dismissed',
      entityType: 'reminder',
      entityId: id,
      before,
      after,
    });
    return after;
  },

  // Admin-only soft delete. We stamp deleted_at rather than removing the row
  // so the audit + comms history stays referentially intact.
  async remove(req: ReqCtx, id: string) {
    if (req.user?.role !== 'ADMIN') throw Forbidden('Only admins can delete reminders');
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).reminder.updateMany({
      where: { id, tenant_id: req.user!.tid, deleted_at: null },
      data: { deleted_at: new Date() },
    });
    if (r.count !== 1) throw NotFound('Reminder not found');
    await writeAudit(req as never, {
      action: 'reminder.deleted',
      entityType: 'reminder',
      entityId: id,
      before,
    });
  },
};
