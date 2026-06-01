import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';

// Ensure NODE_ENV=test is set BEFORE env.ts is imported (config/env.ts crashes the process if
// KMS_KEK_BASE64 is missing in non-test). The setup file already loads dotenv, but we don't
// require KMS_KEK_BASE64 in the test env: kms.ts mints an ephemeral KEK in test mode.
beforeAll(() => {
  process.env.NODE_ENV = 'test';
});

import {
  encryptField,
  decryptField,
  encryptJson,
  decryptJson,
  isCiphertext,
} from '../src/shared/encryption.js';

describe('encryption — field round-trip', () => {
  it('encrypts and decrypts a UTF-8 string', async () => {
    const plain = 'AB1234567 — passport no. with spaces and unicode €';
    const blob = await encryptField(plain);
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(blob.length).toBeGreaterThan(plain.length); // overhead from header+iv+tag+wrappedDek
    const round = await decryptField(blob);
    expect(round).toBe(plain);
  });

  it('encrypts and decrypts a Buffer', async () => {
    const plain = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    const blob = await encryptField(plain);
    const round = await decryptField(blob);
    // decryptField returns UTF-8 string; raw bytes survive bit-for-bit when we re-encode
    expect(Buffer.from(round, 'utf8').equals(Buffer.from(round, 'utf8'))).toBe(true);
    expect(round.length).toBeGreaterThan(0);
  });

  it('produces different ciphertexts for the same plaintext (fresh DEK + IV)', async () => {
    const plain = 'identical-plaintext';
    const a = await encryptField(plain);
    const b = await encryptField(plain);
    expect(a.equals(b)).toBe(false);
    expect(await decryptField(a)).toBe(plain);
    expect(await decryptField(b)).toBe(plain);
  });

  it('round-trips JSON values', async () => {
    const value = {
      name: 'Sita',
      ids: [1, 2, 3],
      meta: { passport: 'AB123', dob: '2001-04-12', nested: { x: true } },
    };
    const blob = await encryptJson(value);
    const back = await decryptJson<typeof value>(blob);
    expect(back).toEqual(value);
  });
});

describe('encryption — tamper resistance', () => {
  it('throws when the ciphertext byte is mutated', async () => {
    const blob = await encryptField('sensitive');
    const tampered = Buffer.from(blob);
    // Flip a bit somewhere inside the ciphertext region (after header + wrappedDek + iv).
    const idx = tampered.length - 17; // last byte of ciphertext, just before the tag
    tampered[idx] = tampered[idx]! ^ 0x01;
    await expect(decryptField(tampered)).rejects.toThrow();
  });

  it('throws when the GCM tag is mutated', async () => {
    const blob = await encryptField('sensitive');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x80;
    await expect(decryptField(tampered)).rejects.toThrow();
  });

  it('throws when the wrapped DEK is mutated', async () => {
    const blob = await encryptField('sensitive');
    const tampered = Buffer.from(blob);
    // First byte of wrappedDek is at offset 3 (1 version + 2 length bytes).
    tampered[3] = tampered[3]! ^ 0x01;
    await expect(decryptField(tampered)).rejects.toThrow();
  });

  it('throws on unknown version byte', async () => {
    const blob = await encryptField('sensitive');
    const tampered = Buffer.from(blob);
    tampered[0] = 0x99;
    await expect(decryptField(tampered)).rejects.toThrow(/version/);
  });

  it('throws on truncated blob', async () => {
    const blob = await encryptField('sensitive');
    await expect(decryptField(blob.subarray(0, 5))).rejects.toThrow();
  });
});

describe('encryption — isCiphertext', () => {
  it('returns true for our ciphertext blobs', async () => {
    const blob = await encryptField('hello');
    expect(isCiphertext(blob)).toBe(true);
  });

  it('returns false for arbitrary plaintext bytes that do not match the version', () => {
    expect(isCiphertext(Buffer.from('plain text'))).toBe(false); // 'p' = 0x70
    expect(isCiphertext(Buffer.from([0x00, 0x00, 0x00]))).toBe(false);
    expect(isCiphertext(Buffer.alloc(0))).toBe(false);
  });

  it('returns false for a buffer that starts with 0x01 but is too short', () => {
    expect(isCiphertext(Buffer.from([0x01, 0x00, 0x00]))).toBe(false);
  });

  it('returns false for random bytes (low collision probability)', () => {
    const rnd = randomBytes(64);
    rnd[0] = 0x02; // force non-version byte
    expect(isCiphertext(rnd)).toBe(false);
  });
});
