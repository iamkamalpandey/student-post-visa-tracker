// Envelope encryption helpers for at-rest PII columns (Bytes, *_enc).
//
// Why envelope encryption?
//   - The KEK (master key) lives in a KMS / HSM and never touches plaintext.
//   - A fresh DEK (data encryption key) is generated *per field* (i.e. per record-column).
//     Compromising one DEK exposes only that one cell.
//   - To rotate the KEK, we re-wrap the DEK without touching the underlying ciphertext —
//     a property a single-key scheme (KEK encrypts plaintext directly) does not give us.
//   - AES-256-GCM is an AEAD: a 128-bit tag detects tampering. We refuse to decrypt
//     mutated bytes; callers see a thrown error rather than silently-corrupted data.
//
// Blob layout (single self-describing buffer stored in a Bytes column):
//
//   off  size  field
//   0    1     version           (currently 0x01)
//   1    2     wrappedDekLen     (big-endian uint16, max 65535 bytes)
//   3    L     wrappedDek        (KEK-wrapped DEK)
//   3+L  12    iv                (GCM nonce)
//   ...  N     ciphertext        (AES-256-GCM of plaintext)
//   end  16   tag                (GCM authentication tag, last 16 bytes)
//
// The version byte lets us evolve the format (different cipher / different layout) without a
// schema migration: readers branch on byte 0.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getKms } from '../config/kms.js';

const VERSION = 0x01;
const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + 2; // version + wrappedDekLen
const MAX_WRAPPED_DEK = 0xffff;

/**
 * Encrypt a single field. Returns the self-describing blob suitable for a Prisma Bytes column.
 *
 * @param plain UTF-8 string or raw bytes. Strings are encoded as UTF-8.
 */
export async function encryptField(plain: string | Buffer): Promise<Buffer> {
  const plainBuf = typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain;
  const kms = getKms();
  const { dek, encryptedDek } = await kms.generateDek();
  if (encryptedDek.length > MAX_WRAPPED_DEK) {
    throw new Error(`encryptField: wrappedDek length ${encryptedDek.length} exceeds uint16 max`);
  }

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, dek, iv);
  const ct = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Wipe DEK from local view immediately. Node Buffers can't be reliably zeroed against the GC,
  // but this minimises the window where it sits in memory next to the ciphertext.
  dek.fill(0);

  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt8(VERSION, 0);
  header.writeUInt16BE(encryptedDek.length, 1);

  return Buffer.concat([header, encryptedDek, iv, ct, tag]);
}

/**
 * Decrypt a blob produced by {@link encryptField}. Returns the plaintext as a UTF-8 string.
 *
 * Throws if:
 *   - the version byte is unknown,
 *   - the blob is structurally too small,
 *   - the GCM tag does not validate (tampering or wrong KEK).
 */
export async function decryptField(blob: Buffer): Promise<string> {
  return (await decryptFieldRaw(blob)).toString('utf8');
}

/** Same as {@link decryptField} but returns raw bytes. */
export async function decryptFieldRaw(blob: Buffer): Promise<Buffer> {
  if (blob.length < HEADER_LEN + IV_LEN + TAG_LEN + 1) {
    throw new Error('decryptField: blob too short');
  }
  const version = blob.readUInt8(0);
  if (version !== VERSION) {
    throw new Error(`decryptField: unsupported version 0x${version.toString(16)}`);
  }
  const wrappedDekLen = blob.readUInt16BE(1);
  const wrappedDekStart = HEADER_LEN;
  const ivStart = wrappedDekStart + wrappedDekLen;
  const ctStart = ivStart + IV_LEN;
  const tagStart = blob.length - TAG_LEN;

  if (ivStart > blob.length || ctStart > tagStart) {
    throw new Error('decryptField: malformed blob');
  }

  const wrappedDek = blob.subarray(wrappedDekStart, ivStart);
  const iv = blob.subarray(ivStart, ctStart);
  const ct = blob.subarray(ctStart, tagStart);
  const tag = blob.subarray(tagStart);

  const kms = getKms();
  const dek = await kms.decryptDek(wrappedDek);
  try {
    const decipher = createDecipheriv(ALG, dek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } finally {
    dek.fill(0);
  }
}

/** JSON-stringify then encrypt. The JSON encoding is UTF-8. */
export async function encryptJson(value: unknown): Promise<Buffer> {
  return encryptField(JSON.stringify(value));
}

/** Decrypt then JSON-parse. */
export async function decryptJson<T>(blob: Buffer): Promise<T> {
  const text = await decryptField(blob);
  return JSON.parse(text) as T;
}

/**
 * Quick discriminator. True iff the buffer's first byte matches our version marker.
 * Use to distinguish ciphertext from accidental plaintext when reading legacy data.
 * Note: a coincidence with the byte 0x01 is possible — this is a hint, not a proof.
 */
export function isCiphertext(blob: Buffer): boolean {
  return blob.length >= HEADER_LEN + IV_LEN + TAG_LEN && blob.readUInt8(0) === VERSION;
}
