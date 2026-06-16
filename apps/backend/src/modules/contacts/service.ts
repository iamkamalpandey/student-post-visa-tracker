// StudentContact service. Encrypts annual_income_minor_enc; hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { encryptField } from '../../shared/encryption.js';
import { writeAudit } from '../../shared/audit.js';
import { logger } from '../../config/logger.js';
import { completeness as computeCompleteness } from '../students/students.service.js';
import type {
  CreateContactRequest,
  UpdateContactRequest,
  ContactListQuery,
} from '@spv/zod-schemas';

// SVT-SYNC-2026-06 — A6: best-effort recompute of parent student's completeness_pct.
// emergency_contact is a completeness key — going 0→1 emergency contacts bumps ~11%.
// We recompute on every contact create/delete (cheap) rather than checking
// is_emergency_contact to avoid missing edge cases (e.g. update flips the flag).
async function recomputeCompleteness(client: DB, tenantId: string, studentId: string): Promise<void> {
  try {
    await computeCompleteness({ db: client as never, tenantId }, studentId);
  } catch (err) {
    logger.warn({ err, studentId }, 'contact.recomputeCompleteness: best-effort failed');
  }
}

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

// Strip encrypted columns from audit payloads to avoid double-encryption.
function stripEnc<T extends Record<string, unknown>>(row: T | null | undefined): Omit<T, 'annual_income_minor_enc'> | null {
  if (!row) return null;
  const { annual_income_minor_enc: _omit, ...rest } = row as T & { annual_income_minor_enc?: unknown };
  return rest;
}

// Default projection for list/get: every column EXCEPT annual_income_minor_enc.
// Ciphertext never leaves the API by default — clients that need plaintext
// go through the dedicated decrypt() controller path.
const SAFE_SELECT = {
  id: true,
  tenant_id: true,
  student_id: true,
  relationship_id: true,
  given_name: true,
  family_name: true,
  phone_e164: true,
  email: true,
  occupation: true,
  employer: true,
  income_currency: true,
  is_primary_guardian: true,
  is_emergency_contact: true,
  is_financial_sponsor: true,
  address_id: true,
  created_at: true,
  updated_at: true,
} as const;

async function toData(input: Partial<CreateContactRequest>) {
  const { annual_income_minor, ...rest } = input as Record<string, unknown> & {
    annual_income_minor?: number | string;
  };
  const out: Record<string, unknown> = { ...rest };
  if (annual_income_minor !== undefined) {
    out['annual_income_minor_enc'] = await encryptField(String(annual_income_minor));
  }
  return out;
}

export const contactService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateContactRequest) {
    const data = await toData(body);
    const created = await db(req).studentContact.create({
      data: { ...data, student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.contact.created',
      entityType: 'student_contact',
      entityId: created.id,
      after: stripEnc(created as Record<string, unknown>),
    });
    // SVT-SYNC-2026-06 — A6: recompute completeness (emergency_contact is a key).
    await recomputeCompleteness(db(req), req.user!.tid, studentId);
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: ContactListQuery) {
    return db(req).studentContact.findMany({
      where: { student_id: studentId, tenant_id: req.user!.tid },
      orderBy: { created_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: SAFE_SELECT,
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).studentContact.findFirst({
      where: { id, tenant_id: req.user!.tid },
      select: SAFE_SELECT,
    });
    if (!found) throw NotFound('Contact not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateContactRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — no `version` column on student_contact, so the
    // If-Match header is accepted but cannot be enforced here. Kept in the
    // signature for API symmetry with notes/* and forward-compat.
    const before = await this.get(req, id);
    const data = await toData(body);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentContact.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: data as never,
    });
    if (r.count !== 1) throw NotFound('Contact not found');
    const after = await db(req).studentContact.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.contact.updated',
      entityType: 'student_contact',
      entityId: id,
      before: stripEnc(before as Record<string, unknown>),
      after: stripEnc(after as Record<string, unknown>),
    });
    // SVT-SYNC-2026-06 — A6: recompute completeness (update can flip is_emergency_contact).
    await recomputeCompleteness(db(req), req.user!.tid, (after as { student_id: string }).student_id);
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentContact.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Contact not found');
    await writeAudit(req as never, {
      action: 'student.contact.deleted',
      entityType: 'student_contact',
      entityId: id,
      before: stripEnc(before as Record<string, unknown>),
    });
    // SVT-SYNC-2026-06 — A6: recompute completeness (deleting last emergency contact drops ~11%).
    await recomputeCompleteness(db(req), req.user!.tid, (before as { student_id: string }).student_id);
  },
};
