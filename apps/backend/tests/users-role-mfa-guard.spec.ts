// SVT-SEC-ROLE-MFA-2026-05 (P0-2) — usersService.update role-mutation MFA
// gate.
//
// CRITICAL bug class fixed: a stolen ADMIN access token belonging to an
// admin who never enrolled MFA could promote any peer to ADMIN — a one-
// shot privilege escalation that bypasses the entire MFA programme.
//
// Service-level guard: when `input.role !== undefined && input.role !==
// target.role` AND target.id !== actor.id, the service requires the caller
// to pass actorMfaEnabled=true AND actorMfaVerifiedAt set. Otherwise it
// throws 403. The route is also gated by requireMfa({enrollmentRequired:
// true}) — see users-admin-mfa-routes.spec.ts for the route-level test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = '11111111-1111-7111-8111-111111111111';

type Row = {
  id: string;
  tenant_id: string;
  email: string;
  role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
  is_active: boolean;
  deleted_at: Date | null;
};

const store = { users: [] as Row[] };

// Audit writes are best-effort (writeAudit never throws); mock so the new
// user.* audit calls don't reach the real $transaction path through this
// spec's minimal prisma mock. SVT-AUDIT-SEC-2026-06.
vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

vi.mock('../src/config/db.js', () => {
  const matchWhere = (rows: Row[], where: Record<string, unknown>): Row[] =>
    rows.filter((r) => {
      for (const [k, v] of Object.entries(where)) {
        if (v === undefined) continue;
        if (v === null) { if ((r as Record<string, unknown>)[k] !== null) return false; continue; }
        if ((r as Record<string, unknown>)[k] !== v) return false;
      }
      return true;
    });
  const prisma = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchWhere(store.users, where)[0] ?? null),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchWhere(store.users, where).length),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = matchWhere(store.users, where);
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      }),
      findUnique: vi.fn(),
    },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/hibp.js', () => ({
  ensurePasswordNotPwned: vi.fn(async () => true),
}));

const { usersService } = await import('../src/modules/users/users.service.js');

const ADMIN_A = randomUUID();
const ADMIN_B = randomUUID();
const TARGET = randomUUID();

beforeEach(() => {
  store.users.length = 0;
  store.users.push(
    { id: ADMIN_A, tenant_id: TENANT, email: 'a@example.com', role: 'ADMIN', is_active: true, deleted_at: null },
    { id: ADMIN_B, tenant_id: TENANT, email: 'b@example.com', role: 'ADMIN', is_active: true, deleted_at: null },
    { id: TARGET,  tenant_id: TENANT, email: 'c@example.com', role: 'COUNSELLOR', is_active: true, deleted_at: null },
  );
});

describe('usersService.update — role mutation MFA guard (P0-2)', () => {
  it('REJECTS role promotion when actor.mfa_enabled is false', async () => {
    // ADMIN_A tries to promote TARGET to ADMIN but did not enrol MFA.
    await expect(
      usersService.update(
        TENANT,
        TARGET,
        { role: 'ADMIN' } as never,
        ADMIN_A,
        { actorMfaEnabled: false, actorMfaVerifiedAt: new Date() },
      ),
    ).rejects.toMatchObject({ status: 403 });
    // No state change.
    expect(store.users.find((u) => u.id === TARGET)!.role).toBe('COUNSELLOR');
  });

  it('REJECTS role promotion when actorMfaVerifiedAt is not set', async () => {
    // Admin DID enrol MFA but the request did not present X-MFA-Code.
    await expect(
      usersService.update(
        TENANT,
        TARGET,
        { role: 'ADMIN' } as never,
        ADMIN_A,
        { actorMfaEnabled: true, actorMfaVerifiedAt: undefined },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.users.find((u) => u.id === TARGET)!.role).toBe('COUNSELLOR');
  });

  it('REJECTS role demotion of another admin without MFA context', async () => {
    await expect(
      usersService.update(
        TENANT,
        ADMIN_B,
        { role: 'COUNSELLOR' } as never,
        ADMIN_A,
        { actorMfaEnabled: false },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.users.find((u) => u.id === ADMIN_B)!.role).toBe('ADMIN');
  });

  it('ALLOWS role promotion when actor has MFA + verified-at (defence-in-depth happy path)', async () => {
    const out = await usersService.update(
      TENANT,
      TARGET,
      { role: 'ADMIN' } as never,
      ADMIN_A,
      { actorMfaEnabled: true, actorMfaVerifiedAt: new Date() },
    );
    expect(out).toBeDefined();
    expect(store.users.find((u) => u.id === TARGET)!.role).toBe('ADMIN');
  });

  it('ALLOWS non-role mutation (display_name) WITHOUT MFA context — gate is role-specific', async () => {
    const out = await usersService.update(
      TENANT,
      TARGET,
      { display_name: 'Carol' } as never,
      ADMIN_A,
      // No MFA — display_name change is not a privilege-escalation pivot.
    );
    expect(out).toBeDefined();
    expect(store.users.find((u) => u.id === TARGET)?.['display_name' as never]).toBe('Carol');
  });

  it('does NOT trip the gate when the role field equals the target role (no-op role)', async () => {
    // The gate only fires on an ACTUAL change; submitting role=ADMIN against
    // an already-ADMIN target is a no-op and must not demand MFA.
    const out = await usersService.update(
      TENANT,
      ADMIN_B,
      { role: 'ADMIN' } as never,
      ADMIN_A,
      // No MFA on actor.
    );
    expect(out).toBeDefined();
  });
});
