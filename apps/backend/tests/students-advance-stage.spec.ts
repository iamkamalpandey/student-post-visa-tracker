// Lifecycle transition logic tests for students.service.ts > advanceStage().
//
// We mock @prisma/client and ../config/db so the service can be imported without
// a real Postgres. The transactional callback ($transaction) is invoked in-process
// with a hand-rolled `tx` object whose model delegates we control per test.
//
// Covered:
//   - Default-open transition matrix (no rows configured → free movement allowed).
//   - Closed matrix with matching transition + role → allowed.
//   - Closed matrix without a matching row → Conflict 409.
//   - Concurrent version mismatch (updateMany count=0) → Conflict 409.
//   - Encrypted PII column (name_in_passport_enc) is stripped from the response.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

// Build a fresh tx every test. We only mock the methods advanceStage actually calls.
type Tx = {
  student: {
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
  };
  lifecycleStage: {
    findFirst: ReturnType<typeof vi.fn>;
  };
  lifecycleStageTransition: {
    findMany: ReturnType<typeof vi.fn>;
  };
  studentLifecycleEvent: {
    create: ReturnType<typeof vi.fn>;
  };
};

let tx: Tx;
const makeTx = (): Tx => ({
  student: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  },
  lifecycleStage: { findFirst: vi.fn() },
  lifecycleStageTransition: { findMany: vi.fn() },
  studentLifecycleEvent: { create: vi.fn() },
});

vi.mock('../src/config/db.js', () => {
  const prisma = {
    $transaction: vi.fn(async (fn: (t: Tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/encryption.js', () => ({
  encryptField: async (s: string | Buffer) =>
    Buffer.from(typeof s === 'string' ? s : s.toString('utf8'), 'utf8'),
  decryptField: async (b: Buffer) => b.toString('utf8'),
  // SVT-LIFECYCLE-2026-05: shared/audit.ts now reaches `encryptJson` via the
  // writeAuditSafe path on the no-op short-circuit. Stub it so the audit
  // helper writes a passthrough Buffer when invoked. The audit write itself
  // still fails because prisma.auditLog is unmocked, but writeAuditSafe
  // swallows that error — the test only cares that advanceStage returns OK.
  encryptJson: async (v: unknown) => Buffer.from(JSON.stringify(v ?? null), 'utf8'),
  decryptJson: async (b: Buffer) => JSON.parse(b.toString('utf8')),
}));

const { advanceStage } = await import('../src/modules/students/students.service.js');
const { prisma } = await import('../src/config/db.js');

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '22222222-2222-7222-8222-222222222222';
const STUDENT = '33333333-3333-7333-8333-333333333333';
const FROM_STAGE = '44444444-4444-7444-8444-444444444444';
const TO_STAGE = '55555555-5555-7555-8555-555555555555';

beforeEach(() => {
  tx = makeTx();
});

function ctx(role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER' = 'COUNSELLOR') {
  return {
    db: prisma as unknown as Parameters<typeof advanceStage>[0]['db'],
    tenantId: TENANT,
    actorId: ACTOR,
    actorRole: role,
  };
}

function freshStudentRow() {
  return {
    id: STUDENT,
    tenant_id: TENANT,
    student_code: 'SPV-2026-000001',
    given_name: 'Asha',
    family_name: 'Sharma',
    name_in_passport_enc: Buffer.from('ASHA SHARMA', 'utf8'),
    current_stage_id: TO_STAGE,
    version: 2,
    completeness_pct: 50,
    current_stage: { id: TO_STAGE, key: 'pre-departure', label: 'Pre Departure', sequence: 10, category: 'PRE_DEPARTURE' },
    assigned_to: null,
  };
}

describe('students.advanceStage()', () => {
  it('default-open matrix: empty transition rows allow any to_stage_id', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    tx.lifecycleStage.findFirst.mockResolvedValue({ id: TO_STAGE });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([]); // open matrix
    tx.studentLifecycleEvent.create.mockResolvedValue({ id: randomUUID() });
    tx.student.updateMany.mockResolvedValue({ count: 1 });
    tx.student.findUniqueOrThrow.mockResolvedValue(freshStudentRow());

    const out = await advanceStage(ctx(), STUDENT, { to_stage_id: TO_STAGE });

    expect(tx.studentLifecycleEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.student.updateMany).toHaveBeenCalledTimes(1);
    // Version increment expressed via Prisma's { increment: 1 } operator.
    const updateData = tx.student.updateMany.mock.calls[0]![0].data;
    expect(updateData).toMatchObject({
      current_stage_id: TO_STAGE,
      version: { increment: 1 },
    });
    // Response should be redacted.
    expect(out).not.toHaveProperty('name_in_passport_enc');
  });

  it('closed matrix with matching transition + role allows the move', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    tx.lifecycleStage.findFirst.mockResolvedValue({ id: TO_STAGE });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([
      { from_stage_id: FROM_STAGE, to_stage_id: TO_STAGE, requires_role: 'COUNSELLOR' },
      { from_stage_id: FROM_STAGE, to_stage_id: 'unrelated', requires_role: null },
    ]);
    tx.studentLifecycleEvent.create.mockResolvedValue({ id: randomUUID() });
    tx.student.updateMany.mockResolvedValue({ count: 1 });
    tx.student.findUniqueOrThrow.mockResolvedValue(freshStudentRow());

    await expect(advanceStage(ctx('COUNSELLOR'), STUDENT, { to_stage_id: TO_STAGE })).resolves.toBeDefined();
  });

  it('ADMIN bypasses requires_role check', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    tx.lifecycleStage.findFirst.mockResolvedValue({ id: TO_STAGE });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([
      { from_stage_id: FROM_STAGE, to_stage_id: TO_STAGE, requires_role: 'COUNSELLOR' },
    ]);
    tx.studentLifecycleEvent.create.mockResolvedValue({ id: randomUUID() });
    tx.student.updateMany.mockResolvedValue({ count: 1 });
    tx.student.findUniqueOrThrow.mockResolvedValue(freshStudentRow());

    await expect(advanceStage(ctx('ADMIN'), STUDENT, { to_stage_id: TO_STAGE })).resolves.toBeDefined();
  });

  it('closed matrix without a matching row throws UnprocessableEntity 422 with allowed list', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    // SVT-LIFECYCLE-2026-05: the service now also reads from_stage and toStage
    // labels/sequence so the error message can name them. The findFirst mock
    // is shared across both calls — return the same row for both lookups.
    tx.lifecycleStage.findFirst.mockResolvedValue({
      id: TO_STAGE,
      label: 'Visa Approved',
      sequence: 20,
    });
    // Matrix is closed (rows exist) but none target TO_STAGE.
    tx.lifecycleStageTransition.findMany.mockResolvedValue([
      { from_stage_id: FROM_STAGE, to_stage_id: 'other-stage', requires_role: null },
    ]);
    // findMany on lifecycleStage is called by the new branch to enumerate the
    // allowed labels for the error detail.
    type LFM = ReturnType<typeof vi.fn>;
    (tx.lifecycleStage as unknown as { findMany?: LFM }).findMany = vi.fn().mockResolvedValue([
      { label: 'Other Stage' },
    ]);

    await expect(advanceStage(ctx(), STUDENT, { to_stage_id: TO_STAGE })).rejects.toMatchObject({
      status: 422,
    });
    // The lifecycle event should NOT have been written.
    expect(tx.studentLifecycleEvent.create).not.toHaveBeenCalled();
  });

  it('concurrent version mismatch (updateMany count=0) throws Conflict 409', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 7 });
    tx.lifecycleStage.findFirst.mockResolvedValue({ id: TO_STAGE });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([]); // open matrix
    tx.studentLifecycleEvent.create.mockResolvedValue({ id: randomUUID() });
    tx.student.updateMany.mockResolvedValue({ count: 0 }); // someone else won

    await expect(advanceStage(ctx(), STUDENT, { to_stage_id: TO_STAGE })).rejects.toMatchObject({
      status: 409,
      detail: expect.stringMatching(/modified concurrently/i),
    });
  });

  it('strips name_in_passport_enc from the response (redactSensitive applied)', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    tx.lifecycleStage.findFirst.mockResolvedValue({ id: TO_STAGE });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([]);
    tx.studentLifecycleEvent.create.mockResolvedValue({ id: randomUUID() });
    tx.student.updateMany.mockResolvedValue({ count: 1 });
    tx.student.findUniqueOrThrow.mockResolvedValue(freshStudentRow());

    const out = (await advanceStage(ctx(), STUDENT, { to_stage_id: TO_STAGE })) as Record<string, unknown>;
    expect(out['name_in_passport_enc']).toBeUndefined();
    expect(out['student_code']).toBe('SPV-2026-000001');
    expect(out['current_stage']).toMatchObject({ id: TO_STAGE });
  });

  it('rejects with NotFound when the student does not exist', async () => {
    tx.student.findFirst.mockResolvedValue(null);

    await expect(advanceStage(ctx(), STUDENT, { to_stage_id: TO_STAGE })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('rejects with NotFound when the destination stage does not exist', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    tx.lifecycleStage.findFirst.mockResolvedValue(null);

    await expect(advanceStage(ctx(), STUDENT, { to_stage_id: TO_STAGE })).rejects.toMatchObject({
      status: 404,
    });
  });

  // SVT-LIFECYCLE-2026-05: backward-direction guard with the default-open
  // (empty) matrix. Counsellors are blocked outright; admins must supply a
  // reason_code; same-stage no-op short-circuits without writing an event.

  it('default-open matrix: COUNSELLOR moving backward → 403 Forbidden', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    // Two findFirst calls: first for toStage (sequence 10), second for fromStage (sequence 50).
    // mockResolvedValueOnce / Once chains so order matches code path.
    tx.lifecycleStage.findFirst
      .mockResolvedValueOnce({ id: TO_STAGE, label: 'Lead', sequence: 10 })
      .mockResolvedValueOnce({ id: FROM_STAGE, label: 'Visa Approved', sequence: 50 });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([]); // open

    await expect(advanceStage(ctx('COUNSELLOR'), STUDENT, { to_stage_id: TO_STAGE })).rejects.toMatchObject({
      status: 403,
      detail: expect.stringMatching(/backward/i),
    });
    expect(tx.studentLifecycleEvent.create).not.toHaveBeenCalled();
  });

  it('default-open matrix: ADMIN moving backward without reason_code → 422', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    tx.lifecycleStage.findFirst
      .mockResolvedValueOnce({ id: TO_STAGE, label: 'Lead', sequence: 10 })
      .mockResolvedValueOnce({ id: FROM_STAGE, label: 'Visa Approved', sequence: 50 });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([]);

    await expect(advanceStage(ctx('ADMIN'), STUDENT, { to_stage_id: TO_STAGE })).rejects.toMatchObject({
      status: 422,
      detail: expect.stringMatching(/reason_code/i),
    });
    expect(tx.studentLifecycleEvent.create).not.toHaveBeenCalled();
  });

  it('default-open matrix: ADMIN moving backward with reason_code → succeeds', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    tx.lifecycleStage.findFirst
      .mockResolvedValueOnce({ id: TO_STAGE, label: 'Lead', sequence: 10 })
      .mockResolvedValueOnce({ id: FROM_STAGE, label: 'Visa Approved', sequence: 50 });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([]);
    tx.studentLifecycleEvent.create.mockResolvedValue({ id: randomUUID() });
    tx.student.updateMany.mockResolvedValue({ count: 1 });
    tx.student.findUniqueOrThrow.mockResolvedValue(freshStudentRow());

    await expect(
      advanceStage(ctx('ADMIN'), STUDENT, { to_stage_id: TO_STAGE, reason_code: 'correction' }),
    ).resolves.toBeDefined();
    // Direction + rule_applied land on the lifecycle event metadata.
    const eventCall = tx.studentLifecycleEvent.create.mock.calls[0]![0];
    expect(eventCall.data.metadata).toMatchObject({
      direction: 'backward',
      rule_applied: 'sequence-fallback',
    });
  });

  // SVT-WAVE-BILLING-SEC-P0-F2 — stage-skip bypass guard with empty matrix.
  // The default-open fallback now only allows forward+1 for COUNSELLOR;
  // bigger skips require ADMIN + `force: true` AND land a forced=true tag on
  // the lifecycle event metadata so the audit trail is honest about the jump.

  it('P0-F2: empty matrix, COUNSELLOR forward+1 → allowed', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    tx.lifecycleStage.findFirst
      .mockResolvedValueOnce({ id: TO_STAGE, label: 'Doc Collection', sequence: 11 })
      .mockResolvedValueOnce({ id: FROM_STAGE, label: 'Lead', sequence: 10 });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([]);
    tx.studentLifecycleEvent.create.mockResolvedValue({ id: randomUUID() });
    tx.student.updateMany.mockResolvedValue({ count: 1 });
    tx.student.findUniqueOrThrow.mockResolvedValue(freshStudentRow());

    await expect(
      advanceStage(ctx('COUNSELLOR'), STUDENT, { to_stage_id: TO_STAGE }),
    ).resolves.toBeDefined();
  });

  it('P0-F2: empty matrix, COUNSELLOR forward+5 → 403 Forbidden', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    tx.lifecycleStage.findFirst
      .mockResolvedValueOnce({ id: TO_STAGE, label: 'Visa Approved', sequence: 50 })
      .mockResolvedValueOnce({ id: FROM_STAGE, label: 'Lead', sequence: 10 });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([]);

    await expect(
      advanceStage(ctx('COUNSELLOR'), STUDENT, { to_stage_id: TO_STAGE }),
    ).rejects.toMatchObject({ status: 403 });
    expect(tx.studentLifecycleEvent.create).not.toHaveBeenCalled();
  });

  it('P0-F2: empty matrix, ADMIN forward+5 WITHOUT force → 422', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    tx.lifecycleStage.findFirst
      .mockResolvedValueOnce({ id: TO_STAGE, label: 'Visa Approved', sequence: 50 })
      .mockResolvedValueOnce({ id: FROM_STAGE, label: 'Lead', sequence: 10 });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([]);

    await expect(
      advanceStage(ctx('ADMIN'), STUDENT, { to_stage_id: TO_STAGE }),
    ).rejects.toMatchObject({ status: 422 });
    expect(tx.studentLifecycleEvent.create).not.toHaveBeenCalled();
  });

  it('P0-F2: empty matrix, ADMIN forward+5 WITH force → succeeds + metadata.forced=true', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: FROM_STAGE, version: 1 });
    tx.lifecycleStage.findFirst
      .mockResolvedValueOnce({ id: TO_STAGE, label: 'Visa Approved', sequence: 50 })
      .mockResolvedValueOnce({ id: FROM_STAGE, label: 'Lead', sequence: 10 });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([]);
    tx.studentLifecycleEvent.create.mockResolvedValue({ id: randomUUID() });
    tx.student.updateMany.mockResolvedValue({ count: 1 });
    tx.student.findUniqueOrThrow.mockResolvedValue(freshStudentRow());

    await expect(
      advanceStage(ctx('ADMIN'), STUDENT, { to_stage_id: TO_STAGE, force: true }),
    ).resolves.toBeDefined();
    const eventCall = tx.studentLifecycleEvent.create.mock.calls[0]![0];
    expect(eventCall.data.metadata).toMatchObject({
      direction: 'forward',
      forced: true,
      skipped_stages: 40,
    });
  });

  it('same-stage no-op: when fromStage === toStage we skip the lifecycle event', async () => {
    // current_stage_id === to_stage_id; the short-circuit fires before the
    // matrix lookup, so we only need to mock the destination findFirst.
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, current_stage_id: TO_STAGE, version: 1 });
    tx.lifecycleStage.findFirst.mockResolvedValueOnce({
      id: TO_STAGE,
      label: 'Visa Approved',
      sequence: 50,
    });
    tx.student.findUniqueOrThrow.mockResolvedValue(freshStudentRow());

    const out = await advanceStage(ctx(), STUDENT, { to_stage_id: TO_STAGE });
    expect(out).toBeDefined();
    expect(tx.studentLifecycleEvent.create).not.toHaveBeenCalled();
    expect(tx.student.updateMany).not.toHaveBeenCalled();
  });
});
