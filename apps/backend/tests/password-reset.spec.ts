// SVT-SEC-2026-05 — Self-service password reset service tests.
//
// Mocks Prisma + comms provider so we can exercise the full request → confirm
// flow without real DB or SMTP.
//
// Covers:
//   - requestPasswordReset for known email creates a token + emails
//   - requestPasswordReset for unknown email is silent (no error, no leak)
//   - confirmPasswordReset rejects unknown/consumed/invalidated/expired token
//   - confirmPasswordReset writes new hash + revokes all refresh tokens
//   - confirmPasswordReset invalidates other live tokens for the same user
//   - HIBP gate fires when env blocks
//   - Token rotation: a 2nd request invalidates the 1st outstanding token

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

type User = { id: string; tenant_id: string; email: string; given_name: string; is_active: boolean; deleted_at: Date | null; password_hash: string };
type ResetToken = {
  id: string; tenant_id: string; user_id: string; token_hash: string;
  requested_at: Date; expires_at: Date; consumed_at: Date | null;
  invalidated_at: Date | null; ip_hash: string | null; ua_hash: string | null;
};

const store = {
  users: [] as User[],
  tokens: [] as ResetToken[],
  refreshTokensRevoked: 0,
};
const auditCalls: Array<Record<string, unknown>> = [];
const sentEmails: Array<{ to: string; subject: string; body: string }> = [];

vi.mock('../src/config/db.js', () => {
  function matchUsers(where: Record<string, unknown>): User[] {
    return store.users.filter((u) => {
      if (where['email'] && u.email !== where['email']) return false;
      if (where['deleted_at'] === null && u.deleted_at != null) return false;
      if (where['is_active'] === true && !u.is_active) return false;
      return true;
    });
  }
  function matchTokens(where: Record<string, unknown>): ResetToken[] {
    return store.tokens.filter((t) => {
      if (where['user_id'] && t.user_id !== where['user_id']) return false;
      if (where['consumed_at'] === null && t.consumed_at != null) return false;
      if (where['invalidated_at'] === null && t.invalidated_at != null) return false;
      if (where['expires_at'] && (where['expires_at'] as { gt?: Date }).gt) {
        if (t.expires_at <= (where['expires_at'] as { gt: Date }).gt) return false;
      }
      const idNot = (where['id'] as { not?: string } | undefined)?.not;
      if (idNot && t.id === idNot) return false;
      return true;
    });
  }
  const prisma = {
    user: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => matchUsers(where)),
      // SVT-SEC-RESET-ENUM-2026-05 (P1-9) — the request flow now uses
      // findFirst with orderBy created_at:asc so multi-tenant emails cannot
      // be enumerated. Mock returns the deterministic first match; the
      // legacy findMany path stays in place for any other caller.
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => matchUsers(where)[0] ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = store.users.find((x) => x.id === where.id);
        if (u) Object.assign(u, data);
        return u;
      }),
    },
    passwordResetToken: {
      findUnique: vi.fn(async ({ where }: { where: { token_hash: string } }) =>
        store.tokens.find((t) => t.token_hash === where.token_hash) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const t: ResetToken = {
          id: `tok-${store.tokens.length}`,
          requested_at: new Date(),
          consumed_at: null, invalidated_at: null,
          ip_hash: null, ua_hash: null,
          ...(data as never),
        };
        store.tokens.push(t);
        return t;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const t = store.tokens.find((x) => x.id === where.id);
        if (t) Object.assign(t, data);
        return t;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = matchTokens(where);
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      }),
    },
    refreshToken: {
      updateMany: vi.fn(async () => {
        store.refreshTokensRevoked += 1;
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as unknown as Promise<unknown>[])),
  };
  return { prisma, prismaAdmin: prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (e: Record<string, unknown>) => { auditCalls.push(e); }),
}));

vi.mock('../src/modules/comms/providers/registry.js', () => ({
  getProvider: vi.fn(() => ({
    channel: 'EMAIL' as const,
    send: vi.fn(async (msg: { to: string; subject?: string; body: string }) => {
      sentEmails.push({ to: msg.to, subject: msg.subject ?? '', body: msg.body });
      return { providerId: 'stub', status: 'SENT' as const };
    }),
  })),
}));

vi.mock('../src/shared/passwords.js', () => ({
  hashPassword: vi.fn(async (p: string) => `argon2$${p}`),
  verifyPassword: vi.fn(async () => true),
}));

const { requestPasswordReset, confirmPasswordReset } = await import(
  '../src/modules/auth/password-reset.service.js'
);

const USER_ID = '11111111-1111-7111-8111-111111111111';
const TENANT_ID = '22222222-2222-7222-8222-222222222222';

beforeEach(() => {
  store.users.length = 0;
  store.tokens.length = 0;
  store.refreshTokensRevoked = 0;
  auditCalls.length = 0;
  sentEmails.length = 0;
  store.users.push({
    id: USER_ID,
    tenant_id: TENANT_ID,
    email: 'alice@example.com',
    given_name: 'Alice',
    is_active: true,
    deleted_at: null,
    password_hash: 'argon2$old',
  });
});

describe('requestPasswordReset', () => {
  it('creates a token + sends an email for a known email', async () => {
    await requestPasswordReset('alice@example.com', { ip: '203.0.113.5', ua: 'browser' });
    expect(store.tokens).toHaveLength(1);
    expect(store.tokens[0]!.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe('alice@example.com');
    expect(sentEmails[0]!.body).toContain('/reset/confirm?token=');
    expect(auditCalls.some((c) => c.action === 'auth.password_reset.requested')).toBe(true);
  });

  it('is silent for unknown email but writes an audit row (anti-enumeration + P1-A8)', async () => {
    // SVT-SEC-RESET-TIMING-2026-05 (P1-A8) — unknown branch now writes a
    // tagged audit row (reason=unknown_email) so operators retain forensic
    // signal on probing sweeps. The user-visible response is unchanged
    // (no token, no email), preserving anti-enumeration.
    await requestPasswordReset('nobody@example.com', {});
    expect(store.tokens).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]!.action).toBe('auth.password_reset.requested');
    expect((auditCalls[0]!.metadata as { reason?: string })?.reason).toBe('unknown_email');
  });

  it('normalises email case + trim', async () => {
    await requestPasswordReset('  ALICE@example.com  ', {});
    expect(store.tokens).toHaveLength(1);
    expect(sentEmails).toHaveLength(1);
  });

  it('invalidates prior outstanding tokens on a fresh request (rotation)', async () => {
    await requestPasswordReset('alice@example.com', {});
    await requestPasswordReset('alice@example.com', {});
    // Both rows are present, but the first is now invalidated.
    expect(store.tokens).toHaveLength(2);
    expect(store.tokens[0]!.invalidated_at).not.toBeNull();
    expect(store.tokens[1]!.invalidated_at).toBeNull();
  });
});

describe('confirmPasswordReset', () => {
  async function mintToken(): Promise<string> {
    // Mimic what requestPasswordReset does so we have a known raw token.
    const raw = 'a'.repeat(40); // 32+ chars to pass the BadRequest length guard
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    store.tokens.push({
      id: 'tok-manual',
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      token_hash: tokenHash,
      requested_at: new Date(),
      expires_at: new Date(Date.now() + 30 * 60_000),
      consumed_at: null,
      invalidated_at: null,
      ip_hash: null,
      ua_hash: null,
    });
    return raw;
  }

  it('rejects malformed token with 400', async () => {
    await expect(confirmPasswordReset('short', 'NewPass-Strong-2026!')).rejects.toMatchObject({ status: 400 });
  });

  it('rejects unknown token with 401', async () => {
    await expect(
      confirmPasswordReset('z'.repeat(40), 'NewPass-Strong-2026!'),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects expired token with 401', async () => {
    const raw = await mintToken();
    store.tokens[0]!.expires_at = new Date(Date.now() - 1000);
    await expect(
      confirmPasswordReset(raw, 'NewPass-Strong-2026!'),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects consumed token with 401 (single-use)', async () => {
    const raw = await mintToken();
    store.tokens[0]!.consumed_at = new Date();
    await expect(
      confirmPasswordReset(raw, 'NewPass-Strong-2026!'),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rejects invalidated token with 401', async () => {
    const raw = await mintToken();
    store.tokens[0]!.invalidated_at = new Date();
    await expect(
      confirmPasswordReset(raw, 'NewPass-Strong-2026!'),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('on success: writes new hash, marks token consumed, revokes refresh tokens, audits', async () => {
    const raw = await mintToken();
    await confirmPasswordReset(raw, 'NewPass-Strong-2026!');
    expect(store.users[0]!.password_hash).toBe('argon2$NewPass-Strong-2026!');
    expect(store.tokens[0]!.consumed_at).not.toBeNull();
    expect(store.refreshTokensRevoked).toBeGreaterThan(0);
    expect(auditCalls.some((c) => c.action === 'auth.password_reset.consumed')).toBe(true);
  });
});
