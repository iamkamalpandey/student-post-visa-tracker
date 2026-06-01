// Hashing helpers used by audit logs, the RefreshToken store, the document store,
// and the hash-anchor job.
//
// Distinct use-cases:
//   1. sha256Hex / hmacHex — generic crypto primitives. sha256Hex is used by:
//        - documents/storage.ts (content-addressing of uploaded files; collision
//          resistance is the only property we need),
//        - jobs/hashAnchor.ts (Merkle-style folding of audit-log entry hashes;
//          again, plain SHA-256 is correct).
//      It is NO LONGER used for refresh-token storage — see (2).
//
//   2. hashRefreshToken — HMAC-SHA256(token, REFRESH_TOKEN_PEPPER). The refresh
//      token itself is a 256-bit random string, so pre-image attacks were
//      already infeasible. The HMAC pepper buys us a *secondary* guarantee:
//      a read-only DB leak (backup tape, replica snapshot, SQL-injection peek
//      at refresh_tokens.token_hash) does NOT let the attacker validate a
//      candidate token without ALSO having the pepper. Pepper rotation
//      crypto-shreds every refresh token (no DB migration — the new hash
//      simply won't match the old stored value, forcing every user to
//      re-authenticate). Required in production via the env schema; in dev
//      it falls back to a fixed dev-only constant so a missing .env doesn't
//      blow up startup.
//
//   3. hashIp / hashUa / emailHashHmac — log-correlation tokens. HMAC user-
//      identifying strings with CORRELATION_HMAC_KEY so attackers who
//      exfiltrate the audit table cannot recover the original IP / UA /
//      email by brute force, but operators can still ask "show me every
//      event from this IP" by computing the HMAC themselves.
//
//      SVT-WAVE-KMS-PROVIDER-2026-05 — this key is now INDEPENDENT of
//      JWT_PRIVATE_KEY. Previous design derived it from the JWT key, which
//      meant JWT rotation silently invalidated every IP/UA/email hash in
//      audit_logs (the operator could no longer pivot across the audit log
//      by IP after rotation because the "compute the same HMAC over a
//      candidate IP" step used a different key). With a dedicated
//      CORRELATION_HMAC_KEY, JWT rotation and correlation-namespace
//      rotation are now independent operations.

import { createHash, createHmac } from 'node:crypto';
import { env } from '../config/env.js';

/** Hex-encoded SHA-256. 64 chars. */
export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Hex-encoded HMAC-SHA-256. 64 chars. */
export function hmacHex(key: string | Buffer, input: string | Buffer): string {
  return createHmac('sha256', key).update(input).digest('hex');
}

// ----------------------------------------------------------------------------
// Refresh-token storage hash
// ----------------------------------------------------------------------------
//
// Hashed with a deploy-stable HMAC pepper so a DB leak alone doesn't let the
// attacker validate tokens. Required env REFRESH_TOKEN_PEPPER (64 hex chars)
// in production; outside production we fall back to a fixed dev constant so
// `pnpm dev` doesn't require operators to mint a pepper before first boot.
//
// The DEV_PEPPER is *intentionally* a literal in source — it has no security
// value (anyone who can read the source can also read the .env). Production
// boot will refuse to start without a real pepper (see config/env.ts).

const DEV_PEPPER_HEX = '00'.repeat(32); // 64 hex chars; dev/test only.

let refreshTokenPepper: Buffer | null = null;
function getRefreshTokenPepper(): Buffer {
  if (!refreshTokenPepper) {
    // Read process.env on the (re)cache miss path so tests can rotate the
    // pepper at runtime via __resetRefreshTokenPepperForTests() without
    // having to reload the entire env module. In production env.REFRESH_TOKEN_PEPPER
    // has already been validated by the zod schema, so the process.env
    // re-read here returns the same string the schema accepted.
    const hex = process.env.REFRESH_TOKEN_PEPPER ?? env.REFRESH_TOKEN_PEPPER ?? DEV_PEPPER_HEX;
    refreshTokenPepper = Buffer.from(hex, 'hex');
  }
  return refreshTokenPepper;
}

/**
 * HMAC-SHA-256 of a refresh token, suitable for storage in
 * RefreshToken.token_hash. The pepper is loaded from env.REFRESH_TOKEN_PEPPER
 * (required in production). Rotating the pepper invalidates every issued
 * refresh token — no DB migration is needed because hashes simply stop
 * matching the new HMAC, forcing every user to re-authenticate.
 *
 * Returns 64 lowercase hex chars. Deterministic for a fixed pepper.
 */
export function hashRefreshToken(rawToken: string): string {
  return hmacHex(getRefreshTokenPepper(), rawToken);
}

/** Test-only: clear the cached pepper so a NEW env.REFRESH_TOKEN_PEPPER takes effect. */
export function __resetRefreshTokenPepperForTests(): void {
  refreshTokenPepper = null;
}

// ----------------------------------------------------------------------------
// Audit-log correlation tokens
// ----------------------------------------------------------------------------
//
// Key sourcing (SVT-WAVE-KMS-PROVIDER-2026-05):
//   - production: env.CORRELATION_HMAC_KEY (64 hex chars). Mandatory; the env
//     schema rejects production boot without it.
//   - dev/test: falls back to a fixed dev constant. The dev key has no
//     security value — it exists only so the suite runs without provisioning.
//
// Why a dedicated key (not derived from JWT_PRIVATE_KEY): rotating the JWT
// signing key is a routine operation (~quarterly). Deriving the correlation
// key from JWT_PRIVATE_KEY would silently re-namespace every IP/UA/email
// hash on rotation, breaking the ability to pivot across the audit log
// post-rotation (operator asks "every event from 10.0.0.5 this week" — the
// hashed-IP lookup matches nothing because the HMAC key changed). With a
// dedicated key, JWT rotation and correlation-namespace rotation are now
// independent calls — see test `correlation hashes survive JWT rotation`.

const DEV_CORRELATION_KEY_HEX = '11'.repeat(32); // 64 hex chars; dev/test only.

let correlationKey: Buffer | null = null;
function getCorrelationKey(): Buffer {
  if (!correlationKey) {
    // SVT-WAVE-KMS-PROVIDER-2026-05 — P1-K4: prefer LOG_HMAC_KEY_BASE64
    // (newer documented spelling, base64-encoded 32 bytes) over the legacy
    // CORRELATION_HMAC_KEY (hex). Both decode to the SAME 32-byte buffer
    // when set to equivalent material — the spelling is purely cosmetic
    // and exists so operators who minted KEK_BASE64 with `openssl rand
    // -base64 32` can re-use the same recipe. process.env re-read mirrors
    // the rationale in getRefreshTokenPepper.
    const b64 = process.env.LOG_HMAC_KEY_BASE64 ?? env.LOG_HMAC_KEY_BASE64;
    if (b64) {
      correlationKey = Buffer.from(b64, 'base64');
    } else {
      const hex =
        process.env.CORRELATION_HMAC_KEY ?? env.CORRELATION_HMAC_KEY ?? DEV_CORRELATION_KEY_HEX;
      correlationKey = Buffer.from(hex, 'hex');
    }
  }
  return correlationKey;
}

/** Test-only: clear the cached correlation key so a new env value takes effect. */
export function __resetCorrelationKeyForTests(): void {
  correlationKey = null;
}

/**
 * HMAC of an IP address with the deploy-stable correlation key.
 *
 * Use only for audit-log correlation ("group all events from the same IP"). NOT a security
 * control: anyone with server secrets can recompute it for a candidate IP set. Empty / unknown
 * IPs are normalised to a constant marker so we never store the empty string.
 */
export function hashIp(ip: string): string {
  return hmacHex(getCorrelationKey(), `ip:${ip || 'unknown'}`);
}

/**
 * HMAC of a User-Agent string. Same caveats as {@link hashIp}.
 * Truncated to 1024 chars defensively — pathological UAs exist.
 */
export function hashUa(ua: string): string {
  const trimmed = (ua || 'unknown').slice(0, 1024);
  return hmacHex(getCorrelationKey(), `ua:${trimmed}`);
}

/**
 * HMAC of a user's email address, lower-cased. Used in audit logs (actor_email_hash) so we can
 * trace activity by a deactivated / soft-deleted user without leaking the address itself.
 *
 * NOTE: this is NOT the password hash and NOT a privacy guarantee against insider attackers.
 */
export function emailHashHmac(email: string): string {
  return hmacHex(getCorrelationKey(), `email:${(email || '').trim().toLowerCase()}`);
}
