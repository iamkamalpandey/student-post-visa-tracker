// StudentDependent service. Encrypts passport_number_enc; hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { encryptField } from '../../shared/encryption.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateDependentRequest,
  UpdateDependentRequest,
  DependentListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

// Strip encrypted columns from audit payloads to avoid double-encryption.
function stripEnc<T extends Record<string, unknown>>(row: T | null | undefined): Omit<T, 'passport_number_enc'> | null {
  if (!row) return null;
  const { passport_number_enc: _omit, ...rest } = row as T & { passport_number_enc?: unknown };
  return rest;
}

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

// Default projection for list/get: every column EXCEPT passport_number_enc.
// Ciphertext never leaves the API by default — clients that need plaintext
// go through the dedicated decrypt() controller path.
const SAFE_SELECT = {
  id: true,
  tenant_id: true,
  student_id: true,
  relationship_id: true,
  given_name: true,
  family_name: true,
  date_of_birth: true,
  nationality_code: true,
  visa_status: true,
  accompanies_principal: true,
  notes: true,
} as const;

async function toData(input: Partial<CreateDependentRequest>) {
  const { passport_number, date_of_birth, ...rest } = input as Record<string, unknown> & {
    passport_number?: string;
    date_of_birth?: string | null;
  };
  const out: Record<string, unknown> = { ...rest };
  if (passport_number !== undefined) out['passport_number_enc'] = await encryptField(passport_number);
  if (date_of_birth !== undefined) out['date_of_birth'] = toDate(date_of_birth);
  return out;
}

export const dependentService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateDependentRequest) {
    const data = await toData(body);
    const created = await db(req).studentDependent.create({
      data: { ...data, student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.dependent.created',
      entityType: 'student_dependent',
      entityId: created.id,
      after: stripEnc(created as Record<string, unknown>),
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: DependentListQuery) {
    return db(req).studentDependent.findMany({
      where: { student_id: studentId, tenant_id: req.user!.tid },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: SAFE_SELECT,
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).studentDependent.findFirst({
      where: { id, tenant_id: req.user!.tid },
      select: SAFE_SELECT,
    });
    if (!found) throw NotFound('Dependent not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateDependentRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — no `version` column on student_dependent, so the
    // If-Match header is accepted but cannot be enforced here. Kept in the
    // signature for API symmetry with notes/* and forward-compat.
    const before = await this.get(req, id);
    const data = await toData(body);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentDependent.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: data as never,
    });
    if (r.count !== 1) throw NotFound('Dependent not found');
    const after = await db(req).studentDependent.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.dependent.updated',
      entityType: 'student_dependent',
      entityId: id,
      before: stripEnc(before as Record<string, unknown>),
      after: stripEnc(after as Record<string, unknown>),
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentDependent.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Dependent not found');
    await writeAudit(req as never, {
      action: 'student.dependent.deleted',
      entityType: 'student_dependent',
      entityId: id,
      before: stripEnc(before as Record<string, unknown>),
    });
  },
};
