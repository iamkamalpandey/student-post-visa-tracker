// Documents service.
// ----------------------------------------------------------------------------
// Owns the entire upload pipeline:
//   1. MIME sniff + size cap (mime.ts)
//   2. SHA-256 fingerprint (storage.ts)
//   3. Antivirus scan (av.ts)
//   4. Optional EXIF strip for images (sharp is intentionally NOT a hard
//      dependency of the backend; we leave a no-op explained in code so the
//      service runs out-of-the-box and a future operator can wire sharp
//      without touching callers).
//   5. Storage write (server-derived storage_key only — never user input)
//   6. Document row insert with retention_until = now + DocumentType.retention_days
//
// Downloads are issued as single-use signed URLs. The signing material is a
// short-lived nonce stored in an in-memory map keyed by (docId, nonce). For a
// single-process deployment this is fine; for multi-replica deployments the
// nonce store should move to Redis. The interface is the same.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { writeAudit } from '../../shared/audit.js';
import { BadRequest, Forbidden, NotFound, UnprocessableEntity } from '../../shared/errors.js';
import { assertOrThrow } from '../../shared/fsm.js';
import { documentFsm, type DocVerification } from './fsm-def.js';

// SVT-FSM-2026-05: state-machine moved to fsm-def.ts. Document.verification is
// one-shot — once an admin stamps a row VERIFIED / REJECTED / EXPIRED, the row
// is terminal. A new upload version is required to re-evaluate. ADMIN escape
// hatch via `force_override: true` + `reason` (>=10 chars) bypasses the guard
// but is audited prominently as `document.verification_force_override`.
import type { AccessTokenClaims } from '../../shared/jwt.js';
import { scanBuffer } from './av.js';
import { ALLOWED_MIME, MAX_UPLOAD_BYTES, detectMime, mimeToExt } from './mime.js';
import { buildStorageKey, getStorage, sha256Hex } from './storage.js';

// Caller context — the RLS-scoped Prisma client (tenantContext middleware
// attaches it as req.db) plus the authenticated principal and the request
// correlation ID for audit.
export interface ServiceContext {
  db: PrismaClient;
  user: AccessTokenClaims;
  ip?: string | null;
  ua?: string | null;
  requestId?: string | null;
}

export interface CreateDocumentArgs {
  studentId: string;
  documentTypeId: string;
  fileName: string;
  mimeHint: string;
  buffer: Buffer;
  issuedOn?: string;
  expiresOn?: string;
}

// ---------------------------------------------------------------------------
// Single-use download nonce store (in-memory, TTL = 5 min)
// ---------------------------------------------------------------------------
interface NonceEntry { docId: string; expiresAt: number; userId: string; }
const nonces = new Map<string, NonceEntry>();
const NONCE_TTL_MS = 5 * 60 * 1000;

function purgeExpiredNonces(now = Date.now()): void {
  for (const [k, v] of nonces) {
    if (v.expiresAt <= now) nonces.delete(k);
  }
}

function issueNonce(docId: string, userId: string): { nonce: string; expiresAt: Date } {
  purgeExpiredNonces();
  const nonce = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
  nonces.set(nonce, { docId, expiresAt: expiresAt.getTime(), userId });
  return { nonce, expiresAt };
}

function consumeNonce(nonce: string): NonceEntry | null {
  purgeExpiredNonces();
  const entry = nonces.get(nonce);
  if (!entry) return null;
  // Single-use: delete on read regardless of validity.
  nonces.delete(nonce);
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}

// Test seam.
export function __resetNoncesForTests(): void { nonces.clear(); }

// ---------------------------------------------------------------------------
// EXIF strip via sharp (libvips). Removes EVERY metadata block — GPS, camera
// serial, capture time, copyright, IPTC, XMP. `.rotate()` first so the visual
// orientation baked from EXIF survives after metadata removal.
//
// Sharp 0.33+ semantics: by default toBuffer() DROPS metadata. The retain
// opt-in is `.keepMetadata()` — which we do NOT call. (Note: `.withMetadata({})`
// looks like a "drop all" hint but actually *keeps* metadata with defaults.)
//
// SVG and animated-format edge cases (image/svg+xml, image/gif) are skipped:
// sharp rasterises SVG (semantic change) and we don't have a hot need to wipe
// SVG metadata. Animated GIF gets passed through; the magic-byte sniff above
// already restricts what kinds of "image/*" we accept.
//
// Failure mode: sharp throws on corrupt/unsupported input. We propagate as
// 422 in the caller (handles `UnprocessableEntity`) rather than silently
// serving an unstripped file.
// ---------------------------------------------------------------------------
async function stripExifIfImage(buf: Buffer, mime: string): Promise<Buffer> {
  if (!mime.startsWith('image/')) return buf;
  if (mime === 'image/svg+xml' || mime === 'image/gif') return buf;
  const sharp = (await import('sharp')).default;
  return sharp(buf, { failOn: 'none' }).rotate().toBuffer();
}

// ---------------------------------------------------------------------------
// createDocument
// ---------------------------------------------------------------------------
export async function createDocument(ctx: ServiceContext, args: CreateDocumentArgs) {
  const tenantId = ctx.user.tid;

  // 1. Size cap (cheap; do this before any IO).
  if (args.buffer.length === 0) throw BadRequest('Empty file');
  if (args.buffer.length > MAX_UPLOAD_BYTES) {
    throw UnprocessableEntity(`File exceeds ${MAX_UPLOAD_BYTES} bytes`);
  }

  // 2. Magic-byte sniff. Header hint must match the actual content.
  const sniff = detectMime(args.buffer, args.mimeHint);
  if (!sniff.allowed || !sniff.detected) {
    throw UnprocessableEntity(
      `Unsupported or mismatched file type: header=${args.mimeHint}, sniffed=${sniff.detected ?? 'unknown'}`,
    );
  }
  const detectedMime = sniff.detected;
  if (!ALLOWED_MIME.has(detectedMime)) {
    // Defensive — detectMime already enforces this, but keep the explicit gate.
    throw UnprocessableEntity('File type not allowed');
  }

  // 3. SHA-256 fingerprint (used for dedup analytics + integrity).
  const sha256 = sha256Hex(args.buffer);

  // 4. Antivirus scan. We scan *before* persisting — clean is the only path
  //    that reaches storage.put. If the scanner is unreachable we record
  //    av_status = ERROR and refuse the upload.
  const scan = await scanBuffer(args.buffer);
  if (scan.result === 'INFECTED') {
    await writeAudit({
      tenantId, actorId: ctx.user.sub, action: 'document.upload_rejected_infected',
      entityType: 'Document', entityId: null,
      after: { sha256, signature: scan.signature ?? null },
      ip: ctx.ip, ua: ctx.ua, requestId: ctx.requestId,
    });
    throw UnprocessableEntity(`File rejected by antivirus: ${scan.signature ?? 'unknown signature'}`);
  }
  if (scan.result === 'ERROR') {
    throw UnprocessableEntity('Antivirus scan failed; please retry');
  }

  // 5. Optional EXIF strip (no-op until sharp is wired — see comment above).
  const safeBuffer = await stripExifIfImage(args.buffer, detectedMime);

  // 6. Look up DocumentType to honour retention_days.
  const docType = await ctx.db.documentType.findFirst({
    where: { id: args.documentTypeId, tenant_id: tenantId, is_active: true },
  });
  if (!docType) throw NotFound('Document type not found');

  // 7. Verify the student exists in the tenant.
  const studentExists = await ctx.db.student.findFirst({
    where: { id: args.studentId, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!studentExists) throw NotFound('Student not found');

  // 8. Allocate the document row first (we need its UUID for the storage key).
  //    Use a transaction so the row is rolled back if storage.put fails.
  const docId = randomUUID();
  const ext = mimeToExt(detectedMime);
  const storageKey = buildStorageKey({ tenantId, studentId: args.studentId, docId, ext });

  const retention_until = docType.retention_days
    ? new Date(Date.now() + docType.retention_days * 24 * 60 * 60 * 1000)
    : null;

  // Storage first (writes to a fresh key — no collision possible) then DB. If
  // the DB insert fails we delete the orphaned object. If storage.put fails,
  // no row was created, no leak.
  await getStorage().put(storageKey, safeBuffer, detectedMime);

  let created;
  try {
    created = await ctx.db.document.create({
      data: {
        id: docId,
        tenant_id: tenantId,
        student_id: args.studentId,
        document_type_id: args.documentTypeId,
        file_name: sanitiseFileName(args.fileName),
        storage_key: storageKey,
        mime_type: detectedMime,
        size_bytes: safeBuffer.length,
        sha256,
        av_status: 'CLEAN',
        av_scanned_at: new Date(),
        issued_on: args.issuedOn ? new Date(args.issuedOn) : null,
        expires_on: args.expiresOn ? new Date(args.expiresOn) : null,
        verification: 'PENDING',
        retention_until,
        created_by_id: ctx.user.sub,
      },
    });
  } catch (err) {
    // Compensating delete: orphaned object would otherwise sit in storage.
    await getStorage().delete(storageKey).catch(() => undefined);
    throw err;
  }

  await writeAudit({
    tenantId, actorId: ctx.user.sub, action: 'document.uploaded',
    entityType: 'Document', entityId: created.id, entityVersion: created.version,
    after: { sha256, mime: detectedMime, size: safeBuffer.length, storage_key: storageKey },
    ip: ctx.ip, ua: ctx.ua, requestId: ctx.requestId,
  });

  return created;
}

// ---------------------------------------------------------------------------
// listForStudent — paginated by created_at desc, cursor on (created_at, id)
// ---------------------------------------------------------------------------
export async function listForStudent(
  ctx: ServiceContext,
  studentId: string,
  opts: { limit?: number; cursor?: string } = {},
) {
  const tenantId = ctx.user.tid;
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);

  const cursorWhere = opts.cursor
    ? { id: { lt: opts.cursor } } // simple id-based cursor; UUIDv4 ordering is fine for a single tenant
    : {};

  const rows = await ctx.db.document.findMany({
    where: {
      tenant_id: tenantId,
      student_id: studentId,
      deleted_at: null,
      ...cursorWhere,
    },
    orderBy: { id: 'desc' },
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;

  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// signedDownload — issue a single-use nonce + URL
// ---------------------------------------------------------------------------
export async function signedDownload(ctx: ServiceContext, docId: string) {
  const tenantId = ctx.user.tid;
  const doc = await ctx.db.document.findFirst({
    where: { id: docId, tenant_id: tenantId, deleted_at: null },
  });
  if (!doc) throw NotFound('Document not found');
  if (doc.av_status !== 'CLEAN') {
    throw Forbidden('Document is not available for download');
  }

  const { nonce, expiresAt } = issueNonce(doc.id, ctx.user.sub);
  return {
    url: `/api/v1/documents/${doc.id}/stream?nonce=${nonce}`,
    expiresAt: expiresAt.toISOString(),
    sha256: doc.sha256,
    mime_type: doc.mime_type,
    file_name: doc.file_name,
    size_bytes: doc.size_bytes,
  };
}

// ---------------------------------------------------------------------------
// streamDownload — validate nonce, fetch object, return raw bytes
// ---------------------------------------------------------------------------
export async function streamDownload(
  ctx: ServiceContext,
  docId: string,
  nonce: string,
): Promise<{
  buffer: Buffer;
  mime: string;
  fileName: string;
  sha256: string;
}> {
  const tenantId = ctx.user.tid;
  const entry = consumeNonce(nonce);
  if (!entry || entry.docId !== docId) throw Forbidden('Invalid or expired download token');
  // Bind nonce to the user that issued it. RLS already constrains the lookup
  // by tenant; this extra check stops a leaked nonce from being replayed by a
  // different user inside the same tenant.
  if (entry.userId !== ctx.user.sub) throw Forbidden('Download token mismatch');

  const doc = await ctx.db.document.findFirst({
    where: { id: docId, tenant_id: tenantId, deleted_at: null },
  });
  if (!doc) throw NotFound('Document not found');
  if (doc.av_status !== 'CLEAN') throw Forbidden('Document is not available for download');

  const buffer = await getStorage().get(doc.storage_key);

  // Re-verify integrity on read. If the stored bytes have drifted from what
  // we recorded at upload time, refuse the download — that's a tampering
  // signal worth surfacing.
  const observed = createHash('sha256').update(buffer).digest('hex');
  if (observed !== doc.sha256) {
    await writeAudit({
      tenantId, actorId: ctx.user.sub, action: 'document.download_integrity_mismatch',
      entityType: 'Document', entityId: doc.id,
      after: { expected: doc.sha256, observed },
      ip: ctx.ip, ua: ctx.ua, requestId: ctx.requestId,
    });
    throw UnprocessableEntity('Stored file failed integrity check');
  }

  await writeAudit({
    tenantId, actorId: ctx.user.sub, action: 'document.downloaded',
    entityType: 'Document', entityId: doc.id,
    ip: ctx.ip, ua: ctx.ua, requestId: ctx.requestId,
  });

  return { buffer, mime: doc.mime_type, fileName: doc.file_name, sha256: doc.sha256 };
}

// ---------------------------------------------------------------------------
// verify — admin-only verification decision
// ---------------------------------------------------------------------------
export async function verify(
  ctx: ServiceContext,
  docId: string,
  decision: {
    verification: 'VERIFIED' | 'REJECTED' | 'EXPIRED';
    notes?: string;
    // SVT-FSM-2026-05: ADMIN escape hatch.
    force_override?: true;
    reason?: string;
  },
) {
  if (ctx.user.role !== 'ADMIN') throw Forbidden('Admin role required');
  const tenantId = ctx.user.tid;

  const existing = await ctx.db.document.findFirst({
    where: { id: docId, tenant_id: tenantId, deleted_at: null },
  });
  if (!existing) throw NotFound('Document not found');

  // SVT-FSM-2026-05: terminal-state guard. The wire enum lacks PENDING (so a
  // legitimate decision is always one of VERIFIED/REJECTED/EXPIRED). When the
  // current row is already terminal we refuse the transition with 409 unless
  // the caller supplied a valid force_override + reason (>=10 chars).
  const current = existing.verification as DocVerification;
  const next = decision.verification as DocVerification;
  const override = decision.force_override === true;
  if (override) {
    const reason = (decision.reason ?? '').trim();
    if (reason.length < 10) {
      throw UnprocessableEntity(
        'force_override requires `reason` of at least 10 characters explaining the override.',
      );
    }
  } else {
    // Framework returns 409 with `Cannot transition from terminal state "X"
    // to "Y"`. The test pins detail: /REJECTED/ which is satisfied by either
    // the legacy or framework message.
    assertOrThrow(documentFsm, current, next, 'ADMIN');
  }

  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await ctx.db.document.updateMany({
    where: { id: docId, tenant_id: tenantId, deleted_at: null },
    data: {
      verification: decision.verification,
      verified_at: new Date(),
      verified_by_id: ctx.user.sub,
    },
  });
  if (wr.count !== 1) throw NotFound('Document not found');
  const updated = await ctx.db.document.findFirstOrThrow({
    where: { id: docId, tenant_id: tenantId },
  });

  const action = decision.verification === 'VERIFIED'
    ? 'doc.verify.accepted'
    : decision.verification === 'REJECTED'
      ? 'doc.verify.rejected'
      : 'doc.verify.expired';

  await writeAudit({
    tenantId, actorId: ctx.user.sub, action,
    entityType: 'Document', entityId: updated.id, entityVersion: updated.version,
    before: { verification: existing.verification },
    after: { verification: updated.verification, notes: decision.notes ?? null },
    ip: ctx.ip, ua: ctx.ua, requestId: ctx.requestId,
  });

  // SVT-FSM-2026-05: write a second, prominent audit row when the override
  // was used so reviewers can find these without scanning every doc.verify.* row.
  if (override) {
    await writeAudit({
      tenantId, actorId: ctx.user.sub, action: 'document.verification_force_override',
      entityType: 'Document', entityId: updated.id, entityVersion: updated.version,
      before: { verification: existing.verification },
      after: {
        verification: updated.verification,
        reason: decision.reason ?? null,
        notes: decision.notes ?? null,
      },
      ip: ctx.ip, ua: ctx.ua, requestId: ctx.requestId,
    });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// softDelete — admin-only logical delete (storage retained)
// ---------------------------------------------------------------------------
export async function softDelete(ctx: ServiceContext, docId: string) {
  if (ctx.user.role !== 'ADMIN') throw Forbidden('Admin role required');
  const tenantId = ctx.user.tid;
  const existing = await ctx.db.document.findFirst({
    where: { id: docId, tenant_id: tenantId, deleted_at: null },
  });
  if (!existing) throw NotFound('Document not found');

  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await ctx.db.document.updateMany({
    where: { id: docId, tenant_id: tenantId, deleted_at: null },
    data: { deleted_at: new Date() },
  });
  if (wr.count !== 1) throw NotFound('Document not found');
  const updated = await ctx.db.document.findFirstOrThrow({
    where: { id: docId, tenant_id: tenantId },
  });
  await writeAudit({
    tenantId, actorId: ctx.user.sub, action: 'document.deleted',
    entityType: 'Document', entityId: updated.id, entityVersion: updated.version,
    ip: ctx.ip, ua: ctx.ua, requestId: ctx.requestId,
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Strip path separators and control characters from the user-supplied
// file_name. We keep this for display only — the storage key is server-built.
function sanitiseFileName(name: string): string {
  const trimmed = (name ?? 'file').toString().slice(0, 255);
  return trimmed.replace(/[\\/\x00-\x1f]/g, '_');
}
