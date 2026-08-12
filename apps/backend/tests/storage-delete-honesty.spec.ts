// SVT-GDPR-2026-08 — a failed delete must never be reported as a shred.
//
// S3Storage.delete ended in `.catch(() => undefined)` labelled "best-effort
// idempotent delete". Idempotent and best-effort are different things, and
// conflating them made erasure lie: DeleteObject is ALREADY idempotent for a
// missing key, so the only errors reaching that catch were real — AccessDenied,
// a throttle, a timeout, the wrong bucket. Swallowing them meant the retention
// pass stamped `deleted_at` and wrote an audit row asserting
// `document.retention_shredded` while the file was still in the bucket. The
// next scan filters `deleted_at IS NULL`, so it was never revisited: a false
// Art. 17 attestation that nothing self-heals and only an audit uncovers.
//
// These tests pin the boundary between "genuinely already gone" (success) and
// "we could not delete it" (must throw).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');
vi.stubEnv('STORAGE_DRIVER', 's3');
vi.stubEnv('S3_BUCKET', 'test-bucket');
vi.stubEnv('S3_REGION', 'us-east-1');
vi.stubEnv('S3_ENDPOINT', 'https://example.invalid');
vi.stubEnv('S3_ACCESS_KEY_ID', 'x');
vi.stubEnv('S3_SECRET_ACCESS_KEY', 'y');

let sendImpl: (cmd: unknown) => Promise<unknown>;

vi.mock('@aws-sdk/client-s3', () => {
  class Cmd {
    constructor(public readonly input: unknown) {}
  }
  return {
    S3Client: class {
      send(cmd: unknown) {
        return sendImpl(cmd);
      }
    },
    DeleteObjectCommand: Cmd,
    PutObjectCommand: Cmd,
    GetObjectCommand: Cmd,
    HeadObjectCommand: Cmd,
  };
});

const { S3Storage } = await import('../src/modules/documents/storage.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store = () => new (S3Storage as any)() as { delete: (k: string) => Promise<void> };

const awsError = (name: string) => Object.assign(new Error(name), { name });

beforeEach(() => {
  sendImpl = async () => ({});
});

describe('S3Storage.delete — real failures surface', () => {
  it('throws on AccessDenied instead of reporting success', async () => {
    sendImpl = async () => {
      throw awsError('AccessDenied');
    };
    await expect(store().delete('tenant/doc-1')).rejects.toThrow(/AccessDenied/);
  });

  it('throws on a throttle', async () => {
    sendImpl = async () => {
      throw awsError('SlowDown');
    };
    await expect(store().delete('tenant/doc-1')).rejects.toThrow(/SlowDown/);
  });

  it('throws on a network timeout', async () => {
    sendImpl = async () => {
      throw awsError('TimeoutError');
    };
    await expect(store().delete('tenant/doc-1')).rejects.toThrow(/TimeoutError/);
  });

  it('throws when the bucket itself is wrong', async () => {
    sendImpl = async () => {
      throw awsError('NoSuchBucket');
    };
    await expect(store().delete('tenant/doc-1')).rejects.toThrow(/NoSuchBucket/);
  });
});

describe('S3Storage.delete — genuine absence is still success', () => {
  it('resolves when the object is already gone (NoSuchKey)', async () => {
    sendImpl = async () => {
      throw awsError('NoSuchKey');
    };
    await expect(store().delete('tenant/doc-1')).resolves.toBeUndefined();
  });

  it('resolves on NotFound', async () => {
    sendImpl = async () => {
      throw awsError('NotFound');
    };
    await expect(store().delete('tenant/doc-1')).resolves.toBeUndefined();
  });

  it('resolves on a normal successful delete', async () => {
    await expect(store().delete('tenant/doc-1')).resolves.toBeUndefined();
  });

  it('sends the key it was asked to delete', async () => {
    const seen: unknown[] = [];
    sendImpl = async (cmd) => {
      seen.push((cmd as { input: unknown }).input);
      return {};
    };
    await store().delete('tenant-a/doc-42');
    expect(seen).toHaveLength(1);
    expect((seen[0] as { Key: string }).Key).toBe('tenant-a/doc-42');
  });
});
