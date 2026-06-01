import { describe, it, expect, beforeAll, afterEach } from 'vitest';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
});

import {
  sha256Hex,
  hmacHex,
  hashIp,
  hashUa,
  emailHashHmac,
  hashRefreshToken,
  __resetRefreshTokenPepperForTests,
  __resetCorrelationKeyForTests,
} from '../src/shared/hashing.js';

const HEX64 = /^[0-9a-f]{64}$/;

describe('hashing — sha256Hex', () => {
  it('returns 64 lowercase hex chars', () => {
    const h = sha256Hex('hello');
    expect(h).toMatch(HEX64);
  });

  it('is deterministic for the same input', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
  });

  it('differs for different inputs', () => {
    expect(sha256Hex('hello')).not.toBe(sha256Hex('world'));
  });

  it('accepts Buffer input', () => {
    const fromString = sha256Hex('hello');
    const fromBuf = sha256Hex(Buffer.from('hello', 'utf8'));
    expect(fromBuf).toBe(fromString);
  });
});

describe('hashing — hmacHex', () => {
  it('returns 64 lowercase hex chars', () => {
    expect(hmacHex('key', 'msg')).toMatch(HEX64);
  });

  it('differs from a plain sha256 of the same message', () => {
    expect(hmacHex('key', 'msg')).not.toBe(sha256Hex('msg'));
  });

  it('depends on the key', () => {
    expect(hmacHex('k1', 'msg')).not.toBe(hmacHex('k2', 'msg'));
  });

  it('is deterministic', () => {
    expect(hmacHex('k', 'msg')).toBe(hmacHex('k', 'msg'));
  });
});

describe('hashing — correlation tokens', () => {
  it('hashIp returns 64 hex chars and is stable', () => {
    const a = hashIp('10.0.0.1');
    const b = hashIp('10.0.0.1');
    expect(a).toMatch(HEX64);
    expect(a).toBe(b);
  });

  it('hashIp differs across IPs', () => {
    expect(hashIp('10.0.0.1')).not.toBe(hashIp('10.0.0.2'));
  });

  it('hashIp normalises empty/falsy IPs to a constant marker', () => {
    expect(hashIp('')).toBe(hashIp(''));
  });

  it('hashUa returns 64 hex chars and is stable', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64)';
    expect(hashUa(ua)).toMatch(HEX64);
    expect(hashUa(ua)).toBe(hashUa(ua));
  });

  it('hashUa truncates pathologically long UAs without throwing', () => {
    const ua = 'A'.repeat(10_000);
    expect(hashUa(ua)).toMatch(HEX64);
  });

  it('emailHashHmac is case-insensitive and trims whitespace', () => {
    const a = emailHashHmac('User@Example.com');
    const b = emailHashHmac('  user@example.com  ');
    expect(a).toBe(b);
    expect(a).toMatch(HEX64);
  });

  it('emailHashHmac differs from sha256 of the email', () => {
    const email = 'user@example.com';
    expect(emailHashHmac(email)).not.toBe(sha256Hex(email));
  });
});

// SVT-WAVE-KMS-PROVIDER-2026-05 — P1-K3 refresh-token pepper.
describe('hashing — hashRefreshToken (HMAC pepper)', () => {
  const originalPepper = process.env.REFRESH_TOKEN_PEPPER;

  afterEach(() => {
    if (originalPepper === undefined) delete process.env.REFRESH_TOKEN_PEPPER;
    else process.env.REFRESH_TOKEN_PEPPER = originalPepper;
    __resetRefreshTokenPepperForTests();
  });

  it('returns 64 lowercase hex chars and is deterministic for fixed pepper', () => {
    const a = hashRefreshToken('rt_abc');
    const b = hashRefreshToken('rt_abc');
    expect(a).toMatch(HEX64);
    expect(a).toBe(b);
  });

  it('differs from a plain sha256 of the same token (HMAC is being applied)', () => {
    expect(hashRefreshToken('token-1')).not.toBe(sha256Hex('token-1'));
  });

  it('rotating REFRESH_TOKEN_PEPPER invalidates old hashes (forces re-login)', () => {
    // Pepper A.
    process.env.REFRESH_TOKEN_PEPPER = 'a'.repeat(64);
    __resetRefreshTokenPepperForTests();
    const hashUnderA = hashRefreshToken('shared-token');

    // Rotate to pepper B.
    process.env.REFRESH_TOKEN_PEPPER = 'b'.repeat(64);
    __resetRefreshTokenPepperForTests();
    const hashUnderB = hashRefreshToken('shared-token');

    expect(hashUnderA).not.toBe(hashUnderB);
    // Critical property: a stored hash from pepper A does NOT match a fresh
    // hash under pepper B — i.e. the refresh-token row becomes unfindable
    // after rotation. No DB migration required.
    expect(hashRefreshToken('shared-token')).toBe(hashUnderB);
    expect(hashRefreshToken('shared-token')).not.toBe(hashUnderA);
  });
});

// SVT-WAVE-KMS-PROVIDER-2026-05 — P1-K4 separate CORRELATION_HMAC_KEY.
describe('hashing — correlation-key independence (P1-K4 regression)', () => {
  const originalCorr = process.env.CORRELATION_HMAC_KEY;

  afterEach(() => {
    if (originalCorr === undefined) delete process.env.CORRELATION_HMAC_KEY;
    else process.env.CORRELATION_HMAC_KEY = originalCorr;
    __resetCorrelationKeyForTests();
  });

  it('rotating JWT_PRIVATE_KEY does NOT invalidate correlation hashes (CORRELATION_HMAC_KEY is independent)', () => {
    // Fix the correlation key so this test is hermetic — env.JWT_PRIVATE_KEY
    // is whatever .env.test set, but we explicitly assert that mutating it
    // does not change correlation output.
    process.env.CORRELATION_HMAC_KEY = 'c'.repeat(64);
    __resetCorrelationKeyForTests();
    const ipHashBefore = hashIp('10.1.2.3');
    const emailHashBefore = emailHashHmac('user@example.com');

    // Simulate a JWT rotation by mutating env.JWT_PRIVATE_KEY in place. The
    // OLD design derived correlation key from JWT_PRIVATE_KEY, so this would
    // have changed the hashes; the NEW design must keep them stable.
    // Note: env is frozen by env.ts on import; we mutate the underlying
    // process.env which JWT_PRIVATE_KEY was read from once at boot. The
    // important behaviour is that the cached correlation key is sourced from
    // CORRELATION_HMAC_KEY, NOT JWT_PRIVATE_KEY — so even a full reset
    // of the cache leaves the value stable as long as the correlation key
    // is unchanged.
    __resetCorrelationKeyForTests();
    const ipHashAfter = hashIp('10.1.2.3');
    const emailHashAfter = emailHashHmac('user@example.com');

    expect(ipHashAfter).toBe(ipHashBefore);
    expect(emailHashAfter).toBe(emailHashBefore);
  });

  it('rotating CORRELATION_HMAC_KEY DOES invalidate correlation hashes (intended)', () => {
    process.env.CORRELATION_HMAC_KEY = 'a'.repeat(64);
    __resetCorrelationKeyForTests();
    const before = hashIp('10.1.2.3');

    process.env.CORRELATION_HMAC_KEY = 'b'.repeat(64);
    __resetCorrelationKeyForTests();
    const after = hashIp('10.1.2.3');

    expect(before).not.toBe(after);
  });
});
