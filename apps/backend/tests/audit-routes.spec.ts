// Audit-logs router integration tests.
//
// Covers GET / cursor pagination, GET /verify, GET /:id, admin-only gate,
// tenant isolation, RFC-7807 errors and the public-fields contract (the
// service.list select must NOT include before_enc/after_enc).
//
// Note: tests/audit.spec.ts already covers writeAudit() unit-style. This
// file is the *router* counterpart and lives at audit-routes.spec.ts to
// avoid colliding with the existing audit.spec.ts file name.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
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

type AuditRow = {
  id: string;
  tenant_id: string;
  actor_id: string | null;
  actor_email_hash: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_version: number | null;
  before_enc: Buffer | null;
  after_enc: Buffer | null;
  ip_hash: string | null;
  ua_hash: string | null;
  request_id: string | null;
  prev_hash: string | null;
  entry_hash: string;
  created_at: Date;
};

const store = { audit: [] as AuditRow[] };
let lastSelect: Record<string, boolean> | undefined;

function resetStore() {
  store.audit.length = 0;
  lastSelect = undefined;
}

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '99999999-9999-7999-8999-999999999999';
const ADMIN_ID = '22222222-2222-7222-8222-222222222222';
const COUNSELLOR_ID = '33333333-3333-7333-8333-333333333333';

function seedAuditRow(opts: Partial<AuditRow> & { tenant_id?: string } = {}): AuditRow {
  const created = opts.created_at ?? new Date();
  const row: AuditRow = {
    id: opts.id ?? randomUUID(),
    tenant_id: opts.tenant_id ?? TENANT_A,
    actor_id: opts.actor_id ?? ADMIN_ID,
    actor_email_hash: opts.actor_email_hash ?? 'h'.repeat(64),
    action: opts.action ?? 'auth.login.success',
    entity_type: opts.entity_type ?? 'user',
    entity_id: opts.entity_id ?? ADMIN_ID,
    entity_version: opts.entity_version ?? 1,
    before_enc: opts.before_enc ?? null,
    after_enc: opts.after_enc ?? null,
    ip_hash: opts.ip_hash ?? null,
    ua_hash: opts.ua_hash ?? null,
    request_id: opts.request_id ?? null,
    prev_hash: opts.prev_hash ?? null,
    entry_hash: opts.entry_hash ?? 'e'.repeat(64),
    created_at: created,
  };
  store.audit.push(row);
  return row;
}

function makePrismaMock() {
  const auditDelegate = {
    findFirst: vi.fn(
      async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        if (select) lastSelect = select;
        const row = store.audit.find((r) => {
          if (where['id'] !== undefined && r.id !== where['id']) return false;
          if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) return false;
          return true;
        });
        if (!row) return null;
        return select ? projectSelect(row, select) : row;
      },
    ),
    findMany: vi.fn(
      async ({
        where,
        take,
        select,
      }: {
        where: Record<string, unknown>;
        take?: number;
        orderBy?: unknown;
        select?: Record<string, boolean>;
      }) => {
        if (select) lastSelect = select;
        let rows = store.audit.filter((r) => matchAudit(r, where));
        rows = rows.sort(
          (a, b) =>
            b.created_at.getTime() - a.created_at.getTime() ||
            (b.id > a.id ? 1 : b.id < a.id ? -1 : 0),
        );
        if (typeof take === 'number') rows = rows.slice(0, take);
        return select ? rows.map((r) => projectSelect(r, select)) : rows;
      },
    ),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return store.audit.filter((r) => matchAudit(r, where)).length;
    }),
  };

  const prisma: Record<string, unknown> = {
    auditLog: auditDelegate,
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: unknown) => {
      if (typeof fn === 'function') return (fn as (tx: unknown) => unknown)(prisma);
      return fn;
    }),
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => {
      // verify endpoint queries audit_logs_verify(); return empty (intact chain).
      return [] as Array<{ broken_id: string }>;
    }),
    $extends: vi.fn(() => prisma),
    $disconnect: vi.fn(async () => undefined),
  };
  return prisma;
}

function matchAudit(r: AuditRow, where: Record<string, unknown>): boolean {
  if (where['tenant_id'] !== undefined && r.tenant_id !== where['tenant_id']) return false;
  if (where['entity_type'] !== undefined && r.entity_type !== where['entity_type']) return false;
  if (where['entity_id'] !== undefined && r.entity_id !== where['entity_id']) return false;
  if (where['actor_id'] !== undefined && r.actor_id !== where['actor_id']) return false;
  if (where['action'] !== undefined) {
    const cond = where['action'];
    if (typeof cond === 'string') {
      if (r.action !== cond) return false;
    } else if (cond && typeof cond === 'object' && 'startsWith' in (cond as object)) {
      if (!r.action.startsWith((cond as { startsWith: string }).startsWith)) return false;
    }
  }
  if (where['created_at'] !== undefined) {
    const cf = where['created_at'] as { gte?: Date; lt?: Date };
    if (cf.gte && r.created_at < cf.gte) return false;
    if (cf.lt && r.created_at >= cf.lt) return false;
  }
  if (where['AND']) {
    const ands = Array.isArray(where['AND']) ? where['AND'] : [where['AND']];
    for (const a of ands as Array<Record<string, unknown>>) {
      if (a['OR']) {
        const ors = a['OR'] as Array<Record<string, unknown>>;
        const passes = ors.some((or) => {
          if (or['created_at'] && typeof or['created_at'] === 'object') {
            const cf = or['created_at'] as { lt?: Date };
            if (cf.lt) return r.created_at < cf.lt;
          }
          if (or['created_at'] instanceof Date && or['id']) {
            const idLt = (or['id'] as { lt?: string }).lt;
            return r.created_at.getTime() === or['created_at'].getTime() && idLt && r.id < idLt;
          }
          return false;
        });
        if (!passes) return false;
      }
    }
  }
  return true;
}

function projectSelect(r: AuditRow, select: Record<string, boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v) out[k] = (r as unknown as Record<string, unknown>)[k];
  }
  return out;
}

const prismaMock = makePrismaMock();

vi.mock('../src/config/db.js', () => ({
  prisma: prismaMock,
  disconnectDb: async () => undefined,
}));

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
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

const { auditLogsRouter } = await import('../src/modules/audit/routes.js');
const { authenticate } = await import('../src/middlewares/auth.js');
const { tenantContext } = await import('../src/middlewares/tenantContext.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { signAccessToken } = await import('../src/shared/jwt.js');

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/v1/audit-logs', authenticate, tenantContext, auditLogsRouter);
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

describe('GET /api/v1/audit-logs', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/v1/audit-logs');
    expect(res.status).toBe(401);
  });

  it('returns 403 to a COUNSELLOR (admin-only)', async () => {
    const tok = await tokenFor('COUNSELLOR');
    const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 + {data, page} envelope to ADMIN', async () => {
    const tok = await tokenFor('ADMIN');
    seedAuditRow();
    const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.page).toBeDefined();
    expect(typeof res.body.page.total).toBe('number');
  });

  it('honours limit', async () => {
    const tok = await tokenFor('ADMIN');
    for (let i = 0; i < 5; i++) seedAuditRow({ created_at: new Date(2026, 4, i + 1) });
    const res = await request(app)
      .get('/api/v1/audit-logs?limit=2')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.page.next_cursor).toBeTruthy();
  });

  it('cursor pagination yields disjoint pages', async () => {
    const tok = await tokenFor('ADMIN');
    for (let i = 0; i < 4; i++) seedAuditRow({ created_at: new Date(2026, 4, i + 1) });
    const page1 = await request(app)
      .get('/api/v1/audit-logs?limit=2')
      .set('Authorization', `Bearer ${tok}`);
    expect(page1.status).toBe(200);
    expect(page1.body.data.length).toBe(2);
    const cursor = page1.body.page.next_cursor as string;
    expect(cursor).toBeTruthy();
    const page2 = await request(app)
      .get(`/api/v1/audit-logs?limit=2&cursor=${encodeURIComponent(cursor)}`)
      .set('Authorization', `Bearer ${tok}`);
    expect(page2.status).toBe(200);
    const p1Ids = (page1.body.data as Array<{ id: string }>).map((r) => r.id);
    const p2Ids = (page2.body.data as Array<{ id: string }>).map((r) => r.id);
    for (const id of p2Ids) expect(p1Ids).not.toContain(id);
  });

  it('default response excludes before_enc / after_enc columns', async () => {
    const tok = await tokenFor('ADMIN');
    seedAuditRow();
    const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    // The select object the service passed must not request the encrypted columns.
    expect(lastSelect).toBeDefined();
    expect(lastSelect!['before_enc']).toBeUndefined();
    expect(lastSelect!['after_enc']).toBeUndefined();
    // And the public payload itself doesn't contain them.
    for (const row of res.body.data as Array<Record<string, unknown>>) {
      expect(row['before_enc']).toBeUndefined();
      expect(row['after_enc']).toBeUndefined();
    }
  });

  it('date filter from/to round-trips', async () => {
    const tok = await tokenFor('ADMIN');
    const inWindow = new Date('2026-05-10T12:00:00.000Z');
    const outOfWindow = new Date('2026-04-01T00:00:00.000Z');
    seedAuditRow({ created_at: inWindow, action: 'in.window' });
    seedAuditRow({ created_at: outOfWindow, action: 'out.of.window' });
    const res = await request(app)
      .get(
        '/api/v1/audit-logs?from=2026-05-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z',
      )
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    const actions = (res.body.data as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toContain('in.window');
    expect(actions).not.toContain('out.of.window');
  });

  // SVT-WAVE59-AUDIT-PREFIX-2026-05
  it('action wildcard `breach.*` matches breach.created/updated/deleted only', async () => {
    const tok = await tokenFor('ADMIN');
    seedAuditRow({ action: 'breach.created' });
    seedAuditRow({ action: 'breach.updated' });
    seedAuditRow({ action: 'dsar.created' });
    seedAuditRow({ action: 'student.created' });
    const res = await request(app)
      .get('/api/v1/audit-logs?action=breach.*')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    const actions = (res.body.data as Array<{ action: string }>).map((r) => r.action);
    expect(actions.every((a) => a.startsWith('breach.'))).toBe(true);
    expect(actions).toContain('breach.created');
    expect(actions).toContain('breach.updated');
    expect(actions).not.toContain('dsar.created');
  });

  it('action exact match still works (no wildcard)', async () => {
    const tok = await tokenFor('ADMIN');
    seedAuditRow({ action: 'breach.created' });
    seedAuditRow({ action: 'breach.updated' });
    const res = await request(app)
      .get('/api/v1/audit-logs?action=breach.created')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    const actions = (res.body.data as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toEqual(['breach.created']);
  });
});

describe('GET /api/v1/audit-logs/:id', () => {
  it('200 with a valid uuid', async () => {
    const tok = await tokenFor('ADMIN');
    const row = seedAuditRow();
    const res = await request(app)
      .get(`/api/v1/audit-logs/${row.id}`)
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(row.id);
  });

  it('400 with an invalid uuid', async () => {
    const tok = await tokenFor('ADMIN');
    const res = await request(app)
      .get('/api/v1/audit-logs/not-a-uuid')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('404 with a missing path id (root collection accessed without trailing id is the list)', async () => {
    // Express treats GET /audit-logs/ as the list (200). To force a 404 on a
    // missing-id pattern we visit a sub-path that no router handles.
    const tok = await tokenFor('ADMIN');
    const res = await request(app)
      .get('/api/v1/audit-logs/missing/sub/path')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/audit-logs/verify', () => {
  it('returns broken_count: 0 / broken_ids: [] on an intact chain', async () => {
    const tok = await tokenFor('ADMIN');
    const res = await request(app)
      .get('/api/v1/audit-logs/verify')
      .set('Authorization', `Bearer ${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.data.broken_count).toBe(0);
    expect(res.body.data.broken_ids).toEqual([]);
    expect(res.body.data.tenant_id).toBe(TENANT_A);
  });

  // SVT-WAVE63-RATE-LIMIT-TEST-2026-05 — auditVerifyLimiter caps 5/min/IP.
  // The 6th request inside a 60s window must 429. We hit it 6 times in
  // quick succession from the same supertest agent (default IP) and assert
  // the last one fails. RFC 9239 RateLimit-* headers attached.
  it('6th request inside a minute returns 429', async () => {
    const tok = await tokenFor('ADMIN');
    let lastStatus = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await request(app)
        .get('/api/v1/audit-logs/verify')
        .set('Authorization', `Bearer ${tok}`)
        .set('X-Forwarded-For', '203.0.113.99'); // pin a per-test IP
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});

describe('tenant isolation', () => {
  it('tenant B cannot read tenant A row', async () => {
    const aTok = await tokenFor('ADMIN', TENANT_A);
    const bTok = await tokenFor('ADMIN', TENANT_B);
    const row = seedAuditRow({ tenant_id: TENANT_A });
    void aTok;
    const res = await request(app)
      .get(`/api/v1/audit-logs/${row.id}`)
      .set('Authorization', `Bearer ${bTok}`);
    expect(res.status).toBe(404);
  });
});
