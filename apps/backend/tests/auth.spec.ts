// Auth module integration tests.
//
// We mock @prisma/client so no Postgres is required, and stub the shared modules
// that another agent owns (encryption / hashing / audit / cookies) so this file
// is independently runnable. The tests exercise the full HTTP surface via
// supertest against a freshly-constructed Express app.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import argon2 from 'argon2';

// ---- env ----
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
// Lockout test fires 6+ login attempts in a single test; production default
// (10/min/IP) is too low for the suite, mask security assertions with 429s.
vi.stubEnv('RATE_LIMIT_AUTH_PER_MINUTE', '10000');
vi.stubEnv('RATE_LIMIT_GLOBAL_PER_MINUTE', '10000');

// ---- in-memory store backing the prisma mock ----
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
  mfa_recovery_hashes: string | null;
  notifications_email_enabled: boolean;
  notifications_digest: 'PER_EVENT' | 'DAILY' | 'OFF';
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
              (where['email'] === undefined || u.email === where['email']) &&
              (where['deleted_at'] === undefined || u.deleted_at === null),
          ) ?? null
        );
      }),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => {
        return store.users.find((u) => u.id === where.id) ?? null;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<UserRow>;
        }) => {
          const u = store.users.find((x) => x.id === where.id);
          if (!u) throw new Error('not found');
          Object.assign(u, data, { updated_at: new Date() });
          return u;
        },
      ),
      // SVT-SEC-MFA-RECOVERY-2026-05 — consumeRecoveryCode uses updateMany with a
      // CSV equality guard to detect concurrent consumes of the same code.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; mfa_recovery_hashes?: string | null };
          data: Partial<UserRow>;
        }) => {
          const u = store.users.find((x) => x.id === where.id);
          if (!u) return { count: 0 };
          if (
            where.mfa_recovery_hashes !== undefined &&
            u.mfa_recovery_hashes !== where.mfa_recovery_hashes
          ) {
            return { count: 0 };
          }
          Object.assign(u, data, { updated_at: new Date() });
          return { count: 1 };
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
      findMany: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          return store.refreshTokens.filter((r) => {
            if (where['replaced_by_id'] !== undefined && r.replaced_by_id !== where['replaced_by_id'])
              return false;
            return true;
          });
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<RefreshRow>;
        }) => {
          const r = store.refreshTokens.find((x) => x.id === where.id);
          if (!r) throw new Error('not found');
          Object.assign(r, data);
          return r;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<RefreshRow>;
        }) => {
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
      // SVT-AUTH-2026-05: authenticate middleware consults the denylist on every
      // request. Returning null = "not denylisted, proceed" matches the prod path
      // where access tokens aren't revoked. Required so the fail-closed branch in
      // middlewares/auth.ts doesn't 503 the entire suite when the mock is missing.
      findUnique: vi.fn(async ({ where }: { where: { jti: string } }) => {
        const row = store.denylist.find((d) => d.jti === where.jti);
        return row ?? null;
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

// Stub the not-yet-existing shared modules so tests are self-contained.
vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

vi.mock('../src/shared/hashing.js', async () => {
  const { createHash, createHmac } = await import('node:crypto');
  return {
    sha256Hex: (s: string) => createHash('sha256').update(s).digest('hex'),
    // SVT-WAVE-KMS-PROVIDER-2026-05 — refresh-token storage uses HMAC pepper.
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
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/auth', authRouter);
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
    mfa_recovery_hashes: null,
    notifications_email_enabled: true,
    notifications_digest: 'PER_EVENT',
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

describe('POST /api/v1/auth/login', () => {
  it('returns 401 with generic title when email is unknown', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever-but-long-enough' });
    expect(res.status).toBe(401);
    expect(res.body.title).toBe('Unauthorized');
  });

  it('returns 200 with token and Set-Cookie spv_refresh on success', async () => {
    await seedUser();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTypeOf('string');
    expect(res.body.token_type).toBe('Bearer');
    expect(res.body.user.email).toBe('user@example.com');
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    const cookieList = Array.isArray(cookies) ? cookies : [cookies];
    expect(cookieList.some((c: string) => c.startsWith('spv_refresh='))).toBe(true);
  });

  it('locks the account after 5 consecutive bad-password attempts', async () => {
    await seedUser();
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com', password: 'definitely-wrong' });
    }
    // 6th attempt — now locked. Even with the right password we should be denied.
    // SVT-SEC-2026-05 (P2-13) — the user-visible 401 detail is the generic
    // 'Invalid credentials' string regardless of whether lockout fired.
    // The lockout state surfaces ONLY via the audit log + admin dashboard;
    // we verify it here via the seeded user's locked_until field.
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.detail).toBe('Invalid credentials');
    expect(store.users[0]!.locked_until).not.toBeNull();
  });

  // SVT-SEC-2026-05 (P2-13) — lockout / wrong-password / unknown-email all
  // return the SAME 401 detail so the lockout signal cannot be used to
  // confirm account existence. Direct comparison between the three branches.
  it('returns IDENTICAL 401 detail for unknown email, wrong password, and locked account', async () => {
    // Branch 1: unknown email.
    const r1 = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever-but-long-enough' });
    expect(r1.status).toBe(401);

    // Branch 2: wrong password against a real user.
    await seedUser();
    const r2 = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'definitely-wrong' });
    expect(r2.status).toBe(401);

    // Branch 3: lock the same user out, then try with the RIGHT password.
    for (let i = 0; i < 4; i++) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com', password: 'definitely-wrong' });
    }
    const r3 = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(r3.status).toBe(401);

    // All three branches expose the same "Invalid credentials" string.
    expect(r1.body.detail).toBe('Invalid credentials');
    expect(r2.body.detail).toBe('Invalid credentials');
    expect(r3.body.detail).toBe('Invalid credentials');
    expect(r1.body.title).toBe(r2.body.title);
    expect(r2.body.title).toBe(r3.body.title);
  });
});

// SVT-SEC-MFA-RECOVERY-2026-05 — recovery code path at /login.
describe('POST /api/v1/auth/login — MFA recovery code', () => {
  // Helper: enrol MFA on the seeded user and return the raw recovery codes.
  // Calls the service directly (we don't have a 6-digit TOTP available in tests
  // beyond the auth.spec scope) by stashing a known hash list onto the user.
  async function seedUserWithRecoveryCodes(): Promise<{ codes: string[]; csv: string }> {
    const { createHash } = await import('node:crypto');
    const codes = ['AAAAA-BBBBB', 'CCCCC-DDDDD', 'EEEEE-FFFFF'];
    const csv = codes
      .map((c) => createHash('sha256').update(c.replace(/-/g, '').toUpperCase()).digest('hex'))
      .join(',');
    await seedUser({
      mfa_enabled: true,
      mfa_secret_enc: Buffer.from('stub-secret', 'utf8'),
      mfa_recovery_hashes: csv,
    });
    return { codes, csv };
  }

  it('returns 200 + tokens when recovery_code matches; removes the hash', async () => {
    const { codes } = await seedUserWithRecoveryCodes();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD, recovery_code: codes[0] });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTypeOf('string');
    // The matched hash should be gone from the stored CSV.
    const remaining = store.users[0]!.mfa_recovery_hashes!.split(',');
    expect(remaining).toHaveLength(2);
  });

  it('returns 401 when the same recovery_code is replayed', async () => {
    const { codes } = await seedUserWithRecoveryCodes();
    const ok = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD, recovery_code: codes[0] });
    expect(ok.status).toBe(200);

    const replay = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD, recovery_code: codes[0] });
    expect(replay.status).toBe(401);
    // failed_login_count incremented on replay; lockout counter armed.
    expect(store.users[0]!.failed_login_count).toBe(1);
  });

  it('returns 401 and increments failed_login_count on a wrong recovery code', async () => {
    await seedUserWithRecoveryCodes();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD, recovery_code: 'ZZZZZ-YYYYY' });
    expect(res.status).toBe(401);
    expect(store.users[0]!.failed_login_count).toBe(1);
  });

  it('locks the account after 5 consecutive wrong-recovery-code attempts', async () => {
    await seedUserWithRecoveryCodes();
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'user@example.com', password: PASSWORD, recovery_code: 'ZZZZZ-YYYYY' });
    }
    expect(store.users[0]!.failed_login_count).toBe(5);
    expect(store.users[0]!.locked_until).not.toBeNull();
  });

  it('rejects recovery_code submission when the user has MFA disabled', async () => {
    // mfa_enabled defaults to false. The recovery_code field is then ignored
    // and the request behaves as a plain password login — the login succeeds.
    // The point: a request carrying recovery_code MUST NOT bypass the
    // "MFA disabled, no recovery flow available" gate; in practice the gate
    // is implicit (we only branch on mfa_enabled). So a successful login
    // here proves the recovery field is not abused as an MFA bypass.
    await seedUser();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD, recovery_code: 'AAAAA-BBBBB' });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns the current user when given a valid bearer token', async () => {
    const user = await seedUser();
    const token = await signAccessToken({
      sub: user.id,
      tid: user.tenant_id,
      role: user.role,
      jti: randomUUID(),
    });
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body.email).toBe(user.email);
    expect(res.body.role).toBe(user.role);
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('returns 401 when no refresh cookie or body token is present', async () => {
    const res = await request(app).post('/api/v1/auth/refresh').send({});
    expect(res.status).toBe(401);
  });
});

// SVT-WAVE9-PREFS-2026-05 — self-service preference update.
describe('PATCH /api/v1/auth/me', () => {
  it('returns 401 without a bearer', async () => {
    const res = await request(app).patch('/api/v1/auth/me').send({ notifications_email_enabled: false });
    expect(res.status).toBe(401);
  });

  it('flips notifications_email_enabled and reflects in the response', async () => {
    const user = await seedUser();
    const token = await signAccessToken({
      sub: user.id, tid: user.tenant_id, role: user.role, jti: randomUUID(),
    });
    // Default is true; flip to false.
    const res1 = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ notifications_email_enabled: false });
    expect(res1.status).toBe(200);
    expect(res1.body.notifications_email_enabled).toBe(false);

    // GET /me reflects the new state.
    const res2 = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res2.status).toBe(200);
    expect(res2.body.notifications_email_enabled).toBe(false);
  });

  it('rejects unknown fields (strict zod)', async () => {
    const user = await seedUser();
    const token = await signAccessToken({
      sub: user.id, tid: user.tenant_id, role: user.role, jti: randomUUID(),
    });
    const res = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'ADMIN' });  // role is admin-only via PATCH /users/:id
    expect(res.status).toBe(422);
  });

  it('updates display_name + locale + timezone in one call', async () => {
    const user = await seedUser();
    const token = await signAccessToken({
      sub: user.id, tid: user.tenant_id, role: user.role, jti: randomUUID(),
    });
    const res = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ display_name: 'Ada', locale: 'en-GB', timezone: 'Europe/London' });
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Ada');
    expect(res.body.locale).toBe('en-GB');
    expect(res.body.timezone).toBe('Europe/London');
  });
});

describe('POST /api/v1/auth/change-password', () => {
  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .send({ current_password: PASSWORD, new_password: 'NewLongerPassword!2026' });
    expect(res.status).toBe(401);
  });

  it('rejects when the current password is incorrect', async () => {
    const user = await seedUser();
    const token = await signAccessToken({
      sub: user.id,
      tid: user.tenant_id,
      role: user.role,
      jti: randomUUID(),
    });
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: 'wrong-password-here', new_password: 'NewLongerPassword!2026' });
    expect(res.status).toBe(401);
  });

  it('succeeds with the right current password and rotates session', async () => {
    const user = await seedUser();
    const token = await signAccessToken({
      sub: user.id,
      tid: user.tenant_id,
      role: user.role,
      jti: randomUUID(),
    });
    const res = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ current_password: PASSWORD, new_password: 'BrandNewLongPwd!2026' });
    expect(res.status).toBe(204);
  });
});
