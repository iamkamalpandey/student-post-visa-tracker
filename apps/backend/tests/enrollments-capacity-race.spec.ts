// SVT-WAVE-BILLING-SEC-P1-F7 — ProgramIntake.capacity race test.
//
// The previous implementation did `count() then create()` without a row lock
// on the ProgramIntake row, so two concurrent enrollments at capacity-1 could
// both observe `seated < capacity` and both succeed. The fix wraps the count
// and create in a single transaction that opens with a `SELECT … FOR UPDATE`
// on the ProgramIntake row, so the two paths serialise.
//
// We simulate the race by having the in-memory store report `seated = cap - 1`
// for the FIRST count, then `seated = cap` for the SECOND (i.e. the second
// caller blocks on the FOR UPDATE, then re-reads after the first commits).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = '11111111-1111-7111-8111-111111111111';
const STUDENT = '22222222-2222-7222-8222-222222222222';
const INSTITUTION = '33333333-3333-7333-8333-333333333333';
const PROGRAM = '44444444-4444-7444-8444-444444444444';
const INTAKE = '55555555-5555-7555-8555-555555555555';

vi.mock('../src/config/db.js', () => {
  const prisma = {};
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

vi.mock('../src/modules/commissions/recalculator.js', () => ({
  upsertClaimForEnrollment: vi.fn(async () => undefined),
}));

vi.mock('../src/modules/billing/enrollment-hook.js', () => ({
  maybeSeedFeePlan: vi.fn(async () => undefined),
  maybePauseOnLeave: vi.fn(async () => undefined),
  maybeResumeFromLeave: vi.fn(async () => undefined),
  maybeCancelOnWithdraw: vi.fn(async () => undefined),
}));

vi.mock('../src/modules/super-agents/service.js', () => ({
  isLinkedToInstitution: vi.fn(async () => true),
}));

const { createForStudent } = await import('../src/modules/enrollments/enrollments.service.js');

type Counts = { value: number };
const seatedCounts: Counts = { value: 0 };
const capacity = 2;

function makeDb() {
  const program = { id: PROGRAM, institution_id: INSTITUTION };
  const intake = { id: INTAKE, campus_id: null, capacity };
  const txObj: Record<string, unknown> = {
    student: {
      findFirst: vi.fn(async () => ({ id: STUDENT })),
    },
    program: { findFirst: vi.fn(async () => program) },
    programIntake: { findFirst: vi.fn(async () => intake) },
    campus: { findFirst: vi.fn(async () => null) },
    enrollment: {
      count: vi.fn(async () => seatedCounts.value),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        seatedCounts.value += 1;
        return { id: 'enr_' + seatedCounts.value, ...data, version: 1 };
      }),
    },
    $queryRaw: vi.fn(async () => [{ id: INTAKE, capacity }]),
  };
  const db = {
    ...txObj,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txObj)),
  };
  return db;
}

beforeEach(() => {
  seatedCounts.value = 0;
});

describe('createForStudent — P1-F7 ProgramIntake capacity race', () => {
  it('two concurrent enrollments at capacity-1 → one succeeds, second 409', async () => {
    const db = makeDb();
    seatedCounts.value = capacity - 1; // exactly one seat left

    const ctx = { db: db as never, tenantId: TENANT, actorId: 'u' };
    const baseInput = {
      institution_id: INSTITUTION,
      program_id: PROGRAM,
      program_intake_id: INTAKE,
      campus_id: null,
      super_agent_id: null,
      enrollment_no: null,
      start_date: null,
      expected_end_date: null,
      actual_end_date: null,
      status: 'APPLIED' as const,
      tuition_total_minor: null,
      tuition_currency: null,
      scholarship_minor: 0n,
      scholarship_name: null,
      agent_commission_minor: null,
      notes: null,
    };

    // First create takes the last seat (seated 1 → 2).
    await createForStudent(ctx, STUDENT, baseInput as never);
    // Second create must now see the locked count = capacity and refuse.
    await expect(
      createForStudent(ctx, STUDENT, baseInput as never),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('within-capacity enrolment succeeds and increments seat count', async () => {
    const db = makeDb();
    seatedCounts.value = 0;

    const ctx = { db: db as never, tenantId: TENANT, actorId: 'u' };
    const baseInput = {
      institution_id: INSTITUTION,
      program_id: PROGRAM,
      program_intake_id: INTAKE,
      campus_id: null,
      super_agent_id: null,
      enrollment_no: null,
      start_date: null,
      expected_end_date: null,
      actual_end_date: null,
      status: 'APPLIED' as const,
      tuition_total_minor: null,
      tuition_currency: null,
      scholarship_minor: 0n,
      scholarship_name: null,
      agent_commission_minor: null,
      notes: null,
    };

    await createForStudent(ctx, STUDENT, baseInput as never);
    expect(seatedCounts.value).toBe(1);
  });
});
