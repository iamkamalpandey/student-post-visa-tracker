// SVT-WAVE-KMS-PROVIDER-2026-05 — P0-K1 GCP KMS provider.
//
// Backs the `KMS_PROVIDER=gcp` env value. Uses @google-cloud/kms's
// CryptoKey.encrypt / decrypt to wrap and unwrap envelope DEKs against a GCP
// CryptoKey resource (KMS_KEY_ID format:
// "projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>"). The KEK never
// leaves Google Cloud — we only ever see DEK plaintexts.
//
// Key strategy: GCP KMS does NOT expose a "GenerateDataKey" primitive the way
// AWS does. We therefore mint the DEK locally with crypto.randomBytes(32) and
// call kmsClient.encrypt() to wrap it. Functionally identical to AWS's
// GenerateDataKey, but the random source is the local CSPRNG rather than
// HSM-generated entropy. This matches the standard pattern documented at
// https://cloud.google.com/kms/docs/envelope-encryption.
//
// SDK loading: lazy. The dependency is OPTIONAL — non-GCP deploys don't need
// @google-cloud/kms installed. If the module is unresolvable at first KMS
// call, we throw a clear "install @google-cloud/kms" message rather than the
// node-internal ERR_MODULE_NOT_FOUND.

import { randomBytes } from 'node:crypto';
import type { Kms } from './kms.js';

const DEK_LEN = 32; // 256 bits

export class GcpKmsKms implements Kms {
  private readonly keyName: string;
  // Adapter object loaded lazily on first use. Typed as a structural interface
  // so we avoid a compile-time dep on @google-cloud/kms's published types.
  private clientPromise: Promise<{
    encrypt: (plaintext: Buffer) => Promise<Buffer>;
    decrypt: (ciphertext: Buffer) => Promise<Buffer>;
  }> | null = null;

  constructor(keyName: string) {
    if (!keyName) throw new Error('GcpKmsKms: keyName is required (cryptoKey resource path)');
    this.keyName = keyName;
  }

  private async client() {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      // Held in a variable so TypeScript's static module resolver doesn't try
      // to type-check the missing optional dependency at build time.
      const sdkName = '@google-cloud/kms';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let mod: any;
      try {
        mod = await import(/* @vite-ignore */ sdkName);
      } catch {
        throw new Error(
          'KMS_PROVIDER=gcp but @google-cloud/kms is not installed. ' +
            'Add it to apps/backend/package.json dependencies, e.g.: ' +
            'pnpm --filter backend add @google-cloud/kms',
        );
      }
      const { KeyManagementServiceClient } = mod;
      const kms = new KeyManagementServiceClient();
      const name = this.keyName;
      return {
        encrypt: async (plaintext: Buffer): Promise<Buffer> => {
          const [resp] = await kms.encrypt({ name, plaintext });
          if (!resp?.ciphertext) {
            throw new Error('GcpKmsKms.encrypt: KMS returned empty ciphertext');
          }
          return Buffer.from(resp.ciphertext as Uint8Array);
        },
        decrypt: async (ciphertext: Buffer): Promise<Buffer> => {
          const [resp] = await kms.decrypt({ name, ciphertext });
          if (!resp?.plaintext) {
            throw new Error('GcpKmsKms.decrypt: KMS returned empty plaintext');
          }
          return Buffer.from(resp.plaintext as Uint8Array);
        },
      };
    })();
    return this.clientPromise;
  }

  async generateDek(): Promise<{ dek: Buffer; encryptedDek: Buffer }> {
    const c = await this.client();
    const dek = randomBytes(DEK_LEN);
    const encryptedDek = await c.encrypt(dek);
    return { dek, encryptedDek };
  }

  async decryptDek(encryptedDek: Buffer): Promise<Buffer> {
    const c = await this.client();
    return c.decrypt(encryptedDek);
  }

  rotateKekId(): string {
    return this.keyName;
  }
}
