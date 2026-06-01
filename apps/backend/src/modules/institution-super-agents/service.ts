// InstitutionSuperAgent service — manages the m:n pivot between an
// institution and the aggregator/intermediary platforms it can be reached
// through. Tenant-scoped via RLS; the application-side WHERE clauses are
// defence-in-depth.

import type { PrismaClient } from '@prisma/client';
import type {
  CreateInstitutionSuperAgentRequest,
  UpdateInstitutionSuperAgentRequest,
} from '@spv/zod-schemas';

import { Conflict, NotFound } from '../../shared/errors.js';

type Db = PrismaClient;

// List the super-agents linked to an institution. Includes a slim summary of
// each super-agent (id/name/short_name/is_active) so the FE can render chips
// without a second roundtrip.
export async function listForInstitution(
  db: Db,
  tenantId: string,
  institutionId: string,
): Promise<unknown[]> {
  // Confirm the institution exists in this tenant; surfaces a clean 404 when
  // a stale FE caches a now-deleted id.
  const inst = await db.institution.findFirst({
    where: { id: institutionId, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!inst) throw NotFound('Institution not found');

  return db.institutionSuperAgent.findMany({
    where: { tenant_id: tenantId, institution_id: institutionId, deleted_at: null },
    orderBy: [{ is_preferred: 'desc' }, { created_at: 'asc' }],
    include: {
      super_agent: {
        select: {
          id: true,
          name: true,
          short_name: true,
          is_active: true,
          status: true,
        },
      },
    },
  });
}

export async function createLink(
  db: Db,
  tenantId: string,
  actorId: string,
  institutionId: string,
  input: CreateInstitutionSuperAgentRequest,
): Promise<unknown> {
  // Confirm both ends exist in this tenant. The FK already provides referential
  // integrity but we check up-front so we can return clean 404s instead of P2003.
  const inst = await db.institution.findFirst({
    where: { id: institutionId, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!inst) throw NotFound('Institution not found');

  const sa = await db.superAgent.findFirst({
    where: { id: input.super_agent_id, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!sa) throw NotFound('Super-agent not found');

  try {
    // Note: per-link commission_pct moved to SuperAgentCommissionRule (the
    // expanded schema models effective-dated rules separately). The
    // CreateInstitutionSuperAgentRequest still accepts a commission_pct on
    // the wire for compatibility but we silently ignore it on the link row
    // itself — admins should configure rates via the dedicated rules surface.
    return await db.institutionSuperAgent.create({
      data: {
        tenant_id: tenantId,
        institution_id: institutionId,
        super_agent_id: input.super_agent_id,
        is_preferred: input.is_preferred,
        notes: input.notes ?? null,
        created_by_id: actorId,
      },
      include: {
        super_agent: {
          select: {
            id: true,
            name: true,
            short_name: true,
            is_active: true,
            status: true,
          },
        },
      },
    });
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002'
    ) {
      throw Conflict('This super-agent is already linked to this institution');
    }
    throw err;
  }
}

export async function updateLink(
  db: Db,
  tenantId: string,
  institutionId: string,
  linkId: string,
  input: UpdateInstitutionSuperAgentRequest,
): Promise<unknown> {
  const data: Record<string, unknown> = {};
  if (input.is_preferred !== undefined) data['is_preferred'] = input.is_preferred;
  if (input.notes !== undefined) data['notes'] = input.notes ?? null;
  // commission_pct is accepted but not persisted on the link itself — see the
  // note in createLink. Kept for FE shape compatibility.
  const wr = await db.institutionSuperAgent.updateMany({
    where: {
      id: linkId,
      tenant_id: tenantId,
      institution_id: institutionId,
      deleted_at: null,
    },
    data,
  });
  if (wr.count !== 1) throw NotFound('Link not found');
  return db.institutionSuperAgent.findFirstOrThrow({
    where: { id: linkId, tenant_id: tenantId },
    include: {
      super_agent: {
        select: { id: true, name: true, short_name: true, is_active: true, status: true },
      },
    },
  });
}

export async function deleteLink(
  db: Db,
  tenantId: string,
  institutionId: string,
  linkId: string,
): Promise<void> {
  // Soft-delete: keeps historical Enrollment.super_agent_id references valid
  // (the FK is on super_agents itself, but the link row carries the policy
  // metadata such as is_preferred/notes that we want preserved for audit).
  // SVT-RLS-2026-05: ensure tenant_id + institution_id in where for
  // defence-in-depth (RLS already filters by tenant; the institution_id check
  // makes sure a link from another institution can't be deleted via a guessed id).
  const wr = await db.institutionSuperAgent.updateMany({
    where: {
      id: linkId,
      tenant_id: tenantId,
      institution_id: institutionId,
      deleted_at: null,
    },
    data: { deleted_at: new Date() },
  });
  if (wr.count !== 1) throw NotFound('Link not found');
}
