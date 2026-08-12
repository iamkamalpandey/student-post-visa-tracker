// SVT-CRYPTO-2026-08 — a KEK rotation must never make data unreadable.
//
// Two defects, both of which destroyed data silently during the exact operation
// that v2 envelopes exist to make safe:
//
//   1. keyFor() short-circuited v1 envelopes (no recorded id) to the ACTIVE key
//      on the reasoning that they "were written with the only key that ever
//      existed". True until the first rotation. Afterwards every v1 blob was
//      written by a now-retired key, the active key failed the GCM tag, and
//      KMS_KEK_PREVIOUS was never consulted. rewrap-secrets could not rescue
//      them either, because it decrypts through this same path.
//
//   2. KMS_KEK_ID has a DEFAULT, so an operator can rotate KMS_KEK_BASE64
//      without ever setting it — stamping new key material with the id every
//      existing envelope already carries. decryptDek then matched on that id
//      and handed the NEW key to OLD ciphertext, never reaching the retired
//      key that would have worked.
//
// Both are unrecoverable and silent. These tests are the proof they stay fixed.

import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const { LocalKms } = await import('../src/config/kms.js');

describe('v1 envelopes survive a rotation', () => {
  it('unwraps a v1 DEK with a RETIRED key after the active key has changed', async () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);

    // Pre-rotation: the only key that existed wraps a DEK. A v1 envelope
    // records no id, which is modelled by passing undefined on unwrap.
    const before = new LocalKms(oldKek, 'kek-1');
    const { dek, encryptedDek } = await before.generateDek();

    // Post-rotation: new key active, old key retired into the registry.
    const after = new LocalKms(newKek, 'kek-2', new Map([['kek-1', oldKek]]));

    // The pre-fix code returned the ACTIVE key here and threw on the GCM tag.
    const recovered = await after.decryptDek(encryptedDek, undefined);
    expect(recovered.equals(dek)).toBe(true);
  });

  it('still unwraps a v1 DEK when the ACTIVE key is the one that wrote it', async () => {
    const kek = randomBytes(32);
    const kms = new LocalKms(kek, 'kek-1');
    const { dek, encryptedDek } = await kms.generateDek();
    expect((await kms.decryptDek(encryptedDek, undefined)).equals(dek)).toBe(true);
  });

  it('walks several retired keys to find the right one', async () => {
    const gen1 = randomBytes(32);
    const gen2 = randomBytes(32);
    const gen3 = randomBytes(32);
    const oldest = new LocalKms(gen1, 'kek-1');
    const { dek, encryptedDek } = await oldest.generateDek();

    const current = new LocalKms(
      gen3,
      'kek-3',
      new Map([
        ['kek-2', gen2],
        ['kek-1', gen1],
      ]),
    );
    expect((await current.decryptDek(encryptedDek, undefined)).equals(dek)).toBe(true);
  });

  it('reports honestly when NO loaded key can unwrap it', async () => {
    const written = new LocalKms(randomBytes(32), 'kek-1');
    const { encryptedDek } = await written.generateDek();
    const unrelated = new LocalKms(randomBytes(32), 'kek-2');
    await expect(unrelated.decryptDek(encryptedDek, undefined)).rejects.toThrow(
      /KMS_KEK_PREVIOUS/,
    );
  });
});

describe('v2 envelopes select by recorded id', () => {
  it('unwraps with the retired key the envelope names', async () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    const before = new LocalKms(oldKek, 'kek-1');
    const { dek, encryptedDek } = await before.generateDek();

    const after = new LocalKms(newKek, 'kek-2', new Map([['kek-1', oldKek]]));
    expect((await after.decryptDek(encryptedDek, 'kek-1')).equals(dek)).toBe(true);
  });

  it('refuses when the named key is not loaded, naming what to restore', async () => {
    const kms = new LocalKms(randomBytes(32), 'kek-2');
    const { encryptedDek } = await new LocalKms(randomBytes(32), 'kek-1').generateDek();
    await expect(kms.decryptDek(encryptedDek, 'kek-1')).rejects.toThrow(
      /wrapped with KEK "kek-1"/,
    );
  });
});

describe('the id-collision rotation mistake fails closed at construction', () => {
  it('refuses to boot when the active id also appears in the retired registry', () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    // The operator rotated KMS_KEK_BASE64 and moved the old pair into
    // KMS_KEK_PREVIOUS, but left KMS_KEK_ID at its default. Without this guard
    // the process starts and quietly destroys every existing ciphertext.
    expect(() => new LocalKms(newKek, 'local-kek-v1', new Map([['local-kek-v1', oldKek]])))
      .toThrow(/also appears in KMS_KEK_PREVIOUS/);
  });

  it('allows a correct rotation where the new id is genuinely new', () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    expect(() => new LocalKms(newKek, 'kek-2', new Map([['kek-1', oldKek]]))).not.toThrow();
  });
});
