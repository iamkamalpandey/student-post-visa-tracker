// Bulk import / export schemas. Shared between FE + BE.
//
// Wire format intent:
//   - Imports: client uploads a file (CSV / JSON / JSONL / XLSX-stub) → server returns a job
//     with sniffed metadata + a suggested mapping. Client posts back a confirmed mapping to
//     /apply. Apply is idempotent via the standard Idempotency-Key header.
//   - Exports: client posts an export request (resource + format + filter + columns + flags),
//     server enqueues a job, then returns a signed download URL once COMPLETED.
//
// Standards:
//   - RFC 4180 for CSV (delimiter / quoting handled in writers/parsers).
//   - ISO 8601 for dates.
//   - RFC 8259 for JSON, JSONL streaming for large datasets.

import { z } from 'zod';
import { SafeWebhookUrl } from './common.js';

export const ImportResource = z.enum([
  'students',
  'institutions',
  'programs',
  'enrollments',
  'program_fees',
]);
export type ImportResource = z.infer<typeof ImportResource>;

export const ImportStatusEnum = z.enum([
  'UPLOADED',
  'PARSING',
  'VALIDATING',
  'DRY_RUN_READY',
  'APPLYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export type ImportStatusEnum = z.infer<typeof ImportStatusEnum>;

export const StartImportResponse = z.object({
  import_job_id: z.string(),
  status: ImportStatusEnum,
  sniffed_encoding: z.enum(['utf-8', 'unknown']),
  sniffed_delimiter: z.enum([',', ';', '\t', '|']).nullable(),
  header_sample: z.array(z.array(z.string())),
  suggested_mapping: z.record(z.string()),
});
export type StartImportResponse = z.infer<typeof StartImportResponse>;

export const ApplyImportRequest = z
  .object({
    mapping_json: z.record(z.string()),
    // SVT-WAVE-BLOCKER-5-2026-05 — SafeWebhookUrl forbids http://, IP
    // literals, localhost, .local/.internal, and cloud metadata hosts so a
    // tenant admin can't trick the future webhook dispatcher into SSRF.
    webhook_url: SafeWebhookUrl.optional(),
  })
  .strict();
export type ApplyImportRequest = z.infer<typeof ApplyImportRequest>;

export const ExportFormat = z.enum(['csv', 'xlsx', 'json', 'jsonl']);
export type ExportFormat = z.infer<typeof ExportFormat>;

export const ExportStatusEnum = z.enum([
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
]);
export type ExportStatusEnum = z.infer<typeof ExportStatusEnum>;

export const CreateExportRequest = z
  .object({
    resource: ImportResource,
    format: ExportFormat,
    filter: z.record(z.unknown()).default({}),
    columns: z.array(z.string()).optional(),
    redact_pii: z.boolean().default(true),
    locale: z.string().default('en'),
    timezone: z.string().default('UTC'),
  })
  .strict();
export type CreateExportRequest = z.infer<typeof CreateExportRequest>;

export const ExportJobResponse = z.object({
  id: z.string(),
  status: ExportStatusEnum,
  download_url: z.string().optional(),
  sha256: z.string().optional(),
  expires_at: z.string().optional(),
});
export type ExportJobResponse = z.infer<typeof ExportJobResponse>;
