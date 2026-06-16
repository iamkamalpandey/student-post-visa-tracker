// Extended auth-flow tests covering the higher-risk security branches:
//   - AccessTokenDenylist enforcement in the authenticate middleware.
//   - Lockout after 5 failed login attempts; counter reset on success.
//   - Refresh-token reuse detection (entire chain revoked on replay).
//   - MFA challenge: mfa_enabled user without code → 401 detail "MFA required".
//
// Mirrors the mocking strategy used by tests/auth.spec.ts. We mock @prisma/client
// via ../src/config/db.js and stub encryption/hashing/cookies for self-containment.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import argon2 from 'argon2';

// ---- env (must come before any import that touches config/env) ----
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
vi.stubEnv('ACCESS_TOKEN_TTL_SECONDS', '900');
vi.stubEnv('REFRESH_TOKEN_TTL_SECONDS', '604800');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');
// Lockout + refresh-reuse + MFA tests fire >10 login attempts in a single
// suite run; the production default (10/min/IP) would otherwise mask the
// security branches under test with 429s.
vi.stubEnv('RATE_LIMIT_AUTH_PER_MINUTE', '10000');
vi.stubEnv('RATE_LIMIT_GLOBAL_PER_MINUTE', '10000');

// ---- in-memory store ----
type UserRow = {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  given_name: string;
  family_name: string;
  display_name: string | null;
  role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
  locale: string;
  timezone: string;
  is_active: boolean;
  last_login_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  password_changed_at: Date | null;
  mfa_enabled: boolean;
  mfa_secret_enc: Buffer | null;
  email_verified_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type RefreshRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  token_hash: string;
  device_id: string | null;
  ua_hash: string | null;
  ip_subnet: string | null;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by_id: string | null;
};

type DenyRow = {
  jti: string;
  user_id: string;
  tenant_id: string;
  expires_at: Date;
};

const store = {
  users: [] as UserRow[],
  refreshTokens: [] as RefreshRow[],
  denylist: [] as DenyRow[],
};

function resetStore() {
  store.users.length = 0;
  store.refreshTokens.length = 0;
  store.denylist.length = 0;
}

// ---- mocks ----
vi.mock('../src/config/db.js', () => {
  const prisma = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return (
          store.users.find(
            (u) =>
              (where['id'] === undefined || u.id === where['id']) &&
              (where['tenant_id'] === undefined || u.tenant_id === where['tenant_id']) &&
              (where['email'] === undefined || u.email === where['email']) &&
              (where['deleted_at'] === undefined || u.deleted_at === null),
          ) ?? null
        );
      }),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => {
        return store.users.find((u) => u.id === where.id) ?? null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
          const u = store.users.find((x) => x.id === where.id);
          if (!u) throw new Error('not found');
          Object.assign(u, data, { updated_at: new Date() });
          return u;
        },
      ),
    },
    refreshToken: {
      create: vi.fn(async ({ data }: { data: Partial<RefreshRow> }) => {
        const row: RefreshRow = {
          id: randomUUID(),
          tenant_id: data.tenant_id!,
          user_id: data.user_id!,
          token_hash: data.token_hash!,
          device_id: data.device_id ?? null,
          ua_hash: data.ua_hash ?? null,
          ip_subnet: data.ip_subnet ?? null,
          issued_at: new Date(),
          expires_at: data.expires_at!,
          revoked_at: null,
          replaced_by_id: null,
        };
        store.refreshTokens.push(row);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id?: string; token_hash?: string } }) => {
          if (where.id) return store.refreshTokens.find((r) => r.id === where.id) ?? null;
          if (where.token_hash)
            return store.refreshTokens.find((r) => r.token_hash === where.token_hash) ?? null;
          return null;
        },
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          return store.refreshTokens.find((r) => {
            if (where['id'] && r.id !== where['id']) return false;
            if (where['tenant_id'] && r.tenant_id !== where['tenant_id']) return false;
            if (where['token_hash'] && r.token_hash !== where['token_hash']) return false;
            return true;
          }) ?? null;
        },
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.refreshTokens.filter((r) => {
          if (where['replaced_by_id'] !== undefined && r.replaced_by_id !== where['replaced_by_id'])
            return false;
          return true;
        });
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<RefreshRow> }) => {
          const r = store.refreshTokens.find((x) => x.id === where.id);
          if (!r) throw new Error('not found');
          Object.assign(r, data);
          return r;
        },
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Partial<RefreshRow> }) => {
          let count = 0;
          const ids = (where['id'] as { in?: string[] } | undefined)?.in;
          for (const r of store.refreshTokens) {
            if (where['user_id'] && r.user_id !== where['user_id']) continue;
            if (ids && !ids.includes(r.id)) continue;
            if (where['revoked_at'] === null && r.revoked_at !== null) continue;
            Object.assign(r, data);
            count += 1;
          }
          return { count };
        },
      ),
    },
    accessTokenDenylist: {
      create: vi.fn(async ({ data }: { data: DenyRow }) => {
        if (store.denylist.some((d) => d.jti === data.jti)) {
          throw new Error('PK conflict');
        }
        store.denylist.push(data);
        return data;
      }),
      findUnique: vi.fn(async ({ where }: { where: { jti: string } }) => {
        return store.denylist.find((d) => d.jti === where.jti) ?? null;
      }),
    },
    $transaction: vi.fn(async (ops: unknown) => {
      if (Array.isArray(ops)) return Promise.all(ops);
      if (typeof ops === 'function') return (ops as (tx: unknown) => unknown)(prisma);
      return ops;
    }),
    $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
    $disconnect: vi.fn(async () => undefined),
  };
  return { prisma, prismaAdmin: prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

vi.mock('../src/shared/hashing.js', async () => {
  const { createHash, createHmac } = await import('node:crypto');
  return {
    sha256Hex: (s: string) => createHash('sha256').update(s).digest('hex'),
    // SVT-WAVE-KMS-PROVIDER-2026-05 — refresh-token storage uses HMAC pepper.
    // Stable test pepper so the mock's input-to-output mapping is deterministic
    // across runs (production uses env.REFRESH_TOKEN_PEPPER).
    hashRefreshToken: (s: string) =>
      createHmac('sha256', 'test-refresh-pepper').update(s).digest('hex'),
    hashIp: (s: string) => createHash('sha256').update(`ip:${s}`).digest('hex'),
    hashUa: (s: string) => createHash('sha256').update(`ua:${s}`).digest('hex'),
    emailHashHmac: (s: string) =>
      createHmac('sha256', 'test-pepper').update(s).digest('hex'),
  };
});

vi.mock('../src/shared/encryption.js', () => ({
  encryptField: async (s: string | Buffer) =>
    Buffer.from(typeof s === 'string' ? s : s.toString('utf8'), 'utf8'),
  decryptField: async (b: Buffer) => b.toString('utf8'),
}));

vi.mock('../src/shared/cookies.js', async () => {
  const COOKIE = 'spv_refresh';
  return {
    setRefreshCookie: (res: { cookie: (n: string, v: string, o: object) => void }, token: string) => {
      res.cookie(COOKIE, token, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/api/v1/auth',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
    },
    clearRefreshCookie: (res: { clearCookie: (n: string, o: object) => void }) => {
      res.clearCookie(COOKIE, { path: '/api/v1/auth' });
    },
    readRefreshCookie: (req: { cookies?: Record<string, string> }) =>
      req.cookies?.[COOKIE] ?? null,
  };
});

// ---- imports under test (after mocks) ----
const { authRouter } = await import('../src/modules/auth/auth.routes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { authenticate } = await import('../src/middlewares/auth.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/auth', authRouter);
  // Mount a tiny protected route to exercise the authenticate middleware in isolation.
  app.get('/api/v1/protected', authenticate, (req, res) => {
    res.json({ ok: true, sub: req.user?.sub });
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER_ID = '22222222-2222-7222-8222-222222222222';
const PASSWORD = 'CorrectHorseBatteryStaple1!';

async function seedUser(overrides: Partial<UserRow> = {}): Promise<UserRow> {
  // argon2 ≥0.41 enforces timeCost ≥ 2 (ARGON2_MIN_TIME). Tests still want
  // the cheapest legal cost to keep the suite fast.
  const hash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 8 * 1024,
    timeCost: 2,
    parallelism: 1,
  });
  const row: UserRow = {
    id: USER_ID,
    tenant_id: TENANT,
    email: 'user@example.com',
    password_hash: hash,
    given_name: 'Ada',
    family_name: 'Lovelace',
    display_name: null,
    role: 'COUNSELLOR',
    locale: 'en',
    timezone: 'UTC',
    is_active: true,
    last_login_at: null,
    failed_login_count: 0,
    locked_until: null,
    password_changed_at: null,
    mfa_enabled: false,
    mfa_secret_enc: null,
    email_verified_at: null,
    deleted_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
  store.users.push(row);
  return row;
}

let app: Express;

beforeAll(() => {
  app = makeApp();
});

beforeEach(() => {
  resetStore();
});

describe('authenticate middleware: AccessTokenDenylist', () => {
  it('rejects with 401 "Token revoked" when JTI is on the denylist with future expiry', async () => {
    const user = await seedUser();
    const jti = randomUUID();
    store.denylist.push({
      jti,
      user_id: user.id,
      tenant_id: user.tenant_id,
      expires_at: new Date(Date.now() + 60_000),
    });
    const token = await signAccessToken({
      sub: user.id,
      tid: user.tenant_id,
      role: user.role,
      jti,
    });
    const res = await request(app)
      .get('/api/v1/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect((res.body.detail as string).toLowerCase()).toContain('revoked');
  });

  it('allows the request when the denylist entry has expired', async () => {
    const user = await seedUser();
    const jti = randomUUID();
    store.denylist.push({
      jti,
      user_id: user.id,
      tenant_id: user.tenant_id,
      expires_at: new Date(Date.now() - 60_000), // expired
    });
    const token = await signAccessToken({
      sub: user.id,
      tid: user.tenant_id,
      role: user.role,
      jti,
    });
    const res = await request(app)
      .get('/api/v1/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('Lockout after consecutive failed logins', () => {
  it('5 failed attempts → 6th rejected even with the correct password (locked state enforced; generic 401 per P1-A8)', async () => {
    await seedUser();
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com', password: 'definitely-wrong' });
      expect(r.status).toBe(401);
    }
    // 6th attempt with correct password is still denied because the row is locked.
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD });
    // SVT-SEC-LOCKOUT-LEAK-2026-05 (P1-A8) — uniform "Invalid credentials"
    // detail for lockout, wrong-password, AND unknown-email so the response
    // body cannot be used to confirm account existence. The lockout state
    // surfaces via audit (metadata.reason='locked'), not via the user-visible
    // copy.
    expect(res.status).toBe(401);
    expect((res.body.detail as string).toLowerCase()).not.toContain('lock');
    expect(res.body.detail).toMatch(/invalid credentials/i);
  });

  it('resets failed_login_count to 0 on successful login', async () => {
    const user = await seedUser({ failed_login_count: 3 });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    const refreshed = store.users.find((u) => u.id === user.id)!;
    expect(refreshed.failed_login_count).toBe(0);
    expect(refreshed.locked_until).toBeNull();
  });
});

describe('Refresh-token reuse detection', () => {
  it('replaying an already-revoked refresh token revokes the entire chain and returns 401', async () => {
    const user = await seedUser();

    // Login → obtain a refresh cookie.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(login.status).toBe(200);
    const cookieHeader = (login.headers['set-cookie'] as unknown as string[] | string) ?? [];
    const cookieList = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
    const refreshCookie = cookieList.find((c) => c.startsWith('spv_refresh='))!;
    expect(refreshCookie).toBeDefined();

    // First refresh — succeeds, the original token is revoked + replaced.
    const refresh1 = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie);
    expect(refresh1.status).toBe(200);
    expect(store.refreshTokens.length).toBe(2); // original + new
    const original = store.refreshTokens[0]!;
    expect(original.revoked_at).not.toBeNull();
    expect(original.replaced_by_id).not.toBeNull();

    // Replay the original (revoked) refresh cookie — should be rejected AND
    // every refresh token in the chain should now carry revoked_at.
    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie);
    expect(replay.status).toBe(401);
    for (const r of store.refreshTokens) {
      expect(r.revoked_at).not.toBeNull();
    }
  });
});

describe('MFA challenge', () => {
  it('mfa_enabled user without mfa_code → 401 with detail "MFA required"', async () => {
    // Stash a stub secret blob; mfa_secret_enc must be non-null but its content is not exercised.
    await seedUser({
      mfa_enabled: true,
      mfa_secret_enc: Buffer.from('stub-secret', 'utf8'),
    });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe('MFA required');
  });

  it('mfa_enabled user with mfa_secret_enc=null → 401 "MFA misconfigured for account"', async () => {
    await seedUser({ mfa_enabled: true, mfa_secret_enc: null });
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD, mfa_code: '123456' });
    expect(res.status).toBe(401);
    expect((res.body.detail as string).toLowerCase()).toContain('misconfigured');
  });
});
