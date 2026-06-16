// SVT-TXN-NOTIFY-2026-05 — fan-out helper for FSM transition notifications.
//
// Several modules (super-agents, enrollments, commission-claims, soon stages)
// flip status fields whose outcomes interest the assigned counsellor or admin
// (e.g. "Adventus terminated", "Enrollment ENROLLED", "Commission PAID"). The
// raw audit row records the event for forensics; this helper additionally
// surfaces it as an in-app notification (CommsMessage with channel='IN_APP')
// targeted at the right user so the bell badge fires.
//
// Design:
//   - notifyStatusTransition(args) is best-effort: failures are logged but
//     never thrown. A flaky notification must not roll back a successful
//     business transition.
//   - Recipient resolution prefers an explicit assigneeId; falls back to the
//     first active ADMIN of the tenant. Mirrors reminderScanner's pattern.
//   - `metadata.href` carries a deep-link the bell drawer can navigate to.
//   - We cache the per-tenant fallback admin id for the process lifetime.
//
// Why not just write a Reminder row? Reminders are time-shifted (scheduled_for).
// These FSM events have already happened — the user wants an immediate badge.
// CommsMessage(channel=IN_APP) is the existing in-app fan-out lane.

import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';

const adminCache = new Map<string, string | null>();

async function resolveRecipient(tenantId: string, preferUserId: string | null | undefined): Promise<string | null> {
  if (preferUserId) return preferUserId;
  if (adminCache.has(tenantId)) return adminCache.get(tenantId) ?? null;
  try {
    const admin = await prisma.user.findFirst({
      where: { tenant_id: tenantId, role: 'ADMIN', is_active: true, deleted_at: null },
      orderBy: { created_at: 'asc' },
      select: { id: true },
    });
    const id = admin?.id ?? null;
    adminCache.set(tenantId, id);
    return id;
  } catch {
    return null;
  }
}

export function _clearTransitionNotifyCache(): void {
  adminCache.clear();
}

export type TransitionNotifyArgs = {
  tenantId: string;
  /** Entity primary key (used in href). */
  entityId: string;
  /** Free-form summary, e.g. "Adventus terminated", "Enrollment moved to ENROLLED". */
  title: string;
  /** Optional longer body. */
  body?: string;
  /** Deep-link relative path, e.g. "/super-agents/<id>" or "/students/<id>?tab=studies". */
  href?: string;
  /** Preferred recipient (assigned counsellor); falls back to first tenant ADMIN. */
  preferUserId?: string | null;
  /** Originator (for audit-like metadata only; not used for routing). */
  actorId?: string | null;
  /** Tag visible in CommsMessage.metadata for filtering bell drawer. */
  source:
    | 'super_agent'
    | 'enrollment'
    | 'commission'
    | 'stage'
    | 'dsar'
    // SVT-WAVE-HIGH-2-2026-05 — breach incidents: open → closed surfaces
    // as a bell ping for the tenant admin (GDPR Art. 33 visibility).
    | 'breach'
    // SVT-WAVE-BILLING-2026-05 — billing FSM transitions (Wave 2+).
    | 'fee_plan'
    | 'payment'
    | 'refund'
    // SVT-SYNC-2026-06 — student-level status changes (ACTIVE→ON_HOLD/WITHDRAWN/
    // COMPLETED/…) surface a bell ping for the assigned counsellor, matching the
    // existing enrollment-status notification.
    | 'student'
    // SVT-AUDIT-VERIFY-2026-06 — the nightly audit-chain verify job pings the
    // tenant ADMIN's bell when a hash-chain break is detected (possible tampering).
    | 'audit';
};

// SVT-WAVE12-NOTIFY-DEDUP-2026-05 — when several rapid-fire transitions hit
// the same entity (rare but real: PATCH retries, double-click, sloppy admin
// flows) we suppress duplicate IN_APP rows within a short window. Source +
// entity_id + recipient is the dedup key; default 60-second window. The DB
// row is still written by the LATEST call (after window elapses) so legit
// repeat events still surface.
const NOTIFY_DEDUP_WINDOW_MS = 60_000;

/**
 * Insert a single IN_APP CommsMessage so the recipient's bell badge fires.
 * Never throws — every error is swallowed + logged.
 *
 * The CommsMessage row requires a thread_id; we create or reuse a per-tenant
 * synthetic "transitions" thread so we don't pollute the per-student thread
 * list with system events. recipient_user_id is the addressing primary.
 */
export async function notifyStatusTransition(args: TransitionNotifyArgs): Promise<void> {
  try {
    const recipientUserId = await resolveRecipient(args.tenantId, args.preferUserId ?? null);
    if (!recipientUserId) {
      logger.debug({ tenantId: args.tenantId, source: args.source }, 'notifyStatusTransition: no recipient — skipped');
      return;
    }

    // Dedup gate: if an identical notification was emitted within the window,
    // drop this one + log debug. Uses sent_at index already in place. Cheap
    // single-row lookup before the bigger tx.
    const since = new Date(Date.now() - NOTIFY_DEDUP_WINDOW_MS);
    const dup = await prisma.commsMessage.findFirst({
      where: {
        tenant_id: args.tenantId,
        recipient_user_id: recipientUserId,
        sent_at: { gte: since },
        body: args.body ?? args.title,
      },
      select: { id: true, metadata: true },
    });
    if (dup) {
      const meta = (dup.metadata as { source?: string; entity_id?: string } | null) ?? {};
      if (meta.source === args.source && meta.entity_id === args.entityId) {
        logger.debug(
          { tenantId: args.tenantId, source: args.source, entityId: args.entityId, dupId: dup.id },
          'notifyStatusTransition: suppressed duplicate within window',
        );
        return;
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${args.tenantId}, true)`;
      // Synthetic system thread per tenant, channel=IN_APP. Idempotent: upsert
      // by a stable key derived from tenant. CommsThread.student_id is nullable;
      // system threads pass null.
      // We pick the first existing system thread or create one — Prisma has no
      // findOrCreate, so do it manually.
      let thread = await tx.commsThread.findFirst({
        where: {
          tenant_id: args.tenantId,
          student_id: null,
          channel: 'IN_APP',
          subject: 'System notifications',
        },
        select: { id: true },
      });
      if (!thread) {
        thread = await tx.commsThread.create({
          data: {
            tenant_id: args.tenantId,
            student_id: null,
            channel: 'IN_APP',
            subject: 'System notifications',
          },
          select: { id: true },
        });
      }
      await tx.commsMessage.create({
        data: {
          tenant_id: args.tenantId,
          thread_id: thread.id,
          direction: 'OUTBOUND',
          status: 'SENT',
          body: args.body ?? args.title,
          sent_at: new Date(),
          recipient_user_id: recipientUserId,
          metadata: {
            title: args.title,
            href: args.href ?? null,
            source: args.source,
            entity_id: args.entityId,
            actor_id: args.actorId ?? null,
          },
          created_by_id: args.actorId ?? null,
        },
      });
    });
  } catch (err) {
    logger.warn(
      { err, tenantId: args.tenantId, source: args.source, entityId: args.entityId },
      'notifyStatusTransition failed (best-effort; non-fatal)',
    );
  }
}
