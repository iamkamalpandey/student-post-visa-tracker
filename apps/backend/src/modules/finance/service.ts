// FinanceItem service. Hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateFinanceRequest,
  UpdateFinanceRequest,
  FinanceListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

function toData(input: Partial<CreateFinanceRequest>) {
  const { amount_minor, due_on, paid_on, ...rest } = input as Record<string, unknown> & {
    amount_minor?: number | string;
    due_on?: string | null;
    paid_on?: string | null;
  };
  return {
    ...rest,
    ...(amount_minor !== undefined ? { amount_minor: BigInt(amount_minor as string | number) } : {}),
    ...(due_on !== undefined ? { due_on: toDate(due_on) } : {}),
    ...(paid_on !== undefined ? { paid_on: toDate(paid_on) } : {}),
  };
}

export const financeService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateFinanceRequest) {
    const created = await db(req).financeItem.create({
      data: { ...toData(body), student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.finance.created',
      entityType: 'finance_item',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: FinanceListQuery) {
    return db(req).financeItem.findMany({
      where: {
        student_id: studentId,
        tenant_id: req.user!.tid,
        ...(q.status ? { status: q.status } : {}),
        ...(q.category ? { category: q.category } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).financeItem.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Finance item not found');
    return found;
  },
  async update(req: { db?: DB; user?: { tid: string } }, id: string, body: UpdateFinanceRequest, _opts?: { expected?: number }) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).financeItem.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: toData(body) as never,
    });
    if (r.count !== 1) throw NotFound('Finance item not found');
    const after = await db(req).financeItem.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.finance.updated',
      entityType: 'finance_item',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).financeItem.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Finance item not found');
    await writeAudit(req as never, {
      action: 'student.finance.deleted',
      entityType: 'finance_item',
      entityId: id,
      before,
    });
  },
};
