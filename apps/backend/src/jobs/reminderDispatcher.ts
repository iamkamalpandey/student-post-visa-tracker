// Reminder dispatcher — turns PENDING Reminder rows into IN_APP CommsMessage
// rows for the assigned admin/counsellor. Polled on a fixed cadence by
// jobs/scheduler.ts; safe to call concurrently because each row's status flip
// is wrapped in an updateMany guard so two workers can't double-dispatch.
//
// We deliberately do NOT use SKIP LOCKED — Prisma doesn't expose it
// natively and the updateMany(where: { id, status: 'PENDING' }) idiom is
// equivalent for our purposes (the second worker's update touches 0 rows).

import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';
import { captureJobException } from '../config/sentry.js';

const JOB_NAME = 'reminder.dispatcher';

type DB = PrismaClient;

const BATCH_LIMIT = 200;

// Cache the per-tenant fallback admin id so we don't issue an extra query
// every dispatch loop. The scanner uses the same lookup; both caches are
// refreshed on process restart (cheap given the cadence).
const fallbackAdminCache = new Map<string, string | null>();

async function fallbackAdminFor(tenantId: string, db: DB): Promise<string | null> {
  if (fallbackAdminCache.has(tenantId)) return fallbackAdminCache.get(tenantId)!;
  const admin = await db.user.findFirst({
    where: { tenant_id: tenantId, role: 'ADMIN', is_active: true, deleted_at: null },
    orderBy: { created_at: 'asc' },
    select: { id: true },
  });
  const id = admin?.id ?? null;
  fallbackAdminCache.set(tenantId, id);
  return id;
}

/** Test hook — flushes the per-tenant fallback admin cache. */
export function _clearFallbackCache() {
  fallbackAdminCache.clear();
}

// Background dispatch runs outside the request scope, so the RLS GUC must be
// set inside every transaction. Mirrors the comms module's withTenantTx.
async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
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
  db: DB = prisma,
  nowOverride?: Date,
): Promise<DispatchResult> {
  const now = nowOverride ?? new Date();
  const result: DispatchResult = { tenantId, picked: 0, sent: 0, failed: 0, skipped: 0 };

  const fallbackAdmin = await fallbackAdminFor(tenantId, db);

  // Pre-flight read happens via the singleton (no RLS GUC) but is filtered by
  // tenant_id explicitly. The actual writes use withTenantTx so policies +
  // triggers see the right tenant.
  const candidates = await db.reminder.findMany({
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
    },
  });
  result.picked = candidates.length;

  for (const r of candidates) {
    try {
      const recipient = r.assigned_to_id ?? fallbackAdmin;
      const studentId = r.student_id;

      // CommsThread requires student_id (NOT NULL). For tenant-wide reminders
      // with no student we have nothing to thread against — mark SENT so the
      // dispatcher doesn't loop on it forever, but skip the message create.
      if (!studentId) {
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

        // Find or create the IN_APP thread for this student.
        let thread = await tx.commsThread.findFirst({
          where: { tenant_id: tenantId, student_id: studentId, channel: 'IN_APP' },
          select: { id: true },
        });
        if (!thread) {
          thread = await tx.commsThread.create({
            data: {
              tenant_id: tenantId,
              student_id: studentId,
              channel: 'IN_APP',
              subject: 'Reminders',
            },
            select: { id: true },
          });
        }

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
            },
          } as never,
        });

        // SVT-WAVE8-EMAIL-2026-05 — enqueue EMAIL fan-out for the same reminder.
        // We write to a per-student EMAIL CommsThread and queue the row; the
        // comms.dispatcher job handles provider send + retry. Skip when there
        // is no recipient (the IN_APP row above also goes nowhere then).
        if (recipient) {
          let emailThread = await tx.commsThread.findFirst({
            where: { tenant_id: tenantId, student_id: studentId, channel: 'EMAIL' },
            select: { id: true },
          });
          if (!emailThread) {
            emailThread = await tx.commsThread.create({
              data: {
                tenant_id: tenantId,
                student_id: studentId,
                channel: 'EMAIL',
                subject: 'Reminders',
              },
              select: { id: true },
            });
          }
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
