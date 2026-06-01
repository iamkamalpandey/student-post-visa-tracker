// SVT-SEC-2026-05 — MFA enrol / verify / disable service tests.

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
    },
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (e: Record<string, unknown>) => { auditCalls.push(e); }),
}));

vi.mock('../src/shared/encryption.js', () => ({
  // SVT-TYPES-2026-05 — encryptField/decryptField are tenant-agnostic now
  // (see shared/encryption.ts). The real decryptField returns a UTF-8 string,
  // matching what middlewares/requireMfa.ts and mfa.service.ts expect.
  encryptField: vi.fn(async (buf: Buffer) => Buffer.concat([Buffer.from('ENC:'), buf])),
  decryptField: vi.fn(async (buf: Buffer) => buf.subarray(4).toString('utf8')),
}));

vi.mock('../src/shared/passwords.js', () => ({
  verifyPassword: vi.fn(async (_hash: string, plain: string) => plain === 'correctpass'),
}));

// verifyTotp must be deterministic for our tests: shim it to accept '123456'
// when secret length > 0.
vi.mock('../src/modules/auth/auth.totp.js', () => ({
  generateTotpSecret: () => 'BASE32SECRETXXXXXXXXXXX',
  totpUri: (secret: string, account: string, issuer: string) =>
    `otpauth://totp/${issuer}:${account}?secret=${secret}`,
  verifyTotp: (_secret: string, code: string) => code === '123456',
}));

const { setupMfa, verifyAndEnableMfa, disableMfa } = await import(
  '../src/modules/auth/mfa.service.js'
);

const USER_ID = '11111111-1111-7111-8111-111111111111';
const TENANT_ID = '22222222-2222-7222-8222-222222222222';

beforeEach(() => {
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
});

describe('setupMfa', () => {
  it('mints fresh secret + stores encrypted + returns otpauth url', async () => {
    // SVT-SEC-MFA-SETUP-PASSWORD-2026-05 (P0-3) — current_password is now
    // mandatory. The mocked verifyPassword above accepts the literal
    // 'correctpass'.
    const out = await setupMfa(USER_ID, 'correctpass');
    expect(out.status).toBe('PENDING_VERIFICATION');
    expect(out.secret.length).toBeGreaterThan(0);
    expect(out.otpauth_url).toMatch(/^otpauth:\/\/totp\/SVT:alice@example\.com/);
    expect(store.users[0]!.mfa_secret_enc).not.toBeNull();
    expect(store.users[0]!.mfa_enabled).toBe(false);
    expect(auditCalls.some((c) => c.action === 'auth.mfa.setup_started')).toBe(true);
  });

  it('rejects when MFA already enabled', async () => {
    store.users[0]!.mfa_enabled = true;
    await expect(setupMfa(USER_ID, 'correctpass')).rejects.toMatchObject({ status: 409 });
  });

  it('rejects for unknown user', async () => {
    await expect(
      setupMfa('00000000-0000-0000-0000-000000000000', 'correctpass'),
    ).rejects.toMatchObject({ status: 401 });
  });

  // SVT-SEC-MFA-SETUP-PASSWORD-2026-05 (P0-3) — wrong current_password
  // MUST reject 401 BEFORE the TOTP secret is rotated. Otherwise a
  // hijacked session could quietly re-mint the secret to bind the
  // attacker's authenticator.
  it('rejects on wrong current_password and does NOT rotate the secret', async () => {
    const initialSecret = store.users[0]!.mfa_secret_enc;
    await expect(setupMfa(USER_ID, 'WRONGPASS')).rejects.toMatchObject({ status: 401 });
    expect(store.users[0]!.mfa_secret_enc).toBe(initialSecret);
    expect(
      auditCalls.some((c) => c.action === 'auth.mfa.setup_password_failed'),
    ).toBe(true);
    expect(auditCalls.some((c) => c.action === 'auth.mfa.setup_started')).toBe(false);
  });
});

describe('verifyAndEnableMfa', () => {
  it('rejects when no setup started', async () => {
    await expect(verifyAndEnableMfa(USER_ID, '123456')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects on bad code', async () => {
    await setupMfa(USER_ID, 'correctpass');
    await expect(verifyAndEnableMfa(USER_ID, '999999')).rejects.toMatchObject({ status: 401 });
  });

  it('enables MFA + returns 10 recovery codes on valid code', async () => {
    await setupMfa(USER_ID, 'correctpass');
    const out = await verifyAndEnableMfa(USER_ID, '123456');
    expect(out.enabled).toBe(true);
    expect(out.recovery_codes).toHaveLength(10);
    for (const code of out.recovery_codes) {
      expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    }
    expect(store.users[0]!.mfa_enabled).toBe(true);
    // SVT-SEC-MFA-RECOVERY-2026-05 — hashes persisted as comma-joined sha256
    // hex (64 chars each, 10 hashes => 10*64 + 9 commas = 649 chars).
    const csv = store.users[0]!.mfa_recovery_hashes!;
    expect(csv).toBeTruthy();
    const parts = csv.split(',');
    expect(parts).toHaveLength(10);
    for (const part of parts) {
      expect(part).toMatch(/^[0-9a-f]{64}$/);
    }
    // The raw codes returned must NOT appear in the stored CSV (only their hashes).
    for (const raw of out.recovery_codes) {
      expect(csv).not.toContain(raw);
    }
    expect(auditCalls.some((c) => c.action === 'auth.mfa.enabled')).toBe(true);
  });

  it('rejects re-enable when already enabled', async () => {
    store.users[0]!.mfa_enabled = true;
    await expect(verifyAndEnableMfa(USER_ID, '123456')).rejects.toMatchObject({ status: 409 });
  });
});

describe('disableMfa', () => {
  beforeEach(async () => {
    await setupMfa(USER_ID, 'correctpass');
    await verifyAndEnableMfa(USER_ID, '123456');
    auditCalls.length = 0;
  });

  it('requires correct password (step-up auth)', async () => {
    await expect(disableMfa(USER_ID, 'wrong')).rejects.toMatchObject({ status: 403 });
    expect(store.users[0]!.mfa_enabled).toBe(true);
  });

  it('disables on correct password + clears secret + recovery hashes', async () => {
    expect(store.users[0]!.mfa_recovery_hashes).toBeTruthy();
    await disableMfa(USER_ID, 'correctpass');
    expect(store.users[0]!.mfa_enabled).toBe(false);
    expect(store.users[0]!.mfa_secret_enc).toBeNull();
    expect(store.users[0]!.mfa_recovery_hashes).toBeNull();
    expect(auditCalls.some((c) => c.action === 'auth.mfa.disabled')).toBe(true);
  });

  it('rejects when MFA is not enabled', async () => {
    store.users[0]!.mfa_enabled = false;
    await expect(disableMfa(USER_ID, 'correctpass')).rejects.toMatchObject({ status: 409 });
  });
});
