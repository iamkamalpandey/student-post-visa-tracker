// SVT-SEC-REFRESH-CSRF-2026-05 (P1-9) — refresh cookie SameSite=Strict +
// body fallback removed.
//
// Asserts:
//   1. cookies.ts emits SameSite=Strict (not Lax).
//   2. auth.controller.refresh does NOT consult req.body.refresh_token — a
//      POST with the token in the body but NO cookie returns 401.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

describe('refresh cookie hardening (P1-9)', () => {
  it('cookies.ts declares SameSite=Strict for the refresh cookie', async () => {
    const path = join(process.cwd(), 'src', 'shared', 'cookies.ts');
    const src = readFileSync(path, 'utf8');
    // Strict, not Lax.
    expect(src).toContain("sameSite: 'strict'");
    expect(src).not.toMatch(/sameSite:\s*'lax'/);
  });

  it('auth.controller.refresh does NOT read refresh_token from the request body', async () => {
    const path = join(process.cwd(), 'src', 'modules', 'auth', 'auth.controller.ts');
    const src = readFileSync(path, 'utf8');
    // The body fallback (req.body.refresh_token) has been removed; the only
    // source is readRefreshCookie. Strip line-comments first so the
    // comment block explaining WHY we removed it doesn't trip this check.
    const executable = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    // The body-fallback read was specifically `req.body.refresh_token` /
    // `body.refresh_token`. Other `req.body as <Schema>` casts are fine —
    // /login, /change-password and friends still need to parse JSON bodies.
    expect(executable).not.toMatch(/req\.body\.refresh_token/);
    expect(executable).not.toMatch(/body\.refresh_token/);
  });

  it('runtime: refresh with body-only token returns 401 (cookie required)', async () => {
    // Cookie-less POST with the token in the body must NOT succeed. We
    // mount the real auth router with a tiny prisma mock that pretends
    // no refresh row matches; the request should fail BEFORE the lookup
    // matters because there's no cookie to read.
    vi.resetModules();
    vi.doMock('../src/config/db.js', () => ({
      prisma: {
        user: { findFirst: vi.fn(async () => null) },
        refreshToken: { findUnique: vi.fn(async () => null) },
        accessTokenDenylist: { findUnique: vi.fn(async () => null) },
      },
      prismaAdmin: {
        user: { findFirst: vi.fn(async () => null) },
        refreshToken: { findUnique: vi.fn(async () => null) },
        accessTokenDenylist: { findUnique: vi.fn(async () => null) },
      },
      disconnectDb: async () => undefined,
    }));
    vi.doMock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));
    vi.doMock('../src/shared/hashing.js', async () => {
      const { createHash, createHmac } = await import('node:crypto');
      return {
        sha256Hex: (s: string) => createHash('sha256').update(s).digest('hex'),
        hashRefreshToken: (s: string) => createHash('sha256').update(s).digest('hex'),
        hashIp: (s: string) => createHash('sha256').update(`ip:${s}`).digest('hex'),
        hashUa: (s: string) => createHash('sha256').update(`ua:${s}`).digest('hex'),
        emailHashHmac: (s: string) => createHmac('sha256', 'k').update(s).digest('hex'),
      };
    });
    vi.doMock('../src/shared/encryption.js', () => ({
      encryptField: async (s: Buffer) => s,
      decryptField: async (s: Buffer) => s.toString('utf8'),
    }));

    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const cookieParser = (await import('cookie-parser')).default;
    const { authRouter } = await import('../src/modules/auth/auth.routes.js');
    const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/v1/auth', authRouter);
    app.use(notFoundHandler);
    app.use(errorHandler);

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: 'pretend-this-is-a-stolen-token' });
    // Body-only is no longer accepted — server treats the missing cookie
    // as "no token" and returns 401.
    expect(res.status).toBe(401);
  });
});
