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
type FeeRow = { id: string; session_label: string; amount_minor: bigint; currency: string; due_on: Date; status: string; paid_at: Date | null };

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
  student: { findMany: vi.fn(async () => state.candidates) },
  crmLeadFee: { findMany: vi.fn(async () => state.fees), update: vi.fn(async () => ({})) },
  financeItem: { create: vi.fn(async () => ({})) },
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
    (mockClient.financeItem as { create: ReturnType<typeof vi.fn> }).create.mockClear();
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
      { id: 'fee-1', session_label: 'Sem 1', amount_minor: 100000n, currency: 'NPR', due_on: new Date('2026-01-01'), status: 'SCHEDULED', paid_at: null },
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
});
