// SVT-SEC-2026-05 — MFA enrol / verify / disable.
//
// Three-phase TOTP enrolment:
//
//   1. setupMfa(userId) →
//      - Generate fresh 160-bit Base32 secret.
//      - Encrypt with tenant DEK (envelope) → store on user.mfa_secret_enc.
//      - Leave user.mfa_enabled=false until verify completes.
//      - Return otpauth:// URI + base32 secret for manual entry.
//      - Subsequent calls re-mint (rotate) until verified.
//
//   2. verifyAndEnableMfa(userId, code) →
//      - Decrypt secret, verifyTotp(secret, code) (±1 step skew).
//      - On success: user.mfa_enabled=true.
//      - Mint 10 recovery codes (random base32, 10 chars each),
//        store SHA-256 hashes — comma-joined into user.mfa_recovery_hashes
//        column (single column avoids a migration for v1; each hash is 64
//        hex chars, 10 codes = 650 chars, fits text easily).
//      - Return the 10 raw codes ONCE — the user MUST copy them down.
//
//   3. disableMfa(userId, password) →
//      - Re-verify password (step-up auth — never allow MFA disable on
//        a session alone).
//      - Clear mfa_secret_enc + mfa_enabled + recovery hashes.
//      - Audit row.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { prisma } from '../../config/db.js';
import { BadRequest, Conflict, Forbidden, Unauthorized } from '../../shared/errors.js';
import { encryptField, decryptField } from '../../shared/encryption.js';
import { verifyPassword } from '../../shared/passwords.js';
import { generateTotpSecret, totpUri, verifyTotp } from './auth.totp.js';
import { writeAudit } from '../../shared/audit.js';

const ISSUER = 'SVT';

/** Base32 alphabet (RFC 4648) — no padding. Used for recovery codes. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function mintRecoveryCode(): string {
  const buf = randomBytes(8);
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += B32[buf[i % buf.length]! % 32];
  }
  // Hyphen for readability: XXXXX-XXXXX
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

function hashRecoveryCode(code: string): string {
  // Strip hyphens before hashing so users can paste with or without.
  return createHash('sha256').update(code.replace(/-/g, '').toUpperCase()).digest('hex');
}

// SVT-SEC-MFA-SETUP-PASSWORD-2026-05 (P0-3) — setupMfa MUST verify the
// caller's current password before rotating the TOTP secret. Without this,
// a hijacked session can complete enrolment with the attacker's
// authenticator (POST /mfa/setup → POST /mfa/verify) and permanently bind
// the victim's account to the attacker's device. Adding `currentPassword`
// closes the pivot — a stolen access token alone is insufficient because
// the attacker also has to present the password.
export async function setupMfa(
  userId: string,
  currentPassword: string,
): Promise<{
  secret: string;
  otpauth_url: string;
  status: 'PENDING_VERIFICATION';
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      tenant_id: true,
      email: true,
      mfa_enabled: true,
      password_hash: true,
    },
  });
  if (!user) throw Unauthorized('Invalid session');
  if (user.mfa_enabled) {
    throw Conflict('MFA already enabled; disable before re-enrolling');
  }
  if (!currentPassword || typeof currentPassword !== 'string') {
    throw Unauthorized('Current password is required to start MFA enrolment');
  }
  // Step-up auth: reject 401 if the password doesn't match BEFORE we mint /
  // store a new secret. We intentionally do not increment the lockout
  // counter here — failed setupMfa attempts are not a credential-stuffing
  // surface (the attacker already has a valid access token to even reach
  // this endpoint), and a noisy enrolment retry by a legitimate user
  // shouldn't lock them out of regular login.
  const ok = await verifyPassword(user.password_hash, currentPassword);
  if (!ok) {
    await writeAudit({
      action: 'auth.mfa.setup_password_failed',
      entityType: 'user',
      entityId: userId,
      actorId: userId,
      tenantId: user.tenant_id,
    } as never);
    throw Unauthorized('Current password is incorrect');
  }

  const secret = generateTotpSecret();
  // encryptField is tenant-agnostic now (the wrapped DEK self-describes the
  // tenant via the KMS layer). Match middlewares/requireMfa.ts which uses the
  // single-arg form.
  const enc = await encryptField(Buffer.from(secret, 'utf8'));
  await prisma.user.update({
    where: { id: userId },
    data: { mfa_secret_enc: enc, mfa_enabled: false },
  });
  await writeAudit({
    action: 'auth.mfa.setup_started',
    entityType: 'user',
    entityId: userId,
    actorId: userId,
    tenantId: user.tenant_id,
  } as never);
  return {
    secret,
    otpauth_url: totpUri(secret, user.email, ISSUER),
    status: 'PENDING_VERIFICATION',
  };
}

export async function verifyAndEnableMfa(
  userId: string,
  code: string,
): Promise<{ enabled: boolean; recovery_codes: string[] }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, tenant_id: true, mfa_secret_enc: true, mfa_enabled: true },
  });
  if (!user) throw Unauthorized('Invalid session');
  if (user.mfa_enabled) {
    throw Conflict('MFA already enabled');
  }
  if (!user.mfa_secret_enc) {
    throw BadRequest('MFA setup not started; call /auth/mfa/setup first');
  }
  // decryptField returns the UTF-8 plaintext directly (matches the new
  // tenant-agnostic API used by middlewares/requireMfa.ts).
  const secret = await decryptField(Buffer.from(user.mfa_secret_enc));
  if (!verifyTotp(secret, code)) {
    throw Unauthorized('Invalid MFA code');
  }
  // Mint 10 recovery codes; persist sha256 hashes joined by comma in
  // users.mfa_recovery_hashes (SVT-SEC-MFA-RECOVERY-2026-05 — migration
  // 20991231235980a_mfa_recovery_hashes). The raw codes are returned to the
  // caller ONCE in this response; they are never persisted in plaintext.
  const codes = Array.from({ length: 10 }, () => mintRecoveryCode());
  const recoveryHashesCsv = codes.map(hashRecoveryCode).join(',');
  await prisma.user.update({
    where: { id: userId },
    data: {
      mfa_enabled: true,
      mfa_recovery_hashes: recoveryHashesCsv,
    },
  });
  await writeAudit({
    action: 'auth.mfa.enabled',
    entityType: 'user',
    entityId: userId,
    actorId: userId,
    tenantId: user.tenant_id,
    // Record the hash count only — never log the hashes themselves
    // (preimage of a hash is still 50 bits of attacker leverage).
    after: { recovery_code_count: codes.length },
  } as never);
  return { enabled: true, recovery_codes: codes };
}

export async function disableMfa(
  userId: string,
  currentPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, tenant_id: true, password_hash: true, mfa_enabled: true },
  });
  if (!user) throw Unauthorized('Invalid session');
  if (!user.mfa_enabled) {
    throw Conflict('MFA is not enabled');
  }
  // Step-up auth: never allow MFA disable on a session alone.
  const ok = await verifyPassword(user.password_hash, currentPassword);
  if (!ok) throw Forbidden('Password verification failed');
  // SVT-QA-2026-08 — disabling MFA is a security-posture downgrade; force
  // all live sessions (access + refresh) to re-authenticate to prevent a
  // stolen-token attacker from silently benefiting from the weaker posture.
  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        mfa_enabled: false,
        mfa_secret_enc: null,
        mfa_recovery_hashes: null,
        sessions_valid_from: now,
      },
    }),
    prisma.refreshToken.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: now },
    }),
  ]);
  const { invalidateSessionsValidFrom } = await import('../../middlewares/auth.js');
  invalidateSessionsValidFrom(userId);
  await writeAudit({
    action: 'auth.mfa.disabled',
    entityType: 'user',
    entityId: userId,
    actorId: userId,
    tenantId: user.tenant_id,
  } as never);
}

/**
 * Constant-time recovery-code check. Used at login when the user's authenticator
 * device is lost. Each code is single-use — we rotate the stored hash list to
 * remove the matched entry. Returns true when a match was consumed.
 *
 * SVT-SEC-MFA-RECOVERY-2026-05 — backed by users.mfa_recovery_hashes (comma-
 * joined sha256 hex hashes). Matching is constant-time across the list so an
 * attacker cannot use timing to confirm "you got close to one of the hashes".
 * Already-consumed codes are simply absent from the list — re-use returns
 * false naturally.
 *
 * Returns false on: MFA disabled, no hashes stored, code malformed, or no
 * match (including re-use of a previously consumed code). The caller (login
 * flow in auth.service) maps `false` to a generic 401 and increments the
 * failed-login counter so brute force gets locked out.
 */
export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  if (!code || typeof code !== 'string') return false;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, mfa_enabled: true, mfa_recovery_hashes: true },
  });
  if (!user || !user.mfa_enabled || !user.mfa_recovery_hashes) return false;

  const candidate = hashRecoveryCode(code);
  const candidateBuf = Buffer.from(candidate, 'hex');
  // sha256 hex must be 64 chars (32 bytes). Anything else => malformed input.
  if (candidateBuf.length !== 32) return false;

  const hashes = user.mfa_recovery_hashes.split(',').filter((h) => h.length === 64);

  // Constant-time scan: compare against EVERY hash so the elapsed time does
  // not leak the position (or presence) of a match. We still bail out the
  // first match — the only attacker signal we'd be leaking is "this code is
  // in your list", which is unavoidable for any consume-on-match semantics.
  let matchIdx = -1;
  for (let i = 0; i < hashes.length; i++) {
    const stored = Buffer.from(hashes[i]!, 'hex');
    if (stored.length === 32 && timingSafeEqual(stored, candidateBuf) && matchIdx === -1) {
      matchIdx = i;
    }
  }
  if (matchIdx === -1) return false;

  // Atomically rewrite the hash list, dropping the matched entry. We guard
  // against a concurrent consume of the SAME code (race window between the
  // findUnique above and this update) by using the previous CSV as a WHERE
  // predicate — if it changed, the update is a no-op and we report failure
  // so the caller treats it as "already consumed".
  const remaining = hashes.filter((_, i) => i !== matchIdx);
  const nextCsv = remaining.length > 0 ? remaining.join(',') : '';
  const updated = await prisma.user.updateMany({
    where: { id: userId, mfa_recovery_hashes: user.mfa_recovery_hashes },
    data: { mfa_recovery_hashes: nextCsv },
  });
  return updated.count === 1;
}

export const __test__ = { mintRecoveryCode, hashRecoveryCode, timingSafeEqual };
