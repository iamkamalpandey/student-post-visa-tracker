// SVT-DEDUP-2026-06 + SVT-REL-2026-06 — the lead→student convert guard against
// creating a second managed student (same family+given name + DOB), and the
// atomic link + fee-migration transaction. One shared mock client backs both
// ctx.db (the pre-tx reads) and the raw prisma.$transaction (the atomic block),
// with students/enrollments/audit stubbed so we exercise only the convert flow.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

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

type Candidate = { id: string; student_code: string; given_name: string; family_name: string };
type FeeRow = {
  id: string; session_label: string; amount_minor: bigint; currency: string;
  due_on: Date; status: string; paid_at: Date | null;
  // SVT-QA-2026-08 (LEAD-H5) — partial-settlement amount carried across the
  // CrmLeadFee → FinanceItem migration.
  paid_amount_minor: bigint | null;
};

// Per-test mutable state the shared mock client reads from.
const state: { candidates: Candidate[]; linkCount: number; fees: FeeRow[] } = {
  candidates: [],
  linkCount: 1,
  fees: [],
};

// One mock client used as BOTH ctx.db and the raw config/db `prisma`. Its
// $transaction runs the callback against itself, so tx.* hits the same spies.
const mockClient: Record<string, unknown> = {
  crmLead: {
    findFirst: vi.fn(async () => ({ id: 'lead-1', student_id: null })),
    updateMany: vi.fn(async () => ({ count: state.linkCount })),
  },
  student: {
    findMany: vi.fn(async () => state.candidates),
    // SVT-QA-2026-08 (LEAD-C1) — compensating soft-delete of the just-created
    // student when the linking tx fails, so a rollback can't leave an orphan.
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  crmLeadFee: { findMany: vi.fn(async () => state.fees), update: vi.fn(async () => ({})) },
  financeItem: { create: vi.fn(async () => ({})) },
  // SVT-QA-2026-08 (LEAD-M1) — convert closes the lead's open follow-ups so the
  // reminder staircase stops firing against a lead nobody works anymore.
  crmFollowUp: { updateMany: vi.fn(async () => ({ count: 0 })) },
  $executeRaw: vi.fn(async () => 0),
  $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockClient)),
};

vi.mock('../src/config/db.js', () => ({ prisma: mockClient, disconnectDb: async () => undefined }));

const createStudentMock = vi.fn(async () => ({ id: 'stu-new', student_code: 'SPV-2026-000009' }));
const createForStudentMock = vi.fn(async () => ({}));
vi.mock('../src/modules/students/students.service.js', () => ({ create: createStudentMock }));
vi.mock('../src/modules/enrollments/enrollments.service.js', () => ({ createForStudent: createForStudentMock }));
vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

const { convertLeadToStudent } = await import('../src/modules/crm-leads/crm-leads.service.js');

const baseInput = {
  given_name: 'Maya',
  family_name: 'Patel',
  name_in_passport: 'Maya Patel',
  date_of_birth: '2000-01-01',
  gender: 'FEMALE',
  nationality_code: 'NP',
  primary_language: 'en',
} as unknown as Parameters<typeof convertLeadToStudent>[2];

const ctx = { db: mockClient, tenantId: 'tenant-1', actorId: 'user-1' } as unknown as Parameters<typeof convertLeadToStudent>[0];

const aMatch: Candidate = { id: 'stu-existing', student_code: 'SPV-2026-000001', given_name: 'Maya', family_name: 'Patel' };

describe('convertLeadToStudent — duplicate guard + atomic migration', () => {
  beforeEach(() => {
    createStudentMock.mockClear();
    createForStudentMock.mockClear();
    (mockClient.student as { findMany: ReturnType<typeof vi.fn> }).findMany.mockClear();
    (mockClient.student as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mockClear();
    (mockClient.financeItem as { create: ReturnType<typeof vi.fn> }).create.mockClear();
    (mockClient.crmLead as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mockClear();
    (mockClient.crmFollowUp as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mockClear();
    (mockClient.$transaction as ReturnType<typeof vi.fn>).mockClear();
    state.candidates = [];
    state.linkCount = 1;
    state.fees = [];
  });

  it('409s with candidate matches when a same-name+DOB student already exists', async () => {
    state.candidates = [aMatch];
    await expect(convertLeadToStudent(ctx, 'lead-1', baseInput)).rejects.toMatchObject({
      status: 409,
      code: 'duplicate_student_candidates',
    });
    // Guard fires BEFORE any student is created (no orphan/duplicate).
    expect(createStudentMock).not.toHaveBeenCalled();
  });

  it('surfaces each candidate in the problem-detail errors[]', async () => {
    state.candidates = [aMatch];
    await expect(convertLeadToStudent(ctx, 'lead-1', baseInput)).rejects.toMatchObject({
      errors: [{ path: 'stu-existing', code: 'existing_student' }],
    });
  });

  it('proceeds (skips the probe) when acknowledge_duplicate is set', async () => {
    state.candidates = [aMatch];
    const r = await convertLeadToStudent(
      ctx,
      'lead-1',
      { ...baseInput, acknowledge_duplicate: true } as typeof baseInput,
    );
    expect(r.student_id).toBe('stu-new');
    expect(createStudentMock).toHaveBeenCalledTimes(1);
    expect((mockClient.student as { findMany: ReturnType<typeof vi.fn> }).findMany).not.toHaveBeenCalled();
  });

  it('proceeds normally when no duplicate exists, linking + migrating in one tx', async () => {
    state.fees = [
      { id: 'fee-1', session_label: 'Sem 1', amount_minor: 100000n, currency: 'NPR', due_on: new Date('2026-01-01'), status: 'SCHEDULED', paid_at: null, paid_amount_minor: null },
    ];
    const r = await convertLeadToStudent(ctx, 'lead-1', baseInput);
    expect(r.student_id).toBe('stu-new');
    expect(r.fees_migrated).toBe(1);
    expect(createStudentMock).toHaveBeenCalledTimes(1);
    // The link + fee-migration ran inside a single (mocked) transaction.
    expect(mockClient.$transaction).toHaveBeenCalledTimes(1);
    expect((mockClient.financeItem as { create: ReturnType<typeof vi.fn> }).create).toHaveBeenCalledTimes(1);
  });

  it('rolls back (throws) when the lead was linked by a concurrent convert', async () => {
    state.linkCount = 0; // updateMany matched nothing → race lost
    await expect(convertLeadToStudent(ctx, 'lead-1', baseInput)).rejects.toMatchObject({ status: 409 });
  });

  // ── SVT-QA-2026-08 regressions ────────────────────────────────────────────

  it('soft-deletes the just-created student when the linking tx fails (no orphan)', async () => {
    // LEAD-C1. `createStudent` necessarily runs OUTSIDE the linking tx (it holds
    // an advisory lock to allocate the SPV code). Before the fix, a tx failure
    // left that student durable, unlinked and unreachable — and the dedup guard
    // then matched the orphan on retry, so each attempt minted another one.
    state.linkCount = 0; // force the tx to throw
    await expect(convertLeadToStudent(ctx, 'lead-1', baseInput)).rejects.toMatchObject({ status: 409 });
    const su = (mockClient.student as { updateMany: ReturnType<typeof vi.fn> }).updateMany;
    expect(su).toHaveBeenCalledTimes(1);
    expect(su.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'stu-new', tenant_id: 'tenant-1', deleted_at: null },
    });
    expect(su.mock.calls[0]?.[0]?.data?.deleted_at).toBeInstanceOf(Date);
  });

  it('does NOT soft-delete the student when the convert succeeds', async () => {
    await convertLeadToStudent(ctx, 'lead-1', baseInput);
    expect((mockClient.student as { updateMany: ReturnType<typeof vi.fn> }).updateMany).not.toHaveBeenCalled();
  });

  it('carries paid_amount_minor onto the migrated FinanceItem (partial settlement survives)', async () => {
    // LEAD-H5. A fee marked PAID for 2,500 of 10,000 used to migrate as a fully
    // settled 10,000 item — the 7,500 shortfall silently left the books.
    state.fees = [{
      id: 'fee-1', session_label: 'Sem 1',
      amount_minor: 1_000_000n, currency: 'NPR',
      due_on: new Date('2026-01-01'), status: 'PAID',
      paid_at: new Date('2026-02-01'), paid_amount_minor: 250_000n,
    }];
    await convertLeadToStudent(ctx, 'lead-1', baseInput);
    const create = (mockClient.financeItem as { create: ReturnType<typeof vi.fn> }).create;
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.data).toMatchObject({
      amount_minor: 1_000_000n,
      paid_amount_minor: 250_000n,
      status: 'PAID',
    });
  });

  it('marks the lead COMPLETED and closes its open follow-ups', async () => {
    // LEAD-M1. A converted lead used to stay ACTIVE — still in the open work
    // queue, still counted by financeSummary, still firing follow-up reminders.
    await convertLeadToStudent(ctx, 'lead-1', baseInput);
    const link = (mockClient.crmLead as { updateMany: ReturnType<typeof vi.fn> }).updateMany;
    expect(link.mock.calls[0]?.[0]?.data).toMatchObject({
      student_id: 'stu-new',
      spv_status: 'COMPLETED',
    });
    const fu = (mockClient.crmFollowUp as { updateMany: ReturnType<typeof vi.fn> }).updateMany;
    expect(fu).toHaveBeenCalledTimes(1);
    expect(fu.mock.calls[0]?.[0]?.where).toMatchObject({
      lead_id: 'lead-1', tenant_id: 'tenant-1', deleted_at: null,
    });
  });

  it('blocks convert while the linked student is LIVE', async () => {
    // LEAD-H3 (negative half): a live link must still 409.
    (mockClient.crmLead as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mockResolvedValueOnce({
      id: 'lead-1', student_id: 'stu-live', student: { deleted_at: null },
    });
    await expect(convertLeadToStudent(ctx, 'lead-1', baseInput)).rejects.toMatchObject({ status: 409 });
    expect(createStudentMock).not.toHaveBeenCalled();
  });

  it('allows re-convert when the previously linked student was soft-deleted', async () => {
    // LEAD-H3 (positive half). The old guard fired on ANY non-null student_id,
    // so cleaning up a mis-converted student permanently bricked the lead —
    // every future Convert returned 409 with no API path to reset the link.
    (mockClient.crmLead as { findFirst: ReturnType<typeof vi.fn> }).findFirst.mockResolvedValueOnce({
      id: 'lead-1', student_id: 'stu-old', student: { deleted_at: new Date('2026-03-01') },
    });
    const r = await convertLeadToStudent(ctx, 'lead-1', baseInput);
    expect(r.student_id).toBe('stu-new');
    expect(createStudentMock).toHaveBeenCalledTimes(1);
  });
});
