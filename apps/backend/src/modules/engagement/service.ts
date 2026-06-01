// EngagementCheck service. Hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateEngagementRequest,
  UpdateEngagementRequest,
  EngagementListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

function toData(input: Partial<CreateEngagementRequest>) {
  const { check_date, ...rest } = input as Record<string, unknown> & { check_date?: string | null };
  const out: Record<string, unknown> = { ...rest };
  if (check_date !== undefined) out['check_date'] = toDate(check_date);
  return out;
}

export const engagementService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateEngagementRequest) {
    const created = await db(req).engagementCheck.create({
      data: { ...toData(body), student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.engagement.created',
      entityType: 'engagement_check',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: EngagementListQuery) {
    return db(req).engagementCheck.findMany({
      where: { student_id: studentId, tenant_id: req.user!.tid },
      orderBy: { check_date: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).engagementCheck.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Engagement check not found');
    return found;
  },
  async update(req: { db?: DB; user?: { tid: string } }, id: string, body: UpdateEngagementRequest, _opts?: { expected?: number }) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).engagementCheck.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: toData(body) as never,
    });
    if (r.count !== 1) throw NotFound('Engagement check not found');
    const after = await db(req).engagementCheck.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.engagement.updated',
      entityType: 'engagement_check',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).engagementCheck.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Engagement check not found');
    await writeAudit(req as never, {
      action: 'student.engagement.deleted',
      entityType: 'engagement_check',
      entityId: id,
      before,
    });
  },
};
