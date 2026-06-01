// SubProcessor service. Admin-only at the route layer.
//
// SVT-WAVE-PRIV-C2-2026-05 — Art. 30(2) requires a *historical* register of
// processors. The previous hard-delete path destroyed regulator evidence; the
// service now soft-deletes by stamping `removed_at` and excludes removed rows
// from the default list. `include_removed=true` opt-in returns the full
// history (ADMIN-only via the route gate) so /admin/ropa.csv can render the
// removed entries with their removal dates.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateSubProcessorRequest,
  UpdateSubProcessorRequest,
  SubProcessorListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

// Extra query field that the controller forwards opaquely; not part of the
// zod schema (which is `.strict()` on the validated body shape). We read it
// off the raw query object as a defensive cast — anything but the literal
// boolean string is treated as false.
type ListOpts = SubProcessorListQuery & { include_removed?: unknown };

function wantsRemoved(q: ListOpts | undefined): boolean {
  if (!q) return false;
  const v: unknown = q.include_removed;
  return v === true || v === 'true' || v === '1';
}

export const subProcessorService = {
  async create(req: { db?: DB; user?: { tid: string } }, body: CreateSubProcessorRequest) {
    const created = await db(req).subProcessor.create({ data: { ...body, tenant_id: req.user!.tid } as never });
    await writeAudit(req as never, {
      action: 'sub_processor.created',
      entityType: 'sub_processor',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, q: ListOpts) {
    return db(req).subProcessor.findMany({
      where: {
        tenant_id: req.user!.tid,
        // SVT-WAVE-PRIV-C2-2026-05 — default to active processors only so
        // operator UIs don't surface removed entries unless they explicitly
        // opt in. The /admin/ropa.csv writer passes include_removed=true.
        ...(wantsRemoved(q) ? {} : { removed_at: null }),
      },
      orderBy: { added_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).subProcessor.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Sub-processor not found');
    return found;
  },
  // SVT-IFMATCH-2026-05 — SubProcessor has no `version` column;
  // `_opts.expected` accepted-but-ignored for API parity (clients may send
  // If-Match without 412). Promote to OCC once schema has `version`.
  async update(req: { db?: DB; user?: { tid: string } }, id: string, body: UpdateSubProcessorRequest, _opts?: { expected?: number }) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).subProcessor.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: body as never,
    });
    if (r.count !== 1) throw NotFound('Sub-processor not found');
    const after = await db(req).subProcessor.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'sub_processor.updated',
      entityType: 'sub_processor',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  // SVT-WAVE-PRIV-C2-2026-05 — soft-delete only. Hard-delete would discard
  // the Art. 30(2) processor history; instead we stamp `removed_at` so the
  // row survives for ROPA exports. Repeat calls are 404 (the row is no
  // longer "active") which matches the prior contract.
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    if ((before as { removed_at: Date | null }).removed_at != null) {
      throw NotFound('Sub-processor not found');
    }
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    // Filter on removed_at=null so a racing double-delete resolves to
    // count=0 → 404 rather than two audit rows.
    const r = await db(req).subProcessor.updateMany({
      where: { id, tenant_id: req.user!.tid, removed_at: null },
      data: { removed_at: new Date() },
    });
    if (r.count !== 1) throw NotFound('Sub-processor not found');
    await writeAudit(req as never, {
      action: 'sub_processor.removed',
      entityType: 'sub_processor',
      entityId: id,
      before,
    });
  },
};
