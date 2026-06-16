// SVT-DSAR-ERASURE-HARDENING-2026-06 — coverage for the three DSAR hardening
// fixes plus a durable completeness guard for GDPR Art. 17 erasure.
//
// Style mirrors the prisma-mock approach of tests/dsar.spec.ts and
// tests/billing-payment-actions.spec.ts: stub envs, mock ../src/config/db.js
// with an in-memory store, capture writeAudit calls, stub encryption/hashing,
// and a getStorage/storage mock. Unlike the HTTP round-trip specs these call
// dsarService.update() directly so we can force precise mock returns
// (count:0 on the guarded transition write; the in-tx subject lookup to null).
//
// Covered:
//   1. (rank 16) guarded status-transition updateMany returning {count:0}
//      → update() rejects 409 Conflict.
//   2. (rank 5/11) ERASURE→COMPLETED where erasure throws → update() rejects,
//      a second dSARRequest.updateMany reverts status to the pre-transition
//      value (+ completed_at:null), and a 'dsar.erasure.failed' audit fires.
//      Plus the happy path: ERASURE→COMPLETED with a present subject resolves
//      and a 'dsar.erasure.executed' audit fires.
//   3. (rank 7) schema-driven META-TEST: every model declaring a `student_id`
//      field must either be referenced by eraseStudent's source via its prisma
//      delegate, or be on an explicit ALLOWLIST (with a reason). Fails loudly
//      when a NEW student-PII table is added but not wired into erasure.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test-kid');
vi.stubEnv('JWT_ISSUER', 'spv-api-test');
vi.stubEnv('JWT_AUDIENCE', 'spv-app-test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = '11111111-1111-7111-8111-111111111111';
const ADMIN_ID = '22222222-2222-7222-8222-222222222222';
const STUDENT_ID = '33333333-3333-7333-8333-333333333333';

type DSARStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'EXPIRED';
type DSARType = 'ACCESS' | 'PORTABILITY' | 'ERASURE' | 'RECTIFICATION' | 'RESTRICTION' | 'OBJECTION';

type DSARRow = {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  type: DSARType;
  status: DSARStatus;
  requested_at: Date;
  due_by: Date;
  completed_at: Date | null;
  export_storage_key: string | null;
  notes: string | null;
};

const store = {
  dsar: [] as DSARRow[],
  students: [] as Array<Record<string, unknown>>,
};

// Captured audit events (action + entity + after) for assertions.
const auditCalls: Array<{ action: string; entityId: string | null; after?: unknown }> = [];

// Generic in-memory where matcher: supports scalar equality, null, and { in: [] }.
function matchWhere(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) {
      if (row[k] != null) return false;
      continue;
    }
    if (typeof v === 'object' && v !== null && 'in' in (v as object)) {
      if (!(v as { in: unknown[] }).in.includes(row[k])) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

// Child-table delegate: a no-op-ish stand-in whose updateMany/deleteMany/count
// report empty results by default. The erasure exercises these; the happy-path
// test only needs them to resolve without throwing.
function mkChildModel() {
  return {
    findMany: vi.fn(async () => [] as Array<Record<string, unknown>>),
    findFirst: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 0 })),
    update: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    count: vi.fn(async () => 0),
  };
}

const dSARRequest = {
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const row: DSARRow = {
      id: randomUUID(),
      tenant_id: String(data['tenant_id']),
      subject_type: String(data['subject_type']),
      subject_id: String(data['subject_id']),
      type: data['type'] as DSARType,
      status: (data['status'] as DSARStatus) ?? 'PENDING',
      requested_at: (data['requested_at'] as Date) ?? new Date(),
      due_by: data['due_by'] as Date,
      completed_at: (data['completed_at'] as Date | null) ?? null,
      export_storage_key: (data['export_storage_key'] as string | null) ?? null,
      notes: (data['notes'] as string | null) ?? null,
    };
    store.dsar.push(row);
    return row;
  }),
  findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    store.dsar.find((r) => matchWhere(r as never, where)) ?? null,
  ),
  findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const r = store.dsar.find((row) => matchWhere(row as never, where));
    if (!r) throw new Error('not found');
    return r;
  }),
  findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    store.dsar.filter((r) => matchWhere(r as never, where)),
  ),
  updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    let count = 0;
    for (const r of store.dsar) {
      if (!matchWhere(r as never, where)) continue;
      for (const [k, v] of Object.entries(data)) {
        (r as unknown as Record<string, unknown>)[k] = v;
      }
      count++;
    }
    return { count };
  }),
};

const student = {
  findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
    store.students.find((s) => matchWhere(s, where)) ?? null,
  ),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const s = store.students.find((x) => x['id'] === where.id);
    if (s) Object.assign(s, data);
    return s ?? {};
  }),
  updateMany: vi.fn(async () => ({ count: 0 })),
};

// Child delegates referenced by eraseStudent. We declare them explicitly (not a
// Proxy) so the meta-test's "delegate exists on mock" sanity is incidental and
// the happy-path erasure has a concrete object for each table it touches.
const childDelegates = {
  studentAddress: mkChildModel(),
  studentIdentification: mkChildModel(),
  studentVisa: mkChildModel(),
  studentRegulatorIdentifier: mkChildModel(),
  studentDependent: mkChildModel(),
  studentContact: mkChildModel(),
  complianceCheck: mkChildModel(),
  engagementCheck: mkChildModel(),
  insuranceRecord: mkChildModel(),
  languageTestResult: mkChildModel(),
  note: mkChildModel(),
  commsThread: mkChildModel(),
  commsMessage: mkChildModel(),
  document: mkChildModel(),
  enrollment: mkChildModel(),
  reminder: mkChildModel(),
  travelRecord: mkChildModel(),
  studentEmployment: mkChildModel(),
  accommodation: mkChildModel(),
  academicQualification: mkChildModel(),
  studentSponsorship: mkChildModel(),
  sponsor: mkChildModel(),
  address: mkChildModel(),
  institution: mkChildModel(),
  campus: mkChildModel(),
  consentRecord: mkChildModel(),
  // SVT-SYNC-2026-06 — eraseStudent now redacts the finance line-items'
  // free-text, the converted lead's mirror PII, and the SPVT lead overlay.
  financeItem: mkChildModel(),
  crmLead: mkChildModel(),
  spvLeadOverlay: mkChildModel(),
  // SVT-DSAR-2026-06 — mock-interview records carry candidate name/email PII.
  interviewAttempt: mkChildModel(),
  // SVT-DSAR-2026-06 — crm child tables redacted on erasure (linked via lead_id).
  crmGuardian: mkChildModel(),
  crmPayment: mkChildModel(),
  crmRemark: mkChildModel(),
  crmCallHistory: mkChildModel(),
  crmVisit: mkChildModel(),
  crmApplication: mkChildModel(),
};

const prismaMock: Record<string, unknown> = {
  dSARRequest,
  student,
  ...childDelegates,
  refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  user: { findFirst: vi.fn(async () => null), update: vi.fn(async () => ({})) },
  auditLog: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null) },
  $transaction: vi.fn(async (fn: unknown) =>
    typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(prismaMock) : fn,
  ),
  $executeRaw: vi.fn(async () => 1),
  $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
  $extends: vi.fn(function (this: unknown) {
    return prismaMock;
  }),
  $disconnect: vi.fn(async () => undefined),
};

vi.mock('../src/config/db.js', () => ({
  prisma: prismaMock,
  disconnectDb: async () => undefined,
}));

vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async (...args: unknown[]) => {
    const ev = (args.length === 2 ? args[1] : args[0]) as {
      action: string;
      entityId?: string | null;
      entity_id?: string | null;
      after?: unknown;
    };
    auditCalls.push({
      action: ev.action,
      entityId: ev.entityId ?? ev.entity_id ?? null,
      after: ev.after,
    });
  }),
}));

vi.mock('../src/shared/encryption.js', () => ({
  encryptField: async (s: string | Buffer) =>
    Buffer.from(typeof s === 'string' ? s : s.toString('utf8'), 'utf8'),
  decryptField: async (b: Buffer) => b.toString('utf8'),
  decryptFieldRaw: async (b: Buffer) => Buffer.from(b.toString('utf8')),
  encryptJson: async (v: unknown) => Buffer.from(JSON.stringify(v ?? null), 'utf8'),
  decryptJson: async (b: Buffer) => JSON.parse(b.toString('utf8')),
  isCiphertext: () => true,
}));

vi.mock('../src/shared/hashing.js', async () => {
  const { createHash, createHmac } = await import('node:crypto');
  return {
    sha256Hex: (s: string) => createHash('sha256').update(s).digest('hex'),
    hashIp: (s: string) => createHash('sha256').update(`ip:${s}`).digest('hex'),
    hashUa: (s: string) => createHash('sha256').update(`ua:${s}`).digest('hex'),
    emailHashHmac: (s: string) => createHmac('sha256', 'test-pepper').update(s).digest('hex'),
  };
});

// Storage mock — the erasure's post-tx cleanup calls getStorage().delete on
// each collected document key. No documents in these tests, so delete is never
// hit, but the seam must resolve.
const bucket = new Map<string, Buffer>();
vi.mock('../src/modules/documents/storage.js', () => ({
  getStorage: () => ({
    put: vi.fn(async (key: string, data: Buffer) => {
      bucket.set(key, data);
    }),
    get: vi.fn(async (key: string) => bucket.get(key) ?? Buffer.alloc(0)),
    delete: vi.fn(async (key: string) => {
      bucket.delete(key);
    }),
    exists: vi.fn(async (key: string) => bucket.has(key)),
  }),
  buildStorageKey: vi.fn((opts: { docId: string; ext: string }) => `mock/${opts.docId}.${opts.ext}`),
  sha256Hex: vi.fn(() => 'sha'),
}));

// Transition notifier is fire-and-forget via setImmediate; stub it so the test
// process doesn't dangle on a real implementation.
vi.mock('../src/shared/transitionNotify.js', () => ({
  notifyStatusTransition: vi.fn(async () => undefined),
}));

const { dsarService } = await import('../src/modules/dsar/service.js');

// Handle to the mocked prisma so the concurrency test can force the guarded
// transition updateMany to match 0 rows (a racing writer flipped the row).
type ChildMock = {
  findMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
};
const { prisma: mockDb } = (await import('../src/config/db.js')) as unknown as {
  prisma: {
    dSARRequest: { updateMany: ReturnType<typeof vi.fn> };
    student: { findFirst: ReturnType<typeof vi.fn> };
    studentSponsorship: ChildMock;
    sponsor: ChildMock;
    studentAddress: ChildMock;
    address: ChildMock;
    accommodation: ChildMock;
    studentContact: ChildMock;
    studentEmployment: ChildMock;
    institution: ChildMock;
    campus: ChildMock;
  };
};

const adminReq = { user: { tid: TENANT, sub: ADMIN_ID, role: 'ADMIN' as const } };

function seedDsar(overrides: Partial<DSARRow> = {}): DSARRow {
  const row: DSARRow = {
    id: randomUUID(),
    tenant_id: TENANT,
    subject_type: 'student',
    subject_id: STUDENT_ID,
    type: 'ACCESS',
    status: 'IN_PROGRESS',
    requested_at: new Date(),
    due_by: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    completed_at: null,
    export_storage_key: null,
    notes: null,
    ...overrides,
  };
  store.dsar.push(row);
  return row;
}

function seedStudent(): void {
  store.students.push({
    id: STUDENT_ID,
    tenant_id: TENANT,
    given_name: 'Asha',
    family_name: 'Patel',
    middle_name: null,
    preferred_name: null,
    name_in_passport_enc: Buffer.from('ASHA PATEL'),
    date_of_birth: new Date('2002-04-12'),
    email_primary: 'asha@example.com',
    deleted_at: null,
  });
}

beforeEach(() => {
  store.dsar.length = 0;
  store.students.length = 0;
  auditCalls.length = 0;
  bucket.clear();
  vi.clearAllMocks();
});

// ===========================================================================
// 1. rank 16 — guarded status-transition updateMany returning {count:0} → 409.
// ===========================================================================
describe('rank 16 — concurrent status-transition guard', () => {
  it('rejects with 409 Conflict when the guarded transition write matches 0 rows', async () => {
    // ACCESS (not ERASURE) so the failure is purely the transition guard, with
    // no erasure side effects in play. IN_PROGRESS -> COMPLETED is a valid edge.
    const row = seedDsar({ type: 'ACCESS', status: 'IN_PROGRESS' });

    // The FIRST dSARRequest.updateMany in update() is the guarded transition
    // write. Force it to report 0 matched rows (a racing writer won the edge).
    mockDb.dSARRequest.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      dsarService.update(adminReq as never, row.id, { status: 'COMPLETED' } as never),
    ).rejects.toMatchObject({ status: 409 });

    // The row must NOT have been advanced to COMPLETED by a later write.
    expect(store.dsar.find((r) => r.id === row.id)!.status).toBe('IN_PROGRESS');
  });
});

// ===========================================================================
// 2. rank 5/11 — ERASURE→COMPLETED erasure-failure revert + audit, plus happy.
// ===========================================================================
describe('rank 5/11 — ERASURE completion erasure failure handling', () => {
  it('reverts status + completed_at and audits dsar.erasure.failed when erasure throws', async () => {
    // ERASURE request mid-flight; transitioning IN_PROGRESS -> COMPLETED is the
    // legal trigger to purge. We make the in-tx subject lookup return null so
    // eraseStudent throws NotFound, exercising the revert + failure-audit path.
    const row = seedDsar({ type: 'ERASURE', status: 'IN_PROGRESS' });
    // No student seeded → student.findFirst returns null inside eraseStudent.

    await expect(
      dsarService.update(adminReq as never, row.id, { status: 'COMPLETED' } as never),
    ).rejects.toMatchObject({ status: 404 });

    // A revert updateMany must have been issued setting status back to the
    // pre-transition value (IN_PROGRESS) and clearing completed_at.
    const revertCall = mockDb.dSARRequest.updateMany.mock.calls.find(
      (c) =>
        (c[0] as { data?: Record<string, unknown> }).data?.['status'] === 'IN_PROGRESS' &&
        (c[0] as { data?: Record<string, unknown> }).data?.['completed_at'] === null,
    );
    expect(revertCall).toBeTruthy();

    // The persisted row reflects the revert (not a false COMPLETED).
    const persisted = store.dsar.find((r) => r.id === row.id)!;
    expect(persisted.status).toBe('IN_PROGRESS');
    expect(persisted.completed_at).toBeNull();

    // A dsar.erasure.failed audit was captured, carrying the revert target.
    const failedAudit = auditCalls.find((c) => c.action === 'dsar.erasure.failed');
    expect(failedAudit).toBeTruthy();
    expect((failedAudit!.after as { reverted_to?: string }).reverted_to).toBe('IN_PROGRESS');

    // No success audit should have fired.
    expect(auditCalls.some((c) => c.action === 'dsar.erasure.executed')).toBe(false);
  });

  it('happy path: ERASURE→COMPLETED with a present subject resolves and audits dsar.erasure.executed', async () => {
    seedStudent();
    const row = seedDsar({ type: 'ERASURE', status: 'IN_PROGRESS' });
    // SVT-DSAR-2026-06 — a linked CRM lead → its children must be redacted too.
    const crmLeadModel = (childDelegates.crmLead as { findMany: ReturnType<typeof vi.fn> });
    crmLeadModel.findMany.mockResolvedValueOnce([{ id: 'lead-x' }]);

    const res = await dsarService.update(
      adminReq as never,
      row.id,
      { status: 'COMPLETED' } as never,
    );

    // CRM child PII redacted (guardian contact + free-text), scoped to the lead.
    const guardian = (childDelegates.crmGuardian as { updateMany: ReturnType<typeof vi.fn> }).updateMany;
    expect(guardian).toHaveBeenCalledTimes(1);
    expect(guardian.mock.calls[0]![0]).toMatchObject({
      where: { lead_id: { in: ['lead-x'] }, tenant_id: TENANT },
      data: { full_name: '[ERASED]', email: null },
    });
    expect((childDelegates.crmRemark as { updateMany: ReturnType<typeof vi.fn> }).updateMany).toHaveBeenCalledTimes(1);

    // Resolves with the COMPLETED row.
    expect((res as { status: DSARStatus }).status).toBe('COMPLETED');
    expect(store.dsar.find((r) => r.id === row.id)!.status).toBe('COMPLETED');

    // The parent student row was anonymised (sentinel applied).
    const s = store.students.find((x) => x['id'] === STUDENT_ID)!;
    expect(s['given_name']).toBe('[ERASED]');
    expect(s['deleted_at']).not.toBeNull();

    // Success audit fired; no failure audit.
    expect(auditCalls.some((c) => c.action === 'dsar.erasure.executed')).toBe(true);
    expect(auditCalls.some((c) => c.action === 'dsar.erasure.failed')).toBe(false);
  });
});

// ===========================================================================
// 2b. rank 7 (orphan branch) — shared catalog (Address / Sponsor) handling.
//
// Both Address and Sponsor are catalog rows shared across students; the erasure
// must NOT destroy a row another entity still references, and MUST anonymise one
// that is now exclusively this student's (orphaned). The orphan determination
// only works if this student's OWN link rows are removed BEFORE the reference
// count — otherwise the count never reaches 0 and orphaned PII silently
// survives. These tests pin that contract for the Sponsor path (the link row is
// hard-deleted, then the count decides) and the Address path.
// ===========================================================================
describe('rank 7 — shared catalog orphan handling (Sponsor / Address)', () => {
  const SPONSOR_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  const ADDRESS_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

  it('deletes the per-student StudentSponsorship link then anonymises a now-orphaned Sponsor', async () => {
    seedStudent();
    const row = seedDsar({ type: 'ERASURE', status: 'IN_PROGRESS' });

    // This student has one sponsorship pointing at SPONSOR_ID.
    mockDb.studentSponsorship.findMany.mockResolvedValueOnce([{ sponsor_id: SPONSOR_ID }]);
    // After the link rows are removed, NO StudentSponsorship references the
    // sponsor → orphaned.
    mockDb.studentSponsorship.count.mockResolvedValueOnce(0);

    await dsarService.update(adminReq as never, row.id, { status: 'COMPLETED' } as never);

    // The per-student link row was HARD-DELETED (not merely nulled) — this is
    // what makes the subsequent orphan count exclude this student's own links.
    expect(mockDb.studentSponsorship.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ student_id: STUDENT_ID, tenant_id: TENANT }),
      }),
    );
    // The orphan reference-count was queried for the captured sponsor id.
    expect(mockDb.studentSponsorship.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ sponsor_id: SPONSOR_ID }) }),
    );
    // Orphaned → the Sponsor catalog PII was anonymised.
    expect(mockDb.sponsor.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: SPONSOR_ID, tenant_id: TENANT }),
        data: expect.objectContaining({ legal_name: '[ERASED]', email: null, phone_e164: null }),
      }),
    );
  });

  it('leaves a Sponsor still referenced by ANOTHER student untouched', async () => {
    seedStudent();
    const row = seedDsar({ type: 'ERASURE', status: 'IN_PROGRESS' });

    mockDb.studentSponsorship.findMany.mockResolvedValueOnce([{ sponsor_id: SPONSOR_ID }]);
    // A different student's sponsorship still points at SPONSOR_ID → shared.
    mockDb.studentSponsorship.count.mockResolvedValueOnce(1);

    await dsarService.update(adminReq as never, row.id, { status: 'COMPLETED' } as never);

    // Link still deleted for THIS student...
    expect(mockDb.studentSponsorship.deleteMany).toHaveBeenCalled();
    // ...but the shared Sponsor catalog row is NOT anonymised.
    expect(mockDb.sponsor.updateMany).not.toHaveBeenCalled();
  });

  it('anonymises an orphaned Address but spares one still referenced by another entity', async () => {
    seedStudent();
    const orphanRow = seedDsar({ type: 'ERASURE', status: 'IN_PROGRESS' });

    // This student links one address.
    mockDb.studentAddress.findMany.mockResolvedValueOnce([{ address_id: ADDRESS_ID }]);
    // Every Address referrer relation reports 0 → orphaned. (studentAddress,
    // accommodation, studentContact, sponsor, studentEmployment, institution,
    // campus — see eraseStudent step 9.) Default mock count is 0, so the
    // Promise.all of counts all resolve to 0 without per-call overrides.
    await dsarService.update(adminReq as never, orphanRow.id, { status: 'COMPLETED' } as never);

    // Link rows removed first, then the orphaned Address PII anonymised.
    expect(mockDb.studentAddress.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ student_id: STUDENT_ID, tenant_id: TENANT }),
      }),
    );
    expect(mockDb.address.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: ADDRESS_ID, tenant_id: TENANT }),
        data: expect.objectContaining({ line1: '[ERASED]', postal_code: null, latitude: null }),
      }),
    );

    // Now the shared case: reset and make one referrer (accommodation) report a
    // surviving reference so the Address is NOT orphaned.
    vi.clearAllMocks();
    store.dsar.length = 0;
    store.students.length = 0;
    seedStudent();
    const sharedRow = seedDsar({ type: 'ERASURE', status: 'IN_PROGRESS' });
    mockDb.studentAddress.findMany.mockResolvedValueOnce([{ address_id: ADDRESS_ID }]);
    mockDb.accommodation.count.mockResolvedValueOnce(1); // another entity holds it

    await dsarService.update(adminReq as never, sharedRow.id, { status: 'COMPLETED' } as never);

    expect(mockDb.address.updateMany).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 3. rank 7 — schema-driven completeness META-TEST.
//
// Parse schema.prisma for every model declaring a `student_id` field. For each
// such model, assert eraseStudent's source references the corresponding prisma
// delegate (camelCase of the model name, e.g. StudentEmployment ->
// tx.studentEmployment / prisma.studentEmployment). Models intentionally NOT
// shredded must appear on ALLOWLIST with a reason, so adding a NEW student-PII
// table without wiring erasure fails this test loudly.
// ===========================================================================
describe('rank 7 — erasure completeness guard (schema-driven)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(here, '../prisma/schema.prisma');
  const servicePath = resolve(here, '../src/modules/dsar/service.ts');
  const schemaSrc = readFileSync(schemaPath, 'utf8');
  const serviceSrc = readFileSync(servicePath, 'utf8');

  // Isolate the eraseStudent function body so a delegate referenced ONLY by the
  // ACCESS export bundle (buildStudentBundle) doesn't falsely satisfy the guard.
  function extractEraseStudentSource(src: string): string {
    const start = src.indexOf('async function eraseStudent(');
    expect(start).toBeGreaterThanOrEqual(0);
    const next = src.indexOf('async function eraseUser(', start);
    expect(next).toBeGreaterThan(start);
    return src.slice(start, next);
  }

  // Parse `model X { ... }` blocks; return names of models whose body declares a
  // `student_id` field (nullable or not). Matches the per-field line
  // `student_id  String[?]  @db.Uuid` style used throughout the schema.
  function modelsWithStudentId(src: string): string[] {
    const names: string[] = [];
    const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
    let m: RegExpExecArray | null;
    while ((m = modelRe.exec(src)) !== null) {
      const name = m[1]!;
      const body = m[2]!;
      if (/^\s*student_id\s+String/m.test(body)) names.push(name);
    }
    return names;
  }

  // Model name -> prisma delegate accessor (camelCase first letter). Prisma's
  // generated client lowercases only the first character: StudentEmployment ->
  // studentEmployment, DSARRequest -> dSARRequest (not relevant here).
  function delegateName(model: string): string {
    return model.charAt(0).toLowerCase() + model.slice(1);
  }

  // Models that legitimately are NOT erased by eraseStudent, each with a reason.
  // Anything new with a student_id MUST be triaged here or wired into erasure.
  const ALLOWLIST: Record<string, string> = {
    // Append-only lifecycle/event log — tamper-evident history of state
    // changes, retained as proof-of-processing (not free-text subject PII).
    StudentLifecycleEvent: 'append-only event log; retained as proof-of-processing',
    // Per-item checklist progress carries no direct identity PII (FK + boolean
    // completion + optional staff note); cascades with the soft-deleted student
    // and is operational metadata, not subject identity data.
    StudentStageChecklistProgress: 'operational checklist state; no identity PII, FK-only',
    // Financial / billing records retained under LEGAL_OBLIGATION (tax,
    // anti-fraud, accounting). GDPR Art. 17(3)(b) carve-out. Erasing these
    // would break the ledger the consultancy must keep.
    FinanceItem: 'financial ledger retained under legal obligation (Art.17(3)(b))',
    CommissionClaim: 'commission/financial record retained under legal obligation',
    Payment: 'billing payment record retained under legal obligation',
    StudentCredit: 'billing credit/ledger record retained under legal obligation',
  };

  const eraseSrc = extractEraseStudentSource(serviceSrc);
  const models = modelsWithStudentId(schemaSrc);

  it('discovers a non-trivial set of student-linked models', () => {
    // Guards against a regex regression silently matching nothing.
    expect(models.length).toBeGreaterThanOrEqual(15);
    // A few anchors we know exist.
    for (const anchor of ['StudentEmployment', 'TravelRecord', 'Accommodation', 'StudentSponsorship']) {
      expect(models).toContain(anchor);
    }
  });

  it('every student-linked model is either erased or explicitly allowlisted', () => {
    const missing: string[] = [];
    for (const model of models) {
      if (model in ALLOWLIST) continue;
      const delegate = delegateName(model);
      // Require a `.<delegate>` member access in eraseStudent's body — covers
      // tx.<delegate>.<op> for every table the routine shreds.
      const ref = new RegExp(`\\.${delegate}\\b`);
      if (!ref.test(eraseSrc)) missing.push(`${model} (expected tx.${delegate}.* in eraseStudent)`);
    }
    expect(
      missing,
      `Student-PII tables not handled by eraseStudent and not allowlisted:\n  ${missing.join('\n  ')}\n` +
        `If a table is intentionally retained, add it to ALLOWLIST with a reason.`,
    ).toEqual([]);
  });

  it('every allowlisted model still actually declares a student_id (no stale entries)', () => {
    const stale = Object.keys(ALLOWLIST).filter((m) => !models.includes(m));
    expect(stale, `Stale ALLOWLIST entries (no longer have student_id): ${stale.join(', ')}`).toEqual([]);
  });
});
