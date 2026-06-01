// SVT-FSM-2026-05: students status FSM tests.
//
// We exercise two surfaces:
//   1. advanceStage() must refuse with 409 when the student is ON_HOLD.
//   2. update() must refuse status transitions that the FSM disallows
//      (e.g. WITHDRAWN → ACTIVE without ADMIN role).

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

type Tx = {
  student: {
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
  };
  lifecycleStage: { findFirst: ReturnType<typeof vi.fn> };
  lifecycleStageTransition: { findMany: ReturnType<typeof vi.fn> };
  studentLifecycleEvent: { create: ReturnType<typeof vi.fn> };
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
    student: {
      findFirst: vi.fn(async (...args: unknown[]) => tx.student.findFirst(...args)),
      updateMany: vi.fn(async (...args: unknown[]) => tx.student.updateMany(...args)),
      findUniqueOrThrow: vi.fn(async (...args: unknown[]) => tx.student.findUniqueOrThrow(...args)),
    },
    $transaction: vi.fn(async (fn: (t: Tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/encryption.js', () => ({
  encryptField: async (s: string | Buffer) =>
    Buffer.from(typeof s === 'string' ? s : s.toString('utf8'), 'utf8'),
  decryptField: async (b: Buffer) => b.toString('utf8'),
  encryptJson: async (v: unknown) => Buffer.from(JSON.stringify(v ?? null), 'utf8'),
  decryptJson: async (b: Buffer) => JSON.parse(b.toString('utf8')),
}));

const { advanceStage, update } = await import('../src/modules/students/students.service.js');
const { prisma } = await import('../src/config/db.js');

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '22222222-2222-7222-8222-222222222222';
const STUDENT = '33333333-3333-7333-8333-333333333333';
const FROM_STAGE = '44444444-4444-7444-8444-444444444444';
const TO_STAGE = '55555555-5555-7555-8555-555555555555';

beforeEach(() => {
  tx = makeTx();
});

describe('advanceStage() ON_HOLD guard', () => {
  it('refuses with 409 when the student is ON_HOLD', async () => {
    tx.student.findFirst.mockResolvedValue({
      id: STUDENT,
      current_stage_id: FROM_STAGE,
      version: 1,
      status: 'ON_HOLD',
      given_name: 'A',
      family_name: 'B',
      assigned_to_id: null,
    });
    tx.lifecycleStage.findFirst.mockResolvedValue({ id: TO_STAGE, label: 'Next', sequence: 20 });

    await expect(
      advanceStage(
        {
          db: prisma as unknown as Parameters<typeof advanceStage>[0]['db'],
          tenantId: TENANT,
          actorId: ACTOR,
          actorRole: 'COUNSELLOR',
        },
        STUDENT,
        { to_stage_id: TO_STAGE },
      ),
    ).rejects.toMatchObject({
      status: 409,
      detail: expect.stringMatching(/on hold/i),
    });
    // No lifecycle event was written.
    expect(tx.studentLifecycleEvent.create).not.toHaveBeenCalled();
  });

  it('proceeds normally when the student is ACTIVE', async () => {
    tx.student.findFirst.mockResolvedValue({
      id: STUDENT,
      current_stage_id: FROM_STAGE,
      version: 1,
      status: 'ACTIVE',
      given_name: 'A',
      family_name: 'B',
      assigned_to_id: null,
    });
    tx.lifecycleStage.findFirst.mockResolvedValue({ id: TO_STAGE, label: 'Next', sequence: 20 });
    tx.lifecycleStageTransition.findMany.mockResolvedValue([]);
    tx.studentLifecycleEvent.create.mockResolvedValue({ id: 'evt-1' });
    tx.student.updateMany.mockResolvedValue({ count: 1 });
    tx.student.findUniqueOrThrow.mockResolvedValue({
      id: STUDENT,
      tenant_id: TENANT,
      version: 2,
      current_stage: { id: TO_STAGE, key: 'k', label: 'Next', sequence: 20, category: 'X' },
      assigned_to: null,
    });
    await expect(
      advanceStage(
        {
          db: prisma as unknown as Parameters<typeof advanceStage>[0]['db'],
          tenantId: TENANT,
          actorId: ACTOR,
          actorRole: 'COUNSELLOR',
        },
        STUDENT,
        { to_stage_id: TO_STAGE },
      ),
    ).resolves.toBeDefined();
  });
});

describe('update() status FSM', () => {
  it('WITHDRAWN → ACTIVE by COUNSELLOR is rejected (403)', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, version: 1, status: 'WITHDRAWN' });
    await expect(
      update(
        {
          db: prisma as unknown as Parameters<typeof update>[0]['db'],
          tenantId: TENANT,
          actorId: ACTOR,
          actorRole: 'COUNSELLOR',
        },
        STUDENT,
        { status: 'ACTIVE', notes: 'reason given here' } as never,
        '"1"',
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('ACTIVE → WITHDRAWN without a reason is rejected (422)', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, version: 1, status: 'ACTIVE' });
    await expect(
      update(
        {
          db: prisma as unknown as Parameters<typeof update>[0]['db'],
          tenantId: TENANT,
          actorId: ACTOR,
          actorRole: 'COUNSELLOR',
        },
        STUDENT,
        { status: 'WITHDRAWN' } as never,
        '"1"',
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('COMPLETED → DEFERRED (terminal-to-terminal) is rejected (409)', async () => {
    tx.student.findFirst.mockResolvedValue({ id: STUDENT, version: 1, status: 'COMPLETED' });
    await expect(
      update(
        {
          db: prisma as unknown as Parameters<typeof update>[0]['db'],
          tenantId: TENANT,
          actorId: ACTOR,
          actorRole: 'ADMIN',
        },
        STUDENT,
        { status: 'DEFERRED', notes: 'should not be allowed even by admin' } as never,
        '"1"',
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
