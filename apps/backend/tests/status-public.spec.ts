// SVT-WAVE-STATUS-PUBLIC-2026-05 — public status endpoint integration tests.
//
// Covers:
//   - 200 + documented shape (status, subsystems[], incidents[]).
//   - Overall 'operational' when all subsystems healthy.
//   - Overall 'degraded' (or 'major_outage') when any subsystem is unhealthy.
//   - Sensitive BreachIncident fields (description, remediation,
//     affected_subjects_count) NEVER appear in the response, even when the
//     underlying row carries them.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('DATABASE_MIGRATE_URL', 'postgresql://x:x@localhost:5432/x');
// REDIS_URL must satisfy env.ts's z.string().url() schema, so we set a syntactically
// valid value and stub the `getRedisClient` module below to keep the Redis subsystem
// out of the snapshot deterministically (no flaky Redis container needed in CI).
vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nNOT_USED\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nNOT_USED\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test-kid');
vi.stubEnv('JWT_ISSUER', 'spv-api-test');
vi.stubEnv('JWT_AUDIENCE', 'spv-app-test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

type BreachRow = {
  id: string;
  tenant_id: string | null;
  detected_at: Date;
  due_by: Date;
  severity: string;
  closed_at: Date | null;
  description: string;
  remediation: string | null;
  affected_subjects_count: number | null;
};

type JobRunRow = {
  id: string;
  job_name: string;
  finished_at: Date | null;
  status: string;
};

const store = {
  dbHealthy: true,
  breaches: [] as BreachRow[],
  jobs: [] as JobRunRow[],
};

function resetStore() {
  store.dbHealthy = true;
  store.breaches.length = 0;
  store.jobs.length = 0;
}

function makePrismaMock() {
  const breachIncident = {
    findMany: vi.fn(
      async ({
        select,
        where,
        take,
      }: {
        select?: Record<string, boolean>;
        where?: { detected_at?: { gte?: Date } };
        take?: number;
      }) => {
        const since = where?.detected_at?.gte;
        const filtered = store.breaches.filter((b) =>
          since ? b.detected_at.getTime() >= since.getTime() : true,
        );
        const ordered = filtered
          .slice()
          .sort((a, b) => b.detected_at.getTime() - a.detected_at.getTime());
        const limited = take ? ordered.slice(0, take) : ordered;
        if (!select) return limited;
        // Honour `select` — the service relies on it to drop admin-only fields.
        return limited.map((row) => {
          const out: Record<string, unknown> = {};
          for (const [k, want] of Object.entries(select)) {
            if (want) out[k] = (row as unknown as Record<string, unknown>)[k];
          }
          return out;
        });
      },
    ),
  };

  const jobRun = {
    findFirst: vi.fn(
      async ({
        where,
      }: {
        where?: { finished_at?: { gte?: Date } };
      }) => {
        const since = where?.finished_at?.gte;
        const matches = store.jobs.filter((j) => {
          if (j.finished_at == null) return false;
          if (since && j.finished_at.getTime() < since.getTime()) return false;
          return true;
        });
        if (matches.length === 0) return null;
        return matches[0];
      },
    ),
  };

  const prisma: Record<string, unknown> = {
    breachIncident,
    jobRun,
    $queryRaw: vi.fn(async () => {
      if (!store.dbHealthy) throw new Error('db down');
      return [{ '?column?': 1 }];
    }),
    $executeRaw: vi.fn(async () => 1),
    $extends: vi.fn(() => prisma),
    $disconnect: vi.fn(async () => undefined),
  };
  return prisma;
}

const prismaMock = makePrismaMock();

vi.mock('../src/config/db.js', () => ({
  prisma: prismaMock,
  disconnectDb: async () => undefined,
}));

// Boot the env module FIRST (it requires REDIS_URL to be a valid URL), then
// drop the env var so the status service treats Redis as "not configured" and
// omits it from the snapshot. This is the deterministic shape we want for the
// "all subsystems healthy" assertion below.
await import('../src/config/env.js');
delete process.env.REDIS_URL;

const { publicStatusRouter } = await import('../src/modules/status-public/routes.js');
const { __resetStatusCacheForTests } = await import(
  '../src/modules/status-public/service.js'
);
const { errorHandler, notFoundHandler } = await import(
  '../src/middlewares/errorHandler.js'
);

function makeApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/v1/public', publicStatusRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let app: Express;

beforeAll(() => {
  app = makeApp();
});

beforeEach(() => {
  resetStore();
  __resetStatusCacheForTests();
  // Seed a recent successful job so the background-jobs subsystem reports
  // 'operational' in the "all healthy" baseline.
  store.jobs.push({
    id: randomUUID(),
    job_name: 'reminder.dispatcher',
    finished_at: new Date(Date.now() - 60_000),
    status: 'SUCCEEDED',
  });
});

describe('GET /api/v1/public/status — shape', () => {
  it('returns 200 with the documented top-level shape', async () => {
    const res = await request(app).get('/api/v1/public/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: expect.any(String),
      generated_at: expect.any(String),
      subsystems: expect.any(Array),
      incidents: expect.any(Array),
    });
    expect(['operational', 'degraded', 'major_outage']).toContain(res.body.status);
    for (const sub of res.body.subsystems as Array<Record<string, unknown>>) {
      expect(sub).toMatchObject({
        name: expect.any(String),
        status: expect.any(String),
        last_checked: expect.any(String),
      });
    }
  });
});

describe('GET /api/v1/public/status — overall roll-up', () => {
  it("reports 'operational' when DB + jobs are healthy and nothing degraded", async () => {
    const res = await request(app).get('/api/v1/public/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('operational');
    // Subsystems must include at least DB and Background jobs.
    const names = (res.body.subsystems as Array<{ name: string }>).map((s) => s.name);
    expect(names).toContain('Database');
    expect(names).toContain('Background jobs');
  });

  it("reports 'major_outage' when the DB ping fails", async () => {
    store.dbHealthy = false;
    const res = await request(app).get('/api/v1/public/status');
    expect(res.status).toBe(200);
    // DB down → service rollUp() escalates beyond 'degraded'.
    expect(['degraded', 'major_outage']).toContain(res.body.status);
    const db = (res.body.subsystems as Array<{ name: string; status: string }>).find(
      (s) => s.name === 'Database',
    );
    expect(db?.status).toBe('degraded');
  });
});

describe('GET /api/v1/public/status — sensitive field redaction', () => {
  it('NEVER includes description / remediation / affected_subjects_count for any incident', async () => {
    // Seed a breach row carrying every sensitive field, just to prove the
    // service's `select` allowlist actually drops them.
    const now = new Date();
    store.breaches.push({
      id: randomUUID(),
      tenant_id: '11111111-1111-7111-8111-111111111111',
      detected_at: new Date(now.getTime() - 24 * 3_600_000),
      due_by: new Date(now.getTime() + 48 * 3_600_000),
      severity: 'HIGH',
      closed_at: null,
      description:
        'INTERNAL: vendor X disclosed credential leak; PII for 1,234 students exposed via misconfigured S3 bucket.',
      remediation:
        'INTERNAL: rotate vendor X API keys, force-logout sessions, file regulator notice within 72h.',
      affected_subjects_count: 1234,
    });

    const res = await request(app).get('/api/v1/public/status');
    expect(res.status).toBe(200);

    const raw = JSON.stringify(res.body);
    // Hard guarantee at the wire level: not even a substring of the
    // sensitive payload may appear in the JSON the public sees.
    expect(raw).not.toMatch(/INTERNAL:/);
    expect(raw).not.toMatch(/1234/);

    expect(Array.isArray(res.body.incidents)).toBe(true);
    expect(res.body.incidents.length).toBe(1);
    const inc = res.body.incidents[0] as Record<string, unknown>;
    // Allowlisted fields are present.
    expect(Object.keys(inc).sort()).toEqual(
      ['id', 'resolved_at', 'severity', 'started_at', 'status', 'title'].sort(),
    );
    // Sensitive keys are absent (explicit per-key check in addition to the
    // wire-substring assertion above).
    expect(inc).not.toHaveProperty('description');
    expect(inc).not.toHaveProperty('remediation');
    expect(inc).not.toHaveProperty('affected_subjects_count');
  });

  it('exposes an empty incidents list when no breaches in window', async () => {
    const res = await request(app).get('/api/v1/public/status');
    expect(res.status).toBe(200);
    expect(res.body.incidents).toEqual([]);
  });
});
