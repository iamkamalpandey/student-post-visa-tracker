// SVT-SEC-MFA-STEPUP-2026-05 — requireMfa middleware spec.
//
// Exercises the four behaviours expected by FE for the sensitive billing
// mutations (refund / void / cancel-plan / complete-refund):
//
//   1. MFA-disabled user → middleware passes through, route handler runs.
//   2. MFA-enabled user without X-MFA-Code header → 401 { code: 'mfa_required' }.
//   3. MFA-enabled user with a valid TOTP → handler runs, audit row written.
//   4. MFA-enabled user with an invalid TOTP → 401 { code: 'mfa_invalid' }.
//   5. Same valid code presented twice within 60s → 401 { code: 'mfa_replay' }
//      on the second submission. The first still goes through.
//
// We mount a tiny Express app with a stub `authenticate`-equivalent middleware
// that primes req.user, then requireMfa, then a no-op handler that 200s. This
// keeps the test focused on the middleware contract and avoids pulling the
// full billing route + Prisma surface (covered by sibling specs).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Base env required by config/env.ts on import (transitively from prisma/db).
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

const store = { user: null as UserRow | null, audits: [] as Array<Record<string, unknown>> };

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
  // The stored secret_enc is just the utf8 secret string bytes; decryptField
  // hands us the secret back.
  decryptField: vi.fn(async (buf: Buffer) => buf.toString('utf8')),
}));

// Deterministic TOTP shim: '123456' is the only accepted code for any secret.
vi.mock('../src/modules/auth/auth.totp.js', () => ({
  verifyTotp: vi.fn((_secret: string, code: string) => code === '123456'),
}));

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (e: Record<string, unknown>) => { store.audits.push(e); }),
}));

const {
  requireMfa,
  __resetMfaReplayCacheForTests,
  __setReplayStoreForTests,
  __resetReplayStoreForTests,
  makeRedisReplayStore,
} = await import('../src/middlewares/requireMfa.js');
const { errorHandler } = await import('../src/middlewares/errorHandler.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  // Stub authenticate — populate req.user the way the real middleware would.
  app.use((req, _res, next) => {
    (req as unknown as { user: { sub: string; tid: string; role: 'ADMIN' } }).user = {
      sub: USER_ID,
      tid: TENANT_ID,
      role: 'ADMIN',
    };
    next();
  });
  // The four sensitive routes share the same gate; we only need one to prove
  // the middleware contract since they all wire the SAME middleware.
  const handler = vi.fn((_req: express.Request, res: express.Response) => {
    res.status(200).json({ ok: true });
  });
  app.post('/billing/payments/:id/refunds', requireMfa, handler);
  // Surface handler on the app object for assertions in individual tests.
  (app as unknown as { __handler: typeof handler }).__handler = handler;
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  store.user = null;
  store.audits.length = 0;
  // Restore the default in-process store between tests so the Redis-mock
  // case below doesn't leak into the legacy cases above (and vice-versa).
  __resetReplayStoreForTests();
  __resetMfaReplayCacheForTests();
});

describe('requireMfa middleware', () => {
  it('MFA-disabled user → refund route passes through without header', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID,
      mfa_enabled: false, mfa_secret_enc: null,
    };
    const app = makeApp();
    const res = await request(app).post('/billing/payments/p1/refunds').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Pass-through skips the audit row — nothing to step-up.
    expect(store.audits).toHaveLength(0);
  });

  it('MFA-enabled user without X-MFA-Code → 401 mfa_required', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID,
      mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
    };
    const app = makeApp();
    const res = await request(app).post('/billing/payments/p1/refunds').send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('mfa_required');
    expect((app as unknown as { __handler: { mock: { calls: unknown[] } } }).__handler.mock.calls).toHaveLength(0);
  });

  it('MFA-enabled user with valid X-MFA-Code → 200 and audit row', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID,
      mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
    };
    const app = makeApp();
    const res = await request(app)
      .post('/billing/payments/p1/refunds')
      .set('X-MFA-Code', '123456')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Audit fire-and-forget — give the microtask queue a tick to flush.
    await new Promise((r) => setImmediate(r));
    expect(store.audits.some((a) => a['action'] === 'auth.mfa.step_up')).toBe(true);
  });

  it('MFA-enabled user with invalid X-MFA-Code → 401 mfa_invalid', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID,
      mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
    };
    const app = makeApp();
    const res = await request(app)
      .post('/billing/payments/p1/refunds')
      .set('X-MFA-Code', '999999')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('mfa_invalid');
  });

  it('replay of the SAME valid code within 60s → 401 mfa_replay on the second call', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID,
      mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
    };
    const app = makeApp();
    const first = await request(app)
      .post('/billing/payments/p1/refunds')
      .set('X-MFA-Code', '123456')
      .send({});
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/billing/payments/p1/refunds')
      .set('X-MFA-Code', '123456')
      .send({});
    expect(second.status).toBe(401);
    expect(second.body.code).toBe('mfa_replay');
  });

  it('malformed code (non-6-digit) → 401 mfa_invalid (no decrypt round trip)', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID,
      mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
    };
    const app = makeApp();
    const res = await request(app)
      .post('/billing/payments/p1/refunds')
      .set('X-MFA-Code', 'abcdef')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('mfa_invalid');
  });

  // SVT-SEC-MFA-REPLAY-REDIS-2026-05 — Redis-backed cross-replica replay
  // protection. We inject a mocked Redis client whose SET-NX returns 'OK' on
  // the first call and null on the second; the middleware must translate
  // that into 200 then 401 mfa_replay exactly like the in-process store.
  it('Redis store: SETNX OK then null → second call returns mfa_replay', async () => {
    store.user = {
      id: USER_ID, tenant_id: TENANT_ID,
      mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
    };
    // Hand-rolled `set` returning OK, then null. We assert the call shape too
    // so a regression in key naming / TTL is caught up-front.
    const calls: Array<{ key: string; value: string; opts: { NX: true; EX: number } }> = [];
    let callIdx = 0;
    const fakeRedis = {
      set: vi.fn(async (key: string, value: string, opts: { NX: true; EX: number }) => {
        calls.push({ key, value, opts });
        return callIdx++ === 0 ? 'OK' : null;
      }),
    };
    __setReplayStoreForTests(makeRedisReplayStore(fakeRedis));

    const app = makeApp();
    const first = await request(app)
      .post('/billing/payments/p1/refunds')
      .set('X-MFA-Code', '123456')
      .send({});
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/billing/payments/p1/refunds')
      .set('X-MFA-Code', '123456')
      .send({});
    expect(second.status).toBe(401);
    expect(second.body.code).toBe('mfa_replay');

    // Both calls hit Redis with the documented key + TTL shape.
    expect(fakeRedis.set).toHaveBeenCalledTimes(2);
    expect(calls[0].key).toBe(`mfa:replay:${USER_ID}:123456`);
    expect(calls[0].opts).toEqual({ NX: true, EX: 60 });
    expect(calls[1].key).toBe(`mfa:replay:${USER_ID}:123456`);
  });
});
