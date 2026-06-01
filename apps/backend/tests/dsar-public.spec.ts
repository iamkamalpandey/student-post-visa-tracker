// SVT-WAVE-DSAR-PUBLIC-2026-05 — public DSAR endpoint integration tests.
//
// Covers the anti-enumeration contract (200 always), the side-effects (row
// insert when a subject matches; no row otherwise), input validation (422),
// and the dedicated rate limiter (429).

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('DATABASE_MIGRATE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nNOT_USED\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nNOT_USED\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test-kid');
vi.stubEnv('JWT_ISSUER', 'spv-api-test');
vi.stubEnv('JWT_AUDIENCE', 'spv-app-test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const STUDENT_ID = '22222222-2222-7222-8222-222222222222';

type DSARRow = {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  type: string;
  status: string;
  requested_at: Date;
  due_by: Date;
  notes: string | null;
};

type StudentRow = {
  id: string;
  tenant_id: string;
  email_primary: string | null;
  deleted_at: Date | null;
};

const store = {
  dsar: [] as DSARRow[],
  students: [] as StudentRow[],
};

const auditCalls: Array<{ action: string; tenant_id?: string | null; after?: unknown }> = [];

function resetStore() {
  store.dsar.length = 0;
  store.students.length = 0;
  auditCalls.length = 0;
}

function matchWhere(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) {
      if (row[k] !== null && row[k] !== undefined) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function makePrismaMock() {
  const dSARRequest = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row: DSARRow = {
        id: randomUUID(),
        tenant_id: String(data['tenant_id']),
        subject_type: String(data['subject_type']),
        subject_id: String(data['subject_id']),
        type: String(data['type']),
        status: String(data['status'] ?? 'PENDING'),
        requested_at: (data['requested_at'] as Date) ?? new Date(),
        due_by: data['due_by'] as Date,
        notes: (data['notes'] as string | null) ?? null,
      };
      store.dsar.push(row);
      return row;
    }),
  };

  const student = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return store.students.find((r) =>
        matchWhere(r as unknown as Record<string, unknown>, where),
      ) ?? null;
    }),
  };

  const user = {
    findFirst: vi.fn(async () => null),
  };

  const commsMessage = {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: randomUUID() })),
  };
  const commsThread = {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: randomUUID() })),
  };

  const prisma: Record<string, unknown> = {
    dSARRequest,
    student,
    user,
    commsMessage,
    commsThread,
    auditLog: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === 'function') return (fn as (tx: unknown) => unknown)(prisma);
      return fn;
    }),
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
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

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (a: unknown, b?: unknown) => {
    const ev = (b !== undefined ? b : a) as {
      action: string;
      tenant_id?: string | null;
      tenantId?: string | null;
      after?: unknown;
    };
    auditCalls.push({
      action: ev.action,
      tenant_id: ev.tenant_id ?? ev.tenantId ?? null,
      after: ev.after,
    });
  }),
}));

vi.mock('../src/shared/encryption.js', () => ({
  encryptField: async (s: string | Buffer) =>
    Buffer.from(typeof s === 'string' ? s : s.toString('utf8'), 'utf8'),
  decryptField: async (b: Buffer) => b.toString('utf8'),
  encryptJson: async (v: unknown) => Buffer.from(JSON.stringify(v ?? null), 'utf8'),
  decryptJson: async (b: Buffer) => JSON.parse(b.toString('utf8')),
  isCiphertext: () => true,
}));

vi.mock('../src/shared/transitionNotify.js', () => ({
  notifyStatusTransition: vi.fn(async () => undefined),
}));

vi.mock('../src/modules/comms/providers/registry.js', () => ({
  getProvider: () => ({
    channel: 'EMAIL',
    send: vi.fn(async () => ({ providerId: 'mock', status: 'SENT' as const })),
  }),
}));

const { publicDsarRouter } = await import('../src/modules/dsar-public/routes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');

function makeApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/v1/public', publicDsarRouter);
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
});

const validBody = (overrides: Record<string, unknown> = {}) => ({
  tenant_id: TENANT_A,
  subject_email: 'student@example.com',
  subject_type: 'student',
  dsar_type: 'ACCESS',
  request_text: 'Please send me a copy of all data you hold about me.',
  ...overrides,
});

// P1-WB7 — every POST /public/dsar now requires an Idempotency-Key header.
// Helper mints a fresh UUID per call so the limiter test still exercises
// distinct logical submissions.
function postPublicDsar(body: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/public/dsar')
    .set('idempotency-key', randomUUID())
    .send(body);
}

describe('POST /api/v1/public/dsar — anti-enumeration', () => {
  it('returns 200 with generic message when subject exists; creates a DSARRequest row', async () => {
    store.students.push({
      id: STUDENT_ID,
      tenant_id: TENANT_A,
      email_primary: 'student@example.com',
      deleted_at: null,
    });

    const res = await postPublicDsar(validBody());
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/If a matching subject exists/i);

    // Subject matched → row inserted in PENDING with the request_text in notes.
    expect(store.dsar.length).toBe(1);
    const row = store.dsar[0]!;
    expect(row.tenant_id).toBe(TENANT_A);
    expect(row.subject_type).toBe('student');
    expect(row.subject_id).toBe(STUDENT_ID);
    expect(row.type).toBe('ACCESS');
    expect(row.status).toBe('PENDING');
    expect(row.notes).toContain('Please send me a copy');

    // Audit row written for the public submission.
    expect(auditCalls.some((c) => c.action === 'dsar.public_request_received')).toBe(true);
  });

  it('returns 200 with identical generic message when subject does NOT exist; no row created', async () => {
    // Empty students store — lookup misses.
    const res = await postPublicDsar(validBody({
      subject_email: 'noone@example.com',
    }));
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/If a matching subject exists/i);

    // Anti-enumeration: no DSARRequest row created.
    expect(store.dsar.length).toBe(0);

    // Audit row STILL written (we want forensic evidence even of no-match
    // submissions; the audit body must not leak the request_text raw).
    expect(auditCalls.some((c) => c.action === 'dsar.public_request_received')).toBe(true);
  });
});

describe('POST /api/v1/public/dsar — validation', () => {
  it('rejects a malformed body with 422', async () => {
    const res = await postPublicDsar({
      tenant_id: 'not-a-uuid',
      subject_email: 'not-an-email',
      subject_type: 'banana',
      dsar_type: 'UNKNOWN',
      request_text: '',
    });
    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty('errors');
    expect(store.dsar.length).toBe(0);
  });

  it('rejects unknown extra fields (strict schema) with 422', async () => {
    const res = await postPublicDsar({ ...validBody(), evil_field: 'pwn' });
    expect(res.status).toBe(422);
  });

  it('rejects an oversize request_text with 422', async () => {
    const res = await postPublicDsar({ ...validBody(), request_text: 'x'.repeat(2001) });
    expect(res.status).toBe(422);
  });

  // P1-WB7 — missing Idempotency-Key header is a 400 with code idempotency_key_required.
  it('rejects a request that omits Idempotency-Key with 400 idempotency_key_required', async () => {
    const res = await request(app).post('/api/v1/public/dsar').send(validBody());
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'idempotency_key_required' });
    expect(store.dsar.length).toBe(0);
  });
});

describe('POST /api/v1/public/dsar — rate limiting', () => {
  it('returns 429 once the per-IP rate limit (20/min) is exceeded', async () => {
    // The publicDsarLimiter is module-level so its bucket persists across the
    // earlier tests. Hammer well past the limit to guarantee a 429 within the
    // window regardless of test-ordering counters.
    let saw429 = false;
    for (let i = 0; i < 80; i++) {
      const res = await postPublicDsar(validBody());
      if (res.status === 429) {
        saw429 = true;
        expect(res.body.title).toBe('Too Many Requests');
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});
