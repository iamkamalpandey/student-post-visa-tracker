// SVT-WAVE-PRIV-C1-2026-05 — full ACCESS round-trip integration test.
// Drives a DSAR through PENDING → IN_PROGRESS → COMPLETED then asserts:
//   1. an export bundle landed in storage,
//   2. the bundle contains every expected section,
//   3. decrypted PII (name_in_passport plaintext) is present,
//   4. the signed-download URL returns the bundle bytes.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', PRIVATE_PEM);
vi.stubEnv('JWT_PUBLIC_KEY', PUBLIC_PEM);
vi.stubEnv('JWT_KID', 'test-kid');
vi.stubEnv('JWT_ISSUER', 'spv-api-test');
vi.stubEnv('JWT_AUDIENCE', 'spv-app-test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = '11111111-1111-7111-8111-111111111111';
const ADMIN_ID = '22222222-2222-7222-8222-222222222222';
const STUDENT_ID = '33333333-3333-7333-8333-333333333333';

type DSARRow = {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  type: string;
  status: string;
  requested_at: Date;
  due_by: Date;
  completed_at: Date | null;
  export_storage_key: string | null;
  notes: string | null;
};

const store = {
  dsar: [] as DSARRow[],
  students: [] as Array<Record<string, unknown>>,
  // empty arrays for all the child tables — exercises the "no related rows"
  // branch which is the common case for a freshly-created student.
};

// In-memory storage bucket so we can read back what the export wrote.
const bucket = new Map<string, Buffer>();

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (v === null) {
      if (row[k] != null) return false;
      continue;
    }
    if (typeof v === 'object' && v !== null && 'lt' in (v as Record<string, unknown>)) {
      const cur = row[k] as Date | undefined;
      const lt = (v as { lt?: Date }).lt;
      if (cur && lt && cur >= lt) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function mkChildModel() {
  return {
    findMany: vi.fn(async () => [] as Array<Record<string, unknown>>),
    findFirst: vi.fn(async () => null),
    updateMany: vi.fn(async () => ({ count: 0 })),
    update: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  };
}

vi.mock('../src/config/db.js', () => {
  const prisma: Record<string, unknown> = {
    dSARRequest: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: DSARRow = {
          id: randomUUID(),
          tenant_id: String(data['tenant_id']),
          subject_type: String(data['subject_type']),
          subject_id: String(data['subject_id']),
          type: String(data['type']),
          status: (data['status'] as string) ?? 'PENDING',
          requested_at: (data['requested_at'] as Date) ?? new Date(),
          due_by: data['due_by'] as Date,
          completed_at: null,
          export_storage_key: null,
          notes: (data['notes'] as string | null) ?? null,
        };
        store.dsar.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.dsar.find((r) => matches(r as never, where)) ?? null,
      ),
      findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const r = store.dsar.find((row) => matches(row as never, where));
        if (!r) throw new Error('not found');
        return r;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.dsar.filter((r) => matches(r as never, where)),
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of store.dsar) {
          if (!matches(r as never, where)) continue;
          for (const [k, v] of Object.entries(data)) {
            (r as unknown as Record<string, unknown>)[k] = v;
          }
          count++;
        }
        return { count };
      }),
    },
    student: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.students.find((s) => s['id'] === where['id'] && s['tenant_id'] === where['tenant_id']) ?? null,
      ),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    studentAddress: mkChildModel(),
    studentIdentification: mkChildModel(),
    studentVisa: mkChildModel(),
    studentRegulatorIdentifier: mkChildModel(),
    enrollment: mkChildModel(),
    complianceCheck: mkChildModel(),
    engagementCheck: mkChildModel(),
    studentEmployment: mkChildModel(),
    studentDependent: mkChildModel(),
    studentContact: mkChildModel(),
    studentSponsorship: mkChildModel(),
    document: mkChildModel(),
    academicQualification: mkChildModel(),
    languageTestResult: mkChildModel(),
    note: mkChildModel(),
    entityTag: mkChildModel(),
    commsThread: mkChildModel(),
    commsMessage: mkChildModel(),
    insuranceRecord: mkChildModel(),
    reminder: mkChildModel(),
    travelRecord: mkChildModel(),
    accommodation: mkChildModel(),
    financeItem: mkChildModel(),
    accessTokenDenylist: { findUnique: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null) },
    refreshToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(prisma) : fn)),
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ '?column?': 1 }]),
    $extends: vi.fn(function (this: unknown) { return prisma; }),
  };
  return { prisma, disconnectDb: async () => undefined };
});

vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

vi.mock('../src/shared/encryption.js', () => ({
  // The fake decryptField returns "Plaintext: <hex>" so we can prove the
  // exported bundle contains decrypted data.
  encryptField: async (s: string | Buffer) =>
    Buffer.from(typeof s === 'string' ? s : s.toString('utf8'), 'utf8'),
  decryptField: async (b: Buffer) => `Plaintext: ${b.toString('utf8')}`,
  decryptFieldRaw: async (b: Buffer) => Buffer.from(`Plaintext: ${b.toString('utf8')}`),
  encryptJson: async (v: unknown) => Buffer.from(JSON.stringify(v ?? null), 'utf8'),
  decryptJson: async (b: Buffer) => JSON.parse(b.toString('utf8')),
  isCiphertext: () => true,
}));

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

vi.mock('../src/shared/idempotencyHandler.js', () => ({
  runIdempotent: async (
    _req: unknown,
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    _opts: unknown,
    work: () => Promise<unknown>,
  ) => {
    const body = await work();
    res.status(201).json(body);
  },
  requireIdempotencyKey: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../src/shared/transitionNotify.js', () => ({
  notifyStatusTransition: vi.fn(async () => undefined),
}));

vi.mock('../src/middlewares/rateLimit.js', () => ({
  dsarLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  heavyReadLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { dsarRouter } = await import('../src/modules/dsar/routes.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { signAccessToken } = await import('../src/shared/jwt.js');
const { __resetExportNoncesForTests } = await import('../src/modules/dsar/service.js');

function makeApp(): Express {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use('/api/v1/dsar', dsarRouter);
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}

let app: Express;
let adminTok: string;

beforeAll(async () => {
  app = makeApp();
  adminTok = await signAccessToken({ sub: ADMIN_ID, tid: TENANT, role: 'ADMIN', jti: randomUUID() });
});

beforeEach(() => {
  store.dsar.length = 0;
  store.students.length = 0;
  bucket.clear();
  __resetExportNoncesForTests();
});

describe('DSAR ACCESS round-trip (SVT-WAVE-PRIV-C1-2026-05)', () => {
  it('COMPLETED ACCESS generates bundle with decrypted PII + downloadable URL', async () => {
    // Seed the subject student row.
    store.students.push({
      id: STUDENT_ID,
      tenant_id: TENANT,
      given_name: 'Asha',
      family_name: 'Patel',
      email_primary: 'asha@example.com',
      name_in_passport_enc: Buffer.from('ASHA PATEL'),
      date_of_birth: new Date('2002-04-12'),
    });

    // Create DSAR.
    const create = await request(app)
      .post('/api/v1/dsar')
      .set('Authorization', `Bearer ${adminTok}`)
      .set('Idempotency-Key', randomUUID())
      .send({ subject_type: 'student', subject_id: STUDENT_ID, type: 'ACCESS' });
    expect(create.status).toBe(201);
    const id = create.body.id as string;

    // Drive to IN_PROGRESS then COMPLETED.
    const ip = await request(app)
      .patch(`/api/v1/dsar/${id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'IN_PROGRESS' });
    expect(ip.status).toBe(200);

    const done = await request(app)
      .patch(`/api/v1/dsar/${id}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .send({ status: 'COMPLETED' });
    expect(done.status).toBe(200);

    // The export bundle must now be in the bucket and the storage key
    // stamped on the row.
    const row = store.dsar.find((r) => r.id === id)!;
    expect(row.export_storage_key).toBeTruthy();
    expect(bucket.size).toBe(1);
    const blob = bucket.get(row.export_storage_key!)!;
    const bundle = JSON.parse(blob.toString('utf8'));

    // Expected sections.
    for (const key of [
      'student', 'addresses', 'identifications', 'visas', 'regulator_identifiers',
      'enrollments', 'compliance_checks', 'engagement_checks', 'employment',
      'dependents', 'contacts', 'sponsorships', 'documents',
      'academic_qualifications', 'language_test_results', 'notes', 'tags',
      'comms_messages',
    ]) {
      expect(bundle).toHaveProperty(key);
    }
    expect(bundle['__subject_type__']).toBe('student');
    expect(bundle['__subject_id__']).toBe(STUDENT_ID);
    expect(bundle['__dsar_type__']).toBe('ACCESS');
    // Decrypted PII: the encryption mock returns "Plaintext: <hex>" — the
    // exporter must have invoked decryptField on name_in_passport_enc.
    expect(bundle['student']['name_in_passport']).toBe('Plaintext: ASHA PATEL');
    // Raw email (not encrypted) makes it through unchanged.
    expect(bundle['student']['email_primary']).toBe('asha@example.com');

    // Request a signed download link + fetch it.
    const link = await request(app)
      .get(`/api/v1/dsar/${id}/export`)
      .set('Authorization', `Bearer ${adminTok}`);
    expect(link.status).toBe(200);
    const url = link.body.data.url as string;
    expect(url).toContain(`/api/v1/dsar/${id}/export/download?token=`);

    // Pull the token out of the URL and stream it back.
    const token = url.split('token=')[1]!;
    const stream = await request(app)
      .get(`/api/v1/dsar/${id}/export/download?token=${token}`)
      .set('Authorization', `Bearer ${adminTok}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(stream.status).toBe(200);
    expect(stream.headers['content-type']).toContain('application/json');
    expect(stream.headers['content-disposition']).toContain(`dsar-export-${id}.json`);
    // The body buffer is the raw JSON bundle bytes — must contain the
    // decrypted plaintext we put in earlier.
    const text = Buffer.isBuffer(stream.body) ? stream.body.toString('utf8') : String(stream.body);
    expect(text).toContain('Plaintext: ASHA PATEL');
  });

  it('PORTABILITY also generates a bundle on COMPLETED', async () => {
    store.students.push({
      id: STUDENT_ID,
      tenant_id: TENANT,
      given_name: 'Asha',
      family_name: 'Patel',
      name_in_passport_enc: Buffer.from('ASHA'),
      date_of_birth: new Date('2002-04-12'),
    });
    const create = await request(app)
      .post('/api/v1/dsar')
      .set('Authorization', `Bearer ${adminTok}`)
      .set('Idempotency-Key', randomUUID())
      .send({ subject_type: 'student', subject_id: STUDENT_ID, type: 'PORTABILITY' });
    expect(create.status).toBe(201);
    const id = create.body.id as string;
    await request(app).patch(`/api/v1/dsar/${id}`).set('Authorization', `Bearer ${adminTok}`).send({ status: 'IN_PROGRESS' });
    await request(app).patch(`/api/v1/dsar/${id}`).set('Authorization', `Bearer ${adminTok}`).send({ status: 'COMPLETED' });

    const row = store.dsar.find((r) => r.id === id)!;
    expect(row.export_storage_key).toBeTruthy();
    expect(bucket.size).toBeGreaterThan(0);
  });

  it('ERASURE (not ACCESS/PORTABILITY) does NOT generate an export bundle', async () => {
    store.students.push({
      id: STUDENT_ID,
      tenant_id: TENANT,
      given_name: 'A',
      family_name: 'P',
      name_in_passport_enc: Buffer.from('A'),
      date_of_birth: new Date('2002-04-12'),
    });
    const create = await request(app)
      .post('/api/v1/dsar')
      .set('Authorization', `Bearer ${adminTok}`)
      .set('Idempotency-Key', randomUUID())
      .send({ subject_type: 'student', subject_id: STUDENT_ID, type: 'ERASURE' });
    const id = create.body.id as string;
    await request(app).patch(`/api/v1/dsar/${id}`).set('Authorization', `Bearer ${adminTok}`).send({ status: 'IN_PROGRESS' });
    await request(app).patch(`/api/v1/dsar/${id}`).set('Authorization', `Bearer ${adminTok}`).send({ status: 'COMPLETED' });

    const row = store.dsar.find((r) => r.id === id)!;
    expect(row.export_storage_key).toBeNull();
    expect(bucket.size).toBe(0);
  });
});
