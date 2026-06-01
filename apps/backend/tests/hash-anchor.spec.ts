// SVT-AUDIT-WORM-2026-05 — computeTenantRoots() job tests.
//
// Verifies per-tenant Merkle root computation, IS NULL branch isolation,
// empty-chain sentinel, and Promise.allSettled persistence resilience.
//
// SVT-PERF-AUDIT-ANCHOR-DELTA-2026-05 — Extends the suite to cover the
// incremental anchor algorithm: a second run with N new entries folds only
// the delta onto the prior root, the cumulative entries_count grows, and a
// run with zero new entries skips writing a redundant anchor row.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

type AuditRow = { tenant_id: string | null; entry_hash: string; created_at: Date; id: string };
type AnchorRow = {
  tenant_id: string | null;
  root_hash: string;
  entries_count: number;
  last_entry_id: string | null;
  last_entry_created_at: Date | null;
  anchored_at: Date;
};

const TENANT_A = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

const store = {
  tenants: [] as Array<{ id: string }>,
  auditLogs: [] as AuditRow[],
  anchors: [] as AnchorRow[],
  failOnTenant: null as string | null | undefined,
};

// findFirst — pick the most-recent anchor for the tenant (or IS NULL branch).
// Ties on anchored_at fall back to insertion order (later push wins) so the
// mock matches DB behaviour on sub-millisecond test runs where two anchors
// for the same tenant land on the same `new Date()`.
function findLatestAnchor(tenantId: string | null): AnchorRow | null {
  let latest: AnchorRow | null = null;
  for (const a of store.anchors) {
    if (a.tenant_id !== tenantId) continue;
    if (!latest || a.anchored_at.getTime() >= latest.anchored_at.getTime()) {
      latest = a;
    }
  }
  return latest;
}

// findMany audit filter — supports the tenant filter alone OR with the
// delta OR-tuple comparator the new hashAnchor uses.
function selectAuditDelta(args: {
  where: {
    tenant_id?: string | null;
    OR?: Array<{ created_at?: { gt: Date }; AND?: Array<{ created_at?: { equals: Date }; id?: { gt: string } }> }>;
  };
}): AuditRow[] {
  const tid = args.where.tenant_id;
  const tenantRows =
    tid === null
      ? store.auditLogs.filter((r) => r.tenant_id === null)
      : store.auditLogs.filter((r) => r.tenant_id === tid);
  if (!args.where.OR) return tenantRows.sort((a, b) => {
    const dt = a.created_at.getTime() - b.created_at.getTime();
    return dt !== 0 ? dt : a.id.localeCompare(b.id);
  });
  // Watermark: pick out (gt created_at) tuple.
  const orClause = args.where.OR;
  const gtAt = orClause[0]?.created_at?.gt;
  const eqAt = orClause[1]?.AND?.[0]?.created_at?.equals;
  const gtId = orClause[1]?.AND?.[1]?.id?.gt;
  return tenantRows
    .filter((r) => {
      if (gtAt && r.created_at.getTime() > gtAt.getTime()) return true;
      if (eqAt && gtId && r.created_at.getTime() === eqAt.getTime() && r.id > gtId) return true;
      return false;
    })
    .sort((a, b) => {
      const dt = a.created_at.getTime() - b.created_at.getTime();
      return dt !== 0 ? dt : a.id.localeCompare(b.id);
    });
}

vi.mock('../src/config/db.js', () => ({
  prisma: {
    tenant: {
      findMany: vi.fn(async () => store.tenants.map((t) => ({ id: t.id }))),
    },
    auditLog: {
      findMany: vi.fn(async (args: Parameters<typeof selectAuditDelta>[0]) => {
        const rows = selectAuditDelta(args);
        return rows.map((r) => ({ id: r.id, entry_hash: r.entry_hash, created_at: r.created_at }));
      }),
    },
    auditAnchor: {
      findFirst: vi.fn(
        async (args: { where: { tenant_id: string | null } }) => {
          const tid = args.where.tenant_id;
          const a = findLatestAnchor(tid === undefined ? null : tid);
          if (!a) return null;
          return {
            root_hash: a.root_hash,
            entries_count: a.entries_count,
            last_entry_id: a.last_entry_id,
            last_entry_created_at: a.last_entry_created_at,
          };
        },
      ),
      create: vi.fn(async (args: { data: AnchorRow }) => {
        if (store.failOnTenant !== undefined && args.data.tenant_id === store.failOnTenant) {
          throw new Error('simulated persist failure');
        }
        store.anchors.push(args.data);
        return args.data;
      }),
    },
  },
  disconnectDb: async () => undefined,
}));

vi.mock('../src/shared/hashing.js', () => ({
  // Deterministic fake: concat input wrapped so we can distinguish roots without real sha256.
  sha256Hex: vi.fn((input: string) => `h(${input})`),
}));

const { computeTenantRoots } = await import('../src/jobs/hashAnchor.js');

beforeEach(() => {
  store.tenants = [{ id: TENANT_A }, { id: TENANT_B }];
  store.auditLogs = [
    { id: '1', tenant_id: TENANT_A, entry_hash: 'A1', created_at: new Date(1) },
    { id: '2', tenant_id: TENANT_A, entry_hash: 'A2', created_at: new Date(2) },
    { id: '3', tenant_id: TENANT_B, entry_hash: 'B1', created_at: new Date(3) },
    { id: '4', tenant_id: null, entry_hash: 'N1', created_at: new Date(4) },
  ];
  store.anchors = [];
  store.failOnTenant = undefined;
});

describe('computeTenantRoots', () => {
  it('returns one entry per tenant + null with distinct root hashes', async () => {
    const out = await computeTenantRoots();
    expect(out).toHaveLength(3);
    const tids = out.map((r) => r.tenantId);
    expect(tids).toEqual([TENANT_A, TENANT_B, null]);
    const roots = out.map((r) => r.root);
    expect(new Set(roots).size).toBe(3); // distinct
    expect(out.find((r) => r.tenantId === TENANT_A)!.entries).toBe(2);
    expect(out.find((r) => r.tenantId === TENANT_B)!.entries).toBe(1);
    expect(out.find((r) => r.tenantId === null)!.entries).toBe(1);
  });

  it('persists one auditAnchor row per computed root', async () => {
    await computeTenantRoots();
    expect(store.anchors).toHaveLength(3);
    const persistedTids = store.anchors.map((a) => a.tenant_id).sort((a, b) => String(a).localeCompare(String(b)));
    expect(persistedTids).toEqual([TENANT_A, TENANT_B, null].sort((a, b) => String(a).localeCompare(String(b))));
    for (const a of store.anchors) {
      expect(typeof a.root_hash).toBe('string');
      expect(a.root_hash.length).toBeGreaterThan(0);
      expect(a.anchored_at).toBeInstanceOf(Date);
    }
  });

  it('empty chain persists the all-zero 64-char sentinel root_hash', async () => {
    store.tenants = [];
    store.auditLogs = []; // nothing for null branch either
    const out = await computeTenantRoots();
    expect(out).toHaveLength(1); // only null branch
    expect(out[0]!.tenantId).toBeNull();
    expect(out[0]!.entries).toBe(0);
    expect(out[0]!.root).toBe(''); // reduce seed when no rows
    expect(store.anchors).toHaveLength(1);
    expect(store.anchors[0]!.root_hash).toBe('0'.repeat(64));
    expect(store.anchors[0]!.entries_count).toBe(0);
  });

  it('null-tenant branch reads ONLY tenant_id IS NULL rows (SEC-burst regression)', async () => {
    const out = await computeTenantRoots();
    const nullEntry = out.find((r) => r.tenantId === null)!;
    // Only one null row (N1) — must NOT collapse all 4 rows into this chain.
    expect(nullEntry.entries).toBe(1);
    // Tenant A's root must differ from null root even though both are non-empty.
    const tenantA = out.find((r) => r.tenantId === TENANT_A)!;
    expect(tenantA.root).not.toBe(nullEntry.root);
    // Verify the underlying auditLog.findMany was invoked with explicit { tenant_id: null }
    const { prisma } = await import('../src/config/db.js');
    const calls = (prisma.auditLog.findMany as ReturnType<typeof vi.fn>).mock.calls;
    const nullCall = calls.find((c) => c[0].where.tenant_id === null);
    expect(nullCall).toBeDefined();
  });

  it('Promise.allSettled keeps other anchors when one tenant persist fails', async () => {
    store.failOnTenant = TENANT_A; // crash only tenant A's create
    const out = await computeTenantRoots();
    expect(out).toHaveLength(3); // computation still returns all three
    // Persistence: A failed, B + null succeeded.
    const persistedTids = store.anchors.map((a) => a.tenant_id);
    expect(persistedTids).not.toContain(TENANT_A);
    expect(persistedTids).toContain(TENANT_B);
    expect(persistedTids).toContain(null);
    expect(store.anchors).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // SVT-PERF-AUDIT-ANCHOR-DELTA-2026-05 — incremental algorithm tests
  // -------------------------------------------------------------------------

  it('second run with N new entries folds the delta and bumps entries_count', async () => {
    // First run: anchors current state.
    await computeTenantRoots();
    const firstRootA = store.anchors.find((a) => a.tenant_id === TENANT_A)!.root_hash;
    expect(store.anchors.find((a) => a.tenant_id === TENANT_A)!.entries_count).toBe(2);

    // Add 3 new audit rows for tenant A AFTER the watermark.
    store.auditLogs.push(
      { id: '5', tenant_id: TENANT_A, entry_hash: 'A3', created_at: new Date(10) },
      { id: '6', tenant_id: TENANT_A, entry_hash: 'A4', created_at: new Date(11) },
      { id: '7', tenant_id: TENANT_A, entry_hash: 'A5', created_at: new Date(12) },
    );

    // Spy on the audit.findMany call shape for tenant A: must include the
    // delta OR-tuple, NOT the full-tenant scan.
    const { prisma } = await import('../src/config/db.js');
    const findManyMock = prisma.auditLog.findMany as ReturnType<typeof vi.fn>;
    findManyMock.mockClear();

    await computeTenantRoots();

    const tenantACall = findManyMock.mock.calls.find((c) => c[0].where.tenant_id === TENANT_A);
    expect(tenantACall).toBeDefined();
    // Delta watermark present — proves we didn't re-read the whole chain.
    expect(tenantACall![0].where.OR).toBeDefined();

    // Same insertion-order tiebreak as the mock — last-pushed wins.
    const anchorsForA = store.anchors.filter((a) => a.tenant_id === TENANT_A);
    const secondAnchorA = anchorsForA[anchorsForA.length - 1]!;
    // Root advanced.
    expect(secondAnchorA.root_hash).not.toBe(firstRootA);
    // Cumulative count = 2 prior + 3 delta.
    expect(secondAnchorA.entries_count).toBe(5);
    // Watermark advanced to the latest delta row.
    expect(secondAnchorA.last_entry_id).toBe('7');
  });

  it('skips writing a new anchor when zero new entries since the last anchor', async () => {
    await computeTenantRoots();
    const initialCount = store.anchors.length;
    expect(initialCount).toBe(3);

    // No new audit rows — second pass should be a no-op for persistence.
    await computeTenantRoots();
    expect(store.anchors).toHaveLength(initialCount); // unchanged
  });

  it('produces a root identical to a from-scratch hash (delta folds onto prior root)', async () => {
    // Baseline: hash all four tenant-A entries from scratch in one call.
    store.auditLogs = [
      { id: '1', tenant_id: TENANT_A, entry_hash: 'A1', created_at: new Date(1) },
      { id: '2', tenant_id: TENANT_A, entry_hash: 'A2', created_at: new Date(2) },
      { id: '3', tenant_id: TENANT_A, entry_hash: 'A3', created_at: new Date(3) },
      { id: '4', tenant_id: TENANT_A, entry_hash: 'A4', created_at: new Date(4) },
    ];
    store.tenants = [{ id: TENANT_A }];
    await computeTenantRoots();
    const oneShotRoot = store.anchors.find((a) => a.tenant_id === TENANT_A)!.root_hash;

    // Reset and run incrementally: first two, then last two.
    store.anchors = [];
    store.auditLogs = [
      { id: '1', tenant_id: TENANT_A, entry_hash: 'A1', created_at: new Date(1) },
      { id: '2', tenant_id: TENANT_A, entry_hash: 'A2', created_at: new Date(2) },
    ];
    await computeTenantRoots();
    store.auditLogs.push(
      { id: '3', tenant_id: TENANT_A, entry_hash: 'A3', created_at: new Date(3) },
      { id: '4', tenant_id: TENANT_A, entry_hash: 'A4', created_at: new Date(4) },
    );
    await computeTenantRoots();
    const anchorsForA2 = store.anchors.filter((a) => a.tenant_id === TENANT_A);
    const incrementalRoot = anchorsForA2[anchorsForA2.length - 1]!.root_hash;
    expect(incrementalRoot).toBe(oneShotRoot);
  });
});
