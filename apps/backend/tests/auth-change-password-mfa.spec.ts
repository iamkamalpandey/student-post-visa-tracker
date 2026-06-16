// SVT-SEC-AUDIT-2026-05 — step-up MFA gate on POST /auth/change-password.
//
// Pinned behaviour:
//   1. MFA-disabled caller → passes the gate (legacy behaviour preserved).
//   2. MFA-enabled caller without X-MFA-Code → 401 { code: 'mfa_required' };
//      authService.changePassword MUST NOT be invoked.
//   3. MFA-enabled caller with the valid TOTP → 204 and changePassword runs.
//
// We mount the real authRouter and stub the underlying service so we can assert
// it was (or was not) called.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', PRIVATE_PEM);
vi.stubEnv('JWT_PUBLIC_KEY', PUBLIC_PEM);
vi.stubEnv('JWT_KID', 'test-kid');
vi.stubEnv('JWT_ISSUER', 'spv-api-test');
vi.stubEnv('JWT_AUDIENCE', 'spv-app-test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');
// The shared authRouter pulls in authLimiter; we need the limit high enough
// that all assertions in one describe block do not 429.
vi.stubEnv('RATE_LIMIT_AUTH_PER_MINUTE', '10000');
vi.stubEnv('RATE_LIMIT_GLOBAL_PER_MINUTE', '10000');

const TENANT_ID = '11111111-1111-7111-8111-111111111111';
const USER_ID = '22222222-2222-7222-8222-222222222222';

type UserRow = {
  id: string;
  tenant_id: string;
  mfa_enabled: boolean;
  mfa_secret_enc: Buffer | null;
};

const store = { user: null as UserRow | null };

// Minimal prisma shim — requireMfa reads user.findUnique with a select; the
// real authService.changePassword is mocked below so we don't need any of
// its underlying tables.
vi.mock('../src/config/db.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        store.user && store.user.id === where.id ? store.user : null),
    },
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  },
  disconnectDb: async () => undefined,
}));

vi.mock('../src/shared/encryption.js', () => ({
  decryptField: vi.fn(async (buf: Buffer) => buf.toString('utf8')),
}));

// Deterministic TOTP shim — '123456' verifies for any secret. Mirrors the
// strategy used by billing-mfa-step-up.spec.ts.
vi.mock('../src/modules/auth/auth.totp.js', () => ({
  verifyTotp: vi.fn((_secret: string, code: string) => code === '123456'),
}));

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

// Stub the service so we can assert it was (or was NOT) invoked, and so the
// test never touches the real password-change machinery (argon2, HIBP, etc).
const changePasswordMock = vi.fn(async () => undefined);
vi.mock('../src/modules/auth/auth.service.js', () => ({
  authService: {
    changePassword: changePasswordMock,
    // The service module is imported once at boot for several routes; we
    // stub every method the router actually calls. updatePref / login etc.
    // are not touched by the change-password endpoint so omitting them is
    // fine for the suite-scoped router import.
    getMe: vi.fn(async () => null),
    updateMyPreferences: vi.fn(async () => null),
  },
}));

// Skip the OriginGuard side-effects on the credentialed auth routes — supertest
// requests have no Origin header so it would 403 the password reset endpoints,
// but those aren't under test.
const { __resetMfaReplayCacheForTests, __resetReplayStoreForTests } =
  await import('../src/middlewares/requireMfa.js');
const { authRouter } = await import('../src/modules/auth/auth.routes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = makeApp();

async function bearer() {
  return signAccessToken({
    sub: USER_ID,
    tid: TENANT_ID,
    role: 'COUNSELLOR',
    jti: randomUUID(),
  });
}

const VALID_BODY = {
  current_password: 'OldPassword!2026',
  new_password: 'BrandNewPassword!2026',
};

beforeEach(() => {
  store.user = null;
  changePasswordMock.mockClear();
  __resetReplayStoreForTests();
  __resetMfaReplayCacheForTests();
});

describe('POST /api/v1/auth/change-password — MFA step-up gate', () => {
  it('MFA-disabled user passes the gate (no X-MFA-Code required)', async () => {
    store.user = { id: USER_ID, tenant_id: TENANT_ID, mfa_enabled: false, mfa_secret_enc: null };
    const tok = await bearer();
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${tok}`)
      .send(VALID_BODY);
    expect(res.status).toBe(204);
    expect(changePasswordMock).toHaveBeenCalledTimes(1);
  });

  it('MFA-enabled user without X-MFA-Code → 401 mfa_required', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID,
      mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
    };
    const tok = await bearer();
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${tok}`)
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('mfa_required');
    // The handler must not run when the gate blocks the request.
    expect(changePasswordMock).not.toHaveBeenCalled();
  });

  it('MFA-enabled user with a valid X-MFA-Code → 204 and changePassword runs', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID,
      mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
    };
    const tok = await bearer();
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${tok}`)
      .set('X-MFA-Code', '123456')
      .send(VALID_BODY);
    expect(res.status).toBe(204);
    expect(changePasswordMock).toHaveBeenCalledTimes(1);
    expect(changePasswordMock).toHaveBeenCalledWith(
      USER_ID,
      VALID_BODY.current_password,
      VALID_BODY.new_password,
      TENANT_ID,
    );
  });
});
