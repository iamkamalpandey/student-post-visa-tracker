import type { Prisma, PrismaClient } from '@prisma/client';
import type { CreateUserRequest, UpdateUserRequest } from '@spv/zod-schemas';
import { withTenantTx } from '../../shared/tenantTx.js';
import { hashPassword } from '../../shared/passwords.js';
import { ensurePasswordNotPwned } from '../../shared/hibp.js';
import { Conflict, Forbidden, NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';

type DB = PrismaClient | Prisma.TransactionClient;

// SVT-SEC-2026-08 (T0-7) — resolve the client, never the bare singleton.
//
// `users` is RLS-scoped with the policy `tenant_id = app_current_tenant()`, and
// that GUC is only set by the per-request client or by withTenantTx. Every
// method here except `list` reached for the `prisma` singleton, so under the
// production `spv_app` role the reads returned NOTHING and the writes failed
// the WITH CHECK — user administration simply did not work, while dev and CI
// (single superuser role, RLS never applies) showed it working perfectly.
//
// The migration to the request-scoped client was started — `list` takes a `db`
// and the controller passes `req.db` — and then stopped. The old fallback was
// the singleton, so a caller that forgot `db` was silently wrong. This helper
// makes the fallback *correct* instead: no client supplied means we open our
// own tenant-scoped transaction. Forgetting to thread `req.db` now costs one
// extra transaction rather than returning an empty result set.
async function scoped<T>(
  tenantId: string,
  db: DB | undefined,
  fn: (client: DB) => Promise<T>,
): Promise<T> {
  if (db) return fn(db);
  return withTenantTx(tenantId, (tx) => fn(tx));
}

export type ListUsersInput = {
  tenantId: string;
  limit: number;
  cursor?: string;
  search?: string;
  // SVT-LOOKUP-FILTERS-2026-05: when the call originates from an assignee
  // picker, hide soft-deleted/disabled users. The admin management screen
  // omits this so it can still surface inactive accounts for re-activation.
  activeOnly?: boolean;
  // SVT-RLS-2026-05: prefer the per-request RLS-scoped client. Falls back
  // to the singleton for backwards-compatibility with callers that haven't
  // been migrated yet.
  db?: DB;
};

const PUBLIC_FIELDS = {
  id: true,
  email: true,
  given_name: true,
  family_name: true,
  display_name: true,
  role: true,
  locale: true,
  timezone: true,
  is_active: true,
  last_login_at: true,
  mfa_enabled: true,
  created_at: true,
  updated_at: true,
} as const;

export const usersService = {
  async list(input: ListUsersInput) {
    const where = {
      tenant_id: input.tenantId,
      deleted_at: null,
      ...(input.activeOnly ? { is_active: true } : {}),
      ...(input.search
        ? {
            OR: [
              { email: { contains: input.search, mode: 'insensitive' as const } },
              { given_name: { contains: input.search, mode: 'insensitive' as const } },
              { family_name: { contains: input.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const rows = await scoped(input.tenantId, input.db, (client) =>
      client.user.findMany({
        where,
        take: input.limit + 1,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        select: PUBLIC_FIELDS,
      }),
    );
    const hasMore = rows.length > input.limit;
    return {
      data: rows.slice(0, input.limit),
      page: { hasMore, nextCursor: hasMore ? rows[input.limit - 1]!.id : null },
    };
  },

  async create(tenantId: string, input: CreateUserRequest, actorId: string, db?: DB) {
    const existing = await scoped(tenantId, db, (c) =>
      c.user.findUnique({
        where: { tenant_id_email: { tenant_id: tenantId, email: input.email.toLowerCase() } },
      }),
    );
    if (existing) throw Conflict('A user with that email already exists in this tenant');

    // SVT-WAVE25-DEFAULTS-2026-05 — when caller doesn't pass locale/timezone,
    // inherit tenant defaults so new users see the workspace settings admin
    // already configured under /settings → Tenant settings.
    let inheritedLocale: string | undefined;
    let inheritedTz: string | undefined;
    if (input.locale === undefined || input.timezone === undefined) {
      const tenant = await scoped(tenantId, db, (c) =>
        c.tenant.findFirst({
          where: { id: tenantId },
          select: { default_locale: true, default_timezone: true },
        }),
      );
      inheritedLocale = tenant?.default_locale;
      inheritedTz = tenant?.default_timezone;
    }

    // SVT-SEC-2026-05 — HIBP check on initial password set (admin-created
    // accounts). NODE_ENV=test bypasses.
    await ensurePasswordNotPwned(input.password, { tenantId });
    const passwordHash = await hashPassword(input.password);
    const created = await scoped(tenantId, db, (c) => c.user.create({
      data: {
        tenant_id: tenantId,
        email: input.email.toLowerCase(),
        password_hash: passwordHash,
        given_name: input.given_name,
        family_name: input.family_name,
        display_name: input.display_name ?? null,
        role: input.role,
        locale: input.locale ?? inheritedLocale ?? 'en',
        timezone: input.timezone ?? inheritedTz ?? 'UTC',
        password_changed_at: new Date(),
      },
      select: PUBLIC_FIELDS,
    }));
    // SVT-WAVE-AUDIT-USERS-2026-06 (W1.3) — account-creation is a privileged
    // lifecycle event (a new principal gains a role in the tenant). Record an
    // append-only audit row. NEVER log the password or its hash; capture only
    // the public shape of the created account.
    await writeAudit({
      action: 'user.created',
      entityType: 'user',
      entityId: created.id,
      actorId,
      tenantId,
      after: {
        email: created.email,
        role: created.role,
        given_name: input.given_name,
        family_name: input.family_name,
      },
    } as never);
    return created;
  },

  async getById(tenantId: string, id: string, db?: DB) {
    const user = await scoped(tenantId, db, (c) =>
      c.user.findFirst({
        where: { tenant_id: tenantId, id, deleted_at: null },
        select: PUBLIC_FIELDS,
      }),
    );
    if (!user) throw NotFound('User not found');
    return user;
  },

  // SVT-SEC-2026-05 — CRITICAL hardening per audit:
  //   1. Block self-demotion / self-deactivation (admin locking themselves out).
  //   2. Block last-active-admin demotion or deactivation (entire tenant locked
  //      out — irreversible without DB intervention).
  //   3. Self role mutation is forbidden even for ADMIN (privilege escalation
  //      pivot — must be done via the admin-managed peer flow).
  //   4. SVT-SEC-ROLE-MFA-2026-05 (P0-2) — role mutations on ANOTHER user
  //      require that the acting admin has MFA enrolled AND has freshly
  //      step-up'd via X-MFA-Code on this request. Without that gate, a
  //      stolen ADMIN access token (no MFA on the account) is enough to
  //      promote any peer to ADMIN — a one-shot privilege escalation that
  //      bypasses the entire MFA programme.
  //   Caller MUST pass actorId so we can apply the self-guards.
  async update(
    tenantId: string,
    id: string,
    input: UpdateUserRequest,
    actorId: string,
    // SVT-IF-MATCH-2026-05 — accepted for controller parity; User has no
    // `version` column so optimistic-concurrency is a no-op here. Field kept
    // in the signature so callers don't break when the column lands later.
    _opts?: {
      expected?: number;
      // SVT-SEC-ROLE-MFA-2026-05 (P0-2) — actor MFA context. Populated by the
      // controller from req.user (DB lookup of mfa_enabled) + req.mfaVerifiedAt
      // (set by middlewares/requireMfa.ts when the X-MFA-Code header was
      // valid for this request). Both required for any role mutation.
      actorMfaEnabled?: boolean;
      actorMfaVerifiedAt?: Date | undefined;
    },
    db?: DB,
  ) {
    const target = await scoped(tenantId, db, (c) =>
      c.user.findFirst({
        where: { tenant_id: tenantId, id, deleted_at: null },
        select: { id: true, role: true, is_active: true },
      }),
    );
    if (!target) throw NotFound('User not found');

    // SVT-WAVE-AUDIT-USERS-2026-06 (W1.3) — snapshot the pre-mutation state for
    // the audit `before` NOW, before the updateMany below. Mirrors the
    // adminDisableMfa `wasEnabled` capture: some Prisma test doubles return a
    // live row reference that updateMany mutates in place, so reading
    // target.role/target.is_active AFTER the write would silently report the
    // new value and lose forensic signal.
    const beforeRole = target.role;
    const beforeIsActive = target.is_active;

    const wantsRoleChange = input.role !== undefined && input.role !== target.role;
    const wantsDeactivation = input.is_active === false && target.is_active;

    // 1 + 3. Self-guards.
    if (id === actorId) {
      if (wantsRoleChange) {
        throw Forbidden('You cannot change your own role; ask another admin');
      }
      if (wantsDeactivation) {
        throw Forbidden('You cannot deactivate your own account');
      }
    }

    // 4. Role-mutation MFA gate. Triggered ONLY when role is actually
    // changing on someone other than the actor (the self-guard above
    // already rejects same-user role changes). The route is already
    // wrapped in requireMfa({enrollmentRequired:true}) so the request
    // would 403 before reaching here when actor.mfa_enabled is false;
    // this is a defence-in-depth check inside the service so a misconfig
    // of the route chain (or a programmatic caller skipping the
    // middleware) still cannot promote anyone to ADMIN.
    if (wantsRoleChange && id !== actorId) {
      if (!_opts?.actorMfaEnabled) {
        throw Forbidden(
          'Role changes require the acting admin to have MFA enrolled. Enrol via /settings → Two-factor authentication and try again.',
        );
      }
      if (!_opts?.actorMfaVerifiedAt) {
        throw Forbidden(
          'Role changes require a fresh MFA step-up — resubmit with the X-MFA-Code header.',
        );
      }
    }

    // 2. Last-admin guard. Triggers when the target is currently ADMIN and
    //    the change either demotes them or deactivates them.
    if (
      target.role === 'ADMIN' &&
      ((wantsRoleChange && input.role !== 'ADMIN') || wantsDeactivation)
    ) {
      const adminCount = await scoped(tenantId, db, (c) =>
        c.user.count({
          where: {
            tenant_id: tenantId,
            role: 'ADMIN',
            is_active: true,
            deleted_at: null,
          },
        }),
      );
      if (adminCount <= 1) {
        throw Conflict('Cannot demote or deactivate the last active admin');
      }
    }

    const updated = await scoped(tenantId, db, (c) =>
      c.user.updateMany({
        where: { tenant_id: tenantId, id, deleted_at: null },
        data: input,
      }),
    );
    if (updated.count === 0) throw NotFound('User not found');
    // SVT-WAVE-AUDIT-USERS-2026-06 (W1.3) — privilege-escalation (promoting a
    // peer to ADMIN) and deactivation are the security-critical mutations, so
    // the audit row carries an explicit before/after of (role, is_active).
    // beforeRole/beforeIsActive were snapshotted PRE-update so they hold the
    // prior state even when a Prisma test double mutates the row reference in
    // place. `input.role` / `input.is_active` may be undefined (field not in
    // this PATCH); fall back to the prior value so the snapshot always reflects
    // the effective state.
    await writeAudit({
      action: 'user.updated',
      entityType: 'user',
      entityId: id,
      actorId,
      tenantId,
      before: { role: beforeRole, is_active: beforeIsActive },
      after: {
        role: input.role ?? beforeRole,
        is_active: input.is_active ?? beforeIsActive,
      },
    } as never);
    return this.getById(tenantId, id, db);
  },

  async softDelete(tenantId: string, id: string, actorId: string, db?: DB) {
    if (id === actorId) throw Conflict('You cannot delete your own account');
    // SVT-SEC-2026-05 — last-admin guard. Deleting the only remaining active
    // admin locks the entire tenant out (no one can do admin-only work like
    // password resets, role mutations, breach review).
    const target = await scoped(tenantId, db, (c) =>
      c.user.findFirst({
        where: { tenant_id: tenantId, id, deleted_at: null },
        select: { role: true, is_active: true },
      }),
    );
    if (!target) throw NotFound('User not found');
    // SVT-WAVE-AUDIT-USERS-2026-06 (W1.3) — snapshot prior state before the
    // updateMany mutates the (possibly shared) row reference, so the audit
    // `before` reports the pre-deletion role/active status, not the new one.
    const beforeRole = target.role;
    const beforeIsActive = target.is_active;
    if (target.role === 'ADMIN' && target.is_active) {
      const adminCount = await scoped(tenantId, db, (c) =>
        c.user.count({
          where: {
            tenant_id: tenantId, role: 'ADMIN', is_active: true, deleted_at: null,
          },
        }),
      );
      if (adminCount <= 1) {
        throw Conflict('Cannot delete the last active admin');
      }
    }
    const updated = await scoped(tenantId, db, (c) =>
      c.user.updateMany({
        where: { tenant_id: tenantId, id, deleted_at: null },
        data: { deleted_at: new Date(), is_active: false },
      }),
    );
    if (updated.count === 0) throw NotFound('User not found');
    // Revoke all refresh tokens so the deleted user cannot continue active sessions.
    await scoped(tenantId, db, (c) =>
      c.refreshToken.updateMany({
        where: { user_id: id, revoked_at: null },
        data: { revoked_at: new Date() },
      }),
    );
    // SVT-WAVE-AUDIT-USERS-2026-06 (W1.3) — soft-deletion removes a principal
    // from the tenant; capture the prior (role, is_active) so a forensic
    // reviewer can see what was deactivated.
    await writeAudit({
      action: 'user.deleted',
      entityType: 'user',
      entityId: id,
      actorId,
      tenantId,
      before: { is_active: beforeIsActive, role: beforeRole },
      after: { deleted: true },
    } as never);
  },

  async resetPassword(tenantId: string, id: string, newPassword: string, actorId: string, db?: DB) {
    const exists = await scoped(tenantId, db, (c) =>
      c.user.findFirst({
        where: { tenant_id: tenantId, id, deleted_at: null },
        select: { id: true },
      }),
    );
    if (!exists) throw NotFound('User not found');
    // SVT-SEC-2026-05 — admin-driven password reset still flows through HIBP.
    await ensurePasswordNotPwned(newPassword, { tenantId, userId: id });
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    // SVT-QA-2026-08 — stamp sessions_valid_from so admin-driven reset also
    // invalidates any live access token for the target user.
    const now = new Date();
    const newHash = await hashPassword(newPassword);
    const wr = await scoped(tenantId, db, (c) =>
      c.user.updateMany({
        where: { id, tenant_id: tenantId, deleted_at: null },
        data: {
          password_hash: newHash,
          password_changed_at: now,
          failed_login_count: 0,
          locked_until: null,
          sessions_valid_from: now,
        },
      }),
    );
    if (wr.count !== 1) throw NotFound('User not found');
    await scoped(tenantId, db, (c) =>
      c.refreshToken.updateMany({
        where: { user_id: id, revoked_at: null },
        data: { revoked_at: now },
      }),
    );
    const { invalidateSessionsValidFrom } = await import('../../middlewares/auth.js');
    invalidateSessionsValidFrom(id);
    // SVT-WAVE-AUDIT-USERS-2026-06 (W1.3) — admin password reset is an
    // account-takeover-adjacent action (the admin sets a credential they then
    // know). NEVER log the password or its hash; record only that the reset
    // happened and that live sessions were revoked.
    await writeAudit({
      action: 'user.password_reset_by_admin',
      entityType: 'user',
      entityId: id,
      actorId,
      tenantId,
      after: { sessions_revoked: true },
    } as never);
  },

  async revokeAllSessions(tenantId: string, id: string, actorId: string, db?: DB) {
    const exists = await scoped(tenantId, db, (c) =>
      c.user.findFirst({
        where: { tenant_id: tenantId, id, deleted_at: null },
        select: { id: true },
      }),
    );
    if (!exists) throw NotFound('User not found');
    // SVT-QA-2026-08 — stamp sessions_valid_from alongside refresh revoke so
    // access tokens fall over within one cache cycle, not the full 15-min TTL.
    const now = new Date();
    // SVT-RLS-2026-05 — tenant_id in the where on BOTH writes (defence in
    // depth on top of the existence check above).
    // Stamp first: once `sessions_valid_from` lands, every live access token
    // for the target is rejected by the authenticate middleware, so the
    // refresh revoke that follows can never leave an exploitable window.
    await scoped(tenantId, db, (c) =>
      c.user.updateMany({
        where: { id, tenant_id: tenantId },
        data: { sessions_valid_from: now },
      }),
    );
    const result = await scoped(tenantId, db, (c) =>
      c.refreshToken.updateMany({
        where: { user_id: id, revoked_at: null },
        data: { revoked_at: now },
      }),
    );
    const { invalidateSessionsValidFrom } = await import('../../middlewares/auth.js');
    invalidateSessionsValidFrom(id);
    // SVT-WAVE-AUDIT-USERS-2026-06 (W1.3) — force session revocation is an
    // admin action against another principal's live sessions; record it with
    // the number of sessions revoked for forensic review.
    await writeAudit({
      action: 'user.sessions_revoked',
      entityType: 'user',
      entityId: id,
      actorId,
      tenantId,
      after: { revoked: result.count },
    } as never);
    return { revoked: result.count };
  },

  // SVT-SEC-MFA-FORCE-DISABLE-2026-05 — admin-driven MFA unbrick path.
  //
  // Background: the previous self-service `disableMfa(userId, password)` flow
  // (in modules/auth/mfa.service.ts) requires the user to authenticate AND
  // know their password. When a customer admin loses BOTH their TOTP device
  // AND every recovery code they cannot log in at all (login forces TOTP
  // before issuing a session), so the password-step-up path is unreachable.
  // The only previous recovery was direct psql access — which bricks the
  // tenant for the duration of the on-call response.
  //
  // This route is the unbrick path: another ADMIN in the SAME tenant can
  // force-disable MFA on the locked-out user. The caller's session is itself
  // gated by `requireMfa` (route-level), so a stolen ADMIN session alone is
  // not sufficient to clear another admin's second factor. We also block
  // self-targeting — the caller must use the password-stepped self flow, not
  // this admin override, on their own account (otherwise an attacker who
  // captured an ADMIN session could clear their victim's own MFA and pivot).
  //
  // Side effects:
  //   - mfa_enabled = false, mfa_secret_enc = null, mfa_recovery_hashes = null
  //   - all live RefreshTokens revoked → target must re-login (and re-enrol
  //     MFA before being allowed back into MFA-gated routes via the org
  //     enforcement layer).
  //   - audit row `auth.mfa.force_disabled_by_admin` with actor + target +
  //     reason captured in `after.metadata.reason` for forensic review.
  async adminDisableMfa(
    tenantId: string,
    targetUserId: string,
    actorId: string,
    reason: string,
    db?: DB,
  ): Promise<void> {
    // Self-guard FIRST so the 403 is consistent regardless of whether the
    // target row exists. Prevents a captured-session attacker from clearing
    // their own MFA via this endpoint (they'd have to re-prove password via
    // `/auth/mfa/disable`).
    if (actorId === targetUserId) {
      throw Forbidden(
        'Use /auth/mfa/disable with your current password to disable your own MFA',
      );
    }

    const target = await scoped(tenantId, db, (c) =>
      c.user.findFirst({
        where: { tenant_id: tenantId, id: targetUserId, deleted_at: null },
        select: { id: true, mfa_enabled: true },
      }),
    );
    if (!target) throw NotFound('User not found');
    // Snapshot the pre-mutation state for the audit row. We capture this BEFORE
    // the updateMany below because some Prisma test doubles return live row
    // references that get mutated in place by the update; reading
    // `target.mfa_enabled` after the update would silently report the new (false)
    // value and lose forensic signal.
    const wasEnabled = target.mfa_enabled;

    // Idempotency tolerance: if MFA is already off we still clear any stale
    // secret/recovery state and revoke tokens — the runbook caller may have
    // partially completed the recovery in a previous attempt. Writing the
    // audit row regardless captures the operator intent.
    await scoped(tenantId, db, (c) =>
      c.user.updateMany({
        where: { tenant_id: tenantId, id: targetUserId, deleted_at: null },
        data: {
          mfa_enabled: false,
          mfa_secret_enc: null,
          mfa_recovery_hashes: null,
        },
      }),
    );

    // Force the target to re-login. Any live session must not be allowed to
    // continue without going through fresh authentication — otherwise the
    // target's MFA-gated step-up checks would silently pass (no MFA enrolled =
    // pass-through in requireMfa).
    // SVT-QA-2026-08 — also stamp sessions_valid_from so live access tokens
    // for the target user are rejected within one cache cycle instead of
    // surviving to their 15-min TTL. Force-disable is a security event that
    // must invalidate every credential of any type immediately.
    const now = new Date();
    // SVT-RLS-2026-05 — tenant_id in the where on BOTH writes.
    // Stamp first (see revokeAllSessions for the ordering rationale).
    await scoped(tenantId, db, (c) =>
      c.user.updateMany({
        where: { id: targetUserId, tenant_id: tenantId },
        data: { sessions_valid_from: now },
      }),
    );
    await scoped(tenantId, db, (c) =>
      c.refreshToken.updateMany({
        where: { user_id: targetUserId, revoked_at: null },
        data: { revoked_at: now },
      }),
    );
    const { invalidateSessionsValidFrom } = await import('../../middlewares/auth.js');
    invalidateSessionsValidFrom(targetUserId);

    await writeAudit({
      action: 'auth.mfa.force_disabled_by_admin',
      entityType: 'user',
      entityId: targetUserId,
      actorId,
      tenantId,
      after: {
        target_user_id: targetUserId,
        reason,
        was_enabled: wasEnabled,
      },
    } as never);
  },
};
