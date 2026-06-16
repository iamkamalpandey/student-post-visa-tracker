import type { Prisma } from '@prisma/client';
import type {
  CreateCampusRequest,
  CreateDepartmentRequest,
  CreateInstitutionAccreditationRequest,
  CreateInstitutionContactRequest,
  CreateInstitutionIdentifierRequest,
  CreateInstitutionRequest,
  CreateSchoolRequest,
  InstitutionListQuery,
  UpdateCampusRequest,
  UpdateDepartmentRequest,
  UpdateInstitutionRequest,
  UpdateSchoolRequest,
} from '@spv/zod-schemas';

import { Conflict, NotFound, PreconditionFailed } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import {
  decodeCursor,
  encodeCursor,
  type Db,
} from './institutions.types.js';

// All service functions take an explicit Db so the handler can pass the RLS-scoped
// req.db (preferred) or fall back to the singleton (background jobs, scripts).
type Ctx = { db: Db; tenantId: string; actorId: string };
type ReadCtx = { db: Db; tenantId: string };

// -----------------------------------------------------------------------------
// Institution: list / get / create / update / softDelete
// -----------------------------------------------------------------------------

export async function list(
  ctx: ReadCtx,
  q: InstitutionListQuery,
): Promise<{ data: unknown[]; nextCursor: string | null; hasMore: boolean; total: number }> {
  const { db, tenantId } = ctx;
  const limit = q.limit;

  const where: Prisma.InstitutionWhereInput = {
    tenant_id: tenantId,
    deleted_at: null,
  };
  if (q.country_code) where.country_code = q.country_code;
  if (typeof q.is_partner === 'boolean') where.is_partner = q.is_partner;
  if (q.q) {
    const needle = q.q.trim();
    where.OR = [
      { display_name: { contains: needle, mode: 'insensitive' } },
      { legal_name: { contains: needle, mode: 'insensitive' } },
      { short_name: { contains: needle, mode: 'insensitive' } },
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

  // Fetch one extra row to determine hasMore without a second round-trip.
  const [rowsPlusOne, total] = await Promise.all([
    db.institution.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        _count: {
          select: {
            programs: true,
            campuses: true,
            schools: true,
            super_agent_links: true,
          },
        },
      },
    }),
    db.institution.count({ where }),
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
  const row = await ctx.db.institution.findFirst({
    where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    include: {
      identifiers: true,
      accreditations: true,
      contacts: true,
      campuses: true,
      schools: {
        include: {
          _count: { select: { departments: true, programs: true } },
        },
      },
      _count: {
        select: {
          programs: true,
          enrollments: true,
          super_agent_links: true,
        },
      },
    },
  });
  if (!row) throw NotFound('Institution not found');
  return row;
}

export async function create(ctx: Ctx, input: CreateInstitutionRequest): Promise<unknown> {
  const { db, tenantId, actorId } = ctx;

  const data: Prisma.InstitutionUncheckedCreateInput = {
    tenant_id: tenantId,
    legal_name: input.legal_name,
    display_name: input.display_name,
    short_name: input.short_name ?? null,
    type: input.type,
    country_code: input.country_code,
    website: input.website ?? null,
    email: input.email ?? null,
    phone_e164: input.phone_e164 ?? null,
    established_year: input.established_year ?? null,
    ranking_global: input.ranking_global ?? null,
    ranking_national: input.ranking_national ?? null,
    description: input.description ?? null,
    logo_url: input.logo_url ?? null,
    banner_url: input.banner_url ?? null,
    is_partner: input.is_partner ?? false,
    partner_since: input.partner_since ? new Date(input.partner_since) : null,
    commission_pct: input.commission_pct ?? null,
    created_by_id: actorId,
    updated_by_id: actorId,
  };

  const created = await db.institution.create({ data });
  // SVT-WAVE-AUDIT-CATALOG-2026-06 (W2.10) — institution creation is a
  // catalog-mutation that downstream programs/fees/commission math depend on.
  // Record an append-only audit row with the identifying shape of the new row.
  await writeAudit({
    action: 'institution.created',
    entityType: 'institution',
    entityId: created.id,
    actorId,
    tenantId,
    after: {
      legal_name: created.legal_name,
      display_name: created.display_name,
      country_code: created.country_code,
      type: created.type,
      is_partner: created.is_partner,
    },
  } as never);
  return created;
}

export async function update(
  ctx: Ctx,
  id: string,
  input: UpdateInstitutionRequest,
  ifMatch: string | undefined,
): Promise<unknown> {
  const { db, tenantId, actorId } = ctx;
  if (!ifMatch) throw PreconditionFailed('If-Match header is required for updates');
  const expected = parseInt(ifMatch.replace(/^"|"$/g, ''), 10);
  if (!Number.isFinite(expected) || expected < 1) {
    throw PreconditionFailed('If-Match must be a numeric version');
  }

  const current = await db.institution.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    select: {
      id: true,
      version: true,
      // SVT-WAVE-AUDIT-CATALOG-2026-06 (W2.10) — capture the pre-update identifying
      // fields for the audit `before`. Widened beyond {id,version} purely for the
      // audit snapshot; the version/If-Match guard below is unchanged.
      legal_name: true,
      display_name: true,
      country_code: true,
      is_partner: true,
      commission_pct: true,
    },
  });
  if (!current) throw NotFound('Institution not found');
  if (current.version !== expected) {
    throw PreconditionFailed(
      `Version mismatch (have ${current.version}, expected ${expected})`,
    );
  }

  const data: Prisma.InstitutionUncheckedUpdateInput = {
    updated_by_id: actorId,
    version: { increment: 1 },
  };
  if (input.legal_name !== undefined) data.legal_name = input.legal_name;
  if (input.display_name !== undefined) data.display_name = input.display_name;
  if (input.short_name !== undefined) data.short_name = input.short_name ?? null;
  if (input.type !== undefined) data.type = input.type;
  if (input.country_code !== undefined) data.country_code = input.country_code;
  if (input.website !== undefined) data.website = input.website ?? null;
  if (input.email !== undefined) data.email = input.email ?? null;
  if (input.phone_e164 !== undefined) data.phone_e164 = input.phone_e164 ?? null;
  if (input.established_year !== undefined) data.established_year = input.established_year ?? null;
  if (input.ranking_global !== undefined) data.ranking_global = input.ranking_global ?? null;
  if (input.ranking_national !== undefined) data.ranking_national = input.ranking_national ?? null;
  if (input.description !== undefined) data.description = input.description ?? null;
  if (input.logo_url !== undefined) data.logo_url = input.logo_url ?? null;
  if (input.banner_url !== undefined) data.banner_url = input.banner_url ?? null;
  if (input.is_partner !== undefined) data.is_partner = input.is_partner;
  if (input.partner_since !== undefined) {
    data.partner_since = input.partner_since ? new Date(input.partner_since) : null;
  }
  if (input.commission_pct !== undefined) data.commission_pct = input.commission_pct ?? null;

  // Conditional UPDATE — zero rows means a concurrent writer beat us.
  const result = await db.institution.updateMany({
    where: { id, tenant_id: tenantId, deleted_at: null, version: expected },
    data: data as unknown as Prisma.InstitutionUpdateManyMutationInput,
  });
  if (result.count === 0) throw Conflict('Concurrent update detected; retry with the latest version');

  // SVT-WAVE-AUDIT-CATALOG-2026-06 (W2.10) — record the change. before holds the
  // pre-update identifying fields (snapshotted above); after reflects the
  // effective post-update value (input.X when supplied, else the prior value).
  // commission_pct is included because it feeds downstream commission math.
  await writeAudit({
    action: 'institution.updated',
    entityType: 'institution',
    entityId: id,
    actorId,
    tenantId,
    before: {
      legal_name: current.legal_name,
      display_name: current.display_name,
      country_code: current.country_code,
      is_partner: current.is_partner,
      commission_pct: current.commission_pct,
    },
    after: {
      legal_name: input.legal_name ?? current.legal_name,
      display_name: input.display_name ?? current.display_name,
      country_code: input.country_code ?? current.country_code,
      is_partner: input.is_partner ?? current.is_partner,
      commission_pct:
        input.commission_pct !== undefined ? input.commission_pct : current.commission_pct,
    },
  } as never);

  return getById({ db, tenantId }, id);
}

export async function softDelete(ctx: Ctx, id: string): Promise<void> {
  const { db, tenantId, actorId } = ctx;
  // SVT-WAVE-AUDIT-CATALOG-2026-06 (W2.10) — capture identifying fields before the
  // soft-delete so the audit `before` reports what was removed. Returns the row
  // (or null) so we keep the existing NotFound semantics via result.count below.
  const existing = await db.institution.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    select: { id: true, legal_name: true, display_name: true, country_code: true },
  });
  const result = await db.institution.updateMany({
    where: { id, tenant_id: tenantId, deleted_at: null },
    data: { deleted_at: new Date() },
  });
  if (result.count === 0) throw NotFound('Institution not found');
  await writeAudit({
    action: 'institution.deleted',
    entityType: 'institution',
    entityId: id,
    actorId,
    tenantId,
    before: {
      id,
      legal_name: existing?.legal_name,
      display_name: existing?.display_name,
      country_code: existing?.country_code,
    },
    after: { deleted: true },
  } as never);
}

// -----------------------------------------------------------------------------
// Tenant ownership guard — used by every nested-collection mutation to ensure the
// caller can't reach into another tenant's institution by guessing the id.
// -----------------------------------------------------------------------------
async function assertOwnsInstitution(
  db: Db,
  tenantId: string,
  institutionId: string,
): Promise<void> {
  const ok = await db.institution.findFirst({
    where: { id: institutionId, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!ok) throw NotFound('Institution not found');
}

// -----------------------------------------------------------------------------
// Identifiers
// -----------------------------------------------------------------------------

export async function listIdentifiers(ctx: ReadCtx, institutionId: string): Promise<unknown[]> {
  await assertOwnsInstitution(ctx.db, ctx.tenantId, institutionId);
  return ctx.db.institutionIdentifier.findMany({
    where: { institution_id: institutionId },
    orderBy: { scheme: 'asc' },
  });
}

export async function createIdentifier(
  ctx: Ctx,
  institutionId: string,
  input: CreateInstitutionIdentifierRequest,
): Promise<unknown> {
  await assertOwnsInstitution(ctx.db, ctx.tenantId, institutionId);
  const created = await ctx.db.institutionIdentifier.create({
    data: {
      institution_id: institutionId,
      scheme: input.scheme,
      value: input.value,
      issued_by: input.issued_by ?? null,
      valid_from: input.valid_from ? new Date(input.valid_from) : null,
      valid_to: input.valid_to ? new Date(input.valid_to) : null,
    },
  });
  await writeAudit({
    action: 'institution.identifier.created',
    entityType: 'institution_identifier',
    entityId: created.id,
    actorId: ctx.actorId,
    tenantId: ctx.tenantId,
    after: { institution_id: institutionId, scheme: created.scheme, value: created.value },
  } as never);
  return created;
}

export async function deleteIdentifier(ctx: Ctx, identifierId: string): Promise<void> {
  // Tenant scoping happens via the institution relationship. We re-check it here.
  const row = await ctx.db.institutionIdentifier.findFirst({
    where: { id: identifierId, institution: { tenant_id: ctx.tenantId, deleted_at: null } },
    select: { id: true, institution_id: true, scheme: true, value: true },
  });
  if (!row) throw NotFound('Identifier not found');
  await ctx.db.institutionIdentifier.delete({ where: { id: identifierId } });
  await writeAudit({
    action: 'institution.identifier.deleted',
    entityType: 'institution_identifier',
    entityId: identifierId,
    actorId: ctx.actorId,
    tenantId: ctx.tenantId,
    before: { id: identifierId, institution_id: row.institution_id, scheme: row.scheme, value: row.value },
    after: { deleted: true },
  } as never);
}

// -----------------------------------------------------------------------------
// Accreditations
// -----------------------------------------------------------------------------

export async function listAccreditations(
  ctx: ReadCtx,
  institutionId: string,
): Promise<unknown[]> {
  await assertOwnsInstitution(ctx.db, ctx.tenantId, institutionId);
  return ctx.db.institutionAccreditation.findMany({
    where: { institution_id: institutionId },
    orderBy: { awarded_on: 'desc' },
  });
}

export async function createAccreditation(
  ctx: Ctx,
  institutionId: string,
  input: CreateInstitutionAccreditationRequest,
): Promise<unknown> {
  await assertOwnsInstitution(ctx.db, ctx.tenantId, institutionId);
  const created = await ctx.db.institutionAccreditation.create({
    data: {
      institution_id: institutionId,
      body: input.body,
      accreditation_no: input.accreditation_no ?? null,
      awarded_on: input.awarded_on ? new Date(input.awarded_on) : null,
      expires_on: input.expires_on ? new Date(input.expires_on) : null,
      scope: input.scope ?? null,
    },
  });
  await writeAudit({
    action: 'institution.accreditation.created',
    entityType: 'institution_accreditation',
    entityId: created.id,
    actorId: ctx.actorId,
    tenantId: ctx.tenantId,
    after: { institution_id: institutionId, body: created.body, accreditation_no: created.accreditation_no },
  } as never);
  return created;
}

export async function deleteAccreditation(ctx: Ctx, accreditationId: string): Promise<void> {
  const row = await ctx.db.institutionAccreditation.findFirst({
    where: { id: accreditationId, institution: { tenant_id: ctx.tenantId, deleted_at: null } },
    select: { id: true, institution_id: true, body: true, accreditation_no: true },
  });
  if (!row) throw NotFound('Accreditation not found');
  await ctx.db.institutionAccreditation.delete({ where: { id: accreditationId } });
  await writeAudit({
    action: 'institution.accreditation.deleted',
    entityType: 'institution_accreditation',
    entityId: accreditationId,
    actorId: ctx.actorId,
    tenantId: ctx.tenantId,
    before: { id: accreditationId, institution_id: row.institution_id, body: row.body, accreditation_no: row.accreditation_no },
    after: { deleted: true },
  } as never);
}

// -----------------------------------------------------------------------------
// Contacts
// -----------------------------------------------------------------------------

export async function listContacts(ctx: ReadCtx, institutionId: string): Promise<unknown[]> {
  await assertOwnsInstitution(ctx.db, ctx.tenantId, institutionId);
  return ctx.db.institutionContact.findMany({
    where: { institution_id: institutionId },
    orderBy: [{ is_primary: 'desc' }, { full_name: 'asc' }],
  });
}

export async function createContact(
  ctx: Ctx,
  institutionId: string,
  input: CreateInstitutionContactRequest,
): Promise<unknown> {
  await assertOwnsInstitution(ctx.db, ctx.tenantId, institutionId);
  // SVT-DQ-2026-06 — at most one primary contact per institution (radio-button
  // semantics): demote any existing primary before promoting this one. Backed by
  // a partial unique index as the concurrent-race safety net.
  if (input.is_primary) {
    await ctx.db.institutionContact.updateMany({
      where: { institution_id: institutionId, is_primary: true },
      data: { is_primary: false },
    });
  }
  const created = await ctx.db.institutionContact.create({
    data: {
      institution_id: institutionId,
      full_name: input.full_name,
      designation: input.designation ?? null,
      department: input.department ?? null,
      email: input.email ?? null,
      phone_e164: input.phone_e164 ?? null,
      is_primary: input.is_primary ?? false,
      notes: input.notes ?? null,
    },
  });
  await writeAudit({
    action: 'institution.contact.created',
    entityType: 'institution_contact',
    entityId: created.id,
    actorId: ctx.actorId,
    tenantId: ctx.tenantId,
    after: { institution_id: institutionId, full_name: created.full_name, is_primary: created.is_primary },
  } as never);
  return created;
}

export async function deleteContact(ctx: Ctx, contactId: string): Promise<void> {
  const row = await ctx.db.institutionContact.findFirst({
    where: { id: contactId, institution: { tenant_id: ctx.tenantId, deleted_at: null } },
    select: { id: true, institution_id: true, full_name: true, is_primary: true },
  });
  if (!row) throw NotFound('Contact not found');
  await ctx.db.institutionContact.delete({ where: { id: contactId } });
  await writeAudit({
    action: 'institution.contact.deleted',
    entityType: 'institution_contact',
    entityId: contactId,
    actorId: ctx.actorId,
    tenantId: ctx.tenantId,
    before: { id: contactId, institution_id: row.institution_id, full_name: row.full_name, is_primary: row.is_primary },
    after: { deleted: true },
  } as never);
}

// -----------------------------------------------------------------------------
// Campuses
// -----------------------------------------------------------------------------

export async function listCampuses(ctx: ReadCtx, institutionId: string): Promise<unknown[]> {
  await assertOwnsInstitution(ctx.db, ctx.tenantId, institutionId);
  return ctx.db.campus.findMany({
    where: { institution_id: institutionId },
    orderBy: [{ is_main: 'desc' }, { name: 'asc' }],
  });
}

export async function createCampus(
  ctx: Ctx,
  institutionId: string,
  input: CreateCampusRequest,
): Promise<unknown> {
  await assertOwnsInstitution(ctx.db, ctx.tenantId, institutionId);
  // SVT-DQ-2026-06 — at most one main campus per institution; demote the prior.
  if (input.is_main) {
    await ctx.db.campus.updateMany({
      where: { institution_id: institutionId, is_main: true },
      data: { is_main: false },
    });
  }
  return ctx.db.campus.create({
    data: {
      institution_id: institutionId,
      name: input.name,
      is_main: input.is_main ?? false,
      address_id: input.address_id ?? null,
      timezone: input.timezone ?? 'UTC',
      phone_e164: input.phone_e164 ?? null,
      email: input.email ?? null,
    },
  });
}

export async function updateCampus(
  ctx: Ctx,
  campusId: string,
  input: UpdateCampusRequest,
): Promise<unknown> {
  const row = await ctx.db.campus.findFirst({
    where: { id: campusId, institution: { tenant_id: ctx.tenantId, deleted_at: null } },
    select: { id: true, institution_id: true },
  });
  if (!row) throw NotFound('Campus not found');

  // SVT-DQ-2026-06 — promoting this campus to main demotes the prior main.
  if (input.is_main === true) {
    await ctx.db.campus.updateMany({
      where: { institution_id: row.institution_id, is_main: true, id: { not: campusId } },
      data: { is_main: false },
    });
  }

  const data: Prisma.CampusUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.is_main !== undefined) data.is_main = input.is_main;
  if (input.address_id !== undefined) {
    data.address = input.address_id
      ? { connect: { id: input.address_id } }
      : { disconnect: true };
  }
  if (input.timezone !== undefined) data.timezone = input.timezone ?? 'UTC';
  if (input.phone_e164 !== undefined) data.phone_e164 = input.phone_e164 ?? null;
  if (input.email !== undefined) data.email = input.email ?? null;
  if (input.is_active !== undefined) data.is_active = input.is_active;

  return ctx.db.campus.update({ where: { id: campusId }, data });
}

export async function deleteCampus(ctx: Ctx, campusId: string): Promise<void> {
  const row = await ctx.db.campus.findFirst({
    where: { id: campusId, institution: { tenant_id: ctx.tenantId, deleted_at: null } },
    select: { id: true },
  });
  if (!row) throw NotFound('Campus not found');
  await ctx.db.campus.delete({ where: { id: campusId } });
}

// -----------------------------------------------------------------------------
// Schools / Departments
// -----------------------------------------------------------------------------

export async function listSchools(ctx: ReadCtx, institutionId: string): Promise<unknown[]> {
  await assertOwnsInstitution(ctx.db, ctx.tenantId, institutionId);
  return ctx.db.school.findMany({
    where: { institution_id: institutionId },
    orderBy: { name: 'asc' },
    include: {
      departments: { orderBy: { name: 'asc' } },
      _count: { select: { programs: true } },
    },
  });
}

export async function createSchool(
  ctx: Ctx,
  institutionId: string,
  input: CreateSchoolRequest,
): Promise<unknown> {
  await assertOwnsInstitution(ctx.db, ctx.tenantId, institutionId);
  return ctx.db.school.create({
    data: {
      institution_id: institutionId,
      name: input.name,
      short_name: input.short_name ?? null,
    },
  });
}

export async function updateSchool(
  ctx: Ctx,
  schoolId: string,
  input: UpdateSchoolRequest,
): Promise<unknown> {
  const row = await ctx.db.school.findFirst({
    where: { id: schoolId, institution: { tenant_id: ctx.tenantId, deleted_at: null } },
    select: { id: true },
  });
  if (!row) throw NotFound('School not found');

  const data: Prisma.SchoolUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.short_name !== undefined) data.short_name = input.short_name ?? null;
  if (input.is_active !== undefined) data.is_active = input.is_active;

  return ctx.db.school.update({ where: { id: schoolId }, data });
}

export async function deleteSchool(ctx: Ctx, schoolId: string): Promise<void> {
  const row = await ctx.db.school.findFirst({
    where: { id: schoolId, institution: { tenant_id: ctx.tenantId, deleted_at: null } },
    select: { id: true },
  });
  if (!row) throw NotFound('School not found');
  await ctx.db.school.delete({ where: { id: schoolId } });
}

export async function createDepartment(
  ctx: Ctx,
  schoolId: string,
  input: CreateDepartmentRequest,
): Promise<unknown> {
  // The schoolId in the URL must agree with the body. This catches accidental cross-posting.
  if (input.school_id !== schoolId) {
    throw NotFound('school_id in body does not match URL');
  }
  const school = await ctx.db.school.findFirst({
    where: { id: schoolId, institution: { tenant_id: ctx.tenantId, deleted_at: null } },
    select: { id: true },
  });
  if (!school) throw NotFound('School not found');

  return ctx.db.department.create({
    data: {
      school_id: schoolId,
      name: input.name,
      short_name: input.short_name ?? null,
    },
  });
}

export async function updateDepartment(
  ctx: Ctx,
  departmentId: string,
  input: UpdateDepartmentRequest,
): Promise<unknown> {
  const row = await ctx.db.department.findFirst({
    where: {
      id: departmentId,
      school: { institution: { tenant_id: ctx.tenantId, deleted_at: null } },
    },
    select: { id: true },
  });
  if (!row) throw NotFound('Department not found');

  const data: Prisma.DepartmentUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.short_name !== undefined) data.short_name = input.short_name ?? null;
  if (input.is_active !== undefined) data.is_active = input.is_active;

  return ctx.db.department.update({ where: { id: departmentId }, data });
}

export async function deleteDepartment(ctx: Ctx, departmentId: string): Promise<void> {
  const row = await ctx.db.department.findFirst({
    where: {
      id: departmentId,
      school: { institution: { tenant_id: ctx.tenantId, deleted_at: null } },
    },
    select: { id: true },
  });
  if (!row) throw NotFound('Department not found');
  await ctx.db.department.delete({ where: { id: departmentId } });
}
