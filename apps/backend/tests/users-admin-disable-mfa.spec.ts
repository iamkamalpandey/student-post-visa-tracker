// SVT-SEC-MFA-FORCE-DISABLE-2026-05 — admin-driven MFA unbrick route.
//
// Covers the route POST /users/:id/mfa/disable wired in users.routes.ts. The
// gate-chain under test is:
//   authenticate (stubbed)
//   tenantContext (not needed in the test app — service is called directly)
//   requireRole('ADMIN')         → 403 for COUNSELLOR
//   requireMfa                   → 401 mfa_required when admin has MFA on
//   uuidParam('id')              → 400 for non-uuid (covered elsewhere)
//   validate(AdminDisableMfaRequest) → 422 for missing reason
//   usersController.adminDisableMfa
//     → service:
//        - self-target → 403
//        - target not found → 404
//        - happy path → 204, audit row, refresh tokens revoked, mfa cleared
//
// Mocks Prisma in-memory so the service runs without a real database.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = '11111111-1111-7111-8111-111111111111';

type UserRow = {
  id: string;
  tenant_id: string;
  email: string;
  role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
  is_active: boolean;
  deleted_at: Date | null;
  mfa_enabled: boolean;
  mfa_secret_enc: Buffer | null;
  mfa_recovery_hashes: string | null;
};

type RefreshRow = {
  id: string;
  user_id: string;
  revoked_at: Date | null;
};

const store = {
  users: [] as UserRow[],
  refreshTokens: [] as RefreshRow[],
  audits: [] as Array<Record<string, unknown>>,
};

vi.mock('../src/config/db.js', () => {
  const matchWhere = (rows: UserRow[], where: Record<string, unknown>): UserRow[] =>
    rows.filter((r) => {
      for (const [k, v] of Object.entries(where)) {
        if (v === undefined) continue;
        if (v === null) {
          if ((r as Record<string, unknown>)[k] !== null) return false;
          continue;
        }
        if ((r as Record<string, unknown>)[k] !== v) return false;
      }
      return true;
    });
  const matchRefresh = (rows: RefreshRow[], where: Record<string, unknown>): RefreshRow[] =>
    rows.filter((r) => {
      for (const [k, v] of Object.entries(where)) {
        if (v === undefined) continue;
        if (v === null) {
          if ((r as Record<string, unknown>)[k] !== null) return false;
          continue;
        }
        if ((r as Record<string, unknown>)[k] !== v) return false;
      }
      return true;
    });
  const prisma = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchWhere(store.users, where)[0] ?? null),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        store.users.find((u) => u.id === where.id) ?? null),
      updateMany: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const rows = matchWhere(store.users, where);
          for (const r of rows) Object.assign(r, data);
          return { count: rows.length };
        },
      ),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchWhere(store.users, where).length),
    },
    refreshToken: {
      updateMany: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const rows = matchRefresh(store.refreshTokens, where);
          for (const r of rows) Object.assign(r, data);
          return { count: rows.length };
        },
      ),
    },
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (e: Record<string, unknown>) => {
    store.audits.push(e);
  }),
}));

vi.mock('../src/shared/encryption.js', () => ({
  // requireMfa needs to decrypt — return the secret bytes verbatim.
  decryptField: vi.fn(async (buf: Buffer) => buf.toString('utf8')),
  encryptField: vi.fn(async (buf: Buffer) => buf),
}));

// Deterministic TOTP shim: '123456' is the only accepted code for any secret.
vi.mock('../src/modules/auth/auth.totp.js', () => ({
  verifyTotp: vi.fn((_secret: string, code: string) => code === '123456'),
}));

const { usersService } = await import('../src/modules/users/users.service.js');
const { usersController } = await import('../src/modules/users/users.controller.js');
const { requireMfa, __resetMfaReplayCacheForTests } = await import(
  '../src/middlewares/requireMfa.js'
);
const { requireRole } = await import('../src/middlewares/auth.js');
const { uuidParam } = await import('../src/middlewares/uuidParam.js');
const { validate } = await import('../src/middlewares/validate.js');
const { errorHandler } = await import('../src/middlewares/errorHandler.js');
const { AdminDisableMfaRequest } = await import('@spv/zod-schemas');

const ADMIN_A = randomUUID();
const ADMIN_B = randomUUID();
const COUNSELLOR_C = randomUUID();
const TARGET = randomUUID();
const MISSING_ID = '00000000-0000-7000-8000-000000000000';

function makeApp(actor: { sub: string; tid: string; role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER' }) {
  const app = express();
  app.use(express.json());
  // Stub authenticate — populate req.user the way the real middleware would.
  app.use((req, _res, next) => {
    (req as unknown as { user: typeof actor }).user = actor;
    next();
  });
  // Mirror the production wiring from users.routes.ts. Note: we don't mount
  // tenantContext (it requires the Prisma extension machinery) — service uses
  // the top-level prisma client via the mock above.
  app.post(
    '/users/:id/mfa/disable',
    requireRole('ADMIN'),
    requireMfa,
    uuidParam('id'),
    validate(AdminDisableMfaRequest),
    usersController.adminDisableMfa,
  );
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  store.users.length = 0;
  store.refreshTokens.length = 0;
  store.audits.length = 0;
  __resetMfaReplayCacheForTests();
  // ADMIN_A — acting admin, MFA OFF (so requireMfa is a pass-through unless
  // an individual test flips it on).
  store.users.push({
    id: ADMIN_A,
    tenant_id: TENANT,
    email: 'a@example.com',
    role: 'ADMIN',
    is_active: true,
    deleted_at: null,
    mfa_enabled: false,
    mfa_secret_enc: null,
    mfa_recovery_hashes: null,
  });
  // ADMIN_B — second admin so the last-admin guard never trips in these tests.
  store.users.push({
    id: ADMIN_B,
    tenant_id: TENANT,
    email: 'b@example.com',
    role: 'ADMIN',
    is_active: true,
    deleted_at: null,
    mfa_enabled: false,
    mfa_secret_enc: null,
    mfa_recovery_hashes: null,
  });
  // COUNSELLOR_C — non-admin caller for the role-gate test.
  store.users.push({
    id: COUNSELLOR_C,
    tenant_id: TENANT,
    email: 'c@example.com',
    role: 'COUNSELLOR',
    is_active: true,
    deleted_at: null,
    mfa_enabled: false,
    mfa_secret_enc: null,
    mfa_recovery_hashes: null,
  });
  // TARGET — the locked-out user. MFA on, secret + recovery hashes populated
  // so we can assert they're cleared.
  store.users.push({
    id: TARGET,
    tenant_id: TENANT,
    email: 'target@example.com',
    role: 'COUNSELLOR',
    is_active: true,
    deleted_at: null,
    mfa_enabled: true,
    mfa_secret_enc: Buffer.from('SECRETBASE32SECRET'),
    mfa_recovery_hashes: 'a'.repeat(64) + ',' + 'b'.repeat(64),
  });
  // Two live refresh tokens for TARGET so we can assert revocation count.
  store.refreshTokens.push({ id: randomUUID(), user_id: TARGET, revoked_at: null });
  store.refreshTokens.push({ id: randomUUID(), user_id: TARGET, revoked_at: null });
});

describe('POST /users/:id/mfa/disable — admin force-disable MFA', () => {
  it('ADMIN can disable target user MFA → 204, MFA cleared, audit written, tokens revoked', async () => {
    const app = makeApp({ sub: ADMIN_A, tid: TENANT, role: 'ADMIN' });
    const res = await request(app)
      .post(`/users/${TARGET}/mfa/disable`)
      .send({ reason: 'Customer lost TOTP device and recovery codes; ticket SUP-1234' });

    expect(res.status).toBe(204);

    const target = store.users.find((u) => u.id === TARGET)!;
    expect(target.mfa_enabled).toBe(false);
    expect(target.mfa_secret_enc).toBeNull();
    expect(target.mfa_recovery_hashes).toBeNull();

    // Both live refresh tokens revoked.
    expect(store.refreshTokens.every((r) => r.revoked_at !== null)).toBe(true);

    // Audit row written with the right action, actor, target, and reason.
    const audit = store.audits.find((a) => a['action'] === 'auth.mfa.force_disabled_by_admin');
    expect(audit).toBeTruthy();
    expect(audit!['actorId']).toBe(ADMIN_A);
    expect(audit!['entityId']).toBe(TARGET);
    expect(audit!['tenantId']).toBe(TENANT);
    const after = audit!['after'] as Record<string, unknown>;
    expect(after['target_user_id']).toBe(TARGET);
    expect(after['reason']).toContain('SUP-1234');
    expect(after['was_enabled']).toBe(true);
  });

  it('ADMIN cannot disable own MFA → 403 (must use /auth/mfa/disable with password)', async () => {
    // Flip ADMIN_A's MFA on so the requireMfa gate is real; the route still
    // accepts the X-MFA-Code, but the service's self-guard fires first inside
    // the handler — exactly the security property under test.
    store.users.find((u) => u.id === ADMIN_A)!.mfa_enabled = true;
    store.users.find((u) => u.id === ADMIN_A)!.mfa_secret_enc = Buffer.from('SECRET_A');

    const app = makeApp({ sub: ADMIN_A, tid: TENANT, role: 'ADMIN' });
    const res = await request(app)
      .post(`/users/${ADMIN_A}/mfa/disable`)
      .set('X-MFA-Code', '123456')
      .send({ reason: 'trying to clear my own MFA' });

    expect(res.status).toBe(403);
    // ADMIN_A's MFA must still be enabled.
    expect(store.users.find((u) => u.id === ADMIN_A)!.mfa_enabled).toBe(true);
  });

  it('COUNSELLOR cannot call route → 403', async () => {
    const app = makeApp({ sub: COUNSELLOR_C, tid: TENANT, role: 'COUNSELLOR' });
    const res = await request(app)
      .post(`/users/${TARGET}/mfa/disable`)
      .send({ reason: 'should be blocked at role gate' });

    expect(res.status).toBe(403);
    // Target untouched.
    expect(store.users.find((u) => u.id === TARGET)!.mfa_enabled).toBe(true);
  });

  it('target user not found in tenant → 404', async () => {
    const app = makeApp({ sub: ADMIN_A, tid: TENANT, role: 'ADMIN' });
    const res = await request(app)
      .post(`/users/${MISSING_ID}/mfa/disable`)
      .send({ reason: 'ghost user — should 404' });

    expect(res.status).toBe(404);
  });

  it('missing reason → 422 validation error', async () => {
    const app = makeApp({ sub: ADMIN_A, tid: TENANT, role: 'ADMIN' });
    const res = await request(app)
      .post(`/users/${TARGET}/mfa/disable`)
      .send({}); // no reason

    expect(res.status).toBe(422);
    // Target untouched.
    expect(store.users.find((u) => u.id === TARGET)!.mfa_enabled).toBe(true);
  });

  it('reason too short (after trim) → 422', async () => {
    const app = makeApp({ sub: ADMIN_A, tid: TENANT, role: 'ADMIN' });
    const res = await request(app)
      .post(`/users/${TARGET}/mfa/disable`)
      .send({ reason: '  ab  ' }); // trims to "ab" — under min(3)

    expect(res.status).toBe(422);
  });

  it('admin with MFA enrolled but missing X-MFA-Code → 401 mfa_required', async () => {
    // Flip ADMIN_A's MFA on so requireMfa actually demands a code.
    store.users.find((u) => u.id === ADMIN_A)!.mfa_enabled = true;
    store.users.find((u) => u.id === ADMIN_A)!.mfa_secret_enc = Buffer.from('SECRET_A');

    const app = makeApp({ sub: ADMIN_A, tid: TENANT, role: 'ADMIN' });
    const res = await request(app)
      .post(`/users/${TARGET}/mfa/disable`)
      .send({ reason: 'should be blocked at mfa gate' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('mfa_required');
    // Target untouched.
    expect(store.users.find((u) => u.id === TARGET)!.mfa_enabled).toBe(true);
  });
});

// Direct service-level tests for the self-guard and audit semantics so we
// don't lose coverage if the route wiring is ever refactored.
describe('usersService.adminDisableMfa — service-level guards', () => {
  it('self-target throws 403 even when target exists and MFA is enabled', async () => {
    // Use TARGET as both actor and target to exercise the self-guard. The
    // route wiring also requires ADMIN role, but the service guard is the
    // authoritative defence (route gate alone could be misconfigured).
    await expect(
      usersService.adminDisableMfa(TENANT, TARGET, TARGET, 'self-target — should reject'),
    ).rejects.toMatchObject({ status: 403 });
    // No mutation.
    expect(store.users.find((u) => u.id === TARGET)!.mfa_enabled).toBe(true);
  });

  it('missing target throws 404', async () => {
    await expect(
      usersService.adminDisableMfa(TENANT, MISSING_ID, ADMIN_A, 'ghost target'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('cross-tenant target is not visible → 404 (tenant isolation)', async () => {
    const OTHER_TENANT = '99999999-9999-7999-8999-999999999999';
    await expect(
      usersService.adminDisableMfa(OTHER_TENANT, TARGET, ADMIN_A, 'cross-tenant attempt'),
    ).rejects.toMatchObject({ status: 404 });
    // Target's MFA must remain enabled.
    expect(store.users.find((u) => u.id === TARGET)!.mfa_enabled).toBe(true);
  });
});
