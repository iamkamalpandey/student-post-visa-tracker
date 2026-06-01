import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/shared/passwords.js';

describe('passwords', () => {
  const PLAIN = 'correct-horse-battery-staple-2026';

  it('hash output is not the plaintext', async () => {
    const hash = await hashPassword(PLAIN);
    expect(hash).toBeTypeOf('string');
    expect(hash).not.toBe(PLAIN);
    // Argon2id encoded prefix
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('verify returns true for the correct password', async () => {
    const hash = await hashPassword(PLAIN);
    await expect(verifyPassword(hash, PLAIN)).resolves.toBe(true);
  });

  it('verify returns false for the wrong password', async () => {
    const hash = await hashPassword(PLAIN);
    await expect(verifyPassword(hash, PLAIN + 'x')).resolves.toBe(false);
  });

  it('different invocations use different salts and produce different hashes', async () => {
    const a = await hashPassword(PLAIN);
    const b = await hashPassword(PLAIN);
    expect(a).not.toBe(b);
    // Both must still verify successfully.
    await expect(verifyPassword(a, PLAIN)).resolves.toBe(true);
    await expect(verifyPassword(b, PLAIN)).resolves.toBe(true);
  });

  it('verify returns false rather than throwing on a malformed hash', async () => {
    await expect(verifyPassword('not-a-real-hash', PLAIN)).resolves.toBe(false);
  });
});
