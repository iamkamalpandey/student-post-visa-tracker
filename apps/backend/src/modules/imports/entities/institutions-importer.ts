// Per-row importer for the `institutions` resource.
//
// Behaviour parity with the pre-refactor monolith in imports.service.ts:
//   - Validates via institutions-mapper.
//   - Dedupes on (tenant_id, legal_name, country_code, deleted_at IS NULL).
//   - Upserts InstitutionIdentifier rows via the (institution_id, scheme)
//     unique key.
//   - Returns a NonStudentRowResult so the orchestrator can audit + emit JSONL
//     without caring about per-resource shape.

import { mapRow as mapInstitutionRow } from '../mappers/institutions-mapper.js';
import type {
  ApplyCtx,
  DryRunCtx,
  DryRunResult,
  MappedRow,
  NonStudentRowResult,
} from './types.js';

export async function dryRun(mapped: MappedRow, ctx: DryRunCtx): Promise<DryRunResult> {
  const r = await mapInstitutionRow(mapped, ctx);
  if (!r.ok) return { ok: false, errors: r.errors };
  const existing = await ctx.db.institution.findFirst({
    where: {
      tenant_id: ctx.tenantId,
      legal_name: r.value.legal_name,
      country_code: r.value.country_code,
      deleted_at: null,
    },
    select: { id: true },
  });
  return {
    ok: true,
    willUpdate: !!existing,
    dedupKey: `${String(r.value.legal_name).toLowerCase()}|${String(r.value.country_code).toUpperCase()}`,
  };
}

export async function applyRow(
  mapped: MappedRow,
  ctx: ApplyCtx,
): Promise<NonStudentRowResult> {
  const r = await mapInstitutionRow(mapped, { tenantId: ctx.tenantId, db: ctx.tx });
  if (!r.ok) {
    return {
      row_number: ctx.rowNumber,
      status: 'failed',
      error: r.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
    };
  }

  const existing = await ctx.tx.institution.findFirst({
    where: {
      tenant_id: ctx.tenantId,
      legal_name: r.value.legal_name,
      country_code: r.value.country_code,
      deleted_at: null,
    },
  });

  const data = {
    legal_name: r.value.legal_name,
    display_name: r.value.display_name,
    ...(r.value.short_name !== undefined ? { short_name: r.value.short_name } : {}),
    type: r.value.type,
    country_code: r.value.country_code,
    ...(r.value.website !== undefined ? { website: r.value.website } : {}),
    ...(r.value.email !== undefined ? { email: r.value.email } : {}),
    ...(r.value.phone_e164 !== undefined ? { phone_e164: r.value.phone_e164 } : {}),
    ...(r.value.established_year !== undefined
      ? { established_year: r.value.established_year }
      : {}),
    ...(r.value.ranking_global !== undefined
      ? { ranking_global: r.value.ranking_global }
      : {}),
    ...(r.value.is_partner !== undefined ? { is_partner: r.value.is_partner } : {}),
  };

  let id: string;
  if (existing) {
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const wr = await ctx.tx.institution.updateMany({
      where: { id: existing.id, tenant_id: ctx.tenantId },
      data: { ...data, updated_by_id: ctx.userId },
    });
    if (wr.count !== 1) {
      return {
        row_number: ctx.rowNumber,
        status: 'failed',
        error: 'Institution row vanished or moved tenants between lookup and write',
      };
    }
    id = existing.id;
    for (const ident of r.value.identifiers) {
      await ctx.tx.institutionIdentifier.upsert({
        where: { institution_id_scheme: { institution_id: id, scheme: ident.scheme } },
        create: { institution_id: id, scheme: ident.scheme, value: ident.value },
        update: { value: ident.value },
      });
    }
    return {
      row_number: ctx.rowNumber,
      status: 'updated',
      id,
      entityType: 'Institution',
    };
  }

  const created = await ctx.tx.institution.create({
    data: {
      ...data,
      tenant_id: ctx.tenantId,
      created_by_id: ctx.userId,
      updated_by_id: ctx.userId,
    },
  });
  id = created.id;
  for (const ident of r.value.identifiers) {
    await ctx.tx.institutionIdentifier.create({
      data: { institution_id: id, scheme: ident.scheme, value: ident.value },
    });
  }
  return { row_number: ctx.rowNumber, status: 'created', id, entityType: 'Institution' };
}
