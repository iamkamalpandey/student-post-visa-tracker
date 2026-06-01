// Tests for the enrollment status FSM gate added to enrollments.service.update().
//
// Mirrors the mocking strategy of students-advance-stage.spec.ts: stub
// @prisma/client / config/db / encryption / audit so the service can be
// imported without a real database, then drive `update()` directly.
//
// Covers:
//   - Valid transition (OFFERED → ACCEPTED) by COUNSELLOR  → 200 OK.
//   - Invalid skip-ahead (OFFERED → COMPLETED)             → 422.
//   - Admin rollback with reason_code (COMPLETED → ENROLLED) → 200 OK.
//   - Counsellor attempting same rollback                  → 403.
//   - Reason-required transition without a reason          → 422.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type EnrollmentRow = {
  id: string;
  institution_id: string;
  program_id: string;
  program_intake_id: string | null;
  campus_id: string | null;
  status: string;
  commission_claim: { id: string; status: string } | null;
};

type Db = {
  enrollment: {
    findFirst: ReturnType<typeof vi.fn>;
    findFirstOrThrow: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

let db: Db;
const makeDb = (): Db => ({
  enrollment: {
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
});

vi.mock('../src/config/db.js', () => {
  const prisma = { /* unused — service receives ctx.db directly */ };
  return { prisma, disconnectDb: async () => undefined };
});

// Audit writes go through writeAudit — stub it so we can assert metadata.
const auditCalls: unknown[] = [];
vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (event: unknown) => {
    auditCalls.push(event);
  }),
}));

// Commission recalculator is fire-and-forget; stub so it doesn't try to import
// real prisma. Calls are recorded so we can assert it only fires on the two
// claim-minting transitions.
const recalcCalls: string[] = [];
vi.mock('../src/modules/commissions/recalculator.js', () => ({
  upsertClaimForEnrollment: vi.fn(async (_ctx: unknown, enrollmentId: string) => {
    recalcCalls.push(enrollmentId);
  }),
}));

// ---------------------------------------------------------------------------
// Imports must come AFTER vi.mock calls so the mocks take effect.
// ---------------------------------------------------------------------------

const { update } = await import('../src/modules/enrollments/enrollments.service.js');

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '22222222-2222-7222-8222-222222222222';
const ENROLLMENT = '33333333-3333-7333-8333-333333333333';
const INSTITUTION = '44444444-4444-7444-8444-444444444444';
const PROGRAM = '55555555-5555-7555-8555-555555555555';

beforeEach(() => {
  db = makeDb();
  auditCalls.length = 0;
  recalcCalls.length = 0;
});

function ctx(role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER' = 'COUNSELLOR') {
  return {
    db: db as unknown as Parameters<typeof update>[0]['db'],
    tenantId: TENANT,
    actorId: ACTOR,
    actorRole: role,
  };
}

function freshRow(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    id: ENROLLMENT,
    institution_id: INSTITUTION,
    program_id: PROGRAM,
    program_intake_id: null,
    campus_id: null,
    status: 'OFFERED',
    commission_claim: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrollments.update() — FSM gate', () => {
  it('accepts a valid forward transition (OFFERED → ACCEPTED) by COUNSELLOR', async () => {
    db.enrollment.findFirst
      .mockResolvedValueOnce(freshRow({ status: 'OFFERED' })) // initial read
      .mockResolvedValueOnce(freshRow({ status: 'ACCEPTED' })); // getById return
    db.enrollment.updateMany.mockResolvedValue({ count: 1 });
    db.enrollment.findFirstOrThrow.mockResolvedValue({ id: ENROLLMENT, status: 'ACCEPTED' });

    await expect(
      update(ctx('COUNSELLOR'), ENROLLMENT, { status: 'ACCEPTED' }),
    ).resolves.toBeDefined();

    expect(db.enrollment.updateMany).toHaveBeenCalledTimes(1);
    // SVT-AUDIT-SEC-2026-05 — service emits two audit rows on status change:
    // status_transition (FSM-specific) then enrollment.updated (field diff).
    expect(auditCalls).toHaveLength(2);
    expect(auditCalls[0]).toMatchObject({
      action: 'enrollment.status_transition',
      after: { from_status: 'OFFERED', to_status: 'ACCEPTED', reason_code: null },
    });
    expect(auditCalls[1]).toMatchObject({ action: 'enrollment.updated' });
    // OFFERED→ACCEPTED is one of the two claim-minting edges → recalc fires.
    expect(recalcCalls).toEqual([ENROLLMENT]);
  });

  it('rejects a skip-ahead transition (OFFERED → COMPLETED) with 422', async () => {
    db.enrollment.findFirst.mockResolvedValueOnce(freshRow({ status: 'OFFERED' }));

    await expect(
      update(ctx('COUNSELLOR'), ENROLLMENT, { status: 'COMPLETED' }),
    ).rejects.toMatchObject({
      status: 422,
      title: 'Invalid status transition',
      detail: expect.stringMatching(/OFFERED -> COMPLETED/),
    });
    // No write should happen.
    expect(db.enrollment.updateMany).not.toHaveBeenCalled();
    expect(auditCalls).toHaveLength(0);
  });

  it('allows an ADMIN rollback (COMPLETED → ENROLLED) with reason_code', async () => {
    db.enrollment.findFirst
      .mockResolvedValueOnce(freshRow({ status: 'COMPLETED' }))
      .mockResolvedValueOnce(freshRow({ status: 'ENROLLED' }));
    db.enrollment.updateMany.mockResolvedValue({ count: 1 });
    db.enrollment.findFirstOrThrow.mockResolvedValue({ id: ENROLLMENT, status: 'ENROLLED' });

    await expect(
      update(ctx('ADMIN'), ENROLLMENT, {
        status: 'ENROLLED',
        reason_code: 'data-correction',
      }),
    ).resolves.toBeDefined();

    expect(db.enrollment.updateMany).toHaveBeenCalledTimes(1);
    expect(auditCalls[0]).toMatchObject({
      after: { from_status: 'COMPLETED', to_status: 'ENROLLED', reason_code: 'data-correction' },
    });
    // COMPLETED→ENROLLED is NOT a claim-minting edge → no recalc.
    expect(recalcCalls).toEqual([]);
  });

  it('blocks a COUNSELLOR attempting the same rollback (COMPLETED → ENROLLED) with 403', async () => {
    db.enrollment.findFirst.mockResolvedValueOnce(freshRow({ status: 'COMPLETED' }));

    await expect(
      update(ctx('COUNSELLOR'), ENROLLMENT, {
        status: 'ENROLLED',
        reason_code: 'oops',
      }),
    ).rejects.toMatchObject({
      status: 403,
      title: 'Invalid status transition',
      detail: expect.stringMatching(/requires role ADMIN/),
    });
    expect(db.enrollment.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a reason-required transition without reason_code (422)', async () => {
    db.enrollment.findFirst.mockResolvedValueOnce(freshRow({ status: 'ACCEPTED' }));

    await expect(
      update(ctx('COUNSELLOR'), ENROLLMENT, { status: 'WITHDRAWN' }),
    ).rejects.toMatchObject({
      status: 422,
      title: 'Invalid status transition',
      detail: expect.stringMatching(/reason_code/),
    });
    expect(db.enrollment.updateMany).not.toHaveBeenCalled();
  });

  it('locks tuition fields when the linked claim is INVOICED (409)', async () => {
    db.enrollment.findFirst.mockResolvedValueOnce(
      freshRow({
        status: 'ENROLLED',
        commission_claim: { id: 'claim-1', status: 'INVOICED' },
      }),
    );

    await expect(
      update(ctx('COUNSELLOR'), ENROLLMENT, { tuition_total_minor: 999n }),
    ).rejects.toMatchObject({
      status: 409,
      detail: expect.stringMatching(/Tuition fields locked/),
    });
    expect(db.enrollment.updateMany).not.toHaveBeenCalled();
  });

  it('permits ADMIN tuition edit when allow_locked_field_edit=true', async () => {
    db.enrollment.findFirst
      .mockResolvedValueOnce(
        freshRow({
          status: 'ENROLLED',
          commission_claim: { id: 'claim-1', status: 'PAID' },
        }),
      )
      .mockResolvedValueOnce(freshRow({ status: 'ENROLLED' }));
    db.enrollment.updateMany.mockResolvedValue({ count: 1 });
    db.enrollment.findFirstOrThrow.mockResolvedValue({ id: ENROLLMENT, status: 'ENROLLED' });

    await expect(
      update(ctx('ADMIN'), ENROLLMENT, {
        tuition_total_minor: 999n,
        allow_locked_field_edit: true,
      }),
    ).resolves.toBeDefined();
    expect(db.enrollment.updateMany).toHaveBeenCalledTimes(1);
  });
});
