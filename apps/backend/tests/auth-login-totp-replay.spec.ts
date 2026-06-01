// SVT-SEC-LOGIN-TOTP-REPLAY-2026-05 (P0-4) — login TOTP anti-replay.
//
// authService.login now consults the same chooseReplayStore() used by
// requireMfa step-up so a TOTP that was already used to sign in cannot be
// replayed within the 60s window. Without this, an attacker who phished
// the 6-digit code (during the 30s step + ±1 skew) could race the
// legitimate user to a fresh session.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import argon2 from 'argon2';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

type UserRow = {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  is_active: boolean;
  failed_login_count: number;
  locked_until: Date | null;
  password_changed_at: Date | null;
  mfa_enabled: boolean;
  mfa_secret_enc: Buffer | null;
  mfa_recovery_hashes: string | null;
  notifications_email_enabled: boolean;
  notifications_digest: 'PER_EVENT' | 'DAILY' | 'OFF';
  given_name: string;
  family_name: string;
  display_name: string | null;
  role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
  locale: string;
  timezone: string;
  last_login_at: Date | null;
  deleted_at: Date | null;
};

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER_ID = '22222222-2222-7222-8222-222222222222';
const PASSWORD = 'CorrectHorseBatteryStaple1!';

const store = {
  user: null as UserRow | null,
  refreshTokens: [] as Array<{ id: string; tenant_id: string; user_id: string; token_hash: string }>,
};

vi.mock('../src/config/db.js', () => {
  const prisma = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (!store.user) return null;
        if (where['email'] !== undefined && store.user.email !== where['email']) return null;
        return store.user;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => {
        if (store.user && where.id === store.user.id) return store.user;
        return null;
      }),
      update: vi.fn(async ({ data }: { where: { id: string }; data: Partial<UserRow> }) => {
        if (store.user) Object.assign(store.user, data);
        return store.user;
      }),
    },
    refreshToken: {
      create: vi.fn(async ({ data }: { data: { tenant_id: string; user_id: string; token_hash: string } }) => {
        const row = { id: `rt_${store.refreshTokens.length}`, ...data };
        store.refreshTokens.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { token_hash?: string } }) =>
        store.refreshTokens.find((r) => r.token_hash === where.token_hash) ?? null),
    },
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
    hashRefreshToken: (s: string) => createHash('sha256').update(s).digest('hex'),
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

vi.mock('../src/shared/jwt.js', () => ({
  signAccessToken: vi.fn(async () => 'fake.jwt.token'),
}));

// Deterministic TOTP shim — '123456' verifies for any secret.
vi.mock('../src/modules/auth/auth.totp.js', () => ({
  verifyTotp: vi.fn((_secret: string, code: string) => code === '123456'),
}));

const { authService } = await import('../src/modules/auth/auth.service.js');
const {
  __resetReplayStoreForTests,
  __resetMfaReplayCacheForTests,
} = await import('../src/middlewares/requireMfa.js');

beforeEach(async () => {
  // Reset replay store between tests so the previous test's (userId,code)
  // claim doesn't leak across cases. Use cheap argon2 for the password
  // hash so the suite stays fast.
  __resetReplayStoreForTests();
  __resetMfaReplayCacheForTests();
  const hash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 8 * 1024,
    timeCost: 2,
    parallelism: 1,
  });
  store.refreshTokens.length = 0;
  store.user = {
    id: USER_ID,
    tenant_id: TENANT,
    email: 'replay@example.com',
    password_hash: hash,
    is_active: true,
    failed_login_count: 0,
    locked_until: null,
    password_changed_at: null,
    mfa_enabled: true,
    mfa_secret_enc: Buffer.from('SECRETBASE32SECRET'),
    mfa_recovery_hashes: null,
    notifications_email_enabled: true,
    notifications_digest: 'PER_EVENT',
    given_name: 'Rey',
    family_name: 'Player',
    display_name: null,
    role: 'COUNSELLOR',
    locale: 'en',
    timezone: 'UTC',
    last_login_at: null,
    deleted_at: null,
  };
});

describe('authService.login — TOTP anti-replay (P0-4)', () => {
  it('first login with valid TOTP succeeds', async () => {
    const res = await authService.login(
      { email: 'replay@example.com', password: PASSWORD, mfa_code: '123456' } as never,
      { ip: '127.0.0.1', ua: 'spec', requestId: 'r1' },
    );
    expect(res.tokens.access_token).toBeTruthy();
  });

  it('replay of the SAME valid TOTP within 60s → 401', async () => {
    // First call claims (userId, code) for 60s.
    const ok = await authService.login(
      { email: 'replay@example.com', password: PASSWORD, mfa_code: '123456' } as never,
      { ip: '127.0.0.1', ua: 'spec', requestId: 'r1' },
    );
    expect(ok.tokens.access_token).toBeTruthy();

    // Second call with the SAME code — caught by the replay store.
    await expect(
      authService.login(
        { email: 'replay@example.com', password: PASSWORD, mfa_code: '123456' } as never,
        { ip: '127.0.0.1', ua: 'spec', requestId: 'r2' },
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
