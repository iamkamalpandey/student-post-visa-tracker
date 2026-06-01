// SVT-SEC-MFA-RECOVERY-2026-05 — recovery-code consume path.
//
// Coverage:
//   - enrol mints 10 codes; the stored CSV is sha256 hashes only (no raw).
//   - consume of a valid code returns true and removes the matching hash.
//   - second consume of the SAME code returns false (single-use).
//   - consume of a never-issued code returns false.
//   - consume with MFA disabled returns false (caller maps to 401).
//   - consume with hyphen vs without hyphen are equivalent (strip-before-hash).
//   - malformed code (wrong length / wrong charset) returns false without
//     leaking via timing — but the practical assertion is just that it
//     returns false safely.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

type User = {
  id: string;
  tenant_id: string;
  email: string;
  password_hash: string;
  mfa_enabled: boolean;
  mfa_secret_enc: Buffer | null;
  mfa_recovery_hashes: string | null;
};

const store = { users: [] as User[] };
const auditCalls: Array<Record<string, unknown>> = [];

vi.mock('../src/config/db.js', () => {
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        store.users.find((u) => u.id === where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = store.users.find((x) => x.id === where.id);
        if (u) Object.assign(u, data);
        return u;
      }),
      // updateMany is used by consumeRecoveryCode to guard against a race
      // where two concurrent consumes of the same code overwrite each other.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; mfa_recovery_hashes: string | null };
          data: Record<string, unknown>;
        }) => {
          const u = store.users.find((x) => x.id === where.id);
          if (!u) return { count: 0 };
          if (u.mfa_recovery_hashes !== where.mfa_recovery_hashes) return { count: 0 };
          Object.assign(u, data);
          return { count: 1 };
        },
      ),
    },
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (e: Record<string, unknown>) => { auditCalls.push(e); }),
}));

vi.mock('../src/shared/encryption.js', () => ({
  // SVT-TYPES-2026-05 — single-arg, tenant-agnostic API (see shared/encryption.ts).
  encryptField: vi.fn(async (buf: Buffer) => Buffer.concat([Buffer.from('ENC:'), buf])),
  decryptField: vi.fn(async (buf: Buffer) => buf.subarray(4).toString('utf8')),
}));

vi.mock('../src/shared/passwords.js', () => ({
  verifyPassword: vi.fn(async (_hash: string, plain: string) => plain === 'correctpass'),
}));

vi.mock('../src/modules/auth/auth.totp.js', () => ({
  generateTotpSecret: () => 'BASE32SECRETXXXXXXXXXXX',
  totpUri: (secret: string, account: string, issuer: string) =>
    `otpauth://totp/${issuer}:${account}?secret=${secret}`,
  verifyTotp: (_secret: string, code: string) => code === '123456',
}));

const { setupMfa, verifyAndEnableMfa, disableMfa, consumeRecoveryCode } = await import(
  '../src/modules/auth/mfa.service.js'
);

const USER_ID = '11111111-1111-7111-8111-111111111111';
const TENANT_ID = '22222222-2222-7222-8222-222222222222';

async function freshEnrolledUser(): Promise<string[]> {
  store.users.length = 0;
  auditCalls.length = 0;
  store.users.push({
    id: USER_ID,
    tenant_id: TENANT_ID,
    email: 'alice@example.com',
    password_hash: 'argon2$correctpass',
    mfa_enabled: false,
    mfa_secret_enc: null,
    mfa_recovery_hashes: null,
  });
  // P0-A3 — setupMfa now requires the caller's current password as a
  // step-up so a session hijacker cannot re-enrol with their own
  // authenticator. The vi.mock above resolves 'correctpass' as valid.
  await setupMfa(USER_ID, 'correctpass');
  const { recovery_codes } = await verifyAndEnableMfa(USER_ID, '123456');
  return recovery_codes;
}

beforeEach(() => {
  store.users.length = 0;
  auditCalls.length = 0;
});

describe('enrolment persists hashed recovery codes', () => {
  it('stores 10 sha256 hex hashes; raw codes are never written', async () => {
    const codes = await freshEnrolledUser();
    expect(codes).toHaveLength(10);
    const csv = store.users[0]!.mfa_recovery_hashes!;
    const parts = csv.split(',');
    expect(parts).toHaveLength(10);
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const raw of codes) {
      expect(csv).not.toContain(raw.replace(/-/g, ''));
    }
  });
});

describe('consumeRecoveryCode', () => {
  it('returns true for a valid code and removes its hash from the list', async () => {
    const codes = await freshEnrolledUser();
    const target = codes[3]!;

    const before = store.users[0]!.mfa_recovery_hashes!.split(',');
    expect(before).toHaveLength(10);

    const ok = await consumeRecoveryCode(USER_ID, target);
    expect(ok).toBe(true);

    const after = store.users[0]!.mfa_recovery_hashes!.split(',');
    expect(after).toHaveLength(9);
    // Other 9 hashes still present, just the matched one is gone.
    const removed = before.find((h) => !after.includes(h));
    expect(removed).toBeDefined();
  });

  it('returns false when the same code is presented a second time (single-use)', async () => {
    const codes = await freshEnrolledUser();
    const target = codes[0]!;
    expect(await consumeRecoveryCode(USER_ID, target)).toBe(true);
    expect(await consumeRecoveryCode(USER_ID, target)).toBe(false);
    // List should be 9 long, not further mutated.
    expect(store.users[0]!.mfa_recovery_hashes!.split(',')).toHaveLength(9);
  });

  it('returns false for a never-issued code', async () => {
    await freshEnrolledUser();
    expect(await consumeRecoveryCode(USER_ID, 'AAAAA-BBBBB')).toBe(false);
    // List unchanged.
    expect(store.users[0]!.mfa_recovery_hashes!.split(',')).toHaveLength(10);
  });

  it('returns false when MFA is disabled', async () => {
    const codes = await freshEnrolledUser();
    await disableMfa(USER_ID, 'correctpass');
    expect(await consumeRecoveryCode(USER_ID, codes[0]!)).toBe(false);
  });

  it('accepts the code with or without the hyphen separator', async () => {
    const codes = await freshEnrolledUser();
    const target = codes[1]!; // XXXXX-XXXXX
    const noHyphen = target.replace('-', '');
    // Same code, two formats — first consumes, second is already-used.
    expect(await consumeRecoveryCode(USER_ID, noHyphen)).toBe(true);
    expect(await consumeRecoveryCode(USER_ID, target)).toBe(false);
  });

  it('returns false for malformed / empty input safely', async () => {
    await freshEnrolledUser();
    expect(await consumeRecoveryCode(USER_ID, '')).toBe(false);
    expect(await consumeRecoveryCode(USER_ID, 'short')).toBe(false);
    // List untouched.
    expect(store.users[0]!.mfa_recovery_hashes!.split(',')).toHaveLength(10);
  });

  it('returns false for an unknown user', async () => {
    await freshEnrolledUser();
    expect(
      await consumeRecoveryCode('00000000-0000-0000-0000-000000000000', 'AAAAA-BBBBB'),
    ).toBe(false);
  });
});
