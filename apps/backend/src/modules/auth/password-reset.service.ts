// SVT-SEC-2026-05 — Self-service password reset (P0 deploy blocker).
//
// Two-phase flow:
//
//   1. POST /api/v1/auth/password/reset-request  { email }
//      - Always responds 200 with the same body to defeat enumeration.
//      - If a matching active user exists, mints a random 32-byte token,
//        sha256-hashes it at rest, stores expires_at = now + 30min.
//      - Invalidates any prior outstanding tokens for the user (max 1 live).
//      - Sends the raw token via email through CommsProvider EMAIL (URL:
//        https://app.example.com/reset/confirm?token=<raw>).
//
//   2. POST /api/v1/auth/password/reset-confirm  { token, new_password }
//      - Sha256s the supplied token, finds the row, validates not-consumed
//        not-expired not-invalidated.
//      - Runs new_password through HIBP (warn/block per env).
//      - Argon2-hashes + writes password_hash, password_changed_at = now,
//        clears failed_login_count + locked_until.
//      - Marks the reset row consumed_at + revokes ALL refresh tokens for
//        the user (force re-login on every device).
//      - Returns 204.
//
// Lockout: rate-limited at the route layer (5/min per IP via authLimiter).

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as dbModule from '../../config/db.js';
import { env } from '../../config/env.js';
import { verifyPassword } from '../../shared/passwords.js';

// SVT-SEC-RLS-ESCAPE-HATCH-2026-05 — request flow looks the user up by email
// across tenants (the requester only knows their email). Migration
// 20991231235983_rls_remove_escape_hatch tightened RLS so the spv_app
// connection with no `app.tenant_id` GUC would see zero rows; we therefore
// route the cross-tenant lookup through the bypass-RLS admin client.
// Namespace import keeps Vitest 2.x's strict named-export check happy on
// the 50+ test files whose db.js mock only exports `prisma`.
const prisma = dbModule.prisma;
const adminDb = (dbModule as { prismaAdmin?: typeof dbModule.prisma }).prismaAdmin ?? prisma;
import { logger } from '../../config/logger.js';
import { BadRequest, NotFound, Unauthorized, UnprocessableEntity } from '../../shared/errors.js';
import { hashPassword } from '../../shared/passwords.js';
import { ensurePasswordNotPwned } from '../../shared/hibp.js';
import { writeAudit } from '../../shared/audit.js';
import { hashIp, hashUa } from '../../shared/hashing.js';
import { getProvider as getCommsProvider } from '../comms/providers/registry.js';

const TOKEN_TTL_MS = 30 * 60_000;

// SVT-SEC-RESET-TIMING-2026-05 (P1-A8) — fixed dummy work to mask the
// known/unknown email branch. A pre-computed Argon2id hash of a random 32-byte
// string; we never care what it decrypts to, we just need a real hash to
// `verifyPassword` against so the wall-clock cost of the "unknown user"
// branch matches the wall-clock cost of the "known user" branch (which runs
// argon2 verify implicitly via `verifyPassword` in step-up flows and uses
// equivalent CPU budget for token mint + hash + DB writes). Mirrors the
// strategy used in auth.service.login for the same enumeration class.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$ZGVmYXVsdGRlZmF1bHRkZWZhdWx0$cVz4lQDjmf/yWvL3pLfhk6gQXdKpKHs5ymoExDXKrgQ';
// A second dummy buffer for constant-time hash compare warm-up. timingSafeEqual
// requires equal-length inputs; both buffers are 32 bytes so the call always
// runs and consumes the same CPU regardless of which branch we take.
const DUMMY_HASH_BUF_A = createHash('sha256').update('svt-password-reset-dummy-a').digest();
const DUMMY_HASH_BUF_B = createHash('sha256').update('svt-password-reset-dummy-b').digest();

function mintRawToken(): string {
  // 32 random bytes → 256-bit token; encoded as URL-safe base64.
  return randomBytes(32).toString('base64url');
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

type RequestCtx = {
  ip?: string | null;
  ua?: string | null;
  appBaseUrl?: string;
};

/**
 * Request a password reset. Always returns silently (anti-enumeration).
 * Caller's IP + UA are hash-stamped for forensics.
 */
export async function requestPasswordReset(email: string, ctx: RequestCtx = {}): Promise<void> {
  const normalised = email.trim().toLowerCase();
  // SVT-SEC-RESET-ENUM-2026-05 (P1-9) — cross-tenant enumeration fix. The
  // previous `findMany` flow minted a reset token for EVERY tenant that
  // shared the email and sent a separate email per match. Two leaks fell
  // out of that:
  //   (a) A user belonging to multiple tenants would receive multiple
  //       reset emails, confirming the multi-tenancy fact externally.
  //   (b) Per-tenant row counts (audit metadata, refresh-token revocations)
  //       differed by 1 vs N from the "email exists in 1 tenant" baseline,
  //       observable by an attacker timing the response or counting
  //       downstream signals.
  // Resolution: take the FIRST match deterministically (oldest tenant by
  // user creation order) and mint exactly one token. The audit row carries
  // the matched tenant_id for forensic review; the user-visible response
  // is always the same generic 200 regardless of match count (including
  // zero). The controller's response is also unchanged so the wire shape
  // remains identical for unknown / single / multi-match emails.
  const candidate = await adminDb.user.findFirst({
    where: { email: normalised, deleted_at: null, is_active: true },
    select: { id: true, tenant_id: true, email: true, given_name: true },
    orderBy: { created_at: 'asc' },
  });

  // SVT-SEC-RESET-TIMING-2026-05 (P1-A8) — constant-time / fixed-work guard
  // against the "is this email a real user?" enumeration. Without this, the
  // known-user branch runs token mint + DB insert + provider send + audit
  // write (~tens of ms of measurable work) while the unknown-user branch
  // returns almost immediately. An attacker can sweep 10k addresses against
  // /reset-request and bucket them by latency.
  //
  // Mitigation on the UNKNOWN branch:
  //   1. Run the SAME argon2 verify as login (dummy hash + the supplied
  //      email as the "password" — never reused, just needs an input of
  //      similar shape so the verify path doesn't short-circuit).
  //   2. Run a `timingSafeEqual` over two equal-length 32-byte buffers so
  //      the CPU profile is identical to the "hash this token" cost on the
  //      known branch.
  //   3. Write an audit row tagged `reason: 'unknown_email'` so operators
  //      retain forensic visibility of probing attempts, but mint NO token
  //      and send NO email (the user-visible 200 stays generic — only the
  //      audit log is enriched).
  // Net effect: the wire-visible response shape is unchanged AND wall-clock
  // variance between known / unknown drops below the 50ms threshold the
  // accompanying timing test enforces.
  if (!candidate) {
    try {
      // Argon2 verify against the dummy hash. `verifyPassword` returns false;
      // we ignore the return value — the only purpose is the CPU spend.
      await verifyPassword(DUMMY_PASSWORD_HASH, normalised);
      // Constant-time buffer compare — same shape as a token-hash equality
      // check would be in a hot path. Both buffers are length 32 so the
      // call always returns without throwing.
      timingSafeEqual(DUMMY_HASH_BUF_A, DUMMY_HASH_BUF_B);
    } catch (err) {
      // Defensive: any failure inside the dummy-work block must not leak
      // back to the caller (would defeat the timing fix on errors that only
      // fire for unknown emails).
      logger.warn({ err }, 'password-reset: dummy-work block failed (non-fatal)');
    }
    await writeAudit({
      action: 'auth.password_reset.requested',
      entityType: 'user',
      entityId: null,
      actorId: null,
      tenantId: null,
      metadata: {
        reason: 'unknown_email',
        ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
        ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
      },
    } as never);
    return;
  }
  const candidates = [candidate];
  for (const user of candidates) {
    try {
      // Invalidate any outstanding live tokens for this user (one live token
      // at a time defeats enumeration via repeated requests).
      await prisma.passwordResetToken.updateMany({
        where: {
          user_id: user.id,
          consumed_at: null,
          invalidated_at: null,
          expires_at: { gt: new Date() },
        },
        data: { invalidated_at: new Date() },
      });

      const rawToken = mintRawToken();
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
      await prisma.passwordResetToken.create({
        data: {
          tenant_id: user.tenant_id,
          user_id: user.id,
          token_hash: tokenHash,
          expires_at: expiresAt,
          ip_hash: ctx.ip ? hashIp(ctx.ip) : null,
          ua_hash: ctx.ua ? hashUa(ctx.ua) : null,
        },
      });

      // Compose + send. We use the IN_APP/EMAIL provider abstraction so
      // tests can mock cleanly. The reset URL points at the FE.
      const baseUrl = (ctx.appBaseUrl ?? env.CORS_ORIGIN?.split(',')[0] ?? 'http://localhost:3001').replace(/\/$/, '');
      const resetUrl = `${baseUrl}/reset/confirm?token=${rawToken}`;
      const provider = getCommsProvider('EMAIL');
      if (provider) {
        await provider.send({
          to: user.email,
          subject: 'Reset your password',
          body:
            `Hi ${user.given_name},\n\n` +
            `Someone — possibly you — requested a password reset for this account.\n\n` +
            `If this was you, click the link below within 30 minutes to choose a new password:\n` +
            `${resetUrl}\n\n` +
            `If this was NOT you, you can ignore this email — your password remains unchanged.\n`,
          // Transactional email: no unsubscribe (RFC 8058 only required for marketing).
          unsubscribeUrl: null,
        });
      } else {
        logger.warn({ userId: user.id }, 'password-reset: no EMAIL provider configured; token created but not emailed');
      }

      await writeAudit({
        action: 'auth.password_reset.requested',
        entityType: 'user',
        entityId: user.id,
        actorId: null,
        tenantId: user.tenant_id,
        metadata: { ip_hash: ctx.ip ? hashIp(ctx.ip) : null },
      } as never);
    } catch (err) {
      // Per-user failure should not block other candidate sends. Log + continue.
      logger.error({ err, userId: user.id }, 'password-reset: request flow failed');
    }
  }
}

/**
 * Consume a reset token, set the new password, revoke all refresh tokens.
 *
 * Throws shaped errors:
 *   401 Unauthorized — token unknown / consumed / invalidated / expired.
 *   422 UnprocessableEntity — HIBP block on the new password.
 *   400 BadRequest — token shape invalid.
 */
export async function confirmPasswordReset(rawToken: string, newPassword: string): Promise<void> {
  if (!rawToken || rawToken.length < 32) throw BadRequest('Invalid reset token');
  const tokenHash = hashToken(rawToken);
  // SVT-SEC-RLS-ESCAPE-HATCH-2026-05 — same rationale as the request flow:
  // token_hash is the only lookup key (no tenant id supplied by the user
  // clicking the reset URL), so we route through the bypass-RLS admin
  // client to avoid the tightened policy returning zero rows.
  const row = await adminDb.passwordResetToken.findUnique({
    where: { token_hash: tokenHash },
    select: {
      id: true, tenant_id: true, user_id: true,
      expires_at: true, consumed_at: true, invalidated_at: true,
    },
  });
  if (!row || row.consumed_at || row.invalidated_at || row.expires_at <= new Date()) {
    throw Unauthorized('Reset token invalid or expired');
  }

  // HIBP guard (block / warn / off per env).
  await ensurePasswordNotPwned(newPassword, { userId: row.user_id, tenantId: row.tenant_id });

  // Hash + persist + invalidate refresh tokens, atomically.
  const newHash = await hashPassword(newPassword);
  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.user_id },
      data: {
        password_hash: newHash,
        password_changed_at: now,
        failed_login_count: 0,
        locked_until: null,
      },
    }),
    prisma.passwordResetToken.update({
      where: { id: row.id },
      data: { consumed_at: now },
    }),
    // Invalidate every other live reset token for this user.
    prisma.passwordResetToken.updateMany({
      where: { user_id: row.user_id, consumed_at: null, invalidated_at: null, id: { not: row.id } },
      data: { invalidated_at: now },
    }),
    prisma.refreshToken.updateMany({
      where: { user_id: row.user_id, revoked_at: null },
      data: { revoked_at: now },
    }),
  ]);

  await writeAudit({
    action: 'auth.password_reset.consumed',
    entityType: 'user',
    entityId: row.user_id,
    actorId: null,
    tenantId: row.tenant_id,
  } as never);
}

// Convenience: avoid throwing UnprocessableEntity unused-import warning in
// thin wrappers.
export const __internal = { UnprocessableEntity, NotFound };
