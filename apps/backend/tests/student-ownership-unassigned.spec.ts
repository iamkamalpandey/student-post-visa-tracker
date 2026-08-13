// SVT-SEC-2026-08 — an unassigned student must be reachable by a counsellor.
//
// `assertStudentOwnership` compared `student.assigned_to_id !== req.user.sub`.
// `null !== '<uuid>'` is true, so every UNASSIGNED student 403'd for every
// non-admin. That mattered because unassigned is the normal state on arrival:
// `create()` sets `assigned_to_id: input.assigned_to_id ?? null` and the
// quick-create form never sends one, so a counsellor pressed "Add student",
// received a row, and was refused the moment they opened it — and could not
// repair it either, because only ADMIN may set `assigned_to_id`.
//
// The realistic response to "I just made this and it says I'm not authorised"
// is to make it again, so the visible symptom was duplicate students rather
// than an error anyone would report. CSV-imported and ADMIN-created students
// land unassigned too.
//
// `requireLeadOwnership` in the same file already had the carve-out, with the
// reasoning spelled out: unassigned records are a shared queue and "locking
// those out would break intake". Students now match.

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
const COUNSELLOR = '22222222-2222-7222-8222-222222222222';
const OTHER_COUNSELLOR = '33333333-3333-7333-8333-333333333333';
const STUDENT = '44444444-4444-7444-8444-444444444444';

/** What the mocked lookup returns for the student under test. */
let studentRow: { assigned_to_id: string | null } | null = null;

// SVT-SEC-2026-08 (T0-7) — assertStudentOwnership takes its client from
// `req.db` when tenantContext supplied one, and otherwise opens its own
// tenant-scoped transaction. These tests call it with a bare request object, so
// they exercise the withTenantTx fallback and the mock needs $transaction +
// $executeRaw. Without a tenant GUC the `students` policy matches no rows, and
// this gate would 403 every counsellor in production.
const studentDb: Record<string, unknown> = {
  student: { findFirst: vi.fn(async () => studentRow) },
};
studentDb['$transaction'] = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(studentDb));
studentDb['$executeRaw'] = vi.fn(async () => 1);

vi.mock('../src/config/db.js', () => ({
  prisma: studentDb,
  prismaAdmin: {},
}));

const { assertStudentOwnership } = await import('../src/middlewares/auth.js');

const req = (sub: string, role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER') =>
  ({ user: { sub, tid: TENANT, role } }) as unknown as Parameters<typeof assertStudentOwnership>[1];

beforeEach(() => {
  studentRow = null;
  vi.clearAllMocks();
});

describe('assertStudentOwnership — unassigned students are a shared queue', () => {
  it('lets a counsellor open a student nobody is assigned to', async () => {
    studentRow = { assigned_to_id: null };
    // Pre-fix this threw: null !== '<uuid>'.
    await expect(assertStudentOwnership(STUDENT, req(COUNSELLOR, 'COUNSELLOR'))).resolves
      .toBeUndefined();
  });

  it('lets a DIFFERENT counsellor open the same unassigned student', async () => {
    // "Shared queue" means shared — not first-come-first-locked.
    studentRow = { assigned_to_id: null };
    await expect(assertStudentOwnership(STUDENT, req(OTHER_COUNSELLOR, 'COUNSELLOR'))).resolves
      .toBeUndefined();
  });

  it('lets a VIEWER open an unassigned student', async () => {
    studentRow = { assigned_to_id: null };
    await expect(assertStudentOwnership(STUDENT, req(COUNSELLOR, 'VIEWER'))).resolves
      .toBeUndefined();
  });
});

describe('assertStudentOwnership — the gate still holds where it matters', () => {
  it("still refuses a student assigned to someone else", async () => {
    studentRow = { assigned_to_id: OTHER_COUNSELLOR };
    await expect(
      assertStudentOwnership(STUDENT, req(COUNSELLOR, 'COUNSELLOR')),
    ).rejects.toThrow(/Not authorised/);
  });

  it('allows the assigned counsellor through', async () => {
    studentRow = { assigned_to_id: COUNSELLOR };
    await expect(assertStudentOwnership(STUDENT, req(COUNSELLOR, 'COUNSELLOR'))).resolves
      .toBeUndefined();
  });

  it('ADMIN bypasses regardless of assignment', async () => {
    studentRow = { assigned_to_id: OTHER_COUNSELLOR };
    await expect(assertStudentOwnership(STUDENT, req(COUNSELLOR, 'ADMIN'))).resolves
      .toBeUndefined();
  });

  it('a missing student is still refused, without leaking that it is missing', async () => {
    studentRow = null;
    await expect(
      assertStudentOwnership(STUDENT, req(COUNSELLOR, 'COUNSELLOR')),
    ).rejects.toThrow(/Not authorised/);
  });
});
