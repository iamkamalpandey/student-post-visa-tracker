// SVT-AUDIT-SEC-2026-06 — regression for the comms thread LIST ownership leak
// (audit backlog rank 4). commsThreadsController.list must scope non-ADMIN
// callers to their assigned students (plus student-less tenant threads),
// mirroring the single-thread get() gate — otherwise any COUNSELLOR can
// enumerate every thread tenant-wide including the last-message body.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = '11111111-1111-7111-8111-111111111111';
const USER = '22222222-2222-7222-8222-222222222222';

const commsThread = { findMany: vi.fn() };
const commsMessage = { findMany: vi.fn(), groupBy: vi.fn(), updateMany: vi.fn() };
vi.mock('../src/config/db.js', () => ({
  prisma: { commsThread, commsMessage },
  disconnectDb: async () => undefined,
}));

const { commsThreadsController } = await import('../src/modules/comms/controller.js');

type Role = 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
function fakeReqRes(role: Role, query: Record<string, string> = {}) {
  const req = { user: { tid: TENANT, sub: USER, role }, query } as never;
  let body: unknown;
  const res = { json: (b: unknown) => { body = b; } } as never;
  const next = (e: unknown) => { throw e; };
  return { req, res, next, getBody: () => body };
}

beforeEach(() => {
  commsThread.findMany.mockReset().mockResolvedValue([]); // empty → short-circuit
  commsMessage.findMany.mockReset();
  commsMessage.groupBy.mockReset();
});

function whereArg() {
  return commsThread.findMany.mock.calls[0]![0].where as Record<string, unknown>;
}

describe('commsThreadsController.list — ownership scope', () => {
  it('COUNSELLOR is scoped to own-assigned (or student-less) threads', async () => {
    const { req, res, next } = fakeReqRes('COUNSELLOR');
    await commsThreadsController.list(req, res, next);
    const where = whereArg();
    expect(where['tenant_id']).toBe(TENANT);
    const and = where['AND'] as Array<Record<string, unknown>> | undefined;
    expect(and, 'non-admin must carry an ownership AND clause').toBeDefined();
    const ownership = and!.find((c) => Array.isArray(c['OR']));
    expect(ownership).toBeDefined();
    const or = ownership!['OR'] as Array<Record<string, unknown>>;
    // own-assigned branch
    expect(or).toContainEqual({ student: { is: { assigned_to_id: USER } } });
    // student-less tenant-thread branch (matches get()'s ungated null-student case)
    expect(or).toContainEqual({ student_id: null });
  });

  it('VIEWER is also scoped (any non-admin)', async () => {
    const { req, res, next } = fakeReqRes('VIEWER');
    await commsThreadsController.list(req, res, next);
    const and = whereArg()['AND'] as Array<Record<string, unknown>> | undefined;
    expect(and?.some((c) => Array.isArray(c['OR']))).toBe(true);
  });

  it('ADMIN sees all threads (no ownership scope)', async () => {
    const { req, res, next } = fakeReqRes('ADMIN');
    await commsThreadsController.list(req, res, next);
    const where = whereArg();
    const and = (where['AND'] as Array<Record<string, unknown>> | undefined) ?? [];
    // No ownership OR clause present for admins.
    expect(and.some((c) => Array.isArray(c['OR']) && JSON.stringify(c).includes('assigned_to_id'))).toBe(false);
  });

  it('search (q) coexists with the ownership scope for non-admins', async () => {
    const { req, res, next } = fakeReqRes('COUNSELLOR', { q: 'asha' });
    await commsThreadsController.list(req, res, next);
    const and = whereArg()['AND'] as Array<Record<string, unknown>>;
    // both an ownership OR and a search OR are present
    const ors = and.filter((c) => Array.isArray(c['OR']));
    expect(ors.length).toBe(2);
  });
});
