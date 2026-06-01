// Per-row importer for the `enrollments` resource.
//
// Behaviour parity with the pre-refactor monolith in imports.service.ts:
//   - Validates via enrollments-mapper (which resolves student_id +
//     institution_id + program_id + optional program_intake_id + campus_id).
//   - Dedupes on (tenant_id, student_id, institution_id, program_id,
//     deleted_at IS NULL).

import { mapRow as mapEnrollmentRow } from '../mappers/enrollments-mapper.js';
import type {
  ApplyCtx,
  DryRunCtx,
  DryRunResult,
  MappedRow,
  NonStudentRowResult,
} from './types.js';

export async function dryRun(mapped: MappedRow, ctx: DryRunCtx): Promise<DryRunResult> {
  const r = await mapEnrollmentRow(mapped, ctx);
  if (!r.ok) return { ok: false, errors: r.errors };
  const existing = await ctx.db.enrollment.findFirst({
    where: {
      tenant_id: ctx.tenantId,
      student_id: r.value.student_id,
      institution_id: r.value.institution_id,
      program_id: r.value.program_id,
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
  const r = await mapEnrollmentRow(mapped, { tenantId: ctx.tenantId, db: ctx.tx });
  if (!r.ok) {
    return {
      row_number: ctx.rowNumber,
      status: 'failed',
      error: r.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
    };
  }

  const existing = await ctx.tx.enrollment.findFirst({
    where: {
      tenant_id: ctx.tenantId,
      student_id: r.value.student_id,
      institution_id: r.value.institution_id,
      program_id: r.value.program_id,
      deleted_at: null,
    },
  });

  const data = {
    student_id: r.value.student_id,
    institution_id: r.value.institution_id,
    program_id: r.value.program_id,
    status: r.value.status,
    ...(r.value.program_intake_id !== undefined
      ? { program_intake_id: r.value.program_intake_id }
      : {}),
    ...(r.value.campus_id !== undefined ? { campus_id: r.value.campus_id } : {}),
    ...(r.value.enrollment_no !== undefined ? { enrollment_no: r.value.enrollment_no } : {}),
    ...(r.value.tuition_total_minor !== undefined
      ? { tuition_total_minor: r.value.tuition_total_minor }
      : {}),
    ...(r.value.tuition_currency !== undefined
      ? { tuition_currency: r.value.tuition_currency }
      : {}),
    ...(r.value.scholarship_minor !== undefined
      ? { scholarship_minor: r.value.scholarship_minor }
      : {}),
    ...(r.value.agent_commission_minor !== undefined
      ? { agent_commission_minor: r.value.agent_commission_minor }
      : {}),
    ...(r.value.start_date !== undefined ? { start_date: r.value.start_date } : {}),
    ...(r.value.expected_end_date !== undefined
      ? { expected_end_date: r.value.expected_end_date }
      : {}),
  };

  if (existing) {
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const wr = await ctx.tx.enrollment.updateMany({
      where: { id: existing.id, tenant_id: ctx.tenantId },
      data: { ...data, updated_by_id: ctx.userId },
    });
    if (wr.count !== 1) {
      return {
        row_number: ctx.rowNumber,
        status: 'failed',
        error: 'Enrollment row vanished or moved tenants between lookup and write',
      };
    }
    return {
      row_number: ctx.rowNumber,
      status: 'updated',
      id: existing.id,
      entityType: 'Enrollment',
    };
  }

  const created = await ctx.tx.enrollment.create({
    data: {
      ...data,
      tenant_id: ctx.tenantId,
      created_by_id: ctx.userId,
      updated_by_id: ctx.userId,
    },
  });
  return {
    row_number: ctx.rowNumber,
    status: 'created',
    id: created.id,
    entityType: 'Enrollment',
  };
}
