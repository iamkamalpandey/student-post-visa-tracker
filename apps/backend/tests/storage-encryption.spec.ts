// SVT-CRYPTO-2026-05 — verifies LocalStorage encrypts-at-rest.
// We poke the raw filesystem with fs.readFileSync to confirm bytes on disk
// are NOT plaintext, then go through get() to confirm transparent decrypt
// reproduces the original input. Also checks the legacy passthrough branch
// (pre-rollout blobs lacking the envelope header) and binary fidelity.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point STORAGE_LOCAL_ROOT at an isolated tmpdir BEFORE config/env.ts is imported.
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'spv-storage-enc-'));
process.env.STORAGE_LOCAL_ROOT = TMP_ROOT;
process.env.STORAGE_DRIVER = 'local';
process.env.NODE_ENV = 'test'; // triggers ephemeral KEK in LocalKms.loadLocalKek
process.env.CORS_ORIGIN = 'http://localhost:3000';
process.env.DATABASE_URL = 'postgresql://x:x@localhost:5432/x';
process.env.DATABASE_MIGRATE_URL = 'postgresql://x:x@localhost:5432/x';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.JWT_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----';
process.env.JWT_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----';
process.env.JWT_KID = 'test';
process.env.SEED_ADMIN_EMAIL = 'admin@example.com';
process.env.SEED_ADMIN_PASSWORD = 'ChangeMeNow!2026';

// Dynamic imports so the env stubs above are in place first.
const { LocalStorage } = await import('../src/modules/documents/storage.js');

const KEY = 'tenantA/studentB/2026/05/doc-1.pdf';
const PLAINTEXT = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8');

function rawPath(key: string): string {
  return join(TMP_ROOT, key);
}

describe('LocalStorage encryption-at-rest', () => {
  let store: InstanceType<typeof LocalStorage>;

  beforeAll(() => {
    store = new LocalStorage(TMP_ROOT);
  });

  it('put() writes ciphertext (NOT plaintext) to disk', async () => {
    await store.put(KEY, PLAINTEXT, 'application/pdf');
    const onDisk = readFileSync(rawPath(KEY));

    // Must not be byte-equal to the input.
    expect(onDisk.equals(PLAINTEXT)).toBe(false);
    // Plaintext substring must not appear anywhere in the blob.
    expect(onDisk.toString('binary').includes(PLAINTEXT.toString('binary'))).toBe(false);
    // Envelope version byte = 0x01.
    expect(onDisk.readUInt8(0)).toBe(0x01);
    // Header(3) + wrappedDek(>=28) + iv(12) + ct(>=plain.length) + tag(16).
    expect(onDisk.length).toBeGreaterThan(PLAINTEXT.length + 3 + 12 + 16);
  });

  it('get() returns plaintext that matches the original input', async () => {
    const out = await store.get(KEY);
    expect(out.equals(PLAINTEXT)).toBe(true);
    expect(out.toString('utf8')).toBe(PLAINTEXT.toString('utf8'));
  });

  it('legacy plaintext file (no envelope header) passes through unchanged', async () => {
    // Simulate a pre-rollout blob: write plaintext directly under the root,
    // bypassing put(). isCiphertext() should return false and get() should
    // return the bytes verbatim. We pad to satisfy the minimum-length check
    // inside isCiphertext (header + iv + tag = 31 bytes); first byte != 0x01
    // ensures the version sniff fails.
    const legacyKey = 'tenantA/studentB/2026/05/legacy.pdf';
    const legacyBytes = Buffer.concat([
      Buffer.from([0x25, 0x50, 0x44, 0x46]), // "%PDF" — first byte 0x25, not 0x01
      Buffer.alloc(64, 0xab),
    ]);
    mkdirSync(join(TMP_ROOT, 'tenantA/studentB/2026/05'), { recursive: true });
    writeFileSync(rawPath(legacyKey), legacyBytes);

    const out = await store.get(legacyKey);
    expect(out.equals(legacyBytes)).toBe(true);
  });

  it('round-trips an arbitrary binary buffer (image-like bytes)', async () => {
    // Construct a buffer with the full 0x00..0xFF range plus a fake PNG header.
    // GCM is byte-transparent but this still defends against an accidental
    // toString('utf8') round-trip mangling the data.
    const binKey = 'tenantA/studentB/2026/05/img.png';
    const range = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) range.writeUInt8(i, i);
    const bin = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
      range,
      Buffer.from([0x00, 0xff, 0x00, 0xff, 0xde, 0xad, 0xbe, 0xef]),
    ]);

    await store.put(binKey, bin, 'image/png');
    const onDisk = readFileSync(rawPath(binKey));
    expect(onDisk.equals(bin)).toBe(false);

    const out = await store.get(binKey);
    expect(out.length).toBe(bin.length);
    expect(out.equals(bin)).toBe(true);
  });

  it('encryption persists across separate LocalStorage instances (no in-memory state)', async () => {
    const crossKey = 'tenantA/studentB/2026/05/cross.pdf';
    const payload = Buffer.from('cross-instance-payload-xyz', 'utf8');

    // Instance A writes.
    const writer = new LocalStorage(TMP_ROOT);
    await writer.put(crossKey, payload, 'application/pdf');

    // Instance B (fresh constructor, no shared state beyond the env-driven KMS
    // singleton) reads.
    const reader = new LocalStorage(TMP_ROOT);
    const out = await reader.get(crossKey);

    expect(out.equals(payload)).toBe(true);
    // And confirm the on-disk blob is still ciphertext.
    const onDisk = readFileSync(rawPath(crossKey));
    expect(onDisk.equals(payload)).toBe(false);
    expect(onDisk.readUInt8(0)).toBe(0x01);
  });
});
