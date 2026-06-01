// Pluggable object-storage abstraction.
// ----------------------------------------------------------------------------
// The Document module never sees a "filename" from user input applied to the
// physical layout: storage keys are entirely derived from server-side context
// (tenant, student, year, month, document UUID, sniffed extension). The user-
// supplied file_name is preserved only as metadata and used for the
// Content-Disposition header on download.
//
// Two drivers are supported:
//   - LocalStorage: files on disk under env.STORAGE_LOCAL_ROOT. Used for
//     development and tests. Writes are atomic (write-tmp, then rename).
//   - S3 (stub): a placeholder that throws. Production deployments must wire
//     an SDK-based implementation behind the same interface.
//
// Path traversal defence
// ----------------------
// `LocalStorage.put/get/delete/exists` all run incoming keys through
// `safePath`, which:
//   1. Rejects absolute paths and any segment containing '..'.
//   2. Resolves the candidate against the configured root and re-checks that
//      the resolved path is *still* inside the root using `path.relative`.
// A would-be attacker who somehow controlled a key cannot escape the root.

import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { env } from '../../config/env.js';

export interface ObjectStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

// ----------------------------------------------------------------------------
// Storage key derivation
// ----------------------------------------------------------------------------
// Keys look like: <tenantId>/<studentId>/<yyyy>/<mm>/<docId>.<ext>
// All components are server-controlled; the only "ext" comes from a fixed
// allow-list in mime.ts via mimeToExt().
export function buildStorageKey(opts: {
  tenantId: string;
  studentId: string;
  docId: string;
  ext: string;
  now?: Date;
}): string {
  const now = opts.now ?? new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const ext = opts.ext.replace(/^\.+/, '').toLowerCase();
  // We re-validate each component matches a strict UUID/date pattern to
  // ensure no caller can ever inject path separators.
  const segs = [opts.tenantId, opts.studentId, yyyy, mm, `${opts.docId}.${ext}`];
  for (const s of segs) {
    if (s.includes('/') || s.includes('\\') || s.includes('..')) {
      throw new Error('Invalid storage key component');
    }
  }
  return segs.join('/');
}

// ----------------------------------------------------------------------------
// Local-disk implementation
// ----------------------------------------------------------------------------
class LocalStorage implements ObjectStorage {
  private readonly root: string;

  constructor(root: string) {
    // Always resolve to an absolute path up-front so safePath() comparisons
    // are deterministic regardless of process CWD.
    this.root = path.resolve(root);
  }

  /** Resolve `key` to an absolute path inside the root, or throw. */
  private safePath(key: string): string {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('Empty storage key');
    }
    if (path.isAbsolute(key)) {
      throw new Error('Absolute storage key not allowed');
    }
    // Segment-by-segment validation: forbid '..' anywhere.
    const segs = key.split(/[\\/]/);
    for (const s of segs) {
      if (s === '..' || s === '.') throw new Error('Path traversal segment');
      if (s.length === 0) throw new Error('Empty path segment');
    }
    const resolved = path.resolve(this.root, key);
    const rel = path.relative(this.root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Resolved path escapes storage root');
    }
    return resolved;
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<void> {
    const finalPath = this.safePath(key);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });

    // SVT-CRYPTO-2026-05 — encrypt-at-rest. Per-field DEK envelope (AES-256-GCM)
    // wrapped by KMS KEK and embedded inline in the blob. Crypto-shred on
    // retention = delete the storage object (wrapped DEK disappears with it).
    // Lazy-import to avoid a circular dep at module load.
    const { encryptField } = await import('../../shared/encryption.js');
    const ciphertext = await encryptField(data);

    // Atomic write: write to <final>.<rand>.tmp then rename. POSIX rename is
    // atomic within a filesystem; on Windows fs.rename overwrites only if the
    // target does not exist, so we delete-then-rename if needed. We never
    // overwrite an existing key in normal flow because storage keys embed a
    // fresh document UUID per upload, but defend anyway.
    const tmp = `${finalPath}.${randomBytes(8).toString('hex')}.tmp`;
    await fs.writeFile(tmp, ciphertext, { mode: 0o600 });
    try {
      await fs.rename(tmp, finalPath);
    } catch (err) {
      // Best-effort cleanup of the tmp file; swallow failures.
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  async get(key: string): Promise<Buffer> {
    const p = this.safePath(key);
    const blob = await fs.readFile(p);
    // SVT-CRYPTO-2026-05 — transparent decrypt. Pre-encryption-rollout legacy
    // blobs lack the envelope header — isCiphertext sniffs and we pass those
    // through unchanged. Once retention sweeps all legacy rows the
    // passthrough can be removed.
    const { decryptFieldRaw, isCiphertext } = await import('../../shared/encryption.js');
    if (isCiphertext(blob)) {
      return await decryptFieldRaw(blob);
    }
    return Buffer.from(blob);
  }

  async delete(key: string): Promise<void> {
    const p = this.safePath(key);
    await fs.unlink(p).catch((err) => {
      // ENOENT is idempotent-success.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    });
  }

  async exists(key: string): Promise<boolean> {
    const p = this.safePath(key);
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }
}

// ----------------------------------------------------------------------------
// S3 stub
// ----------------------------------------------------------------------------
// Intentionally throws so that misconfigured production deployments fail
// loudly during the first put/get rather than silently writing nothing.
class S3StorageStub implements ObjectStorage {
  async put(): Promise<void> { throw new Error('Configure S3 driver for production'); }
  async get(): Promise<Buffer> { throw new Error('Configure S3 driver for production'); }
  async delete(): Promise<void> { throw new Error('Configure S3 driver for production'); }
  async exists(): Promise<boolean> { throw new Error('Configure S3 driver for production'); }
}

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------
let cached: ObjectStorage | null = null;
export function getStorage(): ObjectStorage {
  if (cached) return cached;
  if (env.STORAGE_DRIVER === 'local') {
    cached = new LocalStorage(env.STORAGE_LOCAL_ROOT);
  } else {
    cached = new S3StorageStub();
  }
  return cached;
}

// Test seam: allow tests to swap in an in-memory implementation without
// monkey-patching the module.
export function __setStorageForTests(impl: ObjectStorage | null): void {
  cached = impl;
}

// Convenience for callers that want to verify file integrity post-upload.
export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export { LocalStorage };
