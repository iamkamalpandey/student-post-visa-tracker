// SVT-SEC-MFA-ENROLMENT-2026-05 (P1-6) — requireMfa({enrollmentRequired:true})
// strict variant.
//
// The legacy `requireMfa` middleware passes through when the caller has not
// enrolled MFA — fine for routine flows (change-password, PATCH /me) but a
// privilege-escalation hole for high-blast routes (admin user mutations,
// refund/void/cancel-plan). The factory form lets a route ask for STRICT
// behaviour: an account without MFA enabled is rejected with
// `code: 'mfa_enrollment_required'` and a 403 status.
//
// This spec mounts a tiny Express app exercising BOTH forms of the
// middleware against the same handler to prove the gate-shape changes.

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
  mfa_enabled: boolean;
  mfa_secret_enc: Buffer | null;
};

const store = { user: null as UserRow | null };

vi.mock('../src/config/db.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        store.user && store.user.id === where.id ? store.user : null),
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

const {
  requireMfa,
  __resetMfaReplayCacheForTests,
  __resetReplayStoreForTests,
} = await import('../src/middlewares/requireMfa.js');
const { errorHandler } = await import('../src/middlewares/errorHandler.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { sub: string; tid: string; role: 'ADMIN' } }).user = {
      sub: USER_ID, tid: TENANT_ID, role: 'ADMIN',
    };
    next();
  });
  // Routine variant (legacy): pass-through when MFA disabled.
  app.post('/routine', requireMfa, (_req, res) => res.json({ ok: true }));
  // Strict variant: reject 403 mfa_enrollment_required when MFA disabled.
  app.post('/strict', requireMfa({ enrollmentRequired: true }), (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  store.user = null;
  __resetReplayStoreForTests();
  __resetMfaReplayCacheForTests();
});

describe('requireMfa — enrollmentRequired option (P1-6)', () => {
  it('routine variant: MFA-disabled user → passes through (legacy behaviour)', async () => {
    store.user = { id: USER_ID, tenant_id: TENANT_ID, mfa_enabled: false, mfa_secret_enc: null };
    const app = makeApp();
    const res = await request(app).post('/routine').send({});
    expect(res.status).toBe(200);
  });

  it('strict variant: MFA-disabled user → 403 mfa_enrollment_required', async () => {
    store.user = { id: USER_ID, tenant_id: TENANT_ID, mfa_enabled: false, mfa_secret_enc: null };
    const app = makeApp();
    const res = await request(app).post('/strict').send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('mfa_enrollment_required');
  });

  it('strict variant: MFA-enabled user still requires X-MFA-Code (mfa_required)', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID,
      mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
    };
    const app = makeApp();
    const res = await request(app).post('/strict').send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('mfa_required');
  });

  it('strict variant: MFA-enabled user with valid X-MFA-Code → 200', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID,
      mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
    };
    const app = makeApp();
    const res = await request(app)
      .post('/strict')
      .set('X-MFA-Code', '123456')
      .send({});
    expect(res.status).toBe(200);
  });
});
