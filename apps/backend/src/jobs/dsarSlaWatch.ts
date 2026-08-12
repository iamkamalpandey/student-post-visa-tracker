// SVT-WAVE-PRIV-C3-2026-05 — DSAR 30-day SLA watchdog.
//
// GDPR Art. 12(3) / UK DPA / India DPDP §5(2) all impose a 1-month
// (≈30-day) hard limit on DSAR responses. The intake controller stamps
// `due_by = requested_at + 30d` at create time, but until this job nothing
// actually transitioned a stalled request to EXPIRED — operators saw a red
// "overdue" chip but the regulator-visible status stayed at IN_PROGRESS.
//
// Daily at 07:00 UTC (just after the existing expiry-alerts pass at 06:00
// so dashboard counters reflect both signals together) we:
//   1. Find every non-terminal DSAR whose `due_by < now()`.
//   2. updateMany → status=EXPIRED. Filter on the non-terminal status set
//      so racing operator transitions can never be overwritten.
//   3. Write a `dsar.expired.auto` audit row per transitioned request.
//   4. Notify the tenant ADMIN via the existing IN_APP transitionNotify
//      lane so the bell badge fires.
//   5. Capture a Sentry signal at warning severity — auto-expiry is rare
//      and worth on-call eyeballs (operator missed the clock).
//
// Concurrency: the scheduler wraps this in runJob() which already takes
// the Postgres advisory lock. Within the run we update each row by
// (id, status NOT IN terminal) so a parallel /dsar PATCH that drives the
// row to COMPLETED in the same instant resolves as count=0 → audit is
// skipped, no duplicate notification. Idempotent re-run is a no-op.

import { DSARStatus } from '@prisma/client';
import { prismaAdmin } from '../config/db.js';
import { withTenantTx } from '../shared/tenantTx.js';
import { logger } from '../config/logger.js';
import { captureJobException } from '../config/sentry.js';
import { writeAudit } from '../shared/audit.js';
import { notifyStatusTransition } from '../shared/transitionNotify.js';

const TERMINAL_STATUSES: readonly DSARStatus[] = [
  DSARStatus.COMPLETED,
  DSARStatus.REJECTED,
  DSARStatus.EXPIRED,
] as const;

export type DsarSlaResult = {
  scanned: number;
  expired: number;
  errors: number;
};

export async function runDsarSlaWatch(opts: { nowOverride?: Date } = {}): Promise<DsarSlaResult> {
  const now = opts.nowOverride ?? new Date();
  const result: DsarSlaResult = { scanned: 0, expired: 0, errors: 0 };

  let candidates: Array<{ id: string; tenant_id: string; type: string; subject_id: string }> = [];
  try {
    // SVT-SEC-2026-08 (T0-7) — the discovery scan is cross-tenant by nature
    // (which tenants have an overdue request is not known until we look), so it
    // uses the admin client. On the GUC-less runtime singleton it returned an
    // EMPTY LIST under the production role, so this job logged "no overdue
    // requests" every run and no DSAR SLA breach was ever detected.
    //
    // The per-row WRITE below is tenant-scoped via withTenantTx — the scan finds
    // the work, the transaction does it under that tenant's policies.
    candidates = await prismaAdmin.dSARRequest.findMany({
      where: {
        status: { notIn: [...TERMINAL_STATUSES] },
        due_by: { lt: now },
      },
      select: { id: true, tenant_id: true, type: true, subject_id: true },
    });
  } catch (err) {
    result.errors += 1;
    logger.error({ err }, 'dsar.sla.watch: failed to load candidate rows');
    captureJobException(err, { job: 'dsar.sla.watch' });
    return result;
  }

  result.scanned = candidates.length;
  if (candidates.length === 0) {
    logger.debug({ now }, 'dsar.sla.watch: no overdue requests');
    return result;
  }

  for (const row of candidates) {
    try {
      // Race-safe: filter on non-terminal status so a concurrent operator
      // PATCH that just moved the row to COMPLETED resolves to count=0
      // (we don't audit / notify — the operator already did the right thing).
      const wr = await withTenantTx(row.tenant_id, async (tx) => tx.dSARRequest.updateMany({
        where: {
          id: row.id,
          tenant_id: row.tenant_id,
          status: { notIn: [...TERMINAL_STATUSES] },
        },
        data: { status: DSARStatus.EXPIRED },
      }));
      if (wr.count !== 1) {
        logger.info(
          { dsarId: row.id, tenantId: row.tenant_id },
          'dsar.sla.watch: row no longer non-terminal — skipping (race with operator)',
        );
        continue;
      }
      result.expired += 1;

      // Tamper-evident audit row. The standard dsar.status_changed action is
      // reserved for operator-driven transitions through the controller; we
      // use a distinct action so compliance review can filter the
      // auto-expirations and contrast them with operator-driven ones.
      await writeAudit({
        action: 'dsar.expired.auto',
        entityType: 'dsar_request',
        entityId: row.id,
        tenantId: row.tenant_id,
        actorId: null,
        after: {
          from: 'overdue_non_terminal',
          to: 'EXPIRED',
          reason: 'GDPR 30-day SLA breached; auto-expired by dsar.sla.watch',
          dsar_type: row.type,
          subject_id: row.subject_id,
        },
      });

      // IN_APP notification to the tenant admin. Fire-and-forget per the
      // notifyStatusTransition contract (best-effort; never throws).
      void notifyStatusTransition({
        tenantId: row.tenant_id,
        entityId: row.id,
        source: 'dsar',
        title: `DSAR auto-expired (30-day SLA missed)`,
        body: `DSAR request ${row.id.slice(0, 8)} (${row.type}) passed the 30-day GDPR deadline and was automatically marked EXPIRED. Review immediately.`,
        href: `/dsar?open=${row.id}`,
        preferUserId: null, // fan-out to tenant ADMIN
        actorId: null,
      });

      // Sentry: auto-expiry indicates an operator-side process failure
      // (request slipped through review). Warning severity so the
      // observability stack pages.
      captureJobException(
        new Error(`DSAR ${row.id} auto-expired after 30-day SLA breach`),
        { job: 'dsar.sla.watch', tenant_id: row.tenant_id },
        { dsar_id: row.id, dsar_type: row.type },
      );
    } catch (err) {
      result.errors += 1;
      logger.error(
        { err, dsarId: row.id, tenantId: row.tenant_id },
        'dsar.sla.watch: per-row expiry failed',
      );
      captureJobException(err, { job: 'dsar.sla.watch', tenant_id: row.tenant_id });
    }
  }

  logger.info(
    { scanned: result.scanned, expired: result.expired, errors: result.errors },
    'dsar.sla.watch pass complete',
  );
  return result;
}
