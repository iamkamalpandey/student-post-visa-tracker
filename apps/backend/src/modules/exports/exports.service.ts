// Export service: enqueue → run → signed download.
//
// v1 runs the worker inline (setImmediate) in the same process. v2 will hand `runExport(jobId)`
// to a BullMQ queue (Redis-backed) so a separate worker fleet can churn through long-running
// jobs without holding API process memory hostage. The function signature here is the
// natural job-payload boundary for that swap.

import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { getStorage } from '../documents/storage.js';
import { writeAudit } from '../../shared/audit.js';
import { Forbidden, NotFound, PayloadTooLarge } from '../../shared/errors.js';
import { writeCsv, writeJson, writeJsonl, writeXlsx } from './writers.js';
import type { CreateExportRequest } from '@spv/zod-schemas';
import { buildStudentListWhere } from '../students/students.service.js';

// ----------------------------------------------------------------------------
// PERF-AUDIT-P0-#3 — Buffered-export size cap.
//
// Background: runExport currently materialises the full export payload in
// memory before handing it to storage.put (which itself encrypts buffer-side).
// A 50k-row export trivially OOMs a 1 GB API process.
//
// v1 (this change): cap the export at EXPORT_MAX_BYTES. Enforced two ways —
//   (a) pre-flight in enqueueExport: estimate rows × avg-bytes-per-row using a
//       per-resource heuristic. If the projection exceeds the cap, reject with
//       413 + a `code: 'export_too_large'` so the FE can prompt the user to
//       add filters. No job row is written.
//   (b) hard runtime guard in the buffer loop: if the in-memory buffer grows
//       past the cap mid-write (heuristic was wrong), abort the worker, mark
//       FAILED, and never call storage.put.
//
// v1.1 follow-up (tracked separately): teach storage.put to accept a Readable
// (local fs: pipeline(data, createWriteStream); S3: sdk Upload). That removes
// the buffer entirely and lets us drop this cap. The blocker today is
// encrypt-at-rest, which operates buffer-side; per-chunk encryption is a
// non-trivial refactor and not justified for the v1 export volumes.
// ----------------------------------------------------------------------------
const EXPORT_MAX_BYTES = 100 * 1024 * 1024; // 100 MiB — buffer-mode safety cap.

// Per-resource average serialized row size. These are conservative upper
// bounds derived from the default-columns lists; the goal is "don't enqueue
// a job that is almost certainly going to OOM", not byte-perfect accounting.
// Numbers were sized so a 50k-row student export (~150 bytes/row average,
// pre-redaction) projects to ~7.5 MiB — well under the cap — while a 1M-row
// export projects to ~150 MiB and gets rejected.
const AVG_ROW_BYTES: Record<string, number> = {
  students: 320,
  institutions: 220,
  programs: 180,
  enrollments: 160,
  program_fees: 140,
};
const DEFAULT_AVG_ROW_BYTES = 256;

// Format multiplier accounts for per-row framing overhead (quotes/commas in
// CSV, JSON keys repeated on every row, etc). XLSX is shape-irrelevant here
// because the writer is a stub in v1.
const FORMAT_MULTIPLIER: Record<string, number> = {
  csv: 1.0,
  jsonl: 1.6, // {"col":"val",...}\n — keys repeated per row
  json: 1.6,
  xlsx: 1.0,
};

async function estimateExportBytes(
  tenantId: string,
  resource: string,
  filter: Record<string, unknown>,
  format: string,
): Promise<{ rowCount: number; estimatedBytes: number }> {
  let where: Record<string, unknown> = { tenant_id: tenantId, deleted_at: null };
  if (typeof filter['status'] === 'string') where['status'] = filter['status'];

  let rowCount = 0;
  if (resource === 'students') {
    // SVT-EXPORT-FILTER-2026-08 — estimate against the SAME predicate the
    // export will actually run. Counting the unfiltered tenant here would
    // reject a small filtered export as "too large", which is the mirror image
    // of the disclosure bug fixed in streamRows.
    const slaBreached = filter['sla_breached'] === true || filter['sla_breached'] === 'true';
    const ids = Array.isArray(filter['ids'])
      ? (filter['ids'] as unknown[]).filter((v): v is string => typeof v === 'string')
      : undefined;
    where = (await buildStudentListWhere(prisma as never, tenantId, {
      stage_id: typeof filter['stage_id'] === 'string' ? filter['stage_id'] : undefined,
      status: typeof filter['status'] === 'string' ? (filter['status'] as never) : undefined,
      assigned_to_id:
        typeof filter['assigned_to_id'] === 'string' ? filter['assigned_to_id'] : undefined,
      ...(slaBreached ? { sla_breached: true as const } : {}),
      search: typeof filter['search'] === 'string' ? filter['search'] : undefined,
      ...(ids && ids.length > 0 ? { ids } : {}),
    })) as Record<string, unknown>;
    rowCount = await prisma.student.count({ where: where as any });
  } else if (resource === 'institutions') {
    rowCount = await prisma.institution.count({ where: where as any });
  } else if (resource === 'programs') {
    rowCount = await prisma.program.count({ where: where as any });
  } else if (resource === 'enrollments') {
    rowCount = await prisma.enrollment.count({ where: where as any });
  } else if (resource === 'program_fees') {
    // ProgramFee — tenancy is reachable only via program_intake.program.
    // Mirror the where clause used by streamRows so the estimate matches
    // the eventual row set.
    rowCount = await prisma.programFee.count({
      where: { program_intake: { program: { tenant_id: tenantId, deleted_at: null } } } as any,
    });
  }

  const perRow = AVG_ROW_BYTES[resource] ?? DEFAULT_AVG_ROW_BYTES;
  const multiplier = FORMAT_MULTIPLIER[format] ?? 1.0;
  const estimatedBytes = Math.ceil(rowCount * perRow * multiplier);
  return { rowCount, estimatedBytes };
}

export const __PERF_AUDIT = {
  EXPORT_MAX_BYTES,
  AVG_ROW_BYTES,
  FORMAT_MULTIPLIER,
  estimateExportBytes,
};

export type ExportCtx = {
  tenantId: string;
  userId: string;
  role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
  ip?: string | null;
  ua?: string | null;
  requestId?: string | null;
};

// ----------------------------------------------------------------------------
// In-memory single-use download nonce store.
//
// Each completed export produces a signed-style URL containing `?nonce=<rand>`. The nonce
// has a 5-minute TTL and is invalidated on first successful read. v2: move into Redis with
// SETEX for cross-process scale.
// ----------------------------------------------------------------------------
// SVT-SEC-2026-05 — bind nonce to issuing user so a leaked URL can't be
// replayed by a different user in the same tenant. Auto-prune via per-mint
// setTimeout so the Map never grows unbounded (was a long-running-process
// memory leak before the cleanup was wired).
type Nonce = { jobId: string; tenantId: string; userId: string | null; expiresAt: number; used: boolean };
const nonces = new Map<string, Nonce>();
const NONCE_TTL_MS = 5 * 60 * 1000;

export function mintNonce(jobId: string, tenantId: string, userId?: string | null): string {
  const n = randomBytes(32).toString('base64url');
  nonces.set(n, {
    jobId,
    tenantId,
    userId: userId ?? null,
    expiresAt: Date.now() + NONCE_TTL_MS,
    used: false,
  });
  // Auto-expire so memory stays bounded under heavy export load.
  const t = setTimeout(() => { nonces.delete(n); }, NONCE_TTL_MS + 1_000);
  t.unref();
  return n;
}

export function consumeNonce(
  nonce: string,
  jobId: string,
  userId?: string | null,
): { ok: true; tenantId: string } | { ok: false } {
  const v = nonces.get(nonce);
  if (!v) return { ok: false };
  if (v.used) return { ok: false };
  if (v.expiresAt <= Date.now()) {
    nonces.delete(nonce);
    return { ok: false };
  }
  if (v.jobId !== jobId) return { ok: false };
  // SEC-burst: user binding when both sides supply it. If either side omitted
  // (legacy URLs created before this change), fall back to job+tenant binding
  // so we don't break in-flight downloads on rollout.
  if (v.userId && userId && v.userId !== userId) return { ok: false };
  v.used = true;
  return { ok: true, tenantId: v.tenantId };
}

// ----------------------------------------------------------------------------
// enqueueExport
// ----------------------------------------------------------------------------
export async function enqueueExport(ctx: ExportCtx, req: CreateExportRequest) {
  // PERF-AUDIT-P0-#3 — pre-flight buffer-mode cap. Reject the request before
  // we persist a job row so the caller gets a synchronous, actionable error
  // (413 + code: 'export_too_large') instead of a successful 202 followed by
  // an opaque FAILED job. v1.1 will drop this once storage.put can stream.
  const filter = (req.filter ?? {}) as Record<string, unknown>;
  const { rowCount, estimatedBytes } = await estimateExportBytes(
    ctx.tenantId,
    req.resource,
    filter,
    req.format,
  );
  if (estimatedBytes > EXPORT_MAX_BYTES) {
    const mib = (estimatedBytes / (1024 * 1024)).toFixed(1);
    const capMib = (EXPORT_MAX_BYTES / (1024 * 1024)).toFixed(0);
    throw PayloadTooLarge(
      `Export is too large for v1 buffered pipeline: estimated ${mib} MiB across ${rowCount} rows (cap ${capMib} MiB). Add filters (e.g. status, date range) to narrow the result set.`,
      'export_too_large',
    );
  }

  const job = await prisma.exportJob.create({
    data: {
      tenant_id: ctx.tenantId,
      resource: req.resource,
      format: req.format,
      filter_json: req.filter as Prisma.InputJsonValue,
      columns_json: req.columns ?? [],
      redact_pii: req.redact_pii,
      status: 'QUEUED',
      created_by_id: ctx.userId,
    },
  });

  await writeAudit({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    action: 'export.enqueued',
    entityType: 'ExportJob',
    entityId: job.id,
    after: { resource: req.resource, format: req.format, redact_pii: req.redact_pii },
    ip: ctx.ip ?? null,
    ua: ctx.ua ?? null,
    requestId: ctx.requestId ?? null,
  });

  // Fire-and-forget worker. We swallow errors because the job row itself records FAILED on
  // exception. v2: replace this setImmediate with `queue.add('export', { jobId: job.id })`.
  setImmediate(() => {
    runExport(job.id).catch(() => undefined);
  });

  return job;
}

// ----------------------------------------------------------------------------
// runExport
// ----------------------------------------------------------------------------
export async function runExport(jobId: string): Promise<void> {
  const job = await prisma.exportJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  await prisma.exportJob.updateMany({
    where: { id: jobId, tenant_id: job.tenant_id },
    data: { status: 'RUNNING' },
  });

  try {
    const tenantId = job.tenant_id;
    const resource = job.resource;
    const format = job.format as 'csv' | 'json' | 'jsonl' | 'xlsx';
    const columns =
      Array.isArray(job.columns_json) && job.columns_json.length > 0
        ? (job.columns_json as string[])
        : defaultColumns(resource);
    const filter = (job.filter_json ?? {}) as Record<string, unknown>;

    const ext = format;
    const storageKey = `exports/${tenantId}/${jobId}.${ext}`;
    const hash = createHash('sha256');

    const rowIter = streamRows(tenantId, resource, filter, columns, job.redact_pii);
    let total = 0;
    const counted = (async function* () {
      for await (const row of rowIter) {
        total++;
        yield row;
      }
    })();

    let stream;
    if (format === 'csv') {
      stream = writeCsv(counted, columns);
    } else if (format === 'jsonl') {
      stream = writeJsonl(counted);
    } else if (format === 'json') {
      stream = writeJson(counted);
    } else {
      stream = writeXlsx(counted, columns); // throws — caught below
    }

    // PERF-AUDIT-P0-#3 — buffer-mode hard guard. The pre-flight estimate in
    // enqueueExport catches the obvious cases, but per-row size varies wildly
    // (free-text notes, sparse columns, redaction toggles). If the running
    // buffer crosses EXPORT_MAX_BYTES the estimate was wrong; abort BEFORE
    // calling storage.put so we never hand a >100 MiB buffer to the encryptor.
    const chunks: Buffer[] = [];
    let bufferedBytes = 0;
    for await (const chunk of stream) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      hash.update(b);
      chunks.push(b);
      bufferedBytes += b.length;
      if (bufferedBytes > EXPORT_MAX_BYTES) {
        // Drop the (potentially large) chunk array before throwing so the
        // GC can reclaim it immediately instead of waiting for the catch
        // frame to unwind.
        chunks.length = 0;
        throw new Error(
          `Export exceeded buffer-mode cap (${EXPORT_MAX_BYTES} bytes) mid-write — estimate was wrong. Add filters and retry.`,
        );
      }
    }
    const buf = Buffer.concat(chunks);
    await getStorage().put(storageKey, buf, contentType(format));
    const sha = hash.digest('hex');

    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    await prisma.exportJob.updateMany({
      where: { id: jobId, tenant_id: job.tenant_id },
      data: {
        status: 'COMPLETED',
        storage_key: storageKey,
        sha256: sha,
        row_total: total,
        completed_at: new Date(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
  } catch (err) {
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    await prisma.exportJob.updateMany({
      where: { id: jobId, tenant_id: job.tenant_id },
      data: {
        status: 'FAILED',
        completed_at: new Date(),
      },
    });
    // Best-effort audit; don't rethrow because there is no caller to handle it.
    await writeAudit({
      tenantId: job.tenant_id,
      actorId: job.created_by_id,
      action: 'export.failed',
      entityType: 'ExportJob',
      entityId: jobId,
      after: { error: (err as Error).message },
    });
  }
}

// ----------------------------------------------------------------------------
// signedDownload
// ----------------------------------------------------------------------------
export async function signedDownload(ctx: ExportCtx, jobId: string) {
  const job = await prisma.exportJob.findFirst({
    where: { id: jobId, tenant_id: ctx.tenantId },
  });
  if (!job) throw NotFound('Export job not found');
  if (job.status !== 'COMPLETED') {
    return { url: null, expires_at: null, status: job.status };
  }
  const nonce = mintNonce(jobId, ctx.tenantId, ctx.userId ?? null);
  const url = `/api/v1/exports/${jobId}/download?nonce=${nonce}`;
  return { url, expires_at: new Date(Date.now() + NONCE_TTL_MS).toISOString(), status: job.status };
}

export async function getJob(ctx: ExportCtx, jobId: string) {
  const job = await prisma.exportJob.findFirst({
    where: { id: jobId, tenant_id: ctx.tenantId },
  });
  if (!job) throw NotFound('Export job not found');
  return job;
}

export async function cancelJob(ctx: ExportCtx, jobId: string) {
  const job = await getJob(ctx, jobId);
  if (job.created_by_id !== ctx.userId && ctx.role !== 'ADMIN') {
    throw Forbidden('Only the owner or an admin can cancel this export');
  }
  if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'EXPIRED') {
    return job;
  }
  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await prisma.exportJob.updateMany({
    where: { id: jobId, tenant_id: ctx.tenantId },
    data: { status: 'FAILED', completed_at: new Date() },
  });
  if (wr.count !== 1) throw NotFound('Export job not found');
  return prisma.exportJob.findFirstOrThrow({
    where: { id: jobId, tenant_id: ctx.tenantId },
  });
}

export async function streamFor(tenantId: string, jobId: string) {
  const job = await prisma.exportJob.findFirst({ where: { id: jobId, tenant_id: tenantId } });
  if (!job) throw NotFound('Export job not found');
  if (job.status !== 'COMPLETED' || !job.storage_key) throw NotFound('Export not ready');
  const buf = await getStorage().get(job.storage_key);
  return { job, buf };
}

// ----------------------------------------------------------------------------
// Internals
// ----------------------------------------------------------------------------
function contentType(fmt: string): string {
  switch (fmt) {
    case 'csv': return 'text/csv; charset=utf-8';
    case 'json': return 'application/json';
    case 'jsonl': return 'application/x-ndjson';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default: return 'application/octet-stream';
  }
}

function defaultColumns(resource: string): string[] {
  switch (resource) {
    case 'students':
      return [
        'id',
        'student_code',
        'given_name',
        'middle_name',
        'family_name',
        'preferred_name',
        'date_of_birth',
        'gender',
        'nationality_code',
        'primary_language',
        'email_primary',
        'phone_primary_e164',
        'status',
        'created_at',
      ];
    case 'institutions':
      return ['id', 'legal_name', 'display_name', 'type', 'country_code', 'is_partner', 'created_at'];
    case 'programs':
      return ['id', 'institution_id', 'name', 'level', 'duration_months', 'created_at'];
    case 'enrollments':
      return ['id', 'student_id', 'institution_id', 'program_id', 'status', 'start_date'];
    case 'program_fees':
      return ['id', 'program_intake_id', 'audience', 'fee_type', 'amount_minor', 'currency'];
    default:
      return [];
  }
}

/**
 * Stream rows from the database in pages, applying the redaction policy when requested.
 * Encrypted columns (`*_enc` Bytes) are never included in the output regardless of role —
 * the export pipeline must not leak ciphertext, and we don't decrypt PII for bulk export.
 */
async function* streamRows(
  tenantId: string,
  resource: string,
  filter: Record<string, unknown>,
  columns: string[],
  redactPii: boolean,
): AsyncIterable<Record<string, unknown>> {
  const PAGE = 500;
  let cursorId: string | null = null;
  while (true) {
    // SVT-SEC-2026-05 — soft-deleted rows MUST be excluded from exports.
    // Otherwise erasure-tombstoned subjects re-surface via the bulk pipeline,
    // defeating GDPR Art 17 + retention crons. tenant_id pinned to scope.
    let where: Record<string, unknown> = { tenant_id: tenantId, deleted_at: null };

    // SVT-EXPORT-FILTER-2026-08 — run the SAME predicate the list screen ran.
    //
    // This previously whitelisted `status` and silently dropped everything
    // else, so a counsellor who filtered the students list down to twelve
    // SLA-breached records and clicked "Export CSV" received a CSV of every
    // student in the tenant. No error, no warning, and the frontend told them
    // the file was "an exact representation of what the user sees on screen".
    // Exporting far more subject data than the operator asked for is a
    // disclosure problem, not just a wrong number.
    //
    // buildStudentListWhere is the exact builder /students uses, so the two
    // cannot drift apart again.
    if (resource === 'students') {
      const ids = Array.isArray(filter['ids'])
        ? (filter['ids'] as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined;
      const slaBreached = filter['sla_breached'] === true || filter['sla_breached'] === 'true';
      const studentWhere = await buildStudentListWhere(prisma as never, tenantId, {
        stage_id: typeof filter['stage_id'] === 'string' ? filter['stage_id'] : undefined,
        status: typeof filter['status'] === 'string' ? (filter['status'] as never) : undefined,
        assigned_to_id:
          typeof filter['assigned_to_id'] === 'string' ? filter['assigned_to_id'] : undefined,
        ...(slaBreached ? { sla_breached: true as const } : {}),
        search: typeof filter['search'] === 'string' ? filter['search'] : undefined,
        ...(ids && ids.length > 0 ? { ids } : {}),
      });
      where = studentWhere as Record<string, unknown>;
    } else if (typeof filter['status'] === 'string') {
      // Other resources still honour only `status`; their list screens do not
      // yet offer richer filters, so there is nothing to drift from.
      where['status'] = filter['status'];
    }

    // Keyset cursor. Added via AND so it cannot clobber an `id` predicate that
    // the filter builder may already have set (e.g. an explicit id selection).
    if (cursorId) {
      const existingAnd = Array.isArray(where['AND'])
        ? (where['AND'] as unknown[])
        : where['AND']
          ? [where['AND']]
          : [];
      where['AND'] = [...existingAnd, { id: { gt: cursorId } }];
    }

    let rows: unknown[] = [];
    if (resource === 'students') {
      rows = await prisma.student.findMany({
        where: where as any,
        orderBy: { id: 'asc' },
        take: PAGE,
      });
    } else if (resource === 'institutions') {
      rows = await prisma.institution.findMany({ where: where as any, orderBy: { id: 'asc' }, take: PAGE });
    } else if (resource === 'programs') {
      rows = await prisma.program.findMany({ where: where as any, orderBy: { id: 'asc' }, take: PAGE });
    } else if (resource === 'enrollments') {
      rows = await prisma.enrollment.findMany({ where: where as any, orderBy: { id: 'asc' }, take: PAGE });
    } else if (resource === 'program_fees') {
      // REGRESSION GUARD: ProgramFee has no direct tenant_id column; tenancy is
      // reachable only via program_intake.program.tenant_id. The previous
      // implementation dropped that filter entirely, which leaked every
      // tenant's fees through the export pipeline. Always join through the
      // relation chain so the per-tenant scope is preserved.
      // ProgramFee has no deleted_at; relation chain filters provide isolation.
      const feeWhere: Record<string, unknown> = {
        program_intake: { program: { tenant_id: tenantId, deleted_at: null } },
      };
      if (cursorId) feeWhere['id'] = { gt: cursorId };
      rows = await prisma.programFee.findMany({
        where: feeWhere as any,
        orderBy: { id: 'asc' },
        take: PAGE,
      });
    }
    if (rows.length === 0) break;

    for (const r of rows) {
      const obj = r as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const col of columns) {
        if (col.endsWith('_enc')) continue; // never export ciphertext
        let v = obj[col];
        if (redactPii) {
          if (col === 'email_primary' || col === 'email_secondary') v = redactEmail(v);
          else if (col === 'phone_primary_e164' || col === 'phone_secondary_e164') v = redactPhone(v);
          else if (col === 'passport_number' || col === 'visa_number' || col === 'sponsor_income') v = '[REDACTED]';
        }
        if (typeof v === 'bigint') v = v.toString(10);
        if (v instanceof Date) v = v.toISOString();
        out[col] = v ?? null;
      }
      yield out;
    }
    cursorId = String((rows[rows.length - 1] as { id: string }).id);
    if (rows.length < PAGE) break;
  }
}

function redactEmail(v: unknown): unknown {
  if (typeof v !== 'string' || !v) return v;
  const at = v.indexOf('@');
  if (at <= 1) return '***@***';
  return `${v[0]}***${v.slice(at)}`;
}

function redactPhone(v: unknown): unknown {
  if (typeof v !== 'string' || v.length < 4) return v;
  return `${v.slice(0, 3)}***${v.slice(-2)}`;
}
