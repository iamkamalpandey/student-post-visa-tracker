// DSAR module integration tests.
//
// Coverage focus is the SVT-DSAR-FSM-2026-05 forward-only state machine and the
// is_overdue / days_remaining derived fields surfaced on list responses.
//
// Style mirrors checklist.spec.ts: stub envs, generate a JWT keypair, mock the
// prisma module with an in-memory store, and mount the real router behind the
// real authenticate + tenantContext middlewares.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', PRIVATE_PEM);
vi.stubEnv('JWT_PUBLIC_KEY', PUBLIC_PEM);
vi.stubEnv('JWT_KID', 'test-kid');
vi.stubEnv('JWT_ISSUER', 'spv-api-test');
vi.stubEnv('JWT_AUDIENCE', 'spv-app-test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

type DSARStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'EXPIRED';
type DSARType = 'ACCESS' | 'PORTABILITY' | 'ERASURE' | 'RECTIFICATION' | 'RESTRICTION' | 'OBJECTION';

type DSARRow = {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  type: DSARType;
  status: DSARStatus;
  requested_at: Date;
  due_by: Date;
  completed_at: Date | null;
  export_storage_key: string | null;
  notes: string | null;
};

const store = {
  dsar: [] as DSARRow[],
};
const auditCalls: Array<{ action: string; entityId: string | null; after?: unknown }> = [];

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const ADMIN_ID = '22222222-2222-7222-8222-222222222222';
const COUNSELLOR_ID = '33333333-3333-7333-8333-333333333333';
const SUBJECT_ID = '44444444-4444-7444-8444-444444444444';

function resetStore() {
  store.dsar.length = 0;
  auditCalls.length = 0;
}

function matchWhere(row: DSARRow, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
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
        type: data['type'] as DSARType,
        status: (data['status'] as DSARStatus) ?? 'PENDING',
        requested_at: (data['requested_at'] as Date) ?? new Date(),
        due_by: data['due_by'] as Date,
        completed_at: (data['completed_at'] as Date | null) ?? null,
        export_storage_key: (data['export_storage_key'] as string | null) ?? null,
        notes: (data['notes'] as string | null) ?? null,
      };
      store.dsar.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return store.dsar.find((r) => matchWhere(r, where)) ?? null;
    }),
    findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const r = store.dsar.find((row) => matchWhere(row, where));
      if (!r) throw new Error('not found');
      return r;
    }),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return store.dsar.filter((r) => matchWhere(r, where));
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const r of store.dsar) {
          if (!matchWhere(r, where)) continue;
          for (const [k, v] of Object.entries(data)) {
            (r as unknown as Record<string, unknown>)[k] = v;
          }
          count++;
        }
        return { count };
      },
    ),
  };

  const prisma: Record<string, unknown> = {
    dSARRequest,
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
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
  prismaAdmin: {
    // SVT-SEC-2026-08 — authenticate() reads the JTI denylist via the
    // BYPASS-RLS client (it runs before tenantContext sets the GUC) and fails
    // CLOSED when the lookup throws. null = "this token was never revoked".
    accessTokenDenylist: { findUnique: async () => null },
    // SVT-QA-2026-08 — `authenticate` reads User.sessions_valid_from through the
    // BYPASS-RLS client (it runs before tenantContext sets the tenant GUC) and
    // fails CLOSED when the lookup throws. null = "no revocation on record".
    user: { findUnique: async () => ({ sessions_valid_from: null }) },
  },
  disconnectDb: async () => undefined,
}));

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (...args: unknown[]) => {
    const ev = (args.length === 2 ? args[1] : args[0]) as {
      action: string;
      entityId?: string | null;
      entity_id?: string | null;
      after?: unknown;
    };
    auditCalls.push({
      action: ev.action,
      entityId: ev.entityId ?? ev.entity_id ?? null,
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

vi.mock('../src/shared/hashing.js', async () => {
  const { createHash, createHmac } = await import('node:crypto');
  return {
    sha256Hex: (s: string) => createHash('sha256').update(s).digest('hex'),
    hashIp: (s: string) => createHash('sha256').update(`ip:${s}`).digest('hex'),
    hashUa: (s: string) => createHash('sha256').update(`ua:${s}`).digest('hex'),
    emailHashHmac: (s: string) =>
      createHmac('sha256', 'test-pepper').update(s).digest('hex'),
  };
});

vi.mock('../src/shared/idempotencyHandler.js', () => ({
  // Bypass idempotency wrapper for tests — invoke the work and return its body.
  runIdempotent: async (
    _req: unknown,
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    _opts: unknown,
    work: () => Promise<unknown>,
  ) => {
    const body = await work();
    res.status(201).json(body);
  },
  // routes.ts requires an Idempotency-Key on POST; tests bypass the guard.
  requireIdempotencyKey: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// routes.ts mounts the real dsarLimiter/heavyReadLimiter (20/min). Across this
// suite many DSARs are created, which trips the real limiter; bypass it so the
// FSM/decoration assertions aren't masked by spurious 429s.
vi.mock('../src/middlewares/rateLimit.js', () => ({
  dsarLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  heavyReadLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { dsarRouter } = await import('../src/modules/dsar/routes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/dsar', dsarRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function tokenFor(role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER', tid = TENANT_A) {
  return signAccessToken({
    sub: role === 'ADMIN' ? ADMIN_ID : COUNSELLOR_ID,
    tid,
    role,
    jti: randomUUID(),
  });
}

let app: Express;

beforeAll(() => {
  app = makeApp();
});

beforeEach(() => {
  resetStore();
});

async function createDSAR(token: string, overrides: Partial<DSARRow> = {}) {
  const res = await request(app)
    .post('/api/v1/dsar')
    .set('Authorization', `Bearer ${token}`)
    .send({
      subject_type: 'student',
      subject_id: SUBJECT_ID,
      type: 'ACCESS',
    });
  expect(res.status).toBe(201);
  // Apply any overrides directly into the in-memory row (e.g. due_by in the past).
  if (Object.keys(overrides).length) {
    const row = store.dsar.find((r) => r.id === res.body.id)!;
    Object.assign(row, overrides);
  }
  return res.body as { id: string; status: DSARStatus };
}

describe('DSAR forward-only FSM', () => {
  it('forward path PENDING -> IN_PROGRESS -> COMPLETED stamps completed_at and audits', async () => {
    const adminTok = await tokenFor('ADMIN');
    const created = await createDSAR(adminTok);

    const r1 = await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'IN_PROGRESS' });
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe('IN_PROGRESS');

    const r2 = await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'COMPLETED' });
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe('COMPLETED');
    expect(r2.body.completed_at).toBeTruthy();

    expect(auditCalls.length).toBeGreaterThan(0);
    expect(auditCalls.filter((c) => c.action === 'dsar.status_changed').length).toBe(2);
  });

  it('counsellor can do PENDING -> IN_PROGRESS and IN_PROGRESS -> COMPLETED', async () => {
    const counTok = await tokenFor('COUNSELLOR');
    const adminTok = await tokenFor('ADMIN');
    // Intake is also COUNSELLOR-allowed.
    const created = await createDSAR(adminTok);

    const r1 = await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${counTok}`)
      .send({ status: 'IN_PROGRESS' });
    expect(r1.status).toBe(200);

    const r2 = await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${counTok}`)
      .send({ status: 'COMPLETED' });
    expect(r2.status).toBe(200);
    expect(r2.body.completed_at).toBeTruthy();
  });

  it('COMPLETED -> IN_PROGRESS as COUNSELLOR is forbidden (403)', async () => {
    const adminTok = await tokenFor('ADMIN');
    const counTok = await tokenFor('COUNSELLOR');
    const created = await createDSAR(adminTok);
    // Drive forward to COMPLETED first.
    await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'IN_PROGRESS' });
    await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'COMPLETED' });

    const res = await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${counTok}`)
      .send({ status: 'IN_PROGRESS', notes: 'Subject sent additional records to consider.' });
    expect(res.status).toBe(403);
  });

  it('COMPLETED -> IN_PROGRESS as ADMIN with reason succeeds and clears completed_at', async () => {
    const adminTok = await tokenFor('ADMIN');
    const created = await createDSAR(adminTok);
    await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'IN_PROGRESS' });
    await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'COMPLETED' });
    expect(store.dsar[0]!.completed_at).not.toBeNull();

    const res = await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({
        status: 'IN_PROGRESS',
        notes: 'Reopening because subject submitted new evidence on 2026-05-14.',
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
    expect(res.body.completed_at).toBeNull();
    expect(store.dsar[0]!.completed_at).toBeNull();
  });

  it('COMPLETED -> IN_PROGRESS as ADMIN without sufficient reason -> 422', async () => {
    const adminTok = await tokenFor('ADMIN');
    const created = await createDSAR(adminTok);
    await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'IN_PROGRESS' });
    await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'COMPLETED' });

    const res = await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'IN_PROGRESS', notes: 'short' });
    expect(res.status).toBe(422);
  });

  it('PENDING -> COMPLETED is rejected as illegal transition (422)', async () => {
    const adminTok = await tokenFor('ADMIN');
    const created = await createDSAR(adminTok);
    const res = await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'COMPLETED' });
    expect(res.status).toBe(422);
  });

  it('IN_PROGRESS -> REJECTED requires ADMIN + reason; counsellor blocked', async () => {
    const adminTok = await tokenFor('ADMIN');
    const counTok = await tokenFor('COUNSELLOR');
    const created = await createDSAR(adminTok);
    await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'IN_PROGRESS' });

    // Counsellor cannot reject.
    const blocked = await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${counTok}`)
      .send({ status: 'REJECTED', notes: 'Subject identity unverified after RFI.' });
    expect(blocked.status).toBe(403);

    // Admin without reason -> 422.
    const noReason = await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'REJECTED' });
    expect(noReason.status).toBe(422);

    // Admin with reason -> 200.
    const ok = await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'REJECTED', notes: 'Subject identity unverified after RFI.' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('REJECTED');
  });

  it('EXPIRED is terminal — no further transitions accepted', async () => {
    const adminTok = await tokenFor('ADMIN');
    const created = await createDSAR(adminTok);
    await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'IN_PROGRESS' });
    await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'EXPIRED' });

    const res = await request(app)
      .patch(`/api/v1/dsar/${created.id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'IN_PROGRESS', notes: 'Manually reviving expired request.' });
    expect(res.status).toBe(422);
  });
});

describe('DSAR list response decoration', () => {
  it('marks an IN_PROGRESS request with due_by in the past as is_overdue=true', async () => {
    const adminTok = await tokenFor('ADMIN');
    const created = await createDSAR(adminTok, {
      due_by: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      status: 'IN_PROGRESS',
    });

    const res = await request(app)
      .get('/api/v1/dsar')
      .set('Authorization', `Bearer ${adminTok}`);
    expect(res.status).toBe(200);
    const row = (res.body.data as Array<{ id: string; is_overdue: boolean; days_remaining: number }>)
      .find((r) => r.id === created.id)!;
    expect(row).toBeTruthy();
    expect(row.is_overdue).toBe(true);
    expect(row.days_remaining).toBeLessThan(0);
  });

  it('does NOT mark COMPLETED requests as overdue even when due_by is past', async () => {
    const adminTok = await tokenFor('ADMIN');
    const created = await createDSAR(adminTok, {
      due_by: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      status: 'COMPLETED',
      completed_at: new Date(),
    });
    const res = await request(app)
      .get('/api/v1/dsar')
      .set('Authorization', `Bearer ${adminTok}`);
    const row = (res.body.data as Array<{ id: string; is_overdue: boolean }>)
      .find((r) => r.id === created.id)!;
    expect(row.is_overdue).toBe(false);
  });
});
