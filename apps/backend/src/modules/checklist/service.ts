// Per-stage checklist tasks + per-student progress.
//
// Two resource families share this module:
//   * LifecycleStageChecklistItem — definitions live on a stage.
//   * StudentStageChecklistProgress — toggle completion per student per item.
//
// All DB calls go through the request-scoped RLS client. We never fall back to
// the singleton — that would skip tenant isolation. The service signature takes
// the explicit Db so unit tests can pass a mock, but every controller invocation
// must source it from req.db (see controller.ts).
import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  CreateChecklistItemRequest,
  UpdateChecklistItemRequest,
  UpsertChecklistProgressRequest,
} from '@spv/zod-schemas';
import { Conflict, NotFound } from '../../shared/errors.js';

type Db = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Items (per stage)
// ---------------------------------------------------------------------------

export async function listItems(
  db: Db,
  tenantId: string,
  stageId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<unknown[]> {
  // Confirm the stage exists in this tenant. RLS makes the inner findMany safe,
  // but this gives the caller a clean 404 instead of an empty list when the id
  // is bogus.
  const stage = await db.lifecycleStage.findFirst({
    where: { id: stageId, tenant_id: tenantId },
    select: { id: true },
  });
  if (!stage) throw NotFound('Stage not found');

  const where: Prisma.LifecycleStageChecklistItemWhereInput = {
    tenant_id: tenantId,
    stage_id: stageId,
    deleted_at: null,
  };
  if (!opts.includeInactive) where.is_active = true;

  return db.lifecycleStageChecklistItem.findMany({
    where,
    orderBy: [{ sequence: 'asc' }, { created_at: 'asc' }],
  });
}

export async function createItem(
  db: Db,
  tenantId: string,
  stageId: string,
  input: CreateChecklistItemRequest,
): Promise<unknown> {
  const stage = await db.lifecycleStage.findFirst({
    where: { id: stageId, tenant_id: tenantId },
    select: { id: true },
  });
  if (!stage) throw NotFound('Stage not found');

  // If sequence omitted, append to the end (max + 1).
  let sequence = input.sequence;
  if (sequence === undefined) {
    const max = await db.lifecycleStageChecklistItem.aggregate({
      where: { stage_id: stageId, deleted_at: null },
      _max: { sequence: true },
    });
    sequence = (max._max.sequence ?? -1) + 1;
  }

  return db.lifecycleStageChecklistItem.create({
    data: {
      tenant_id: tenantId,
      stage_id: stageId,
      label: input.label,
      description: input.description ?? null,
      sequence,
      is_required: input.is_required ?? true,
      sla_hours: input.sla_hours ?? null,
      is_active: input.is_active ?? true,
    },
  });
}

export async function updateItem(
  db: Db,
  tenantId: string,
  id: string,
  input: UpdateChecklistItemRequest,
  // SVT-IF-MATCH-2026-05 — accepted for controller parity;
  // LifecycleStageChecklistItem has no `version` column so optimistic-
  // concurrency is a no-op here. Field kept in the signature so callers
  // don't break when the column lands later.
  _opts?: { expected?: number },
): Promise<unknown> {
  void _opts;
  const found = await db.lifecycleStageChecklistItem.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!found) throw NotFound('Checklist item not found');

  const data: Prisma.LifecycleStageChecklistItemUpdateManyMutationInput = {};
  if (input.label !== undefined) data.label = input.label;
  if (input.description !== undefined) data.description = input.description ?? null;
  if (input.sequence !== undefined) data.sequence = input.sequence;
  if (input.is_required !== undefined) data.is_required = input.is_required;
  if (input.sla_hours !== undefined) data.sla_hours = input.sla_hours ?? null;
  if (input.is_active !== undefined) data.is_active = input.is_active;

  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await db.lifecycleStageChecklistItem.updateMany({
    where: { id, tenant_id: tenantId, deleted_at: null },
    data,
  });
  if (wr.count !== 1) throw NotFound('Checklist item not found');
  return db.lifecycleStageChecklistItem.findFirstOrThrow({
    where: { id, tenant_id: tenantId },
  });
}

// Soft delete — preserves any existing student progress rows. Hard cascade
// would orphan completion history; we never want that in audit territory.
export async function removeItem(db: Db, tenantId: string, id: string): Promise<void> {
  const r = await db.lifecycleStageChecklistItem.updateMany({
    where: { id, tenant_id: tenantId, deleted_at: null },
    data: { deleted_at: new Date(), is_active: false },
  });
  if (r.count === 0) throw NotFound('Checklist item not found');
}

// ---------------------------------------------------------------------------
// Progress (per student)
// ---------------------------------------------------------------------------

export async function listProgress(
  db: Db,
  tenantId: string,
  studentId: string,
  stageId: string,
): Promise<unknown[]> {
  // Tenant scope: confirm student belongs here.
  const student = await db.student.findFirst({
    where: { id: studentId, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!student) throw NotFound('Student not found');

  return db.studentStageChecklistProgress.findMany({
    where: { tenant_id: tenantId, student_id: studentId, stage_id: stageId },
  });
}

export async function upsertProgress(
  db: Db,
  tenantId: string,
  studentId: string,
  actorId: string,
  input: UpsertChecklistProgressRequest,
  // SVT-IF-MATCH-2026-05 — accepted for controller parity;
  // StudentStageChecklistProgress has no `version` column so optimistic-
  // concurrency is a no-op here. Field kept in the signature so callers
  // don't break when the column lands later.
  _opts?: { expected?: number },
): Promise<unknown> {
  void _opts;
  const student = await db.student.findFirst({
    where: { id: studentId, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!student) throw NotFound('Student not found');

  const item = await db.lifecycleStageChecklistItem.findFirst({
    where: { id: input.checklist_item_id, tenant_id: tenantId, deleted_at: null },
    select: { id: true, stage_id: true, is_active: true },
  });
  if (!item) throw NotFound('Checklist item not found');
  if (!item.is_active) throw Conflict('Checklist item is inactive');

  const now = new Date();
  const completed_at = input.completed ? now : null;
  const completed_by_id = input.completed ? actorId : null;
  // notes accepted whether or not completed — counsellors may annotate WIP items.
  const notes = input.notes === undefined ? undefined : (input.notes ?? null);

  return db.studentStageChecklistProgress.upsert({
    where: {
      student_id_checklist_item_id: {
        student_id: studentId,
        checklist_item_id: input.checklist_item_id,
      },
    },
    update: {
      completed_at,
      completed_by_id,
      ...(notes === undefined ? {} : { notes }),
    },
    create: {
      tenant_id: tenantId,
      student_id: studentId,
      stage_id: item.stage_id,
      checklist_item_id: input.checklist_item_id,
      completed_at,
      completed_by_id,
      notes: notes ?? null,
    },
  });
}
