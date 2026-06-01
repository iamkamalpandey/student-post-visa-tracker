// SVT-AUDIT-WORM-2026-05 — GET /api/v1/audit-logs/anchors handler tests.
//
// Tests the controller directly (no full express mount) — mocks the
// tenant-scoped db on req.db and asserts pagination + cross-tenant deny.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

type AnchorRow = { id: string; tenant_id: string | null; root_hash: string; entries_count: number; anchored_at: Date };

const store = { anchors: [] as AnchorRow[] };

vi.mock('../src/config/db.js', () => ({
  prisma: {},
  disconnectDb: async () => undefined,
}));

const { anchorsHandler } = await import('../src/modules/audit/controller.js');

const TENANT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const ADMIN_ID = '11111111-1111-7111-8111-111111111111';

function makeReq(overrides: Record<string, unknown> = {}) {
  const findMany = vi.fn(async (args: { where: Record<string, unknown>; take: number }) => {
    const w = args.where;
    const tenantIn = (w['tenant_id'] as { in?: Array<string | null> } | string | undefined);
    if (typeof tenantIn === 'string' && tenantIn === '__deny__') return [];
    const allowed = (tenantIn as { in: Array<string | null> })?.in ?? [];
    const cursor = (w['anchored_at'] as { lt?: Date } | undefined)?.lt;
    return store.anchors
      .filter((a) => allowed.includes(a.tenant_id))
      .filter((a) => (cursor ? a.anchored_at < cursor : true))
      .sort((a, b) => b.anchored_at.getTime() - a.anchored_at.getTime())
      .slice(0, args.take);
  });
  return {
    user: { tid: TENANT_A, sub: ADMIN_ID, role: 'ADMIN' },
    db: { auditAnchor: { findMany } },
    query: {},
    ...overrides,
  } as never;
}

function makeRes() {
  let body: unknown = null;
  let status = 200;
  return {
    statusCode: 200,
    status(s: number) { status = s; return this; },
    json(b: unknown) { body = b; return this; },
    get body() { return body; },
    get _status() { return status; },
  } as never;
}

beforeEach(() => {
  store.anchors.length = 0;
  for (let i = 0; i < 3; i += 1) {
    store.anchors.push({
      id: `anchor-${i}`,
      tenant_id: TENANT_A,
      root_hash: '0'.repeat(60) + `r${i}`,
      entries_count: 100 + i,
      anchored_at: new Date(Date.UTC(2026, 4, 10 + i)),
    });
  }
});

describe('anchorsHandler', () => {
  it('returns persisted rows newest-first', async () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    await anchorsHandler(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect((res as never as { body: { data: AnchorRow[]; next_cursor: string | null } }).body.data).toHaveLength(3);
    expect((res as never as { body: { data: AnchorRow[] } }).body.data[0]!.id).toBe('anchor-2');
    expect((res as never as { body: { next_cursor: string | null } }).body.next_cursor).toBeNull();
  });

  it('paginates with next_cursor when limit reached', async () => {
    const req = makeReq({ query: { limit: '2' } });
    const res = makeRes();
    const next = vi.fn();
    await anchorsHandler(req, res, next);
    const body = (res as never as { body: { data: AnchorRow[]; next_cursor: string } }).body;
    expect(body.data).toHaveLength(2);
    expect(body.next_cursor).toBe(new Date(Date.UTC(2026, 4, 11)).toISOString());

    const req2 = makeReq({ query: { limit: '2', cursor: body.next_cursor } });
    const res2 = makeRes();
    await anchorsHandler(req2, res2, vi.fn());
    const body2 = (res2 as never as { body: { data: AnchorRow[]; next_cursor: string | null } }).body;
    expect(body2.data).toHaveLength(1);
    expect(body2.next_cursor).toBeNull();
  });

  it('cross-tenant request returns empty (defence in depth on top of RLS)', async () => {
    const req = makeReq({ query: { tenant_id: TENANT_B } });
    const res = makeRes();
    await anchorsHandler(req, res, vi.fn());
    expect((res as never as { body: { data: AnchorRow[] } }).body.data).toEqual([]);
  });

  it('own-tenant explicit filter accepted', async () => {
    const req = makeReq({ query: { tenant_id: TENANT_A } });
    const res = makeRes();
    await anchorsHandler(req, res, vi.fn());
    expect((res as never as { body: { data: AnchorRow[] } }).body.data.length).toBeGreaterThan(0);
  });

  it('empty result returns next_cursor: null', async () => {
    store.anchors.length = 0;
    const req = makeReq();
    const res = makeRes();
    await anchorsHandler(req, res, vi.fn());
    const body = (res as never as { body: { data: AnchorRow[]; next_cursor: string | null } }).body;
    expect(body.data).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it('caps limit at 500', async () => {
    const req = makeReq({ query: { limit: '99999' } });
    const res = makeRes();
    await anchorsHandler(req, res, vi.fn());
    const findManyCalls = (req as never as { db: { auditAnchor: { findMany: ReturnType<typeof vi.fn> } } }).db.auditAnchor.findMany.mock.calls;
    expect(findManyCalls[0]![0].take).toBe(500);
  });
});
