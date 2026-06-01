// SVT-WAVE-KMS-PROVIDER-2026-05 — P1-K3 refresh-token legacy → HMAC rehash.
//
// Covers two layers:
//
//   1. The `tokenHmac(raw, tenantId)` helper in shared/passwords.ts —
//      tenant-bound HMAC-SHA256 keyed on REFRESH_TOKEN_PEPPER. Asserts:
//        - hex shape (64 chars),
//        - depends on tenantId (cross-tenant collision impossible),
//        - depends on the pepper (rotation invalidates),
//        - differs from the legacy bare sha256 (so DB lookups can't be
//          accidentally compared against the legacy column).
//
//   2. The `hashRefreshTokenLegacy(raw)` shim — bare sha256(hex) — used
//      by the auth-service refresh path to accept a legacy-shaped token
//      ONCE, after which the normal rotation re-issues an HMAC-shaped
//      replacement. We assert the two helpers produce DIFFERENT outputs
//      for the same input (otherwise the fallback would be a no-op).

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
});

import { tokenHmac, hashRefreshTokenLegacy } from '../src/shared/passwords.js';

const HEX64 = /^[0-9a-f]{64}$/;

describe('tokenHmac(raw, tenantId) — P1-K3', () => {
  const originalPepper = process.env.REFRESH_TOKEN_PEPPER;

  afterEach(() => {
    if (originalPepper === undefined) delete process.env.REFRESH_TOKEN_PEPPER;
    else process.env.REFRESH_TOKEN_PEPPER = originalPepper;
  });

  it('returns 64 lowercase hex chars', () => {
    expect(tokenHmac('raw', 'tenant-1')).toMatch(HEX64);
  });

  it('is deterministic for fixed (pepper, tenantId, raw)', () => {
    process.env.REFRESH_TOKEN_PEPPER = 'a'.repeat(64);
    expect(tokenHmac('raw', 'tenant-1')).toBe(tokenHmac('raw', 'tenant-1'));
  });

  it('differs across tenants for the same raw token', () => {
    expect(tokenHmac('shared-raw', 'tenant-1')).not.toBe(
      tokenHmac('shared-raw', 'tenant-2'),
    );
  });

  it('differs across raw tokens for the same tenant', () => {
    expect(tokenHmac('raw-a', 'tenant-1')).not.toBe(
      tokenHmac('raw-b', 'tenant-1'),
    );
  });

  it('rotating REFRESH_TOKEN_PEPPER changes the output (rotation invalidates)', () => {
    process.env.REFRESH_TOKEN_PEPPER = 'a'.repeat(64);
    const underA = tokenHmac('raw', 'tenant-1');
    process.env.REFRESH_TOKEN_PEPPER = 'b'.repeat(64);
    const underB = tokenHmac('raw', 'tenant-1');
    expect(underA).not.toBe(underB);
  });

  it('output differs from a bare sha256(raw) — defeats rainbow-table search', () => {
    const bare = createHash('sha256').update('raw').digest('hex');
    expect(tokenHmac('raw', 'tenant-1')).not.toBe(bare);
  });
});

describe('hashRefreshTokenLegacy — P1-K3 cutover shim', () => {
  it('reproduces bare sha256(raw) — the old shape', () => {
    const bare = createHash('sha256').update('raw').digest('hex');
    expect(hashRefreshTokenLegacy('raw')).toBe(bare);
  });

  it('differs from tokenHmac output (otherwise the fallback would be a no-op)', () => {
    expect(hashRefreshTokenLegacy('raw')).not.toBe(tokenHmac('raw', 't1'));
  });
});
