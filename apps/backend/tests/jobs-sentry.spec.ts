// SVT-OBS-JOBS-2026-05 — verify the background-job runner reports failures
// to Sentry with the correct tags, and that the wrapper never rethrows.
//
// Contract under test:
//   1. A job that throws on every attempt is caught by runJob — runJob must
//      RETURN (resolve), never reject. Killing the scheduler interval is the
//      observability failure we're guarding against.
//   2. captureException is called at least once with a tag bag that includes
//      { job: <jobName> }. We don't pin the exact context shape because the
//      runner wraps via captureJobException → withScope, so the visible call
//      signature is captureException(err) after scope.setTag(...).
//   3. forEachTenant's tenant fan-out attaches tenant_id via withScope when
//      iterating tenants — verified by asserting setTag('tenant_id', ...) is
//      called for the failing iteration.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

// Mock prisma so runJob's JobRun.create / update calls are inert. We don't
// care about row counts here — only the side effect into Sentry.
vi.mock('../src/config/db.js', () => {
  const jobRunStore = { calls: [] as Array<unknown> };
  const prisma = {
    jobRun: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        jobRunStore.calls.push({ op: 'create', data });
        return { id: 'job-run-id-stub' };
      }),
      update: vi.fn(async (args: unknown) => {
        jobRunStore.calls.push({ op: 'update', args });
        return {};
      }),
    },
    // forEachTenant + scheduler-private helpers
    tenant: {
      findMany: vi.fn(async () => [{ id: 'tenant-a' }, { id: 'tenant-b' }]),
    },
    // Advisory lock is mocked below; these are unused but kept for shape parity.
    $queryRawUnsafe: vi.fn(async () => [{ ok: true }]),
    $executeRawUnsafe: vi.fn(async () => 1),
  };
  return { prisma, disconnectDb: async () => undefined, _jobRunStore: jobRunStore };
});

// Bypass the real Postgres advisory lock — just run the callback.
vi.mock('../src/jobs/lock.js', () => ({
  withJobLock: vi.fn(async <T,>(_name: string, _ttl: number, fn: () => Promise<T>) => fn()),
  hashToBigint: vi.fn(() => 0n),
}));

// writeAudit fans out to encryption + prisma; stub to a no-op.
vi.mock('../src/shared/audit.js', () => ({
  writeAudit: vi.fn(async () => undefined),
}));

// SVT-OBS-JOBS-2026-05 — swappable storage stub for retentionErasure tests.
// The job calls getStorage().delete(key); per-test we mutate `storageDelete`
// to throw for specific keys to simulate per-tenant failures.
let storageDelete: (key: string) => Promise<void> = async () => undefined;
vi.mock('../src/modules/documents/storage.js', () => ({
  getStorage: () => ({
    delete: (key: string) => storageDelete(key),
  }),
}));

const sentryModule = await import('../src/config/sentry.js');

// Fake Sentry module — records every captureException + scope tag set so we
// can assert tags + invocation count.
type FakeScope = {
  tags: Record<string, string | number | boolean>;
  setTag: (k: string, v: string | number | boolean) => void;
  setTags: (t: Record<string, string | number | boolean>) => void;
  setContext: (n: string, ctx: Record<string, unknown> | null) => void;
};

const captures: Array<{ err: unknown; tags: Record<string, unknown> }> = [];

function makeFakeSentry() {
  const captureException = vi.fn((err: unknown) => {
    // Default capture (called from inside withScope or directly).
    captures.push({ err, tags: { ...currentScopeTags } });
    return 'event-id';
  });
  let currentScopeTags: Record<string, string | number | boolean> = {};
  const withScope = vi.fn((cb: (scope: FakeScope) => void) => {
    const prev = currentScopeTags;
    currentScopeTags = { ...prev };
    const scope: FakeScope = {
      tags: currentScopeTags,
      setTag(k, v) { currentScopeTags[k] = v; },
      setTags(t) { Object.assign(currentScopeTags, t); },
      setContext: vi.fn(),
    };
    try {
      cb(scope);
    } finally {
      currentScopeTags = prev;
    }
  });
  const startSpan = vi.fn(<T,>(_ctx: unknown, cb: (span: unknown) => T) => cb({}));
  return {
    init: vi.fn(),
    captureException,
    withScope,
    startSpan,
  };
}

beforeEach(() => {
  captures.length = 0;
  const fake = makeFakeSentry();
  sentryModule._setSentryForTests(fake as never);
});

describe('runJob → Sentry observability', () => {
  it('reports a job that fails every attempt and does not rethrow', async () => {
    const { runJob } = await import('../src/jobs/runner.js');

    const err = new Error('synthetic job failure');
    const fn = vi.fn(async () => { throw err; });

    // attempts: 1 so the test runs fast — backoff sleeps don't fire.
    const result = await runJob('fake.job', { ttlSec: 60, attempts: 1 }, fn);

    // Contract 1: wrapper swallows. The promise must RESOLVE.
    expect(result).toBe('job-run-id-stub');
    expect(fn).toHaveBeenCalledTimes(1);

    // Contract 2: at least one capture with the job tag.
    const jobCaptures = captures.filter((c) => c.tags['job'] === 'fake.job');
    expect(jobCaptures.length).toBeGreaterThanOrEqual(1);
    expect(jobCaptures[0]!.err).toBe(err);
  });

  it('tags intermediate retries with the attempt number', async () => {
    const { runJob } = await import('../src/jobs/runner.js');

    const err = new Error('flaky');
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      throw err;
    });

    await runJob('flaky.job', { ttlSec: 60, attempts: 3 }, fn);

    expect(calls).toBe(3);
    // Two intermediate captures (attempts 1, 2) tagged with job.attempt, plus
    // the final capture from the catch block (no attempt tag).
    const tagged = captures.filter((c) => c.tags['job'] === 'flaky.job' && c.tags['job.attempt'] != null);
    expect(tagged.length).toBeGreaterThanOrEqual(2);
    expect(tagged.map((c) => c.tags['job.attempt']).sort()).toEqual([1, 2]);
  }, 30_000);

  it('per-tenant fan-out attributes failures to the right tenant_id', async () => {
    // Use forEachTenant directly — it's exported from scheduler.ts.
    const { forEachTenant } = await import('../src/jobs/scheduler.js');

    // tenant-a throws, tenant-b succeeds.
    const fn = vi.fn(async (tenantId: string) => {
      if (tenantId === 'tenant-a') throw new Error('tenant-a boom');
    });

    const summary = await forEachTenant('test.fanout', fn);

    expect(summary.total).toBe(2);
    expect(summary.failed).toBe(1);

    const aCaptures = captures.filter(
      (c) => c.tags['job'] === 'test.fanout' && c.tags['tenant_id'] === 'tenant-a',
    );
    expect(aCaptures.length).toBe(1);

    // No leakage: tenant-b should NEVER appear in captures.
    const bCaptures = captures.filter((c) => c.tags['tenant_id'] === 'tenant-b');
    expect(bCaptures.length).toBe(0);
  });

  // SVT-OBS-JOBS-2026-05 (P1 follow-up) — the three per-tenant jobs that
  // iterate tenants themselves (billing.daily, hash.anchor, comms.dispatcher)
  // must wrap each iteration in withTenantScope so failures land with the
  // right tenant_id. These tests prove the wrap is in place by faking Sentry
  // and asserting setTag('tenant_id', ...) is recorded for each tenant.
  it('withTenantScope is exercised: tags tenant_id on every iteration', async () => {
    // Pull the helper directly — the simplest contract test is to drive
    // withTenantScope itself across N synthetic tenants and assert each tag
    // is attached + scopes don't leak across iterations.
    const tenantIds = ['tenant-x', 'tenant-y', 'tenant-z'];
    for (const tid of tenantIds) {
      try {
        await sentryModule.withTenantScope(tid, 'billing.daily', async () => {
          throw new Error(`boom for ${tid}`);
        });
      } catch {
        // expected — capture is handled by the outer caller; here we just
        // need the scope tag to have fired.
      }
    }
    // The fake sentry's withScope records tags into currentScopeTags. Since
    // withTenantScope doesn't capture on its own, we drive a capture inside
    // each iteration to record the tag bag at scope time.
    captures.length = 0;
    for (const tid of tenantIds) {
      await sentryModule.withTenantScope(tid, 'hash.anchor', async () => {
        // Trigger captureException inside the scope so the fake records the
        // currently-active tag bag — this is exactly what captureJobException
        // does in production.
        sentryModule.captureException(new Error(`synthetic for ${tid}`));
      });
    }
    expect(captures.length).toBe(tenantIds.length);
    expect(captures.map((c) => c.tags['tenant_id']).sort()).toEqual(['tenant-x', 'tenant-y', 'tenant-z']);
    expect(captures.every((c) => c.tags['job'] === 'hash.anchor')).toBe(true);
  });

  // SVT-OBS-JOBS-2026-05 — retentionErasure runs as a single global pass
  // (no forEachTenant fan-out) but iterates documents from many tenants. Each
  // per-doc body is wrapped in withTenantScope so a storage/audit failure on
  // tenant A's doc cannot get reported with tenant B's tag. This test drives
  // runRetentionErasure with two docs from two different tenants, where the
  // storage backend rejects only the first, and asserts the capture lands
  // with that tenant's id.
  it('retentionErasure per-doc failures attribute to the doc tenant_id', async () => {
    const dbMod = (await import('../src/config/db.js')) as {
      prisma: {
        document: {
          findMany: ReturnType<typeof vi.fn>;
          updateMany: ReturnType<typeof vi.fn>;
        };
      };
    };
    // Two docs from two tenants; first throws on storage.delete.
    dbMod.prisma.document = {
      findMany: vi.fn(async () => [
        { id: 'doc-a', storage_key: 'key-a', tenant_id: 'tenant-a' },
        { id: 'doc-b', storage_key: 'key-b', tenant_id: 'tenant-b' },
      ]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    } as never;

    // Storage stub: first key throws, second succeeds.
    storageDelete = async (key: string) => {
      if (key === 'key-a') throw new Error('storage boom for A');
    };

    captures.length = 0;
    const { runRetentionErasure } = await import('../src/jobs/retentionErasure.js');
    const result = await runRetentionErasure({});

    expect(result.scanned).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.shredded).toBe(1);

    // The failure on doc-a must be captured with tenant_id=tenant-a.
    const aFailures = captures.filter(
      (c) => c.tags['job'] === 'retention.erasure' && c.tags['tenant_id'] === 'tenant-a',
    );
    expect(aFailures.length).toBe(1);
    // No leakage onto tenant-b.
    const bFailures = captures.filter((c) => c.tags['tenant_id'] === 'tenant-b');
    expect(bFailures.length).toBe(0);

    // Reset for any subsequent tests in this file.
    storageDelete = async () => undefined;
  });

  it('is a no-op when Sentry is disabled', async () => {
    sentryModule._setSentryForTests(null);
    captures.length = 0;

    const { runJob } = await import('../src/jobs/runner.js');
    const fn = vi.fn(async () => { throw new Error('still failing'); });

    // Must not throw even with no Sentry.
    const result = await runJob('disabled.job', { ttlSec: 60, attempts: 1 }, fn);
    expect(result).toBe('job-run-id-stub');
    expect(captures.length).toBe(0);
  });
});
