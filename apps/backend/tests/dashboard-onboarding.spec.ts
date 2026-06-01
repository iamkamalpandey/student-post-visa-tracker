// SVT-WAVE60-ONBOARDING-2026-05 — first-run onboarding checklist endpoint.
//
// /api/v1/dashboard/onboarding returns the 8 setup steps a fresh tenant must
// complete. Verifies each step's complete computation, the aggregated
// complete_count, the 60s per-tenant cache, role gating (VIEWER denied), and
// auth gating (401 without bearer).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', PRIVATE_PEM);
vi.stubEnv('JWT_PUBLIC_KEY', PUBLIC_PEM);
vi.stubEnv('JWT_KID', 'test-kid');
vi.stubEnv('JWT_ISSUER', 'spv-api-test');
vi.stubEnv('JWT_AUDIENCE', 'spv-app-test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const USER_A = '22222222-2222-7222-8222-222222222222';

type TenantRow = {
  id: string;
  legal_name: string | null;
  name: string;
  billing_enabled: boolean;
};
type UserRow = {
  id: string;
  tenant_id: string;
  role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
  mfa_enabled: boolean;
};
type CountableRow = { tenant_id: string; deleted_at?: Date | null };

const store = {
  tenants: [] as TenantRow[],
  users: [] as UserRow[],
  students: [] as CountableRow[],
  institutions: [] as CountableRow[],
  programs: [] as CountableRow[],
  stages: [] as CountableRow[],
};

function whereMatches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === null && row[k] != null) return false;
    if (v !== null && typeof v !== 'object' && row[k] !== v) return false;
  }
  return true;
}

vi.mock('../src/config/db.js', () => {
  const prisma = {
    tenant: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return store.tenants.find((t) => t.id === where.id) ?? null;
      }),
    },
    user: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.users.filter((u) => whereMatches(u as unknown as Record<string, unknown>, where)).length;
      }),
    },
    student: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.students.filter((s) => whereMatches(s as unknown as Record<string, unknown>, where)).length;
      }),
    },
    institution: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.institutions.filter((s) => whereMatches(s as unknown as Record<string, unknown>, where)).length;
      }),
    },
    program: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.programs.filter((s) => whereMatches(s as unknown as Record<string, unknown>, where)).length;
      }),
    },
    lifecycleStage: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return store.stages.filter((s) => whereMatches(s as unknown as Record<string, unknown>, where)).length;
      }),
    },
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    $extends: vi.fn(function (this: unknown) { return prisma; }),
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, disconnectDb: async () => undefined };
});

// /summary handler imports the expiry job — onboarding doesn't use it, but the
// router module pulls it in at import time.
vi.mock('../src/jobs/expiryAlerts.js', () => ({
  findUpcomingExpiries: async () => [],
}));

const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { dashboardRouter, _clearOnboardingCache } = await import('../src/modules/dashboard/dashboard.routes.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/dashboard', authenticate, tenantContext, dashboardRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let app: Express;
let adminToken: string;
let viewerToken: string;

beforeEach(async () => {
  store.tenants.length = 0;
  store.users.length = 0;
  store.students.length = 0;
  store.institutions.length = 0;
  store.programs.length = 0;
  store.stages.length = 0;
  _clearOnboardingCache();
  if (!app) app = makeApp();
  if (!adminToken) {
    adminToken = await signAccessToken({ sub: USER_A, tid: TENANT_A, role: 'ADMIN', jti: randomUUID() });
  }
  if (!viewerToken) {
    viewerToken = await signAccessToken({ sub: USER_A, tid: TENANT_A, role: 'VIEWER', jti: randomUUID() });
  }
});

afterEach(() => {
  _clearOnboardingCache();
});

function seedTenant(opts: Partial<TenantRow> = {}): TenantRow {
  const t: TenantRow = {
    id: TENANT_A,
    legal_name: 'Default Tenant',
    name: 'Default Tenant',
    billing_enabled: false,
    ...opts,
  };
  store.tenants.push(t);
  return t;
}

function seedUsers(rows: Partial<UserRow>[]): void {
  rows.forEach((r) => {
    store.users.push({
      id: randomUUID(),
      tenant_id: TENANT_A,
      role: 'COUNSELLOR',
      mfa_enabled: false,
      ...r,
    });
  });
}

function getStep(body: { data: { steps: Array<{ id: string; complete: boolean }> } }, id: string): { id: string; complete: boolean } {
  const step = body.data.steps.find((s) => s.id === id);
  if (!step) throw new Error(`step ${id} not found in response`);
  return step;
}

describe('GET /api/v1/dashboard/onboarding', () => {
  it('returns 401 without bearer', async () => {
    const res = await request(app).get('/api/v1/dashboard/onboarding');
    expect(res.status).toBe(401);
  });

  it('returns 403 for VIEWER role', async () => {
    seedTenant();
    const res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  // 1. tenant_settings
  it('tenant_settings: incomplete for "Default Tenant" legal_name, complete once renamed', async () => {
    seedTenant({ legal_name: 'Default Tenant' });
    let res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(getStep(res.body, 'tenant_settings').complete).toBe(false);

    _clearOnboardingCache();
    store.tenants[0]!.legal_name = 'Acme Education Ltd';
    res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'tenant_settings').complete).toBe(true);
  });

  // 2. first_user_invited
  it('first_user_invited: incomplete with 1 user, complete with 2+', async () => {
    seedTenant();
    seedUsers([{ role: 'ADMIN' }]);
    let res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'first_user_invited').complete).toBe(false);

    _clearOnboardingCache();
    seedUsers([{ role: 'COUNSELLOR' }]);
    res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'first_user_invited').complete).toBe(true);
  });

  // 3. first_student
  it('first_student: incomplete with 0 students, complete with 1+ (soft-deleted ignored)', async () => {
    seedTenant();
    let res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'first_student').complete).toBe(false);

    _clearOnboardingCache();
    store.students.push({ tenant_id: TENANT_A, deleted_at: new Date() }); // soft-deleted
    res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'first_student').complete).toBe(false);

    _clearOnboardingCache();
    store.students.push({ tenant_id: TENANT_A, deleted_at: null });
    res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'first_student').complete).toBe(true);
  });

  // 4. first_institution
  it('first_institution: flips to complete with at least 1 institution', async () => {
    seedTenant();
    let res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'first_institution').complete).toBe(false);

    _clearOnboardingCache();
    store.institutions.push({ tenant_id: TENANT_A });
    res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'first_institution').complete).toBe(true);
  });

  // 5. first_program
  it('first_program: flips to complete with at least 1 program', async () => {
    seedTenant();
    let res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'first_program').complete).toBe(false);

    _clearOnboardingCache();
    store.programs.push({ tenant_id: TENANT_A });
    res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'first_program').complete).toBe(true);
  });

  // 6. lifecycle_stages_seeded
  it('lifecycle_stages_seeded: complete when at least 1 stage exists', async () => {
    seedTenant();
    let res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'lifecycle_stages_seeded').complete).toBe(false);

    _clearOnboardingCache();
    store.stages.push({ tenant_id: TENANT_A });
    res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'lifecycle_stages_seeded').complete).toBe(true);
  });

  // 7. billing_decision
  it('billing_decision: complete only when tenant.billing_enabled is true', async () => {
    seedTenant({ billing_enabled: false });
    let res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'billing_decision').complete).toBe(false);

    _clearOnboardingCache();
    store.tenants[0]!.billing_enabled = true;
    res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'billing_decision').complete).toBe(true);
  });

  // 8. mfa_enabled_for_admin
  it('mfa_enabled_for_admin: complete only when at least one ADMIN has mfa_enabled=true', async () => {
    seedTenant();
    seedUsers([{ role: 'ADMIN', mfa_enabled: false }, { role: 'COUNSELLOR', mfa_enabled: true }]);
    let res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    // COUNSELLOR with mfa doesn't satisfy — must be an ADMIN.
    expect(getStep(res.body, 'mfa_enabled_for_admin').complete).toBe(false);

    _clearOnboardingCache();
    store.users[0]!.mfa_enabled = true; // admin now has MFA
    res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'mfa_enabled_for_admin').complete).toBe(true);
  });

  it('complete_count reflects the sum of complete steps and steps shape stable', async () => {
    seedTenant({ legal_name: 'Acme Education Ltd', billing_enabled: true });
    seedUsers([
      { role: 'ADMIN', mfa_enabled: true },
      { role: 'COUNSELLOR' },
    ]);
    store.students.push({ tenant_id: TENANT_A, deleted_at: null });
    store.institutions.push({ tenant_id: TENANT_A });
    store.programs.push({ tenant_id: TENANT_A });
    store.stages.push({ tenant_id: TENANT_A });

    const res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.steps).toHaveLength(8);
    expect(res.body.data.complete_count).toBe(8);
    expect(res.body.data.steps.map((s: { id: string }) => s.id)).toEqual([
      'tenant_settings',
      'first_user_invited',
      'first_student',
      'first_institution',
      'first_program',
      'lifecycle_stages_seeded',
      'billing_decision',
      'mfa_enabled_for_admin',
    ]);
    res.body.data.steps.forEach((s: { id: string; action_url: string; label: string }) => {
      expect(typeof s.label).toBe('string');
      expect(s.action_url.startsWith('/')).toBe(true);
    });
  });

  it('caches the payload per tenant for 60s (mocked-clock-free: stale flag flip not visible until clear)', async () => {
    seedTenant({ legal_name: 'Default Tenant' });
    let res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'tenant_settings').complete).toBe(false);

    // Mutate the store WITHOUT clearing the cache. A second request should
    // still see the cached "incomplete" answer.
    store.tenants[0]!.legal_name = 'Acme Education Ltd';
    res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'tenant_settings').complete).toBe(false);

    // After clearing the cache the new value is visible.
    _clearOnboardingCache();
    res = await request(app)
      .get('/api/v1/dashboard/onboarding')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getStep(res.body, 'tenant_settings').complete).toBe(true);
  });
});
