// PERF-AUDIT-P0-#3 — verify buffered-export size cap.
//
// Two paths to cover:
//   1. Estimated bytes under the cap → enqueueExport proceeds and persists a
//      QUEUED job row.
//   2. Estimated bytes over the cap → enqueueExport throws a 413 HttpError
//      with code='export_too_large' BEFORE any job row is written. This is
//      the load-bearing behaviour: the controller relies on the throw to
//      surface a synchronous error to the API caller instead of a 202 plus
//      an opaque FAILED job downstream.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExportJobRow = {
  id: string;
  tenant_id: string;
  resource: string;
  format: string;
  filter_json: unknown;
  columns_json: unknown;
  redact_pii: boolean;
  status: string;
  created_by_id: string;
};

const store = {
  studentCount: 0,
  jobs: [] as ExportJobRow[],
};

vi.mock('../src/config/db.js', () => {
  const prisma = {
    student: {
      count: vi.fn(async () => store.studentCount),
    },
    institution: { count: vi.fn(async () => 0) },
    program: { count: vi.fn(async () => 0) },
    enrollment: { count: vi.fn(async () => 0) },
    programFee: { count: vi.fn(async () => 0) },
    exportJob: {
      create: vi.fn(async ({ data }: { data: Omit<ExportJobRow, 'id'> }) => {
        const row: ExportJobRow = { id: `job-${store.jobs.length + 1}`, ...data };
        store.jobs.push(row);
        return row;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findUnique: vi.fn(async () => null),
    },
  };

  // SVT-SEC-2026-08 (T0-7) — these paths now scope their queries: cross-tenant
  // discovery reads use prismaAdmin, and everything with a known tenant runs
  // inside withTenantTx, which opens a transaction and sets the app.tenant_id
  // GUC first. Without the GUC the RLS policies match zero rows under the
  // production role, so the code silently did nothing.
  (prisma as Record<string, unknown>)['$transaction'] =
    vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  (prisma as Record<string, unknown>)['$executeRaw'] = vi.fn(async () => 1);

  return { prisma, prismaAdmin: prisma, disconnectDb: async () => undefined };
});

// Audit + storage stubs — enqueueExport calls writeAudit; runExport (kicked
// off via setImmediate) will short-circuit because findUnique returns null.
vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

const { enqueueExport, __PERF_AUDIT } = await import('../src/modules/exports/exports.service.js');
const { HttpError } = await import('../src/shared/errors.js');

const CTX = {
  tenantId: '11111111-1111-7111-8111-111111111111',
  userId: '22222222-2222-7222-8222-222222222222',
  role: 'ADMIN' as const,
  ip: null,
  ua: null,
  requestId: null,
};

function resetStore() {
  store.studentCount = 0;
  store.jobs.length = 0;
}

describe('export buffered-size cap (PERF-AUDIT-P0-#3)', () => {
  beforeEach(() => resetStore());
  afterEach(() => vi.clearAllMocks());

  it('estimates 100 MiB cap at the documented threshold', () => {
    // Sanity check the constant so a careless edit can't silently raise it.
    expect(__PERF_AUDIT.EXPORT_MAX_BYTES).toBe(100 * 1024 * 1024);
  });

  it('enqueues a job when the projection is under the cap', async () => {
    // 50k students × 320 bytes/row × csv-multiplier(1.0) ≈ 16 MiB — well under cap.
    store.studentCount = 50_000;
    const job = await enqueueExport(CTX, {
      resource: 'students',
      format: 'csv',
      filter: {},
      redact_pii: true,
      locale: 'en',
      timezone: 'UTC',
    });
    expect(job.status).toBe('QUEUED');
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]!.resource).toBe('students');
  });

  it('rejects with 413 + code=export_too_large when projection exceeds cap', async () => {
    // 1M students × 320 bytes/row × jsonl-multiplier(1.6) ≈ 488 MiB — way over.
    store.studentCount = 1_000_000;
    let captured: unknown = null;
    try {
      await enqueueExport(CTX, {
        resource: 'students',
        format: 'jsonl',
        filter: {},
        redact_pii: true,
        locale: 'en',
        timezone: 'UTC',
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(HttpError);
    const httpErr = captured as InstanceType<typeof HttpError>;
    expect(httpErr.status).toBe(413);
    expect(httpErr.code).toBe('export_too_large');
    // Defensive: the user-visible message must mention adding filters so the
    // FE can render a helpful prompt instead of an opaque "payload too large".
    expect(httpErr.detail).toMatch(/filter/i);
    // CRITICAL: no job row was created — the caller's retry semantics depend
    // on this. If we'd written a QUEUED row we'd leak FAILED rows for every
    // rejected attempt and the cancel endpoint would be the only escape.
    expect(store.jobs).toHaveLength(0);
  });

  it('rejection message names both the projected and cap sizes in MiB', async () => {
    store.studentCount = 1_000_000;
    let captured: unknown = null;
    try {
      await enqueueExport(CTX, {
        resource: 'students',
        format: 'jsonl',
        filter: {},
        redact_pii: true,
        locale: 'en',
        timezone: 'UTC',
      });
    } catch (err) {
      captured = err;
    }
    const httpErr = captured as InstanceType<typeof HttpError>;
    // ~488 MiB projected; 100 MiB cap. Both must appear so the user can size
    // their filter (i.e. "I need to cut to ~20% of rows").
    expect(httpErr.detail).toMatch(/MiB/);
    expect(httpErr.detail).toMatch(/100 MiB/);
    expect(httpErr.detail).toMatch(/1000000 rows/);
  });
});
