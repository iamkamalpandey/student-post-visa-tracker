// SVT-WAVE-AUDIT-USERS-2026-06 (W1.3) — user-account lifecycle audit trail.
//
// GDPR / OWASP-ASVS-V7 accountability: the privileged user-account mutations
// (create, update incl. role change / deactivation, soft-delete, admin
// password reset, force session revoke) MUST leave a tamper-evident audit
// row. Before this wave the only writeAudit in the module was adminDisableMfa,
// so privilege escalation (promoting a peer to ADMIN) and account takeover
// (admin password reset) left no trace.
//
// This spec mirrors the in-memory Prisma mock pattern of
// users-self-promotion-guard.spec.ts + billing-payment-actions.spec.ts:
//   - mock ../src/config/db.js with an object store + matchWhere helper
//   - mock ../src/shared/audit.js to capture every writeAudit call
//   - mock ../src/shared/passwords.js + ../src/shared/hibp.js so the service
//     runs without argon2 / network.
//
// We assert each mutation pushes ONE audit entry with the correct action +
// actorId + entityId, and that update's before/after reflect a role change.

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
  given_name?: string;
  family_name?: string;
  role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
  is_active: boolean;
  password_hash?: string;
  deleted_at: Date | null;
};

type AuditCall = {
  action: string;
  actorId?: string;
  entityId?: string;
  tenantId?: string;
  entityType?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

const store = {
  users: [] as Row[],
  refreshTokens: [] as Array<{ user_id: string; revoked_at: Date | null }>,
};
const auditCalls: AuditCall[] = [];

vi.mock('../src/config/db.js', () => {
  const matchWhere = <T extends Record<string, unknown>>(rows: T[], where: Record<string, unknown>): T[] =>
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
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        // Supports both `{ id }` and the composite `tenant_id_email` lookup.
        const composite = (where as { tenant_id_email?: { tenant_id: string; email: string } })
          .tenant_id_email;
        if (composite) {
          return store.users.find(
            (u) => u.tenant_id === composite.tenant_id && u.email === composite.email,
          ) ?? null;
        }
        return matchWhere(store.users, where)[0] ?? null;
      }),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchWhere(store.users, where).length),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: randomUUID(), deleted_at: null, ...(data as never) } as Row;
        store.users.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = matchWhere(store.users, where);
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      }),
    },
    tenant: {
      findFirst: vi.fn(async () => ({ default_locale: 'en', default_timezone: 'UTC' })),
    },
    refreshToken: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = store.refreshTokens.filter(
          (t) => t.user_id === where['user_id'] && t.revoked_at === null,
        );
        for (const t of rows) Object.assign(t, data);
        return { count: rows.length };
      }),
    },
  };
  return { prisma, disconnectDb: async () => undefined };
});

// Capture every writeAudit call. The service uses the 1-arg loose form
// (writeAudit({...} as never)); push the single argument verbatim.
vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (e: AuditCall) => { auditCalls.push(e); }),
}));

// Avoid argon2 work + keep the hash deterministic (so we can assert it is
// NEVER surfaced into an audit payload).
vi.mock('../src/shared/passwords.js', () => ({
  hashPassword: vi.fn(async () => 'argon2-hash-stub'),
  verifyPassword: vi.fn(async () => true),
}));

vi.mock('../src/shared/hibp.js', () => ({
  ensurePasswordNotPwned: vi.fn(async () => true),
}));

const { usersService } = await import('../src/modules/users/users.service.js');

const ADMIN_ACTOR = randomUUID();
const ADMIN_B = randomUUID();
const TARGET = randomUUID();

const seedTargetTokens = (count: number) => {
  for (let i = 0; i < count; i++) store.refreshTokens.push({ user_id: TARGET, revoked_at: null });
};

beforeEach(() => {
  store.users.length = 0;
  store.refreshTokens.length = 0;
  auditCalls.length = 0;
  store.users.push(
    { id: ADMIN_ACTOR, tenant_id: TENANT, email: 'actor@example.com', role: 'ADMIN', is_active: true, deleted_at: null },
    { id: ADMIN_B, tenant_id: TENANT, email: 'b@example.com', role: 'ADMIN', is_active: true, deleted_at: null },
    { id: TARGET, tenant_id: TENANT, email: 'target@example.com', given_name: 'Tara', family_name: 'Jet', role: 'COUNSELLOR', is_active: true, deleted_at: null },
  );
});

const auditFor = (action: string) => auditCalls.filter((c) => c.action === action);

describe('users.service — lifecycle audit trail (W1.3)', () => {
  it('create() writes a user.created audit row with actor + new account shape (no secrets)', async () => {
    const created = await usersService.create(
      TENANT,
      {
        email: 'new@example.com',
        password: 'Sup3rSecret!Pw2026',
        given_name: 'New',
        family_name: 'User',
        role: 'COUNSELLOR',
      } as never,
      ADMIN_ACTOR,
    );

    const rows = auditFor('user.created');
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.actorId).toBe(ADMIN_ACTOR);
    expect(a.entityId).toBe(created.id);
    expect(a.tenantId).toBe(TENANT);
    expect(a.entityType).toBe('user');
    expect(a.after).toMatchObject({
      email: 'new@example.com',
      role: 'COUNSELLOR',
      given_name: 'New',
      family_name: 'User',
    });
    // Never log the password or its hash.
    const blob = JSON.stringify(a);
    expect(blob).not.toContain('Sup3rSecret!Pw2026');
    expect(blob).not.toContain('argon2-hash-stub');
    expect(a.after).not.toHaveProperty('password');
    expect(a.after).not.toHaveProperty('password_hash');
  });

  it('update() role promotion writes user.updated with before/after reflecting the role change', async () => {
    // Promote TARGET (COUNSELLOR → ADMIN) — the privilege-escalation case.
    // Satisfy the role-mutation MFA gate via the opts so the guard passes.
    await usersService.update(
      TENANT,
      TARGET,
      { role: 'ADMIN' } as never,
      ADMIN_ACTOR,
      { actorMfaEnabled: true, actorMfaVerifiedAt: new Date() },
    );

    const rows = auditFor('user.updated');
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.actorId).toBe(ADMIN_ACTOR);
    expect(a.entityId).toBe(TARGET);
    expect(a.tenantId).toBe(TENANT);
    expect(a.entityType).toBe('user');
    // before/after must clearly show the privilege escalation.
    expect(a.before).toMatchObject({ role: 'COUNSELLOR', is_active: true });
    expect(a.after).toMatchObject({ role: 'ADMIN', is_active: true });
    // And the store actually changed (guards passed).
    expect(store.users.find((u) => u.id === TARGET)!.role).toBe('ADMIN');
  });

  it('update() deactivation writes user.updated with is_active before=true after=false', async () => {
    await usersService.update(
      TENANT,
      TARGET,
      { is_active: false } as never,
      ADMIN_ACTOR,
    );
    const a = auditFor('user.updated')[0]!;
    expect(a.before).toMatchObject({ is_active: true, role: 'COUNSELLOR' });
    expect(a.after).toMatchObject({ is_active: false, role: 'COUNSELLOR' });
  });

  it('softDelete() writes a user.deleted audit row with prior state + deleted:true', async () => {
    await usersService.softDelete(TENANT, TARGET, ADMIN_ACTOR);

    const rows = auditFor('user.deleted');
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.actorId).toBe(ADMIN_ACTOR);
    expect(a.entityId).toBe(TARGET);
    expect(a.tenantId).toBe(TENANT);
    expect(a.before).toMatchObject({ is_active: true, role: 'COUNSELLOR' });
    expect(a.after).toMatchObject({ deleted: true });
  });

  it('resetPassword() writes user.password_reset_by_admin and NEVER logs the password', async () => {
    seedTargetTokens(2);
    await usersService.resetPassword(TENANT, TARGET, 'BrandNew!Passw0rd2026', ADMIN_ACTOR);

    const rows = auditFor('user.password_reset_by_admin');
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.actorId).toBe(ADMIN_ACTOR);
    expect(a.entityId).toBe(TARGET);
    expect(a.tenantId).toBe(TENANT);
    expect(a.after).toMatchObject({ sessions_revoked: true });
    const blob = JSON.stringify(a);
    expect(blob).not.toContain('BrandNew!Passw0rd2026');
    expect(blob).not.toContain('argon2-hash-stub');
    // Sessions were actually revoked as part of the flow.
    expect(store.refreshTokens.every((t) => t.revoked_at !== null)).toBe(true);
  });

  it('revokeAllSessions() writes user.sessions_revoked with the revoked count', async () => {
    seedTargetTokens(3);
    const result = await usersService.revokeAllSessions(TENANT, TARGET, ADMIN_ACTOR);
    expect(result.revoked).toBe(3);

    const rows = auditFor('user.sessions_revoked');
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.actorId).toBe(ADMIN_ACTOR);
    expect(a.entityId).toBe(TARGET);
    expect(a.tenantId).toBe(TENANT);
    expect(a.after).toMatchObject({ revoked: 3 });
  });

  it('a rejected mutation (last-admin guard) writes NO audit row', async () => {
    // Demote ADMIN_B so ADMIN_ACTOR is the sole active admin, then a third
    // admin (TARGET promoted) attempts to deactivate the last admin → 409.
    store.users.find((u) => u.id === ADMIN_B)!.role = 'COUNSELLOR';
    await expect(
      usersService.update(TENANT, ADMIN_ACTOR, { is_active: false } as never, TARGET),
    ).rejects.toMatchObject({ status: 409 });
    expect(auditCalls).toHaveLength(0);
  });
});
