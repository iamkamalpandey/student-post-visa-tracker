// Shared types for the per-entity importers.
//
// Each importer takes a single mapped row (header → value, already aliased)
// plus a small ApplyCtx and returns a uniform NonStudentRowResult so the
// orchestrator can aggregate counts + write per-row audit + emit JSONL
// without caring which resource it just processed.

import type { PrismaClient } from '@prisma/client';

export type MappedRow = Record<string, unknown>;

export type ApplyCtx = {
  tenantId: string;
  userId: string;
  jobId: string;
  rowNumber: number;
  // Transaction-scoped Prisma client. The orchestrator wraps each 500-row
  // chunk in $transaction so a single bad row (or chunk-level failure)
  // rolls the entire chunk back, matching prior behaviour.
  tx: PrismaClient;
};

export type DryRunCtx = {
  tenantId: string;
  // Read-only Prisma client (the orchestrator passes the singleton here;
  // no writes are performed at dry-run time).
  db: PrismaClient;
};

export type NonStudentRowResult = {
  row_number: number;
  status: 'created' | 'updated' | 'skipped' | 'failed';
  id?: string;
  entityType?: string;
  error?: string;
};

export type DryRunResult =
  | { ok: true; willUpdate: boolean }
  | { ok: false; errors: Array<{ field: string; message: string }> };
