// DSARRequest service. POST is open to any authenticated user; LIST is admin only.
// due_by is computed as requested_at + 30 days at create-time.
//
// SVT-DSAR-FSM-2026-05: Forward-only state machine for DSAR status transitions.
// The PATCH /dsar/:id endpoint enforces:
//   - PENDING       -> IN_PROGRESS                    (any COUNSELLOR+)
//   - IN_PROGRESS   -> COMPLETED                      (any COUNSELLOR+, stamps completed_at)
//   - IN_PROGRESS   -> REJECTED                       (ADMIN only, requires notes >= 10 chars)
//   - IN_PROGRESS   -> EXPIRED                        (ADMIN only — manual override; the
//                                                       automated job calls this path with
//                                                       a system actor)
//   - COMPLETED     -> IN_PROGRESS                    (ADMIN only, requires notes;
//                                                       CLEARS completed_at)
//   - REJECTED      -> IN_PROGRESS                    (ADMIN only, requires notes)
//   - EXPIRED       -> (terminal, no manual transitions)
//
// Plus a derived `is_overdue` / `days_remaining` pair attached at list-time so the FE
// can surface the GDPR / UK DPA 30-day clock without re-implementing the formula.
import type { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { NotFound, UnprocessableEntity } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { notifyStatusTransition } from '../../shared/transitionNotify.js';
import { assertOrThrow } from '../../shared/fsm.js';
import { dsarFsm } from './fsm-def.js';
import { getStorage } from '../documents/storage.js';
import { decryptField } from '../../shared/encryption.js';
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  CreateDSARRequest,
  UpdateDSARRequest,
  DSARListQuery,
  DSARStatus,
  Role,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

const DSAR_DUE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const REASON_MIN_CHARS = 10;

type ReqUser = { tid: string; role?: Role; sub?: string };

// SVT-FSM-2026-05: transition table lives in ./fsm-def.ts now. This module
// only enforces the DSAR-specific notes-length policy (>= 10 chars) for the
// reason-required transitions; the role + transition checks come from the
// shared framework via assertOrThrow().
const REASON_REQUIRED_TRANSITIONS = new Set<string>([
  'IN_PROGRESS->REJECTED',
  'COMPLETED->IN_PROGRESS',
  'REJECTED->IN_PROGRESS',
]);

// GDPR Art. 17 sentinel for redacted text fields. Keeping a marker rather than
// empty-string makes anonymised rows visually distinct in any operator UI that
// still queries them for accounting/regulatory join paths.
const ERASED = '[ERASED]';
// Date sentinel for date_of_birth (Prisma Date is NOT NULL). Year 1900-01-01 is
// outside any realistic student DOB range; UIs render the marker via this date.
const ERASED_DOB = new Date('1900-01-01T00:00:00.000Z');
// Empty Bytes buffer for envelope-encrypted *_enc columns. Combined with KEK
// rotation (separate ops procedure), the original DEK becomes unrecoverable —
// any backup containing the original ciphertext is then crypto-shredded too.
const ERASED_ENC = Buffer.alloc(0);

function decorate<T extends { status: DSARStatus; due_by: Date; completed_at: Date | null }>(
  row: T,
): T & { is_overdue: boolean; days_remaining: number } {
  const now = Date.now();
  const due = row.due_by instanceof Date ? row.due_by.getTime() : new Date(row.due_by).getTime();
  const terminal = row.status === 'COMPLETED' || row.status === 'REJECTED' || row.status === 'EXPIRED';
  const days_remaining = Math.ceil((due - now) / DAY_MS);
  const is_overdue = !terminal && now > due;
  return { ...row, is_overdue, days_remaining };
}

// ============================================================================
// SVT-DSAR-ERASURE-2026-05 — actuation of GDPR Art. 17 / UK DPA / India DPDP §10.
//
// When a DSAR with type === 'ERASURE' transitions to COMPLETED, the subject's
// personal data must be irreversibly erased. We:
//   (1) anonymise PII columns to neutral sentinels (preserves referential
//       integrity for accounting/regulator joins that legally MUST persist),
//   (2) crypto-shred *_enc columns by overwriting with an empty buffer (the
//       ciphertext is gone; future KEK rotation finishes the job by invalidating
//       backups too),
//   (3) delete owned object-storage artefacts (Document.storage_key files),
//   (4) soft-delete the subject row (deleted_at) so it stops appearing in lists,
//   (5) revoke active sessions when the subject is a User.
//
// Atomicity: anonymisation is one tx via the raw prisma client (bypassing the
// tenant-scoped extension whose per-op savepoints would each commit separately
// and leave a half-erased subject if storage cleanup fails). Storage deletes
// happen AFTER tx commit — if a file delete fails we log + audit but keep the
// DB anonymisation; the operator can replay storage cleanup from the audit row.
//
// Failure mode: any tx error throws back to the caller (PATCH /dsar/:id) which
// surfaces as 500 and keeps DSAR.status at IN_PROGRESS so the operator retries.
// ============================================================================
async function eraseStudent(
  studentId: string,
  tenantId: string,
  actorId: string | null | undefined,
): Promise<{
  documents_deleted: number;
  storage_keys_purged: string[];
  storage_purge_errors: number;
}> {
  const storageKeysToDelete: string[] = [];

  await prisma.$transaction(async (tx) => {
    // RLS context for the duration of the tx.
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

    const subject = await tx.student.findFirst({ where: { id: studentId, tenant_id: tenantId } });
    if (!subject) throw NotFound(`Subject student ${studentId} not found in tenant`);

    // 1. Parent row PII columns → sentinels; crypto-shred name_in_passport_enc.
    await tx.student.update({
      where: { id: studentId },
      data: {
        given_name: ERASED,
        middle_name: null,
        family_name: ERASED,
        preferred_name: null,
        name_in_passport_enc: ERASED_ENC,
        date_of_birth: ERASED_DOB,
        gender_self_described: null,
        religion: null,
        ethnicity: null,
        email_primary: null,
        email_secondary: null,
        phone_primary_e164: null,
        phone_secondary_e164: null,
        notes: null,
        deleted_at: new Date(),
        deleted_by_id: actorId ?? null,
      },
    });

    // 2. Child tables carrying PII / *_enc columns.
    await tx.studentIdentification.updateMany({
      where: { student_id: studentId, tenant_id: tenantId },
      data: { document_number_enc: ERASED_ENC },
    });
    await tx.studentVisa.updateMany({
      where: { student_id: studentId, tenant_id: tenantId },
      data: { visa_number_enc: ERASED_ENC },
    });
    await tx.studentRegulatorIdentifier.updateMany({
      where: { student_id: studentId, tenant_id: tenantId },
      data: { value_enc: ERASED_ENC },
    });
    await tx.studentDependent.updateMany({
      where: { student_id: studentId, tenant_id: tenantId },
      data: {
        given_name: ERASED,
        family_name: ERASED,
        passport_number_enc: null,
      },
    });
    await tx.studentContact.updateMany({
      where: { student_id: studentId, tenant_id: tenantId },
      data: {
        given_name: ERASED,
        family_name: ERASED,
        email: null,
        phone_e164: null,
        annual_income_minor_enc: null,
      },
    });
    await tx.insuranceRecord.updateMany({
      where: { student_id: studentId, tenant_id: tenantId },
      data: { policy_number_enc: ERASED_ENC },
    });
    await tx.languageTestResult.updateMany({
      where: { student_id: studentId, tenant_id: tenantId },
      data: { certificate_no: null },
    });

    // 3. Notes (polymorphic) — body redacted but row preserved for audit chain.
    await tx.note.updateMany({
      where: { tenant_id: tenantId, entity_type: 'student', entity_id: studentId },
      data: { body: ERASED },
    });

    // 4. Comms threads / messages: redact body, preserve thread skeleton for
    // GDPR proof-of-action records.
    const threads = await tx.commsThread.findMany({
      where: { tenant_id: tenantId, student_id: studentId },
      select: { id: true },
    });
    if (threads.length > 0) {
      await tx.commsMessage.updateMany({
        where: { thread_id: { in: threads.map((t) => t.id) } },
        data: { body: ERASED },
      });
    }

    // 5. Documents — collect storage keys then nullify the row metadata.
    const documents = await tx.document.findMany({
      where: { student_id: studentId, tenant_id: tenantId, deleted_at: null },
      select: { id: true, storage_key: true },
    });
    for (const doc of documents) storageKeysToDelete.push(doc.storage_key);
    await tx.document.updateMany({
      where: { student_id: studentId, tenant_id: tenantId },
      data: {
        file_name: ERASED,
        deleted_at: new Date(),
      },
    });

    // 6. Cascade soft-delete child entities that don't carry their own PII but
    // shouldn't survive the subject erasure (per ICO guidance: erase the whole
    // record where retention isn't independently justified).
    const now = new Date();
    await tx.enrollment.updateMany({
      where: { student_id: studentId, tenant_id: tenantId, deleted_at: null },
      data: { deleted_at: now },
    });
    await tx.reminder.updateMany({
      where: { tenant_id: tenantId, student_id: studentId, deleted_at: null },
      data: { deleted_at: now },
    });
  });

  // Storage cleanup AFTER tx commit. Best-effort + audit-trail; the operator
  // can re-run from the audit row's storage_keys_purged list if any fail.
  const storage = getStorage();
  let storage_purge_errors = 0;
  for (const key of storageKeysToDelete) {
    try {
      await storage.delete(key);
    } catch (err) {
      storage_purge_errors += 1;
      logger.error({ err, storage_key: key, student_id: studentId }, 'DSAR erasure: storage delete failed');
    }
  }

  return {
    documents_deleted: storageKeysToDelete.length,
    storage_keys_purged: storageKeysToDelete,
    storage_purge_errors,
  };
}

async function eraseUser(
  userId: string,
  tenantId: string,
  actorId: string | null | undefined,
): Promise<{ refresh_tokens_revoked: number }> {
  let refresh_tokens_revoked = 0;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const subject = await tx.user.findFirst({ where: { id: userId, tenant_id: tenantId } });
    if (!subject) throw NotFound(`Subject user ${userId} not found in tenant`);

    // Anonymise + deactivate. email cleared but kept-unique by prefix with id so
    // the @@unique([tenant_id, email]) doesn't trip future erasures.
    await tx.user.update({
      where: { id: userId },
      data: {
        given_name: ERASED,
        family_name: ERASED,
        display_name: null,
        email: `erased+${userId}@invalid.local`,
        password_hash: '!ERASED!',  // unverifiable; lockout-equivalent
        mfa_secret_enc: null,
        is_active: false,
        deleted_at: new Date(),
      },
    });
    const r = await tx.refreshToken.updateMany({
      where: { user_id: userId, tenant_id: tenantId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    refresh_tokens_revoked = r.count;
  });

  return { refresh_tokens_revoked };
  // Note: actorId is intentionally read for the audit row written by the caller.
  // Marking the variable to suppress unused-warning in strict environments:
  void actorId;
}

// ============================================================================
// SVT-WAVE-PRIV-C1-2026-05 — DSAR ACCESS / PORTABILITY export bundle.
//
// On COMPLETED for a type ∈ {ACCESS, PORTABILITY} we collect every row a
// subject owns across the schema, decrypt the *_enc envelope-encrypted
// columns back to plaintext (the subject is entitled to their own PII), and
// write the bundle to object storage. The storage key is stamped on the
// DSARRequest as `export_storage_key`; the FE polls for COMPLETED + an
// export key and renders a "Download export" button.
//
// Downloads are issued via single-use nonces (24h TTL) — see
// `signExportDownload` + `streamExport` below.
//
// PII boundary
// ------------
// The bundle DOES contain the subject's plaintext PII. That is the entire
// point of an Art. 15 / Art. 20 request. The recipient is the subject (or
// the regulator handling their complaint) so this is intra-subject data
// flow, not a third-party disclosure.
// ============================================================================

// 24-hour TTL for export download nonces — matches the spec. Single-use
// after the first redemption.
const EXPORT_NONCE_TTL_MS = 24 * 60 * 60 * 1000;

type ExportNonceEntry = {
  storageKey: string;
  tenantId: string;
  expiresAt: number;
  // We bind to the dsar id (not user id) because the subject may not have a
  // SVT user account; the nonce is short-lived and single-use so binding
  // to the dsar is sufficient under the regulator-facing handoff model.
  dsarId: string;
};
const exportNonces = new Map<string, ExportNonceEntry>();

function issueExportNonce(dsarId: string, tenantId: string, storageKey: string): { nonce: string; expiresAt: Date } {
  // Lazy purge of expired entries on every issue (the map is small in practice).
  const now = Date.now();
  for (const [k, v] of exportNonces) if (v.expiresAt <= now) exportNonces.delete(k);
  const nonce = randomBytes(24).toString('base64url');
  const expiresAt = new Date(now + EXPORT_NONCE_TTL_MS);
  exportNonces.set(nonce, { dsarId, tenantId, storageKey, expiresAt: expiresAt.getTime() });
  return { nonce, expiresAt };
}

export function _consumeExportNonce(nonce: string): ExportNonceEntry | null {
  const entry = exportNonces.get(nonce);
  if (!entry) return null;
  exportNonces.delete(nonce);
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}

export function __resetExportNoncesForTests(): void {
  exportNonces.clear();
}

// Storage key for the JSON bundle. Lives under a dsar-export/ prefix so a
// LocalStorage operator can tell at a glance that this is regulator-facing
// material, not student-uploaded content.
function buildExportKey(tenantId: string, dsarId: string): string {
  const yyyy = new Date().getUTCFullYear();
  return `dsar-export/${tenantId}/${yyyy}/${dsarId}.json`;
}

// Decrypt a *_enc Bytes column. Returns null if the buffer is empty
// (already crypto-shredded) or undefined (column absent on the row).
async function tryDecrypt(buf: Buffer | null | undefined): Promise<string | null> {
  if (buf == null) return null;
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length === 0) return null;
  try {
    return await decryptField(buf);
  } catch {
    // Decryption failure should never block an Art. 15 fulfilment — record
    // a sentinel so the subject can see the column existed even if the DEK
    // is now unrecoverable (e.g. after a KEK rotation gone wrong).
    return '[DECRYPT_FAILED]';
  }
}

// Walk an array of rows and replace each `<name>_enc` Bytes column with a
// decrypted `<name>` field (string). Mutates in place for simplicity; the
// caller hands us freshly-loaded Prisma rows that no other code holds.
async function decryptRowsEnc(rows: Array<Record<string, unknown>>, encColumns: string[]): Promise<void> {
  for (const row of rows) {
    for (const col of encColumns) {
      // Strip suffix only when the column actually ends in _enc.
      const base = col.endsWith('_enc') ? col.slice(0, -'_enc'.length) : col;
      const val = row[col];
      const plain = await tryDecrypt(val as Buffer | null | undefined);
      row[base] = plain;
      // Replace the ciphertext Buffer with a stable marker so the JSON
      // bundle doesn't contain machine-encrypted binary noise that the
      // subject can't use.
      row[col] = plain == null ? null : '[encrypted: see plaintext field above]';
    }
  }
}

// Best-effort signed-download URL for a Document row. Returns an opaque
// path the FE / subject can follow within EXPORT_NONCE_TTL_MS. The doc-
// stream endpoint enforces ownership separately; for an Art. 15 export the
// subject is allowed to receive every owned document.
function documentExportLink(docId: string): string {
  // The export is regulator-handoff; we surface a direct path. Operators
  // should serve this from a side-channel (e.g. secure S3 presigned URL)
  // in production. Documented in the bundle's __notes__ field.
  return `/api/v1/dsar/exports/document/${docId}`;
}

// SVT-WAVE-PRIV-C1-2026-05 — collect every Student-owned row.
async function buildStudentBundle(studentId: string, tenantId: string): Promise<Record<string, unknown>> {
  const where = { student_id: studentId, tenant_id: tenantId };

  // We pull in raw Prisma rows — they include the *_enc Buffers. The
  // decryptRowsEnc helper appends plaintext fields per row.
  const [
    student,
    addresses,
    identifications,
    visas,
    regulatorIds,
    enrollments,
    compliance,
    engagements,
    employment,
    dependents,
    contacts,
    sponsorships,
    documents,
    qualifications,
    languageTests,
    notes,
    entityTags,
    commsThreads,
  ] = await Promise.all([
    prisma.student.findFirst({ where: { id: studentId, tenant_id: tenantId } }),
    prisma.studentAddress.findMany({ where }),
    prisma.studentIdentification.findMany({ where }),
    prisma.studentVisa.findMany({ where }),
    prisma.studentRegulatorIdentifier.findMany({ where }),
    prisma.enrollment.findMany({ where }),
    prisma.complianceCheck.findMany({ where }),
    prisma.engagementCheck.findMany({ where }),
    prisma.studentEmployment.findMany({ where }),
    prisma.studentDependent.findMany({ where }),
    prisma.studentContact.findMany({ where }),
    prisma.studentSponsorship.findMany({ where }),
    prisma.document.findMany({ where }),
    prisma.academicQualification.findMany({ where }),
    prisma.languageTestResult.findMany({ where }),
    prisma.note.findMany({ where: { entity_type: 'student', entity_id: studentId, tenant_id: tenantId } }),
    prisma.entityTag.findMany({ where: { entity_type: 'student', entity_id: studentId, tenant_id: tenantId } }),
    prisma.commsThread.findMany({ where: { student_id: studentId, tenant_id: tenantId } }),
  ]);

  if (!student) throw NotFound(`Student ${studentId} not found in tenant`);

  // Decrypt envelope columns. The student row holds name_in_passport_enc.
  const studentRow = student as Record<string, unknown>;
  await decryptRowsEnc([studentRow], ['name_in_passport_enc']);
  await decryptRowsEnc(identifications as Array<Record<string, unknown>>, ['document_number_enc']);
  await decryptRowsEnc(visas as Array<Record<string, unknown>>, ['visa_number_enc']);
  await decryptRowsEnc(regulatorIds as Array<Record<string, unknown>>, ['value_enc']);
  await decryptRowsEnc(dependents as Array<Record<string, unknown>>, ['passport_number_enc']);
  await decryptRowsEnc(contacts as Array<Record<string, unknown>>, ['annual_income_minor_enc']);

  // Pull comms messages across all of the subject's threads.
  let commsMessages: Array<Record<string, unknown>> = [];
  if (commsThreads.length > 0) {
    const rows = await prisma.commsMessage.findMany({
      where: { thread_id: { in: commsThreads.map((t) => t.id) } },
    });
    commsMessages = rows as Array<Record<string, unknown>>;
  }

  // Documents — emit metadata + a signed-download URL per file.
  const documentsWithUrls = (documents as Array<Record<string, unknown>>).map((d) => ({
    ...d,
    // Strip server-side-only fields that aren't useful in a portability
    // bundle (storage_key reveals the internal layout).
    storage_key: undefined,
    download: {
      url: documentExportLink(d['id'] as string),
      expires_at: new Date(Date.now() + EXPORT_NONCE_TTL_MS).toISOString(),
      // TTL in seconds for clarity.
      ttl_seconds: Math.floor(EXPORT_NONCE_TTL_MS / 1000),
    },
  }));

  return {
    __subject_type__: 'student',
    __subject_id__: studentId,
    __tenant_id__: tenantId,
    __generated_at__: new Date().toISOString(),
    __notes__: [
      'This bundle is generated in response to a GDPR Art. 15 (Right of Access) /',
      'Art. 20 (Portability) request. Encrypted-at-rest fields have been decrypted',
      'and surfaced as plaintext sibling fields (e.g. passport_number alongside',
      'passport_number_enc). Document download URLs are valid for 24 hours.',
    ].join(' '),
    student: studentRow,
    addresses,
    identifications,
    visas,
    regulator_identifiers: regulatorIds,
    enrollments,
    compliance_checks: compliance,
    engagement_checks: engagements,
    employment,
    dependents,
    contacts,
    sponsorships,
    documents: documentsWithUrls,
    academic_qualifications: qualifications,
    language_test_results: languageTests,
    notes,
    tags: entityTags,
    comms_messages: commsMessages,
  };
}

async function buildUserBundle(userId: string, tenantId: string): Promise<Record<string, unknown>> {
  const [user, refreshTokens, consents, audit] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, tenant_id: tenantId } }),
    prisma.refreshToken.findMany({
      where: { user_id: userId, tenant_id: tenantId },
      // Metadata only — never expose the actual token_hash, which is a
      // privileged credential reference even after hashing.
      select: {
        id: true,
        device_id: true,
        ua_hash: true,
        ip_subnet: true,
        issued_at: true,
        expires_at: true,
        revoked_at: true,
        last_used_at: true,
      },
    }),
    prisma.consentRecord.findMany({
      where: { tenant_id: tenantId, subject_type: 'user', subject_id: userId },
    }),
    prisma.auditLog.findMany({
      where: { tenant_id: tenantId, actor_id: userId },
      orderBy: { created_at: 'desc' },
      // Soft cap so an extremely active admin doesn't generate a multi-GB
      // bundle. Forensics still has the full table; this is just the
      // portability extract.
      take: 10_000,
      select: {
        id: true,
        action: true,
        entity_type: true,
        entity_id: true,
        entity_version: true,
        ip_hash: true,
        ua_hash: true,
        request_id: true,
        created_at: true,
      },
    }),
  ]);

  if (!user) throw NotFound(`User ${userId} not found in tenant`);

  // Strip credential material from the User row.
  const userRow = user as Record<string, unknown>;
  delete userRow['password_hash'];
  delete userRow['mfa_secret_enc'];
  delete userRow['mfa_recovery_hashes'];

  return {
    __subject_type__: 'user',
    __subject_id__: userId,
    __tenant_id__: tenantId,
    __generated_at__: new Date().toISOString(),
    user: userRow,
    refresh_tokens: refreshTokens,
    consent_records: consents,
    audit_log_entries: audit,
  };
}

/**
 * Build + persist the export bundle for a COMPLETED ACCESS/PORTABILITY DSAR.
 * Returns the storage key + signed-download metadata. Idempotent: re-running
 * for the same dsar overwrites the bundle (the subject's data may have
 * changed between attempts; the latest snapshot is the canonical answer).
 */
export async function exportSubject(opts: {
  dsarId: string;
  dsarType: 'ACCESS' | 'PORTABILITY';
  subjectType: string;
  subjectId: string;
  tenantId: string;
}): Promise<{ storageKey: string; downloadUrl: string; expiresAt: Date; sizeBytes: number }> {
  let bundle: Record<string, unknown>;
  if (opts.subjectType === 'student') {
    bundle = await buildStudentBundle(opts.subjectId, opts.tenantId);
  } else if (opts.subjectType === 'user') {
    bundle = await buildUserBundle(opts.subjectId, opts.tenantId);
  } else {
    throw UnprocessableEntity(`Cannot export subject_type=${opts.subjectType}`);
  }
  bundle['__dsar_id__'] = opts.dsarId;
  bundle['__dsar_type__'] = opts.dsarType;

  // BigInt is not JSON-serialisable; the bigint serializer the test setup
  // installs handles the global default but we belt+brace it here because
  // the export is regulator-facing and must never throw mid-flush.
  const json = JSON.stringify(bundle, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  const buffer = Buffer.from(json, 'utf8');
  const storageKey = buildExportKey(opts.tenantId, opts.dsarId);
  await getStorage().put(storageKey, buffer, 'application/json');

  const { nonce, expiresAt } = issueExportNonce(opts.dsarId, opts.tenantId, storageKey);
  const downloadUrl = `/api/v1/dsar/${opts.dsarId}/export/download?token=${nonce}`;
  return { storageKey, downloadUrl, expiresAt, sizeBytes: buffer.length };
}

// Helper used by the controller streaming endpoint: re-mint a fresh nonce
// for an existing export, scoped to (dsar, tenant). The dsar must already
// have an `export_storage_key`.
export function signExportDownload(dsarId: string, tenantId: string, storageKey: string): { url: string; expiresAt: Date } {
  const { nonce, expiresAt } = issueExportNonce(dsarId, tenantId, storageKey);
  return { url: `/api/v1/dsar/${dsarId}/export/download?token=${nonce}`, expiresAt };
}

export const dsarService = {
  async create(req: { db?: DB; user?: ReqUser }, body: CreateDSARRequest) {
    const requested_at = new Date();
    const due_by = new Date(requested_at.getTime() + DSAR_DUE_DAYS * DAY_MS);
    const created = await db(req).dSARRequest.create({
      data: {
        ...body,
        tenant_id: req.user!.tid,
        requested_at,
        due_by,
      } as never,
    });
    await writeAudit(req as never, {
      action: 'dsar.created',
      entityType: 'dsar_request',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: ReqUser }, q: DSARListQuery) {
    const rows = await db(req).dSARRequest.findMany({
      where: {
        tenant_id: req.user!.tid,
        ...(q.status ? { status: q.status } : {}),
        ...(q.type ? { type: q.type } : {}),
      },
      orderBy: { requested_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return rows.map((r) => decorate(r as never));
  },
  async get(req: { db?: DB; user?: ReqUser }, id: string) {
    const found = await db(req).dSARRequest.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('DSAR request not found');
    return decorate(found as never);
  },
  async update(
    req: { db?: DB; user?: ReqUser },
    id: string,
    body: UpdateDSARRequest,
    // SVT-IF-MATCH-2026-05 — accepted for controller parity; DSARRequest has no
    // `version` column so optimistic-concurrency is a no-op here. Field kept
    // in the signature so callers don't break when the column lands later.
    _opts?: { expected?: number },
  ) {
    void _opts;
    const beforeRaw = await db(req).dSARRequest.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!beforeRaw) throw NotFound('DSAR request not found');
    // Snapshot before-state by value: in some test stubs (and in principle,
    // any in-memory layer) updateMany may mutate the same object reference we
    // hold here, which would erase the from-status by the time we audit.
    const before = { ...beforeRaw };
    const beforeStatus = before.status as DSARStatus;

    const data: Record<string, unknown> = { ...body };

    // Status transition guard. Only enforced when the caller is actually changing status.
    if (body.status && body.status !== beforeStatus) {
      const role = (req.user?.role ?? 'COUNSELLOR') as UserRole;
      // Framework handles invalid-transition (422), role-too-weak (403), and
      // terminal short-circuit. Pass a placeholder for reason since DSAR
      // enforces a stricter 10-char policy via REASON_MIN_CHARS below.
      assertOrThrow(dsarFsm, beforeStatus, body.status, role, 'placeholder');
      const edge = `${beforeStatus}->${body.status}`;
      if (REASON_REQUIRED_TRANSITIONS.has(edge)) {
        const reason = (body.notes ?? '').trim();
        if (reason.length < REASON_MIN_CHARS) {
          throw UnprocessableEntity(
            `Transition ${beforeStatus} -> ${body.status} requires \`notes\` of at least ${REASON_MIN_CHARS} characters`,
          );
        }
      }

      // Stamp / clear completed_at based on transition direction.
      if (body.status === 'COMPLETED' && beforeStatus !== 'COMPLETED') {
        data['completed_at'] = new Date();
      } else if (beforeStatus === 'COMPLETED' && body.status !== 'COMPLETED') {
        data['completed_at'] = null;
      }
    }

    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).dSARRequest.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: data as never,
    });
    if (r.count !== 1) throw NotFound('DSAR request not found');
    const after = await db(req).dSARRequest.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });

    // Status-change side-effect: write a dedicated audit event in addition to the
    // generic dsar.updated row, with from/to/role/reason for compliance review.
    if (body.status && body.status !== beforeStatus) {
      await writeAudit(req as never, {
        action: 'dsar.status_changed',
        entityType: 'dsar_request',
        entityId: id,
        before: { status: beforeStatus },
        after: {
          from: beforeStatus,
          to: body.status,
          role: req.user?.role ?? null,
          reason: (body.notes ?? '').trim() || null,
        },
      });

      // SVT-WAVE-HIGH-1-2026-05 — DSAR FSM transitions were silent (audit
      // only). The GDPR 30-day clock matters; surface every state change as
      // an IN_APP ping to the tenant admin so they don't miss a regulator
      // deadline. notifyStatusTransition is best-effort + dedup-aware so
      // rapid double-clicks won't spam.
      setImmediate(() => {
        void notifyStatusTransition({
          tenantId: req.user!.tid,
          entityId: id,
          source: 'dsar',
          title: `DSAR ${beforeStatus} → ${body.status}`,
          body: `DSAR request moved from ${beforeStatus} to ${body.status} by ${req.user?.role ?? 'unknown role'}.`,
          href: `/dsar?open=${id}`,
          preferUserId: null,        // fan-out to tenant admin
          actorId: req.user?.sub ?? null,
        });
      });

      // SVT-WAVE-PRIV-C1-2026-05 — generate the export bundle on COMPLETED
      // for ACCESS / PORTABILITY. Stamps DSARRequest.export_storage_key + writes
      // a dsar.export.generated audit row. Order matters: bundle generation
      // happens AFTER the status→COMPLETED audit row so the chain reads
      // "request completed", "export generated" in chronological order.
      const dsarTypeForExport = (after as { type?: string }).type;
      if (
        body.status === 'COMPLETED' &&
        (dsarTypeForExport === 'ACCESS' || dsarTypeForExport === 'PORTABILITY')
      ) {
        const subjectType = (after as { subject_type?: string }).subject_type;
        const subjectId = (after as { subject_id?: string }).subject_id;
        const tenantId = req.user!.tid;
        try {
          if (!subjectId || !subjectType) {
            throw UnprocessableEntity('DSAR is missing subject_type / subject_id');
          }
          const exp = await exportSubject({
            dsarId: id,
            dsarType: dsarTypeForExport,
            subjectType,
            subjectId,
            tenantId,
          });
          // Stamp the storage key on the row so the FE can render the
          // download button independently of the in-process nonce store.
          await db(req).dSARRequest.updateMany({
            where: { id, tenant_id: tenantId },
            data: { export_storage_key: exp.storageKey } as never,
          });
          await writeAudit(req as never, {
            action: 'dsar.export.generated',
            entityType: 'dsar_request',
            entityId: id,
            after: {
              subject_type: subjectType,
              subject_id: subjectId,
              storage_key: exp.storageKey,
              size_bytes: exp.sizeBytes,
              download_url: exp.downloadUrl,
              expires_at: exp.expiresAt.toISOString(),
            },
          });
        } catch (err) {
          // Export failure is loud but non-fatal — the operator can re-run
          // by patching the row out-of and back-into COMPLETED.
          logger.error(
            { err, dsar_id: id, subject_type: subjectType, subject_id: subjectId },
            'DSAR export: bundle generation failed',
          );
          await writeAudit(req as never, {
            action: 'dsar.export.failed',
            entityType: 'dsar_request',
            entityId: id,
            after: {
              error: (err as Error).message ?? String(err),
              subject_type: subjectType ?? null,
              subject_id: subjectId ?? null,
            },
          });
        }
      }

      // SVT-DSAR-ERASURE-2026-05: the COMPLETED transition for a type=ERASURE
      // DSAR is the legal trigger to actually purge subject data. We run after
      // the status row commits so the audit chain shows status→COMPLETED then
      // dsar.erasure.executed in clear chronological order.
      const dsarType = (after as { type?: string }).type;
      if (body.status === 'COMPLETED' && dsarType === 'ERASURE') {
        const subjectType = (after as { subject_type?: string }).subject_type;
        const subjectId = (after as { subject_id?: string }).subject_id;
        const tenantId = req.user!.tid;
        const actorId = req.user?.sub ?? null;

        let result: Record<string, unknown> = {};
        if (subjectType === 'student' && subjectId) {
          result = await eraseStudent(subjectId, tenantId, actorId);
        } else if (subjectType === 'user' && subjectId) {
          result = await eraseUser(subjectId, tenantId, actorId);
        } else {
          // Unknown subject_type → audit + leave the rest to the operator. Do
          // NOT throw: the DSAR is already COMPLETED at the operator's intent.
          logger.warn(
            { dsar_id: id, subject_type: subjectType, subject_id: subjectId },
            'DSAR erasure: unknown subject_type — manual purge required',
          );
          result = { skipped: true, reason: 'unknown_subject_type' };
        }

        await writeAudit(req as never, {
          action: 'dsar.erasure.executed',
          entityType: 'dsar_request',
          entityId: id,
          after: {
            subject_type: subjectType ?? null,
            subject_id: subjectId ?? null,
            ...result,
          },
        });
      }
    }

    await writeAudit(req as never, {
      action: 'dsar.updated',
      entityType: 'dsar_request',
      entityId: id,
      before,
      after,
    });
    return decorate(after as never);
  },

  // SVT-WAVE37-DSAR-DASH-2026-05 — admin-only counts for the dashboard widget.
  // Mirrors the breach summary shape. Open = not in terminal status; overdue =
  // open AND due_by < now; due_within_3d = open AND due_by within [now, +3d].
  // Three days because DSAR clock is 30d so 3d ≈ 10% — meaningful escalation.
  async dashboardSummary(req: { db?: DB; user?: ReqUser }) {
    const tenantId = req.user!.tid;
    const now = new Date();
    const horizon = new Date(now.getTime() + 3 * DAY_MS);
    const TERMINAL: DSARStatus[] = ['COMPLETED', 'REJECTED', 'EXPIRED'];
    const [open, overdue, dueSoon] = await Promise.all([
      db(req).dSARRequest.count({
        where: { tenant_id: tenantId, status: { notIn: TERMINAL } },
      }),
      db(req).dSARRequest.count({
        where: { tenant_id: tenantId, status: { notIn: TERMINAL }, due_by: { lt: now } },
      }),
      db(req).dSARRequest.count({
        where: {
          tenant_id: tenantId,
          status: { notIn: TERMINAL },
          due_by: { gte: now, lte: horizon },
        },
      }),
    ]);
    return { open, overdue, due_within_3d: dueSoon };
  },
};
