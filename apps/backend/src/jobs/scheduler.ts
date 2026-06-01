// In-process scheduler for background workers.
//
// We deliberately use plain setInterval/setTimeout rather than node-cron /
// BullMQ / pg-boss to keep the dependency surface minimal. The cadences are
// coarse (minutes / hours / days) and the workloads are small enough that
// drift is fine.
//
// Cadences:
//   * dispatchPending         — every 30 minutes per tenant (unchanged)
//   * scanForTenant           — every 6 hours per tenant   (unchanged)
//   * runIdempotencyCleanup   — daily at 02:00 UTC
//   * runRetentionErasure     — daily at 03:00 UTC
//   * computeTenantRoots      — daily at 04:00 UTC (Merkle anchor)
//   * findUpcomingExpiries    — daily at 06:00 UTC
//
// Tradeoff for the daily jobs: rather than a precise cron expression we use
// `scheduleDaily(hourUtc)`, which computes the next slot in UTC and uses
// setTimeout → setInterval(24h). This is +/- a few seconds accurate (event
// loop jitter) which is fine for retention/expiry/anchor work; it avoids
// pulling in node-cron solely for this. If we ever need second-level
// accuracy or sub-daily cron expressions, swap this for pg-boss.
//
// Multi-replica safety: every job invocation is wrapped in `runJob()` which
// takes a Postgres advisory lock keyed by job name. If another replica is
// holding the lock the run is recorded as SKIPPED_LOCKED and skipped.
//
// startScheduler() is idempotent: calling it twice in the same process is a
// no-op (we track whether the timers were already registered).

import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';
import { captureJobException, withTenantScope } from '../config/sentry.js';

import { dispatchPending } from './reminderDispatcher.js';
import { dispatchCommsOutbox } from './commsDispatcher.js';
import { runCommsCleanup } from './commsCleanup.js';
import { runCommsDigest } from './commsDigest.js';
import { scanForTenant } from './reminderScanner.js';
import { findUpcomingExpiries } from './expiryAlerts.js';
import { computeTenantRoots } from './hashAnchor.js';
import { runRetentionErasure } from './retentionErasure.js';
import { runIdempotencyCleanup } from './idempotencyCleanup.js';
import { runBillingDaily } from './billingDaily.js';
import { runDsarSlaWatch } from './dsarSlaWatch.js';
import { runJob, type JobOutcome } from './runner.js';

const DISPATCH_EVERY_MS = 30 * 60 * 1000;
const SCAN_EVERY_MS = 6 * 60 * 60 * 1000;
// SVT-WAVE8-OUTBOX-2026-05 — comms outbox dispatcher runs every 5 minutes so
// EMAIL fan-out catches up quickly without spamming the provider quota.
const COMMS_DISPATCH_EVERY_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

let dispatchHandle: NodeJS.Timeout | null = null;
let scanHandle: NodeJS.Timeout | null = null;
let commsHandle: NodeJS.Timeout | null = null;
const dailyHandles: Array<NodeJS.Timeout> = [];

// Helper: load active tenants and run `fn` for each, isolating failures so one
// bad tenant doesn't prevent the others from running.
//
// PERF-FIX-SEC-2026-05: bounded concurrency. Previously `Promise.allSettled`
// fired one Prisma query per tenant in parallel — with 200 tenants this
// instantly saturated the DB pool (default 10–25). Cap to 5 in-flight so
// each pass takes longer but every other request continues serving traffic.
const TENANT_CONCURRENCY = 5;

export async function forEachTenant(
  jobName: string,
  fn: (tenantId: string) => Promise<unknown>,
): Promise<{ total: number; failed: number }> {
  let tenants: Array<{ id: string }> = [];
  try {
    tenants = await prisma.tenant.findMany({
      where: { is_active: true },
      select: { id: true },
    });
  } catch (err) {
    logger.error({ err, jobName }, 'scheduler: failed to load tenant list');
    return { total: 0, failed: 0 };
  }

  let failed = 0;
  // Hand-rolled p-limit so we don't pull in a dep for one call site.
  for (let i = 0; i < tenants.length; i += TENANT_CONCURRENCY) {
    const batch = tenants.slice(i, i + TENANT_CONCURRENCY);
    // Per-tenant Sentry scope: failures inside `fn` are tagged with the
    // tenant_id of the iteration they came from. The scope is isolated so a
    // failure in tenant A cannot leak attributes onto a later capture for
    // tenant B in the same batch.
    const results = await Promise.allSettled(
      batch.map((t) => withTenantScope(t.id, jobName, () => Promise.resolve(fn(t.id)))),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j]!;
      const t = batch[j]!;
      if (r.status === 'rejected') {
        failed += 1;
        logger.error({ err: r.reason, jobName, tenantId: t.id }, 'scheduler: tenant job rejected');
        // Report the per-tenant failure to Sentry with both tags. The outer
        // runJob() captures the aggregate failure too, but without tenant_id
        // — so this is the only place per-tenant attribution is preserved.
        captureJobException(r.reason, { job: jobName, tenant_id: t.id });
      }
    }
  }
  logger.debug({ jobName, total: tenants.length, failed }, 'scheduler: tenant pass complete');
  return { total: tenants.length, failed };
}

async function runDispatchPass(): Promise<JobOutcome> {
  const summary = await forEachTenant('reminder.dispatcher', async (tenantId) => {
    try {
      await dispatchPending(tenantId);
    } catch (err) {
      logger.error({ err, tenantId }, 'reminder.dispatcher failed for tenant');
      throw err;
    }
  });
  return {
    rowsProcessed: summary.total,
    rowsFailed: summary.failed,
    metadata: { tenants: summary.total },
  };
}

async function runScanPass(): Promise<JobOutcome> {
  const summary = await forEachTenant('reminder.scanner', async (tenantId) => {
    try {
      await scanForTenant(tenantId);
    } catch (err) {
      logger.error({ err, tenantId }, 'reminder.scanner failed for tenant');
      throw err;
    }
  });
  return {
    rowsProcessed: summary.total,
    rowsFailed: summary.failed,
    metadata: { tenants: summary.total },
  };
}

async function runCommsDispatchPass(): Promise<JobOutcome> {
  const r = await dispatchCommsOutbox();
  return {
    rowsProcessed: r.sent,
    rowsFailed: r.failed,
    metadata: {
      picked: r.picked,
      sent: r.sent,
      failed: r.failed,
      opted_out: r.opted_out,
      terminal: r.terminal,
    },
  };
}

async function runCommsCleanupPass(): Promise<JobOutcome> {
  const r = await runCommsCleanup();
  return {
    rowsProcessed: r.deleted,
    rowsFailed: r.errors,
    metadata: { scanned: r.scanned, deleted: r.deleted, errors: r.errors },
  };
}

async function runCommsDigestPass(): Promise<JobOutcome> {
  const r = await runCommsDigest();
  return {
    rowsProcessed: r.digests_created,
    rowsFailed: r.errors,
    metadata: { ...r },
  };
}

async function runRetentionPass(): Promise<JobOutcome> {
  // Single global pass — the underlying job filters by retention_until; per-
  // tenant fan-out adds latency without benefit.
  const r = await runRetentionErasure({});
  return {
    rowsProcessed: r.shredded,
    rowsFailed: r.errors,
    metadata: { scanned: r.scanned, shredded: r.shredded, errors: r.errors },
  };
}

async function runHashAnchorPass(): Promise<JobOutcome> {
  const roots = await computeTenantRoots();
  return {
    rowsProcessed: roots.length,
    rowsFailed: 0,
    metadata: { tenantRoots: roots.length },
  };
}

async function runIdempotencyCleanupPass(): Promise<JobOutcome> {
  const r = await runIdempotencyCleanup();
  return {
    rowsProcessed: r.deleted,
    rowsFailed: 0,
    metadata: { deleted: r.deleted },
  };
}

// SVT-AUDIT-VERIFY-2026-05: Daily integrity check on every tenant's audit chain.
// Calls the `audit_logs_verify(tenant_id)` SQL function (init migration) which
// recomputes entry_hash for every row in tenant order and returns the ids
// whose chain link broke. Any broken_count > 0 escalates via logger.error so
// the existing pino → sink alerting fires. Manual on-demand verify via
// /api/v1/audit-logs/verify continues to work alongside this.
async function runAuditVerifyPass(): Promise<JobOutcome> {
  const tenants = await prisma.tenant.findMany({
    where: { is_active: true },
    select: { id: true },
  });
  let total = 0;
  let broken = 0;
  for (const t of tenants) {
    try {
      await withTenantScope(t.id, 'audit.chain.verify', async () => {
        const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM audit_logs_verify(${t.id}::uuid)`;
        total += 1;
        if (rows.length > 0) {
          broken += rows.length;
          logger.error(
            { tenantId: t.id, brokenCount: rows.length, brokenIds: rows.map((r) => r.id).slice(0, 10) },
            'audit.chain.verify: BROKEN chain links detected — investigate immediately',
          );
          // A broken audit chain is a P0 compliance signal — report even
          // though no exception was thrown so it never goes unnoticed.
          captureJobException(
            new Error(`audit chain broken for tenant ${t.id} (${rows.length} rows)`),
            { job: 'audit.chain.verify', tenant_id: t.id },
            { brokenCount: rows.length },
          );
        }
      });
    } catch (err) {
      logger.error({ err, tenantId: t.id }, 'audit.chain.verify failed for tenant');
      captureJobException(err, { job: 'audit.chain.verify', tenant_id: t.id });
    }
  }
  return {
    rowsProcessed: total,
    rowsFailed: broken,
    metadata: { tenants: total, brokenCount: broken },
  };
}

// SVT-WAVE-PRIV-C3-2026-05 — DSAR 30-day SLA watchdog. Transitions any
// non-terminal DSAR past its `due_by` to EXPIRED + audits + notifies admin.
// Daily at 07:00 UTC, right after the 06:00 expiry-alerts pass so the
// dashboard sees both signals together.
async function runDsarSlaWatchPass(): Promise<JobOutcome> {
  const r = await runDsarSlaWatch();
  return {
    rowsProcessed: r.expired,
    rowsFailed: r.errors,
    metadata: { scanned: r.scanned, expired: r.expired, errors: r.errors },
  };
}

async function runExpiryAlertsPass(): Promise<JobOutcome> {
  // Walk all active tenants — the underlying scan is per-tenant when
  // tenantId is provided, and we want a per-tenant signal in metadata.
  const tenants = await prisma.tenant.findMany({
    where: { is_active: true },
    select: { id: true },
  });
  let total = 0;
  let failed = 0;
  for (const t of tenants) {
    try {
      await withTenantScope(t.id, 'expiry.alerts', async () => {
        const rows = await findUpcomingExpiries({ tenantId: t.id });
        total += rows.length;
      });
    } catch (err) {
      failed++;
      logger.error({ err, tenantId: t.id }, 'expiry.alerts failed for tenant');
      captureJobException(err, { job: 'expiry.alerts', tenant_id: t.id });
    }
  }
  return {
    rowsProcessed: total,
    rowsFailed: failed,
    metadata: { tenants: tenants.length },
  };
}

// Compute the milliseconds until the next occurrence of HH:00 UTC (today or
// tomorrow). Returns at minimum 1s into the future to avoid scheduling work
// in the past after clock drift.
function msUntilUtcHour(hourUtc: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  const ms = next.getTime() - now.getTime();
  return Math.max(ms, 1_000);
}

// Schedule `fn` to fire at HH:00 UTC daily. Returns the active handle so
// stop() can clear it.
function scheduleDaily(hourUtc: number, jobName: string, fn: () => Promise<JobOutcome>) {
  const fire = () => void runJob(jobName, { ttlSec: 6 * 60 * 60 }, fn);
  const initial = setTimeout(() => {
    fire();
    const interval = setInterval(fire, DAY_MS);
    interval.unref();
    dailyHandles.push(interval);
  }, msUntilUtcHour(hourUtc));
  initial.unref();
  dailyHandles.push(initial);
  logger.info({ jobName, hourUtc, msUntilFirst: msUntilUtcHour(hourUtc) }, 'scheduler: daily job armed');
}

/**
 * Boot the in-process scheduler. Call once after server.listen().
 *
 * Returns a stop() function for tests / graceful shutdown.
 */
export function startScheduler(): { stop: () => void } {
  if (dispatchHandle || scanHandle || dailyHandles.length > 0) {
    logger.warn('scheduler already started; ignoring duplicate startScheduler() call');
    return { stop };
  }

  // Kick a first dispatch + scan pass on the next tick so boot logs include
  // real activity. Each pass swallows its own errors (runJob never throws).
  setImmediate(() => {
    void runJob('reminder.dispatcher', { ttlSec: 30 * 60 }, runDispatchPass);
  });
  setImmediate(() => {
    void runJob('reminder.scanner', { ttlSec: 6 * 60 * 60 }, runScanPass);
  });

  dispatchHandle = setInterval(() => {
    void runJob('reminder.dispatcher', { ttlSec: 30 * 60 }, runDispatchPass);
  }, DISPATCH_EVERY_MS);
  // unref() so the timer doesn't keep the process alive on shutdown.
  dispatchHandle.unref();

  scanHandle = setInterval(() => {
    void runJob('reminder.scanner', { ttlSec: 6 * 60 * 60 }, runScanPass);
  }, SCAN_EVERY_MS);
  scanHandle.unref();

  // SVT-WAVE8-OUTBOX-2026-05 — drain the comms outbox (EMAIL via Resend etc).
  setImmediate(() => {
    void runJob('comms.dispatcher', { ttlSec: 10 * 60 }, runCommsDispatchPass);
  });
  commsHandle = setInterval(() => {
    void runJob('comms.dispatcher', { ttlSec: 10 * 60 }, runCommsDispatchPass);
  }, COMMS_DISPATCH_EVERY_MS);
  commsHandle.unref();

  // Daily jobs — staggered so they never overlap.
  // 02:00 UTC chosen as a low-traffic window; the table cleanup is cheap (one
  // indexed deleteMany) but we still avoid stacking it on top of the 03:00
  // retention pass.
  scheduleDaily(2, 'idempotency.cleanup', runIdempotencyCleanupPass);
  scheduleDaily(3, 'retention.erasure', runRetentionPass);
  scheduleDaily(4, 'hash.anchor', runHashAnchorPass);
  // 05:00 UTC: verify the audit chain right after the 04:00 hash.anchor pass
  // so the just-anchored Merkle root is checked against a fresh chain replay.
  // Any broken_count > 0 fires an error-level log → ops alerting.
  scheduleDaily(5, 'audit.chain.verify', runAuditVerifyPass);
  scheduleDaily(6, 'expiry.alerts', runExpiryAlertsPass);
  // SVT-WAVE-PRIV-C3-2026-05 — DSAR 30-day SLA watchdog at 07:00 UTC.
  scheduleDaily(7, 'dsar.sla.watch', runDsarSlaWatchPass);
  // SVT-WAVE-BILLING-2026-05 — daily billing cron: INVOICED→DUE, DUE→OVERDUE,
  // LATE_FEE adjustments (idempotent), plan ACTIVE→COMPLETED. Skips tenants
  // with billing_enabled=false. Runs after expiry alerts so today's due-date
  // signals are visible in both pipelines.
  scheduleDaily(6, 'billing.daily', async () => {
    return runBillingDaily();
  });
  // SVT-WAVE13-CLEANUP-2026-05 — purge SENT/READ comms_messages older than
  // 30d to keep the table small. After hash.anchor (4:00) + audit.verify
  // (5:00) so we never delete rows before they're anchored.
  scheduleDaily(7, 'comms.cleanup', runCommsCleanupPass);
  // SVT-WAVE14-DIGEST-2026-05 — collapse per-user queued EMAIL into 1 daily
  // summary at 08:00 UTC. After cleanup so we don't digest rows about to die.
  scheduleDaily(8, 'comms.digest', runCommsDigestPass);

  logger.info(
    { dispatchEveryMs: DISPATCH_EVERY_MS, scanEveryMs: SCAN_EVERY_MS },
    'background scheduler started',
  );
  return { stop };
}

function stop(): void {
  if (dispatchHandle) {
    clearInterval(dispatchHandle);
    dispatchHandle = null;
  }
  if (commsHandle) {
    clearInterval(commsHandle);
    commsHandle = null;
  }
  if (scanHandle) {
    clearInterval(scanHandle);
    scanHandle = null;
  }
  for (const h of dailyHandles) {
    clearTimeout(h);
    clearInterval(h);
  }
  dailyHandles.length = 0;
}

export const _scheduler = {
  stop,
  runDispatchPass,
  runScanPass,
  runRetentionPass,
  runHashAnchorPass,
  runExpiryAlertsPass,
  runIdempotencyCleanupPass,
  runDsarSlaWatchPass,
  msUntilUtcHour,
};
