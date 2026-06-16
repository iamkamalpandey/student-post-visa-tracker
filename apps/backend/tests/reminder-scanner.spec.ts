// SVT-PERF-REMINDER-SCANNER-BATCH-2026-05 — scanForTenant() perf regression test.
//
// The original scanner ran one $transaction(upsertReminder) per candidate row.
// At 50 students × ~7 entity types × ~3 offsets that's >1000 round-trips per
// tenant per pass, and at production fan-out ~3000+. This test pins the new
// batched implementation to a DB-call budget so the regression cannot
// silently come back.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_ID = '11111111-1111-7111-8111-111111111111';

// Counters: every call hitting the prisma surface area gets tallied so we
// can assert the new code stays inside its batched DB-call budget.
const counters = {
  // top-level reads (findMany/findFirst on entity tables)
  reads: 0,
  // bulk writes (createMany — the new fast path)
  bulkCreates: 0,
  // per-row writes (upsert / create — the old slow path; must stay zero)
  perRowWrites: 0,
  // $transaction wrappers — one per entity group bulk insert
  transactions: 0,
  // raw set_config statements
  setConfig: 0,
  // rows pushed in by createMany (total reminder candidates that survived
  // the past-date filter)
  rowsBulkInserted: 0,
};

// ---------------------------------------------------------------------------
// Fixture: 50 students each with a future-dated visa expiry. 3 EXPIRY offsets
// per student = 150 candidate reminders that would have been 150 separate
// $transaction/upsert pairs in the legacy implementation.
// ---------------------------------------------------------------------------
const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // +1y

function makeVisas(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `vvvvvvvv-vvvv-7vvv-8vvv-${String(i).padStart(12, '0')}`,
    student_id: `ssssssss-ssss-7sss-8sss-${String(i).padStart(12, '0')}`,
    expires_on: FUTURE,
    destination_country: 'AU',
  }));
}

const fixture = {
  visas: makeVisas(50),
  // SVT-COMPLIANCE-REMINDERS-2026-06 — controllable per-test compliance checks.
  complianceChecks: [] as Array<{ id: string; student_id: string; check_type: string; scheduled_at: Date }>,
};

const inMemoryReminders: Array<Record<string, unknown>> = [];

vi.mock('../src/config/db.js', () => {
  const visaFindMany = vi.fn(async () => {
    counters.reads++;
    return fixture.visas;
  });
  const emptyRead = vi.fn(async () => {
    counters.reads++;
    return [];
  });
  const userFindFirst = vi.fn(async () => {
    counters.reads++;
    return { id: ADMIN_ID };
  });

  const reminderCreateMany = vi.fn(
    async (args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
      counters.bulkCreates++;
      // Simulate the unique-constraint dedup so re-runs don't double-count.
      const before = inMemoryReminders.length;
      for (const r of args.data) {
        const dupe = inMemoryReminders.some(
          (existing) =>
            existing['tenant_id'] === r['tenant_id'] &&
            existing['source_entity_type'] === r['source_entity_type'] &&
            existing['source_entity_id'] === r['source_entity_id'] &&
            (existing['scheduled_for'] as Date).getTime() === (r['scheduled_for'] as Date).getTime(),
        );
        if (!dupe) inMemoryReminders.push(r);
      }
      const inserted = inMemoryReminders.length - before;
      counters.rowsBulkInserted += inserted;
      return { count: inserted };
    },
  );
  const reminderUpsert = vi.fn(async () => {
    counters.perRowWrites++;
    return {};
  });
  const reminderCreate = vi.fn(async () => {
    counters.perRowWrites++;
    return {};
  });

  const tx = {
    $executeRaw: vi.fn(async () => {
      counters.setConfig++;
      return 1;
    }),
    reminder: {
      createMany: reminderCreateMany,
      upsert: reminderUpsert,
      create: reminderCreate,
    },
  };

  return {
    prisma: {
      user: { findFirst: userFindFirst },
      enrollment: { findMany: emptyRead },
      financeItem: { findMany: emptyRead },
      studentVisa: { findMany: visaFindMany },
      studentIdentification: { findMany: emptyRead },
      insuranceRecord: { findMany: emptyRead },
      document: { findMany: emptyRead },
      commissionClaim: { findMany: emptyRead },
      complianceCheck: {
        findMany: vi.fn(async () => {
          counters.reads++;
          return fixture.complianceChecks;
        }),
      },
      reminder: {
        createMany: reminderCreateMany,
        upsert: reminderUpsert,
        create: reminderCreate,
      },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
        counters.transactions++;
        return fn(tx);
      }),
    },
    disconnectDb: async () => undefined,
  };
});

const { scanForTenant, _clearAdminCache } = await import('../src/jobs/reminderScanner.js');

beforeEach(() => {
  counters.reads = 0;
  counters.bulkCreates = 0;
  counters.perRowWrites = 0;
  counters.transactions = 0;
  counters.setConfig = 0;
  counters.rowsBulkInserted = 0;
  inMemoryReminders.length = 0;
  fixture.complianceChecks = [];
  _clearAdminCache();
});

describe('scanForTenant — batched DB calls', () => {
  it('produces 150 candidates from 50 visas using ≤15 total DB calls (was 150+)', async () => {
    const result = await scanForTenant(TENANT);

    // 50 visas × 3 EXPIRY offsets = 150 attempted reminders, all in the future.
    expect(result.attempted).toBe(150);
    expect(result.inserted).toBe(150);
    expect(counters.rowsBulkInserted).toBe(150);

    // Hard budget: scanner must NOT regress to per-row writes.
    expect(counters.perRowWrites).toBe(0);

    // The new contract — one bulk insert per non-empty entity-type group.
    // Only studentVisa returned data here, so exactly ONE createMany call.
    expect(counters.bulkCreates).toBe(1);

    // One $transaction per non-empty group, set_config called inside it.
    expect(counters.transactions).toBe(1);
    expect(counters.setConfig).toBe(1);

    // Total DB calls budget: 8 entity-type reads + 1 admin lookup + 1
    // bulk-insert transaction (which itself bundles set_config + createMany
    // in one round trip from the caller's view). The legacy implementation
    // ran 150+ on this fixture; cap at 15 to leave headroom for one extra
    // read if a future entity-type is added without trashing the perf win.
    const totalCalls = counters.reads + counters.bulkCreates + counters.perRowWrites;
    expect(totalCalls).toBeLessThanOrEqual(15);
    // Hard regression guard: scanner must beat the old per-row regime by an
    // order of magnitude on this fixture.
    expect(totalCalls).toBeLessThan(150);
  });

  it('is idempotent on re-run (skipDuplicates → ON CONFLICT DO NOTHING)', async () => {
    await scanForTenant(TENANT);
    const firstCount = inMemoryReminders.length;
    expect(firstCount).toBe(150);

    // Reset per-call counters but KEEP inMemoryReminders so the dedup mirror
    // still rejects duplicates on the second pass.
    counters.bulkCreates = 0;
    counters.rowsBulkInserted = 0;

    const second = await scanForTenant(TENANT);

    // Second pass still attempts 150 rows but inserts zero (all dupes).
    expect(second.attempted).toBe(150);
    expect(second.inserted).toBe(0);
    expect(counters.rowsBulkInserted).toBe(0);
    expect(inMemoryReminders.length).toBe(firstCount); // unchanged
    // Critically: still ZERO per-row writes — the batched path handled it.
    expect(counters.perRowWrites).toBe(0);
  });

  it('sets app.tenant_id INSIDE the same transaction as createMany (RLS GUC contract)', async () => {
    await scanForTenant(TENANT);
    // For each $transaction that contains a createMany, set_config ran first.
    // We can't easily assert order across mocks, but counts must match.
    expect(counters.setConfig).toBe(counters.transactions);
    expect(counters.bulkCreates).toBe(counters.transactions);
  });

  it('chases not-yet-completed compliance-check deadlines (COMPLIANCE_CHECK_DUE)', async () => {
    fixture.complianceChecks = [
      {
        id: 'cccccccc-cccc-7ccc-8ccc-000000000001',
        student_id: 'ssssssss-ssss-7sss-8sss-000000000001',
        check_type: 'POLICE_REGISTRATION',
        scheduled_at: FUTURE,
      },
    ];
    await scanForTenant(TENANT);
    const cc = inMemoryReminders.filter((r) => r['type'] === 'COMPLIANCE_CHECK_DUE');
    // 4 COMPLIANCE_OFFSETS_DAYS, all in the future (deadline +1y).
    expect(cc.length).toBe(4);
    expect(cc.every((r) => r['source_entity_type'] === 'compliance_check')).toBe(true);
    expect(cc.every((r) => r['source_entity_id'] === fixture.complianceChecks[0]!.id)).toBe(true);
  });
});
