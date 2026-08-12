// SVT-REL-2026-08 — the reminder bulk insert must stay inside Postgres' bind-
// parameter ceiling, and must never report a failed write as a quiet success.
//
// `createMany` is ONE multi-row INSERT no matter how many rows it is given.
// Postgres caps a statement at 32,767 bind parameters and ReminderCreateRow has
// 13 columns, so the hard ceiling is ~2,520 rows per call. The scanner sent
// every candidate for an entity type in a single unchunked statement, and the
// payment staircase alone emits 3 rows per source row — which put the EXISTING
// dataset at roughly 95% of the limit. It was going to break at about 1.1x
// current data.
//
// And it would have broken invisibly: the catch logged and returned 0, while a
// count of 0 is exactly what a healthy re-run produces when every row is
// already present (ON CONFLICT skips are not counted either). "Reminders have
// stopped" and "nothing new to do" were literally the same number, so the job
// would have gone on reporting success while students missed visa deadlines.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_ID = '11111111-1111-7111-8111-111111111111';

// Postgres' documented limit, and the row width the scanner actually writes.
const MAX_BIND_PARAMS = 32_767;
const COLUMNS_PER_ROW = 13;

const FUTURE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

/** Every createMany batch the scanner issued, in order. */
let batchSizes: number[] = [];
/** When set, a batch at this index (0-based) throws, simulating a write failure. */
let failAtBatch: number | null = null;
let visaCount = 0;

function makeVisas(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `vvvvvvvv-vvvv-7vvv-8vvv-${String(i).padStart(12, '0')}`,
    student_id: `ssssssss-ssss-7sss-8sss-${String(i).padStart(12, '0')}`,
    expires_on: FUTURE,
    destination_country: 'AU',
  }));
}

vi.mock('../src/config/db.js', () => {
  const emptyRead = vi.fn(async () => []);
  const createMany = vi.fn(async (args: { data: Array<Record<string, unknown>> }) => {
    const index = batchSizes.length;
    batchSizes.push(args.data.length);
    if (failAtBatch !== null && index === failAtBatch) {
      throw new Error('simulated write failure');
    }
    return { count: args.data.length };
  });
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    reminder: { createMany },
  };
  return {
    prisma: {
      user: { findFirst: vi.fn(async () => ({ id: ADMIN_ID })) },
      enrollment: { findMany: emptyRead },
      financeItem: { findMany: emptyRead },
      studentVisa: { findMany: vi.fn(async () => makeVisas(visaCount)) },
      studentIdentification: { findMany: emptyRead },
      insuranceRecord: { findMany: emptyRead },
      document: { findMany: emptyRead },
      commissionClaim: { findMany: emptyRead },
      complianceCheck: { findMany: emptyRead },
      reminder: { createMany },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    },
    disconnectDb: async () => undefined,
  };
});

const { scanForTenant, _clearAdminCache } = await import('../src/jobs/reminderScanner.js');

beforeEach(() => {
  batchSizes = [];
  failAtBatch = null;
  visaCount = 0;
  _clearAdminCache();
  vi.clearAllMocks();
});

describe('reminder bulk insert — stays inside the bind-parameter ceiling', () => {
  it('splits a large candidate set across several statements', async () => {
    visaCount = 400; // × 3 EXPIRY offsets = 1,200 candidate rows
    const result = await scanForTenant(TENANT);

    expect(result.attempted).toBe(1_200);
    expect(batchSizes.length).toBeGreaterThan(1);
    expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(1_200);
  });

  it('keeps every statement under the parameter ceiling with real headroom', async () => {
    visaCount = 400;
    await scanForTenant(TENANT);

    for (const size of batchSizes) {
      expect(size * COLUMNS_PER_ROW).toBeLessThan(MAX_BIND_PARAMS);
    }
    // The pre-fix single statement was 1,200 × 13 = 15,600 params — inside the
    // ceiling at THIS size, which is exactly why it went unnoticed. Assert real
    // margin so the batch cannot creep back toward the limit.
    const worst = Math.max(...batchSizes) * COLUMNS_PER_ROW;
    expect(worst).toBeLessThan(MAX_BIND_PARAMS / 4);
  });

  it('still issues a single statement when the set is small', async () => {
    visaCount = 10; // 30 rows
    await scanForTenant(TENANT);
    expect(batchSizes).toEqual([30]);
  });

  it('writes nothing at all when there are no candidates', async () => {
    visaCount = 0;
    const result = await scanForTenant(TENANT);
    expect(batchSizes).toEqual([]);
    expect(result.attempted).toBe(0);
    expect(result.failed).toBe(0);
  });
});

describe('reminder bulk insert — a failed write is reported, not swallowed', () => {
  it('counts the lost rows instead of reporting a clean run', async () => {
    visaCount = 400;
    failAtBatch = 1; // second chunk dies
    const result = await scanForTenant(TENANT);

    // Pre-fix this returned inserted: 0 with no failure signal anywhere, which
    // is indistinguishable from "everything was already present".
    expect(result.failed).toBeGreaterThan(0);
    expect(result.inserted).toBeGreaterThan(0);
    expect(result.inserted + result.failed).toBe(1_200);
  });

  it('keeps going after a failed chunk so one bad batch does not lose the rest', async () => {
    visaCount = 400;
    failAtBatch = 0; // first chunk dies
    const result = await scanForTenant(TENANT);

    expect(batchSizes.length).toBeGreaterThan(1);
    expect(result.inserted).toBeGreaterThan(0);
  });

  it('reports failed: 0 on a completely healthy run', async () => {
    visaCount = 400;
    const result = await scanForTenant(TENANT);
    expect(result.failed).toBe(0);
    expect(result.inserted).toBe(1_200);
  });
});
