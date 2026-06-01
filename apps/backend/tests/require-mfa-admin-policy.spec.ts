// SVT-SEC-MFA-ADMIN-POLICY-2026-05 (P1-A6) — tenant `require_mfa_for_admins`
// policy enforcement inside requireMfa middleware.
//
// Matrix:
//   tenant.require_mfa_for_admins | actor.role  | actor.mfa_enabled | outcome
//   false                         | ADMIN       | false             | pass + WARN
//   true                          | ADMIN       | false             | 403 mfa_required_for_admin
//   true                          | COUNSELLOR  | false             | pass (non-admin untouched)
//   true                          | ADMIN       | true (no header)  | 401 mfa_required (normal path)
//
// Also covers: WARN log fires when an ADMIN without MFA passes through the
// legacy pass-through branch (policy off).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const USER_ID = '11111111-1111-7111-8111-111111111111';
const TENANT_ID = '22222222-2222-7222-8222-222222222222';

type UserRow = {
  id: string;
  tenant_id: string;
  role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
  mfa_enabled: boolean;
  mfa_secret_enc: Buffer | null;
};

type TenantRow = {
  id: string;
  require_mfa_for_admins: boolean;
};

const store = {
  user: null as UserRow | null,
  tenant: null as TenantRow | null,
};

vi.mock('../src/config/db.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        store.user && store.user.id === where.id ? store.user : null),
    },
    tenant: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        store.tenant && store.tenant.id === where.id ? store.tenant : null),
    },
  },
  disconnectDb: async () => undefined,
}));

vi.mock('../src/shared/encryption.js', () => ({
  decryptField: vi.fn(async (buf: Buffer) => buf.toString('utf8')),
}));

vi.mock('../src/modules/auth/auth.totp.js', () => ({
  verifyTotp: vi.fn((_secret: string, code: string) => code === '123456'),
}));

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

const warnSpy = vi.fn();
vi.mock('../src/config/logger.js', () => ({
  logger: {
    warn: (...args: unknown[]) => warnSpy(...args),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const captureSpy = vi.fn();
vi.mock('../src/config/sentry.js', () => ({
  captureException: (...args: unknown[]) => captureSpy(...args),
}));

const {
  requireMfa,
  __resetReplayStoreForTests,
  __resetMfaReplayCacheForTests,
} = await import('../src/middlewares/requireMfa.js');
const { errorHandler } = await import('../src/middlewares/errorHandler.js');

function makeApp(role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { sub: string; tid: string; role: typeof role } }).user = {
      sub: USER_ID, tid: TENANT_ID, role,
    };
    next();
  });
  app.post('/gated', requireMfa, (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  store.user = null;
  store.tenant = null;
  warnSpy.mockClear();
  captureSpy.mockClear();
  __resetReplayStoreForTests();
  __resetMfaReplayCacheForTests();
});

describe('requireMfa — tenant require_mfa_for_admins policy (P1-A6)', () => {
  it('policy ON + ADMIN without MFA → 403 mfa_required_for_admin', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID, role: 'ADMIN',
      mfa_enabled: false, mfa_secret_enc: null,
    };
    store.tenant = { id: TENANT_ID, require_mfa_for_admins: true };
    const app = makeApp('ADMIN');
    const res = await request(app).post('/gated').send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('mfa_required_for_admin');
  });

  it('policy OFF + ADMIN without MFA → passes BUT emits WARN log + Sentry breadcrumb', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID, role: 'ADMIN',
      mfa_enabled: false, mfa_secret_enc: null,
    };
    store.tenant = { id: TENANT_ID, require_mfa_for_admins: false };
    const app = makeApp('ADMIN');
    const res = await request(app).post('/gated').send({});
    expect(res.status).toBe(200);
    // WARN log must mention the admin pattern.
    const warnCalls = warnSpy.mock.calls.map((c) => JSON.stringify(c));
    expect(warnCalls.some((c) => /admin action by user without MFA enrolled/i.test(c))).toBe(true);
    // Sentry breadcrumb (captureException) called with the right tag type.
    expect(captureSpy).toHaveBeenCalled();
    const captureCall = captureSpy.mock.calls[0]!;
    const captureCtx = captureCall[1] as Record<string, unknown> | undefined;
    expect(captureCtx?.['type']).toBe('mfa.admin_without_mfa');
  });

  it('policy ON + COUNSELLOR without MFA → policy does not apply (legacy pass-through)', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID, role: 'COUNSELLOR',
      mfa_enabled: false, mfa_secret_enc: null,
    };
    store.tenant = { id: TENANT_ID, require_mfa_for_admins: true };
    const app = makeApp('COUNSELLOR');
    const res = await request(app).post('/gated').send({});
    expect(res.status).toBe(200);
  });

  it('policy ON + ADMIN with MFA enrolled + missing header → normal mfa_required path', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID, role: 'ADMIN',
      mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
    };
    store.tenant = { id: TENANT_ID, require_mfa_for_admins: true };
    const app = makeApp('ADMIN');
    const res = await request(app).post('/gated').send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('mfa_required');
  });

  it('policy ON + ADMIN with MFA + valid X-MFA-Code → 200', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID, role: 'ADMIN',
      mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
    };
    store.tenant = { id: TENANT_ID, require_mfa_for_admins: true };
    const app = makeApp('ADMIN');
    const res = await request(app).post('/gated').set('X-MFA-Code', '123456').send({});
    expect(res.status).toBe(200);
  });
});
