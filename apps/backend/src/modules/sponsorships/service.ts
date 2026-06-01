// Sponsor + StudentSponsorship service. Hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateSponsorRequest,
  UpdateSponsorRequest,
  SponsorListQuery,
  CreateSponsorshipRequest,
  UpdateSponsorshipRequest,
  SponsorshipListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

function toSponsorshipData(input: Partial<CreateSponsorshipRequest>) {
  const { amount_minor, starts_on, ends_on, ...rest } = input as Record<string, unknown> & {
    amount_minor?: number | string;
    starts_on?: string | null;
    ends_on?: string | null;
  };
  return {
    ...rest,
    ...(amount_minor !== undefined ? { amount_minor: BigInt(amount_minor as string | number) } : {}),
    ...(starts_on !== undefined ? { starts_on: toDate(starts_on) } : {}),
    ...(ends_on !== undefined ? { ends_on: toDate(ends_on) } : {}),
  };
}

export const sponsorService = {
  async create(req: { db?: DB; user?: { tid: string } }, body: CreateSponsorRequest) {
    const created = await db(req).sponsor.create({ data: { ...body, tenant_id: req.user!.tid } as never });
    await writeAudit(req as never, {
      action: 'sponsor.created',
      entityType: 'sponsor',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, q: SponsorListQuery) {
    return db(req).sponsor.findMany({
      where: { tenant_id: req.user!.tid, ...(q.type ? { type: q.type } : {}) },
      orderBy: { created_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).sponsor.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Sponsor not found');
    return found;
  },
  // SVT-IFMATCH-2026-05 — Sponsor has no `version` column; `_opts.expected`
  // is accepted for API parity (so clients can send If-Match without 412s) but
  // ignored. Promote to OCC once the column is added.
  async update(req: { db?: DB; user?: { tid: string } }, id: string, body: UpdateSponsorRequest, _opts?: { expected?: number }) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).sponsor.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: body as never,
    });
    if (r.count !== 1) throw NotFound('Sponsor not found');
    const after = await db(req).sponsor.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'sponsor.updated',
      entityType: 'sponsor',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).sponsor.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Sponsor not found');
    await writeAudit(req as never, {
      action: 'sponsor.deleted',
      entityType: 'sponsor',
      entityId: id,
      before,
    });
  },
};

export const sponsorshipService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateSponsorshipRequest) {
    const created = await db(req).studentSponsorship.create({
      data: { ...toSponsorshipData(body), student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.sponsorship.created',
      entityType: 'student_sponsorship',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: SponsorshipListQuery) {
    return db(req).studentSponsorship.findMany({
      where: { student_id: studentId, tenant_id: req.user!.tid },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).studentSponsorship.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Sponsorship not found');
    return found;
  },
  // SVT-IFMATCH-2026-05 — StudentSponsorship has no `version` column;
  // `_opts.expected` is accepted but ignored. Wire OCC once schema gains one.
  async update(req: { db?: DB; user?: { tid: string } }, id: string, body: UpdateSponsorshipRequest, _opts?: { expected?: number }) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentSponsorship.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: toSponsorshipData(body) as never,
    });
    if (r.count !== 1) throw NotFound('Sponsorship not found');
    const after = await db(req).studentSponsorship.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.sponsorship.updated',
      entityType: 'student_sponsorship',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentSponsorship.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Sponsorship not found');
    await writeAudit(req as never, {
      action: 'student.sponsorship.deleted',
      entityType: 'student_sponsorship',
      entityId: id,
      before,
    });
  },
};
