// SVT-FSM-2026-05: documents.service.verify() state-machine guard tests.
//
// Pattern: drive the service directly with a hand-rolled prisma mock so we
// don't need supertest. The service relies only on ctx.db.document.{findFirst,
// updateMany, findFirstOrThrow} for the verify path.
//
// Covered:
//   - PENDING → VERIFIED is allowed.
//   - REJECTED → VERIFIED is rejected with 409 (no force_override).
//   - REJECTED → VERIFIED with force_override + reason (>=10 chars) succeeds
//     and emits the document.verification_force_override audit row.
//   - force_override without sufficient reason → 422.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const auditCalls: Array<{ action: string; entityId: string | null }> = [];

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (...args: unknown[]) => {
    const ev = (args.length === 2 ? args[1] : args[0]) as {
      action: string;
      entityId?: string | null;
      entity_id?: string | null;
    };
    auditCalls.push({ action: ev.action, entityId: ev.entityId ?? ev.entity_id ?? null });
  }),
}));

vi.mock('../src/config/db.js', () => ({
  prisma: {} as unknown,
  disconnectDb: async () => undefined,
}));

const { verify } = await import('../src/modules/documents/documents.service.js');

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '22222222-2222-7222-8222-222222222222';
const DOC_ID = '33333333-3333-7333-8333-333333333333';

type DocRow = {
  id: string;
  tenant_id: string;
  verification: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
  version: number;
  deleted_at: Date | null;
};

let row: DocRow;

function makeCtx(role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER' = 'ADMIN') {
  const db = {
    document: {
      findFirst: vi.fn(async () => row),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(row, data);
        return { count: 1 };
      }),
      findFirstOrThrow: vi.fn(async () => row),
    },
  };
  return {
    ctx: {
      db: db as unknown as Parameters<typeof verify>[0]['db'],
      user: { tid: TENANT, sub: ACTOR, role },
      ip: '127.0.0.1',
      ua: 'vitest',
      requestId: 'req-1',
    } as unknown as Parameters<typeof verify>[0],
    db,
  };
}

beforeEach(() => {
  auditCalls.length = 0;
  row = {
    id: DOC_ID,
    tenant_id: TENANT,
    verification: 'PENDING',
    version: 1,
    deleted_at: null,
  };
});

describe('documents.verify() FSM', () => {
  it('PENDING → VERIFIED is allowed and audited as doc.verify.accepted', async () => {
    const { ctx } = makeCtx('ADMIN');
    const out = await verify(ctx, DOC_ID, { verification: 'VERIFIED' });
    expect(out.verification).toBe('VERIFIED');
    expect(auditCalls.some((c) => c.action === 'doc.verify.accepted')).toBe(true);
    // No force_override audit when not used.
    expect(auditCalls.some((c) => c.action === 'document.verification_force_override')).toBe(false);
  });

  it('REJECTED → VERIFIED without force_override is rejected with 409', async () => {
    row.verification = 'REJECTED';
    const { ctx } = makeCtx('ADMIN');
    await expect(verify(ctx, DOC_ID, { verification: 'VERIFIED' })).rejects.toMatchObject({
      status: 409,
      detail: expect.stringMatching(/REJECTED/),
    });
    // The forbidden transition must NOT have flipped the row.
    expect(row.verification).toBe('REJECTED');
  });

  it('REJECTED → VERIFIED with force_override + reason (>=10 chars) succeeds and audits override', async () => {
    row.verification = 'REJECTED';
    const { ctx } = makeCtx('ADMIN');
    const out = await verify(ctx, DOC_ID, {
      verification: 'VERIFIED',
      force_override: true,
      reason: 'Re-verified after the user re-uploaded a fresh scan offline.',
    });
    expect(out.verification).toBe('VERIFIED');
    expect(auditCalls.some((c) => c.action === 'doc.verify.accepted')).toBe(true);
    expect(auditCalls.some((c) => c.action === 'document.verification_force_override')).toBe(true);
  });

  it('force_override with a too-short reason → 422', async () => {
    row.verification = 'REJECTED';
    const { ctx } = makeCtx('ADMIN');
    await expect(
      verify(ctx, DOC_ID, { verification: 'VERIFIED', force_override: true, reason: 'too short' }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('non-ADMIN cannot call verify (403)', async () => {
    const { ctx } = makeCtx('COUNSELLOR');
    await expect(verify(ctx, DOC_ID, { verification: 'VERIFIED' })).rejects.toMatchObject({
      status: 403,
    });
  });
});
