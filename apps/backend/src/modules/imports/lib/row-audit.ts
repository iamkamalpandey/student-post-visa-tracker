// Per-row audit emitter for the bulk-import orchestrator.
//
// Centralises the writeAudit() call so the apply loop can stay focused on
// counters + chunk control. Behaviour (action wording, after-payload shape)
// is identical to the pre-refactor inline calls.

import { writeAudit } from '../../../shared/audit.js';
import type { ImportResource } from '@spv/zod-schemas';

export type RowAuditCtx = {
  tenantId: string;
  userId: string;
  jobId: string;
  rowNumber: number;
  ip?: string | null;
  ua?: string | null;
  requestId?: string | null;
};

export async function writeStudentRowAudit(
  ctx: RowAuditCtx,
  outcome: { status: 'created' | 'updated' | 'failed'; id?: string; external_id?: string },
): Promise<void> {
  await writeAudit({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    action: `student.import.${outcome.status === 'updated' ? 'update' : 'create'}`,
    entityType: 'Student',
    entityId: outcome.id ?? ctx.rowNumber.toString(),
    after: {
      import_job_id: ctx.jobId,
      row_number: ctx.rowNumber,
      external_id: outcome.external_id,
    },
    ip: ctx.ip ?? null,
    ua: ctx.ua ?? null,
    requestId: ctx.requestId ?? null,
  });
}

export async function writeNonStudentRowAudit(
  ctx: RowAuditCtx,
  resource: ImportResource,
  outcome: { status: 'created' | 'updated' | 'skipped' | 'failed'; id?: string; entityType?: string },
): Promise<void> {
  await writeAudit({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    action: `${resource}.import.${outcome.status}`,
    entityType: outcome.entityType ?? resource,
    entityId: outcome.id ?? ctx.rowNumber.toString(),
    after: { import_job_id: ctx.jobId, row_number: ctx.rowNumber },
    ip: ctx.ip ?? null,
    ua: ctx.ua ?? null,
    requestId: ctx.requestId ?? null,
  });
}
