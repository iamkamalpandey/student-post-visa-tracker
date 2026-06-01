// SuperAgent service — tenant-scoped CRUD with soft delete + status FSM.
//
// A super-agent is an aggregator/intermediary platform (Adventus, Edvoy, IDP,
// Apply Board, BUSY) the consultancy uses to access institutions. Many-to-many
// link with Institution lives in InstitutionSuperAgent; per-Enrollment
// attribution lives directly on Enrollment.super_agent_id.
//
// Status semantics (see fsm-def.ts):
//   ACTIVE <-> PAUSED  via FSM
//   * --> TERMINATED   terminal; once set, cannot revert.
//
// Soft delete = sets `deleted_at`; queries always filter `deleted_at: null`.

import type { Prisma, PrismaClient, UserRole } from '@prisma/client';
import type {
  CreateSuperAgentRequest,
  SuperAgentListQuery,
  UpdateSuperAgentRequest,
} from '@spv/zod-schemas';

import { Conflict, NotFound, PreconditionFailed } from '../../shared/errors.js';
import { assertOrThrow } from '../../shared/fsm.js';

import { superAgentFsm, type SuperAgentStatus } from './fsm-def.js';

type Db = PrismaClient;

// ----- list ------------------------------------------------------------------

export async function list(
  db: Db,
  tenantId: string,
  q: SuperAgentListQuery,
): Promise<unknown[]> {
  const where: Prisma.SuperAgentWhereInput = {
    tenant_id: tenantId,
    deleted_at: null,
  };
  if (q.country_code) where.country_code = q.country_code;
  if (q.type_id) where.type_id = q.type_id;
  if (q.status) where.status = q.status;
  if (q.is_active !== undefined) where.is_active = q.is_active;
  return db.superAgent.findMany({
    where,
    orderBy: [{ name: 'asc' }],
    include: {
      type: { select: { id: true, key: true, label: true } },
    },
  });
}

// ----- get -------------------------------------------------------------------

export async function getById(
  db: Db,
  tenantId: string,
  id: string,
): Promise<unknown> {
  const row = await db.superAgent.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    include: {
      type: { select: { id: true, key: true, label: true } },
      sub_processor: { select: { id: true, name: true } },
    },
  });
  if (!row) throw NotFound('Super-agent not found');
  return row;
}

// ----- create ----------------------------------------------------------------

export async function create(
  db: Db,
  tenantId: string,
  actorId: string,
  input: CreateSuperAgentRequest,
): Promise<unknown> {
  try {
    const status = input.status ?? 'ACTIVE';
    return await db.superAgent.create({
      data: {
        tenant_id: tenantId,
        type_id: input.type_id ?? null,
        name: input.name,
        short_name: input.short_name ?? null,
        legal_name: input.legal_name ?? null,
        country_code: input.country_code ?? null,
        website: input.website ?? null,
        logo_url: input.logo_url ?? null,
        contact_email: input.contact_email ?? null,
        contact_phone_e164: input.contact_phone_e164 ?? null,
        default_commission_pct: input.default_commission_pct ?? null,
        default_currency: input.default_currency ?? null,
        payment_terms_days: input.payment_terms_days ?? null,
        status,
        // Mirror legacy is_active off status when not explicitly provided.
        is_active: input.is_active ?? status === 'ACTIVE',
        sub_processor_id: input.sub_processor_id ?? null,
        notes: input.notes ?? null,
        created_by_id: actorId,
        updated_by_id: actorId,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw Conflict(
        `A super-agent named "${input.name}" already exists in this tenant`,
      );
    }
    throw err;
  }
}

// ----- update ----------------------------------------------------------------

// Optimistic concurrency: when an `expected` version is supplied the UPDATE
// fails fast with 412 if another writer has bumped the row. Status changes
// route through the FSM gate (ACTIVE <-> PAUSED, * -> TERMINATED).
export async function update(
  db: Db,
  tenantId: string,
  actorId: string,
  id: string,
  input: UpdateSuperAgentRequest,
  expected?: number,
  actorRole?: UserRole,
  reasonCode?: string,
): Promise<unknown> {
  const existing = await db.superAgent.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    select: { id: true, version: true, status: true },
  });
  if (!existing) throw NotFound('Super-agent not found');
  if (expected !== undefined && existing.version !== expected) {
    throw PreconditionFailed(
      'Record was modified by another request; reload and retry.',
    );
  }

  // FSM gate for status changes.
  if (input.status !== undefined && input.status !== existing.status) {
    const role: UserRole = actorRole ?? 'COUNSELLOR';
    assertOrThrow(
      superAgentFsm,
      existing.status as SuperAgentStatus,
      input.status as SuperAgentStatus,
      role,
      reasonCode,
    );
  }

  const data: Prisma.SuperAgentUncheckedUpdateInput = {
    updated_by_id: actorId,
    version: { increment: 1 },
  };
  if (input.type_id !== undefined) data.type_id = input.type_id ?? null;
  if (input.name !== undefined) data.name = input.name;
  if (input.short_name !== undefined) data.short_name = input.short_name ?? null;
  if (input.legal_name !== undefined) data.legal_name = input.legal_name ?? null;
  if (input.country_code !== undefined) data.country_code = input.country_code ?? null;
  if (input.website !== undefined) data.website = input.website ?? null;
  if (input.logo_url !== undefined) data.logo_url = input.logo_url ?? null;
  if (input.contact_email !== undefined) data.contact_email = input.contact_email ?? null;
  if (input.contact_phone_e164 !== undefined) {
    data.contact_phone_e164 = input.contact_phone_e164 ?? null;
  }
  if (input.default_commission_pct !== undefined) {
    data.default_commission_pct = input.default_commission_pct ?? null;
  }
  if (input.default_currency !== undefined) {
    data.default_currency = input.default_currency ?? null;
  }
  if (input.payment_terms_days !== undefined) {
    data.payment_terms_days = input.payment_terms_days ?? null;
  }
  if (input.status !== undefined) {
    data.status = input.status;
    // Mirror legacy is_active off status whenever status itself moves; keeps
    // pre-status FE/queries that filter on is_active in sync.
    if (input.is_active === undefined) {
      data.is_active = input.status === 'ACTIVE';
    }
  }
  if (input.is_active !== undefined) data.is_active = input.is_active;
  if (input.sub_processor_id !== undefined) {
    data.sub_processor_id = input.sub_processor_id ?? null;
  }
  if (input.notes !== undefined) data.notes = input.notes ?? null;

  try {
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const where: Prisma.SuperAgentWhereInput = {
      id,
      tenant_id: tenantId,
      deleted_at: null,
    };
    if (expected !== undefined) where.version = expected;
    const wr = await db.superAgent.updateMany({ where, data });
    if (wr.count !== 1) {
      if (expected !== undefined) {
        const stillThere = await db.superAgent.findFirst({
          where: { id, tenant_id: tenantId, deleted_at: null },
          select: { id: true },
        });
        if (stillThere) {
          throw PreconditionFailed(
            'Record was modified by another request; reload and retry.',
          );
        }
      }
      throw NotFound('Super-agent not found');
    }
    return await db.superAgent.findFirstOrThrow({
      where: { id, tenant_id: tenantId },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw Conflict('A super-agent with that name already exists in your tenant');
    }
    throw err;
  }
}

// ----- soft delete -----------------------------------------------------------

export async function softDelete(
  db: Db,
  tenantId: string,
  actorId: string,
  id: string,
): Promise<void> {
  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await db.superAgent.updateMany({
    where: { id, tenant_id: tenantId, deleted_at: null },
    data: {
      deleted_at: new Date(),
      is_active: false,
      status: 'TERMINATED',
      updated_by_id: actorId,
    },
  });
  if (wr.count !== 1) throw NotFound('Super-agent not found');
}

// ----- metrics ---------------------------------------------------------------

export async function metrics(
  db: Db,
  tenantId: string,
  superAgentId: string,
): Promise<{
  super_agent_id: string;
  enrollments_total: number;
  enrollments_by_status: Record<string, number>;
  commissions_by_currency: Record<string, string>;
  linked_institutions: number;
}> {
  const sa = await db.superAgent.findFirst({
    where: { id: superAgentId, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!sa) throw NotFound('Super-agent not found');

  const [enrolByStatus, claimsByCcy, links] = await Promise.all([
    db.enrollment.groupBy({
      by: ['status'],
      where: { tenant_id: tenantId, super_agent_id: superAgentId, deleted_at: null },
      _count: { _all: true },
    }),
    db.commissionClaim.groupBy({
      by: ['currency'],
      where: { tenant_id: tenantId, super_agent_id: superAgentId, deleted_at: null },
      _sum: { amount_minor: true },
    }),
    db.institutionSuperAgent.count({
      where: { tenant_id: tenantId, super_agent_id: superAgentId, deleted_at: null },
    }),
  ]);

  const enrollments_by_status: Record<string, number> = {};
  let enrollments_total = 0;
  for (const r of enrolByStatus) {
    enrollments_by_status[r.status] = r._count._all;
    enrollments_total += r._count._all;
  }
  const commissions_by_currency: Record<string, string> = {};
  for (const r of claimsByCcy) {
    commissions_by_currency[r.currency] = (r._sum.amount_minor ?? 0n).toString();
  }
  return {
    super_agent_id: superAgentId,
    enrollments_total,
    enrollments_by_status,
    commissions_by_currency,
    linked_institutions: links,
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

// Cross-module helper: verify that a super-agent is linked to the given
// institution (used by enrollments.service to gate Enrollment.super_agent_id
// writes). Returns true iff the link exists for this tenant and is not
// soft-deleted.
export async function isLinkedToInstitution(
  db: Db,
  tenantId: string,
  institutionId: string,
  superAgentId: string,
): Promise<boolean> {
  const row = await db.institutionSuperAgent.findFirst({
    where: {
      tenant_id: tenantId,
      institution_id: institutionId,
      super_agent_id: superAgentId,
      deleted_at: null,
    },
    select: { id: true },
  });
  return Boolean(row);
}
