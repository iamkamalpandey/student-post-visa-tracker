// SVT-SEC-RESET-ENUM-2026-05 (P1-9) — verifies that requestPasswordReset
// cannot be used to enumerate which tenant(s) an email belongs to.
//
// Previously the service called `findMany({ where: { email } })` and minted
// a fresh reset token (with separate email) for EVERY tenant that shared the
// address. Two leaks fell out of that:
//
//   - Multiple emails arriving = "this email exists in N tenants" (a side-
//     channel observable by the holder of the inbox).
//   - Per-tenant audit + refresh-revocation row counts differed by tenant
//     count from the baseline.
//
// Fix: `findFirst({ where: { email }, orderBy: { created_at: 'asc' } })` —
// at most ONE token is minted, at most ONE email is sent, and the
// user-visible response is identical for 0 / 1 / N matches.

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
  given_name: string;
  is_active: boolean;
  deleted_at: Date | null;
  password_hash: string;
  created_at: Date;
};

type ResetToken = {
  id: string;
  tenant_id: string;
  user_id: string;
  token_hash: string;
  requested_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  invalidated_at: Date | null;
  ip_hash: string | null;
  ua_hash: string | null;
};

const store = {
  users: [] as User[],
  tokens: [] as ResetToken[],
};

const auditCalls: Array<Record<string, unknown>> = [];
const sentEmails: Array<{ to: string }> = [];

vi.mock('../src/config/db.js', () => {
  function matchUsers(where: Record<string, unknown>): User[] {
    return store.users.filter((u) => {
      if (where['email'] && u.email !== where['email']) return false;
      if (where['deleted_at'] === null && u.deleted_at != null) return false;
      if (where['is_active'] === true && !u.is_active) return false;
      return true;
    });
  }
  const prisma = {
    user: {
      findFirst: vi.fn(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: Record<string, 'asc' | 'desc'> }) => {
        const matches = matchUsers(where);
        if (orderBy?.['created_at'] === 'asc') {
          matches.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
        }
        return matches[0] ?? null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => matchUsers(where)),
      update: vi.fn(async () => undefined),
    },
    passwordResetToken: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const t: ResetToken = {
          id: `tok-${store.tokens.length}`,
          requested_at: new Date(),
          consumed_at: null,
          invalidated_at: null,
          ip_hash: null,
          ua_hash: null,
          ...(data as never),
        };
        store.tokens.push(t);
        return t;
      }),
      update: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    refreshToken: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as unknown as Promise<unknown>[])),
  };
  return { prisma, prismaAdmin: prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (e: Record<string, unknown>) => {
    auditCalls.push(e);
  }),
}));

vi.mock('../src/modules/comms/providers/registry.js', () => ({
  getProvider: vi.fn(() => ({
    channel: 'EMAIL' as const,
    send: vi.fn(async (msg: { to: string }) => {
      sentEmails.push({ to: msg.to });
      return { providerId: 'stub', status: 'SENT' as const };
    }),
  })),
}));

vi.mock('../src/shared/passwords.js', () => ({
  hashPassword: vi.fn(async (p: string) => `argon2$${p}`),
  verifyPassword: vi.fn(async () => true),
}));

const { requestPasswordReset } = await import(
  '../src/modules/auth/password-reset.service.js'
);

beforeEach(() => {
  store.users.length = 0;
  store.tokens.length = 0;
  auditCalls.length = 0;
  sentEmails.length = 0;
});

describe('SVT-SEC-RESET-ENUM-2026-05 (P1-9) — password reset does not enumerate across tenants', () => {
  it('non-existent email → no token row, no email, but audit row written with reason=unknown_email (P1-A8)', async () => {
    // SVT-SEC-RESET-TIMING-2026-05 (P1-A8) — the unknown-email branch now
    // writes an audit row (tagged `reason: unknown_email`) so operators can
    // observe probing attempts. No token + no email keeps the FE-visible
    // response identical to the known-user 200 response.
    await requestPasswordReset('ghost@example.com', { ip: '203.0.113.5', ua: 'browser' });
    expect(store.tokens).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]!['action']).toBe('auth.password_reset.requested');
    expect(auditCalls[0]!['tenantId']).toBeNull();
    expect(auditCalls[0]!['entityId']).toBeNull();
    const meta = auditCalls[0]!['metadata'] as Record<string, unknown>;
    expect(meta['reason']).toBe('unknown_email');
  });

  it('multi-tenant email → exactly ONE token + ONE email + ONE audit row (no enumeration leak)', async () => {
    // Seed the same email in three different tenants; the previous findMany
    // flow would have minted three tokens and sent three emails.
    const t0 = new Date('2024-01-01T00:00:00Z');
    const t1 = new Date('2024-06-01T00:00:00Z');
    const t2 = new Date('2025-01-01T00:00:00Z');
    store.users.push(
      {
        id: 'u-1', tenant_id: 'tenant-A', email: 'shared@example.com',
        given_name: 'A', is_active: true, deleted_at: null,
        password_hash: 'argon2$x', created_at: t0,
      },
      {
        id: 'u-2', tenant_id: 'tenant-B', email: 'shared@example.com',
        given_name: 'B', is_active: true, deleted_at: null,
        password_hash: 'argon2$x', created_at: t1,
      },
      {
        id: 'u-3', tenant_id: 'tenant-C', email: 'shared@example.com',
        given_name: 'C', is_active: true, deleted_at: null,
        password_hash: 'argon2$x', created_at: t2,
      },
    );

    await requestPasswordReset('shared@example.com', {});

    // Exactly one token minted (deterministic: the oldest tenant by user created_at).
    expect(store.tokens).toHaveLength(1);
    expect(store.tokens[0]!.tenant_id).toBe('tenant-A');
    expect(store.tokens[0]!.user_id).toBe('u-1');

    // Exactly one email sent.
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe('shared@example.com');

    // Exactly one audit row, and it carries the matched tenant for forensics.
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]!['action']).toBe('auth.password_reset.requested');
    expect(auditCalls[0]!['tenantId']).toBe('tenant-A');
  });

  it('single-tenant email still works (regression guard)', async () => {
    store.users.push({
      id: 'u-1', tenant_id: 'tenant-A', email: 'solo@example.com',
      given_name: 'S', is_active: true, deleted_at: null,
      password_hash: 'argon2$x', created_at: new Date(),
    });
    await requestPasswordReset('solo@example.com', {});
    expect(store.tokens).toHaveLength(1);
    expect(sentEmails).toHaveLength(1);
    expect(auditCalls).toHaveLength(1);
  });

  it('inactive / soft-deleted user does not trigger reset (no info leak)', async () => {
    store.users.push(
      {
        id: 'u-inactive', tenant_id: 'tenant-A', email: 'paused@example.com',
        given_name: 'P', is_active: false, deleted_at: null,
        password_hash: 'argon2$x', created_at: new Date(),
      },
      {
        id: 'u-deleted', tenant_id: 'tenant-B', email: 'gone@example.com',
        given_name: 'D', is_active: true, deleted_at: new Date(),
        password_hash: 'argon2$x', created_at: new Date(),
      },
    );
    await requestPasswordReset('paused@example.com', {});
    await requestPasswordReset('gone@example.com', {});
    expect(store.tokens).toHaveLength(0);
    expect(sentEmails).toHaveLength(0);
    // SVT-SEC-RESET-TIMING-2026-05 (P1-A8) — inactive / soft-deleted users
    // are treated as "unknown email" for the purposes of the timing-safe
    // branch: we write an audit row with reason=unknown_email but DO NOT
    // mint a token or send an email. Two calls → two audit rows.
    expect(auditCalls).toHaveLength(2);
    for (const row of auditCalls) {
      expect(row['action']).toBe('auth.password_reset.requested');
      expect(row['tenantId']).toBeNull();
      expect((row['metadata'] as Record<string, unknown>)['reason']).toBe('unknown_email');
    }
  });
});
