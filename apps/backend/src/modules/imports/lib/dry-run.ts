// Dry-run validator + counter for the bulk-import report endpoint.
//
// Walks the parsed-row stream, asks each per-resource importer "would this
// create or update?", and returns the totals + a 100-row error sample +
// the full error list (for the JSONL report file). Pulled out of
// imports.service.ts so the orchestrator stays focused on lifecycle.

import type { PrismaClient } from '@prisma/client';
import type { ImportResource } from '@spv/zod-schemas';
import { mapStudentRow } from '../mappers/students-mapper.js';
import { findExistingStudent } from '../entities/students-importer.js';
import { dryRunNonStudent } from '../entities/index.js';
import { applyMapping } from './header-mapper.js';

export type DryRunReportEntry = {
  row_number: number;
  field: string;
  value: unknown;
  error: string;
};

export type DryRunSummary = {
  willCreate: number;
  willUpdate: number;
  willSkip: number;
  errors: number;
  sample: DryRunReportEntry[];
  allErrors: DryRunReportEntry[];
};

export async function runDryRun(args: {
  resource: ImportResource;
  rows: Array<Record<string, unknown>>;
  mapping: Record<string, string>;
  tenantId: string;
  db: PrismaClient;
}): Promise<DryRunSummary> {
  const { resource, rows, mapping, tenantId, db } = args;
  let willCreate = 0;
  let willUpdate = 0;
  const willSkip = 0;
  let errors = 0;
  const sample: DryRunReportEntry[] = [];
  const allErrors: DryRunReportEntry[] = [];

  for (let i = 0; i < rows.length; i++) {
    const mapped = applyMapping(rows[i]!, mapping);
    if (resource === 'students') {
      const r = mapStudentRow(mapped);
      if (!r.ok) {
        errors++;
        for (const e of r.errors) {
          const entry: DryRunReportEntry = {
            row_number: i + 1,
            field: e.field,
            value: mapped[e.field],
            error: e.message,
          };
          allErrors.push(entry);
          if (sample.length < 100) sample.push(entry);
        }
        continue;
      }
      // Cheap "would-update vs would-create" probe: ExternalId match → update;
      // name match → update.
      const existing = await findExistingStudent(
        tenantId,
        r.value.name_in_passport,
        r.external_id,
        db,
      );
      if (existing) willUpdate++;
      else willCreate++;
      continue;
    }

    // institutions / programs / enrollments / program_fees: validate via mapper
    // and probe for an existing row to decide create vs update.
    const probe = await dryRunNonStudent(resource, mapped, { tenantId, db });
    if (!probe.ok) {
      errors++;
      for (const e of probe.errors) {
        const entry: DryRunReportEntry = {
          row_number: i + 1,
          field: e.field,
          value: mapped[e.field],
          error: e.message,
        };
        allErrors.push(entry);
        if (sample.length < 100) sample.push(entry);
      }
      continue;
    }
    if (probe.willUpdate) willUpdate++;
    else willCreate++;
  }

  return { willCreate, willUpdate, willSkip, errors, sample, allErrors };
}
