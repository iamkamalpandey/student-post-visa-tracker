// SVT-WAVE-JWT-ROTATE-2026-05 — graceful multi-kid rotation.
//
// Covers the keyset behaviour from `apps/backend/src/shared/jwt.ts`:
//   - Signing always uses the PRIMARY kid (the one with a private half).
//   - Verify accepts PRIMARY, NEXT, and PREV kids.
//   - Unknown kid → throw (which the auth middleware translates to 401).
//   - JWKS publishes every configured public key.
//
// We stub env BEFORE importing jwt.ts (env.ts validates at import time), then
// reset the in-module keyset cache so it reads the freshly stubbed values.

import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';

function genPem() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

const PRIMARY = genPem();
const NEXT = genPem();
const PREV = genPem();
const UNKNOWN = genPem();

const KID_PRIMARY = 'rotation-primary-2026-05';
const KID_NEXT = 'rotation-next-2026-05';
const KID_PREV = 'rotation-prev-2026-04';
const KID_UNKNOWN = 'rotation-unknown';

const ISSUER = 'spv-api-test';
const AUDIENCE = 'spv-app-test';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('DATABASE_MIGRATE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
vi.stubEnv('JWT_PRIVATE_KEY', PRIMARY.privatePem);
vi.stubEnv('JWT_PUBLIC_KEY', PRIMARY.publicPem);
vi.stubEnv('JWT_KID', KID_PRIMARY);
vi.stubEnv('JWT_PUBLIC_KEY_NEXT', NEXT.publicPem);
vi.stubEnv('JWT_KID_NEXT', KID_NEXT);
vi.stubEnv('JWT_PUBLIC_KEY_PREV', PREV.publicPem);
vi.stubEnv('JWT_KID_PREV', KID_PREV);
vi.stubEnv('JWT_ISSUER', ISSUER);
vi.stubEnv('JWT_AUDIENCE', AUDIENCE);
vi.stubEnv('ACCESS_TOKEN_TTL_SECONDS', '900');
vi.stubEnv('REFRESH_TOKEN_TTL_SECONDS', '604800');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const { signAccessToken, verifyAccessToken, jwks, _resetKeysetForTests } = await import(
  '../src/shared/jwt.js'
);
_resetKeysetForTests();

const baseClaims = {
  sub: '11111111-1111-7111-8111-111111111111',
  tid: '22222222-2222-7222-8222-222222222222',
  role: 'ADMIN' as const,
  jti: '33333333-3333-7333-8333-333333333333',
};

async function signWith(privatePem: string, kid: string): Promise<string> {
  const key = await importPKCS8(privatePem, 'RS256');
  return new SignJWT({ tid: baseClaims.tid, role: baseClaims.role })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
    .setSubject(baseClaims.sub)
    .setJti(baseClaims.jti)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key);
}

function decodeHeader(jwt: string): Record<string, unknown> {
  const [headerB64] = jwt.split('.');
  const json = Buffer.from(headerB64!, 'base64url').toString('utf8');
  return JSON.parse(json);
}

describe('jwt graceful rotation (multi-kid keyset)', () => {
  it('signing uses the PRIMARY kid (header.kid === JWT_KID)', async () => {
    const token = await signAccessToken(baseClaims);
    const header = decodeHeader(token);
    expect(header.kid).toBe(KID_PRIMARY);
    expect(header.alg).toBe('RS256');
  });

  it('token signed with PRIMARY verifies under the multi-kid keyset', async () => {
    const token = await signAccessToken(baseClaims);
    const decoded = await verifyAccessToken(token);
    expect(decoded.sub).toBe(baseClaims.sub);
    expect(decoded.tid).toBe(baseClaims.tid);
    expect(decoded.role).toBe(baseClaims.role);
  });

  it('token signed with the old key (now PREV public-only) still verifies', async () => {
    // Simulates the overlap window: a session was issued under the old key, the
    // operator promoted NEXT→PRIMARY and demoted the old key to PREV, and the
    // user's still-live access token must keep working until natural expiry.
    const token = await signWith(PREV.privatePem, KID_PREV);
    const decoded = await verifyAccessToken(token);
    expect(decoded.sub).toBe(baseClaims.sub);
  });

  it('token with an unknown kid is rejected (would map to 401)', async () => {
    const token = await signWith(UNKNOWN.privatePem, KID_UNKNOWN);
    await expect(verifyAccessToken(token)).rejects.toThrow();
  });

  it('JWKS endpoint returns all configured public keys (primary + next + prev)', async () => {
    const set = await jwks();
    expect(set.keys.length).toBe(3);
    const kids = set.keys.map((k) => k.kid).sort();
    expect(kids).toEqual([KID_PREV, KID_PRIMARY, KID_NEXT].sort());
    for (const key of set.keys) {
      expect(key.alg).toBe('RS256');
      expect(key.use).toBe('sig');
      expect(key.kty).toBe('RSA');
    }
  });
});
