// SVT-SEC-HIBP-FAIL-CLOSED-2026-05 (P1-7) — verifies that the HIBP guard
// rejects passwords when the upstream API is unreachable AND we are running
// in production. Previously the helper failed-OPEN unconditionally (returning
// `true` on network error), which let a sustained HIBP outage be used by an
// attacker to slip a breached password through change-password / signup /
// admin-reset.
//
// Matrix tested:
//
//   NODE_ENV    | HIBP_FAIL_OPEN | HIBP_FAIL_CLOSED | unreachable → outcome
//   production  | (unset)        | (unset)          | THROW 503
//   production  | true           | (unset)          | OPEN (returns true)
//   development | (unset)        | (unset)          | OPEN (legacy)
//   development | (unset)        | true             | THROW 503
//
// The existing hibp.spec.ts pins NODE_ENV=development so its legacy fail-open
// expectation continues to hold under the new defaults.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_FETCH = global.fetch;

const STUB_ENV: Record<string, string> = {
  CORS_ORIGIN: 'http://localhost:3001',
  DATABASE_URL: 'postgresql://x:x@localhost:5432/x',
  DATABASE_MIGRATE_URL: 'postgresql://x:x@localhost:5432/x',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----',
  JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----',
  JWT_KID: 'test',
  SEED_ADMIN_EMAIL: 'admin@example.com',
  SEED_ADMIN_PASSWORD: 'ChangeMeNow!2026',
  // Production env validation insists on these — provide stubs so the
  // module loads cleanly under NODE_ENV=production in test mode.
  KMS_LOCAL_OK: 'true',
  KMS_KEK_BASE64: 'a'.repeat(48),
  REFRESH_TOKEN_PEPPER: '0'.repeat(64),
  CORRELATION_HMAC_KEY: '0'.repeat(64),
};

function stubBaseEnv(): void {
  for (const [k, v] of Object.entries(STUB_ENV)) {
    vi.stubEnv(k, v);
  }
  // The HIBP enforcement mode must NOT be 'off' (the off branch short-
  // circuits before any reachability check). The helper auto-selects 'off'
  // when NODE_ENV=test; we override here to exercise the real path.
  vi.stubEnv('HIBP_ENFORCEMENT', 'block');
}

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.unstubAllEnvs();
  delete process.env['HIBP_FAIL_OPEN'];
  delete process.env['HIBP_FAIL_CLOSED'];
  vi.resetModules();
});

beforeEach(() => {
  vi.resetModules();
});

describe('SVT-SEC-HIBP-FAIL-CLOSED-2026-05 (P1-7) — production fails closed on HIBP outage', () => {
  it('NODE_ENV=production + HIBP unreachable → throws 503 (fail-CLOSED)', async () => {
    stubBaseEnv();
    vi.stubEnv('NODE_ENV', 'production');
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as never;
    const { ensurePasswordNotPwned } = await import('../src/shared/hibp.js');
    await expect(
      ensurePasswordNotPwned('SomeCandidate-Password!42', { userId: 'u1', tenantId: 't1' }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('NODE_ENV=production + non-200 from HIBP → throws 503 (fail-CLOSED)', async () => {
    stubBaseEnv();
    vi.stubEnv('NODE_ENV', 'production');
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      text: async () => '',
    })) as never;
    const { ensurePasswordNotPwned } = await import('../src/shared/hibp.js');
    await expect(
      ensurePasswordNotPwned('SomeCandidate-Password!42', {}),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('NODE_ENV=production + HIBP_FAIL_OPEN=true allows the explicit opt-out', async () => {
    stubBaseEnv();
    vi.stubEnv('NODE_ENV', 'production');
    process.env['HIBP_FAIL_OPEN'] = 'true';
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as never;
    const { ensurePasswordNotPwned } = await import('../src/shared/hibp.js');
    await expect(
      ensurePasswordNotPwned('SomeCandidate-Password!42', {}),
    ).resolves.toBe(true);
  });

  it('NODE_ENV=development + HIBP unreachable → fails OPEN (legacy dev behaviour)', async () => {
    stubBaseEnv();
    vi.stubEnv('NODE_ENV', 'development');
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as never;
    const { ensurePasswordNotPwned } = await import('../src/shared/hibp.js');
    await expect(
      ensurePasswordNotPwned('SomeCandidate-Password!42', {}),
    ).resolves.toBe(true);
  });

  it('NODE_ENV=development + HIBP_FAIL_CLOSED=true forces fail-closed', async () => {
    stubBaseEnv();
    vi.stubEnv('NODE_ENV', 'development');
    process.env['HIBP_FAIL_CLOSED'] = 'true';
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as never;
    const { ensurePasswordNotPwned } = await import('../src/shared/hibp.js');
    await expect(
      ensurePasswordNotPwned('SomeCandidate-Password!42', {}),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('production fail-closed error string matches the FE-shaped sentinel', async () => {
    stubBaseEnv();
    vi.stubEnv('NODE_ENV', 'production');
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as never;
    const { ensurePasswordNotPwned } = await import('../src/shared/hibp.js');
    let caught: Error | null = null;
    try {
      await ensurePasswordNotPwned('SomeCandidate-Password!42', {});
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/try again/i);
    expect(caught!.message).toMatch(/unavailable/i);
  });
});
