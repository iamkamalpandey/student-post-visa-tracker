// Bulk-import service — orchestrator only.
//
// High-level lifecycle:
//   startImport()  → store source file, sniff, suggest mapping, persist ImportJob (DRY_RUN_READY)
//   getReport()    → re-parse + validate; return totals + sample errors + write JSONL report
//   apply()        → idempotent apply; chunked (500 rows/tx); per-row dedupe via ExternalId or
//                    a (tenant, name_in_passport) heuristic; writes per-row AuditLog correlated
//                    via the import_job_id placed in the audit `after` payload (the AuditLog
//                    schema has no native metadata column, so we co-locate the correlation
//                    inside the encrypted snapshot — verifiable via decryptJson).
//   cancel()       → flips to CANCELLED if not yet COMPLETED.
//   getStatus()    → re-reads the job row.
//   getResult()    → returns the JSONL of original-rows + new-IDs + per-row status.
//
// Idempotency is now DB-backed via the IdempotencyRecord model (see
// shared/idempotency.ts). This replaces the previous in-process Map, which broke
// across processes and lost cached results on a restart. Cross-process safety
// comes from the (tenant_id, scope, key) UNIQUE constraint.
//
// Refactor note (2026-05): per-resource INSERT/UPDATE blocks live in
// ./entities/<resource>-importer.ts. The orchestrator parses + maps + chunks
// + audits but no longer holds resource-specific Prisma calls. Behaviour is
// preserved bit-for-bit: same dedupe keys, same audit payload shape, same
// JSONL result format, same 500-row chunk size.

import { createHash, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { writeAudit } from '../../shared/audit.js';
import { prisma } from '../../config/db.js';
import { getStorage } from '../documents/storage.js';
import { BadRequest, NotFound, Conflict } from '../../shared/errors.js';
import { withIdempotency, SCOPE_IMPORTS_APPLY, type PrismaLike } from '../../shared/idempotency.js';
import { parseCsvStream, parseJsonStream, parseJsonlStream, sniffEncoding, sniffDelimiter } from './parsers.js';
import { applyRow as applyStudentRow } from './entities/students-importer.js';
import { applyNonStudentRow } from './entities/index.js';
import { applyMapping, suggestMapping } from './lib/header-mapper.js';
import { contentTypeFor, inferExt, parseByExt } from './lib/file-format.js';
import { writeNonStudentRowAudit, writeStudentRowAudit } from './lib/row-audit.js';
import { runDryRun } from './lib/dry-run.js';
import type { ImportResource, ApplyImportRequest } from '@spv/zod-schemas';
import type { PrismaClient } from '@prisma/client';

// Re-export for callers/tests that imported the suggester from this module
// before the lib/ split. Keeps the public surface unchanged.
export { suggestMapping };

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------
export type ImportCtx = {
  tenantId: string;
  userId: string;
  // SVT-SEC-2026-05 — role needed to gate cross-user import access.
  role?: 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
  ip?: string | null;
  ua?: string | null;
  requestId?: string | null;
};

export type StartImportArgs = {
  filename: string;
  buffer: Buffer;
};

// ----------------------------------------------------------------------------
// startImport
// ----------------------------------------------------------------------------
export async function startImport(
  ctx: ImportCtx,
  file: StartImportArgs,
  resource: ImportResource,
) {
  const ext = inferExt(file.filename);
  const sha256 = createHash('sha256').update(file.buffer).digest('hex');
  const jobId = randomUUID();
  const storageKey = `imports/${ctx.tenantId}/${jobId}/source.${ext}`;
  await getStorage().put(storageKey, file.buffer, contentTypeFor(ext));

  const sniffedEncoding = sniffEncoding(file.buffer);
  let headerSample: string[][] = [];
  let suggested: Record<string, string> = {};
  let delim: ',' | ';' | '\t' | '|' | null = null;

  if (sniffedEncoding === 'utf-8') {
    if (ext === 'csv') {
      // Inspect the first ~64KB so we don't decode 50MB to compute a 5-row sample.
      const head = file.buffer.subarray(0, Math.min(file.buffer.length, 64 * 1024)).toString('utf8');
      const firstLine = head.split(/\r?\n/, 1)[0] ?? '';
      delim = sniffDelimiter(firstLine);
      const rows: string[][] = [];
      // Re-use the streaming parser to extract the first 6 rows (header + 5 sample rows).
      const headerSeen: string[] = [];
      let count = 0;
      for await (const row of parseCsvStream(file.buffer, { delimiter: delim })) {
        if (headerSeen.length === 0) {
          for (const k of Object.keys(row)) headerSeen.push(k);
          rows.push(headerSeen);
        }
        rows.push(headerSeen.map((h) => row[h] ?? ''));
        count++;
        if (count >= 5) break;
      }
      headerSample = rows;
      suggested = suggestMapping(headerSeen, resource);
    } else if (ext === 'json' || ext === 'jsonl') {
      const it = ext === 'json' ? parseJsonStream(file.buffer) : parseJsonlStream(file.buffer);
      let count = 0;
      const headerSeen: string[] = [];
      for await (const row of it) {
        if (!row || typeof row !== 'object') continue;
        if (headerSeen.length === 0) {
          for (const k of Object.keys(row as Record<string, unknown>)) headerSeen.push(k);
          headerSample.push(headerSeen);
        }
        headerSample.push(headerSeen.map((h) => String((row as Record<string, unknown>)[h] ?? '')));
        count++;
        if (count >= 5) break;
      }
      suggested = suggestMapping(headerSeen, resource);
    }
  }

  const job = await prisma.importJob.create({
    data: {
      id: jobId,
      tenant_id: ctx.tenantId,
      resource,
      source_filename: file.filename,
      storage_key: storageKey,
      sha256,
      status: 'DRY_RUN_READY',
      mapping_json: suggested,
      created_by_id: ctx.userId,
    },
  });

  await writeAudit({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    action: 'import.started',
    entityType: 'ImportJob',
    entityId: job.id,
    after: { resource, filename: file.filename, sha256, import_job_id: job.id },
    ip: ctx.ip ?? null,
    ua: ctx.ua ?? null,
    requestId: ctx.requestId ?? null,
  });

  return {
    import_job_id: job.id,
    status: job.status,
    sniffed_encoding: sniffedEncoding,
    sniffed_delimiter: delim,
    header_sample: headerSample,
    suggested_mapping: suggested,
  };
}

// ----------------------------------------------------------------------------
// getStatus / getReport / cancel
// ----------------------------------------------------------------------------
export async function getStatus(ctx: ImportCtx, jobId: string) {
  const job = await prisma.importJob.findFirst({
    where: { id: jobId, tenant_id: ctx.tenantId },
  });
  if (!job) throw NotFound('Import job not found');
  // SVT-SEC-2026-05 — import payloads often contain unmasked student PII.
  // Counsellors must not read another counsellor's import job (incl. its
  // result.jsonl / errors.jsonl). ADMIN bypasses for tenant-wide oversight.
  if (ctx.role && ctx.role !== 'ADMIN' && job.created_by_id !== ctx.userId) {
    throw NotFound('Import job not found');
  }
  return job;
}

export type ReportSampleError = { row_number: number; field: string; value: unknown; error: string };

export async function getReport(ctx: ImportCtx, jobId: string) {
  const job = await getStatus(ctx, jobId);
  const buf = await getStorage().get(job.storage_key);
  const ext = inferExt(job.source_filename);
  const rows = await parseByExt(buf, ext);
  const mapping = (job.mapping_json as Record<string, string>) ?? {};

  // Use the singleton client for the report-time lookups; the report endpoint
  // is a pure read of pre-validated rows + a few cheap probe queries.
  const summary = await runDryRun({
    resource: job.resource as ImportResource,
    rows,
    mapping,
    tenantId: ctx.tenantId,
    db: prisma as unknown as PrismaClient,
  });

  // Persist the JSONL error report (for /errors.jsonl).
  // Defence-in-depth: pin the updates to (id, tenant_id) via updateMany so
  // even a future caller that bypasses getStatus() can't touch a sibling
  // tenant's job.
  const data: { row_total: number; error_report_key?: string } = { row_total: rows.length };
  if (summary.allErrors.length > 0) {
    const lines = summary.allErrors.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const errKey = `imports/${ctx.tenantId}/${jobId}/errors.jsonl`;
    await getStorage().put(errKey, Buffer.from(lines, 'utf8'), 'application/x-ndjson');
    data.error_report_key = errKey;
  }
  const r = await prisma.importJob.updateMany({
    where: { id: jobId, tenant_id: ctx.tenantId },
    data,
  });
  if (r.count !== 1) throw NotFound('Import job not found');

  return {
    totals: {
      will_create: summary.willCreate,
      will_update: summary.willUpdate,
      will_skip: summary.willSkip,
      errors: summary.errors,
    },
    sample_errors: summary.sample,
  };
}

export async function cancel(ctx: ImportCtx, jobId: string) {
  const job = await getStatus(ctx, jobId);
  if (job.status === 'COMPLETED') throw Conflict('Cannot cancel a completed job');
  // Defence-in-depth: pin the update to (id, tenant_id) so the write is
  // tenant-scoped even if a future code path skips getStatus().
  const r = await prisma.importJob.updateMany({
    where: { id: jobId, tenant_id: ctx.tenantId },
    data: { status: 'CANCELLED', completed_at: new Date() },
  });
  if (r.count !== 1) throw NotFound('Import job not found');
  const updated = await prisma.importJob.findFirstOrThrow({
    where: { id: jobId, tenant_id: ctx.tenantId },
  });
  await writeAudit({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    action: 'import.cancelled',
    entityType: 'ImportJob',
    entityId: jobId,
    after: { import_job_id: jobId, prior_status: job.status },
    ip: ctx.ip ?? null,
    ua: ctx.ua ?? null,
    requestId: ctx.requestId ?? null,
  });
  return updated;
}

// ----------------------------------------------------------------------------
// apply
// ----------------------------------------------------------------------------
export type ApplyOpts = {
  idempotencyKey: string;
};

export async function apply(
  ctx: ImportCtx,
  jobId: string,
  body: ApplyImportRequest,
  opts: ApplyOpts,
  req: Request,
) {
  // Prefer the RLS-scoped client attached by tenantContext middleware so all
  // idempotency_records reads/writes carry the correct app.tenant_id GUC.
  // Fall back to the singleton for code paths that don't go through HTTP.
  const db: PrismaLike = (req.db as unknown as PrismaLike) ?? (prisma as unknown as PrismaLike);

  // Canonical hash of the request: jobId + body. Anything else (headers, IP)
  // is intentionally excluded so a legit retry from a different host still
  // replays the cached result.
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ jobId, body }))
    .digest('hex');

  const result = await withIdempotency<ApplyResultBody>(
    {
      db,
      tenantId: ctx.tenantId,
      scope: SCOPE_IMPORTS_APPLY,
      key: opts.idempotencyKey,
      requestHash,
    },
    () => doApply(ctx, jobId, body),
  );
  return result.body;
}

type ApplyResultBody = {
  job: unknown;
  totals: { processed: number; created: number; updated: number; skipped: number; failed: number };
};

async function doApply(
  ctx: ImportCtx,
  jobId: string,
  body: ApplyImportRequest,
): Promise<{ status: number; body: ApplyResultBody }> {
  const job = await getStatus(ctx, jobId);
  if (job.status === 'CANCELLED' || job.status === 'COMPLETED') {
    throw Conflict(`Cannot apply a job in status ${job.status}`);
  }

  const buf = await getStorage().get(job.storage_key);
  const ext = inferExt(job.source_filename);
  const rows = await parseByExt(buf, ext);
  const mapping = body.mapping_json;

  // Empty-file guard: refuse to flip a 0-row upload to COMPLETED (silent no-op).
  // Status is still DRY_RUN_READY here (the APPLYING flip is below), so the
  // operator can re-upload the correct file. Mirrors the dry-run report check.
  if (rows.length === 0) {
    throw BadRequest('Import file has no data rows. Check the file, delimiter, and encoding.');
  }

  // Defence-in-depth: pin update to (id, tenant_id) via updateMany.
  {
    const r = await prisma.importJob.updateMany({
      where: { id: jobId, tenant_id: ctx.tenantId },
      data: {
        status: 'APPLYING',
        started_at: new Date(),
        mapping_json: mapping,
        webhook_url: body.webhook_url ?? null,
        row_total: rows.length,
      },
    });
    if (r.count !== 1) throw NotFound('Import job not found');
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;

  // Per-row result for the JSONL result file.
  const results: Array<{ row_number: number; status: string; id?: string; external_id?: string; error?: string }> = [];

  const CHUNK = 500;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, rows.length);
    const slice = rows.slice(start, end);
    try {
      await prisma.$transaction(async (tx) => {
        const txClient = tx as unknown as PrismaClient;
        for (let k = 0; k < slice.length; k++) {
          const rowNumber = start + k + 1;
          const raw = slice[k]!;
          const mapped = applyMapping(raw, mapping);

          const auditCtx = {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            jobId,
            rowNumber,
            ip: ctx.ip ?? null,
            ua: ctx.ua ?? null,
            requestId: ctx.requestId ?? null,
          };

          if (job.resource === 'students') {
            const outcome = await applyStudentRow(mapped, {
              tenantId: ctx.tenantId,
              userId: ctx.userId,
              jobId,
              rowNumber,
              tx: txClient,
            });
            if (outcome.status === 'created') created++;
            else if (outcome.status === 'updated') updated++;
            else if (outcome.status === 'failed') failed++;
            results.push(outcome);
            if (outcome.status !== 'failed') {
              await writeStudentRowAudit(auditCtx, outcome);
              processed++;
            }
            continue;
          }

          const outcome = await applyNonStudentRow(job.resource as ImportResource, mapped, {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            jobId,
            rowNumber,
            tx: txClient,
          });
          if (outcome.status === 'created') created++;
          else if (outcome.status === 'updated') updated++;
          else if (outcome.status === 'skipped') skipped++;
          else if (outcome.status === 'failed') failed++;
          results.push(outcome);
          if (outcome.status !== 'failed') {
            await writeNonStudentRowAudit(auditCtx, job.resource as ImportResource, outcome);
          }
          processed++;
        }
      });
    } catch (err) {
      // Rollback for this chunk only — count every row in the slice as failed and continue.
      failed += slice.length;
      for (let k = 0; k < slice.length; k++) {
        results.push({
          row_number: start + k + 1,
          status: 'failed',
          error: `chunk failed: ${(err as Error).message}`,
        });
      }
    }

    // Persist running counters so /status is live.
    // Defence-in-depth: pin to (id, tenant_id) via updateMany.
    const r = await prisma.importJob.updateMany({
      where: { id: jobId, tenant_id: ctx.tenantId },
      data: {
        row_processed: processed,
        row_created: created,
        row_updated: updated,
        row_skipped: skipped,
        row_failed: failed,
      },
    });
    if (r.count !== 1) throw NotFound('Import job not found');
  }

  // Build and persist the result JSONL.
  const resultLines = results.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const resultKey = `imports/${ctx.tenantId}/${jobId}/result.jsonl`;
  await getStorage().put(resultKey, Buffer.from(resultLines, 'utf8'), 'application/x-ndjson');

  // Defence-in-depth: pin to (id, tenant_id) via updateMany then re-read.
  {
    const r = await prisma.importJob.updateMany({
      where: { id: jobId, tenant_id: ctx.tenantId },
      data: {
        status: 'COMPLETED',
        completed_at: new Date(),
        result_key: resultKey,
      },
    });
    if (r.count !== 1) throw NotFound('Import job not found');
  }
  const finalJob = await prisma.importJob.findFirstOrThrow({
    where: { id: jobId, tenant_id: ctx.tenantId },
  });

  const responseBody: ApplyResultBody = {
    job: finalJob,
    totals: {
      processed,
      created,
      updated,
      skipped,
      failed,
    },
  };
  return { status: 200, body: responseBody };
}

export async function getResult(ctx: ImportCtx, jobId: string): Promise<Buffer> {
  const job = await getStatus(ctx, jobId);
  if (!job.result_key) throw NotFound('Result not yet available');
  return getStorage().get(job.result_key);
}

export async function getErrors(ctx: ImportCtx, jobId: string): Promise<Buffer> {
  const job = await getStatus(ctx, jobId);
  if (!job.error_report_key) return Buffer.from('', 'utf8');
  return getStorage().get(job.error_report_key);
}

// Re-exported for tests / controller use.
export { BadRequest };
