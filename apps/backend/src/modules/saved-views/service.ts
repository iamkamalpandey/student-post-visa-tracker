// SavedView service. Per-user (user_id == sub) plus tenant-shared (is_shared = true, user_id null).
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { Forbidden, NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateSavedViewRequest,
  UpdateSavedViewRequest,
  SavedViewListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

interface AuthCtx { db?: DB; user?: { tid: string; sub: string; role: string } }

export const savedViewService = {
  async create(req: AuthCtx, body: CreateSavedViewRequest) {
    const created = await db(req).savedView.create({
      data: {
        ...body,
        tenant_id: req.user!.tid,
        // Shared views are tenant-wide (user_id null); personal views are owned by the caller.
        user_id: body.is_shared ? null : req.user!.sub,
      } as never,
    });
    await writeAudit(req as never, {
      action: 'saved_view.created',
      entityType: 'saved_view',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: AuthCtx, q: SavedViewListQuery) {
    return db(req).savedView.findMany({
      where: {
        tenant_id: req.user!.tid,
        OR: [{ user_id: req.user!.sub }, { is_shared: true }],
        ...(q.resource ? { resource: q.resource } : {}),
      },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: AuthCtx, id: string) {
    const found = await db(req).savedView.findFirst({
      where: {
        id,
        tenant_id: req.user!.tid,
        OR: [{ user_id: req.user!.sub }, { is_shared: true }],
      },
    });
    if (!found) throw NotFound('Saved view not found');
    return found;
  },
  async update(
    req: AuthCtx,
    id: string,
    body: UpdateSavedViewRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — _opts.expected accepted for API parity with
    // versioned modules; SavedView has no `version` column (no-op).
    const existing = await this.get(req, id);
    // Only the owner — or any admin — may modify a saved view.
    if (existing.user_id && existing.user_id !== req.user!.sub && req.user!.role !== 'ADMIN') {
      throw Forbidden('Cannot modify another user’s saved view');
    }
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).savedView.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: body as never,
    });
    if (r.count !== 1) throw NotFound('Saved view not found');
    const after = await db(req).savedView.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'saved_view.updated',
      entityType: 'saved_view',
      entityId: id,
      before: existing,
      after,
    });
    return after;
  },
  async remove(req: AuthCtx, id: string) {
    const existing = await this.get(req, id);
    if (existing.user_id && existing.user_id !== req.user!.sub && req.user!.role !== 'ADMIN') {
      throw Forbidden('Cannot delete another user’s saved view');
    }
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).savedView.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Saved view not found');
    await writeAudit(req as never, {
      action: 'saved_view.deleted',
      entityType: 'saved_view',
      entityId: id,
      before: existing,
    });
  },
};
