// SVT-WAVE-KMS-PROVIDER-2026-05 — rewrap-secrets script tests.
//
// We exercise the script's pure layer (rewrapColumn) against an in-memory
// fake PrismaClient. This keeps the test hermetic — no real DB, no migration
// apply — while still covering:
//
//   - Round-trip: a row encrypted under KEK_A decrypts after rewrap under KEK_B.
//   - Old KEK rejection: with only KEK_B loadable, decrypting an OLD blob fails.
//   - Dry-run: --dry-run must not mutate any row or insert progress.
//   - Resume: a second pass over the same rows is a no-op.
//   - Schema coverage: every `*_enc Bytes` in schema.prisma is present in the
//     ENCRYPTED_COLUMNS list (catches new encrypted columns landing without
//     the rewrap script being updated).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
});

import { encryptField, decryptField } from '../src/shared/encryption.js';
import { LocalKms, __setKmsForTests, type Kms } from '../src/config/kms.js';
import {
  ENCRYPTED_COLUMNS,
  rewrapColumn,
  runRewrap,
  type RewrapArgs,
  type EncryptedColumn,
} from '../scripts/rewrap-secrets.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ----------------------------------------------------------------------------
// Fake PrismaClient
// ----------------------------------------------------------------------------
// Implements just enough of the $queryRaw + $executeRaw + $transaction
// surface that rewrapColumn issues. The fake doesn't parse SQL — it relies
// on the well-defined parameter order produced by the script.

type FakeRow = { id: string; blob: Buffer };

function makeFakePrisma(initial: FakeRow[]) {
  const rows: FakeRow[] = initial.map((r) => ({ id: r.id, blob: Buffer.from(r.blob) }));
  const progress = new Set<string>(); // table|col|id keys
  const inserts: { table: string; column: string; row_id: string; new_kek_id?: string; old_kek_id?: string }[] = [];
  const matchProgressKey = (table: string, col: string, id: string) => `${table}|${col}|${id}`;

  async function queryRaw(_strings: TemplateStringsArray, ...values: unknown[]): Promise<FakeRow[]> {
    const literals = values.filter((v): v is string => typeof v === 'string');
    const table = literals[0]!;
    const column = literals[1]!;
    const limit = (values.find((v): v is number => typeof v === 'number') ?? 500) as number;
    const filtered = rows.filter((r) => !progress.has(matchProgressKey(table, column, r.id)));
    return filtered.slice(0, limit);
  }

  async function executeRaw(_strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const literals = values.filter((v): v is string => typeof v === 'string');
    const buffers = values.filter((v): v is Buffer => Buffer.isBuffer(v));
    if (buffers.length === 1) {
      // UPDATE
      const id = literals[0]!;
      const newBlob = buffers[0]!;
      const row = rows.find((r) => r.id === id);
      if (row) row.blob = newBlob;
      return 1;
    }
    // INSERT INTO kek_rotation_progress
    const [table, column, row_id, old_kek_id, new_kek_id] = literals as (string | undefined)[];
    progress.add(matchProgressKey(table!, column!, row_id!));
    inserts.push({ table: table!, column: column!, row_id: row_id!, old_kek_id, new_kek_id });
    return 1;
  }

  const tx = { $executeRaw: executeRaw };
  const client = {
    $queryRaw: queryRaw as unknown,
    $executeRaw: executeRaw as unknown,
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    $disconnect: async () => undefined,
  } as unknown as import('@prisma/client').PrismaClient;

  return { client, rows, progress, inserts };
}

const COL: EncryptedColumn = {
  table: 'students',
  pk: 'id',
  column: 'name_in_passport_enc',
  nullable: false,
};

const DEFAULT_ARGS: RewrapArgs = {
  oldKekId: 'kek-old',
  newKekId: 'kek-new',
  dryRun: false,
  resume: false,
  batchSize: 50,
};

// A LocalKms variant that knows TWO KEKs and tries both on unwrap. Mirrors
// the realistic "during rotation OLD + NEW are both loadable" situation:
// fresh wraps always go under NEW (matches AWS KMS rotation semantics).
class DualKms implements Kms {
  constructor(private readonly oldKek: Buffer, private readonly newKek: Buffer) {}
  async generateDek() {
    const fresh = new LocalKms(this.newKek, 'kek-new');
    return fresh.generateDek();
  }
  async decryptDek(blob: Buffer): Promise<Buffer> {
    const newKms = new LocalKms(this.newKek, 'kek-new');
    try {
      return await newKms.decryptDek(blob);
    } catch {
      const oldKms = new LocalKms(this.oldKek, 'kek-old');
      return oldKms.decryptDek(blob);
    }
  }
  rotateKekId(): string {
    return 'dual';
  }
}

beforeEach(() => {
  __setKmsForTests(null);
});

describe('rewrap-secrets — schema coverage', () => {
  it('ENCRYPTED_COLUMNS covers every *_enc Bytes column in schema.prisma', () => {
    const schemaPath = resolve(__dirname, '..', 'prisma', 'schema.prisma');
    const text = readFileSync(schemaPath, 'utf8');
    // Match lines like "  passport_number_enc   Bytes?" — extract the column name.
    const re = /^\s*([a-z_][a-z0-9_]*_enc)\s+Bytes\??/gim;
    const foundColumns = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      foundColumns.add(m[1]!);
    }
    const listed = new Set(ENCRYPTED_COLUMNS.map((c) => c.column));
    const missing = [...foundColumns].filter((c) => !listed.has(c));
    expect(missing).toEqual([]);
  });
});

describe('rewrap-secrets — round trip + dry-run + old-KEK rejection', () => {
  it('decrypts under OLD KEK and re-encrypts under NEW KEK; final blobs read under NEW KEK', async () => {
    const kekA = randomBytes(32);
    const kekB = randomBytes(32);

    // Phase 1: seed with KEK_A.
    __setKmsForTests(new LocalKms(kekA, 'kek-A'));
    const plaintext1 = 'AB1234567';
    const plaintext2 = 'XY9876543';
    const blob1 = await encryptField(plaintext1);
    const blob2 = await encryptField(plaintext2);

    // Phase 2: switch to DualKms so unwrap finds KEK_A, wrap uses KEK_B.
    __setKmsForTests(new DualKms(kekA, kekB));
    const fake = makeFakePrisma([
      { id: 'row-1', blob: blob1 },
      { id: 'row-2', blob: blob2 },
    ]);
    const n = await rewrapColumn(fake.client, COL, DEFAULT_ARGS);
    expect(n).toBe(2);

    // Verify the rewritten blobs decrypt under KEK_B ALONE.
    __setKmsForTests(new LocalKms(kekB, 'kek-B'));
    expect(await decryptField(fake.rows[0]!.blob)).toBe(plaintext1);
    expect(await decryptField(fake.rows[1]!.blob)).toBe(plaintext2);

    // Progress recorded for both rows with the correct kek ids.
    expect(fake.inserts).toHaveLength(2);
    expect(fake.inserts.every((i) => i.new_kek_id === 'kek-new' && i.old_kek_id === 'kek-old')).toBe(true);
  });

  it('after rewrap, the OLD KEK alone cannot decrypt the new blobs', async () => {
    const kekA = randomBytes(32);
    const kekB = randomBytes(32);

    __setKmsForTests(new LocalKms(kekA, 'kek-A'));
    const blob = await encryptField('passport-secret');

    __setKmsForTests(new DualKms(kekA, kekB));
    const fake = makeFakePrisma([{ id: 'r', blob }]);
    await rewrapColumn(fake.client, COL, DEFAULT_ARGS);

    __setKmsForTests(new LocalKms(kekA, 'kek-A-only'));
    await expect(decryptField(fake.rows[0]!.blob)).rejects.toThrow();
  });

  it('--dry-run decrypts every row but writes nothing and records no progress', async () => {
    const kekA = randomBytes(32);
    const kekB = randomBytes(32);

    __setKmsForTests(new LocalKms(kekA, 'kek-A'));
    const blob = await encryptField('dry-run-test');
    const originalBlob = Buffer.from(blob);

    __setKmsForTests(new DualKms(kekA, kekB));
    const fake = makeFakePrisma([{ id: 'd', blob }]);
    const n = await rewrapColumn(fake.client, COL, { ...DEFAULT_ARGS, dryRun: true });

    expect(n).toBe(1);
    expect(fake.rows[0]!.blob.equals(originalBlob)).toBe(true);
    expect(fake.inserts).toEqual([]);
    expect(fake.progress.size).toBe(0);
  });

  it('skips rows already in progress (resume path)', async () => {
    const kek = randomBytes(32);

    __setKmsForTests(new LocalKms(kek, 'K'));
    const blob = await encryptField('already-done');

    __setKmsForTests(new DualKms(kek, kek));
    const fake = makeFakePrisma([{ id: 'A', blob }]);
    expect(await rewrapColumn(fake.client, COL, DEFAULT_ARGS)).toBe(1);
    expect(await rewrapColumn(fake.client, COL, DEFAULT_ARGS)).toBe(0);
  });
});

// SVT-WAVE-KMS-PROVIDER-2026-05 — D2 --table scoping.
//
// The --table flag stages a rotation table-by-table. Two behaviours matter:
//   - a known table name restricts processing to that table only,
//   - an unknown table name fails FAST at startup (would otherwise no-op the
//     rotation silently, leaving the operator believing the rewrap ran).
describe('rewrap-secrets — --table scoping (D2)', () => {
  it('unknown --table name fails fast with the list of known tables', async () => {
    // runRewrap touches the KMS singleton on the way in; a LocalKms is fine
    // for the throw path because no DB IO happens before the table check.
    __setKmsForTests(new LocalKms(randomBytes(32), 'k'));
    const fake = makeFakePrisma([]);
    await expect(
      runRewrap(
        { ...DEFAULT_ARGS, table: 'definitely_not_a_table' },
        fake.client,
      ),
    ).rejects.toThrow(/does not match any encrypted column/);
  });

  it('known --table restricts rewrap to that table only', async () => {
    // We don't need real data here — just confirm the filter narrows the
    // ENCRYPTED_COLUMNS list. With an empty fake, totals come back as a map
    // of (table.column) → 0, but ONLY for the named table.
    __setKmsForTests(new LocalKms(randomBytes(32), 'k'));
    const fake = makeFakePrisma([]);
    const { totals } = await runRewrap(
      { ...DEFAULT_ARGS, table: 'audit_logs' },
      fake.client,
    );
    const tables = new Set(Object.keys(totals).map((k) => k.split('.')[0]));
    expect([...tables]).toEqual(['audit_logs']);
  });

  it('without --table, every entry in ENCRYPTED_COLUMNS is walked', async () => {
    __setKmsForTests(new LocalKms(randomBytes(32), 'k'));
    const fake = makeFakePrisma([]);
    const { totals } = await runRewrap(DEFAULT_ARGS, fake.client);
    // Each (table.column) key must show up once.
    expect(Object.keys(totals).sort()).toEqual(
      ENCRYPTED_COLUMNS.map((c) => `${c.table}.${c.column}`).sort(),
    );
  });
});
