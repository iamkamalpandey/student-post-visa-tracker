// ComplianceCheck service. Hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateComplianceRequest,
  UpdateComplianceRequest,
  ComplianceListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

function toData(input: Partial<CreateComplianceRequest>) {
  const { scheduled_at, completed_at, expires_on, ...rest } = input as Record<string, unknown> & {
    scheduled_at?: string | null;
    completed_at?: string | null;
    expires_on?: string | null;
  };
  const out: Record<string, unknown> = { ...rest };
  if (scheduled_at !== undefined) out['scheduled_at'] = toDate(scheduled_at);
  if (completed_at !== undefined) out['completed_at'] = toDate(completed_at);
  if (expires_on !== undefined) out['expires_on'] = toDate(expires_on);
  return out;
}

export const complianceService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateComplianceRequest) {
    const created = await db(req).complianceCheck.create({
      data: { ...toData(body), student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.compliance.created',
      entityType: 'compliance_check',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: ComplianceListQuery) {
    return db(req).complianceCheck.findMany({
      where: {
        student_id: studentId,
        tenant_id: req.user!.tid,
        ...(q.check_type ? { check_type: q.check_type } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).complianceCheck.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Compliance check not found');
    return found;
  },
  async update(req: { db?: DB; user?: { tid: string } }, id: string, body: UpdateComplianceRequest, _opts?: { expected?: number }) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).complianceCheck.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: toData(body) as never,
    });
    if (r.count !== 1) throw NotFound('Compliance check not found');
    const after = await db(req).complianceCheck.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.compliance.updated',
      entityType: 'compliance_check',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).complianceCheck.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Compliance check not found');
    await writeAudit(req as never, {
      action: 'student.compliance.deleted',
      entityType: 'compliance_check',
      entityId: id,
      before,
    });
  },
};
