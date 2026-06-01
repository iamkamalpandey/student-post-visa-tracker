// Accommodation service. Hard-deletes (no deleted_at on model).
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateAccommodationRequest,
  UpdateAccommodationRequest,
  AccommodationListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

function toData(input: CreateAccommodationRequest | UpdateAccommodationRequest) {
  const { rent_minor, deposit_minor, move_in_date, move_out_date, ...rest } = input as Record<string, unknown> & {
    rent_minor?: number | string;
    deposit_minor?: number | string;
    move_in_date?: string | null;
    move_out_date?: string | null;
  };
  return {
    ...rest,
    ...(rent_minor !== undefined ? { rent_minor: BigInt(rent_minor as string | number) } : {}),
    ...(deposit_minor !== undefined ? { deposit_minor: BigInt(deposit_minor as string | number) } : {}),
    ...(move_in_date !== undefined ? { move_in_date: toDate(move_in_date) } : {}),
    ...(move_out_date !== undefined ? { move_out_date: toDate(move_out_date) } : {}),
  };
}

export const accommodationService = {
  async create(req: { db?: DB; user?: { tid: string } }, studentId: string, body: CreateAccommodationRequest) {
    // `body.type` is required by the Zod schema (CreateAccommodationRequest)
    // and flows through `...rest` in toData(), but TS erases that proof. Cast
    // to the Prisma create input so the required `type` discriminant lands in
    // the generated SQL.
    const created = await db(req).accommodation.create({
      data: { ...toData(body), student_id: studentId, tenant_id: req.user!.tid } as Prisma.AccommodationUncheckedCreateInput,
    });
    await writeAudit(req as never, {
      action: 'student.accommodation.created',
      entityType: 'accommodation',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: AccommodationListQuery) {
    return db(req).accommodation.findMany({
      where: {
        student_id: studentId,
        tenant_id: req.user!.tid,
        ...(q.type ? { type: q.type } : {}),
        ...(q.is_current !== undefined ? { is_current: q.is_current } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).accommodation.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Accommodation not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateAccommodationRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — Accommodation has no `version` column in
    // schema.prisma, so optimistic-concurrency cannot be enforced here.
    // We accept the opt arg for signature parity with versioned services
    // and so the controller can pass `readIfMatch(req)` unconditionally.
    void _opts;
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).accommodation.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: toData(body),
    });
    if (r.count !== 1) throw NotFound('Accommodation not found');
    const after = await db(req).accommodation.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.accommodation.updated',
      entityType: 'accommodation',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).accommodation.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Accommodation not found');
    await writeAudit(req as never, {
      action: 'student.accommodation.deleted',
      entityType: 'accommodation',
      entityId: id,
      before,
    });
  },
};
