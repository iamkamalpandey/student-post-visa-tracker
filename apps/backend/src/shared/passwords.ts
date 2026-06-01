import argon2 from 'argon2';
import { createHash, createHmac } from 'node:crypto';

// Argon2id with parameters meeting OWASP password storage cheat sheet (2024).
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 64 * 1024, // 64 MB
  timeCost: 3,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// SVT-WAVE-KMS-PROVIDER-2026-05 — P1-K3 refresh-token hash with tenant scope.
// ----------------------------------------------------------------------------
//
// Threat model: an attacker who reads refresh_tokens.token_hash on a backup
// tape or via blind SQL injection should NOT be able to validate a candidate
// token by recomputing sha256(candidate) and comparing column values. The
// previous design (bare sha256(hex)) made this trivial — every deployment
// shared the same domain-separation-free hash.
//
// Fix:
//   - Apply HMAC-SHA256 keyed on REFRESH_TOKEN_PEPPER (deploy-stable secret).
//   - Bind the HMAC to the tenant id so cross-tenant collisions are
//     impossible even if two tenants happen to mint identical raw tokens
//     (a 2^-256 event, but the binding also fingerprints stolen rows by
//     origin and lets us shred a single tenant's tokens via per-tenant
//     pepper rotation in a future migration).
//
// `tokenHmac(raw, tenantId)` is the canonical hasher going forward.
// `hashRefreshTokenLegacy(raw)` reproduces the old sha256(hex) shape so the
// auth-service refresh path can accept a one-time legacy verification before
// rotating to the new format (see refresh-token rehash window — 7 days).
//
// Returned encoding: lowercase hex, 64 chars (HMAC-SHA256 output).
export function tokenHmac(raw: string, tenantId: string): string {
  const pepperHex =
    process.env.REFRESH_TOKEN_PEPPER ?? '00'.repeat(32); // dev/test fallback
  const pepper = Buffer.from(pepperHex, 'hex');
  // Domain-separated input — the colon prevents a tenant id that happens to
  // share a prefix with another tenant's raw token from colliding.
  return createHmac('sha256', pepper).update(`v1:${tenantId}:${raw}`).digest('hex');
}

/**
 * Legacy refresh-token hasher: bare sha256(raw) hex. RETAINED only so the
 * auth refresh path can accept a token issued before P1-K3 was deployed,
 * rotate it to the new tokenHmac format, and from then on enforce the new
 * format. After the refresh-token window (7 days post-deploy) every row in
 * the DB will have rotated and this helper becomes dead code we can delete.
 */
export function hashRefreshTokenLegacy(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
