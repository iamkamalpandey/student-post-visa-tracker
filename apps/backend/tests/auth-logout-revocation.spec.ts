// SVT-SEC-2026-08 — logging out must actually revoke the access token.
//
// `POST /auth/logout` deliberately omits `authenticate`, so a client whose
// access token has already expired can still clear its refresh cookie. The side
// effect was that `req.user` was ALWAYS undefined on this path, so the
// controller's `req.user?.jti ?? null` was always null, so the `if (accessJti)`
// branch inside authService.logout — the ONLY writer of accessTokenDenylist in
// the entire codebase — never ran. The denylist was dead code.
//
// Consequence: an attacker holding a stolen access token (shared kiosk, browser
// extension, proxy log) kept full API access for the remainder of the token TTL
// after the victim clicked "Log out" and was shown success.
//
// There was no test on this path at all, which is how it survived a security
// sweep that hardened five neighbouring routes.
//
// These tests pin both halves of the contract, because they pull in opposite
// directions: a VALID bearer must yield a JTI to revoke, and an invalid or
// absent one must still complete — logout can never fail, since a thrown error
// would strand the refresh cookie, the more dangerous of the two credentials.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', PRIVATE_PEM);
vi.stubEnv('JWT_PUBLIC_KEY', PUBLIC_PEM);
vi.stubEnv('JWT_KID', 'test-kid');
vi.stubEnv('JWT_ISSUER', 'spv-api-test');
vi.stubEnv('JWT_AUDIENCE', 'spv-app-test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const USER = '22222222-2222-7222-8222-222222222222';
const TENANT = '11111111-1111-7111-8111-111111111111';

/** Everything authService.logout was called with, per invocation. */
const logoutCalls: Array<{
  refresh: string | null;
  jti: string | null;
  ctx: { userId: string | null; tenantId: string | null };
}> = [];

vi.mock('../src/modules/auth/auth.service.js', () => ({
  authService: {
    logout: vi.fn(async (refresh: string | null, jti: string | null, ctx: never) => {
      logoutCalls.push({ refresh, jti, ctx: ctx as never });
    }),
  },
}));

vi.mock('../src/shared/cookies.js', () => ({
  readRefreshCookie: vi.fn(() => 'refresh-token-value'),
  clearRefreshCookie: vi.fn(),
  setRefreshCookie: vi.fn(),
}));

vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

const { signAccessToken } = await import('../src/shared/jwt.js');
const { authController } = await import('../src/modules/auth/auth.controller.js');

function res() {
  const r = {
    statusCode: 0,
    status(code: number) {
      r.statusCode = code;
      return r;
    },
    end: vi.fn(),
    json: vi.fn(),
  };
  return r;
}

const req = (authorization?: string, user?: Record<string, unknown>) =>
  ({
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? authorization : undefined,
    ...(user ? { user } : {}),
  }) as never;

beforeEach(() => {
  logoutCalls.length = 0;
  vi.clearAllMocks();
});

describe('POST /auth/logout — a valid token is revoked', () => {
  it('extracts the JTI from the bearer and passes it for denylisting', async () => {
    const token = await signAccessToken({
      sub: USER,
      tid: TENANT,
      role: 'COUNSELLOR',
      jti: 'jti-to-revoke',
    });
    const r = res();
    await authController.logout(req(`Bearer ${token}`), r as never, vi.fn() as never);

    // Pre-fix this was null, so the denylist row was never written.
    expect(logoutCalls).toHaveLength(1);
    expect(logoutCalls[0]!.jti).toBe('jti-to-revoke');
    expect(r.statusCode).toBe(204);
  });

  it('passes the real actor so the denylist row is not sentinel zeros', async () => {
    const token = await signAccessToken({
      sub: USER,
      tid: TENANT,
      role: 'ADMIN',
      jti: 'jti-2',
    });
    await authController.logout(req(`Bearer ${token}`), res() as never, vi.fn() as never);
    expect(logoutCalls[0]!.ctx).toEqual({ userId: USER, tenantId: TENANT });
  });

  it('still prefers req.user when an upstream middleware populated it', async () => {
    await authController.logout(
      req(undefined, { sub: USER, tid: TENANT, jti: 'from-req-user' }),
      res() as never,
      vi.fn() as never,
    );
    expect(logoutCalls[0]!.jti).toBe('from-req-user');
  });
});

describe('POST /auth/logout — never fails, whatever the caller presents', () => {
  it('succeeds with NO Authorization header, clearing the refresh cookie', async () => {
    const r = res();
    await authController.logout(req(undefined), r as never, vi.fn() as never);
    expect(r.statusCode).toBe(204);
    expect(logoutCalls[0]!.jti).toBeNull();
    // The refresh token is the more dangerous credential — it must still be
    // handed to the service for invalidation even with no access token.
    expect(logoutCalls[0]!.refresh).toBe('refresh-token-value');
  });

  it('succeeds with a malformed bearer', async () => {
    const r = res();
    await authController.logout(req('Bearer not-a-jwt'), r as never, vi.fn() as never);
    expect(r.statusCode).toBe(204);
    expect(logoutCalls[0]!.jti).toBeNull();
  });

  it('succeeds with a token signed by the WRONG key', async () => {
    // An expired token takes the same path: verifyAccessToken throws, we fall
    // through. Wrong-key is deterministic and needs no clock control.
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const otherPem = other.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    vi.stubEnv('JWT_PRIVATE_KEY', otherPem);
    const r = res();
    await authController.logout(req('Bearer aaa.bbb.ccc'), r as never, vi.fn() as never);
    vi.stubEnv('JWT_PRIVATE_KEY', PRIVATE_PEM);
    expect(r.statusCode).toBe(204);
    expect(logoutCalls[0]!.jti).toBeNull();
  });

  it('succeeds when the header is present but not a Bearer scheme', async () => {
    const r = res();
    await authController.logout(req('Basic dXNlcjpwYXNz'), r as never, vi.fn() as never);
    expect(r.statusCode).toBe(204);
    expect(logoutCalls[0]!.jti).toBeNull();
  });
});
