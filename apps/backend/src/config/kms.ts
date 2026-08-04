// Key Management Service (KMS) abstraction.
//
// We use envelope encryption everywhere PII is at rest:
//   plaintext --AES-256-GCM(DEK)--> ciphertext
//   DEK       --AES-256-GCM(KEK)--> encryptedDek
//
// The KEK never leaves the KMS (or in dev/test, the process boundary). The DEK is
// generated fresh per field — see shared/encryption.ts. This module only knows how
// to mint and unwrap DEKs; it has no concept of "field" or "record".
//
// Provider matrix
// ---------------
//   - local: in-process AES-256-GCM. KEK loaded from KMS_KEK_BASE64. Default for
//     dev/test. In production REFUSES to start unless KMS_LOCAL_OK=true
//     (explicit override for self-hosted ops who manage KEK material on disk).
//     Tradeoff: KEK lives inside the app process, so a memory-disclosure bug
//     (heapdump, /proc/<pid>/mem read) exposes it. Acceptable for self-hosted
//     air-gapped installs; not acceptable for multi-tenant SaaS.
//   - aws:   AwsKmsKms. Calls KMS.GenerateDataKey to mint DEKs and KMS.Decrypt
//     to unwrap. KEK never leaves AWS. Dependency `@aws-sdk/client-kms` is
//     LAZY-loaded so non-AWS deploys don't need it; if KMS_PROVIDER=aws and
//     the dep is not installed, boot fails fast with a clear message.
//   - gcp / vault: enum slots reserved. getKms() throws "not implemented" until
//     a class lands (GcpKmsKms via @google-cloud/kms, VaultKms via
//     node-vault).
//
// Switching provider: set KMS_PROVIDER=aws and KMS_KEY_ID=<arn-or-alias>.
// Re-wrap existing ciphertext with infra/scripts/rewrap-secrets.ts after the
// cutover — see infra/docs/runbooks/kms-rotation.md.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from './env.js';
import { GcpKmsKms } from './kms-gcp.js';

const ALG = 'aes-256-gcm';
const KEK_LEN = 32; // 256 bits
const DEK_LEN = 32; // 256 bits
const IV_LEN = 12; // 96 bits, GCM standard
const TAG_LEN = 16; // 128 bits

export interface Kms {
  /** Generate a fresh 256-bit DEK and its KEK-wrapped form. */
  generateDek(): Promise<{ dek: Buffer; encryptedDek: Buffer }>;
  /**
   * Unwrap a previously wrapped DEK. Throws on tag mismatch / wrong KEK.
   *
   * SVT-CRYPTO-2026-08 — `kekId` identifies WHICH key wrapped this DEK, read
   * from the v2 envelope header. Providers that embed key identity in their
   * own ciphertext (AWS, GCP) ignore it. `local` uses it to select from its
   * KEK registry, which is what makes rotation survivable: without it, a
   * rotated KEK orphans every existing ciphertext.
   *
   * Undefined means "v1 envelope, no id recorded" — providers fall back to the
   * active key, preserving the pre-rotation behaviour for legacy blobs.
   */
  decryptDek(encryptedDek: Buffer, kekId?: string): Promise<Buffer>;
  /** Identifier of the active KEK; stamped into new envelopes, used during rotation. */
  rotateKekId(): string;
}

/**
 * Local KMS suitable for development and tests.
 *
 *  - Production: do NOT use; switch KMS_PROVIDER to a real provider. The env
 *    schema enforces this — KMS_PROVIDER=local + NODE_ENV=production refuses
 *    to boot unless KMS_LOCAL_OK=true is set explicitly.
 *  - Dev:        reads KMS_KEK_BASE64 from env. Throws if missing.
 *  - Test:       (NODE_ENV === 'test') if KMS_KEK_BASE64 is missing, generates an ephemeral
 *                KEK in-memory so the test suite runs without a .env file.
 *
 * Wrap layout (encryptedDek): [12 IV][N ciphertext][16 tag] — tag appended.
 */
export class LocalKms implements Kms {
  private readonly kek: Buffer;
  private readonly kekId: string;
  /**
   * SVT-CRYPTO-2026-08 — retired KEKs, by id. Ciphertext written before a
   * rotation still names the key that wrapped it, so we can unwrap it here
   * until `rewrap-secrets` has migrated every row. Without this registry a
   * KEK rotation is equivalent to deleting all encrypted PII.
   */
  private readonly previous: ReadonlyMap<string, Buffer>;

  constructor(kek: Buffer, kekId = 'local-kek-v1', previous?: ReadonlyMap<string, Buffer>) {
    if (kek.length !== KEK_LEN) {
      throw new Error(`LocalKms: KEK must be ${KEK_LEN} bytes, got ${kek.length}`);
    }
    this.kek = kek;
    this.kekId = kekId;
    this.previous = previous ?? new Map();
  }

  /** Resolve the key for an envelope's recorded id. */
  private keyFor(kekId?: string): Buffer {
    // v1 envelopes carry no id — they predate rotation support, so by
    // definition they were written with the only key that ever existed.
    if (kekId === undefined || kekId === this.kekId) return this.kek;
    const old = this.previous.get(kekId);
    if (!old) {
      throw new Error(
        `LocalKms.decryptDek: ciphertext was wrapped with KEK "${kekId}" which is not the active ` +
          `key ("${this.kekId}") and is not in KMS_KEK_PREVIOUS. Restore that key material to ` +
          `KMS_KEK_PREVIOUS as "${kekId}:<base64>" — this data CANNOT be decrypted without it.`,
      );
    }
    return old;
  }

  async generateDek(): Promise<{ dek: Buffer; encryptedDek: Buffer }> {
    const dek = randomBytes(DEK_LEN);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALG, this.kek, iv);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encryptedDek = Buffer.concat([iv, ct, tag]);
    return { dek, encryptedDek };
  }

  async decryptDek(encryptedDek: Buffer, kekId?: string): Promise<Buffer> {
    if (encryptedDek.length < IV_LEN + TAG_LEN) {
      throw new Error('LocalKms.decryptDek: wrapped DEK too short');
    }
    const key = this.keyFor(kekId);
    const iv = encryptedDek.subarray(0, IV_LEN);
    const tag = encryptedDek.subarray(encryptedDek.length - TAG_LEN);
    const ct = encryptedDek.subarray(IV_LEN, encryptedDek.length - TAG_LEN);
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  rotateKekId(): string {
    return this.kekId;
  }
}

/**
 * AWS KMS-backed implementation. The KEK never leaves AWS; we only see DEKs.
 *
 *   - generateDek -> KMS.GenerateDataKey(KeySpec='AES_256') returning
 *     Plaintext (the DEK) + CiphertextBlob (the wrapped DEK).
 *   - decryptDek  -> KMS.Decrypt(CiphertextBlob) returning Plaintext.
 *   - rotateKekId -> the KeyId we were configured with. AWS rotation of the
 *     underlying key version is handled by AWS itself; our id is the alias /
 *     ARN, which stays stable across rotations.
 *
 * The AWS SDK is loaded lazily so deploys that don't use AWS do not need the
 * dependency installed. If `@aws-sdk/client-kms` is not resolvable and
 * KMS_PROVIDER=aws, getKms() throws on first call (which happens at boot —
 * see server.ts importing config/db.ts which transitively touches encryption).
 */
export class AwsKmsKms implements Kms {
  private readonly keyId: string;
  // The SDK client type is intentionally `unknown` here to avoid a hard
  // compile-time dep on @aws-sdk/client-kms (we want it optional). All usage
  // goes through a small adapter inside `client()`.
  private clientPromise: Promise<{
    generateDataKey: () => Promise<{ Plaintext: Uint8Array; CiphertextBlob: Uint8Array }>;
    decrypt: (ciphertext: Buffer) => Promise<{ Plaintext: Uint8Array }>;
  }> | null = null;

  constructor(keyId: string, private readonly region?: string) {
    if (!keyId) throw new Error('AwsKmsKms: keyId is required');
    this.keyId = keyId;
  }

  private async client() {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      // Use `any` for the dynamic import: we don't want a compile-time
      // dependency on @aws-sdk/client-kms types (the dep is optional). The
      // module specifier is held in a variable so TypeScript's static module
      // resolver doesn't try to type-check the missing dependency at build
      // time — we only need it to resolve at runtime when the operator
      // has opted into KMS_PROVIDER=aws.
      const sdkName = '@aws-sdk/client-kms';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let mod: any;
      try {
        mod = await import(/* @vite-ignore */ sdkName);
      } catch {
        throw new Error(
          'KMS_PROVIDER=aws but @aws-sdk/client-kms is not installed. ' +
            'Add it to apps/backend/package.json dependencies, e.g.: ' +
            'pnpm --filter backend add @aws-sdk/client-kms',
        );
      }
      const { KMSClient, GenerateDataKeyCommand, DecryptCommand } = mod;
      const kms = new KMSClient(this.region ? { region: this.region } : {});
      const keyId = this.keyId;
      return {
        generateDataKey: async () => {
          const out = await kms.send(
            new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256' }),
          );
          if (!out.Plaintext || !out.CiphertextBlob) {
            throw new Error('AwsKmsKms.generateDek: KMS returned empty result');
          }
          return { Plaintext: out.Plaintext, CiphertextBlob: out.CiphertextBlob };
        },
        decrypt: async (ciphertext: Buffer) => {
          const out = await kms.send(
            new DecryptCommand({ CiphertextBlob: ciphertext, KeyId: keyId }),
          );
          if (!out.Plaintext) {
            throw new Error('AwsKmsKms.decryptDek: KMS returned empty plaintext');
          }
          return { Plaintext: out.Plaintext };
        },
      };
    })();
    return this.clientPromise;
  }

  async generateDek(): Promise<{ dek: Buffer; encryptedDek: Buffer }> {
    const c = await this.client();
    const out = await c.generateDataKey();
    return {
      dek: Buffer.from(out.Plaintext),
      encryptedDek: Buffer.from(out.CiphertextBlob),
    };
  }

  // `kekId` is intentionally unused: an AWS KMS CiphertextBlob embeds the key
  // id it was produced under, so KMS.Decrypt resolves the right key (and the
  // right rotated version) on its own. We accept the parameter to satisfy the
  // interface and keep the call site provider-agnostic.
  async decryptDek(encryptedDek: Buffer, _kekId?: string): Promise<Buffer> {
    const c = await this.client();
    const out = await c.decrypt(encryptedDek);
    return Buffer.from(out.Plaintext);
  }

  rotateKekId(): string {
    return this.keyId;
  }
}

function loadLocalKek(): Buffer {
  const b64 = env.KMS_KEK_BASE64;
  if (b64) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== KEK_LEN) {
      throw new Error(
        `KMS_KEK_BASE64 must decode to ${KEK_LEN} bytes (got ${buf.length}). Generate with: openssl rand -base64 32`,
      );
    }
    return buf;
  }
  if (env.isTest) {
    // Ephemeral test KEK. Stable for the duration of the process so encrypt/decrypt round-trip
    // works across tests in the same run.
    return randomBytes(KEK_LEN);
  }
  throw new Error(
    'KMS_KEK_BASE64 is required outside of test. Generate with: openssl rand -base64 32',
  );
}

/**
 * SVT-CRYPTO-2026-08 — parse `KMS_KEK_PREVIOUS` into an id -> key registry.
 *
 * Format: `id:base64,id:base64` — e.g.
 *   local-kek-v1:9f8a…==,local-kek-v2:3b1c…==
 *
 * Fails LOUDLY on a malformed entry rather than skipping it. A silently-dropped
 * retired key looks identical to a correct config right up until someone reads
 * a row encrypted under it, at which point the data is unrecoverable — exactly
 * the failure mode this registry exists to prevent.
 */
function loadPreviousKeks(): ReadonlyMap<string, Buffer> {
  const raw = env.KMS_KEK_PREVIOUS;
  const out = new Map<string, Buffer>();
  if (!raw) return out;

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0) {
      throw new Error(
        `KMS_KEK_PREVIOUS entry "${trimmed}" is malformed. Expected "id:base64" pairs, comma-separated.`,
      );
    }
    const id = trimmed.slice(0, sep).trim();
    const buf = Buffer.from(trimmed.slice(sep + 1).trim(), 'base64');
    if (buf.length !== KEK_LEN) {
      throw new Error(
        `KMS_KEK_PREVIOUS entry "${id}" must decode to ${KEK_LEN} bytes (got ${buf.length}).`,
      );
    }
    if (out.has(id)) {
      throw new Error(`KMS_KEK_PREVIOUS contains duplicate key id "${id}".`);
    }
    out.set(id, buf);
  }
  return out;
}

let cached: Kms | null = null;

/**
 * Returns the singleton KMS for this process. Provider is selected by
 * `env.KMS_PROVIDER`:
 *
 *   local            -> LocalKms (KEK from KMS_KEK_BASE64; refused in prod
 *                       without KMS_LOCAL_OK=true; ephemeral in tests).
 *   aws              -> AwsKmsKms (lazy imports @aws-sdk/client-kms; boot fails
 *                       fast if the dep is missing).
 *   gcp | vault      -> reserved enum slots; throws until a provider class lands.
 */
export function getKms(): Kms {
  if (cached) return cached;
  switch (env.KMS_PROVIDER) {
    case 'aws': {
      if (!env.KMS_KEY_ID) {
        throw new Error('KMS_PROVIDER=aws requires KMS_KEY_ID (key ARN or alias)');
      }
      cached = new AwsKmsKms(env.KMS_KEY_ID, env.KMS_AWS_REGION);
      return cached;
    }
    case 'gcp': {
      if (!env.KMS_KEY_ID) {
        throw new Error(
          'KMS_PROVIDER=gcp requires KMS_KEY_ID ' +
            '(projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>)',
        );
      }
      // GcpKmsKms wraps @google-cloud/kms behind a lazy SDK loader (parallel
      // to the AWS path inside AwsKmsKms) — non-GCP deploys never resolve
      // the optional dep, and boot fails fast with a clear "install
      // @google-cloud/kms" message at first generateDek()/decryptDek() call
      // if the dep is missing while KMS_PROVIDER=gcp.
      cached = new GcpKmsKms(env.KMS_KEY_ID);
      return cached;
    }
    case 'vault':
      throw new Error(
        'KMS_PROVIDER=vault is reserved but not yet implemented. ' +
          'Add a VaultKms class backed by node-vault and wire it here.',
      );
    case 'local':
    default:
      cached = new LocalKms(loadLocalKek(), env.KMS_KEK_ID, loadPreviousKeks());
      return cached;
  }
}

/** Test-only: reset the cached KMS so a different KEK is loaded on next getKms(). */
export function __resetKmsForTests(): void {
  cached = null;
}

/**
 * Test-only: override the cached KMS so subsequent getKms() calls return the
 * supplied instance. Pass `null` to clear (equivalent to __resetKmsForTests).
 *
 * Used by the rewrap-secrets spec to simulate "old KEK then new KEK" without
 * needing a real KMS swap mid-test. NEVER call from production code.
 */
export function __setKmsForTests(kms: Kms | null): void {
  cached = kms;
}
