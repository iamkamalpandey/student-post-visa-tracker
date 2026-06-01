// Address + StudentAddress service. Hard-deletes.
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateAddressRequest,
  UpdateAddressRequest,
  AddressListQuery,
  CreateStudentAddressRequest,
  UpdateStudentAddressRequest,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

export const addressService = {
  async create(req: { db?: DB; user?: { tid: string } }, body: CreateAddressRequest) {
    const created = await db(req).address.create({ data: { ...body, tenant_id: req.user!.tid } as never });
    await writeAudit(req as never, {
      action: 'address.created',
      entityType: 'address',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, q: AddressListQuery) {
    return db(req).address.findMany({
      where: {
        tenant_id: req.user!.tid,
        ...(q.country_code ? { country_code: q.country_code } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).address.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Address not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateAddressRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — _opts.expected accepted for API parity with
    // versioned modules; Address has no `version` column so this is a no-op.
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).address.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: body as never,
    });
    if (r.count !== 1) throw NotFound('Address not found');
    const after = await db(req).address.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'address.updated',
      entityType: 'address',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).address.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Address not found');
    await writeAudit(req as never, {
      action: 'address.deleted',
      entityType: 'address',
      entityId: id,
      before,
    });
  },
};

const toDate = (v: string | null | undefined) => (v ? new Date(v) : v ?? null);

function toStudentAddressData(input: Partial<CreateStudentAddressRequest>) {
  const { valid_from, valid_to, ...rest } = input as Record<string, unknown> & {
    valid_from?: string | null;
    valid_to?: string | null;
  };
  const out: Record<string, unknown> = { ...rest };
  if (valid_from !== undefined) out['valid_from'] = toDate(valid_from);
  if (valid_to !== undefined) out['valid_to'] = toDate(valid_to);
  return out;
}

export const studentAddressService = {
  async create(
    req: { db?: DB; user?: { tid: string } },
    studentId: string,
    body: CreateStudentAddressRequest,
  ) {
    const created = await db(req).studentAddress.create({
      data: { ...toStudentAddressData(body), student_id: studentId, tenant_id: req.user!.tid } as never,
    });
    await writeAudit(req as never, {
      action: 'student.address.created',
      entityType: 'student_address',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string) {
    return db(req).studentAddress.findMany({
      where: { student_id: studentId, tenant_id: req.user!.tid },
      include: { address: true },
      orderBy: { created_at: 'desc' },
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).studentAddress.findFirst({
      where: { id, tenant_id: req.user!.tid },
      include: { address: true },
    });
    if (!found) throw NotFound('Student address not found');
    return found;
  },
  async update(
    req: { db?: DB; user?: { tid: string } },
    id: string,
    body: UpdateStudentAddressRequest,
    _opts?: { expected?: number },
  ) {
    // SVT-IFMATCH-2026-05 — _opts.expected accepted for API parity with
    // versioned modules; StudentAddress has no `version` column (no-op).
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentAddress.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: toStudentAddressData(body) as never,
    });
    if (r.count !== 1) throw NotFound('Student address not found');
    const after = await db(req).studentAddress.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
      include: { address: true },
    });
    await writeAudit(req as never, {
      action: 'student.address.updated',
      entityType: 'student_address',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).studentAddress.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Student address not found');
    await writeAudit(req as never, {
      action: 'student.address.deleted',
      entityType: 'student_address',
      entityId: id,
      before,
    });
  },
};
