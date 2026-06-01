// ConsentRecord service. Admin or self for student subjects.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { Forbidden, NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type { CreateConsentRequest, ConsentListQuery } from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

interface AuthCtx {
  db?: DB;
  user?: { tid: string; sub: string; role: string };
}

// Self-or-admin: ADMIN can act on any subject; non-admins only when subject_id == own user id
// AND subject_type === 'user'. Anything else is rejected.
function assertAuthorised(req: AuthCtx, subjectType: string, subjectId: string) {
  if (req.user?.role === 'ADMIN') return;
  if (subjectType === 'user' && req.user?.sub === subjectId) return;
  throw Forbidden('Only admins or the subject themself may manage this consent');
}

export const consentService = {
  async create(req: AuthCtx, body: CreateConsentRequest) {
    assertAuthorised(req, body.subject_type, body.subject_id);
    const created = await db(req).consentRecord.create({
      data: {
        ...body,
        tenant_id: req.user!.tid,
        ...(body.evidence ? { evidence: body.evidence } : {}),
      } as never,
    });
    await writeAudit(req as never, {
      action: 'consent.created',
      entityType: 'consent_record',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  // SVT-WAVE-PRIV-C4-2026-05 — VIEWER role can only see their own consent
  // rows (subject_type='user' AND subject_id=req.user.sub). Any explicit
  // filter to a different subject is silently coerced back to "self" — we
  // don't leak whether a row exists for the target. ADMIN + COUNSELLOR see
  // every row in the tenant (existing behaviour preserved).
  async list(req: AuthCtx, q: ConsentListQuery) {
    const isViewer = req.user?.role === 'VIEWER';
    const baseWhere: Record<string, unknown> = {
      tenant_id: req.user!.tid,
      ...(q.subject_type ? { subject_type: q.subject_type } : {}),
      ...(q.subject_id ? { subject_id: q.subject_id } : {}),
    };
    if (isViewer) {
      // Force self-only regardless of any subject_id/subject_type query
      // parameters the caller supplied. This is the "tenant-leakage-safe"
      // pattern — we never surface a 403 that confirms a target subject_id
      // exists, we just return their own rows.
      baseWhere['subject_type'] = 'user';
      baseWhere['subject_id'] = req.user!.sub;
    }
    return db(req).consentRecord.findMany({
      where: baseWhere,
      orderBy: { granted_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: AuthCtx, id: string) {
    const found = await db(req).consentRecord.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Consent record not found');
    // SVT-WAVE-PRIV-C4-2026-05 — VIEWER may only fetch their own row. Same
    // 404 (not 403) so existence-probing is blocked.
    if (req.user?.role === 'VIEWER') {
      const row = found as { subject_type: string; subject_id: string };
      if (row.subject_type !== 'user' || row.subject_id !== req.user?.sub) {
        throw NotFound('Consent record not found');
      }
    }
    return found;
  },
  // SVT-CONSENT-2026-05: GDPR Art. 7(3) / UK DPA / India DPDP §6(4) require
  // the right to withdraw consent. Stamps revoked_at; preserves the row for
  // forensic proof of withdrawal date. Idempotent — re-revoking is a no-op.
  async revoke(req: AuthCtx, id: string) {
    const before = await this.get(req, id);
    assertAuthorised(req, (before as { subject_type: string }).subject_type, (before as { subject_id: string }).subject_id);
    if ((before as { revoked_at: Date | null }).revoked_at != null) {
      return before; // idempotent
    }
    const r = await db(req).consentRecord.updateMany({
      where: { id, tenant_id: req.user!.tid, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    if (r.count !== 1) throw NotFound('Consent record not found');
    const after = await db(req).consentRecord.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'consent.revoked',
      entityType: 'consent_record',
      entityId: id,
      before,
      after,
    });
    return after;
  },
};
