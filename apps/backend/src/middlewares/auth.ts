import type { Request, Response, NextFunction } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { verifyAccessToken } from '../shared/jwt.js';
import { Unauthorized, Forbidden, ServiceUnavailable } from '../shared/errors.js';
import { prismaAdmin } from '../config/db.js';
import { withTenantTx } from '../shared/tenantTx.js';
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
  // SVT-SEC-2026-08 (T0-7) — prismaAdmin, like the denylist lookup below.
  //
  // `refresh_tokens` is RLS-scoped and this runs inside `authenticate`, before
  // tenantContext has set the GUC, so on the singleton the updateMany matched
  // zero rows under the production role and `last_used_at` never advanced. The
  // idle check in refresh() reads that stamp, so every active session would
  // have looked idle and users would have been signed out mid-work — with the
  // throttle map above making it look like the code had run.
  //
  // Scoping by user_id is sound here: it is globally unique, and this is an
  // authentication primitive with no tenant context by construction.
  await prismaAdmin.refreshToken.updateMany({
    where: { user_id: userId, revoked_at: null, expires_at: { gt: new Date() } },
    data: { last_used_at: new Date(now) },
  });
}

// SVT-QA-2026-08 — sessions_valid_from cache. Every authenticated request
// otherwise costs a DB hit to check whether the token was invalidated by a
// password change / MFA disable / admin revoke. A short-TTL per-user cache
// keeps the hot path cheap while still bounding the window a revoked token
// can survive to `SESSIONS_CACHE_TTL_MS` milliseconds after the flip.
//
// Fail-closed on DB error: if we can't answer "was this session revoked?"
// we cannot prove the token is still valid, and pretending otherwise is a
// worse posture than a brief 503. Legitimate users retry; a stolen-token
// attacker cannot ride a Postgres blip.
//
// Invalidated by the 6 revocation flows via `invalidateSessionsValidFrom`.
const SESSIONS_CACHE_TTL_MS = 30_000;
const sessionsValidFromCache = new Map<string, { validFromMs: number; cachedAt: number }>();

/** Called by revocation flows (auth.service, users.service, mfa.service, etc.). */
export function invalidateSessionsValidFrom(userId: string): void {
  sessionsValidFromCache.delete(userId);
}

function readSessionsValidFromCache(userId: string): number | null {
  const cached = sessionsValidFromCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < SESSIONS_CACHE_TTL_MS) {
    return cached.validFromMs;
  }
  return null;
}

async function getSessionsValidFromMs(userId: string): Promise<number> {
  const cached = readSessionsValidFromCache(userId);
  if (cached !== null) return cached;
  // Read via adminDb (BYPASSRLS) so a tenant-context-less path (this
  // middleware runs BEFORE tenantContext) can still resolve the user's
  // revocation stamp.
  const row = await prismaAdmin.user.findUnique({
    where: { id: userId },
    select: { sessions_valid_from: true },
  });
  const validFromMs = row?.sessions_valid_from ? row.sessions_valid_from.getTime() : 0;
  sessionsValidFromCache.set(userId, { validFromMs, cachedAt: Date.now() });
  return validFromMs;
}

// SVT-PERF-2026-08 — JTI denylist cache.
//
// The denylist answers "was this exact token explicitly logged out?". Before
// this, EVERY authenticated request paid a `SELECT ... WHERE jti = ?` for it —
// on an app where the overwhelming majority of tokens are NOT denylisted, that
// is a per-request query whose answer is almost always "no row".
//
// A negative result is cached for a short TTL. The security cost is bounded and
// explicit: a token revoked via /auth/logout can survive at most
// DENYLIST_NEG_CACHE_TTL_MS after the logout call. That window is deliberately
// much shorter than the access-token TTL, and logout ALSO clears the refresh
// cookie, so the session cannot be renewed past it.
//
// A POSITIVE result (token IS denied) is never cached as negative and short-
// circuits immediately — we never cache our way into accepting a revoked token.
const DENYLIST_NEG_CACHE_TTL_MS = 10_000;
const denylistNegCache = new Map<string, number>(); // jti -> cachedAt

/** Called by logout so a freshly denylisted token is never served from cache. */
export function invalidateDenylistCache(jti: string): void {
  denylistNegCache.delete(jti);
}

async function isTokenDenylisted(jti: string): Promise<boolean> {
  const cachedAt = denylistNegCache.get(jti);
  if (cachedAt !== undefined && Date.now() - cachedAt < DENYLIST_NEG_CACHE_TTL_MS) {
    return false; // known-not-denied, recently verified
  }
  // SVT-SEC-2026-08 — prismaAdmin, for the same reason getSessionsValidFromMs
  // above uses it: this runs inside `authenticate`, which executes BEFORE
  // `tenantContext` sets the `app.tenant_id` GUC.
  //
  // `access_token_denylist` carries FORCE RLS with
  // `USING (tenant_id = app_current_tenant() OR tenant_id IS NULL)`, and every
  // denylist row is written with a real tenant_id. With no GUC set,
  // `tenant_id = app_current_tenant()` evaluates to NULL and `tenant_id IS NULL`
  // is false, so the row is FILTERED OUT — findUnique returns null without
  // throwing. That is indistinguishable from "this token was never revoked", so
  // the check silently passed every revoked token through.
  //
  // Note this bypassed the fail-closed handling at the call site: that catch
  // only fires on an exception, and RLS filtering is not an exception. The
  // control looked robust and was inert.
  const denied = await prismaAdmin.accessTokenDenylist.findUnique({ where: { jti } });
  if (denied && denied.expires_at > new Date()) return true;
  denylistNegCache.set(jti, Date.now());
  // Opportunistic sweep: the map is keyed by JTI so it grows with unique
  // tokens. Bound it — entries are worthless once past their TTL anyway.
  if (denylistNegCache.size > 10_000) {
    const cutoff = Date.now() - DENYLIST_NEG_CACHE_TTL_MS;
    for (const [k, t] of denylistNegCache) {
      if (t < cutoff) denylistNegCache.delete(k);
    }
  }
  return false;
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
      if (await isTokenDenylisted(claims.jti)) {
        return next(Unauthorized('Token revoked'));
      }
    } catch (err) {
      logger.error({ err, jti: claims.jti }, 'JTI denylist lookup failed — refusing access (fail-closed)');
      return next(ServiceUnavailable('Auth denylist unavailable; retry shortly'));
    }
    // SVT-QA-2026-08 — session-wide revoke check. The JTI denylist above
    // covers `/auth/logout`; this covers changePassword, confirmPasswordReset,
    // admin resetPassword, self disableMfa, admin adminDisableMfa, and
    // revokeAllSessions — all of which invalidate every live token issued to
    // the user by stamping `sessions_valid_from`. Tokens issued before that
    // stamp are rejected here even if they haven't hit their TTL.
    try {
      const validFromMs = await getSessionsValidFromMs(claims.sub);
      // verifyAccessToken always populates `iat`; the type is optional only
      // because the same shape doubles as the sign() input. Coerce to 0
      // defensively — any token missing iat is treated as immediately
      // revoked when sessions_valid_from is set.
      const iatMs = (claims.iat ?? 0) * 1000;
      if (validFromMs > 0 && iatMs < validFromMs) {
        return next(Unauthorized('Session revoked'));
      }
    } catch (err) {
      logger.error({ err, sub: claims.sub }, 'sessions_valid_from lookup failed — refusing access (fail-closed)');
      return next(ServiceUnavailable('Auth session store unavailable; retry shortly'));
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
// SVT-SEC-2026-08 (T0-7) — the resolvers take their client from the caller.
//
// Every table below is RLS-scoped and the `prisma` singleton carries no tenant
// GUC, so under the production `spv_app` role each of these lookups returned
// null. The call site treats null as "not authorised", so this fails CLOSED —
// no data leak — but every COUNSELLOR would have been 403'd out of every child
// resource in the product: contacts, visas, documents, reminders, enrolments,
// the lot. ADMIN short-circuits before the lookup ever runs, so an admin-only
// smoke test would have shown the whole app working.
type ChildDb = PrismaClient | Prisma.TransactionClient;
const CHILD_STUDENT_RESOLVERS: Record<
  string,
  (id: string, tenantId: string, db: ChildDb) => Promise<{ student_id: string | null } | null>
> = {
  contact: (id, tenantId, db) =>
    db.studentContact.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  visa: (id, tenantId, db) =>
    db.studentVisa.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  identification: (id, tenantId, db) =>
    db.studentIdentification.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  dependent: (id, tenantId, db) =>
    db.studentDependent.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  employment: (id, tenantId, db) =>
    db.studentEmployment.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  qualification: (id, tenantId, db) =>
    db.academicQualification.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  languageTest: (id, tenantId, db) =>
    db.languageTestResult.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  travel: (id, tenantId, db) =>
    db.travelRecord.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  accommodation: (id, tenantId, db) =>
    db.accommodation.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  insurance: (id, tenantId, db) =>
    db.insuranceRecord.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  finance: (id, tenantId, db) =>
    db.financeItem.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  compliance: (id, tenantId, db) =>
    db.complianceCheck.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  engagement: (id, tenantId, db) =>
    db.engagementCheck.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  regulatorId: (id, tenantId, db) =>
    db.studentRegulatorIdentifier.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  sponsorship: (id, tenantId, db) =>
    db.studentSponsorship.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  enrollment: (id, tenantId, db) =>
    db.enrollment.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  document: (id, tenantId, db) =>
    db.document.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
  reminder: (id, tenantId, db) =>
    db.reminder.findFirst({ where: { id, tenant_id: tenantId }, select: { student_id: true } }),
};

export type StudentOwnerChild = keyof typeof CHILD_STUDENT_RESOLVERS;

// SVT-QA-2026-08 — exported so polymorphic-parent services (notes, reminders
// with entity_type='student' or student_id) can enforce the same ownership
// contract as the per-student routes without duplicating the middleware
// dispatch. Callers pass a minimal Request-shaped context.
export async function assertStudentOwnership(
  studentId: string,
  req: Request,
): Promise<void> {
  if (!req.user) throw Unauthorized();
  if (req.user.role === 'ADMIN') return; // ADMIN always bypasses ownership.
  // SVT-SEC-2026-08 (T0-7) — `students` is RLS-scoped; the singleton has no
  // tenant GUC, so under the production role this read returned null and every
  // counsellor was 403'd from every student. Fails closed, but the product does
  // not work. ADMIN returns above, so admin testing would never surface it.
  const stid = req.user.tid;
  const student = req.db
    ? await req.db.student.findFirst({
        where: { id: studentId, tenant_id: stid, deleted_at: null },
        select: { assigned_to_id: true },
      })
    : await withTenantTx(stid, (tx) => tx.student.findFirst({
        where: { id: studentId, tenant_id: stid, deleted_at: null },
        select: { assigned_to_id: true },
      }));
  if (!student) {
    // Tenant-leakage-safe: same 404-ish behaviour as if the row didn't exist.
    throw Forbidden('Not authorised for this student');
  }
  // SVT-SEC-2026-08 — an UNASSIGNED student is open to any counsellor in the
  // tenant, exactly as `requireLeadOwnership` below already treats an
  // unassigned lead ("the shared queue is how they get picked up; locking
  // those out would break intake").
  //
  // Without the null carve-out this gate locked counsellors out of students
  // they had just created themselves. `create()` defaults `assigned_to_id` to
  // null and the quick-create form never sends one, so a counsellor pressed
  // "Add student", got a row, and was refused 403 the instant they opened it —
  // and could not fix it either, because only ADMIN may set `assigned_to_id`.
  // The realistic user response is to create the student again, so the failure
  // mode was duplicate records rather than a visible error.
  //
  // Deliberately fixed HERE rather than by defaulting the assignee in
  // `create()`. The carve-out is the more general fix: ADMIN-created and
  // CSV-imported students also arrive unassigned and must stay pickup-able,
  // which auto-assigning the creator would not address. It is also the form the
  // caseload-scoping work needs — a scoped list has to read
  // `assigned_to_id = self OR assigned_to_id IS NULL` for the same reason, so
  // the two stay consistent.
  if (student.assigned_to_id !== null && student.assigned_to_id !== req.user.sub) {
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
      // Prefer the request-scoped client. Fall back to our own tenant-scoped
      // transaction rather than the singleton, so a route mounted without
      // tenantContext resolves correctly instead of silently 403ing every
      // non-admin caller.
      const tid = req.user.tid;
      const row = req.db
        ? await lookup(id, tid, req.db)
        : await withTenantTx(tid, (tx) => lookup(id, tid, tx));
      if (!row || !row.student_id) return next(Forbidden('Not authorised for this resource'));
      await assertStudentOwnership(row.student_id, req);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * SVT-QA-2026-08 (LEAD-H2) — per-record ownership gate for CRM leads.
 *
 * The docs promise "COUNSELLOR can only mutate records assigned to them", and
 * every student sub-resource enforces it via `requireStudentOwnership`. The
 * lead routes had no equivalent, so ANY counsellor in the tenant could PATCH
 * any lead — including reassigning `assigned_to_id` to themselves — and then
 * add, edit, pay, waive or delete that lead's fees. The audit log recorded who
 * did it, but nothing stopped them: a colleague on leave could return to find
 * their book rewritten.
 *
 * Semantics mirror the student gate:
 *   - ADMIN bypasses.
 *   - An UNASSIGNED lead (`assigned_to_id IS NULL`) is open to any counsellor.
 *     Leads land unassigned from the V2 sync and the shared queue is how they
 *     get picked up; locking those out would break intake.
 *   - An ASSIGNED lead is mutable only by its assignee.
 *   - A missing lead yields the same Forbidden as a foreign one, so the gate
 *     cannot be used to probe which lead ids exist.
 */
export function requireLeadOwnership(idParam = 'id') {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw Unauthorized();
      if (req.user.role === 'ADMIN') return next();
      const id = req.params[idParam];
      if (!id) return next(Forbidden('Missing lead id'));
      // SVT-SEC-2026-08 (T0-7) — same as assertStudentOwnership above: on the
      // GUC-less singleton this returned null for every lead in production.
      const ltid = req.user.tid;
      const lead = req.db
        ? await req.db.crmLead.findFirst({
            where: { id, tenant_id: ltid, deleted_at: null },
            select: { assigned_to_id: true },
          })
        : await withTenantTx(ltid, (tx) => tx.crmLead.findFirst({
            where: { id, tenant_id: ltid, deleted_at: null },
            select: { assigned_to_id: true },
          }));
      if (!lead) return next(Forbidden('Not authorised for this lead'));
      if (lead.assigned_to_id !== null && lead.assigned_to_id !== req.user.sub) {
        return next(Forbidden('Not authorised for this lead'));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
