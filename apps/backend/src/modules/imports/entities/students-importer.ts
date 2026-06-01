// Per-row importer for the `students` resource.
//
// Behaviour parity with the pre-refactor monolith in imports.service.ts:
//   - Validates via students-mapper (returns a typed value + optional external_id).
//   - On update: matches an existing Student by external_id (preferred) or
//     name_in_passport heuristic (v1 fallback returns null when no external_id).
//   - On create: requires a tenant-level lifecycle stage flagged is_initial
//     (the import row fails otherwise — same message string), generates a
//     deterministic student_code prefixed `IMP-<jobId8>-<rowNumber>` and
//     encrypts name_in_passport before storing it.
//
// The orchestrator handles per-row audit + JSONL emission once this returns.

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { encryptField } from '../../../shared/encryption.js';
import { mapStudentRow } from '../mappers/students-mapper.js';
import type { ApplyCtx, MappedRow } from './types.js';

export type StudentApplyResult = {
  row_number: number;
  status: 'created' | 'updated' | 'failed';
  id?: string;
  external_id?: string;
  error?: string;
};

export async function findExistingStudent(
  tenantId: string,
  namePassport: string,
  externalId: string | undefined,
  client: PrismaClient,
): Promise<{ id: string } | null> {
  if (externalId) {
    const ext = await client.externalId.findFirst({
      where: { tenant_id: tenantId, entity_type: 'student', external_id: externalId },
    });
    if (ext) {
      return client.student.findFirst({
        where: { id: ext.entity_id, tenant_id: tenantId },
        select: { id: true },
      });
    }
  }
  // Fallback: name-in-passport heuristic. We can't query encrypted columns
  // directly, so we bound the search to recently-created students and filter
  // app-side. For v1 this is good enough; v2 should add a deterministic
  // search hash column to enable an indexed lookup. For BadRequest noise
  // control we just return null when no external_id is given.
  if (!externalId) {
    void namePassport; // unused in v1 — see comment above.
    return null;
  }
  return null;
}

export async function applyRow(mapped: MappedRow, ctx: ApplyCtx): Promise<StudentApplyResult> {
  const r = mapStudentRow(mapped);
  if (!r.ok) {
    return {
      row_number: ctx.rowNumber,
      status: 'failed',
      error: r.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
    };
  }

  const existing = await findExistingStudent(
    ctx.tenantId,
    r.value.name_in_passport,
    r.external_id,
    ctx.tx,
  );

  if (existing) {
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const wr = await ctx.tx.student.updateMany({
      where: { id: existing.id, tenant_id: ctx.tenantId },
      data: {
        given_name: r.value.given_name,
        family_name: r.value.family_name,
        ...(r.value.middle_name !== undefined ? { middle_name: r.value.middle_name } : {}),
        ...(r.value.preferred_name !== undefined ? { preferred_name: r.value.preferred_name } : {}),
        date_of_birth: new Date(`${r.value.date_of_birth}T00:00:00Z`),
        gender: r.value.gender,
        nationality_code: r.value.nationality_code,
        primary_language: r.value.primary_language,
        ...(r.value.email_primary !== undefined ? { email_primary: r.value.email_primary } : {}),
        ...(r.value.email_secondary !== undefined
          ? { email_secondary: r.value.email_secondary }
          : {}),
        ...(r.value.phone_primary_e164 !== undefined
          ? { phone_primary_e164: r.value.phone_primary_e164 }
          : {}),
        ...(r.value.phone_secondary_e164 !== undefined
          ? { phone_secondary_e164: r.value.phone_secondary_e164 }
          : {}),
        updated_by_id: ctx.userId,
      },
    });
    if (wr.count !== 1) {
      return {
        row_number: ctx.rowNumber,
        status: 'failed',
        error: 'Student row vanished or moved tenants between lookup and write',
      };
    }
    return {
      row_number: ctx.rowNumber,
      status: 'updated',
      id: existing.id,
      ...(r.external_id !== undefined ? { external_id: r.external_id } : {}),
    };
  }

  // Pick an initial stage. We don't have a guaranteed seed here, so we look
  // up the lifecycle stage flagged is_initial; if absent, the import row
  // fails (same wording as the pre-refactor monolith).
  const initial = await ctx.tx.lifecycleStage.findFirst({
    where: { tenant_id: ctx.tenantId, is_initial: true },
  });
  if (!initial) {
    return {
      row_number: ctx.rowNumber,
      status: 'failed',
      error: 'No is_initial lifecycle stage configured for tenant',
    };
  }

  const studentId = randomUUID();
  const namePassportEnc = await encryptField(r.value.name_in_passport);
  const studentCode = `IMP-${ctx.jobId.slice(0, 8)}-${ctx.rowNumber}`;
  await ctx.tx.student.create({
    data: {
      id: studentId,
      tenant_id: ctx.tenantId,
      student_code: studentCode,
      given_name: r.value.given_name,
      family_name: r.value.family_name,
      ...(r.value.middle_name !== undefined ? { middle_name: r.value.middle_name } : {}),
      ...(r.value.preferred_name !== undefined ? { preferred_name: r.value.preferred_name } : {}),
      name_in_passport_enc: namePassportEnc,
      date_of_birth: new Date(`${r.value.date_of_birth}T00:00:00Z`),
      gender: r.value.gender,
      nationality_code: r.value.nationality_code,
      primary_language: r.value.primary_language,
      ...(r.value.email_primary !== undefined ? { email_primary: r.value.email_primary } : {}),
      ...(r.value.email_secondary !== undefined ? { email_secondary: r.value.email_secondary } : {}),
      ...(r.value.phone_primary_e164 !== undefined
        ? { phone_primary_e164: r.value.phone_primary_e164 }
        : {}),
      ...(r.value.phone_secondary_e164 !== undefined
        ? { phone_secondary_e164: r.value.phone_secondary_e164 }
        : {}),
      current_stage_id: initial.id,
      created_by_id: ctx.userId,
      updated_by_id: ctx.userId,
    },
  });

  if (r.external_id) {
    await ctx.tx.externalId.create({
      data: {
        tenant_id: ctx.tenantId,
        entity_type: 'student',
        entity_id: studentId,
        external_id: r.external_id,
        source_system: 'import',
      },
    });
  }

  return {
    row_number: ctx.rowNumber,
    status: 'created',
    id: studentId,
    ...(r.external_id !== undefined ? { external_id: r.external_id } : {}),
  };
}
