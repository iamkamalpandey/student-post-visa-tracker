// Per-row importer for the `program_fees` resource.
//
// Behaviour parity with the pre-refactor monolith in imports.service.ts:
//   - Validates via program-fees-mapper (resolves the program intake and
//     normalises the audience / fee_type / per_period enums).
//   - Dedupes on (program_intake_id, audience, fee_type, currency).

import { mapRow as mapProgramFeeRow } from '../mappers/program-fees-mapper.js';
import type {
  ApplyCtx,
  DryRunCtx,
  DryRunResult,
  MappedRow,
  NonStudentRowResult,
} from './types.js';

export async function dryRun(mapped: MappedRow, ctx: DryRunCtx): Promise<DryRunResult> {
  const r = await mapProgramFeeRow(mapped, ctx);
  if (!r.ok) return { ok: false, errors: r.errors };
  const existing = await ctx.db.programFee.findFirst({
    where: {
      program_intake_id: r.value.program_intake_id,
      audience: r.value.audience,
      fee_type: r.value.fee_type,
      currency: r.value.currency,
    },
    select: { id: true },
  });
  return { ok: true, willUpdate: !!existing };
}

export async function applyRow(
  mapped: MappedRow,
  ctx: ApplyCtx,
): Promise<NonStudentRowResult> {
  const r = await mapProgramFeeRow(mapped, { tenantId: ctx.tenantId, db: ctx.tx });
  if (!r.ok) {
    return {
      row_number: ctx.rowNumber,
      status: 'failed',
      error: r.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
    };
  }

  const existing = await ctx.tx.programFee.findFirst({
    where: {
      program_intake_id: r.value.program_intake_id,
      audience: r.value.audience,
      fee_type: r.value.fee_type,
      currency: r.value.currency,
    },
  });

  const data = {
    program_intake_id: r.value.program_intake_id,
    audience: r.value.audience,
    fee_type: r.value.fee_type,
    amount_minor: r.value.amount_minor,
    currency: r.value.currency,
    per_period: r.value.per_period,
    is_estimated: r.value.is_estimated,
    ...(r.value.effective_from !== undefined ? { effective_from: r.value.effective_from } : {}),
  };

  if (existing) {
    await ctx.tx.programFee.update({ where: { id: existing.id }, data });
    return {
      row_number: ctx.rowNumber,
      status: 'updated',
      id: existing.id,
      entityType: 'ProgramFee',
    };
  }

  const created = await ctx.tx.programFee.create({ data });
  return {
    row_number: ctx.rowNumber,
    status: 'created',
    id: created.id,
    entityType: 'ProgramFee',
  };
}
