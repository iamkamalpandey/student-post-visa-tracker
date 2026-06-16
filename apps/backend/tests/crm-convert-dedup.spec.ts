// SVT-DEDUP-2026-06 — the lead→student convert guard against creating a second
// managed student for someone who already exists (same family+given name + DOB).
// Establishes the first crm-leads.service harness: a hand-mocked db passed via
// ctx + module mocks for the heavy create paths, so we exercise ONLY the guard.

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

// The convert path delegates the heavy lifting (encryption, code allocation,
// enrolment, audit) to other modules — stub them so the test isolates the guard.
const createStudentMock = vi.fn(async () => ({ id: 'stu-new', student_code: 'SPV-2026-000009' }));
const createForStudentMock = vi.fn(async () => ({}));
vi.mock('../src/modules/students/students.service.js', () => ({ create: createStudentMock }));
vi.mock('../src/modules/enrollments/enrollments.service.js', () => ({ createForStudent: createForStudentMock }));
vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

const { convertLeadToStudent } = await import('../src/modules/crm-leads/crm-leads.service.js');

type Candidate = { id: string; student_code: string; given_name: string; family_name: string };

function makeDb(candidates: Candidate[]) {
  return {
    crmLead: {
      findFirst: vi.fn(async () => ({ id: 'lead-1', student_id: null })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    student: { findMany: vi.fn(async () => candidates) },
    crmLeadFee: { findMany: vi.fn(async () => []) },
    financeItem: { create: vi.fn(async () => ({})) },
  };
}

const baseInput = {
  given_name: 'Maya',
  family_name: 'Patel',
  name_in_passport: 'Maya Patel',
  date_of_birth: '2000-01-01',
  gender: 'FEMALE',
  nationality_code: 'NP',
  primary_language: 'en',
} as unknown as Parameters<typeof convertLeadToStudent>[2];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (db: any) => ({ db, tenantId: 'tenant-1', actorId: 'user-1' }) as Parameters<typeof convertLeadToStudent>[0];

const aMatch: Candidate = { id: 'stu-existing', student_code: 'SPV-2026-000001', given_name: 'Maya', family_name: 'Patel' };

describe('convertLeadToStudent — duplicate guard', () => {
  beforeEach(() => {
    createStudentMock.mockClear();
    createForStudentMock.mockClear();
  });

  it('409s with candidate matches when a same-name+DOB student already exists', async () => {
    const db = makeDb([aMatch]);
    await expect(convertLeadToStudent(ctx(db), 'lead-1', baseInput)).rejects.toMatchObject({
      status: 409,
      code: 'duplicate_student_candidates',
    });
    // Guard fires BEFORE any student is created (no orphan/duplicate).
    expect(createStudentMock).not.toHaveBeenCalled();
    expect(db.student.findMany).toHaveBeenCalledTimes(1);
  });

  it('surfaces each candidate in the problem-detail errors[]', async () => {
    const db = makeDb([aMatch]);
    await expect(convertLeadToStudent(ctx(db), 'lead-1', baseInput)).rejects.toMatchObject({
      errors: [{ path: 'stu-existing', code: 'existing_student' }],
    });
  });

  it('proceeds (skips the probe) when acknowledge_duplicate is set', async () => {
    const db = makeDb([aMatch]);
    const r = await convertLeadToStudent(
      ctx(db),
      'lead-1',
      { ...baseInput, acknowledge_duplicate: true } as typeof baseInput,
    );
    expect(r.student_id).toBe('stu-new');
    expect(createStudentMock).toHaveBeenCalledTimes(1);
    expect(db.student.findMany).not.toHaveBeenCalled();
  });

  it('proceeds normally when no duplicate exists', async () => {
    const db = makeDb([]);
    const r = await convertLeadToStudent(ctx(db), 'lead-1', baseInput);
    expect(r.student_id).toBe('stu-new');
    expect(createStudentMock).toHaveBeenCalledTimes(1);
    expect(db.student.findMany).toHaveBeenCalledTimes(1);
  });
});
