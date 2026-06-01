// StudentRegulatorIdentifier service. Encrypts value_enc; hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { encryptField } from '../../shared/encryption.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateRegulatorIdRequest,
  UpdateRegulatorIdRequest,
  RegulatorIdListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

// Strip encrypted columns from audit payloads to avoid double-encryption.
function stripEnc<T extends Record<string, unknown>>(row: T | null | undefined): Omit<T, 'value_enc'> | null {
  if (!row) return null;
  const { value_enc: _omit, ...rest } = row as T & { value_enc?: unknown };
  return rest;
}

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

// Default projection for list/get: every column EXCEPT value_enc.
// Ciphertext never leaves the API by default — clients that need plaintext
// go through the dedicated decrypt() controller path.
const SAFE_SELECT = {
  id: true,
  tenant_id: true,
  student_id: true,
  scheme: true,
  issued_on: true,
  expires_on: true,
  status: true,
  notes: true,
  created_at: true,
} as const;

async function toData(input: Partial<CreateRegulatorIdRequest>) {
  const { value, issued_on, expires_on, ...rest } = input as Record<string, unknown> & {
    value?: string;
    issued_on?: string | null;
    expires_on?: string | null;
  };
  const out: Record<string, unknown> = { ...rest };
  if (value !== undefined) out['value_enc'] = await encryptField(value);
  if (issued_on !== undefined) out['issued_on'] = toDate(issued_on);
  if (expires_on !== undefined) out['expires_on'] = toDate(expires_on);
  return out;
}

export const regulatorIdService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateRegulatorIdRequest) {
    const data = await toData(body);
    const created = await db(req).studentRegulatorIdentifier.create({
      data: { ...data, student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.regulator_id.created',
      entityType: 'student_regulator_identifier',
      entityId: created.id,
      after: stripEnc(created as Record<string, unknown>),
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: RegulatorIdListQuery) {
    return db(req).studentRegulatorIdentifier.findMany({
      where: {
        student_id: studentId,
        tenant_id: req.user!.tid,
        ...(q.scheme ? { scheme: q.scheme } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: SAFE_SELECT,
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).studentRegulatorIdentifier.findFirst({
      where: { id, tenant_id: req.user!.tid },
      select: SAFE_SELECT,
    });
    if (!found) throw NotFound('Regulator identifier not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateRegulatorIdRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — no `version` column on
    // student_regulator_identifier, so the If-Match header is accepted but
    // cannot be enforced here. Kept in the signature for API symmetry with
    // notes/* and forward-compat.
    const before = await this.get(req, id);
    const data = await toData(body);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentRegulatorIdentifier.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: data as never,
    });
    if (r.count !== 1) throw NotFound('Regulator identifier not found');
    const after = await db(req).studentRegulatorIdentifier.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.regulator_id.updated',
      entityType: 'student_regulator_identifier',
      entityId: id,
      before: stripEnc(before as Record<string, unknown>),
      after: stripEnc(after as Record<string, unknown>),
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentRegulatorIdentifier.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Regulator identifier not found');
    await writeAudit(req as never, {
      action: 'student.regulator_id.deleted',
      entityType: 'student_regulator_identifier',
      entityId: id,
      before: stripEnc(before as Record<string, unknown>),
    });
  },
};
