// SVT-WAVE14-DIGEST-2026-05 — daily email digest collapser.
//
// Pattern:
//   1. Find users with notifications_digest = 'DAILY'.
//   2. For each user, find QUEUED EMAIL comms_messages addressed to them
//      whose parent thread is a 'Reminders' or 'System notifications' thread.
//   3. If >0, build a single summary message (plain-text bullet list), write
//      it as QUEUED to a per-tenant Digest thread, and flip the originals to
//      SENT with metadata.digested_into = <new_id>.
//   4. The commsDispatcher then ships the summary via Resend.
//
// Empty case: user opted into DAILY but no events queued → nothing to do.
// Failure mode: per-user errors are logged + swallowed (don't poison the
// pass for other users).
//
// Scheduled daily at 08:00 UTC (after expiry.alerts at 06:00).

import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';

type DB = PrismaClient;
const BATCH_LIMIT = 500;

export type CommsDigestResult = {
  users_scanned: number;
  users_with_events: number;
  digests_created: number;
  rows_collapsed: number;
  errors: number;
};

async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

export async function runCommsDigest(db: DB = prisma): Promise<CommsDigestResult> {
  const result: CommsDigestResult = {
    users_scanned: 0,
    users_with_events: 0,
    digests_created: 0,
    rows_collapsed: 0,
    errors: 0,
  };

  const users = await db.user.findMany({
    where: {
      deleted_at: null,
      is_active: true,
      notifications_digest: 'DAILY',
      notifications_email_enabled: true,
    },
    select: { id: true, tenant_id: true, email: true },
  });
  result.users_scanned = users.length;

  for (const u of users) {
    try {
      // Find queued EMAIL messages addressed to this user via EMAIL threads.
      // The reminderDispatcher writes those to a per-student 'Reminders' EMAIL
      // thread; we collapse anything sitting in EMAIL channel.
      const queued = await db.commsMessage.findMany({
        where: {
          tenant_id: u.tenant_id,
          recipient_user_id: u.id,
          status: 'QUEUED',
          thread: { channel: 'EMAIL' },
        },
        orderBy: { created_at: 'asc' },
        take: BATCH_LIMIT,
        select: { id: true, subject: true, body: true, created_at: true, thread_id: true },
      });
      if (queued.length === 0) continue;

      result.users_with_events += 1;

      // Build summary body — plain text bullets, one per source event.
      const lines = [
        `Daily digest — ${queued.length} update${queued.length === 1 ? '' : 's'} since yesterday.`,
        '',
        ...queued.map((m) => `• ${m.subject ?? m.body}`),
      ];
      const summary = lines.join('\n');

      await withTenantTx(u.tenant_id, async (tx) => {
        // Find or create per-tenant Digest EMAIL thread (no student scope —
        // these are user-level summaries). student_id nullable per Wave 5.
        let thread = await tx.commsThread.findFirst({
          where: {
            tenant_id: u.tenant_id,
            student_id: null,
            channel: 'EMAIL',
            subject: 'Daily digest',
          },
          select: { id: true },
        });
        if (!thread) {
          thread = await tx.commsThread.create({
            data: {
              tenant_id: u.tenant_id,
              student_id: null,
              channel: 'EMAIL',
              subject: 'Daily digest',
            },
            select: { id: true },
          });
        }

        const created = await tx.commsMessage.create({
          data: {
            tenant_id: u.tenant_id,
            thread_id: thread.id,
            recipient_user_id: u.id,
            direction: 'OUTBOUND',
            status: 'QUEUED',
            subject: `[SPV] Daily digest — ${queued.length} update${queued.length === 1 ? '' : 's'}`,
            body: summary,
            metadata: {
              digest: true,
              source_count: queued.length,
              source_ids: queued.map((m) => m.id),
            },
          } as never,
        });

        // Mark originals SENT with a back-pointer so the audit trail shows
        // where they went. The commsDispatcher won't re-send these.
        await tx.commsMessage.updateMany({
          where: { id: { in: queued.map((m) => m.id) }, status: 'QUEUED' },
          data: {
            status: 'SENT',
            sent_at: new Date(),
            metadata: { digested_into: created.id },
          },
        });

        result.digests_created += 1;
        result.rows_collapsed += queued.length;
      });
    } catch (err) {
      result.errors += 1;
      logger.error({ err, userId: u.id, tenantId: u.tenant_id }, 'comms.digest failed for user');
    }
  }

  if (result.users_scanned > 0) {
    logger.info(result, 'comms digest pass complete');
  }
  return result;
}
