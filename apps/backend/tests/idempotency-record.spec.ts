// Unit tests for shared/idempotency.ts withIdempotency().
//
// We back the IdempotencyRecord delegate with an in-memory Map keyed by row id.
// The (tenant_id, scope, key) UNIQUE constraint is simulated by an index Map so
// duplicate INSERTs raise a Prisma-style P2002 error and the production retry
// path is exercised.
//
// No Postgres, no Prisma client — just the structural PrismaLike that
// withIdempotency() consumes. This keeps the test fast and deterministic.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { withIdempotency, SCOPE_IMPORTS_APPLY, type PrismaLike } from '../src/shared/idempotency.js';

// ---- in-memory store ----
type Status = 'PENDING' | 'SUCCESS' | 'FAILED';
type Row = {
  id: string;
  tenant_id: string;
  scope: string;
  key: string;
  request_hash: string;
  status: Status;
  status_code: number | null;
  response: unknown;
  expires_at: Date;
  created_at: Date;
  completed_at: Date | null;
};

class P2002 extends Error {
  code = 'P2002';
  constructor(target: string) {
    super(`Unique constraint failed on ${target}`);
  }
}

type Row2 = Row & { user_id?: string | null };

const rows = new Map<string, Row2>();
const uniqueIndex = new Map<string, string>(); // (tenant|user|scope|key) → id

// SVT-WAVE-BILLING-SEC-P1-F5 — uniqueness boundary now includes user_id; NULL
// maps to a deterministic sentinel so webhook callers (no user) still collide
// on duplicate keys the way they used to under the old (tenant|scope|key)
// composite.
const NIL_USER = '00000000-0000-0000-0000-000000000000';
function uniq(t: string, s: string, k: string, u?: string | null): string {
  return `${t}|${u ?? NIL_USER}|${s}|${k}`;
}

function makeDb(): PrismaLike {
  return {
    idempotencyRecord: {
      // SVT-WAVE-BILLING-SEC-P1-F8 (C8) — CAS-takeover updateMany for the
      // stale-PENDING reclaim path. Matches the (id, status, created_at) tuple
      // optimistically; returns count=0 if another retrier got there first.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const id = where['id'] as string;
          const row = rows.get(id);
          if (!row) return { count: 0 };
          if (where['status'] !== undefined && row.status !== where['status']) {
            return { count: 0 };
          }
          if (
            where['created_at'] !== undefined &&
            row.created_at.getTime() !== (where['created_at'] as Date).getTime()
          ) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const u = uniq(
          data['tenant_id'] as string,
          data['scope'] as string,
          data['key'] as string,
          (data['user_id'] as string | null | undefined) ?? null,
        );
        if (uniqueIndex.has(u)) {
          throw new P2002('idempotency_records.tenant_user_scope_key_key');
        }
        const id = randomUUID();
        const row: Row2 = {
          id,
          tenant_id: data['tenant_id'] as string,
          user_id: (data['user_id'] as string | null | undefined) ?? null,
          scope: data['scope'] as string,
          key: data['key'] as string,
          request_hash: data['request_hash'] as string,
          status: (data['status'] as Status) ?? 'PENDING',
          status_code: null,
          response: null,
          expires_at: data['expires_at'] as Date,
          created_at: new Date(),
          completed_at: null,
        };
        rows.set(id, row);
        uniqueIndex.set(u, id);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const t = where['tenant_id'] as string | undefined;
        const s = where['scope'] as string | undefined;
        const k = where['key'] as string | undefined;
        const u = (where['user_id'] as string | null | undefined) ?? null;
        if (t && s && k) {
          const id = uniqueIndex.get(uniq(t, s, k, u));
          return id ? rows.get(id) ?? null : null;
        }
        for (const row of rows.values()) {
          if (
            (t === undefined || row.tenant_id === t) &&
            (s === undefined || row.scope === s) &&
            (k === undefined || row.key === k) &&
            (where['user_id'] === undefined || (row.user_id ?? null) === u)
          ) {
            return row;
          }
        }
        return null;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const id = where['id'] as string;
          const row = rows.get(id);
          if (!row) throw new Error('row not found');
          Object.assign(row, data);
          return row;
        },
      ),
    },
  };
}

const TENANT = '11111111-1111-7111-8111-111111111111';
const KEY = 'idem-key-abc';
const HASH = 'sha256:body-fingerprint';

beforeEach(() => {
  rows.clear();
  uniqueIndex.clear();
});

describe('withIdempotency()', () => {
  it('first call inserts PENDING then writes SUCCESS', async () => {
    const db = makeDb();
    const work = vi.fn(async () => ({ status: 200, body: { ok: true } }));

    const out = await withIdempotency(
      { db, tenantId: TENANT, scope: SCOPE_IMPORTS_APPLY, key: KEY, requestHash: HASH },
      work,
    );

    expect(work).toHaveBeenCalledTimes(1);
    expect(out.replayed).toBe(false);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });

    // Row should now be SUCCESS with the body cached.
    const stored = [...rows.values()][0]!;
    expect(stored.status).toBe('SUCCESS');
    expect(stored.status_code).toBe(200);
    expect(stored.response).toEqual({ ok: true });
    expect(stored.completed_at).toBeInstanceOf(Date);
  });

  it('second call with same key + same hash replays cached body without re-running work', async () => {
    const db = makeDb();
    const work1 = vi.fn(async () => ({ status: 201, body: { id: 'abc' } }));
    await withIdempotency(
      { db, tenantId: TENANT, scope: SCOPE_IMPORTS_APPLY, key: KEY, requestHash: HASH },
      work1,
    );

    const work2 = vi.fn(async () => ({ status: 999, body: { wrong: true } }));
    const out = await withIdempotency(
      { db, tenantId: TENANT, scope: SCOPE_IMPORTS_APPLY, key: KEY, requestHash: HASH },
      work2,
    );

    expect(work2).not.toHaveBeenCalled();
    expect(out.replayed).toBe(true);
    expect(out.status).toBe(201);
    expect(out.body).toEqual({ id: 'abc' });
  });

  it('same key + different hash throws Conflict (key reuse)', async () => {
    const db = makeDb();
    await withIdempotency(
      { db, tenantId: TENANT, scope: SCOPE_IMPORTS_APPLY, key: KEY, requestHash: HASH },
      async () => ({ status: 200, body: { ok: true } }),
    );

    await expect(
      withIdempotency(
        { db, tenantId: TENANT, scope: SCOPE_IMPORTS_APPLY, key: KEY, requestHash: 'different-hash' },
        async () => ({ status: 200, body: {} }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  // SVT-WAVE-BILLING-SEC-P1-F8 (C8) — recent-PENDING (< 60s) is a genuine
  // in-flight worker; retries must wait their turn rather than re-execute.
  it('P1-F8: recent-PENDING row (< 60s) → 409 conflict, work NOT re-run', async () => {
    const db = makeDb();
    const id = randomUUID();
    const fresh: Row2 = {
      id,
      tenant_id: TENANT,
      user_id: null,
      scope: SCOPE_IMPORTS_APPLY,
      key: KEY,
      request_hash: HASH,
      status: 'PENDING',
      status_code: null,
      response: null,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      created_at: new Date(Date.now() - 5 * 1000), // 5s old
      completed_at: null,
    };
    rows.set(id, fresh);
    uniqueIndex.set(uniq(TENANT, SCOPE_IMPORTS_APPLY, KEY), id);

    const work = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    await expect(
      withIdempotency(
        { db, tenantId: TENANT, scope: SCOPE_IMPORTS_APPLY, key: KEY, requestHash: HASH },
        work,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(work).not.toHaveBeenCalled();
    expect(rows.get(id)!.status).toBe('PENDING');
  });

  // SVT-WAVE-BILLING-SEC-P1-F8 (C8) — POST-AUDIT POLICY: stale-PENDING (> 5min)
  // is NO LONGER auto-revived. Money-movers can leave the downstream provider
  // in a partially-applied state if the worker crashed mid-flight, and there
  // is no reliable signal in the idempotency row alone that distinguishes
  // "definitely-didn't-apply" from "applied-but-failed-to-persist-success".
  // The retry path now surfaces 409 with an "investigate manually" detail and
  // the work thunk is NOT re-invoked. An operator must reconcile with the
  // provider and either delete the row (to permit a fresh run) or hand-write
  // SUCCESS/FAILED to match the downstream state.
  it('P1-F8: stale-PENDING row (> 5min) → 409 conflict, work NOT re-run, row left untouched', async () => {
    const db = makeDb();
    const id = randomUUID();
    const originalCreatedAt = new Date(Date.now() - 10 * 60 * 1000); // 10 min old
    const stale: Row2 = {
      id,
      tenant_id: TENANT,
      user_id: null,
      scope: SCOPE_IMPORTS_APPLY,
      key: KEY,
      request_hash: HASH,
      status: 'PENDING',
      status_code: null,
      response: null,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      created_at: originalCreatedAt,
      completed_at: null,
    };
    rows.set(id, stale);
    uniqueIndex.set(uniq(TENANT, SCOPE_IMPORTS_APPLY, KEY), id);

    const work = vi.fn(async () => ({ status: 200, body: { revived: true } }));
    await expect(
      withIdempotency(
        { db, tenantId: TENANT, scope: SCOPE_IMPORTS_APPLY, key: KEY, requestHash: HASH },
        work,
      ),
    ).rejects.toMatchObject({
      status: 409,
      detail: expect.stringMatching(/investigate/i),
    });
    // Work was NOT invoked — operator must reconcile by hand.
    expect(work).not.toHaveBeenCalled();
    // Row is untouched — created_at and status both preserved so the operator
    // sees the original timestamp during investigation.
    const after = rows.get(id)!;
    expect(after.status).toBe('PENDING');
    expect(after.created_at.getTime()).toBe(originalCreatedAt.getTime());
  });

  // SVT-WAVE-BILLING-SEC-P1-F5 — same Idempotency-Key from two different
  // users must produce two independent executions (no cross-user replay).
  it('P1-F5: same key + same scope + different users → two independent runs', async () => {
    const db = makeDb();
    const userA = 'aaaa1111-1111-7111-8111-111111111111';
    const userB = 'bbbb2222-2222-7222-8222-222222222222';
    const work = vi.fn(async () => ({ status: 200, body: { ok: true } }));

    await withIdempotency(
      { db, tenantId: TENANT, scope: SCOPE_IMPORTS_APPLY, key: KEY, requestHash: HASH, userId: userA },
      work,
    );
    await withIdempotency(
      { db, tenantId: TENANT, scope: SCOPE_IMPORTS_APPLY, key: KEY, requestHash: HASH, userId: userB },
      work,
    );

    // Both users got their own execution — work fired twice, two rows persisted.
    expect(work).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(2);
    const users = [...rows.values()].map((r) => r.user_id).sort();
    expect(users).toEqual([userA, userB].sort());
  });

  it('work that throws marks the row FAILED with status_code, then rethrows', async () => {
    const db = makeDb();
    const httpish = Object.assign(new Error('boom'), {
      status: 503,
      title: 'Service Unavailable',
      detail: 'storage offline',
    });
    const work = vi.fn(async () => {
      throw httpish;
    });

    await expect(
      withIdempotency(
        { db, tenantId: TENANT, scope: SCOPE_IMPORTS_APPLY, key: KEY, requestHash: HASH },
        work,
      ),
    ).rejects.toBe(httpish);

    const stored = [...rows.values()][0]!;
    expect(stored.status).toBe('FAILED');
    expect(stored.status_code).toBe(503);
    const body = stored.response as { title: string; detail: string; status: number };
    expect(body.title).toBe('Service Unavailable');
    expect(body.detail).toBe('storage offline');
    expect(body.status).toBe(503);
  });

  it('work without a status defaults the FAILED row to status_code 500', async () => {
    const db = makeDb();
    const work = vi.fn(async () => {
      throw new Error('plain old error');
    });

    await expect(
      withIdempotency(
        { db, tenantId: TENANT, scope: SCOPE_IMPORTS_APPLY, key: KEY, requestHash: HASH },
        work,
      ),
    ).rejects.toThrow(/plain old error/);

    const stored = [...rows.values()][0]!;
    expect(stored.status).toBe('FAILED');
    expect(stored.status_code).toBe(500);
  });

  // RLS proof — needs a real Postgres with policies, can't be mocked meaningfully here.
  it.todo('respects tenant_id scoping under Postgres RLS (covered by deep-test bash)');
});
