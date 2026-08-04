// SVT-CRYPTO-2026-08 — KEK rotation must not destroy data.
//
// The bug this pins: under KMS_PROVIDER=local the wrapped DEK is just
// [iv][ct][tag] with NO key identity recorded, and the v1 envelope stored none
// either. So rotating KMS_KEK_BASE64 made every existing ciphertext
// permanently undecryptable — total, silent, unrecoverable PII loss caused by
// a routine security operation, surfacing only when someone happened to read a
// row. There was no way to even tell which key a blob needed.
//
// v2 envelopes stamp the active KEK id, and LocalKms keeps a registry of
// retired keys, so a rotated key can still unwrap old ciphertext until
// rewrap-secrets has migrated it.
//
// These tests drive the real crypto path end to end — no mocked cipher.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const { LocalKms, __setKmsForTests, __resetKmsForTests } = await import('../src/config/kms.js');
const { encryptField, decryptField, envelopeKekId, isCiphertext } = await import(
  '../src/shared/encryption.js'
);

const KEK_OLD = randomBytes(32);
const KEK_NEW = randomBytes(32);
const SECRET = 'A1234567 — passport number with unicode ✓';

afterEach(() => {
  __resetKmsForTests();
});

describe('envelope v2 — records which KEK wrapped it', () => {
  beforeEach(() => {
    __setKmsForTests(new LocalKms(KEK_OLD, 'kek-2026-01'));
  });

  it('round-trips under the active key', async () => {
    const blob = await encryptField(SECRET);
    expect(await decryptField(blob)).toBe(SECRET);
  });

  it('stamps the active KEK id into the envelope', async () => {
    const blob = await encryptField(SECRET);
    expect(envelopeKekId(blob)).toBe('kek-2026-01');
  });

  it('is recognised as ciphertext', async () => {
    expect(isCiphertext(await encryptField(SECRET))).toBe(true);
  });

  it('rejects a tampered ciphertext (GCM tag still enforced)', async () => {
    const blob = await encryptField(SECRET);
    // Flip a bit inside the ciphertext body, well past the header.
    const tampered = Buffer.from(blob);
    tampered[tampered.length - TAG_OFFSET_INTO_BODY] ^= 0xff;
    await expect(decryptField(tampered)).rejects.toThrow();
  });
});
// Far enough from the end to land in ciphertext rather than the 16-byte tag.
const TAG_OFFSET_INTO_BODY = 20;

describe('KEK rotation — the failure mode this work exists to prevent', () => {
  it('OLD ciphertext still decrypts after rotating to a NEW active key', async () => {
    // 1. Write under the old key.
    __setKmsForTests(new LocalKms(KEK_OLD, 'kek-2026-01'));
    const oldBlob = await encryptField(SECRET);

    // 2. Rotate: new key is active, old key retained in the registry.
    __setKmsForTests(
      new LocalKms(KEK_NEW, 'kek-2026-08', new Map([['kek-2026-01', KEK_OLD]])),
    );

    // 3. The old row must still be readable. Before v2 this threw
    //    "Unsupported state or unable to authenticate data" forever.
    expect(await decryptField(oldBlob)).toBe(SECRET);
  });

  it('NEW writes use the new key id while old rows keep theirs', async () => {
    __setKmsForTests(new LocalKms(KEK_OLD, 'kek-2026-01'));
    const oldBlob = await encryptField(SECRET);

    __setKmsForTests(
      new LocalKms(KEK_NEW, 'kek-2026-08', new Map([['kek-2026-01', KEK_OLD]])),
    );
    const newBlob = await encryptField(SECRET);

    expect(envelopeKekId(oldBlob)).toBe('kek-2026-01');
    expect(envelopeKekId(newBlob)).toBe('kek-2026-08');
    // Both readable simultaneously — that is what makes a rolling rewrap safe.
    expect(await decryptField(oldBlob)).toBe(SECRET);
    expect(await decryptField(newBlob)).toBe(SECRET);
  });

  it('fails with an ACTIONABLE error when the retired key was not retained', async () => {
    __setKmsForTests(new LocalKms(KEK_OLD, 'kek-2026-01'));
    const oldBlob = await encryptField(SECRET);

    // Operator rotated but forgot KMS_KEK_PREVIOUS.
    __setKmsForTests(new LocalKms(KEK_NEW, 'kek-2026-08'));

    // The error must NAME the missing key so the operator knows exactly which
    // material to restore — the old failure was an opaque GCM auth error.
    await expect(decryptField(oldBlob)).rejects.toThrow(/kek-2026-01/);
    await expect(decryptField(oldBlob)).rejects.toThrow(/KMS_KEK_PREVIOUS/);
  });

  it('supports a multi-generation registry (two rotations deep)', async () => {
    const KEK_GEN1 = randomBytes(32);
    const KEK_GEN2 = randomBytes(32);
    const KEK_GEN3 = randomBytes(32);

    __setKmsForTests(new LocalKms(KEK_GEN1, 'gen1'));
    const b1 = await encryptField('first');
    __setKmsForTests(new LocalKms(KEK_GEN2, 'gen2', new Map([['gen1', KEK_GEN1]])));
    const b2 = await encryptField('second');
    __setKmsForTests(
      new LocalKms(KEK_GEN3, 'gen3', new Map([['gen1', KEK_GEN1], ['gen2', KEK_GEN2]])),
    );
    const b3 = await encryptField('third');

    expect(await decryptField(b1)).toBe('first');
    expect(await decryptField(b2)).toBe('second');
    expect(await decryptField(b3)).toBe('third');
  });
});

describe('v1 backwards compatibility — no migration required', () => {
  it('decrypts a legacy v1 envelope, which records no KEK id', async () => {
    const kek = randomBytes(32);
    const kms = new LocalKms(kek, 'whatever-id');
    __setKmsForTests(kms);

    // Hand-build a v1 blob exactly as the previous implementation did:
    //   [0x01][wrappedDekLen:2][wrappedDek][iv:12][ct][tag:16]
    const { createCipheriv, randomBytes: rb } = await import('node:crypto');
    const { dek, encryptedDek } = await kms.generateDek();
    const iv = rb(12);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(SECRET, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    const header = Buffer.alloc(3);
    header.writeUInt8(0x01, 0);
    header.writeUInt16BE(encryptedDek.length, 1);
    const v1Blob = Buffer.concat([header, encryptedDek, iv, ct, tag]);

    expect(isCiphertext(v1Blob)).toBe(true);
    expect(envelopeKekId(v1Blob)).toBeNull(); // v1 records no id
    expect(await decryptField(v1Blob)).toBe(SECRET);
  });

  it('rejects an unknown future version rather than guessing', async () => {
    __setKmsForTests(new LocalKms(KEK_OLD, 'kek-2026-01'));
    const blob = await encryptField(SECRET);
    const bogus = Buffer.from(blob);
    bogus.writeUInt8(0x7f, 0);
    await expect(decryptField(bogus)).rejects.toThrow(/unsupported version/i);
  });
});
