// StudentEmployment service. Hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateEmploymentRequest,
  UpdateEmploymentRequest,
  EmploymentListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

function toData(input: Partial<CreateEmploymentRequest>) {
  const { started_on, ended_on, ...rest } = input as Record<string, unknown> & {
    started_on?: string | null;
    ended_on?: string | null;
  };
  const out: Record<string, unknown> = { ...rest };
  if (started_on !== undefined) out['started_on'] = toDate(started_on);
  if (ended_on !== undefined) out['ended_on'] = toDate(ended_on);
  return out;
}

export const employmentService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateEmploymentRequest) {
    const created = await db(req).studentEmployment.create({
      data: { ...toData(body), student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.employment.created',
      entityType: 'student_employment',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: EmploymentListQuery) {
    return db(req).studentEmployment.findMany({
      where: { student_id: studentId, tenant_id: req.user!.tid },
      orderBy: { started_on: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).studentEmployment.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Employment record not found');
    return found;
  },
  async update(req: { db?: DB; user?: { tid: string } }, id: string, body: UpdateEmploymentRequest, _opts?: { expected?: number }) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentEmployment.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: toData(body) as never,
    });
    if (r.count !== 1) throw NotFound('Employment record not found');
    const after = await db(req).studentEmployment.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.employment.updated',
      entityType: 'student_employment',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentEmployment.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Employment record not found');
    await writeAudit(req as never, {
      action: 'student.employment.deleted',
      entityType: 'student_employment',
      entityId: id,
      before,
    });
  },
};
