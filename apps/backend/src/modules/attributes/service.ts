// AttributeDefinition + EntityAttribute service. Hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateAttributeDefinitionRequest,
  UpdateAttributeDefinitionRequest,
  CreateEntityAttributeRequest,
  UpdateEntityAttributeRequest,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

interface ListQ { limit: number; cursor?: string; entity_type?: string; entity_id?: string; definition_id?: string }

export const attributeDefinitionService = {
  async create(req: { db?: DB; user?: { tid: string } }, body: CreateAttributeDefinitionRequest) {
    const created = await db(req).attributeDefinition.create({
      data: {
        ...body,
        tenant_id: req.user!.tid,
        ...(body.enum_values ? { enum_values: body.enum_values } : {}),
      } as never,
    });
    await writeAudit(req as never, {
      action: 'attribute_definition.created',
      entityType: 'attribute_definition',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, q: ListQ) {
    return db(req).attributeDefinition.findMany({
      where: { tenant_id: req.user!.tid, ...(q.entity_type ? { entity_type: q.entity_type } : {}) },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).attributeDefinition.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Attribute definition not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateAttributeDefinitionRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — _opts.expected accepted for API parity with
    // versioned modules; AttributeDefinition has no `version` column (no-op).
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).attributeDefinition.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: body as never,
    });
    if (r.count !== 1) throw NotFound('Attribute definition not found');
    const after = await db(req).attributeDefinition.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'attribute_definition.updated',
      entityType: 'attribute_definition',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).attributeDefinition.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Attribute definition not found');
    await writeAudit(req as never, {
      action: 'attribute_definition.deleted',
      entityType: 'attribute_definition',
      entityId: id,
      before,
    });
  },
};

export const entityAttributeService = {
  async create(req: { db?: DB; user?: { tid: string } }, body: CreateEntityAttributeRequest) {
    const created = await db(req).entityAttribute.create({ data: { ...body, tenant_id: req.user!.tid } as never });
    await writeAudit(req as never, {
      action: 'entity_attribute.created',
      entityType: 'entity_attribute',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, q: ListQ) {
    return db(req).entityAttribute.findMany({
      where: {
        tenant_id: req.user!.tid,
        ...(q.entity_type ? { entity_type: q.entity_type } : {}),
        ...(q.entity_id ? { entity_id: q.entity_id } : {}),
        ...(q.definition_id ? { definition_id: q.definition_id } : {}),
      },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).entityAttribute.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Entity attribute not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateEntityAttributeRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — _opts.expected accepted for API parity with
    // versioned modules; EntityAttribute has no `version` column (no-op).
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).entityAttribute.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: body as never,
    });
    if (r.count !== 1) throw NotFound('Entity attribute not found');
    const after = await db(req).entityAttribute.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'entity_attribute.updated',
      entityType: 'entity_attribute',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).entityAttribute.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Entity attribute not found');
    await writeAudit(req as never, {
      action: 'entity_attribute.deleted',
      entityType: 'entity_attribute',
      entityId: id,
      before,
    });
  },
};
