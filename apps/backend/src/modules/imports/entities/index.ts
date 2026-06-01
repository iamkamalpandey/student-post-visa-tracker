// Dispatch helpers for the per-resource importers.
//
// The orchestrator (imports.service.ts) only needs to know "given a resource
// + a mapped row, what's the dryRun verdict / apply outcome?". This file
// keeps the resource → importer routing in one place so the orchestrator
// stays small.

import type { ImportResource } from '@spv/zod-schemas';
import * as institutions from './institutions-importer.js';
import * as programs from './programs-importer.js';
import * as enrollments from './enrollments-importer.js';
import * as programFees from './program-fees-importer.js';
import type {
  ApplyCtx,
  DryRunCtx,
  DryRunResult,
  MappedRow,
  NonStudentRowResult,
} from './types.js';

type NonStudentResource = Exclude<ImportResource, 'students'>;

const NON_STUDENT_IMPORTERS: Record<
  NonStudentResource,
  {
    dryRun: (mapped: MappedRow, ctx: DryRunCtx) => Promise<DryRunResult>;
    applyRow: (mapped: MappedRow, ctx: ApplyCtx) => Promise<NonStudentRowResult>;
  }
> = {
  institutions,
  programs,
  enrollments,
  program_fees: programFees,
};

export async function dryRunNonStudent(
  resource: ImportResource,
  mapped: MappedRow,
  ctx: DryRunCtx,
): Promise<DryRunResult> {
  if (resource === 'students') {
    return { ok: false, errors: [{ field: '(resource)', message: 'students dry-run is handled by the orchestrator' }] };
  }
  const importer = NON_STUDENT_IMPORTERS[resource];
  if (!importer) {
    return { ok: false, errors: [{ field: '(resource)', message: `unknown resource ${resource}` }] };
  }
  return importer.dryRun(mapped, ctx);
}

export async function applyNonStudentRow(
  resource: ImportResource,
  mapped: MappedRow,
  ctx: ApplyCtx,
): Promise<NonStudentRowResult> {
  if (resource === 'students') {
    return {
      row_number: ctx.rowNumber,
      status: 'failed',
      error: 'students apply is handled by the orchestrator',
    };
  }
  const importer = NON_STUDENT_IMPORTERS[resource];
  if (!importer) {
    return {
      row_number: ctx.rowNumber,
      status: 'skipped',
      error: `unknown resource ${resource}`,
    };
  }
  try {
    return await importer.applyRow(mapped, ctx);
  } catch (err) {
    return {
      row_number: ctx.rowNumber,
      status: 'failed',
      error: (err as Error).message ?? 'unknown error',
    };
  }
}

export type { ApplyCtx, DryRunCtx, DryRunResult, MappedRow, NonStudentRowResult };
