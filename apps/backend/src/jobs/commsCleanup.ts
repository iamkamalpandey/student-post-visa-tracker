// SVT-WAVE13-CLEANUP-2026-05 — purge old SENT / READ comms_messages rows.
//
// IN_APP notifications + EMAIL receipts pile up: every reminder, every
// transition writes one. After 30 days the row has no forensic value (audit
// chain captures the event independently). Cleanup keeps the table small +
// indices hot.
//
// Scope:
//   * SENT or READ status (delivery completed cleanly)
//   * sent_at older than RETENTION_DAYS
//   * direction OUTBOUND (no inbound replies yet, but be explicit)
//
// Not purged:
//   * QUEUED / FAILED — still actionable
//   * Threads themselves (could be empty after purge; harmless)
//
// Runs as a scheduled daily job; safe to call concurrently because we DELETE
// by id and tolerate count<expected.

import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';

const RETENTION_DAYS = 30;
const BATCH_LIMIT = 5000;

export type CommsCleanupResult = {
  scanned: number;
  deleted: number;
  errors: number;
};

export async function runCommsCleanup(nowOverride?: Date): Promise<CommsCleanupResult> {
  const now = nowOverride ?? new Date();
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000);
  const result: CommsCleanupResult = { scanned: 0, deleted: 0, errors: 0 };

  try {
    const rows = await prisma.commsMessage.findMany({
      where: {
        status: { in: ['SENT', 'READ', 'DELIVERED'] },
        direction: 'OUTBOUND',
        sent_at: { lt: cutoff },
      },
      select: { id: true },
      take: BATCH_LIMIT,
    });
    result.scanned = rows.length;
    if (rows.length === 0) {
      logger.debug({ cutoff }, 'comms.cleanup: nothing to purge');
      return result;
    }

    const r = await prisma.commsMessage.deleteMany({
      where: { id: { in: rows.map((x) => x.id) } },
    });
    result.deleted = r.count;
    logger.info(
      { scanned: result.scanned, deleted: result.deleted, cutoff },
      'comms.cleanup pass complete',
    );
  } catch (err) {
    result.errors += 1;
    logger.error({ err }, 'comms.cleanup failed');
  }

  return result;
}
