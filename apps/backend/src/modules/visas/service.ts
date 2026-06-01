// StudentVisa service. Encrypts visa_number_enc; hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound, PreconditionFailed } from '../../shared/errors.js';
import { encryptField } from '../../shared/encryption.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateVisaRequest,
  UpdateVisaRequest,
  VisaListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

// ---------------------------------------------------------------------------
// SVT-FSM-2026-05: Active-visa mutex helper. When a row is being flipped to
// is_active=true, deactivate every sibling row (same student) that is
// currently active. Run inside the same transaction as the new write so the
// pair commits atomically. The DB-side partial unique idx
// (idx_student_visas_active_unique) is the backstop if a race squeaks past.
// ---------------------------------------------------------------------------
type TxLike = Prisma.TransactionClient;

async function deactivateSiblingActiveVisas(
  tx: TxLike,
  args: { tenantId: string; studentId: string; keepVisaId: string; actorId: string | null },
): Promise<string[]> {
  const siblings = await tx.studentVisa.findMany({
    where: {
      tenant_id: args.tenantId,
      student_id: args.studentId,
      is_active: true,
      id: { not: args.keepVisaId },
    },
    select: { id: true },
  });
  if (siblings.length === 0) return [];
  await tx.studentVisa.updateMany({
    where: {
      tenant_id: args.tenantId,
      student_id: args.studentId,
      is_active: true,
      id: { not: args.keepVisaId },
    },
    data: { is_active: false },
  });
  return siblings.map((s) => s.id);
}

// Strip encrypted columns from audit payloads to avoid double-encryption.
function stripEnc<T extends Record<string, unknown>>(row: T | null | undefined): Omit<T, 'visa_number_enc'> | null {
  if (!row) return null;
  const { visa_number_enc: _omit, ...rest } = row as T & { visa_number_enc?: unknown };
  return rest;
}

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

// Default projection for list/get: every column EXCEPT visa_number_enc.
// Ciphertext must never leave the API by accident — clients that need the
// plaintext go through the dedicated decrypt() controller path.
const SAFE_SELECT = {
  id: true,
  tenant_id: true,
  student_id: true,
  visa_category_id: true,
  destination_country: true,
  issuing_post: true,
  issued_on: true,
  expires_on: true,
  entries: true,
  conditions: true,
  is_active: true,
  // SVT-OCC-2026-05: surface `version` so clients can echo it back via
  // If-Match on the next PATCH for optimistic-concurrency.
  version: true,
  created_at: true,
  updated_at: true,
} as const;

async function toData(input: Partial<CreateVisaRequest>) {
  const { visa_number, issued_on, expires_on, ...rest } = input as Record<string, unknown> & {
    visa_number?: string;
    issued_on?: string | null;
    expires_on?: string | null;
  };
  const out: Record<string, unknown> = { ...rest };
  if (visa_number !== undefined) out['visa_number_enc'] = await encryptField(visa_number);
  if (issued_on !== undefined) out['issued_on'] = toDate(issued_on);
  if (expires_on !== undefined) out['expires_on'] = toDate(expires_on);
  return out;
}

export const visaService = {
  async create(
    req: { db?: DB; user?: { tid: string; sub?: string } },
    studentId: string,
    body: CreateVisaRequest,
  ) {
    const data = await toData(body);
    const tenantId = req.user!.tid;
    // SVT-FSM-2026-05: when the new row will be is_active=true, deactivate any
    // sibling active visa(s) atomically. Default in the schema is is_active=true,
    // so treat undefined as true.
    const willBeActive = (data['is_active'] as boolean | undefined) !== false;

    const client = db(req) as PrismaClient;
    const { created, deactivatedIds } = await client.$transaction(async (tx) => {
      const row = await tx.studentVisa.create({
        data: { ...data, student_id: studentId, tenant_id: tenantId } as never,
      });
      const deactivated = willBeActive
        ? await deactivateSiblingActiveVisas(tx, {
            tenantId,
            studentId,
            keepVisaId: row.id,
            actorId: req.user?.sub ?? null,
          })
        : [];
      return { created: row, deactivatedIds: deactivated };
    });

    await writeAudit(req as never, {
      action: 'student.visa.created',
      entityType: 'student_visa',
      entityId: created.id,
      after: stripEnc(created as Record<string, unknown>),
    });
    // SVT-FSM-2026-05: emit one audit row per auto-deactivated sibling so the
    // chain explains why their is_active flipped without an explicit user request.
    for (const oldId of deactivatedIds) {
      await writeAudit(req as never, {
        action: 'visa.auto_deactivated_due_to_new_active',
        entityType: 'student_visa',
        entityId: oldId,
        after: { reason: 'new_active_visa', new_visa_id: created.id, student_id: studentId },
      });
    }
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: VisaListQuery) {
    return db(req).studentVisa.findMany({
      where: {
        student_id: studentId,
        tenant_id: req.user!.tid,
        ...(q.is_active !== undefined ? { is_active: q.is_active } : {}),
      },
      orderBy: { expires_on: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: SAFE_SELECT,
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).studentVisa.findFirst({
      where: { id, tenant_id: req.user!.tid },
      select: SAFE_SELECT,
    });
    if (!found) throw NotFound('Visa not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string; sub?: string } },
    id: string,
    body: UpdateVisaRequest,
    expected?: number,
  ) {
    const before = await this.get(req, id);
    const data = await toData(body);
    const tenantId = req.user!.tid;

    // SVT-OCC-2026-05: optional optimistic-concurrency check. When the
    // controller passed an `expected` version (parsed from If-Match), fast-fail
    // here if the row already moved on. The atomic guard inside the
    // transaction (where.version=expected) is the second line of defence
    // against a TOCTOU race between this read and the UPDATE.
    if (expected !== undefined && (before as { version: number }).version !== expected) {
      throw PreconditionFailed('Record was modified by another request; reload and retry.');
    }

    // SVT-FSM-2026-05: enforce the active-visa mutex when this PATCH flips
    // is_active to true. Read-modify-write happens in one transaction so the
    // sibling deactivation lands with the same commit boundary.
    const flippingToActive = data['is_active'] === true && (before as { is_active?: boolean }).is_active !== true;

    const client = db(req) as PrismaClient;
    const { after, deactivatedIds } = await client.$transaction(async (tx) => {
      // SVT-OCC-2026-05: bump version every PATCH so the next If-Match check
      // can detect downstream concurrent writers.
      const writeData = { ...data, version: { increment: 1 } } as Prisma.StudentVisaUncheckedUpdateInput;
      // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
      const where: Prisma.StudentVisaWhereInput = { id, tenant_id: tenantId };
      if (expected !== undefined) where.version = expected;
      const r = await tx.studentVisa.updateMany({
        where,
        data: writeData,
      });
      if (r.count !== 1) {
        if (expected !== undefined) {
          // Re-read to differentiate "version moved" (412) from "row gone" (404).
          const stillThere = await tx.studentVisa.findFirst({
            where: { id, tenant_id: tenantId },
            select: { id: true },
          });
          if (stillThere) {
            throw PreconditionFailed('Record was modified by another request; reload and retry.');
          }
        }
        throw NotFound('Visa not found');
      }
      const fresh = await tx.studentVisa.findFirstOrThrow({
        where: { id, tenant_id: tenantId },
      });
      const studentId = (fresh as { student_id: string }).student_id;
      const deactivated = flippingToActive
        ? await deactivateSiblingActiveVisas(tx, {
            tenantId,
            studentId,
            keepVisaId: id,
            actorId: req.user?.sub ?? null,
          })
        : [];
      return { after: fresh, deactivatedIds: deactivated };
    });

    await writeAudit(req as never, {
      action: 'student.visa.updated',
      entityType: 'student_visa',
      entityId: id,
      before: stripEnc(before as Record<string, unknown>),
      after: stripEnc(after as Record<string, unknown>),
    });
    for (const oldId of deactivatedIds) {
      await writeAudit(req as never, {
        action: 'visa.auto_deactivated_due_to_new_active',
        entityType: 'student_visa',
        entityId: oldId,
        after: {
          reason: 'new_active_visa',
          new_visa_id: id,
          student_id: (after as { student_id: string }).student_id,
        },
      });
    }
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentVisa.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Visa not found');
    await writeAudit(req as never, {
      action: 'student.visa.deleted',
      entityType: 'student_visa',
      entityId: id,
      before: stripEnc(before as Record<string, unknown>),
    });
  },
};
