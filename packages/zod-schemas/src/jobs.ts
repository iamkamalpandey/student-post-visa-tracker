// Zod schemas for the background-job observability API.
//
// Background jobs (reminder.dispatcher, reminder.scanner, expiry.alerts,
// hash.anchor, retention.erasure, ...) record one row per invocation in
// `job_runs`. This module exposes a small read-only surface so SREs / admins
// can poll `GET /api/v1/jobs/recent` to confirm jobs are running, succeeding,
// and processing the expected row counts.
//
// The table itself is written to only by the scheduler (via `recordRun`),
// never by an HTTP request, so we don't need Create/Update schemas here.

import { z } from 'zod';

import { Uuid } from './common.js';

// Mirrors prisma.JobRunStatus. Kept in sync manually because zod-schemas
// must not depend on @prisma/client.
export const JobRunStatusEnum = z.enum([
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'PARTIAL',
  'SKIPPED_LOCKED',
]);
export type JobRunStatus = z.infer<typeof JobRunStatusEnum>;

// Query params for GET /api/v1/jobs/recent.
//   - limit  : 1..100, default 20. The endpoint is intended for a small
//              "recent runs" widget on the admin dashboard, not pagination.
//   - job_name : optional exact-match filter, e.g. "reminder.dispatcher".
export const JobRunListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    job_name: z.string().min(1).max(120).optional(),
  })
  .strict();
export type JobRunListQuery = z.infer<typeof JobRunListQuery>;

// Response row. ISO-8601 string timestamps for cross-language friendliness.
// `metadata` is returned as-is — schedulers stash arbitrary per-job context
// (tenants processed, queue depth, etc.) so we don't enumerate keys.
export const JobRunRow = z.object({
  id: Uuid,
  job_name: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  status: JobRunStatusEnum,
  rows_processed: z.number().int().nonnegative(),
  rows_failed: z.number().int().nonnegative(),
  error_message: z.string().nullable(),
  metadata: z.unknown().nullable(),
});
export type JobRunRow = z.infer<typeof JobRunRow>;

export const JobRunListResponse = z.object({
  data: z.array(JobRunRow),
});
export type JobRunListResponse = z.infer<typeof JobRunListResponse>;
