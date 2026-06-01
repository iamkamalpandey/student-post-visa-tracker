// StudentIdentification service. Encrypts document_number_enc; hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { encryptField } from '../../shared/encryption.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateIdentificationRequest,
  UpdateIdentificationRequest,
  IdentificationListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

// Strip encrypted columns from audit payloads to avoid double-encryption.
function stripEnc<T extends Record<string, unknown>>(row: T | null | undefined): Omit<T, 'document_number_enc'> | null {
  if (!row) return null;
  const { document_number_enc: _omit, ...rest } = row as T & { document_number_enc?: unknown };
  return rest;
}

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

// Default projection for list/get: every column EXCEPT document_number_enc.
// Ciphertext never leaves the API by default — clients that need plaintext
// go through the dedicated decrypt() controller path.
const SAFE_SELECT = {
  id: true,
  tenant_id: true,
  student_id: true,
  type: true,
  issuing_country: true,
  issued_on: true,
  expires_on: true,
  is_primary: true,
  created_at: true,
  updated_at: true,
} as const;

async function toData(input: Partial<CreateIdentificationRequest>) {
  const { document_number, issued_on, expires_on, ...rest } = input as Record<string, unknown> & {
    document_number?: string;
    issued_on?: string | null;
    expires_on?: string | null;
  };
  const out: Record<string, unknown> = { ...rest };
  if (document_number !== undefined) out['document_number_enc'] = await encryptField(document_number);
  if (issued_on !== undefined) out['issued_on'] = toDate(issued_on);
  if (expires_on !== undefined) out['expires_on'] = toDate(expires_on);
  return out;
}

export const identificationService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateIdentificationRequest) {
    const data = await toData(body);
    const created = await db(req).studentIdentification.create({
      data: { ...data, student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.identification.created',
      entityType: 'student_identification',
      entityId: created.id,
      after: stripEnc(created as Record<string, unknown>),
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: IdentificationListQuery) {
    return db(req).studentIdentification.findMany({
      where: {
        student_id: studentId,
        tenant_id: req.user!.tid,
        ...(q.type ? { type: q.type } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: SAFE_SELECT,
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).studentIdentification.findFirst({
      where: { id, tenant_id: req.user!.tid },
      select: SAFE_SELECT,
    });
    if (!found) throw NotFound('Identification not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateIdentificationRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — no `version` column on student_identification, so
    // the If-Match header is accepted but cannot be enforced here. Kept in the
    // signature for API symmetry with notes/* and forward-compat.
    const before = await this.get(req, id);
    const data = await toData(body);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentIdentification.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: data as never,
    });
    if (r.count !== 1) throw NotFound('Identification not found');
    const after = await db(req).studentIdentification.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.identification.updated',
      entityType: 'student_identification',
      entityId: id,
      before: stripEnc(before as Record<string, unknown>),
      after: stripEnc(after as Record<string, unknown>),
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentIdentification.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Identification not found');
    await writeAudit(req as never, {
      action: 'student.identification.deleted',
      entityType: 'student_identification',
      entityId: id,
      before: stripEnc(before as Record<string, unknown>),
    });
  },
};
