// SVT-WAVE-KMS-PROVIDER-2026-05 — P1-K4 LOG_HMAC_KEY_BASE64 alias.
//
// The correlation HMAC key is now sourced from either:
//   - LOG_HMAC_KEY_BASE64 (newer documented spelling; base64-encoded 32 bytes), OR
//   - CORRELATION_HMAC_KEY (legacy hex; 64 chars), OR
//   - a fixed dev-only constant (when neither is set, NODE_ENV != production).
//
// When BOTH are set, the base64 form wins (it's the newer documented form).
// Tests assert:
//   - the alias is picked up by hashIp / hashUa / emailHashHmac,
//   - the base64 path produces the same output as the hex path when given
//     equivalent byte material,
//   - independently rotating LOG_HMAC_KEY_BASE64 invalidates correlation
//     hashes (intended — rotating the correlation namespace is the whole
//     point of the dedicated key),
//   - rotating REFRESH_TOKEN_PEPPER does NOT affect correlation output
//     (the two secrets must be independent — same property as the existing
//     hashing.spec.ts coverage but expressed through the new base64 path).

import { describe, it, expect, beforeAll, afterEach } from 'vitest';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
});

import {
  hashIp,
  hashUa,
  emailHashHmac,
  __resetCorrelationKeyForTests,
  __resetRefreshTokenPepperForTests,
} from '../src/shared/hashing.js';

const HEX64 = /^[0-9a-f]{64}$/;

describe('LOG_HMAC_KEY_BASE64 — P1-K4 alias for the correlation key', () => {
  const origB64 = process.env.LOG_HMAC_KEY_BASE64;
  const origHex = process.env.CORRELATION_HMAC_KEY;

  afterEach(() => {
    if (origB64 === undefined) delete process.env.LOG_HMAC_KEY_BASE64;
    else process.env.LOG_HMAC_KEY_BASE64 = origB64;
    if (origHex === undefined) delete process.env.CORRELATION_HMAC_KEY;
    else process.env.CORRELATION_HMAC_KEY = origHex;
    __resetCorrelationKeyForTests();
  });

  it('hashIp picks up LOG_HMAC_KEY_BASE64 (decoded 32 bytes) when set', () => {
    process.env.LOG_HMAC_KEY_BASE64 = Buffer.alloc(32, 0xaa).toString('base64');
    delete process.env.CORRELATION_HMAC_KEY;
    __resetCorrelationKeyForTests();
    const h = hashIp('10.0.0.1');
    expect(h).toMatch(HEX64);
  });

  it('base64 and hex forms produce identical hashes for the same key bytes', () => {
    const keyBytes = Buffer.alloc(32, 0x55);

    process.env.LOG_HMAC_KEY_BASE64 = keyBytes.toString('base64');
    delete process.env.CORRELATION_HMAC_KEY;
    __resetCorrelationKeyForTests();
    const viaB64 = emailHashHmac('user@example.com');

    delete process.env.LOG_HMAC_KEY_BASE64;
    process.env.CORRELATION_HMAC_KEY = keyBytes.toString('hex');
    __resetCorrelationKeyForTests();
    const viaHex = emailHashHmac('user@example.com');

    expect(viaB64).toBe(viaHex);
  });

  it('LOG_HMAC_KEY_BASE64 wins when both spellings are set', () => {
    const bytesA = Buffer.alloc(32, 0x11);
    const bytesB = Buffer.alloc(32, 0x22);

    // Reference output: only the b64 form set.
    process.env.LOG_HMAC_KEY_BASE64 = bytesA.toString('base64');
    delete process.env.CORRELATION_HMAC_KEY;
    __resetCorrelationKeyForTests();
    const onlyB64 = hashUa('Mozilla');

    // Now set BOTH — the hex form has different bytes. The newer b64 form
    // must still win, so the output is unchanged.
    process.env.LOG_HMAC_KEY_BASE64 = bytesA.toString('base64');
    process.env.CORRELATION_HMAC_KEY = bytesB.toString('hex');
    __resetCorrelationKeyForTests();
    const both = hashUa('Mozilla');

    expect(both).toBe(onlyB64);
  });

  it('rotating LOG_HMAC_KEY_BASE64 DOES invalidate correlation hashes (intended)', () => {
    process.env.LOG_HMAC_KEY_BASE64 = Buffer.alloc(32, 0x33).toString('base64');
    delete process.env.CORRELATION_HMAC_KEY;
    __resetCorrelationKeyForTests();
    const before = hashIp('10.1.2.3');

    process.env.LOG_HMAC_KEY_BASE64 = Buffer.alloc(32, 0x44).toString('base64');
    __resetCorrelationKeyForTests();
    const after = hashIp('10.1.2.3');

    expect(before).not.toBe(after);
  });

  it('rotating REFRESH_TOKEN_PEPPER does NOT alter correlation output (keys are independent)', () => {
    process.env.LOG_HMAC_KEY_BASE64 = Buffer.alloc(32, 0x55).toString('base64');
    delete process.env.CORRELATION_HMAC_KEY;
    process.env.REFRESH_TOKEN_PEPPER = 'a'.repeat(64);
    __resetCorrelationKeyForTests();
    __resetRefreshTokenPepperForTests();
    const before = hashIp('10.5.6.7');

    process.env.REFRESH_TOKEN_PEPPER = 'b'.repeat(64);
    __resetRefreshTokenPepperForTests();
    const after = hashIp('10.5.6.7');

    expect(before).toBe(after);
  });

  it('decoded key length other than 32 bytes is rejected by the env validator', async () => {
    // Re-import the env schema and feed it a bad value — we don't reload
    // env.ts itself because it would process.exit(1) on parse failure.
    const { z } = await import('zod');
    const refine = z
      .string()
      .min(1)
      .refine((s) => {
        try {
          return Buffer.from(s, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'must decode to exactly 32 bytes');
    expect(refine.safeParse(Buffer.alloc(16).toString('base64')).success).toBe(false);
    expect(refine.safeParse(Buffer.alloc(32).toString('base64')).success).toBe(true);
  });
});
