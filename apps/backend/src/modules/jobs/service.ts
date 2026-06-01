// Read-only service for the background-job observability surface.
//
// Job runs are global (not tenant-scoped) — they describe scheduler activity
// that affects every tenant. Listing is therefore done via the unscoped
// singleton prisma client; access control happens at the route layer
// (`requireRole('ADMIN')`).
import { prisma } from '../../config/db.js';

import type { JobRunListQuery } from '@spv/zod-schemas';

export type JobRunDto = {
  id: string;
  job_name: string;
  started_at: string;
  finished_at: string | null;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'PARTIAL' | 'SKIPPED_LOCKED';
  rows_processed: number;
  rows_failed: number;
  error_message: string | null;
  metadata: unknown;
};

export async function listRecent(q: JobRunListQuery): Promise<JobRunDto[]> {
  const rows = await prisma.jobRun.findMany({
    where: q.job_name ? { job_name: q.job_name } : undefined,
    orderBy: { started_at: 'desc' },
    take: q.limit,
    select: {
      id: true,
      job_name: true,
      started_at: true,
      finished_at: true,
      status: true,
      rows_processed: true,
      rows_failed: true,
      error_message: true,
      metadata: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    job_name: r.job_name,
    started_at: r.started_at.toISOString(),
    finished_at: r.finished_at ? r.finished_at.toISOString() : null,
    status: r.status,
    rows_processed: r.rows_processed,
    rows_failed: r.rows_failed,
    error_message: r.error_message,
    metadata: r.metadata,
  }));
}
