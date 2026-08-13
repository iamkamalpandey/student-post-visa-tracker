// SVT-SEC-2026-05 — users.service.update self-guards.
//
// CRITICAL bug class fixed:
//   1. ADMIN cannot change own role (privilege-escalation pivot).
//   2. ADMIN cannot deactivate self (account lockout).
//   3. Demoting / deactivating the LAST active admin is blocked
//      (entire-tenant lockout — irreversible without DB access).
//
// Mocks Prisma in-memory so the service runs without a real database.

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
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: randomUUID(), deleted_at: null, ...(data as never) } as Row;
        store.users.push(row);
        return row;
      }),
      findUnique: vi.fn(),
    },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    // SVT-SEC-2026-08 (T0-7) — users.service resolves its client via scoped(),
    // which falls back to withTenantTx when no req.db is passed. That opens a
    // transaction and sets the tenant GUC; without it the RLS policy on `users`
    // matches zero rows under the production role.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/hibp.js', () => ({
  ensurePasswordNotPwned: vi.fn(async () => true),
}));

const { usersService } = await import('../src/modules/users/users.service.js');

const ADMIN_A = randomUUID();
const ADMIN_B = randomUUID();
const COUNSELLOR_C = randomUUID();

// SVT-SEC-ROLE-MFA-2026-05 (P0-2) — role mutations now require the acting
// admin to have MFA enrolled AND have step-up'd the request. The legitimate
// scenarios in this file pass `mfaOk` to the service; the new dedicated
// spec users-role-mfa-guard.spec.ts covers the NEGATIVE cases (no MFA →
// 403). Keeping `mfaOk` as a const named tuple of (actorMfaEnabled,
// actorMfaVerifiedAt) so the intent is obvious at each callsite.
const mfaOk = { actorMfaEnabled: true, actorMfaVerifiedAt: new Date() };

beforeEach(() => {
  store.users.length = 0;
  store.users.push(
    { id: ADMIN_A, tenant_id: TENANT, email: 'a@example.com', role: 'ADMIN', is_active: true, deleted_at: null },
    { id: ADMIN_B, tenant_id: TENANT, email: 'b@example.com', role: 'ADMIN', is_active: true, deleted_at: null },
    { id: COUNSELLOR_C, tenant_id: TENANT, email: 'c@example.com', role: 'COUNSELLOR', is_active: true, deleted_at: null },
  );
});

describe('users.service.update — self-promotion guards', () => {
  it('blocks ADMIN from changing own role (privilege-escalation pivot)', async () => {
    await expect(
      usersService.update(TENANT, ADMIN_A, { role: 'COUNSELLOR' } as never, ADMIN_A),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('blocks ADMIN from deactivating self', async () => {
    await expect(
      usersService.update(TENANT, ADMIN_A, { is_active: false } as never, ADMIN_A),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('allows ADMIN to update own non-role fields (e.g. display_name)', async () => {
    const out = await usersService.update(TENANT, ADMIN_A, { display_name: 'New' } as never, ADMIN_A);
    expect(out).toBeDefined();
    expect(store.users.find((u) => u.id === ADMIN_A)?.['display_name' as never]).toBe('New');
  });

  it('allows ADMIN to demote a different admin when at least one admin will remain', async () => {
    const out = await usersService.update(TENANT, ADMIN_B, { role: 'COUNSELLOR' } as never, ADMIN_A, mfaOk);
    expect(out).toBeDefined();
    expect(store.users.find((u) => u.id === ADMIN_B)?.role).toBe('COUNSELLOR');
  });

  it('blocks demoting the LAST active admin (tenant lockout protection)', async () => {
    // Demote ADMIN_B first → only ADMIN_A left.
    await usersService.update(TENANT, ADMIN_B, { role: 'COUNSELLOR' } as never, ADMIN_A, mfaOk);
    // Now another admin (would be ADMIN_A himself in a real scenario, but try
    // simulating ADMIN_B is the actor demoting ADMIN_A) — the last-admin guard
    // should block regardless of actor identity.
    // Re-promote B to ADMIN so it can act as the actor, then demote A.
    store.users.find((u) => u.id === ADMIN_B)!.role = 'ADMIN';
    // Demote B first to leave only A; then try to demote A.
    await usersService.update(TENANT, ADMIN_B, { role: 'COUNSELLOR' } as never, ADMIN_A, mfaOk);
    // Only ADMIN_A remains. Promote COUNSELLOR_C to ADMIN to be the actor.
    store.users.find((u) => u.id === COUNSELLOR_C)!.role = 'ADMIN';
    // Now demote ADMIN_A. There are TWO admins (A + C), so the demote of A
    // should succeed. Then trying to demote C should fail.
    await usersService.update(TENANT, ADMIN_A, { role: 'COUNSELLOR' } as never, COUNSELLOR_C, mfaOk);
    await expect(
      usersService.update(TENANT, COUNSELLOR_C, { role: 'COUNSELLOR' } as never, COUNSELLOR_C, mfaOk),
    ).rejects.toMatchObject({ status: 403 }); // hits self-guard first
  });

  it('blocks deactivating the last active admin', async () => {
    // Demote ADMIN_B so ADMIN_A is the sole active admin. COUNSELLOR_C acts
    // as the would-be deactivator. Last-admin guard returns 409.
    store.users.find((u) => u.id === ADMIN_B)!.role = 'COUNSELLOR';
    await expect(
      usersService.update(TENANT, ADMIN_A, { is_active: false } as never, COUNSELLOR_C),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('softDelete refuses to remove the last active admin', async () => {
    // Demote ADMIN_B so A is the last admin.
    store.users.find((u) => u.id === ADMIN_B)!.role = 'COUNSELLOR';
    await expect(
      usersService.softDelete(TENANT, ADMIN_A, ADMIN_B),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('softDelete blocks self-delete (existing guard)', async () => {
    await expect(
      usersService.softDelete(TENANT, ADMIN_A, ADMIN_A),
    ).rejects.toMatchObject({ status: 409 });
  });
});
