// SVT-WAVE33-SLA-2026-05 — SLA breach detection endpoint.
//
// /api/v1/dashboard/sla-breaches returns students whose elapsed time in their
// current stage exceeds the stage's sla_hours threshold. Verifies: hidden
// stages excluded, stages without SLA excluded, terminal statuses excluded,
// ordering by worst breach first, tenant isolation.

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

type StageRow = {
  id: string; tenant_id: string; key: string; label: string;
  sla_hours: number | null; color_hex: string | null;
  show_on_dashboard: boolean;
};
type StudentRow = {
  id: string; tenant_id: string; student_code: string;
  given_name: string; family_name: string;
  current_stage_id: string; stage_entered_at: Date;
  status: string; deleted_at: Date | null;
  assigned_to_id: string | null;
};

const store = { stages: [] as StageRow[], students: [] as StudentRow[] };

vi.mock('../src/config/db.js', () => {
  const prisma = {
    lifecycleStage: {
      findMany: vi.fn(async ({ where, select: _select }: { where: Record<string, unknown>; select?: unknown }) => {
        return store.stages.filter((s) => {
          if (s.tenant_id !== where['tenant_id']) return false;
          const sla = where['sla_hours'] as { not: null } | undefined;
          if (sla && sla.not === null && s.sla_hours == null) return false;
          if ('show_on_dashboard' in where && s.show_on_dashboard !== where['show_on_dashboard']) return false;
          return true;
        });
      }),
    },
    student: {
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        let rows = store.students.filter((s) => {
          if (s.tenant_id !== where['tenant_id']) return false;
          if (where['deleted_at'] === null && s.deleted_at != null) return false;
          const status = where['status'] as string | { notIn?: string[] } | undefined;
          if (typeof status === 'string' && s.status !== status) return false;
          if (status && typeof status === 'object' && status.notIn?.includes(s.status)) return false;
          const cs = where['current_stage_id'] as { in: string[] } | undefined;
          if (cs?.in && !cs.in.includes(s.current_stage_id)) return false;
          return true;
        });
        rows = rows.sort((a, b) => a.stage_entered_at.getTime() - b.stage_entered_at.getTime());
        return take ? rows.slice(0, take) : rows;
      }),
    },
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    $extends: vi.fn(function (this: unknown) { return prisma; }),
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, prismaAdmin: { user: { findUnique: async () => ({ sessions_valid_from: null }) } }, disconnectDb: async () => undefined };
});

// Stub the expiry job — dashboardRouter imports it for /summary; /sla-breaches doesn't use it.
vi.mock('../src/jobs/expiryAlerts.js', () => ({
  findUpcomingExpiries: async () => [],
}));

const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { dashboardRouter } = await import('../src/modules/dashboard/dashboard.routes.js');
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
let token: string;

beforeEach(async () => {
  store.stages.length = 0;
  store.students.length = 0;
  if (!app) app = makeApp();
  if (!token) {
    token = await signAccessToken({ sub: USER_A, tid: TENANT_A, role: 'ADMIN', jti: randomUUID() });
  }
});

const HOUR_MS = 60 * 60 * 1000;

function seedStage(opts: Partial<StageRow> = {}): StageRow {
  const s: StageRow = {
    id: randomUUID(), tenant_id: TENANT_A, key: 'visa', label: 'Visa',
    sla_hours: 48, color_hex: '#888888', show_on_dashboard: true,
    ...opts,
  };
  store.stages.push(s);
  return s;
}

function seedStudent(opts: Partial<StudentRow> & { current_stage_id: string }): StudentRow {
  const s: StudentRow = {
    id: randomUUID(), tenant_id: TENANT_A, student_code: 'SPV-X',
    given_name: 'Maya', family_name: 'Patel',
    stage_entered_at: new Date(Date.now() - 24 * HOUR_MS),
    status: 'ACTIVE', deleted_at: null, assigned_to_id: null,
    ...opts,
  };
  store.students.push(s);
  return s;
}

describe('GET /api/v1/dashboard/sla-breaches', () => {
  it('returns 401 without bearer', async () => {
    const res = await request(app).get('/api/v1/dashboard/sla-breaches');
    expect(res.status).toBe(401);
  });

  it('returns only students whose elapsed time exceeds stage sla_hours', async () => {
    const stage = seedStage({ sla_hours: 48 });
    // 100h in stage → breached by ~52h
    seedStudent({ current_stage_id: stage.id, student_code: 'BREACH-1', stage_entered_at: new Date(Date.now() - 100 * HOUR_MS) });
    // 24h in stage → still inside SLA
    seedStudent({ current_stage_id: stage.id, student_code: 'OK-1', stage_entered_at: new Date(Date.now() - 24 * HOUR_MS) });
    const res = await request(app)
      .get('/api/v1/dashboard/sla-breaches')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].student_code).toBe('BREACH-1');
    expect(res.body.data[0].hours_over_sla).toBeGreaterThan(50);
    expect(res.body.data[0].stage_id).toBe(stage.id);
  });

  it('ignores stages without sla_hours', async () => {
    const stageNoSla = seedStage({ sla_hours: null, key: 'enrolled' });
    seedStudent({ current_stage_id: stageNoSla.id, stage_entered_at: new Date(Date.now() - 1000 * HOUR_MS) });
    const res = await request(app)
      .get('/api/v1/dashboard/sla-breaches')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.data).toEqual([]);
  });

  it('ignores stages hidden from the dashboard', async () => {
    const hidden = seedStage({ sla_hours: 24, show_on_dashboard: false, key: 'archived' });
    seedStudent({ current_stage_id: hidden.id, stage_entered_at: new Date(Date.now() - 100 * HOUR_MS) });
    const res = await request(app)
      .get('/api/v1/dashboard/sla-breaches')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.data).toEqual([]);
  });

  it('counts only ACTIVE students (terminal + paused statuses have a stopped clock)', async () => {
    const stage = seedStage({ sla_hours: 24 });
    const old = new Date(Date.now() - 100 * HOUR_MS);
    // Terminal — excluded.
    seedStudent({ current_stage_id: stage.id, status: 'WITHDRAWN', stage_entered_at: old });
    seedStudent({ current_stage_id: stage.id, status: 'COMPLETED', stage_entered_at: old });
    // Paused / pre-start — clock stopped, must NOT show as a breach (the fix).
    seedStudent({ current_stage_id: stage.id, status: 'ON_HOLD', stage_entered_at: old });
    seedStudent({ current_stage_id: stage.id, status: 'ON_LEAVE', stage_entered_at: old });
    seedStudent({ current_stage_id: stage.id, status: 'DEFERRED', stage_entered_at: old });
    // Only this one is a real breach.
    seedStudent({ current_stage_id: stage.id, status: 'ACTIVE', stage_entered_at: old, student_code: 'ACT' });
    const res = await request(app)
      .get('/api/v1/dashboard/sla-breaches')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].student_code).toBe('ACT');
  });

  it('ignores soft-deleted students', async () => {
    const stage = seedStage({ sla_hours: 24 });
    seedStudent({ current_stage_id: stage.id, deleted_at: new Date(), stage_entered_at: new Date(Date.now() - 100 * HOUR_MS) });
    const res = await request(app)
      .get('/api/v1/dashboard/sla-breaches')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.data).toEqual([]);
  });

  it('orders by worst breach (hours_over_sla DESC)', async () => {
    const stage = seedStage({ sla_hours: 24 });
    seedStudent({ current_stage_id: stage.id, student_code: 'A', stage_entered_at: new Date(Date.now() - 100 * HOUR_MS) });
    seedStudent({ current_stage_id: stage.id, student_code: 'B', stage_entered_at: new Date(Date.now() - 200 * HOUR_MS) });
    seedStudent({ current_stage_id: stage.id, student_code: 'C', stage_entered_at: new Date(Date.now() - 50 * HOUR_MS) });
    const res = await request(app)
      .get('/api/v1/dashboard/sla-breaches')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.data.map((r: { student_code: string }) => r.student_code)).toEqual(['B', 'A', 'C']);
  });

  it('returns page.total reflecting full breach count even when limit truncates', async () => {
    const stage = seedStage({ sla_hours: 24 });
    for (let i = 0; i < 5; i += 1) {
      seedStudent({ current_stage_id: stage.id, student_code: `S${i}`, stage_entered_at: new Date(Date.now() - (50 + i) * HOUR_MS) });
    }
    const res = await request(app)
      .get('/api/v1/dashboard/sla-breaches?limit=2')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.page.total).toBe(5);
  });

  it('returns empty when tenant has no SLA-configured stages', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/sla-breaches')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.page.total).toBe(0);
  });

  // SVT-WAVE49-SLA-SEVERITY-2026-05
  it('filters by ?min_hours_over for critical-only triage', async () => {
    const stage = seedStage({ sla_hours: 24 });
    // 25h elapsed → 1h over (warning)
    seedStudent({ current_stage_id: stage.id, student_code: 'W1', stage_entered_at: new Date(Date.now() - 25 * HOUR_MS) });
    // 100h elapsed → 76h over (critical)
    seedStudent({ current_stage_id: stage.id, student_code: 'C1', stage_entered_at: new Date(Date.now() - 100 * HOUR_MS) });
    const res = await request(app)
      .get('/api/v1/dashboard/sla-breaches?min_hours_over=24')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].student_code).toBe('C1');
  });
});
