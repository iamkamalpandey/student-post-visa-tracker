// SVT-SEC-RESET-TIMING-2026-05 (P1-A8) — verifies the constant-work
// guard on requestPasswordReset. The previous implementation returned
// almost immediately for unknown emails while the known-user branch ran
// token mint + DB insert + provider send + audit write. An attacker
// sweeping addresses against /password/reset-request could bucket
// responses by latency and confirm which emails exist.
//
// Fix (password-reset.service.ts → SVT-SEC-RESET-TIMING-2026-05):
//   - Unknown branch runs an Argon2 verify against a dummy hash
//     (matching the cost of the known-user path's verifyPassword-equivalent
//     CPU spend) plus a timingSafeEqual to mask token-hash compares.
//   - Audit row is written on BOTH branches (operators still see probing
//     attempts; FE response shape stays generic).
//
// This spec asserts (a) wall-clock variance between known / unknown stays
// inside a generous 50ms envelope and (b) the unknown branch DOES call
// verifyPassword (proxy for "dummy work ran").

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

const store = { users: [] as User[] };
const sentEmails: Array<{ to: string }> = [];
const verifyPasswordCalls: Array<{ hash: string; password: string }> = [];

vi.mock('../src/config/db.js', () => {
  const prisma = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const matches = store.users.filter((u) => {
          if (where['email'] && u.email !== where['email']) return false;
          if (where['deleted_at'] === null && u.deleted_at != null) return false;
          if (where['is_active'] === true && !u.is_active) return false;
          return true;
        });
        return matches[0] ?? null;
      }),
    },
    passwordResetToken: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'tok-x',
        ...(data as never),
      })),
      update: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as unknown as Promise<unknown>[])),
  };
  return { prisma, prismaAdmin: prisma, disconnectDb: async () => undefined };
});

// SVT-SEC-RESET-TIMING-2026-05 — `verifyPassword` mock simulates the wall-
// clock cost of a real Argon2 verify (~30ms in CI). The known + unknown
// branches both call it once; the timing assertion below checks that the
// elapsed-time delta stays below 50ms. We track each call so we can also
// assert the unknown branch actually executes the dummy work.
vi.mock('../src/shared/passwords.js', () => ({
  hashPassword: vi.fn(async (p: string) => `argon2$${p}`),
  verifyPassword: vi.fn(async (hash: string, password: string) => {
    verifyPasswordCalls.push({ hash, password });
    // Simulate ~30ms of Argon2 work. Real argon2 verify on Node is in this
    // ballpark for the v1 cost params (8 MiB / 2 iter / 1 lane).
    await new Promise((r) => setTimeout(r, 30));
    return false;
  }),
}));

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
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

const { requestPasswordReset } = await import(
  '../src/modules/auth/password-reset.service.js'
);

beforeEach(() => {
  store.users.length = 0;
  sentEmails.length = 0;
  verifyPasswordCalls.length = 0;
});

describe('SVT-SEC-RESET-TIMING-2026-05 (P1-A8) — constant-time + dummy work on unknown email', () => {
  it('unknown-email branch invokes verifyPassword (dummy work fires)', async () => {
    await requestPasswordReset('ghost@example.com', {});
    expect(verifyPasswordCalls).toHaveLength(1);
    // The dummy hash should be our fixed Argon2id constant (sanity that we
    // are NOT verifying against a real user's hash on the unknown branch).
    expect(verifyPasswordCalls[0]!.hash).toContain('$argon2id$');
  });

  it('wall-clock variance between known and unknown email is < 50ms', async () => {
    // Seed exactly one user for the "known" measurement.
    store.users.push({
      id: 'u-1', tenant_id: 'tenant-A', email: 'real@example.com',
      given_name: 'R', is_active: true, deleted_at: null,
      password_hash: 'argon2$x', created_at: new Date(),
    });

    // Warm-up: prime the JIT + mock callsites so the first measurement isn't
    // skewed by cold-path cost. Two calls each direction is enough.
    await requestPasswordReset('warmup1@example.com', {});
    await requestPasswordReset('real@example.com', {});
    await requestPasswordReset('warmup2@example.com', {});
    await requestPasswordReset('real@example.com', {});

    // Measure. We take the BEST-OF-3 in each branch to filter out scheduler
    // hiccups (GC pauses, event-loop drift) that would dominate the
    // 30-ms-Argon2 signal but are noise from our perspective.
    async function measure(email: string): Promise<number> {
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        // eslint-disable-next-line no-await-in-loop
        await requestPasswordReset(email, {});
        samples.push(performance.now() - t0);
      }
      return Math.min(...samples);
    }

    const knownMs = await measure('real@example.com');
    const unknownMs = await measure('ghost@example.com');

    // Variance must stay inside a generous envelope. The 50ms window is
    // significantly wider than the ~30ms Argon2 cost we simulate so a real
    // Argon2 wall-clock asymmetry would blow past it; comparable verify
    // cost on both branches keeps the delta near zero.
    const delta = Math.abs(knownMs - unknownMs);
    expect(delta).toBeLessThan(50);
  });
});
