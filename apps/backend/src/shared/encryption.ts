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
// Blob layout (single self-describing buffer stored in a Bytes column).
//
// v1 (0x01) — LEGACY, still readable, never written:
//
//   off  size  field
//   0    1     version           (0x01)
//   1    2     wrappedDekLen     (big-endian uint16)
//   3    L     wrappedDek        (KEK-wrapped DEK)
//   3+L  12    iv                (GCM nonce)
//   ...  N     ciphertext        (AES-256-GCM of plaintext)
//   end  16    tag               (GCM authentication tag, last 16 bytes)
//
// v2 (0x02) — CURRENT, adds the KEK identifier:
//
//   off      size  field
//   0        1     version           (0x02)
//   1        1     kekIdLen          (uint8, 1..255)
//   2        K     kekId             (ASCII, id of the KEK that wrapped the DEK)
//   2+K      2     wrappedDekLen     (big-endian uint16)
//   4+K      L     wrappedDek
//   4+K+L    12    iv
//   ...      N     ciphertext
//   end      16    tag
//
// SVT-CRYPTO-2026-08 — WHY v2 EXISTS.
//
// v1 recorded no key identity. Under KMS_PROVIDER=local the wrapped DEK is
// just [iv][ct][tag], so nothing in the stored bytes says which KEK produced
// it. Rotating KMS_KEK_BASE64 therefore made every existing ciphertext
// permanently undecryptable — total, silent, unrecoverable PII loss triggered
// by a routine security operation, with no error until someone read a row.
// (AWS/GCP were unaffected: their blobs embed the key id.)
//
// v2 stamps the active KEK id into every envelope, and LocalKms keeps a
// registry of retired keys (KMS_KEK_PREVIOUS), so rotation is: mint new key ->
// move old into KMS_KEK_PREVIOUS -> deploy -> rewrap -> drop old entry. At no
// point is data unreadable.
//
// Backwards compatibility is total: v1 blobs decrypt unchanged (no kekId is
// passed, so the provider falls back to the active key, exactly as before).
// No migration or backfill is required — rewrapping is an optimisation that
// lets you eventually retire an old key, not a prerequisite.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getKms } from '../config/kms.js';

const VERSION_V1 = 0x01;
const VERSION_V2 = 0x02;
/** Version written by `encryptField`. Readers accept v1 and v2. */
const WRITE_VERSION = VERSION_V2;
const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const V1_HEADER_LEN = 1 + 2; // version + wrappedDekLen
const MAX_WRAPPED_DEK = 0xffff;
const MAX_KEK_ID = 0xff;

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

  // v2 header: version | kekIdLen | kekId | wrappedDekLen
  const kekId = kms.rotateKekId();
  const kekIdBuf = Buffer.from(kekId, 'ascii');
  if (kekIdBuf.length === 0 || kekIdBuf.length > MAX_KEK_ID) {
    throw new Error(
      `encryptField: KEK id must be 1..${MAX_KEK_ID} ASCII bytes, got ${kekIdBuf.length}`,
    );
  }
  const header = Buffer.alloc(2 + kekIdBuf.length + 2);
  header.writeUInt8(WRITE_VERSION, 0);
  header.writeUInt8(kekIdBuf.length, 1);
  kekIdBuf.copy(header, 2);
  header.writeUInt16BE(encryptedDek.length, 2 + kekIdBuf.length);

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
  if (blob.length < V1_HEADER_LEN + IV_LEN + TAG_LEN + 1) {
    throw new Error('decryptField: blob too short');
  }
  const version = blob.readUInt8(0);

  // Parse the header per version. `kekId` stays undefined for v1, which tells
  // the provider "no key recorded — use the active one", i.e. exactly the
  // pre-rotation behaviour those blobs were written under.
  let kekId: string | undefined;
  let wrappedDekLen: number;
  let wrappedDekStart: number;

  if (version === VERSION_V1) {
    wrappedDekLen = blob.readUInt16BE(1);
    wrappedDekStart = V1_HEADER_LEN;
  } else if (version === VERSION_V2) {
    const kekIdLen = blob.readUInt8(1);
    if (kekIdLen === 0) throw new Error('decryptField: malformed blob (empty kekId)');
    const lenOffset = 2 + kekIdLen;
    if (lenOffset + 2 > blob.length) throw new Error('decryptField: malformed blob (truncated header)');
    kekId = blob.subarray(2, lenOffset).toString('ascii');
    wrappedDekLen = blob.readUInt16BE(lenOffset);
    wrappedDekStart = lenOffset + 2;
  } else {
    throw new Error(`decryptField: unsupported version 0x${version.toString(16)}`);
  }

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
  const dek = await kms.decryptDek(wrappedDek, kekId);
  try {
    const decipher = createDecipheriv(ALG, dek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } finally {
    dek.fill(0);
  }
}

/**
 * SVT-CRYPTO-2026-08 — which KEK wrapped this blob, or `null` for a legacy v1
 * envelope that recorded none. Lets `rewrap-secrets` skip rows already under
 * the active key instead of decrypt/re-encrypt churning the whole table.
 */
export function envelopeKekId(blob: Buffer): string | null {
  if (blob.length < 2 || blob.readUInt8(0) !== VERSION_V2) return null;
  const kekIdLen = blob.readUInt8(1);
  if (kekIdLen === 0 || 2 + kekIdLen > blob.length) return null;
  return blob.subarray(2, 2 + kekIdLen).toString('ascii');
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
  if (blob.length < V1_HEADER_LEN + IV_LEN + TAG_LEN) return false;
  const v = blob.readUInt8(0);
  return v === VERSION_V1 || v === VERSION_V2;
}
