// AcademicQualification service. Hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateQualificationRequest,
  UpdateQualificationRequest,
  QualificationListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

function toData(input: Partial<CreateQualificationRequest>) {
  const { started_on, completed_on, ...rest } = input as Record<string, unknown> & {
    started_on?: string | null;
    completed_on?: string | null;
  };
  const out: Record<string, unknown> = { ...rest };
  if (started_on !== undefined) out['started_on'] = toDate(started_on);
  if (completed_on !== undefined) out['completed_on'] = toDate(completed_on);
  return out;
}

export const qualificationService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateQualificationRequest) {
    const created = await db(req).academicQualification.create({
      data: { ...toData(body), student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.qualification.created',
      entityType: 'academic_qualification',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: QualificationListQuery) {
    return db(req).academicQualification.findMany({
      where: {
        student_id: studentId,
        tenant_id: req.user!.tid,
        ...(q.level ? { level: q.level } : {}),
      },
      orderBy: { completed_on: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).academicQualification.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Qualification not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateQualificationRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — no `version` column on academic_qualification, so
    // the If-Match header is accepted but cannot be enforced here. Kept in the
    // signature for API symmetry with notes/* and forward-compat.
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).academicQualification.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: toData(body) as never,
    });
    if (r.count !== 1) throw NotFound('Qualification not found');
    const after = await db(req).academicQualification.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.qualification.updated',
      entityType: 'academic_qualification',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).academicQualification.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Qualification not found');
    await writeAudit(req as never, {
      action: 'student.qualification.deleted',
      entityType: 'academic_qualification',
      entityId: id,
      before,
    });
  },
};
