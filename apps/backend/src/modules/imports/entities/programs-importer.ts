// Per-row importer for the `programs` resource.
//
// Behaviour parity with the pre-refactor monolith in imports.service.ts:
//   - Validates via programs-mapper.
//   - Dedupes on (institution_id, name, level, deleted_at IS NULL).
//   - Optionally upserts an associated ProgramIntake row.
//
// Intake upsert note: the schema has a UNIQUE on
// (program_id, campus_id, intake_year, intake_month) where campus_id is
// nullable. Prisma's compound-unique-where input declares campus_id as
// non-nullable (a known prisma typing quirk). The pre-refactor code worked
// around this with `campus_id: null as any`. Here we drop down to the safe
// findFirst → create / update pattern, which also clears the `as any` cast.
// Behaviourally equivalent: we still match an existing intake on the same
// composite, and when none exists we still create one with `campus_id`
// implicitly NULL (the default for an optional column).

import { mapRow as mapProgramRow } from '../mappers/programs-mapper.js';
import type {
  ApplyCtx,
  DryRunCtx,
  DryRunResult,
  MappedRow,
  NonStudentRowResult,
} from './types.js';

export async function dryRun(mapped: MappedRow, ctx: DryRunCtx): Promise<DryRunResult> {
  const r = await mapProgramRow(mapped, ctx);
  if (!r.ok) return { ok: false, errors: r.errors };
  const existing = await ctx.db.program.findFirst({
    where: {
      institution_id: r.value.institution_id,
      name: r.value.name,
      level: r.value.level,
      deleted_at: null,
    },
    select: { id: true },
  });
  return { ok: true, willUpdate: !!existing };
}

export async function applyRow(
  mapped: MappedRow,
  ctx: ApplyCtx,
): Promise<NonStudentRowResult> {
  const r = await mapProgramRow(mapped, { tenantId: ctx.tenantId, db: ctx.tx });
  if (!r.ok) {
    return {
      row_number: ctx.rowNumber,
      status: 'failed',
      error: r.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
    };
  }

  const data = {
    institution_id: r.value.institution_id,
    name: r.value.name,
    level: r.value.level,
    duration_months: r.value.duration_months,
    ...(r.value.code !== undefined ? { code: r.value.code } : {}),
    ...(r.value.short_name !== undefined ? { short_name: r.value.short_name } : {}),
    ...(r.value.field_of_study !== undefined ? { field_of_study: r.value.field_of_study } : {}),
    ...(r.value.isced_code !== undefined ? { isced_code: r.value.isced_code } : {}),
    ...(r.value.delivery_mode !== undefined ? { delivery_mode: r.value.delivery_mode } : {}),
    ...(r.value.language_of_instruction !== undefined
      ? { language_of_instruction: r.value.language_of_instruction }
      : {}),
    ...(r.value.credit_hours !== undefined ? { credit_hours: r.value.credit_hours } : {}),
    ...(r.value.description !== undefined ? { description: r.value.description } : {}),
    ...(r.value.url !== undefined ? { url: r.value.url } : {}),
  };

  const existing = await ctx.tx.program.findFirst({
    where: {
      institution_id: r.value.institution_id,
      name: r.value.name,
      level: r.value.level,
      deleted_at: null,
    },
  });

  let id: string;
  let status: 'created' | 'updated';
  if (existing) {
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const wr = await ctx.tx.program.updateMany({
      where: { id: existing.id, tenant_id: ctx.tenantId },
      data,
    });
    if (wr.count !== 1) {
      return {
        row_number: ctx.rowNumber,
        status: 'failed',
        error: 'Program row vanished or moved tenants between lookup and write',
      };
    }
    id = existing.id;
    status = 'updated';
  } else {
    const created = await ctx.tx.program.create({
      data: { ...data, tenant_id: ctx.tenantId },
    });
    id = created.id;
    status = 'created';
  }

  if (r.value.intake) {
    // findFirst then create/update — safer than the upsert + null-campus_id
    // composite that Prisma's typings refuse to accept (see header note).
    const intake = r.value.intake;
    const existingIntake = await ctx.tx.programIntake.findFirst({
      where: {
        program_id: id,
        campus_id: null,
        intake_year: intake.intake_year,
        intake_month: intake.intake_month,
      },
      select: { id: true },
    });
    if (existingIntake) {
      await ctx.tx.programIntake.update({
        where: { id: existingIntake.id },
        data: { intake_label: intake.intake_label },
      });
    } else {
      await ctx.tx.programIntake.create({
        data: {
          program_id: id,
          intake_year: intake.intake_year,
          intake_month: intake.intake_month,
          intake_label: intake.intake_label,
        },
      });
    }
  }

  return { row_number: ctx.rowNumber, status, id, entityType: 'Program' };
}
