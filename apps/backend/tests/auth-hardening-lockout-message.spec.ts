// SVT-SEC-LOCKOUT-LEAK-2026-05 (P1-8) — verifies that the login response for a
// LOCKED account is byte-identical to the response for an unknown email or a
// wrong-password attempt. Earlier copy returned "Account locked" specifically
// when the account existed AND was in lockout, which let an attacker confirm
// "this email exists in the system AND I have already attacked it enough to
// trigger lockout" — a user-existence leak.
//
// The lockout state is still preserved in the audit log (metadata.reason =
// 'locked') so operators can distinguish in the admin dashboard; the
// user-visible 401 detail must NOT vary.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import argon2 from 'argon2';

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
vi.stubEnv('RATE_LIMIT_AUTH_PER_MINUTE', '10000');
vi.stubEnv('RATE_LIMIT_GLOBAL_PER_MINUTE', '10000');

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
  failed_login_count: number;
  locked_until: Date | null;
  mfa_enabled: boolean;
  mfa_secret_enc: Buffer | null;
  mfa_recovery_hashes: string | null;
  notifications_email_enabled: boolean;
  notifications_digest: 'PER_EVENT' | 'DAILY' | 'OFF';
  deleted_at: Date | null;
};

const store = { users: [] as UserRow[] };

vi.mock('../src/config/db.js', () => {
  const prisma = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.users.find(
          (u) => u.email === where['email'] && u.deleted_at === null,
        ) ?? null,
      ),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        store.users.find((u) => u.id === where.id) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const u = store.users.find((x) => x.id === where.id);
        if (!u) throw new Error('not found');
        Object.assign(u, data);
        return u;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    refreshToken: {
      create: vi.fn(async () => ({ id: 'x' })),
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    accessTokenDenylist: {
      create: vi.fn(async () => undefined),
      findUnique: vi.fn(async () => null),
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

vi.mock('../src/shared/cookies.js', () => ({
  setRefreshCookie: () => undefined,
  clearRefreshCookie: () => undefined,
  readRefreshCookie: () => null,
}));

const { authRouter } = await import('../src/modules/auth/auth.routes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');

const PASSWORD = 'CorrectHorseBatteryStaple1!';

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/auth', authRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function seedUser(overrides: Partial<UserRow> = {}): Promise<UserRow> {
  const hash = await argon2.hash(PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 8 * 1024,
    timeCost: 2,
    parallelism: 1,
  });
  const row: UserRow = {
    id: '22222222-2222-7222-8222-222222222222',
    tenant_id: '11111111-1111-7111-8111-111111111111',
    email: 'user@example.com',
    password_hash: hash,
    given_name: 'Ada',
    family_name: 'Lovelace',
    display_name: null,
    role: 'COUNSELLOR',
    locale: 'en',
    timezone: 'UTC',
    is_active: true,
    failed_login_count: 0,
    locked_until: null,
    mfa_enabled: false,
    mfa_secret_enc: null,
    mfa_recovery_hashes: null,
    notifications_email_enabled: true,
    notifications_digest: 'PER_EVENT',
    deleted_at: null,
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
  store.users.length = 0;
});

describe('SVT-SEC-LOCKOUT-LEAK-2026-05 (P1-8) — lockout message does not leak account existence', () => {
  it('locked account returns the SAME 401 body as wrong-password', async () => {
    // Seed a user already in the locked window.
    await seedUser({ locked_until: new Date(Date.now() + 15 * 60_000), failed_login_count: 5 });

    // Lockout branch — present the CORRECT password to ensure we hit the
    // lock check before the password verify (lock check fires first).
    const lockedRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD });

    // Reset store and re-seed without the lock so we can hit the
    // wrong-password branch with an EXISTING email.
    store.users.length = 0;
    await seedUser();
    const wrongPwRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: 'definitely-wrong' });

    expect(lockedRes.status).toBe(401);
    expect(wrongPwRes.status).toBe(401);
    // The user-visible body must match: same title + same detail string.
    expect(lockedRes.body.title).toBe(wrongPwRes.body.title);
    expect(lockedRes.body.detail).toBe(wrongPwRes.body.detail);
    // No lockout-specific copy may leak through.
    const bodyText = JSON.stringify(lockedRes.body).toLowerCase();
    expect(bodyText).not.toContain('lock');
  });

  it('locked account body matches the unknown-email body too (no existence leak)', async () => {
    // Locked email (exists + locked).
    await seedUser({ locked_until: new Date(Date.now() + 15 * 60_000), failed_login_count: 5 });
    const lockedRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'user@example.com', password: PASSWORD });
    expect(lockedRes.status).toBe(401);

    // Unknown email (does not exist at all).
    store.users.length = 0;
    const unknownRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.com', password: PASSWORD });
    expect(unknownRes.status).toBe(401);

    // Bodies must be identical so an attacker cannot tell the two cases apart.
    expect(lockedRes.body.title).toBe(unknownRes.body.title);
    expect(lockedRes.body.detail).toBe(unknownRes.body.detail);
  });
});
