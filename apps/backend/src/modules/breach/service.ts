// BreachIncident service. Admin only at the route layer; tenant-scoped where possible.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { notifyStatusTransition } from '../../shared/transitionNotify.js';
import type {
  CreateBreachRequest,
  UpdateBreachRequest,
  BreachListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

// GDPR Art. 33 / UK DPA / India DPDP §8 require notification within 72h of
// becoming aware of the breach. due_by anchors the SLA clock to detected_at.
const SLA_HOURS = 72;
const MS_PER_HOUR = 3_600_000;

type DecoratedBreach<T extends { due_by: Date; closed_at: Date | null }> = T & {
  hours_remaining: number | null;  // null when closed
  is_overdue: boolean;
};

function decorate<T extends { due_by: Date; closed_at: Date | null }>(row: T): DecoratedBreach<T> {
  const closed = row.closed_at != null;
  const remainingMs = row.due_by.getTime() - Date.now();
  return {
    ...row,
    hours_remaining: closed ? null : Math.floor(remainingMs / MS_PER_HOUR),
    is_overdue: !closed && remainingMs < 0,
  };
}

export const breachService = {
  async create(req: { db?: DB; user?: { tid: string } }, body: CreateBreachRequest) {
    // Compute due_by deterministically server-side so client-side clocks can't
    // tamper with the regulator clock. detected_at is mandatory on the wire.
    const detectedAt = new Date((body as { detected_at: string }).detected_at);
    const dueBy = new Date(detectedAt.getTime() + SLA_HOURS * MS_PER_HOUR);
    const created = await db(req).breachIncident.create({
      data: { ...body, tenant_id: req.user?.tid ?? null, due_by: dueBy } as never,
    });
    await writeAudit(req as never, {
      action: 'breach.created',
      entityType: 'breach_incident',
      entityId: created.id,
      after: created,
    });
    return decorate(created);
  },
  async list(req: { db?: DB; user?: { tid: string } }, q: BreachListQuery) {
    const rows = await db(req).breachIncident.findMany({
      where: {
        tenant_id: req.user!.tid,
        ...(q.severity ? { severity: q.severity } : {}),
      },
      orderBy: { detected_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return rows.map(decorate);
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).breachIncident.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Breach incident not found');
    return decorate(found);
  },
  // SVT-IFMATCH-2026-05 — BreachIncident has no `version` column in the
  // current schema, so `_opts.expected` (from If-Match) is accepted for API
  // parity but ignored. Wire full OCC via assertVersion + version-gated
  // updateMany once the column lands in prisma/schema.prisma.
  async update(req: { db?: DB; user?: { tid: string; sub?: string; role?: string } }, id: string, body: UpdateBreachRequest, _opts?: { expected?: number }) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).breachIncident.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: body as never,
    });
    if (r.count !== 1) throw NotFound('Breach incident not found');
    const after = await db(req).breachIncident.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'breach.updated',
      entityType: 'breach_incident',
      entityId: id,
      before,
      after,
    });

    // SVT-WAVE-HIGH-2-2026-05 — closure is the breach FSM's terminal event.
    // Surface it as an IN_APP ping so the tenant admin sees a clear "incident
    // closed" signal in the bell drawer (paired with the GDPR 72h dashboard
    // widget). Fires only when closed_at flips from null → set, never when
    // an already-closed incident is patched.
    if (before.closed_at == null && after.closed_at != null) {
      setImmediate(() => {
        void notifyStatusTransition({
          tenantId: req.user!.tid,
          entityId: id,
          source: 'breach',
          title: 'Breach incident closed',
          body: `Breach incident ${id.slice(0, 8)}… closed by ${req.user?.role ?? 'unknown role'}.`,
          href: `/breach-incidents?open=${id}`,
          preferUserId: null,
          actorId: (req.user as { sub?: string } | undefined)?.sub ?? null,
        });
      });
    }
    return decorate(after);
  },
  // SVT-WAVE36-BREACH-DASH-2026-05 — small aggregate for the dashboard's
  // admin-only breach widget. Tenant-scoped; no PII surfaces. Counts:
  //   - open: not closed
  //   - overdue: open AND due_by < now
  //   - due_within_24h: open AND 0h <= remaining <= 24h
  async dashboardSummary(req: { db?: DB; user?: { tid: string } }) {
    const tenantId = req.user!.tid;
    const now = new Date();
    const horizon = new Date(now.getTime() + 24 * MS_PER_HOUR);
    const [open, overdue, dueSoon] = await Promise.all([
      db(req).breachIncident.count({
        where: { tenant_id: tenantId, closed_at: null },
      }),
      db(req).breachIncident.count({
        where: { tenant_id: tenantId, closed_at: null, due_by: { lt: now } },
      }),
      db(req).breachIncident.count({
        where: {
          tenant_id: tenantId,
          closed_at: null,
          due_by: { gte: now, lte: horizon },
        },
      }),
    ]);
    return { open, overdue, due_within_24h: dueSoon };
  },

  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).breachIncident.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Breach incident not found');
    await writeAudit(req as never, {
      action: 'breach.deleted',
      entityType: 'breach_incident',
      entityId: id,
      before,
    });
  },
};
