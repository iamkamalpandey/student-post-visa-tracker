// InsuranceRecord service. Encrypts policy_number_enc; hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { encryptField } from '../../shared/encryption.js';
import { writeAudit } from '../../shared/audit.js';
import { logger } from '../../config/logger.js';
import type {
  CreateInsuranceRequest,
  UpdateInsuranceRequest,
  InsuranceListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

// SVT-SYNC-2026-06 — A7: dismiss stale "insurance expiry" reminders when
// an insurance record is deleted. Best-effort.
async function dismissInsuranceReminders(client: DB, tenantId: string, recordId: string): Promise<void> {
  try {
    const result = await (client as PrismaClient).reminder.updateMany({
      where: {
        tenant_id: tenantId,
        source_entity_type: 'insurance_record',
        source_entity_id: recordId,
        status: { in: ['PENDING', 'SENT', 'SNOOZED'] },
      },
      data: { status: 'DISMISSED' },
    });
    if (result.count > 0) {
      logger.info({ tenantId, recordId, dismissed: result.count }, 'auto-dismissed insurance expiry reminders');
    }
  } catch (err) {
    logger.warn({ err, tenantId, recordId }, 'dismissInsuranceReminders: best-effort failed');
  }
}

// Strip encrypted columns from audit payloads to avoid double-encryption.
function stripEnc<T extends Record<string, unknown>>(row: T | null | undefined): Omit<T, 'policy_number_enc'> | null {
  if (!row) return null;
  const { policy_number_enc: _omit, ...rest } = row as T & { policy_number_enc?: unknown };
  return rest;
}

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

// Default projection for list/get: every column EXCEPT policy_number_enc.
// Ciphertext never leaves the API by default — clients that need plaintext
// go through the dedicated decrypt() controller path.
const SAFE_SELECT = {
  id: true,
  tenant_id: true,
  student_id: true,
  provider: true,
  coverage_type: true,
  starts_on: true,
  ends_on: true,
  premium_minor: true,
  premium_currency: true,
  created_at: true,
} as const;

async function toData(input: Partial<CreateInsuranceRequest>) {
  const { policy_number, premium_minor, starts_on, ends_on, ...rest } = input as Record<string, unknown> & {
    policy_number?: string;
    premium_minor?: number | string;
    starts_on?: string | null;
    ends_on?: string | null;
  };
  const out: Record<string, unknown> = { ...rest };
  if (policy_number !== undefined) out['policy_number_enc'] = await encryptField(policy_number);
  if (premium_minor !== undefined) out['premium_minor'] = BigInt(premium_minor as string | number);
  if (starts_on !== undefined) out['starts_on'] = toDate(starts_on);
  if (ends_on !== undefined) out['ends_on'] = toDate(ends_on);
  return out;
}

export const insuranceService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateInsuranceRequest) {
    const data = await toData(body);
    const created = await db(req).insuranceRecord.create({
      data: { ...(data as object), student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.insurance.created',
      entityType: 'insurance_record',
      entityId: created.id,
      after: stripEnc(created as Record<string, unknown>),
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: InsuranceListQuery) {
    return db(req).insuranceRecord.findMany({
      where: { student_id: studentId, tenant_id: req.user!.tid },
      orderBy: { ends_on: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: SAFE_SELECT,
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).insuranceRecord.findFirst({
      where: { id, tenant_id: req.user!.tid },
      select: SAFE_SELECT,
    });
    if (!found) throw NotFound('Insurance record not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateInsuranceRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — InsuranceRecord has no `version` column in
    // schema.prisma, so optimistic-concurrency cannot be enforced here.
    // We accept the opt arg for signature parity with versioned services
    // and so the controller can pass `readIfMatch(req)` unconditionally.
    void _opts;
    const before = await this.get(req, id);
    const data = await toData(body);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).insuranceRecord.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: data as never,
    });
    if (r.count !== 1) throw NotFound('Insurance record not found');
    const after = await db(req).insuranceRecord.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.insurance.updated',
      entityType: 'insurance_record',
      entityId: id,
      before: stripEnc(before as Record<string, unknown>),
      after: stripEnc(after as Record<string, unknown>),
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).insuranceRecord.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Insurance record not found');
    // SVT-SYNC-2026-06 — A7: deleted insurance → dismiss its expiry reminders.
    await dismissInsuranceReminders(db(req), req.user!.tid, id);
    await writeAudit(req as never, {
      action: 'student.insurance.deleted',
      entityType: 'insurance_record',
      entityId: id,
      before: stripEnc(before as Record<string, unknown>),
    });
  },
};
