// Reminder dispatcher — turns PENDING Reminder rows into IN_APP CommsMessage
// rows for the assigned admin/counsellor. Polled on a fixed cadence by
// jobs/scheduler.ts; safe to call concurrently because each row's status flip
// is wrapped in an updateMany guard so two workers can't double-dispatch.
//
// We deliberately do NOT use SKIP LOCKED — Prisma doesn't expose it
// natively and the updateMany(where: { id, status: 'PENDING' }) idiom is
// equivalent for our purposes (the second worker's update touches 0 rows).

import { Prisma, type PrismaClient } from '@prisma/client';

import { logger } from '../config/logger.js';
import { captureJobException } from '../config/sentry.js';
import { withTenantTx } from '../shared/tenantTx.js';

const JOB_NAME = 'reminder.dispatcher';

type DB = PrismaClient;

const BATCH_LIMIT = 200;

// Cache the per-tenant fallback admin id so we don't issue an extra query
// every dispatch loop. The scanner uses the same lookup; both caches are
// refreshed on process restart (cheap given the cadence).
const fallbackAdminCache = new Map<string, string | null>();

async function fallbackAdminFor(tenantId: string, db?: DB): Promise<string | null> {
  if (fallbackAdminCache.has(tenantId)) return fallbackAdminCache.get(tenantId)!;
  // SVT-SEC-2026-08 (T0-7) — `users` is RLS-scoped, so this lookup needs the
  // tenant GUC. Without it every tenant resolved to "no fallback admin" and
  // unassigned reminders had nowhere to go.
  const admin = db
    ? await db.user.findFirst({
        where: { tenant_id: tenantId, role: 'ADMIN', is_active: true, deleted_at: null },
        orderBy: { created_at: 'asc' },
        select: { id: true },
      })
    : await withTenantTx(tenantId, async (tx) => tx.user.findFirst({
        where: { tenant_id: tenantId, role: 'ADMIN', is_active: true, deleted_at: null },
        orderBy: { created_at: 'asc' },
        select: { id: true },
      }));
  const id = admin?.id ?? null;
  fallbackAdminCache.set(tenantId, id);
  return id;
}

/** Test hook — flushes the per-tenant fallback admin cache. */
export function _clearFallbackCache() {
  fallbackAdminCache.clear();
}

export type DispatchResult = {
  tenantId: string;
  picked: number;
  sent: number;
  failed: number;
  skipped: number; // PENDING but no usable recipient/thread, marked SENT to prevent retry
};

/**
 * Process up to BATCH_LIMIT pending reminders for one tenant. Each row is
 * handled in its own try/catch so a single failure can't halt the batch.
 *
 * @param tenantId Tenant whose reminders we want to dispatch.
 * @param db Optional Prisma client override (mainly for tests). Uses the
 *           singleton when omitted.
 * @param nowOverride Optional clock override (tests).
 */
export async function dispatchPending(
  tenantId: string,
  db?: DB,
  nowOverride?: Date,
): Promise<DispatchResult> {
  const now = nowOverride ?? new Date();
  const result: DispatchResult = { tenantId, picked: 0, sent: 0, failed: 0, skipped: 0 };

  const fallbackAdmin = await fallbackAdminFor(tenantId, db);

  // Find-or-create a comms thread for (channel, threadStudentId). When
  // threadStudentId is null (SVT-V2-TRACKER tracked-fee reminders) we key the
  // synthetic per-tenant thread by subject so all such reminders share one.
  async function findOrCreateThread(
    tx: Prisma.TransactionClient,
    channel: 'IN_APP' | 'EMAIL',
    threadStudentId: string | null,
    subject: string,
  ): Promise<{ id: string }> {
    const existing = await tx.commsThread.findFirst({
      where: {
        tenant_id: tenantId,
        student_id: threadStudentId,
        channel,
        ...(threadStudentId === null ? { subject } : {}),
      },
      select: { id: true },
    });
    if (existing) return existing;
    return tx.commsThread.create({
      data: { tenant_id: tenantId, student_id: threadStudentId, channel, subject },
      select: { id: true },
    });
  }

  // SVT-SEC-2026-08 (T0-7) — this read is now scoped like the writes.
  //
  // The note here used to read: "Pre-flight read happens via the singleton (no
  // RLS GUC) but is filtered by tenant_id explicitly." Under the production
  // `spv_app` role that read matched ZERO rows — `reminders` is RLS-scoped and
  // the policy has no NULL-GUC branch — so the dispatcher picked up nothing and
  // no reminder was ever sent. The writes below were correctly scoped all
  // along; it was the read that FINDS the work which was not, and a job that
  // finds nothing looks identical to a job with nothing to do.
  //
  // The tenant is already known here, so there is no cross-tenant reach to
  // justify the admin client: withTenantTx keeps RLS enforcing on the read too.
  const candidates = await withTenantTx(tenantId, async (tx) => tx.reminder.findMany({
    where: {
      tenant_id: tenantId,
      status: 'PENDING',
      deleted_at: null,
      scheduled_for: { lte: now },
    },
    orderBy: [{ scheduled_for: 'asc' }, { id: 'asc' }],
    take: BATCH_LIMIT,
    select: {
      id: true,
      student_id: true,
      type: true,
      title: true,
      due_on: true,
      assigned_to_id: true,
      source_entity_type: true,
      metadata: true,
    },
  }));
  result.picked = candidates.length;

  for (const r of candidates) {
    try {
      const recipient = r.assigned_to_id ?? fallbackAdmin;
      const studentId = r.student_id;
      // SVT-V2-CRM-MIRROR-2026-06 — deep-link target carried on the reminder.
      const href = ((r.metadata ?? {}) as { href?: string | null }).href ?? null;
      // Reminders with no `students` row (e.g. crm_lead_fee, which lives in the
      // CRM mirror) still deliver — to a per-tenant synthetic IN_APP/EMAIL
      // thread (CommsThread.student_id is nullable) — as long as they carry an
      // href to navigate to. Otherwise there's nothing actionable to surface.
      const isSynthetic = !studentId && href != null;
      const threadStudentId = studentId ?? null;
      const threadSubject = studentId
        ? 'Reminders'
        : r.source_entity_type === 'crm_lead_fee'
          ? 'Fee reminders'
          : 'Notifications';

      // Genuinely tenant-wide reminders with neither a student nor an href have
      // nothing actionable to thread against — mark SENT so the dispatcher
      // doesn't loop forever, but skip the message create.
      if (!studentId && !isSynthetic) {
        await withTenantTx(tenantId, async (tx) => {
          await tx.reminder.updateMany({
            where: { id: r.id, status: 'PENDING' },
            data: { status: 'SENT', sent_at: now, fire_count: { increment: 1 } },
          });
        });
        result.skipped++;
        logger.warn(
          { reminderId: r.id, tenantId },
          'reminder.dispatch skipped: no student_id, no thread possible',
        );
        continue;
      }

      const sent = await withTenantTx(tenantId, async (tx) => {
        // Atomic claim: only the worker that flips PENDING -> SENT actually
        // writes the comms row. updateMany returns count=0 if a peer already
        // claimed it, so we exit early without inserting a duplicate.
        const claimed = await tx.reminder.updateMany({
          where: { id: r.id, status: 'PENDING' },
          data: { status: 'SENT', sent_at: now, fire_count: { increment: 1 } },
        });
        if (claimed.count === 0) return false;

        // Find or create the IN_APP thread (per-student, or per-tenant
        // synthetic when threadStudentId is null — see isTrackedFee above).
        const thread = await findOrCreateThread(tx, 'IN_APP', threadStudentId, threadSubject);

        await tx.commsMessage.create({
          data: {
            tenant_id: tenantId,
            thread_id: thread.id,
            recipient_user_id: recipient ?? null,
            direction: 'OUTBOUND',
            status: 'SENT',
            subject: r.title,
            body: r.title,
            sent_at: now,
            metadata: {
              reminder_id: r.id,
              type: r.type,
              due_on: r.due_on.toISOString().slice(0, 10),
              href, // deep-link target for the NotificationsBell
            },
          } as never,
        });

        // SVT-WAVE8-EMAIL-2026-05 — enqueue EMAIL fan-out for the same reminder.
        // We write to a per-student EMAIL CommsThread and queue the row; the
        // comms.dispatcher job handles provider send + retry. Skip when there
        // is no recipient (the IN_APP row above also goes nowhere then).
        if (recipient) {
          const emailThread = await findOrCreateThread(tx, 'EMAIL', threadStudentId, threadSubject);
          await tx.commsMessage.create({
            data: {
              tenant_id: tenantId,
              thread_id: emailThread.id,
              recipient_user_id: recipient,
              direction: 'OUTBOUND',
              status: 'QUEUED',
              subject: `[Reminder] ${r.title}`,
              body: `${r.title}\n\nDue: ${r.due_on.toISOString().slice(0, 10)}`,
              metadata: {
                reminder_id: r.id,
                type: r.type,
                due_on: r.due_on.toISOString().slice(0, 10),
                href,
              },
            } as never,
          });
        }
        return true;
      });

      if (sent) {
        result.sent++;
      } else {
        // Already claimed by a peer worker — count as skipped, not failed.
        result.skipped++;
      }
    } catch (err) {
      result.failed++;
      logger.error(
        { err, reminderId: r.id, tenantId },
        'reminder.dispatch failed for row',
      );
      // SVT-OBS-JOBS-2026-05 — surface per-row failures to Sentry with the
      // tenant_id attached. The scheduler wraps the whole dispatchPending
      // call in withTenantScope, but we catch each row's error inside the
      // for-loop (so one bad row doesn't halt the batch), which means the
      // outer scheduler-level Sentry handler never sees them. Without this
      // capture, persistent per-row failures only show up in logs.
      captureJobException(err, { job: JOB_NAME, tenant_id: tenantId });
      // We deliberately do NOT mark the row as failed — leaving it PENDING
      // means the next dispatcher pass will retry it. Persistent failures
      // surface in the log + monitoring.
    }
  }

  if (result.picked > 0) {
    logger.info(result, 'reminder dispatch batch complete');
  }
  return result;
}
