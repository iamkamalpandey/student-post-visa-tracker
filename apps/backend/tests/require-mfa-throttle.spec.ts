// P0-WB2 (2026-05) — per-user step-up MFA attempt throttle.
//
// The /auth/mfa/* surface is already protected by authLimiter (5/min/IP).
// The X-MFA-Code step-up path is NOT bound to /auth/mfa/*, so without a
// user-scoped throttle an attacker holding a session token could brute-
// force the 6-digit TOTP space at the full global rate (600/min) across
// every authenticated mutation. The throttle below caps at 10/min/user.
//
// We mount the middleware against a tiny Express app with a fixed user
// and burn through the budget; the 11th request must return 429 with
// `code: 'mfa_throttled'`. A bad code increments the bucket exactly the
// same as a good one — a guesser doesn't get free retries by spamming
// garbage strings.

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
  verifyTotp: vi.fn(() => false),  // every code is wrong; we only care about throttle behaviour.
}));

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

const {
  requireMfa,
  __resetMfaReplayCacheForTests,
  __resetReplayStoreForTests,
  __resetMfaThrottleForTests,
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
  app.post('/protected', requireMfa, (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  store.user = {
    id: USER_ID,
    tenant_id: TENANT_ID,
    mfa_enabled: true,
    mfa_secret_enc: Buffer.from('JBSWY3DPEHPK3PXP', 'utf8'),
  };
  __resetReplayStoreForTests();
  __resetMfaReplayCacheForTests();
  __resetMfaThrottleForTests();
});

describe('requireMfa — per-user attempt throttle (P0-WB2)', () => {
  it('returns 429 mfa_throttled on the 11th attempt within the 60s window', async () => {
    const app = makeApp();
    // First 10 attempts: code is wrong → 401 mfa_invalid.
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/protected').set('X-MFA-Code', '000000').send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'mfa_invalid' });
    }
    // 11th attempt: throttle fires regardless of code.
    const overflow = await request(app).post('/protected').set('X-MFA-Code', '000001').send({});
    expect(overflow.status).toBe(429);
    expect(overflow.body).toMatchObject({ code: 'mfa_throttled' });
  });

  it('counts malformed codes toward the budget (an attacker cannot free-spam garbage)', async () => {
    const app = makeApp();
    // 10 garbage attempts (not even 6-digit). Each one must still cost a
    // budget slot — otherwise the throttle is bypassable by appending a non-
    // digit character to every guess.
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/protected').set('X-MFA-Code', 'garbage').send({});
      expect(res.status).toBe(401);
    }
    const overflow = await request(app).post('/protected').set('X-MFA-Code', '000000').send({});
    expect(overflow.status).toBe(429);
    expect(overflow.body).toMatchObject({ code: 'mfa_throttled' });
  });

  it('missing X-MFA-Code header does NOT consume budget (returns 401 mfa_required first)', async () => {
    const app = makeApp();
    // 50 header-less calls should not exhaust the budget; the throttle keys
    // off "attempt made" — a request that never even ships a code is the
    // FE's hint to open the TOTP prompt, not a guess.
    for (let i = 0; i < 50; i++) {
      const res = await request(app).post('/protected').send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'mfa_required' });
    }
    // We can still attempt 10 real codes after the header-less spam.
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/protected').set('X-MFA-Code', '000000').send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'mfa_invalid' });
    }
  });

  it('throttle is per-user — resetting between tests via __resetMfaThrottleForTests works', async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) {
      await request(app).post('/protected').set('X-MFA-Code', '000000').send({});
    }
    expect(
      (await request(app).post('/protected').set('X-MFA-Code', '000000').send({})).status,
    ).toBe(429);
    __resetMfaThrottleForTests();
    // After reset the bucket is empty again.
    const res = await request(app).post('/protected').set('X-MFA-Code', '000000').send({});
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'mfa_invalid' });
  });
});
