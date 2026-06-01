import type { Prisma } from '@prisma/client';
import type {
  CreateProgramFeeRequest,
  CreateProgramIntakeRequest,
  CreateProgramModuleRequest,
  CreateProgramRequest,
  CreateProgramRequirementRequest,
  ProgramListQuery,
  UpdateProgramFeeRequest,
  UpdateProgramIntakeRequest,
  UpdateProgramModuleRequest,
  UpdateProgramRequest,
  UpdateProgramRequirementRequest,
} from '@spv/zod-schemas';

import { Conflict, NotFound, PreconditionFailed } from '../../shared/errors.js';
import { decodeCursor, encodeCursor, type Db } from './programs.types.js';

type Ctx = { db: Db; tenantId: string; actorId: string };
type ReadCtx = { db: Db; tenantId: string };

// -----------------------------------------------------------------------------
// Programs
// -----------------------------------------------------------------------------

export async function list(
  ctx: ReadCtx,
  q: ProgramListQuery,
): Promise<{ data: unknown[]; nextCursor: string | null; hasMore: boolean; total: number }> {
  const { db, tenantId } = ctx;
  const limit = q.limit;

  const where: Prisma.ProgramWhereInput = {
    tenant_id: tenantId,
    deleted_at: null,
  };
  if (q.institution_id) where.institution_id = q.institution_id;
  if (q.level) where.level = q.level;
  if (q.field_of_study) {
    where.field_of_study = { contains: q.field_of_study, mode: 'insensitive' };
  }
  if (q.isced_code) where.isced_code = q.isced_code;
  if (q.country_code) {
    // Join through institution.country_code without a separate query.
    where.institution = { country_code: q.country_code };
  }
  if (q.q) {
    where.OR = [
      { name: { contains: q.q, mode: 'insensitive' } },
      { short_name: { contains: q.q, mode: 'insensitive' } },
      { code: { contains: q.q, mode: 'insensitive' } },
    ];
  }

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

  const [rowsPlusOne, total] = await Promise.all([
    db.program.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        institution: { select: { id: true, display_name: true, country_code: true } },
        _count: { select: { intakes: true, requirements: true, modules: true } },
      },
    }),
    db.program.count({ where }),
  ]);

  const hasMore = rowsPlusOne.length > limit;
  const rows = hasMore ? rowsPlusOne.slice(0, limit) : rowsPlusOne;
  const last = rows[rows.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ created_at: last.created_at.toISOString(), id: last.id })
      : null;

  return { data: rows, nextCursor, hasMore, total };
}

export async function getById(ctx: ReadCtx, id: string): Promise<unknown> {
  const row = await ctx.db.program.findFirst({
    where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    include: {
      institution: { select: { id: true, display_name: true, country_code: true } },
      school: { select: { id: true, name: true } },
      department: { select: { id: true, name: true } },
      intakes: {
        orderBy: [{ intake_year: 'desc' }, { intake_month: 'desc' }],
        include: { fees: true },
      },
      requirements: { orderBy: { category: 'asc' } },
      modules: { orderBy: [{ semester: 'asc' }, { code: 'asc' }] },
    },
  });
  if (!row) throw NotFound('Program not found');
  return row;
}

export async function create(ctx: Ctx, input: CreateProgramRequest): Promise<unknown> {
  const { db, tenantId } = ctx;

  // Cross-tenant guard: institution must belong to the caller's tenant.
  const inst = await db.institution.findFirst({
    where: { id: input.institution_id, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!inst) throw NotFound('Institution not found');

  // school_id and department_id (if provided) must belong to the same institution.
  if (input.school_id) {
    const school = await db.school.findFirst({
      where: { id: input.school_id, institution_id: input.institution_id },
      select: { id: true },
    });
    if (!school) throw NotFound('School not found in target institution');
  }
  if (input.department_id) {
    const dept = await db.department.findFirst({
      where: {
        id: input.department_id,
        ...(input.school_id ? { school_id: input.school_id } : {}),
        school: { institution_id: input.institution_id },
      },
      select: { id: true },
    });
    if (!dept) throw NotFound('Department not found in target school');
  }

  return db.program.create({
    data: {
      tenant_id: tenantId,
      institution_id: input.institution_id,
      school_id: input.school_id ?? null,
      department_id: input.department_id ?? null,
      code: input.code ?? null,
      name: input.name,
      short_name: input.short_name ?? null,
      level: input.level,
      field_of_study: input.field_of_study ?? null,
      isced_code: input.isced_code ?? null,
      delivery_mode: input.delivery_mode,
      language_of_instruction: input.language_of_instruction,
      duration_months: input.duration_months,
      credit_hours: input.credit_hours ?? null,
      description: input.description ?? null,
      url: input.url ?? null,
      duration_pattern: input.duration_pattern ?? null,
      terms_per_year: input.terms_per_year ?? null,
    },
  });
}

export async function update(
  ctx: Ctx,
  id: string,
  input: UpdateProgramRequest,
  ifMatch: string | undefined,
): Promise<unknown> {
  const { db, tenantId } = ctx;
  if (!ifMatch) throw PreconditionFailed('If-Match header is required for updates');
  const expected = parseInt(ifMatch.replace(/^"|"$/g, ''), 10);
  if (!Number.isFinite(expected) || expected < 1) {
    throw PreconditionFailed('If-Match must be a numeric version');
  }

  const current = await db.program.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    select: { id: true, version: true, institution_id: true },
  });
  if (!current) throw NotFound('Program not found');
  if (current.version !== expected) {
    throw PreconditionFailed(
      `Version mismatch (have ${current.version}, expected ${expected})`,
    );
  }

  const data: Prisma.ProgramUncheckedUpdateInput = { version: { increment: 1 } };
  if (input.code !== undefined) data.code = input.code ?? null;
  if (input.name !== undefined) data.name = input.name;
  if (input.short_name !== undefined) data.short_name = input.short_name ?? null;
  if (input.level !== undefined) data.level = input.level;
  if (input.field_of_study !== undefined) data.field_of_study = input.field_of_study ?? null;
  if (input.isced_code !== undefined) data.isced_code = input.isced_code ?? null;
  if (input.delivery_mode !== undefined) data.delivery_mode = input.delivery_mode;
  if (input.language_of_instruction !== undefined) {
    data.language_of_instruction = input.language_of_instruction;
  }
  if (input.duration_months !== undefined) data.duration_months = input.duration_months;
  if (input.credit_hours !== undefined) data.credit_hours = input.credit_hours ?? null;
  if (input.description !== undefined) data.description = input.description ?? null;
  if (input.url !== undefined) data.url = input.url ?? null;
  if (input.is_active !== undefined) data.is_active = input.is_active;
  if (input.school_id !== undefined) data.school_id = input.school_id ?? null;
  if (input.department_id !== undefined) data.department_id = input.department_id ?? null;
  if (input.duration_pattern !== undefined) {
    data.duration_pattern = input.duration_pattern ?? null;
  }
  if (input.terms_per_year !== undefined) data.terms_per_year = input.terms_per_year ?? null;

  const result = await db.program.updateMany({
    where: { id, tenant_id: tenantId, deleted_at: null, version: expected },
    data: data as unknown as Prisma.ProgramUpdateManyMutationInput,
  });
  if (result.count === 0) {
    throw Conflict('Concurrent update detected; retry with the latest version');
  }

  return getById({ db, tenantId }, id);
}

export async function softDelete(ctx: Ctx, id: string): Promise<void> {
  const result = await ctx.db.program.updateMany({
    where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    data: { deleted_at: new Date() },
  });
  if (result.count === 0) throw NotFound('Program not found');
}

// -----------------------------------------------------------------------------
// Tenant ownership guards
// -----------------------------------------------------------------------------
async function assertOwnsProgram(db: Db, tenantId: string, programId: string): Promise<void> {
  const ok = await db.program.findFirst({
    where: { id: programId, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!ok) throw NotFound('Program not found');
}

async function assertOwnsIntake(db: Db, tenantId: string, intakeId: string): Promise<void> {
  const ok = await db.programIntake.findFirst({
    where: { id: intakeId, program: { tenant_id: tenantId, deleted_at: null } },
    select: { id: true },
  });
  if (!ok) throw NotFound('Program intake not found');
}

// -----------------------------------------------------------------------------
// Intakes
// -----------------------------------------------------------------------------

export async function listIntakes(ctx: ReadCtx, programId: string): Promise<unknown[]> {
  await assertOwnsProgram(ctx.db, ctx.tenantId, programId);
  return ctx.db.programIntake.findMany({
    where: { program_id: programId },
    orderBy: [{ intake_year: 'desc' }, { intake_month: 'desc' }],
    include: { campus: { select: { id: true, name: true } } },
  });
}

export async function createIntake(
  ctx: Ctx,
  programId: string,
  input: CreateProgramIntakeRequest,
): Promise<unknown> {
  await assertOwnsProgram(ctx.db, ctx.tenantId, programId);
  return ctx.db.programIntake.create({
    data: {
      program_id: programId,
      campus_id: input.campus_id ?? null,
      intake_year: input.intake_year,
      intake_month: input.intake_month,
      intake_label: input.intake_label,
      application_open: input.application_open ? new Date(input.application_open) : null,
      application_close: input.application_close ? new Date(input.application_close) : null,
      decision_date: input.decision_date ? new Date(input.decision_date) : null,
      classes_start_on: input.classes_start_on ? new Date(input.classes_start_on) : null,
      classes_end_on: input.classes_end_on ? new Date(input.classes_end_on) : null,
      capacity: input.capacity ?? null,
      is_open: input.is_open,
      notes: input.notes ?? null,
    },
  });
}

export async function updateIntake(
  ctx: Ctx,
  intakeId: string,
  input: UpdateProgramIntakeRequest,
): Promise<unknown> {
  await assertOwnsIntake(ctx.db, ctx.tenantId, intakeId);

  const data: Prisma.ProgramIntakeUncheckedUpdateInput = {};
  if (input.campus_id !== undefined) data.campus_id = input.campus_id ?? null;
  if (input.intake_year !== undefined) data.intake_year = input.intake_year;
  if (input.intake_month !== undefined) data.intake_month = input.intake_month;
  if (input.intake_label !== undefined) data.intake_label = input.intake_label;
  if (input.application_open !== undefined) {
    data.application_open = input.application_open ? new Date(input.application_open) : null;
  }
  if (input.application_close !== undefined) {
    data.application_close = input.application_close ? new Date(input.application_close) : null;
  }
  if (input.decision_date !== undefined) {
    data.decision_date = input.decision_date ? new Date(input.decision_date) : null;
  }
  if (input.classes_start_on !== undefined) {
    data.classes_start_on = input.classes_start_on ? new Date(input.classes_start_on) : null;
  }
  if (input.classes_end_on !== undefined) {
    data.classes_end_on = input.classes_end_on ? new Date(input.classes_end_on) : null;
  }
  if (input.capacity !== undefined) data.capacity = input.capacity ?? null;
  if (input.is_open !== undefined) data.is_open = input.is_open;
  if (input.notes !== undefined) data.notes = input.notes ?? null;

  return ctx.db.programIntake.update({ where: { id: intakeId }, data });
}

export async function deleteIntake(ctx: Ctx, intakeId: string): Promise<void> {
  await assertOwnsIntake(ctx.db, ctx.tenantId, intakeId);
  await ctx.db.programIntake.delete({ where: { id: intakeId } });
}

// -----------------------------------------------------------------------------
// Fees (under intakes)
// -----------------------------------------------------------------------------

export async function listFees(ctx: ReadCtx, intakeId: string): Promise<unknown[]> {
  await assertOwnsIntake(ctx.db, ctx.tenantId, intakeId);
  return ctx.db.programFee.findMany({
    where: { program_intake_id: intakeId },
    orderBy: [{ audience: 'asc' }, { fee_type: 'asc' }],
  });
}

export async function createFee(
  ctx: Ctx,
  intakeId: string,
  input: CreateProgramFeeRequest,
): Promise<unknown> {
  await assertOwnsIntake(ctx.db, ctx.tenantId, intakeId);
  return ctx.db.programFee.create({
    data: {
      program_intake_id: intakeId,
      audience: input.audience,
      fee_type: input.fee_type,
      amount_minor: input.amount_minor,
      currency: input.currency,
      per_period: input.per_period,
      is_estimated: input.is_estimated,
      effective_from: input.effective_from ? new Date(input.effective_from) : null,
      notes: input.notes ?? null,
    },
  });
}

export async function updateFee(
  ctx: Ctx,
  feeId: string,
  input: UpdateProgramFeeRequest,
): Promise<unknown> {
  const row = await ctx.db.programFee.findFirst({
    where: {
      id: feeId,
      program_intake: { program: { tenant_id: ctx.tenantId, deleted_at: null } },
    },
    select: { id: true },
  });
  if (!row) throw NotFound('Program fee not found');

  const data: Prisma.ProgramFeeUncheckedUpdateInput = {};
  if (input.audience !== undefined) data.audience = input.audience;
  if (input.fee_type !== undefined) data.fee_type = input.fee_type;
  if (input.amount_minor !== undefined) data.amount_minor = input.amount_minor;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.per_period !== undefined) data.per_period = input.per_period;
  if (input.is_estimated !== undefined) data.is_estimated = input.is_estimated;
  if (input.effective_from !== undefined) {
    data.effective_from = input.effective_from ? new Date(input.effective_from) : null;
  }
  if (input.notes !== undefined) data.notes = input.notes ?? null;

  return ctx.db.programFee.update({ where: { id: feeId }, data });
}

export async function deleteFee(ctx: Ctx, feeId: string): Promise<void> {
  const row = await ctx.db.programFee.findFirst({
    where: {
      id: feeId,
      program_intake: { program: { tenant_id: ctx.tenantId, deleted_at: null } },
    },
    select: { id: true },
  });
  if (!row) throw NotFound('Program fee not found');
  await ctx.db.programFee.delete({ where: { id: feeId } });
}

// -----------------------------------------------------------------------------
// Requirements
// -----------------------------------------------------------------------------

export async function listRequirements(ctx: ReadCtx, programId: string): Promise<unknown[]> {
  await assertOwnsProgram(ctx.db, ctx.tenantId, programId);
  return ctx.db.programRequirement.findMany({
    where: { program_id: programId },
    orderBy: { category: 'asc' },
  });
}

export async function createRequirement(
  ctx: Ctx,
  programId: string,
  input: CreateProgramRequirementRequest,
): Promise<unknown> {
  await assertOwnsProgram(ctx.db, ctx.tenantId, programId);
  return ctx.db.programRequirement.create({
    data: {
      program_id: programId,
      category: input.category,
      label: input.label,
      details: input.details ?? null,
      min_value: input.min_value ?? null,
      unit: input.unit ?? null,
      is_mandatory: input.is_mandatory,
    },
  });
}

export async function updateRequirement(
  ctx: Ctx,
  reqId: string,
  input: UpdateProgramRequirementRequest,
): Promise<unknown> {
  const row = await ctx.db.programRequirement.findFirst({
    where: { id: reqId, program: { tenant_id: ctx.tenantId, deleted_at: null } },
    select: { id: true },
  });
  if (!row) throw NotFound('Program requirement not found');

  const data: Prisma.ProgramRequirementUncheckedUpdateInput = {};
  if (input.category !== undefined) data.category = input.category;
  if (input.label !== undefined) data.label = input.label;
  if (input.details !== undefined) data.details = input.details ?? null;
  if (input.min_value !== undefined) data.min_value = input.min_value ?? null;
  if (input.unit !== undefined) data.unit = input.unit ?? null;
  if (input.is_mandatory !== undefined) data.is_mandatory = input.is_mandatory;

  return ctx.db.programRequirement.update({ where: { id: reqId }, data });
}

export async function deleteRequirement(ctx: Ctx, reqId: string): Promise<void> {
  const row = await ctx.db.programRequirement.findFirst({
    where: { id: reqId, program: { tenant_id: ctx.tenantId, deleted_at: null } },
    select: { id: true },
  });
  if (!row) throw NotFound('Program requirement not found');
  await ctx.db.programRequirement.delete({ where: { id: reqId } });
}

// -----------------------------------------------------------------------------
// Modules
// -----------------------------------------------------------------------------

export async function listModules(ctx: ReadCtx, programId: string): Promise<unknown[]> {
  await assertOwnsProgram(ctx.db, ctx.tenantId, programId);
  return ctx.db.programModule.findMany({
    where: { program_id: programId },
    orderBy: [{ semester: 'asc' }, { code: 'asc' }],
  });
}

export async function createModule(
  ctx: Ctx,
  programId: string,
  input: CreateProgramModuleRequest,
): Promise<unknown> {
  await assertOwnsProgram(ctx.db, ctx.tenantId, programId);
  return ctx.db.programModule.create({
    data: {
      program_id: programId,
      code: input.code,
      title: input.title,
      credits: input.credits ?? null,
      semester: input.semester ?? null,
      is_core: input.is_core,
      description: input.description ?? null,
    },
  });
}

export async function updateModule(
  ctx: Ctx,
  moduleId: string,
  input: UpdateProgramModuleRequest,
): Promise<unknown> {
  const row = await ctx.db.programModule.findFirst({
    where: { id: moduleId, program: { tenant_id: ctx.tenantId, deleted_at: null } },
    select: { id: true },
  });
  if (!row) throw NotFound('Program module not found');

  const data: Prisma.ProgramModuleUncheckedUpdateInput = {};
  if (input.code !== undefined) data.code = input.code;
  if (input.title !== undefined) data.title = input.title;
  if (input.credits !== undefined) data.credits = input.credits ?? null;
  if (input.semester !== undefined) data.semester = input.semester ?? null;
  if (input.is_core !== undefined) data.is_core = input.is_core;
  if (input.description !== undefined) data.description = input.description ?? null;

  return ctx.db.programModule.update({ where: { id: moduleId }, data });
}

export async function deleteModule(ctx: Ctx, moduleId: string): Promise<void> {
  const row = await ctx.db.programModule.findFirst({
    where: { id: moduleId, program: { tenant_id: ctx.tenantId, deleted_at: null } },
    select: { id: true },
  });
  if (!row) throw NotFound('Program module not found');
  await ctx.db.programModule.delete({ where: { id: moduleId } });
}
