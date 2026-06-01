import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../shared/jwt.js';
import { Unauthorized, Forbidden, ServiceUnavailable } from '../shared/errors.js';
import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';
import type { Role } from '@spv/zod-schemas';

// `req.user` is augmented globally in `src/types/express.d.ts`.

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// SVT-SEC-IDLE-2026-05 — idle-bump throttle. Single-process map; for multi-
// replica deployments swap to Redis. 60s throttle means at most one DB write
// per user per minute. Updates EVERY live refresh row for the user so the
// `refresh()` idle check has a fresh stamp regardless of which device is active.
const IDLE_BUMP_THROTTLE_MS = 60_000;
const lastBumpAt = new Map<string, number>();

async function bumpIdleStamp(userId: string): Promise<void> {
  const now = Date.now();
  const prev = lastBumpAt.get(userId) ?? 0;
  if (now - prev < IDLE_BUMP_THROTTLE_MS) return;
  lastBumpAt.set(userId, now);
  await prisma.refreshToken.updateMany({
    where: { user_id: userId, revoked_at: null, expires_at: { gt: new Date() } },
    data: { last_used_at: new Date(now) },
  });
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      throw Unauthorized();
    }
    const token = header.slice('Bearer '.length).trim();
    const claims = await verifyAccessToken(token);
    // Reject revoked access tokens. Logout writes the JTI here; consult every request.
    //
    // FAIL-CLOSED on DB error: when the denylist query can't be answered we
    // cannot prove the token isn't revoked. Returning 503 (with retry-after
    // semantics implied) is the only safe choice — a stolen-token attacker
    // would otherwise wait for a Postgres blip to slip through. The legitimate
    // user gets a brief outage rather than a long-lived security hole.
    try {
      const denied = await prisma.accessTokenDenylist.findUnique({ where: { jti: claims.jti } });
      if (denied && denied.expires_at > new Date()) {
        return next(Unauthorized('Token revoked'));
      }
    } catch (err) {
      logger.error({ err, jti: claims.jti }, 'JTI denylist lookup failed — refusing access (fail-closed)');
      return next(ServiceUnavailable('Auth denylist unavailable; retry shortly'));
    }
    req.user = claims;
    // SVT-SEC-IDLE-2026-05 — bump RefreshToken.last_used_at on every authenticated
    // request, throttled per-user to 60s. Used at refresh time to enforce idle
    // session timeout. Fire-and-forget: DB blip must never fail the request.
    void bumpIdleStamp(claims.sub).catch((err) =>
      logger.warn({ err, sub: claims.sub }, 'idle-bump failed (non-fatal)'),
    );
    // Defence-in-depth: a VIEWER role can never make a write, regardless of which
    // route they hit. Individual admin-only routes also enforce requireRole('ADMIN').
    if (claims.role === 'VIEWER' && !READ_METHODS.has(req.method)) {
      return next(Forbidden('Viewer role is read-only'));
    }
    next();
  } catch (err) {
    if ((err as { status?: number }).status === 401) return next(err);
    next(Unauthorized('Invalid or expired token'));
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(Unauthorized());
    if (!roles.includes(req.user.role)) return next(Forbidden());
    next();
  };
}

/**
 * SVT-RBAC-OWN-2026-05: Student-ownership gate for COUNSELLOR mutations.
 *
 * Several PII-mutation routes (PATCH /students/:id, POST /students/:id/transitions,
 * POST /students/:id/messages, DELETE /<sub-resource>/:id, etc.) currently allow
 * any COUNSELLOR to act on any tenant student. That permits inside-tenant cross-
 * counsellor PII tampering — a confidentiality breach even though tenant
 * isolation holds.
 *
 * This middleware resolves the parent student from the request and asserts
 * `student.assigned_to_id === req.user.sub` OR `role === 'ADMIN'`. Lookup is
 * tenant-scoped + soft-delete-aware. ADMIN short-circuits so admin tools work
 * without ownership noise.
 *
 * Usage:
 *   router.patch('/students/:id', authenticate, tenantContext, requireRole('ADMIN','COUNSELLOR'),
 *                requireStudentOwnership('id'), handler);
 *
 *   router.delete('/contacts/:id', authenticate, tenantContext, requireRole('ADMIN','COUNSELLOR'),
 *                 requireStudentOwnershipViaChild('contact', 'id'), handler);
 *
 * For sub-resources the helper expects an explicit lookup map so it can resolve
 * `child_id → parent_student_id` cheaply. Each child route registers its own
 * resolver via `requireStudentOwnershipViaChild('<model>', '<idParam>')`.
 */
const CHILD_STUDENT_RESOLVERS: Record<
  string,
  (id: string, tenantId: string) => Promise<{ student_id: string | null } | null>
> = {
  contact: (id, tenantId) =>
    prisma.studentContact.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  visa: (id, tenantId) =>
    prisma.studentVisa.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  identification: (id, tenantId) =>
    prisma.studentIdentification.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  dependent: (id, tenantId) =>
    prisma.studentDependent.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  employment: (id, tenantId) =>
    prisma.studentEmployment.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  qualification: (id, tenantId) =>
    prisma.academicQualification.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  languageTest: (id, tenantId) =>
    prisma.languageTestResult.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  travel: (id, tenantId) =>
    prisma.travelRecord.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  accommodation: (id, tenantId) =>
    prisma.accommodation.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  insurance: (id, tenantId) =>
    prisma.insuranceRecord.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  finance: (id, tenantId) =>
    prisma.financeItem.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  compliance: (id, tenantId) =>
    prisma.complianceCheck.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  engagement: (id, tenantId) =>
    prisma.engagementCheck.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  regulatorId: (id, tenantId) =>
    prisma.studentRegulatorIdentifier.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  sponsorship: (id, tenantId) =>
    prisma.studentSponsorship.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  enrollment: (id, tenantId) =>
    prisma.enrollment.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  document: (id, tenantId) =>
    prisma.document.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  reminder: (id, tenantId) =>
    prisma.reminder.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
};

export type StudentOwnerChild = keyof typeof CHILD_STUDENT_RESOLVERS;

async function assertStudentOwnership(
  studentId: string,
  req: Request,
): Promise<void> {
  if (!req.user) throw Unauthorized();
  if (req.user.role === 'ADMIN') return; // ADMIN always bypasses ownership.
  const student = await prisma.student.findFirst({
    where: { id: studentId, tenant_id: req.user.tid, deleted_at: null },
    select: { assigned_to_id: true },
  });
  if (!student) {
    // Tenant-leakage-safe: same 404-ish behaviour as if the row didn't exist.
    throw Forbidden('Not authorised for this student');
  }
  if (student.assigned_to_id !== req.user.sub) {
    throw Forbidden('Not authorised for this student');
  }
}

/**
 * Gate routes that already carry the student id in a path parameter
 * (e.g. /students/:id/transitions, /students/:id/messages).
 */
export function requireStudentOwnership(idParam = 'id') {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const id = req.params[idParam];
      if (!id) return next(Forbidden('Missing student id'));
      await assertStudentOwnership(id, req);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Gate routes that carry a child entity id (e.g. /contacts/:id, /finance/:id)
 * — we resolve the parent student via the registered model lookup.
 */
export function requireStudentOwnershipViaChild(
  child: StudentOwnerChild,
  idParam = 'id',
) {
  const lookup = CHILD_STUDENT_RESOLVERS[child];
  if (!lookup) throw new Error(`requireStudentOwnershipViaChild: unknown child '${child}'`);
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw Unauthorized();
      if (req.user.role === 'ADMIN') return next();
      const id = req.params[idParam];
      if (!id) return next(Forbidden('Missing entity id'));
      const row = await lookup(id, req.user.tid);
      if (!row || !row.student_id) return next(Forbidden('Not authorised for this resource'));
      await assertStudentOwnership(row.student_id, req);
      next();
    } catch (err) {
      next(err);
    }
  };
}
