// SVT-WAVE-ENGAGEMENT-2026-06 — attendance / engagement at-risk endpoint.
//
// /api/v1/dashboard/engagement-at-risk surfaces ACTIVE students whose recent
// attendance rate has fallen below a threshold (a UKVI sponsor-duty early
// warning). The SQL aggregation (COUNT FILTER + HAVING threshold/min_checks +
// ACTIVE/deleted predicates) is verified directly against Postgres; this spec
// pins the HTTP contract + the JS-side mapping (rate rounding, absent_count,
// limit-vs-total) and auth, with $queryRaw returning canned aggregation rows.

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

type AggRow = {
  student_id: string;
  student_code: string | null;
  given_name: string | null;
  family_name: string | null;
  assigned_to_id: string | null;
  total_count: number;
  present_count: number;
  last_check_date: Date | null;
};

const store = { aggRows: [] as AggRow[], lastSql: '' as string };

vi.mock('../src/config/db.js', () => {
  const prisma = {
    // The endpoint's only data call. We return the canned aggregation rows the
    // DB would produce; the SQL itself is verified separately against Postgres.
    $queryRaw: vi.fn(async (sql: { sql?: string }) => {
      store.lastSql = sql?.sql ?? '';
      return store.aggRows;
    }),
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    $extends: vi.fn(function (this: unknown) { return prisma; }),
    $transaction: vi.fn(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma, disconnectDb: async () => undefined };
});

// dashboardRouter imports the expiry job for /summary; this endpoint doesn't use it.
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
let adminToken: string;

beforeEach(async () => {
  store.aggRows.length = 0;
  store.lastSql = '';
  if (!app) app = makeApp();
  if (!adminToken) {
    adminToken = await signAccessToken({ sub: USER_A, tid: TENANT_A, role: 'ADMIN', jti: randomUUID() });
  }
});

function aggRow(opts: Partial<AggRow> & { total_count: number; present_count: number }): AggRow {
  return {
    student_id: randomUUID(),
    student_code: 'SPV-X',
    given_name: 'Maya',
    family_name: 'Patel',
    assigned_to_id: null,
    last_check_date: new Date('2026-06-10'),
    ...opts,
  };
}

describe('GET /api/v1/dashboard/engagement-at-risk', () => {
  it('returns 401 without bearer', async () => {
    const res = await request(app).get('/api/v1/dashboard/engagement-at-risk');
    expect(res.status).toBe(401);
  });

  it('maps aggregation rows to attendance_rate (4dp) + absent_count', async () => {
    store.aggRows.push(aggRow({ student_code: 'LOW', total_count: 10, present_count: 6 }));
    const res = await request(app)
      .get('/api/v1/dashboard/engagement-at-risk')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const row = res.body.data[0];
    expect(row.student_code).toBe('LOW');
    expect(row.total_count).toBe(10);
    expect(row.present_count).toBe(6);
    expect(row.absent_count).toBe(4);
    expect(row.attendance_rate).toBe(0.6);
  });

  it('rounds attendance_rate to 4 decimals', async () => {
    // 2/3 = 0.66666… → 0.6667
    store.aggRows.push(aggRow({ total_count: 3, present_count: 2 }));
    const res = await request(app)
      .get('/api/v1/dashboard/engagement-at-risk')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.data[0].attendance_rate).toBe(0.6667);
  });

  it('preserves DB ordering and truncates to limit while page.total reflects full set', async () => {
    for (let i = 0; i < 5; i += 1) {
      store.aggRows.push(aggRow({ student_code: `S${i}`, total_count: 10, present_count: i }));
    }
    const res = await request(app)
      .get('/api/v1/dashboard/engagement-at-risk?limit=2')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((r: { student_code: string }) => r.student_code)).toEqual(['S0', 'S1']);
    expect(res.body.page.total).toBe(5);
  });

  it('returns empty data + total 0 when no student is at risk', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/engagement-at-risk')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.page.total).toBe(0);
  });

  it('issues the attendance aggregation against engagement_checks for an authorised caller', async () => {
    const res = await request(app)
      .get('/api/v1/dashboard/engagement-at-risk')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // Confirms the happy path reaches the DB layer with the expected source table.
    expect(store.lastSql).toContain('engagement_checks');
    expect(store.lastSql).toContain('FILTER (WHERE e.present)');
  });
});
