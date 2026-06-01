// VisaType service — tenant-scoped CRUD with soft delete.
//
// `is_generic` rows act as the tenant default for a country. They CAN'T be
// renamed (name change) or soft-deleted because downstream code (and reporting
// links) may pin to them. Re-classifying a row from generic → non-generic via
// PATCH is allowed and is the supported way to retire a default.
//
// Soft delete = sets `deleted_at`; queries always filter `deleted_at: null`.
// Re-using a (tenant, country, name) tuple after delete is allowed because the
// soft-deleted row is excluded from the unique index lookup at the application
// level (we INSERT with the same values; the DB unique still bites only if we
// don't filter, which we do via `findFirst`). For full safety the unique
// constraint may need a partial index in a follow-up migration.

import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  CreateVisaTypeRequest,
  UpdateVisaTypeRequest,
  VisaTypeListQuery,
} from '@spv/zod-schemas';

import { Conflict, NotFound, UnprocessableEntity } from '../../shared/errors.js';

type Db = PrismaClient;

// ----- list ------------------------------------------------------------------

export async function list(
  db: Db,
  tenantId: string,
  q: VisaTypeListQuery,
): Promise<unknown[]> {
  const where: Prisma.VisaTypeWhereInput = {
    tenant_id: tenantId,
    deleted_at: null,
  };
  if (q.country_code) where.country_code = q.country_code;
  if (q.is_active !== undefined) where.is_active = q.is_active;
  return db.visaType.findMany({
    where,
    orderBy: [{ country_code: 'asc' }, { is_generic: 'desc' }, { name: 'asc' }],
  });
}

// ----- get -------------------------------------------------------------------

export async function getById(db: Db, tenantId: string, id: string): Promise<unknown> {
  const row = await db.visaType.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
  });
  if (!row) throw NotFound('Visa type not found');
  return row;
}

// ----- create ----------------------------------------------------------------

export async function create(
  db: Db,
  tenantId: string,
  input: CreateVisaTypeRequest,
): Promise<unknown> {
  try {
    return await db.visaType.create({
      data: {
        tenant_id: tenantId,
        country_code: input.country_code,
        name: input.name,
        short_name: input.short_name ?? null,
        description: input.description ?? null,
        is_active: input.is_active,
        is_generic: input.is_generic,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw Conflict(
        `A visa type named "${input.name}" already exists for ${input.country_code} in this tenant`,
      );
    }
    throw err;
  }
}

// ----- update ----------------------------------------------------------------

// Generic rows have a guarded shape: name + is_generic itself can't be changed
// without an explicit "convert to non-generic" sequence (clear is_generic
// first, then rename). is_active still flips so admins can hide a default.
export async function update(
  db: Db,
  tenantId: string,
  id: string,
  input: UpdateVisaTypeRequest,
): Promise<unknown> {
  const existing = await db.visaType.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
  });
  if (!existing) throw NotFound('Visa type not found');

  if (existing.is_generic) {
    if (input.name !== undefined && input.name !== existing.name) {
      throw UnprocessableEntity(
        'Cannot rename a generic visa type — clear is_generic first if you really intend to retire it',
      );
    }
  }

  const data: Prisma.VisaTypeUpdateInput = {};
  if (input.country_code !== undefined) data.country_code = input.country_code;
  if (input.name !== undefined) data.name = input.name;
  if (input.short_name !== undefined) data.short_name = input.short_name ?? null;
  if (input.description !== undefined) data.description = input.description ?? null;
  if (input.is_active !== undefined) data.is_active = input.is_active;
  if (input.is_generic !== undefined) data.is_generic = input.is_generic;

  try {
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const wr = await db.visaType.updateMany({
      where: { id, tenant_id: tenantId, deleted_at: null },
      data: data as unknown as Prisma.VisaTypeUpdateManyMutationInput,
    });
    if (wr.count !== 1) throw NotFound('Visa type not found');
    return await db.visaType.findFirstOrThrow({ where: { id, tenant_id: tenantId } });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw Conflict('A visa type with that name already exists for this country in your tenant');
    }
    throw err;
  }
}

// ----- soft delete -----------------------------------------------------------

// Generic rows are protected from deletion (orphaning catastrophe). Admins
// must demote (PATCH is_generic=false) before deleting.
export async function softDelete(db: Db, tenantId: string, id: string): Promise<void> {
  const existing = await db.visaType.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    select: { id: true, is_generic: true },
  });
  if (!existing) throw NotFound('Visa type not found');
  if (existing.is_generic) {
    throw UnprocessableEntity(
      'Cannot delete a generic visa type — clear is_generic first via PATCH',
    );
  }

  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await db.visaType.updateMany({
    where: { id, tenant_id: tenantId, deleted_at: null },
    data: { deleted_at: new Date(), is_active: false },
  });
  if (wr.count !== 1) throw NotFound('Visa type not found');
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
