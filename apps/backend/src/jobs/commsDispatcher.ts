// SVT-WAVE8-OUTBOX-2026-05 — outbox-style dispatcher for external-provider
// channels (EMAIL via Resend, later SMS/WHATSAPP). IN_APP rows are written
// directly with status=SENT by callers (no provider hop); this job only
// touches rows that need a real provider send.
//
// Pattern:
//   1. Find candidate rows: status='QUEUED' OR (status='FAILED' AND attempts<MAX
//      AND next_retry_at<=now).
//   2. For each row, fetch the recipient User to learn `email` + opt-in flag.
//      Skip + mark SENT (no-op) if user opted out (we don't want to spam logs
//      with FAILED rows for a deliberate opt-out — the row exists for audit).
//   3. Resolve channel by inspecting the parent CommsThread.channel.
//   4. Call provider.send. On SENT, stamp status=SENT + provider_id + sent_at.
//      On FAILED, increment attempts + set next_retry_at via exponential backoff.
//   5. After MAX_ATTEMPTS, leave status=FAILED with next_retry_at=NULL so the
//      job stops re-picking it. Operator inspects via the messages list.
//
// Backoff: 5min, 30min, 4hr — three attempts total. Tunable via constants.

import type { PrismaClient } from '@prisma/client';
import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';
import { withTenantScope } from '../config/sentry.js';
import { getProvider } from '../modules/comms/providers/registry.js';
import type { CommsChannel } from '../modules/comms/providers/index.js';
import { withTenantTx } from '../shared/tenantTx.js';

const BATCH_LIMIT = 100;
const MAX_ATTEMPTS = 3;
// Exponential-ish: attempt 1 fails → +5min, attempt 2 fails → +30min, attempt 3 fails → terminal.
const BACKOFF_MS = [5 * 60_000, 30 * 60_000];

type DB = PrismaClient;

export type CommsDispatchResult = {
  picked: number;
  sent: number;
  failed: number;
  opted_out: number;
  terminal: number; // FAILED rows that hit MAX_ATTEMPTS this pass
};

/**
 * One pass of the outbox dispatcher. Walks every active tenant and drains its
 * QUEUED + retryable FAILED rows up to BATCH_LIMIT per tenant.
 */
export async function dispatchCommsOutbox(
  db: DB = prisma,
  nowOverride?: Date,
): Promise<CommsDispatchResult> {
  const now = nowOverride ?? new Date();
  const result: CommsDispatchResult = { picked: 0, sent: 0, failed: 0, opted_out: 0, terminal: 0 };

  // SVT-TENANT-ISO-2026-05 — per-tenant candidate scan. Previously the
  // findMany ran on singleton prisma with no tenant_id filter, batching rows
  // ACROSS tenants in one global BATCH_LIMIT and starving any tenant that
  // happened to land later in created_at order. Now each tenant gets its own
  // BATCH_LIMIT and the per-row writes inside withTenantTx already carry
  // the correct RLS context.
  // Pull active tenants from the SAME db param so unit-test mocks supply
  // the row set. The fallback singleton produces the same result in prod.
  const tenants = await db.tenant.findMany({
    where: { is_active: true },
    select: { id: true },
  });
  const candidates: Array<{
    id: string; tenant_id: string; thread_id: string;
    recipient_user_id: string | null;
    subject: string | null; body: string;
    attempts: number; metadata: unknown;
  }> = [];
  for (const t of tenants) {
    // SVT-OBS-JOBS-2026-05 — per-tenant Sentry scope on the candidate scan so
    // a tenant whose findMany throws (e.g. RLS hiccup, transient pool error)
    // gets attributed to the right tenant_id rather than landing as an
    // unattributed `comms.dispatcher` failure.
    try {
      const rows = await withTenantScope(t.id, 'comms.dispatcher', async () =>
        db.commsMessage.findMany({
          where: {
            tenant_id: t.id,
            OR: [
              { status: 'QUEUED' },
              { status: 'FAILED', attempts: { lt: MAX_ATTEMPTS }, next_retry_at: { lte: now } },
            ],
          },
          orderBy: { created_at: 'asc' },
          take: BATCH_LIMIT,
          select: {
            id: true, tenant_id: true, thread_id: true, recipient_user_id: true,
            subject: true, body: true, attempts: true, metadata: true,
          },
        }),
      );
      for (const r of rows) candidates.push(r as never);
    } catch (err) {
      // Don't let one tenant's scan crash poison the rest of the pass.
      logger.error({ err, tenantId: t.id }, 'comms.dispatcher: candidate scan failed');
    }
  }
  result.picked = candidates.length;

  for (const m of candidates) {
    try {
      // SVT-OBS-JOBS-2026-05 — wrap the per-row send in a tenant-scoped
      // Sentry block so any thrown exception inside the per-row processing
      // (provider hiccup, prisma error, etc.) is attributed to the right
      // tenant_id rather than landing as an unattributed comms.dispatcher
      // failure. The outer try/catch still increments result.failed so the
      // batch summary is honest. `continue` in the loop becomes `return`
      // from the wrapper callback to short-circuit identically.
      await withTenantScope(m.tenant_id, 'comms.dispatcher', async () => {
        // Resolve channel from thread; IN_APP messages never get here (caller
        // writes them as SENT directly) but be safe.
        const thread = await db.commsThread.findFirst({
          where: { id: m.thread_id },
          select: { channel: true },
        });
        if (!thread || thread.channel === 'IN_APP') {
          // No external provider applies — flip to SENT to remove from the queue.
          await withTenantTx(m.tenant_id, async (tx) => {
            await tx.commsMessage.updateMany({
              where: { id: m.id, status: { in: ['QUEUED', 'FAILED'] } },
              data: { status: 'SENT', sent_at: now, last_attempt_at: now },
            });
          });
          result.sent++;
          return;
        }

        // Recipient resolution: external sends need a `to` address. For EMAIL we
        // fetch the recipient user's email + opt-out flag. SMS/WHATSAPP would
        // resolve phone — out of scope here; flip to FAILED + terminal so they
        // don't loop forever.
        const channel = thread.channel as CommsChannel;
        let to: string | null = null;
        let optedOut = false;
        if (channel === 'EMAIL' && m.recipient_user_id) {
          const user = await db.user.findFirst({
            where: { id: m.recipient_user_id, deleted_at: null, is_active: true },
            select: { email: true, notifications_email_enabled: true },
          });
          to = user?.email ?? null;
          optedOut = user ? !user.notifications_email_enabled : false;
        }

        if (optedOut) {
          await withTenantTx(m.tenant_id, async (tx) => {
            await tx.commsMessage.updateMany({
              where: { id: m.id, status: { in: ['QUEUED', 'FAILED'] } },
              data: { status: 'SENT', sent_at: now, last_attempt_at: now },
            });
          });
          result.opted_out++;
          logger.debug({ messageId: m.id, channel }, 'comms.dispatcher: recipient opted out');
          return;
        }

        if (!to) {
          // No deliverable address — terminal failure. Mark FAILED with no retry.
          await withTenantTx(m.tenant_id, async (tx) => {
            await tx.commsMessage.updateMany({
              where: { id: m.id, status: { in: ['QUEUED', 'FAILED'] } },
              data: {
                status: 'FAILED',
                last_attempt_at: now,
                attempts: { increment: 1 },
                next_retry_at: null,
              },
            });
          });
          result.terminal++;
          result.failed++;
          logger.warn({ messageId: m.id, channel }, 'comms.dispatcher: no deliverable address');
          return;
        }

        // SVT-WAVE15-FROM-2026-05 — fetch per-tenant FROM. Null falls back to
        // provider's default (env.EMAIL_FROM). Tenant lookup is cheap + cached
        // by Prisma's connection-pool; skip when not EMAIL.
        let tenantFrom: string | null = null;
        if (channel === 'EMAIL') {
          const tenant = await db.tenant.findFirst({
            where: { id: m.tenant_id },
            select: { email_from: true },
          });
          tenantFrom = tenant?.email_from ?? null;
        }

        // Send via provider. Provider never throws — returns SENT or FAILED.
        const provider = getProvider(channel);
        const sendResult = await provider.send({
          to,
          from: tenantFrom,
          subject: m.subject ?? undefined,
          body: m.body,
          metadata: (m.metadata as Record<string, unknown> | null) ?? undefined,
        });

        if (sendResult.status === 'SENT') {
          await withTenantTx(m.tenant_id, async (tx) => {
            await tx.commsMessage.updateMany({
              where: { id: m.id, status: { in: ['QUEUED', 'FAILED'] } },
              data: {
                status: 'SENT',
                sent_at: now,
                last_attempt_at: now,
                attempts: { increment: 1 },
                provider_id: sendResult.providerId,
                next_retry_at: null,
              },
            });
          });
          result.sent++;
        } else {
          // FAILED: compute backoff. If we just hit MAX_ATTEMPTS, terminal (no retry).
          const nextAttempt = m.attempts + 1;
          const isTerminal = nextAttempt >= MAX_ATTEMPTS;
          const backoff = isTerminal ? null : BACKOFF_MS[nextAttempt - 1] ?? null;
          const retryAt = backoff ? new Date(now.getTime() + backoff) : null;
          await withTenantTx(m.tenant_id, async (tx) => {
            await tx.commsMessage.updateMany({
              where: { id: m.id, status: { in: ['QUEUED', 'FAILED'] } },
              data: {
                status: 'FAILED',
                last_attempt_at: now,
                attempts: { increment: 1 },
                next_retry_at: retryAt,
                metadata: {
                  ...((m.metadata as Record<string, unknown> | null) ?? {}),
                  last_error: sendResult.error,
                },
              },
            });
          });
          result.failed++;
          if (isTerminal) result.terminal++;
          logger.warn(
            { messageId: m.id, channel, attempts: nextAttempt, error: sendResult.error, terminal: isTerminal },
            'comms.dispatcher: send failed',
          );
        }
      });
    } catch (err) {
      result.failed++;
      logger.error({ err, messageId: m.id, tenantId: m.tenant_id }, 'comms.dispatcher: unexpected error for row');
    }
  }

  if (result.picked > 0) {
    logger.info(result, 'comms outbox dispatch batch complete');
  }
  return result;
}
