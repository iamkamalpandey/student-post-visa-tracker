import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  CreateStageRequest,
  CreateTransitionRequest,
  PreviewImpactRequest,
  ReorderStagesRequest,
  UpdateStageRequest,
} from '@spv/zod-schemas';

import { Conflict, NotFound, UnprocessableEntity } from '../../shared/errors.js';

type Db = PrismaClient;

// ----- list ------------------------------------------------------------------

// Active first, then by sequence asc. Admins may opt-in to inactive stages.
//
// `visaTypeId` filters strictly. Pass:
//   - undefined: no filter
//   - a uuid: stages pinned to that visa type only
//   - the literal `null`: stages with NO visa_type_id (the generic ones)
// The "null" sentinel keeps the wire shape simple — query strings can't
// natively distinguish "absent" from "null".
export async function list(
  db: Db,
  tenantId: string,
  opts: { includeInactive?: boolean; visaTypeId?: string | null } = {},
): Promise<unknown[]> {
  const where: Prisma.LifecycleStageWhereInput = { tenant_id: tenantId };
  if (!opts.includeInactive) where.is_active = true;
  if (opts.visaTypeId === null) where.visa_type_id = null;
  else if (opts.visaTypeId !== undefined) where.visa_type_id = opts.visaTypeId;

  return db.lifecycleStage.findMany({
    where,
    orderBy: [{ is_active: 'desc' }, { sequence: 'asc' }],
  });
}

// ----- create ----------------------------------------------------------------

export async function create(
  db: Db,
  tenantId: string,
  input: CreateStageRequest,
): Promise<unknown> {
  // Belt-and-braces; the zod refine has already caught this for HTTP callers
  // but the service may be invoked from seed scripts that skip validation.
  if (input.is_outcome_success && input.is_outcome_failure) {
    throw UnprocessableEntity(
      'is_outcome_success and is_outcome_failure are mutually exclusive',
    );
  }
  // Uniqueness on (tenant_id, key) is enforced by the DB; we surface as 409.
  try {
    return await db.lifecycleStage.create({
      data: {
        tenant_id: tenantId,
        key: input.key,
        label: input.label,
        label_translations: input.label_translations ?? undefined,
        description: input.description ?? null,
        sequence: input.sequence,
        category: input.category,
        color_hex: input.color_hex ?? null,
        icon: input.icon ?? null,
        is_initial: input.is_initial,
        is_terminal: input.is_terminal,
        sla_hours: input.sla_hours ?? null,
        destination_country: input.destination_country ?? null,
        // v6 ----------------------------------------------------------
        visa_type_id: input.visa_type_id ?? null,
        is_outcome_success: input.is_outcome_success,
        is_outcome_failure: input.is_outcome_failure,
        show_on_dashboard: input.show_on_dashboard,
        prompt_date_label: input.prompt_date_label ?? null,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw Conflict(`Stage key '${input.key}' already exists for this tenant`);
    }
    throw err;
  }
}

// ----- update ----------------------------------------------------------------

export async function update(
  db: Db,
  tenantId: string,
  id: string,
  input: UpdateStageRequest,
): Promise<unknown> {
  // Confirm tenant ownership before mutating; updateMany returns count.
  const found = await db.lifecycleStage.findFirst({
    where: { id, tenant_id: tenantId },
    select: { id: true },
  });
  if (!found) throw NotFound('Stage not found');

  // v6: revalidate the XOR constraint when both flags happen to be sent in a
  // single PATCH. The zod schema also enforces this for HTTP callers; this is
  // defence-in-depth for direct service calls (jobs, scripts).
  if (input.is_outcome_success === true && input.is_outcome_failure === true) {
    throw UnprocessableEntity(
      'is_outcome_success and is_outcome_failure are mutually exclusive',
    );
  }

  // Unchecked variant lets us set the visa_type_id FK column directly without
  // the relation `connect`/`disconnect` ceremony — required because updateMany
  // accepts only scalar columns.
  const data: Prisma.LifecycleStageUncheckedUpdateInput = {};
  if (input.key !== undefined) data.key = input.key;
  if (input.label !== undefined) data.label = input.label;
  if (input.label_translations !== undefined) data.label_translations = input.label_translations;
  if (input.description !== undefined) data.description = input.description ?? null;
  if (input.sequence !== undefined) data.sequence = input.sequence;
  if (input.category !== undefined) data.category = input.category;
  if (input.color_hex !== undefined) data.color_hex = input.color_hex ?? null;
  if (input.icon !== undefined) data.icon = input.icon ?? null;
  if (input.is_initial !== undefined) data.is_initial = input.is_initial;
  if (input.is_terminal !== undefined) data.is_terminal = input.is_terminal;
  if (input.is_active !== undefined) data.is_active = input.is_active;
  if (input.sla_hours !== undefined) data.sla_hours = input.sla_hours ?? null;
  if (input.destination_country !== undefined) data.destination_country = input.destination_country ?? null;
  // v6 -----------------------------------------------------------------
  if (input.visa_type_id !== undefined) data.visa_type_id = input.visa_type_id ?? null;
  if (input.is_outcome_success !== undefined) data.is_outcome_success = input.is_outcome_success;
  if (input.is_outcome_failure !== undefined) data.is_outcome_failure = input.is_outcome_failure;
  if (input.show_on_dashboard !== undefined) data.show_on_dashboard = input.show_on_dashboard;
  if (input.prompt_date_label !== undefined) data.prompt_date_label = input.prompt_date_label ?? null;

  try {
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const wr = await db.lifecycleStage.updateMany({
      where: { id, tenant_id: tenantId },
      data: data as unknown as Prisma.LifecycleStageUpdateManyMutationInput,
    });
    if (wr.count !== 1) throw NotFound('Stage not found');
  } catch (err) {
    if (isUniqueViolation(err)) throw Conflict('Stage key conflict');
    throw err;
  }
  return db.lifecycleStage.findFirstOrThrow({ where: { id, tenant_id: tenantId } });
}

// ----- delete ----------------------------------------------------------------

// Block when students currently sit on the stage. We point the caller to the
// reassign endpoint via the detail message — the FE renders this verbatim.
export async function remove(db: Db, tenantId: string, id: string): Promise<void> {
  const found = await db.lifecycleStage.findFirst({
    where: { id, tenant_id: tenantId },
    select: { id: true },
  });
  if (!found) throw NotFound('Stage not found');

  const blockers = await db.student.count({
    where: { tenant_id: tenantId, current_stage_id: id, deleted_at: null },
  });
  if (blockers > 0) {
    throw Conflict(
      `Cannot delete stage: ${blockers} student(s) are currently on this stage. Move them via POST /api/v1/students/:id/transitions before deleting.`,
    );
  }

  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await db.lifecycleStage.deleteMany({
    where: { id, tenant_id: tenantId },
  });
  if (wr.count !== 1) throw NotFound('Stage not found');
}

// ----- reorder ---------------------------------------------------------------

// Bulk re-sequencing: applied in a single transaction so partial failures roll back.
// We accept whatever sequence values the caller sends — uniqueness across the column
// is *not* enforced by the schema (intentional), so callers can stage edits before
// re-numbering.
export async function reorder(
  db: Db,
  tenantId: string,
  input: ReorderStagesRequest,
): Promise<{ updated: number }> {
  return db.$transaction(async (tx) => {
    let updated = 0;
    for (const item of input.items) {
      const r = await tx.lifecycleStage.updateMany({
        where: { id: item.id, tenant_id: tenantId },
        data: { sequence: item.sequence },
      });
      updated += r.count;
    }
    if (updated !== input.items.length) {
      // Some IDs didn't belong to this tenant — bail out, transaction rolls back.
      throw NotFound('One or more stage IDs not found in this tenant');
    }
    return { updated };
  });
}

// ----- transitions -----------------------------------------------------------

export async function listTransitions(
  db: Db,
  tenantId: string,
  opts: { fromStageId?: string } = {},
): Promise<unknown[]> {
  // SVT-LIFECYCLE-2026-05: `fromStageId` narrows the matrix to outgoing edges
  // from a single stage. Used by the AdvanceStageDialog to compute reachable
  // targets per the configured matrix when one exists.
  const where: Prisma.LifecycleStageTransitionWhereInput = { tenant_id: tenantId };
  if (opts.fromStageId) where.from_stage_id = opts.fromStageId;

  return db.lifecycleStageTransition.findMany({
    where,
    include: {
      from_stage: { select: { id: true, key: true, label: true, sequence: true } },
      to_stage: { select: { id: true, key: true, label: true, sequence: true } },
    },
    orderBy: [{ from_stage: { sequence: 'asc' } }, { to_stage: { sequence: 'asc' } }],
  });
}

export async function createTransition(
  db: Db,
  tenantId: string,
  input: CreateTransitionRequest,
): Promise<unknown> {
  // Both stages must belong to this tenant.
  const stages = await db.lifecycleStage.findMany({
    where: { tenant_id: tenantId, id: { in: [input.from_stage_id, input.to_stage_id] } },
    select: { id: true },
  });
  if (stages.length !== 2) throw NotFound('One or both stages not found in this tenant');

  try {
    return await db.lifecycleStageTransition.create({
      data: {
        tenant_id: tenantId,
        from_stage_id: input.from_stage_id,
        to_stage_id: input.to_stage_id,
        requires_role: input.requires_role ?? null,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw Conflict('Transition already exists');
    throw err;
  }
}

export async function deleteTransition(db: Db, tenantId: string, id: string): Promise<void> {
  const r = await db.lifecycleStageTransition.deleteMany({
    where: { id, tenant_id: tenantId },
  });
  if (r.count === 0) throw NotFound('Transition not found');
}

// ----- preview impact --------------------------------------------------------

export async function previewImpact(
  db: Db,
  tenantId: string,
  input: PreviewImpactRequest,
): Promise<{ stage_id: string; action: string; affected_students: number; transitions_removed: number }> {
  const stage = await db.lifecycleStage.findFirst({
    where: { id: input.stage_id, tenant_id: tenantId },
    select: { id: true },
  });
  if (!stage) throw NotFound('Stage not found');

  const [students, transitions] = await Promise.all([
    db.student.count({
      where: { tenant_id: tenantId, current_stage_id: input.stage_id, deleted_at: null },
    }),
    db.lifecycleStageTransition.count({
      where: {
        tenant_id: tenantId,
        OR: [{ from_stage_id: input.stage_id }, { to_stage_id: input.stage_id }],
      },
    }),
  ]);

  return {
    stage_id: input.stage_id,
    action: input.action,
    affected_students: students,
    transitions_removed: input.action === 'delete' ? transitions : 0,
  };
}

// ----- helpers ---------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}
