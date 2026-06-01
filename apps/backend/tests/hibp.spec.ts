// SVT-SEC-2026-05 — HIBP k-anonymity helper tests.
//
// Mocks global fetch so we don't hit api.pwnedpasswords.com from CI.
// Verifies:
//   - sha1 prefix routing
//   - suffix detection against k-anonymity-style response body
//   - fail-open on network error / non-200 / timeout
//   - ensurePasswordNotPwned: warn vs block vs off enforcement
//   - HIBP_FAIL_CLOSED escalation

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'development'); // bypass test-shortcircuit
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

// SHA1 of "password" = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
// prefix = 5BAA6, suffix = 1E4C9B93F3F0682250B6CF8331B7EE68FD8

const PWNED_BODY = [
  '0018A45C4D1DEF81644B54AB7F969B88D65:1',
  // The actual suffix for "password" (count 9659365 per HIBP at last check).
  '1E4C9B93F3F0682250B6CF8331B7EE68FD8:9659365',
  'ABCDEF0123456789:42',
].join('\r\n');

const CLEAN_BODY = [
  '0018A45C4D1DEF81644B54AB7F969B88D65:1',
  'ABCDEF0123456789:42',
].join('\r\n');

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env['HIBP_ENFORCEMENT'];
  delete process.env['HIBP_FAIL_CLOSED'];
  vi.resetModules();
});

beforeEach(() => {
  vi.resetModules();
});

async function loadModule() {
  return await import('../src/shared/hibp.js');
}

describe('hibp.checkPwnedPassword', () => {
  it('returns pwned=true with count when the suffix is in the response', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => PWNED_BODY,
    })) as never;
    const { checkPwnedPassword } = await loadModule();
    const r = await checkPwnedPassword('password');
    expect(r.pwned).toBe(true);
    expect(r.count).toBe(9659365);
    expect(r.unreachable).toBe(false);
  });

  it('returns pwned=false when suffix is absent', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => CLEAN_BODY,
    })) as never;
    const { checkPwnedPassword } = await loadModule();
    const r = await checkPwnedPassword('password');
    expect(r.pwned).toBe(false);
    expect(r.count).toBe(0);
    expect(r.unreachable).toBe(false);
  });

  it('returns unreachable=true on non-200 response (fail-open)', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })) as never;
    const { checkPwnedPassword } = await loadModule();
    const r = await checkPwnedPassword('password');
    expect(r.pwned).toBe(false);
    expect(r.unreachable).toBe(true);
  });

  it('returns unreachable=true on fetch throw (fail-open)', async () => {
    global.fetch = vi.fn(async () => { throw new Error('boom'); }) as never;
    const { checkPwnedPassword } = await loadModule();
    const r = await checkPwnedPassword('password');
    expect(r.pwned).toBe(false);
    expect(r.unreachable).toBe(true);
  });

  it('only sends the first 5 hex chars of the SHA-1 (privacy)', async () => {
    const seenUrls: string[] = [];
    global.fetch = vi.fn(async (url: string) => {
      seenUrls.push(url);
      return { ok: true, status: 200, text: async () => CLEAN_BODY };
    }) as never;
    const { checkPwnedPassword } = await loadModule();
    await checkPwnedPassword('password');
    expect(seenUrls).toHaveLength(1);
    const sentPrefix = seenUrls[0]!.replace(/^.*\/range\//, '');
    expect(sentPrefix).toMatch(/^[0-9A-F]{5}$/);
    expect(sentPrefix.length).toBe(5);
    // Full SHA-1 of "password" must NOT appear.
    expect(seenUrls[0]!).not.toContain('1E4C9B93F3F0682250B6CF8331B7EE68FD8');
  });
});

describe('hibp.ensurePasswordNotPwned', () => {
  it('mode=off skips the check entirely', async () => {
    process.env['HIBP_ENFORCEMENT'] = 'off';
    const callCounter = vi.fn(async () => ({ ok: true, status: 200, text: async () => PWNED_BODY }));
    global.fetch = callCounter as never;
    const { ensurePasswordNotPwned } = await loadModule();
    const result = await ensurePasswordNotPwned('password', {});
    expect(result).toBe(true);
    expect(callCounter).not.toHaveBeenCalled();
  });

  it('mode=warn returns false on a pwned password (does not throw)', async () => {
    process.env['HIBP_ENFORCEMENT'] = 'warn';
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => PWNED_BODY })) as never;
    const { ensurePasswordNotPwned } = await loadModule();
    const result = await ensurePasswordNotPwned('password', { userId: 'u1', tenantId: 't1' });
    expect(result).toBe(false);
  });

  it('mode=block throws a shaped 422 on a pwned password', async () => {
    process.env['HIBP_ENFORCEMENT'] = 'block';
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => PWNED_BODY })) as never;
    const { ensurePasswordNotPwned } = await loadModule();
    await expect(ensurePasswordNotPwned('password', {})).rejects.toMatchObject({
      status: 422,
      title: 'Password is compromised',
    });
  });

  it('mode=warn allows safe passwords', async () => {
    process.env['HIBP_ENFORCEMENT'] = 'warn';
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => CLEAN_BODY })) as never;
    const { ensurePasswordNotPwned } = await loadModule();
    const result = await ensurePasswordNotPwned('password', {});
    expect(result).toBe(true);
  });

  it('fail-OPEN on unreachable HIBP by default', async () => {
    process.env['HIBP_ENFORCEMENT'] = 'block';
    global.fetch = vi.fn(async () => { throw new Error('network down'); }) as never;
    const { ensurePasswordNotPwned } = await loadModule();
    const result = await ensurePasswordNotPwned('password', {});
    expect(result).toBe(true);
  });

  it('fail-CLOSED throws 503 when HIBP_FAIL_CLOSED=true', async () => {
    process.env['HIBP_ENFORCEMENT'] = 'block';
    process.env['HIBP_FAIL_CLOSED'] = 'true';
    global.fetch = vi.fn(async () => { throw new Error('network down'); }) as never;
    const { ensurePasswordNotPwned } = await loadModule();
    await expect(ensurePasswordNotPwned('password', {})).rejects.toMatchObject({ status: 503 });
  });
});
