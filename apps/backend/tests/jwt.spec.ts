import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';

// Generate an ephemeral RSA-2048 keypair and stub env BEFORE importing the module
// under test, because src/config/env.ts validates env at import time.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

const ISSUER = 'spv-api-test';
const AUDIENCE = 'spv-app-test';
const KID = 'test-key-1';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', PRIVATE_PEM);
vi.stubEnv('JWT_PUBLIC_KEY', PUBLIC_PEM);
vi.stubEnv('JWT_KID', KID);
vi.stubEnv('JWT_ISSUER', ISSUER);
vi.stubEnv('JWT_AUDIENCE', AUDIENCE);
vi.stubEnv('ACCESS_TOKEN_TTL_SECONDS', '900');
vi.stubEnv('REFRESH_TOKEN_TTL_SECONDS', '604800');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

// Dynamic import after env is stubbed.
const { signAccessToken, verifyAccessToken } = await import('../src/shared/jwt.js');

const baseClaims = {
  sub: '11111111-1111-7111-8111-111111111111',
  tid: '22222222-2222-7222-8222-222222222222',
  role: 'ADMIN' as const,
  jti: '33333333-3333-7333-8333-333333333333',
};

describe('jwt (RS256)', () => {
  let validToken: string;

  beforeAll(async () => {
    validToken = await signAccessToken(baseClaims);
  });

  it('round-trips a valid token', async () => {
    const decoded = await verifyAccessToken(validToken);
    expect(decoded.sub).toBe(baseClaims.sub);
    expect(decoded.tid).toBe(baseClaims.tid);
    expect(decoded.role).toBe(baseClaims.role);
    expect(decoded.jti).toBe(baseClaims.jti);
  });

  it('rejects a tampered token (signature mismatch)', async () => {
    const parts = validToken.split('.');
    // Mutate the payload segment (flip last char) so the signature no longer matches.
    const payload = parts[1]!;
    parts[1] = payload.slice(0, -1) + (payload.slice(-1) === 'A' ? 'B' : 'A');
    const tampered = parts.join('.');
    await expect(verifyAccessToken(tampered)).rejects.toThrow();
  });

  it('rejects a token with the wrong audience', async () => {
    const key = await importPKCS8(PRIVATE_PEM, 'RS256');
    const wrongAud = await new SignJWT({ tid: baseClaims.tid, role: baseClaims.role })
      .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
      .setSubject(baseClaims.sub)
      .setJti(baseClaims.jti)
      .setIssuer(ISSUER)
      .setAudience('some-other-audience')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key);
    await expect(verifyAccessToken(wrongAud)).rejects.toThrow();
  });

  it('rejects a token with the wrong issuer', async () => {
    const key = await importPKCS8(PRIVATE_PEM, 'RS256');
    const wrongIss = await new SignJWT({ tid: baseClaims.tid, role: baseClaims.role })
      .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
      .setSubject(baseClaims.sub)
      .setJti(baseClaims.jti)
      .setIssuer('rogue-issuer')
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key);
    await expect(verifyAccessToken(wrongIss)).rejects.toThrow();
  });

  it('rejects an HS256 token (algorithm pinning defeats alg-confusion)', async () => {
    // Forge an HS256 token signed with the public key bytes — a classic alg-confusion attack.
    // Since verify pins algorithms: ['RS256'], jose must reject before signature check.
    const secret = new TextEncoder().encode(PUBLIC_PEM);
    const hsToken = await new SignJWT({ tid: baseClaims.tid, role: baseClaims.role })
      .setProtectedHeader({ alg: 'HS256', kid: KID, typ: 'JWT' })
      .setSubject(baseClaims.sub)
      .setJti(baseClaims.jti)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(secret);
    await expect(verifyAccessToken(hsToken)).rejects.toThrow();
  });
});
