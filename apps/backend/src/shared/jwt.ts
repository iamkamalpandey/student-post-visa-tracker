import {
  SignJWT,
  jwtVerify,
  importPKCS8,
  importSPKI,
  exportJWK,
  errors as joseErrors,
  type JWK,
  type KeyLike,
} from 'jose';
import { env } from '../config/env.js';
import type { Role } from '@spv/zod-schemas';

export type AccessTokenClaims = {
  sub: string; // user id
  tid: string; // tenant id
  role: Role;
  jti: string;
  // SVT-QA-2026-08 — surfaced so authenticate middleware can compare against
  // User.sessions_valid_from for session-wide access-token revoke. Optional
  // on the shared type because the same shape is also used as the INPUT to
  // signAccessToken(), where jose stamps iat itself via .setIssuedAt().
  // Always present after verifyAccessToken().
  iat?: number; // seconds since epoch (jose default from setIssuedAt())
};

// SVT-WAVE-JWT-ROTATE-2026-05 — graceful key rotation via an in-memory keyset.
// We hold up to three entries:
//   PRIMARY — full keypair, used for signing AND verification.
//   NEXT    — key being rotated in; verify-only here until promoted to primary.
//   PREV    — public half of a retired primary; accepts in-flight tokens until
//             the longest session age (refresh TTL) passes, then env can be
//             unset. Runbook: infra/docs/runbooks/jwt-key-rotation.md.
type KeysetEntry = {
  kid: string;
  publicKey: Promise<KeyLike>;
  privateKey?: Promise<KeyLike>;
};

let keysetCache: KeysetEntry[] | null = null;

function buildKeyset(): KeysetEntry[] {
  const entries: KeysetEntry[] = [
    {
      kid: env.JWT_KID,
      publicKey: importSPKI(env.JWT_PUBLIC_KEY, 'RS256'),
      privateKey: importPKCS8(env.JWT_PRIVATE_KEY, 'RS256'),
    },
  ];
  if (env.JWT_PUBLIC_KEY_NEXT && env.JWT_KID_NEXT) {
    // NEXT is verify-only; even if a private half is provided we deliberately
    // do not sign with it until the operator promotes it to PRIMARY.
    entries.push({
      kid: env.JWT_KID_NEXT,
      publicKey: importSPKI(env.JWT_PUBLIC_KEY_NEXT, 'RS256'),
    });
  }
  if (env.JWT_PUBLIC_KEY_PREV && env.JWT_KID_PREV) {
    entries.push({
      kid: env.JWT_KID_PREV,
      publicKey: importSPKI(env.JWT_PUBLIC_KEY_PREV, 'RS256'),
    });
  }
  return entries;
}

function keyset(): KeysetEntry[] {
  if (!keysetCache) keysetCache = buildKeyset();
  return keysetCache;
}

// Test-only escape hatch so specs can rebuild the keyset after stubbing env.
// Not exported via index — only used by the rotation spec.
export function _resetKeysetForTests(): void {
  keysetCache = null;
}

function primaryEntry(): KeysetEntry {
  const primary = keyset().find((k) => k.privateKey !== undefined);
  if (!primary) {
    // Defensive: PRIMARY is required by env validation, so this should be unreachable.
    throw new Error('No signing key configured');
  }
  return primary;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  const primary = primaryEntry();
  const key = await primary.privateKey!;
  return new SignJWT({ tid: claims.tid, role: claims.role })
    .setProtectedHeader({ alg: 'RS256', kid: primary.kid, typ: 'JWT' })
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  // Resolve the verification key by the token header's `kid`. Rejecting unknown
  // kids before signature check both avoids unnecessary crypto work and gives
  // a cleaner error for operators reading the trace.
  const { payload, protectedHeader } = await jwtVerify(
    token,
    async (header) => {
      const entry = keyset().find((k) => k.kid === header.kid);
      if (!entry) {
        throw new joseErrors.JWKSNoMatchingKey();
      }
      return entry.publicKey;
    },
    {
      algorithms: ['RS256'], // pin algorithm to defeat alg-confusion attacks
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    },
  );
  if (protectedHeader.alg !== 'RS256') {
    throw new Error('Unexpected JWT algorithm');
  }
  return {
    sub: String(payload.sub),
    tid: String(payload['tid']),
    role: String(payload['role']) as Role,
    jti: String(payload.jti),
    // payload.iat is guaranteed present because signAccessToken sets it via
    // .setIssuedAt(); jose typing has it optional so we default to 0 (would
    // fail any sessions_valid_from > epoch check, which is the safer bias).
    iat: typeof payload.iat === 'number' ? payload.iat : 0,
  };
}

export async function jwks(): Promise<{ keys: JWK[] }> {
  const entries = keyset();
  const out: JWK[] = [];
  for (const entry of entries) {
    const key = await entry.publicKey;
    const jwk = await exportJWK(key);
    jwk.kid = entry.kid;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    out.push(jwk);
  }
  return { keys: out };
}
