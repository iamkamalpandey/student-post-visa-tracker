// FinanceItem service. Hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { Conflict, NotFound, PreconditionFailed } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { logger } from '../../config/logger.js';
import type {
  CreateFinanceRequest,
  UpdateFinanceRequest,
  FinanceListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

function toData(input: Partial<CreateFinanceRequest>) {
  const { amount_minor, paid_amount_minor, due_on, paid_on, ...rest } = input as Record<string, unknown> & {
    amount_minor?: number | string;
    paid_amount_minor?: number | string;
    due_on?: string | null;
    paid_on?: string | null;
  };
  return {
    ...rest,
    ...(amount_minor !== undefined ? { amount_minor: BigInt(amount_minor as string | number) } : {}),
    // SVT-QA-2026-08 (LEAD-H5) — partial-settlement amount, BigInt like its sibling.
    ...(paid_amount_minor !== undefined
      ? { paid_amount_minor: BigInt(paid_amount_minor as string | number) }
      : {}),
    ...(due_on !== undefined ? { due_on: toDate(due_on) } : {}),
    ...(paid_on !== undefined ? { paid_on: toDate(paid_on) } : {}),
  };
}

// SVT-SYNC-2026-06 — A7: auto-dismiss PENDING/SENT/SNOOZED reminders that
// reference this finance item. Fires when the item transitions to a terminal
// payment state (PAID/WAIVED) or is deleted — prevents "payment due" staircase
// from firing for a settled item.
const DISMISSABLE_STATUSES = ['PAID', 'WAIVED', 'CANCELLED', 'REFUNDED'];

// SVT-QA-2026-08 (BILL-H4) — FinanceItem status transition rules.
//
// `update` previously copied `input.status` into the write with no guard at
// all, so any status could become any other: PAID → PENDING, REFUNDED → PAID,
// WAIVED → PENDING. The damaging direction is un-settling a settled item —
// its reminders were already DISMISSED (terminal) and nothing re-arms them,
// so an item flipped PAID → PENDING silently falls off the collections queue
// forever while still showing as owed on the student ledger.
//
// FinanceStatus (schema.prisma) = PENDING | PAID | OVERDUE | WAIVED | REFUNDED.
// Forward motion and correction between open states is allowed; leaving a
// settled state is not, except the one genuinely-needed reversal PAID →
// REFUNDED (which the refund workflow drives).
const FINANCE_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  PENDING: ['PAID', 'OVERDUE', 'WAIVED'],
  OVERDUE: ['PAID', 'PENDING', 'WAIVED'],
  PAID: ['REFUNDED'],
  WAIVED: [],
  REFUNDED: [],
};

function assertFinanceStatusTransition(from: string, to: string): void {
  if (from === to) return;
  const allowed = FINANCE_STATUS_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw Conflict(
      `Cannot transition finance item from ${from} to ${to}.` +
        (allowed.length ? ` Allowed: ${allowed.join(', ')}.` : ' That status is terminal.'),
    );
  }
}

async function dismissRemindersForFinanceItem(client: DB, tenantId: string, itemId: string): Promise<void> {
  const result = await (client as PrismaClient).reminder.updateMany({
    where: {
      tenant_id: tenantId,
      source_entity_type: 'finance_item',
      source_entity_id: itemId,
      status: { in: ['PENDING', 'SENT', 'SNOOZED'] },
    },
    data: { status: 'DISMISSED' },
  });
  if (result.count > 0) {
    logger.info({ tenantId, entityType: 'finance_item', entityId: itemId, dismissed: result.count }, 'auto-dismissed stale finance reminders');
  }
}

export const financeService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateFinanceRequest) {
    const created = await db(req).financeItem.create({
      data: { ...toData(body), student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.finance.created',
      entityType: 'finance_item',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: FinanceListQuery) {
    return db(req).financeItem.findMany({
      where: {
        student_id: studentId,
        tenant_id: req.user!.tid,
        ...(q.status ? { status: q.status } : {}),
        ...(q.category ? { category: q.category } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).financeItem.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Finance item not found');
    return found;
  },
  async update(req: { db?: DB; user?: { tid: string } }, id: string, body: UpdateFinanceRequest, opts?: { expected?: number }) {
    const before = await this.get(req, id) as { status?: string; version?: number };
    // SVT-QA-2026-08 (BILL-H4) — gate the status transition. See
    // FINANCE_STATUS_TRANSITIONS above for why an ungated flip is a real
    // money-visibility bug, not a hygiene nit.
    const nextStatus = (body as { status?: string }).status;
    if (nextStatus && before.status) {
      assertFinanceStatusTransition(before.status, nextStatus);
    }
    // SVT-QA-2026-08 (BILL-H3) — honour If-Match. The controller has always
    // parsed the header into `expected` and passed it here, but the parameter
    // was discarded (`_opts`) and the model had no `version` column, so the
    // optimistic-concurrency contract was theatre: two counsellors correcting
    // the same amount_minor concurrently both wrote, last one silently won.
    // `version` now exists (migration 20991231235999) and is folded into the
    // WHERE plus incremented on every write.
    if (opts?.expected !== undefined && before.version !== undefined && before.version !== opts.expected) {
      throw PreconditionFailed('Finance item was modified by another request; reload and retry.');
    }
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).financeItem.updateMany({
      where: {
        id, tenant_id: req.user!.tid,
        ...(opts?.expected !== undefined ? { version: opts.expected } : {}),
      },
      data: { ...toData(body), version: { increment: 1 } } as never,
    });
    if (r.count !== 1) {
      if (opts?.expected !== undefined) {
        throw PreconditionFailed('Finance item was modified by another request; reload and retry.');
      }
      throw NotFound('Finance item not found');
    }
    const after = await db(req).financeItem.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.finance.updated',
      entityType: 'finance_item',
      entityId: id,
      before,
      after,
    });
    // SVT-SYNC-2026-06 — A7: if status transitioned to a terminal payment state,
    // dismiss any stale "payment due" reminders referencing this item.
    const afterStatus = (after as { status?: string }).status;
    if (afterStatus && DISMISSABLE_STATUSES.includes(afterStatus)) {
      await dismissRemindersForFinanceItem(db(req), req.user!.tid, id);
    }
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).financeItem.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Finance item not found');
    // SVT-SYNC-2026-06 — A7: deleted → dismiss its reminders.
    await dismissRemindersForFinanceItem(db(req), req.user!.tid, id);
    await writeAudit(req as never, {
      action: 'student.finance.deleted',
      entityType: 'finance_item',
      entityId: id,
      before,
    });
  },
};
