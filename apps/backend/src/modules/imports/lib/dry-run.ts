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

  const pushError = (entry: DryRunReportEntry) => {
    errors++;
    allErrors.push(entry);
    if (sample.length < 100) sample.push(entry);
  };

  // Empty-file guard: a 0-row file almost always means the wrong file, a bad
  // delimiter, or an unreadable encoding — not "nothing to do". Surface it
  // loudly instead of letting apply() report a silent success.
  if (rows.length === 0) {
    pushError({
      row_number: 0,
      field: '(file)',
      value: 0,
      error: 'Import file has no data rows. Check the file, delimiter, and encoding.',
    });
    return { willCreate, willUpdate, willSkip, errors, sample, allErrors };
  }

  // Within-file duplicate detection: two rows with the same dedupe key collide
  // on apply (idempotent upsert → later row silently overwrites the earlier).
  // Track the first row per key; flag every later collision so the operator
  // fixes the source rather than losing a row to last-write-wins.
  const seenKeys = new Map<string, number>();

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
      // Within-file duplicate: same ExternalId, else same name_in_passport.
      const dupKey = r.external_id
        ? `students|ext:${r.external_id}`
        : `students|name:${r.value.name_in_passport.trim().toLowerCase()}`;
      const firstAt = seenKeys.get(dupKey);
      if (firstAt !== undefined) {
        pushError({
          row_number: i + 1,
          field: r.external_id ? 'external_id' : 'name_in_passport',
          value: r.external_id ?? r.value.name_in_passport,
          error: `Duplicate of row ${firstAt} in this file — on apply the later row would overwrite the earlier.`,
        });
        continue;
      }
      seenKeys.set(dupKey, i + 1);

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
    const dupKey = `${resource}|${probe.dedupKey}`;
    const firstAt = seenKeys.get(dupKey);
    if (firstAt !== undefined) {
      pushError({
        row_number: i + 1,
        field: '(duplicate)',
        value: probe.dedupKey,
        error: `Duplicate of row ${firstAt} in this file — on apply the later row would overwrite the earlier.`,
      });
      continue;
    }
    seenKeys.set(dupKey, i + 1);
    if (probe.willUpdate) willUpdate++;
    else willCreate++;
  }

  return { willCreate, willUpdate, willSkip, errors, sample, allErrors };
}
