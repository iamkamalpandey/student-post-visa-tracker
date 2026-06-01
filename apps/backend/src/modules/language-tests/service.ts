// LanguageTestResult service. Hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateLanguageTestRequest,
  UpdateLanguageTestRequest,
  LanguageTestListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

function toData(input: Partial<CreateLanguageTestRequest>) {
  const { test_date, expires_on, ...rest } = input as Record<string, unknown> & {
    test_date?: string | null;
    expires_on?: string | null;
  };
  const out: Record<string, unknown> = { ...rest };
  if (test_date !== undefined) out['test_date'] = toDate(test_date);
  if (expires_on !== undefined) out['expires_on'] = toDate(expires_on);
  return out;
}

export const languageTestService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateLanguageTestRequest) {
    const created = await db(req).languageTestResult.create({
      data: { ...toData(body), student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.language_test.created',
      entityType: 'language_test_result',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: LanguageTestListQuery) {
    return db(req).languageTestResult.findMany({
      where: {
        student_id: studentId,
        tenant_id: req.user!.tid,
        ...(q.test_type ? { test_type: q.test_type } : {}),
      },
      orderBy: { test_date: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).languageTestResult.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Language test not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateLanguageTestRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — no `version` column on language_test_result, so
    // the If-Match header is accepted but cannot be enforced here. Kept in the
    // signature for API symmetry with notes/* and forward-compat.
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).languageTestResult.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: toData(body) as never,
    });
    if (r.count !== 1) throw NotFound('Language test not found');
    const after = await db(req).languageTestResult.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.language_test.updated',
      entityType: 'language_test_result',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).languageTestResult.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Language test not found');
    await writeAudit(req as never, {
      action: 'student.language_test.deleted',
      entityType: 'language_test_result',
      entityId: id,
      before,
    });
  },
};
