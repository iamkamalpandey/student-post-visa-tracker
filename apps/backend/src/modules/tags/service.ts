// Tag + EntityTag service. Both hard-deleted.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateTagRequest,
  UpdateTagRequest,
  TagListQuery,
  CreateEntityTagRequest,
  EntityTagListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

export const tagService = {
  async create(req: { db?: DB; user?: { tid: string } }, body: CreateTagRequest) {
    const created = await db(req).tag.create({ data: { ...body, tenant_id: req.user!.tid } as never });
    await writeAudit(req as never, {
      action: 'tag.created',
      entityType: 'tag',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, q: TagListQuery) {
    // SVT-LOOKUP-FILTERS-2026-05: picker default is active-only. Admin tooling
    // can pass ?include_inactive=true to see archived tags too.
    return db(req).tag.findMany({
      where: {
        tenant_id: req.user!.tid,
        ...(q.include_inactive ? {} : { is_active: true }),
      },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).tag.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Tag not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateTagRequest,
    _opts?: { expected?: number },
  ) {
    // Tag has no version column; If-Match is accepted-but-ignored for API
    // consistency. Lift to applyVersionedUpdate if/when a version column lands.
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).tag.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: body as never,
    });
    if (r.count !== 1) throw NotFound('Tag not found');
    const after = await db(req).tag.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'tag.updated',
      entityType: 'tag',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).tag.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Tag not found');
    await writeAudit(req as never, {
      action: 'tag.deleted',
      entityType: 'tag',
      entityId: id,
      before,
    });
  },
};

export const entityTagService = {
  async create(req: { db?: DB; user?: { tid: string; sub: string } }, body: CreateEntityTagRequest) {
    const created = await db(req).entityTag.create({
      data: { ...body, tenant_id: req.user!.tid, created_by_id: req.user?.sub ?? null } as never,
    });
    await writeAudit(req as never, {
      action: 'entity_tag.created',
      entityType: 'entity_tag',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, q: EntityTagListQuery) {
    return db(req).entityTag.findMany({
      where: {
        tenant_id: req.user!.tid,
        ...(q.entity_type ? { entity_type: q.entity_type } : {}),
        ...(q.entity_id ? { entity_id: q.entity_id } : {}),
        ...(q.tag_id ? { tag_id: q.tag_id } : {}),
      },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).entityTag.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Entity tag not found');
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).entityTag.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Entity tag not found');
    await writeAudit(req as never, {
      action: 'entity_tag.deleted',
      entityType: 'entity_tag',
      entityId: id,
      before: found,
    });
  },
};
