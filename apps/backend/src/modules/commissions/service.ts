// CommissionClaim service — list / get / state-machine transitions / admin edit / summary.
//
// State machine (see also tests/commissions-validation.spec.ts):
//
//   PENDING --claim--> CLAIMED --invoice--> INVOICED --mark-paid--> PAID
//      \                  \                    \                       (terminal)
//       \                  \                    +--dispute--> DISPUTED
//        +--dispute--> DISPUTED                 |
//                          |                    +--waive --> WAIVED  (admin override)
//                          +--waive --> WAIVED
//
// Any non-PAID may be DISPUTED. Any state may be WAIVED (admin override).
// Illegal transitions raise 409 Conflict.

import type { Request } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';

import { Conflict, NotFound, PreconditionFailed, Unauthorized } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { notifyStatusTransition } from '../../shared/transitionNotify.js';
// SVT-FSM-2026-05: the canonical commission state-machine lives in
// `./fsm-def.ts` (consumed by the /api/v1/fsm/commission/options FE
// endpoint). Inline per-action guards below are preserved because each
// commission action (claim/invoice/mark-paid/dispute/resolve-dispute/waive)
// maps to ONE specific FSM edge — the generic "find any matching rule"
// helper in shared/fsm.ts would accept legal-but-wrong-action transitions
// (e.g. /invoice from DISPUTED via the DISPUTED -> INVOICED resolveDispute
// edge). The fsm-def is still the single source of truth for the FE.
import type {
  CommissionListQuery,
  DisputeRequest,
  InvoiceRequest,
  MarkPaidRequest,
  ResolveDisputeRequest,
  UpdateCommissionRequest,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
// HTTP-only service: the tenantContext middleware MUST attach req.db. We
// refuse a silent fallback to the unscoped singleton because that would
// bypass RLS for every query in this module.
const db = (req?: { db?: DB }): DB => {
  if (!req?.db) throw new Error('tenantContext middleware not applied');
  return req.db;
};

function user(req: Request): { tid: string; sub: string } {
  if (!req.user) throw Unauthorized();
  return { tid: req.user.tid, sub: req.user.sub };
}

const fullInclude: Prisma.CommissionClaimInclude = {
  student: { select: { id: true, given_name: true, family_name: true, student_code: true } },
  institution: { select: { id: true, display_name: true, country_code: true } },
  enrollment: {
    select: {
      id: true,
      enrollment_no: true,
      tuition_total_minor: true,
      tuition_currency: true,
      program: { select: { id: true, name: true, level: true } },
      program_intake: { select: { id: true, intake_label: true, intake_year: true, intake_month: true } },
    },
  },
};

// ---------------------------------------------------------------------------
// list / get
// ---------------------------------------------------------------------------

export async function list(req: Request, q: CommissionListQuery) {
  const { tid } = user(req);
  const where: Prisma.CommissionClaimWhereInput = {
    tenant_id: tid,
    deleted_at: null,
  };
  if (q.status) where.status = q.status;
  if (q.institution_id) where.institution_id = q.institution_id;
  if (q.student_id) where.student_id = q.student_id;
  if (q.claimed_from || q.claimed_to) {
    where.claimed_on = {};
    if (q.claimed_from) (where.claimed_on as Prisma.DateTimeFilter).gte = new Date(q.claimed_from);
    if (q.claimed_to) (where.claimed_on as Prisma.DateTimeFilter).lte = new Date(q.claimed_to);
  }
  if (q.paid_from || q.paid_to) {
    where.paid_on = {};
    if (q.paid_from) (where.paid_on as Prisma.DateTimeFilter).gte = new Date(q.paid_from);
    if (q.paid_to) (where.paid_on as Prisma.DateTimeFilter).lte = new Date(q.paid_to);
  }

  const [rows, total] = await Promise.all([
    db(req).commissionClaim.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: fullInclude,
    }),
    db(req).commissionClaim.count({ where }),
  ]);
  return { data: rows, total };
}

export async function getById(req: Request, id: string) {
  const { tid } = user(req);
  const row = await db(req).commissionClaim.findFirst({
    where: { id, tenant_id: tid, deleted_at: null },
    include: fullInclude,
  });
  if (!row) throw NotFound('Commission claim not found');
  return row;
}

// ---------------------------------------------------------------------------
// state-machine helpers
// ---------------------------------------------------------------------------

async function loadForTransition(req: Request, id: string) {
  const { tid } = user(req);
  const row = await db(req).commissionClaim.findFirst({
    where: { id, tenant_id: tid, deleted_at: null },
  });
  if (!row) throw NotFound('Commission claim not found');
  return row;
}

function todayDateOnly(): Date {
  // Postgres @db.Date strips time but Prisma still needs a Date. Use UTC midnight
  // so the value round-trips identically regardless of server timezone.
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ---------------------------------------------------------------------------
// claim: PENDING -> CLAIMED
// ---------------------------------------------------------------------------

export async function claim(req: Request, id: string) {
  const { tid, sub } = user(req);
  const before = await loadForTransition(req, id);
  if (before.status !== 'PENDING') {
    throw Conflict(`Cannot claim from status ${before.status}; only PENDING is allowed`);
  }
  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await db(req).commissionClaim.updateMany({
    where: { id, tenant_id: tid, deleted_at: null },
    data: {
      status: 'CLAIMED',
      claimed_on: todayDateOnly(),
      updated_by_id: sub,
      version: { increment: 1 },
    },
  });
  if (wr.count !== 1) throw NotFound('Commission claim not found');
  const after = await db(req).commissionClaim.findFirstOrThrow({
    where: { id, tenant_id: tid },
    include: fullInclude,
  });
  await writeAudit(req as never, {
    action: 'commission_claim.claimed',
    entityType: 'commission_claim',
    entityId: id,
    entityVersion: after.version,
    before: { status: before.status },
    after: { status: after.status, claimed_on: after.claimed_on },
  });
  return after;
}

// ---------------------------------------------------------------------------
// invoice: CLAIMED -> INVOICED. Auto-generates invoice_no if absent.
// ---------------------------------------------------------------------------

export async function invoice(req: Request, id: string, body: InvoiceRequest) {
  const { tid, sub } = user(req);
  const before = await loadForTransition(req, id);
  if (before.status !== 'CLAIMED') {
    throw Conflict(`Cannot invoice from status ${before.status}; only CLAIMED is allowed`);
  }

  let invoiceNo = body.invoice_no;
  if (!invoiceNo) {
    invoiceNo = await nextInvoiceNumber(req, tid);
  } else {
    // Reject collisions on (tenant, invoice_no) early — DB doesn't enforce
    // uniqueness on that pair (no @@unique in schema), so we have to.
    const clash = await db(req).commissionClaim.findFirst({
      where: { tenant_id: tid, invoice_no: invoiceNo, NOT: { id } },
      select: { id: true },
    });
    if (clash) throw Conflict(`invoice_no ${invoiceNo} already in use`);
  }

  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await db(req).commissionClaim.updateMany({
    where: { id, tenant_id: tid, deleted_at: null },
    data: {
      status: 'INVOICED',
      invoice_no: invoiceNo,
      invoiced_on: todayDateOnly(),
      updated_by_id: sub,
      version: { increment: 1 },
    },
  });
  if (wr.count !== 1) throw NotFound('Commission claim not found');
  const after = await db(req).commissionClaim.findFirstOrThrow({
    where: { id, tenant_id: tid },
    include: fullInclude,
  });
  await writeAudit(req as never, {
    action: 'commission_claim.invoiced',
    entityType: 'commission_claim',
    entityId: id,
    entityVersion: after.version,
    before: { status: before.status },
    after: { status: after.status, invoice_no: after.invoice_no, invoiced_on: after.invoiced_on },
  });
  return after;
}

/**
 * Per-tenant, per-month auto-incrementing invoice number generator.
 * Format: COM-YYYY-MM-NNNNNN. Uses the current month's existing invoice_no
 * count as the seed; collisions are extremely unlikely under normal load
 * (they'd require two invoices issued in the same DB-ms window) but we still
 * retry up to 5 times to be safe.
 */
async function nextInvoiceNumber(req: Request, tenantId: string): Promise<string> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const prefix = `COM-${year}-${month}-`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const count = await db(req).commissionClaim.count({
      where: { tenant_id: tenantId, invoice_no: { startsWith: prefix } },
    });
    const seq = String(count + 1 + attempt).padStart(6, '0');
    const candidate = `${prefix}${seq}`;
    const clash = await db(req).commissionClaim.findFirst({
      where: { tenant_id: tenantId, invoice_no: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  // Extremely unlikely fallback — let the DB surface the collision if so.
  return `${prefix}${String(Date.now()).slice(-6).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// markPaid: INVOICED -> PAID
// ---------------------------------------------------------------------------

export async function markPaid(req: Request, id: string, body: MarkPaidRequest) {
  const { tid, sub } = user(req);
  const before = await loadForTransition(req, id);
  if (before.status !== 'INVOICED') {
    throw Conflict(`Cannot mark-paid from status ${before.status}; only INVOICED is allowed`);
  }
  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await db(req).commissionClaim.updateMany({
    where: { id, tenant_id: tid, deleted_at: null },
    data: {
      status: 'PAID',
      paid_on: new Date(body.paid_on),
      payment_reference: body.payment_reference ?? null,
      updated_by_id: sub,
      version: { increment: 1 },
    },
  });
  if (wr.count !== 1) throw NotFound('Commission claim not found');
  const after = await db(req).commissionClaim.findFirstOrThrow({
    where: { id, tenant_id: tid },
    include: fullInclude,
  });
  await writeAudit(req as never, {
    action: 'commission_claim.paid',
    entityType: 'commission_claim',
    entityId: id,
    entityVersion: after.version,
    before: { status: before.status },
    after: {
      status: after.status,
      paid_on: after.paid_on,
      payment_reference: after.payment_reference,
    },
  });
  // SVT-WAVE6-TXN-NOTIFY: PAID is the money-landed signal — admin almost
  // always wants the bell. Best-effort fan-out via shared helper.
  void notifyStatusTransition({
    tenantId: tid,
    entityId: id,
    title: `Commission paid · ${after.institution?.display_name ?? 'institution'}`,
    body: body.payment_reference ? `Ref: ${body.payment_reference}` : undefined,
    href: `/commissions?tab=paid`,
    actorId: sub,
    source: 'commission',
  });
  return after;
}

// ---------------------------------------------------------------------------
// dispute: anything-non-PAID -> DISPUTED
// ---------------------------------------------------------------------------

export async function dispute(req: Request, id: string, body: DisputeRequest) {
  const { tid, sub } = user(req);
  const before = await loadForTransition(req, id);
  if (before.status === 'PAID') {
    throw Conflict('Cannot dispute a PAID claim; use a refund/credit-note workflow instead');
  }
  if (before.status === 'DISPUTED') {
    throw Conflict('Claim is already DISPUTED');
  }
  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await db(req).commissionClaim.updateMany({
    where: { id, tenant_id: tid, deleted_at: null },
    data: {
      status: 'DISPUTED',
      dispute_reason: body.dispute_reason,
      updated_by_id: sub,
      version: { increment: 1 },
    },
  });
  if (wr.count !== 1) throw NotFound('Commission claim not found');
  const after = await db(req).commissionClaim.findFirstOrThrow({
    where: { id, tenant_id: tid },
    include: fullInclude,
  });
  await writeAudit(req as never, {
    action: 'commission_claim.disputed',
    entityType: 'commission_claim',
    entityId: id,
    entityVersion: after.version,
    before: { status: before.status },
    after: { status: after.status, dispute_reason: after.dispute_reason },
  });
  // SVT-WAVE6-TXN-NOTIFY: DISPUTED requires admin action — surface immediately.
  void notifyStatusTransition({
    tenantId: tid,
    entityId: id,
    title: `Commission disputed · ${after.institution?.display_name ?? 'institution'}`,
    body: body.dispute_reason,
    href: `/commissions?tab=disputed`,
    actorId: sub,
    source: 'commission',
  });
  return after;
}

// ---------------------------------------------------------------------------
// resolveDispute: DISPUTED -> INVOICED  (clears dispute_reason)
// ---------------------------------------------------------------------------
//
// Mirror of `dispute`. The brief: a DISPUTED claim, once the disagreement is
// settled in the institution's favour (or the counterparty withdraws), should
// re-enter the standard payment pipeline at INVOICED — NOT at PENDING/CLAIMED,
// because the invoice itself was already issued. We clear `dispute_reason`
// (the resolution closes that thread) and audit the before/after snapshot so
// the original reason text is recoverable from the audit log.

export async function resolveDispute(
  req: Request,
  id: string,
  _body: ResolveDisputeRequest,
) {
  const { tid, sub } = user(req);
  const before = await loadForTransition(req, id);
  if (before.status !== 'DISPUTED') {
    throw Conflict(
      `Cannot resolve a claim in status ${before.status}; resolve only works on DISPUTED`,
    );
  }
  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await db(req).commissionClaim.updateMany({
    where: { id, tenant_id: tid, deleted_at: null },
    data: {
      status: 'INVOICED',
      dispute_reason: null,
      updated_by_id: sub,
      version: { increment: 1 },
    },
  });
  if (wr.count !== 1) throw NotFound('Commission claim not found');
  const after = await db(req).commissionClaim.findFirstOrThrow({
    where: { id, tenant_id: tid },
    include: fullInclude,
  });
  await writeAudit(req as never, {
    action: 'commission_claim.dispute_resolved',
    entityType: 'commission_claim',
    entityId: id,
    entityVersion: after.version,
    before: { status: before.status, dispute_reason: before.dispute_reason },
    after: { status: after.status, dispute_reason: after.dispute_reason },
  });
  return after;
}

// ---------------------------------------------------------------------------
// waive: any -> WAIVED  (admin override, terminal)
// ---------------------------------------------------------------------------

export async function waive(req: Request, id: string) {
  const { tid, sub } = user(req);
  const before = await loadForTransition(req, id);
  if (before.status === 'WAIVED') throw Conflict('Claim is already WAIVED');
  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  const wr = await db(req).commissionClaim.updateMany({
    where: { id, tenant_id: tid, deleted_at: null },
    data: {
      status: 'WAIVED',
      updated_by_id: sub,
      version: { increment: 1 },
    },
  });
  if (wr.count !== 1) throw NotFound('Commission claim not found');
  const after = await db(req).commissionClaim.findFirstOrThrow({
    where: { id, tenant_id: tid },
    include: fullInclude,
  });
  await writeAudit(req as never, {
    action: 'commission_claim.waived',
    entityType: 'commission_claim',
    entityId: id,
    entityVersion: after.version,
    before: { status: before.status },
    after: { status: after.status },
  });
  return after;
}

// ---------------------------------------------------------------------------
// PATCH (admin manual edit) — only amount_minor / commission_pct / notes.
// Bumps version and audits the diff.
// ---------------------------------------------------------------------------

export async function patch(
  req: Request,
  id: string,
  body: UpdateCommissionRequest,
  expected?: number,
) {
  const { tid, sub } = user(req);
  const before = await loadForTransition(req, id);

  // Optional If-Match: only enforced when the controller passed an `expected`
  // version (parsed from the request header). Clients that omit If-Match
  // continue to work for backwards compatibility — the protection only fires
  // when the caller opts in.
  if (expected !== undefined && before.version !== expected) {
    throw PreconditionFailed('Record was modified by another request; reload and retry.');
  }

  const data: Prisma.CommissionClaimUncheckedUpdateInput = {
    updated_by_id: sub,
    version: { increment: 1 },
  };
  if (body.amount_minor !== undefined) data.amount_minor = body.amount_minor;
  if (body.commission_pct !== undefined) data.commission_pct = new Prisma.Decimal(body.commission_pct);
  if (body.notes !== undefined) data.notes = body.notes;

  // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
  // When an `expected` version was supplied, fold it into the WHERE so the
  // UPDATE is atomic against a concurrent writer that bumped the version
  // between the SELECT above and now.
  const where: Prisma.CommissionClaimWhereInput = {
    id,
    tenant_id: tid,
    deleted_at: null,
  };
  if (expected !== undefined) where.version = expected;
  const wr = await db(req).commissionClaim.updateMany({ where, data });
  if (wr.count !== 1) {
    if (expected !== undefined) {
      // Re-read to differentiate "version moved" (412) from "row gone" (404).
      const stillThere = await db(req).commissionClaim.findFirst({
        where: { id, tenant_id: tid, deleted_at: null },
        select: { id: true },
      });
      if (stillThere) {
        throw PreconditionFailed('Record was modified by another request; reload and retry.');
      }
    }
    throw NotFound('Commission claim not found');
  }
  const after = await db(req).commissionClaim.findFirstOrThrow({
    where: { id, tenant_id: tid },
    include: fullInclude,
  });
  await writeAudit(req as never, {
    action: 'commission_claim.patched',
    entityType: 'commission_claim',
    entityId: id,
    entityVersion: after.version,
    before: {
      amount_minor: before.amount_minor.toString(),
      commission_pct: before.commission_pct.toString(),
      notes: before.notes,
    },
    after: {
      amount_minor: after.amount_minor.toString(),
      commission_pct: after.commission_pct.toString(),
      notes: after.notes,
    },
  });
  return after;
}

// ---------------------------------------------------------------------------
// summary: per institution + currency aggregates
// ---------------------------------------------------------------------------

export type SummaryRow = {
  institution_id: string;
  currency: string;
  pending_count: number;
  pending_total_minor: string;
  claimed_total_minor: string;
  invoiced_total_minor: string;
  paid_total_minor: string;
  outstanding_total_minor: string; // CLAIMED + INVOICED (not yet PAID, not DISPUTED/WAIVED)
};

export async function summary(req: Request) {
  const { tid } = user(req);
  // groupBy on (institution_id, currency, status) — aggregate amount + count.
  const groups = await db(req).commissionClaim.groupBy({
    by: ['institution_id', 'currency', 'status'],
    where: { tenant_id: tid, deleted_at: null },
    _sum: { amount_minor: true },
    _count: { _all: true },
  });

  // Pivot status into named columns.
  const byKey = new Map<string, SummaryRow>();
  for (const g of groups) {
    const key = `${g.institution_id}::${g.currency}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        institution_id: g.institution_id,
        currency: g.currency,
        pending_count: 0,
        pending_total_minor: '0',
        claimed_total_minor: '0',
        invoiced_total_minor: '0',
        paid_total_minor: '0',
        outstanding_total_minor: '0',
      };
      byKey.set(key, row);
    }
    const sum = (g._sum.amount_minor ?? 0n).toString();
    switch (g.status) {
      case 'PENDING':
        row.pending_count = g._count._all;
        row.pending_total_minor = sum;
        break;
      case 'CLAIMED':
        row.claimed_total_minor = sum;
        break;
      case 'INVOICED':
        row.invoiced_total_minor = sum;
        break;
      case 'PAID':
        row.paid_total_minor = sum;
        break;
      // DISPUTED + WAIVED counted but not surfaced as separate columns; they're
      // visible via the regular list endpoint with status filter.
      default:
        break;
    }
  }
  // Compute outstanding = CLAIMED + INVOICED.
  for (const row of byKey.values()) {
    row.outstanding_total_minor = (
      BigInt(row.claimed_total_minor) + BigInt(row.invoiced_total_minor)
    ).toString();
  }
  return { data: Array.from(byKey.values()) };
}
