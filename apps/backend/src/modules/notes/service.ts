// Note service. Soft-deletes via deleted_at.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { Forbidden, NotFound, PreconditionFailed } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { assertVersion } from '../../shared/ifMatch.js';
import type { CreateNoteRequest, UpdateNoteRequest, NoteListQuery } from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

export const noteService = {
  async create(req: { db?: DB; user?: { tid: string; sub: string } }, body: CreateNoteRequest) {
    const created = await db(req).note.create({
      data: { ...body, tenant_id: req.user!.tid, created_by_id: req.user!.sub } as never,
    });
    await writeAudit(req as never, {
      action: 'note.created',
      entityType: 'note',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, q: NoteListQuery) {
    return db(req).note.findMany({
      where: {
        tenant_id: req.user!.tid,
        entity_type: q.entity_type,
        entity_id: q.entity_id,
        deleted_at: null,
      },
      orderBy: [{ is_pinned: 'desc' }, { created_at: 'desc' }],
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).note.findFirst({ where: { id, tenant_id: req.user!.tid, deleted_at: null } });
    if (!found) throw NotFound('Note not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string; sub: string; role?: string } },
    id: string,
    body: UpdateNoteRequest,
    opts?: { expected?: number },
  ) {
    const before = await this.get(req, id) as { created_by_id: string | null; version?: number };
    // SVT-AUDIT-SEC-2026-05 — non-admin authors can only edit their own
    // notes. Without this, a COUNSELLOR could tamper with another
    // counsellor's audit-relevant note text. ADMIN bypasses.
    if (req.user?.role !== 'ADMIN' && before.created_by_id !== req.user?.sub) {
      throw Forbidden('Not authorised to edit this note');
    }
    // SVT-IFMATCH-2026-05 — optimistic-concurrency guard. When client sends
    // If-Match, version must equal the loaded `before` row; the updateMany
    // below also gates on version=expected so the race window is closed.
    if (opts?.expected !== undefined && before.version !== undefined) {
      assertVersion(before.version, opts.expected);
    }
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const where: Record<string, unknown> = { id, tenant_id: req.user!.tid, deleted_at: null };
    if (opts?.expected !== undefined) where['version'] = opts.expected;
    const r = await db(req).note.updateMany({
      where: where as never,
      data: { ...body, updated_by_id: req.user!.sub } as never,
    });
    if (r.count !== 1) {
      if (opts?.expected !== undefined) {
        throw PreconditionFailed('Note was modified by another request; reload and retry.');
      }
      throw NotFound('Note not found');
    }
    const after = await db(req).note.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'note.updated',
      entityType: 'note',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string; sub: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).note.updateMany({
      where: { id, tenant_id: req.user!.tid, deleted_at: null },
      data: { deleted_at: new Date(), updated_by_id: req.user!.sub } as never,
    });
    if (r.count !== 1) throw NotFound('Note not found');
    await writeAudit(req as never, {
      action: 'note.deleted',
      entityType: 'note',
      entityId: id,
      before,
    });
  },
};
