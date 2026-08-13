// SVT-SEC-MFA-STEPUP-2026-05 (P1-5 + P0-2) — admin USER MUTATION routes are
// gated by requireMfa({enrollmentRequired:true}). Verifies:
//
//   1. PATCH /users/:id without MFA enrolled on the actor → 403
//      mfa_enrollment_required.
//   2. PATCH /users/:id with MFA enrolled but NO X-MFA-Code → 401
//      mfa_required.
//   3. DELETE /users/:id same gate.
//   4. POST /users/:id/reset-password same gate.
//   5. POST /users/:id/sessions/revoke same gate.

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
};

const store = { users: [] as UserRow[] };

vi.mock('../src/config/db.js', () => {
  const matchWhere = (rows: UserRow[], where: Record<string, unknown>): UserRow[] =>
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
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        store.users.find((u) => u.id === where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const rows = matchWhere(store.users, where);
        for (const r of rows) Object.assign(r, data);
        return { count: rows.length };
      }),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchWhere(store.users, where).length),
    },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
  // SVT-SEC-2026-08 (T0-7) — users.service resolves its client via scoped(),
  // which falls back to withTenantTx when the caller passes no req.db. That
  // opens a transaction and sets the tenant GUC; without it the RLS policy on
  // `users` matches zero rows under the production role.
  (prisma as Record<string, unknown>)['$transaction'] =
    vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  (prisma as Record<string, unknown>)['$executeRaw'] = vi.fn(async () => 1);

  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock('../src/shared/encryption.js', () => ({
  decryptField: vi.fn(async (buf: Buffer) => buf.toString('utf8')),
  encryptField: vi.fn(async (buf: Buffer) => buf),
}));
vi.mock('../src/modules/auth/auth.totp.js', () => ({
  verifyTotp: vi.fn((_secret: string, code: string) => code === '123456'),
}));
vi.mock('../src/shared/hibp.js', () => ({
  ensurePasswordNotPwned: vi.fn(async () => true),
}));
vi.mock('../src/shared/passwords.js', () => ({
  hashPassword: vi.fn(async () => 'argon2$hashed'),
}));

const { usersController } = await import('../src/modules/users/users.controller.js');
const { requireMfa, __resetMfaReplayCacheForTests } = await import('../src/middlewares/requireMfa.js');
const { requireRole } = await import('../src/middlewares/auth.js');
const { uuidParam } = await import('../src/middlewares/uuidParam.js');
const { validate } = await import('../src/middlewares/validate.js');
const { errorHandler } = await import('../src/middlewares/errorHandler.js');
const { UpdateUserRequest, ResetPasswordRequest, CreateUserRequest } = await import('@spv/zod-schemas');

const ADMIN_NOMFA = randomUUID();
const ADMIN_MFA = randomUUID();
const ADMIN_OTHER = randomUUID();
const TARGET = randomUUID();

function makeApp(actor: { sub: string; role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { sub: string; tid: string; role: typeof actor.role } }).user = {
      sub: actor.sub,
      tid: TENANT,
      role: actor.role,
    };
    next();
  });
  // Mirror production wiring from users.routes.ts.
  app.patch(
    '/users/:id',
    uuidParam('id'),
    requireRole('ADMIN'),
    requireMfa({ enrollmentRequired: true }),
    validate(UpdateUserRequest),
    usersController.update,
  );
  app.delete(
    '/users/:id',
    uuidParam('id'),
    requireRole('ADMIN'),
    requireMfa({ enrollmentRequired: true }),
    usersController.softDelete,
  );
  app.post(
    '/users/:id/reset-password',
    uuidParam('id'),
    requireRole('ADMIN'),
    requireMfa({ enrollmentRequired: true }),
    validate(ResetPasswordRequest),
    usersController.resetPassword,
  );
  app.post(
    '/users/:id/sessions/revoke',
    uuidParam('id'),
    requireRole('ADMIN'),
    requireMfa({ enrollmentRequired: true }),
    usersController.revokeAllSessions,
  );
  // SVT-SEC-2026-08 — create, now gated like every other mutation here.
  app.post(
    '/users',
    requireRole('ADMIN'),
    requireMfa({ enrollmentRequired: true }),
    validate(CreateUserRequest),
    usersController.create,
  );
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  store.users.length = 0;
  __resetMfaReplayCacheForTests();
  store.users.push({
    id: ADMIN_NOMFA, tenant_id: TENANT, email: 'noMfa@example.com',
    role: 'ADMIN', is_active: true, deleted_at: null,
    mfa_enabled: false, mfa_secret_enc: null,
  });
  store.users.push({
    id: ADMIN_MFA, tenant_id: TENANT, email: 'mfa@example.com',
    role: 'ADMIN', is_active: true, deleted_at: null,
    mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
  });
  // Second mfa-enrolled admin so the last-admin guard never trips when
  // mutating the others.
  store.users.push({
    id: ADMIN_OTHER, tenant_id: TENANT, email: 'other@example.com',
    role: 'ADMIN', is_active: true, deleted_at: null,
    mfa_enabled: true, mfa_secret_enc: Buffer.from('SECRET'),
  });
  store.users.push({
    id: TARGET, tenant_id: TENANT, email: 'target@example.com',
    role: 'COUNSELLOR', is_active: true, deleted_at: null,
    mfa_enabled: false, mfa_secret_enc: null,
  });
});

describe('admin user mutation routes — MFA enrolment gate (P1-5)', () => {
  it('PATCH /users/:id — admin WITHOUT MFA enrolled → 403 mfa_enrollment_required', async () => {
    const app = makeApp({ sub: ADMIN_NOMFA, role: 'ADMIN' });
    const res = await request(app)
      .patch(`/users/${TARGET}`)
      .send({ display_name: 'New Name' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('mfa_enrollment_required');
  });

  it('PATCH /users/:id — admin with MFA enrolled but missing X-MFA-Code → 401 mfa_required', async () => {
    const app = makeApp({ sub: ADMIN_MFA, role: 'ADMIN' });
    const res = await request(app)
      .patch(`/users/${TARGET}`)
      .send({ display_name: 'New Name' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('mfa_required');
  });

  it('PATCH /users/:id — admin with MFA + valid X-MFA-Code, non-role mutation → 200', async () => {
    const app = makeApp({ sub: ADMIN_MFA, role: 'ADMIN' });
    const res = await request(app)
      .patch(`/users/${TARGET}`)
      .set('X-MFA-Code', '123456')
      .send({ display_name: 'New Name' });
    expect(res.status).toBe(200);
  });

  // SVT-SEC-ROLE-MFA-2026-05 (P0-2) — even with the route gate satisfied,
  // role MUTATION still requires the service-level guard to see a valid
  // mfa-verified-at on the request (defence-in-depth).
  it('PATCH /users/:id — role promotion succeeds when actor has MFA + X-MFA-Code', async () => {
    const app = makeApp({ sub: ADMIN_MFA, role: 'ADMIN' });
    const res = await request(app)
      .patch(`/users/${TARGET}`)
      .set('X-MFA-Code', '123456')
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(200);
    expect(store.users.find((u) => u.id === TARGET)!.role).toBe('ADMIN');
  });

  it('DELETE /users/:id — admin WITHOUT MFA → 403 mfa_enrollment_required', async () => {
    const app = makeApp({ sub: ADMIN_NOMFA, role: 'ADMIN' });
    const res = await request(app).delete(`/users/${TARGET}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('mfa_enrollment_required');
  });

  it('POST /users/:id/reset-password — admin WITHOUT MFA → 403 mfa_enrollment_required', async () => {
    const app = makeApp({ sub: ADMIN_NOMFA, role: 'ADMIN' });
    const res = await request(app)
      .post(`/users/${TARGET}/reset-password`)
      .send({ new_password: 'BrandNewLongPwd!2026' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('mfa_enrollment_required');
  });

  it('POST /users/:id/sessions/revoke — admin WITHOUT MFA → 403 mfa_enrollment_required', async () => {
    const app = makeApp({ sub: ADMIN_NOMFA, role: 'ADMIN' });
    const res = await request(app).post(`/users/${TARGET}/sessions/revoke`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('mfa_enrollment_required');
  });

  // SVT-SEC-2026-08 — CREATE was exempt from this gate on the reasoning that it
  // "doesn't mutate existing accounts". True, and beside the point: `role` is
  // client-supplied and RoleEnum includes ADMIN, so a stolen admin token that
  // could not patch, delete, reset or revoke anything could still mint a fresh
  // ADMIN with a chosen password and no MFA, then log in as it. Persistence is
  // worth more than any single mutation the gate was guarding.
  //
  // These two cases exist so the exemption cannot be reinstated quietly.
  it('POST /users — admin WITHOUT MFA cannot mint a new ADMIN → 403 mfa_enrollment_required', async () => {
    const app = makeApp({ sub: ADMIN_NOMFA, role: 'ADMIN' });
    const res = await request(app).post('/users').send({
      email: 'attacker@example.com',
      password: 'BrandNewLongPwd!2026',
      given_name: 'A',
      family_name: 'B',
      role: 'ADMIN',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('mfa_enrollment_required');
  });

  it('POST /users — enrolled admin still needs a fresh X-MFA-Code → 401 mfa_required', async () => {
    const app = makeApp({ sub: ADMIN_MFA, role: 'ADMIN' });
    const res = await request(app).post('/users').send({
      email: 'newjoiner@example.com',
      password: 'BrandNewLongPwd!2026',
      given_name: 'C',
      family_name: 'D',
      role: 'COUNSELLOR',
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('mfa_required');
  });
});
