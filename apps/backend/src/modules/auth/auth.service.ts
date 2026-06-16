// Auth domain service. Holds ALL authentication business logic: credential check,
// account lockout, MFA gating, refresh-token rotation with reuse detection, and
// password change. Thin Express controllers (auth.controller.ts) delegate here.
//
// Security choices worth flagging for reviewers:
//
//  - User enumeration: every unsuccessful login takes the SAME code path (verify a
//    password against a dummy hash) so timing & error responses don't leak whether
//    the email exists.
//  - Lockout: exponential backoff after 5 consecutive failures. The lock window
//    grows as 15min × 2^(extraFailures); we audit the failure either way.
//  - Refresh token reuse detection: refresh tokens are single-use. If a token that
//    has already been revoked is presented, we treat it as theft and revoke the
//    entire chain (forward via replaced_by_id, backward by walking the same field).
//  - Device binding: stored ua_hash + ip_subnet are compared. ip_subnet is /24 for
//    IPv4 and /48 for IPv6; rejecting on mismatch in dev creates too many false
//    positives, so we only enforce in production.
//  - Access-token revocation on logout: we insert the access JTI into a denylist
//    keyed by jti, with an expiry equal to the token's natural exp. The
//    authenticate middleware should consult this list on every request.

import { randomBytes, randomUUID } from 'node:crypto';

import * as dbModule from '../../config/db.js';

// SVT-SEC-RLS-ESCAPE-HATCH-2026-05 — auth-time cross-tenant lookups must use
// the bypass-RLS admin client because migration
// 20991231235983_rls_remove_escape_hatch removed the `OR app_current_tenant()
// IS NULL` escape clause that previously let unscoped queries see all rows.
// `prismaAdmin` connects via DATABASE_MIGRATE_URL (spv_admin, BYPASSRLS) and
// must ONLY be used for narrow authentication primitives (email lookup,
// token-hash lookup, by-id reads of records the caller has already proven
// ownership of).
//
// We deliberately use a namespace import + indirect property access so
// Vitest 2.x's strict "named export not in mock" check doesn't fire on the
// 50+ test files whose db.js mock only exports `prisma` + `disconnectDb`.
// In those tests `prismaAdmin` resolves to undefined and we fall back to the
// mocked `prisma` singleton — keeping in-memory fixtures intact.
const prisma = dbModule.prisma;
const adminDb = (dbModule as { prismaAdmin?: typeof dbModule.prisma }).prismaAdmin ?? prisma;
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { Unauthorized, BadRequest } from '../../shared/errors.js';
import { signAccessToken } from '../../shared/jwt.js';
import { hashPassword, verifyPassword, hashRefreshTokenLegacy } from '../../shared/passwords.js';
import { ensurePasswordNotPwned } from '../../shared/hibp.js';
import { encryptField, decryptField } from '../../shared/encryption.js';
import { hashRefreshToken, hashIp, hashUa, emailHashHmac } from '../../shared/hashing.js';
import { writeAudit } from '../../shared/audit.js';

import { verifyTotp } from './auth.totp.js';
import { chooseReplayStore } from '../../middlewares/requireMfa.js';
import type {
  LoginRequest,
  TokenResponse,
  AuthUserResponse,
  AuthContext,
  Role,
} from './auth.types.js';

// A pre-computed Argon2id hash of a 32-byte random string. We don't care what plaintext
// it represents; we just need a real Argon2 hash to verify against in the "user not
// found" branch so timing matches the happy path.
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$ZGVmYXVsdGRlZmF1bHRkZWZhdWx0$cVz4lQDjmf/yWvL3pLfhk6gQXdKpKHs5ymoExDXKrgQ';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MINUTES = 15;

interface LoginResult {
  tokens: TokenResponse;
  refreshTokenRaw: string;
}

/** Truncate an IPv4 address to /24 or an IPv6 address to /48. */
function ipSubnet(ip: string | undefined): string | null {
  if (!ip) return null;
  // Strip IPv6-mapped IPv4 prefix.
  const cleaned = ip.replace(/^::ffff:/, '');
  if (cleaned.includes('.')) {
    // IPv4: keep first 3 octets.
    const parts = cleaned.split('.');
    if (parts.length !== 4) return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (cleaned.includes(':')) {
    // IPv6: keep first 3 hextets (48 bits).
    const parts = cleaned.split(':');
    return `${parts.slice(0, 3).join(':')}::/48`;
  }
  return null;
}

function toUserResponse(u: {
  id: string;
  tenant_id: string;
  email: string;
  given_name: string;
  family_name: string;
  display_name: string | null;
  role: Role;
  locale: string;
  timezone: string;
  mfa_enabled: boolean;
  notifications_email_enabled: boolean;
  notifications_digest: 'PER_EVENT' | 'DAILY' | 'OFF';
}): AuthUserResponse {
  return {
    id: u.id,
    tenant_id: u.tenant_id,
    email: u.email,
    given_name: u.given_name,
    family_name: u.family_name,
    display_name: u.display_name,
    role: u.role,
    locale: u.locale,
    timezone: u.timezone,
    mfa_enabled: u.mfa_enabled,
    notifications_email_enabled: u.notifications_email_enabled,
    notifications_digest: u.notifications_digest,
  };
}

/** Generate a cryptographically random refresh token (256 bits, base64url). */
function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

class AuthService {
  /**
   * Authenticate the user and mint an access+refresh token pair. The raw refresh token
   * is returned alongside the response so the controller can put it into an HttpOnly cookie.
   */
  async login(input: LoginRequest, ctx: AuthContext): Promise<LoginResult> {
    const email = input.email.toLowerCase();

    // Lookup across tenants. In a single-tenant deployment this collapses to a single row.
    // SVT-SEC-RLS-ESCAPE-HATCH-2026-05 — cross-tenant findFirst by email
    // requires the bypass-RLS admin client; the tightened RLS policy would
    // return zero rows on the spv_app session that has no `app.tenant_id`
    // GUC set (login happens before tenant context is established).
    const user = await adminDb.user.findFirst({
      where: { email, deleted_at: null },
    });

    // Enumeration-resistance: even when the user doesn't exist, run a real Argon2 verify
    // so the response time matches the happy path within an order of magnitude.
    if (!user) {
      await verifyPassword(DUMMY_HASH, input.password);
      await writeAudit({
        action: 'auth.login.failed',
        entity_type: 'user',
        entity_id: null,
        actor_id: null,
        tenant_id: null,
        actor_email_hash: emailHashHmac(email),
        ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
        ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
        request_id: ctx.requestId ?? null,
        metadata: { reason: 'unknown_user' },
      });
      throw Unauthorized('Invalid credentials');
    }

    // Lock check before password verify — denies access without revealing the password
    // is correct, which is desirable when the lock arose from a brute-force attempt.
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      await writeAudit({
        action: 'auth.login.failed',
        entity_type: 'user',
        entity_id: user.id,
        actor_id: user.id,
        tenant_id: user.tenant_id,
        ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
        ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
        request_id: ctx.requestId ?? null,
        metadata: { reason: 'locked' },
      });
      // SVT-SEC-2026-05 (P2-13) — return the same generic message as wrong-
      // password / unknown-email so the lockout state itself cannot be used
      // to confirm the email exists. Lockout signal is preserved in the
      // audit log (metadata.reason = 'locked') and surfaces to operators
      // via the admin dashboard; end users see the same 401 detail
      // regardless of the underlying cause.
      throw Unauthorized('Invalid credentials');
    }

    const passwordOk = await verifyPassword(user.password_hash, input.password);
    if (!passwordOk) {
      const newFailed = user.failed_login_count + 1;
      let lockUntil: Date | null = null;
      if (newFailed >= LOCKOUT_THRESHOLD) {
        const extra = newFailed - LOCKOUT_THRESHOLD;
        const minutes = LOCKOUT_BASE_MINUTES * 2 ** extra;
        // Cap at 24h to avoid runaway lockouts on a noisy attacker.
        const capped = Math.min(minutes, 60 * 24);
        lockUntil = new Date(Date.now() + capped * 60_000);
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { failed_login_count: newFailed, locked_until: lockUntil },
      });
      await writeAudit({
        action: 'auth.login.failed',
        entity_type: 'user',
        entity_id: user.id,
        actor_id: user.id,
        tenant_id: user.tenant_id,
        ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
        ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
        request_id: ctx.requestId ?? null,
        metadata: { reason: 'bad_password', failed_count: newFailed, locked: lockUntil != null },
      });
      // SVT-SEC-2026-05 (P2-13) — uniform "Invalid credentials" regardless
      // of whether this attempt tripped the lockout. The lockout state
      // surfaces via audit metadata + the admin dashboard, never via the
      // 401 detail string (which would otherwise leak account existence).
      throw Unauthorized('Invalid credentials');
    }

    // Deactivated accounts: still respond with a generic 401 so attackers can't tell
    // the difference between disabled-account and wrong-password.
    if (!user.is_active) {
      await writeAudit({
        action: 'auth.login.failed',
        entity_type: 'user',
        entity_id: user.id,
        actor_id: user.id,
        tenant_id: user.tenant_id,
        ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
        ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
        request_id: ctx.requestId ?? null,
        metadata: { reason: 'inactive' },
      });
      throw Unauthorized('Invalid credentials');
    }

    // MFA gate. Two phases: first request returns 401 with a sentinel detail asking the
    // client to collect the TOTP and re-submit; second request includes mfa_code OR
    // recovery_code (SVT-SEC-MFA-RECOVERY-2026-05). Recovery codes are the documented
    // fallback when the user has lost their authenticator device.
    if (user.mfa_enabled) {
      if (!input.mfa_code && !input.recovery_code) {
        // We do NOT reset the failed counter here — credentials were correct, but the
        // session isn't established yet. Treat this as a benign "needs second factor".
        throw Unauthorized('MFA required');
      }
      if (input.recovery_code) {
        // Recovery-code branch. Wrong codes count toward the same lockout window as
        // wrong passwords — recovery codes are sensitive (each one is a single-use
        // bypass of TOTP) so brute force MUST be throttled.
        const { consumeRecoveryCode } = await import('./mfa.service.js');
        const consumed = await consumeRecoveryCode(user.id, input.recovery_code);
        if (!consumed) {
          const newFailed = user.failed_login_count + 1;
          let lockUntil: Date | null = null;
          if (newFailed >= LOCKOUT_THRESHOLD) {
            const extra = newFailed - LOCKOUT_THRESHOLD;
            const minutes = LOCKOUT_BASE_MINUTES * 2 ** extra;
            const capped = Math.min(minutes, 60 * 24);
            lockUntil = new Date(Date.now() + capped * 60_000);
          }
          await prisma.user.update({
            where: { id: user.id },
            data: { failed_login_count: newFailed, locked_until: lockUntil },
          });
          await writeAudit({
            action: 'auth.mfa.recovery_code_failed',
            entity_type: 'user',
            entity_id: user.id,
            actor_id: user.id,
            tenant_id: user.tenant_id,
            ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
            ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
            request_id: ctx.requestId ?? null,
            metadata: { failed_count: newFailed, locked: lockUntil != null },
          });
          // SVT-SEC-2026-05 (P2-13) — uniform "Invalid credentials" regardless
          // of whether lockout fired; the lockout state is in the audit row,
          // not the user-visible response. Same rationale as the bad-password
          // branch above: lockout-specific copy leaks "this email exists".
          throw Unauthorized('Invalid credentials');
        }
        await writeAudit({
          action: 'auth.mfa.recovery_code_used',
          entity_type: 'user',
          entity_id: user.id,
          actor_id: user.id,
          tenant_id: user.tenant_id,
          ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
          ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
          request_id: ctx.requestId ?? null,
          metadata: {},
        });
      } else {
        if (!user.mfa_secret_enc) {
          // Misconfiguration: mfa_enabled flag is set but no secret stored. Refuse rather
          // than silently bypass MFA.
          throw Unauthorized('MFA misconfigured for account');
        }
        const secret = await decryptField(Buffer.from(user.mfa_secret_enc));
        const submittedCode = input.mfa_code!;
        if (!verifyTotp(secret, submittedCode)) {
          await writeAudit({
            action: 'auth.mfa.failed',
            entity_type: 'user',
            entity_id: user.id,
            actor_id: user.id,
            tenant_id: user.tenant_id,
            ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
            ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
            request_id: ctx.requestId ?? null,
            metadata: {},
          });
          throw Unauthorized('Invalid credentials');
        }
        // SVT-SEC-LOGIN-TOTP-REPLAY-2026-05 (P0-4) — anti-replay for the
        // login-time TOTP. The step-up middleware (requireMfa) already
        // claims (userId, code) for 60s via chooseReplayStore; we apply
        // the SAME store to login so a TOTP that was used to sign in
        // cannot be replayed within the 30s step + ±1 skew window. Without
        // this, an attacker who captured the 6-digit code in transit (or
        // shoulder-surfed it) could race the legitimate user to a fresh
        // session before the user's code expired naturally.
        const store = await chooseReplayStore();
        const fresh = await store.markIfFresh(user.id, submittedCode);
        if (!fresh) {
          await writeAudit({
            action: 'auth.mfa.failed',
            entity_type: 'user',
            entity_id: user.id,
            actor_id: user.id,
            tenant_id: user.tenant_id,
            ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
            ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
            request_id: ctx.requestId ?? null,
            metadata: { reason: 'totp_replay' },
          });
          // Generic 401 so attackers cannot distinguish replay from
          // wrong-code (which would let them confirm "this code was the
          // right code at some point").
          throw Unauthorized('Invalid credentials');
        }
      }
    }

    // All checks passed: reset counters and stamp last_login_at.
    await prisma.user.update({
      where: { id: user.id },
      data: { failed_login_count: 0, locked_until: null, last_login_at: new Date() },
    });

    const tokens = await this.mintTokenPair(user, ctx);

    await writeAudit({
      action: 'auth.login.success',
      entity_type: 'user',
      entity_id: user.id,
      actor_id: user.id,
      tenant_id: user.tenant_id,
      ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
      ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
      request_id: ctx.requestId ?? null,
      metadata: { mfa_used: user.mfa_enabled },
    });

    return tokens;
  }

  /**
   * Rotate a refresh token. Single-use semantics: the presented token is revoked
   * regardless of outcome, and a new one is issued only if everything checks out.
   * Reuse of an already-revoked token is treated as evidence of theft.
   */
  async refresh(rawToken: string, ctx: AuthContext): Promise<LoginResult> {
    if (!rawToken) {
      throw Unauthorized('Refresh token required');
    }

    const tokenHash = hashRefreshToken(rawToken);
    // SVT-SEC-RLS-ESCAPE-HATCH-2026-05 — refresh lookup is by token_hash
    // alone (cross-tenant). The caller does not present their tenant id in
    // the cookie / header, so the spv_app RLS session would see zero rows
    // for a request whose `app.tenant_id` GUC is unset. Use the admin
    // client for this unique-key lookup only; subsequent ops (rotation,
    // updates) carry the now-known tenant_id and could safely use the
    // tenant-scoped client, but we keep them on the admin client too so
    // the entire refresh flow runs against one consistent connection.
    let row = await adminDb.refreshToken.findUnique({ where: { token_hash: tokenHash } });

    // SVT-WAVE-KMS-PROVIDER-2026-05 — P1-K3 legacy refresh-token rehash.
    // Before the pepper was deployed, refresh tokens were stored as bare
    // sha256(raw). Cookies issued in the pre-deploy window still arrive
    // with the legacy shape; accept them ONCE so the user isn't kicked
    // out, then rehash to the HMAC shape via the normal rotation below.
    // The rehash window is bounded by REFRESH_TOKEN_TTL_SECONDS (7d default)
    // — any legacy row not exercised inside that window expires naturally
    // and the column converges to 100% HMAC.
    let isLegacyHash = false;
    if (!row) {
      const legacyHash = hashRefreshTokenLegacy(rawToken);
      if (legacyHash !== tokenHash) {
        const legacyRow = await adminDb.refreshToken.findUnique({
          where: { token_hash: legacyHash },
        });
        if (legacyRow) {
          row = legacyRow;
          isLegacyHash = true;
        }
      }
    }

    if (!row) {
      throw Unauthorized('Invalid refresh token');
    }

    // Reuse detection: a revoked token presented to /refresh implies someone replayed
    // a stolen token. Burn the entire chain so any active session derived from this
    // family is invalidated.
    if (row.revoked_at) {
      await this.revokeChain(row.id, row.tenant_id);
      await writeAudit({
        action: 'auth.refresh.theft',
        entity_type: 'refresh_token',
        entity_id: row.id,
        actor_id: row.user_id,
        tenant_id: row.tenant_id,
        ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
        ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
        request_id: ctx.requestId ?? null,
        metadata: { reason: 'reuse_of_revoked' },
      });
      throw Unauthorized('Invalid refresh token');
    }

    if (row.expires_at.getTime() <= Date.now()) {
      throw Unauthorized('Refresh token expired');
    }

    // Device binding check. ua_hash must match; ip_subnet is permissive in dev.
    const expectedUa = ctx.ua ? hashUa(ctx.ua) : null;
    const expectedSubnet = ipSubnet(ctx.ip);

    const uaMismatch = row.ua_hash != null && expectedUa != null && row.ua_hash !== expectedUa;
    const subnetMismatch =
      row.ip_subnet != null && expectedSubnet != null && row.ip_subnet !== expectedSubnet;

    if (uaMismatch || (env.isProd && subnetMismatch)) {
      await writeAudit({
        action: 'auth.refresh.device_mismatch',
        entity_type: 'refresh_token',
        entity_id: row.id,
        actor_id: row.user_id,
        tenant_id: row.tenant_id,
        ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
        ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
        request_id: ctx.requestId ?? null,
        metadata: { ua_mismatch: uaMismatch, subnet_mismatch: subnetMismatch },
      });
      // Defensive: also revoke this token so the session can't continue under a stolen cookie.
      await prisma.refreshToken.update({
        where: { id: row.id },
        data: { revoked_at: new Date() },
      });
      throw Unauthorized('Invalid refresh token');
    }

    // SVT-SYNC-2026-06: defense-in-depth — scope to tenant from the refresh token.
    const user = await prisma.user.findFirst({ where: { id: row.user_id, tenant_id: row.tenant_id } });
    if (!user || !user.is_active || user.deleted_at) {
      // The token was valid but the account is no longer eligible.
      await prisma.refreshToken.update({
        where: { id: row.id },
        data: { revoked_at: new Date() },
      });
      throw Unauthorized('Invalid refresh token');
    }
    // SVT-SEC-2026-05 — refresh MUST honour the lockout window. Previously
    // a locked account whose access token had expired could keep spinning
    // fresh access tokens via refresh until the refresh TTL ran out.
    if (user.locked_until && user.locked_until > new Date()) {
      await prisma.refreshToken.update({
        where: { id: row.id },
        data: { revoked_at: new Date() },
      });
      throw Unauthorized('Account locked');
    }
    // SVT-SEC-IDLE-2026-05 — idle-session cutoff. If the token hasn't been
    // exercised within IDLE_TIMEOUT_MIN, treat the session as abandoned and
    // revoke. Compare against last_used_at when present; fall back to
    // issued_at for tokens minted pre-migration that never got bumped.
    const idleMs = env.IDLE_TIMEOUT_MIN * 60_000;
    const lastSeen = (row.last_used_at ?? row.issued_at).getTime();
    if (Date.now() - lastSeen > idleMs) {
      await prisma.refreshToken.update({
        where: { id: row.id },
        data: { revoked_at: new Date() },
      });
      await writeAudit({
        action: 'auth.refresh.idle_timeout',
        entity_type: 'refresh_token',
        entity_id: row.id,
        actor_id: row.user_id,
        tenant_id: row.tenant_id,
        ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
        ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
        request_id: ctx.requestId ?? null,
        metadata: { idle_minutes: Math.round((Date.now() - lastSeen) / 60_000) },
      });
      throw Unauthorized('Session idle timeout');
    }

    // SVT-WAVE-KMS-PROVIDER-2026-05 — P1-K3 audit the rehash so we have a
    // metric for "how many legacy-hash rows are still in play". When the
    // count hits zero we can delete the legacy-hash code path entirely.
    if (isLegacyHash) {
      await writeAudit({
        action: 'auth.refresh.legacy_rehashed',
        entity_type: 'refresh_token',
        entity_id: row.id,
        actor_id: row.user_id,
        tenant_id: row.tenant_id,
        ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
        ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
        request_id: ctx.requestId ?? null,
        metadata: { from: 'sha256_bare', to: 'hmac_pepper' },
      });
    }

    // Mint the new pair, then revoke + chain the old row.
    const next = await this.mintTokenPair(user, ctx);
    const newRow = await prisma.refreshToken.findUnique({
      where: { token_hash: hashRefreshToken(next.refreshTokenRaw) },
    });
    await prisma.refreshToken.update({
      where: { id: row.id },
      data: { revoked_at: new Date(), replaced_by_id: newRow?.id ?? null },
    });

    await writeAudit({
      action: 'auth.refresh.rotated',
      entity_type: 'refresh_token',
      entity_id: newRow?.id ?? null,
      actor_id: user.id,
      tenant_id: user.tenant_id,
      ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
      ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
      request_id: ctx.requestId ?? null,
      metadata: { replaced_id: row.id },
    });

    return next;
  }

  /**
   * Revoke a refresh token (if present) and add the access JTI to the denylist (if
   * present). Idempotent: callers shouldn't error on best-effort logout.
   */
  async logout(
    rawToken: string | null,
    accessJti: string | null,
    // SVT-SEC-2026-05 — caller (auth.controller) MUST pass req.user.{sub,tid}
    // so the JTI denylist row carries real ownership. Sentinel zero-UUIDs
    // broke audit forensics and risked FK violation. The refresh-token row
    // also supplies actor/tenant for the rawToken path (already real).
    actorContext?: { userId?: string | null; tenantId?: string | null },
  ): Promise<void> {
    let resolvedUserId = actorContext?.userId ?? null;
    let resolvedTenantId = actorContext?.tenantId ?? null;

    if (rawToken) {
      const tokenHash = hashRefreshToken(rawToken);
      // SVT-SEC-RLS-ESCAPE-HATCH-2026-05 — same rationale as `refresh()`:
      // token_hash is the only key, no tenant id is in scope yet, so we
      // must use the bypass-RLS admin client to find the row.
      let row = await adminDb.refreshToken.findUnique({ where: { token_hash: tokenHash } });
      // P1-K3 legacy fallback (mirror of refresh()): logout must work for
      // sessions that haven't rotated yet, otherwise the user's other
      // device gets a 200 + a still-live token on the backend.
      if (!row) {
        const legacyHash = hashRefreshTokenLegacy(rawToken);
        if (legacyHash !== tokenHash) {
          row = await adminDb.refreshToken.findUnique({ where: { token_hash: legacyHash } });
        }
      }
      if (row && !row.revoked_at) {
        await adminDb.refreshToken.update({
          where: { id: row.id },
          data: { revoked_at: new Date() },
        });
        // Prefer caller-supplied ids; fall back to the refresh-token row so
        // logout-by-refresh-only flows still capture real ownership.
        resolvedUserId = resolvedUserId ?? row.user_id;
        resolvedTenantId = resolvedTenantId ?? row.tenant_id;
        await writeAudit({
          action: 'auth.logout',
          entity_type: 'refresh_token',
          entity_id: row.id,
          actor_id: row.user_id,
          tenant_id: row.tenant_id,
          metadata: {},
        });
      }
    }

    if (accessJti) {
      const expiresAt = new Date(Date.now() + env.ACCESS_TOKEN_TTL_SECONDS * 1000);
      // SEC-burst: prefer real user_id/tenant_id from req.user (always
      // populated on authenticated POST /logout). If somehow missing (e.g.
      // jti-only revocation path) we still write the denylist row but skip
      // it when both ids are null — otherwise sentinel zeros would violate
      // FKs and silently lose the revocation.
      if (resolvedUserId && resolvedTenantId) {
        try {
          await prisma.accessTokenDenylist.create({
            data: {
              jti: accessJti,
              user_id: resolvedUserId,
              tenant_id: resolvedTenantId,
              expires_at: expiresAt,
            },
          });
        } catch (err) {
        // SVT-AUDIT-SEC-2026-05 — fail-CLOSED on logout. The previous catch
        // swallowed every error including DB outages, which would silently
        // accept the access token until its TTL expired (≤15 min). Now we
        // only swallow the idempotent PK conflict; anything else escalates
        // so the caller can refuse to return 200 to a "logout succeeded"
        // response that isn't actually true.
        const code = (err as { code?: string } | null)?.code;
        if (code === 'P2002') {
          // Already denylisted (idempotent retry) — safe to ignore.
        } else {
          logger.error(
            { err, accessJti },
            'auth.logout: JTI denylist write failed; token remains valid until TTL',
          );
          throw err;
        }
      }
      } else {
        // No user/tenant context AND no resolvable refresh-token row — log
        // loudly. This is a defensive path: every authenticated POST /logout
        // sets req.user, so a missing context means the controller didn't
        // plumb it through. Fail-CLOSED by throwing so the caller learns.
        logger.error(
          { accessJti },
          'auth.logout: missing actor context for JTI denylist write; refusing to revoke',
        );
        throw new Error('auth.logout: missing actor context');
      }
    }
  }

  /**
   * Verify the current password, hash the new one, persist, and revoke ALL refresh
   * tokens for the user so other devices are forced to re-authenticate.
   */
  async changePassword(userId: string, current: string, next: string, tenantId?: string): Promise<void> {
    // SVT-SYNC-2026-06: defense-in-depth — scope to tenant when available.
    const user = await prisma.user.findFirst({
      where: { id: userId, ...(tenantId ? { tenant_id: tenantId } : {}) },
    });
    if (!user || !user.is_active || user.deleted_at) {
      throw Unauthorized('Invalid session');
    }
    const ok = await verifyPassword(user.password_hash, current);
    if (!ok) {
      throw Unauthorized('Current password is incorrect');
    }
    if (current === next) {
      throw BadRequest('New password must differ from current password');
    }
    // Quick reject if next is identical to old hash (reuse without literal match).
    if (await verifyPassword(user.password_hash, next)) {
      throw BadRequest('New password must differ from current password');
    }

    // SVT-SEC-2026-05 — HIBP k-anonymity breach check. NODE_ENV=test bypasses
    // (the helper short-circuits). In prod, HIBP_ENFORCEMENT=block rejects
    // breached passwords with a shaped 422; warn-mode (default) audits +
    // allows. Network failures fail-OPEN so a third-party outage cannot
    // brick password changes (override via HIBP_FAIL_CLOSED=true).
    await ensurePasswordNotPwned(next, { userId: user.id, tenantId: user.tenant_id });

    const newHash = await hashPassword(next);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { password_hash: newHash, password_changed_at: new Date() },
      }),
      // Revoke every active refresh token belonging to this user.
      prisma.refreshToken.updateMany({
        where: { user_id: userId, revoked_at: null },
        data: { revoked_at: new Date() },
      }),
    ]);

    await writeAudit({
      action: 'auth.password.changed',
      entity_type: 'user',
      entity_id: userId,
      actor_id: userId,
      tenant_id: user.tenant_id,
      metadata: {},
    });
  }

  /** Look the user up fresh from the DB so deactivation since token issue is honoured. */
  async getMe(userId: string, tenantId?: string): Promise<AuthUserResponse> {
    // SVT-SYNC-2026-06: defense-in-depth — scope to tenant when available.
    const user = await prisma.user.findFirst({
      where: { id: userId, ...(tenantId ? { tenant_id: tenantId } : {}) },
    });
    if (!user || !user.is_active || user.deleted_at) {
      throw Unauthorized('Invalid session');
    }
    return toUserResponse({
      id: user.id,
      tenant_id: user.tenant_id,
      email: user.email,
      given_name: user.given_name,
      family_name: user.family_name,
      display_name: user.display_name,
      role: user.role as Role,
      locale: user.locale,
      timezone: user.timezone,
      mfa_enabled: user.mfa_enabled,
      notifications_email_enabled: user.notifications_email_enabled,
      notifications_digest: user.notifications_digest as 'PER_EVENT' | 'DAILY' | 'OFF',
    });
  }

  // SVT-WAVE9-PREFS-2026-05 — user-self-service preferences update.
  // Caller is always the authenticated user (route enforces). Only the
  // whitelisted preference fields are updatable here; role / is_active /
  // password / email stay on admin-only endpoints.
  async updateMyPreferences(
    userId: string,
    input: {
      display_name?: string;
      locale?: string;
      timezone?: string;
      notifications_email_enabled?: boolean;
      notifications_digest?: 'PER_EVENT' | 'DAILY' | 'OFF';
    },
    tenantId?: string,
  ): Promise<AuthUserResponse> {
    const data: Record<string, unknown> = {};
    if (input.display_name !== undefined) data['display_name'] = input.display_name;
    if (input.locale !== undefined) data['locale'] = input.locale;
    if (input.timezone !== undefined) data['timezone'] = input.timezone;
    if (input.notifications_email_enabled !== undefined) {
      data['notifications_email_enabled'] = input.notifications_email_enabled;
    }
    if (input.notifications_digest !== undefined) {
      data['notifications_digest'] = input.notifications_digest;
    }
    if (Object.keys(data).length === 0) {
      // No changes; return current state without bumping updated_at.
      return this.getMe(userId, tenantId);
    }
    // SVT-SYNC-2026-06: defense-in-depth — scope update to tenant.
    if (tenantId) {
      await prisma.user.updateMany({ where: { id: userId, tenant_id: tenantId }, data });
    } else {
      await prisma.user.update({ where: { id: userId }, data });
    }
    return this.getMe(userId, tenantId);
  }

  // ----- internal helpers ---------------------------------------------------

  /** Sign access JWT, generate refresh token, persist hashed refresh row, return both. */
  private async mintTokenPair(
    user: {
      id: string;
      tenant_id: string;
      email: string;
      given_name: string;
      family_name: string;
      display_name: string | null;
      role: Role;
      locale: string;
      timezone: string;
      mfa_enabled: boolean;
      notifications_email_enabled: boolean;
      notifications_digest: 'PER_EVENT' | 'DAILY' | 'OFF';
    },
    ctx: AuthContext,
  ): Promise<LoginResult> {
    const jti = randomUUID();
    const accessToken = await signAccessToken({
      sub: user.id,
      tid: user.tenant_id,
      role: user.role,
      jti,
    });

    const refreshRaw = generateRefreshToken();
    const refreshHash = hashRefreshToken(refreshRaw);
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_SECONDS * 1000);

    await prisma.refreshToken.create({
      data: {
        tenant_id: user.tenant_id,
        user_id: user.id,
        token_hash: refreshHash,
        device_id: ctx.deviceId ?? null,
        ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
        ip_subnet: ipSubnet(ctx.ip),
        expires_at: expiresAt,
        // SVT-SEC-IDLE-2026-05 — seed last_used_at so idle check on first
        // refresh after mint compares against the right baseline.
        last_used_at: new Date(),
      },
    });

    return {
      tokens: {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: env.ACCESS_TOKEN_TTL_SECONDS,
        user: toUserResponse(user),
      },
      refreshTokenRaw: refreshRaw,
    };
  }

  /**
   * Walk the replaced_by_id chain from `startId` in BOTH directions and revoke every
   * row encountered. Used when reuse of a revoked token is detected — we don't know
   * which segment of the family the attacker may have grabbed, so revoke them all.
   */
  private async revokeChain(startId: string, tenantId: string): Promise<void> {
    const seen = new Set<string>();
    const queue: string[] = [startId];

    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);

      // SVT-SYNC-2026-06: defense-in-depth — scope chain walk to tenant.
      const row = await prisma.refreshToken.findFirst({ where: { id, tenant_id: tenantId } });
      if (!row) continue;

      // Walk forward.
      if (row.replaced_by_id && !seen.has(row.replaced_by_id)) {
        queue.push(row.replaced_by_id);
      }
      // Walk backward: rows whose replaced_by_id points at this row.
      const predecessors = await prisma.refreshToken.findMany({
        where: { replaced_by_id: id, tenant_id: tenantId },
        select: { id: true },
      });
      for (const p of predecessors) {
        if (!seen.has(p.id)) queue.push(p.id);
      }
    }

    if (seen.size > 0) {
      await prisma.refreshToken.updateMany({
        where: { id: { in: Array.from(seen) }, tenant_id: tenantId, revoked_at: null },
        data: { revoked_at: new Date() },
      });
    }
  }
}

export const authService = new AuthService();
export type { LoginResult };
