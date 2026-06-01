// TravelRecord service. Hard-deletes (no deleted_at column on the model).
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateTravelRequest,
  UpdateTravelRequest,
  TravelListQuery,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

function toData(input: CreateTravelRequest | UpdateTravelRequest) {
  const { fare_minor, departure_at, arrival_at, ...rest } = input as Record<string, unknown> & {
    fare_minor?: number | string;
    departure_at?: string | null;
    arrival_at?: string | null;
  };
  return {
    ...rest,
    ...(fare_minor !== undefined ? { fare_minor: BigInt(fare_minor as string | number) } : {}),
    ...(departure_at !== undefined ? { departure_at: toDate(departure_at) } : {}),
    ...(arrival_at !== undefined ? { arrival_at: toDate(arrival_at) } : {}),
  };
}

export const travelService = {
  async create(
    req: { db?: DB; user?: { tid: string } },
    studentId: string,
    body: CreateTravelRequest,
  ) {
    const created = await db(req).travelRecord.create({
      data: { ...toData(body), student_id: studentId, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.travel.created',
      entityType: 'travel_record',
      entityId: created.id,
      after: created,
    });
    return created;
  },

  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: TravelListQuery) {
    return db(req).travelRecord.findMany({
      where: { student_id: studentId, tenant_id: req.user!.tid, ...(q.status ? { status: q.status } : {}) },
      orderBy: { departure_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },

  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).travelRecord.findFirst({
      where: { id, tenant_id: req.user!.tid },
    });
    if (!found) throw NotFound('Travel record not found');
    return found;
  },

  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateTravelRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — TravelRecord has no `version` column in
    // schema.prisma, so optimistic-concurrency cannot be enforced here.
    // We accept the opt arg for signature parity with versioned services
    // and so the controller can pass `readIfMatch(req)` unconditionally.
    void _opts;
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).travelRecord.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: toData(body),
    });
    if (r.count !== 1) throw NotFound('Travel record not found');
    const after = await db(req).travelRecord.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'student.travel.updated',
      entityType: 'travel_record',
      entityId: id,
      before,
      after,
    });
    return after;
  },

  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).travelRecord.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Travel record not found');
    await writeAudit(req as never, {
      action: 'student.travel.deleted',
      entityType: 'travel_record',
      entityId: id,
      before,
    });
  },
};
